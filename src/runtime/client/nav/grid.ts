/**
 * The block grid navigation plans over: one class character per block, read from the helper pack's `grid` query in
 * 16-block sections and cached, so a moving player only fetches the sections it has not seen (or that went stale).
 * The helper spreads each scan over game ticks, so sections are asked for nearest first in small queries that are
 * all in flight at once: the blocks around the player arrive first and planning can start before the rest.
 */
import type { PlayerWorld, Vec3 } from "../types.ts";

/**
 * Block classes (the helper's `grid` query):
 * `.` passable, `#` solid, `s` bottom slab (half-height floor), `t` stairs, `w` water, `L` lava, `X` dangerous
 * (fire, cactus, magma, powder snow, berry bush, wither rose, campfire, cobweb, dripstone), `H` climbable, `D` closed
 * door, `G` closed fence gate, `d` open door or gate, `F` fence or wall, `u` unknown (not loaded or not fetched).
 */
export type BlockClass = "." | "#" | "s" | "t" | "w" | "L" | "X" | "H" | "D" | "G" | "d" | "F" | "u";

/** What the planner reads. Outside the known area every block is `u`. */
export interface BlockGrid {
  at(x: number, y: number, z: number): BlockClass;
}

/**
 * Decode one box of the helper's `grid` reply into cells (x fastest, then z, then y): regions of 7 characters, the
 * class then the first and last corner relative to the box (x, y, z, x, y, z) as base-36 digits. Blocks no region
 * covers are unknown (`u`).
 */
export function decodeRegions(text: string, sx: number, sy: number, sz: number): Uint8Array {
  const out = new Uint8Array(sx * sy * sz).fill(117 /* u */);
  if (text.length % 7 !== 0) throw new Error(`grid box text has ${text.length} characters, not a multiple of 7`);
  const digit = (k: number) => {
    const c = text.charCodeAt(k);
    return c <= 57 ? c - 48 : c - 87;
  };
  for (let k = 0; k < text.length; k += 7) {
    const c = text.charCodeAt(k);
    const [ax, ay, az, bx, by, bz] = [digit(k + 1), digit(k + 2), digit(k + 3), digit(k + 4), digit(k + 5), digit(k + 6)];
    if (!(ax >= 0 && ay >= 0 && az >= 0 && ax <= bx && ay <= by && az <= bz && bx < sx && by < sy && bz < sz)) throw new Error(`grid region ${text.slice(k, k + 7)} is outside the ${sx}x${sy}x${sz} box`);
    for (let y = ay; y <= by; y++) for (let z = az; z <= bz; z++) out.fill(c, (y * sz + z) * sx + ax, (y * sz + z) * sx + bx + 1);
  }
  return out;
}

export const SECTION = 16;
/**
 * Sections per helper query. Small queries let the nearest blocks come back after a tick or two (the helper scans
 * at most a few milliseconds per tick), and they are all sent at once so the rest follows without round trips.
 */
const QUERY_SECTIONS = 2;

interface Section {
  cells: Uint8Array;
  at: number;
  /** Some of its blocks were unknown to the helper (an unloaded chunk, or outside the world's height). */
  unknown: boolean;
}

const UNKNOWN = "u".charCodeAt(0);

/** Statistics of the helper's scans, for the result message, the bench and tests. */
interface ScanStats {
  /** Queries answered and blocks fetched. */
  fetches: number;
  fetchedBlocks: number;
  /** Script time the helper spent scanning, in all and in the worst single game tick. */
  scriptMs: number;
  maxTickMs: number;
}

/** Sections of the world fetched through the helper pack, kept per world (and dimension) across calls. */
export class GridCache implements BlockGrid {
  readonly #world: PlayerWorld;
  #sections = new Map<string, Section>();
  /** Sections asked for and not answered yet, so overlapping calls wait for the same query. */
  #pending = new Map<string, Promise<void>>();
  #dimension?: string;
  /** Blocks the follower changed (an opened door) until the next fetch of their section. */
  #overrides = new Map<string, BlockClass>();
  readonly stats: ScanStats = { fetches: 0, fetchedBlocks: 0, scriptMs: 0, maxTickMs: 0 };
  /** Goes up whenever sections arrive, so a follower can tell the grid learned something since it planned. */
  version = 0;

  constructor(world: PlayerWorld) {
    this.#world = world;
  }

  at(x: number, y: number, z: number): BlockClass {
    const o = this.#overrides.get(`${x},${y},${z}`);
    if (o) return o;
    const sx = Math.floor(x / SECTION);
    const sy = Math.floor(y / SECTION);
    const sz = Math.floor(z / SECTION);
    const s = this.#sections.get(`${sx},${sy},${sz}`);
    if (!s) return "u";
    const lx = x - sx * SECTION;
    const ly = y - sy * SECTION;
    const lz = z - sz * SECTION;
    return String.fromCharCode(s.cells[(ly * SECTION + lz) * SECTION + lx] as number) as BlockClass;
  }

  /** Set one block until its section is fetched again (the follower opened a door). */
  override(x: number, y: number, z: number, c: BlockClass): void {
    this.#overrides.set(`${x},${y},${z}`, c);
  }

  /** Forget everything when the player changes dimension. */
  dimension(id: string): void {
    if (this.#dimension !== undefined && this.#dimension !== id) {
      this.#sections.clear();
      this.#overrides.clear();
      this.#pending.clear();
    }
    this.#dimension = id;
  }

  /** Whether every section touching the box is known and not older than `maxAgeMs`. */
  has(min: Vec3, max: Vec3, maxAgeMs = 60_000, now = Date.now()): boolean {
    return this.#missing(min, max, maxAgeMs, now).length === 0;
  }

  #missing(min: Vec3, max: Vec3, maxAgeMs: number, now: number): [number, number, number][] {
    const want: [number, number, number][] = [];
    for (let sy = Math.floor(min.y / SECTION); sy <= Math.floor(max.y / SECTION); sy++) {
      for (let sz = Math.floor(min.z / SECTION); sz <= Math.floor(max.z / SECTION); sz++) {
        for (let sx = Math.floor(min.x / SECTION); sx <= Math.floor(max.x / SECTION); sx++) {
          const s = this.#sections.get(`${sx},${sy},${sz}`);
          if (!s || maxAgeMs <= 0 || now - s.at > maxAgeMs) want.push([sx, sy, sz]);
        }
      }
    }
    return want;
  }

  /**
   * Make sure every section touching the box from `min` to `max` (inclusive block coordinates) is known and not
   * older than `maxAgeMs`. Sections are asked for nearest to `focus` first (default the box's centre); the promise
   * settles when all of them have arrived.
   */
  async ensure(min: Vec3, max: Vec3, maxAgeMs = 60_000, now = Date.now(), focus?: Vec3): Promise<void> {
    if (!this.#world.query) throw new Error("navigation needs the helper pack's grid query (game_launch with the helper)");
    const f = focus ?? { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
    const want = sectionOrder(this.#missing(min, max, maxAgeMs, now), f);
    const waits: Promise<void>[] = [];
    const ask: [number, number, number][] = [];
    for (const s of want) {
      const pending = this.#pending.get(s.join(","));
      if (pending && maxAgeMs > 0) waits.push(pending);
      else ask.push(s);
    }
    for (let i = 0; i < ask.length; i += QUERY_SECTIONS) {
      const batch = ask.slice(i, i + QUERY_SECTIONS);
      const p = this.#fetch(batch, now);
      for (const s of batch) this.#pending.set(s.join(","), p);
      waits.push(p);
    }
    await Promise.all(waits);
  }

  async #fetch(batch: [number, number, number][], now: number): Promise<void> {
    const query = this.#world.query as NonNullable<PlayerWorld["query"]>;
    const boxes = batch.map(([sx, sy, sz]) => [sx * SECTION, sy * SECTION, sz * SECTION, SECTION, SECTION, SECTION]);
    try {
      const reply = (await query("grid", { boxes, ...(this.#dimension ? { dimension: this.#dimension } : {}) })) as { boxes?: unknown; ms?: unknown; maxTickMs?: unknown };
      if (!reply || !Array.isArray(reply.boxes) || reply.boxes.length !== batch.length) throw new Error("malformed grid reply from the helper pack");
      this.stats.fetches++;
      this.stats.fetchedBlocks += batch.length * SECTION ** 3;
      if (typeof reply.ms === "number") this.stats.scriptMs += reply.ms;
      if (typeof reply.maxTickMs === "number") this.stats.maxTickMs = Math.max(this.stats.maxTickMs, reply.maxTickMs);
      batch.forEach(([sx, sy, sz], k) => {
        const key = `${sx},${sy},${sz}`;
        const cells = decodeRegions(String((reply.boxes as unknown[])[k]), SECTION, SECTION, SECTION);
        this.#sections.set(key, { cells, at: now, unknown: cells.includes(UNKNOWN) });
        for (const o of this.#overrides.keys()) {
          const [x, y, z] = o.split(",").map(Number) as [number, number, number];
          if (Math.floor(x / SECTION) === sx && Math.floor(y / SECTION) === sy && Math.floor(z / SECTION) === sz) this.#overrides.delete(o);
        }
      });
      this.version++;
    } finally {
      for (const s of batch) {
        const key = s.join(",");
        if (this.#pending.get(key)) this.#pending.delete(key);
      }
    }
  }

  /** Fetch the sections around one block again (after opening a door, or when stuck). */
  async refresh(at: Vec3, radius = 1): Promise<void> {
    await this.ensure({ x: at.x - radius, y: at.y - radius, z: at.z - radius }, { x: at.x + radius, y: at.y + radius, z: at.z + radius }, 0);
  }

  /** Forget the sections that held unknown blocks, so the next plan fetches them again (chunks load as the player walks). */
  forgetUnknown(): void {
    for (const [key, section] of this.#sections) if (section.unknown) this.#sections.delete(key);
  }
}

/** Sections sorted nearest to `focus` first (distance from the focus block to the section's nearest block). */
export function sectionOrder(sections: [number, number, number][], focus: Vec3): [number, number, number][] {
  const dist = ([sx, sy, sz]: [number, number, number]) => {
    const d = (v: number, s: number) => Math.max(0, s * SECTION - v, v - (s * SECTION + SECTION - 1));
    return Math.hypot(d(focus.x, sx), d(focus.y, sy) * 2, d(focus.z, sz));
  };
  return sections.map((s) => [s, dist(s)] as const).sort((a, b) => a[1] - b[1]).map(([s]) => s);
}

const caches = new WeakMap<PlayerWorld, GridCache>();

/** The grid cache of one running game (one per world object, which the bridge keeps per launch). */
export function gridFor(world: PlayerWorld): GridCache {
  let c = caches.get(world);
  if (!c) {
    c = new GridCache(world);
    caches.set(world, c);
  }
  return c;
}
