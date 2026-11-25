/**
 * Attaching to a game the user opened, with the in-game agent: a live setting that pops a confirmation dialog is
 * cancelled (never confirmed for the user), `websocket_encryption` is never set, and a game that requires encrypted
 * websockets gets the step to turn that off instead of a `/connect` dial. The agent is a fake on a loopback port.
 */
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Install from "../../gamefiles/install.ts";
import { optionsFiles, type ClientInstall } from "../../gamefiles/install.ts";
import type * as Launcher from "./launcher.ts";
import { ClientBridge, ENCRYPTED_STEP } from "./bridge.ts";
import { engine } from "../engine/engine.ts";
import { registerInputProvider, type EngineInput, type InputProvider } from "./inputprovider.ts";

let install: ClientInstall;
const stopGame = vi.fn(async () => ({ stopped: true, message: "must not run" }));

vi.mock("../../gamefiles/install.ts", async (original) => ({
  ...(await original<typeof Install>()),
  findInstall: async () => install,
}));
vi.mock("./launcher.ts", async (original) => ({
  ...(await original<typeof Launcher>()),
  stop: () => stopGame(),
  gamePids: async () => [process.pid],
}));

type Request = { id?: number; method?: string; params?: Record<string, unknown> };

/** The in-game agent of a game sitting on its start screen that requires encrypted websockets. */
interface FakeAgent {
  server: Server;
  port: number;
  requests: Request[];
}

async function fakeAgent(): Promise<FakeAgent> {
  const requests: Request[] = [];
  let screen = { name: "start_screen", stack: ["start_screen"], modal: false };
  const answer = (request: Request): unknown => {
    const params = request.params ?? {};
    switch (request.method) {
      case "engine.status":
        return { build: "1.26.60.30", hooked: true, tick: 1, resolved: {}, missing: [] };
      case "ui.screen":
        return screen;
      case "settings.set":
        // Turning websockets on asks the player to confirm, as the game's security settings do.
        if (params.id === "websockets_enabled" && params.value === true) screen = { name: "modal_screen", stack: ["start_screen", "modal_screen"], modal: true };
        return { id: params.id, previous: false, value: params.value };
      case "settings.get":
        return { id: params.id, type: "bool", value: true };
      case "ui.controls":
        return screen.modal
          ? [
              { name: "button.ok", type: "button", rect: [0, 0, 10, 10], text: "OK", enabled: true },
              { name: "button.cancel", type: "button", rect: [20, 0, 10, 10], text: "Cancel", enabled: true },
            ]
          : [];
      case "ui.press":
        if (params.name === "button.cancel") screen = { name: "start_screen", stack: ["start_screen"], modal: false };
        return { pressed: true };
      default:
        return {};
    }
  };
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const request = JSON.parse(line) as Request;
        requests.push(request);
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: answer(request) })}\n`);
      }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  return { server, port: address.port, requests };
}

/** An input provider whose attach is the engine's own (it reuses the fake agent listening on its port). */
const provider: InputProvider = {
  name: "test agent",
  input: {} as EngineInput,
  motion: () => undefined,
  pausedReason: () => undefined,
  hold: async () => async () => {},
  attach: async () => void (await engine.attach()),
  launched: async () => {},
  stopped: async () => engine.close(),
  close: () => engine.close(),
};

describe("attaching with the in-game agent", () => {
  let dir: string;
  let agent: FakeAgent;
  let unregister: () => void;
  let enginePort: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sw-bridge-attach-"));
    process.env.SCULKWIRE_DATA = join(dir, "data");
    process.env.SCULKWIRE_CONFIG = join(dir, "config");
    install = { kind: "custom", label: "fake", appData: dir, sharedComMojang: dir, userComMojang: dir, logsDir: join(dir, "logs"), wine: false, preview: false } as ClientInstall;
    const [options] = optionsFiles(install);
    if (!options) throw new Error("no options.txt path");
    await mkdir(join(options, ".."), { recursive: true });
    await writeFile(options, "websocket_encryption:1\ncontent_log_file:0\n");
    agent = await fakeAgent();
    enginePort = engine.port;
    Object.assign(engine, { port: agent.port });
    unregister = registerInputProvider(provider);
  });

  afterEach(async () => {
    unregister();
    engine.close();
    Object.assign(engine, { port: enginePort });
    agent.server.close();
    stopGame.mockClear();
    delete process.env.SCULKWIRE_DATA;
    delete process.env.SCULKWIRE_CONFIG;
    await rm(dir, { recursive: true, force: true });
  });

  it("cancels a confirmation a live setting opened, never sets websocket_encryption, and asks the user to turn encryption off", async () => {
    const bridge = new ClientBridge();
    const status = await bridge.start({ debuggerPort: 0, connectPort: 0, connect: true });
    try {
      const sets = agent.requests.filter((r) => r.method === "settings.set").map((r) => r.params?.id);
      expect(sets).toEqual(["websockets_enabled", "content_log_file"]);
      // The dialog was answered with Cancel by its control, never OK, and no Escape was needed.
      const presses = agent.requests.filter((r) => r.method === "ui.press").map((r) => r.params?.name);
      expect(presses).toEqual(["button.cancel"]);
      expect(agent.requests.some((r) => r.method === "ui.key")).toBe(false);
      expect(status.worldNote).toContain("could not set websockets_enabled live (the game asked to confirm the change (modal_screen)");
      expect(status.worldNote).toContain("content_log_file false -> true");
      expect(status.manualSteps).toContain(ENCRYPTED_STEP);
      expect(status.manualSteps.some((m) => m.startsWith("open a world"))).toBe(true);
      expect(agent.requests.some((r) => r.method === "ui.text")).toBe(false);
    } finally {
      const r = await bridge.stop();
      expect(r.detached).toBe(true);
    }
    expect(stopGame).not.toHaveBeenCalled();
  }, 20_000);
});
