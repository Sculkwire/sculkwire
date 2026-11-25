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

  it("stops at the first death with maxDeaths 0, and when the simulation is paused", async () => {
    const dead = fakeGame([], me({ health: 0 }));
    let respawns = 0;
    const respawn = async () => {
      respawns++;
      return { respawned: true, via: "press" as const, detail: "respawned" };
    };
    expect(await play({ action: "play", goal: "g", maxDeaths: 0 }, { ...dead.env, respawn })).toMatchObject({ stoppedBy: "died", message: "the player died", stats: { deaths: 1 } });
    expect(respawns).toBe(0);
    const paused = fakeGame([]);
    const p = await play({ action: "play", goal: "g" }, { ...paused.env, paused: () => true });
    expect([p.stoppedBy, p.message]).toEqual(["error", expect.stringMatching(/paused/)]);
  });

  it("respawns after a death mid-goal and goes on with it, counting the death", async () => {
    const game = fakeGame([]);
    // The player dies on the loop's third decision.
    let reads = 0;
    const entities = async () => {
      if (++reads === 3) game.state.health = 0;
      return game.env.entities();
    };
    let respawns = 0;
    const respawn = async () => {
      respawns++;
      game.state.health = 20;
      return { respawned: true, via: "press" as const, detail: "respawned (death: press RESPAWN (button.respawn_button))" };
    };
    const r = await play({ action: "play", goal: "survive for 1 second", durationMs: 5000, stepMs: 100 }, { ...game.env, entities, respawn });
    expect(r).toMatchObject({ stoppedBy: "goal_done", stats: { deaths: 1, health: 20 } });
    expect(respawns).toBe(1);
  });

  it("stops with died when RESPAWN does not bring the player back, or after maxDeaths deaths", async () => {
    const failing = fakeGame([], me({ health: 0 }));
    const stuck = await play({ action: "play", goal: "g" }, { ...failing.env, respawn: async () => ({ respawned: false, via: "click" as const, detail: "the player did not respawn within 15 s" }) });
    expect(stuck).toMatchObject({ stoppedBy: "died", message: "the player died and did not respawn: the player did not respawn within 15 s", stats: { deaths: 1 } });
    // RESPAWN is pressed, but the player dies again at once: two respawns, the third death stops the run.
    const again = fakeGame([], me({ health: 0 }));
    let respawns = 0;
    const r = await play({ action: "play", goal: "g", maxDeaths: 2 }, { ...again.env, respawn: async () => ({ respawned: true, via: "press" as const, detail: `respawned ${++respawns}` }) });
    expect(r).toMatchObject({ stoppedBy: "died", message: expect.stringMatching(/died 3 times; play respawns at most 2/), stats: { deaths: 3 } });
    expect(respawns).toBe(2);
  });

  it("rejects unknown tactics in allow", async () => {
    await expect(play({ action: "play", goal: "g", allow: ["fly"] }, fakeGame([]).env)).rejects.toThrow(/unknown play tactic/);
  });
});
