#!/usr/bin/env node
import { backgroundDownloadsAllowed, exitAfterGrace } from "./core/background.ts";
import type { CliCommand } from "./core/cli.ts";
import { ExitCode } from "./core/diagnostic.ts";
import { VERSION } from "./core/meta.ts";
import { commands as decisionCommands } from "./decision/cli.ts";
import { loadExtensions } from "./extensions/index.ts";
import { commands as gamefilesCommands } from "./gamefiles/cli.ts";
import { commands as knowledgeCommands } from "./knowledge/cli.ts";
import { serveStdio } from "./mcp/server.ts";
import { commands as bdsCommands } from "./runtime/bds/cli.ts";
import { commands as gameCommands } from "./runtime/client/cli.ts";
import { commands as engineCommands } from "./runtime/engine/cli.ts";
import { commands as updateCommands } from "./update/cli.ts";
import { commands as validateCommands } from "./validate/cli.ts";
import { useKnowledgeProviders } from "./validate/providers.ts";

const BUILTIN: CliCommand[] = [
  {
    name: "mcp",
    summary: "Run the MCP server over stdio",
    async run() {
      await serveStdio();
      return ExitCode.ok;
    },
  },
  ...knowledgeCommands,
  ...validateCommands,
  ...bdsCommands,
  ...gameCommands,
  ...engineCommands,
  ...gamefilesCommands,
  ...decisionCommands,
  ...updateCommands,
];

function usage(commands: readonly CliCommand[]): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  return [
    `sculk ${VERSION}: Minecraft Bedrock add-on development toolkit`,
    "",
    "Usage: sculk <command> [args]",
    "",
    ...commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
  ].join("\n");
}

/** Longest command name that prefixes argv wins, so `knowledge update` beats `knowledge`; a built-in wins a tie. */
function resolve(commands: readonly CliCommand[], argv: string[]): { command: CliCommand; rest: string[] } | undefined {
  let best: { command: CliCommand; rest: string[] } | undefined;
  for (const command of commands) {
    const words = command.name.split(" ");
    if (words.every((w, i) => argv[i] === w) && (!best || words.length > best.command.name.split(" ").length)) {
      best = { command, rest: argv.slice(words.length) };
    }
  }
  return best;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return ExitCode.ok;
  }
  // Built-in commands, then every installed extension's (`src/extensions/`).
  const commands = [...BUILTIN, ...(await loadExtensions()).flatMap((ext) => ext.commands ?? [])];
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(`${usage(commands)}\n`);
    return ExitCode.ok;
  }
  const hit = resolve(commands, argv);
  if (!hit) {
    process.stderr.write(`unknown command: ${argv.join(" ")}\n\n${usage(commands)}\n`);
    return ExitCode.usage;
  }
  useKnowledgeProviders();
  return hit.command.run(hit.rest);
}

main(process.argv.slice(2))
  .then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = ExitCode.usage;
    },
  )
  // A short-lived command does not wait for background metadata refreshes; `sculk mcp` keeps running.
  .finally(() => {
    if (!backgroundDownloadsAllowed()) exitAfterGrace();
  });
