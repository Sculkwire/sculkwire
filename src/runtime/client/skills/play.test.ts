import { describe, expect, it } from "vitest";
import { fakeGame, me, mob } from "../../../testing/skillgame.ts";
import { play } from "./play.ts";

describe("play loop", () => {
  it("kills every hostile and stops on the built-in goal check", async () => {
    const game = fakeGame([mob("-11", "zombie", 0, 2.5), mob("-12", "zombie", 0, 2.8)]);
    const r = await play({ action: "play", goal: "kill the hostile mobs near you", durationMs: 15_000 }, game.env);
    expect(r).toMatchObject({ stoppedBy: "goal_done", goalCheck: { kind: "kill", known: true } });
    expect(r.stats).toMatchObject({ kills: 2, killed: { zombie: 2 }, hits: 2, misses: 0, hitsTaken: 0, blocked: 0, deaths: 0 });
    // One fight for both: it moves on to the next hostile by itself.
    expect(r.trace.map((t) => [t.action, t.target?.id])).toEqual([
      ["fight", "-11"],
      // Idles while the goal check confirms nothing is left.
      ["idle", undefined],
    ]);
    expect(game.entities).toEqual([]);
  });

  it("runs a goal the built-in checks cannot verify until the time limit", async () => {
    const r = await play({ action: "play", goal: "dance a little", durationMs: 1000, stepMs: 100 }, fakeGame([]).env);
    expect([r.stoppedBy, r.goalCheck.known]).toEqual(["timeout", false]);
    expect(r.message).toMatch(/time limit: the built-in checks cannot verify this goal/);
    expect(r.trace[0]).toMatchObject({ action: "idle", score: expect.any(Number), reason: expect.any(String) });
  });

  it("stops when the player dies and when the simulation is paused", async () => {
    const dead = fakeGame([], me({ health: 0 }));
    expect(await play({ action: "play", goal: "g" }, dead.env)).toMatchObject({ stoppedBy: "died", stats: { deaths: 1 } });
    const paused = fakeGame([]);
    const p = await play({ action: "play", goal: "g" }, { ...paused.env, paused: () => true });
    expect([p.stoppedBy, p.message]).toEqual(["error", expect.stringMatching(/paused/)]);
  });

  it("rejects unknown tactics in allow", async () => {
    await expect(play({ action: "play", goal: "g", allow: ["fly"] }, fakeGame([]).env)).rejects.toThrow(/unknown play tactic/);
  });
});
