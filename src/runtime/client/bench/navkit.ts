/**
 * Shared pieces of the movement courses (`nav-*` scenarios): block placement relative to the arena origin and the
 * standard course scenario, a `goto` from the start to the goal judged on arriving without damage.
 */
import { xyz } from "../geometry.ts";
import type { Vec3 } from "../types.ts";
import { fillBox, wall } from "./arena.ts";
import type { BenchContext, Metric, Offset, RunOutcome, Scenario } from "./types.ts";

/** Commands relative to one arena origin. `dy` 0 is the feet layer on the floor (the floor's top block is -1). */
export function blocks(origin: Vec3) {
  return {
    set: (dx: number, dy: number, dz: number, block: string, states?: Record<string, string | number | boolean>) =>
      `setblock ${xyz({ x: origin.x + dx, y: origin.y + dy, z: origin.z + dz })} ${block}${states ? ` [${Object.entries(states).map(([k, v]) => `"${k}"=${typeof v === "string" ? `"${v}"` : v}`).join(",")}]` : ""}`,
    fill: (dx0: number, dy0: number, dz0: number, dx1: number, dy1: number, dz1: number, block: string) =>
      fillBox({ x: origin.x + dx0, y: origin.y + dy0, z: origin.z + dz0 }, { x: origin.x + dx1, y: origin.y + dy1, z: origin.z + dz1 }, block),
  };
}

/** The numbers `navigate` reports in its message (`3 jump(s)`, `2 replan(s)`, ...). */
function counts(message: string): Record<string, number> {
  const n = (re: RegExp) => Number(re.exec(message)?.[1] ?? 0);
  return {
    jumps: n(/(\d+) jump\(s\)/),
    gapJumps: n(/(\d+) gap jump\(s\)/),
    doors: n(/(\d+) door\(s\) opened/),
    closed: n(/(\d+) closed behind/),
    replans: n(/(\d+) replan\(s\)/),
  };
}

/**
 * A movement course inside a glass ring: survival, day, empty hands, a `goto` from `start` to `goal` (block
 * offsets, feet level), successful when the player arrives at the goal's height with no damage and no death.
 */
export function course(
  s: Pick<Scenario, "name" | "summary"> & {
    area?: Scenario["area"];
    runs?: number;
    timeoutMs?: number;
    start?: Offset;
    yaw?: number;
    goal: Offset;
    build: (origin: Vec3) => string[];
    /** Extra numbers read after the run. */
    measure?: (ctx: BenchContext, o: RunOutcome) => Promise<Record<string, Metric>> | Record<string, Metric>;
    /** Extra success condition on top of arriving without damage. */
    also?: (o: RunOutcome, extra: Record<string, Metric>) => boolean;
  },
): Scenario {
  const timeoutMs = s.timeoutMs ?? 45_000;
  const area = s.area ?? { radius: 12, height: 10 };
  return {
    name: s.name,
    suite: "nav",
    summary: s.summary,
    runs: s.runs ?? 3,
    timeoutMs,
    area,
    floor: "stone",
    // A glass ring at the edge, so the course is the only way to the goal.
    build: (ctx) => [...wall(ctx.origin, area.radius, 4), ...s.build(ctx.origin)],
    player: { gameMode: "survival", time: "day", ...(s.start ? { at: s.start } : {}), yaw: s.yaw ?? 0 },
    action: (ctx) => {
      const g = ctx.at(s.goal);
      return { action: "goto", x: g.x + 0.5, y: g.y, z: g.z + 0.5, radius: 0.6, timeoutMs };
    },
    measure: async (ctx, o) => {
      const g = ctx.at(s.goal);
      const p = o.state?.location;
      const off = p ? Math.hypot(p.x - (g.x + 0.5), p.z - (g.z + 0.5)) : Number.NaN;
      return {
        offGoal: Math.round(off * 100) / 100,
        dy: p ? Math.round((p.y - g.y) * 100) / 100 : Number.NaN,
        ...counts(o.message),
        ...((await s.measure?.(ctx, o)) ?? {}),
      };
    },
    success: (o, extra) => o.ok && o.deaths === 0 && o.damageTaken === 0 && Math.abs(Number(extra.dy)) <= 1 && (s.also?.(o, extra) ?? true),
  };
}
