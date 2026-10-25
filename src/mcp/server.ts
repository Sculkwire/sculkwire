import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setBackgroundDownloads } from "../core/background.ts";
import { VERSION } from "../core/meta.ts";
import { runShutdown } from "../core/shutdown.ts";
import { register as decision } from "../decision/mcp.ts";
import { loadExtensions, registerExtension } from "../extensions/index.ts";
import { register as gamefiles } from "../gamefiles/mcp.ts";
import { register as knowledge } from "../knowledge/mcp.ts";
import { register as bds } from "../runtime/bds/mcp.ts";
import { register as game } from "../runtime/client/mcp.ts";
import { autoUpdate } from "../update/auto.ts";
import { register as update } from "../update/mcp.ts";
import { register as validate } from "../validate/mcp.ts";

/**
 * Contract for feature modules: `src/<feature>/mcp.ts` exports `register(server)`, which calls
 * `server.registerTool` / `server.registerResource` with zod input schemas and returns structured content.
 */
export type RegisterFeature = (server: McpServer) => void;

const FEATURES: RegisterFeature[] = [knowledge, validate, bds, game, gamefiles, decision, update];

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
  for (const register of FEATURES) register(server);
  for (const ext of await loadExtensions()) registerExtension(server, ext);
  return server;
}

export async function serveStdio(): Promise<void> {
  const server = await createServer();
  // Long-lived: newer builds the daily pins name are downloaded in the background for later calls.
  setBackgroundDownloads(true);
  await server.connect(new StdioServerTransport());
  // A managed install checks for an update in the background (at most once a day). Never awaited: startup and tool
  // calls do not wait for the network, and the running session keeps its version.
  void autoUpdate({ notify: (data) => server.server.sendLoggingMessage({ level: "notice", logger: "sculkwire", data }) });
  const exit = (code: number) => {
    // The agent client went away: stop anything sculkwire started (the game, BDS) before exiting.
    void runShutdown().finally(() => process.exit(code));
  };
  process.stdin.once("end", () => exit(0));
  process.stdin.once("close", () => exit(0));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => exit(0));
}
