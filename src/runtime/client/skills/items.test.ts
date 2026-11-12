import { describe, expect, it } from "vitest";
import { ironArmor } from "../../../testing/skillgame.ts";
import { armorPoints, bestFoodSlot, bestWeaponSlot } from "./items.ts";

describe("items", () => {
  it("ranks weapons, food and armor", () => {
    expect(bestWeaponSlot([{ typeId: "minecraft:stone_sword", amount: 1 }, { typeId: "minecraft:diamond_sword", amount: 1 }, null])).toMatchObject({ slot: 2, damage: 7 });
    expect(bestWeaponSlot([{ typeId: "minecraft:dirt", amount: 1 }])).toBeUndefined();
    expect(armorPoints(ironArmor.map((a) => a.typeId))).toBe(15);
    const food = [{ typeId: "minecraft:rotten_flesh", amount: 4 }, { typeId: "minecraft:bread", amount: 2 }, { typeId: "minecraft:cooked_beef", amount: 1 }];
    expect(bestFoodSlot(food, 4)?.typeId).toBe("minecraft:cooked_beef");
    // Two missing points: bread wastes less than steak; rotten flesh only when it is all there is.
    expect(bestFoodSlot(food, 18)?.typeId).toBe("minecraft:bread");
    expect(bestFoodSlot([{ typeId: "minecraft:rotten_flesh", amount: 4 }], 10)?.typeId).toBe("minecraft:rotten_flesh");
    expect(bestFoodSlot(food, 20)).toBeUndefined();
  });
});
