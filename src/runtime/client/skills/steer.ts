/**
 * Which way is open to the player on the nav grid: the free run toward a heading, the heading that gets farthest
 * while keeping clear of mobs, and cover from an archer's arrows.
 */
import { angleDiff } from "../geometry.ts";
import type { Vec3 } from "../types.ts";

/** Grid classes a body can stand in (`u`: not fetched yet, taken as open). */
function open(c: string): boolean {
  return c === "." || c === "u";
}

/**
 * How far (blocks, up to `max`) the player can run from `me` toward `yaw` on level ground: feet and head free
 * across the body's width, something solid under the feet (no hole, no water or lava). A wall, a hole or a pool ends
 * the run.
 */
export function clearRun(grid: CoverGrid, me: Vec3, yaw: number, max = 6): number {
  const r = (yaw * Math.PI) / 180;
  const dx = -Math.sin(r);
  const dz = Math.cos(r);
  const fy = Math.floor(me.y + 0.01);
  for (let d = 0.5; d <= max; d += 0.5) {
    // The middle and both sides of the 0.6-wide body.
    for (const side of [0, -0.3, 0.3]) {
      const x = Math.floor(me.x + dx * d - dz * side);
      const z = Math.floor(me.z + dz * d + dx * side);
      const ground = grid.at(x, fy - 1, z);
      if (!open(grid.at(x, fy, z)) || !open(grid.at(x, fy + 1, z)) || ground === "." || ground === "w" || ground === "L") return d - 0.5;
    }
  }
  return max;
}

interface HeadingInput {
  me: Vec3;
  /** Where the player wants to go (world yaw): away from a burning creeper, back and aside from a group. */
  desired: number;
  /** Headings up to this many degrees off `desired` are tried, every 15 degrees. */
  spreadDeg: number;
  /**
   * Mobs to stay clear of on the way, each by `clearance` blocks (default `PATH_CLEARANCE`; a creeper being run from
   * too, so the run never passes it).
   */
  mobs: readonly { location: Vec3; clearance?: number }[];
  /** Free run toward a heading (`clearRun` on the nav grid). */
  clear: (yaw: number) => number;
  /** The heading picked last frame: kept unless another is clearly better, so the run does not zigzag. */
  previous?: number;
  horizon?: number;
}

/** Closest horizontal distance from `p` to the segment `a`-`b`. */
function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const len2 = vx * vx + vz * vz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / len2)) : 0;
  return Math.hypot(p.x - a.x - vx * t, p.z - a.z - vz * t);
}

/** A mob this close to the way counts against it (a zombie's reach plus a step). */
const PATH_CLEARANCE = 2.2;

/**
 * The heading to move along: the one that gets farthest along `desired` within the next `horizon` blocks, with the
 * free run cut short by walls, holes and water, and taking off for every mob near the way (so the player strafes
 * around a zombie instead of into it) and for a run blocked within a block and a half.
 */
export function openHeading(i: HeadingInput): number {
  const horizon = i.horizon ?? 6;
  let best = { yaw: i.desired, score: Number.NEGATIVE_INFINITY };
  for (let off = -i.spreadDeg; off <= i.spreadDeg; off += 15) {
    const yaw = i.desired + off;
    const run = Math.min(horizon, i.clear(yaw));
    const r = (yaw * Math.PI) / 180;
    const end = { x: i.me.x - Math.sin(r) * run, y: i.me.y, z: i.me.z + Math.cos(r) * run };
    let score = run * Math.cos((off * Math.PI) / 180) - Math.abs(off) / 360;
    if (run < 1.5) score -= 4;
    for (const m of i.mobs) {
      const d = segmentDistance(m.location, i.me, end);
      const keep = m.clearance ?? PATH_CLEARANCE;
      if (d < keep) score -= (keep - d) * 2.5;
    }
    if (i.previous !== undefined && Math.abs(angleDiff(i.previous, yaw)) <= 20) score += 0.5;
    if (score > best.score) best = { yaw, score };
  }
  return best.yaw;
}

/** What `findCover` reads: the nav grid's block classes (`#` solid, `.` passable, `s`/`t` slabs and stairs). */
interface CoverGrid {
  at(x: number, y: number, z: number): string;
}

/** Skeleton eyes and the player's chest, above the feet: the line an arrow takes. */
const ARCHER_EYE = 1.5;
const CHEST = 1.2;

/** Whether a solid block stands on the straight line from `from` to `to` (sampled every quarter block). */
export function lineBlocked(grid: CoverGrid, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): boolean {
  const len = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const steps = Math.ceil(len / 0.25);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (grid.at(Math.floor(from.x + (to.x - from.x) * t), Math.floor(from.y + (to.y - from.y) * t), Math.floor(from.z + (to.z - from.z) * t)) === "#") return true;
  }
  return false;
}

/**
 * A spot to run to while closing on an archer: standable, within `maxDist` of the player, at least 1.5 blocks nearer
 * the archer than the player is, with a solid block between the archer's eyes and the player's chest there. The one
 * that gains the most ground for the least walking, or undefined when the grid has no cover on the way.
 */
export function findCover(grid: CoverGrid, me: { x: number; y: number; z: number }, archer: { x: number; y: number; z: number }, skip: ReadonlySet<string> = new Set(), maxDist = 6): { x: number; y: number; z: number } | undefined {
  const fx = Math.floor(me.x);
  const fy = Math.floor(me.y);
  const fz = Math.floor(me.z);
  const now = Math.hypot(archer.x - me.x, archer.z - me.z);
  const eye = { x: archer.x, y: archer.y + ARCHER_EYE, z: archer.z };
  let best: { at: { x: number; y: number; z: number }; score: number } | undefined;
  for (let dx = -maxDist; dx <= maxDist; dx++) {
    for (let dz = -maxDist; dz <= maxDist; dz++) {
      const x = fx + dx;
      const z = fz + dz;
      if (skip.has(`${x},${z}`)) continue;
      const at = { x: x + 0.5, y: fy, z: z + 0.5 };
      const walk = Math.hypot(at.x - me.x, at.z - me.z);
      if (walk > maxDist) continue;
      const gain = now - Math.hypot(archer.x - at.x, archer.z - at.z);
      if (gain < 1.5) continue;
      const ground = grid.at(x, fy - 1, z);
      if (!(ground === "#" || ground === "s" || ground === "t") || grid.at(x, fy, z) !== "." || grid.at(x, fy + 1, z) !== ".") continue;
      if (!lineBlocked(grid, eye, { x: at.x, y: fy + CHEST, z: at.z })) continue;
      const score = gain - 0.3 * walk;
      if (!best || score > best.score) best = { at, score };
    }
  }
  return best?.at;
}
