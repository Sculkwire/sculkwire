import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TAG, readLevelDat, writeLevelDat, type NbtCompound } from "../../gamefiles/nbt.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { bridge } from "../client/bridge.ts";
import { levelDatRoot } from "../client/world.ts";
import { EngineSession, type EngineResult, type WorldChange, type WorldState } from "./engine.ts";
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
    passesArgs: false,
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

/** A session that behaves as if an agent were attached and the game answered for `loaded`. */
function attached(loaded: WorldState, onSet?: (change: WorldChange) => void): EngineSession {
  const session = new EngineSession({ port: 9, timeoutMs: 200 });
  Object.defineProperty(session, "attached", { get: () => true, configurable: true });
  session.worldGet = async (): Promise<EngineResult<WorldState>> => ({ ok: true, value: loaded });
  session.worldSet = async (change: WorldChange): Promise<EngineResult<WorldState>> => {
    onSet?.(change);
    return { ok: true, value: { ...loaded, ...change, gamerules: { ...loaded.gamerules, ...change.gamerules } } };
  };
  return session;
}

const none = () => undefined;

describe("world settings from level.dat", () => {
  it("reads a sculkwire world's own data", async () => {
    const { install } = await fixture();
    const dir = world(install, "sculkwire-bridge", "sculkwire-bridge");
    const result = await getWorldSettings("bridge", { install, session: detached(), loaded: none });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.source).toBe("level.dat");
    expect(result.value.world).toEqual({ name: "sculkwire-bridge", levelId: "sculkwire-bridge", dir });
    expect(result.value.settings).toMatchObject({
      name: "sculkwire-bridge",
      gameType: "creative",
      difficulty: "normal",
      cheats: true,
      time: 6000,
      dayCycle: false,
      spawn: [0, 32767, 0],
      experiments: [],
      education: null,
      weather: null,
      dimension: null,
    });
    expect(result.value.settings.seed).toMatch(/^\d+$/);
    expect(result.value.settings.gamerules).toMatchObject({
      dodaylightcycle: false,
      doweathercycle: false,
      domobspawning: false,
      commandblockoutput: false,
      sendcommandfeedback: true,
      showcoordinates: true,
    });
  });

  it("answers for the world played last when none is named or loaded", async () => {
    const { install } = await fixture();
    world(install, "sculkwire-old", "sculkwire-old", (root) => root.set("LastPlayed", { type: TAG.Long, value: 1n }));
    world(install, "sculkwire-bridge", "sculkwire-bridge");
    const result = await getWorldSettings(undefined, { install, session: detached(), loaded: none });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.world.name).toBe("sculkwire-bridge");
  });

  it("changes difficulty, game type, time and game rules and writes level.dat", async () => {
    const { install } = await fixture();
    const dir = world(install, "sculkwire-bridge", "sculkwire-bridge");
    const deps = { install, session: detached(), loaded: none };
    const change: WorldChange = {
      difficulty: "hard",
      gameType: "survival",
      time: 12000,
      gamerules: { keepinventory: true, randomtickspeed: 5 },
    };
    const result = await setWorldSettings(change, "bridge", deps);
    if (!result.ok) throw new Error(result.message);
    expect(result.value.world.dir).toBe(dir);
    expect(result.value.settings).toMatchObject({
      difficulty: "hard",
      gameType: "survival",
      time: 12000,
      gamerules: { keepinventory: true, randomtickspeed: 5 },
    });
    // A fresh read comes from the file, so the change really was written.
    const again = await getWorldSettings("bridge", deps);
    if (!again.ok) throw new Error(again.message);
    expect(again.value.settings).toMatchObject({ difficulty: "hard", gameType: "survival", time: 12000 });
  });
});

describe("weather in level.dat", () => {
  it("writes the rain and lightning levels with a timer that holds them", async () => {
    const { install } = await fixture();
    const dir = world(install, "sculkwire-bridge", "sculkwire-bridge");
    const deps = { install, session: detached(), loaded: none };
    const thunder = await setWorldSettings({ weather: { rain: true, lightning: true } }, "bridge", deps);
    if (!thunder.ok) throw new Error(thunder.message);
    expect(thunder.value.settings.weather).toEqual({ rain: true, lightning: true });
    const level = readLevelDat(new Uint8Array(readFileSync(join(dir, "level.dat"))));
    expect(level.root.get("rainLevel")).toEqual({ type: TAG.Float, value: 1 });
    expect(level.root.get("lightningLevel")).toEqual({ type: TAG.Float, value: 1 });
    expect(level.root.get("rainTime")).toEqual({ type: TAG.Int, value: 24_000 * 5 });
    expect(level.root.get("lightningTime")).toEqual({ type: TAG.Int, value: 24_000 * 5 });

    // Rain without thunder drops the lightning level, and clear drops both.
    const rain = await setWorldSettings({ weather: { rain: true, lightning: false } }, "bridge", deps);
    if (!rain.ok) throw new Error(rain.message);
    expect(rain.value.settings.weather).toEqual({ rain: true, lightning: false });
    const clear = await setWorldSettings({ weather: { rain: false, lightning: false } }, "bridge", deps);
    if (!clear.ok) throw new Error(clear.message);
    expect(clear.value.settings.weather).toEqual({ rain: false, lightning: false });
    const again = await getWorldSettings("bridge", deps);
    if (!again.ok) throw new Error(again.message);
    expect(again.value.settings.weather).toEqual({ rain: false, lightning: false });
  });
});

describe("world settings guards", () => {
  it("refuses a world that is not a sculkwire-* test world", async () => {
    const { install } = await fixture();
    world(install, "sculkwire-x", "MyWorld");
    const result = await setWorldSettings(
      { difficulty: "hard" },
      undefined,
      { install, session: detached(), loaded: () => ({ levelId: "sculkwire-x", name: "MyWorld" }) },
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid_params", message: expect.stringContaining("only sculkwire-* worlds are changed") });
  });

  it("refuses to rewrite a world the running game has loaded", async () => {
    const { install } = await fixture();
    world(install, "sculkwire-bridge", "sculkwire-bridge");
    const result = await setWorldSettings(
      { time: 1 },
      undefined,
      { install, session: detached(), loaded: () => ({ levelId: "sculkwire-bridge", name: "sculkwire-bridge" }) },
    );
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("is loaded by the running game") });
  });

  it("refuses a game rule level.dat does not have", async () => {
    const { install } = await fixture();
    world(install, "sculkwire-bridge", "sculkwire-bridge");
    const result = await setWorldSettings({ gamerules: { not_a_rule: true } }, "bridge", { install, session: detached(), loaded: none });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("level.dat has no game rule not_a_rule") });
  });

  it("rewrites level.dat once the bridge's game process exited, and refuses while it runs", async () => {
    const { install } = await fixture();
    const dir = world(install, "sculkwire-bridge", "sculkwire-bridge");
    const launch = { mode: "desktop" as const, startedAt: 0, pid: 0, argv: [], launchLog: "", notes: [] };
    bridge.world = { levelId: "sculkwire-bridge", name: "sculkwire-bridge", dir };
    try {
      // The default `loaded` is the bridge's: a live game process holds the world.
      bridge.launchState = { ...launch, gamePid: process.pid };
      const refused = await setWorldSettings({ time: 1 }, undefined, { install, session: detached() });
      expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("is loaded by the running game") });
      // A crashed game left its launch state behind: the world is free again.
      bridge.launchState = { ...launch, gamePid: spawnSync(process.execPath, ["-e", ""]).pid };
      const changed = await setWorldSettings({ time: 1 }, undefined, { install, session: detached() });
      if (!changed.ok) throw new Error(changed.message);
      expect(changed.value.settings.time).toBe(1);
    } finally {
      bridge.launchState = undefined;
      bridge.world = undefined;
    }
  });
});

describe("world settings through an agent", () => {
  it("changes the loaded world when its name carries the test prefix", async () => {
    const { install } = await fixture();
    const seen: WorldChange[] = [];
    const session = attached(state("sculkwire-bridge"), (change) => seen.push(change));
    const result = await setWorldSettings({ difficulty: "peaceful", gamerules: { pvp: false } }, undefined, { install, session, loaded: none });
    if (!result.ok) throw new Error(result.message);
    expect(result.value).toMatchObject({ source: "engine", world: { name: "sculkwire-bridge" }, settings: { difficulty: "peaceful" } });
    expect(seen).toEqual([{ difficulty: "peaceful", gamerules: { pvp: false } }]);
  });

  it("refuses a loaded world that is not a test world, without asking the engine to change it", async () => {
    const { install } = await fixture();
    const seen: WorldChange[] = [];
    const session = attached(state("MyWorld"), (change) => seen.push(change));
    const result = await setWorldSettings({ difficulty: "hard" }, undefined, { install, session, loaded: none });
    expect(result).toMatchObject({ ok: false, reason: "invalid_params", message: expect.stringContaining("only sculkwire-* worlds are changed") });
    expect(seen).toEqual([]);
  });
});
