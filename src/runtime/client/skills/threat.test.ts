import { describe, expect, it } from "vitest";
import { kit, mapOf, me, mob } from "../../../testing/skillgame.ts";
import { parseGoal } from "./goal.ts";
import { scoreTactics } from "./tactics.ts";
import { ThreatTracker } from "./threat.ts";

describe("threat map", () => {
  it("measures how fast mobs close in and estimates a creeper's fuse", () => {
    const t = new ThreatTracker();
    t.update(0, me(), [mob("z", "zombie", 0, 8), mob("c", "creeper", 5, 0)]);
    const m = t.update(500, me(), [mob("z", "zombie", 0, 7), mob("c", "creeper", 2.5, 0)]);
    const z = m.entities.find((e) => e.id === "z");
    expect(z?.approach).toBeCloseTo(2, 1);
    expect(m.entities.find((e) => e.id === "c")?.fuse).toEqual({ lit: true, ms: 0 });
    const later = t.update(1200, me(), [mob("z", "zombie", 0, 6), mob("c", "creeper", 2, 0)]);
    expect(later.entities.find((e) => e.id === "c")?.fuse).toEqual({ lit: true, ms: 700 });
    expect(later.hostiles[0]?.key).toBe("creeper_1");
    expect(later.entities.find((e) => e.id === "c")?.danger).toBe(1);
  });

  it("takes the reported velocity and ignition, drops players, and lists what vanished", () => {
    const t = new ThreatTracker();
    t.update(0, me(), [mob("z", "zombie", 0, 5, { velocity: { x: 0, y: 0, z: -0.1 } }), mob("p", "player", 1, 1)]);
    const m = t.update(100, me(), [mob("c", "creeper", 6, 0, { ignited: true })]);
    expect(m.entities.map((e) => e.id)).toEqual(["c"]);
    expect(m.entities[0]?.fuse?.lit).toBe(true);
    expect(m.vanished.map((e) => [e.id, e.approach])).toEqual([["z", 2]]);
  });

  it("reads the vitals from the loadout", () => {
    const m = mapOf([], { health: 12 }, kit(15));
    expect(m.vitals).toMatchObject({ health: 12, hunger: 15, armor: 15, heldDamage: 6, weapon: { slot: 1 }, food: { slot: 2, typeId: "minecraft:cooked_beef" } });
  });

  it("names the carried food at full hunger without offering to eat it", () => {
    // Live retail: steak in slot 2 at food 20/20 was reported as `Food: none`.
    const full = mapOf([], { health: 5 }, kit(20));
    expect(full.vitals).toMatchObject({ hunger: 20, armor: 15, weapon: { slot: 1 }, food: { slot: 2, typeId: "minecraft:cooked_beef" } });
    expect(scoreTactics(full, parseGoal("explore")).some((t) => t.kind === "eat")).toBe(false);
  });
});
