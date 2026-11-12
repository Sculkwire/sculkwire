/**
 * The nearby entities the helper prints with every streamed player state, and how old the readings the skills get
 * are. A helper query answers 100 to 250 ms after the game read the entity; the stream's readings are at most a tick
 * or two old when they arrive, and each one handed out is carried forward along its velocity by its age.
 */
import { horizontalDistance } from "./geometry.ts";
import type { EntityInfo, Vec3 } from "./types.ts";

/** One streamed list: what the helper printed with the player state of game tick `tick`, arriving at wall time `at`. */
export interface StreamedEntities {
  at: number;
  tick: number;
  /** The helper's search radius and how many it lists at most (the closest first). */
  radius: number;
  limit: number;
  list: EntityInfo[];
}

/** A stream reading older than this is not used: the stream stopped or the game stalls. */
export const STREAM_FRESH_MS = 200;
/** Never carry a reading forward by more than this many ticks. */
const MAX_PROJECT_TICKS = 6;

/**
 * The entity carried forward from its reading by `ageMs` along its horizontal velocity (blocks per tick). The game
 * tick is moved on by as much, so tick-based velocity estimates stay consistent. `ageMs` says how old the reading
 * underneath is.
 */
export function project(e: EntityInfo, tick: number, ageMs: number): EntityInfo {
  const ticks = Math.max(0, Math.min(MAX_PROJECT_TICKS, ageMs / 50));
  const v = e.velocity;
  const location = v ? { x: e.location.x + v.x * ticks, y: e.location.y, z: e.location.z + v.z * ticks } : e.location;
  return { ...e, location, tick: tick + ticks, ageMs: Math.round(ageMs) };
}

function fresh(s: StreamedEntities | undefined, now: number): s is StreamedEntities {
  return s !== undefined && now - s.at <= STREAM_FRESH_MS;
}

/** The streamed entity `id`, carried forward to `now`; undefined when the stream is stale or does not list it. */
export function streamEntity(s: StreamedEntities | undefined, id: string, now: number): EntityInfo | undefined {
  if (!fresh(s, now)) return undefined;
  const e = s.list.find((m) => m.id === id);
  return e ? project(e, s.tick, now - s.at) : undefined;
}

/**
 * The streamed entities within `radius` of `me`, carried forward to `now`. Undefined when the stream cannot answer:
 * stale, a radius past the helper's, or a full list (the helper stopped at its limit) whose farthest entry is
 * inside the radius, so some within it may be missing.
 */
export function streamEntities(s: StreamedEntities | undefined, me: Vec3, radius: number, now: number): EntityInfo[] | undefined {
  if (!fresh(s, now) || radius > s.radius) return undefined;
  if (s.list.length >= s.limit && Math.max(0, ...s.list.map((e) => Math.hypot(e.location.x - me.x, e.location.y - me.y, e.location.z - me.z))) <= radius) return undefined;
  return s.list.filter((e) => horizontalDistance(me, e.location) <= radius).map((e) => project(e, s.tick, now - s.at));
}

/** How old the entity readings the skills got were, by where they came from. */
export interface StalenessSummary {
  count: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
}

/**
 * Reading ages, kept per source (`stream`, `query`). An age is the wall time from the arrival of the streamed state of
 * the reading's game tick to the moment the skill has the reading: the same clock for both sources, leaving out only
 * the print's transport, which both share.
 */
export class Staleness {
  readonly #ages = new Map<string, number[]>();

  record(source: string, ms: number): void {
    let a = this.#ages.get(source);
    if (!a) this.#ages.set(source, (a = []));
    if (a.length < 20_000) a.push(Math.max(0, ms));
  }

  reset(): void {
    this.#ages.clear();
  }

  summary(): Record<string, StalenessSummary> {
    const out: Record<string, StalenessSummary> = {};
    for (const [source, a] of this.#ages) {
      if (a.length === 0) continue;
      const s = [...a].sort((x, y) => x - y);
      const at = (q: number) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0);
      out[source] = { count: s.length, meanMs: Math.round(s.reduce((n, x) => n + x, 0) / s.length), p50Ms: at(0.5), p90Ms: at(0.9), maxMs: Math.round(s.at(-1) ?? 0) };
    }
    return out;
  }
}

/** Arrival wall times of the last streamed game ticks, to date a helper reply's tick on the stream's clock. */
export class TickClock {
  readonly #arrivals = new Map<number, number>();

  arrived(tick: number, at: number): void {
    this.#arrivals.set(tick, at);
    if (this.#arrivals.size > 400) {
      const first = this.#arrivals.keys().next().value;
      if (first !== undefined) this.#arrivals.delete(first);
    }
  }

  /** When tick `tick` arrived; between streamed ticks, the nearest one before it plus 50 ms a tick. */
  wallOf(tick: number): number | undefined {
    const exact = this.#arrivals.get(tick);
    if (exact !== undefined) return exact;
    let best: [number, number] | undefined;
    for (const [t, at] of this.#arrivals) if (t <= tick && (!best || t > best[0])) best = [t, at];
    return best ? best[1] + (tick - best[0]) * 50 : undefined;
  }
}
