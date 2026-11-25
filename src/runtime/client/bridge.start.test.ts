/**
 * `start` on an install the user starts: the bridge returns at once and keeps waiting for the world in the background.
 * `start` on an install sculkwire launches: `stop` during the wait ends it with "the game stopped".
 * The launcher is replaced so no game process is looked up, started or stopped.
 */
import { createServer, type AddressInfo } from "node:net";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Install from "../../gamefiles/install.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { ClientBridge } from "./bridge.ts";
import type * as ContentLog from "./contentlog.ts";
import { readDebugLogSince } from "./contentlog.ts";
import type * as Launcher from "./launcher.ts";
import type { LaunchState } from "./launcher.ts";
import { readLevelDat, TAG, writeLevelDat, type NbtCompound } from "../../gamefiles/nbt.ts";
import { createWorld, HELPER_PACK_DIR } from "./world.ts";
import { listAllWorlds } from "./worldstore.ts";
import { useDevWorld } from "./devworld.ts";
import { ICON_FILE } from "./icon.ts";

const state: LaunchState = { mode: "desktop", startedAt: 0, pid: 0, argv: [], launchLog: "", notes: ["start Minecraft yourself"] };
let install: ClientInstall;
/** Replaces the launcher's `waitForGame` while set. */
let waitForGame: ((signal?: AbortSignal) => Promise<number>) | undefined;
const stopGame = vi.fn(async () => ({ stopped: true, message: "the game was not running" }));
/** The game processes the launcher finds. */
let runningPids: number[] = [];

vi.mock("../../gamefiles/install.ts", async (original) => ({
  ...(await original<typeof Install>()),
  findInstall: async () => install,
}));
vi.mock("./launcher.ts", async (original) => ({
  ...(await original<typeof Launcher>()),
  launch: async () => ({ ...state }),
  waitForGame: async (_install: unknown, _timeoutMs: number, signal?: AbortSignal) => (waitForGame ? waitForGame(signal) : process.pid),
  readLaunchState: async () => ({ ...state }),
  stop: () => stopGame(),
  gamePids: async () => runningPids,
}));
vi.mock("./contentlog.ts", async (original) => {
  const real = await original<typeof ContentLog>();
  return { ...real, readDebugLogSince: vi.fn(real.readDebugLogSince) };
});

describe("client bridge start", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sw-bridge-start-"));
    process.env.SCULKWIRE_DATA = join(dir, "data");
    process.env.SCULKWIRE_CONFIG = join(dir, "config");
    install = {
      kind: "custom",
      label: "fake",
      appData: dir,
      sharedComMojang: dir,
      userComMojang: dir,
      logsDir: join(dir, "logs"),
      wine: false,
      preview: false,
    } as ClientInstall;
  });

  afterEach(async () => {
    waitForGame = undefined;
    runningPids = [];
    stopGame.mockClear();
    delete process.env.SCULKWIRE_DATA;
    delete process.env.SCULKWIRE_CONFIG;
    await rm(dir, { recursive: true, force: true });
  });

  it("frees the debugger port when the start fails after opening it, so the next launch can take it", async () => {
    const freePort = async (): Promise<number> => {
      const s = createServer();
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      const { port } = s.address() as AddressInfo;
      await new Promise((r) => s.close(r));
      return port;
    };
    const debuggerPort = await freePort();
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
    const connectPort = (taken.address() as AddressInfo).port;
    const bridge = new ClientBridge();
    try {
      await expect(bridge.start({ mode: "desktop", debuggerPort, connectPort })).rejects.toThrow(/EADDRINUSE/);
      const again = createServer();
      await new Promise<void>((resolve, reject) => {
        again.once("error", reject);
        again.listen(debuggerPort, "127.0.0.1", resolve);
      });
      await new Promise((r) => again.close(r));
    } finally {
      await new Promise((r) => taken.close(r));
      await bridge.stop();
    }
  });

  it("ends the background wait for the world when the session stops", async () => {
    const bridge = new ClientBridge();
    const status = await bridge.start({ mode: "desktop", debuggerPort: 0, connectPort: 0 });
    expect(status.ready).toBe(false);
    // The background wait reads the engine log every 500 ms while the world is not up.
    await vi.waitFor(() => expect(vi.mocked(readDebugLogSince)).toHaveBeenCalled());
    await bridge.stop();
    const reads = vi.mocked(readDebugLogSince).mock.calls.length;
    await sleep(1_200);
    expect(vi.mocked(readDebugLogSince).mock.calls.length).toBe(reads);
    expect(bridge.status().manualSteps.filter((m) => m.includes("did not reach the world"))).toEqual([]);
  });

  it("fails a launch that waits for the game with \"the game stopped\" when the session stops, stopping once", async () => {
    install = { ...install, launch: ["launcher", "{uri}"] };
    let waiting!: () => void;
    const entered = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    waitForGame = (signal) =>
      new Promise((_resolve, reject) => {
        waiting();
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const bridge = new ClientBridge();
    const started = bridge.start({ mode: "desktop", debuggerPort: 0, connectPort: 0 });
    const failed = expect(started).rejects.toThrow("client did not reach the world: the game stopped");
    await entered;
    await bridge.stop();
    await failed;
    expect(stopGame).toHaveBeenCalledTimes(1);
  });

  it("removes stale test worlds but not the one it launches, and says a kept world keeps its own settings", async () => {
    const old = await createWorld(install, { name: "old", helper: false });
    const bridgeWorld = await createWorld(install, { name: "bridge", helper: false });
    const longAgo = BigInt(Math.floor(Date.now() / 1000) - 10 * 86_400);
    for (const world of [old, bridgeWorld]) {
      const level = readLevelDat(new Uint8Array(await readFile(join(world.dir, "level.dat"))));
      level.root.set("LastPlayed", { type: TAG.Long, value: longAgo });
      await writeFile(join(world.dir, "level.dat"), writeLevelDat(level));
    }
    const bridge = new ClientBridge();
    const status = await bridge.start({ mode: "desktop", debuggerPort: 0, connectPort: 0, keep: true, difficulty: "hard" });
    await bridge.stop();
    expect(status.prunedWorlds).toEqual(["sculkwire-old"]);
    expect(status.worldNote).toBe("sculkwire-bridge was entered as it is and keeps its own difficulty and experiments: difficulty hard not applied");
    expect((await listAllWorlds(install)).map((w) => w.name)).toEqual(["sculkwire-bridge"]);
  });

  /** One of the user's own worlds, cheats off, with a foreign pack and its own icon; saved as the dev world. */
  async function savedUserWorld(): Promise<string> {
    const world = join(install.userComMojang, "minecraftWorlds", "Xy+z=");
    await mkdir(join(world, "db"), { recursive: true });
    const root: NbtCompound = new Map();
    root.set("LevelName", { type: TAG.String, value: "Steve's Base" });
    root.set("cheatsEnabled", { type: TAG.Byte, value: 0 });
    root.set("commandsEnabled", { type: TAG.Byte, value: 0 });
    await writeFile(join(world, "level.dat"), writeLevelDat({ storageVersion: 10, rootName: "", root }));
    await writeFile(join(world, "levelname.txt"), "Steve's Base");
    await writeFile(join(world, "db", "000001.ldb"), "the player's build");
    await writeFile(join(world, "world_behavior_packs.json"), JSON.stringify([{ pack_id: "foreign", version: [2, 0, 0] }]));
    await writeFile(join(world, ICON_FILE), "the user's picture");
    await useDevWorld(install, "Steve's Base");
    return world;
  }

  const project = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test", "fixtures", "good_addon");
  const launchOpts = { mode: "desktop", debuggerPort: 0, connectPort: 0 } as const;

  it("enters the saved dev world, and on stop leaves the packs in it and their folders in place", async () => {
    const world = await savedUserWorld();
    const bridge = new ClientBridge();
    const status = await bridge.start({ ...launchOpts, project });
    expect(status).toMatchObject({ world: "Steve's Base", worldMode: "user" });
    expect(status.worldBackup?.startsWith(join(dir, "data", "world-backups", "Xy+z="))).toBe(true);
    expect(status.worldNote).toContain(`backed up to ${status.worldBackup}`);
    expect(status.worldNote).toContain("turned cheats on in Steve's Base");
    const helper = JSON.parse(await readFile(join(HELPER_PACK_DIR, "manifest.json"), "utf8")).header.uuid;
    const r = await bridge.stop();
    expect(r.savedAndQuit).toBeUndefined();
    expect(r.keptPackFolders?.length).toBeGreaterThan(0);
    for (const folder of r.keptPackFolders ?? []) await access(folder);
    expect(r.stopNote).toContain("own icon was put back");
    const packs = JSON.parse(await readFile(join(world, "world_behavior_packs.json"), "utf8")) as { pack_id: string }[];
    expect(packs[0]?.pack_id).toBe(helper);
    expect(packs.map((p) => p.pack_id)).toContain("foreign");
    expect(packs.length).toBe(3);
    expect(await readFile(join(world, ICON_FILE), "utf8")).toBe("the user's picture");
    expect(await readFile(join(world, "db", "000001.ldb"), "utf8")).toBe("the player's build");
    expect(readLevelDat(new Uint8Array(await readFile(join(world, "level.dat")))).root.get("cheatsEnabled")?.value).toBe(1);
  });

  it("launches a sculkwire test world with fresh, leaving the saved dev world untouched", async () => {
    const world = await savedUserWorld();
    const level = await readFile(join(world, "level.dat"));
    const bridge = new ClientBridge();
    const status = await bridge.start({ ...launchOpts, fresh: true });
    await bridge.stop();
    expect(status).toMatchObject({ world: "sculkwire-bridge", worldMode: "fresh" });
    expect(await readFile(join(world, "level.dat"))).toEqual(level);
    expect(await readFile(join(world, ICON_FILE), "utf8")).toBe("the user's picture");
  });

  it("refuses userWorld with a test world option, and writes nothing into the world while the game runs", async () => {
    const world = await savedUserWorld();
    const level = await readFile(join(world, "level.dat"));
    await expect(new ClientBridge().start({ ...launchOpts, userWorld: "Steve's Base", world: "other" })).rejects.toThrow(
      "userWorld enters one of your own worlds and cannot be combined with world",
    );
    runningPids = [4242];
    await expect(new ClientBridge().start(launchOpts)).rejects.toThrow("the game is running");
    expect(await readFile(join(world, "level.dat"))).toEqual(level);
    expect(await readFile(join(world, ICON_FILE), "utf8")).toBe("the user's picture");
  });
});
