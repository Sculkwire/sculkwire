/**
 * `attach` reuses an agent that already listens on the session's port (loaded by an earlier attach, in this process or
 * another) and never builds or injects again: the injector refuses a DLL that is already loaded in the game.
 */
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Install from "../../gamefiles/install.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { EngineSession } from "./engine.ts";

const { buildAgent, injectAgent } = vi.hoisted(() => ({
  buildAgent: vi.fn(async () => {
    throw new Error("build must not run");
  }),
  injectAgent: vi.fn(async () => {
    throw new Error("inject must not run");
  }),
}));

vi.mock("../../gamefiles/install.ts", async (original) => ({
  ...(await original<typeof Install>()),
  findInstall: async () => ({ kind: "custom", label: "fake", appData: "/x", sharedComMojang: "/x", userComMojang: "/x", logsDir: "/x", wine: false, preview: false }) as ClientInstall,
}));
vi.mock("./build.ts", () => ({ buildAgent }));
vi.mock("./inject.ts", () => ({ injectAgent }));

/** An agent already loaded in the game: answers `engine.status` on a loopback port. */
async function loadedAgent(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const request = JSON.parse(line) as { id?: number };
        const result = { build: "1.26.60.30", hooked: true, tick: 1, resolved: {}, missing: [] };
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  return { server, port: address.port };
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanup.splice(0)) done();
});

describe("engine attach", () => {
  it("reuses an agent already listening on its port instead of injecting again", async () => {
    const { server, port } = await loadedAgent();
    const session = new EngineSession({ port });
    cleanup.push(() => session.close(), () => void server.close());
    const status = await session.attach();
    expect(status).toMatchObject({ build: "1.26.60.30", hooked: true });
    expect(session.attached).toBe(true);
    expect(buildAgent).not.toHaveBeenCalled();
    expect(injectAgent).not.toHaveBeenCalled();
  });
});
