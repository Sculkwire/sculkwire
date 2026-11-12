/**
 * The built-in features, in the order `sculk --help` and `tools/list` show them. A feature registers its MCP tools
 * (`src/<feature>/mcp.ts`) and lists its CLI commands (`src/<feature>/cli.ts`); `src/cli.ts` and `src/mcp/server.ts`
 * read this list. Extensions (`src/extensions/`) come after it.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CliCommand } from "./core/cli.ts";
import { commands as gamefilesCommands } from "./gamefiles/cli.ts";
import { register as gamefilesTools } from "./gamefiles/mcp.ts";
import { commands as knowledgeCommands } from "./knowledge/cli.ts";
import { register as knowledgeTools } from "./knowledge/mcp.ts";
import { commands as bdsCommands } from "./runtime/bds/cli.ts";
import { register as bdsTools } from "./runtime/bds/mcp.ts";
import { installAgentProvider } from "./runtime/client/agentprovider.ts";
import { commands as gameCommands } from "./runtime/client/cli.ts";
import { register as gameTools } from "./runtime/client/mcp.ts";
import { commands as engineCommands } from "./runtime/engine/cli.ts";
import { register as engineTools } from "./runtime/engine/mcp.ts";
import { commands as setupCommands } from "./setup/cli.ts";
import { commands as updateCommands } from "./update/cli.ts";
import { register as updateTools } from "./update/mcp.ts";
import { commands as validateCommands } from "./validate/cli.ts";
import { register as validateTools } from "./validate/mcp.ts";
import { useKnowledgeProviders } from "./validate/providers.ts";

export interface Feature {
  name: string;
  /** Registers the feature's MCP tools. */
  register?(server: McpServer): void;
  /** CLI commands, listed in `sculk --help`. */
  commands?: CliCommand[];
}

export const FEATURES: Feature[] = [
  { name: "knowledge", register: knowledgeTools, commands: knowledgeCommands },
  { name: "validate", register: validateTools, commands: validateCommands },
  { name: "bds", register: bdsTools, commands: bdsCommands },
  { name: "game client", register: gameTools, commands: gameCommands },
  { name: "engine", register: engineTools, commands: engineCommands },
  { name: "gamefiles", register: gamefilesTools, commands: gamefilesCommands },
  { name: "setup", commands: setupCommands },
  { name: "update", register: updateTools, commands: updateCommands },
];

let wired = false;

/**
 * Connects the features to each other, once per process, before any tool or command runs: the validator reads the
 * knowledge cache, and the in-game agent is the built-in input provider of `player_act` and `sculk bench`.
 */
export function wireFeatures(): void {
  if (wired) return;
  wired = true;
  useKnowledgeProviders();
  installAgentProvider();
}
