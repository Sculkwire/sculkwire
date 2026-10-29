/**
 * JSON-schema validation, schema chosen by file kind + `format_version`, first source that covers the file wins:
 *   rockide  rockide/schemas (cached copy from `src/knowledge/rockide.ts`, or `--rockide <dir>`),
 *            routed by its own fileMatch table, one schema folder per format_version;
 *   engine   bedrock-samples `metadata/json_schemas/<area>/<kind>/<format_version>/` (runtime checkout) or any folder
 *            with that layout (`--engine-schemas`), nearest version <= the file's.
 * Ajv errors are reduced to the explanation (the anyOf branch that got furthest) and mapped to source ranges.
 * Vanilla calibration: a complaint vanilla content also triggers is a schema gap, reported as `schema.gap`.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseJsonc } from "jsonc-parser";
import type { Diagnostic } from "../core/diagnostic.ts";
import { cacheDir } from "../core/paths.ts";
import type { PackKind } from "../core/project.ts";
import { compareVersionTuples, type FileKind, formatVersionOf, versionTuple } from "./classify.ts";
import { type JsonDocument, parsePointer, pointerJoin, rangeAtPointer } from "./jsonc.ts";

export type SchemaSourceName = "engine" | "rockide";

export interface SchemaChoice {
  source: SchemaSourceName;
  /** Absolute schema file. */
  file: string;
  /** Instance subtree the schema describes ("" = whole document). */
  pointer: string;
  /** Engine schema version folder, when versioned. */
  version?: string;
  dialect: "draft-07" | "2020-12";
  /** Short human label, e.g. `engine server/entity/1.26.50/ActorDocument.json`. */
  label: string;
}

export interface SchemaOptions {
  /** bedrock-samples checkout; its `metadata/json_schemas` is the engine schema source unless `engineSchemasDir` is set. */
  samplesRoot?: string;
  /** Engine schema dump: a bedrock-samples root or a directory in the `<area>/<kind>/<format_version>/` layout. */
  engineSchemasDir?: string;
  rockideSchemasDir?: string;
}

/** Directory in the `<area>/<kind>/<format_version>/` layout, when an engine schema source is configured. */
export function engineSchemasBase(opts: SchemaOptions): string | undefined {
  const dir = opts.engineSchemasDir ?? opts.samplesRoot;
  if (!dir) return undefined;
  const nested = join(dir, "metadata", "json_schemas");
  return existsSync(nested) ? nested : dir;
}

const MAX_ERRORS_PER_FILE = 20;
const CALIBRATION_VERSION = 4;

// ---------------------------------------------------------------- engine schemas (bedrock-samples)

interface EngineRoot {
  kind: FileKind;
  dirs: string[];
  file: string;
  pointer: string;
}

/** Document roots of the engine schema dump and the file subtree each one describes. */
const ENGINE_ROOTS: EngineRoot[] = [
  { kind: "entity", dirs: ["server/entity"], file: "ActorDocument.json", pointer: "/minecraft:entity" },
  { kind: "item", dirs: ["server/item"], file: "ItemDocument.json", pointer: "/minecraft:item" },
  // 1.20.50 dumped only the component table: validate components of items older than the 1.26.30 document.
  { kind: "item", dirs: ["server/item"], file: "Component.json", pointer: "/minecraft:item/components" },
  { kind: "block", dirs: ["server/block"], file: "Blocks.json", pointer: "/minecraft:block" },
  { kind: "biome", dirs: ["server/biome"], file: "Biome Document.json", pointer: "" },
  { kind: "client_biome", dirs: ["client/biome"], file: "Client Biome Document.json", pointer: "" },
  { kind: "particle", dirs: ["client/particles"], file: "Particle Effect Data.json", pointer: "/particle_effect" },
  { kind: "dimension", dirs: ["client_server/dimension"], file: "Dimensions.json", pointer: "" },
  { kind: "spawn_rule", dirs: ["server/spawn", "client_server/spawn"], file: "Spawn Rules.json", pointer: "/minecraft:spawn_rules" },
  { kind: "feature_rule", dirs: ["client_server/world"], file: "Feature Rule.json", pointer: "/minecraft:feature_rules" },
  { kind: "jigsaw_structure", dirs: ["client_server/world"], file: "JigsawStructure.json", pointer: "/minecraft:jigsaw" },
  { kind: "structure_set", dirs: ["client_server/world"], file: "Structure Set.json", pointer: "/minecraft:structure_set" },
  { kind: "processor_list", dirs: ["client_server/world"], file: "Processor List.json", pointer: "/minecraft:processor_list" },
  { kind: "template_pool", dirs: ["server/world"], file: "Template Pool.json", pointer: "/minecraft:template_pool" },
  { kind: "voxel_shape", dirs: ["server/voxel_shapes"], file: "VoxelShapeFile.json", pointer: "/minecraft:voxel_shape" },
  { kind: "block_culling", dirs: ["client/block"], file: "Culling.json", pointer: "/minecraft:block_culling_rules" },
];

interface EngineCandidate {
  version: number[];
  versionText: string;
  file: string;
  root: EngineRoot;
}

const engineIndexMemo = new Map<string, Promise<Map<FileKind, EngineCandidate[]>>>();

/** kind -> candidate schema files sorted by version (beta folders excluded; `legacy` sorts first). */
function engineIndex(base: string): Promise<Map<FileKind, EngineCandidate[]>> {
  let p = engineIndexMemo.get(base);
  if (!p) {
    p = (async () => {
      const out = new Map<FileKind, EngineCandidate[]>();
      for (const root of ENGINE_ROOTS) {
        for (const dir of root.dirs) {
          let versions: string[] = [];
          try {
            versions = await readdir(join(base, dir));
          } catch {
            continue;
          }
          for (const v of versions) {
            const tuple = v === "legacy" ? [0] : versionTuple(v);
            if (!tuple.length) continue;
            const file = join(base, dir, v, root.file);
            if (!existsSync(file)) continue;
            let list = out.get(root.kind);
            if (!list) out.set(root.kind, (list = []));
            list.push({ version: tuple, versionText: v, file, root });
          }
        }
      }
      for (const list of out.values()) list.sort((a, b) => compareVersionTuples(a.version, b.version));
      return out;
    })();
    engineIndexMemo.set(base, p);
  }
  return p;
}

/** Nearest engine schema with version <= the file's format_version. Exported for tests. */
export function pickEngineCandidate(candidates: readonly EngineCandidate[], formatVersion: string): EngineCandidate | undefined {
  const fv = versionTuple(formatVersion);
  if (!fv.length) return undefined;
  let best: EngineCandidate | undefined;
  for (const c of candidates) if (compareVersionTuples(c.version, fv) <= 0) best = c;
  return best;
}

// ---------------------------------------------------------------- glob routing (rockide)

interface GlobRule {
  packKind: PackKind | undefined;
  include: RegExp[];
  exclude: RegExp[];
  file: string;
  dialect: "draft-07" | "2020-12";
}

export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (pattern.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 2;
    } else if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const j = pattern.indexOf("}", i);
      out += `(?:${pattern
        .slice(i + 1, j)
        .split(",")
        .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|")})`;
      i = j;
    } else out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const rockideMemo = new Map<string, Promise<GlobRule[]>>();

/** Rockide's own file -> schema mapping, parsed from its `scripts/compile.ts` (BP/RP/SP entry tables). */
function loadRockideRules(dir: string): Promise<GlobRule[]> {
  let p = rockideMemo.get(dir);
  if (!p) {
    p = (async () => {
      const src = await readFile(join(dir, "scripts", "compile.ts"), "utf8");
      const rules: GlobRule[] = [];
      for (const [constName, packKind] of [
        ["BP_ENTRIES", "behavior"],
        ["RP_ENTRIES", "resource"],
        ["SP_ENTRIES", "skin"],
      ] as [string, PackKind][]) {
        const block = new RegExp(`const ${constName}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`).exec(src)?.[1];
        if (!block) continue;
        for (const m of block.matchAll(/fileMatch:\s*(\[[^\]]*\]|"[^"]*"),\s*url:\s*"([^"]+)"/g)) {
          const raw = m[1] as string;
          const matches = (raw.startsWith("[") ? JSON.parse(raw.replace(/,\s*\]/, "]")) : [JSON.parse(raw)]) as string[];
          let include = matches.filter((x) => !x.startsWith("!"));
          let exclude = matches.filter((x) => x.startsWith("!")).map((x) => x.slice(1));
          if (packKind === "resource" && !include.some((x) => x.startsWith("manifest."))) {
            include = [...include, ...include.map((x) => `subpacks/*/${x}`)];
            exclude = [...exclude, ...exclude.map((x) => `subpacks/*/${x}`)];
          }
          rules.push({
            packKind,
            include: include.map(globToRegExp),
            exclude: exclude.map(globToRegExp),
            file: join(dir, m[2] as string),
            dialect: "2020-12",
          });
        }
      }
      return rules;
    })();
    rockideMemo.set(dir, p);
  }
  return p;
}

function matchRule(rules: readonly GlobRule[], packKind: PackKind, rel: string): GlobRule | undefined {
  return rules.find(
    (r) =>
      (r.packKind === undefined || r.packKind === packKind) &&
      r.include.some((re) => re.test(rel)) &&
      !r.exclude.some((re) => re.test(rel)),
  );
}

/**
 * Source precedence, measured on bedrock-samples 1.26.60.5 (`docs/tools.md`, validate_pack): rockide first
 * catches unknown components and fields the engine dump admits (86% vs 18% of injected entity/block/item
 * errors) for +9 held-out vanilla false positives in 3816 files (24 vs 15); engine covers what rockide does not
 * route.
 */
const SCHEMA_ORDER: readonly SchemaSourceName[] = ["rockide", "engine"];

/** Choose the schema for one file. `undefined` = no schema covers it. */
export async function chooseSchema(
  packKind: PackKind,
  rel: string,
  kind: FileKind,
  value: unknown,
  opts: SchemaOptions,
): Promise<SchemaChoice | undefined> {
  // manifest.json is owned by the manifest check: the available schemas reject valid manifests.
  if (kind === "manifest") return undefined;
  for (const source of SCHEMA_ORDER) {
    const choice = source === "engine" ? await engineChoice(kind, value, opts) : await rockideChoice(packKind, rel, opts);
    if (choice) return choice;
  }
  return undefined;
}

async function engineChoice(kind: FileKind, value: unknown, opts: SchemaOptions): Promise<SchemaChoice | undefined> {
  const fv = formatVersionOf(value);
  const engineBase = engineSchemasBase(opts);
  if (!engineBase || !fv) return undefined;
  const c = pickEngineCandidate((await engineIndex(engineBase)).get(kind) ?? [], fv);
  if (!c || !subtreeExists(value, c.root.pointer)) return undefined;
  const rel2 = c.file.slice(engineBase.length + 1).split("\\").join("/");
  return { source: "engine", file: c.file, pointer: c.root.pointer, version: c.versionText, dialect: "draft-07", label: `engine ${rel2}` };
}

async function rockideChoice(packKind: PackKind, rel: string, opts: SchemaOptions): Promise<SchemaChoice | undefined> {
  const dir = opts.rockideSchemasDir;
  if (!dir) return undefined;
  const r = matchRule(await loadRockideRules(dir), packKind, rel);
  if (!r) return undefined;
  return { source: "rockide", file: r.file, pointer: "", dialect: r.dialect, label: `rockide ${r.file.slice(dir.length + 1).split("\\").join("/")}` };
}

function subtreeExists(value: unknown, pointer: string): boolean {
  let v: unknown = value;
  for (const seg of parsePointer(pointer)) {
    if (!v || typeof v !== "object" || Array.isArray(v) || !(seg in v)) return false;
    v = (v as Record<string, unknown>)[seg];
  }
  return v !== undefined;
}

// ---------------------------------------------------------------- schema loading + Ajv

type Json = Record<string, unknown>;

const rawCache = new Map<string, Promise<unknown>>();

function readSchemaFile(path: string): Promise<unknown> {
  let p = rawCache.get(path);
  if (!p) {
    p = readFile(path, "utf8").then((t) => parseJsonc(t, [], { allowTrailingComma: true }) as unknown);
    rawCache.set(path, p);
  }
  return p;
}

const basenameMaps = new Map<string, Map<string, string[]>>();

async function basenameMap(root: string): Promise<Map<string, string[]>> {
  let m = basenameMaps.get(root);
  if (m) return m;
  m = new Map();
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".json")) {
        const list = m?.get(e.name) ?? [];
        list.push(p);
        m?.set(e.name, list);
      }
    }
  };
  await walk(root);
  basenameMaps.set(root, m);
  return m;
}

/** Resolve a `$ref` file part against the referencing file, with fallbacks for upstream layout quirks. */
async function resolveRefFile(ref: string, fromFile: string, sourceRoot: string | undefined): Promise<string | undefined> {
  const direct = fileURLToPath(new URL(ref, pathToFileURL(fromFile)));
  if (existsSync(direct)) return direct;
  if (sourceRoot) {
    // Rockide writes repo-root-relative refs (`schema/...`).
    const idx = ref.indexOf("schema/");
    if (idx >= 0) {
      const candidate = join(sourceRoot, decodeURIComponent(ref.slice(idx)));
      if (existsSync(candidate)) return candidate;
    }
    const hits = (await basenameMap(sourceRoot)).get(basename(direct)) ?? [];
    if (hits.length === 1) return hits[0];
  }
  return undefined;
}

/** Rewrite every external `$ref` to an absolute file URL (and drop `$id`/`$schema` noise from subschemas). */
async function absolutizeRefs(node: unknown, fromFile: string, sourceRoot: string | undefined): Promise<void> {
  if (Array.isArray(node)) {
    for (const v of node) await absolutizeRefs(v, fromFile, sourceRoot);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Json;
  const ref = o.$ref;
  if (typeof ref === "string" && !ref.startsWith("#")) {
    const hash = ref.indexOf("#");
    const filePart = hash >= 0 ? ref.slice(0, hash) : ref;
    const frag = hash >= 0 ? ref.slice(hash) : "";
    if (/^https?:/.test(filePart)) {
      delete o.$ref; // remote refs are never fetched; treat as unconstrained
    } else {
      const target = await resolveRefFile(filePart, fromFile, sourceRoot);
      if (target) o.$ref = `${pathToFileURL(target).href}${frag}`;
      else delete o.$ref;
    }
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === "enum" || k === "const" || k === "default" || k === "examples" || k === "defaultSnippets") continue;
    await absolutizeRefs(v, fromFile, sourceRoot);
  }
}

/** VS Code merges a `$ref` target into its node, so `additionalProperties: false` beside a `$ref` admits the
 * target's properties. Rockide relies on it. */
async function vscodeMerge(node: unknown): Promise<void> {
  if (Array.isArray(node)) {
    for (const v of node) await vscodeMerge(v);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Json;
  if (typeof o.$ref === "string" && (o.additionalProperties === false || o.unevaluatedProperties === false)) {
    const { props, patterns } = await declared(o.$ref, 0, new Set());
    const own = (o.properties ??= {}) as Json;
    for (const p of props) if (!(p in own)) own[p] = true;
    if (patterns.size) {
      const pp = (o.patternProperties ??= {}) as Json;
      for (const p of patterns) if (!(p in pp)) pp[p] = true;
    }
  }
  for (const v of Object.values(o)) await vscodeMerge(v);
}

async function refTarget(ref: string): Promise<unknown> {
  const hash = ref.indexOf("#");
  const url = hash >= 0 ? ref.slice(0, hash) : ref;
  if (!url.startsWith("file:")) return undefined;
  let node = await readSchemaFile(fileURLToPath(url)).catch(() => undefined);
  for (const seg of parsePointer(hash >= 0 ? decodeURIComponent(ref.slice(hash + 1)) : "")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Json)[seg];
  }
  return node;
}

async function declared(ref: string, depth: number, seen: Set<string>): Promise<{ props: Set<string>; patterns: Set<string> }> {
  const props = new Set<string>();
  const patterns = new Set<string>();
  if (depth > 12 || seen.has(ref)) return { props, patterns };
  seen.add(ref);
  const visit = async (n: unknown, base: string): Promise<void> => {
    if (!n || typeof n !== "object" || Array.isArray(n)) return;
    const o = n as Json;
    for (const k of Object.keys((o.properties as Json) ?? {})) props.add(k);
    for (const k of Object.keys((o.patternProperties as Json) ?? {})) patterns.add(k);
    if (typeof o.$ref === "string") {
      const abs = o.$ref.startsWith("#") ? `${base.split("#")[0]}${o.$ref}` : o.$ref;
      const r = await declared(abs, depth + 1, seen);
      for (const p of r.props) props.add(p);
      for (const p of r.patterns) patterns.add(p);
    }
    for (const key of ["allOf", "anyOf", "oneOf"]) for (const s of (o[key] as unknown[]) ?? []) await visit(s, base);
    await visit(o.then, base);
    await visit(o.else, base);
  };
  await visit(await refTarget(ref), ref);
  return { props, patterns };
}

/**
 * Engine dump of block `states` lists arrays of strings only (the dumper loses the variant); the game takes
 * boolean and integer state values too (`"ns:open": [false, true]`, documented block states).
 */
function blockStateValues(schema: Json): void {
  const ap = schema.additionalProperties as Json | undefined;
  const alts = ap?.oneOf ?? ap?.anyOf;
  for (const alt of Array.isArray(alts) ? (alts as Json[]) : []) {
    const items = alt.items as Json | undefined;
    if (alt.type === "array" && items?.type === "string") items.type = ["string", "boolean", "integer"];
  }
}

/**
 * `oneOf` -> `anyOf`. Bedrock schemas use `oneOf` for "one of these shapes" with overlapping branches (a filter
 * test object also matches the filter-group map); the game takes the first shape that fits, so exactly-one
 * semantics would reject content the game loads.
 */
function oneOfToAnyOf(node: unknown): void {
  if (Array.isArray(node)) {
    for (const v of node) oneOfToAnyOf(v);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Json;
  if (Array.isArray(o.oneOf) && !("anyOf" in o)) {
    o.anyOf = o.oneOf;
    delete o.oneOf;
  }
  for (const [k, v] of Object.entries(o)) if (k !== "enum" && k !== "const" && k !== "default" && k !== "examples") oneOfToAnyOf(v);
}

/** Draft-07 tuple `items: [...]` inside 2020-12 schemas (VS Code accepts it) -> `prefixItems`. */
function tupleItems(node: unknown): void {
  if (Array.isArray(node)) {
    for (const v of node) tupleItems(v);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Json;
  if (Array.isArray(o.items)) {
    o.prefixItems = o.items;
    delete o.items;
    if ("additionalItems" in o) {
      o.items = o.additionalItems;
      delete o.additionalItems;
    }
  }
  for (const v of Object.values(o)) tupleItems(v);
}

/** Loot `match_tool` conditions take their fields directly on the condition (Mojang docs; BDS loads it);
 * Rockide only accepts them nested under a `match_tool` key. Its `count`, `durability` and enchantment `levels`
 * also take a number or `{range_min, range_max}` (Mojang docs, LootTableConditions), not only `{min, max}`. */
function flatMatchTool(schema: Json): void {
  const defs = (schema.$defs as Json | undefined) ?? {};
  const range = { type: "object", additionalProperties: false, properties: { range_min: { type: "number" }, range_max: { type: "number" } } };
  for (const [owner, key] of [
    ["match_tool", "count"],
    ["match_tool", "durability"],
    ["enchantment_spec", "levels"],
  ] as const) {
    const props = (defs[owner] as Json | undefined)?.properties as Json | undefined;
    const prop = props?.[key] as Json | undefined;
    if (!props || !prop) continue;
    const { description, ...shape } = prop;
    props[key] = { description, anyOf: [shape, { type: "number" }, range] };
  }
  const fields = ((defs.match_tool as Json)?.properties as Json) ?? {};
  for (const branch of (schema.allOf as Json[]) ?? []) {
    const cond = ((branch.if as Json)?.properties as Json)?.condition as Json | undefined;
    const then = branch.then as Json | undefined;
    if (cond?.const === "match_tool" && then && typeof then === "object") {
      const props = (then.properties ??= {}) as Json;
      for (const k of Object.keys(fields)) if (!(k in props)) props[k] = { $ref: `#/$defs/match_tool/properties/${k}` };
      then.required = ["condition"];
    }
  }
}

interface SourceRuntime {
  ajv: Ajv;
  sourceRoot: string | undefined;
  rockide: boolean;
  compiled: Map<string, Promise<ValidateFunction>>;
}

function makeAjv(dialect: "draft-07" | "2020-12"): Ajv {
  const opts = {
    strict: false,
    allErrors: true,
    verbose: true,
    validateFormats: false,
    validateSchema: false,
    allowUnionTypes: true,
    unicodeRegExp: false,
    logger: false as const,
    inlineRefs: false,
  };
  const ajv = dialect === "2020-12" ? new Ajv2020(opts) : new Ajv(opts);
  // Rockide gates removed fields per format_version with `deprecated`, and the engine dump marks removed block
  // components with it; the game rejects such fields, so it is a validation keyword here, not an annotation.
  ajv.removeKeyword("deprecated");
  ajv.addKeyword({
    keyword: "deprecated",
    schemaType: "boolean",
    validate: (schemaValue: boolean) => schemaValue !== true,
    errors: false,
  });
  return ajv;
}

class SchemaRuntime {
  private readonly runtimes = new Map<string, SourceRuntime>();

  private runtime(key: string, dialect: "draft-07" | "2020-12", sourceRoot: string | undefined, rockide: boolean): SourceRuntime {
    let r = this.runtimes.get(key);
    if (!r) {
      const ajv = makeAjv(dialect);
      r = { ajv, sourceRoot, rockide, compiled: new Map() };
      const rt = r;
      ajv.opts.loadSchema = (uri: string) => this.load(uri, rt);
      this.runtimes.set(key, r);
    }
    return r;
  }

  private async load(uri: string, rt: SourceRuntime): Promise<Json> {
    const path = fileURLToPath(uri);
    const raw = structuredClone(await readSchemaFile(path));
    const schema: Json = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Json) : {};
    delete schema.$schema;
    schema.$id = uri;
    await absolutizeRefs(schema, path, rt.sourceRoot);
    if (/[\\/]server[\\/]block[\\/][^\\/]+[\\/]States\.json$/.test(path)) blockStateValues(schema);
    oneOfToAnyOf(schema);
    if (rt.rockide) {
      if (path.split("\\").join("/").endsWith("/server/loot_table/condition.json")) flatMatchTool(schema);
      await vscodeMerge(schema);
      tupleItems(schema);
    }
    return schema;
  }

  async validator(choice: SchemaChoice, opts: SchemaOptions): Promise<ValidateFunction> {
    const sourceRoot = choice.source === "engine" ? engineSchemasBase(opts) : opts.rockideSchemasDir;
    const rt = this.runtime(`${choice.source}|${sourceRoot}`, choice.dialect, sourceRoot, choice.source === "rockide");
    const uri = pathToFileURL(choice.file).href;
    let p = rt.compiled.get(uri);
    if (!p) {
      p = (async () => {
        const existing = rt.ajv.getSchema(uri);
        if (existing) return existing;
        return rt.ajv.compileAsync(await this.load(uri, rt));
      })();
      rt.compiled.set(uri, p);
    }
    return p;
  }
}

const runtime = new SchemaRuntime();

// ---------------------------------------------------------------- error reduction + messages

export interface SchemaIssue {
  keyword: string;
  /** Absolute pointer into the document. */
  pointer: string;
  /** Pointer to highlight: the offending key for property-name errors. */
  keyPointer?: string;
  message: string;
  /** Calibration signatures (what the complaint is about, independent of location). */
  signatures: string[];
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function short(v: unknown): string {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function under(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

const WRAPPERS: Record<string, true> = { anyOf: true, oneOf: true, if: true, $ref: true };
const ALTERNATIVE: Record<string, true> = { type: true, enum: true, const: true };

/** Keep the explanation: drop wrapper errors and wrong-alternative complaints, merge type alternatives. */
export function reduceErrors(errors: readonly ErrorObject[]): ErrorObject[] {
  let es = errors.filter((e) => !(e.keyword === "if" || e.keyword === "$ref"));
  es = es.filter(
    (e) => !(WRAPPERS[e.keyword] && es.some((o) => o !== e && !WRAPPERS[o.keyword] && under(e.instancePath, o.instancePath))),
  );
  const deeper = (p: string): boolean => es.some((o) => o.instancePath.startsWith(`${p}/`) && !WRAPPERS[o.keyword]);
  es = es.filter((e) => !(ALTERNATIVE[e.keyword] && deeper(e.instancePath)));
  // additionalProperties cascades from an anyOf branch that is not the explanation
  es = es.filter(
    (e) =>
      !(
        e.keyword === "additionalProperties" &&
        es.some((o) => o.keyword !== "additionalProperties" && o.instancePath.startsWith(`${e.instancePath}/`))
      ),
  );
  // propertyNames failures that a `deprecated` error already explains
  es = es.filter(
    (e) =>
      !(
        e.keyword === "propertyNames" &&
        es.some(
          (o) => o.keyword === "deprecated" && o.instancePath === pointerJoin(e.instancePath, String(e.params.propertyName)),
        )
      ),
  );
  // merge type/enum/const alternatives at the same path into one error
  const out: ErrorObject[] = [];
  const merged = new Map<string, ErrorObject>();
  const seen = new Set<string>();
  for (const e of es) {
    if (ALTERNATIVE[e.keyword]) {
      const prev = merged.get(e.instancePath);
      if (prev) {
        const alts = (prev.params.alternatives as ErrorObject[]) ?? [prev];
        prev.params = { ...prev.params, alternatives: [...alts, e] };
        continue;
      }
      const copy = { ...e, params: { ...e.params } };
      merged.set(e.instancePath, copy);
      out.push(copy);
      continue;
    }
    const key = `${e.instancePath}|${e.keyword}|${JSON.stringify(e.params)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function expectation(e: ErrorObject): string {
  if (e.keyword === "type") return String(e.params.type).split(",").join(" or ");
  if (e.keyword === "enum") {
    const vals = (e.params.allowedValues as unknown[]) ?? [];
    return `one of ${vals.slice(0, 8).map(short).join(", ")}${vals.length > 8 ? `, ... (${vals.length} values)` : ""}`;
  }
  if (e.keyword === "const") return short(e.params.allowedValue);
  return e.message ?? e.keyword;
}

function where(pointer: string): string {
  const segs = parsePointer(pointer);
  return segs.length ? segs.slice(-2).join(".") : "document";
}

function seg(s: string | undefined): string {
  return s === undefined ? "" : /^\d+$/.test(s) ? "#" : s;
}

/** Turn one reduced Ajv error into an issue (pointer made absolute by `base`). */
export function toIssue(e: ErrorObject, base: string, kindKey: string): SchemaIssue {
  const pointer = `${base}${e.instancePath}`;
  const segs = parsePointer(pointer);
  const last = seg(segs[segs.length - 1]);
  const cat = kindKey;
  switch (e.keyword) {
    case "type":
    case "enum":
    case "const": {
      const alts = (e.params.alternatives as ErrorObject[] | undefined) ?? [e];
      const expected = [...new Set(alts.map(expectation))].join(" or ");
      return {
        keyword: alts.some((a) => a.keyword === "type") ? "type" : e.keyword,
        pointer,
        message: `${where(pointer)}: must be ${expected} (got ${jsonType(e.data)} ${short(e.data)})`,
        signatures: [`${cat}|${e.keyword}|${last}|${jsonType(e.data)}|${alts.map(expectation).sort().join("/")}`],
      };
    }
    case "required": {
      const missing = String(e.params.missingProperty);
      return {
        keyword: "required",
        pointer,
        message: `${where(pointer)}: missing required property "${missing}"`,
        signatures: [`${cat}|required|${missing}`],
      };
    }
    case "additionalProperties": {
      const prop = String(e.params.additionalProperty);
      return {
        keyword: e.keyword,
        pointer: pointerJoin(pointer, prop),
        keyPointer: pointerJoin(pointer, prop),
        message: `${where(pointer)}: unknown property "${prop}"`,
        signatures: [`${cat}|${e.keyword}|${prop}`],
      };
    }
    case "unevaluatedProperties": {
      const prop = String(e.params.unevaluatedProperty);
      return {
        keyword: e.keyword,
        pointer: pointerJoin(pointer, prop),
        keyPointer: pointerJoin(pointer, prop),
        message: `${where(pointer)}: unknown property "${prop}"`,
        signatures: [`${cat}|additionalProperties|${prop}`],
      };
    }
    case "propertyNames": {
      const prop = String(e.params.propertyName);
      return {
        keyword: e.keyword,
        pointer: pointerJoin(pointer, prop),
        keyPointer: pointerJoin(pointer, prop),
        message: `${where(pointer)}: property "${prop}" is not allowed here`,
        signatures: [`${cat}|propertyNames|${prop}`],
      };
    }
    case "deprecated": {
      const msg = (e.parentSchema as Json | undefined)?.deprecationMessage;
      return {
        keyword: e.keyword,
        pointer,
        keyPointer: pointer,
        message: `${where(pointer)}: removed/deprecated at this format_version${typeof msg === "string" ? ` (${msg})` : ""}`,
        signatures: [`${cat}|deprecated|${last}`],
      };
    }
    default:
      return {
        keyword: e.keyword,
        pointer,
        message: `${where(pointer)}: ${e.message ?? e.keyword}`,
        signatures: [`${cat}|${e.keyword}|${segs.slice(-2).map(seg).join("/")}`],
      };
  }
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^\$/, "");
}

export interface EvaluateResult {
  issues: SchemaIssue[];
  /** Set when the schema did not list the file's format_version and an older one was used. */
  fallback?: { from: string; to: string };
}

/** Errors of one document against its schema, reduced to issues. Throws if the schema cannot compile. */
export async function evaluate(value: unknown, choice: SchemaChoice, kindKey: string, opts: SchemaOptions): Promise<EvaluateResult> {
  const validate = await runtime.validator(choice, opts);
  let instance: unknown = value;
  for (const s of parsePointer(choice.pointer)) instance = (instance as Json)[s];
  const key = `${choice.source}:${kindKey}`;
  validate(instance);
  let reduced = reduceErrors(validate.errors ?? []);
  let fallback: { from: string; to: string } | undefined;
  // Rockide-style format_version enums: validate with the nearest older version the schema knows.
  const fvErr = reduced.find((e) => e.instancePath === "/format_version" && e.keyword === "enum");
  const fv = formatVersionOf(instance);
  if (fvErr && fv && versionTuple(fv).length) {
    const known = ((fvErr.params.allowedValues as unknown[]) ?? []).filter(
      (v): v is string => typeof v === "string" && versionTuple(v).length > 0,
    );
    const older = known.filter((v) => compareVersionTuples(versionTuple(v), versionTuple(fv)) <= 0);
    older.sort((a, b) => compareVersionTuples(versionTuple(a), versionTuple(b)));
    const to = older[older.length - 1];
    if (to) {
      validate({ ...(instance as Json), format_version: to });
      reduced = reduceErrors(validate.errors ?? []);
      fallback = { from: fv, to };
    }
  }
  const issues = reduced.map((e) => toIssue(e, choice.pointer, key));
  return fallback ? { issues, fallback } : { issues };
}

// ---------------------------------------------------------------- calibration against vanilla

/** What vanilla content tells about the schemas: complaints it triggers (gaps). */
export interface Calibration {
  signatures: Set<string>;
}

const calibrationMemo = new Map<string, Promise<Calibration>>();

/**
 * Signatures of schema complaints vanilla content triggers (computed once per samples checkout + schema
 * sources, cached under `cacheDir('validate')`). The game loads vanilla, so a shared complaint is a schema gap.
 */
export function calibration(
  identity: string,
  opts: SchemaOptions,
  vanillaFiles: () => Promise<{ packKind: PackKind; rel: string; kind: FileKind; value: unknown }[]>,
): Promise<Calibration> {
  const key = createHash("sha1")
    .update(JSON.stringify([identity, engineSchemasBase(opts) ?? "", opts.rockideSchemasDir ?? "", CALIBRATION_VERSION]))
    .digest("hex")
    .slice(0, 16);
  let p = calibrationMemo.get(key);
  if (!p) {
    p = (async () => {
      const file = cacheDir("validate", `calibration-${key}.json`);
      try {
        const cached = JSON.parse(await readFile(file, "utf8")) as { signatures: string[] };
        return { signatures: new Set(cached.signatures) };
      } catch {
        // not cached yet
      }
      const signatures = new Set<string>();
      for (const f of await vanillaFiles()) {
        const choice = await chooseSchema(f.packKind, f.rel, f.kind, f.value, opts);
        if (!choice) continue;
        try {
          const { issues } = await evaluate(f.value, choice, f.kind, opts);
          for (const i of issues) for (const s of i.signatures) signatures.add(s);
        } catch {
          // schema that cannot compile: nothing to calibrate
        }
      }
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ signatures: [...signatures].sort() }));
      return { signatures };
    })();
    calibrationMemo.set(key, p);
  }
  return p;
}

// ---------------------------------------------------------------- per-file check

export interface SchemaFileResult {
  choice?: SchemaChoice;
  diagnostics: Omit<Diagnostic, "file">[];
}

/** Game rules no schema encodes, each measured on BDS (legacy docs/validate.md). */
function gameRules(kind: FileKind, value: unknown, doc: JsonDocument): Omit<Diagnostic, "file">[] {
  const out: Omit<Diagnostic, "file">[] = [];
  if (kind !== "item" && kind !== "block") return out;
  const fv = formatVersionOf(value);
  const root = kind === "item" ? "minecraft:item" : "minecraft:block";
  const mc = ((value as Json)?.[root] as Json | undefined)?.description as Json | undefined;
  const group = (mc?.menu_category as Json | undefined)?.group;
  if (typeof group === "string" && !group.includes(":") && fv && compareVersionTuples(versionTuple(fv), [1, 21, 60]) >= 0) {
    const pointer = `/${root}/description/menu_category/group`;
    out.push({
      severity: "error",
      code: "schema.menu-group-namespace",
      source: "schema",
      message: `menu_category.group '${group}' needs a namespace from format_version 1.21.60; the game rejects the whole ${kind}`,
      hint: `use "minecraft:${group}"`,
      pointer,
      range: rangeAtPointer(doc, pointer),
    });
  }
  return out;
}

export interface SchemaFileArgs {
  packKind: PackKind;
  rel: string;
  kind: FileKind;
  doc: JsonDocument;
  opts: SchemaOptions;
  /** Vanilla calibration: complaints vanilla also triggers become `schema.gap` warnings. */
  calibration?: Calibration;
  /** Target game version tuple; a newer `format_version` is an error. */
  gameVersion?: number[];
  channel?: string;
}

export async function checkSchemaFile(args: SchemaFileArgs): Promise<SchemaFileResult> {
  const { packKind, rel, kind, doc, opts } = args;
  const gaps = args.calibration?.signatures;
  const value = doc.value;
  const diagnostics: Omit<Diagnostic, "file">[] = [];
  if (value === undefined) return { diagnostics };
  if (packKind === "behavior") diagnostics.push(...gameRules(kind, value, doc));
  const fv = formatVersionOf(value);
  if (fv && args.gameVersion && kind !== "manifest") {
    const t = versionTuple(fv);
    if (t.length && compareVersionTuples(t.slice(0, 3), args.gameVersion.slice(0, 3)) > 0) {
      diagnostics.push({
        severity: "error",
        code: "schema.format-version-too-new",
        source: "schema",
        message: `format_version ${fv} is newer than Minecraft ${args.gameVersion.join(".")} (${args.channel ?? "stable"}); the game rejects the file`,
        pointer: "/format_version",
        range: rangeAtPointer(doc, "/format_version"),
      });
    }
  }
  const choice = await chooseSchema(packKind, rel, kind, value, opts);
  if (!choice) return { diagnostics };
  let result: EvaluateResult;
  try {
    result = await evaluate(value, choice, kind, opts);
  } catch (err) {
    diagnostics.push({
      severity: "warning",
      code: "schema.unavailable",
      source: "schema",
      message: `schema ${choice.label} could not be evaluated: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
      range: rangeAtPointer(doc, ""),
    });
    return { choice, diagnostics };
  }
  if (result.fallback) {
    diagnostics.push({
      severity: "warning",
      code: "schema.format-version-fallback",
      source: "schema",
      message: `${choice.label} has no schema for format_version ${result.fallback.from}; validated with ${result.fallback.to}`,
      pointer: "/format_version",
      range: rangeAtPointer(doc, "/format_version"),
    });
  }
  let errors = 0;
  for (const issue of result.issues) {
    const range = issue.keyPointer ? rangeAtPointer(doc, issue.keyPointer, true) : rangeAtPointer(doc, issue.pointer);
    const isGap = gaps !== undefined && issue.signatures.every((s) => gaps.has(s));
    if (isGap) {
      diagnostics.push({
        severity: "warning",
        code: "schema.gap",
        source: "schema",
        message: `${issue.message} (vanilla content triggers this too: schema gap)`,
        pointer: issue.pointer,
        range,
      });
      continue;
    }
    errors++;
    if (errors > MAX_ERRORS_PER_FILE) {
      diagnostics.push({
        severity: "error",
        code: "schema.truncated",
        source: "schema",
        message: `more than ${MAX_ERRORS_PER_FILE} schema errors; the rest are omitted`,
        range: rangeAtPointer(doc, ""),
      });
      break;
    }
    diagnostics.push({ severity: "error", code: `schema.${kebab(issue.keyword)}`, source: "schema", message: issue.message, pointer: issue.pointer, range });
  }
  return { choice, diagnostics };
}
