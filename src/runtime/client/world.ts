/**
 * Test worlds for the client: a flat creative world with cheats on, named `sculkwire-<name>`, with the helper pack
 * and chosen packs active. The game fills in every level.dat key we leave out on first load.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TAG, writeLevelDat } from "../bds/nbt.ts";
import type { NbtCompound, NbtTag } from "../bds/nbt.ts";
import { parseGameVersion } from "../../core/version.ts";
import { ICON_FILE, worldIcon } from "./icon.ts";
import type { ClientInstall } from "./install.ts";

export const WORLD_PREFIX = "sculkwire-";
export const HELPER_PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), "helper-pack");
export const HELPER_PACK_FOLDER = "sculkwire_helper";

export interface PackRef {
  uuid: string;
  version: number[];
  kind: "behavior" | "resource";
}

/** Level.dat `Difficulty` values. */
export const DIFFICULTIES = { peaceful: 0, easy: 1, normal: 2, hard: 3 } as const;
export type Difficulty = keyof typeof DIFFICULTIES;

export interface WorldOptions {
  /** Without the `sculkwire-` prefix; it is added when missing. */
  name: string;
  /** Packs to activate in the world (besides the helper). */
  packs?: PackRef[];
  /** Install and activate the helper behavior pack (default true). */
  helper?: boolean;
  /** Experiment toggles, e.g. `gametest` (Beta APIs). */
  experiments?: string[];
  seed?: bigint;
  /** Game version for `lastOpenedWithVersion` (e.g. `1.26.60.30`). */
  gameVersion?: string;
  /** Default `normal`, so hostile mobs exist (peaceful removes them). */
  difficulty?: Difficulty;
}

export interface CreatedWorld {
  /** Folder name under minecraftWorlds = the localLevelId for the deeplink. */
  levelId: string;
  name: string;
  dir: string;
}

const byte = (v: number): NbtTag => ({ type: TAG.Byte, value: v });
const int = (v: number): NbtTag => ({ type: TAG.Int, value: v });
const long = (v: bigint): NbtTag => ({ type: TAG.Long, value: v });
const str = (v: string): NbtTag => ({ type: TAG.String, value: v });
const intList = (v: number[]): NbtTag => ({ type: TAG.List, value: { elementType: TAG.Int, items: v.map(int) } });

const FLAT_LAYERS =
  '{"biome_id":1,"block_layers":[{"block_name":"minecraft:bedrock","count":1},{"block_name":"minecraft:dirt","count":2},{"block_name":"minecraft:grass_block","count":1}],"encoding_version":6,"structure_options":null,"world_version":"version.post_1_18"}\n';

/**
 * Root compound of a flat, creative, cheats-on world with daylight/weather/mob spawning frozen for reproducibility.
 * Multiplayer is off (no LAN, Xbox Live or platform broadcast), so nobody can join a test session.
 */
export function levelDatRoot(name: string, opts: Pick<WorldOptions, "experiments" | "seed" | "gameVersion" | "difficulty"> = {}): NbtCompound {
  const root: NbtCompound = new Map();
  root.set("LevelName", str(name));
  root.set("GameType", int(1));
  root.set("Generator", int(2));
  root.set("FlatWorldLayers", str(FLAT_LAYERS));
  root.set("Difficulty", int(DIFFICULTIES[opts.difficulty ?? "normal"]));
  root.set("RandomSeed", long(opts.seed ?? 0x5c01c3n));
  root.set("SpawnX", int(0));
  root.set("SpawnY", int(32767));
  root.set("SpawnZ", int(0));
  root.set("StorageVersion", int(10));
  root.set("commandsEnabled", byte(1));
  root.set("cheatsEnabled", byte(1));
  root.set("hasBeenLoadedInCreative", byte(1));
  root.set("commandblockoutput", byte(0));
  root.set("sendcommandfeedback", byte(1));
  root.set("dodaylightcycle", byte(0));
  root.set("doweathercycle", byte(0));
  root.set("domobspawning", byte(0));
  root.set("Time", long(6000n));
  root.set("showcoordinates", byte(1));
  root.set("MultiplayerGame", byte(0));
  root.set("MultiplayerGameIntent", byte(0));
  root.set("LANBroadcast", byte(0));
  root.set("LANBroadcastIntent", byte(0));
  // Broadcast setting 0 is "no multiplayer" (1 invite only, 2 friends, 3 friends of friends, 4 public).
  root.set("XBLBroadcastIntent", int(0));
  root.set("PlatformBroadcastIntent", int(0));
  root.set("LastPlayed", long(BigInt(Math.floor(Date.now() / 1000))));
  const v = opts.gameVersion ? parseGameVersion(opts.gameVersion) : undefined;
  if (v) root.set("lastOpenedWithVersion", intList([v.major, v.minor, v.patch, v.build ?? 0, 0]));
  root.set("MinimumCompatibleClientVersion", intList([1, 21, 0, 0, 0]));
  const exp: NbtCompound = new Map();
  for (const e of opts.experiments ?? []) exp.set(e, byte(1));
  if (opts.experiments?.length) {
    exp.set("experiments_ever_used", byte(1));
    exp.set("saved_with_toggled_experiments", byte(1));
  }
  root.set("experiments", { type: TAG.Compound, value: exp });
  return root;
}

export function worldName(name: string): string {
  return name.startsWith(WORLD_PREFIX) ? name : `${WORLD_PREFIX}${name}`;
}

/** Folder-safe level id derived from the world name (stable, so a re-create replaces the same world). */
export function levelIdFor(name: string): string {
  return worldName(name).replace(/[^A-Za-z0-9_-]+/g, "_");
}

async function helperManifest(): Promise<{ header: { uuid: string; version: number[] } }> {
  return JSON.parse(await readFile(join(HELPER_PACK_DIR, "manifest.json"), "utf8")) as { header: { uuid: string; version: number[] } };
}

/** Copy the helper pack into development_behavior_packs (replacing an older copy). */
export async function installHelperPack(install: ClientInstall): Promise<PackRef> {
  const dest = join(install.sharedComMojang, "development_behavior_packs", HELPER_PACK_FOLDER);
  await rm(dest, { recursive: true, force: true });
  await cp(HELPER_PACK_DIR, dest, { recursive: true });
  const m = await helperManifest();
  return { uuid: m.header.uuid, version: m.header.version, kind: "behavior" };
}

/**
 * Create (or replace) a `sculkwire-` world in the active user's minecraftWorlds. Never touches other worlds. The world
 * gets sculkwire's icon for its level id (icon.ts), which is how the join recovery knows its tile on the Play screen.
 */
export async function createWorld(install: ClientInstall, opts: WorldOptions): Promise<CreatedWorld> {
  const name = worldName(opts.name);
  const levelId = levelIdFor(name);
  const dir = join(install.userComMojang, "minecraftWorlds", levelId);
  if (!levelId.startsWith(WORLD_PREFIX)) throw new Error(`refusing to write world folder ${levelId}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "db"), { recursive: true });
  const root = levelDatRoot(name, opts);
  await writeFile(join(dir, "level.dat"), writeLevelDat({ storageVersion: 10, rootName: "", root }));
  await writeFile(join(dir, "levelname.txt"), name);
  await writeWorldIcon({ levelId, name, dir });
  const packs = [...(opts.packs ?? [])];
  if (opts.helper !== false) packs.unshift(await installHelperPack(install));
  const entries = (kind: PackRef["kind"]) => packs.filter((p) => p.kind === kind).map((p) => ({ pack_id: p.uuid, version: p.version }));
  await writeFile(join(dir, "world_behavior_packs.json"), `${JSON.stringify(entries("behavior"), null, 2)}\n`);
  await writeFile(join(dir, "world_resource_packs.json"), `${JSON.stringify(entries("resource"), null, 2)}\n`);
  return { levelId, name, dir };
}

/** `sculkwire-` worlds in the active user's folder. */
export async function listWorlds(install: ClientInstall): Promise<CreatedWorld[]> {
  const base = join(install.userComMojang, "minecraftWorlds");
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return [];
  }
  const out: CreatedWorld[] = [];
  for (const levelId of names) {
    let name: string;
    try {
      name = (await readFile(join(base, levelId, "levelname.txt"), "utf8")).trim();
    } catch {
      continue;
    }
    if (name.startsWith(WORLD_PREFIX)) out.push({ levelId, name, dir: join(base, levelId) });
  }
  return out;
}

/**
 * Write sculkwire's icon into a `sculkwire-` world (createWorld does). The game replaces `world_icon.jpeg` with a
 * picture of the world when it saves and quits it, so the join recovery writes the icon again before it looks for it.
 */
export async function writeWorldIcon(world: CreatedWorld): Promise<void> {
  if (!world.levelId.startsWith(WORLD_PREFIX)) throw new Error(`refusing to write into world folder ${world.levelId}`);
  await writeFile(join(world.dir, ICON_FILE), worldIcon(world.levelId));
}

/** Remove a world this tool created (name must carry the prefix). */
export async function deleteWorld(world: CreatedWorld): Promise<void> {
  if (!world.name.startsWith(WORLD_PREFIX)) throw new Error(`refusing to delete non-sculkwire world ${world.name}`);
  await rm(world.dir, { recursive: true, force: true });
}
