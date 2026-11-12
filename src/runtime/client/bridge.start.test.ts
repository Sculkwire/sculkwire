/**
 * `start` on an install the user starts: the bridge returns at once and keeps waiting for the world in the background.
 * `start` on an install sculkwire launches: `stop` during the wait ends it with "the game stopped".
 * The launcher is replaced so no game process is looked up, started or stopped.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Install from "../../gamefiles/install.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { ClientBridge } from "./bridge.ts";
import type * as ContentLog from "./contentlog.ts";
import { readDebugLogSince } from "./contentlog.ts";
import type * as Launcher from "./launcher.ts";
import type { LaunchState } from "./launcher.ts";
import { readLevelDat, TAG, writeLevelDat } from "../../gamefiles/nbt.ts";
import { createWorld } from "./world.ts";
import { listAllWorlds } from "./worldstore.ts";

const state: LaunchState = { mode: "desktop", startedAt: 0, pid: 0, argv: [], launchLog: "", notes: ["start Minecraft yourself"] };
let install: ClientInstall;
/** Replaces the launcher's `waitForGame` while set. */
let waitForGame: ((signal?: AbortSignal) => Promise<number>) | undefined;
const stopGame = vi.fn(async () => ({ stopped: true, message: "the game was not running" }));

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
    stopGame.mockClear();
    delete process.env.SCULKWIRE_DATA;
    await rm(dir, { recursive: true, force: true });
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
});
