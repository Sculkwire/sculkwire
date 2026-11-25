/**
 * The worlds the client is launched into. For a user that is always one of their own worlds (`enterUserWorld`): the
 * one they chose or the one that uses the project's packs, entered with the helper and the project's packs, its small
 * files backed up before each launch writes them. sculkwire writes nothing else into it (no icon, no marker).
 *
 * `createWorld` makes a scratch world for `sculk bench` and sculkwire's own live tests only: a flat creative world with
 * cheats on, named `sculkwire-<name>`, replaced on each call and deleted by its caller when the run ends. The game fills
 * in every level.dat key left out on first load.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLevelDat, TAG, tagNumber, writeLevelDat } from "../../gamefiles/nbt.ts";
import type { NbtCompound, NbtTag } from "../../gamefiles/nbt.ts";
import { parseGameVersion } from "../../core/version.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { DIFFICULTIES, difficultyOf, hasCheats, levelIdFor, setCheats, setSinglePlayer, WORLD_PREFIX, worldName, type Difficulty } from "../../gamefiles/worlds.ts";
import { exists, readJsonOr, writeFileAtomic } from "../../core/fs.ts";
import { dataDir } from "../../core/paths.ts";
import { findWorld } from "./worldstore.ts";

export const HELPER_PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), "helper-pack");
export const HELPER_PACK_FOLDER = "sculkwire_helper";

export interface PackRef {
  uuid: string;
  version: number[];
  kind: "behavior" | "resource";
}

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
  /** `created`: a scratch world (`createWorld`), `user`: one of the user's own worlds (`enterUserWorld`). */
  how: "created" | "user";
  /** `user` only: the backup of the files this launch wrote (`USER_WORLD_FILES`). */
  backup?: string;
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
  setCheats(root);
  root.set("hasBeenLoadedInCreative", byte(1));
  root.set("commandblockoutput", byte(0));
  root.set("sendcommandfeedback", byte(1));
  root.set("dodaylightcycle", byte(0));
  root.set("doweathercycle", byte(0));
  root.set("domobspawning", byte(0));
  root.set("Time", long(6000n));
  root.set("showcoordinates", byte(1));
  setSinglePlayer(root);
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

type PackEntry = { pack_id: string; version: number[] };

/** Put `entries` first in a world's pack list (helper first); other packs stay, a same `pack_id` is replaced. */
async function mergePackList(file: string, entries: PackEntry[]): Promise<void> {
  const current = await readJsonOr<unknown>(file);
  const ids = new Set(entries.map((e) => e.pack_id));
  const others = (Array.isArray(current) ? current : []).filter(
    (e: unknown) => typeof e === "object" && e !== null && !ids.has((e as { pack_id?: unknown }).pack_id as string),
  );
  await writeFileAtomic(file, `${JSON.stringify([...entries, ...others], null, 2)}\n`);
}

/**
 * Create (or replace) the scratch world `sculkwire-<name>` in the active user's minecraftWorlds, for `sculk bench` and
 * sculkwire's own live tests: never for a user's session. Never touches other worlds and writes no icon; its caller
 * deletes it when the run ends (`deleteWorld`).
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
  await activatePacks(install, dir, opts, true);
  return { levelId, name, dir, how: "created" };
}

/** The helper (unless `helper` is false) and `packs` into a world's pack lists: written anew with `replace`, else merged. */
async function activatePacks(install: ClientInstall, dir: string, opts: Pick<WorldOptions, "packs" | "helper">, replace: boolean): Promise<void> {
  const packs = [...(opts.packs ?? [])];
  if (opts.helper !== false) packs.unshift(await installHelperPack(install));
  for (const kind of ["behavior", "resource"] as const) {
    const file = join(dir, `world_${kind}_packs.json`);
    const entries = packs.filter((p) => p.kind === kind).map((p) => ({ pack_id: p.uuid, version: p.version }));
    if (replace) await writeFile(file, `${JSON.stringify(entries, null, 2)}\n`);
    else await mergePackList(file, entries);
  }
}

/** The files of a user's dev world sculkwire may write, copied to a backup before each launch writes them. Never `db/`. */
export const USER_WORLD_FILES = ["level.dat", "level.dat_old", "world_behavior_packs.json", "world_resource_packs.json"] as const;
/** Backups kept per world; older ones are removed. */
export const WORLD_BACKUPS_KEPT = 10;

export interface UserWorldOptions {
  /** Level name or level id of one of the user's own worlds (a name several worlds share is refused). */
  world: string;
  /** Packs to activate in the world (besides the helper). */
  packs?: PackRef[];
  /** Install and activate the helper behavior pack (default true). */
  helper?: boolean;
  /** Turn the Beta APIs experiment on (it stays on in the world for good). */
  betaApis?: boolean;
  /** Set the world's difficulty; left as it is when absent. */
  difficulty?: Difficulty;
  /** Where backups go: `<backupRoot>/<levelId>/<timestamp>`. Default `dataDir("world-backups")`. */
  backupRoot?: string;
  now?: Date;
}

/**
 * Copy the user world's small files (`USER_WORLD_FILES`, never `db/`) to `<root>/<levelId>/<ISO timestamp>` and keep the
 * newest `WORLD_BACKUPS_KEPT` backups of that world. Returns the new backup's folder.
 */
async function backupUserWorld(dir: string, levelId: string, root: string, now: Date): Promise<string> {
  const worldBackups = join(root, levelId);
  // Colons are not allowed in Windows file names; the stamp still sorts by time.
  const dest = join(worldBackups, now.toISOString().replace(/:/g, "-"));
  await mkdir(dest, { recursive: true });
  for (const file of USER_WORLD_FILES) {
    if (await exists(join(dir, file))) await cp(join(dir, file), join(dest, file));
  }
  const all = (await readdir(worldBackups)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - WORLD_BACKUPS_KEPT))) await rm(join(worldBackups, old), { recursive: true, force: true });
  return dest;
}

/**
 * Enter one of the user's own worlds: the one they chose, or the one that uses the project's packs. Never deletes or
 * replaces it: first its small files are backed up (`backupUserWorld`), then the helper and `packs` are merged into
 * its pack lists (other packs stay), cheats and commands are turned on when they are off, Beta APIs only with
 * `betaApis`, the difficulty only when given. Nothing else is written into it. Call it only while the game does not
 * run. Returns the world and one note per change to its settings.
 */
export async function enterUserWorld(install: ClientInstall, opts: UserWorldOptions): Promise<{ world: CreatedWorld; notes: string[] }> {
  const { levelId, name, dir } = await findWorld(install, opts.world);
  const backup = await backupUserWorld(dir, levelId, opts.backupRoot ?? dataDir("world-backups"), opts.now ?? new Date());
  const level = readLevelDat(new Uint8Array(await readFile(join(dir, "level.dat"))));
  const notes: string[] = [];
  let changed = false;
  if (!hasCheats(level.root)) {
    setCheats(level.root);
    changed = true;
    notes.push(`turned cheats on in ${name} (sculkwire's commands need them); the game awards no achievements in it from now on`);
  }
  if (opts.betaApis) {
    const experiments = level.root.get("experiments");
    const exp: NbtCompound = experiments?.type === TAG.Compound ? (experiments.value as NbtCompound) : new Map();
    if (tagNumber(exp.get("gametest")) !== 1) {
      exp.set("gametest", byte(1));
      exp.set("experiments_ever_used", byte(1));
      exp.set("saved_with_toggled_experiments", byte(1));
      level.root.set("experiments", { type: TAG.Compound, value: exp });
      changed = true;
      notes.push(`turned the Beta APIs experiment on in ${name}; an experiment stays on in a world for good`);
    }
  }
  if (opts.difficulty && difficultyOf(tagNumber(level.root.get("Difficulty"))) !== opts.difficulty) {
    level.root.set("Difficulty", int(DIFFICULTIES[opts.difficulty]));
    changed = true;
    notes.push(`set the difficulty of ${name} to ${opts.difficulty}`);
  }
  if (changed) await writeFileAtomic(join(dir, "level.dat"), writeLevelDat(level));
  await activatePacks(install, dir, opts, false);
  return { world: { levelId, name, dir, how: "user", backup }, notes };
}
