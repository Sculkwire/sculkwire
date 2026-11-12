import { describe, expect, it } from "vitest";
import { enchantmentName, itemSlotSchema, parseSlot } from "./slot.ts";

const slot = (item: string, count = 1) => ({ item, count });

describe("parseSlot", () => {
  it("namespaces a bare item id and always reports enchantments", () => {
    expect(parseSlot(slot("oak_planks", 4))).toEqual({ item: "minecraft:oak_planks", count: 4, enchantments: [] });
  });

  it("keeps an empty slot as null and rejects a slot with no item", () => {
    expect(parseSlot(null)).toBeNull();
    expect(parseSlot({ count: 2 })).toBeUndefined();
    expect(parseSlot({ item: "  ", count: 2 })).toBeUndefined();
  });

  it("defaults the count and drops a count below one", () => {
    expect(parseSlot({ item: "minecraft:stone" })).toEqual({ item: "minecraft:stone", count: 1, enchantments: [] });
    expect(parseSlot(slot("minecraft:stone", 0))).toBeUndefined();
    expect(parseSlot(slot("minecraft:stone", 1.5))).toBeUndefined();
  });

  it("clamps damage into the item's own maximum", () => {
    expect(parseSlot({ item: "minecraft:diamond_pickaxe", durability: { damage: 4000, max: 1561 } })?.durability).toEqual({ damage: 1561, max: 1561 });
    expect(parseSlot({ item: "minecraft:diamond_pickaxe", durability: { damage: -3, max: 1561 } })?.durability).toEqual({ damage: 0, max: 1561 });
  });

  it("reads both the game's and the Script API's enchantment shape", () => {
    const both = parseSlot({
      item: "minecraft:diamond_sword",
      enchantments: [{ id: "sharpness", level: 5 }, { type: { id: "minecraft:unbreaking" }, level: 3 }],
    });
    expect(both?.enchantments).toEqual([
      { id: "minecraft:sharpness", level: 5 },
      { id: "minecraft:unbreaking", level: 3 },
    ]);
  });

  it("names the game's numeric enchantment ids", () => {
    const pick = parseSlot({ item: "minecraft:iron_pickaxe", enchantments: [{ id: 17, level: 1 }, { id: 15, level: 1 }] });
    expect(pick?.enchantments).toEqual([
      { id: "minecraft:unbreaking", level: 1 },
      { id: "minecraft:efficiency", level: 1 },
    ]);
    expect(enchantmentName(0)).toBe("minecraft:protection");
    expect(enchantmentName(9)).toBe("minecraft:sharpness");
    expect(enchantmentName(37)).toBe("minecraft:swift_sneak");
    expect(enchantmentName(40)).toBe("minecraft:breach");
    expect(enchantmentName(99)).toBe("minecraft:unknown_99");
    // A negative or fractional number is not an id.
    expect(parseSlot({ item: "minecraft:stick", enchantments: [{ id: -1 }, { id: 1.5 }] })?.enchantments).toEqual([]);
  });

  it("carries a custom name, lore and the contents of a container item", () => {
    const bundle = parseSlot({
      item: "minecraft:bundle",
      name: "Kit",
      lore: ["line one"],
      contents: [slot("minecraft:bread", 3), null],
    });
    expect(bundle?.name).toBe("Kit");
    expect(bundle?.lore).toEqual(["line one"]);
    expect(bundle?.contents).toEqual([{ item: "minecraft:bread", count: 3, enchantments: [] }, null]);
  });

  it("publishes a shulker box with empty inner slots through the output schema", () => {
    const box = parseSlot({ item: "minecraft:shulker_box", contents: [slot("minecraft:emerald"), null, null, slot("minecraft:golden_apple", 2)] });
    expect(itemSlotSchema.safeParse(box).success).toBe(true);
  });
});
