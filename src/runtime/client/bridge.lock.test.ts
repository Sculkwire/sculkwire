/**
 * game_launch `inputLock`: once sculkwire has the game (a launched game reached its world, or right after attaching to
 * the game the user opened) the input provider keeps the lock on for the session, and `stop` hands the earlier mode
 * back before it lets go of the game. A failed attach only adds `lockNote`. The provider and the game are fakes: no
 * game process is looked up, started or stopped.
 */
import { createConnection, type Socket } from "node:net";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, FrameDecoder } from "../debugger/framing.ts";
import type * as Install from "../../gamefiles/install.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { TAG, writeLevelDat, type NbtCompound } from "../../gamefiles/nbt.ts";
import type * as Launcher from "./launcher.ts";
import type { LaunchState } from "./launcher.ts";
import { ClientBridge } from "./bridge.ts";
import { HELPER_MARK } from "./helperprotocol.ts";
import { registerInputProvider, type EngineInput, type InputLockStatus, type InputProvider } from "./inputprovider.ts";
import type { LockMode } from "../engine/lock.ts";

const state: LaunchState = { mode: "desktop", startedAt: 0, pid: 0, argv: [], launchLog: "", notes: ["start Minecraft yourself"] };
let install: ClientInstall;
/** The game processes the launcher finds: one means the user's game already runs, so the bridge attaches. */
let runningPids: number[] = [];
const stopGame = vi.fn(async () => ({ stopped: true, message: "closed the game" }));

vi.mock("../../gamefiles/install.ts", async (original) => ({
  ...(await original<typeof Install>()),
  findInstall: async () => install,
}));
vi.mock("./launcher.ts", async (original) => ({
  ...(await original<typeof Launcher>()),
  launch: async () => ({ ...state }),
  waitForGame: async () => process.pid,
  readLaunchState: async () => ({ ...state }),
  stop: () => stopGame(),
  gamePids: async () => runningPids,
}));

/** An input provider that records what the bridge asks of its lock, in order. */
class FakeProvider implements InputProvider {
  readonly name = "fake agent";
  readonly input = {} as EngineInput;
  readonly calls: string[] = [];
  /** Set: `attach` and the lock fail with this. */
  attachError: string | undefined;
  /** The session lock this provider holds, like the agent's per-connection bit. */
  #session: LockMode | undefined;
  #attached = false;
  motion = () => undefined;
  pausedReason = () => undefined;
  hold = async () => async () => {};
  launched = async () => {};
  async attach(): Promise<void> {
    this.calls.push("attach");
    if (this.attachError) throw new Error(this.attachError);
    this.#attached = true;
  }
  lockStatus(): InputLockStatus | undefined {
    return this.#attached ? { mode: "auto", locked: this.#session === "on", user: false, session: this.#session === "on" } : undefined;
  }
  async sessionLock(mode: Exclude<LockMode, "off">): Promise<string | undefined> {
    if (!this.#attached) {
      try {
        await this.attach();
      } catch (e) {
        return `the in-game agent could not be attached (${(e as Error).message})`;
      }
    }
    this.calls.push(`lock ${mode}`);
    this.#session = mode;
    return undefined;
  }
  async releaseSessionLock(): Promise<void> {
    this.calls.push(`release (${this.#session ?? "nothing held"})`);
    this.#session = undefined;
  }
  async stopped(): Promise<void> {
    this.calls.push("stopped");
    this.#attached = false;
    // The connection closed: the agent ends the session lock with it.
    this.#session = undefined;
  }
  close = () => {};
}

/**
 * The game dialling the bridge's debugger from its world: once the bridge resumed it, the helper pack prints ready and
 * the player spawns.
 */
function gameInWorld(port: number): Socket {
  const socket = createConnection({ host: "127.0.0.1", port });
  const decoder = new FrameDecoder();
  let resumed = false;
  socket.on("error", () => {});
  socket.on("connect", () => {
    socket.write(encodeFrame({ type: "event", event: { type: "ProtocolEvent", version: 11, plugins: [] } }));
  });
  socket.on("data", (chunk: Buffer) => {
    for (const m of decoder.push(chunk) as Record<string, unknown>[]) {
      if (m.type !== "resume" || resumed) continue;
      resumed = true;
      for (const message of [HELPER_MARK.ready, HELPER_MARK.spawned]) {
        socket.write(encodeFrame({ type: "event", event: { type: "PrintEvent", message, logLevel: 1 } }));
      }
    }
  });
  return socket;
}

/** One of the user's own worlds to launch into. */
async function userWorld(): Promise<void> {
  const world = join(install.userComMojang, "minecraftWorlds", "Xy+z=");
  await mkdir(join(world, "db"), { recursive: true });
  const root: NbtCompound = new Map();
  root.set("LevelName", { type: TAG.String, value: "Steve's Base" });
  root.set("cheatsEnabled", { type: TAG.Byte, value: 1 });
  root.set("commandsEnabled", { type: TAG.Byte, value: 1 });
  await writeFile(join(world, "level.dat"), writeLevelDat({ storageVersion: 10, rootName: "", root }));
  await writeFile(join(world, "levelname.txt"), "Steve's Base");
}

const opts = { mode: "desktop", debuggerPort: 0, connectPort: 0 } as const;

describe("game_launch inputLock", () => {
  let dir: string;
  let provider: FakeProvider;
  let unregister: () => void;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sw-bridge-lock-"));
    process.env.SCULKWIRE_DATA = join(dir, "data");
    process.env.SCULKWIRE_CONFIG = join(dir, "config");
    install = { kind: "custom", label: "fake", appData: dir, sharedComMojang: dir, userComMojang: dir, logsDir: join(dir, "logs"), wine: false, preview: false } as ClientInstall;
    provider = new FakeProvider();
    unregister = registerInputProvider(provider);
  });

  afterEach(async () => {
    unregister();
    runningPids = [];
    stopGame.mockClear();
    delete process.env.SCULKWIRE_DATA;
    delete process.env.SCULKWIRE_CONFIG;
    await rm(dir, { recursive: true, force: true });
  });

  describe("attached to the game the user opened", () => {
    beforeEach(() => {
      runningPids = [process.pid];
    });

    it("releases the session lock while the user has a step in the game, takes it again once the channels are up, and the detach ends it", async () => {
      // The user's game has a world open.
      const world = join(install.userComMojang, "minecraftWorlds", "Ab+c=");
      await mkdir(world, { recursive: true });
      await writeFile(join(world, "levelname.txt"), "Steve's Base");
      await mkdir(install.logsDir, { recursive: true });
      await writeFile(
        join(install.logsDir, "Debug_Log_2026.txt"),
        `[2026-11-08 20:49:12:490 INFO CLIENT 1 2] Opening level '${world.replaceAll("\\", "/")}/db'\n` +
          "[2026-11-08 20:49:15:100 INFO CLIENT 1 2] Player Spawned: Steve\n",
      );
      const bridge = new ClientBridge();
      const status = await bridge.start({ ...opts, inputLock: "on" });
      let game: Socket | undefined;
      let connect: WebSocket | undefined;
      try {
        // The fake agent drives no chat, so the user is asked to type the channel commands: the lock is let go for that.
        expect(status.manualSteps.length).toBeGreaterThan(0);
        expect(status.inputLock).toMatchObject({ locked: false, session: false });
        expect(status.lockNote).toMatch(/^input lock released so the user can take the step in manualSteps in the game/);
        expect(provider.calls).toEqual(["stopped", "attach", "lock on", "release (on)"]);
        // The user types them: the debugger and /connect dial in, nothing is left for the user, and the lock comes back.
        game = gameInWorld(status.debugger.port ?? 0);
        connect = new WebSocket(`ws://127.0.0.1:${status.connect.port ?? 0}`);
        await vi.waitFor(() => expect(bridge.status().inputLock).toMatchObject({ locked: true, session: true }), { timeout: 15_000, interval: 200 });
        expect(bridge.status().manualSteps).toEqual([]);
        expect(bridge.status().lockNote).toBeUndefined();
        expect(provider.calls.slice(-1)).toEqual(["lock on"]);
      } finally {
        const r = await bridge.stop();
        game?.destroy();
        connect?.close();
        expect(r.detached).toBe(true);
      }
      expect(provider.calls.slice(-2)).toEqual(["release (on)", "stopped"]);
      expect(stopGame).not.toHaveBeenCalled();
    }, 30_000);

    it("still attaches when the agent cannot, and says why the lock is not set", async () => {
      provider.attachError = "the agent DLL could not be built";
      const bridge = new ClientBridge();
      const status = await bridge.start({ ...opts, inputLock: "on" });
      try {
        expect(status).toMatchObject({ running: true, attached: true });
        expect(status.inputLock).toBeUndefined();
        expect(status.lockNote).toBe(
          "input lock on not set, so the user's keyboard and mouse still reach the game: the in-game agent could not be attached (the agent DLL could not be built)",
        );
        // The failed attach is not tried a second time for the lock.
        expect(provider.calls.filter((c) => c === "attach")).toEqual(["attach"]);
      } finally {
        await bridge.stop();
      }
      expect(bridge.status().lockNote).toBeUndefined();
    });

    it("holds no session lock with inputLock auto (the default) or off, and sets nothing without inputLock (the bench and the CLI)", async () => {
      for (const inputLock of ["auto", "off", undefined] as const) {
        const from = provider.calls.length;
        const bridge = new ClientBridge();
        const status = await bridge.start({ ...opts, ...(inputLock ? { inputLock } : {}) });
        await bridge.stop();
        expect(status.lockNote).toBeUndefined();
        // Between calls nothing is locked: auto locks per action, off never.
        expect(status.inputLock).toMatchObject({ locked: false });
        const locks = provider.calls.slice(from).filter((c) => c.startsWith("lock"));
        expect(locks).toEqual(inputLock ? [`lock ${inputLock}`] : []);
      }
    });
  });

  it.runIf(process.platform === "linux")(
    "locks a launched game once it reached its world, and the stop releases it before the game goes",
    async () => {
      await userWorld();
      const bridge = new ClientBridge();
      const status = await bridge.start({ ...opts, userWorld: "Steve's Base", inputLock: "on" });
      // The user starts this install's game: nothing is locked before the world is in.
      expect(provider.calls).not.toContain("lock on");
      const game = gameInWorld(status.debugger.port ?? 0);
      try {
        await vi.waitFor(() => expect(bridge.status().inputLock).toMatchObject({ locked: true, session: true }), { timeout: 12_000, interval: 200 });
        // /connect is opt-in (connect: true): the game did not dial in by itself, and nothing is asked of the user for it.
        expect(bridge.status().manualSteps.some((m) => m.includes("/connect"))).toBe(false);
        let callsAtStop: string[] = [];
        stopGame.mockImplementationOnce(async () => {
          callsAtStop = [...provider.calls];
          return { stopped: true, message: "closed the game" };
        });
        await bridge.stop();
        expect(callsAtStop.slice(-2)).toEqual(["lock on", "release (on)"]);
      } finally {
        game.destroy();
      }
    },
    20_000,
  );

  it("locks as soon as the walk into the world attaches the agent on the start screen, before the world loads", async () => {
    await userWorld();
    // The engine log of the game the user starts: empty at the launch, then the start screen comes up.
    await mkdir(install.logsDir, { recursive: true });
    const log = join(install.logsDir, "Debug_Log_2026.txt");
    await writeFile(log, "");
    const bridge = new ClientBridge();
    await bridge.start({ ...opts, userWorld: "Steve's Base", inputLock: "on" });
    try {
      expect(provider.calls).not.toContain("lock on");
      await appendFile(log, "[2026-11-25 08:13:37:407 INFO GUI 320 316] Created 'start.start_screen' screen in 0.855900ms\n");
      await vi.waitFor(() => expect(provider.calls).toContain("lock on"), { timeout: 5_000, interval: 100 });
      expect(provider.calls.slice(-2)).toEqual(["attach", "lock on"]);
      expect(bridge.status().inputLock).toMatchObject({ locked: true, session: true });
    } finally {
      await bridge.stop();
    }
    expect(provider.calls.slice(-2)).toEqual(["release (on)", "stopped"]);
  });
});
