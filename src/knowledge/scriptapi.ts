/**
 * Script API lookups. Signatures and docs come from the channel's `@minecraft/*` typings; the module version
 * that introduced each symbol comes from bedrock-samples `metadata/script_modules` (engine-generated).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "../core/paths.ts";
import type { Channel } from "../core/version.ts";
import { type DtsSymbol, parsePackage } from "./dts.ts";
import { writeJsonAtomic } from "../core/fs.ts";
import { single } from "./net.ts";
import { ensureBedrockSamples } from "./samples.ts";
import { suggestNames } from "./suggest.ts";
import { ensureTypings } from "./typings.ts";
import { TYPINGS_PACKAGES } from "./versions.ts";

// ---------------------------------------------------------------------------------------------
// "since" index from engine metadata

interface ModuleSince {
  /** Stable module versions in ascending order. */
  versions: string[];
  /** Latest beta module version (`2.11.0-beta`), if any. */
  beta?: string;
  /** Symbol → first stable module version that has it; `beta` when only the beta module has it. */
  since: Record<string, string>;
}

type SinceIndex = Record<string, ModuleSince>;

interface MetaMember {
  name: string;
}
interface MetaContainer {
  name: string;
  functions?: MetaMember[];
  properties?: MetaMember[];
  constants?: MetaMember[];
}
interface MetaModule {
  classes?: MetaContainer[];
  interfaces?: MetaContainer[];
  enums?: MetaContainer[];
  errors?: MetaContainer[];
  type_aliases?: MetaMember[];
  objects?: MetaMember[];
  functions?: MetaMember[];
  constants?: MetaMember[];
}

function semverKey(v: string): number[] {
  return v.replace(/-.*$/, "").split(".").map(Number);
}

function compareSemver(a: string, b: string): number {
  const ka = semverKey(a);
  const kb = semverKey(b);
  for (let i = 0; i < 3; i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function metaSymbols(mod: MetaModule): string[] {
  const out: string[] = [];
  for (const group of [mod.classes, mod.interfaces, mod.enums, mod.errors]) {
    for (const c of group ?? []) {
      out.push(c.name);
      for (const m of [...(c.functions ?? []), ...(c.properties ?? []), ...(c.constants ?? [])]) {
        out.push(`${c.name}.${m.name}`);
      }
    }
  }
  for (const group of [mod.type_aliases, mod.objects, mod.functions, mod.constants]) {
    for (const m of group ?? []) out.push(m.name);
  }
  return out;
}

async function buildSinceIndex(metadataDir: string): Promise<SinceIndex> {
  const dir = join(metadataDir, "script_modules", "@minecraft");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const byModule = new Map<string, { version: string; file: string }[]>();
  for (const file of files) {
    const m = /^(.+?)_(\d+\.\d+\.\d+(?:-[\w.]+)?)\.json$/.exec(file);
    if (!m?.[1] || !m[2]) continue;
    const name = `@minecraft/${m[1].replace(/-bindings$/, "")}`;
    const list = byModule.get(name) ?? [];
    list.push({ version: m[2], file });
    byModule.set(name, list);
  }
  const index: SinceIndex = {};
  for (const [name, list] of byModule) {
    // A module version may exist as a thin wrapper plus a `-bindings` file; keep whichever has content.
    const contents = new Map<string, MetaModule>();
    for (const { version, file } of list) {
      const mod = JSON.parse(await readFile(join(dir, file), "utf8")) as MetaModule;
      if (metaSymbols(mod).length || !contents.has(version)) contents.set(version, mod);
    }
    const versions = [...contents.keys()].filter((v) => !v.includes("-")).sort(compareSemver);
    const beta = [...contents.keys()].filter((v) => v.includes("-")).sort(compareSemver).at(-1);
    const since: Record<string, string> = {};
    for (const v of versions) for (const s of metaSymbols(contents.get(v)!)) since[s] ??= v;
    if (beta) for (const s of metaSymbols(contents.get(beta)!)) since[s] ??= "beta";
    const entry: ModuleSince = { versions, since };
    if (beta) entry.beta = beta;
    index[name] = entry;
  }
  return index;
}

const sinceCache = new Map<string, Promise<{ tag: string; index: SinceIndex }>>();

async function sinceIndex(channel: Channel, offline?: boolean): Promise<{ tag: string; index: SinceIndex }> {
  const samples = await ensureBedrockSamples({ channel, offline, parts: ["metadata"] });
  const cached = sinceCache.get(samples.tag);
  if (cached) return cached;
  const p = single(`since:${samples.tag}`, async () => {
    const path = cacheDir("knowledge", "derived", samples.tag, "script-since.json");
    try {
      return { tag: samples.tag, index: JSON.parse(await readFile(path, "utf8")) as SinceIndex };
    } catch {
      const index = await buildSinceIndex(join(samples.root, "metadata"));
      await writeJsonAtomic(path, index);
      return { tag: samples.tag, index };
    }
  });
  sinceCache.set(samples.tag, p);
  p.catch(() => sinceCache.delete(samples.tag));
  return p;
}

// ---------------------------------------------------------------------------------------------
// Typings symbol tables

interface SymbolTable {
  packages: Record<string, string>;
  version: string;
  byName: Map<string, DtsSymbol[]>;
  all: DtsSymbol[];
}

const tableCache = new Map<string, Promise<SymbolTable>>();

async function symbolTable(channel: Channel, beta: boolean, offline?: boolean): Promise<SymbolTable> {
  const install = await ensureTypings({ channel, beta, offline });
  const key = install.nodeModulesDir;
  const cached = tableCache.get(key);
  if (cached) return cached;
  const p = (async () => {
    const all: DtsSymbol[] = [];
    for (const pkg of TYPINGS_PACKAGES) {
      if (!install.packages[pkg]) continue;
      all.push(...(await parsePackage(join(install.nodeModulesDir, ...pkg.split("/")), pkg)));
    }
    const byName = new Map<string, DtsSymbol[]>();
    for (const s of all) {
      const list = byName.get(s.name) ?? [];
      list.push(s);
      byName.set(s.name, list);
    }
    return { packages: install.packages, version: install.version, byName, all };
  })();
  tableCache.set(key, p);
  p.catch(() => tableCache.delete(key));
  return p;
}

// ---------------------------------------------------------------------------------------------
// Lookup

export interface ApiEntry {
  module: string;
  npmVersion: string;
  name: string;
  kind: DtsSymbol["kind"];
  signature: string;
  summary: string;
  params: { name: string; text: string }[];
  returns?: string;
  throws: string[];
  privileges: string[];
  deprecated?: string;
  /** Only available in the beta API (`@beta`, or absent from the non-beta typings). */
  beta: boolean;
  /** First stable module version with this symbol (engine metadata), or `beta`. */
  since?: string;
  /** Declared on a base class (`Player.applyDamage` → `Entity.applyDamage`). */
  inheritedFrom?: string;
  examples: { title: string; code: string }[];
  /** For classes/interfaces/enums: member signatures. */
  members?: { name: string; kind: string; signature: string; beta: boolean }[];
}

export interface ApiLookupResult {
  channel: Channel;
  /** Game build of the typings. */
  version: string;
  samplesTag: string;
  query: string;
  entries: ApiEntry[];
  /** Near matches when nothing matched exactly. */
  suggestions: string[];
}

/** `@minecraft/server:Entity.applyDamage`, `Entity#applyDamage`, `Entity.applyDamage()`, `world.getDimension`. */
export function normalizeApiQuery(query: string): { module?: string; path: string[] } {
  let q = query.trim().replace(/\(\)$/, "").replace(/#/g, ".");
  let module: string | undefined;
  const m = /^(@minecraft\/[\w-]+)(?:[:.](.*))?$/.exec(q);
  if (m?.[1]) {
    module = m[1];
    q = m[2] ?? "";
  }
  return { module, path: q.split(".").filter(Boolean) };
}

export async function apiLookup(opts: {
  query: string;
  channel: Channel;
  module?: string;
  offline?: boolean;
  limit?: number;
}): Promise<ApiLookupResult> {
  const limit = opts.limit ?? 10;
  const [betaTable, stableTable, since] = await Promise.all([
    symbolTable(opts.channel, true, opts.offline),
    symbolTable(opts.channel, false, opts.offline),
    sinceIndex(opts.channel, opts.offline),
  ]);
  const parsed = normalizeApiQuery(opts.query);
  const module = opts.module ?? parsed.module;
  const inModule = (s: DtsSymbol) => !module || s.module === module;
  const variables = new Map<string, string>();
  for (const s of betaTable.all) {
    if (s.kind !== "variable") continue;
    const type = /:\s*([A-Za-z_$][\w$]*)\s*$/.exec(s.signature)?.[1];
    if (type) variables.set(s.name, type);
  }

  const resolveMember = (container: string, member: string, seen = new Set<string>()): DtsSymbol[] => {
    if (seen.has(container)) return [];
    seen.add(container);
    const direct = (betaTable.byName.get(`${container}.${member}`) ?? []).filter(inModule);
    if (direct.length) return direct;
    const owner = (betaTable.byName.get(container) ?? []).find((s) => s.bases);
    for (const base of owner?.bases ?? []) {
      const found = resolveMember(base.replace(/^\w+\./, ""), member, seen);
      if (found.length) return found;
    }
    return [];
  };

  let matches: { sym: DtsSymbol; inheritedFrom?: string }[] = [];
  const [first, second] = parsed.path;
  if (first && second) {
    const container = variables.get(first) ?? first;
    let found = resolveMember(container, second);
    if (!found.length) {
      const ci = betaTable.all.filter(
        (s) => inModule(s) && s.name.toLowerCase() === `${container}.${second}`.toLowerCase(),
      );
      found = ci;
    }
    matches = found.map((sym) => ({
      sym,
      inheritedFrom: sym.container && sym.container !== container ? sym.container : undefined,
    }));
  } else if (first) {
    const exact = (betaTable.byName.get(first) ?? []).filter(inModule);
    const members = betaTable.all.filter((s) => inModule(s) && s.container && s.name.endsWith(`.${first}`));
    matches = (exact.length ? [...exact, ...members] : members).map((sym) => ({ sym }));
    if (!matches.length) {
      const lower = first.toLowerCase();
      matches = betaTable.all
        .filter((s) => inModule(s) && (s.name.toLowerCase() === lower || s.name.toLowerCase().endsWith(`.${lower}`)))
        .map((sym) => ({ sym }));
    }
  }

  /** The plain typings' declaration of a symbol, when it is not beta there. */
  const stableOf = (sym: DtsSymbol): DtsSymbol | undefined =>
    (stableTable.byName.get(sym.name) ?? []).find((s) => s.module === sym.module && !s.doc.beta);
  const entries = matches.slice(0, limit).map(({ sym: betaSym, inheritedFrom }): ApiEntry => {
    // A stable symbol is reported from the plain typings (their signature, docs and npm version); only a beta
    // symbol comes from the beta typings.
    const stableSym = stableOf(betaSym);
    const sym = stableSym ?? betaSym;
    const entry: ApiEntry = {
      module: sym.module,
      npmVersion: (stableSym ? stableTable : betaTable).packages[sym.module] ?? "",
      name: sym.name,
      kind: sym.kind,
      signature: sym.signature,
      summary: sym.doc.summary,
      params: sym.doc.params,
      throws: sym.doc.throws,
      privileges: sym.doc.privileges,
      beta: !stableSym,
      examples: sym.doc.examples.slice(0, 2),
    };
    if (sym.doc.returns) entry.returns = sym.doc.returns;
    if (sym.doc.deprecated) entry.deprecated = sym.doc.deprecated;
    const s = since.index[sym.module]?.since[sym.name];
    if (s) entry.since = s;
    if (inheritedFrom) entry.inheritedFrom = inheritedFrom;
    if (sym.kind === "class" || sym.kind === "interface" || sym.kind === "enum") {
      entry.members = betaTable.all
        .filter((m) => m.container === sym.name && m.module === sym.module)
        .map((betaMember) => {
          const m = stableOf(betaMember) ?? betaMember;
          return { name: m.name.slice(sym.name.length + 1), kind: m.kind, signature: m.signature, beta: m === betaMember };
        });
    }
    return entry;
  });

  const suggestions = entries.length
    ? []
    : suggestNames(
        parsed.path.at(-1) ?? opts.query,
        betaTable.all.filter(inModule).map((s) => s.name),
        { key: (n) => n.slice(n.lastIndexOf(".") + 1) },
      );
  return {
    channel: opts.channel,
    version: betaTable.version,
    samplesTag: since.tag,
    query: opts.query,
    entries,
    suggestions,
  };
}
