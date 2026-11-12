/**
 * Vanilla data from a bedrock-samples checkout (fetched at runtime, never bundled): the names vanilla content
 * defines or references (for reference checks), shipped script-module versions (for manifest checks), the
 * command list (for .mcfunction checks) and the game version the samples describe.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readJsonOr, writeFileAtomic } from "../core/fs.ts";
import { memoAsync } from "../core/memo.ts";
import { cacheDir } from "../core/paths.ts";
import type { PackKind } from "../core/project.ts";
import { checkoutCommit, readCommandNames, readSamplesVersion, readScriptModuleVersions, readVanillaData } from "../knowledge/metadata.ts";
import { classifyFile, type FileKind, JSON_EXT } from "./classify.ts";
import { Context, loadPack, type Pack } from "./context.ts";
import { ReferenceChecker, type RefKind, type VanillaNames } from "./references.ts";

const CACHE_VERSION = 1;

/** `metadata/vanilladata_modules` files whose ids count as vanilla names, and the kind each one names. */
const VANILLADATA_KINDS: Record<string, keyof VanillaNames> = {
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

/** The vanilla behavior and resource packs of a samples checkout, with one context that reads and parses their files. */
async function loadVanillaPacks(root: string): Promise<{ ctx: Context; packs: Pack[] }> {
  const packs: Pack[] = [];
  for (const [sub, kind] of [
    ["behavior_pack", "behavior"],
    ["resource_pack", "resource"],
  ] as [string, PackKind][]) {
    const pack = await loadPack({ kind, dir: join(root, sub), relDir: sub }, root);
    if (pack.files.length) packs.push(pack);
  }
  return { ctx: new Context(root, packs), packs };
}

/** Every vanilla JSON file the game can load, classified, for schema calibration. */
export async function vanillaFiles(root: string): Promise<{ packKind: PackKind; rel: string; kind: FileKind; value: unknown }[]> {
  const { ctx, packs } = await loadVanillaPacks(root);
  const out: { packKind: PackKind; rel: string; kind: FileKind; value: unknown }[] = [];
  for (const p of packs) {
    for (const rel of p.files) {
      if (!JSON_EXT.test(rel)) continue;
      const value = await ctx.value(p, rel);
      if (value !== undefined) out.push({ packKind: p.kind, rel, kind: classifyFile(p.kind, rel), value });
    }
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
  const { ctx, packs } = await loadVanillaPacks(root);
  const collector = new Collector(ctx, packs, names);
  await collector.init();
  for (const [kind, defined] of collector.idx) {
    let set = names[kind];
    if (!set) names[kind] = set = new Set();
    for (const n of defined.keys()) set.add(n);
  }
  const data = await readVanillaData(root);
  for (const [file, key] of Object.entries(VANILLADATA_KINDS)) {
    const found = data.find((d) => d.file === file);
    if (!found) continue;
    let set = names[key];
    if (!set) names[key] = set = new Set();
    for (const item of found.items) if (typeof item.name === "string") set.add(item.name);
  }
  // Second pass: collect what vanilla references (and is therefore shipped) given the full index.
  await collector.run();
  return names;
}

const memo = memoAsync<VanillaData>();

/** Load (and cache under `cacheDir('validate')`) the vanilla data of a bedrock-samples checkout. */
export function loadVanilla(root: string): Promise<VanillaData> {
  return memo(root, () => loadVanillaUncached(root));
}

async function loadVanillaUncached(root: string): Promise<VanillaData> {
  const version = await readSamplesVersion(root);
  const versionText = await readFile(join(root, "version.json"), "utf8").catch(() => "");
  const identity = createHash("sha1")
    .update(`${root}\n${versionText}\n${await checkoutCommit(root)}`)
    .digest("hex")
    .slice(0, 16);
  const cacheFile = cacheDir("validate", `vanilla-${identity}-v${CACHE_VERSION}.json`);
  const cached = await readJsonOr<Record<string, string[]>>(cacheFile);
  let names: VanillaNames;
  if (cached) {
    names = {};
    for (const [k, v] of Object.entries(cached)) names[k as keyof VanillaNames] = new Set(v);
  } else {
    names = await buildNames(root);
    const plain: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(names)) plain[k] = [...(v as Set<string>)].sort();
    await writeFileAtomic(cacheFile, JSON.stringify(plain));
  }
  const data: VanillaData = {
    root,
    identity,
    names,
    scriptModules: await readScriptModuleVersions(root),
    commands: await readCommandNames(root),
  };
  if (version) data.version = version;
  return data;
}
