/**
 * `sculk update`: install the newest version of the configured channel into the managed layout and switch to it.
 * Only Node built-ins and dependency-free modules are imported: `bootstrap.ts` runs this from a fresh clone.
 */
import type { CliCommand } from "../core/cli.ts";
import { ExitCode } from "../core/diagnostic.ts";
import { isChannel, readChannel, saveChannel } from "./config.ts";
import {
  type Channel,
  checkoutRemote,
  codeRoot,
  DEFAULT_REPO,
  detectRunning,
  initLayout,
  layout,
  platformLauncher,
  readCurrent,
  readInstall,
  rollback,
  type Running,
  update,
} from "./install.ts";

const USAGE = [
  "usage: sculk update [--check] [--channel release|main|off] [--rollback]",
  "       sculk update --install [--repo <git url>] [--channel release|main]",
  "",
  "  --check      report whether a newer version exists, install nothing",
  "  --channel    save the update channel (release tags, the main branch, or off for no automatic updates)",
  "  --rollback   switch back to the version before the last update",
  "  --install    create the managed install (used by install.sh and install.ps1), print the launcher path",
].join("\n");

interface Args {
  check: boolean;
  rollback: boolean;
  install: boolean;
  channel?: Channel;
  repo?: string;
}

function parse(args: string[]): Args | string {
  const out: Args = { check: false, rollback: false, install: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") out.check = true;
    else if (arg === "--rollback") out.rollback = true;
    else if (arg === "--install") out.install = true;
    else if (arg === "--channel" || arg === "--repo") {
      const value = args[++i];
      if (!value) return `${arg} needs a value`;
      if (arg === "--repo") out.repo = value;
      else if (isChannel(value)) out.channel = value;
      else return `unknown channel ${value}`;
    } else return `unknown argument ${arg}`;
  }
  if (out.repo && !out.install) return "--repo only applies to --install";
  if (out.rollback && (out.check || out.install)) return "--rollback cannot be combined with --check or --install";
  return out;
}

const say = (line: string) => process.stdout.write(`${line}\n`);

async function install(args: Args): Promise<number> {
  const l = layout();
  const repo = args.repo ?? (await readInstall(l))?.repo ?? (await checkoutRemote(codeRoot())) ?? DEFAULT_REPO;
  await initLayout(l, repo);
  const channel = args.channel ?? (await readChannel());
  const result = await update(l, { channel: channel === "main" ? "main" : "release", repo });
  if (result.action === "no-release") {
    process.stderr.write(`${repo} has no release tag (vX.Y.Z) yet. Install the main branch with --channel main.\n`);
    return ExitCode.usage;
  }
  process.stderr.write(
    result.action === "updated" ? `sculkwire ${result.current} installed in ${l.root}\n` : `sculkwire ${result.current} is already installed in ${l.root}\n`,
  );
  say(platformLauncher(l));
  return ExitCode.ok;
}

export async function runUpdate(argv: string[], running: Running = detectRunning()): Promise<number> {
  const args = parse(argv);
  if (typeof args === "string") {
    process.stderr.write(`${args}\n${USAGE}\n`);
    return ExitCode.usage;
  }
  if (args.channel) {
    const path = await saveChannel(args.channel);
    process.stderr.write(`Saved update channel ${args.channel} in ${path}\n`);
  }
  try {
    if (args.install) return await install(args);
    if (!running.managed) {
      say(`${running.root} is a development checkout and does not update itself.`);
      say(`Update it with: git -C ${JSON.stringify(running.root)} pull && npm install`);
      return ExitCode.ok;
    }
    const l = running.managed.layout;
    if (args.rollback) {
      const r = await rollback(l);
      say(`Switched to ${r.current} (was ${r.previous ?? "none"}). New sessions start ${r.current}; restart running MCP sessions to use it.`);
      return ExitCode.ok;
    }
    const channel = await readChannel();
    if (channel === "off" && args.channel === "off" && !args.check) {
      say("Automatic updates are off. `sculk update` still installs the newest release when you run it.");
      return ExitCode.ok;
    }
    const result = await update(l, { channel, check: args.check });
    const current = result.current ?? (await readCurrent(l));
    switch (result.action) {
      case "no-release":
        say(`No release found. Current: ${current ?? "none"}.`);
        break;
      case "up-to-date":
        say(`sculkwire ${current} is the newest version on the ${channel} channel.`);
        break;
      case "available":
        say(`sculkwire ${result.latest} is available (current ${current}). Run \`sculk update\` to install it.`);
        break;
      case "updated":
        say(`sculkwire ${result.current} installed (was ${result.previous ?? "none"}). Restart your MCP sessions to use it. \`sculk update --rollback\` switches back.`);
        break;
    }
    return ExitCode.ok;
  } catch (err) {
    process.stderr.write(`sculk update: ${err instanceof Error ? err.message : String(err)}\n`);
    return ExitCode.findings;
  }
}

export const commands: CliCommand[] = [
  {
    name: "update",
    summary: "Update a managed install to the newest release (--check, --channel, --rollback)",
    run: (args) => runUpdate(args),
  },
];
