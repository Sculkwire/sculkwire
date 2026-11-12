import { describe, expect, it } from "vitest";
import { parseItemPhrase, resolveName } from "./names.ts";

describe("parseItemPhrase", () => {
  it("splits a material clause off the name and ends the name at words that are not part of it", () => {
    expect(parseItemPhrase("pickaxe out of the planks")).toEqual({ words: ["pickaxe"], material: "wooden" });
    expect(parseItemPhrase("a pickaxe from wood")).toEqual({ words: ["pickaxe"], material: "wooden" });
    expect(parseItemPhrase("sword made of iron")).toEqual({ words: ["sword"], material: "iron" });
    expect(parseItemPhrase("axe using cobblestone")).toEqual({ words: ["axe"], material: "stone" });
    expect(parseItemPhrase("wooden pickaxe made at the crafting table over there")).toEqual({ words: ["wooden", "pickaxe"] });
    expect(parseItemPhrase("a golden apple please")).toEqual({ words: ["golden", "apple"] });
    expect(parseItemPhrase("bucket of water")).toEqual({ words: ["bucket", "water"] });
  });
});

describe("resolveName variants", () => {
  const tools = ["minecraft:wooden_pickaxe", "minecraft:stone_pickaxe", "minecraft:iron_pickaxe", "minecraft:golden_sword", "minecraft:gold_ingot", "minecraft:crafting_table", "minecraft:water_bucket"];

  it("reads material words in the name and the longest known name inside the phrase", async () => {
    const id = async (raw: string) => (await resolveName({ raw, universe: tools, atHand: {} })).id;
    expect(await id("wood pickaxe")).toBe("minecraft:wooden_pickaxe");
    expect(await id("gold sword")).toBe("minecraft:golden_sword");
    expect(await id("gold ingot")).toBe("minecraft:gold_ingot");
    expect(await id("pickaxe of iron")).toBe("minecraft:iron_pickaxe");
    expect(await id("bucket of water")).toBe("minecraft:water_bucket");
    expect(await id("wooden pickaxe ready for me")).toBe("minecraft:wooden_pickaxe");
    expect(await id("stone pickaxe thingy")).toBe("minecraft:stone_pickaxe");
  });

  it("takes a makeable variant, from the inventory before the containers near, the best material first", async () => {
    const makeable = (can: Record<string, "inventory" | "near">) => async (id: string, from: "inventory" | "near") => can[id] === from || (from === "near" && can[id] === "inventory");
    const pick = await resolveName({ raw: "pickaxe", universe: tools, atHand: {}, makeable: makeable({ "minecraft:wooden_pickaxe": "inventory", "minecraft:iron_pickaxe": "near" }) });
    expect(pick).toMatchObject({ id: "minecraft:wooden_pickaxe", chosen: "the only one makeable from the inventory" });
    const both = await resolveName({ raw: "pickaxe", universe: tools, atHand: {}, makeable: makeable({ "minecraft:wooden_pickaxe": "inventory", "minecraft:stone_pickaxe": "inventory" }) });
    expect(both).toMatchObject({ id: "minecraft:stone_pickaxe", chosen: "the best material makeable from the inventory; also makeable: wooden_pickaxe" });
    const none = await resolveName({ raw: "pickaxe", universe: tools, atHand: {}, makeable: makeable({}) });
    expect(none.considered).toEqual(["minecraft:iron_pickaxe", "minecraft:stone_pickaxe", "minecraft:wooden_pickaxe"]);
  });
});

describe("resolveName", () => {
  const universe = ["minecraft:iron_sword", "minecraft:iron_ingot", "minecraft:raw_iron", "minecraft:raw_copper", "minecraft:iron_ore", "minecraft:stone_sword"];

  it("takes an exact id, an id without namespace, and plain words", async () => {
    expect((await resolveName({ raw: "minecraft:iron_ingot", universe, atHand: {} })).id).toBe("minecraft:iron_ingot");
    expect((await resolveName({ raw: "raw_iron", universe, atHand: {} })).id).toBe("minecraft:raw_iron");
    expect((await resolveName({ raw: "the iron sword", universe, atHand: {} })).id).toBe("minecraft:iron_sword");
  });

  it("breaks a tie by what is at hand, then by the plainest id", async () => {
    const blade = await resolveName({ raw: "blade", universe, atHand: { "minecraft:stone_sword": 1 } });
    expect(blade.id).toBe("minecraft:stone_sword");
    const ore = await resolveName({ raw: "ore", universe, atHand: {}, near: { "minecraft:raw_copper": 4 } });
    expect(ore.id).toBe("minecraft:raw_copper");
  });

  it("takes the item there is most of among those at hand, and reports a tie that remains", async () => {
    const more = await resolveName({ raw: "ore", universe, atHand: { "minecraft:raw_iron": 2, "minecraft:raw_copper": 5 } });
    expect(more.id).toBe("minecraft:raw_copper");
    const even = await resolveName({ raw: "ore", universe, atHand: { "minecraft:raw_iron": 3, "minecraft:raw_copper": 3 } });
    expect(even.id).toBeUndefined();
    expect(even.tied).toEqual(["minecraft:raw_copper", "minecraft:raw_iron"]);
  });
});
