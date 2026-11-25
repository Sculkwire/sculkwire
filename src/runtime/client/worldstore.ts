/**
 * The worlds of the active user: listing them, finding one by name or level id, finding the user's worlds that use a
 * project's packs, and the `sculkwire-` worlds earlier versions made as test worlds (and `sculk bench` still makes as
 * scratch worlds): their kept marker, removal of stale ones, deletion of one.
 *
 * Only a folder whose name AND level name both start with `sculkwire-` is ever deleted here (the live-game rule: never
 * touch the user's own worlds), and one marked kept or copied (it can hold the user's work) never automatically. The
 * user's own worlds are only read here; the one a launch enters is written by `enterUserWorld` (world.ts).
 */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { readJsonOr } from "../../core/fs.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { readLevelDat, tagNumber, type LevelDat } from "../../gamefiles/nbt.ts";
import { gameTypeOf, levelIdFor, WORLD_PREFIX, worldName, type GameType } from "../../gamefiles/worlds.ts";

/** A `sculkwire-` world not played for this many days is removed by the next launch, unless it is kept. */
export const STALE_WORLD_DAYS = 3;
/** The kept marker earlier versions wrote into a `sculkwire-` world's folder. */
export const WORLD_MARKER = "sculkwire-world.json";
/** The picture of a world the game shows as its tile's thumbnail on the Play screen; the game writes it. */
export const ICON_FILE = "world_icon.jpeg";

export interface WorldMarker {
  /** Never removed automatically. */
  keep: boolean;
  /** The level name of the user's world this one was copied from. */
  copiedFrom?: string;
}

export interface WorldInfo {
  /** Folder name under minecraftWorlds. */
  levelId: string;
  /** Level name (`levelname.txt`). */
  name: string;
  dir: string;
  /** Both the folder and the level name start with `sculkwire-`: the only worlds sculkwire deletes. */
  sculkwire: boolean;
  /** A `sculkwire-` world with the kept marker: never removed automatically. */
  kept: boolean;
  /** The level name of the user's world a `sculkwire-` world was copied from by an earlier version. */
  copiedFrom?: string;
  /** `LastPlayed` of `level.dat`, else the folder's modification time. */
  lastPlayed: Date;
  gameMode?: GameType;
  /** Total size of the folder's files; only `listAllWorlds` measures it. */
  sizeBytes?: number;
}

/** A world sculkwire refuses to delete or write: not a test world, or the one the game has loaded. */
export class WorldRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldRefused";
  }
}

function worldsDir(install: ClientInstall): string {
  return join(install.userComMojang, "minecraftWorlds");
}

function isTestWorld(levelId: string, name: string): boolean {
  return levelId.startsWith(WORLD_PREFIX) && name.startsWith(WORLD_PREFIX);
}

async function folderSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

/** One world folder, or undefined when its `levelname.txt` or `level.dat` cannot be read. */
async function readWorld(base: string, levelId: string, size: boolean): Promise<WorldInfo | undefined> {
  const dir = join(base, levelId);
  let name: string;
  let level: LevelDat;
  try {
    name = (await readFile(join(dir, "levelname.txt"), "utf8")).trim();
    level = readLevelDat(new Uint8Array(await readFile(join(dir, "level.dat"))));
  } catch {
    return undefined;
  }
  const sculkwire = isTestWorld(levelId, name);
  const marker = sculkwire ? await readJsonOr<Partial<WorldMarker>>(join(dir, WORLD_MARKER)) : undefined;
  const seconds = tagNumber(level.root.get("LastPlayed"));
  const gameMode = gameTypeOf(tagNumber(level.root.get("GameType")));
  return {
    levelId,
    name,
    dir,
    sculkwire,
    kept: marker?.keep === true,
    ...(typeof marker?.copiedFrom === "string" ? { copiedFrom: marker.copiedFrom } : {}),
    lastPlayed: seconds !== undefined && seconds > 0 ? new Date(seconds * 1000) : (await stat(dir)).mtime,
    ...(gameMode ? { gameMode } : {}),
    ...(size ? { sizeBytes: await folderSize(dir) } : {}),
  };
}

async function scanWorlds(install: ClientInstall, size: boolean): Promise<WorldInfo[]> {
  const base = worldsDir(install);
  let ids: string[];
  try {
    ids = await readdir(base);
  } catch {
    return [];
  }
  const out: WorldInfo[] = [];
  for (const levelId of ids) {
    const world = await readWorld(base, levelId, size);
    if (world) out.push(world);
  }
  return out.sort((a, b) => b.lastPlayed.getTime() - a.lastPlayed.getTime());
}

/** Every world in the active user's minecraftWorlds, played last first, with its size unless `size` is false. */
export function listAllWorlds(install: ClientInstall, size = true): Promise<WorldInfo[]> {
  return scanWorlds(install, size);
}

/**
 * The user's own worlds (never a `sculkwire-` one) whose behavior or resource pack list names one of `uuids`, played
 * last first.
 */
export async function worldsWithPacks(install: ClientInstall, uuids: readonly string[]): Promise<WorldInfo[]> {
  const wanted = new Set(uuids);
  const out: WorldInfo[] = [];
  for (const world of await scanWorlds(install, false)) {
    if (world.sculkwire) continue;
    for (const kind of ["behavior", "resource"]) {
      const list = await readJsonOr<unknown>(join(world.dir, `world_${kind}_packs.json`));
      const usesPack = (e: unknown) => typeof e === "object" && e !== null && "pack_id" in e && typeof e.pack_id === "string" && wanted.has(e.pack_id);
      if (Array.isArray(list) && list.some(usesPack)) {
        out.push(world);
        break;
      }
    }
  }
  return out;
}

/** Delete one listed world, after checking once more that both its folder and its level name are sculkwire's. */
async function removeTestWorld(world: WorldInfo): Promise<void> {
  if (!isTestWorld(world.levelId, world.name)) {
    throw new WorldRefused(`${world.name} (folder ${world.levelId}) is not a ${WORLD_PREFIX}* world; sculkwire never deletes it`);
  }
  await rm(world.dir, { recursive: true, force: true });
}

export interface PruneOptions {
  /** Level ids never removed: the world about to be launched, the user's saved dev world. */
  except?: readonly string[];
  now?: Date;
  maxAgeDays?: number;
}

/** Remove `sculkwire-` worlds that are not kept and were last played more than `maxAgeDays` ago. Returns their names. */
export async function pruneWorlds(install: ClientInstall, opts: PruneOptions = {}): Promise<string[]> {
  const cutoff = (opts.now ?? new Date()).getTime() - (opts.maxAgeDays ?? STALE_WORLD_DAYS) * 86_400_000;
  const removed: string[] = [];
  for (const world of await scanWorlds(install, false)) {
    if (!world.sculkwire || world.kept || opts.except?.includes(world.levelId) || world.lastPlayed.getTime() >= cutoff) continue;
    try {
      await removeTestWorld(world);
      removed.push(world.name);
    } catch {
      // A folder the game or another process holds open stays until a later launch.
    }
  }
  return removed;
}

export interface DeleteResult {
  /** The world name asked for, with the prefix. */
  world: string;
  existed: boolean;
  /** Folders removed. */
  levelIds: string[];
}

/**
 * Delete one test world by name (`sculkwire-` added when missing). Refuses a world that is not sculkwire's and the
 * world `loaded` (a level id) the running game has open.
 */
export async function deleteWorld(install: ClientInstall, name: string, opts: { loaded?: string } = {}): Promise<DeleteResult> {
  const wanted = worldName(name);
  const levelId = levelIdFor(wanted);
  if (opts.loaded !== undefined && opts.loaded === levelId) {
    throw new WorldRefused(`${wanted} is loaded by the running game: stop the game first (game_stop), then delete it`);
  }
  const all = await scanWorlds(install, false);
  const hits = all.filter((w) => w.name === wanted || w.levelId === levelId);
  const foreign = hits.find((w) => !w.sculkwire);
  if (foreign) {
    throw new WorldRefused(`${foreign.name} (folder ${foreign.levelId}) is not a ${WORLD_PREFIX}* world; sculkwire deletes only its own test worlds`);
  }
  if (hits.length === 0) {
    const own = all.find((w) => w.name === name && !w.sculkwire);
    if (own) throw new WorldRefused(`"${name}" (folder ${own.levelId}) is one of your own worlds; sculkwire never deletes it`);
    return { world: wanted, existed: false, levelIds: [] };
  }
  const loaded = hits.find((w) => w.levelId === opts.loaded);
  if (loaded) throw new WorldRefused(`${loaded.name} is loaded by the running game: stop the game first (game_stop), then delete it`);
  for (const world of hits) await removeTestWorld(world);
  return { world: wanted, existed: true, levelIds: hits.map((w) => w.levelId) };
}

/**
 * The one world whose level id, else whose level name, is `wanted`. Throws when none is, and when several share the
 * name (pass the level id of one).
 */
export async function findWorld(install: ClientInstall, wanted: string): Promise<WorldInfo> {
  const all = await scanWorlds(install, false);
  const byId = all.filter((w) => w.levelId === wanted);
  const matches = byId.length > 0 ? byId : all.filter((w) => w.name === wanted);
  if (matches.length === 0) throw new Error(`no world named or with level id "${wanted}" in ${install.label}; game_worlds lists them`);
  if (matches.length > 1) {
    throw new Error(`${matches.length} worlds are named "${wanted}"; pass the level id of one: ${matches.map((w) => `${w.levelId} (last played ${w.lastPlayed.toISOString()})`).join(", ")}`);
  }
  return matches[0] as WorldInfo;
}

/**
 * One line of a world list: name, folder, mode, last played, size, and what sculkwire may do with it. `devWorld` is
 * the level id of the user's saved dev world.
 */
export function worldLine(w: WorldInfo, loaded?: string, devWorld?: string): string {
  const tags = [
    w.sculkwire ? "sculkwire" : "yours",
    ...(w.levelId === devWorld ? ["your default dev world"] : []),
    ...(w.kept ? ["kept"] : []),
    ...(w.copiedFrom ? [`copy of ${w.copiedFrom}`] : []),
    ...(w.levelId === loaded ? ["loaded"] : []),
  ];
  const size = w.sizeBytes === undefined ? "" : `, ${(w.sizeBytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${w.name} [${w.levelId}] ${w.gameMode ?? "unknown mode"}, last played ${w.lastPlayed.toISOString()}${size} (${tags.join(", ")})`;
}
