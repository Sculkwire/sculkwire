/**
 * World settings of a test world: live through the agent when it is attached, else the `level.dat` of a `sculkwire-*`
 * world that no game has loaded.
 *
 * Weather is in level.dat too (`rainLevel`/`rainTime`, `lightningLevel`/`lightningTime`), so a file edit can set it
 * for a world no game has loaded.
 *
 * Changes are only ever made in worlds named `sculkwire-*` (the live-game rule: never touch the user's own worlds).
 * The agent refuses on its own; here the loaded level's name and, for a file edit, both the level name and the folder
 * are checked first. World changes need no restore, because a test world is disposable: it is created by `game_launch`
 * and replaced by the next launch.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readLevelDat, writeLevelDat, TAG, type LevelDat, type NbtTag } from "../../gamefiles/nbt.ts";
import { bridge } from "../client/bridge.ts";
import { findInstall, type ClientInstall } from "../../gamefiles/install.ts";
import { DIFFICULTIES, WORLD_PREFIX, worldName } from "../../gamefiles/worlds.ts";
import {
  GAME_TYPES,
  difficultyOf,
  engine,
  gameTypeOf,
  type EngineFailure,
  type EngineResult,
  type EngineSession,
  type WorldChange,
  type WorldState,
} from "./engine.ts";

/** Where an answer came from: the running level, or the file the game reads at its next launch. */
export type WorldSource = "engine" | "level.dat";

export interface WorldView {
  source: WorldSource;
  /** The world the answer describes; the folder only for a `level.dat` read. */
  world: { name: string; levelId?: string; dir?: string };
  settings: WorldState;
}

/** What the tools and the tests hand in; everything defaults to the real thing. */
export interface WorldDeps {
  session?: EngineSession;
  install?: ClientInstall;
  /** The world the running game has loaded, or undefined when none runs. Defaults to the bridge's. */
  loaded?: () => { levelId: string; name: string } | undefined;
}

/**
 * Game rules as `level.dat` stores them: the key of the same name, a byte for a switch and an int for a number.
 * Reading reports only these names, so a stray level.dat field is never mistaken for a rule.
 */
const GAMERULES: Record<string, "bool" | "int"> = {
  commandblockoutput: "bool",
  commandblocksenabled: "bool",
  dodaylightcycle: "bool",
  doentitydrops: "bool",
  dofiretick: "bool",
  doimmediaterespawn: "bool",
  doinsomnia: "bool",
  domobloot: "bool",
  domobspawning: "bool",
  dotiledrops: "bool",
  doweathercycle: "bool",
  drowningdamage: "bool",
  falldamage: "bool",
  firedamage: "bool",
  freezedamage: "bool",
  keepinventory: "bool",
  mobgriefing: "bool",
  naturalregeneration: "bool",
  pvp: "bool",
  respawnblocksexplode: "bool",
  sendcommandfeedback: "bool",
  showcoordinates: "bool",
  showdeathmessages: "bool",
  showtags: "bool",
  tntexplodes: "bool",
  maxcommandchainlength: "int",
  randomtickspeed: "int",
  playerssleepingpercentage: "int",
};

/** How long a weather change set in level.dat holds: five in-game days, well past a test session. */
const WEATHER_HOLD_TICKS = 24_000 * 5;

function refusal(message: string): EngineFailure {
  return { ok: false, code: -32602, reason: "invalid_params", message };
}

/** The bridge's loaded world, when a game runs. */
function bridgeLoaded(): { levelId: string; name: string } | undefined {
  const world = bridge.world;
  return bridge.running && world ? { levelId: world.levelId, name: world.name } : undefined;
}

function tagNumber(tag: NbtTag | undefined): number | undefined {
  if (!tag) return undefined;
  if (typeof tag.value === "number") return tag.value;
  if (typeof tag.value === "bigint") return Number(tag.value);
  return undefined;
}

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

/**
 * The world a file read or edit means: the named one, else the game's loaded one, else the newest `sculkwire-*` world.
 * A name is prefixed with `sculkwire-` like every other world name sculkwire takes.
 */
async function pickWorld(install: ClientInstall, name: string | undefined, deps: WorldDeps): Promise<WorldOnDisk | EngineFailure> {
  const worlds = await worldsOnDisk(install);
  if (worlds.length === 0) {
    return refusal(`no world folder with a level.dat in ${join(install.userComMojang, "minecraftWorlds")}; game_launch creates one`);
  }
  if (name) {
    const wanted = worldName(name);
    const hit = worlds.find((w) => (stateFromLevel(w.level).name ?? "") === wanted);
    if (!hit) return refusal(`no world named ${wanted} in ${install.label}`);
    return hit;
  }
  const loaded = (deps.loaded ?? bridgeLoaded)();
  if (loaded) {
    const hit = worlds.find((w) => w.levelId === loaded.levelId);
    if (hit) return hit;
  }
  const test = worlds.filter((w) => (stateFromLevel(w.level).name ?? "").startsWith(WORLD_PREFIX));
  if (test.length === 0) return refusal(`no ${WORLD_PREFIX}* world in ${install.label}; game_launch creates one`);
  // The world played last is the one the bridge most likely means.
  const [newest] = test.sort((a, b) => (tagNumber(b.level.root.get("LastPlayed")) ?? 0) - (tagNumber(a.level.root.get("LastPlayed")) ?? 0));
  return newest ?? refusal(`no ${WORLD_PREFIX}* world in ${install.label}; game_launch creates one`);
}

/**
 * The settings of a test world: the running level's when an agent is attached, else `level.dat`.
 * `name` selects a world for the file read; the live read always answers for the loaded one.
 */
export async function getWorldSettings(name?: string, deps: WorldDeps = {}): Promise<EngineResult<WorldView>> {
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
 * Change a test world. Through an agent the game applies it; otherwise `level.dat` is rewritten, and only for a
 * `sculkwire-*` world that is not loaded (the running game would overwrite the file and keep its own value).
 */
export async function setWorldSettings(change: WorldChange, name?: string, deps: WorldDeps = {}): Promise<EngineResult<WorldView>> {
  const session = deps.session ?? engine;
  if (await session.reachable()) {
    const current = await session.worldGet();
    if (!current.ok) return current;
    const loadedName = current.value.name;
    if (loadedName === null || !loadedName.startsWith(WORLD_PREFIX)) {
      return refusal(
        `the loaded world is ${loadedName === null ? "not named by the engine" : loadedName}, and only ${WORLD_PREFIX}* worlds are changed`,
      );
    }
    const result = await session.worldSet(change);
    return result.ok ? { ok: true, value: { source: "engine", world: { name: loadedName }, settings: result.value } } : result;
  }
  const install = deps.install ?? (await findInstall());
  const picked = await pickWorld(install, name, deps);
  if ("ok" in picked) return picked;
  const levelName = stateFromLevel(picked.level).name;
  if (!picked.levelId.startsWith(WORLD_PREFIX) || levelName === null || !levelName.startsWith(WORLD_PREFIX)) {
    return refusal(`${picked.dir} holds ${levelName ?? "an unnamed world"}, and only ${WORLD_PREFIX}* worlds are changed`);
  }
  const loaded = (deps.loaded ?? bridgeLoaded)();
  if (loaded && loaded.levelId === picked.levelId) {
    return refusal(`${levelName} is loaded by the running game: attach the agent to change it live, or stop the game first`);
  }
  const error = applyToLevel(picked.level, change);
  if (error) return refusal(error);
  const file = join(picked.dir, "level.dat");
  const staging = `${file}.sculkwire-tmp`;
  await writeFile(staging, writeLevelDat(picked.level));
  await rename(staging, file);
  return {
    ok: true,
    value: {
      source: "level.dat",
      world: { name: levelName, levelId: picked.levelId, dir: picked.dir },
      settings: stateFromLevel(picked.level),
    },
  };
}
