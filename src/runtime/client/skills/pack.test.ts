import { describe, expect, it } from "vitest";
import { attackers, bearingArc, ENGINE_LATENCY_MS, feetClear, nextAttackMs, packMove, raiseLeadMs, shieldSwingOk, strikeTarget, SWING_OPENS_SHIELD_MS, type PackInput, type PackMob } from "./pack.ts";

/** A zombie `dist` blocks away, `off` degrees off the view (the view looks at yaw 0), straight on its axis by default. */
const zombie = (id: string, dist: number, off = 0, extra: Partial<PackMob> = {}): PackMob => ({
  id,
  dist,
  bearing: off,
  offViewDeg: off,
  mobReach: 1.4,
  closing: 2.3,
  speed: 2.3,
  dueMs: 0,
  hittableMs: 0,
  ...extra,
});
const open = () => 6;
const input = (mobs: PackMob[], extra: Partial<PackInput> = {}): PackInput => ({ mobs, stance: "auto", hasShield: true, latencyMs: ENGINE_LATENCY_MS, view: 0, room: open, ...extra });

describe("pack footwork", () => {
  it("waits for a lone zombie at the edge of reach, shield down", () => {
    // 3 blocks out it needs (3 - 1.4) / 2.3 = 0.7 s to have the player in reach: stand and let it come.
    expect(packMove(input([zombie("a", 3)]))).toMatchObject({ foot: "hold", shield: false });
    expect(packMove(input([zombie("a", 3.8)]))).toMatchObject({ foot: "hold", shield: false });
    // From 8 blocks, walk to meet it; one that does not come is walked up to.
    expect(packMove(input([zombie("a", 8)]))).toMatchObject({ foot: "advance", shield: false, sprint: true, heading: 0 });
    expect(packMove(input([zombie("a", 4.5, 0, { closing: 0, speed: 0 })]))).toMatchObject({ foot: "advance", shield: false });
  });

  it("in auto decides exactly as kite does with room behind: the same feet, the shield never up", () => {
    const cases = [[zombie("a", 2.4)], [zombie("a", 1.8)], [zombie("a", 1.3, 40)], [zombie("a", 8)], [zombie("a", 3, -20), zombie("b", 3.3, 25)], [zombie("a", 2.4)]];
    for (const room of [open, () => 2, () => 1.2]) {
      for (const mobs of cases) {
        const auto = packMove(input(mobs, { room }));
        expect(auto).toEqual(packMove(input(mobs, { stance: "kite", room })));
        expect(auto.shield).toBe(false);
      }
    }
    // A mob faster than the backpedal (a ravager at 6 blocks a second) on open ground: still the feet.
    expect(packMove(input([zombie("r", 4.5, 0, { speed: 6, closing: 6, mobReach: 2 })]))).toMatchObject({ shield: false });
  });

  it("in auto raises the shield only boxed in, 400 ms ahead of the attack, and kite never", () => {
    const boxed = { room: () => 0.5 };
    // (2.4 - 1.4) / 2.3 = 435 ms: within the raise window, and still ahead of the lead.
    expect(packMove(input([zombie("a", 2.4)], boxed))).toMatchObject({ foot: "guard", shield: true });
    expect(packMove(input([zombie("a", 2.4)], { ...boxed, stance: "kite" }))).toMatchObject({ shield: false });
    // Attacks of several zombies following each other closer than the lead: it stays up.
    const mobs = [zombie("a", 1.3, -20, { dueMs: 700 }), zombie("b", 1.3, 0, { dueMs: 300 }), zombie("c", 1.3, 20, { dueMs: 1000 })];
    expect(packMove(input(mobs, { ...boxed, guardMs: 800 }))).toMatchObject({ foot: "guard", shield: true });
  });

  it("does not count a raise sent less than 400 ms before the attack as protection: guard steps back, auto with room never raises", () => {
    const lead = raiseLeadMs(ENGINE_LATENCY_MS);
    expect(lead).toBe(400);
    // Out of reach by a little, the attack due as it gets in: 200 ms. With room: `auto` keeps walking away.
    const m = zombie("a", 1.86);
    expect(packMove(input([m]))).toMatchObject({ foot: "retreat", shield: false });
    expect(packMove(input([m], { room: () => 1.2 }))).toMatchObject({ foot: "retreat", shield: false });
    // `guard`: a fresh raise would come too late, so the feet; up for 250 ms already, it blocks.
    expect(packMove(input([m], { stance: "guard" }))).toMatchObject({ foot: "retreat", shield: false });
    expect(packMove(input([m], { stance: "guard", guardMs: 250 }))).toMatchObject({ foot: "guard", shield: true });
    // Boxed in, `auto` still never raises it late (it would block nothing, and lowering it holds the feet still); a
    // stalled `guard` with nowhere to go raises it for the next attack.
    expect(packMove(input([m], { room: () => 0.5 }))).toMatchObject({ foot: "retreat", shield: false });
    expect(packMove(input([m], { stance: "guard", stepOut: true, room: () => 0.5 }))).toMatchObject({ foot: "guard", shield: true });
    // A swing 200 ms ago keeps the shield open 450 ms more: a raise for an attack due in 478 ms would not block it.
    expect(packMove(input([zombie("a", 2.5)], { room: () => 0.5, swingAgoMs: 200 }))).toMatchObject({ shield: false });
    expect(packMove(input([zombie("a", 2.5)], { room: () => 0.5, swingAgoMs: 500 }))).toMatchObject({ foot: "guard", shield: true });
  });

  it("guard steps out when its clocks leave no window: shield only for an attack it can block in time", () => {
    const mobs = [zombie("a", 1.3, -20, { dueMs: 700 }), zombie("b", 1.3, 0, { dueMs: 300 }), zombie("c", 1.3, 20, { dueMs: 1000 })];
    expect(packMove(input(mobs, { stance: "guard", guardMs: 2000 }))).toMatchObject({ foot: "guard", shield: true });
    // Stepping out: b is due in 300 ms, too late for a fresh raise, so back at full speed.
    expect(packMove(input(mobs, { stance: "guard", stepOut: true }))).toMatchObject({ foot: "retreat", shield: false });
    // Stepping out with a mob due 450 ms away: up in time, so the shield.
    expect(packMove(input([zombie("a", 1.3, 0, { dueMs: 450 })], { stance: "guard", stepOut: true }))).toMatchObject({ foot: "guard", shield: true });
  });

  it("swings from behind the shield only when no covered mob can attack while the swing holds it open", () => {
    // 650 ms open plus 100 ms latency: an attack due later than 750 ms is safe.
    expect(SWING_OPENS_SHIELD_MS).toBe(650);
    // Right after a block the mob waits 1500 ms.
    expect(nextAttackMs(1000, true, 1000)).toBe(2500);
    expect(nextAttackMs(1000, false, 1000)).toBe(2000);
    expect(shieldSwingOk([zombie("a", 1.3, 0, { dueMs: 1400 })], ENGINE_LATENCY_MS)).toBe(true);
    expect(shieldSwingOk([zombie("a", 1.3, 0, { dueMs: 700 })], ENGINE_LATENCY_MS)).toBe(false);
    // One coming into reach with an unknown clock attacks as it gets there: (2.8 - 1.4) / 2.3 = 609 ms.
    expect(shieldSwingOk([zombie("a", 1.3, 0, { dueMs: 1400 }), zombie("b", 2.8, 10)], ENGINE_LATENCY_MS)).toBe(false);
    // One at the arc's edge counts too: the raised shield still blocks it at 80 degrees.
    expect(shieldSwingOk([zombie("a", 1.3, 0, { dueMs: 1400 }), zombie("c", 1.3, 80)], ENGINE_LATENCY_MS)).toBe(false);
  });

  it("covers only the front half: a zombie in reach 80 degrees off is stepped away from, or the pack turned in front", () => {
    const side = zombie("a", 1.9, 80, { mobReach: 1.98, dueMs: 500 });
    expect(packMove(input([side]))).toMatchObject({ foot: "retreat", shield: false });
    // In a corner the feet cannot: turn so it is in front and shield (`guard`; `auto` raises it only in time).
    const cornered = packMove(input([zombie("a", 1.5, 80, { mobReach: 1.98 })], { stance: "guard", room: () => 0 }));
    expect(cornered).toMatchObject({ shield: true });
    expect(cornered.face).toBeCloseTo(80, 0);
  });

  it("walks out when the pack is around the player (more than one shield arc), whatever the stance", () => {
    const mobs = [zombie("a", 1.5, -100, { mobReach: 1.98 }), zombie("b", 1.5, 100, { mobReach: 1.98 }), zombie("c", 1.5, 0)];
    expect(packMove(input(mobs, { room: () => 0 }))).toMatchObject({ foot: "retreat", shield: false });
    expect(packMove(input(mobs, { stance: "guard", room: () => 0 }))).toMatchObject({ foot: "retreat", shield: false });
  });

  it("never raises the shield against an axe: it steps back", () => {
    expect(packMove(input([zombie("v", 1.7, 0, { axe: true, speed: 3.5, closing: 3.5 })]))).toMatchObject({ foot: "retreat", shield: false });
  });

  it("holds the ground behind the shield in guard stance, and boxed in", () => {
    expect(packMove(input([zombie("a", 3.5)], { stance: "guard" }))).toMatchObject({ foot: "guard", shield: true });
    expect(packMove(input([zombie("a", 1.7)], { stance: "guard", room: () => 0 }))).toMatchObject({ foot: "guard", shield: true });
    // `auto` boxed in with the attack due too soon for a raise: no shield.
    expect(packMove(input([zombie("a", 1.7)], { room: () => 0 }))).toMatchObject({ shield: false });
  });

  it("gets out of a zombie's reach in time only walking backward faster than it, with room", () => {
    expect(feetClear(zombie("a", 1.86), 200, 100, 6)).toBe(true);
    expect(feetClear(zombie("a", 1.86), 200, 100, 1)).toBe(false);
    // Inside its reach: 0.6 blocks to gain at 2 blocks a second take 300 ms more.
    expect(feetClear(zombie("a", 0.9), 200, 100, 6)).toBe(false);
    expect(feetClear(zombie("r", 1.86, 0, { speed: 6, closing: 6 }), 1000, 100, 6)).toBe(false);
  });
});

describe("pack hand and attack clocks", () => {
  it("strikes the mob in reach the hand can strike soonest, keeping the current one while it is about as soon", () => {
    // 40 degrees off takes a 300 ms turn, 5 degrees none.
    const a = zombie("a", 2.5, 40, { strikeInMs: 300 });
    const b = zombie("b", 2.5, 5, { strikeInMs: 0 });
    expect(strikeTarget([a, b], undefined, ENGINE_LATENCY_MS)).toBe("b");
    // The current one far off the view gives way to one under the crosshair (the live run picked a mob 59 degrees off
    // with a nearer one 14 degrees off).
    expect(strikeTarget([a, b], "a", ENGINE_LATENCY_MS)).toBe("b");
    expect(strikeTarget([{ ...a, strikeInMs: 80 }, b], "a", ENGINE_LATENCY_MS)).toBe("a");
    // The current one just struck (invulnerable for 450 ms more): the other.
    expect(strikeTarget([{ ...b, hittableMs: 450, strikeInMs: 450 }, a], "b", ENGINE_LATENCY_MS)).toBe("a");
    // None in reach: the current one while it is about as near as the nearest.
    expect(strikeTarget([zombie("a", 5), zombie("b", 4.5)], "a", ENGINE_LATENCY_MS)).toBe("a");
    expect(strikeTarget([zombie("a", 7), zombie("b", 4.5)], "a", ENGINE_LATENCY_MS)).toBe("b");
  });

  it("steps away from a mob coming in that the hand cannot strike in time, and holds for one it can", () => {
    // 2.6 out, closing at 2.3: in its reach (1.4) in 520 ms. The swing ready and the view on it: hold and strike.
    expect(packMove(input([zombie("a", 2.6, 0, { strikeInMs: 0 })]))).toMatchObject({ foot: "hold" });
    // Just struck (450 ms of invulnerability left): it would be in reach before the hand can answer, so back now.
    expect(packMove(input([zombie("a", 2.6, 0, { hittableMs: 450, strikeInMs: 450 })]))).toMatchObject({ foot: "retreat" });
    // 38 degrees off the view (a turn of 300 ms plus the latency) at 2.6: back.
    expect(packMove(input([zombie("a", 2.6, 38, { strikeInMs: 450 })]))).toMatchObject({ foot: "retreat" });
    // Within the 2.5 the readings show hits from, coming in, the hand not ready: back.
    expect(packMove(input([zombie("a", 2.45, 0, { strikeInMs: 150 })]))).toMatchObject({ foot: "retreat" });
  });

  it("holds only while the hand can strike this tick every mob coming in inside the strike range", () => {
    // 2.9 out and coming, the turn onto it estimated to land in time (100 ms): the view off it by more than the
    // tolerance as the game shows it still means back now; on it, hold and strike.
    expect(packMove(input([zombie("a", 2.9, 0, { strikeInMs: 100, strikeNow: false })]))).toMatchObject({ foot: "retreat" });
    expect(packMove(input([zombie("a", 2.9, 0, { strikeInMs: 0, strikeNow: true })]))).toMatchObject({ foot: "hold" });
    // Backing off (not coming in), or outside the 3.0 strike range and its 0.1 edge: the reading alone does not send the feet back.
    expect(packMove(input([zombie("a", 2.9, 0, { closing: -1, strikeInMs: 100, strikeNow: false })]))).toMatchObject({ foot: "hold" });
    expect(packMove(input([zombie("a", 3.15, 0, { closing: 0.5, strikeInMs: 0, strikeNow: false })])).foot).not.toBe("retreat");
  });

  it("credits an attack to the mob due first and to every long-overdue one in reach; a block only to those in front", () => {
    const due = zombie("a", 1.3, 0, { dueMs: 0 });
    const cool = zombie("b", 1.2, 10, { dueMs: 600 });
    expect(attackers([cool, due], false)).toEqual(["a"]);
    // Two ready on one tick show as one rise: the one due first, and another in reach whose clock is long overdue.
    expect(attackers([due, zombie("e", 1.2, -10, { overdueMs: 600 })], true)).toEqual(["e", "a"]);
    // One that only just came due (the clocks are a tick or two off) is not credited: it may not have attacked yet.
    expect(attackers([zombie("a", 1.3, 0, { overdueMs: 400 }), zombie("g", 1.2, -10, { overdueMs: 50 })], true)).toEqual(["g", "a"]);
    expect(attackers([zombie("h", 1.3, 0, { overdueMs: 400 }), zombie("g", 1.25, -10, { overdueMs: 50 })], true)).toEqual(["g", "h"]);
    expect(attackers([zombie("a", 1.3, 0, { overdueMs: 400 }), zombie("g", 1.2, -10, { overdueMs: 50, dueMs: 0 }), cool], true)).not.toContain("b");
    expect(attackers([zombie("c", 1.3, 120)], true)).toEqual([]);
    expect(attackers([zombie("c", 1.3, 120)], false)).toEqual(["c"]);
    expect(attackers([zombie("d", 3)], false)).toEqual([]);
  });

  it("measures the arc a pack takes around the player", () => {
    expect(bearingArc([350, 10])).toMatchObject({ width: 20 });
    expect(bearingArc([350, 10]).middle % 360).toBeCloseTo(0, 5);
    expect(bearingArc([-110, 110]).width).toBe(140);
    expect(bearingArc([0, 120, 240]).width).toBe(240);
  });
});
