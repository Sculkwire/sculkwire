import { describe, expect, it } from "vitest";
import { angleDiff } from "../geometry.ts";
import { crowdMove, isolated, pickDuelTarget } from "./crowd.ts";

describe("fighting a group", () => {
  const origin = { x: 0, y: 0, z: 0 };
  const at = (id: string, x: number, z: number) => ({ id, location: { x, y: 0, z } });

  it("fights the closest mob, or the one hitting the player", () => {
    expect(pickDuelTarget(origin, "a", [at("a", 0, 3), at("b", 0, 1.5)], false)).toBe("b");
    expect(pickDuelTarget(origin, "a", [at("a", 0, 3), at("b", 0, 2.4)], false)).toBe("a");
    expect(pickDuelTarget(origin, "a", [at("a", 0, 3), at("b", 0, 2.4)], true)).toBe("b");
    expect(pickDuelTarget(origin, "a", [at("a", 0, 3)], true)).toBe("a");
  });

  it("jumps for crits only against a lone mob", () => {
    expect(isolated(origin, "a", [at("a", 0, 3), at("b", 3, 0)])).toBe(false);
    expect(isolated(origin, "a", [at("a", 0, 3), at("b", 6, 0)])).toBe(true);
  });

  it("backs off to the side away from the group, and away from all when one flanks", () => {
    const target = at("a", 0, 3);
    expect(crowdMove(origin, target, [target])).toBeUndefined();
    // A second zombie ahead and to the right (-X): step back and to the left (+X, -Z).
    const kite = crowdMove(origin, target, [target, at("b", -1.5, 3)]);
    expect(kite?.reason).toBe("kite");
    expect(Math.abs(angleDiff(-135, kite?.heading ?? 0))).toBeLessThan(1);
    // One beside on the left (+X): get away from both, toward -X and -Z, so both end up in front.
    const flank = crowdMove(origin, target, [target, at("b", 3, 0)]);
    expect(flank?.reason).toBe("flanked");
    expect(Math.abs(angleDiff(135, flank?.heading ?? 0))).toBeLessThan(1);
  });
});
