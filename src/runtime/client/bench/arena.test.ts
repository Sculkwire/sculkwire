import { describe, expect, it } from "vitest";
import { arenaCommands, arenaOrigin, FILL_LIMIT, fillBox, playerCommands, summonCommand } from "./arena.ts";

describe("arena commands", () => {
  it("splits a big fill into slabs under the block limit", () => {
    const cmds = fillBox({ x: 0, y: 0, z: 0 }, { x: 99, y: 9, z: 99 }, "air");
    expect(cmds.length).toBe(4);
    for (const c of cmds) {
      const [x0, y0, z0, x1, y1, z1] = c.split(" ").slice(1, 7).map(Number) as number[];
      expect(((x1 as number) - (x0 as number) + 1) * ((y1 as number) - (y0 as number) + 1) * ((z1 as number) - (z0 as number) + 1)).toBeLessThanOrEqual(FILL_LIMIT);
    }
    expect(cmds.at(-1)).toMatch(/ 99 9 99 air$/);
  });
  it("clears the box, lays the floor, and sets the player up", () => {
    const o = arenaOrigin(1);
    const cmds = arenaCommands({ area: { radius: 2, height: 3 } }, o);
    expect(cmds).toEqual([`fill ${o.x - 2} ${o.y} ${o.z - 2} ${o.x + 2} ${o.y + 3} ${o.z + 2} air`, `fill ${o.x - 2} ${o.y - 1} ${o.z - 2} ${o.x + 2} ${o.y - 1} ${o.z + 2} minecraft:grass_block`]);
    const p = playerCommands({ time: "night", hotbar: [{ item: "iron_sword" }, { item: "cooked_beef", amount: 16 }], armor: "iron", offhand: "shield" }, o);
    expect(p).toContain("gamemode survival @a");
    expect(p).toContain("time set 18000");
    expect(p).toContain("replaceitem entity @a slot.hotbar 1 minecraft:cooked_beef 16");
    expect(p).toContain("replaceitem entity @a slot.armor.chest 0 minecraft:iron_chestplate 1");
    expect(p).toContain("replaceitem entity @a slot.weapon.offhand 0 minecraft:shield 1");
    expect(p.at(-1)).toBe(`tp @a ${o.x + 0.5} ${o.y} ${o.z + 0.5} 0 0`);
    expect(summonCommand({ type: "zombie", at: { dx: 0, dy: 0, dz: 10 } }, o)).toBe(`summon minecraft:zombie ${o.x + 0.5} ${o.y} ${o.z + 10.5} 0 0 minecraft:as_adult`);
  });
});
