/**
 * World settings: live through the agent when it is attached, else the `level.dat` of a world no game has loaded.
 *
 * Weather is in level.dat too (`rainLevel`/`rainTime`, `lightningLevel`/`lightningTime`), so a file edit can set it
 * for a world no game has loaded.
 *
 * Changes are only ever made in the world the user chose or opened (the live-game rule: never touch the user's other
 * worlds). Live: the loaded world must be the one sculkwire entered or attached to, or the user's saved dev world; the
 * host checks its name and passes it to the agent, which refuses any other loaded world on its own. A file edit only
 * ever writes the saved dev world, and only while the game does not run (it would overwrite the file and keep its own
 * value). A change stays in the world: it is the user's, so set back what a test changed.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../core/fs.ts";
import { findInstall, type ClientInstall } from "../../gamefiles/install.ts";
import { readLevelDat, tagNumber, writeLevelDat, TAG, type LevelDat, type NbtTag } from "../../gamefiles/nbt.ts";
import { DIFFICULTIES, GAME_TYPES, GAMERULES, difficultyOf, gameTypeOf } from "../../gamefiles/worlds.ts";
import type { ScriptRoute } from "./deps.ts";
import { engine, type EngineSession, type WorldChange, type WorldState } from "./engine.ts";
import { invalid, type EngineFailure, type EngineResult } from "./failure.ts";

/** Where an answer came from: the running level, or the file the game reads at its next launch. */
export type WorldSource = "engine" | "level.dat";

export interface WorldView {
  source: WorldSource;
  /** The world the answer describes; the folder only for a `level.dat` read. */
  world: { name: string; levelId?: string; dir?: string };
  settings: WorldState;
}

/**
 * What the tools and the tests hand in: the client's view of the game (`loadedWorld`, the saved `devWorld`,
 * `gameRunning`; the `ScriptRoute` itself in the tools). `session` and `install` default to the real thing.
 */
export interface WorldDeps extends Pick<ScriptRoute, "loadedWorld" | "devWorld" | "gameRunning"> {
  session?: EngineSession;
  install?: ClientInstall;
}

/** How long a weather change set in level.dat holds: five in-game days, well past a test session. */
const WEATHER_HOLD_TICKS = 24_000 * 5;

function tagBool(tag: NbtTag | undefined): boolean | undefined {
  const n = tagNumber(tag);
  return n === undefined ? undefined : n !== 0;
}

/** The experiment names a level was saved with (the bookkeeping keys are not experiments). */
function experimentIds(level: LevelDat): string[] {
  const tag = level.root.get("experiments");
  if (!tag || tag.type !== TAG.Compound || !(tag.value instanceof Map)) return [];
  const out: string[] = [];
  for (const [name, value] of tag.value) {
    if (name === "experiments_ever_used" || name === "saved_with_toggled_experiments") continue;
    if (tagNumber(value) === 1) out.push(name);
  }
  return out.sort();
}

/** What one `level.dat` says, in the shape `world.settings` reports. */
export function stateFromLevel(level: LevelDat): WorldState {
  const root = level.root;
  const gamerules: Record<string, boolean | number> = {};
  for (const [name, kind] of Object.entries(GAMERULES)) {
    const n = tagNumber(root.get(name));
    if (n === undefined) continue;
    gamerules[name] = kind === "bool" ? n !== 0 : n;
  }
  const levelName = root.get("LevelName");
  const rainLevel = tagNumber(root.get("rainLevel"));
  const lightningLevel = tagNumber(root.get("lightningLevel"));
  const spawnX = tagNumber(root.get("SpawnX"));
  const spawnY = tagNumber(root.get("SpawnY"));
  const spawnZ = tagNumber(root.get("SpawnZ"));
  const seed = tagNumber(root.get("RandomSeed"));
  return {
    name: typeof levelName?.value === "string" ? levelName.value : null,
    seed: seed === undefined ? null : String(seed),
    gameType: gameTypeOf(tagNumber(root.get("GameType"))) ?? null,
    difficulty: difficultyOf(tagNumber(root.get("Difficulty"))) ?? null,
    cheats: tagBool(root.get("commandsEnabled")) ?? tagBool(root.get("cheatsEnabled")) ?? null,
    // Education edition and the dimension are not stored in level.dat; the game reports them, the file cannot.
    education: null,
    experiments: experimentIds(level),
    gamerules,
    time: tagNumber(root.get("Time")) ?? null,
    dayCycle: tagBool(root.get("dodaylightcycle")) ?? null,
    // The game writes both levels together; one that is absent means that weather is not active.
    weather: rainLevel === undefined && lightningLevel === undefined ? null : { rain: (rainLevel ?? 0) > 0, lightning: (lightningLevel ?? 0) > 0 },
    spawn: spawnX !== undefined && spawnY !== undefined && spawnZ !== undefined ? [spawnX, spawnY, spawnZ] : null,
    dimension: null,
  };
}

/** Apply `change` to a level.dat root, the way the game would. Returns why it cannot, or undefined when it did. */
export function applyToLevel(level: LevelDat, change: WorldChange): string | undefined {
  const root = level.root;
  if (change.weather !== undefined) {
    const { rain, lightning } = change.weather;
    // Levels are floats (0 or 1) and the timers hold the change; a clear sky is level 0 with a timer as well.
    root.set("rainLevel", { type: TAG.Float, value: rain || lightning ? 1 : 0 });
    root.set("lightningLevel", { type: TAG.Float, value: lightning ? 1 : 0 });
    root.set("rainTime", { type: TAG.Int, value: WEATHER_HOLD_TICKS });
    root.set("lightningTime", { type: TAG.Int, value: WEATHER_HOLD_TICKS });
  }
  if (change.difficulty !== undefined) {
    const index = DIFFICULTIES[change.difficulty];
    if (index === undefined) return `difficulty must be one of ${Object.keys(DIFFICULTIES).join(", ")}`;
    root.set("Difficulty", { type: TAG.Int, value: index });
  }
  if (change.gameType !== undefined) {
    const index = (GAME_TYPES as readonly string[]).indexOf(change.gameType);
    if (index < 0) return `gameType must be one of ${GAME_TYPES.join(", ")}`;
    root.set("GameType", { type: TAG.Int, value: index });
  }
  if (change.time !== undefined) {
    if (!Number.isInteger(change.time) || change.time < 0 || change.time > 24000) return "time must be whole ticks from 0 to 24000";
    root.set("Time", { type: TAG.Long, value: BigInt(change.time) });
  }
  for (const [name, value] of Object.entries(change.gamerules ?? {})) {
    const kind = GAMERULES[name];
    if (kind === undefined) return `level.dat has no game rule ${name}`;
    if (kind === "bool") {
      if (typeof value !== "boolean") return `game rule ${name} is a switch: give true or false`;
      root.set(name, { type: TAG.Byte, value: value ? 1 : 0 });
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value)) return `game rule ${name} is a whole number`;
    root.set(name, { type: TAG.Int, value });
  }
  return undefined;
}

interface WorldOnDisk {
  levelId: string;
  dir: string;
  level: LevelDat;
}

/** Every world folder of the install whose `level.dat` can be read (the user's own included: the caller refuses them). */
async function worldsOnDisk(install: ClientInstall): Promise<WorldOnDisk[]> {
  const base = join(install.userComMojang, "minecraftWorlds");
  let ids: string[];
  try {
    ids = await readdir(base);
  } catch {
    return [];
  }
  const out: WorldOnDisk[] = [];
  for (const levelId of ids) {
    const dir = join(base, levelId);
    const file = join(dir, "level.dat");
    if (!existsSync(file)) continue;
    try {
      out.push({ levelId, dir, level: readLevelDat(new Uint8Array(await readFile(file))) });
    } catch {
      // A damaged level.dat is not a world this tool can answer for.
    }
  }
  return out;
}

/** The one world whose level id, else whose level name, is `wanted`. */
function findOnDisk(worlds: readonly WorldOnDisk[], wanted: string, install: ClientInstall): WorldOnDisk | EngineFailure {
  const byId = worlds.filter((w) => w.levelId === wanted);
  const matches = byId.length ? byId : worlds.filter((w) => stateFromLevel(w.level).name === wanted);
  if (matches.length === 1) return matches[0] as WorldOnDisk;
  if (matches.length === 0) return invalid(`no world named or with level id "${wanted}" in ${install.label}; game_worlds lists them`);
  return invalid(`${matches.length} worlds are named "${wanted}"; pass the level id of one: ${matches.map((w) => w.levelId).join(", ")}`);
}

/**
 * The world a file read means: the named one (level name or level id), else the game's loaded one, else the user's
 * saved dev world.
 */
async function pickWorld(install: ClientInstall, name: string | undefined, deps: WorldDeps): Promise<WorldOnDisk | EngineFailure> {
  const worlds = await worldsOnDisk(install);
  if (name) return findOnDisk(worlds, name, install);
  const loaded = deps.loadedWorld();
  const loadedHit = loaded && worlds.find((w) => w.levelId === loaded.levelId);
  if (loadedHit) return loadedHit;
  const saved = await deps.devWorld();
  if (!saved) return invalid(`no world given, none loaded and no default dev world saved for ${install.label}: pass world, or save one with game_worlds action use`);
  return findOnDisk(worlds, saved.levelId, install);
}

/**
 * The settings of a world: the running level's when an agent is attached, else `level.dat`. `name` selects a world
 * for the file read; the live read always answers for the loaded one. Reading changes nothing.
 */
export async function getWorldSettings(name: string | undefined, deps: WorldDeps): Promise<EngineResult<WorldView>> {
  const session = deps.session ?? engine;
  if (await session.reachable()) {
    const result = await session.worldGet();
    if (!result.ok) return result;
    return { ok: true, value: { source: "engine", world: { name: result.value.name ?? "" }, settings: result.value } };
  }
  const install = deps.install ?? (await findInstall());
  const picked = await pickWorld(install, name, deps);
  if ("ok" in picked) return picked;
  const settings = stateFromLevel(picked.level);
  return {
    ok: true,
    value: { source: "level.dat", world: { name: settings.name ?? picked.levelId, levelId: picked.levelId, dir: picked.dir }, settings },
  };
}

/**
 * Change the world the user chose or opened. Through an agent the game applies it, in the loaded world only when it is
 * the one sculkwire entered or attached to or the saved dev world; otherwise `level.dat` of the saved dev world is
 * rewritten, only while the game does not run.
 */
export async function setWorldSettings(change: WorldChange, name: string | undefined, deps: WorldDeps): Promise<EngineResult<WorldView>> {
  const session = deps.session ?? engine;
  const saved = await deps.devWorld();
  if (await session.reachable()) {
    const current = await session.worldGet();
    if (!current.ok) return current;
    const loadedName = current.value.name;
    const allowed = [deps.loadedWorld()?.name, saved?.name].filter((n) => n !== undefined);
    if (loadedName === null || !allowed.includes(loadedName)) {
      const which = allowed.length ? allowed.map((n) => `"${n}"`).join(" or ") : "none (no world entered or attached, no default dev world saved)";
      return invalid(
        `the loaded world is ${loadedName === null ? "not named by the engine" : `"${loadedName}"`}; world_settings changes only the world ` +
          `sculkwire entered or attached to, or your saved dev world: ${which}`,
      );
    }
    const loadedIds = [loadedName, deps.loadedWorld()?.levelId, ...(saved && saved.name === loadedName ? [saved.levelId] : [])];
    if (name !== undefined && !loadedIds.includes(name)) {
      return invalid(`world "${name}" is not the loaded world "${loadedName}"; through the agent only the loaded world is changed`);
    }
    const result = await session.worldSet(change, loadedName);
    return result.ok ? { ok: true, value: { source: "engine", world: { name: loadedName }, settings: result.value } } : result;
  }
  const install = deps.install ?? (await findInstall());
  if (!saved) return invalid("without an attached agent world_settings changes only your saved dev world's level.dat, and none is saved: game_worlds action use");
  const picked = findOnDisk(await worldsOnDisk(install), saved.levelId, install);
  if ("ok" in picked) return picked;
  const levelName = stateFromLevel(picked.level).name ?? saved.name;
  if (name !== undefined && name !== picked.levelId && name !== levelName) {
    return invalid(`"${name}" is not your saved dev world ${saved.name} [${saved.levelId}]: without an attached agent only that world's level.dat is changed`);
  }
  if (deps.loadedWorld() !== undefined || (await deps.gameRunning())) {
    return invalid(`the game is running: attach the agent (engine_attach) to change ${levelName} live, or stop the game first`);
  }
  const error = applyToLevel(picked.level, change);
  if (error) return invalid(error);
  await writeFileAtomic(join(picked.dir, "level.dat"), writeLevelDat(picked.level));
  return {
    ok: true,
    value: {
      source: "level.dat",
      world: { name: levelName, levelId: picked.levelId, dir: picked.dir },
      settings: stateFromLevel(picked.level),
    },
  };
}
