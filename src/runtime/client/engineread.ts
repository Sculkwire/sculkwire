/**
 * The in-game agent as the fallback for what the helper pack and the content-log file answer: `game_query` kinds the
 * agent reads from the game's memory (`player`, `entities`, `block`, `blocks`) when the helper pack does not answer,
 * and `game_log` from the agent's content-log ring when no content-log file is written. Both happen in a game the
 * user opened without the helper pack or without `content_log_file` (an attached game).
 */
import type { Diagnostic } from "../../core/diagnostic.ts";
import { DIMENSIONS } from "../engine/dimension.ts";
import { engine, type EngineSession } from "../engine/engine.ts";
import type { EngineResult } from "../engine/failure.ts";
import { contentLog, contentLogText, worldBlock, worldBlocks, worldEntities, type ContentLogEntry } from "../engine/worldread.ts";
import { finishEntries, type IndexedPack, type LogEntry } from "../gamelog/logparse.ts";
import { entryDiagnostics, normalizeClientMessage, type LogPosition } from "./contentlog.ts";

/** The `game_query` kinds the agent answers on its own. */
export const ENGINE_QUERY_KINDS: Readonly<Record<string, true>> = { player: true, entities: true, block: true, blocks: true };

type QueryParams = Record<string, unknown>;

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function dimensionOf(params: QueryParams): string | number | undefined {
  const value = params.dimension;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

/**
 * A `game_query` kind answered by the agent, in the helper pack's shape: `player` is a one-element list of the local
 * player (`location`, `rotation` as `{x: pitch, y: yaw}`, `dimension`; no name, id or game mode, which the agent does
 * not read); `entities`, `block` and `blocks` come from the integrated server. Undefined for a kind it does not answer.
 */
export async function engineQuery(kind: string, params: QueryParams, session: EngineSession = engine): Promise<EngineResult<unknown> | undefined> {
  if (!ENGINE_QUERY_KINDS[kind]) return undefined;
  const at = { x: num(params.x), y: num(params.y), z: num(params.z) };
  if (kind === "entities") {
    return worldEntities({ ...at, radius: num(params.radius), type: typeof params.type === "string" ? params.type : undefined, limit: num(params.limit), dimension: dimensionOf(params) }, session);
  }
  if (kind === "blocks") {
    const types = Array.isArray(params.types) ? params.types.filter((t): t is string => typeof t === "string") : undefined;
    return worldBlocks(
      { ...at, radius: num(params.radius), type: typeof params.type === "string" ? params.type : undefined, types, limit: num(params.limit), dimension: dimensionOf(params) },
      session,
    );
  }
  const state = await session.playerState();
  if (kind === "player") {
    if (!state.ok) return state;
    const [x, y, z] = state.value.position;
    const [pitch, yaw] = state.value.rotation;
    const dimension = state.value.dimension;
    return {
      ok: true,
      value: [
        {
          location: x === null || y === null || z === null ? null : { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, z: Math.round(z * 100) / 100 },
          rotation: pitch === null || yaw === null ? null : { x: pitch, y: yaw },
          dimension: dimension === null ? null : DIMENSIONS[dimension] ? `minecraft:${DIMENSIONS[dimension]}` : null,
        },
      ],
    };
  }
  // `block` at the given point, else at the player's feet, as the helper anchors it.
  if (at.x !== undefined && at.y !== undefined && at.z !== undefined) {
    return worldBlock({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z), dimension: dimensionOf(params) }, session);
  }
  if (!state.ok) return state;
  const [x, y, z] = state.value.position;
  if (x === null || y === null || z === null) return { ok: false, code: -32001, reason: "anchor_missing", anchor: "player.position", message: "the player's position is not readable" };
  return worldBlock({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }, session);
}

/** The agent's content-log entries as log entries the content-log mapper reads (info dropped, noise removed). */
export function engineLogEntries(entries: readonly ContentLogEntry[]): LogEntry[] {
  const out: LogEntry[] = entries.map((e) => {
    const entry: LogEntry = {
      severity: e.level === "error" ? "error" : e.level === "warning" ? "warning" : "info",
      message: normalizeClientMessage(e.message),
      origin: "content-log",
    };
    if (e.area) entry.category = e.area;
    return entry;
  });
  return finishEntries(out, false);
}

/** What `game_log` reported and where it came from. */
export interface ClientLog {
  diagnostics: Diagnostic[];
  text: string;
  /** `file`: the game's own log files; `engine`: the agent's content-log ring. */
  source: "file" | "engine";
  note?: string;
}

/** What the file route read: the bridge's `logs()` answer. */
export interface FileLog {
  diagnostics: Diagnostic[];
  text: string;
  cursor: { log?: LogPosition };
}

/**
 * Chooses `game_log`'s source per call and keeps the agent's cursor. The agent's ring is the source when no log file
 * exists, or when the file route read nothing while the agent holds new warnings or errors (the game writes no
 * content-log file, or buffers it). Once chosen it stays the source while the agent answers, so the file's late flush
 * of the same messages is never reported a second time. Without an agent the file route answers as before.
 */
export class EngineLogReader {
  #since = 0;
  #engine = false;
  #session: EngineSession;

  constructor(session: EngineSession = engine) {
    this.#session = session;
  }

  async read(file: FileLog, packs: readonly IndexedPack[]): Promise<ClientLog> {
    const page = await contentLog(this.#since, undefined, this.#session);
    if (!page.ok) {
      this.#engine = false;
      return { diagnostics: file.diagnostics, text: file.text, source: "file" };
    }
    // Always follow the ring, so a later switch never reports messages older than the call that switched.
    this.#since = page.value.next;
    const entries = engineLogEntries(page.value.entries);
    const fileSilent = !file.text.trim();
    if (!this.#engine && file.cursor.log !== undefined && !(fileSilent && entries.length > 0)) {
      return { diagnostics: file.diagnostics, text: file.text, source: "file" };
    }
    this.#engine = true;
    const text = contentLogText(page.value.entries);
    const notes: string[] = [];
    notes.push(file.cursor.log === undefined ? "no content-log file exists; read from the game through the agent" : "the content-log file is not being written; read from the game through the agent");
    if (page.value.dropped > 0) notes.push(`${page.value.dropped} older message(s) left the agent's buffer before this read`);
    if (page.value.forced) notes.push("no content-log end point (file or GUI) is enabled; the agent keeps the game's content log emitting while it reads it");
    return {
      diagnostics: entryDiagnostics(entries, packs),
      text: text.length > 20_000 ? text.slice(-20_000) : text,
      source: "engine",
      note: notes.join("; "),
    };
  }
}
