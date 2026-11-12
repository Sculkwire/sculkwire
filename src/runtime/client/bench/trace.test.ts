import { describe, expect, it } from "vitest";
import type { TraceFrame, TraceMob } from "../skills/stats.ts";
import husks3 from "./scenarios/combat-husks3.ts";
import { traceMetrics } from "./trace.ts";
import type { BenchContext, RunOutcome } from "./types.ts";

describe("trace metrics", () => {
  const mob = (over: Partial<TraceMob> = {}): TraceMob => ({ id: "z1", type: "zombie", dist: 5, reach: 2.5, coolMs: 0, offViewDeg: 0, closing: 0, target: true, ...over });
  const frame = (t: number, over: Partial<TraceFrame> = {}): TraceFrame => ({
    t,
    x: 0,
    z: 0,
    onGround: true,
    mobs: [],
    foot: "hold",
    plan: "wait",
    readyMs: 0,
    shield: false,
    aimErr: 0,
    aimTol: 10,
    fwd: 0,
    strafe: 0,
    sprint: false,
    ...over,
  });
  // A hit, a step back out of reach, a second hit stood still in reach through a 200 ms stall, then a swing.
  const frames: TraceFrame[] = [
    frame(0, { mobs: [mob({ dist: 2.5 }), mob({ id: "s1", type: "skeleton", dist: 10, reach: 15, target: false })], readyMs: 300, shield: true, ev: ["swing", "hit"], aimErr: 4 }),
    frame(25, { x: 0.05, mobs: [mob({ dist: 2.7 })], foot: "retreat", readyMs: 275 }),
    frame(50, { x: 0.1, mobs: [mob({ dist: 3.1 })], foot: "retreat" }),
    frame(75, { x: 0.1, mobs: [mob({ dist: 2.4 }), mob({ id: "z2", dist: 1, reach: 2, target: false })], foot: "advance", readyMs: 500, ev: ["swing", "hit"], aimErr: 6 }),
    frame(275, { x: 0.1, mobs: [mob({ dist: 2.4, coolMs: 800 })], readyMs: 50 }),
    frame(300, { x: 0.1, mobs: [mob({ dist: 2.4 })], ev: ["swing"], aimErr: 8 }),
  ];
  it("reads step-backs, time in reach, idling, shield and footwork off the frames", () => {
    expect(traceMetrics(frames)).toEqual({
      hits: 2,
      stepBacks: 1,
      stepBackShare: 0.5,
      blocks: 0,
      idleInReachMs: 100,
      inReachStillMs: 100,
      inReachMs: 150,
      shieldMs: 25,
      retreatMs: 50,
      advanceMs: 100,
      holdMs: 50,
      maxMobsInReach: 2,
      aimErrAtSwing: 6,
    });
  });
  it("counts blocks, and standing still behind the raised shield is not idle exposure", () => {
    const guarded: TraceFrame[] = [
      frame(0, { mobs: [mob({ dist: 2 })], readyMs: 400, shield: true, foot: "guard" }),
      frame(25, { mobs: [mob({ dist: 2 })], readyMs: 375, shield: true, foot: "guard", ev: ["block"] }),
      frame(50, { mobs: [mob({ dist: 2 })], readyMs: 350, shield: false }),
      frame(75, { mobs: [mob({ dist: 2 })], readyMs: 325, shield: true, ev: ["block"] }),
      frame(100, { mobs: [mob({ dist: 2 })] }),
    ];
    expect(traceMetrics(guarded)).toMatchObject({ blocks: 2, idleInReachMs: 25, inReachStillMs: 100, shieldMs: 75, hits: 0, stepBacks: 0, stepBackShare: 0 });
  });
  it("is all zero for no frames, with no aim figure", () => {
    expect(traceMetrics([])).toEqual({
      hits: 0,
      stepBacks: 0,
      stepBackShare: 0,
      blocks: 0,
      idleInReachMs: 0,
      inReachStillMs: 0,
      inReachMs: 0,
      shieldMs: 0,
      retreatMs: 0,
      advanceMs: 0,
      holdMs: 0,
      maxMobsInReach: 0,
    });
  });
  it("lands in a combat scenario's extras next to the fight's own counts", async () => {
    const outcome: RunOutcome = { ok: true, message: "", durationMs: 1, healthStart: 20, healthEnd: 20, damageTaken: 0, blastDamage: 0, fallDamage: 0, falls: 0, deaths: 0, kills: 3, lost: 0, exploded: 0, hurts: [], frames };
    const extra = await husks3.measure?.({} as BenchContext, outcome);
    expect(extra).toMatchObject({ stepBacks: 1, stepBackShare: 0.5, blocks: 0, idleInReachMs: 100, inReachStillMs: 100, inReachMs: 150, maxMobsInReach: 2, aimErrAtSwing: 6, hits: 0, misses: 0, crits: 0, blocked: 0, cleared: true });
    const played = { ...outcome, play: { stats: { swings: 4, hits: 3, misses: 1, crits: 0, blocked: 2 }, trace: [] } } as unknown as RunOutcome;
    expect(await husks3.measure?.({} as BenchContext, played)).toMatchObject({ blocked: 2, hits: 3 });
  });
});
