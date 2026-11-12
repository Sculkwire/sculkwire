/**
 * Headless pack validator: every diagnostic has a project-relative file, a 1-based range and a stable code.
 *   validateProject(root, opts)        all packs under a directory (Regolith projects built with rgl)
 *   validateText(path, text?, opts)    one file, optionally with unsaved content, in its project context
 */
import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { atLeast, compareDiagnostics, type Diagnostic, type DiagnosticSummary, type Severity, summarize } from "../core/diagnostic.ts";
import { discoverProject, type PackInfo } from "../core/project.ts";
import type { Channel } from "../core/version.ts";
import { classifyFile, type FileKind, JSON_EXT, versionTuple } from "./classify.ts";
import { parseJson } from "./jsonc.ts";
import { Context, loadPack, type Pack, toPosix } from "./context.ts";
import { checkLang } from "./lang.ts";
import { checkManifests, type ManifestOptions } from "./manifest.ts";
import { checkMcfunctions } from "./mcfunction.ts";
import { checkReferences, type ReferenceOptions } from "./references.ts";
import { buildRegolith, regolithPlan } from "../core/regolith.ts";
import { calibration, checkSchemaFile, type SchemaFileArgs, type SchemaOptions } from "./schema.ts";
import { checkTypeScript, type ResolveTypings, type TypeScriptOptions } from "./typescript.ts";
import { loadVanilla, type VanillaData } from "./vanilla.ts";

export const CHECKS = ["json", "manifest", "schema", "reference", "lang", "mcfunction", "typescript"] as const;
export type CheckName = (typeof CHECKS)[number];

/** Newest game version known without game metadata (the newest release when this was written). */
const OFFLINE_VERSION_ESTIMATE = [1, 26, 60];

export interface ValidateOptions {
  channel?: Channel;
  /** bedrock-samples checkout (vanilla names, script modules, commands, engine schemas, calibration). Env: SCULKWIRE_SAMPLES. */
  samplesRoot?: string;
  /** Called when `samplesRoot` is not given (e.g. knowledge `ensureBedrockSamples`); undefined = none. */
  resolveSamples?: (channel: Channel) => Promise<string | undefined>;
  /** Engine schema dump (bedrock-samples root or `<area>/<kind>/<format_version>/` layout); defaults to samplesRoot's. */
  engineSchemasDir?: string;
  /** A `node_modules` dir (or parent) with `@minecraft/*` typings. */
  typingsDir?: string;
  resolveTypings?: ResolveTypings;
  /** rockide/schemas checkout; overrides `resolveRockide`. */
  rockideSchemasDir?: string;
  /** Called when `rockideSchemasDir` is not given (knowledge cache `ensureRockideSchemas`); fails open with a note. */
  resolveRockide?: () => Promise<RockideSource>;
  /** Exact target game version (`1.26.60`); defaults to the samples' version. */
  gameVersion?: string;
  /** Subset of CHECKS; default all. */
  checks?: string[];
  /** Threshold for `ok` (and the CLI exit code). Default `error`. */
  failOn?: Severity;
  /** Missing texture/sound files are warnings (generated packs without binaries). */
  assetsOptional?: boolean;
  /** Command names for .mcfunction checks (defaults to the samples' command list). */
  commands?: string[];
  /** Regolith projects: `auto` builds with rgl when the profile has filters (default), `build` always, `source` never. */
  regolith?: "auto" | "build" | "source";
  regolithProfile?: string;
  rglPath?: string;
  tscPath?: string;
  /** Unsaved contents by absolute path (used by validateText). */
  overlay?: Map<string, string>;
}

/** The rockide/schemas copy a run used, or why it used none. */
export interface RockideSource {
  root?: string;
  /** Release tag in use. */
  release?: string;
  commit?: string;
  /** Newest release seen upstream. */
  latest?: string;
  note?: string;
}

export interface ValidationResult {
  root: string;
  target: { channel: Channel; version?: string };
  ok: boolean;
  packs: (Omit<PackInfo, "dir"> & { files: number })[];
  filesChecked: number;
  checks: CheckName[];
  diagnostics: Diagnostic[];
  summary: DiagnosticSummary;
  /** Schema used per file (project-relative path -> label). */
  schemaSources: Record<string, string>;
  vanilla?: { root: string; version?: string };
  rockide?: RockideSource;
  regolith?: { profile: string; built: boolean; message?: string };
}

async function vanillaFiles(v: VanillaData) {
  const out: { packKind: "behavior" | "resource"; rel: string; kind: FileKind; value: unknown }[] = [];
  const packs: Pack[] = [];
  for (const [sub, kind] of [
    ["behavior_pack", "behavior"],
    ["resource_pack", "resource"],
  ] as const) {
    if (existsSync(join(v.root, sub))) packs.push(await loadPack({ kind, dir: join(v.root, sub), relDir: sub }, v.root));
  }
  const ctx = new Context(v.root, packs);
  for (const p of packs) {
    for (const rel of p.files) {
      if (!JSON_EXT.test(rel)) continue;
      const value = await ctx.value(p, rel);
      if (value !== undefined) out.push({ packKind: p.kind as "behavior" | "resource", rel, kind: classifyFile(p.kind, rel), value });
    }
  }
  return out;
}

/**
 * Process-wide defaults merged under every call's options (MCP + CLI). The integrator wires runtime providers
 * here, e.g. `validateDefaults.resolveSamples = (ch) => ensureBedrockSamples({channel: ch}).then((s) => s.root)`.
 */
export const validateDefaults: ValidateOptions = {};

export async function validateProject(rootArg: string, callOpts: ValidateOptions = {}): Promise<ValidationResult> {
  const opts: ValidateOptions = { ...validateDefaults, ...callOpts };
  const root = resolve(rootArg);
  const channel: Channel = opts.channel ?? "stable";
  const checks = (opts.checks?.length ? CHECKS.filter((c) => opts.checks?.includes(c)) : [...CHECKS]) as CheckName[];
  const unknownChecks = (opts.checks ?? []).filter((c) => !(CHECKS as readonly string[]).includes(c));
  if (unknownChecks.length) throw new Error(`unknown check(s): ${unknownChecks.join(", ")} (known: ${CHECKS.join(", ")})`);
  const samplesRoot = opts.samplesRoot ?? process.env.SCULKWIRE_SAMPLES ?? (await opts.resolveSamples?.(channel));
  const vanilla = samplesRoot ? await loadVanilla(samplesRoot) : undefined;
  const version = opts.gameVersion ?? vanilla?.version;
  const gameVersion = version ? versionTuple(version.replace(/[^\d.].*$/, "")) : undefined;

  const layout = await discoverProject(root);
  const result: Partial<ValidationResult> = {};
  let workDir: string | undefined;
  const packs: Pack[] = [];
  const builtSources = new Map<string, string>();
  if (layout.regolith) {
    const plan = await regolithPlan(root, opts.regolithProfile);
    const mode = opts.regolith ?? "auto";
    if (plan && (mode === "build" || (mode === "auto" && plan.hasFilters))) {
      const build = await buildRegolith(root, plan.profile, opts.rglPath);
      if ("outputs" in build) {
        workDir = build.workDir;
        for (const o of build.outputs) builtSources.set(resolve(o.source), o.built);
        result.regolith = { profile: plan.profile, built: true };
      } else {
        // Without a build the source packs are validated; say so unless rgl itself failed.
        const fallback = build.message.startsWith("rgl run") ? "" : "; validated the source packs instead";
        result.regolith = { profile: plan.profile, built: false, message: `${build.message}${fallback}` };
      }
    } else if (plan) {
      result.regolith = { profile: plan.profile, built: false, message: plan.hasFilters ? "build skipped (regolith: source)" : "profile has no filters; validated the source packs" };
    }
  }
  try {
    for (const info of layout.packs) {
      const built = builtSources.get(resolve(info.dir));
      if (built) {
        const builtInfo = { ...info };
        packs.push(await loadPack(builtInfo, root, { dir: built, displayDir: info.relDir, sourceDir: info.dir }));
      } else packs.push(await loadPack(info, root));
    }
    const ctx = new Context(root, packs, opts.overlay);
    if (result.regolith && !result.regolith.built && result.regolith.message && layout.regolith) {
      ctx.push({
        severity: result.regolith.message.startsWith("rgl run") ? "error" : "info",
        code: result.regolith.message.startsWith("rgl run") ? "regolith.build-failed" : "regolith.not-built",
        source: "manifest",
        message: result.regolith.message,
        file: toPosix(relative(root, layout.regolith.configPath)),
      });
    }
    for (const pack of packs) {
      const m = await ctx.value(pack, "manifest.json");
      if (m && typeof m === "object" && !Array.isArray(m)) pack.manifest = m as Record<string, unknown>;
    }

    let filesChecked = 0;
    const schemaSources: Record<string, string> = {};
    const schemaOpts: SchemaOptions = {};
    const engineDir = opts.engineSchemasDir ?? samplesRoot;
    if (engineDir) schemaOpts.engineSchemasDir = engineDir;
    let rockide: RockideSource | undefined;
    if (checks.includes("schema")) {
      rockide = opts.rockideSchemasDir ? { root: resolve(opts.rockideSchemasDir) } : await opts.resolveRockide?.();
      if (rockide?.root) schemaOpts.rockideSchemasDir = rockide.root;
    }
    const calib = vanilla && checks.includes("schema") ? await calibration(vanilla.identity, schemaOpts, () => vanillaFiles(vanilla)) : undefined;

    for (const pack of packs) {
      for (const rel of pack.files) {
        filesChecked++;
        if (!JSON_EXT.test(rel)) continue;
        const doc = await ctx.json(pack, rel);
        if (!doc) continue;
        if (checks.includes("json")) {
          for (const p of doc.problems) {
            const d: Omit<Diagnostic, "file"> = { severity: p.severity, code: p.code, source: "json", message: p.message, range: p.range };
            if (p.pointer !== undefined) d.pointer = p.pointer;
            await ctx.add(pack, rel, d);
          }
        }
        if (checks.includes("schema") && (pack.kind === "behavior" || pack.kind === "resource" || pack.kind === "skin")) {
          const args: SchemaFileArgs = { packKind: pack.kind, rel, kind: classifyFile(pack.kind, rel), doc, opts: schemaOpts, channel };
          if (calib) args.calibration = calib;
          if (gameVersion?.length) args.gameVersion = gameVersion;
          const r = await checkSchemaFile(args);
          if (r.choice) schemaSources[ctx.label(pack, rel)] = r.choice.label;
          for (const d of r.diagnostics) await ctx.add(pack, rel, d);
        }
      }
    }
    if (checks.includes("manifest")) {
      const mo: ManifestOptions = { channel };
      if (gameVersion?.length) mo.gameVersion = gameVersion;
      else mo.gameVersionEstimate = OFFLINE_VERSION_ESTIMATE;
      if (vanilla?.scriptModules.size) mo.scriptModules = vanilla.scriptModules;
      await checkManifests(ctx, packs, mo);
    }
    if (checks.includes("reference")) {
      const ro: ReferenceOptions = {};
      if (vanilla) ro.vanilla = vanilla.names;
      if (opts.assetsOptional) ro.assetsOptional = true;
      await checkReferences(ctx, packs, ro);
    }
    if (checks.includes("lang")) await checkLang(ctx, packs);
    if (checks.includes("mcfunction")) {
      const commands = opts.commands ? new Set(opts.commands.map((c) => c.toLowerCase())) : vanilla?.commands;
      await checkMcfunctions(ctx, packs, commands ? { commands } : {});
    }
    if (checks.includes("typescript")) {
      // Type-check sources, not Regolith build output (bundled JS); built packs map back to their source dirs.
      const sourcePacks: Pack[] = [];
      for (const p of packs) sourcePacks.push(p.sourceDir ? await loadPack(p.info, root) : p);
      const tctx = new Context(root, sourcePacks, opts.overlay);
      for (const p of sourcePacks) {
        const m = await tctx.value(p, "manifest.json");
        if (m && typeof m === "object" && !Array.isArray(m)) p.manifest = m as Record<string, unknown>;
      }
      const to: TypeScriptOptions = { channel };
      if (opts.typingsDir) to.typingsDir = opts.typingsDir;
      if (opts.resolveTypings) to.resolveTypings = opts.resolveTypings;
      if (opts.tscPath) to.tscPath = opts.tscPath;
      await checkTypeScript(tctx, sourcePacks, to);
      for (const d of tctx.diagnostics) ctx.push(d);
    }

    const diagnostics = ctx.diagnostics.sort(compareDiagnostics);
    const failOn = opts.failOn ?? "error";
    const target: ValidationResult["target"] = { channel };
    if (version) target.version = version;
    const out: ValidationResult = {
      root,
      target,
      ok: !diagnostics.some((d) => atLeast(d.severity, failOn)),
      packs: packs.map((p) => {
        const { dir: _dir, ...rest } = p.info;
        return { ...rest, files: p.files.length };
      }),
      filesChecked,
      checks,
      diagnostics,
      summary: summarize(diagnostics),
      schemaSources,
    };
    if (vanilla) out.vanilla = vanilla.version ? { root: vanilla.root, version: vanilla.version } : { root: vanilla.root };
    if (rockide) out.rockide = rockide;
    if (result.regolith) out.regolith = result.regolith;
    return out;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
}

/** Nearest ancestor holding manifest.json. */
function packDirOf(file: string): string | undefined {
  for (let d = dirname(file); ; d = dirname(d)) {
    if (existsSync(join(d, "manifest.json"))) return d;
    if (dirname(d) === d) return undefined;
  }
}

/**
 * Validate one file (unsaved `text` overrides the disk) in the context of its pack and sibling packs, and
 * return only that file's diagnostics. Diagnostic paths are relative to the returned `root`.
 */
export async function validateText(path: string, text: string | undefined, opts: ValidateOptions = {}): Promise<ValidationResult> {
  const abs = resolve(path);
  const packDir = packDirOf(abs);
  const overlay = new Map(opts.overlay ?? []);
  if (text !== undefined) overlay.set(abs, text);
  // The project is the pack's parent (BP + RP side by side), or the pack itself when it stands alone.
  const parent = packDir ? dirname(packDir) : dirname(abs);
  const root = packDir && existsSync(parent) && (await stat(parent)).isDirectory() ? parent : packDir ?? dirname(abs);
  if (!packDir) {
    // Not inside a pack: syntax only.
    const content = text ?? (await readFile(abs, "utf8"));
    const file = toPosix(relative(root, abs));
    const diagnostics: Diagnostic[] = JSON_EXT.test(abs)
      ? parseJson(content).problems.map((p) => ({ severity: p.severity, code: p.code, source: "json" as const, message: p.message, range: p.range, file }))
      : [];
    return {
      root,
      target: { channel: opts.channel ?? "stable" },
      ok: !diagnostics.some((d) => atLeast(d.severity, opts.failOn ?? "error")),
      packs: [],
      filesChecked: 1,
      checks: ["json"],
      diagnostics,
      summary: summarize(diagnostics),
      schemaSources: {},
    };
  }
  const r = await validateProject(root, { ...opts, overlay, regolith: "source" });
  const file = toPosix(relative(root, abs));
  const diagnostics = r.diagnostics.filter((d) => d.file === file);
  const schemaSources: Record<string, string> = {};
  if (r.schemaSources[file]) schemaSources[file] = r.schemaSources[file] as string;
  return {
    ...r,
    filesChecked: 1,
    diagnostics,
    summary: summarize(diagnostics),
    ok: !diagnostics.some((d) => atLeast(d.severity, opts.failOn ?? "error")),
    schemaSources,
  };
}
