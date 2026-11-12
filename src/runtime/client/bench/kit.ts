/** Shared pieces of the combat scenarios: the standard loadout, a walled arena and the common judging. */
import type { Vec3 } from "../player.ts";
import { fillBox } from "./arena.ts";
import { traceMetrics } from "./trace.ts";
import type { Metric, MobSpawn, PlayerSetup, RunOutcome, Scenario } from "./types.ts";

/** Survival at night with an iron sword, cooked beef, full iron armor and a shield in the off hand. */
export const FIGHTER: PlayerSetup = {
  gameMode: "survival",
  time: "night",
  hotbar: [{ item: "iron_sword" }, { item: "cooked_beef", amount: 16 }],
  armor: "iron",
  offhand: "shield",
};

export const COMBAT_AREA = { radius: 14, height: 6 };

/** A glass ring three blocks high at the arena's edge, so mobs and player stay in the arena. */
export function wall(origin: Vec3, radius = COMBAT_AREA.radius, height = 3): string[] {
  const r = radius;
  const y0 = origin.y;
  const y1 = origin.y + height - 1;
  const side = (x0: number, z0: number, x1: number, z1: number) => fillBox({ x: origin.x + x0, y: y0, z: origin.z + z0 }, { x: origin.x + x1, y: y1, z: origin.z + z1 }, "minecraft:glass");
  return [...side(-r, -r, r, -r), ...side(-r, r, r, r), ...side(-r, -r, -r, r), ...side(r, -r, r, r)];
}

/**
 * A combat scenario: the standard arena, a `play` kill goal, judged on kills and deaths. The extras add the fight's
 * own counts and, from the run's per-tick trace, how the player moved and blocked while mobs could reach it
 * (`traceMetrics`; the stats' `hits` stays the hit count, the trace's own count of hit frames is not repeated).
 */
export function combat(
  s: Pick<Scenario, "name" | "summary" | "runs" | "spawnAfterMs"> & {
    mobs: MobSpawn[];
    goal: string;
    /** Default `FIGHTER` (night); `{ ...FIGHTER, time: "day" }` for a day fight. */
    player?: PlayerSetup;
    timeoutMs?: number;
    build?: (origin: Vec3) => string[];
    /** Extra success condition on top of every mob killed and no death. */
    also?: (o: RunOutcome, extra: Record<string, Metric>) => boolean;
    /** Replaces the default success rule (every mob killed by the player, no death, `also`). */
    success?: (o: RunOutcome, extra: Record<string, Metric>) => boolean;
  },
): Scenario {
  const timeoutMs = s.timeoutMs ?? 90_000;
  return {
    name: s.name,
    suite: "combat",
    summary: s.summary,
    runs: s.runs,
    timeoutMs,
    area: COMBAT_AREA,
    build: (ctx) => [...wall(ctx.origin), ...(s.build?.(ctx.origin) ?? [])],
    player: s.player ?? FIGHTER,
    mobs: s.mobs,
    ...(s.spawnAfterMs !== undefined ? { spawnAfterMs: s.spawnAfterMs } : {}),
    action: () => ({ action: "play", goal: s.goal, durationMs: timeoutMs }),
    measure: (_ctx, o) => {
      const by = (re: RegExp) => Math.round(o.hurts.filter((h) => re.test(h.damager ?? "")).reduce((t, h) => t + h.damage, 0) * 10) / 10;
      const tactics = o.play?.trace ?? [];
      const extra: Record<string, Metric> = {
        hitsTaken: o.hurts.length,
        cleared: o.kills === s.mobs.length,
        swings: o.play?.stats.swings ?? 0,
        hits: o.play?.stats.hits ?? 0,
        misses: o.play?.stats.misses ?? 0,
        crits: o.play?.stats.crits ?? 0,
        blocked: o.play?.stats.blocked ?? 0,
        eats: tactics.filter((t) => t.action === "eat" && t.result.ok).length,
        flees: tactics.filter((t) => t.action === "flee").length,
        zombieDmg: by(/zombie/),
        skeletonDmg: by(/skeleton|arrow/),
        spiderDmg: by(/spider/),
        exploded: o.exploded,
        // Spawned or not, mobs near that died by something other than the player (spear husks hit each other).
        otherDeaths: Object.values(o.play?.stats.otherDeaths ?? {}).reduce((n, k) => n + k, 0),
      };
      if (o.frames) {
        const { hits: _traceHits, aimErrAtSwing, ...trace } = traceMetrics(o.frames);
        Object.assign(extra, trace);
        if (aimErrAtSwing !== undefined) extra.aimErrAtSwing = aimErrAtSwing;
      }
      return extra;
    },
    success: s.success ?? ((o, extra) => o.kills === s.mobs.length && o.deaths === 0 && (s.also?.(o, extra) ?? true)),
  };
}
