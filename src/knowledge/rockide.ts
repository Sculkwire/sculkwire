/**
 * rockide/schemas (https://github.com/rockide/schemas): community JSON schemas for Bedrock add-on files, one folder
 * per `format_version`. Fetched at runtime into `cacheDir('knowledge','rockide')` and kept on the newest release.
 *
 * Cache (`tracked.ts`): one directory per release tag (`<tag>/`, the source tarball of the tag with `schema/` and
 * `scripts/compile.ts`, whose entry tables `rockideRoutes` reads for the validator) plus `current.json` naming the
 * release in use. The release asset `schemas.tar.gz` is not used: it holds only compiled bundles. The tags are
 * re-checked at most once a day (`git ls-remote --tags`), or on `refresh` (`sculk knowledge update`); offline and failed
 * checks keep the last copy.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { x as untar } from "tar";
import { errorMessage } from "../core/errors.ts";
import { writeFileAtomic } from "../core/fs.ts";
import { isPlainObject, type JsonObject } from "../core/json.ts";
import { memoAsync } from "../core/memo.ts";
import { cacheDir } from "../core/paths.ts";
import type { PackKind } from "../core/project.ts";
import { compareDotted } from "../core/version.ts";
import { readSchemaJson } from "./metadata.ts";
import { httpBytes, runOk } from "./net.ts";
import { ensureTracked, type Marker, readTracked, type ReleaseFetcher, type TrackedCopy, type TrackedSpec } from "./tracked.ts";

export const ROCKIDE_REPO = "https://github.com/rockide/schemas";

export interface RockideRelease {
  /** Release tag (`0.1.4`). */
  version: string;
  commit: string;
}

export type RockideFetcher = ReleaseFetcher<RockideRelease>;

const STABLE_TAG = /^v?(\d+\.\d+\.\d+)$/;

/** Newest `x.y.z` tag (pre-release tags are skipped) from `git ls-remote --tags` output; peeled commits win. */
export function newestRelease(lsRemote: string): RockideRelease | undefined {
  const commits = new Map<string, string>();
  for (const line of lsRemote.split("\n")) {
    const m = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (m?.[1] && m[2] && (m[3] || !commits.has(m[2]))) commits.set(m[2], m[1]);
  }
  let best: { tag: string; version: string } | undefined;
  for (const tag of commits.keys()) {
    const version = STABLE_TAG.exec(tag)?.[1];
    if (version && (!best || compareDotted(version, best.version) > 0)) best = { tag, version };
  }
  return best ? { version: best.tag, commit: commits.get(best.tag) as string } : undefined;
}

const githubFetcher: RockideFetcher = {
  async latest() {
    const { stdout } = await runOk("git", ["ls-remote", "--tags", ROCKIDE_REPO]);
    const release = newestRelease(stdout);
    if (!release) throw new Error(`git ls-remote ${ROCKIDE_REPO}: no release tag`);
    return release;
  },
  async download(release, dest) {
    const bytes = await httpBytes(`${ROCKIDE_REPO.replace("://github.com/", "://codeload.github.com/")}/tar.gz/${release.commit}`);
    const archive = join(dest, ".schemas.tar.gz");
    await writeFileAtomic(archive, bytes);
    await untar({ file: archive, cwd: dest, strip: 1 });
    await rm(archive, { force: true });
  },
};

const SHA_RE = /^[0-9a-f]{40}$/;

const SPEC: TrackedSpec<RockideRelease> = {
  key: "rockide",
  name: "rockide/schemas",
  dir: () => cacheDir("knowledge", "rockide"),
  complete: (dir) => existsSync(join(dir, "schema", "bedrock")) && existsSync(join(dir, "scripts", "compile.ts")),
  // Before releases were tracked, `current.json` named a `main` commit directory. It stays usable (offline too) and
  // counts as never checked, so the first online use switches to the newest release.
  legacy: (raw): Marker<RockideRelease> | undefined =>
    typeof raw.commit === "string" && SHA_RE.test(raw.commit)
      ? { release: { version: "main", commit: raw.commit }, dir: raw.commit, fetchedAt: String(raw.fetchedAt), checkedAt: new Date(0).toISOString() }
      : undefined,
};

export interface EnsureRockideOptions {
  /** Cache only; never contact GitHub. */
  offline?: boolean;
  /** Check the release tags now, even when the last check is less than a day old. */
  refresh?: boolean;
  /** Clock and network, for tests. */
  now?: number;
  fetcher?: RockideFetcher;
}

/**
 * The cached rockide/schemas release (its `root` holds `schema/` and `scripts/compile.ts`), downloading or switching
 * to a newer release when due. Throws only when no copy exists and one cannot be fetched (offline, network failure);
 * a failed update falls back to the cached copy (`stale`).
 */
export function ensureRockideSchemas(opts: EnsureRockideOptions = {}): Promise<TrackedCopy<RockideRelease>> {
  return ensureTracked(SPEC, githubFetcher, opts);
}

/** The copy in use without any network or download, for status reports. */
export function rockideStatus(): Promise<Marker<RockideRelease> | undefined> {
  return readTracked(SPEC);
}

/** One entry of rockide's own file -> schema routing: globs relative to a pack root and the schema they select. */
export interface RockideRoute {
  packKind: PackKind;
  /** VS Code `fileMatch` globs; a leading `!` excludes. */
  fileMatch: string[];
  /** Absolute schema file. */
  file: string;
}

/** Rockide's routing, parsed from the BP/RP/SP entry tables of its `scripts/compile.ts`. */
export async function rockideRoutes(root: string): Promise<RockideRoute[]> {
  const src = await readFile(join(root, "scripts", "compile.ts"), "utf8");
  const routes: RockideRoute[] = [];
  for (const [constName, packKind] of [
    ["BP_ENTRIES", "behavior"],
    ["RP_ENTRIES", "resource"],
    ["SP_ENTRIES", "skin"],
  ] as [string, PackKind][]) {
    const block = new RegExp(`const ${constName}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`).exec(src)?.[1];
    if (!block) continue;
    for (const m of block.matchAll(/fileMatch:\s*(\[[^\]]*\]|"[^"]*"),\s*url:\s*"([^"]+)"/g)) {
      const raw = m[1] as string;
      const fileMatch = (raw.startsWith("[") ? JSON.parse(raw.replace(/,\s*\]/, "]")) : [JSON.parse(raw)]) as string[];
      routes.push({ packKind, fileMatch, file: join(root, m[2] as string) });
    }
  }
  return routes;
}


export interface RockideProperty {
  name: string;
  type?: string;
  description?: string;
  default?: unknown;
  /** Allowed values (first 50; `enumCount` gives the total when longer). */
  enum?: unknown[];
  enumCount?: number;
  minimum?: number;
  maximum?: number;
  required?: boolean;
  deprecated?: boolean;
  properties?: RockideProperty[];
}

export interface RockideComponent {
  /** `server/entity/behaviors`, `server/block/components`, `client/entity/...`. */
  scope: string;
  /** Every schema format_version folder that lists the component, ascending. */
  formatVersions: string[];
  /** Folder used for the summary: the newest one not newer than the game version. */
  selectedVersion: string;
  /** True when every folder is newer than the game version (the newest one is summarized). */
  newerThanGame?: boolean;
  /** Schema file of the selected version, relative to the rockide root (`#pointer` for definitions inside a file). */
  file: string;
  title?: string;
  description?: string;
  type?: string;
  properties: RockideProperty[];
  /** Format versions where the component's schema changed, with the schema file each one introduced. */
  changes: { formatVersion: string; file: string }[];
}

export interface RockideLookup {
  repo: string;
  /** Release tag in use. */
  release?: string;
  commit?: string;
  /** Newest release seen upstream (differs from `release` while its download keeps failing). */
  latest?: string;
  /** Local copy the results come from. */
  root?: string;
  /** Game version the selection targets. */
  gameVersion: string;
  matches: RockideComponent[];
  /** Why there are no rockide results (not cached, offline, failed fetch), or that the copy is stale. */
  note?: string;
}

interface IndexEntry {
  scope: string;
  version: string;
  /** The `_index.json` naming the component and its property node there (a `$ref` or an inline definition). */
  indexFile: string;
  node: JsonObject;
  /** Where the definition lives, relative to the rockide root (`file#pointer`). */
  target: string;
}

const VERSION_DIR = /^\d+(?:\.\d+)+$/;
/** Allowed values kept in structured results / shown in text summaries. */
const ENUM_CAP = 50;
const TEXT_ENUM_CAP = 12;


function atPointer(doc: unknown, pointer: string): unknown {
  let v = doc;
  for (const raw of pointer.split("/").filter(Boolean)) {
    const seg = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isPlainObject(v) && !Array.isArray(v)) return undefined;
    v = (v as JsonObject)[seg];
  }
  return v;
}

function splitRef(ref: string, fromFile: string): { file: string; pointer: string } {
  const [path = "", pointer = ""] = ref.split("#");
  return { file: path ? join(dirname(fromFile), path) : fromFile, pointer };
}

const indexMemo = memoAsync<Map<string, IndexEntry[]>>();

/** id -> every `<area>/<kind>/<version>/<group>/_index.json` entry naming it. */
function componentIndex(root: string): Promise<Map<string, IndexEntry[]>> {
  return indexMemo(root, async () => {
    const out = new Map<string, IndexEntry[]>();
    const base = join(root, "schema", "bedrock");
    const dirs = async (d: string) =>
      (await readdir(d, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const area of await dirs(base)) {
      for (const kind of await dirs(join(base, area))) {
        for (const version of (await dirs(join(base, area, kind))).filter((v) => VERSION_DIR.test(v))) {
          for (const group of await dirs(join(base, area, kind, version))) {
            const indexFile = join(base, area, kind, version, group, "_index.json");
            if (!existsSync(indexFile)) continue;
            let index: unknown;
            try {
              index = await readSchemaJson(indexFile);
            } catch {
              continue;
            }
            const props = isPlainObject(index) && isPlainObject(index.properties) ? index.properties : {};
            for (const [id, node] of Object.entries(props)) {
              if (!id.includes(":") || !isPlainObject(node)) continue;
              const { file, pointer } =
                typeof node.$ref === "string" ? splitRef(node.$ref, indexFile) : { file: indexFile, pointer: `/properties/${id.replace(/~/g, "~0").replace(/\//g, "~1")}` };
              const entry: IndexEntry = { scope: `${area}/${kind}/${group}`, version, indexFile, node, target: posix(root, file, pointer) };
              const list = out.get(id) ?? [];
              list.push(entry);
              out.set(id, list);
            }
          }
        }
      }
    }
    return out;
  });
}

/** Every component id rockide knows (for suggestions). */
export async function rockideComponentIds(root: string): Promise<string[]> {
  return [...(await componentIndex(root)).keys()];
}

/** Follow `$ref` chains (bounded); sibling keys of a `$ref` override the target's, as VS Code merges them. */
async function deref(node: unknown, file: string, depth = 0): Promise<{ node: JsonObject; file: string }> {
  if (!isPlainObject(node)) return { node: {}, file };
  if (typeof node.$ref !== "string" || depth > 8) return { node, file };
  const { file: f, pointer } = splitRef(node.$ref, file);
  let target: unknown;
  try {
    target = atPointer(await readSchemaJson(f), pointer);
  } catch {
    return { node, file };
  }
  const { $ref: _ref, ...rest } = node;
  const inner = await deref(target, f, depth + 1);
  const merged: JsonObject = { ...inner.node };
  for (const [k, v] of Object.entries(rest)) if (v !== "" && v !== undefined) merged[k] = v;
  return { node: merged, file: inner.file };
}

const branchesOf = (n: JsonObject): unknown[] => [...((n.anyOf as unknown[]) ?? []), ...((n.oneOf as unknown[]) ?? [])];

async function describeType(node: JsonObject, file: string, depth = 0): Promise<{ types: string[]; values: unknown[] }> {
  const types = new Set<string>();
  const values: unknown[] = [];
  const declared = typeof node.type === "string" ? [node.type] : Array.isArray(node.type) ? node.type.map(String) : [];
  for (const t of declared) {
    // `array<string>`: element types (and their allowed values) of a uniform array.
    if (t === "array" && isPlainObject(node.items) && depth < 3) {
      const r = await deref(node.items, file);
      const inner = await describeType(r.node, r.file, depth + 1);
      types.add(inner.types.length ? `array<${inner.types.join(" | ")}>` : "array");
      values.push(...inner.values);
    } else types.add(t);
  }
  if (Array.isArray(node.enum)) values.push(...node.enum);
  if ("const" in node) values.push(node.const);
  if (depth < 3) {
    for (const b of branchesOf(node)) {
      const r = await deref(b, file);
      // Case-insensitive pattern branches repeat an enum; they add nothing to the summary.
      if (typeof r.node.pattern === "string" && !r.node.type && !r.node.enum) continue;
      const inner = await describeType(r.node, r.file, depth + 1);
      for (const t of inner.types) types.add(t);
      values.push(...inner.values);
    }
  }
  if (!types.size && values.length) for (const v of values) types.add(v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  return { types: [...types], values };
}

async function summarize(raw: unknown, file: string, name: string, required: boolean, depth: number): Promise<RockideProperty> {
  const { node, file: f } = await deref(raw, file);
  const p: RockideProperty = { name };
  const { types, values } = await describeType(node, f);
  if (types.length) p.type = types.join(" | ");
  if (typeof node.description === "string" && node.description.trim()) p.description = node.description.trim();
  if (node.default !== undefined) p.default = node.default;
  const unique = [...new Set(values.map((v) => JSON.stringify(v)))].map((v) => JSON.parse(v) as unknown);
  if (unique.length) {
    p.enum = unique.slice(0, ENUM_CAP);
    if (unique.length > ENUM_CAP) p.enumCount = unique.length;
  }
  if (typeof node.minimum === "number" && Math.abs(node.minimum) < 3e38 && node.minimum !== -2147483648) p.minimum = node.minimum;
  if (typeof node.maximum === "number" && Math.abs(node.maximum) < 3e38 && node.maximum !== 2147483647) p.maximum = node.maximum;
  if (required) p.required = true;
  if (node.deprecated === true) p.deprecated = true;
  if (depth < 2) {
    const kids = await properties(node, f, depth + 1);
    if (kids.length) p.properties = kids;
  }
  return p;
}

async function properties(node: JsonObject, file: string, depth: number): Promise<RockideProperty[]> {
  // The object form among `oneOf: [shorthand, {type: object, properties}]`, or the element of an array of objects.
  let obj: { node: JsonObject; file: string } | undefined;
  for (const c of [{ node, file }, ...(await Promise.all(branchesOf(node).map((b) => deref(b, file))))]) {
    const candidate = !isPlainObject(c.node.properties) && isPlainObject(c.node.items) ? await deref(c.node.items, c.file) : c;
    if (isPlainObject(candidate.node.properties)) {
      obj = candidate;
      break;
    }
  }
  if (!obj) return [];
  const req = new Set(Array.isArray(obj.node.required) ? (obj.node.required as string[]) : []);
  const out: RockideProperty[] = [];
  for (const [name, child] of Object.entries(obj.node.properties as JsonObject)) out.push(await summarize(child, obj.file, name, req.has(name), depth));
  return out;
}

const posix = (root: string, file: string, pointer: string): string =>
  `${relative(root, file).split("\\").join("/")}${pointer ? `#${pointer}` : ""}`;

/** Rockide schema of one component id per scope, summarized at the newest format_version <= `gameVersion`. */
export async function rockideComponent(root: string, id: string, gameVersion: string): Promise<RockideComponent[]> {
  const entries = (await componentIndex(root)).get(id) ?? [];
  const game = gameVersion.split(".").slice(0, 3).join(".");
  const byScope = new Map<string, IndexEntry[]>();
  for (const e of entries) byScope.set(e.scope, [...(byScope.get(e.scope) ?? []), e]);
  const out: RockideComponent[] = [];
  for (const [scope, list] of [...byScope].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => compareDotted(a.version, b.version));
    const fit = list.filter((e) => compareDotted(e.version, game) <= 0);
    const sel = (fit.at(-1) ?? list.at(-1)) as IndexEntry;
    const changes: RockideComponent["changes"] = [];
    for (const e of list) if (changes.at(-1)?.file !== e.target) changes.push({ formatVersion: e.version, file: e.target });
    const { node, file } = await deref(sel.node, sel.indexFile);
    const c: RockideComponent = {
      scope,
      formatVersions: list.map((e) => e.version),
      selectedVersion: sel.version,
      file: sel.target,
      properties: await properties(node, file, 0),
      changes,
    };
    if (!fit.length) c.newerThanGame = true;
    if (typeof node.title === "string" && node.title) c.title = node.title;
    if (typeof node.description === "string" && node.description.trim()) c.description = node.description.trim();
    const { types } = await describeType(node, file);
    if (types.length) c.type = types.join(" | ");
    out.push(c);
  }
  return out;
}

/** Fail-open lookup for `component_lookup`: no cached copy (or offline without one) yields a note, never an error. */
export async function lookupRockide(id: string, gameVersion: string, opts: EnsureRockideOptions = {}): Promise<RockideLookup> {
  let checkout: TrackedCopy<RockideRelease>;
  try {
    checkout = await ensureRockideSchemas(opts);
  } catch (err) {
    return { repo: ROCKIDE_REPO, gameVersion, matches: [], note: `rockide/schemas unavailable: ${errorMessage(err)}` };
  }
  const r: RockideLookup = {
    repo: ROCKIDE_REPO,
    release: checkout.release.version,
    commit: checkout.release.commit,
    latest: checkout.latest,
    root: checkout.root,
    gameVersion,
    matches: await rockideComponent(checkout.root, id, gameVersion),
  };
  if (checkout.stale) r.note = `using cached release ${checkout.release.version}; update failed: ${checkout.stale}`;
  return r;
}

function propertyLine(p: RockideProperty, indent: string): string[] {
  const facts = [
    p.type,
    p.required ? "required" : undefined,
    p.default !== undefined ? `default ${JSON.stringify(p.default)}` : undefined,
    p.enum
      ? `one of ${p.enum.slice(0, TEXT_ENUM_CAP).map((v) => JSON.stringify(v)).join(", ")}${(p.enumCount ?? p.enum.length) > TEXT_ENUM_CAP ? `, … (${p.enumCount ?? p.enum.length} values)` : ""}`
      : undefined,
    p.minimum !== undefined ? `min ${p.minimum}` : undefined,
    p.maximum !== undefined ? `max ${p.maximum}` : undefined,
    p.deprecated ? "deprecated" : undefined,
  ].filter(Boolean);
  return [
    `${indent}- ${p.name}${facts.length ? ` (${facts.join("; ")})` : ""}${p.description ? `: ${p.description.replace(/\n/g, " ")}` : ""}`,
    ...(p.properties ?? []).flatMap((c) => propertyLine(c, `${indent}  `)),
  ];
}

/** Text summary of a rockide lookup, shared by the CLI and `component_lookup`. */
export function formatRockide(r: RockideLookup): string[] {
  const lines: string[] = [];
  const head = `rockide/schemas${r.release ? ` ${r.release}` : ""}${r.commit ? ` @ ${r.commit.slice(0, 10)}` : ""}`;
  if (r.note) lines.push(`${head}: ${r.note}`);
  for (const m of r.matches) {
    lines.push(
      `${head} ${m.scope} format_version ${m.selectedVersion}${m.newerThanGame ? ` (newer than ${r.gameVersion})` : ""}: ${m.file}`,
      `  versions: ${m.formatVersions.join(", ")}; changed in ${m.changes.map((c) => c.formatVersion).join(", ")}`,
    );
    if (m.description) lines.push(`  ${m.description.replace(/\n/g, " ")}`);
    for (const p of m.properties) lines.push(...propertyLine(p, "  "));
  }
  return lines;
}
