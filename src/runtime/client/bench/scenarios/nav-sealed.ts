/**
 * A goal no player can reach: the block inside a closed glass box (walls, floor of stone, roof). `goto` must answer
 * that it found no way, and fast: the box closes the goal in, so no wider window or walk is tried. Success is that
 * failure within 15 s, its message naming the closest reachable spot, and the player unharmed.
 */
import { wall } from "../kit.ts";
import { blocks } from "./nav-kit.ts";
import type { Offset, Scenario } from "../types.ts";

const AREA = { radius: 12, height: 6 };
const GOAL: Offset = { dx: 0, dy: 0, dz: 6 };
const LIMIT_MS = 15_000;

const sealed: Scenario = {
  name: "sealed",
  suite: "nav",
  summary: "the goal inside a closed glass box 6 blocks ahead; success: a failure answer within 15 s naming the closest spot, no damage",
  runs: 3,
  timeoutMs: LIMIT_MS,
  area: AREA,
  floor: "stone",
  build: (ctx) => {
    const b = blocks(ctx.origin);
    // A 3 x 3 x 4 glass box, then its inside (the goal block and the one above) cleared.
    return [...wall(ctx.origin, AREA.radius, 4), ...b.fill(-1, 0, 5, 1, 3, 7, "glass"), ...b.fill(0, 0, 6, 0, 1, 6, "air")];
  },
  player: { gameMode: "survival", time: "day", yaw: 0 },
  action: (ctx) => {
    const g = ctx.at(GOAL);
    return { action: "goto", x: g.x + 0.5, y: g.y, z: g.z + 0.5, radius: 0.6, timeoutMs: LIMIT_MS };
  },
  measure: (ctx, o) => {
    const p = o.state?.location;
    const start = ctx.at({ dx: 0, dy: 0, dz: 0 });
    return {
      seconds: Math.round(o.durationMs / 100) / 10,
      closestSpot: /The closest reachable spot is/.test(o.message),
      closedIn: /closed in/.test(o.message),
      walked: p ? Math.round(Math.hypot(p.x - (start.x + 0.5), p.z - (start.z + 0.5)) * 10) / 10 : Number.NaN,
    };
  },
  success: (o, extra) => !o.ok && extra.closestSpot === true && o.durationMs <= LIMIT_MS && o.deaths === 0 && o.damageTaken === 0,
};

export default sealed;
