/**
 * Navigation like a player: plan over the block grid (planner.ts), then follow the path with the controller's
 * hands, looking a few blocks ahead along it, sprinting on straight stretches, jumping just before steps and gaps,
 * opening doors, and planning again when the player leaves the path, gets stuck or the target entity moves.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { aimAt } from "../camera.ts";
import { horizontalDistance, yawTo } from "../geometry.ts";
import type { Follow, PlayerController } from "../player.ts";
import type { PlayerState, Vec3 } from "../types.ts";
import { gridFor, type GridCache } from "./grid.ts";
import { closedIn, plan, standAt, type PathStep, type PlanResult } from "./planner.ts";

interface NavigateOptions {
  /** Arrive within this many blocks (default 0.7, 2 for an entity). */
  radius?: number;
  /** Sprint on straight stretches (default true). Gaps of 2 or 3 blocks are always sprint-jumped. */
  sprint?: boolean;
  /** Entity id to keep the crosshair on while walking (the player strafes). */
  look?: string;
  /** Give up after this long (default 60000). */
  timeoutMs?: number;
  /** Close the doors and gates it opened once through them (default true, false when following an entity). */
  closeDoors?: boolean;
}

interface NavigateResult {
  ok: boolean;
  message: string;
  /** The last planned path (feet positions, block centers). */
  path?: Vec3[];
}

/** Blocks around the player the grid covers when planning: 48 x 48 and 6 up and down, stretched toward the goal. */
const WINDOW_HALF = 24;
const WINDOW_UP = 6;
const WINDOW_DOWN = 6;
/** Most blocks beyond the player the window reaches toward a far goal. */
const WINDOW_REACH = 40;
/** Sections older than this are fetched again when planning. */
const GRID_MAX_AGE_MS = 30_000;
const TICK_MS = 25;
/** No headway for this long: jump once like a player would, then plan again from fresh blocks. */
const STUCK_JUMP_MS = 1000;
const STUCK_REPLAN_MS = 2000;
const MAX_REPLANS = 40;
/**
 * Wider windows (blocks each way from the player) tried in turn when the plan in the normal one finds no way and its
 * search reached the window's edge (a wall wider than the window), or a partial path ends where the player stands.
 */
const WIDE_HALVES = [40, 64] as const;
/** Search limit of a plan in a wider window: about 2 s of planning (16 000 blocks took 0.3 s in the tests). */
const WIDE_MAX_NODES = 120_000;
/** Legs walked to the closest reachable spot in a row without getting 1 block nearer the target before giving up. */
const STALE_LEGS = 3;
/** How long one tap of the walk key lasts when edging off a ledge onto a ladder (about one game tick). */
const LADDER_TAP_MS = 40;

function center(p: PathStep): Vec3 {
  return { x: p.x + 0.5, y: p.floor, z: p.z + 0.5 };
}

/** The point `ahead` blocks further along the path from where the player is (projected onto segment `cur`). */
function alongPath(path: readonly PathStep[], cur: number, p: Vec3, ahead: number): Vec3 {
  let a = center(path[cur] as PathStep);
  let left = ahead;
  for (let i = cur; i + 1 < path.length; i++) {
    const b = center(path[i + 1] as PathStep);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    let from = 0;
    if (i === cur && len > 0) {
      from = Math.max(0, Math.min(len, ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / len));
    }
    if (from + left <= len && len > 0) {
      const t = (from + left) / len;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    }
    left -= len - from;
    a = b;
  }
  return center(path[path.length - 1] as PathStep);
}

/** Horizontal distance from `p` to the segment between two steps. */
function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

/** Whether the player has reached step `s` (on its floor, or there in the air for climbs and swims). */
function reached(p: Vec3, s: PathStep, last: boolean): boolean {
  const flat = Math.hypot(p.x - (s.x + 0.5), p.z - (s.z + 0.5));
  if (flat > (last ? 0.35 : 0.5)) return false;
  const dy = p.y - s.floor;
  if (s.move === "climb" || s.move === "swim") return Math.abs(dy) < 0.8;
  if (s.move === "jump") return dy > -0.3 && dy < 1.4;
  // A drop counts once the player is down (stepping off the top of a ladder, the feet are over it before the fall).
  if (s.move === "drop") return dy > -0.6 && dy < 0.5;
  return dy > -0.6 && dy < 1.4;
}

/** Same direction from one step to the next as from `a` to `b`. */
function sameDirection(a: PathStep, b: PathStep, c: PathStep, d: PathStep): boolean {
  return b.x - a.x === d.x - c.x && b.z - a.z === d.z - c.z;
}

/**
 * Horizontal blocks an airborne player still drifts with no input before its feet, now `height` blocks above the
 * landing floor, come down onto it: per tick the position moves by the velocity, horizontal speed keeps 91 %, and the
 * vertical speed loses 0.08 to gravity and then 2 % to drag. Speeds are blocks per tick.
 */
export function coastDistance(v: number, vy: number, height: number): number {
  let y = height;
  let dist = 0;
  for (let t = 0; t < 60 && !(vy <= 0 && y <= 0); t++) {
    dist += v;
    y += vy;
    v *= 0.91;
    vy = (vy - 0.08) * 0.98;
  }
  return dist;
}

interface Stats {
  replans: number;
  jumps: number;
  gaps: number;
  doors: number;
  closed: number;
  planned: number;
  minHealth?: number;
  /**
   * Doors and gates opened on the way, with the direction they were walked through, to close once the player is past
   * them. Kept across replans: a replan right after a door must not forget to close it.
   */
  toClose: { step: PathStep; dx: number; dz: number }[];
}

type FollowOutcome = "arrived" | "end" | "replan" | "refine" | "stuck" | "timeout";

/** The goal as it is now: a fixed point, or where the entity stands (null when it is gone). */
interface Goal {
  point(): Vec3 | null;
  hasY: boolean;
  stop(): void;
  label: string;
}

async function entityGoal(pc: PlayerController, id: string, signal?: AbortSignal): Promise<Goal | string> {
  const first = await pc.world.entity(id);
  if (!first) return `no entity ${id}`;
  let last: Vec3 | null = first.location;
  let stopped = false;
  void (async () => {
    while (!stopped && !signal?.aborted) {
      await pc.hands.sleep(300).catch(() => undefined);
      if (stopped) return;
      const e = await pc.world.entity(id).catch(() => undefined);
      if (e === undefined) continue;
      last = e ? e.location : null;
      if (!e) return;
    }
  })();
  return {
    point: () => last,
    hasY: true,
    stop: () => {
      stopped = true;
    },
    label: first.typeId.replace(/^minecraft:/, ""),
  };
}

/**
 * Walk to a point or an entity over the blocks around the player. Plans with A* over the helper's block grid,
 * follows the path smoothly, and plans again as it goes. Falls back to the straight walk (`moveTo`) when the game
 * has no helper queries.
 */
export async function navigate(pc: PlayerController, target: Vec3 | { x: number; y?: number; z: number } | { entity: string }, opts: NavigateOptions = {}, signal?: AbortSignal): Promise<NavigateResult> {
  const world = pc.world;
  const hands = pc.hands;
  const started = hands.now();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = started + timeoutMs;
  const isEntity = "entity" in target;
  const radius = opts.radius ?? (isEntity ? 2 : 0.7);
  let goal: Goal;
  if (isEntity) {
    const g = await entityGoal(pc, target.entity, signal);
    if (typeof g === "string") return { ok: false, message: g };
    goal = g;
  } else {
    const fixed = { x: target.x, y: target.y ?? Number.NaN, z: target.z };
    goal = { point: () => fixed, hasY: target.y !== undefined, stop: () => undefined, label: "the target" };
  }
  if (!world.query) {
    try {
      const p = goal.point();
      if (!p) return { ok: false, message: `${goal.label} is gone` };
      return await pc.moveTo({ x: p.x, z: p.z }, radius, opts.sprint ?? false, timeoutMs, { ...(opts.look ? { look: opts.look } : {}), ...(signal ? { signal } : {}) });
    } finally {
      goal.stop();
    }
  }
  const grid = gridFor(world);
  const first = await world.state();
  const stats: Stats = { replans: 0, jumps: 0, gaps: 0, doors: 0, closed: 0, planned: 0, toClose: [], ...(first.health !== undefined ? { minHealth: first.health } : {}) };
  // Close doors and gates behind on the way to a place; a chase or a fight does not stop for them.
  opts = { ...opts, closeDoors: opts.closeDoors ?? !isEntity };
  const watched = opts.look ? await hands.follow(opts.look) : undefined;
  if (opts.look && !watched) {
    goal.stop();
    return { ok: false, message: `no entity ${opts.look} to look at` };
  }
  let lastPath: PathStep[] = [];
  /** Legs walked to the closest reachable spot, legs in a row without headway, and the player's nearest distance. */
  const recover = { legs: 0, stale: 0, best: Number.POSITIVE_INFINITY };
  let stuckRuns = 0;
  let noStart = 0;
  let airborne = 0;
  const summary = (s: PlayerState) => {
    const parts = [`${stats.planned} blocks planned`];
    if (stats.jumps) parts.push(`${stats.jumps} jump(s)`);
    if (stats.gaps) parts.push(`${stats.gaps} gap jump(s)`);
    if (stats.doors) parts.push(`${stats.doors} door(s) opened`);
    if (stats.closed) parts.push(`${stats.closed} closed behind`);
    if (stats.replans) parts.push(`${stats.replans} replan(s)`);
    const lost = first.health !== undefined && stats.minHealth !== undefined ? first.health - Math.min(stats.minHealth, s.health ?? stats.minHealth) : 0;
    return `${((hands.now() - started) / 1000).toFixed(1)} s, ${parts.join(", ")}, ${lost > 0 ? `took ${lost} damage` : "no damage"}`;
  };
  const pathOut = () => lastPath.map(center);
  try {
    for (;;) {
      const s = await world.state();
      const g = goal.point();
      if (!g) return { ok: false, message: `${goal.label} is gone (${summary(s)})`, path: pathOut() };
      const dist = horizontalDistance(s.location, g);
      if (dist <= radius && (!goal.hasY || Math.abs(s.location.y - g.y) <= 1.5)) {
        return { ok: true, message: `arrived ${dist.toFixed(2)} blocks from ${goal.label} in ${summary(s)}`, path: pathOut() };
      }
      if (hands.now() > deadline) return { ok: false, message: `timed out ${dist.toFixed(1)} blocks from ${goal.label} after ${summary(s)}`, path: pathOut() };
      grid.dimension(s.dimension);
      // Mid-air (jumping or falling): plan from where the player lands.
      const feet = grid.at(Math.floor(s.location.x), Math.floor(s.location.y + 0.2), Math.floor(s.location.z));
      if (!s.onGround && s.velocity.y < -0.05 && feet !== "w" && feet !== "H" && ++airborne < 60) {
        await hands.sleep(50, signal);
        continue;
      }
      airborne = 0;
      const r = await planWide(grid, s.location, g, goal.hasY, radius);
      if (r.status === "no_start") {
        // In the air or on something the grid does not stand on: let the move finish, then look again.
        if (++noStart > 20) return { ok: false, message: r.message, path: pathOut() };
        await hands.stop();
        await hands.sleep(150, signal);
        continue;
      }
      noStart = 0;
      let leg = false;
      if (r.status === "unreachable") {
        // No way in any window: walk to the closest spot the search reached and plan again from there (the blocks
        // beyond may load on the way), as long as the legs bring the player nearer.
        if (recover.legs === 0 || dist <= recover.best - 1) {
          recover.best = Math.min(recover.best, dist);
          recover.stale = 0;
        } else recover.stale++;
        const end = r.path[r.path.length - 1];
        const why = r.closed
          ? "the target is closed in by blocks on every side"
          : !r.cut?.edge && !r.cut?.unknown
            ? "every block the player can reach is known and closed in"
            : !end || horizontalDistance(s.location, center(end)) <= 1.5
              ? "the closest spot is where the player stands"
              : recover.stale >= STALE_LEGS
                ? `${STALE_LEGS} legs in a row brought the player no nearer`
                : undefined;
        if (why) {
          const w = r.window;
          const tried = `Tried a window of ${w.max.x - w.min.x + 1} x ${w.max.z - w.min.z + 1} blocks around the player and walked ${recover.legs} leg(s) to the closest spot, getting within ${recover.best.toFixed(1)} blocks of ${goal.label}`;
          return { ok: false, message: `${r.message}. ${tried}: ${why}`, path: r.path.map(center) };
        }
        recover.legs++;
        leg = true;
      }
      lastPath = r.path;
      stats.planned += r.path.length - 1;
      if (r.path.length < 2 && r.status === "partial") return { ok: false, message: `${r.message}, and the player is already there`, path: pathOut() };
      const outcome = await followPath(pc, grid, r.path, r.status === "found", goal, radius, opts, stats, deadline, watched, signal, r.provisional ? grid.version : undefined);
      // Blocks unknown before a leg may have loaded on the way: fetch them again for the next plan.
      if (leg) grid.forgetUnknown();
      if (outcome === "arrived") continue;
      if (outcome === "timeout") continue;
      // More of the window arrived after a provisional plan: plan again with it (not a replan for the limit).
      if (outcome === "refine") continue;
      if (outcome === "stuck") {
        if (++stuckRuns > 4) {
          const now = await world.state();
          return { ok: false, message: `stuck ${horizontalDistance(now.location, g).toFixed(1)} blocks from ${goal.label} after ${summary(now)}`, path: pathOut() };
        }
        // The grid may be wrong here (a block changed): fetch the blocks around the player again.
        const at = (await world.state()).location;
        await grid.refresh({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) }, 2);
      } else stuckRuns = Math.max(0, stuckRuns - 1);
      if (++stats.replans > MAX_REPLANS) return { ok: false, message: `gave up after ${MAX_REPLANS} replans (${summary(await world.state())})`, path: pathOut() };
    }
  } finally {
    goal.stop();
    watched?.stop();
    await hands.stop();
  }
}

/** Blocks around the player that must be known before planning starts; the rest of the window may still be coming. */
const NEAR_HALF = 6;
const NEAR_UP = 3;
const NEAR_DOWN = 4;
/** How long planning waits for the whole window once the near blocks are in. */
const WINDOW_GRACE_MS = 150;

interface Planned extends PlanResult {
  /** Planned before every section of the window arrived: plan again as they come in. */
  provisional: boolean;
  /** The window planned in (the goal is outside it for a partial path). */
  window: { min: Vec3; max: Vec3 };
  /** No way, and the goal is closed in by blocks on every side (`closedIn`): nothing wider or a walk can help. */
  closed?: boolean;
}

/**
 * Plan in the normal window, then in the wider ones while the plan finds no way and its search reached the window's
 * edge, or a partial path ends where the player stands. A goal closed in by blocks gives up at once.
 */
async function planWide(grid: GridCache, from: Vec3, to: Vec3, hasY: boolean, radius: number): Promise<Planned> {
  let r = await planFrom(grid, from, to, hasY, radius);
  if (r.status === "unreachable" && closedIn(grid, { x: to.x, z: to.z, radius, ...(hasY ? { y: to.y } : {}) }, from)) return { ...r, closed: true };
  for (const half of WIDE_HALVES) {
    if (!(r.status === "unreachable" && r.cut?.edge) && !(r.status === "partial" && r.path.length < 2)) break;
    r = await planFrom(grid, from, to, hasY, radius, half);
  }
  return r;
}

/**
 * Fetch the blocks of the planning window, nearest to the player first, and plan from the player's feet to the goal
 * as soon as the blocks around the player are known (waiting a little for the rest). A plan that finds no way while
 * the window is still arriving waits for all of it and plans again.
 */
async function planFrom(grid: GridCache, from: Vec3, to: Vec3, hasY: boolean, radius: number, half = WINDOW_HALF): Promise<Planned> {
  const clampTo = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const fx = Math.floor(from.x);
  const fy = Math.floor(from.y);
  const fz = Math.floor(from.z);
  const tx = clampTo(Math.floor(to.x), fx - WINDOW_REACH, fx + WINDOW_REACH);
  const tz = clampTo(Math.floor(to.z), fz - WINDOW_REACH, fz + WINDOW_REACH);
  const ty = hasY ? clampTo(Math.floor(to.y), fy - 16, fy + 16) : fy;
  const min = { x: Math.min(fx - half, tx - 4), y: Math.min(fy - WINDOW_DOWN, ty - 3), z: Math.min(fz - half, tz - 4) };
  const max = { x: Math.max(fx + half - 1, tx + 4), y: Math.max(fy + WINDOW_UP, ty + 3), z: Math.max(fz + half - 1, tz + 4) };
  const focus = { x: fx + Math.sign(tx - fx) * 4, y: fy, z: fz + Math.sign(tz - fz) * 4 };
  let done = false;
  const all = grid.ensure(min, max, GRID_MAX_AGE_MS, Date.now(), focus).then(() => {
    done = true;
  });
  // Its failure surfaces through the awaits below; this keeps it from counting as unhandled meanwhile.
  all.catch(() => undefined);
  await Promise.race([all, grid.ensure({ x: fx - NEAR_HALF, y: fy - NEAR_DOWN, z: fz - NEAR_HALF }, { x: fx + NEAR_HALF, y: fy + NEAR_UP, z: fz + NEAR_HALF }, GRID_MAX_AGE_MS, Date.now(), focus)]);
  if (!done) await Promise.race([all, sleep(WINDOW_GRACE_MS)]);
  const goal = { x: to.x, z: to.z, radius, ...(hasY ? { y: to.y } : {}) };
  const options = { bounds: { min, max }, ...(half > WINDOW_HALF ? { maxNodes: WIDE_MAX_NODES } : {}) };
  let r = plan(grid, from, goal, options);
  if (!done && r.status !== "found") {
    await all;
    r = plan(grid, from, goal, options);
  }
  return { ...r, provisional: !done, window: { min, max } };
}

/** Follow one planned path until the goal, its end, a reason to plan again, or the deadline. */
async function followPath(
  pc: PlayerController,
  grid: GridCache,
  path: PathStep[],
  complete: boolean,
  goal: Goal,
  radius: number,
  opts: NavigateOptions,
  stats: Stats,
  deadline: number,
  watched: Follow | undefined,
  signal?: AbortSignal,
  /** Grid version a provisional partial plan was made with: plan again when more sections have arrived. */
  provisionalVersion?: number,
): Promise<FollowOutcome> {
  const hands = pc.hands;
  const world = pc.world;
  const last = path.length - 1;
  const planGoal = goal.point();
  let cur = 0;
  let lookPoint: Vec3 = alongPath(path, 0, center(path[0] as PathStep), 3.5);
  const lookAhead = { widthDeg: 12, aim: (me: PlayerState) => aimAt(me, { ...lookPoint, y: lookPoint.y + 1.1 }) };
  if (watched) hands.track(watched, 0.9, 8);
  else hands.look(lookAhead);
  const started = hands.now();
  let progress = { at: started, value: Number.NEGATIVE_INFINITY };
  let lastJumpAt = Number.NEGATIVE_INFINITY;
  let ladderTapAt = Number.NEGATIVE_INFINITY;
  let holdingUp = false;
  let finalSince: number | undefined;
  /** The gap step a jump is flying to, and the direction of the jump, until the player lands. */
  let flight: { step: PathStep; dx: number; dz: number } | undefined;
  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new Error("cancelled");
    const s = await world.state();
    const now = hands.now();
    const p = s.location;
    if (s.health !== undefined) stats.minHealth = Math.min(stats.minHealth ?? s.health, s.health);
    if (now > deadline) return "timeout";
    const g = goal.point();
    if (!g) return "replan";
    // A moving target: plan again when it has left the end of this path.
    if (planGoal && horizontalDistance(planGoal, g) > Math.max(1.5, radius)) return "replan";
    // A partial path planned before the window arrived: plan again with the new sections, between steps on the ground.
    if (provisionalVersion !== undefined && !complete && grid.version !== provisionalVersion && s.onGround && now - started > 250) return "refine";
    for (let k = cur + 1; k <= Math.min(cur + 4, last); k++) if (reached(p, path[k] as PathStep, k === last)) cur = k;
    const here = path[cur] as PathStep;
    const next = path[cur + 1];
    if (!next) {
      // The last step: walk the final bit straight to the exact goal (or plan the next leg of a partial path).
      if (!complete) return "end";
      const dist = horizontalDistance(p, g);
      if (dist <= radius) return "arrived";
      finalSince ??= now;
      if (now - finalSince > 3000) return "replan";
      const coast = dist < 1.2 && Math.floor(now / 100) % 2 === 1;
      await hands.walk(coast ? undefined : yawTo(p, g), false);
      lookPoint = g;
      await hands.sleep(TICK_MS, signal);
      continue;
    }
    // Off the path (pushed, slipped or fell): plan again from here.
    const off = segmentDistance(p, center(here), center(next));
    if (off > 1.6 || p.y < here.floor - 1.5 - (next.move === "drop" ? (next.fall ?? 0) : 0)) return "replan";
    // In the air after a gap jump: steer the landing onto the target block like a player, holding forward while
    // short of it, letting go when on course, and pulling back when the jump would carry past a narrow landing.
    if (flight && s.onGround && now - lastJumpAt > 150) flight = undefined;
    if (flight && !s.onGround) {
      const c = center(flight.step);
      const rel = (p.x - c.x) * flight.dx + (p.z - c.z) * flight.dz;
      const v = s.velocity.x * flight.dx + s.velocity.z * flight.dz;
      const landing = rel + coastDistance(v, s.velocity.y, p.y - flight.step.floor);
      const heading = Math.atan2(-flight.dx, flight.dz) * (180 / Math.PI);
      if (landing < -0.2) await hands.walk(heading, true);
      else if (landing > 0.15) await hands.walk(heading + 180, false);
      else await hands.walk(undefined);
      await hands.sleep(TICK_MS, signal);
      continue;
    }
    const nextCenter = center(next);
    const toNext = horizontalDistance(p, nextCenter);
    // Doors and gates: stop, look at it, open it.
    if (next.move === "door" && toNext < 1.8) {
      const feet = grid.at(next.x, next.y, next.z);
      const head = grid.at(next.x, next.y + 1, next.z);
      if (feet === "D" || feet === "G" || head === "D") {
        const opened = await clickDoor(pc, grid, next, "open", signal);
        if (!opened) return "stuck";
        stats.doors++;
        if (opts.closeDoors) stats.toClose.push({ step: next, dx: Math.sign(next.x - here.x), dz: Math.sign(next.z - here.z) });
        if (watched) hands.track(watched, 0.9, 8);
        else hands.look(lookAhead);
        progress = { at: hands.now(), value: Number.NEGATIVE_INFINITY };
        continue;
      }
    }
    // A door or gate this walk opened: close it once through and clear of it, like a player keeping mobs out.
    const behind = stats.toClose.find((d) => {
      const c = center(d.step);
      return s.onGround && (p.x - c.x) * d.dx + (p.z - c.z) * d.dz >= 1.1;
    });
    if (behind) {
      stats.toClose.splice(stats.toClose.indexOf(behind), 1);
      if (horizontalDistance(p, center(behind.step)) < 3.5 && (await clickDoor(pc, grid, behind.step, "closed", signal))) stats.closed++;
      if (watched) hands.track(watched, 0.9, 8);
      else hands.look(lookAhead);
      progress = { at: hands.now(), value: Number.NEGATIVE_INFINITY };
      continue;
    }
    // Precise moves aim at the next block, walking aims a little ahead along the path.
    const precise = next.move !== "walk" && next.move !== "swim";
    const carrot = precise ? nextCenter : alongPath(path, cur, p, 0.6);
    const heading = yawTo(p, carrot);
    lookPoint = next.move === "climb" ? { x: next.x + 0.5, y: next.y + (next.y > here.y ? 1.5 : -0.5), z: next.z + 0.5 } : alongPath(path, cur, p, 3.5);
    // Sprint on straight stretches and for long gap jumps.
    const gapAhead = path.slice(cur + 1, cur + 4).find((st) => st.move === "gap");
    const longGap = gapAhead !== undefined && (gapAhead.gap ?? 1) >= 2;
    let straight = 0;
    for (let k = cur + 1; k < last && straight < 4; k++) {
      const a = path[k] as PathStep;
      const b = path[k + 1] as PathStep;
      if (a.move !== "walk" || b.move !== "walk" || !sameDirection(here, next, a, b)) break;
      straight++;
    }
    const view = pc.camera.view()?.yaw ?? s.rotation.y;
    const facing = Math.abs(((((heading - view) % 360) + 540) % 360) - 180) < 30;
    const sprint = (longGap || (opts.sprint !== false && straight >= 3)) && (facing || watched !== undefined);
    const feetClass = grid.at(Math.floor(p.x), Math.floor(p.y + 0.2), Math.floor(p.z));
    const inWater = feetClass === "w";
    const onLadder = feetClass === "H";
    const climbUp = next.move === "climb" && next.floor > here.floor;
    const climbDown = next.move === "climb" && next.floor < here.floor;
    // Stepping off a ledge onto a ladder below (the top of a ladder going down): the ladder only catches a player
    // whose feet come down inside its block, and a player tips off the ledge about at the ladder's center, so any
    // speed left then carries the fall past the ladder. Walk up to the edge, stop, and edge over it in short taps.
    const ontoLadder = !onLadder && (climbDown || (next.move === "drop" && grid.at(next.x, next.y, next.z) === "H"));
    if (ontoLadder && s.onGround) {
      const len = Math.hypot(next.x - here.x, next.z - here.z);
      const dx = len ? (next.x - here.x) / len : 0;
      const dz = len ? (next.z - here.z) / len : 0;
      const remaining = (nextCenter.x - p.x) * dx + (nextCenter.z - p.z) * dz;
      const along = Math.max(0, s.velocity.x * dx + s.velocity.z * dz);
      // The reported velocity is what carries into the next tick after ground friction (55 % kept): let go and the
      // player slides v / 0.45 further, and the input delay adds its ticks at the full speed v / 0.55.
      const leadTicks = pc.input === "engine" ? 2 : 3;
      const slide = along * (1 / 0.45 + leadTicks / 0.55);
      const dirYaw = Math.atan2(-dx, dz) * (180 / Math.PI);
      if (slide < remaining - 0.15) await hands.walk(dirYaw, false);
      else if (along < 0.02 && now - ladderTapAt > 300) {
        ladderTapAt = now;
        await hands.walk(dirYaw, false);
      } else if (now - ladderTapAt > LADDER_TAP_MS) await hands.walk(undefined);
    } else if (ontoLadder || climbDown) {
      // Falling into the ladder or going down it: no keys (walking off it would be a fall, pushing into its wall
      // climbs), except to steer back over its center when drifting out of its block.
      await hands.walk(toNext > 0.2 ? yawTo(p, nextCenter) : undefined, false);
    } else if (climbUp) {
      // Going up: push into the ladder's wall (it climbs with the jump held), never sideways off it.
      const ladder = grid.at(here.x, here.y, here.z) === "H" ? here : next;
      const wall = ladderWall(grid, ladder.x, ladder.y, ladder.z);
      await hands.walk(wall ? yawTo(p, wall) : undefined);
    } else await hands.walk(heading, sprint);
    // Jumps: just before a one-block step, and at the edge of a gap.
    let jump = false;
    if (next.move === "jump" && s.onGround && toNext < 1.25 && p.y < next.floor - 0.4 && now - lastJumpAt > 500) jump = true;
    if (next.move === "gap" && s.onGround && now - lastJumpAt > 500) {
      const dx = Math.sign(next.x - here.x);
      const dz = Math.sign(next.z - here.z);
      const along = (p.x - (here.x + 0.5)) * dx + (p.z - (here.z + 0.5)) * dz;
      // Where the player will be when the jump reaches the game (blocks per tick times the input delay in ticks),
      // so it leaves from just before the edge (at +0.5) on either route.
      const speed = Math.max(0, s.velocity.x * dx + s.velocity.z * dz);
      const leadTicks = pc.input === "engine" ? 2 : 3;
      if (along + speed * leadTicks >= 0.25) {
        jump = true;
        stats.gaps++;
        const len = Math.hypot(dx, dz) || 1;
        flight = { step: next, dx: dx / len, dz: dz / len };
      }
    }
    if (jump) {
      lastJumpAt = now;
      if (next.move === "jump") stats.jumps++;
      await hands.jump(next.move === "gap" ? 250 : 200);
    }
    // Climbing, getting off the top of a ladder, and swimming up: hold jump (changed only when that need changes, so
    // it never cuts a jump short).
    const holdUp = climbUp || ((onLadder || inWater) && next.floor > here.floor - 0.1 && !climbDown);
    if (holdUp !== holdingUp && !jump) {
      holdingUp = holdUp;
      await hands.move({ jump: holdUp });
    }
    // No headway: jump once (a player bumping an edge), then plan again. Never at the ledge above a ladder, where a
    // jump would carry past it.
    const value = cur * 100 - toNext;
    if (value > progress.value + 0.2) progress = { at: now, value };
    else if (now - progress.at > STUCK_REPLAN_MS) return "stuck";
    else if (now - progress.at > STUCK_JUMP_MS && s.onGround && !ontoLadder && now - lastJumpAt > 800) {
      lastJumpAt = now;
      await hands.jump(150);
    }
    await hands.sleep(TICK_MS, signal);
  }
}

/**
 * Aim points on a door or gate block, center first. A closed door or gate fills the middle, but an open door is a
 * thin panel along one edge of its block, so closing one aims near each edge in turn until a click lands.
 */
const DOOR_AIMS: readonly (readonly [number, number])[] = [
  [0.5, 0.5],
  [0.1, 0.5],
  [0.9, 0.5],
  [0.5, 0.1],
  [0.5, 0.9],
];

/** Look at a door or gate block and click it, then check the grid shows it `want` (open or closed). */
async function clickDoor(pc: PlayerController, grid: GridCache, door: PathStep, want: "open" | "closed", signal?: AbortSignal): Promise<boolean> {
  const hands = pc.hands;
  await hands.walk(undefined);
  const isClosed = () => {
    const feet = grid.at(door.x, door.y, door.z);
    return feet === "D" || feet === "G" || grid.at(door.x, door.y + 1, door.z) === "D";
  };
  for (let attempt = 0; attempt < DOOR_AIMS.length; attempt++) {
    const [ax, az] = DOOR_AIMS[attempt] as readonly [number, number];
    await pc.lookAtPoint({ x: door.x + ax, y: door.y + 0.8, z: door.z + az }, 6, signal);
    await hands.use(true);
    await hands.sleep(80, signal);
    await hands.use(false);
    await hands.sleep(250, signal);
    await grid.refresh({ x: door.x, y: door.y, z: door.z }, 0);
    if (isClosed() === (want === "closed")) return true;
  }
  return false;
}

/** The side of a ladder block its solid backing is on (the way to push to climb it), or undefined. */
function ladderWall(grid: GridCache, x: number, y: number, z: number): Vec3 | undefined {
  for (const [dx, dz] of [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ] as const) {
    if (grid.at(x + dx, y, z + dz) === "#") return { x: x + 0.5 + dx, y, z: z + 0.5 + dz };
  }
  return undefined;
}

/**
 * Whether walking straight from `from` to `to` works without planning: every block on the line can be stood on,
 * reached by at most a one-block step up or a drop of up to 3, with no hazard on the way. Unknown blocks count as
 * blocked.
 */
export function straightLineClear(grid: { at: GridCache["at"] }, from: Vec3, to: Vec3): boolean {
  const dist = horizontalDistance(from, to);
  let y = Math.floor(from.y + 0.01);
  let floor = standAt(grid, Math.floor(from.x), y, Math.floor(from.z))?.floor ?? from.y;
  let bx = Math.floor(from.x);
  let bz = Math.floor(from.z);
  for (let d = 0.25; d <= dist + 0.01; d += 0.25) {
    const t = Math.min(1, d / Math.max(dist, 1e-6));
    // The player's body is 0.6 wide: check the line and both of its edges.
    for (const side of [0, -0.3, 0.3]) {
      const nx = from.x + (to.x - from.x) * t + (side * -(to.z - from.z)) / Math.max(dist, 1e-6);
      const nz = from.z + (to.z - from.z) * t + (side * (to.x - from.x)) / Math.max(dist, 1e-6);
      const cx = Math.floor(nx);
      const cz = Math.floor(nz);
      if (side === 0 && cx === bx && cz === bz) continue;
      let found: { y: number; floor: number } | undefined;
      for (const dy of [0, 1, -1, -2, -3]) {
        const st = standAt(grid, cx, y + dy, cz);
        if (st && st.kind === "ground" && st.floor - floor <= 1.01 && floor - st.floor <= 3.01) {
          found = { y: y + dy, floor: st.floor };
          break;
        }
      }
      if (!found) return false;
      if (side === 0) {
        bx = cx;
        bz = cz;
        y = found.y;
        floor = found.floor;
      }
    }
  }
  return true;
}

/**
 * `move_to`: the straight walk when nothing is in the way (it turns and walks at once, like before), the planner when
 * the straight line is blocked or the straight walk gets stuck.
 */
export async function moveToAction(
  pc: PlayerController,
  action: { x: number; z: number; y?: number; radius?: number; sprint?: boolean; timeoutMs?: number; look?: string },
  signal?: AbortSignal,
): Promise<NavigateResult> {
  const look = { ...(action.look ? { look: action.look } : {}), ...(signal ? { signal } : {}) };
  if (!pc.world.query) return pc.moveTo(action, action.radius, action.sprint, action.timeoutMs, look);
  const started = pc.hands.now();
  const s = await pc.world.state();
  const grid = gridFor(pc.world);
  grid.dimension(s.dimension);
  const goal = { x: action.x, y: action.y ?? s.location.y, z: action.z };
  const lo = { x: Math.floor(Math.min(s.location.x, goal.x)) - 1, y: Math.floor(Math.min(s.location.y, goal.y)) - 4, z: Math.floor(Math.min(s.location.z, goal.z)) - 1 };
  const hi = { x: Math.floor(Math.max(s.location.x, goal.x)) + 1, y: Math.floor(Math.max(s.location.y, goal.y)) + 3, z: Math.floor(Math.max(s.location.z, goal.z)) + 1 };
  const far = hi.x - lo.x > 96 || hi.z - lo.z > 96;
  if (!far) await grid.ensure(lo, hi, GRID_MAX_AGE_MS);
  const nav = (note: string) => {
    const timeoutMs = Math.max(1000, (action.timeoutMs ?? 60_000) - (pc.hands.now() - started));
    return navigate(pc, { x: action.x, z: action.z, ...(action.y !== undefined ? { y: action.y } : {}) }, { ...action, timeoutMs }, signal).then((r) => ({ ...r, message: `${r.message} (${note})` }));
  };
  if (far || !straightLineClear(grid, s.location, goal)) return nav("planned a path: the straight line is blocked");
  const r = await pc.moveTo(action, action.radius, action.sprint, action.timeoutMs, look);
  if (r.ok || !r.message.startsWith("stuck")) return r;
  return nav(`planned a path after the straight walk got ${r.message}`);
}
