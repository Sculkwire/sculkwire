/** One server run, and the logs of a stopped server turned into Diagnostics and a raw log. */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Diagnostic } from "../../core/diagnostic.ts";
import { dataDir } from "../../core/paths.ts";
import { entriesToDiagnostics, mergeEntries, parseConsole, parseContentLog, type IndexedPack, type LogEntry } from "../gamelog/logparse.ts";
import { contentLogFiles, type BdsInstance } from "./instance.ts";
import { BdsServer, START_TIMEOUT_MS } from "./server.ts";

export interface RunOutcome {
  status: "started" | "exited" | "timeout";
  server: BdsServer;
}

export async function runOnce(instance: BdsInstance, opts: { settleMs?: number; startTimeoutMs?: number } = {}): Promise<RunOutcome> {
  const server = new BdsServer(instance.dir);
  let status: RunOutcome["status"] = "started";
  try {
    await server.started(opts.startTimeoutMs ?? START_TIMEOUT_MS);
    await sleep(opts.settleMs ?? 0);
  } catch {
    status = server.state === "exited" ? "exited" : "timeout";
  }
  await server.stop();
  return { status, server };
}

export async function collectLogs(instance: BdsInstance, server: BdsServer): Promise<{ contentLog: string; entries: LogEntry[] }> {
  let contentLog = "";
  for (const f of await contentLogFiles(instance)) contentLog += await readFile(f, "utf8");
  const entries = mergeEntries(parseConsole(server.text()), parseContentLog(contentLog));
  return { contentLog, entries };
}

const KEEP_RUN_LOGS = 100;

/** Write the run's console + content log to `dataDir('bds-runs', <id>.log)`; keeps the newest 100 logs. */
async function writeRawLog(id: string, server: BdsServer, contentLog: string): Promise<string> {
  const dir = dataDir("bds-runs");
  const path = join(dir, `${id}.log`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${server.text().join("\n")}\n\n===== content log =====\n${contentLog}`);
  // Instance ids start with a UTC timestamp, so name order is age order.
  const logs = (await readdir(dir)).filter((n) => n.endsWith(".log")).sort();
  for (const old of logs.slice(0, Math.max(0, logs.length - KEEP_RUN_LOGS))) await rm(join(dir, old), { force: true });
  return path;
}

/** The version a server's findings name: the one it printed, else the installed one. */
export function serverVersionOf(server: BdsServer, instance: BdsInstance): string {
  return server.serverVersion ?? instance.install.version;
}

/** `BDS <version>`: the prefix of every Diagnostic a server's logs give. */
export function runLabel(serverVersion: string): string {
  return `BDS ${serverVersion}`;
}

export interface FinishedRun {
  serverVersion: string;
  label: string;
  /** Console and content-log findings mapped to pack files, baseline subtracted. */
  diagnostics: Diagnostic[];
  rawLogPath: string;
}

/** After the server stopped: its logs as Diagnostics, and the raw log kept after the instance is removed. */
export async function finishRun(run: { instance: BdsInstance; indexed: readonly IndexedPack[]; baseline: ReadonlySet<string> }, server: BdsServer): Promise<FinishedRun> {
  const { contentLog, entries } = await collectLogs(run.instance, server);
  const serverVersion = serverVersionOf(server, run.instance);
  const label = runLabel(serverVersion);
  const diagnostics = entriesToDiagnostics(entries, run.indexed, { baseline: run.baseline, label });
  const rawLogPath = await writeRawLog(run.instance.id, server, contentLog);
  return { serverVersion, label, diagnostics, rawLogPath };
}
