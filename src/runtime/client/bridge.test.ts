import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "../debugger/framing.ts";
import { ClientBridge, connectView } from "./bridge.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import type { LaunchState } from "./launcher.ts";

const launch = (gamePid?: number): LaunchState => ({
  mode: "desktop",
  startedAt: 0,
  pid: 0,
  argv: [],
  launchLog: "",
  notes: ["start Minecraft yourself"],
  ...(gamePid !== undefined ? { gamePid } : {}),
});

/** A pid that existed and is gone now. */
const exitedPid = (): number => {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (!pid) throw new Error("no child pid");
  return pid;
};

describe("client bridge liveness", () => {
  it("counts a launch as running while its game process lives, and before the user started it", () => {
    const bridge = new ClientBridge();
    expect(bridge.status()).toMatchObject({ running: false, ready: false });
    bridge.launchState = launch();
    expect(bridge.running).toBe(true);
    bridge.launchState = launch(process.pid);
    expect(bridge.running).toBe(true);
    expect(bridge.status().gameExited).toBeUndefined();
  });

  it("reports a game whose process exited as not running, with game_stop as the step", async () => {
    const bridge = new ClientBridge();
    const pid = exitedPid();
    bridge.launchState = launch(pid);
    expect(bridge.running).toBe(false);
    const s = bridge.status();
    expect(s).toMatchObject({ running: false, ready: false, mode: "desktop", gameExited: true });
    expect(s.manualSteps).toEqual([`the game process (pid ${pid}) exited: call game_stop to clean up, then game_launch`]);
    await expect(bridge.command("say hi")).rejects.toThrow(`the game process (pid ${pid}) exited`);
  });
});

describe("/connect manual step", () => {
  const step = 'type "/connect localhost:19131" in the game chat to enable /connect';

  it("drops the step once a client attached, names the method chat, and shows it again when the client is gone", () => {
    expect(connectView(step, undefined, 0)).toEqual({ status: { clients: 0 }, steps: [step] });
    expect(connectView(step, undefined, 1)).toEqual({ status: { clients: 1, method: "chat" }, steps: [] });
    expect(connectView(step, undefined, 0)).toEqual({ status: { clients: 0 }, steps: [step] });
  });

  it("keeps a known method and has no step when the game dialled in by itself", () => {
    expect(connectView(undefined, "automatic", 1)).toEqual({ status: { clients: 1, method: "automatic" }, steps: [] });
    expect(connectView(undefined, undefined, 0)).toEqual({ status: { clients: 0 }, steps: [] });
  });
});

interface FakeGame {
  /** The helper pack runs and answers queries. */
  helper: boolean;
  sockets: Socket[];
  commands: string[];
  /** Handles a command itself (returns true) instead of the default behaviour. */
  onCommand?: (command: string, socket: Socket) => boolean;
  print(socket: Socket, message: string): void;
  /** Dial the debugger; once it resumed us, start the helper, which prints ready. */
  dial(): Promise<Socket>;
  close(): void;
}

/**
 * A fake game on the script debugger: dials the bridge's listener, echoes each command like the game, answers helper
 * queries while its helper runs, and prints ready when the helper (re)starts. `onCommand` scripts `reload all` and
 * `script debugger connect` per test.
 */
function fakeGame(port: number): FakeGame {
  const game: FakeGame = {
    helper: false,
    sockets: [],
    commands: [],
    print(socket, message) {
      socket.write(encodeFrame({ type: "event", event: { type: "PrintEvent", message, logLevel: 1 } }));
    },
    dial() {
      const { promise, resolve } = Promise.withResolvers<Socket>();
      const socket = createConnection({ host: "127.0.0.1", port });
      const decoder = new FrameDecoder();
      socket.on("error", () => {});
      socket.on("connect", () => {
        game.sockets.push(socket);
        socket.write(encodeFrame({ type: "event", event: { type: "ProtocolEvent", version: 11, plugins: [{ name: "sculkwire helper", module_uuid: "AAAA-1" }] } }));
      });
      socket.on("data", (chunk: Buffer) => {
        for (const m of decoder.push(chunk) as Record<string, unknown>[]) {
          if (m.type === "resume" && !game.helper) {
            game.helper = true;
            game.print(socket, "[sculkwire:ready]");
            resolve(socket);
          }
          if (m.type !== "minecraftCommand") continue;
          // Protocol 11 sends the flat shape: `command` is the command line.
          const command = String(m.command);
          game.commands.push(command);
          game.print(socket, `[Scripting] Executing command [${command}]`);
          if (game.onCommand?.(command, socket)) continue;
          const query = /^scriptevent sculkwire:query (.*)$/.exec(command)?.[1];
          if (query !== undefined && game.helper) {
            const parsed: unknown = JSON.parse(query);
            const id = parsed && typeof parsed === "object" && "id" in parsed ? parsed.id : undefined;
            game.print(socket, `[sculkwire:reply] ${JSON.stringify({ id, ok: true, result: "pong" })}`);
          }
          if (command === "reload") {
            game.print(socket, "Function and script files have been reloaded.");
            game.print(socket, "[sculkwire:ready]");
          }
        }
      });
      return promise;
    },
    close() {
      for (const s of game.sockets) s.destroy();
    },
  };
  return game;
}

describe("game_reload over the script debugger", () => {
  let dir: string;
  let bridge: ClientBridge;
  let game: FakeGame;
  const fast = { readyMs: 500, redialMs: 500, helperMs: 500 };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sw-bridge-"));
    process.env.SCULKWIRE_DATA = join(dir, "data");
    await mkdir(join(dir, "data", "client"), { recursive: true });
    await mkdir(join(dir, "logs"), { recursive: true });
    const state = launch(process.pid);
    await writeFile(join(dir, "data", "client", "launch.json"), JSON.stringify(state));
    bridge = new ClientBridge();
    bridge.launchState = state;
    bridge.install = {
      kind: "custom",
      label: "fake",
      appData: dir,
      sharedComMojang: dir,
      userComMojang: dir,
      logsDir: join(dir, "logs"),
      passesArgs: false,
      wine: false,
      preview: false,
    } as unknown as ClientInstall;
    game = fakeGame(await bridge.listenDebugger(0));
    await game.dial();
    await bridge.waitForPrint((p) => p.message.includes("[sculkwire:ready]"), 2000);
    expect(await bridge.query("ping")).toBe("pong");
  });

  afterEach(async () => {
    bridge.closeDebugger();
    game.close();
    delete process.env.SCULKWIRE_DATA;
    await rm(dir, { recursive: true, force: true });
  });

  it("re-establishes the debugger when /reload all leaves the old socket open with no script runtime behind it", async () => {
    game.onCommand = (command) => {
      if (command === "reload all") {
        // Retail 1.26.63: the echo comes, then nothing: no output, no helper replies on this socket.
        game.helper = false;
        return true;
      }
      if (command.startsWith("script debugger connect ")) {
        void game.dial();
        return true;
      }
      return false;
    };
    const r = await bridge.reload(true, fast);
    expect(r.command).toMatchObject({ command: "reload all", via: "debugger" });
    expect(r.diagnostics.filter((d) => d.code === "client.helper-lost")).toEqual([]);
    expect(game.commands).toContain(`script debugger connect localhost ${bridge.status().debugger.port}`);
    const s = bridge.status();
    expect(s.debugger.attached).toBe(true);
    expect(s.manualSteps).toEqual([]);
    expect(await bridge.query("ping")).toBe("pong");
  });

  it("waits for the game's own re-attach when /reload all drops the debugger socket", async () => {
    game.onCommand = (command, socket) => {
      if (command !== "reload all") return false;
      // The game closes the debugger socket (after the echo it already wrote) and dials in again by itself.
      game.helper = false;
      socket.end(() => void game.dial());
      return true;
    };
    const r = await bridge.reload(true, fast);
    expect(r.diagnostics.filter((d) => d.code === "client.helper-lost")).toEqual([]);
    expect(game.commands.filter((c) => c.startsWith("script debugger connect"))).toEqual([]);
    expect(bridge.status().debugger.attached).toBe(true);
    expect(await bridge.query("ping")).toBe("pong");
  });

  it("drops a dead channel and reports the helper lost when the game never comes back", async () => {
    game.onCommand = (command) => {
      if (command === "reload all") game.helper = false;
      return command === "reload all" || command.startsWith("script debugger connect ");
    };
    const r = await bridge.reload(true, fast);
    const lost = r.diagnostics.filter((d) => d.code === "client.helper-lost");
    expect(lost).toMatchObject([{ severity: "error", source: "client" }]);
    const s = bridge.status();
    const port = s.debugger.port;
    expect(s).toMatchObject({ ready: false, debugger: { attached: false } });
    expect(s.manualSteps).toContainEqual(expect.stringContaining(`type "/script debugger connect localhost ${port}" in the game chat`));
    await expect(bridge.query("ping")).rejects.toThrow("queries need the script debugger");

    // The user types the command: the new session's ready print clears the step.
    const since = (await bridge.logs()).cursor.printSeq;
    await game.dial();
    await bridge.waitForPrint((p) => p.message.includes("[sculkwire:ready]"), 2000, since);
    expect(await bridge.query("ping")).toBe("pong");
    expect(bridge.status().manualSteps).toEqual([]);
  });

  it("keeps plain /reload quick when the helper prints ready again", async () => {
    const r = await bridge.reload(false, fast);
    expect(r.command).toMatchObject({ via: "debugger", ok: true, output: ["Function and script files have been reloaded."] });
    expect(r.diagnostics).toEqual([]);
    expect(game.commands.filter((c) => c.startsWith("script debugger connect"))).toEqual([]);
  });
});
