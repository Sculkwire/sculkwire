import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { err, out, type CliCommand } from "../../core/cli.ts";
import { ExitCode, exitCodeFor, formatDiagnostic, summarize } from "../../core/diagnostic.ts";
import { errorMessage, UsageError } from "../../core/errors.ts";
import { bench } from "./bench/cli.ts";
import { bridge, WORLD_WAIT_MAX_S } from "./bridge.ts";
import { clientDiagnostics, indexProjectPacks, readSince } from "./contentlog.ts";
import { findInstall, findInstalls, pickInstall, type ClientInstall } from "../../gamefiles/install.ts";
import { gamePids, readLaunchState } from "./launcher.ts";
import { listWorlds } from "./world.ts";
import { deleteWorld, listAllWorlds, WorldRefused, worldLine } from "./worldstore.ts";

function print(json: boolean, value: unknown, text: string): void {
  out(json ? JSON.stringify(value, null, 2) : text);
}

const status: CliCommand = {
  name: "game status",
  summary: "Client installs found (launcher, version), whether the game runs, sculkwire test worlds",
  async run(args) {
    const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
    const installs = await findInstalls();
    const install = pickInstall(installs);
    const state = await readLaunchState();
    const pids = await gamePids(install);
    const worlds = await listWorlds(install);
    const value = { install, installs, running: pids.length > 0, pids, launch: state, worlds: worlds.map((w) => w.name) };
    const describe = (i: ClientInstall) =>
      `${i.label}: ${i.version ?? "version unknown"}${i.preview ? " preview" : ""}, ` +
      `${i.launch ? "sculkwire launches it" : "you start the game"}, data ${i.appData}`;
    print(!!values.json, value, [
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
    print(!!values.json, { diagnostics, summary: s }, [...diagnostics.map(formatDiagnostic), `${s.errors} error(s), ${s.warnings} warning(s)`].join("\n"));
    return exitCodeFor(diagnostics);
  },
};

const check: CliCommand = {
  name: "game check",
  summary:
    "Load a project in the real client, collect errors, optional screenshot: game check <dir> [--display window|headless|desktop] [--mute] [--seconds 10] [--screenshot out.png] [--beta-apis] [--world-wait 180]",
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
        "world-wait": { type: "string" },
      },
    });
    const project = positionals[0];
    if (!project) throw new UsageError(this.summary);
    const display = values.display;
    if (display !== undefined && display !== "window" && display !== "headless" && display !== "desktop") {
      throw new UsageError("--display must be window, headless or desktop");
    }
    const worldWait = values["world-wait"] === undefined ? undefined : Number(values["world-wait"]);
    if (worldWait !== undefined && !(Number.isInteger(worldWait) && worldWait >= 10 && worldWait <= WORLD_WAIT_MAX_S)) {
      throw new UsageError(`--world-wait must be whole seconds from 10 to ${WORLD_WAIT_MAX_S}`);
    }
    err("launching the client (1-2 min)...");
    try {
      const st = await bridge.start({
        project,
        ...(display ? { mode: display } : {}),
        ...(values.mute ? { mute: true } : {}),
        betaApis: !!values["beta-apis"],
        ...(worldWait !== undefined ? { timeoutMs: worldWait * 1000 } : {}),
      });
      err(`in world ${st.world}; debugger ${st.debugger.attached ? "attached" : "not attached"}, /connect clients ${st.connect.clients}`);
      await sleep(Number(values.seconds ?? 10) * 1000);
      const shot = values.screenshot ? await bridge.screenshot(values.screenshot) : undefined;
      const { diagnostics } = await bridge.logs({ printSeq: 0 });
      const s = summarize(diagnostics);
      print(!!values.json, { status: st, diagnostics, summary: s, screenshot: shot }, [
        ...diagnostics.map(formatDiagnostic),
        `${s.errors} error(s), ${s.warnings} warning(s)${shot ? `; screenshot ${shot.path}` : ""}`,
      ].join("\n"));
      return exitCodeFor(diagnostics);
    } catch (e) {
      err(errorMessage(e));
      return ExitCode.usage;
    } finally {
      await bridge.stop();
    }
  },
};

const worlds: CliCommand = {
  name: "game worlds",
  summary: "Every world of the active game user, or delete one sculkwire test world: game worlds [--json] | game worlds --delete <name>",
  async run(args) {
    const { values } = parseArgs({ args, options: { json: { type: "boolean" }, delete: { type: "string" } } });
    const install = await findInstall();
    const state = await readLaunchState();
    const loaded = state?.world !== undefined && (await gamePids(install)).length > 0 ? state.world : undefined;
    if (values.delete !== undefined) {
      try {
        const deleted = await deleteWorld(install, values.delete, loaded !== undefined ? { loaded } : {});
        print(!!values.json, { deleted }, deleted.existed ? `deleted ${deleted.world} (${deleted.levelIds.join(", ")})` : `no world ${deleted.world}`);
        return deleted.existed ? ExitCode.ok : ExitCode.findings;
      } catch (e) {
        if (!(e instanceof WorldRefused)) throw e;
        err(e.message);
        return ExitCode.usage;
      }
    }
    const all = await listAllWorlds(install);
    const value = all.map((w) => ({ ...w, lastPlayed: w.lastPlayed.toISOString(), loaded: w.levelId === loaded }));
    print(!!values.json, { worlds: value }, all.map((w) => worldLine(w, loaded)).join("\n") || `no worlds in ${install.label}`);
    return ExitCode.ok;
  },
};

const stop: CliCommand = {
  name: "game stop",
  summary: "Stop the client and restore the options.txt keys sculkwire changed",
  async run() {
    const r = await bridge.stop();
    out(r.stopped ? "stopped" : `not stopped: ${r.message}`);
    return r.stopped ? ExitCode.ok : ExitCode.usage;
  },
};

export const commands: CliCommand[] = [status, log, check, worlds, stop, bench];
