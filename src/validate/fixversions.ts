/**
 * `pack_fix_versions`: raise outdated version fields of a project's packs, dry run by default.
 *   - manifest `header.min_engine_version` -> the channel's current game version, only when lower;
 *   - manifest script-module dependencies (`@minecraft/server`, ...) -> the newest version for the channel from the
 *     knowledge npm pins, beta only when the manifest already asks for a beta; never a downgrade;
 *   - content-file `format_version`s are only suggested: schemas change between versions. With `formatVersions` a file
 *     is moved to the newest version its schema knows (never past the game) when the validator finds no error the file
 *     did not already have under the new version; otherwise it is skipped with the reason.
 * Every edit is a splice at the value's source range, so formatting and comments stay. Regolith projects: the source
 * packs are edited, never rgl's build output in `.regolith/tmp`.
 */
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { formatDiagnostic } from "../core/diagnostic.ts";
import { writeFileAtomic } from "../core/fs.ts";
import { isPlainObject } from "../core/json.ts";
import { discoverProject } from "../core/project.ts";
import { regolithPlan } from "../core/regolith.ts";
import { type Channel, compareTuples } from "../core/version.ts";
import { readScriptModuleVersions } from "../knowledge/metadata.ts";
import { getPins, parseNpmVersion } from "../knowledge/versions.ts";
import { classifyFile, formatVersionOf, JSON_EXT, versionTuple } from "./classify.ts";
import { loadPack, toPosix } from "./context.ts";
import { validateDefaults, validateProject, type ValidateOptions } from "./index.ts";
import { type JsonNode, nodeAtPointer, parseJson } from "./jsonc.ts";
import { NPM_ONLY } from "./manifest.ts";
import { knownFormatVersions, type SchemaOptions } from "./schema.ts";

/** What the fields are raised to. */
export interface FixTargets {
  /** Game version `min_engine_version` is raised to and `format_version`s are capped at (`1.26.60`). */
  gameVersion: string;
  /** Per script module, the manifest versions to move to: `stable` (`2.3.0`) and `beta` (`2.4.0-beta`). */
  modules: Record<string, { stable?: string; beta?: string }>;
  /** Module -> manifest versions the game ships (bedrock-samples metadata), when known. */
  shipped?: Map<string, Map<string, string | undefined>>;
}

export interface FixOptions {
  channel?: Channel;
  /** Write the changes (default: dry run). */
  apply?: boolean;
  /** Also move content-file `format_version`s the validator accepts under the newer version. */
  formatVersions?: boolean;
  /**
   * The game the packs must load on (`1.26.63`): `min_engine_version` is never raised past it, since a client older
   * than a pack's `min_engine_version` refuses the pack.
   */
  gameVersion?: string;
  /** Targets instead of the knowledge pins (tests). */
  targets?: FixTargets;
  /** Schema and samples sources; unset ones come from the validator's knowledge providers. */
  samplesRoot?: string;
  rockideSchemasDir?: string;
  engineSchemasDir?: string;
}

export interface VersionChange {
  /** Project-relative path. */
  file: string;
  /** JSON pointer of the value. */
  pointer: string;
  from: string;
  to: string;
  applied: boolean;
}

export interface VersionNote {
  file: string;
  pointer?: string;
  from?: string;
  to?: string;
  reason: string;
}

export interface FixResult {
  root: string;
  channel: Channel;
  target: { gameVersion: string };
  applied: boolean;
  changes: VersionChange[];
  /** Newer `format_version`s the schemas know, not applied (pass `formatVersions` to try them). */
  suggestions: VersionNote[];
  skipped: VersionNote[];
  /** Set for a Regolith project whose profile runs filters: the sources were edited, rgl's output was not. */
  regolith?: string;
}

const MODULE_VERSION = /^(\d+)\.(\d+)\.(\d+)(-beta)?$/;

/** Manifest version of an npm pin: a release or release candidate is `x.y.z`, a beta `x.y.z-beta`. */
function manifestVersion(npm: string | undefined, want: "stable" | "beta"): string | undefined {
  const info = npm ? parseNpmVersion(npm) : undefined;
  if (!info) return undefined;
  const base = info.base.join(".");
  if (want === "beta") return info.kind === "beta" ? `${base}-beta` : undefined;
  return info.kind === "release" || info.kind === "rc" ? base : undefined;
}

/**
 * Targets from the knowledge pins of a channel, plus the module versions the game ships when samples are at hand.
 * The game version is the channel's bedrock-samples release (`1.26.60`), not the newest build a changelog names: a
 * hotfix newer than the samples is not on every client yet, and a pack whose `min_engine_version` is newer than the
 * client does not load. `gameVersion` lowers it further, to the game the packs are tested on.
 */
export async function resolveTargets(channel: Channel, samplesRoot?: string, gameVersion?: string): Promise<FixTargets> {
  const pin = (await getPins()).channels[channel];
  const modules: FixTargets["modules"] = {};
  for (const [pkg, p] of Object.entries(pin.npm)) {
    const stable = manifestVersion(p.default?.version, "stable");
    const beta = manifestVersion(p.beta?.version, "beta");
    modules[pkg] = { ...(stable ? { stable } : {}), ...(beta ? { beta } : {}) };
  }
  const tuple = (v: string) => versionTuple(v.replace(/[^\d.].*$/, "")).slice(0, 3);
  const candidates = [tuple(pin.version), tuple(pin.samples.version), ...(gameVersion ? [tuple(gameVersion)] : [])];
  const lowest = candidates.reduce((a, b) => (compareTuples(b, a) < 0 ? b : a));
  const targets: FixTargets = { gameVersion: lowest.join("."), modules };
  if (samplesRoot) {
    const shipped = await readScriptModuleVersions(samplesRoot);
    if (shipped.size) targets.shipped = shipped;
  }
  return targets;
}

interface Edit {
  offset: number;
  length: number;
  text: string;
}

/** Text with the edits spliced in (back to front, so offsets stay valid). */
function splice(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.offset - a.offset)) out = out.slice(0, e.offset) + e.text + out.slice(e.offset + e.length);
  return out;
}

/** The edit replacing a value node's source text. */
function valueEdit(node: JsonNode, text: string): Edit {
  return { offset: node.offset, length: node.length, text };
}

/** Queue edits of one file and the change they make. */
type AddEdits = (abs: string, text: string, edits: Edit[], change: VersionChange) => void;

/** The script module version to move `current` to, or why not. Undefined = already current. */
function moduleTarget(name: string, current: string, targets: FixTargets): { to: string } | { reason: string } | undefined {
  const m = MODULE_VERSION.exec(current);
  if (!m) return { reason: `version ${JSON.stringify(current)} is not x.y.z or x.y.z-beta` };
  const beta = m[4] !== undefined;
  const slot = beta ? "beta" : "stable";
  const shipped = targets.shipped?.get(name);
  if (targets.shipped && !shipped) return { reason: `${name} is not a script module Minecraft ${targets.gameVersion} ships` };
  let to = targets.modules[name]?.[slot];
  if (shipped && (!to || !shipped.has(to))) {
    // The pin is not (yet) in the game: the newest version of that kind the game ships instead.
    const same = [...shipped.keys()].filter((v) => MODULE_VERSION.test(v) && v.endsWith("-beta") === beta);
    same.sort((a, b) => compareTuples(versionTuple(a.replace("-beta", "")), versionTuple(b.replace("-beta", ""))));
    to = same.at(-1);
  }
  if (!to) return { reason: `no ${slot} version of ${name} known for this channel` };
  const cur = [Number(m[1]), Number(m[2]), Number(m[3])];
  return compareTuples(versionTuple(to.replace("-beta", "")), cur) > 0 ? { to } : undefined;
}

/** Raise outdated version fields under `path` (project, add-on or pack directory). */
export async function fixVersions(path: string, opts: FixOptions = {}): Promise<FixResult> {
  const root = resolve(path);
  const channel: Channel = opts.channel ?? "stable";
  const apply = opts.apply === true;
  const layout = await discoverProject(root);
  const samplesRoot = opts.samplesRoot ?? process.env.SCULKWIRE_SAMPLES ?? (await validateDefaults.resolveSamples?.(channel));
  const rockideSchemasDir = opts.rockideSchemasDir ?? validateDefaults.rockideSchemasDir ?? (await validateDefaults.resolveRockide?.())?.root;
  const schemaOpts: SchemaOptions = {};
  const engineDir = opts.engineSchemasDir ?? samplesRoot;
  if (engineDir) schemaOpts.engineSchemasDir = engineDir;
  if (rockideSchemasDir) schemaOpts.rockideSchemasDir = rockideSchemasDir;
  const targets = opts.targets ?? (await resolveTargets(channel, samplesRoot, opts.gameVersion));
  const game = versionTuple(targets.gameVersion);

  const result: FixResult = { root, channel, target: { gameVersion: targets.gameVersion }, applied: apply, changes: [], suggestions: [], skipped: [] };
  if (layout.regolith) {
    const plan = await regolithPlan(root);
    if (plan?.hasFilters) {
      result.regolith = "edited the source packs only, never rgl's build output in .regolith/tmp; run `rgl run` (or keep `rgl watch` running) to rebuild. sculkwire does not run rgl";
    }
  }

  /** Per absolute file: original text, edits, and the changes they make. */
  const files = new Map<string, { text: string; edits: Edit[]; changes: VersionChange[] }>();
  /** Content files whose format_version edit waits for the validator. */
  const formatEdits = new Map<string, { file: string; text: string; edit: Edit; change: VersionChange }>();
  const add: AddEdits = (abs, text, edits, change) => {
    let f = files.get(abs);
    if (!f) files.set(abs, (f = { text, edits: [], changes: [] }));
    f.edits.push(...edits);
    f.changes.push(change);
  };

  for (const info of layout.packs) {
    if (info.kind !== "behavior" && info.kind !== "resource") continue;
    const pack = await loadPack(info, root);
    for (const rel of pack.files) {
      if (!JSON_EXT.test(rel)) continue;
      const abs = join(pack.dir, ...rel.split("/"));
      const file = toPosix(relative(root, abs));
      let text: string;
      try {
        text = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      const doc = parseJson(text);
      if (doc.value === undefined) {
        if (rel === "manifest.json") result.skipped.push({ file, reason: "the game cannot read this JSON; fix its syntax first (validate_pack)" });
        continue;
      }
      if (rel === "manifest.json") {
        manifestEdits(file, abs, text, doc.root, doc.value, targets, game, result, add);
        continue;
      }
      const kind = classifyFile(info.kind, rel);
      const fv = formatVersionOf(doc.value);
      const fvNode = nodeAtPointer(doc.root, "/format_version");
      if (!fv || !fvNode || !versionTuple(fv).length) continue;
      const known = (await knownFormatVersions(info.kind, rel, kind, doc.value, schemaOpts)).filter((v) => !game.length || compareTuples(versionTuple(v).slice(0, 3), game) <= 0);
      const newest = known.at(-1);
      if (!newest || compareTuples(versionTuple(newest), versionTuple(fv)) <= 0) continue;
      const note = { file, pointer: "/format_version", from: fv, to: newest };
      if (!opts.formatVersions) {
        result.suggestions.push({ ...note, reason: `the schemas know format_version ${newest}; fields may have changed, so pass formatVersions to try it under the validator` });
        continue;
      }
      formatEdits.set(abs, { file, text, edit: valueEdit(fvNode, JSON.stringify(newest)), change: { ...note, applied: false } });
    }
  }

  if (formatEdits.size) {
    // Accept a new format_version only when the validator finds no error the file did not already have.
    const vopts: ValidateOptions = { checks: ["json", "schema"], regolith: "source", channel, gameVersion: targets.gameVersion };
    if (samplesRoot) vopts.samplesRoot = samplesRoot;
    if (opts.engineSchemasDir) vopts.engineSchemasDir = opts.engineSchemasDir;
    if (rockideSchemasDir) vopts.rockideSchemasDir = rockideSchemasDir;
    const before = await validateProject(root, vopts);
    const overlay = new Map([...formatEdits].map(([abs, f]) => [abs, splice(f.text, [f.edit])]));
    const after = await validateProject(root, { ...vopts, overlay });
    const key = (d: { code: string; pointer?: string; message: string }): string => `${d.code}|${d.pointer ?? ""}|${d.message}`;
    for (const [abs, f] of formatEdits) {
      const old = new Set(before.diagnostics.filter((d) => d.file === f.file && d.severity === "error").map(key));
      const fresh = after.diagnostics.filter((d) => d.file === f.file && d.severity === "error" && !old.has(key(d)));
      if (fresh.length) {
        const more = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : "";
        result.skipped.push({ file: f.file, pointer: f.change.pointer, from: f.change.from, to: f.change.to, reason: `invalid under ${f.change.to}: ${formatDiagnostic(fresh[0] as (typeof fresh)[number])}${more}` });
        continue;
      }
      add(abs, f.text, [f.edit], f.change);
    }
  }

  for (const [abs, f] of files) {
    if (apply) {
      await writeFileAtomic(abs, splice(f.text, f.edits));
      for (const c of f.changes) c.applied = true;
    }
    result.changes.push(...f.changes);
  }
  result.changes.sort((a, b) => a.file.localeCompare(b.file) || a.pointer.localeCompare(b.pointer));
  return result;
}

function manifestEdits(
  file: string,
  abs: string,
  text: string,
  root: JsonNode | undefined,
  value: unknown,
  targets: FixTargets,
  game: number[],
  result: FixResult,
  add: AddEdits,
): void {
  if (!isPlainObject(value)) return;
  const header = isPlainObject(value.header) ? value.header : undefined;
  const mev = header?.min_engine_version;
  const mevPtr = "/header/min_engine_version";
  const mevNode = nodeAtPointer(root, mevPtr);
  if (mev !== undefined && mevNode && game.length) {
    const nums = Array.isArray(mev) && mev.length === 3 && mev.every((n) => Number.isInteger(n)) ? (mev as number[]) : typeof mev === "string" && versionTuple(mev).length === 3 ? versionTuple(mev) : undefined;
    if (!nums) result.skipped.push({ file, pointer: mevPtr, from: JSON.stringify(mev), reason: "min_engine_version is not [major, minor, patch]" });
    else if (compareTuples(nums, game) < 0) {
      const change = { file, pointer: mevPtr, from: nums.join("."), to: game.join("."), applied: false };
      if (mevNode.type === "array") {
        // Only the numbers that change, so the array's layout and comments stay.
        add(abs, text, (mevNode.children ?? []).flatMap((n, i) => (n.value === game[i] ? [] : [valueEdit(n, String(game[i]))])), change);
      } else add(abs, text, [valueEdit(mevNode, JSON.stringify(game.join(".")))], change);
    }
  }
  const deps = Array.isArray(value.dependencies) ? value.dependencies : [];
  for (const [i, dep] of deps.entries()) {
    if (!isPlainObject(dep) || typeof dep.module_name !== "string") continue;
    const name = dep.module_name;
    const pointer = `/dependencies/${i}/version`;
    if (NPM_ONLY[name]) {
      result.skipped.push({ file, pointer, reason: `${name} is an npm library, not a native module; bundle it and remove the dependency` });
      continue;
    }
    const node = nodeAtPointer(root, pointer);
    if (typeof dep.version !== "string" || !node) {
      result.skipped.push({ file, pointer, reason: `${name} version is not a string` });
      continue;
    }
    const t = moduleTarget(name, dep.version, targets);
    if (!t) continue;
    if ("reason" in t) result.skipped.push({ file, pointer, from: dep.version, reason: t.reason });
    else add(abs, text, [valueEdit(node, JSON.stringify(t.to))], { file, pointer, from: dep.version, to: t.to, applied: false });
  }
}

/** Text summary of a run: one line per change, suggestion and skip, at most `max` of them (MCP text and CLI output). */
export function fixSummary(r: FixResult, max = 40): string {
  const verb = r.applied ? "changed" : "would change (dry run: nothing written)";
  const head = [`${r.changes.length} field(s) ${verb}, ${r.suggestions.length} suggestion(s), ${r.skipped.length} skipped; target ${r.channel} ${r.target.gameVersion}`];
  if (r.regolith) head.push(`note: ${r.regolith}`);
  const lines = [
    ...r.changes.map((c) => `${c.file} ${c.pointer}: ${c.from} -> ${c.to}`),
    ...r.suggestions.map((s) => `suggest ${s.file} ${s.pointer}: ${s.from} -> ${s.to}`),
    ...r.skipped.map((s) => `skipped ${s.file}${s.pointer ? ` ${s.pointer}` : ""}: ${s.reason}`),
  ];
  const more = lines.length > max ? [`... ${lines.length - max} more in structuredContent`] : [];
  return [...head, ...lines.slice(0, max), ...more].join("\n");
}
