import { describe, expect, it } from "vitest";
import { fakeGame } from "../../../testing/skillgame.ts";
import { combatStats, MAX_TRACE_FRAMES, resetStats, traceFights, traceFrame, type TraceFrame } from "./stats.ts";

describe("fight results", () => {
  it("keeps tracing on across resetStats, capped at MAX_TRACE_FRAMES", () => {
    const pc = fakeGame([]).env.controller;
    const frame: Omit<TraceFrame, "t"> = { x: 0, z: 0, onGround: true, mobs: [], foot: "hold", plan: "wait", readyMs: 0, shield: false, aimErr: 0, aimTol: 5, fwd: 0, strafe: 0, sprint: false };
    expect(combatStats(pc).trace).toBeUndefined();
    traceFights(pc, true);
    for (let i = 0; i < MAX_TRACE_FRAMES + 5; i++) traceFrame(combatStats(pc), pc.hands.now(), frame);
    expect(combatStats(pc).trace).toHaveLength(MAX_TRACE_FRAMES);
    expect(resetStats(pc).trace).toEqual([]);
    traceFights(pc, false);
    expect(resetStats(pc).trace).toBeUndefined();
  });
});
