/**
 * Exact lookups over bedrock-samples `metadata/` (commands, Molang, components, vanilla data ids) and the
 * vanilla packs (usage examples), plus component definitions from rockide/schemas (newest release, checked daily).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Channel } from "../core/version.ts";
import { lookupRockide, type RockideLookup, rockideComponentIds } from "./rockide.ts";
import { ensureBedrockSamples, type SamplesCheckout, type SamplesPart } from "./samples.ts";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function listFiles(dir: string, ext: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(ext))
      .map((e) => join(e.parentPath, e.name))
      .sort();
  } catch {
    return [];
  }
}

/** Per-tag memo: derived tables are pure functions of the checkout. */
function memo<T>(build: (s: SamplesCheckout) => Promise<T>): (s: SamplesCheckout) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (s) => {
    let p = cache.get(s.tag);
    if (!p) {
      p = build(s);
      cache.set(s.tag, p);
      p.catch(() => cache.delete(s.tag));
    }
    return p;
  };
}

export interface SourceTag {
  channel: Channel;
  version: string;
  samplesTag: string;
}

const tagOf = (s: SamplesCheckout): SourceTag => ({ channel: s.channel, version: s.version, samplesTag: s.tag });

// ---------------------------------------------------------------------------------------------
// Commands

interface RawCommand {
  name: string;
  description: string;
  aliases: { name: string }[] | string[];
  permission_level: number;
  requires_cheats: boolean;
  overloads: { name: string; params: { name: string; is_optional: boolean; type: { name: string } }[] }[];
}
interface RawCommands {
  commands: RawCommand[];
  command_enums: { name: string; values: { value: string }[] }[];
}

export interface CommandInfo {
  name: string;
  description: string;
  aliases: string[];
  permissionLevel: number;
  requiresCheats: boolean;
  overloads: { syntax: string; params: { name: string; type: string; optional: boolean; values?: string[] }[] }[];
}

const commandTable = memo(async (s) => readJson<RawCommands>(join(s.root, "metadata", "command_modules", "mojang-commands.json")));

export async function commandLookup(opts: { name: string; channel: Channel; offline?: boolean }): Promise<
  SourceTag & { query: string; commands: CommandInfo[]; suggestions: string[] }
> {
  const samples = await ensureBedrockSamples({ channel: opts.channel, offline: opts.offline, parts: ["metadata"] });
  const raw = await commandTable(samples);
  const enums = new Map(raw.command_enums.map((e) => [e.name.toLowerCase(), e.values.map((v) => v.value)]));
  const q = opts.name.trim().replace(/^\//, "").toLowerCase();
  const aliasNames = (c: RawCommand) => c.aliases.map((a) => (typeof a === "string" ? a : a.name));
  const hits = raw.commands.filter((c) => c.name === q || aliasNames(c).includes(q));
  const commands = hits.map((c): CommandInfo => ({
    name: c.name,
    description: c.description,
    aliases: aliasNames(c),
    permissionLevel: c.permission_level,
    requiresCheats: c.requires_cheats,
    overloads: c.overloads.map((o) => {
      const params = o.params.map((p) => {
        const values = enums.get(p.type.name.toLowerCase());
        const param: CommandInfo["overloads"][number]["params"][number] = {
          name: p.name,
          type: p.type.name,
          optional: p.is_optional,
        };
        if (values) param.values = values.slice(0, 60);
        return param;
      });
      const syntax = [
        `/${c.name}`,
        ...params.map((p) => {
          const inner = p.values && p.values.length === 1 ? p.values[0] : `${p.name}: ${p.type}`;
          return p.optional ? `[${inner}]` : `<${inner}>`;
        }),
      ].join(" ");
      return { syntax, params };
    }),
  }));
  const suggestions = commands.length
    ? []
    : raw.commands.filter((c) => c.name.includes(q)).map((c) => c.name).slice(0, 15);
  return { ...tagOf(samples), query: opts.name, commands, suggestions };
}

// ---------------------------------------------------------------------------------------------
// Molang

interface RawMolang {
  queries: {
    name: string;
    description: string;
    min_args?: number;
    max_args?: number;
    return_type?: string;
    version_ranges?: { first_version: string; last_version?: string; query_sets?: string[] }[];
  }[];
  math_functions: { name: string; description: string; min_args?: number; max_args?: number }[];
}

export interface MolangInfo {
  name: string;
  kind: "query" | "math";
  description: string;
  minArgs?: number;
  maxArgs?: number;
  returnType?: string;
  versionRanges?: { first_version: string; last_version?: string; query_sets?: string[] }[];
}

const molangTable = memo(async (s) => readJson<RawMolang>(join(s.root, "metadata", "molang_modules", "mojang-molang-queries.json")));

export async function molangLookup(opts: { name: string; channel: Channel; offline?: boolean; limit?: number }): Promise<
  SourceTag & { query: string; exact: boolean; entries: MolangInfo[] }
> {
  const samples = await ensureBedrockSamples({ channel: opts.channel, offline: opts.offline, parts: ["metadata"] });
  const raw = await molangTable(samples);
  const all: MolangInfo[] = [
    ...raw.queries.map((q): MolangInfo => {
      const info: MolangInfo = { name: q.name, kind: "query", description: q.description };
      if (q.min_args !== undefined) info.minArgs = q.min_args;
      if (q.max_args !== undefined) info.maxArgs = q.max_args;
      if (q.return_type) info.returnType = q.return_type;
      if (q.version_ranges) info.versionRanges = q.version_ranges;
      return info;
    }),
    ...raw.math_functions.map((m): MolangInfo => {
      const info: MolangInfo = { name: m.name, kind: "math", description: m.description };
      if (m.min_args !== undefined) info.minArgs = m.min_args;
      if (m.max_args !== undefined) info.maxArgs = m.max_args;
      return info;
    }),
  ];
  const q = opts.name.trim().toLowerCase().replace(/^q\./, "query.").replace(/\(.*$/, "");
  const candidates = q.includes(".") ? [q] : [`query.${q}`, `math.${q}`];
  const exact = all.filter((e) => candidates.includes(e.name.toLowerCase()));
  const needle = q.replace(/^(query|math)\./, "");
  const entries = exact.length
    ? exact
    : all.filter((e) => e.name.toLowerCase().includes(needle)).slice(0, opts.limit ?? 20);
  return { ...tagOf(samples), query: opts.name, exact: exact.length > 0, entries };
}

// ---------------------------------------------------------------------------------------------
// Components

interface DocNode {
  name?: string;
  description?: string[] | string;
  type?: string;
  default?: string;
  nodes?: DocNode[];
}

export interface ComponentProperty {
  name: string;
  type?: string;
  default?: string;
  description?: string;
  properties?: ComponentProperty[];
}

export interface ComponentDoc {
  /** doc_modules file (`entities`, `blocks`, `item`, …). */
  module: string;
  section: string;
  description: string;
  properties: ComponentProperty[];
}

const ID_NAME_RE = /^([a-z0-9_]+:[a-z0-9_.]+)/;
const text = (d: DocNode["description"]): string => (Array.isArray(d) ? d.join("\n") : (d ?? "")).trim();

function toProperty(n: DocNode, depth = 0): ComponentProperty {
  const p: ComponentProperty = { name: n.name ?? "" };
  if (n.type) p.type = n.type;
  if (n.default !== undefined) p.default = n.default;
  const d = text(n.description);
  if (d) p.description = d;
  const kids = (n.nodes ?? []).filter((k) => k.name);
  if (kids.length && depth < 2) p.properties = kids.map((k) => toProperty(k, depth + 1));
  return p;
}

const componentDocs = memo(async (s) => {
  const out = new Map<string, ComponentDoc[]>();
  for (const file of await listFiles(join(s.root, "metadata", "doc_modules"), ".json")) {
    const module = relative(join(s.root, "metadata", "doc_modules"), file).replace(/\.json$/, "");
    const root = await readJson<DocNode>(file);
    const walk = (node: DocNode, trail: string[]) => {
      for (const child of node.nodes ?? []) {
        const id = child.name ? ID_NAME_RE.exec(child.name)?.[1] : undefined;
        if (id) {
          const list = out.get(id) ?? [];
          list.push({
            module,
            section: trail.join(" > "),
            description: text(child.description),
            properties: (child.nodes ?? []).filter((k) => k.name).map((k) => toProperty(k)),
          });
          out.set(id, list);
        } else {
          walk(child, child.name ? [...trail, child.name] : trail);
        }
      }
    };
    walk(root, []);
  }
  return out;
});

export interface ComponentSchemaRef {
  /** `server/entity`, `client/block`, … */
  scope: string;
  /** format_versions in which the engine schema changed (one file per change). */
  formatVersions: string[];
  /** Path of the newest schema, relative to the samples root. */
  latest: string;
  description?: string;
}

const engineSchemas = memo(async (s) => {
  const out = new Map<string, ComponentSchemaRef[]>();
  const base = join(s.root, "metadata", "json_schemas");
  const files = await listFiles(base, ".json");
  const byKey = new Map<string, { id: string; scope: string; versions: { fv: string; path: string }[] }>();
  for (const file of files) {
    const rel = relative(base, file).split("\\").join("/");
    const parts = rel.split("/");
    if (parts.length !== 4) continue;
    const [side, kind, fv, name] = parts as [string, string, string, string];
    if (!name.startsWith("minecraft_")) continue;
    const id = `minecraft:${name.slice("minecraft_".length, -".json".length)}`;
    const key = `${id}|${side}/${kind}`;
    const entry = byKey.get(key) ?? { id, scope: `${side}/${kind}`, versions: [] };
    entry.versions.push({ fv, path: `metadata/json_schemas/${rel}` });
    byKey.set(key, entry);
  }
  const fvKey = (fv: string) => (fv === "beta" ? [Number.MAX_SAFE_INTEGER] : fv.split(".").map(Number));
  const cmp = (a: string, b: string) => {
    const ka = fvKey(a);
    const kb = fvKey(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (ka[i] ?? 0) - (kb[i] ?? 0);
      if (d) return d;
    }
    return 0;
  };
  for (const e of byKey.values()) {
    e.versions.sort((a, b) => cmp(a.fv, b.fv));
    const stable = e.versions.filter((v) => v.fv !== "beta");
    const latest = (stable.at(-1) ?? e.versions.at(-1))!;
    const ref: ComponentSchemaRef = { scope: e.scope, formatVersions: e.versions.map((v) => v.fv), latest: latest.path };
    try {
      const schema = await readJson<{ description?: string }>(join(s.root, latest.path));
      if (schema.description) ref.description = schema.description;
    } catch {
      // unreadable schema: keep the reference without a description
    }
    const list = out.get(e.id) ?? [];
    list.push(ref);
    out.set(e.id, list);
  }
  return out;
});

export interface ComponentLookupResult extends SourceTag {
  id: string;
  docs: ComponentDoc[];
  engineSchemas: ComponentSchemaRef[];
  /** rockide/schemas definition per scope, at the format_version matching the channel's game version. */
  rockide: RockideLookup;
  suggestions: string[];
}

export async function componentLookup(opts: { id: string; channel: Channel; offline?: boolean }): Promise<ComponentLookupResult> {
  const samples = await ensureBedrockSamples({ channel: opts.channel, offline: opts.offline, parts: ["metadata"] });
  const raw = opts.id.trim().toLowerCase();
  const id = raw.includes(":") ? raw : `minecraft:${raw}`;
  const [docs, schemas, rockide] = await Promise.all([
    componentDocs(samples),
    engineSchemas(samples),
    lookupRockide(id, samples.version, { offline: opts.offline }),
  ]);
  const result: ComponentLookupResult = {
    ...tagOf(samples),
    id,
    // "ID Lists" sections repeat the id with only a numeric type id; keep them only if nothing else documents it.
    docs: ((all) => {
      const real = all.filter((d) => !(/^\d+$/.test(d.description) && !d.properties.length));
      return real.length ? real : all;
    })(docs.get(id) ?? []),
    engineSchemas: schemas.get(id) ?? [],
    rockide,
    suggestions: [],
  };
  if (!result.docs.length && !result.engineSchemas.length && !rockide.matches.length) {
    const needle = id.replace(/^minecraft:/, "");
    const rockideIds = rockide.root ? await rockideComponentIds(rockide.root) : [];
    result.suggestions = [...new Set([...docs.keys(), ...schemas.keys(), ...rockideIds])]
      .filter((k) => k.includes(needle))
      .sort()
      .slice(0, 20);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Vanilla data ids

interface RawVanillaData {
  vanilla_data_type?: string;
  data_items: { name: string; [k: string]: unknown }[];
}

const vanillaData = memo(async (s) => {
  const out = new Map<string, { type: string; data: Record<string, unknown> }[]>();
  for (const file of await listFiles(join(s.root, "metadata", "vanilladata_modules"), ".json")) {
    const raw = await readJson<RawVanillaData>(file);
    const type = raw.vanilla_data_type ?? file.replace(/^.*mojang-|\.json$/g, "");
    for (const item of raw.data_items ?? []) {
      const list = out.get(item.name) ?? [];
      list.push({ type, data: item });
      out.set(item.name, list);
    }
  }
  return out;
});

// ---------------------------------------------------------------------------------------------
// Vanilla examples

export interface VanillaExample {
  /** Path relative to the samples root (`behavior_pack/entities/wolf.json`). */
  file: string;
  line: number;
  /** The identifier is a JSON key (component usage) rather than a value. */
  asKey: boolean;
  excerpt: string;
}

export interface VanillaExampleResult extends SourceTag {
  identifier: string;
  /** Matching entries in `vanilladata_modules` (blocks, items, entities, …). */
  ids: { type: string; data: Record<string, unknown> }[];
  examples: VanillaExample[];
  totalFiles: number;
}

const packFiles = memo(async (s) => ({
  behavior_pack: await listFiles(join(s.root, "behavior_pack"), ".json"),
  resource_pack: await listFiles(join(s.root, "resource_pack"), ".json"),
}));

function excerptAround(lines: string[], index: number, before = 2, after = 8): string {
  const start = Math.max(0, index - before);
  const slice = lines.slice(start, index + after + 1);
  return slice.map((l, i) => `${start + i + 1}: ${l}`).join("\n");
}

export async function vanillaExample(opts: {
  identifier: string;
  channel: Channel;
  pack?: "behavior" | "resource" | "both";
  limit?: number;
  offline?: boolean;
}): Promise<VanillaExampleResult> {
  const pack = opts.pack ?? "both";
  const parts: SamplesPart[] = ["metadata"];
  if (pack !== "resource") parts.push("behavior_pack");
  if (pack !== "behavior") parts.push("resource_pack");
  const samples = await ensureBedrockSamples({ channel: opts.channel, offline: opts.offline, parts });
  const limit = opts.limit ?? 8;
  const identifier = opts.identifier.trim();
  const files = await packFiles(samples);
  const candidates = [
    ...(pack !== "resource" ? files.behavior_pack : []),
    ...(pack !== "behavior" ? files.resource_pack : []),
  ];
  const quoted = `"${identifier}"`;
  const keyRe = new RegExp(`"${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`);
  const asKey: VanillaExample[] = [];
  const asValue: VanillaExample[] = [];
  let totalFiles = 0;
  for (const file of candidates) {
    const content = await readFile(file, "utf8");
    if (!content.includes(quoted)) continue;
    totalFiles++;
    const lines = content.split(/\r?\n/);
    const idx = lines.findIndex((l) => l.includes(quoted));
    const isKey = keyRe.test(lines[idx] ?? "");
    const ex: VanillaExample = {
      file: relative(samples.root, file).split("\\").join("/"),
      line: idx + 1,
      asKey: isKey,
      excerpt: excerptAround(lines, idx),
    };
    (isKey ? asKey : asValue).push(ex);
  }
  const ids = (await vanillaData(samples)).get(identifier.includes(":") ? identifier : `minecraft:${identifier}`) ?? [];
  return {
    ...tagOf(samples),
    identifier,
    ids,
    examples: [...asKey, ...asValue].slice(0, limit),
    totalFiles,
  };
}
