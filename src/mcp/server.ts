import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { setBackgroundDownloads } from "../core/background.ts";
import { VERSION } from "../core/meta.ts";
import { runShutdown } from "../core/shutdown.ts";
import { loadExtensions, registerExtension } from "../extensions/index.ts";
import { FEATURES, wireFeatures } from "../features.ts";
import { autoUpdate } from "../update/auto.ts";

/** The server with every built-in feature, then the tools of every installed extension (`src/extensions/`). */
export async function createServer(): Promise<McpServer> {
  const server = new McpServer(
    { name: "sculkwire", version: VERSION },
    {
      capabilities: { logging: {} },
      instructions:
        "sculkwire: Minecraft Bedrock add-on development. Look up versioned docs, Script API, components and vanilla " +
        "examples before writing content; validate packs and fix every error by file and line; prove behaviour in the " +
        "game (BDS or client) with GameTest, content log and screenshots.",
    },
  );
  wireFeatures();
  for (const feature of FEATURES) feature.register?.(server);
  for (const ext of await loadExtensions()) registerExtension(server, ext);
  return server;
}

/** How long a closed stdin may keep the process alive: answering the requests already received, then flushing stdout. */
const STDIN_CLOSE_GRACE_MS = 30_000;

/**
 * The stdio transport, counting the requests it received and has not answered yet. A client may write its requests and
 * close stdin right away: the process then exits only after those answers are written (see `serveStdio`).
 */
class AnsweringStdioTransport extends StdioServerTransport {
  readonly #pending = new Set<string | number>();
  #waiters: (() => void)[] = [];

  override async start(): Promise<void> {
    // `Protocol.connect` sets `onmessage` before it calls `start`.
    const handle = this.onmessage;
    this.onmessage = (message: JSONRPCMessage) => {
      if ("method" in message && "id" in message) this.#pending.add(message.id);
      else if ("method" in message && message.method === "notifications/cancelled") {
        // A cancelled request is never answered.
        const id = message.params?.requestId;
        if (typeof id === "string" || typeof id === "number") this.#settle(id);
      }
      handle?.(message);
    };
    return super.start();
  }

  override async send(message: JSONRPCMessage): Promise<void> {
    await super.send(message);
    if (("result" in message || "error" in message) && "id" in message && message.id !== undefined) this.#settle(message.id);
  }

  /** Resolves once every request received so far is answered (its answer handed to stdout). */
  answered(): Promise<void> {
    if (this.#pending.size === 0) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#waiters.push(resolve);
    return promise;
  }

  #settle(id: string | number): void {
    if (!this.#pending.delete(id) || this.#pending.size > 0) return;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}

export async function serveStdio(): Promise<void> {
  const server = await createServer();
  // Long-lived: newer builds the daily pins name are downloaded in the background for later calls.
  setBackgroundDownloads(true);
  const transport = new AnsweringStdioTransport();
  await server.connect(transport);
  // A managed install checks for an update in the background (at most once a day). Never awaited: startup and tool
  // calls do not wait for the network, and the running session keeps its version.
  void autoUpdate({ notify: (data) => server.server.sendLoggingMessage({ level: "notice", logger: "sculkwire", data }) });
  // The agent client went away: stop anything sculkwire started (the game, BDS) before exiting.
  const exit = () => void runShutdown().finally(() => process.exit(0));
  let closing = false;
  const stdinClosed = () => {
    if (closing) return;
    closing = true;
    // The client may still read stdout: answer what it already asked, then let stdout hand every byte to the pipe
    // (a slow reader leaves them buffered in this process), bounded so a hung tool cannot keep the process alive.
    const { promise: done, resolve: finish } = Promise.withResolvers<void>();
    setTimeout(finish, STDIN_CLOSE_GRACE_MS);
    void transport.answered().then(() => process.stdout.write("", () => finish()));
    void done.then(exit);
  };
  process.stdin.once("end", stdinClosed);
  process.stdin.once("close", stdinClosed);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, exit);
}
