/**
 * Finding blocks and entities for a task step beyond the first lookup. The helper's `blocks` query scans a cube of at
 * most 16 blocks around a point, so a block search that comes back empty around the player goes on with cubes
 * centred on a ring around the player, nearest first, in loaded chunks only, up to a hard cap of cubes. An entity
 * search that comes back empty asks once more with the wider radius (the helper's `entities` query reaches 256).
 * Results are sorted by distance to the player.
 */
import type { Vec3 } from "../player.ts";
import type { BlockInfo, EntitySeen, TaskEnv } from "./types.ts";

/** The helper's `blocks` cube reaches at most this far from its centre (`helper-pack/scripts/main.js`). */
export const CUBE_RADIUS = 16;
/** How far a search reaches by default once the first lookup came back empty. */
export const SEARCH_REACH = 48;
/** At most this many `blocks` cubes per search, the first one included. */
export const MAX_CUBES = 12;

export interface SearchOptions {
  /** Radius of the first lookup around the player (default the env's radius, else 16). */
  radius?: number;
  /** Farthest reach once the first lookup is empty (default 48 blocks, horizontally from the player). */
  reach?: number;
  /** Most `blocks` queries (default 12). */
  maxCubes?: number;
}

export interface Found<T> {
  /** Nearest first. */
  found: T[];
  /** How far the search went, for messages: `16 blocks` or `48 blocks (searched 9 cubes)`. */
  within: string;
  /** `blocks` cubes or `entities` rounds asked. */
  queries: number;
  /** The helper's error per query that threw (`entities minecraft:villager within 16: ...`). */
  errors: string[];
  /** Every query asked threw: "none found" means nothing then. */
  failed: boolean;
}

/** One cube of the ring: its centre and the horizontal distance from the player to its nearest block. */
export interface RingCube {
  center: Vec3;
  near: number;
}

function boxDistance(me: Vec3, c: Vec3, r: number): number {
  const dx = Math.max(0, Math.abs(me.x - c.x) - r);
  const dz = Math.max(0, Math.abs(me.z - c.z) - r);
  return Math.hypot(dx, dz);
}

/**
 * The cubes searched after the first one: a 16-block cube around the player when the first lookup was smaller, then
 * cubes on a grid 33 blocks apart around the player (so they tile without gaps), each kept when part of it lies within
 * `reach`, nearest first (ties in a fixed order).
 */
export function ringCubes(me: Vec3, firstRadius: number, reach: number): RingCube[] {
  const step = 2 * CUBE_RADIUS + 1;
  const base = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) };
  const out: (RingCube & { order: number })[] = [];
  if (firstRadius < CUBE_RADIUS) out.push({ center: base, near: 0, order: -1 });
  const n = Math.ceil((reach - CUBE_RADIUS) / step);
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      if (i === 0 && j === 0) continue;
      const center = { x: base.x + i * step, y: base.y, z: base.z + j * step };
      const near = boxDistance(me, center, CUBE_RADIUS);
      if (near < reach) out.push({ center, near, order: (i + n) * (2 * n + 1) + (j + n) });
    }
  }
  return out.sort((a, b) => a.near - b.near || a.order - b.order).map(({ center, near }) => ({ center, near }));
}

function blockCenter(at: Vec3): Vec3 {
  return { x: Math.floor(at.x) + 0.5, y: Math.floor(at.y), z: Math.floor(at.z) + 0.5 };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Blocks of any of `types`, nearest to the player first. The first query is the player's own cube of `radius`, as
 * before; only when it finds none do the ring's cubes follow, each skipped when the block at its centre does not
 * read (an unloaded chunk), and the search stops once no cube left can hold a block nearer than the nearest found.
 */
export async function findBlocks(env: TaskEnv, types: readonly string[], options: SearchOptions = {}): Promise<Found<BlockInfo>> {
  const radius = options.radius ?? env.radius ?? CUBE_RADIUS;
  const reach = Math.max(options.reach ?? SEARCH_REACH, radius);
  const maxCubes = options.maxCubes ?? MAX_CUBES;
  const me = await env.controller.position();
  const seen = new Map<string, BlockInfo>();
  const add = (rows: BlockInfo[]) => {
    for (const row of rows) seen.set(`${Math.floor(row.location.x)},${Math.floor(row.location.y)},${Math.floor(row.location.z)}`, row);
  };
  const sorted = () => [...seen.values()].sort((a, b) => distance(me, blockCenter(a.location)) - distance(me, blockCenter(b.location)));
  let queries = 0;
  const errors: string[] = [];
  const ask = async (at?: Vec3): Promise<BlockInfo[]> => {
    queries++;
    try {
      return await env.query.blocks(types, at ? CUBE_RADIUS : radius, at);
    } catch (err) {
      errors.push(`blocks${at ? ` around ${Math.floor(at.x)} ${Math.floor(at.y)} ${Math.floor(at.z)}` : ""}: ${messageOf(err)}`);
      return [];
    }
  };
  const done = (within: string): Found<BlockInfo> => ({ found: sorted(), within, queries, errors, failed: queries > 0 && errors.length === queries });
  add(await ask());
  if (seen.size || reach <= radius) return done(`${radius} blocks`);
  let best = Number.POSITIVE_INFINITY;
  for (const cube of ringCubes(me, radius, reach)) {
    if (queries >= maxCubes || cube.near >= best) break;
    if (!(await env.query.block(cube.center).catch(() => null))) continue;
    const rows = (await ask(cube.center)).filter((row) => {
      const c = blockCenter(row.location);
      return Math.hypot(c.x - me.x, c.z - me.z) <= reach;
    });
    add(rows);
    for (const row of rows) best = Math.min(best, distance(me, blockCenter(row.location)));
  }
  return done(`${reach} blocks (searched ${queries} cubes)`);
}

/**
 * Entities of any of `types`, nearest to the player first: within `radius`, else once more within the reach. A type
 * whose query throws is reported in `errors` and does not hide the rows the other types found.
 */
export async function findEntities(env: TaskEnv, types: readonly string[], options: SearchOptions = {}): Promise<Found<EntitySeen>> {
  const radius = options.radius ?? env.radius ?? CUBE_RADIUS;
  const reach = Math.max(options.reach ?? SEARCH_REACH, radius);
  const me = await env.controller.position();
  const errors: string[] = [];
  let asked = 0;
  const ask = async (r: number) => {
    const seen = new Map<string, EntitySeen>();
    const rows = await Promise.all(
      types.map(async (type) => {
        asked++;
        try {
          return await env.query.entities(type, r);
        } catch (err) {
          errors.push(`entities ${type} within ${r}: ${messageOf(err)}`);
          return [] as EntitySeen[];
        }
      }),
    );
    for (const row of rows.flat()) seen.set(row.id, row);
    return [...seen.values()].sort((a, b) => distance(me, a.location) - distance(me, b.location));
  };
  const result = (found: EntitySeen[], within: string, queries: number): Found<EntitySeen> => ({ found, within, queries, errors, failed: asked > 0 && errors.length === asked });
  const near = await ask(radius);
  if (near.length || reach <= radius) return result(near, `${radius} blocks`, 1);
  return result(await ask(reach), `${reach} blocks`, 2);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Why a search found nothing, for a step's message: what was asked, how far, and the helper's errors. */
export function notFoundText(what: string, search: Found<unknown>, asked: readonly string[]): string {
  const failures = search.errors.length ? `; ${search.failed ? "every query failed" : "some queries failed"}: ${search.errors.join("; ")}` : "";
  return `no ${what} within ${search.within} (asked for ${asked.join(", ")})${failures}`;
}
