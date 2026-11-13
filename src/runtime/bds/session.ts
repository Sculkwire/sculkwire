/**
 * Long-lived BDS sessions: one server per session id, packs symlinked from the project (edit + `reload`),
 * stdin commands with collected output, cursor-based logs, and a script debugger attached at level load
 * (`script-debugger-auto-attach=listen` on a private port; the console `script debugger listen` command drops
 * inbound connections on BDS 1.26.63.1, so the auto-attach listener is the reliable inbound path).
 * For a Regolith project whose profile runs filters the world links what rgl last built; `rgl watch` rewrites those
 * folders in place, so a `reload` loads the edited sources. sculkwire does not run rgl.
 */
import { rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatDiagnostic, type Diagnostic } from "../../core/diagnostic.ts";
import { errorMessage } from "../../core/errors.ts";
import { summarizeProfile, type ProfileSummary } from "../debugger/profile.ts";
import { DebuggerSession, connectTo } from "../debugger/session.ts";
import { entriesToDiagnostics, mergeEntries, parseConsole, type IndexedPack } from "../gamelog/logparse.ts";
import { dirLinkType, freeTcpPort, type BdsInstance } from "./instance.ts";
import { disposeRun, indexProject, prepareInstance, projectPacks, withKept, type BdsRunOptions, type KeptRun, type ProjectPacks } from "./project.ts";
import { finishRun, runLabel, serverVersionOf } from "./run.ts";
import { BdsServer, START_TIMEOUT_MS, type ConsoleLine } from "./server.ts";

export interface BdsSession {
  id: string;
  projectRoot: string;
  /** The packs the world loads, with rgl's output they come from for a filtered Regolith profile. */
  project: ProjectPacks;
  packMode: "copy" | "symlink";
  instance: BdsInstance;
  server: BdsServer;
  indexed: IndexedPack[];
  baseline: Set<string>;
  debugger?: DebuggerSession;
  debuggerError?: string;
  debuggerPort: number;
  startedAt: number;
  keep: boolean;
}

export interface SessionInfo {
  id: string;
  state: BdsServer["state"];
  serverVersion: string;
  projectRoot: string;
  instanceDir: string;
  /** UDP port clients can join on (`localhost:<port>`). */
  port: number;
  debugger: { attached: boolean; port: number; protocolVersion?: number; error?: string };
  /** `path` is the pack folder relative to `projectRoot`, `.` when the project folder is itself the pack. */
  packs: { name: string; kind: string; path: string }[];
  startedAt: string;
}

const sessions = new Map<string, BdsSession>();

export function sessionPacks(indexed: readonly IndexedPack[]): SessionInfo["packs"] {
  return indexed.map((p) => ({ name: p.pack.name ?? p.pack.uuid ?? p.folder ?? "", kind: p.pack.kind, path: p.pack.relDir || "." }));
}

function info(s: BdsSession): SessionInfo {
  const dbg: SessionInfo["debugger"] = { attached: !!s.debugger && !s.debugger.closed, port: s.debuggerPort };
  if (s.debugger?.info) dbg.protocolVersion = s.debugger.info.version;
  if (s.debuggerError) dbg.error = s.debuggerError;
  return {
    id: s.id,
    state: s.server.state,
    serverVersion: s.server.serverVersion ?? s.instance.install.version,
    projectRoot: s.projectRoot,
    instanceDir: s.instance.dir,
    port: s.instance.port,
    debugger: dbg,
    packs: sessionPacks(s.indexed),
    startedAt: new Date(s.startedAt).toISOString(),
  };
}

function getSession(id: string): BdsSession {
  const s = sessions.get(id);
  if (!s) throw new Error(`no BDS session ${id}; running: ${[...sessions.keys()].join(", ") || "none"}`);
  return s;
}

function requireDebugger(s: BdsSession): DebuggerSession {
  if (!s.debugger || s.debugger.closed) throw new Error(`session ${s.id} has no attached script debugger${s.debuggerError ? `: ${s.debuggerError}` : ""}`);
  return s.debugger;
}

export interface StartOptions extends BdsRunOptions {
  /** `symlink` (default) so `reload` picks up edits; `copy` to freeze the packs. */
  packMode?: "copy" | "symlink";
  /** Attach the script debugger (default true). */
  debugger?: boolean;
  startTimeoutMs?: number;
}

export async function startSession(path: string, opts: StartOptions = {}): Promise<SessionInfo> {
  const project = await projectPacks(path, opts);
  if (project.failure) throw new Error(`BDS session not started: ${formatDiagnostic(project.failure)}`);
  const debuggerPort = await freeTcpPort();
  const wantDebugger = opts.debugger !== false;
  const properties: Record<string, string> = wantDebugger
    ? {
        "script-debugger-auto-attach": "listen",
        "force-inbound-debug-port": String(debuggerPort),
        "script-debugger-auto-attach-timeout": "30",
      }
    : {};
  const packMode = opts.packMode ?? "symlink";
  const { instance, baseline, indexed } = await prepareInstance(project, { ...opts, packMode, properties });
  const server = new BdsServer(instance.dir);
  const session: BdsSession = {
    id: instance.id,
    projectRoot: project.root,
    project,
    packMode,
    instance,
    server,
    indexed,
    baseline,
    debuggerPort,
    startedAt: Date.now(),
    keep: opts.keep ?? false,
  };
  sessions.set(session.id, session);
  const timeoutMs = opts.startTimeoutMs ?? START_TIMEOUT_MS;
  const attaching = new AbortController();
  const attach = wantDebugger
    ? connectTo("127.0.0.1", debuggerPort, { timeoutMs, signal: attaching.signal }).then(
        (d) => {
          session.debugger = d;
        },
        (err: unknown) => {
          session.debuggerError = errorMessage(err);
        },
      )
    : Promise.resolve();
  try {
    await server.started(timeoutMs);
  } catch (err) {
    attaching.abort();
    sessions.delete(session.id);
    await server.stop(5000);
    await disposeRun(instance, opts.keep);
    throw new Error(`BDS session did not start: ${errorMessage(err)}\n${server.tail()}`);
  }
  await attach;
  // Let the post-start banner (telemetry notice) flush so it does not land in the first command's output.
  await server.quiet(server.lines.length, { quietMs: 300, maxMs: 3000 });
  server.once("exit", () => session.debugger?.close());
  return info(session);
}

/** Print every console line of the session, past and future; resolves when the server exits. */
export function followSession(id: string, onLine: (line: ConsoleLine) => void): Promise<number | null> {
  const { server } = getSession(id);
  for (const l of server.lines) onLine(l);
  server.on("line", onLine);
  return server.exited;
}

export interface CommandResult {
  lines: ConsoleLine[];
  via: "console" | "debugger";
}

const RELOAD_RE = /^\/?reload(\s+all)?\s*$/;

/**
 * Run a command. Console (stdin) by default; output = console lines until it goes quiet. `via: "debugger"`
 * runs it through the script debugger as `minecraftCommand` (output arrives as `[Scripting]` console lines).
 * `reload` (functions + scripts) and `reload all` (also rejoins the world and reloads all packs) on the console
 * first make a Regolith session's world follow rgl's current output (`followRegolithOutput`).
 */
export async function sessionCommand(
  id: string,
  command: string,
  opts: { via?: "console" | "debugger"; quietMs?: number; maxMs?: number; dimension?: string } = {},
): Promise<CommandResult> {
  const s = getSession(id);
  if (opts.via === "debugger") {
    const dbg = requireDebugger(s);
    const from = s.server.lines.length;
    dbg.command(command, opts.dimension);
    return { lines: await s.server.quiet(from, { quietMs: opts.quietMs, maxMs: opts.maxMs, needOutput: true }), via: "debugger" };
  }
  const reload = RELOAD_RE.exec(command);
  if (reload) {
    await followRegolithOutput(s);
    return { lines: await s.server.command(reload[1] ? "reload all" : "reload", { quietMs: 800, maxMs: 15_000 }), via: "console" };
  }
  return { lines: await s.server.command(command, opts), via: "console" };
}

export interface LogsResult {
  lines: ConsoleLine[];
  /** Pass as `since` for the next call. */
  next: number;
  diagnostics: Diagnostic[];
}

/** Console lines with `seq > since` (max `limit`, oldest first) and the diagnostics they contain. */
export function sessionLogs(id: string, since = 0, limit = 500): LogsResult {
  const s = getSession(id);
  // `seq` is the 1-based index of a line, so the lines after `since` start at index `since`.
  const lines = s.server.lines.slice(since, since + limit);
  const entries = mergeEntries(parseConsole(lines.map((l) => l.text)));
  const diagnostics = entriesToDiagnostics(entries, s.indexed, { baseline: s.baseline, label: runLabel(serverVersionOf(s.server, s.instance)) });
  return { lines, next: lines.at(-1)?.seq ?? since, diagnostics };
}

/**
 * Before a `reload` of a Regolith session (symlink mode only; a copied world stays frozen): look up what rgl last
 * built again. `rgl watch` rewrites its output folders in place, so the world's links usually stay; when an output
 * folder moved (another profile ran), the world's link for that pack is pointed at the new one. Only the links in
 * the world change, never rgl's output. Throws with the `regolith.not-built` Diagnostic when the output is gone;
 * the session then stays as it was.
 */
export async function followRegolithOutput(s: Pick<BdsSession, "projectRoot" | "project" | "packMode" | "instance" | "indexed">): Promise<void> {
  const build = s.project.build;
  if (!build || s.packMode !== "symlink") return;
  const fresh = await projectPacks(s.projectRoot);
  if (fresh.failure) throw new Error(`reload not run, the session keeps the packs it loaded: ${formatDiagnostic(fresh.failure)}`);
  const freshBySource = new Map(fresh.loadable.map((p) => [fresh.build?.sources.get(p.dir)?.dir ?? p.dir, p]));
  for (const loaded of s.instance.packs) {
    const source = build.sources.get(loaded.pack.dir);
    const next = source ? freshBySource.get(source.dir) : undefined;
    if (!next || next.dir === loaded.pack.dir) continue;
    // The world entry is a link: removing it leaves the folder it pointed at alone.
    await rm(loaded.worldPath, { force: true });
    await symlink(resolve(next.dir), loaded.worldPath, dirLinkType(process.platform));
    loaded.pack = next;
  }
  s.project = fresh;
  s.indexed = await indexProject(s.project, s.instance.packs);
}

export type ProfileResult = { action: "start" } | ({ action: "capture" | "stop" } & ProfileSummary);

/**
 * The script profiler over the session's debugger: `start`, `stop` (the top `limit` functions), or `capture`
 * (start, run `command`, wait `durationMs`, stop).
 */
export async function sessionProfile(
  id: string,
  opts: { action: "capture" | "start" | "stop"; durationMs: number; command?: string; limit: number },
): Promise<ProfileResult> {
  const dbg = requireDebugger(getSession(id));
  if (opts.action === "start") {
    dbg.startProfiler();
    return { action: "start" };
  }
  if (opts.action === "capture") {
    dbg.startProfiler();
    if (opts.command) dbg.command(opts.command);
    await sleep(opts.durationMs);
  }
  const capture = await dbg.stopProfiler();
  return { action: opts.action, ...summarizeProfile(capture.profile, opts.limit) };
}

export interface StopResult {
  exitCode: number | null;
  rawLogPath: string;
  diagnostics: Diagnostic[];
  /** Where the kept instance folder is, when the session was started with `keep`. */
  instanceDir?: string;
}

export async function stopSession(id: string): Promise<StopResult> {
  const s = getSession(id);
  sessions.delete(id);
  s.debugger?.close();
  let result: StopResult;
  let kept: KeptRun | undefined;
  try {
    const exitCode = await s.server.stop();
    const { diagnostics, rawLogPath } = await finishRun(s, s.server);
    result = { exitCode, rawLogPath, diagnostics };
  } finally {
    kept = await disposeRun(s.instance, s.keep);
  }
  return withKept(result, kept);
}

/** Stop every running session (MCP server shutdown). */
export async function stopAllSessions(): Promise<void> {
  for (const id of [...sessions.keys()]) await stopSession(id).catch(() => undefined);
}
