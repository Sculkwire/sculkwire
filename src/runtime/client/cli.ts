import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { CliCommand } from "../../core/cli.ts";
import { ExitCode, exitCodeFor, formatDiagnostic, summarize } from "../../core/diagnostic.ts";
import { bench } from "./bench/cli.ts";
import { bridge } from "./bridge.ts";
import { clientDiagnostics, indexProjectPacks, readSince } from "./contentlog.ts";
import { findInstall, findInstalls, type ClientInstall } from "./install.ts";
import { gamePids, readLaunchState } from "./launcher.ts";
import { listWorlds } from "./world.ts";

function out(json: boolean, value: unknown, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
}

const status: CliCommand = {
  name: "game status",
  summary: "Client installs found (launcher, version), whether the game runs, sculkwire test worlds",
  async run(args) {
    const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
    const installs = await findInstalls();
    const install = await findInstall();
    const state = await readLaunchState();
    const pids = await gamePids(install);
    const worlds = await listWorlds(install);
    const value = { install, installs, running: pids.length > 0, pids, launch: state, worlds: worlds.map((w) => w.name) };
    const describe = (i: ClientInstall) =>
      `${i.label}: ${i.version ?? "version unknown"}${i.preview ? " preview" : ""}, ` +
      `${i.launch ? "sculkwire launches it" : "you start the game"}, data ${i.appData}`;
    out(!!values.json, value, [
      `using ${describe(install)}`,
      ...installs.filter((i) => i.appData !== install.appData).map((i) => `also found ${describe(i)}`),
      `running: ${pids.length > 0 ? `yes (pid ${pids.join(", ")}${state ? `, ${state.mode}` : ""})` : "no"}`,
      `test worlds: ${worlds.map((w) => w.name).join(", ") || "none"}`,
    ].join("\n"));
    return ExitCode.ok;
  },
};

const log: CliCommand = {
  name: "game log",
  summary: "Newest client content log as diagnostics: game log [--project <dir>] [--json]",
  async run(args) {
    const { values } = parseArgs({ args, options: { json: { type: "boolean" }, project: { type: "string" } } });
    const install = await findInstall();
    const { text } = await readSince(install.logsDir);
    const packs = values.project ? await indexProjectPacks(values.project, install.sharedComMojang) : [];
    const diagnostics = clientDiagnostics(text, packs);
    const s = summarize(diagnostics);
    out(!!values.json, { diagnostics, summary: s }, [...diagnostics.map(formatDiagnostic), `${s.errors} error(s), ${s.warnings} warning(s)`].join("\n"));
    return exitCodeFor(diagnostics);
  },
};

const check: CliCommand = {
  name: "game check",
  summary:
    "Load a project in the real client, collect errors, optional screenshot: game check <dir> [--display window|headless|desktop] [--mute] [--seconds 10] [--screenshot out.png] [--beta-apis]",
  async run(args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        seconds: { type: "string" },
        screenshot: { type: "string" },
        display: { type: "string" },
        mute: { type: "boolean" },
        "beta-apis": { type: "boolean" },
      },
    });
    const project = positionals[0];
    if (!project) {
      process.stderr.write(`${this.summary}\n`);
      return ExitCode.usage;
    }
    process.stderr.write("launching the client (1-2 min)...\n");
    try {
      const display = values.display;
      if (display !== undefined && display !== "window" && display !== "headless" && display !== "desktop") {
        process.stderr.write(`--display must be window, headless or desktop\n`);
        return ExitCode.usage;
      }
      const st = await bridge.start({
        project,
        ...(display ? { mode: display } : {}),
        ...(values.mute ? { mute: true } : {}),
        betaApis: !!values["beta-apis"],
      });
      process.stderr.write(`in world ${st.world}; debugger ${st.debugger.attached ? "attached" : "not attached"}, /connect clients ${st.connect.clients}\n`);
      await sleep(Number(values.seconds ?? 10) * 1000);
      const shot = values.screenshot ? await bridge.screenshot(values.screenshot) : undefined;
      const { diagnostics } = await bridge.logs({ printSeq: 0 });
      const s = summarize(diagnostics);
      out(!!values.json, { status: st, diagnostics, summary: s, screenshot: shot }, [
        ...diagnostics.map(formatDiagnostic),
        `${s.errors} error(s), ${s.warnings} warning(s)${shot ? `; screenshot ${shot.path}` : ""}`,
      ].join("\n"));
      return exitCodeFor(diagnostics);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return ExitCode.usage;
    } finally {
      await bridge.stop();
    }
  },
};

const stop: CliCommand = {
  name: "game stop",
  summary: "Stop the client and restore the options.txt keys sculkwire changed",
  async run() {
    const r = await bridge.stop();
    process.stdout.write(`${r.stopped ? "stopped" : `not stopped: ${r.message}`}\n`);
    return r.stopped ? ExitCode.ok : ExitCode.usage;
  },
};

export const commands: CliCommand[] = [status, log, check, stop, bench];
