/**
 * `wait_until` and `game_events`: the host side of the helper pack's `wait` and `events` queries, and the `log`
 * condition, which the host checks itself against the content log and the debugger prints.
 */
import { setTimeout as delay } from "node:timers/promises";
import { formatDiagnostic, type Diagnostic } from "../../core/diagnostic.ts";
import { errorMessage, UsageError } from "../../core/errors.ts";
import type { LogPosition } from "./contentlog.ts";

/** `wait_until`'s default and largest timeout: the largest stays under the clients' 60 s tool timeout. */
export const WAIT_DEFAULT_MS = 10_000;
export const WAIT_MAX_MS = 55_000;
/** Extra time the host gives the helper's reply after the helper's own timeout, before it gives up on it. */
const REPLY_GRACE_MS = 5_000;
/** How often the `log` condition reads the log. */
const LOG_POLL_MS = 250;

export const COMPARE_OPS = ["==", "!=", "<", "<=", ">", ">="] as const;
export type CompareOp = (typeof COMPARE_OPS)[number];

export type WaitCondition =
  | { kind: "entity"; type: string; op?: "present" | "absent" | CompareOp; value?: number; radius?: number; x?: number; y?: number; z?: number; dimension?: string }
  | { kind: "block"; x: number; y: number; z: number; type: string; is?: boolean; states?: Record<string, string | number | boolean>; dimension?: string }
  | { kind: "score"; objective: string; participant: string; op?: CompareOp; value: number }
  | { kind: "event"; event: string; since?: number; match?: Record<string, string | number | boolean> }
  | { kind: "log"; pattern?: string; errorsOnly?: boolean }
  | { kind: "player"; x: number; y: number; z: number; radius: number }
  | { kind: "ticks"; ticks: number };

export interface WaitResult {
  met: boolean;
  timedOut: boolean;
  elapsedMs: number;
  /** Game ticks that passed, as the helper counted them; absent for `log` and when the helper's reply never came. */
  ticks?: number;
  /** The last value the check saw (a count, a block, a score, the matching event, diagnostic or log line). */
  observed: unknown;
}

export interface GameEvent {
  seq: number;
  tick: number;
  kind: string;
  [field: string]: unknown;
}

export interface EventsResult {
  tick: number;
  events: GameEvent[];
  next: number;
  dropped: number;
  reset: boolean;
}

type LogCursor = { log?: LogPosition; printSeq: number };

/** What the waits need from the bridge; `bridge` satisfies it, tests pass fakes. */
export interface WaitDeps {
  status(): { running: boolean; ready: boolean; manualSteps: string[] };
  query(kind: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  logMark(): Promise<LogCursor>;
  logs(cursor: LogCursor, advance: boolean): Promise<{ diagnostics: Diagnostic[]; text: string; cursor: LogCursor }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Throw when the helper pack cannot answer: no game, or its scripts are not (or no longer) answering. */
export function requireHelper(deps: Pick<WaitDeps, "status">): void {
  const s = deps.status();
  if (!s.running) throw new Error("no client running; call game_launch first");
  if (!s.ready) {
    const steps = s.manualSteps.length ? `: ${s.manualSteps.join("; ")}` : "; call game_status";
    throw new Error(`the helper pack is not answering yet (game_status ready is false)${steps}`);
  }
}

/** Buffered in-world events after cursor `since` (`"now"`: only the current cursor). */
export async function readEvents(deps: WaitDeps, opts: { since?: number | "now"; kinds?: string[]; limit?: number }): Promise<EventsResult> {
  requireHelper(deps);
  const params: Record<string, unknown> = {};
  if (opts.since !== undefined) params.since = opts.since;
  if (opts.kinds?.length) params.kinds = opts.kinds;
  if (opts.limit !== undefined) params.limit = opts.limit;
  return (await deps.query("events", params)) as EventsResult;
}

/** Wait until `condition` holds or `timeoutMs` (clamped to WAIT_MAX_MS) passes. */
export async function waitUntil(deps: WaitDeps, condition: WaitCondition, timeoutMs = WAIT_DEFAULT_MS): Promise<WaitResult> {
  const timeout = Math.max(0, Math.min(WAIT_MAX_MS, timeoutMs));
  if (condition.kind === "log") return waitForLog(deps, condition, timeout);
  requireHelper(deps);
  const now = deps.now ?? Date.now;
  const start = now();
  // The helper checks every tick and answers once; the host only bounds how long it listens for that answer.
  const abort = new AbortController();
  const hostDeadline = delay(timeout + REPLY_GRACE_MS, "late" as const, { signal: abort.signal });
  try {
    const reply = await Promise.race([deps.query("wait", { condition, timeoutMs: timeout }, timeout + REPLY_GRACE_MS + 1_000), hostDeadline]);
    if (reply === "late") return { met: false, timedOut: true, elapsedMs: now() - start, observed: null };
    return reply as WaitResult;
  } finally {
    abort.abort();
    hostDeadline.catch(() => {});
  }
}

/** Compile a `log` pattern, refusing a bad one up front. */
function logPattern(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined) return undefined;
  try {
    return new RegExp(pattern, "i");
  } catch (err) {
    throw new UsageError(`log pattern is not a valid regular expression: ${errorMessage(err)}`);
  }
}

/** The first new diagnostic or log line the `log` condition accepts. */
export function matchLog(read: { diagnostics: readonly Diagnostic[]; text: string }, re: RegExp | undefined, errorsOnly: boolean): unknown {
  const diagnostics = errorsOnly ? read.diagnostics.filter((d) => d.severity === "error") : read.diagnostics;
  const hit = diagnostics.find((d) => !re || re.test(formatDiagnostic(d)));
  if (hit) return { diagnostic: hit };
  if (!re || errorsOnly) return undefined;
  const line = read.text.split(/\r?\n/).find((l) => l.trim() && re.test(l));
  return line === undefined ? undefined : { line };
}

/**
 * The `log` condition: content-log entries and script prints written after this call, read every LOG_POLL_MS with a
 * cursor of its own, so game_log still reports them afterwards.
 */
async function waitForLog(deps: WaitDeps, c: Extract<WaitCondition, { kind: "log" }>, timeout: number): Promise<WaitResult> {
  const re = logPattern(c.pattern);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  const start = now();
  let cursor = await deps.logMark();
  // No log file yet: what the first read returns is the log so far, not news.
  if (!cursor.log) cursor = (await deps.logs(cursor, false)).cursor;
  for (;;) {
    const read = await deps.logs(cursor, false);
    cursor = read.cursor;
    const observed = matchLog(read, re, c.errorsOnly === true);
    if (observed !== undefined) return { met: true, timedOut: false, elapsedMs: now() - start, observed };
    if (now() - start >= timeout) return { met: false, timedOut: true, elapsedMs: now() - start, observed: null };
    await sleep(LOG_POLL_MS);
  }
}
