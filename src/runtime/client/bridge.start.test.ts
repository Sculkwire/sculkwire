/**
 * `start` on an install the user starts: the bridge returns at once and keeps waiting for the world in the background.
 * `start` on an install sculkwire launches: `stop` during the wait ends it with "the game stopped".
 * `start` while the install's game already runs: the bridge attaches to it and `stop` only detaches.
 * The launcher is replaced so no game process is looked up, started or stopped.
 */
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, FrameDecoder } from "../debugger/framing.ts";
import type * as Install from "../../gamefiles/install.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { ClientBridge, dialCommands, helperMissing } from "./bridge.ts";
import type * as ContentLog from "./contentlog.ts";
import { readDebugLogSince } from "./contentlog.ts";
import type * as Launcher from "./launcher.ts";
import type { LaunchState } from "./launcher.ts";
import { readLevelDat, TAG, writeLevelDat, type NbtCompound } from "../../gamefiles/nbt.ts";
import { createWorld, HELPER_PACK_DIR, HELPER_PACK_FOLDER } from "./world.ts";
import { ICON_FILE, listAllWorlds } from "./worldstore.ts";
import { useDevWorld } from "./devworld.ts";
import { FakePactl } from "../../testing/fakepactl.ts";
import { MUTE_SINK } from "./mute.ts";

const state: LaunchState = { mode: "desktop", startedAt: 0, pid: 0, argv: [], launchLog: "", notes: ["start Minecraft yourself"] };
/** Merged into the launch state `launch` returns. */
let launched: Partial<LaunchState> = {};
let pactl = new FakePactl();
let install: ClientInstall;
/** Replaces the launcher's `waitForGame` while set. */
let waitForGame: ((signal?: AbortSignal) => Promise<number>) | undefined;
const stopGame = vi.fn(async () => ({ stopped: true, message: "the game was not running" }));
/** The game processes the launcher finds. */
let runningPids: number[] = [];
/** Whether a launch state file exists (another process's launch, or none at all). */
let stateFile = true;

vi.mock("../../gamefiles/install.ts", async (original) => ({
  ...(await original<typeof Install>()),
  findInstall: async () => install,
}));
vi.mock("./launcher.ts", async (original) => ({
  ...(await original<typeof Launcher>()),
  launch: async () => ({ ...state, ...launched }),
  waitForGame: async (_install: unknown, _timeoutMs: number, signal?: AbortSignal) => (waitForGame ? waitForGame(signal) : process.pid),
  readLaunchState: async () => (stateFile ? { ...state } : undefined),
  stop: () => stopGame(),
  gamePids: async () => runningPids,
  systemPactl: (args: readonly string[]) => pactl.run(args),
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
    stateFile = true;
    launched = {};
    pactl = new FakePactl();
    stopGame.mockClear();
    delete process.env.SCULKWIRE_DATA;
    delete process.env.SCULKWIRE_CONFIG;
    await rm(dir, { recursive: true, force: true });
  });

  it("never stops a running game it did not launch: a stop with no launch of its own leaves the game alone", async () => {
    // The user's game runs; this process launched nothing and no launch state file says sculkwire did.
    stateFile = false;
    runningPids = [4242];
    const r = await new ClientBridge().stop();
    expect(stopGame).not.toHaveBeenCalled();
    expect(r).toMatchObject({ stopped: true, message: expect.stringMatching(/left alone/) });
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
    await savedUserWorld();
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
    await savedUserWorld();
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

  it("removes stale sculkwire worlds, but never kept ones or the saved dev world", async () => {
    await savedUserWorld();
    const old = await createWorld(install, { name: "old", helper: false });
    const kept = await createWorld(install, { name: "kept", helper: false });
    await writeFile(join(kept.dir, "sculkwire-world.json"), JSON.stringify({ keep: true, copiedFrom: "Steve's Base" }));
    const longAgo = BigInt(Math.floor(Date.now() / 1000) - 10 * 86_400);
    for (const world of [old, kept]) {
      const level = readLevelDat(new Uint8Array(await readFile(join(world.dir, "level.dat"))));
      level.root.set("LastPlayed", { type: TAG.Long, value: longAgo });
      await writeFile(join(world.dir, "level.dat"), writeLevelDat(level));
    }
    const bridge = new ClientBridge();
    const status = await bridge.start({ mode: "desktop", debuggerPort: 0, connectPort: 0 });
    await bridge.stop();
    expect(status.prunedWorlds).toEqual(["sculkwire-old"]);
    expect((await listAllWorlds(install)).map((w) => w.name).sort()).toEqual(["Steve's Base", "sculkwire-kept"]);
  });

  /** One of the user's own worlds, cheats off, with a foreign pack (and `packs`) and its own icon. */
  async function userWorld(levelId: string, name: string, opts: { packs?: string[]; lastPlayed?: number } = {}): Promise<string> {
    const world = join(install.userComMojang, "minecraftWorlds", levelId);
    await mkdir(join(world, "db"), { recursive: true });
    const root: NbtCompound = new Map();
    root.set("LevelName", { type: TAG.String, value: name });
    root.set("cheatsEnabled", { type: TAG.Byte, value: 0 });
    root.set("commandsEnabled", { type: TAG.Byte, value: 0 });
    if (opts.lastPlayed !== undefined) root.set("LastPlayed", { type: TAG.Long, value: BigInt(opts.lastPlayed) });
    await writeFile(join(world, "level.dat"), writeLevelDat({ storageVersion: 10, rootName: "", root }));
    await writeFile(join(world, "levelname.txt"), name);
    await writeFile(join(world, "db", "000001.ldb"), "the player's build");
    const packs = ["foreign", ...(opts.packs ?? [])].map((pack_id) => ({ pack_id, version: [2, 0, 0] }));
    await writeFile(join(world, "world_behavior_packs.json"), JSON.stringify(packs));
    await writeFile(join(world, ICON_FILE), "the user's picture");
    return world;
  }

  /** `userWorld` Steve's Base, saved as the dev world. */
  async function savedUserWorld(): Promise<string> {
    const world = await userWorld("Xy+z=", "Steve's Base");
    await useDevWorld(install, "Steve's Base");
    return world;
  }

  const project = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test", "fixtures", "good_addon");
  const launchOpts = { mode: "desktop", debuggerPort: 0, connectPort: 0 } as const;

  describe.runIf(process.platform === "linux")("mute", () => {
    /** The game's pid: alive, so the bridge does not take the game for exited. */
    const GAME = process.pid;

    it("keeps a muted launch's streams on the silent sink through the stop, then removes the sink", async () => {
      launched = { muteRequested: true };
      pactl.inputs = [
        { id: 7, sink: "1", pid: GAME },
        { id: 8, sink: "1", pid: 999 },
      ];
      const bridge = new ClientBridge();
      await savedUserWorld();
      await bridge.start(launchOpts);
      // The game process appears after the launch; the next sweep finds its stream.
      runningPids = [GAME];
      await vi.waitFor(() => expect(pactl.sinkOf(7)).toBe(MUTE_SINK), { timeout: 5_000, interval: 100 });
      expect(bridge.status()).toMatchObject({ muted: true });
      expect(bridge.status().muteNote).toBeUndefined();
      expect(pactl.sinkOf(8)).toBe("speakers");
      let atStop: string | undefined;
      let sinkAtStop = false;
      stopGame.mockImplementationOnce(async () => {
        atStop = pactl.sinkOf(7);
        sinkAtStop = pactl.sinks.some((s) => s.name === MUTE_SINK);
        // The game exits: its stream goes with it.
        pactl.inputs = pactl.inputs.filter((i) => i.pid !== GAME);
        return { stopped: true, message: "closed the game (1 process(es))" };
      });
      await bridge.stop();
      expect(atStop).toBe(MUTE_SINK);
      expect(sinkAtStop).toBe(true);
      expect(pactl.callsOf("move-sink-input").filter((c) => c[2] !== MUTE_SINK)).toEqual([]);
      expect(pactl.sinks.some((s) => s.name === MUTE_SINK)).toBe(false);
      expect(pactl.calls.some((c) => c[0] === "set-sink-input-mute")).toBe(false);
    }, 15_000);

    it("reports muted false with the reason when pactl is missing", async () => {
      launched = { muteRequested: true };
      pactl.missing = true;
      const bridge = new ClientBridge();
      await savedUserWorld();
      const status = await bridge.start(launchOpts);
      await bridge.stop();
      expect(status).toMatchObject({ muted: false, muteNote: "could not create the silent sink (pactl is not installed); the game's sound plays normally" });
    });

    it("leaves the sound of a launch without mute alone", async () => {
      const bridge = new ClientBridge();
      await savedUserWorld();
      const status = await bridge.start(launchOpts);
      await bridge.stop();
      expect(status.muted).toBe(false);
      expect(pactl.calls).toEqual([]);
    });

    it("leaves an attached game's sound alone, and with mute: true silences it until the detach", async () => {
      runningPids = [GAME];
      pactl.inputs = [{ id: 7, sink: "1", pid: GAME }];
      const plain = new ClientBridge();
      const status = await plain.start(launchOpts);
      await plain.stop();
      expect(status).toMatchObject({ attached: true, muted: false });
      expect(pactl.calls).toEqual([]);

      const bridge = new ClientBridge();
      const muted = await bridge.start({ ...launchOpts, mute: true });
      expect(muted).toMatchObject({ attached: true, muted: true });
      expect(muted.worldNote).not.toContain("mute");
      expect(pactl.sinkOf(7)).toBe(MUTE_SINK);
      const r = await bridge.stop();
      expect(r.detached).toBe(true);
      expect(pactl.sinkOf(7)).toBe("speakers");
      expect(pactl.sinks.some((s) => s.name === MUTE_SINK)).toBe(false);
      expect(stopGame).not.toHaveBeenCalled();
    });
  });

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
    expect(r.stopNote).not.toContain("icon");
    const packs = JSON.parse(await readFile(join(world, "world_behavior_packs.json"), "utf8")) as { pack_id: string }[];
    expect(packs[0]?.pack_id).toBe(helper);
    expect(packs.map((p) => p.pack_id)).toContain("foreign");
    expect(packs.length).toBe(3);
    expect(await readFile(join(world, ICON_FILE), "utf8")).toBe("the user's picture");
    expect(await readFile(join(world, "db", "000001.ldb"), "utf8")).toBe("the player's build");
    expect(readLevelDat(new Uint8Array(await readFile(join(world, "level.dat")))).root.get("cheatsEnabled")?.value).toBe(1);
  });

  /** The project's behavior pack uuid (test/fixtures/good_addon). */
  const PROJECT_BP = "5b1c7a0e-2f1d-4c55-9a39-1e7d3b6a0001";

  it("without a saved dev world enters the user's world that already uses the project's packs", async () => {
    const now = Math.floor(Date.now() / 1000);
    const world = await userWorld("Ab+c=", "Echo Lab", { packs: [PROJECT_BP], lastPlayed: now - 86_400 });
    const other = await userWorld("Zz9==", "Survival", { lastPlayed: now });
    const level = await readFile(join(other, "level.dat"));
    const bridge = new ClientBridge();
    const status = await bridge.start({ ...launchOpts, project });
    await bridge.stop();
    expect(status).toMatchObject({ world: "Echo Lab", worldMode: "user" });
    expect(status.worldNote).toContain("Echo Lab is the one of your worlds whose pack lists name the project's packs");
    expect(await readFile(join(world, ICON_FILE), "utf8")).toBe("the user's picture");
    expect(await readFile(join(other, "level.dat"))).toEqual(level);
  });

  it("of several worlds using the project's packs enters the one played last and says so", async () => {
    const now = Math.floor(Date.now() / 1000);
    await userWorld("Ab+c=", "Echo Lab", { packs: [PROJECT_BP], lastPlayed: now - 86_400 });
    await userWorld("De+f=", "Echo Lab 2", { packs: [PROJECT_BP], lastPlayed: now - 60 });
    const bridge = new ClientBridge();
    const status = await bridge.start({ ...launchOpts, project });
    await bridge.stop();
    expect(status).toMatchObject({ world: "Echo Lab 2", worldMode: "user" });
    expect(status.worldNote).toContain("2 of your worlds use the project's packs (Echo Lab 2 [De+f=], Echo Lab [Ab+c=]); Echo Lab 2 was played last");
  });

  it("finds no world to use: fails at once listing the user's worlds and the next step, and creates none", async () => {
    await userWorld("Zz9==", "Survival", { lastPlayed: 1_700_000_000 });
    await createWorld(install, { name: "left-over", helper: false });
    const bridge = new ClientBridge();
    const failed = bridge.start({ ...launchOpts, project });
    await expect(failed).rejects.toThrow(/no world to launch into: .*none of your worlds lists the project's packs\. Your worlds, played last first: "Survival" \[Zz9==\] last played 2023-11-14\. Ask the user which world/);
    await expect(failed).rejects.toThrow(/game_worlds \{action: "use"/);
    expect((await listAllWorlds(install)).map((w) => w.name).sort()).toEqual(["Survival", "sculkwire-left-over"]);
  });

  it("writes nothing into the saved dev world while the game runs: it attaches instead", async () => {
    const world = await savedUserWorld();
    const level = await readFile(join(world, "level.dat"));
    runningPids = [process.pid];
    const bridge = new ClientBridge();
    const status = await bridge.start(launchOpts);
    await bridge.stop();
    expect(status).toMatchObject({ attached: true, worldMode: "attached" });
    expect(await readFile(join(world, "level.dat"))).toEqual(level);
    expect(await readFile(join(world, ICON_FILE), "utf8")).toBe("the user's picture");
    expect(JSON.parse(await readFile(join(world, "world_behavior_packs.json"), "utf8"))).toEqual([{ pack_id: "foreign", version: [2, 0, 0] }]);
  });

  describe("a game that already runs", () => {
    beforeEach(() => {
      runningPids = [process.pid];
    });

    /** The engine log of the user's game: it opened and joined `levelId`. */
    async function openedWorld(levelId: string, name: string): Promise<string> {
      const world = join(install.userComMojang, "minecraftWorlds", levelId);
      await mkdir(world, { recursive: true });
      await writeFile(join(world, "levelname.txt"), name);
      await mkdir(install.logsDir, { recursive: true });
      await writeFile(
        join(install.logsDir, "Debug_Log_2026.txt"),
        `[2026-11-08 20:49:12:490 INFO CLIENT 1 2] Opening level '${world.replaceAll("\\", "/")}/db'\n` +
          "[2026-11-08 20:49:15:100 INFO CLIENT 1 2] Player Spawned: Steve\n",
      );
      return world;
    }

    it("attaches instead of refusing, and without an agent names the two commands to type", async () => {
      await openedWorld("Ab+c=", "Steve's Base");
      const bridge = new ClientBridge();
      const status = await bridge.start(launchOpts);
      try {
        expect(status).toMatchObject({ running: true, ready: false, attached: true, worldMode: "attached", inWorld: true, levelId: "Ab+c=", world: "Steve's Base" });
        expect(status.worldNote).toContain("attached to the game you opened");
        const lines = dialCommands(status.debugger.port ?? 0, status.connect.port ?? 0);
        expect(lines.debugger).toMatch(/^script debugger connect localhost \d+$/);
        expect(lines.connect).toMatch(/^connect localhost:\d+$/);
        expect(status.manualSteps.some((m) => m.includes(`type "/${lines.debugger}" in the game chat`))).toBe(true);
        expect(status.manualSteps.some((m) => m.includes(`type "/${lines.connect}" in the game chat`))).toBe(true);
        expect(status.manualSteps.some((m) => m.startsWith("open a world"))).toBe(false);
        expect(bridge.launchState).toMatchObject({ attached: true, gamePid: process.pid, mode: "desktop" });
        await expect(bridge.input({ action: "key", keys: "w" })).rejects.toThrow("only through the in-game agent");
      } finally {
        const r = await bridge.stop();
        expect(r).toMatchObject({ stopped: true, detached: true, message: "detached from the game you opened; it keeps running" });
      }
      expect(stopGame).not.toHaveBeenCalled();
      expect(bridge.running).toBe(false);
    });

    it("says the game sits in a menu when no world is open", async () => {
      const bridge = new ClientBridge();
      const status = await bridge.start(launchOpts);
      await bridge.stop();
      expect(status).toMatchObject({ attached: true, inWorld: false });
      expect(status.manualSteps[0]).toMatch(/^open a world in the game: it sits in its menus/);
    });

    it("names the fresh-start options it could not apply, and does not fail for them", async () => {
      const bridge = new ClientBridge();
      const status = await bridge.start({ ...launchOpts, userWorld: "Steve's Base", difficulty: "hard", width: 800, betaApis: false });
      await bridge.stop();
      expect(status.worldNote).toContain("userWorld, display, width, difficulty need the game closed first: not applied");
      expect(stopGame).not.toHaveBeenCalled();
    });

    it("refuses a launch that needs its own game (attach: false)", async () => {
      await expect(new ClientBridge().start({ ...launchOpts, attach: false })).rejects.toThrow("is already running and this needs a game of its own");
    });

    it("keeps deployed pack folders the open world lists on detach, removes the others, and says a missing pack needs a rejoin", async () => {
      const world = await openedWorld("Ab+c=", "Steve's Base");
      const bridge = new ClientBridge();
      const status = await bridge.start({ ...launchOpts, project });
      const [listed, ...others] = status.packs;
      expect(listed?.path).toBeDefined();
      expect(others.length).toBeGreaterThan(0);
      expect(status.worldNote).toContain("not in the open world's pack lists");
      // The user added one of the packs to the world meanwhile (sculkwire never writes the open world's pack lists).
      await writeFile(join(world, "world_behavior_packs.json"), JSON.stringify([{ pack_id: listed?.uuid, version: [1, 0, 0] }]));
      const r = await bridge.stop();
      expect(r.keptPackFolders).toEqual([listed?.path]);
      await access(listed?.path ?? "");
      for (const p of others) if (p.path) await expect(access(p.path)).rejects.toThrow();
    });

    it("is ready once the debugger dials in; without the helper pack in the world queries fail at once and the pack is installed", async () => {
      await openedWorld("Ab+c=", "Steve's Base");
      const bridge = new ClientBridge();
      const status = await bridge.start(launchOpts);
      const socket = dialDebugger(status.debugger.port ?? 0);
      try {
        await vi.waitFor(() => expect(bridge.status().ready).toBe(true), { timeout: 8_000, interval: 200 });
        const ready = bridge.status();
        expect(ready.helperNote).toContain(helperMissing("Steve's Base"));
        expect(ready.manualSteps.some((m) => m.includes("script debugger connect"))).toBe(false);
        await expect(bridge.query("entities", {}, 30_000)).rejects.toThrow("the sculkwire helper pack does not run in \"Steve's Base\"");
        await access(join(install.sharedComMojang, "development_behavior_packs", HELPER_PACK_FOLDER, "manifest.json"));
      } finally {
        socket.destroy();
        await bridge.stop();
      }
    }, 20_000);
  });
});

/** A game whose world has no helper pack, dialling the bridge's debugger: it echoes commands and answers nothing. */
function dialDebugger(port: number): Socket {
  const socket = createConnection({ host: "127.0.0.1", port });
  const decoder = new FrameDecoder();
  socket.on("error", () => {});
  socket.on("connect", () => {
    socket.write(encodeFrame({ type: "event", event: { type: "ProtocolEvent", version: 11, plugins: [] } }));
  });
  socket.on("data", (chunk: Buffer) => {
    for (const m of decoder.push(chunk) as Record<string, unknown>[]) {
      if (m.type !== "minecraftCommand") continue;
      const message = `[Scripting] Executing command [${String(m.command)}]`;
      socket.write(encodeFrame({ type: "event", event: { type: "PrintEvent", message, logLevel: 1 } }));
    }
  });
  return socket;
}
