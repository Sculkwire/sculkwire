/**
 * Headless pack validator: every diagnostic has a project-relative file, a 1-based range and a stable code.
 *   validateProject(root, opts)        all packs under a directory (Regolith projects: what rgl last built)
 *   validateText(path, text?, opts)    one file, optionally with unsaved content, in its project context
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { atLeast, compareDiagnostics, type Diagnostic, type DiagnosticSummary, type Severity, summarize } from "../core/diagnostic.ts";
import { isPlainObject } from "../core/json.ts";
import { discoverProject, type PackInfo } from "../core/project.ts";
import { RGL_NOT_BUILT, regolithOutput, regolithPlan } from "../core/regolith.ts";
import type { Channel } from "../core/version.ts";
import { classifyFile, JSON_EXT, versionTuple } from "./classify.ts";
import { Context, type Finding, loadPack, type Pack, toDiagnostic, toPosix } from "./context.ts";
import { type JsonDocument, type JsonProblem, parseJson } from "./jsonc.ts";
import { checkLang } from "./lang.ts";
import { checkManifests, type ManifestOptions } from "./manifest.ts";
import { checkMcfunctions } from "./mcfunction.ts";
import { checkReferences, type ReferenceOptions } from "./references.ts";
import { type Calibration, calibration, checkSchemaFile, type SchemaFileArgs, type SchemaOptions } from "./schema.ts";
import { checkTypeScript, type ResolveTypings, type TypeScriptOptions } from "./typescript.ts";
import { loadVanilla, type VanillaData, vanillaFiles } from "./vanilla.ts";

/** Every check, in the order results list them; `CHECK_RUNS` holds what each one does. */
export const CHECKS = ["json", "manifest", "schema", "reference", "lang", "mcfunction", "typescript"] as const;
export type CheckName = (typeof CHECKS)[number];

/** The names in `names` that are no check. */
export function unknownChecks(names: readonly string[]): string[] {
  return names.filter((c) => !(CHECKS as readonly string[]).includes(c));
}

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
  /**
   * Regolith projects: `auto` validates rgl's last build output in `.regolith/tmp` when the profile runs filters
   * (default), `build` always, `source` validates the source packs. sculkwire never runs rgl.
   */
  regolith?: "auto" | "build" | "source";
  /** The Regolith profile whose filters decide `auto` (default: `default`, else the first). */
  regolithProfile?: string;
  tscPath?: string;
  /** Unsaved contents by absolute path (used by validateText). */
  overlay?: Map<string, string>;
}

/** The options `validate_pack`/`validate_file` and `sculk validate` take, under their MCP names. */
export interface ValidateArgs {
  channel?: Channel | undefined;
  fail_on?: "error" | "warning" | undefined;
  samples_root?: string | undefined;
  typings_dir?: string | undefined;
  engine_schemas_dir?: string | undefined;
  rockide_dir?: string | undefined;
  checks?: string[] | undefined;
  regolith?: "auto" | "build" | "source" | undefined;
  profile?: string | undefined;
  game_version?: string | undefined;
  assets_optional?: boolean | undefined;
}

export function toOptions(a: ValidateArgs): ValidateOptions {
  const o: ValidateOptions = {};
  if (a.channel) o.channel = a.channel;
  if (a.fail_on) o.failOn = a.fail_on;
  if (a.samples_root) o.samplesRoot = a.samples_root;
  if (a.typings_dir) o.typingsDir = a.typings_dir;
  if (a.engine_schemas_dir) o.engineSchemasDir = a.engine_schemas_dir;
  if (a.rockide_dir) o.rockideSchemasDir = a.rockide_dir;
  if (a.game_version) o.gameVersion = a.game_version;
  if (a.profile) o.regolithProfile = a.profile;
  if (a.assets_optional) o.assetsOptional = true;
  if (a.checks) o.checks = a.checks;
  if (a.regolith) o.regolith = a.regolith;
  return o;
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
  /** `built`: rgl's last output was validated; `builtAt` (ISO time) is when rgl last ran, when known. */
  regolith?: { profile: string; built: boolean; builtAt?: string; message?: string };
}

/**
 * Process-wide defaults merged under every call's options (MCP + CLI). `useKnowledgeProviders()`
 * (`validate/providers.ts`, called by `wireFeatures()`) fills in the samples, rockide and typings providers; a
 * caller that skips it validates without them.
 */
export const validateDefaults: ValidateOptions = {};

/** What every check of one run sees. */
interface CheckEnv {
  root: string;
  ctx: Context;
  packs: Pack[];
  channel: Channel;
  opts: ValidateOptions;
  vanilla?: VanillaData;
  /** Target game version tuple, when known. */
  gameVersion?: number[];
  schemaOpts: SchemaOptions;
  calibration?: Calibration;
  /** Filled by the schema check: project-relative path -> schema label. */
  schemaSources: Record<string, string>;
}

/** A check runs per JSON file (inside the file loop, before every project check), once per project, or both. */
interface Check {
  file?(env: CheckEnv, pack: Pack, rel: string, doc: JsonDocument): Promise<void>;
  project?(env: CheckEnv): Promise<void>;
}

function jsonFinding(p: JsonProblem): Omit<Finding, "file"> {
  const d: Omit<Finding, "file"> = { severity: p.severity, code: p.code, message: p.message, range: p.range };
  if (p.pointer !== undefined) d.pointer = p.pointer;
  return d;
}

/** Sets `pack.manifest` for every pack whose manifest.json is a JSON object. */
async function readManifests(ctx: Context): Promise<void> {
  for (const pack of ctx.packs) {
    const m = await ctx.value(pack, "manifest.json");
    if (isPlainObject(m)) pack.manifest = m;
  }
}

const CHECK_RUNS: Record<CheckName, Check> = {
  json: {
    async file({ ctx }, pack, rel, doc) {
      for (const p of doc.problems) await ctx.add(pack, rel, jsonFinding(p));
    },
  },
  manifest: {
    async project({ ctx, packs, channel, gameVersion, vanilla }) {
      const mo: ManifestOptions = { channel };
      if (gameVersion?.length) mo.gameVersion = gameVersion;
      else mo.gameVersionEstimate = OFFLINE_VERSION_ESTIMATE;
      if (vanilla?.scriptModules.size) mo.scriptModules = vanilla.scriptModules;
      await checkManifests(ctx, packs, mo);
    },
  },
  schema: {
    async file(env, pack, rel, doc) {
      if (pack.kind !== "behavior" && pack.kind !== "resource" && pack.kind !== "skin") return;
      const args: SchemaFileArgs = { packKind: pack.kind, rel, kind: classifyFile(pack.kind, rel), doc, opts: env.schemaOpts, channel: env.channel };
      if (env.calibration) args.calibration = env.calibration;
      if (env.gameVersion?.length) args.gameVersion = env.gameVersion;
      const r = await checkSchemaFile(args);
      if (r.choice) env.schemaSources[env.ctx.label(pack, rel)] = r.choice.label;
      for (const d of r.diagnostics) await env.ctx.add(pack, rel, d);
    },
  },
  reference: {
    async project({ ctx, packs, vanilla, opts }) {
      const ro: ReferenceOptions = {};
      if (vanilla) ro.vanilla = vanilla.names;
      if (opts.assetsOptional) ro.assetsOptional = true;
      await checkReferences(ctx, packs, ro);
    },
  },
  lang: {
    project: ({ ctx, packs }) => checkLang(ctx, packs),
  },
  mcfunction: {
    async project({ ctx, packs, vanilla, opts }) {
      const commands = opts.commands ? new Set(opts.commands.map((c) => c.toLowerCase())) : vanilla?.commands;
      await checkMcfunctions(ctx, packs, commands ? { commands } : {});
    },
  },
  typescript: {
    async project({ root, ctx, packs, channel, opts }) {
      const to: TypeScriptOptions = { channel };
      if (opts.typingsDir) to.typingsDir = opts.typingsDir;
      if (opts.resolveTypings) to.resolveTypings = opts.resolveTypings;
      if (opts.tscPath) to.tscPath = opts.tscPath;
      if (!packs.some((p) => p.sourceDir)) {
        await checkTypeScript(ctx, packs, to);
        return;
      }
      // Type-check sources, not Regolith build output (bundled JS); built packs map back to their source dirs.
      const sourcePacks: Pack[] = [];
      for (const p of packs) sourcePacks.push(p.sourceDir ? await loadPack(p.info, root) : p);
      const tctx = new Context(root, sourcePacks, opts.overlay);
      await readManifests(tctx);
      await checkTypeScript(tctx, sourcePacks, to);
      for (const d of tctx.diagnostics) ctx.push(d);
    },
  },
};

function verdict(diagnostics: readonly Diagnostic[], failOn: Severity = "error"): { ok: boolean; summary: DiagnosticSummary } {
  return { ok: !diagnostics.some((d) => atLeast(d.severity, failOn)), summary: summarize(diagnostics) };
}

export async function validateProject(rootArg: string, callOpts: ValidateOptions = {}): Promise<ValidationResult> {
  const opts: ValidateOptions = { ...validateDefaults, ...callOpts };
  const root = resolve(rootArg);
  const channel: Channel = opts.channel ?? "stable";
  const checks = (opts.checks?.length ? CHECKS.filter((c) => opts.checks?.includes(c)) : [...CHECKS]) as CheckName[];
  const unknown = unknownChecks(opts.checks ?? []);
  if (unknown.length) throw new Error(`unknown check(s): ${unknown.join(", ")} (known: ${CHECKS.join(", ")})`);
  const samplesRoot = opts.samplesRoot ?? process.env.SCULKWIRE_SAMPLES ?? (await opts.resolveSamples?.(channel));
  const vanilla = samplesRoot ? await loadVanilla(samplesRoot) : undefined;
  const version = opts.gameVersion ?? vanilla?.version;
  const gameVersion = version ? versionTuple(version.replace(/[^\d.].*$/, "")) : undefined;

  const layout = await discoverProject(root);
  let regolith: ValidationResult["regolith"];
  let notBuilt: { severity: Severity; message: string } | undefined;
  const packs: Pack[] = [];
  const builtSources = new Map<string, string>();
  if (layout.regolith) {
    const plan = await regolithPlan(root, opts.regolithProfile);
    const mode = opts.regolith ?? "auto";
    if (plan && (mode === "build" || (mode === "auto" && plan.hasFilters))) {
      const output = await regolithOutput(root);
      if (output) {
        for (const o of output.outputs) builtSources.set(resolve(o.source), o.built);
        const when = output.builtAt ? ` from ${output.builtAt.toISOString()}` : "";
        regolith = {
          profile: plan.profile,
          built: true,
          ...(output.builtAt ? { builtAt: output.builtAt.toISOString() } : {}),
          message: `validated rgl's last build output in .regolith/tmp${when}; if the sources changed since, run \`rgl run\` first`,
        };
        // rgl's output may hold one of the two packs `config.json` names and not the other (a run under way).
        const configured = [layout.regolith.behaviorPack, layout.regolith.resourcePack].filter((d) => d !== undefined).map((d) => resolve(d));
        const unbuilt = layout.packs.filter((p) => configured.includes(resolve(p.dir)) && !builtSources.has(resolve(p.dir))).map((p) => p.relDir || ".");
        if (unbuilt.length) {
          notBuilt = {
            severity: mode === "build" ? "error" : "warning",
            message:
              `rgl's last build in .regolith/tmp has no pack for ${unbuilt.join(", ")}: run \`rgl run\`, or keep \`rgl watch\` running, first. ` +
              "Validated that source pack instead; it holds the filter inputs, not what the game loads. sculkwire does not run rgl",
          };
        }
      } else {
        // The caller who asked for the build output gets an error; `auto` falls back to the sources with a warning.
        const message = `${RGL_NOT_BUILT}. Validated the source packs instead; they hold the filter inputs, not what the game loads`;
        notBuilt = { severity: mode === "build" ? "error" : "warning", message };
        regolith = { profile: plan.profile, built: false, message };
      }
    } else if (plan) {
      const message = plan.hasFilters ? "validated the source packs, not rgl's build output (regolith: source)" : "profile has no filters; validated the source packs";
      notBuilt = { severity: "info", message };
      regolith = { profile: plan.profile, built: false, message };
    }
  }
  for (const info of layout.packs) {
    const built = builtSources.get(resolve(info.dir));
    packs.push(built ? await loadPack(info, root, { dir: built, displayDir: info.relDir, sourceDir: info.dir }) : await loadPack(info, root));
  }
  const ctx = new Context(root, packs, opts.overlay);
  if (notBuilt && layout.regolith) {
    ctx.push({ severity: notBuilt.severity, code: "regolith.not-built", message: notBuilt.message, file: toPosix(relative(root, layout.regolith.configPath)) });
  }
  await readManifests(ctx);

  const env: CheckEnv = { root, ctx, packs, channel, opts, schemaOpts: {}, schemaSources: {} };
  if (vanilla) env.vanilla = vanilla;
  if (gameVersion) env.gameVersion = gameVersion;
  const engineDir = opts.engineSchemasDir ?? samplesRoot;
  if (engineDir) env.schemaOpts.engineSchemasDir = engineDir;
  let rockide: RockideSource | undefined;
  if (checks.includes("schema")) {
    rockide = opts.rockideSchemasDir ? { root: resolve(opts.rockideSchemasDir) } : await opts.resolveRockide?.();
    if (rockide?.root) env.schemaOpts.rockideSchemasDir = rockide.root;
    if (vanilla) env.calibration = await calibration(vanilla.identity, env.schemaOpts, () => vanillaFiles(vanilla.root));
  }

  const run = checks.map((c) => CHECK_RUNS[c]);
  let filesChecked = 0;
  for (const pack of packs) {
    for (const rel of pack.files) {
      filesChecked++;
      if (!JSON_EXT.test(rel)) continue;
      const doc = await ctx.json(pack, rel);
      if (!doc) continue;
      for (const check of run) await check.file?.(env, pack, rel, doc);
    }
  }
  for (const check of run) await check.project?.(env);

  const diagnostics = ctx.diagnostics.sort(compareDiagnostics);
  const { ok, summary } = verdict(diagnostics, opts.failOn);
  const target: ValidationResult["target"] = { channel };
  if (version) target.version = version;
  const out: ValidationResult = {
    root,
    target,
    ok,
    packs: packs.map((p) => {
      const { dir: _dir, ...rest } = p.info;
      return { ...rest, files: p.files.length };
    }),
    filesChecked,
    checks,
    diagnostics,
    summary,
    schemaSources: env.schemaSources,
  };
  if (vanilla) out.vanilla = vanilla.version ? { root: vanilla.root, version: vanilla.version } : { root: vanilla.root };
  if (rockide) out.rockide = rockide;
  if (regolith) out.regolith = regolith;
  return out;
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
    const diagnostics: Diagnostic[] = JSON_EXT.test(abs) ? parseJson(content).problems.map((p) => toDiagnostic({ ...jsonFinding(p), file })) : [];
    const { ok, summary } = verdict(diagnostics, opts.failOn);
    return { root, target: { channel: opts.channel ?? "stable" }, ok, packs: [], filesChecked: 1, checks: ["json"], diagnostics, summary, schemaSources: {} };
  }
  const r = await validateProject(root, { ...opts, overlay, regolith: "source" });
  const file = toPosix(relative(root, abs));
  const diagnostics = r.diagnostics.filter((d) => d.file === file);
  const schemaSources: Record<string, string> = {};
  if (r.schemaSources[file]) schemaSources[file] = r.schemaSources[file] as string;
  return { ...r, filesChecked: 1, diagnostics, ...verdict(diagnostics, opts.failOn), schemaSources };
}
