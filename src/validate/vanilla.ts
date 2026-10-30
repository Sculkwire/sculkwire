/**
 * Vanilla data from a bedrock-samples checkout (fetched at runtime, never bundled): the names vanilla content
 * defines or references (for reference checks), shipped script-module versions (for manifest checks), the
 * command list (for .mcfunction checks) and the game version the samples describe.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "../core/paths.ts";
import type { PackInfo, PackKind } from "../core/project.ts";
import { Context, loadPack, type Pack } from "./context.ts";
import { ReferenceChecker, type RefKind, type VanillaNames } from "./references.ts";

const CACHE_VERSION = 1;

const VANILLADATA_KINDS: Record<string, string> = {
  "mojang-items.json": "item",
  "mojang-blocks.json": "block",
  "mojang-entities.json": "entity",
  "mojang-biomes.json": "biome",
  "mojang-effects.json": "effect",
  "mojang-enchantments.json": "enchantment",
  "mojang-features.json": "feature",
  "mojang-dimensions.json": "dimension",
};

export interface VanillaData {
  root: string;
  /** Game version the samples describe (`version.json` latest), e.g. `1.26.50.4`. */
  version?: string;
  /** Stable identity of the checkout, used as cache key by other caches (schema calibration). */
  identity: string;
  names: VanillaNames;
  /** `@minecraft/<module>` -> manifest version -> module uuid, as shipped by this game version. */
  scriptModules: Map<string, Map<string, string | undefined>>;
  /** Command names and aliases (lowercase). Empty when the samples lack `metadata/command_modules`. */
  commands: Set<string>;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function gitHead(root: string): Promise<string> {
  const head = (await readText(join(root, ".git", "HEAD")))?.trim();
  if (!head) return "";
  const ref = /^ref: (.+)$/.exec(head)?.[1];
  if (!ref) return head;
  return (await readText(join(root, ".git", ...ref.split("/"))))?.trim() ?? ref;
}

/** Game version (`version.json` "latest") of a samples checkout. */
export async function samplesVersion(root: string): Promise<string | undefined> {
  const text = await readText(join(root, "version.json"));
  if (!text) return undefined;
  try {
    const v = (JSON.parse(text) as { latest?: { version?: unknown } }).latest?.version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

async function scriptModules(root: string): Promise<Map<string, Map<string, string | undefined>>> {
  const out = new Map<string, Map<string, string | undefined>>();
  const dir = join(root, "metadata", "script_modules");
  async function walk(d: string, scope: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        await walk(join(d, e.name), e.name.startsWith("@") ? e.name : scope);
        continue;
      }
      const m = /^(.+)_(\d+\.\d+\.\d+(?:-\w+)?)\.json$/.exec(e.name);
      if (!m) continue;
      const name = scope ? `${scope}/${m[1]}` : (m[1] as string);
      if (name.endsWith("-bindings")) continue;
      let uuid: string | undefined;
      try {
        const j = JSON.parse(await readFile(join(d, e.name), "utf8")) as { uuid?: unknown };
        if (typeof j.uuid === "string") uuid = j.uuid;
      } catch {
        uuid = undefined;
      }
      let versions = out.get(name);
      if (!versions) out.set(name, (versions = new Map()));
      versions.set(m[2] as string, uuid);
    }
  }
  await walk(dir, "");
  return out;
}

async function commands(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  const text = await readText(join(root, "metadata", "command_modules", "mojang-commands.json"));
  if (!text) return out;
  try {
    const j = JSON.parse(text) as { commands?: { name?: unknown; aliases?: unknown }[] };
    for (const c of j.commands ?? []) {
      if (typeof c.name === "string") out.add(c.name.toLowerCase());
      for (const a of Array.isArray(c.aliases) ? c.aliases : []) {
        const n = typeof a === "string" ? a : (a as { name?: unknown })?.name;
        if (typeof n === "string") out.add(n.toLowerCase());
      }
    }
  } catch {
    // unreadable command metadata: mcfunction command checks are skipped
  }
  return out;
}

/** Everything vanilla content references ships with the game (engine assets, legacy aliases), so it counts. */
class Collector extends ReferenceChecker {
  readonly out: VanillaNames;
  constructor(ctx: Context, packs: Pack[], out: VanillaNames) {
    super(ctx, packs, { vanilla: out });
    this.out = out;
  }
  override async missing(_pack: Pack, _rel: string, _pointer: string, kind: RefKind, name: string): Promise<void> {
    let set = this.out[kind];
    if (!set) this.out[kind] = set = new Set();
    set.add(name);
  }
  override async duplicates(): Promise<void> {}
}

async function buildNames(root: string): Promise<VanillaNames> {
  const names: VanillaNames = {};
  const packs: Pack[] = [];
  for (const [sub, kind] of [
    ["behavior_pack", "behavior"],
    ["resource_pack", "resource"],
  ] as [string, PackKind][]) {
    const info: PackInfo = { kind, dir: join(root, sub), relDir: sub };
    const pack = await loadPack(info, root);
    if (pack.files.length) packs.push(pack);
  }
  const ctx = new Context(root, packs);
  const collector = new Collector(ctx, packs, names);
  await collector.init();
  for (const [kind, defined] of collector.idx) {
    let set = names[kind];
    if (!set) names[kind] = set = new Set();
    for (const n of defined.keys()) set.add(n);
  }
  for (const [file, kind] of Object.entries(VANILLADATA_KINDS)) {
    const text = await readText(join(root, "metadata", "vanilladata_modules", file));
    if (!text) continue;
    try {
      const j = JSON.parse(text) as { data_items?: { name?: unknown }[] };
      const key = kind as keyof VanillaNames;
      let set = names[key];
      if (!set) names[key] = set = new Set();
      for (const item of j.data_items ?? []) if (typeof item.name === "string") set.add(item.name);
    } catch {
      // skip unreadable metadata file
    }
  }
  // Second pass: collect what vanilla references (and is therefore shipped) given the full index.
  await collector.run();
  return names;
}

const memo = new Map<string, Promise<VanillaData>>();

/** Load (and cache under `cacheDir('validate')`) the vanilla data of a bedrock-samples checkout. */
export function loadVanilla(root: string): Promise<VanillaData> {
  let p = memo.get(root);
  if (!p) {
    p = loadVanillaUncached(root);
    memo.set(root, p);
  }
  return p;
}

async function loadVanillaUncached(root: string): Promise<VanillaData> {
  const version = await samplesVersion(root);
  const identity = createHash("sha1")
    .update(`${root}\n${(await readText(join(root, "version.json"))) ?? ""}\n${await gitHead(root)}`)
    .digest("hex")
    .slice(0, 16);
  const cacheFile = cacheDir("validate", `vanilla-${identity}-v${CACHE_VERSION}.json`);
  let names: VanillaNames | undefined;
  const cached = await readText(cacheFile);
  if (cached) {
    try {
      const j = JSON.parse(cached) as Record<string, string[]>;
      names = {};
      for (const [k, v] of Object.entries(j)) names[k as keyof VanillaNames] = new Set(v);
    } catch {
      names = undefined;
    }
  }
  if (!names) {
    names = await buildNames(root);
    const plain: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(names)) plain[k] = [...(v as Set<string>)].sort();
    await mkdir(cacheDir("validate"), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(plain));
  }
  const data: VanillaData = {
    root,
    identity,
    names,
    scriptModules: await scriptModules(root),
    commands: await commands(root),
  };
  if (version) data.version = version;
  return data;
}
