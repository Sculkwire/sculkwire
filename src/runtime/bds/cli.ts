import { createInterface } from "node:readline";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type { CliCommand } from "../../core/cli.ts";
import { ExitCode, exitCodeFor, formatDiagnostic, summarize } from "../../core/diagnostic.ts";
import { isChannel, type Channel } from "../../core/version.ts";
import { bdsCheck } from "./check.ts";
import { runGameTests } from "./gametest.ts";
import { installBds, listInstalled, PrerequisiteError } from "./install.ts";
import { getSession, startSession, stopSession } from "./session.ts";

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

class UsageError extends Error {}

function parse<T extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: T, usage: string) {
  try {
    return parseArgs({ args, options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(`${err instanceof Error ? err.message : String(err)}\nusage: ${usage}`);
  }
}

function channelOf(value: unknown): Channel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isChannel(value)) throw new UsageError(`--channel must be stable or preview, got ${String(value)}`);
  return value;
}

function intOf(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${name} must be a non-negative integer`);
  return n;
}

/** Shared error → exit code mapping: usage and prerequisite errors are 2. */
async function guarded(usage: string, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return ExitCode.usage;
    }
    if (err instanceof PrerequisiteError) {
      process.stderr.write(`prerequisite: ${err.message}\n`);
      return ExitCode.usage;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\nusage: ${usage}\n`);
    return ExitCode.usage;
  }
}

const COMMON = {
  channel: { type: "string" },
  "accept-eula": { type: "boolean" },
  json: { type: "boolean" },
  keep: { type: "boolean" },
} as const;

const INSTALL_USAGE = "sculk bds install [--channel stable|preview] [--accept-eula] [--force] [--json]";
const CHECK_USAGE = "sculk bds check <path> [--channel stable|preview] [--settle <ms>] [--keep] [--accept-eula] [--json]";
const GAMETEST_USAGE =
  "sculk bds gametest <path> [--tag <tag>]... [--mode automation|command] [--timeout <ms>] [--channel stable|preview] [--keep] [--accept-eula] [--json]";
const RUN_USAGE = "sculk bds run <path> [--channel stable|preview] [--copy] [--no-debugger] [--accept-eula]";

export const commands: CliCommand[] = [
  {
    name: "bds install",
    summary: "Download Bedrock Dedicated Server (Linux or Windows x64) for a channel into the cache",
    run: (args) =>
      guarded(INSTALL_USAGE, async () => {
        const { values } = parse(args, { ...COMMON, force: { type: "boolean" } }, INSTALL_USAGE);
        if (values.help) {
          process.stdout.write(`${INSTALL_USAGE}\n`);
          return ExitCode.ok;
        }
        const r = await installBds({ channel: channelOf(values.channel), acceptEula: values["accept-eula"], force: values.force, log });
        const installed = await listInstalled();
        if (values.json) process.stdout.write(`${JSON.stringify({ ...r, installed }, null, 2)}\n`);
        else process.stdout.write(`${r.channel} ${r.version} ${r.dir}${r.downloaded ? "" : " (already installed)"}\n`);
        return ExitCode.ok;
      }),
  },
  {
    name: "bds check",
    summary: "Load packs into a disposable BDS and report content-log errors by file and line",
    run: (args) =>
      guarded(CHECK_USAGE, async () => {
        const { values, positionals } = parse(args, { ...COMMON, settle: { type: "string" } }, CHECK_USAGE);
        if (values.help) {
          process.stdout.write(`${CHECK_USAGE}\n`);
          return ExitCode.ok;
        }
        if (positionals.length !== 1) throw new UsageError(`expected one path\nusage: ${CHECK_USAGE}`);
        const r = await bdsCheck(positionals[0]!, {
          channel: channelOf(values.channel),
          settleMs: intOf(values.settle, "--settle"),
          keep: values.keep,
          acceptEula: values["accept-eula"],
          log,
        });
        const summary = summarize(r.diagnostics);
        if (values.json) process.stdout.write(`${JSON.stringify({ ...r, summary }, null, 2)}\n`);
        else for (const d of r.diagnostics) process.stdout.write(`${formatDiagnostic(d)}\n`);
        if (r.status === "build-failed") log(`Regolith build failed, BDS not started: ${summary.errors} error(s)`);
        else log(`BDS ${r.serverVersion} ${r.status}: ${summary.errors} error(s), ${summary.warnings} warning(s) in ${r.durationMs} ms; log ${r.rawLogPath}`);
        return exitCodeFor(r.diagnostics);
      }),
  },
  {
    name: "bds gametest",
    summary: "Run GameTests headlessly on BDS; exit 1 when a test fails",
    run: (args) =>
      guarded(GAMETEST_USAGE, async () => {
        const { values, positionals } = parse(
          args,
          { ...COMMON, tag: { type: "string", multiple: true }, mode: { type: "string" }, timeout: { type: "string" } },
          GAMETEST_USAGE,
        );
        if (values.help) {
          process.stdout.write(`${GAMETEST_USAGE}\n`);
          return ExitCode.ok;
        }
        if (positionals.length !== 1) throw new UsageError(`expected one path\nusage: ${GAMETEST_USAGE}`);
        if (values.mode !== undefined && values.mode !== "automation" && values.mode !== "command") {
          throw new UsageError("--mode must be automation or command");
        }
        const r = await runGameTests(positionals[0]!, {
          tags: values.tag,
          mode: values.mode,
          timeoutMs: intOf(values.timeout, "--timeout"),
          channel: channelOf(values.channel),
          keep: values.keep,
          acceptEula: values["accept-eula"],
          log,
        });
        if (values.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        else {
          for (const t of r.results) process.stdout.write(`${t.result.toUpperCase().padEnd(9)} ${t.name}${t.error ? `: ${t.error}` : ""}\n`);
          for (const d of r.diagnostics) process.stdout.write(`${formatDiagnostic(d)}\n`);
        }
        if (r.serverVersion) log(`GameTest ${r.passed}/${r.total} passed, ${r.failed} failed (BDS ${r.serverVersion}, ${r.mode}, ${r.durationMs} ms); log ${r.rawLogPath}`);
        else log("GameTest not run: the Regolith build failed");
        return r.exitCode;
      }),
  },
  {
    name: "bds run",
    summary: "Run BDS with the packs attached; stdin lines are server commands, console goes to stdout",
    run: (args) =>
      guarded(RUN_USAGE, async () => {
        const { values, positionals } = parse(
          args,
          { channel: COMMON.channel, "accept-eula": COMMON["accept-eula"], keep: COMMON.keep, copy: { type: "boolean" }, "no-debugger": { type: "boolean" } },
          RUN_USAGE,
        );
        if (values.help) {
          process.stdout.write(`${RUN_USAGE}\n`);
          return ExitCode.ok;
        }
        if (positionals.length !== 1) throw new UsageError(`expected one path\nusage: ${RUN_USAGE}`);
        const info = await startSession(positionals[0]!, {
          channel: channelOf(values.channel),
          packMode: values.copy ? "copy" : "symlink",
          debugger: !values["no-debugger"],
          keep: values.keep,
          acceptEula: values["accept-eula"],
          log,
        });
        const session = getSession(info.id);
        for (const l of session.server.lines) process.stdout.write(`${l.text}\n`);
        session.server.on("line", (l: { text: string }) => process.stdout.write(`${l.text}\n`));
        log(`session ${info.id}: join localhost:${info.port}; type commands, \`stop\` or Ctrl+C to quit`);
        const rl = createInterface({ input: process.stdin });
        const { promise, resolve } = Promise.withResolvers<void>();
        rl.on("line", (line) => {
          if (/^\/?stop\s*$/.test(line.trim())) resolve();
          else if (line.trim()) session.server.write(line.trim());
        });
        rl.on("close", () => resolve());
        process.once("SIGINT", () => resolve());
        session.server.once("exit", () => resolve());
        await promise;
        rl.close();
        const r = await stopSession(info.id);
        for (const d of r.diagnostics) log(formatDiagnostic(d));
        log(`stopped (exit ${r.exitCode}); log ${r.rawLogPath}`);
        return exitCodeFor(r.diagnostics);
      }),
  },
];
