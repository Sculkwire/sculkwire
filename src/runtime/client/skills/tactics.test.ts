import { describe, expect, it } from "vitest";
import { killHostiles, kit, mapOf, me, mob } from "../../../testing/skillgame.ts";
import { parseGoal } from "./goal.ts";
import { chooseTactic, scoreTactics, tacticKey } from "./tactics.ts";
import { ThreatTracker } from "./threat.ts";

describe("tactic scores", () => {
  it("fights the nearest of several zombies", () => {
    const m = mapOf([mob("far", "zombie", 0, 9), mob("near", "zombie", 3, 0), mob("mid", "zombie", 0, -5)]);
    const best = chooseTactic(scoreTactics(m, killHostiles));
    expect(best.kind).toBe("fight");
    expect(best.target?.id).toBe("near");
  });

  it("flees when nearly dead with a zombie close, and eats once it is safe", () => {
    const close = chooseTactic(scoreTactics(mapOf([mob("z", "zombie", 0, 3)], { health: 4 }, kit(16)), killHostiles));
    expect(close.kind).toBe("flee");
    const safe = chooseTactic(scoreTactics(mapOf([mob("z", "zombie", 0, 15)], { health: 4 }, kit(16)), killHostiles));
    expect(safe.kind).toBe("eat");
    const nothing = chooseTactic(scoreTactics(mapOf([], { health: 9 }, kit(19)), parseGoal("explore")));
    expect(nothing.kind).toBe("eat");
  });

  it("eats when hungry but not with a mob at hand, and never at a full food bar", () => {
    expect(chooseTactic(scoreTactics(mapOf([], {}, kit(6)), parseGoal("explore"))).kind).toBe("eat");
    expect(chooseTactic(scoreTactics(mapOf([mob("z", "zombie", 0, 3)], {}, kit(6)), killHostiles)).kind).toBe("fight");
    expect(scoreTactics(mapOf([], { health: 5 }, kit(20)), parseGoal("explore")).some((t) => t.kind === "eat")).toBe(false);
  });

  it("backs off from a creeper whose fuse has burned, and fights one that just came close", () => {
    const t = new ThreatTracker();
    t.update(0, me(), [mob("c", "creeper", 2, 0)]);
    const fresh = chooseTactic(scoreTactics(t.update(100, me(), [mob("c", "creeper", 2, 0)]), killHostiles));
    expect(fresh.kind).toBe("fight");
    const burning = t.update(700, me(), [mob("c", "creeper", 2, 0)]);
    const run = chooseTactic(scoreTactics(burning, killHostiles), "fight:c");
    expect(run.kind).toBe("flee");
    expect(run.target?.id).toBe("c");
    expect(run.score).toBeGreaterThanOrEqual(0.9);
  });

  it("walks to a reach goal, uses the item on goal targets not hit yet, and idles otherwise", () => {
    expect(chooseTactic(scoreTactics(mapOf([]), parseGoal("go to 10 64 -20"))).kind).toBe("goto");
    const cows = mapOf([mob("a", "cow", 0, 4), mob("b", "cow", 0, 8)]);
    const goal = parseGoal("hit every cow near you once with the held item");
    const first = chooseTactic(scoreTactics(cows, goal));
    expect([first.kind, first.target?.id]).toEqual(["use_on", "a"]);
    const second = chooseTactic(scoreTactics(cows, goal, { usedOn: new Map([["a", "minecraft:cow"]]) }));
    expect(second.target?.id).toBe("b");
    expect(chooseTactic(scoreTactics(mapOf([mob("a", "cow", 0, 4)]), killHostiles)).kind).toBe("idle");
  });

  it("keeps the running tactic unless another is clearly better, keeps one fight across targets, and honours the allow list", () => {
    const m = mapOf([mob("a", "zombie", 0, 3), mob("b", "zombie", 0, 3.5)]);
    const scored = scoreTactics(m, killHostiles);
    // A fight moves from mob to mob by itself: one tactic, started on the best-scored target.
    expect(tacticKey(chooseTactic(scored, "fight"))).toBe("fight");
    expect(chooseTactic(scored, "fight").target?.id).toBe("a");
    const cows = mapOf([mob("a", "cow", 0, 4), mob("b", "cow", 0, 4.5)]);
    const use = scoreTactics(cows, parseGoal("hit every cow near you once with the held item"));
    expect(tacticKey(chooseTactic(use, "use_on:b"))).toBe("use_on:b");
    expect(tacticKey(chooseTactic(use))).toBe("use_on:a");
    const noFight = scoreTactics(m, killHostiles, { allowed: new Set(["flee", "idle"]) });
    expect(noFight.map((t) => t.kind)).toEqual(["idle"]);
  });
});

describe("emergency", () => {
  it("preempts the running tactic at once", () => {
    const t = new ThreatTracker();
    t.update(0, me(), [mob("c", "creeper", 2, 0)]);
    const burning = scoreTactics(t.update(800, me(), [mob("c", "creeper", 2, 0)]), killHostiles);
    expect(chooseTactic(burning, "fight:c").kind).toBe("flee");
  });
});

describe("recovery", () => {
  it("keeps away while recovering until health is back, fighting only a mob at hand", () => {
    const far = mapOf([mob("z", "zombie", 0, 10)], { health: 9 });
    expect(chooseTactic(scoreTactics(far, killHostiles)).kind).toBe("fight");
    const away = chooseTactic(scoreTactics(far, killHostiles, { recovering: true }));
    expect([away.kind, away.recover]).toEqual(["flee", true]);
    // Past the flee range a kill goal's target is still gone after, at a low score any flee or meal beats (a goal
    // target that keeps away must not leave the run idle); without a kill goal the player rests.
    const gone = scoreTactics(mapOf([mob("z", "zombie", 0, 15)], { health: 9 }), killHostiles, { recovering: true });
    expect(gone.map((t) => [t.kind, t.score])).toEqual([
      ["fight", 0.3],
      ["idle", 0.05],
    ]);
    expect(scoreTactics(mapOf([mob("z", "zombie", 0, 15)], { health: 9 }), { kind: "free" }, { recovering: true }).map((t) => t.kind)).toEqual(["idle"]);
    expect(chooseTactic(scoreTactics(mapOf([mob("z", "zombie", 0, 10)], { health: 13 }), killHostiles, { recovering: true })).kind).toBe("fight");
  });
});

describe("cornered", () => {
  it("fights back the mob at hand when running just failed", () => {
    const m = mapOf([mob("z", "zombie", 0, 2)], { health: 5 });
    expect(chooseTactic(scoreTactics(m, killHostiles)).kind).toBe("flee");
    const back = chooseTactic(scoreTactics(m, killHostiles, { recovering: true, cornered: true }));
    expect([back.kind, back.target?.id]).toEqual(["fight", "z"]);
  });
});
