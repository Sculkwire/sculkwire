/**
 * The built-in features, in the order `sculk --help` and `tools/list` show them. A feature registers its MCP tools
 * (`src/<feature>/mcp.ts`) and lists its CLI commands (`src/<feature>/cli.ts`); `src/cli.ts` and `src/mcp/server.ts`
 * read this list. Extensions (`src/extensions/`) come after it.
 */
import type { Extension } from "./extensions/index.ts";
import { commands as gamefilesCommands } from "./gamefiles/cli.ts";
import { register as gamefilesTools } from "./gamefiles/mcp.ts";
import { commands as knowledgeCommands } from "./knowledge/cli.ts";
import { register as knowledgeTools } from "./knowledge/mcp.ts";
import { registerStoreSource } from "./knowledge/store.ts";
import { commands as bdsCommands } from "./runtime/bds/cli.ts";
import { register as bdsTools } from "./runtime/bds/mcp.ts";
import { bdsStoreSource } from "./runtime/bds/store.ts";
import { installAgentProvider } from "./runtime/client/agentprovider.ts";
import { bridge } from "./runtime/client/bridge.ts";
import { commands as gameCommands } from "./runtime/client/cli.ts";
import { register as gameTools } from "./runtime/client/mcp.ts";
import { commands as engineCommands } from "./runtime/engine/cli.ts";
import type { EngineDeps } from "./runtime/engine/deps.ts";
import { register as engineTools } from "./runtime/engine/mcp.ts";
import { commands as setupCommands } from "./setup/cli.ts";
import { commands as updateCommands } from "./update/cli.ts";
import { register as updateTools } from "./update/mcp.ts";
import { commands as validateCommands } from "./validate/cli.ts";
import { register as validateTools } from "./validate/mcp.ts";
import { useKnowledgeProviders } from "./validate/providers.ts";

/** The engine sits under the game client: it reaches the helper pack and the loaded world through the client bridge. */
const engineDeps: EngineDeps = {
  script: {
    query: (kind, params) => bridge.query(kind, params),
    loadedWorld: () => {
      const world = bridge.world;
      return bridge.running && world ? { levelId: world.levelId, name: world.name } : undefined;
    },
  },
};

/** A built-in feature has the shape of an extension: a name, its MCP tools, its CLI commands. */
export const FEATURES: Extension[] = [
  { name: "knowledge", register: knowledgeTools, commands: knowledgeCommands },
  { name: "validate", register: validateTools, commands: validateCommands },
  { name: "bds", register: bdsTools, commands: bdsCommands },
  { name: "game client", register: gameTools, commands: gameCommands },
  { name: "engine", register: (server) => engineTools(server, engineDeps), commands: engineCommands(engineDeps) },
  { name: "gamefiles", register: gamefilesTools, commands: gamefilesCommands },
  { name: "setup", commands: setupCommands },
  { name: "update", register: updateTools, commands: updateCommands },
];

let wired = false;

/**
 * Connects the features to each other, once per process, before any tool or command runs: the validator reads the
 * knowledge cache, `sculk knowledge update` and `knowledge status` cover the installed BDS builds, and the in-game
 * agent is the built-in input provider of `player_act` and `sculk bench`.
 */
export function wireFeatures(): void {
  if (wired) return;
  wired = true;
  useKnowledgeProviders();
  registerStoreSource(bdsStoreSource);
  installAgentProvider();
}
