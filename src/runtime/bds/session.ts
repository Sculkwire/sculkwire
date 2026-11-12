/**
 * Long-lived BDS sessions: one server per session id, packs symlinked from the project (edit + `reload`),
 * stdin commands with collected output, cursor-based logs, and a script debugger attached at level load
 * (`script-debugger-auto-attach=listen` on a private port; the console `script debugger listen` command drops
 * inbound connections on BDS 1.26.63.1, so the auto-attach listener is the reliable inbound path).
 * A Regolith project whose profile runs filters is built with rgl first and the world links the build output;
 * `reload` builds again into the same dirs, so edits to the sources apply.
 */
import { cp, rm } from "node:fs/promises";
import { formatDiagnostic, type Diagnostic } from "../../core/diagnostic.ts";
import { DebuggerSession, connectTo } from "../debugger/session.ts";
import { disposeBuild, indexProject, prepareInstance, projectPacks, writeRawLog, type BdsRunOptions, type ProjectPacks } from "./check.ts";
import { disposeInstance, freeTcpPort, type BdsInstance } from "./instance.ts";
import { entriesToDiagnostics, mergeEntries, parseConsole, type IndexedPack } from "../gamelog/logparse.ts";
import { BdsServer, type ConsoleLine } from "./server.ts";
import { collectLogs } from "./template.ts";

export interface BdsSession {
  id: string;
  projectRoot: string;
  /** The packs the world loads, with the Regolith build they come from. */
  project: ProjectPacks;
  packMode: "copy" | "symlink";
  rglPath?: string;
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

export function info(s: BdsSession): SessionInfo {
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
    packs: s.indexed.map((p) => ({ name: p.pack.name ?? p.pack.uuid ?? p.folder ?? "", kind: p.pack.kind, path: p.pack.relDir || "." })),
    startedAt: new Date(s.startedAt).toISOString(),
  };
}

export function getSession(id: string): BdsSession {
  const s = sessions.get(id);
  if (!s) throw new Error(`no BDS session ${id}; running: ${[...sessions.keys()].join(", ") || "none"}`);
  return s;
}

export function listSessions(): SessionInfo[] {
  return [...sessions.values()].map(info);
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
  const { instance, baseline, indexed } = await prepareInstance(project, { ...opts, packMode, properties }).catch(async (err: unknown) => {
    await disposeBuild(project, opts.keep);
    throw err;
  });
  const server = new BdsServer(instance.dir);
  const session: BdsSession = {
    id: instance.id,
    projectRoot: project.root,
    project,
    packMode,
    ...(opts.rglPath ? { rglPath: opts.rglPath } : {}),
    instance,
    server,
    indexed,
    baseline,
    debuggerPort,
    startedAt: Date.now(),
    keep: opts.keep ?? false,
  };
  sessions.set(session.id, session);
  const timeoutMs = opts.startTimeoutMs ?? 180_000;
  const attach = wantDebugger
    ? connectTo("127.0.0.1", debuggerPort, { timeoutMs }).then(
        (d) => {
          session.debugger = d;
        },
        (err: unknown) => {
          session.debuggerError = err instanceof Error ? err.message : String(err);
        },
      )
    : Promise.resolve();
  try {
    await server.started(timeoutMs);
  } catch (err) {
    sessions.delete(session.id);
    await server.stop(5000);
    const tail = server.lines.slice(-30).map((l) => l.text).join("\n");
    if (!opts.keep) await disposeInstance(instance);
    await disposeBuild(project, opts.keep);
    throw new Error(`BDS session did not start: ${err instanceof Error ? err.message : String(err)}\n${tail}`);
  }
  await attach;
  // Let the post-start banner (telemetry notice) flush so it does not land in the first command's output.
  await server.quiet(server.lines.length, { quietMs: 300, maxMs: 3000 });
  server.once("exit", () => session.debugger?.close());
  return info(session);
}

export interface CommandResult {
  lines: ConsoleLine[];
  via: "console" | "debugger";
}

/**
 * Run a command. Console (stdin) by default; output = console lines until it goes quiet. `via: "debugger"`
 * runs it through the script debugger as `minecraftCommand` (output arrives as `[Scripting]` console lines).
 */
export async function sessionCommand(
  id: string,
  command: string,
  opts: { via?: "console" | "debugger"; quietMs?: number; maxMs?: number; dimension?: string } = {},
): Promise<CommandResult> {
  const s = getSession(id);
  if (opts.via === "debugger") {
    if (!s.debugger || s.debugger.closed) throw new Error(`session ${id} has no attached script debugger${s.debuggerError ? `: ${s.debuggerError}` : ""}`);
    const from = s.server.lines.length;
    s.debugger.command(command, opts.dimension);
    return { lines: await s.server.quiet(from, { quietMs: opts.quietMs, maxMs: opts.maxMs, needOutput: true }), via: "debugger" };
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
  const lines = s.server.lines.filter((l) => l.seq > since).slice(0, limit);
  const entries = mergeEntries(parseConsole(lines.map((l) => l.text)));
  const diagnostics = entriesToDiagnostics(entries, s.indexed, { baseline: s.baseline, label: `BDS ${s.server.serverVersion ?? ""}`.trim() });
  return { lines, next: lines.at(-1)?.seq ?? since, diagnostics };
}

/**
 * Build a Regolith session's project again and replace the build output its world links to (symlink mode only; a
 * copied world stays frozen). Throws with the build Diagnostic when rgl fails; the world keeps the previous build.
 */
async function rebuild(s: BdsSession): Promise<void> {
  const build = s.project.build;
  if (!build || s.packMode !== "symlink") return;
  const fresh = await projectPacks(s.projectRoot, s.rglPath ? { rglPath: s.rglPath } : {});
  if (fresh.failure) throw new Error(`reload not run, the previous build stays loaded: ${formatDiagnostic(fresh.failure)}`);
  try {
    const freshBySource = new Map(fresh.loadable.map((p) => [fresh.build?.sources.get(p.dir)?.dir ?? p.dir, p.dir]));
    for (const [builtDir, source] of build.sources) {
      const next = freshBySource.get(source.dir);
      if (!next) continue;
      await rm(builtDir, { recursive: true, force: true });
      await cp(next, builtDir, { recursive: true });
    }
  } finally {
    await disposeBuild(fresh, false);
  }
  s.indexed = await indexProject(s.project, s.instance.packs);
}

/**
 * `reload` (functions + scripts) or `reload all` (also rejoins the world and reloads all packs). A Regolith
 * session is rebuilt first, so the reload loads the edited sources.
 */
export async function reloadSession(id: string, all = false): Promise<CommandResult> {
  await rebuild(getSession(id));
  return sessionCommand(id, all ? "reload all" : "reload", { quietMs: 800, maxMs: 15_000 });
}

export interface StopResult {
  exitCode: number | null;
  rawLogPath: string;
  diagnostics: Diagnostic[];
}

export async function stopSession(id: string): Promise<StopResult> {
  const s = getSession(id);
  sessions.delete(id);
  s.debugger?.close();
  const exitCode = await s.server.stop();
  const { contentLog, entries } = await collectLogs(s.instance, s.server);
  const diagnostics = entriesToDiagnostics(entries, s.indexed, { baseline: s.baseline, label: `BDS ${s.server.serverVersion ?? ""}`.trim() });
  const rawLogPath = await writeRawLog(s.instance.id, s.server, contentLog);
  if (!s.keep) await disposeInstance(s.instance);
  await disposeBuild(s.project, s.keep);
  return { exitCode, rawLogPath, diagnostics };
}

/** Stop every running session (MCP server shutdown). */
export async function stopAllSessions(): Promise<void> {
  for (const id of [...sessions.keys()]) await stopSession(id).catch(() => undefined);
}
