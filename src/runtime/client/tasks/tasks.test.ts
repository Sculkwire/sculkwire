import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drive, fakeClock } from "../../../testing/faketime.ts";
import { fakeTaskWorld, FakeWorld, furnaceRecipe as furnace, runFakeStep as run, shapedRecipe as shaped, stack } from "../../../testing/fakeworld.ts";
import { runTaskStep, taskStepDone } from "./steps.ts";

const FIXTURES = [
  shaped("test:sword", ["X", "X", "#"], { X: { item: "minecraft:iron_ingot" }, "#": { item: "minecraft:stick" } }, { item: "minecraft:iron_sword" }),
  shaped("test:stick", ["A", "A"], { A: { tag: "minecraft:planks" } }, { item: "minecraft:stick", count: 4 }),
  shaped("test:planks", ["#"], { "#": { item: "minecraft:oak_log" } }, { item: "minecraft:oak_planks", count: 4 }),
  shaped("test:ingot_from_nuggets", ["###", "###", "###"], { "#": { item: "minecraft:iron_nugget" } }, { item: "minecraft:iron_ingot" }),
  furnace("test:smelt_iron", "minecraft:raw_iron", "minecraft:iron_ingot", ["furnace", "blast_furnace"]),
  shaped("test:wooden_pickaxe", ["XXX", " # ", " # "], { X: { tag: "minecraft:planks" }, "#": { item: "minecraft:stick" } }, { item: "minecraft:wooden_pickaxe" }),
  shaped("test:stone_pickaxe", ["XXX", " # ", " # "], { X: { tag: "minecraft:stone_tool_materials" }, "#": { item: "minecraft:stick" } }, { item: "minecraft:stone_pickaxe" }),
  shaped("test:iron_pickaxe", ["XXX", " # ", " # "], { X: { item: "minecraft:iron_ingot" }, "#": { item: "minecraft:stick" } }, { item: "minecraft:iron_pickaxe" }),
  shaped("test:wooden_sword", ["X", "X", "#"], { X: { tag: "minecraft:planks" }, "#": { item: "minecraft:stick" } }, { item: "minecraft:wooden_sword" }),
  furnace("test:smelt_copper", "minecraft:raw_copper", "minecraft:copper_ingot", ["furnace", "blast_furnace"]),
];

const world = () => fakeTaskWorld(FIXTURES);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("craft", () => {
  it("crafts at the crafting table near when every ingredient is at hand", async () => {
    const w = world();
    w.give("iron_ingot", 2);
    w.give("stick", 1);
    w.place("crafting_table", { x: 4, y: 64, z: 0 });
    const result = await run(w, { kind: "craft", item: "iron sword" });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("made 1 iron_sword");
    expect(result.gained).toEqual({ "minecraft:iron_sword": 1, "minecraft:iron_ingot": -2, "minecraft:stick": -1 });
    expect(result.actions).toContain("walked to the crafting_table at 4 64 0");
    expect(w.screen).toBeNull();
  });

  it("crafts a 2x2 recipe in the inventory's own grid, without a table", async () => {
    const w = world();
    w.give("oak_log", 1);
    const result = await run(w, { kind: "craft", item: "oak_planks", count: 4 });
    expect(result.ok).toBe(true);
    expect(result.gained).toEqual({ "minecraft:oak_planks": 4, "minecraft:oak_log": -1 });
    expect(result.actions).toContain("opened the inventory screen");
  });

  it("smelts the ingots first when the inventory holds the raw iron and a furnace is near", async () => {
    const w = world();
    w.give("raw_iron", 2);
    w.give("stick", 1);
    w.give("coal", 1);
    w.place("crafting_table", { x: 4, y: 64, z: 0 });
    w.place("furnace", { x: -4, y: 64, z: 0 });
    const result = await run(w, { kind: "craft", item: "minecraft:iron_sword" });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("made 1 iron_sword (smelted 2 iron_ingot first)");
    expect(result.gained).toEqual({ "minecraft:iron_sword": 1, "minecraft:raw_iron": -2, "minecraft:stick": -1, "minecraft:coal": -1 });
    expect(result.actions).toContain("the furnace smelted 2 iron_ingot");
  });

  it("fails naming the missing ingredient and its count", async () => {
    const w = world();
    w.give("iron_ingot", 1);
    w.give("stick", 1);
    w.place("crafting_table", { x: 4, y: 64, z: 0 });
    const result = await run(w, { kind: "craft", item: "iron_sword" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_ingredient");
    expect(result.message).toMatch(/^needs 1 more iron_ingot \(has 1\)/);
    expect(result.gained).toEqual({});
  });

  it("without a recipe index says so and asks the game's lookup about what the inventory holds", async () => {
    const w = new FakeWorld(fakeClock);
    w.give("stick", 1);
    const result = await drive(runTaskStep({ kind: "craft", item: "minecraft:oak_planks" }, w.env({ recipesNote: "no bedrock-samples behavior pack is cached" })), 100);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_found");
    expect(result.message).toContain("no recipe index (no bedrock-samples behavior pack is cached)");
  });
});

describe("smelt", () => {
  it("fetches coal from a chest near when the inventory holds no fuel", async () => {
    const w = world();
    w.give("raw_iron", 3);
    w.place("chest", { x: 3, y: 64, z: 3 }, [stack("coal", 5)]);
    w.place("furnace", { x: -4, y: 64, z: 0 });
    const result = await run(w, { kind: "smelt", item: "iron ingot", count: 3 });
    expect(result.ok).toBe(true);
    expect(result.gained).toEqual({ "minecraft:iron_ingot": 3, "minecraft:raw_iron": -3 });
    expect(w.blockAt({ x: 3, y: 64, z: 3 })?.slots?.[0]).toMatchObject({ item: "minecraft:coal", count: 4 });
    expect(result.actions.some((line) => /^moved 1 coal from container_items:0/.test(line))).toBe(true);
  });

  it("takes the input's name too: raw_iron smelts into iron_ingot", async () => {
    const w = world();
    w.give("raw_iron", 1);
    w.give("coal", 1);
    w.place("furnace", { x: -4, y: 64, z: 0 });
    const result = await run(w, { kind: "smelt", item: "raw_iron" });
    expect(result.ok).toBe(true);
    expect(result.gained["minecraft:iron_ingot"]).toBe(1);
  });

  it("closes the screen and lets go of the input when cancelled while the furnace works", async () => {
    const w = world();
    w.give("raw_iron", 3);
    w.give("coal", 1);
    w.place("furnace", { x: -4, y: 64, z: 0 });
    const abort = new AbortController();
    const step = runTaskStep({ kind: "smelt", item: "iron_ingot", count: 3 }, w.env(), abort.signal);
    for (let t = 0; t < 200 && !(w.screen?.kind === "furnace" && w.blockAt({ x: -4, y: 64, z: 0 })?.slots?.[0]); t++) await vi.advanceTimersByTimeAsync(100);
    expect(w.screen?.kind).toBe("furnace");
    await vi.advanceTimersByTimeAsync(3_000);
    abort.abort();
    const result = await drive(step, 100);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cancelled");
    expect(w.screen).toBeNull();
    expect(w.closes).toBeGreaterThanOrEqual(1);
    expect(w.releases).toBeGreaterThanOrEqual(1);
  });
});

describe("trade", () => {
  const offer = { buyA: stack("wheat", 20), buyB: null, sell: stack("emerald", 1), uses: 0, maxUses: 16 };

  it("buys an emerald with the items the offer costs", async () => {
    const w = world();
    w.give("wheat", 20);
    w.villager("-77", { x: 6, y: 64, z: 0 }, [offer]);
    const result = await run(w, { kind: "trade", item: "emerald" });
    expect(result.ok).toBe(true);
    expect(result.gained).toEqual({ "minecraft:emerald": 1, "minecraft:wheat": -20 });
    expect(result.actions).toContain("traded 1 time: 20 wheat for 1 emerald");
    expect(result.actions).toContain("offers of the villager at 6 64 0: 1 emerald for 20 wheat");
  });

  it("fails with what the offer costs and how much is missing when the items are too few", async () => {
    const w = world();
    w.give("wheat", 5);
    w.villager("-77", { x: 6, y: 64, z: 0 }, [offer]);
    const result = await run(w, { kind: "trade", item: "emerald" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_ingredient");
    expect(result.message).toContain("sells 1 emerald for 20 wheat; needs 15 more wheat (has 5)");
    expect(result.gained).toEqual({});
    expect(w.screen).toBeNull();
  });

  it("answers no_offer naming what the traders sell", async () => {
    const w = world();
    w.give("wheat", 20);
    w.villager("-77", { x: 6, y: 64, z: 0 }, [offer]);
    const result = await run(w, { kind: "trade", item: "minecraft:bread" });
    expect(result.reason).toBe("no_offer");
    expect(result.message).toBe("no trader within 16 blocks sells bread (they sell 1 emerald)");
  });
});

describe("fetch", () => {
  it("takes the item out of a shulker box lying in a chest, and leaves the placed box standing", async () => {
    const w = world();
    w.place("chest", { x: 3, y: 64, z: 0 }, [stack("red_shulker_box", 1, [stack("diamond", 10)])]);
    const result = await run(w, { kind: "fetch", item: "diamond", count: 3 });
    expect(result.ok).toBe(true);
    expect(result.gained).toEqual({ "minecraft:diamond": 3 });
    const left = result.actions.find((line) => line.startsWith("left the red_shulker_box placed at "));
    expect(left).toBeDefined();
    const [x, y, z] = (left ?? "").replace("left the red_shulker_box placed at ", "").split(" ").map(Number);
    const placed = w.blockAt({ x: x ?? 0, y: y ?? 0, z: z ?? 0 });
    expect(placed?.typeId).toBe("minecraft:red_shulker_box");
    expect(placed?.slots?.[0]).toMatchObject({ item: "minecraft:diamond", count: 7 });
    expect(w.blockAt({ x: 3, y: 64, z: 0 })?.slots?.[0]).toBeNull();
  });

  it("recovers from a refused move through the first possible repair and records it", async () => {
    const w = world();
    w.place("chest", { x: 3, y: 64, z: 0 }, [stack("diamond", 5)]);
    w.refusals.push({ to: "hotbar_items:0", reason: "the slot is locked" });
    const result = await run(w, { kind: "fetch", item: "diamond", count: 5 });
    expect(result.ok).toBe(true);
    expect(result.gained).toEqual({ "minecraft:diamond": 5 });
    expect(result.actions).toContain("the game refused moving 5 diamond from container_items:0 to hotbar_items:0 (0 of 5 taken so far) (the slot is locked); repair: other_slot (try the move with another slot)");
  });

  it("fails with not_found and where it looked when no container holds the item", async () => {
    const w = world();
    w.place("chest", { x: 3, y: 64, z: 0 }, [stack("dirt", 5)]);
    const result = await run(w, { kind: "fetch", item: "minecraft:diamond" });
    expect(result.reason).toBe("not_found");
    expect(result.message).toBe("no diamond in the 1 container within 16 blocks");
  });
});

describe("names", () => {
  function oreWorld(): FakeWorld {
    const w = world();
    w.give("raw_iron", 3);
    w.give("raw_copper", 3);
    w.give("coal", 2);
    w.place("furnace", { x: -4, y: 64, z: 0 });
    return w;
  }

  it("takes the ore there is most of when the name is tied", async () => {
    const w = oreWorld();
    w.give("raw_copper", 2);
    const result = await run(w, { kind: "smelt", item: "the ore" });
    expect(result.ok).toBe(true);
    expect(result.gained["minecraft:copper_ingot"]).toBe(1);
  });

  it("fails naming the candidates when a tie remains", async () => {
    const w = oreWorld();
    const result = await run(w, { kind: "smelt", item: "the ore" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_found");
    expect(result.message).toBe('"the ore" as the item to smelt or the item to get from smelting could mean raw_copper or raw_iron equally: name one');
    expect(result.gained).toEqual({});
  });
});

describe("equip and reach", () => {
  it("puts a shield in the off hand and holds a sword from the main inventory", async () => {
    const w = world();
    w.give("shield", 1);
    w.give("iron_sword", 1);
    const shield = await run(w, { kind: "equip", item: "shield" });
    expect(shield.ok).toBe(true);
    expect(w.inventory.offhand?.item).toBe("minecraft:shield");
    const sword = await run(w, { kind: "equip", item: "iron sword" });
    expect(sword.ok).toBe(true);
    expect(w.inventory.hotbar[w.inventory.selectedSlot - 1]?.item).toBe("minecraft:iron_sword");
  });

  it("stands next to the nearest block of a type", async () => {
    const w = world();
    w.place("crafting_table", { x: 8, y: 64, z: 0 });
    const result = await run(w, { kind: "reach_block", block: "crafting table" });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("standing next to the crafting_table at 8 64 0");
  });

  it("reports unreachable when no way leads to the block", async () => {
    const w = world();
    w.place("crafting_table", { x: 8, y: 64, z: 0 });
    w.unreachable.add("8,64,0");
    const result = await run(w, { kind: "reach_block", block: "minecraft:crafting_table" });
    expect(result.reason).toBe("unreachable");
  });

  it("stands next to the nearest entity of a type", async () => {
    const w = world();
    w.villager("-5", { x: 10, y: 64, z: 0 }, []);
    const result = await run(w, { kind: "reach_entity", type: "villager" });
    expect(result.ok).toBe(true);
  });
});

describe("using a block from where the player can", () => {
  const usesOf = (w: FakeWorld, block: string) => w.uses.filter((use) => use.startsWith(`${block} `) || use.startsWith(`${block}@`));

  it("tries each face the eye is on the side of, then steps to another spot", async () => {
    const w = world();
    w.place("chest", { x: 3, y: 64, z: 0 }, [stack("diamond", 2)]);
    w.blockedFrom.set("3,64,0", new Set(["4,64,0"]));
    const result = await run(w, { kind: "fetch", item: "diamond", count: 2 });
    expect(result.ok).toBe(true);
    expect(result.gained).toEqual({ "minecraft:diamond": 2 });
    expect(w.uses.slice(0, 3)).toEqual(["3,64,0 from 4,64,0", "3,64,0@up from 4,64,0", "3,64,0@east from 4,64,0"]);
    expect(w.uses[3]).not.toContain("from 4,64,0");
    expect(result.actions.some((line) => /^stepped to -?\d+ 64 -?\d+ to use the chest at 3 64 0$/.test(line))).toBe(true);
  });

  it("notices the neighbour chest that opened instead and uses the wanted one from another spot", async () => {
    const w = world();
    w.place("chest", { x: 3, y: 64, z: 0 }, [stack("diamond", 1)]);
    w.place("chest", { x: 3, y: 64, z: 2 }, [stack("dirt", 1)]);
    w.opensInstead.set("3,64,0", { from: "4,64,0", opens: "3,64,2" });
    const result = await run(w, { kind: "fetch", item: "diamond" });
    expect(result.ok).toBe(true);
    expect(result.gained).toEqual({ "minecraft:diamond": 1 });
    expect(w.blockAt({ x: 3, y: 64, z: 2 })?.slots?.[0]).toMatchObject({ item: "minecraft:dirt", count: 1 });
    expect(usesOf(w, "3,64,0").length).toBeGreaterThan(3);
  });

  it("says which chest opened when only the wrong one ever does", async () => {
    const w = world();
    w.place("chest", { x: 3, y: 64, z: 0 }, [stack("diamond", 1)]);
    w.place("chest", { x: 3, y: 64, z: 2 }, [stack("dirt", 1)]);
    w.opensInstead.set("3,64,0", { from: "*", opens: "3,64,2" });
    const result = await run(w, { kind: "fetch", item: "diamond" });
    expect(result.ok).toBe(false);
    expect(result.actions.some((line) => line.includes("from 4 64 0 at its nearest point: it opened the chest at 3 64 2 instead"))).toBe(true);
  });

  it("takes the other half of a double chest as the wanted chest", async () => {
    const w = world();
    w.place("chest", { x: 3, y: 64, z: 0 }, [stack("diamond", 1)]);
    w.place("chest", { x: 3, y: 64, z: 1 }, [stack("diamond", 1)]);
    w.opensInstead.set("3,64,0", { from: "*", opens: "3,64,1" });
    const result = await run(w, { kind: "fetch", item: "diamond" });
    expect(result.ok).toBe(true);
    expect(result.actions).toContain("opened the chest screen (the other half of the double chest, at 3 64 1)");
  });

  it("gives a block up after the use cap, listing every spot and face, and moves to the next block", async () => {
    const w = world();
    w.place("chest", { x: 3, y: 64, z: 0 }, [stack("diamond", 1)]);
    w.place("chest", { x: -6, y: 64, z: 0 }, [stack("diamond", 1)]);
    w.blockedFrom.set("3,64,0", new Set(["*"]));
    const result = await run(w, { kind: "fetch", item: "diamond" });
    expect(result.ok).toBe(true);
    expect(usesOf(w, "3,64,0")).toHaveLength(12);
    const refusal = result.actions.find((line) => line.startsWith("the chest at 3 64 0 refused: tried 12 uses: "));
    expect(refusal).toContain("from 4 64 0 at its nearest point: no view from the player's eye reaches the block at 3 64 0: the crosshair lands on the block at 4 64 0 instead; ");
    expect(refusal).toContain("from 4 64 0 on its up face: ");
    expect(refusal).toMatch(/stopped after 12 uses in \d+ s$/);
    expect(usesOf(w, "-6,64,0").length).toBeGreaterThan(0);
  });

  it("gives a block up after the time cap", async () => {
    const w = world();
    w.walkMs = 20_000;
    w.place("crafting_table", { x: 4, y: 64, z: 0 });
    w.blockedFrom.set("4,64,0", new Set(["*"]));
    w.give("oak_log", 1);
    w.give("iron_ingot", 2);
    w.give("stick", 1);
    const result = await run(w, { kind: "craft", item: "iron_sword" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("refused");
    expect(result.message).toMatch(/^no crafting table within 16 blocks could be used \(the crafting_table at 4 64 0: tried \d+ uses: .*stopped after \d+ uses in 40 s\)$/);
    expect(usesOf(w, "4,64,0").length).toBeLessThan(12);
  });
});

describe("using a trader from where the player can", () => {
  const offer = { buyA: stack("wheat", 20), buyB: null, sell: stack("emerald", 1), uses: 0, maxUses: 16 };
  const bread = { buyA: stack("emerald", 1), buyB: null, sell: stack("bread", 6), uses: 0, maxUses: 16 };

  function traders(): FakeWorld {
    const w = world();
    w.give("wheat", 20);
    w.villager("-77", { x: 6, y: 64, z: 0 }, [offer]);
    w.villager("-78", { x: 12, y: 64, z: 0 }, [bread]);
    w.entityInFront.set("-77", { from: new Set(["7,64,0"]), other: "-78" });
    return w;
  }

  it("does not use the trader when another one is in the line of sight, and steps aside", async () => {
    const w = traders();
    const result = await run(w, { kind: "trade", item: "emerald" });
    expect(result.ok).toBe(true);
    expect(result.gained).toEqual({ "minecraft:emerald": 1, "minecraft:wheat": -20 });
    expect(w.uses.filter((use) => use === "entity -77 from 7,64,0")).toEqual([]);
  });

  it("closes the trade screen of another trader, told by the screen's trader id", async () => {
    const w = traders();
    const result = await drive(runTaskStep({ kind: "trade", item: "emerald" }, w.env({ noLookAt: true })), 100, 300_000);
    expect(result.ok).toBe(true);
    expect(w.uses).toContain("entity -77 from 7,64,0");
    expect(w.villagers[1]?.offers[0]?.uses).toBe(0);
  });

  it("without the trader id, a screen without the offer while the crosshair rests on another trader is the wrong one", async () => {
    const w = traders();
    w.hideTrader = true;
    const result = await drive(runTaskStep({ kind: "trade", item: "emerald" }, w.env({ noLookAt: true })), 100, 300_000);
    expect(result.ok).toBe(true);
    expect(result.gained["minecraft:emerald"]).toBe(1);
  });

  it("steps aside when a block stands between the eye and the trader", async () => {
    const w = world();
    w.give("wheat", 20);
    w.villager("-77", { x: 6, y: 64, z: 0 }, [offer]);
    w.entityBlockedFrom.set("-77", new Set(["7,64,0"]));
    const result = await run(w, { kind: "trade", item: "emerald" });
    expect(result.ok).toBe(true);
    expect(w.uses.some((use) => use.endsWith("from 7,64,0"))).toBe(false);
  });

  it("names every spot it tried when no view reaches the trader", async () => {
    const w = world();
    w.give("wheat", 20);
    w.villager("-77", { x: 6, y: 64, z: 0 }, [offer]);
    w.entityBlockedFrom.set("-77", new Set(["*"]));
    const result = await run(w, { kind: "trade", item: "emerald" });
    expect(result.reason).toBe("refused");
    expect(result.message).toContain("the villager at 6 64 0: tried 0 uses from 5 spots: from 7 64 0: the block at 7 65 0 is in the way; ");
    expect(w.uses).toEqual([]);
  });
});

describe("live-run fixes", () => {
  it("waits for the inventory screen and tries a craft again while the screen is not readable yet", async () => {
    const w = world();
    w.give("oak_log", 1);
    w.inventoryLagPolls = 5;
    w.notReadableActs = 2;
    const result = await run(w, { kind: "craft", item: "oak_planks", count: 4 });
    expect(result.ok).toBe(true);
    expect(result.gained).toEqual({ "minecraft:oak_planks": 4, "minecraft:oak_log": -1 });
    expect(result.actions.filter((line) => line.includes("the screen was not readable yet"))).toHaveLength(2);
  });

  it("crafts at the table near when the inventory grid stays unreadable", async () => {
    const w = world();
    w.give("oak_log", 1);
    w.place("crafting_table", { x: 4, y: 64, z: 0 });
    w.notReadableActs = 3;
    const result = await run(w, { kind: "craft", item: "oak_planks", count: 4 });
    expect(result.ok).toBe(true);
    expect(result.actions).toContain("using a crafting table instead");
    expect(result.actions).toContain("walked to the crafting_table at 4 64 0");
  });

  it("reports the inventory grid's own failure when no table is there to fall back on", async () => {
    const w = world();
    w.give("oak_log", 1);
    w.notReadableActs = 3;
    const result = await run(w, { kind: "craft", item: "oak_planks", count: 4 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("refused");
    expect(result.message).toContain("anchor not resolved: the open screen's controller is not readable now");
    expect(result.message).toContain("(and no crafting table within 48 blocks");
  });

  it("does not let one failing entity query hide the traders the others found", async () => {
    const w = world();
    w.give("wheat", 20);
    w.villager("-77", { x: 6, y: 64, z: 0 }, [{ buyA: stack("wheat", 20), buyB: null, sell: stack("emerald", 1), uses: 0, maxUses: 16 }]);
    w.entityErrors.set("minecraft:villager", "helper: Invalid entity type");
    const result = await run(w, { kind: "trade", item: "emerald" });
    expect(result.ok).toBe(true);
  });

  it("fails with the helper's error, not 'no villager', when every entity query failed", async () => {
    const w = world();
    for (const type of ["minecraft:villager_v2", "minecraft:villager", "minecraft:wandering_trader"]) w.entityErrors.set(type, "helper: no player in the world");
    const result = await run(w, { kind: "trade", item: "emerald" });
    expect(result.reason).toBe("no_agent");
    expect(result.message).toMatch(/^no villager or wandering trader within 48 blocks \(asked for minecraft:villager_v2, minecraft:villager, minecraft:wandering_trader\); every query failed: entities minecraft:villager_v2 within 16: helper: no player in the world; /);
  });

  it("says what it asked for and how far when no trader is there", async () => {
    const w = world();
    const result = await run(w, { kind: "trade", item: "emerald" });
    expect(result.reason).toBe("no_station");
    expect(result.message).toBe("no villager or wandering trader within 48 blocks (asked for minecraft:villager_v2, minecraft:villager, minecraft:wandering_trader)");
  });

  it("takes all of an item when no number was given, and says so", async () => {
    const w = world();
    w.place("chest", { x: 3, y: 64, z: 0 }, [stack("diamond", 3)]);
    const result = await run(w, { kind: "fetch", item: "diamond", all: true });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("took all 3 diamond out of the 1 container within 16 blocks");
    expect(result.gained).toEqual({ "minecraft:diamond": 3 });
  });
});

describe("item phrases", () => {
  function planks(): FakeWorld {
    const w = world();
    w.give("oak_planks", 8);
    w.place("crafting_table", { x: 4, y: 64, z: 0 });
    return w;
  }

  for (const phrase of ["wood pickaxe", "wooden pickaxe made at the crafting table over there", "pickaxe out of the planks", "pickaxe from wood"]) {
    it(`makes the wooden pickaxe for "${phrase}"`, async () => {
      const result = await run(planks(), { kind: "craft", item: phrase });
      expect(result.ok).toBe(true);
      expect(result.gained["minecraft:wooden_pickaxe"]).toBe(1);
    });
  }

  it("takes the only variant makeable from what is at hand for a bare \"pickaxe\", and says so", async () => {
    const result = await run(planks(), { kind: "craft", item: "pickaxe" });
    expect(result.ok).toBe(true);
    expect(result.message).toBe('made 1 wooden_pickaxe (made 4 stick first) (chosen for "pickaxe": the only one makeable from the inventory)');
  });

  it("fails honestly for an iron pickaxe with only planks", async () => {
    const result = await run(planks(), { kind: "craft", item: "an iron pickaxe" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_ingredient");
    expect(result.message).toMatch(/^needs 3 more iron_ingot \(has 0\)/);
  });

  it("names the variants it weighed when none of them can be made", async () => {
    const w = world();
    w.place("crafting_table", { x: 4, y: 64, z: 0 });
    const result = await run(w, { kind: "craft", item: "pickaxe" });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('"pickaxe" as the item to craft could mean iron_pickaxe or stone_pickaxe or wooden_pickaxe equally (none of them can be made from what is at hand): name one');
  });

  it("takes the best material makeable for a bare \"sword\" (iron before wood)", async () => {
    const w = planks();
    w.give("iron_ingot", 2);
    w.give("stick", 1);
    const result = await run(w, { kind: "craft", item: "sword" });
    expect(result.ok).toBe(true);
    expect(result.gained["minecraft:iron_sword"]).toBe(1);
    expect(result.message).toContain('(chosen for "sword": the best material makeable from the inventory; also makeable: wooden_sword)');
  });
});

describe("fetching every item, and placing the box", () => {
  function shulkerChest(): FakeWorld {
    const w = world();
    w.place("chest", { x: 3, y: 64, z: 0 }, [stack("red_shulker_box", 1, [stack("diamond", 3)])]);
    return w;
  }

  it("takes all 3 even when the nested read shows 1 and the inventory read lags a move behind", async () => {
    const w = shulkerChest();
    w.nestedReadsShort = true;
    w.lagInventoryReads = true;
    const result = await run(w, { kind: "fetch", item: "diamond", all: true });
    expect(result.ok).toBe(true);
    expect(result.gained).toEqual({ "minecraft:diamond": 3 });
    expect(result.message).toMatch(/^took all 3 diamond out of the 1 container within 16 blocks; the red_shulker_box at -?\d+ 64 -?\d+ stays placed \(a step never breaks blocks\)$/);
  });

  it("fails with both numbers when some stay out of reach", async () => {
    const w = world();
    w.place("chest", { x: 3, y: 64, z: 0 }, [stack("diamond", 2)]);
    w.place("chest", { x: -3, y: 64, z: 0 }, [stack("diamond", 2)]);
    w.unreachable.add("-3,64,0");
    const result = await run(w, { kind: "fetch", item: "diamond", all: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_found");
    expect(result.message).toBe("took 2 of the 4 diamond the 2 containers within 16 blocks held at first, and 2 still read as there");
  });

  it("places the box on the next cell when no view reaches the first", async () => {
    const w = shulkerChest();
    w.noViewFloors.add("4,63,-1");
    const result = await run(w, { kind: "fetch", item: "diamond", count: 3 });
    expect(result.ok).toBe(true);
    expect(result.actions).toContain(
      "placing the red_shulker_box failed at 4 64 -1: no view from the player's eye reaches the block at 4 63 -1: the crosshair lands on the block at 4 64 0 instead",
    );
    expect(result.actions).toContain("placed the red_shulker_box at 4 64 1");
    expect(w.blockAt({ x: 4, y: 64, z: 1 })?.typeId).toBe("minecraft:red_shulker_box");
  });

  it("names every cell it tried when the box cannot be placed anywhere", async () => {
    const w = shulkerChest();
    for (let x = -2; x <= 10; x++) for (let z = -6; z <= 6; z++) w.noViewFloors.add(`${x},63,${z}`);
    const result = await run(w, { kind: "fetch", item: "diamond", count: 3 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("refused");
    expect(result.message).toMatch(/^placing the red_shulker_box failed in 12 tries: 4 64 -1: no view from the player's eye reaches the block at 4 63 -1: .*; /);
    expect(w.uses.length).toBeGreaterThan(0);
  });
});

describe("taskStepDone", () => {
  it("checks counts, held items and distance", () => {
    expect(taskStepDone({ kind: "craft", item: "iron sword" }, {}, { "minecraft:iron_sword": 1 })).toBe(true);
    expect(taskStepDone({ kind: "fetch", item: "diamond", count: 3 }, { "minecraft:diamond": 1 }, { "minecraft:diamond": 3 })).toBe(false);
    expect(taskStepDone({ kind: "smelt", item: "raw_iron" }, {}, { "minecraft:iron_ingot": 1 }, { item: "minecraft:iron_ingot" })).toBe(true);
    expect(taskStepDone({ kind: "equip", item: "shield" }, {}, {}, { offhand: "minecraft:shield" })).toBe(true);
    expect(taskStepDone({ kind: "reach_block", block: "chest" }, {}, {}, { distance: 1.2 })).toBe(true);
    expect(taskStepDone({ kind: "reach_entity", type: "cow" }, {}, {}, {})).toBe(false);
  });
});
