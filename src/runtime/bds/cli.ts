import { createInterface } from "node:readline";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { err as log, out, type CliCommand } from "../../core/cli.ts";
import { ExitCode, exitCodeFor, formatDiagnostic, summarize } from "../../core/diagnostic.ts";
import { errorMessage, PrerequisiteError, UsageError } from "../../core/errors.ts";
import { isChannel, type Channel } from "../../core/version.ts";
import { bdsCheck, describeCheck } from "./check.ts";
import { describeGameTest, runGameTests } from "./gametest.ts";
import { installBds, listInstalled } from "./install.ts";
import { followSession, sessionCommand, startSession, stopSession } from "./session.ts";

function parse<T extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: T, usage: string) {
  try {
    return parseArgs({ args, options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(`${errorMessage(err)}\nusage: ${usage}`);
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

/** `; kept <folder>` for a run whose instance was kept, else empty. */
function keptText(r: { instanceDir?: string }): string {
  return r.instanceDir ? `; kept ${r.instanceDir}` : "";
}

/** Shared error → exit code mapping: usage and prerequisite errors are 2. */
async function guarded(usage: string, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof UsageError) {
      log(err.message);
      return ExitCode.usage;
    }
    if (err instanceof PrerequisiteError) {
      log(`prerequisite: ${err.message}`);
      return ExitCode.usage;
    }
    log(`${errorMessage(err)}\nusage: ${usage}`);
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
          out(INSTALL_USAGE);
          return ExitCode.ok;
        }
        const r = await installBds({ channel: channelOf(values.channel), acceptEula: values["accept-eula"], force: values.force, log });
        const installed = await listInstalled();
        if (values.json) out(JSON.stringify({ ...r, installed }, null, 2));
        else out(`${r.channel} ${r.version} ${r.dir}${r.downloaded ? "" : " (already installed)"}`);
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
          out(CHECK_USAGE);
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
        // The CLI's exit code is the process's own; the JSON keeps the keys it always had.
        const { exitCode, ...result } = r;
        if (values.json) out(JSON.stringify({ ...result, summary: summarize(r.diagnostics) }, null, 2));
        else for (const d of r.diagnostics) out(formatDiagnostic(d));
        log(r.status === "build-failed" ? describeCheck(r) : `${describeCheck(r)}; log ${r.rawLogPath}${keptText(r)}`);
        return exitCode;
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
          out(GAMETEST_USAGE);
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
        if (values.json) out(JSON.stringify(r, null, 2));
        else {
          for (const t of r.results) out(`${t.result.toUpperCase().padEnd(9)} ${t.name}${t.error ? `: ${t.error}` : ""}`);
          for (const d of r.diagnostics) out(formatDiagnostic(d));
        }
        const head = describeGameTest(r, [`${r.durationMs} ms`]);
        log(head ? `${head}; log ${r.rawLogPath}${keptText(r)}` : "GameTest not run: the Regolith build failed");
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
          out(RUN_USAGE);
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
        const exited = followSession(info.id, (l) => out(l.text));
        log(`session ${info.id}: join localhost:${info.port}; type commands, \`stop\` or Ctrl+C to quit`);
        const rl = createInterface({ input: process.stdin });
        const { promise, resolve } = Promise.withResolvers<void>();
        rl.on("line", (line) => {
          if (/^\/?stop\s*$/.test(line.trim())) resolve();
          else if (line.trim()) sessionCommand(info.id, line.trim()).catch((e: unknown) => log(errorMessage(e)));
        });
        rl.on("close", () => resolve());
        process.once("SIGINT", () => resolve());
        void exited.then(() => resolve());
        await promise;
        rl.close();
        const r = await stopSession(info.id);
        for (const d of r.diagnostics) log(formatDiagnostic(d));
        log(`stopped (exit ${r.exitCode}); log ${r.rawLogPath}${keptText(r)}`);
        return exitCodeFor(r.diagnostics);
      }),
  },
];
