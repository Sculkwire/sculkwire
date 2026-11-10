import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientInstall } from "../client/install.ts";
import { gamePath } from "./gamepath.ts";
import { EngineSession, engineGameDir, type EngineStatus } from "./engine.ts";
import { AgentClient } from "./client.ts";
import type { UiKeyAction } from "./ui.ts";

type RpcRequest = Record<string, unknown> & { id?: number | string; method?: string };
type RpcResponse = Record<string, unknown>;

interface FakeAgent {
  port: number;
  /** Sockets accepted so far, including ones the test dropped. */
  connections: number;
  /** Every request line the client sent, parsed, in arrival order. */
  requests: RpcRequest[];
  /** Answers one request. Returning undefined sends nothing. */
  handler: (request: RpcRequest) => RpcResponse | undefined;
  /** Resolves once at least `count` request lines have arrived (no polling). */
  waitForRequests(count: number): Promise<RpcRequest[]>;
  /** Drops every client socket while the server keeps listening. */
  drop(): void;
  /** Writes one message line to every connected client (a server notification). */
  push(message: unknown): void;
  stop(): Promise<void>;
}

function reply(request: RpcRequest, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id: request.id, result };
}

function rpcError(request: RpcRequest, code: number, text: string): RpcResponse {
  return { jsonrpc: "2.0", id: request.id, error: { code, message: text } };
}

function statusResult(overrides: Partial<EngineStatus> = {}): EngineStatus {
  return { build: "1.26.60.30", hooked: true, tick: 7, resolved: { command: "0x140001000" }, missing: [], ...overrides };
}

/** A TCP server that records request lines and answers through a replaceable handler. */
async function fakeAgent(): Promise<FakeAgent> {
  const requests: RpcRequest[] = [];
  const sockets = new Set<Socket>();
  const waiters: { count: number; resolve: (lines: RpcRequest[]) => void }[] = [];

  const notify = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter && requests.length >= waiter.count) {
        waiters.splice(i, 1);
        waiter.resolve(requests);
      }
    }
  };

  const agent: FakeAgent = {
    port: 0,
    connections: 0,
    requests,
    handler: (request) => reply(request, { ok: true }),
    waitForRequests: (count) => {
      if (requests.length >= count) return Promise.resolve(requests);
      const { promise, resolve } = Promise.withResolvers<RpcRequest[]>();
      waiters.push({ count, resolve });
      return promise;
    },
    drop: () => {
      for (const socket of sockets) socket.destroy();
    },
    push: (message) => {
      for (const socket of sockets) socket.write(`${JSON.stringify(message)}\n`);
    },
    stop: () => {
      for (const socket of sockets) socket.destroy();
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      return promise;
    },
  };

  const server: Server = createServer((socket) => {
    agent.connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const request = JSON.parse(line) as RpcRequest;
        requests.push(request);
        notify();
        const response = agent.handler(request);
        if (response) socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake agent has no TCP address");
  agent.port = address.port;
  return agent;
}

const sessions: EngineSession[] = [];
const agents: FakeAgent[] = [];

async function makeAgent(): Promise<FakeAgent> {
  const agent = await fakeAgent();
  agents.push(agent);
  return agent;
}

function makeSession(agent: FakeAgent): EngineSession {
  const session = new EngineSession({ port: agent.port });
  sessions.push(session);
  return session;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the condition");
    await sleep(10);
  }
}

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  for (const agent of agents.splice(0)) await agent.stop();
});

describe("engine client support", () => {
  const install: ClientInstall = {
    kind: "wine-prefix",
    label: "Flarial",
    appData: "",
    sharedComMojang: "",
    userComMojang: "",
    logsDir: "",
    passesArgs: false,
    wine: true,
    preview: false,
    gameDir: "/games/mc",
  };
  const exe = (path: string) => path === join("/games/mc", "Minecraft.Windows.exe");
  const linux = { platform: "linux" as const, candidates: () => [] };

  it("accepts a Wine or Proton install on Linux and a native one on Windows", () => {
    expect(engineGameDir(install, { ...linux, exists: exe })).toBe("/games/mc");
    expect(engineGameDir({ ...install, kind: "mcbe-gdk-installer", label: "mcbe-gdk-installer" }, { ...linux, exists: exe })).toBe("/games/mc");
    const windows: ClientInstall = { ...install, kind: "windows", label: "Windows", wine: false };
    expect(engineGameDir(windows, { platform: "win32", exists: exe })).toBe("/games/mc");
    expect(engineGameDir({ ...windows, kind: "custom", label: "custom" }, { platform: "win32", exists: exe })).toBe("/games/mc");
  });

  it("rejects an install whose game is not the Windows process of this OS", () => {
    const nativeInstall: ClientInstall = { ...install, kind: "custom", label: "custom", wine: false };
    expect(() => engineGameDir(nativeInstall, { ...linux, exists: exe })).toThrow(/needs the game's Windows process.*natively.*linux/);
    expect(() => engineGameDir(install, { platform: "win32", exists: exe })).toThrow(/needs the game's Windows process.*under Wine.*win32/);
  });

  it("finds the game folder of an install without one among the candidates (SCULKWIRE_GAME_DIRS)", () => {
    const custom: ClientInstall = { ...install, gameDir: undefined };
    const dirs = ["/retail/absent", "/games/mc"];
    expect(engineGameDir(custom, { ...linux, candidates: () => dirs, exists: exe })).toBe("/games/mc");
    expect(() => engineGameDir(custom, { ...linux, candidates: () => ["/games/absent"], exists: () => false })).toThrow(
      /cannot find Minecraft.Windows.exe for Flarial: set SCULKWIRE_GAME_DIR/,
    );
    expect(() => engineGameDir(install, { ...linux, exists: () => false })).toThrow(/has no Minecraft.Windows.exe in \/games\/mc/);
  });
});

describe("engine method wrappers", () => {
  it("sends the contract method names and normalizes the status shape", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = (request) =>
      request.method === "player.state"
        ? reply(request, { position: [1, 2, 3], rotation: [0, 90], dimension: 0 })
        : reply(request, statusResult({ missing: ["x"] }));
    const resolved = await session.resolve();
    if (!resolved.ok) throw new Error(resolved.message);
    expect(resolved.value.missing).toEqual(["x"]);
    expect(resolved.value.build).toBe("1.26.60.30");
    const player = await session.playerState();
    if (!player.ok) throw new Error(player.message);
    expect(player.value.position).toEqual([1, 2, 3]);
    expect(agent.requests.map((request) => request.method)).toEqual(["engine.resolve", "player.state"]);
  });
});

describe("engine error handling", () => {
  it("maps every agent error code to a stable reason", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    const cases = [
      [-32601, "unknown_method"],
      [-32602, "invalid_params"],
      [-32001, "anchor_missing"],
      [-32002, "not_in_world"],
      [-32003, "wrong_thread"],
      [-32004, "timeout"],
      [-32006, "command_failed"],
      [-32007, "path_not_writable"],
      [-32014, "scripting_unavailable"],
      [-32099, "rpc_error"],
    ] as const;
    for (const [code, reason] of cases) {
      agent.handler = (request) => rpcError(request, code, "agent said no");
      const result = await session.command("time set noon");
      if (result.ok) throw new Error(`expected ${code} to fail`);
      expect(result.code).toBe(code);
      expect(result.reason).toBe(reason);
      expect(result.message).toBe("agent said no");
    }
  });

  it("names the single unresolved anchor when the agent reports -32001", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = (request) =>
      request.method === "engine.status"
        ? reply(request, statusResult({ missing: ["ChatUtils::executeCommand"], resolved: {} }))
        : rpcError(request, -32001, "anchor not resolved");
    const result = await session.command("time set noon");
    if (result.ok) throw new Error("expected the command to fail");
    expect(result.reason).toBe("anchor_missing");
    expect(result.anchor).toBe("ChatUtils::executeCommand");
    expect(agent.requests.map((request) => request.method)).toEqual(["command", "engine.status"]);
  });

  it("keeps the agent's reason from error.data.message", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = (request) => ({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32602, message: "invalid params", data: { message: "no screen is open" } },
    });
    const result = await session.command("time set noon");
    if (result.ok) throw new Error("expected the command to fail");
    expect(result.message).toBe("invalid params: no screen is open");
  });

  it("connects to an agent that is already listening when asked whether one is reachable", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    expect(session.attached).toBe(false);
    expect(await session.reachable()).toBe(true);
    expect(session.attached).toBe(true);
    await agent.stop();
    agents.splice(agents.indexOf(agent), 1);
    expect(await new EngineSession({ port: 9, timeoutMs: 200 }).reachable()).toBe(false);
  });

  it("reports not_attached when nothing listens on the port", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    await agent.stop();
    agents.splice(agents.indexOf(agent), 1);
    const result = await session.status();
    if (result.ok) throw new Error("expected status to fail");
    expect(result.reason).toBe("not_attached");
    expect(result.code).toBe(-32000);
  });
});

describe("engine command origin bootstrap", () => {
  const missingOrigin = (request: RpcRequest): RpcResponse => ({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32001, message: "anchor missing", data: { anchor: "command.origin", wait_for: "command.origin" } },
  });

  it("types one quiet chat line on the HUD when the agent has no origin yet, then runs the command", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    let captured = false;
    let screen = "hud_screen";
    agent.handler = (request) => {
      const params = request.params as Record<string, unknown> | undefined;
      switch (request.method) {
        case "command":
          return captured ? reply(request, { success: true, message: "commands.time.query.daytime: 6000" }) : missingOrigin(request);
        case "ui.screen":
          return reply(request, { name: screen, stack: [screen], modal: false });
        case "ui.key":
          if (params?.key === "t") screen = "chat_screen";
          if (params?.key === "Return") {
            screen = "hud_screen";
            captured = true;
          }
          return reply(request, { sent: 1 });
        default:
          return reply(request, { armed: true });
      }
    };
    const result = await session.command("time query daytime");
    expect(result).toEqual({ ok: true, value: { success: true, message: "commands.time.query.daytime: 6000" } });
    const sent = agent.requests.map((request) => [request.method, request.params]);
    expect(sent).toContainEqual(["command.prime", {}]);
    expect(sent).toContainEqual(["ui.text", { text: "/testfor @s" }]);
    const order = agent.requests.map((request) => {
      const params = request.params;
      const key = params && typeof params === "object" && "key" in params ? `:${String(params.key)}` : "";
      return `${request.method}${request.method === "ui.key" ? key : ""}`;
    });
    expect(order.indexOf("command.prime")).toBeLessThan(order.indexOf("ui.key:t"));
    expect(order.indexOf("ui.text")).toBeLessThan(order.indexOf("ui.key:Return"));
    expect(order).not.toContain("ui.key:Escape");
  });

  it("never types while another screen is open, and keeps the agent's answer", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = (request) => {
      if (request.method === "command") return missingOrigin(request);
      if (request.method === "ui.screen") return reply(request, { name: "pause_screen", stack: ["hud_screen", "pause_screen"], modal: false });
      return reply(request, {});
    };
    const result = await session.command("time query daytime");
    if (result.ok) throw new Error("expected the command to fail");
    expect(result.anchor).toBe("command.origin");
    expect(result.message).toContain("a screen is open");
    expect(agent.requests.map((request) => request.method)).not.toContain("ui.key");
    expect(agent.requests.map((request) => request.method)).not.toContain("ui.text");
  });
});

describe("engine tick arguments", () => {
  it("rejects a call with no field, several fields, or a step outside 1 to 600", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    const cases = [{}, { pause: true, step: 4 }, { pause: true, scale: 2 }, { step: 0 }, { step: 601 }, { step: 2.5 }, { scale: 0 }, { scale: Number.NaN }];
    for (const args of cases) {
      const result = await session.tick(args);
      if (result.ok) throw new Error(`expected ${JSON.stringify(args)} to fail`);
      expect(result.code).toBe(-32602);
      expect(result.reason).toBe("invalid_params");
    }
    expect(agent.requests).toHaveLength(0);
  });

  it("sends exactly one tick method with the contract parameter names", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = (request) => {
      if (request.method === "tick.pause") return reply(request, { paused: true });
      if (request.method === "tick.step") return reply(request, { ticks: 25 });
      if (request.method === "tick.scale") return reply(request, { scale: 3 });
      return undefined;
    };
    await expect(session.tick({ pause: true })).resolves.toEqual({ ok: true, value: { paused: true } });
    await expect(session.tick({ step: 25 })).resolves.toEqual({ ok: true, value: { ticks: 25 } });
    await expect(session.tick({ scale: 3 })).resolves.toEqual({ ok: true, value: { scale: 3 } });
    await agent.waitForRequests(3);
    expect(agent.requests.map((request) => [request.method, request.params])).toEqual([
      ["tick.pause", { paused: true }],
      ["tick.step", { count: 25 }],
      ["tick.scale", { value: 3 }],
    ]);
  });
});

describe("engine pause tracking", () => {
  it("knows the simulation is paused after pause or step, and not after resuming", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = (request) => {
      if (request.method === "tick.pause") return reply(request, request.params);
      if (request.method === "tick.step") return reply(request, { ticks: 1 });
      return reply(request, { success: true, message: "" });
    };
    expect(session.paused).toBe(false);
    await session.tick({ pause: true });
    expect(session.paused).toBe(true);
    await session.tick({ pause: false });
    expect(session.paused).toBe(false);
    await session.tick({ step: 1 });
    expect(session.paused).toBe(true);
    // Only the tick methods decide this: a command goes through the engine's dispatcher and changes nothing here.
    await session.command("/time set noon");
    expect(session.paused).toBe(true);
  });

  it("forgets the pause when the agent connection drops or the session closes, as when the game stops", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = (request) => reply(request, request.params);
    await session.tick({ pause: true });
    expect(session.paused).toBe(true);
    agent.drop();
    await waitFor(() => !session.attached);
    expect(session.paused).toBe(false);
    await session.tick({ pause: true });
    expect(session.paused).toBe(true);
    session.close();
    expect(session.paused).toBe(false);
  });
});

describe("engine screenshot", () => {
  /** The `path` parameter the agent received: `gamePath` of the host path (native on Windows, Wine's `Z:\…` on Linux). */
  function agentPath(request: RpcRequest): string {
    const params = request.params;
    if (!params || typeof params !== "object" || !("path" in params) || typeof params.path !== "string") {
      throw new Error("screenshot request without a path");
    }
    return params.path;
  }
  const hostPath = (request: RpcRequest) =>
    process.platform === "win32" ? agentPath(request) : agentPath(request).slice(2).replaceAll("\\", "/");
  /** Stand-in PNG: a body followed by the IEND chunk the agent waits for. */
  const IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const png = (body: string) => Buffer.concat([Buffer.from(body), IEND]);

  it("passes the game's path and moves a file written where it was asked", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = (request) => {
      writeFileSync(hostPath(request), png("png"));
      return reply(request, request.params);
    };
    const dir = await mkdtemp(join(tmpdir(), "sculkwire-engine-"));
    try {
      const host = join(dir, "shot.png");
      const result = await session.screenshot(host);
      if (!result.ok) throw new Error(result.message);
      expect(result.value).toEqual({ path: host, bytes: 3 + IEND.length, format: "png" });
      expect(readdirSync(dir)).toEqual(["shot.png"]);
      const sent = agent.requests[0];
      if (!sent) throw new Error("no request recorded");
      expect(agentPath(sent)).toMatch(/^[A-Z]:\\.*\\sculkwire-[a-z0-9]+-[0-9a-f]{6}\.png$/);
      expect(agentPath(sent)).toBe(gamePath(join(dir, basename(hostPath(sent)))));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("copies the file from the game's screenshot gallery, which ignores the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sculkwire-engine-"));
    const appData = join(dir, "Minecraft Bedrock");
    // Only appData is read by screenshot; the rest of the install does not matter here.
    const install = { appData } as ClientInstall;
    const agent = await makeAgent();
    const session = new EngineSession({ port: agent.port, install });
    sessions.push(session);
    agent.handler = (request) => {
      const photos = join(appData, "screenshots", "sculkwire-world", "photos", "-1");
      mkdirSync(photos, { recursive: true });
      const file = join(photos, basename(hostPath(request)));
      // The game writes in pieces: the first part must not be copied as the screenshot. A real delay, because the
      // session polls the real file system across a real socket round trip; fake timers would stall both.
      writeFileSync(file, "ima");
      setTimeout(() => writeFileSync(file, png("image")), 600);
      return reply(request, request.params);
    };
    try {
      const host = join(dir, "out", "shot.png");
      const result = await session.screenshot(host);
      if (!result.ok) throw new Error(result.message);
      expect(result.value).toEqual({ path: host, bytes: 5 + IEND.length, format: "png" });
      expect(readFileSync(host).equals(png("image"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("takes the newest new gallery picture when the game chose the name (named: false)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sculkwire-engine-"));
    const appData = join(dir, "Minecraft Bedrock");
    const install = { appData } as ClientInstall;
    const photos = join(appData, "screenshots", "sculkwire-world", "photos");
    // An older picture from before the request must not be taken.
    mkdirSync(join(photos, "old"), { recursive: true });
    const old = join(photos, "old", "old.png");
    writeFileSync(old, png("old"));
    const past = new Date(Date.now() - 60_000);
    utimesSync(old, past, past);
    const agent = await makeAgent();
    const session = new EngineSession({ port: agent.port, install });
    sessions.push(session);
    agent.handler = (request) => {
      mkdirSync(join(photos, "new"), { recursive: true });
      writeFileSync(join(photos, "new", "game-chosen.png"), png("fresh"));
      return reply(request, { path: agentPath(request), named: false, route: "button" });
    };
    try {
      const host = join(dir, "out", "shot.png");
      const result = await session.screenshot(host);
      if (!result.ok) throw new Error(result.message);
      expect(result.value).toEqual({ path: host, bytes: 5 + IEND.length, format: "png" });
      expect(readFileSync(host).equals(png("fresh"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("takes the retail gallery's JPEG from com.mojang/Screenshots and gives the copy a .jpg name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sculkwire-engine-"));
    const userComMojang = join(dir, "Minecraft Bedrock", "Users", "1", "games", "com.mojang");
    const install = { appData: join(dir, "Minecraft Bedrock"), userComMojang } as ClientInstall;
    const gallery = join(userComMojang, "Screenshots", "2535406089794402");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const agent = await makeAgent();
    const session = new EngineSession({ port: agent.port, install });
    sessions.push(session);
    agent.handler = (request) => {
      mkdirSync(gallery, { recursive: true });
      const file = join(gallery, "c33490af-c4e4-489a-9f2c-fa5866af71c5.jpeg");
      // Unfinished: no end marker yet, so it must not be taken. A real delay, as in the PNG gallery test: the session
      // polls the real file system across a real socket round trip, which fake timers would stall.
      writeFileSync(file, jpeg.subarray(0, 5));
      setTimeout(() => writeFileSync(file, jpeg), 600);
      return reply(request, { path: agentPath(request), named: false, route: "button" });
    };
    try {
      const result = await session.screenshot(join(dir, "out", "shot.png"));
      if (!result.ok) throw new Error(result.message);
      const expected = join(dir, "out", "shot.jpg");
      expect(result.value).toEqual({ path: expected, bytes: jpeg.length, format: "jpeg" });
      expect(readFileSync(expected).equals(jpeg)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("engine reconnect", () => {
  it("reconnects after the agent drops the socket", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = (request) => reply(request, statusResult());
    const first = await session.status();
    expect(first.ok).toBe(true);
    expect(agent.connections).toBe(1);
    agent.drop();
    await waitFor(() => !session.attached);
    const second = await session.status();
    expect(second.ok).toBe(true);
    expect(agent.connections).toBe(2);
  });

  it("fails an in-flight call when the socket drops, then serves the next call on a new socket", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = () => undefined;
    const pending = session.command("time set noon");
    await agent.waitForRequests(1);
    agent.drop();
    const failed = await pending;
    if (failed.ok) throw new Error("expected the dropped call to fail");
    expect(failed.reason).toBe("not_attached");
    agent.handler = (request) => reply(request, statusResult());
    const again = await session.status();
    expect(again.ok).toBe(true);
    expect(agent.connections).toBe(2);
  });
});

function tickParams(tick: number, yaw = 0) {
  return { tick, position: [1, 64, 2], rotation: [10, yaw], velocity: [0, -0.08, 0], onGround: true, health: 20, selectedSlot: 3 };
}

describe("engine input and tick stream", () => {
  it("delivers server notifications to listeners while answers still match their requests", async () => {
    const agent = await makeAgent();
    agent.handler = (request) => {
      // A notification goes out before the answer, on the same connection.
      agent.push({ jsonrpc: "2.0", method: "tick", params: tickParams(5) });
      return reply(request, "pong");
    };
    const client = new AgentClient({ port: agent.port });
    const seen: unknown[] = [];
    const all: string[] = [];
    const off = client.on("tick", (params) => seen.push(params));
    client.on("*", (_params, method) => all.push(method));
    try {
      expect(await client.ping()).toBe("pong");
      await waitFor(() => seen.length === 1);
      expect(seen[0]).toEqual(tickParams(5));
      expect(all).toEqual(["tick"]);
      off();
      agent.push({ jsonrpc: "2.0", method: "tick", params: tickParams(6) });
      await waitFor(() => all.length === 2);
      expect(seen).toHaveLength(1);
    } finally {
      client.close();
    }
  });

  it("subscribes once, fans ticks out to every listener and unsubscribes after the last one", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    const a: number[] = [];
    const b: number[] = [];
    const offA = await session.subscribeTicks((t) => a.push(t.tick));
    const offB = await session.subscribeTicks((t) => b.push(t.tick), 2);
    if (!offA.ok || !offB.ok) throw new Error("subscribe failed");
    expect(agent.requests.filter((r) => r.method === "stream.subscribe")).toEqual([expect.objectContaining({ params: { every: 1 } })]);
    agent.push({ jsonrpc: "2.0", method: "tick", params: tickParams(1, 45) });
    // A malformed tick is dropped, not delivered half-parsed.
    agent.push({ jsonrpc: "2.0", method: "tick", params: { tick: 2 } });
    agent.push({ jsonrpc: "2.0", method: "tick", params: tickParams(3) });
    await waitFor(() => a.length === 2 && b.length === 2);
    expect(a).toEqual([1, 3]);
    expect(session.lastTick?.tick).toMatchObject({ tick: 3, position: [1, 64, 2], rotation: [10, 0], onGround: true, health: 20, selectedSlot: 3 });
    await offA.value();
    expect(agent.requests.some((r) => r.method === "stream.unsubscribe")).toBe(false);
    await offB.value();
    expect(agent.requests.at(-1)?.method).toBe("stream.unsubscribe");
    expect(session.lastTick).toBeUndefined();
  });

  it("resubscribes on a new connection after the agent dropped the old one", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    const ticks: number[] = [];
    expect((await session.subscribeTicks((t) => ticks.push(t.tick))).ok).toBe(true);
    agent.drop();
    await waitFor(() => !session.attached);
    expect((await session.subscribeTicks(() => undefined)).ok).toBe(true);
    expect(agent.requests.filter((r) => r.method === "stream.subscribe")).toHaveLength(2);
    agent.push({ jsonrpc: "2.0", method: "tick", params: tickParams(9) });
    await waitFor(() => ticks.includes(9));
  });

  it("sends input.look, input.move, input.release, input.attack and input.use with their params", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = (request) => {
      if (request.method === "input.look") return reply(request, request.params);
      if (request.method === "input.attack") return reply(request, { hit: "-4294967295" });
      return reply(request, {});
    };
    expect(await session.look(-30.5, 170)).toEqual({ ok: true, value: { pitch: -30.5, yaw: 170 } });
    expect((await session.move({ forward: 0.7, strafe: -0.7, sprint: true })).ok).toBe(true);
    expect((await session.release()).ok).toBe(true);
    expect(await session.attack()).toEqual({ ok: true, value: { hit: "-4294967295", target: null } });
    expect((await session.use(true)).ok).toBe(true);
    expect((await session.use()).ok).toBe(true);
    expect(agent.requests.map((r) => [r.method, r.params])).toEqual([
      ["input.look", { pitch: -30.5, yaw: 170 }],
      ["input.move", { forward: 0.7, strafe: -0.7, jump: false, sneak: false, sprint: true }],
      ["input.release", {}],
      ["input.attack", {}],
      ["input.use", { hold: true }],
      ["input.use", {}],
    ]);
  });

  it("rejects out-of-range input before sending and names the anchor of an unresolved method", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    expect(await session.look(91, 0)).toMatchObject({ ok: false, reason: "invalid_params" });
    expect(await session.move({ forward: 2 })).toMatchObject({ ok: false, reason: "invalid_params" });
    expect(agent.requests).toHaveLength(0);
    agent.handler = (request) => ({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "unresolved", data: { anchor: "MoveInputHandler" } } });
    expect(await session.move({ forward: 1 })).toMatchObject({ ok: false, reason: "anchor_missing", anchor: "MoveInputHandler" });
  });
});

describe("engine ui wrappers", () => {
  it("sends the contract method names and parameters", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = (request) => {
      if (request.method === "ui.screen") return reply(request, { name: "start_screen", stack: ["start_screen"], modal: false });
      if (request.method === "ui.controls") {
        return reply(request, { controls: [{ name: "play", type: "button", rect: [10, 20, 200, 40], text: "Play", enabled: true }] });
      }
      return reply(request, {});
    };
    const screen = await session.uiScreen();
    if (!screen.ok) throw new Error(screen.message);
    expect(screen.value).toEqual({ name: "start_screen", stack: ["start_screen"], modal: false });
    const controls = await session.uiControls("play");
    if (!controls.ok) throw new Error(controls.message);
    expect(controls.value).toEqual([{ name: "play", type: "button", rect: [10, 20, 200, 40], text: "Play", enabled: true }]);
    expect((await session.uiPress("play")).ok).toBe(true);
    expect((await session.uiKey("ctrl+a")).ok).toBe(true);
    expect((await session.uiKey("Escape", "down")).ok).toBe(true);
    expect((await session.uiText("hello")).ok).toBe(true);
    expect((await session.uiClick(10, 20, "right")).ok).toBe(true);
    expect((await session.uiScroll(10, 20, -3)).ok).toBe(true);
    expect(agent.requests.map((r) => [r.method, r.params])).toEqual([
      ["ui.screen", {}],
      ["ui.controls", { filter: "play" }],
      ["ui.press", { name: "play" }],
      ["ui.key", { key: "ctrl+a" }],
      ["ui.key", { key: "Escape", action: "down" }],
      ["ui.text", { text: "hello" }],
      ["ui.click", { x: 10, y: 20, button: "right" }],
      ["ui.scroll", { x: 10, y: 20, delta: -3 }],
    ]);
  });

  it("rejects what cannot be sent before opening a socket", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    expect(await session.uiKey("   ")).toMatchObject({ ok: false, reason: "invalid_params" });
    expect(await session.uiKey("ctrl+a+b+c+d")).toMatchObject({ ok: false, reason: "invalid_params" });
    expect(await session.uiKey("Escape", "tap" as UiKeyAction)).toMatchObject({ ok: false, reason: "invalid_params" });
    expect(await session.uiText("")).toMatchObject({ ok: false, reason: "invalid_params" });
    expect(await session.uiClick(Number.NaN, 1)).toMatchObject({ ok: false, reason: "invalid_params" });
    expect(await session.uiClick(-1, 1)).toMatchObject({ ok: false, reason: "invalid_params" });
    expect(await session.uiClick(1, 1, "middle" as never)).toMatchObject({ ok: false, reason: "invalid_params" });
    expect(await session.uiScroll(1, 1, 1.5)).toMatchObject({ ok: false, reason: "invalid_params" });
    expect(await session.uiScroll(1, 1, 0)).toMatchObject({ ok: false, reason: "invalid_params" });
    expect(await session.uiPress(" ")).toMatchObject({ ok: false, reason: "invalid_params" });
    expect(agent.requests).toHaveLength(0);
  });

  it("refuses an answer it cannot read instead of inventing a screen", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = (request) => reply(request, request.method === "ui.screen" ? { stack: [] } : { nonsense: true });
    expect(await session.uiScreen()).toMatchObject({ ok: false, reason: "protocol" });
    expect(await session.uiControls()).toMatchObject({ ok: false, reason: "protocol" });
  });
});

describe("engine settings wrapper", () => {
  it("sends settings.set and reads whether the game saved it", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = (request) => reply(request, { id: "gfx_viewdistance", previous: 24, value: 48, saved: false });
    const edit = await session.settingsSet("gfx_viewdistance", 48);
    if (!edit.ok) throw new Error(edit.message);
    expect(edit.value).toEqual({ id: "gfx_viewdistance", previous: 24, value: 48, saved: false });
    expect(agent.requests.map((r) => [r.method, r.params])).toEqual([["settings.set", { id: "gfx_viewdistance", value: 48 }]]);
  });

  it("leaves saved out when the agent does not report it, and refuses one that is not a boolean", async () => {
    const agent = await makeAgent();
    const session = makeSession(agent);
    agent.handler = (request) => reply(request, { id: "gfx_viewdistance", previous: null, value: 12 });
    const silent = await session.settingsSet("gfx_viewdistance", 12);
    if (!silent.ok) throw new Error(silent.message);
    expect(silent.value).not.toHaveProperty("saved");
    agent.handler = (request) => reply(request, { id: "gfx_viewdistance", previous: 12, value: 20, saved: "yes" });
    expect(await session.settingsSet("gfx_viewdistance", 20)).toMatchObject({ ok: false, reason: "protocol" });
  });
});
