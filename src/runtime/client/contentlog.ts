/**
 * Client content log (`%APPDATA%/Minecraft Bedrock/logs/ContentLog<date>_1.txt`, lines `HH:MM:SS[Area][level]-msg`):
 * incremental reads from a byte offset, client path normalisation, and mapping to Diagnostics (source `client`)
 * against the project's packs, using the shared BDS log mapper.
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "../../core/diagnostic.ts";
import { compareDiagnostics } from "../../core/diagnostic.ts";
import { discoverProject } from "../../core/project.ts";
import type { PackInfo } from "../../core/project.ts";
import { entriesToDiagnostics, indexPack, NOISE, normalizeMessage, parseContentLog } from "../bds/logparse.ts";
import type { IndexedPack, LogEntry } from "../bds/logparse.ts";
import { parseLocations, type PrintEvent } from "../debugger/print.ts";
import { listDevPacks, packDisplayName } from "./deploy.ts";

export interface LogPosition {
  file: string;
  offset: number;
}

const CONTENT_LOG = /^ContentLog.*\.txt$/;
const DEBUG_LOG = /^Debug_Log.*\.txt$/;

/** Newest file in the logs directory whose name matches `pattern`, by modification time. */
async function latestLog(logsDir: string, pattern: RegExp): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(logsDir);
  } catch {
    return undefined;
  }
  let best: { file: string; mtime: number } | undefined;
  for (const n of names) {
    if (!pattern.test(n)) continue;
    const file = join(logsDir, n);
    const s = await stat(file);
    if (!best || s.mtimeMs > best.mtime) best = { file, mtime: s.mtimeMs };
  }
  return best?.file;
}

async function endOf(logsDir: string, pattern: RegExp): Promise<LogPosition | undefined> {
  const file = await latestLog(logsDir, pattern);
  if (!file) return undefined;
  return { file, offset: (await stat(file)).size };
}

/** Newest `ContentLog*.txt` in the logs directory (one per launch). */
export async function latestContentLog(logsDir: string): Promise<string | undefined> {
  return latestLog(logsDir, CONTENT_LOG);
}

/** Current end of the newest content log: entries after this position are "new". */
export async function logEnd(logsDir: string): Promise<LogPosition | undefined> {
  return endOf(logsDir, CONTENT_LOG);
}

/** `Debug_Log<date>.txt`, one per launch: the engine log, which carries network and level-transition lines the content log does not. */
export async function latestDebugLog(logsDir: string): Promise<string | undefined> {
  return latestLog(logsDir, DEBUG_LOG);
}

/** Current end of the newest engine log (`Debug_Log*.txt`). */
export async function debugLogEnd(logsDir: string): Promise<LogPosition | undefined> {
  return endOf(logsDir, DEBUG_LOG);
}

/**
 * Text written since `from` (or the whole newest log). When the game started a new log file in between, reads the
 * new file from its start. Cuts at the last newline so a half-written entry is read next time.
 */
export async function readSince(logsDir: string, from?: LogPosition): Promise<{ text: string; end: LogPosition | undefined }> {
  return readLogSince(logsDir, CONTENT_LOG, from);
}

/** Engine-log counterpart of `readSince` (`Debug_Log*.txt`). */
export async function readDebugLogSince(logsDir: string, from?: LogPosition): Promise<{ text: string; end: LogPosition | undefined }> {
  return readLogSince(logsDir, DEBUG_LOG, from);
}

async function readLogSince(logsDir: string, pattern: RegExp, from?: LogPosition): Promise<{ text: string; end: LogPosition | undefined }> {
  const file = await latestLog(logsDir, pattern);
  if (!file) return { text: "", end: undefined };
  const start = from && from.file === file ? from.offset : 0;
  const size = (await stat(file)).size;
  if (size <= start) return { text: "", end: { file, offset: start } };
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const cut = buf.lastIndexOf(0x0a);
    if (cut < 0) return { text: "", end: { file, offset: start } };
    return { text: buf.subarray(0, cut + 1).toString("utf8"), end: { file, offset: start + cut + 1 } };
  } finally {
    await fh.close();
  }
}

/** `[2026-11-08 20:49:12:490 ERROR SCRIPTING 376 324] [Scripting] message`: an engine-log line, here one mirroring the content log. */
const ENGINE_LINE_RE = /^\[\d{4}-\d\d-\d\d (\d\d:\d\d:\d\d):\d+ (ERROR|WARN|INFO|VERBOSE|DEBUG) ([A-Z_]+) \d+ \d+\] (.*)$/;
/** Content-log areas are single capitalised words (`Scripting`, `Json`, `SpawnRules`, `UI`). */
const AREA_RE = /^\[([A-Z][A-Za-z]*)\] ?(.*)$/;
/** Engine subsystems whose bracketed tags are not content-log areas (`[Client]`, `[Server]`, `[PendingAppearance]`). */
const NOT_CONTENT_LOG: Record<string, true> = { LEVELTRANSITION: true, PERSONA: true, NETWORK: true, PLATFORM: true, XBOXLIVE: true };
const CONTENT_LEVEL: Record<string, string> = { ERROR: "error", WARN: "warning", INFO: "inform", VERBOSE: "verbose", DEBUG: "verbose" };

/**
 * The content-log entries an engine-log (`Debug_Log`) text mirrors, rewritten as content-log text
 * (`HH:MM:SS[Area][level]-message`, continuation lines kept, entries separated by a blank line) so the content-log
 * parser reads them unchanged. Other engine lines are dropped.
 */
export function contentLogFromDebugLog(text: string): string {
  const out: string[] = [];
  let open = false;
  for (const line of text.split(/\r?\n/)) {
    const m = ENGINE_LINE_RE.exec(line);
    if (m) {
      const area = NOT_CONTENT_LOG[m[3]!] ? undefined : AREA_RE.exec(m[4]!);
      if (open) out.push("");
      open = !!area;
      if (area) out.push(`${m[1]}[${area[1]}][${CONTENT_LEVEL[m[2]!]}]-${area[2]}`);
      continue;
    }
    if (!line.trim()) {
      if (open) out.push("");
      open = false;
      continue;
    }
    if (open) out.push(line);
  }
  if (open) out.push("");
  return out.length ? `${out.join("\n")}\n` : "";
}

/**
 * Content-log text written since `from`, read live. The game buffers its `ContentLog*.txt` and writes it in blocks (the
 * rest at exit, or never when the game is killed), so entries such as a missing script main file are not in it yet
 * right after launch. The engine log (`Debug_Log*.txt`) is written line by line and mirrors every content-log entry,
 * so it is read instead, falling back to the content log file when there is no engine log.
 */
export async function readContentSince(logsDir: string, from?: LogPosition): Promise<{ text: string; end: LogPosition | undefined }> {
  const engineLog = await readDebugLogSince(logsDir, from);
  if (engineLog.end) return { text: contentLogFromDebugLog(engineLog.text), end: engineLog.end };
  return readSince(logsDir, from);
}

/** Where `readContentSince` reads on from: the end of the newest engine log, else of the newest content log. */
export async function contentEnd(logsDir: string): Promise<LogPosition | undefined> {
  return (await debugLogEnd(logsDir)) ?? (await logEnd(logsDir));
}

const COM_MOJANG_RE = /(?:%APPDATA%|[A-Za-z]:\/users\/[^/]+\/AppData\/Roaming)\/Minecraft Bedrock\/Users\/[^/]+\/games\/com\.mojang\//gi;
const PACK_PIPE_RE = /\b(development_(?:behavior|resource)_packs|behavior_packs|resource_packs)\/([^/|]+?) \| ([\w\-./]+\.(?:json|mcfunction|js|lang|material))/g;

/**
 * Client messages name files as `%APPDATA%/…/com.mojang/development_behavior_packs/<Folder> | blocks/x.json | …`.
 * Drop the user-specific prefix and join folder and file into one path the mapper understands.
 */
export function normalizeClientMessage(message: string): string {
  return message.replace(COM_MOJANG_RE, "").replace(PACK_PIPE_RE, "$1/$2/$3");
}

export function parseClientLog(text: string, keepInfo = false): LogEntry[] {
  return parseContentLog(text, keepInfo).map((e) => ({ ...e, message: normalizeClientMessage(e.message) }));
}

/** Engine-log lines of the deeplink join racing Microsoft sign-in (`LoginPacket failed validation` → `DisconnectPacket`). */
const LOGIN_REJECTED = /ERROR NETWORK [^\]]*\] LoginPacket failed validation\s*$/;
const DISCONNECT_PACKET = /INFO NETWORK [^\]]*\] DisconnectPacket\s*$/;
/** A client that made it into the world: the race is over (its earlier rejection no longer matters). */
export const CLIENT_JOINED = /(?:\[Client\]Level-LevelInitialized\s*$|Player Spawned: )/;
/** A world-loading progress screen is pushed: a join attempt started. */
const JOIN_ATTEMPT_STARTED = /\] Created 'progress\.world_loading_progress_screen'/;
/** The local server shuts the world down. Before the client is in, that is sign-in finishing while the world loads. */
const WORLD_CLOSED = /\[Server\]Level-LevelStartLeaveGame\s*$/;

/** What a `Debug_Log` says about the world join so far. Carried between incremental reads: a rejection and its disconnect are separate lines. */
export interface JoinState {
  /** `LoginPacket failed validation` waiting for the `DisconnectPacket` that confirms it. */
  rejected?: string;
  /**
   * The join failed and the client is out of the world: a rejected login left it on its connection-error screen
   * ("You need to authenticate to Microsoft services"), or the world closed before the client was in and it is back
   * on the start screen.
   */
  failed: boolean;
  /** The newest relevant line is a client join: the client is (back) in the world. */
  joined: boolean;
  /** World-loading progress screens so far: a new one means a join attempt (re)started. */
  attempts: number;
  /** The lines of the newest failure, for messages. */
  lines: string[];
}

/** A log nothing has been read from yet. Never mutated: `joinStateInLog` returns a new state. */
export const NO_JOIN_YET: JoinState = { failed: false, joined: false, attempts: 0, lines: [] };

/**
 * Follow the world join in `Debug_Log` text. The deeplink join racing Microsoft sign-in fails in one of two ways: the
 * client's LoginPacket is rejected (`LoginPacket failed validation`) followed by `DisconnectPacket`, leaving it on the
 * connection-error screen until "Back to menu" is pressed; or sign-in finishes while the world loads and the game
 * closes the world again (`[Server]Level-LevelStartLeaveGame` with no client join), leaving it on the start screen.
 * Pass the state of earlier reads to follow a log read in chunks; a client join (`[Client]Level-LevelInitialized`,
 * `Player Spawned:`) clears the failure.
 */
export function joinStateInLog(text: string, state: JoinState = NO_JOIN_YET): JoinState {
  let rejected = state.rejected;
  let failed = state.failed;
  let joined = state.joined;
  let attempts = state.attempts;
  let lines = state.lines;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (LOGIN_REJECTED.test(line)) {
      rejected = line;
    } else if (rejected && DISCONNECT_PACKET.test(line)) {
      failed = true;
      joined = false;
      lines = [rejected, line];
      rejected = undefined;
    } else if (CLIENT_JOINED.test(line)) {
      failed = false;
      joined = true;
      rejected = undefined;
    } else if (!joined && !failed && WORLD_CLOSED.test(line)) {
      failed = true;
      lines = [line];
    } else if (JOIN_ATTEMPT_STARTED.test(line)) {
      // A new world-loading screen: the earlier rejection belongs to the previous attempt.
      attempts++;
      failed = false;
    }
  }
  return { ...(rejected ? { rejected } : {}), failed, joined, attempts, lines };
}

/** Deployed folder name of each development pack, by manifest uuid. */
export async function deployedPackFolders(comMojang: string): Promise<Map<string, string>> {
  return new Map((await listDevPacks(comMojang)).map((d) => [d.uuid, d.folder]));
}

/**
 * Index the project's packs, each tagged with the folder it is deployed under in the client (by uuid). A lang-key
 * manifest name is resolved first, because the game names packs in its messages by the translated name.
 */
export async function indexProjectPacks(projectRoot: string, sharedComMojang: string): Promise<IndexedPack[]> {
  const layout = await discoverProject(projectRoot);
  const folders = await deployedPackFolders(sharedComMojang);
  return Promise.all(
    layout.packs.map(async (p: PackInfo) => {
      const pack = p.name ? { ...p, name: await packDisplayName(p.name, [p.dir]) } : p;
      return indexPack(pack, pack.uuid ? folders.get(pack.uuid.toLowerCase()) : undefined);
    }),
  );
}

/**
 * Content-log text → Diagnostics (source `client`). Identical findings (the game repeats Molang errors every frame)
 * collapse into one with a repeat count.
 */
export function clientDiagnostics(text: string, packs: readonly IndexedPack[]): Diagnostic[] {
  return entryDiagnostics(parseClientLog(text), packs);
}

/**
 * With the script debugger attached the client also sends its content log there as prints. Warn/error prints become
 * content-log entries mapped the same way.
 */
export function printEntries(prints: readonly Pick<PrintEvent, "level" | "message">[]): LogEntry[] {
  const out: LogEntry[] = [];
  for (const p of prints) {
    if (p.level !== "error" && p.level !== "warn" && p.level !== "stop") continue;
    const message = normalizeClientMessage(p.message.trim());
    if (NOISE.test(message)) continue;
    const entry: LogEntry = { severity: p.level === "warn" ? "warning" : "error", message, origin: "content-log" };
    // Prints carry no content-log area; script frames identify script errors.
    if (parseLocations(message).length > 0) entry.category = "Scripting";
    out.push(entry);
  }
  return out;
}

/**
 * The prints a content-log text does not already hold. The game writes each content-log line to the log and, with the
 * debugger attached, sends it as a print too (a script `console.warn` is a `[Scripting][warning]` log line and a `warn`
 * print). The log entry carries the area, so it is the one kept. Each log entry absorbs one print with the same message.
 */
export function unmirroredPrints<P extends Pick<PrintEvent, "message">>(logEntries: readonly LogEntry[], prints: readonly P[]): P[] {
  const inLog = new Map<string, number>();
  for (const e of logEntries) {
    const key = normalizeMessage(e.message);
    inLog.set(key, (inLog.get(key) ?? 0) + 1);
  }
  return prints.filter((p) => {
    const key = normalizeMessage(normalizeClientMessage(p.message));
    const n = inLog.get(key) ?? 0;
    if (n > 0) inLog.set(key, n - 1);
    return n === 0;
  });
}

export function entryDiagnostics(entries: readonly LogEntry[], packs: readonly IndexedPack[]): Diagnostic[] {
  // Entries without an area get the shared mapper's server-console code; on the client they are content-log findings.
  const all = entriesToDiagnostics(entries, packs, { source: "client" }).map((d) =>
    d.code.startsWith("bds.") ? { ...d, code: `content-log.${d.code.slice(4)}` } : d,
  );
  const byKey = new Map<string, { d: Diagnostic; n: number }>();
  for (const d of all) {
    const key = `${d.code}|${d.file ?? ""}|${d.range?.start.line ?? 0}|${d.message}`;
    const hit = byKey.get(key);
    if (hit) hit.n++;
    else byKey.set(key, { d, n: 1 });
  }
  const out = [...byKey.values()].map(({ d, n }) => (n > 1 ? { ...d, message: `${d.message} (repeated ${n}×)` } : d));
  return out.sort(compareDiagnostics);
}
