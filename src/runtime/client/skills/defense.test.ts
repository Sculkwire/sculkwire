import { describe, expect, it } from "vitest";
import { clearRun, closeInTicks, creeperLightDist, creeperLit, creeperMove, creeperStand, critSafe, crowdedCreeper, findCover, type FuseMemory, lineBlocked, openHeading, readyInMs, spiderAirborne, trackFuse, untilMobHitMs, weaveDeg } from "./defense.ts";
import { pickDuelTarget } from "./crowd.ts";
import { bowSlot, hasShield } from "./items.ts";
import { HIT_COOLDOWN_MS } from "./melee.ts";
import { boxReach, meleeReach, mobInfo } from "./mobs.ts";
import { EAT_HEALTH, lowHealth, scoreTactics } from "./tactics.ts";
import { ThreatTracker } from "./threat.ts";
import { angleDiff, type EntityInfo, type Loadout, type PlayerState } from "../player.ts";
import { parseGoal } from "./goal.ts";

describe("swing timing", () => {
  it("counts down the struck mob's 10-tick invulnerability for every weapon", () => {
    expect(readyInMs(1000, 1000)).toBe(HIT_COOLDOWN_MS);
    expect(readyInMs(1300, 1000)).toBe(200);
    expect(readyInMs(1600, 1000)).toBe(0);
    expect(readyInMs(0, Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("box reach", () => {
  it("matches melee_box_attack: the mob's box grown 0.8 on x and z against the player's", () => {
    expect(boxReach(0.6)).toBeCloseTo(1.4);
    const zombie = mobInfo("zombie");
    expect(zombie.range).toBeCloseTo(1.98, 2);
    expect(zombie.cooldownMs).toBe(1000);
    // Straight along an axis 1.4, on a diagonal 1.98.
    expect(meleeReach(zombie, 0, 3)).toBeCloseTo(1.4);
    expect(meleeReach(zombie, 2, 2)).toBeCloseTo(1.98, 2);
    // A spider is 1.4 wide: 1.8 to 2.55.
    expect(meleeReach(mobInfo("spider"), 3, 0)).toBeCloseTo(1.8);
    expect(mobInfo("spider").range).toBeCloseTo(2.55, 2);
    // No box: the plain range.
    expect(meleeReach(mobInfo("phantom"), 1, 1)).toBe(2);
  });
});
describe("creeper fuse reaction", () => {
  const base = { lit: false, fuseMs: 0, readyInMs: 0, hasShield: true };
  it("strikes inside the measured 3.0 reach, steps in to a standing creeper just beyond it, and backs off while the swing cools down", () => {
    // Unlit and standing: ready / cooling at 2.9, 3.05, 3.2, 3.5.
    const standing = [2.9, 3.05, 3.2, 3.5].map((dist) => [creeperMove({ ...base, dist }), creeperMove({ ...base, dist, readyInMs: 400 })]);
    expect(standing).toEqual([
      ["strike", "retreat"],
      ["step", "retreat"],
      ["step", "retreat"],
      ["approach", "retreat"],
    ]);
    // Walking in at 2.5 blocks a second: met standing still, struck once inside reach, never stepped to.
    const walking = [2.9, 3.05, 3.2, 3.5].map((dist) => creeperMove({ ...base, dist, closing: 2.5 }));
    expect(walking).toEqual(["strike", "approach", "approach", "approach"]);
    expect(creeperMove({ ...base, dist: 4.5, readyInMs: 400 })).toBe("hold");
    expect(creeperMove({ ...base, dist: 6 })).toBe("approach");
  });
  it("strikes or closes in to a burning creeper while a hit still leaves time for the run", () => {
    // Lit 200 ms ago and standing: ready / cooling at 2.9, 3.05, 3.2, 3.5 (the close-in covers up to 0.45).
    const lit = [2.9, 3.05, 3.2, 3.5].map((dist) => [creeperMove({ ...base, lit: true, fuseMs: 200, dist }), creeperMove({ ...base, lit: true, fuseMs: 200, dist, readyInMs: 400 })]);
    expect(lit).toEqual([
      ["strike", "run"],
      ["step", "run"],
      ["step", "run"],
      ["run", "run"],
    ]);
    // Still slowing: judged by where it will stand. Coming in on a diagonal it lights at about 3.35 and stands at about
    // 3.15, outside reach: close in while it slows. Along an axis it stands at 2.9: wait for it standing.
    expect(creeperMove({ ...base, lit: true, fuseMs: 50, dist: 3.3, closing: 1.4, stand: creeperStand(0.7, 0.7) })).toBe("step");
    expect(creeperMove({ ...base, lit: true, fuseMs: 50, dist: 3.05, closing: 1.4, stand: creeperStand(0, 1) })).toBe("strike");
    // A swing while a hit leaves time to get out (a struck creeper is past 7 about 0.8 s after the hit, plus the input
    // latency): 500 ms burned leaves 1000; 650 burned (850 left) no longer.
    expect(creeperMove({ ...base, lit: true, fuseMs: 500, dist: 2.9 })).toBe("strike");
    expect(creeperMove({ ...base, lit: true, fuseMs: 650, dist: 2.9 })).not.toBe("strike");
    // A mob passing through the line is waited out while the fuse allows the strike, and once the escape was chosen on
    // this fuse it stays the decision.
    expect(creeperMove({ ...base, lit: true, fuseMs: 300, dist: 2.9, lineBlocked: true, committed: true })).toBe("strike");
    expect(creeperMove({ ...base, lit: true, fuseMs: 300, dist: 2.9, lineBlocked: true })).toBe("strike");
    expect(creeperMove({ ...base, lit: true, fuseMs: 300, dist: 3.6, lineBlocked: true })).toBe("run");
    expect(creeperMove({ ...base, lit: true, fuseMs: 300, dist: 2.9, running: true })).toBe("run");
  });
  it("lights by the box gap: about 3.1 along an axis, about 3.35 on a diagonal; a close-in takes 1 to 3 ticks", () => {
    expect(creeperLightDist(0, 3)).toBeCloseTo(3.1, 2);
    expect(creeperLightDist(3, 3)).toBeCloseTo(3.34, 1);
    expect(creeperLightDist(0.6, 0.8)).toBeCloseTo(3.34, 1);
    expect([0.05, 0.11, 0.2, 0.27, 0.4, 0.6].map(closeInTicks)).toEqual([1, 1, 2, 2, 3, 3]);
  });
  it("strikes an unlit creeper that got close instead of backing off, and backs off only while the swing cools down", () => {
    expect(creeperMove({ ...base, dist: 2.6 })).toBe("strike");
    expect(creeperMove({ ...base, dist: 2.6, readyInMs: 300 })).toBe("retreat");
  });
  it("strikes a burning creeper in reach while enough fuse is left, then runs; never turns back from a run", () => {
    expect(creeperMove({ ...base, lit: true, fuseMs: 200, dist: 3 })).toBe("strike");
    expect(creeperMove({ ...base, lit: true, fuseMs: 200, dist: 3, running: true })).toBe("run");
    expect(creeperMove({ ...base, lit: true, fuseMs: 200, dist: 3, readyInMs: 400 })).toBe("run");
    expect(creeperMove({ ...base, lit: true, fuseMs: 1100, dist: 3 })).toBe("block");
  });
  it("backs off instead of walking up to a creeper through zombies", () => {
    const zombie = (id: string, dist: number) => ({ id, dist, mobReach: 1.98 });
    // A zombie nearer than the creeper is in the way, one 3 blocks out is about to reach the player.
    expect(crowdedCreeper([zombie("z", 3.5)], "c", 4.5)).toBe(true);
    expect(crowdedCreeper([zombie("z", 3.2)], "c", 3)).toBe(true);
    expect(crowdedCreeper([zombie("z", 6)], "c", 4.5)).toBe(false);
    expect(crowdedCreeper([], "c", 4.5)).toBe(false);
  });
  it("takes the fuse as lit near its measured 3-block start range and as out only past 7", () => {
    expect(creeperLit(false, 2.7, 0)).toBe(true);
    // Standing at 3.2 (it stopped to swell) is lit; 3.5 with no close reading before is not.
    expect(creeperLit(false, 3.2, 0)).toBe(true);
    expect(creeperLit(false, 3.5, 0)).toBe(false);
    expect(creeperLit(false, 9, 0, true)).toBe(true);
    expect(creeperLit(true, 6.8, 0)).toBe(true);
    expect(creeperLit(true, 7.5, 0)).toBe(false);
    // A swelling creeper stands still: one still walking in at 2.5 blocks a second is not lit.
    expect(creeperLit(false, 2.7, 2.5)).toBe(false);
    expect(creeperLit(true, 4, 2.5)).toBe(false);
  });
  it("takes a creeper that came close and then stood still as lit, with the player already backing away", () => {
    // Came within 3.3 half a second ago, stands at 4.2 now: it stopped to swell.
    expect(creeperLit(false, 4.2, 0.1, undefined, 500)).toBe(true);
    // Too long ago, or still walking in: not lit.
    expect(creeperLit(false, 4.2, 0.1, undefined, 1500)).toBe(false);
    expect(creeperLit(false, 4.2, 2.4, undefined, 500)).toBe(false);
    // Thrown back by a hit (moving away fast) at 3.2: not a swell.
    expect(creeperLit(false, 3.2, -5, undefined, 0)).toBe(false);
  });
  it("remembers a close reading across frames, ignores one thrown back by a hit, and drops a fuse that never blew", () => {
    const f: FuseMemory = {};
    // Walking in at 3.2: not lit yet, but the close reading is kept.
    expect(trackFuse(f, 0, 3.2, 2.5)).toBe(false);
    expect(f.closeAt).toBe(0);
    // 400 ms later it stands at 3.9 with the player backing off: lit since the close reading.
    expect(trackFuse(f, 400, 3.9, 0)).toBe(true);
    // Since the close reading, which happened about 150 ms before it was read.
    expect(f.fuseSince).toBe(-150);
    // Still burning while within 7.3, even long after the close reading.
    expect(trackFuse(f, 1400, 6.5, 0)).toBe(true);
    // Past its fuse and overdue: it did not blow, so it was not lit.
    expect(trackFuse(f, 2300, 6.5, 0)).toBe(false);
    const thrown: FuseMemory = {};
    expect(trackFuse(thrown, 0, 3.2, -6)).toBe(false);
    expect(thrown.closeAt).toBeUndefined();
    expect(trackFuse(thrown, 300, 5, 0)).toBe(false);
  });
  it("takes a struck creeper as lit until it walks back in, and one standing still within 7.3 blocks as lit", () => {
    const f: FuseMemory = { struckAt: 0 };
    // Thrown back by the hit (and the stale reading still says it walks in): lit since the strike.
    expect(trackFuse(f, 100, 3.1, 2.6, undefined, 1500, 2.6)).toBe(true);
    expect(trackFuse(f, 400, 4, -6, undefined, 1500, 6)).toBe(true);
    expect(trackFuse(f, 750, 5, 0, undefined, 1500, 0.1)).toBe(true);
    expect(f.fuseSince).toBeLessThanOrEqual(0);
    // One that walks back in after the hit is not lit.
    const back: FuseMemory = { struckAt: 0 };
    expect(trackFuse(back, 400, 5, 0, undefined, 1500, 0.1)).toBe(true);
    expect(trackFuse(back, 750, 4.5, 2.5, undefined, 1500, 2.5)).toBe(false);
    expect(back.struckAt).toBeUndefined();
    // Never struck: lit once it has stood 300 ms; one walking sideways (closing 0, speed 2.5) is not.
    const still: FuseMemory = {};
    expect(trackFuse(still, 0, 5, 0, undefined, 1500, 0.1)).toBe(false);
    expect(trackFuse(still, 350, 5, 0, undefined, 1500, 0.1)).toBe(true);
    expect(still.fuseSince).toBe(-150);
    // Within 4.5 blocks a stop counts at once.
    const near: FuseMemory = {};
    expect(trackFuse(near, 0, 4, 0, undefined, 1500, 0.1)).toBe(true);
    const side: FuseMemory = {};
    expect(trackFuse(side, 0, 5, 0, undefined, 1500, 2.5)).toBe(false);
    expect(trackFuse(side, 500, 5, 0, undefined, 1500, 2.5)).toBe(false);
  });
  it("runs as soon as the fuse burns (once running, or with the swing cooling), shields when the blast comes first, and re-engages once it is out", () => {
    expect(creeperMove({ ...base, dist: 2.4, lit: true, fuseMs: 100, running: true })).toBe("run");
    // From 3 blocks the sprint out of the blast takes about 0.9 s: with 1.1 s left it runs, with 0.6 s it shields.
    expect(creeperMove({ ...base, dist: 3, lit: true, fuseMs: 400, readyInMs: 400 })).toBe("run");
    expect(creeperMove({ ...base, dist: 3, lit: true, fuseMs: 900 })).toBe("block");
    expect(creeperMove({ ...base, dist: 2.4, lit: true, fuseMs: 1200 })).toBe("block");
    // Just struck at 2.24 (live): thrown about 2 farther, so with room behind the backward walk is in time; without the
    // hit, or with a wall behind and the turn to make, the shield.
    expect(creeperMove({ ...base, dist: 2.24, lit: true, fuseMs: 500, readyInMs: 400, struckAgoMs: 100 })).toBe("run");
    expect(creeperMove({ ...base, dist: 2.24, lit: true, fuseMs: 900, readyInMs: 400, struckAgoMs: 100, roomBehind: 1 })).toBe("block");
    expect(creeperMove({ ...base, dist: 2.24, lit: true, fuseMs: 900, readyInMs: 400 })).toBe("block");
    expect(creeperMove({ ...base, hasShield: false, dist: 2.4, lit: true, fuseMs: 1200 })).toBe("run");
    expect(creeperMove({ ...base, dist: 7.4, lit: true, fuseMs: 1200 })).toBe("hold");
    // Out of the blast's reach but not yet out of the fuse's: keep running, no shield.
    expect(creeperMove({ ...base, dist: 6.8, lit: true, fuseMs: 1300 })).toBe("run");
    // The fuse went out past 7 blocks: back at it.
    expect(creeperMove({ ...base, dist: 7.4 })).toBe("approach");
  });
});

describe("critical hits", () => {
  it("jumps only when no melee mob can hit the player before the falling swing", () => {
    // A zombie 3.5 blocks out closing at 2.3 b/s is in its reach in about 660 ms: no jump.
    expect(untilMobHitMs({ dist: 3.5, mobReach: 1.98, closing: 2.3 })).toBeCloseTo(661, 0);
    expect(critSafe([{ dist: 3.5, mobReach: 1.98, closing: 2.3 }])).toBe(false);
    expect(critSafe([{ dist: 4.5, mobReach: 1.98, closing: 2.3 }])).toBe(true);
    // In reach but its attack cooling down for 900 ms: a crit fits in.
    expect(critSafe([{ dist: 1.6, mobReach: 1.98, closing: 0, coolMs: 900 }])).toBe(true);
    expect(critSafe([{ dist: 1.6, mobReach: 1.98, closing: 0, coolMs: 300 }])).toBe(false);
  });
});

describe("archers and spiders", () => {
  it("weaves toward archers, not toward melee mobs or archers at hand", () => {
    const skeleton = mobInfo("minecraft:skeleton");
    const angles = [0, 150, 300, 450, 600].map((t) => weaveDeg(t, 10, skeleton));
    expect(Math.max(...angles.map(Math.abs))).toBeGreaterThan(30);
    expect(weaveDeg(450, 10, mobInfo("minecraft:zombie"))).toBe(0);
    expect(weaveDeg(450, 3, skeleton)).toBe(0);
  });
  it("waits while a spider is in the air or on a wall", () => {
    expect(spiderAirborne(0.3, 0.5)).toBe(true);
    expect(spiderAirborne(0, 1.5)).toBe(true);
    expect(spiderAirborne(0, 0)).toBe(false);
  });
  it("finds cover behind a pillar on the way to an archer, and none on open ground", () => {
    // Flat ground at y -1, a 2-high pillar at x 0, z 5 (between the player at z 0 and the skeleton at z 12).
    const pillar = new Set(["0,0,5", "0,1,5"]);
    const grid = { at: (x: number, y: number, z: number) => (y < 0 ? "#" : pillar.has(`${x},${y},${z}`) ? "#" : ".") };
    const open = { at: (_x: number, y: number) => (y < 0 ? "#" : ".") };
    const me = { x: 0.5, y: 0, z: 0.5 };
    const skeleton = { x: 0.5, y: 0, z: 12.5 };
    expect(lineBlocked(grid, { x: 0.5, y: 1.5, z: 12.5 }, { x: 0.5, y: 1.2, z: 4.5 })).toBe(true);
    const spot = findCover(grid, me, skeleton);
    expect(spot).toBeDefined();
    expect(spot?.z).toBeLessThan(5);
    expect(spot?.z).toBeGreaterThan(2);
    expect(lineBlocked(grid, { x: skeleton.x, y: 1.5, z: skeleton.z }, { x: spot?.x ?? 0, y: 1.2, z: spot?.z ?? 0 })).toBe(true);
    expect(findCover(open, me, skeleton)).toBeUndefined();
    expect(findCover(grid, me, skeleton, new Set([`${Math.floor(spot?.x ?? 0)},${Math.floor(spot?.z ?? 0)}`]))).not.toEqual(spot);
  });
});

describe("creeper first", () => {
  const at = (x: number, z: number) => ({ x, y: 0, z });
  it("turns to a creeper within 5 blocks before a zombie, unless the zombie is a block nearer; keeps a creeper target while it is close", () => {
    const mobs = [
      { id: "z", typeId: "minecraft:zombie", location: at(0, 2) },
      { id: "c", typeId: "minecraft:creeper", location: at(3, 3) },
    ];
    // The zombie 2 blocks out, the creeper 4.2 behind it: the zombie first, the creeper once it is lit or as near.
    expect(pickDuelTarget(at(0, 0), "z", mobs, false)).toBe("z");
    expect(pickDuelTarget(at(0, 0), "z", mobs, false, new Set(["c"]))).toBe("c");
    expect(pickDuelTarget(at(0, 0), "z", [mobs[0] as (typeof mobs)[0], { ...(mobs[1] as (typeof mobs)[1]), location: at(1, 2.5) }], false)).toBe("c");
    // A burning creeper target is kept out to 7.5 blocks; an unlit one at 6 gives way to the zombie hitting the player.
    const six = [mobs[0] as (typeof mobs)[0], { ...(mobs[1] as (typeof mobs)[1]), location: at(0, 6) }];
    expect(pickDuelTarget(at(0, 0), "c", six, true, new Set(["c"]))).toBe("c");
    expect(pickDuelTarget(at(0, 0), "c", six, true)).toBe("z");
    expect(pickDuelTarget(at(0, 0), "z", [mobs[0] as (typeof mobs)[0], { ...(mobs[1] as (typeof mobs)[1]), location: at(0, 9) }], false)).toBe("z");
    // A creeper whose fuse burns comes first out to 7.5 blocks, so the player gets out of its blast.
    const far = [mobs[0] as (typeof mobs)[0], { ...(mobs[1] as (typeof mobs)[1]), location: at(0, 6.5) }];
    expect(pickDuelTarget(at(0, 0), "z", far, false)).toBe("z");
    expect(pickDuelTarget(at(0, 0), "z", far, false, new Set(["c"]))).toBe("c");
  });
});

describe("kit", () => {
  it("finds a bow with arrows and a shield in the off hand", () => {
    expect(bowSlot([{ typeId: "minecraft:iron_sword", amount: 1 }, { typeId: "minecraft:bow", amount: 1 }, { typeId: "minecraft:arrow", amount: 16 }])).toEqual({ slot: 2, arrows: 16 });
    expect(bowSlot([{ typeId: "minecraft:bow", amount: 1 }, null])).toBeUndefined();
    expect(hasShield([{ slot: "Offhand", typeId: "minecraft:shield" }])).toBe(true);
    expect(hasShield([{ slot: "Chest", typeId: "minecraft:iron_chestplate" }])).toBe(false);
  });
});

function me(health: number): PlayerState {
  return {
    tick: 0,
    name: "p",
    location: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0 },
    dimension: "minecraft:overworld",
    onGround: true,
    sneaking: false,
    sprinting: false,
    gameMode: "survival",
    selectedSlot: 1,
    health,
  };
}

const zombieAt = (z: number): EntityInfo => ({ id: "z", typeId: "minecraft:zombie", location: { x: 0, y: 0, z }, health: { current: 20, max: 20 }, velocity: { x: 0, y: 0, z: 0 } });
const kit: Loadout = {
  hotbar: [{ typeId: "minecraft:iron_sword", amount: 1 }, { typeId: "minecraft:cooked_beef", amount: 8 }],
  hunger: 18,
  armor: ["helmet", "chestplate", "leggings", "boots"].map((p) => ({ slot: p, typeId: `minecraft:iron_${p}` })),
};

describe("health, armor and eating in the scores", () => {
  const goal = parseGoal("kill all the zombies");
  it("eats mid-fight below 14 health when no mob is within 4 blocks, not with one at hand", () => {
    const far = scoreTactics(new ThreatTracker().update(0, me(EAT_HEALTH - 4), [zombieAt(9)], kit), goal);
    expect(far[0]?.kind).toBe("eat");
    const near = scoreTactics(new ThreatTracker().update(0, me(EAT_HEALTH - 4), [zombieAt(3)], kit), goal);
    expect(near.some((t) => t.kind === "eat")).toBe(false);
  });
  it("lets armor buy more fighting before running to heal", () => {
    expect(lowHealth(15)).toBe(6);
    expect(lowHealth(0)).toBe(8);
    const bare = { ...kit, armor: [], hunger: 20 };
    const naked = scoreTactics(new ThreatTracker().update(0, me(7), [zombieAt(5)], bare), goal);
    expect(naked[0]?.kind).toBe("flee");
    const armored = scoreTactics(new ThreatTracker().update(0, me(7), [zombieAt(5)], { ...kit, hunger: 20 }), goal);
    expect(armored[0]?.kind).toBe("fight");
  });
  it("keeps an archer that has the player in range on offer while recovering, instead of idling under its arrows", () => {
    const skeleton: EntityInfo = { id: "s", typeId: "minecraft:skeleton", location: { x: 0, y: 0, z: 14 }, health: { current: 20, max: 20 } };
    const scored = scoreTactics(new ThreatTracker().update(0, me(5), [skeleton], { ...kit, hunger: 20 }), parseGoal("kill the hostile mobs near you"), { recovering: true });
    expect(scored[0]?.kind).toBe("fight");
  });
  it("fights an archer 8 blocks away while recovering instead of running under its arrows, and still runs from a zombie", () => {
    const skeleton: EntityInfo = { id: "s", typeId: "minecraft:skeleton", location: { x: 0, y: 0, z: 8 }, health: { current: 20, max: 20 } };
    const goal2 = parseGoal("kill the hostile mobs near you");
    const archer = scoreTactics(new ThreatTracker().update(0, me(5), [skeleton], { ...kit, hunger: 20 }), goal2, { recovering: true });
    expect([archer[0]?.kind, archer[0]?.target?.id]).toEqual(["fight", "s"]);
    expect(archer.some((t) => t.kind === "flee")).toBe(false);
    const both = scoreTactics(new ThreatTracker().update(0, me(5), [skeleton, zombieAt(6)], { ...kit, hunger: 20 }), goal2, { recovering: true });
    expect(both[0]?.kind).toBe("flee");
  });
});

describe("reported creeper fuse", () => {
  it("trusts the helper: lit with its burn time, out when it says so, no guessing from distance", () => {
    const f: FuseMemory = {};
    // Standing within 3 blocks would be guessed lit; the helper says not.
    expect(trackFuse(f, 0, 2.9, 0, false, 1500, 0)).toBe(false);
    expect(f.fuseSince).toBeUndefined();
    expect(trackFuse(f, 1000, 3, 0, true, 1500, 0, 400)).toBe(true);
    expect(f.fuseSince).toBe(600);
    // Out again (the player got past the stop range).
    expect(trackFuse(f, 1500, 7.2, -2, false, 1500, 2)).toBe(false);
    expect(f.fuseSince).toBeUndefined();
  });

  it("keeps the strike memory for the walk-up rule", () => {
    const f: FuseMemory = { struckAt: 100 };
    trackFuse(f, 200, 4, -5, false, 1500, 5);
    expect(f.struckAt).toBe(100);
  });

  it("runs once a reported fuse burns, with the time left from the reported burn", () => {
    const f: FuseMemory = {};
    const lit = trackFuse(f, 1000, 3.2, 0, true, 1500, 0, 1200);
    const move = creeperMove({ dist: 3.2, lit, fuseMs: 1000 - (f.fuseSince ?? 1000), readyInMs: 0, hasShield: true });
    // 300 ms left at 3.2 blocks: no sprint gets out of the blast in time, so the shield goes up.
    expect(move).toBe("block");
  });

  it("the threat map takes the reported fuse and its age", () => {
    const creeper: EntityInfo = { id: "c", typeId: "minecraft:creeper", location: { x: 0, y: 0, z: 2.8 }, health: { current: 20, max: 20 }, ignited: false };
    const t = new ThreatTracker();
    expect(t.update(0, me(20), [creeper]).hostiles[0]?.fuse?.lit).toBe(false);
    const fuse = t.update(1000, me(20), [{ ...creeper, ignited: true, fuseTicks: 10, ageMs: 40 }]).hostiles[0]?.fuse;
    expect(fuse).toEqual({ lit: true, ms: 540 });
  });
});

describe("open heading", () => {
  /** A grid: solid floor at y -1, air above, a glass wall along z = 3 (blocks z >= 3 solid at feet and head). */
  const walled = { at: (_x: number, y: number, z: number) => (y < 0 ? "#" : z >= 3 && y <= 2 ? "#" : ".") };

  it("measures the free run toward a heading up to a wall, a hole or water", () => {
    const at = { x: 0.5, y: 0, z: 0.5 };
    // Yaw 0 points to +z: the wall starts 2.5 blocks ahead.
    expect(clearRun(walled, at, 0)).toBe(2);
    expect(clearRun(walled, at, 180)).toBe(6);
    const hole = { at: (x: number, y: number) => (y < 0 ? (x === 2 ? "." : "#") : ".") };
    // Yaw -90 points to +x: the hole at x = 2 under the feet.
    expect(clearRun(hole, at, -90)).toBe(1);
  });

  it("turns aside from a wall right behind instead of running into it", () => {
    const me = { x: 0.5, y: 0, z: 2.2 };
    const yaw = openHeading({ me, desired: 0, spreadDeg: 120, mobs: [], clear: (y) => clearRun(walled, me, y) });
    expect(Math.abs(angleDiff(0, yaw))).toBeGreaterThanOrEqual(75);
  });

  it("strafes around a zombie standing on the way instead of into it", () => {
    const me = { x: 0, y: 0, z: 0 };
    const zombie = { location: { x: 0, y: 0, z: 2.5 } };
    const yaw = openHeading({ me, desired: 0, spreadDeg: 120, mobs: [zombie], clear: () => 6 });
    expect(Math.abs(angleDiff(0, yaw))).toBeGreaterThanOrEqual(30);
    // Nothing in the way: straight on.
    expect(openHeading({ me, desired: 0, spreadDeg: 120, mobs: [], clear: () => 6 })).toBe(0);
  });

  it("keeps a creeper's wider clearance", () => {
    const me = { x: 0, y: 0, z: 0 };
    const creeper = { location: { x: 3.5, y: 0, z: 3 }, clearance: 4 };
    const yaw = openHeading({ me, desired: -45, spreadDeg: 90, mobs: [creeper], clear: () => 6 });
    // -45 heads toward +x +z, past the creeper: the pick leans away from it (toward +z alone or farther).
    expect(angleDiff(-45, yaw)).toBeGreaterThan(0);
  });
});
