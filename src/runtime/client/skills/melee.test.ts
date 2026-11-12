import { describe, expect, it } from "vitest";
import { CRIT_GIVE_UP_MS, HIT_CONFIRM_MS, HIT_COOLDOWN_MS, HIT_DOUBT_MS, meleePlan, swingOutcome, type MeleeInput } from "./melee.ts";

describe("melee timing", () => {
  const base: MeleeInput = { now: 10_000, lastHit: 0, onGround: true, vy: 0, inReach: true, nearReach: true, crits: true };

  it("jumps shortly before the next hit is due and swings on the way down", () => {
    expect(meleePlan({ ...base, lastHit: base.now - HIT_COOLDOWN_MS + 450 })).toBe("wait");
    expect(meleePlan({ ...base, lastHit: base.now - HIT_COOLDOWN_MS + 300 })).toBe("jump");
    // Rising: hold the swing until the fall.
    expect(meleePlan({ ...base, onGround: false, vy: 0.3, airborneSince: base.now - 100 })).toBe("wait");
    expect(meleePlan({ ...base, onGround: false, vy: -0.15, airborneSince: base.now - 400 })).toBe("crit");
    // Falling but the target is still invulnerable: no wasted swing.
    expect(meleePlan({ ...base, lastHit: base.now - 200, onGround: false, vy: -0.15 })).toBe("wait");
  });

  it("gives up on a crit that does not come, and hits plainly without crits", () => {
    expect(meleePlan({ ...base, lastHit: base.now - HIT_COOLDOWN_MS - CRIT_GIVE_UP_MS - 1 })).toBe("swing");
    expect(meleePlan({ ...base, crits: false })).toBe("swing");
    expect(meleePlan({ ...base, crits: false, lastHit: base.now - 100 })).toBe("wait");
    expect(meleePlan({ ...base, crits: false, inReach: false })).toBe("wait");
    expect(meleePlan({ ...base, onGround: false, vy: 0, airborneSince: base.now - 1000 })).toBe("swing");
    expect(meleePlan({ ...base, nearReach: false, inReach: false })).toBe("wait");
  });

  it("judges a keyboard click by the target's health reading", () => {
    const p = { at: 1000, health: 20 };
    expect(swingOutcome(p, 1100, 20)).toBe("pending");
    expect(swingOutcome(p, 1250, 14)).toBe("hit");
    expect(swingOutcome(p, 1000 + HIT_DOUBT_MS, 20)).toBe("doubt");
    // A reading that drops late still makes it a hit.
    expect(swingOutcome(p, 1000 + HIT_CONFIRM_MS - 1, 17)).toBe("hit");
    expect(swingOutcome(p, 1000 + HIT_CONFIRM_MS, 20)).toBe("miss");
    expect(swingOutcome(p, 1000 + HIT_CONFIRM_MS, undefined)).toBe("miss");
  });
});
