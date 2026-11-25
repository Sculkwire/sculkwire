import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TAG, readLevelDat, writeLevelDat, type NbtCompound } from "../../gamefiles/nbt.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { levelDatRoot } from "../client/world.ts";
import { EngineSession, type WorldChange, type WorldState } from "./engine.ts";
import type { EngineResult } from "./failure.ts";
import { getWorldSettings, setWorldSettings } from "./world.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Fixture {
  install: ClientInstall;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sculkwire-world-"));
  dirs.push(root);
  const user = join(root, "Users", "1", "games", "com.mojang");
  mkdirSync(join(user, "minecraftWorlds"), { recursive: true });
  const install: ClientInstall = {
    kind: "wine-prefix",
    label: "test install",
    appData: root,
    sharedComMojang: join(root, "Users", "Shared", "games", "com.mojang"),
    userComMojang: user,
    logsDir: root,
    wine: true,
    preview: false,
  };
  return { install };
}

/** Write a world folder the way `createWorld` does, with an optional change to its level.dat root. */
function world(install: ClientInstall, levelId: string, name: string, patch?: (root: NbtCompound) => void): string {
  const dir = join(install.userComMojang, "minecraftWorlds", levelId);
  mkdirSync(join(dir, "db"), { recursive: true });
  const root = levelDatRoot(name);
  patch?.(root);
  writeFileSync(join(dir, "level.dat"), writeLevelDat({ storageVersion: 10, rootName: "", root }));
  writeFileSync(join(dir, "levelname.txt"), name);
  return dir;
}

/** A session with no agent: port 9 answers nothing. */
function detached(): EngineSession {
  return new EngineSession({ port: 9, timeoutMs: 200 });
}

function state(name: string | null, over: Partial<WorldState> = {}): WorldState {
  return {
    name,
    seed: "1",
    gameType: "creative",
    difficulty: "normal",
    cheats: true,
    education: null,
    experiments: [],
    gamerules: {},
    time: 1000,
    dayCycle: false,
    weather: { rain: false, lightning: false },
    spawn: [0, 64, 0],
    dimension: 0,
    ...over,
  };
}

/** A session that behaves as if an agent were attached and the game answered for `loaded`; `onSet` sees each change. */
function attached(loaded: WorldState, onSet?: (change: WorldChange, world: string) => void): EngineSession {
  const session = new EngineSession({ port: 9, timeoutMs: 200 });
  Object.defineProperty(session, "attached", { get: () => true, configurable: true });
  session.worldGet = async (): Promise<EngineResult<WorldState>> => ({ ok: true, value: loaded });
  session.worldSet = async (change: WorldChange, world: string): Promise<EngineResult<WorldState>> => {
    onSet?.(change, world);
    return { ok: true, value: { ...loaded, ...change, gamerules: { ...loaded.gamerules, ...change.gamerules } } };
  };
  return session;
}

type Named = { levelId: string; name: string };

/** The client's view: the world the bridge entered or attached to, the saved dev world, whether the game runs. */
function view(install: ClientInstall, session: EngineSession, game: { loaded?: Named; dev?: Named; running?: boolean } = {}) {
  return { install, session, loadedWorld: () => game.loaded, devWorld: async () => game.dev, gameRunning: async () => game.running ?? false };
}

const MY_BASE: Named = { levelId: "Xy+z=", name: "My Base" };

describe("world settings from level.dat", () => {
  it("reads any world by level name or level id, and changes nothing", async () => {
    const { install } = await fixture();
    const dir = world(install, "Ab+c=", "Survival");
    const before = readFileSync(join(dir, "level.dat"));
    for (const wanted of ["Survival", "Ab+c="]) {
      const result = await getWorldSettings(wanted, view(install, detached()));
      if (!result.ok) throw new Error(result.message);
      expect(result.value.source).toBe("level.dat");
      expect(result.value.world).toEqual({ name: "Survival", levelId: "Ab+c=", dir });
      expect(result.value.settings).toMatchObject({ name: "Survival", gameType: "creative", difficulty: "normal", cheats: true, time: 6000, weather: null });
      expect(result.value.settings.gamerules).toMatchObject({ dodaylightcycle: false, showcoordinates: true });
    }
    expect(readFileSync(join(dir, "level.dat"))).toEqual(before);
  });

  it("answers for the loaded world, else the saved dev world, else says what to pass", async () => {
    const { install } = await fixture();
    world(install, MY_BASE.levelId, MY_BASE.name);
    world(install, "Ab+c=", "Survival");
    const loaded = await getWorldSettings(undefined, view(install, detached(), { loaded: { levelId: "Ab+c=", name: "Survival" }, dev: MY_BASE }));
    expect(loaded.ok && loaded.value.world.name).toBe("Survival");
    const saved = await getWorldSettings(undefined, view(install, detached(), { dev: MY_BASE }));
    expect(saved.ok && saved.value.world.name).toBe("My Base");
    const neither = await getWorldSettings(undefined, view(install, detached()));
    expect(neither).toMatchObject({ ok: false, message: expect.stringContaining("no default dev world saved") });
  });

  it("changes difficulty, game type, time and game rules in the saved dev world's level.dat", async () => {
    const { install } = await fixture();
    const dir = world(install, MY_BASE.levelId, MY_BASE.name);
    const deps = view(install, detached(), { dev: MY_BASE });
    const change: WorldChange = {
      difficulty: "hard",
      gameType: "survival",
      time: 12000,
      gamerules: { keepinventory: true, randomtickspeed: 5 },
    };
    const result = await setWorldSettings(change, undefined, deps);
    if (!result.ok) throw new Error(result.message);
    expect(result.value.world.dir).toBe(dir);
    expect(result.value.settings).toMatchObject({ difficulty: "hard", gameType: "survival", time: 12000, gamerules: { keepinventory: true, randomtickspeed: 5 } });
    // A fresh read comes from the file, so the change really was written.
    const again = await getWorldSettings("My Base", deps);
    if (!again.ok) throw new Error(again.message);
    expect(again.value.settings).toMatchObject({ difficulty: "hard", gameType: "survival", time: 12000 });
  });
});

describe("weather in level.dat", () => {
  it("writes the rain and lightning levels with a timer that holds them", async () => {
    const { install } = await fixture();
    const dir = world(install, MY_BASE.levelId, MY_BASE.name);
    const deps = view(install, detached(), { dev: MY_BASE });
    const thunder = await setWorldSettings({ weather: { rain: true, lightning: true } }, "My Base", deps);
    if (!thunder.ok) throw new Error(thunder.message);
    expect(thunder.value.settings.weather).toEqual({ rain: true, lightning: true });
    const level = readLevelDat(new Uint8Array(readFileSync(join(dir, "level.dat"))));
    expect(level.root.get("rainLevel")).toEqual({ type: TAG.Float, value: 1 });
    expect(level.root.get("lightningLevel")).toEqual({ type: TAG.Float, value: 1 });
    expect(level.root.get("rainTime")).toEqual({ type: TAG.Int, value: 24_000 * 5 });
    expect(level.root.get("lightningTime")).toEqual({ type: TAG.Int, value: 24_000 * 5 });

    // Rain without thunder drops the lightning level, and clear drops both.
    const rain = await setWorldSettings({ weather: { rain: true, lightning: false } }, undefined, deps);
    if (!rain.ok) throw new Error(rain.message);
    expect(rain.value.settings.weather).toEqual({ rain: true, lightning: false });
    const clear = await setWorldSettings({ weather: { rain: false, lightning: false } }, undefined, deps);
    if (!clear.ok) throw new Error(clear.message);
    expect(clear.value.settings.weather).toEqual({ rain: false, lightning: false });
    const again = await getWorldSettings(undefined, deps);
    if (!again.ok) throw new Error(again.message);
    expect(again.value.settings.weather).toEqual({ rain: false, lightning: false });
  });
});

describe("world settings guards", () => {
  it("without an agent writes no world but the saved dev world", async () => {
    const { install } = await fixture();
    const other = world(install, "Ab+c=", "Survival");
    world(install, MY_BASE.levelId, MY_BASE.name);
    const before = readFileSync(join(other, "level.dat"));
    const named = await setWorldSettings({ difficulty: "hard" }, "Survival", view(install, detached(), { dev: MY_BASE }));
    expect(named).toMatchObject({ ok: false, reason: "invalid_params", message: expect.stringContaining("is not your saved dev world My Base") });
    const unsaved = await setWorldSettings({ difficulty: "hard" }, "Survival", view(install, detached()));
    expect(unsaved).toMatchObject({ ok: false, message: expect.stringContaining("none is saved") });
    expect(readFileSync(join(other, "level.dat"))).toEqual(before);
  });

  it("never rewrites level.dat while the game runs, loaded by sculkwire or not", async () => {
    const { install } = await fixture();
    const dir = world(install, MY_BASE.levelId, MY_BASE.name);
    const before = readFileSync(join(dir, "level.dat"));
    const loaded = await setWorldSettings({ time: 1 }, undefined, view(install, detached(), { dev: MY_BASE, loaded: MY_BASE, running: true }));
    expect(loaded).toMatchObject({ ok: false, message: expect.stringContaining("the game is running") });
    const running = await setWorldSettings({ time: 1 }, undefined, view(install, detached(), { dev: MY_BASE, running: true }));
    expect(running).toMatchObject({ ok: false, message: expect.stringContaining("the game is running") });
    expect(readFileSync(join(dir, "level.dat"))).toEqual(before);
    const closed = await setWorldSettings({ time: 1 }, undefined, view(install, detached(), { dev: MY_BASE }));
    if (!closed.ok) throw new Error(closed.message);
    expect(closed.value.settings.time).toBe(1);
  });

  it("refuses a game rule level.dat does not have", async () => {
    const { install } = await fixture();
    world(install, MY_BASE.levelId, MY_BASE.name);
    const result = await setWorldSettings({ gamerules: { not_a_rule: true } }, undefined, view(install, detached(), { dev: MY_BASE }));
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("level.dat has no game rule not_a_rule") });
  });
});

describe("world settings through an agent", () => {
  it("changes the world sculkwire entered or attached to, naming it to the agent", async () => {
    const { install } = await fixture();
    const seen: [WorldChange, string][] = [];
    const session = attached(state("Echo Lab"), (change, name) => seen.push([change, name]));
    const result = await setWorldSettings({ difficulty: "peaceful", gamerules: { pvp: false } }, undefined, view(install, session, { loaded: { levelId: "Ab+c=", name: "Echo Lab" } }));
    if (!result.ok) throw new Error(result.message);
    expect(result.value).toMatchObject({ source: "engine", world: { name: "Echo Lab" }, settings: { difficulty: "peaceful" } });
    expect(seen).toEqual([[{ difficulty: "peaceful", gamerules: { pvp: false } }, "Echo Lab"]]);
  });

  it("changes the saved dev world when the game has it open", async () => {
    const { install } = await fixture();
    const seen: string[] = [];
    const session = attached(state("My Base"), (_change, name) => seen.push(name));
    const result = await setWorldSettings({ time: 1000 }, "Xy+z=", view(install, session, { dev: MY_BASE }));
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["My Base"]);
  });

  it("refuses any other loaded world, and a world argument naming another, without asking the agent", async () => {
    const { install } = await fixture();
    const seen: WorldChange[] = [];
    const other = attached(state("Survival"), (change) => seen.push(change));
    const refused = await setWorldSettings({ difficulty: "hard" }, undefined, view(install, other, { dev: MY_BASE }));
    expect(refused).toMatchObject({ ok: false, reason: "invalid_params", message: expect.stringContaining('the loaded world is "Survival"') });
    expect(await setWorldSettings({ difficulty: "hard" }, undefined, view(install, other))).toMatchObject({ ok: false, message: expect.stringContaining("none (no world entered") });
    const entered = attached(state("Echo Lab"), (change) => seen.push(change));
    const mismatch = await setWorldSettings({ difficulty: "hard" }, "My Base", view(install, entered, { loaded: { levelId: "Ab+c=", name: "Echo Lab" }, dev: MY_BASE }));
    expect(mismatch).toMatchObject({ ok: false, message: expect.stringContaining('is not the loaded world "Echo Lab"') });
    expect(seen).toEqual([]);
  });
});
