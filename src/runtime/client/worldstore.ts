/**
 * The worlds of the active user and the life of sculkwire's test worlds: the kept marker, removal of stale ones,
 * deletion of one, and a test world copied from one of the user's worlds.
 *
 * Only a folder whose name AND level name both start with `sculkwire-` is ever written or deleted (the live-game rule:
 * never touch the user's own worlds). A user's world is only read, to copy it, and only when the user picked it.
 */
import { cp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exists, readJsonOr, writeJsonAtomic } from "../../core/fs.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { readLevelDat, tagNumber, TAG, writeLevelDat, type LevelDat } from "../../gamefiles/nbt.ts";
import { gameTypeOf, levelIdFor, setCheats, setSinglePlayer, WORLD_PREFIX, worldName, type GameType } from "../../gamefiles/worlds.ts";
import { ICON_FILE, worldIcon } from "./icon.ts";

/** A test world not played for this many days is removed by the next launch, unless it is kept. */
export const STALE_WORLD_DAYS = 3;
/** The largest world `copyWorld` copies. */
export const COPY_LIMIT_BYTES = 4 * 1024 ** 3;
/** The kept marker in a test world's folder. */
export const WORLD_MARKER = "sculkwire-world.json";

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
  /** Both the folder and the level name start with `sculkwire-`: the only worlds sculkwire writes or deletes. */
  sculkwire: boolean;
  /** A test world with the kept marker: never removed automatically. */
  kept: boolean;
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

/** Every world in the active user's minecraftWorlds, played last first, with its size. */
export function listAllWorlds(install: ClientInstall): Promise<WorldInfo[]> {
  return scanWorlds(install, true);
}

/** The test world in folder `levelId`, or undefined when there is none (or the folder holds another world). */
export async function testWorldAt(install: ClientInstall, levelId: string): Promise<WorldInfo | undefined> {
  const world = await readWorld(worldsDir(install), levelId, false);
  return world?.sculkwire ? world : undefined;
}

/** The kept marker of a test world folder, or undefined. */
export async function readMarker(dir: string): Promise<WorldMarker | undefined> {
  const marker = await readJsonOr<Partial<WorldMarker>>(join(dir, WORLD_MARKER));
  if (!marker || typeof marker !== "object") return undefined;
  return { keep: marker.keep === true, ...(typeof marker.copiedFrom === "string" ? { copiedFrom: marker.copiedFrom } : {}) };
}

export async function writeMarker(world: { levelId: string; dir: string }, marker: WorldMarker): Promise<void> {
  if (!world.levelId.startsWith(WORLD_PREFIX)) throw new WorldRefused(`refusing to write into world folder ${world.levelId}`);
  await writeJsonAtomic(join(world.dir, WORLD_MARKER), marker);
}

/**
 * Write sculkwire's icon into a `sculkwire-` world (createWorld does). The game replaces `world_icon.jpeg` with a
 * picture of the world when it saves and quits it, so the join recovery writes the icon again before it looks for it.
 */
export async function writeWorldIcon(world: { levelId: string; dir: string }): Promise<void> {
  if (!world.levelId.startsWith(WORLD_PREFIX)) throw new Error(`refusing to write into world folder ${world.levelId}`);
  await writeFile(join(world.dir, ICON_FILE), worldIcon(world.levelId));
}

/** Delete one listed world, after checking once more that both its folder and its level name are sculkwire's. */
async function removeTestWorld(world: WorldInfo): Promise<void> {
  if (!isTestWorld(world.levelId, world.name)) {
    throw new WorldRefused(`${world.name} (folder ${world.levelId}) is not a ${WORLD_PREFIX}* world; sculkwire never deletes it`);
  }
  await rm(world.dir, { recursive: true, force: true });
}

export interface PruneOptions {
  /** Level id of the world about to be launched: never removed. */
  except?: string;
  now?: Date;
  maxAgeDays?: number;
}

/** Remove test worlds that are not kept and were last played more than `maxAgeDays` ago. Returns their names. */
export async function pruneWorlds(install: ClientInstall, opts: PruneOptions = {}): Promise<string[]> {
  const cutoff = (opts.now ?? new Date()).getTime() - (opts.maxAgeDays ?? STALE_WORLD_DAYS) * 86_400_000;
  const removed: string[] = [];
  for (const world of await scanWorlds(install, false)) {
    if (!world.sculkwire || world.kept || world.levelId === opts.except || world.lastPlayed.getTime() >= cutoff) continue;
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

const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);

/** Name the copy, and make it a test world: single player, cheats on. Every other tag stays as the source had it. */
async function patchCopiedLevel(file: string, name: string): Promise<void> {
  const level = readLevelDat(new Uint8Array(await readFile(file)));
  level.root.set("LevelName", { type: TAG.String, value: name });
  setSinglePlayer(level.root);
  setCheats(level.root);
  await writeFile(file, writeLevelDat(level));
}

export interface CopyOptions {
  /** Level name or level id of the world to copy (an exact match). */
  from: string;
  /** Name of the copy; `sculkwire-` is added when missing. */
  name: string;
  /** Largest source accepted (default `COPY_LIMIT_BYTES`). */
  limitBytes?: number;
}

/**
 * Copy one of the user's worlds (or a test world) to the test world `sculkwire-<name>`, replacing an older one. The
 * source is only read. The copy gets the new name, single player with cheats on, the icon and the kept marker.
 */
export async function copyWorld(install: ClientInstall, opts: CopyOptions): Promise<{ levelId: string; name: string; dir: string }> {
  const all = await scanWorlds(install, false);
  const byId = all.filter((w) => w.levelId === opts.from);
  const matches = byId.length > 0 ? byId : all.filter((w) => w.name === opts.from);
  if (matches.length === 0) throw new Error(`no world named or with level id "${opts.from}" in ${install.label}; game_worlds lists them`);
  if (matches.length > 1) {
    throw new Error(`${matches.length} worlds are named "${opts.from}"; pass the level id of one: ${matches.map((w) => `${w.levelId} (last played ${w.lastPlayed.toISOString()})`).join(", ")}`);
  }
  const [source] = matches as [WorldInfo];
  const name = worldName(opts.name);
  const levelId = levelIdFor(name);
  if (!levelId.startsWith(WORLD_PREFIX)) throw new WorldRefused(`refusing to write world folder ${levelId}`);
  if (source.levelId === levelId) throw new Error(`${source.name} is ${name} itself; launch it with keep: true to continue in it`);
  const size = await folderSize(source.dir);
  const limit = opts.limitBytes ?? COPY_LIMIT_BYTES;
  if (size > limit) throw new Error(`${source.name} is ${gib(size)} GiB; sculkwire copies worlds up to ${gib(limit)} GiB`);
  const dir = join(worldsDir(install), levelId);
  await rm(dir, { recursive: true, force: true });
  await cp(source.dir, dir, { recursive: true });
  await patchCopiedLevel(join(dir, "level.dat"), name);
  // The game's backup of level.dat would bring the original name and multiplayer back if the game ever fell back to it.
  const backup = join(dir, "level.dat_old");
  if (await exists(backup)) await patchCopiedLevel(backup, name).catch(() => rm(backup, { force: true }));
  await writeFile(join(dir, "levelname.txt"), name);
  const world = { levelId, name, dir };
  await writeWorldIcon(world);
  await writeMarker(world, { keep: true, copiedFrom: source.name });
  return world;
}

/** One line of a world list: name, folder, mode, last played, size, and what sculkwire may do with it. */
export function worldLine(w: WorldInfo, loaded?: string): string {
  const tags = [
    w.sculkwire ? "sculkwire" : "yours, never changed",
    ...(w.kept ? ["kept"] : []),
    ...(w.copiedFrom ? [`copy of ${w.copiedFrom}`] : []),
    ...(w.levelId === loaded ? ["loaded"] : []),
  ];
  const size = w.sizeBytes === undefined ? "" : `, ${(w.sizeBytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${w.name} [${w.levelId}] ${w.gameMode ?? "unknown mode"}, last played ${w.lastPlayed.toISOString()}${size} (${tags.join(", ")})`;
}
