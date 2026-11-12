/**
 * The workstation module: what an interact answer, an open screen, a move, an act and a close become before anything is
 * trusted, the parameters each call accepts, and how the typed calls reach the agent.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { engine, EngineSession } from "./engine.ts";
import type { EngineResult } from "./failure.ts";
import {
  interactBlock,
  interactBlockParams,
  interactEntity,
  interactEntityParams,
  interactText,
  parseInteract,
  parseScreenAct,
  parseScreenClose,
  parseScreenMove,
  parseScreenState,
  parseSlotRef,
  registerWorkstationTools,
  screenAct,
  screenActParams,
  screenActText,
  screenClose,
  screenMove,
  screenMoveParams,
  screenState,
  screenStateText,
} from "./workstation.ts";

const slot = (item: string, count = 1) => ({ item, count });

/** A session that answers the methods in `values`, records every call, and reports the rest as an older agent. */
function recording(values: Record<string, unknown> = {}) {
  const session = new EngineSession({ port: 9, timeoutMs: 100 });
  const calls: { method: string; params?: unknown }[] = [];
  session.call = async <T>(method: string, params?: unknown): Promise<EngineResult<T>> => {
    calls.push({ method, params });
    return method in values
      ? { ok: true, value: values[method] as T }
      : { ok: false, code: -32601, reason: "unknown_method", message: `no ${method}` };
  };
  return { session, calls };
}

describe("interact.block and interact.entity answers", () => {
  it("reads the screen that opened and treats an opened screen as a change", () => {
    expect(parseInteract({ screen: "crafting_table_screen", changed: true }, "block")).toEqual({
      target: "block",
      screen: "crafting_table_screen",
      changed: true,
    });
    expect(parseInteract({ screen: " trade_screen " }, "entity")).toEqual({
      target: "entity",
      screen: "trade_screen",
      changed: true,
    });
  });

  it("reads an interaction that opened nothing", () => {
    expect(parseInteract({ screen: null, changed: false }, "block")).toEqual({ target: "block", screen: null, changed: false });
    expect(parseInteract({ changed: true }, "block")).toEqual({ target: "block", screen: null, changed: true });
    expect(parseInteract({}, "block")).toEqual({ target: "block", screen: null, changed: false });
  });

  it("refuses an answer that is not an object, or one whose fields are the wrong type", () => {
    expect(parseInteract([], "block")).toBeUndefined();
    expect(parseInteract("trade_screen", "block")).toBeUndefined();
    expect(parseInteract({ screen: 5 }, "block")).toBeUndefined();
    expect(parseInteract({ screen: null, changed: "yes" }, "block")).toBeUndefined();
  });
});

describe("screen.state answers", () => {
  const item = (name: string, count = 1) => ({ item: name, count, enchantments: [] });

  it("reads a container screen: its name, its kind and every container's slots, with no state of its own", () => {
    const state = parseScreenState({
      screen: "chest_screen",
      kind: "chest",
      containers: { container: [slot("minecraft:coal", 9), null], player: [null] },
      data: null,
    });
    expect(state?.screen).toBe("chest_screen");
    expect(state?.kind).toBe("chest");
    expect(state?.containers.container).toEqual([item("minecraft:coal", 9), null]);
    expect(state?.containers.player).toHaveLength(1);
    expect(state?.data).toBeNull();
    // Outside a world the agent answers no containers and no data.
    expect(parseScreenState({ screen: "start_screen", kind: "other" })?.data).toBeNull();
  });

  it("names an unknown or absent kind other, and a screen without containers has none", () => {
    expect(parseScreenState({ screen: "chest_screen", kind: "moon_chest" })?.kind).toBe("other");
    expect(parseScreenState({ screen: "hud_screen" })?.containers).toEqual({});
    expect(parseScreenState({ screen: "furnace_screen", kind: "blast_furnace" })?.kind).toBe("blast_furnace");
  });

  it("reads a villager's offers, the selected one and the trader, as the agent sends them", () => {
    const state = parseScreenState({
      screen: "trade_screen",
      kind: "trade",
      containers: { TradeIngredient1Container: [slot("minecraft:emerald", 3)], HotbarContainer: [slot("minecraft:bread", 6)] },
      data: {
        offers: [
          { index: 0, buyA: slot("minecraft:wheat", 20), buyB: null, sell: slot("minecraft:emerald"), uses: 2, maxUses: 16, locked: false, netId: 4097 },
          { index: 1, buyA: slot("minecraft:emerald"), buyB: null, sell: slot("minecraft:bread", 6), uses: 12, maxUses: 12, locked: true, netId: 4098 },
          { index: 2, buyA: slot("minecraft:emerald", 3), buyB: slot("minecraft:wheat", 20), sell: slot("minecraft:cookie", 18), uses: null, maxUses: null, locked: false, netId: null },
        ],
        selected: 1,
        trader: "-4294967283",
      },
    });
    expect(state?.data?.offers?.map((offer) => offer.index)).toEqual([0, 1, 2]);
    expect(state?.data?.offers?.[0]).toEqual({
      index: 0,
      buyA: item("minecraft:wheat", 20),
      buyB: null,
      sell: item("minecraft:emerald"),
      uses: 2,
      maxUses: 16,
      locked: false,
      netId: 4097,
    });
    expect(state?.data?.offers?.[1]?.locked).toBe(true);
    expect(state?.data?.offers?.[2]).toMatchObject({ buyB: item("minecraft:wheat", 20), uses: null, maxUses: null, netId: null });
    expect(state?.data?.selected).toBe(1);
    expect(state?.data?.trader).toBe("-4294967283");
    // A trader the game no longer has: no offers, no trader, and the selection the model still holds.
    const gone = parseScreenState({ screen: "trade_screen", kind: "trade", data: { offers: [], selected: -1, trader: null } });
    expect(gone?.data).toEqual({ offers: [], selected: -1, trader: null });
  });

  it("reads the stonecutter's recipes, the selected one and its result", () => {
    const state = parseScreenState({
      screen: "stonecutter_screen",
      kind: "stonecutter",
      data: {
        recipes: [
          { index: 0, result: slot("minecraft:stone_slab", 2), netId: 1201 },
          { index: 1, result: slot("minecraft:stone_stairs"), netId: 1202 },
        ],
        selected: 0,
        result: slot("minecraft:stone_slab", 2),
      },
    });
    expect(state?.data?.recipes).toEqual([
      { index: 0, result: item("minecraft:stone_slab", 2), netId: 1201 },
      { index: 1, result: item("minecraft:stone_stairs"), netId: 1202 },
    ]);
    expect(state?.data?.selected).toBe(0);
    expect(state?.data?.result).toEqual(item("minecraft:stone_slab", 2));
    const empty = parseScreenState({ screen: "stonecutter_screen", kind: "stonecutter", data: { recipes: [], selected: -1, result: null } });
    expect(empty?.data).toEqual({ recipes: [], selected: -1, result: null });
  });

  it("reads the enchanting options with their enchantments, lapis and net ids", () => {
    const state = parseScreenState({
      screen: "enchanting_screen",
      kind: "enchanting_table",
      data: {
        options: [
          { option: 0, cost: 1, hint: "efficiency", level: 1, lapis: 1, levelsTaken: 1, enchants: [{ id: 15, level: 1 }], netId: 9 },
          { option: 1, cost: 17, hint: "unbreaking", level: 2, lapis: 2, levelsTaken: 2, enchants: [{ id: 17, level: 2 }, { id: 15, level: 1 }], netId: 10 },
          { option: 2, cost: null, hint: null, level: null, enchants: [], netId: null },
        ],
      },
    });
    expect(state?.data?.options?.[0]).toEqual({ option: 0, cost: 1, hint: "efficiency", level: 1, lapis: 1, levelsTaken: 1, enchants: [{ id: 15, level: 1 }], netId: 9 });
    expect(state?.data?.options?.[1]).toMatchObject({ cost: 17, lapis: 2, levelsTaken: 2 });
    expect(state?.data?.options?.[1]?.enchants).toHaveLength(2);
    // An agent that does not report the lapis: null, not a guess.
    expect(state?.data?.options?.[2]).toEqual({ option: 2, cost: null, hint: null, level: null, lapis: null, levelsTaken: null, enchants: [], netId: null });
    expect(parseScreenState({ screen: "enchanting_screen", kind: "enchanting_table", data: { options: [] } })?.data).toEqual({ options: [] });
  });

  it("reads furnace and brewing progress as fractions", () => {
    for (const kind of ["furnace", "blast_furnace", "smoker"]) {
      expect(parseScreenState({ screen: `${kind}_screen`, kind, data: { burn: 0.75, cook: 0.3125 } })?.data).toEqual({ burn: 0.75, cook: 0.3125 });
    }
    expect(parseScreenState({ screen: "furnace_screen", kind: "furnace", data: { burn: null, cook: 0 } })?.data).toEqual({ burn: null, cook: 0 });
    const brewing = parseScreenState({ screen: "brewing_stand_screen", kind: "brewing_stand", data: { brew: 0.5, fuel: 1 } });
    expect(brewing?.data).toEqual({ brew: 0.5, fuel: 1 });
  });

  it("reads a result screen's result and inputs", () => {
    const state = parseScreenState({
      screen: "grindstone_screen",
      kind: "grindstone",
      data: {
        result: slot("minecraft:iron_sword"),
        inputs: { grindstone_input_items: [slot("minecraft:iron_sword")], grindstone_additional_items: [null] },
      },
    });
    expect(state?.data?.result).toEqual(item("minecraft:iron_sword"));
    expect(state?.data?.inputs).toEqual({ grindstone_input_items: [item("minecraft:iron_sword")], grindstone_additional_items: [null] });
    for (const kind of ["smithing_table", "cartography_table"]) {
      expect(parseScreenState({ screen: `${kind}_screen`, kind, data: { result: null, inputs: {} } })?.data).toEqual({ result: null, inputs: {} });
    }
  });

  it("reads an anvil: the result, the levels it costs, whether that is too expensive and the rename text", () => {
    const state = parseScreenState({
      screen: "anvil_screen",
      kind: "anvil",
      containers: { anvil_input_items: [slot("minecraft:iron_pickaxe")] },
      data: { result: slot("minecraft:iron_pickaxe"), xpCost: 5, tooExpensive: false, name: "Pick" },
    });
    expect(state?.data).toEqual({ result: item("minecraft:iron_pickaxe"), xpCost: 5, tooExpensive: false, name: "Pick" });
    const empty = parseScreenState({ screen: "anvil_screen", kind: "anvil", data: { result: null, xpCost: null, tooExpensive: null, name: "" } });
    expect(empty?.data).toEqual({ result: null, xpCost: null, tooExpensive: null, name: "" });
  });

  it("reads a beacon's effects, named or numeric, and the loom's pattern", () => {
    const beacon = parseScreenState({ screen: "beacon_screen", kind: "beacon", data: { primary: "speed", secondary: null } });
    expect(beacon?.data).toEqual({ primary: "speed", secondary: null });
    expect(parseScreenState({ screen: "beacon_screen", kind: "beacon", data: { primary: 26, secondary: "regeneration" } })?.data).toEqual({
      primary: 26,
      secondary: "regeneration",
    });
    expect(parseScreenState({ screen: "loom_screen", kind: "loom", data: { pattern: "creeper" } })?.data).toEqual({ pattern: "creeper" });
    expect(parseScreenState({ screen: "loom_screen", kind: "loom", data: { pattern: null } })?.data).toEqual({ pattern: null });
  });

  it("reads a decoded state the agent cannot read now as unavailable, not as a failure", () => {
    const state = parseScreenState({
      screen: "furnace_screen",
      kind: "furnace",
      data: { unavailable: "the open screen's model is not a brewing stand's", anchor: "screen.furnace_progress" },
    });
    expect(state?.data).toEqual({ unavailable: "the open screen's model is not a brewing stand's", anchor: "screen.furnace_progress" });
    expect(parseScreenState({ screen: "loom_screen", kind: "loom", data: { unavailable: "no anchor", anchor: null } })?.data?.anchor).toBeNull();
  });

  it("keeps fields it does not know, and passes an undecoded kind's data through", () => {
    const trade = parseScreenState({
      screen: "trade_screen",
      kind: "trade",
      data: { offers: [{ index: 0, buyA: null, buyB: null, sell: null, uses: 0, maxUses: 1, locked: false, netId: 1, tier: 2 }], selected: 0, trader: "7", tier: 3 },
    });
    expect(trade?.data?.tier).toBe(3);
    expect(trade?.data?.offers?.[0]).toHaveProperty("tier", 2);
    const horse = parseScreenState({ screen: "horse_screen", kind: "horse", data: { saddled: true, result: "anything" } });
    expect(horse?.data).toEqual({ saddled: true, result: "anything" });
  });

  it("refuses a screen without a name, an unreadable slot and a decoded field of the wrong type", () => {
    expect(parseScreenState({ kind: "chest" })).toBeUndefined();
    expect(parseScreenState({ screen: "  " })).toBeUndefined();
    expect(parseScreenState({ screen: "chest_screen", containers: { ChestContainer: [slot("stone", 0)] } })).toBeUndefined();
    expect(parseScreenState({ screen: "chest_screen", containers: [slot("stone")] })).toBeUndefined();
    expect(parseScreenState({ screen: "chest_screen", kind: "chest", data: "full" })).toBeUndefined();
    expect(parseScreenState({ screen: "anvil_screen", kind: "anvil", data: { xpCost: "lots" } })).toBeUndefined();
    expect(parseScreenState({ screen: "trade_screen", kind: "trade", data: { offers: [{ buyA: slot("minecraft:emerald") }] } })).toBeUndefined();
    expect(parseScreenState({ screen: "stonecutter_screen", kind: "stonecutter", data: { recipes: ["minecraft:stone_slab"] } })).toBeUndefined();
    expect(parseScreenState({ screen: "furnace_screen", kind: "furnace", data: { burn: 40, cook: 0 } })).toBeUndefined();
    expect(parseScreenState({ screen: "beacon_screen", kind: "beacon", data: { primary: true } })).toBeUndefined();
    expect(parseScreenState({ screen: "loom_screen", kind: "loom", data: { unavailable: 3 } })).toBeUndefined();
    expect(parseScreenState([])).toBeUndefined();
  });
});

describe("screen.move, screen.act and screen.close answers", () => {
  it("reads how many items crossed, and an answer that does not count", () => {
    expect(parseScreenMove({ moved: 3 })).toEqual({ moved: 3 });
    expect(parseScreenMove({})).toEqual({});
    expect(parseScreenMove({ moved: -1 })).toBeUndefined();
    expect(parseScreenMove({ moved: 1.5 })).toBeUndefined();
    expect(parseScreenMove([])).toBeUndefined();
  });

  it("reads what an act made, took and cost, and a refusal with its reason", () => {
    expect(parseScreenAct({ done: true, result: slot("minecraft:oak_planks", 4), consumed: [slot("minecraft:oak_log")], xpCost: 2 })).toEqual({
      done: true,
      result: { item: "minecraft:oak_planks", count: 4, enchantments: [] },
      consumed: [{ item: "minecraft:oak_log", count: 1, enchantments: [] }],
      xpCost: 2,
    });
    expect(parseScreenAct({ done: false, result: null, consumed: [], reason: "no recipe" })).toEqual({
      done: false,
      result: null,
      consumed: [],
      reason: "no recipe",
    });
    expect(parseScreenAct({ done: true, result: slot("minecraft:bread", 6), consumed: [slot("minecraft:emerald")], reason: null, to: "hotbar_items" })).toEqual({
      done: true,
      result: { item: "minecraft:bread", count: 6, enchantments: [] },
      consumed: [{ item: "minecraft:emerald", count: 1, enchantments: [] }],
    });
  });

  it("needs done, and refuses a bad cost or reason", () => {
    expect(parseScreenAct({ result: null, consumed: [] })).toBeUndefined();
    expect(parseScreenAct({ done: true, result: null, consumed: [], xpCost: -1 })).toBeUndefined();
    expect(parseScreenAct({ done: true, result: null, consumed: [], reason: 7 })).toBeUndefined();
    expect(parseScreenAct({ done: true, result: { item: "" }, consumed: [] })).toBeUndefined();
  });

  it("takes a close that says nothing as closed, and a refusal as a refusal", () => {
    expect(parseScreenClose(undefined)).toEqual({ closed: true });
    expect(parseScreenClose({})).toEqual({ closed: true });
    expect(parseScreenClose({ closed: false })).toEqual({ closed: false });
    expect(parseScreenClose("closed")).toBeUndefined();
    expect(parseScreenClose({ closed: 1 })).toBeUndefined();
  });

  it("keeps the Escapes the close sent", () => {
    expect(parseScreenClose({ closed: true, escapes: 2 })).toEqual({ closed: true, escapes: 2 });
    expect(parseScreenClose({ closed: false, escapes: 3 })).toEqual({ closed: false, escapes: 3 });
    expect(parseScreenClose({ closed: true, escapes: "2" })).toEqual({ closed: true });
    expect(parseScreenClose({ closed: true, escapes: -1 })).toEqual({ closed: true });
  });
});

describe("parameters", () => {
  it("takes a block position with an optional dimension and face", () => {
    expect(interactBlockParams({ x: 1, y: 64, z: -2 })).toEqual({ x: 1, y: 64, z: -2 });
    expect(interactBlockParams({ x: 1, y: 64, z: -2, dimension: "minecraft:nether", face: "up" })).toEqual({
      x: 1,
      y: 64,
      z: -2,
      dimension: "nether",
      face: "up",
    });
    expect(interactBlockParams({ x: 1, y: 64, z: -2, dimension: 2 })).toEqual({ x: 1, y: 64, z: -2, dimension: "the_end" });
    expect(typeof interactBlockParams({ x: 1, y: 64, z: -2, dimension: "minecraft:aether" })).toBe("string");
    expect(typeof interactBlockParams({ x: 1.5, y: 64, z: -2 })).toBe("string");
    expect(typeof interactBlockParams({ x: 1, y: 64, z: -2, face: "sideways" as never })).toBe("string");
  });

  it("takes an entity's unique id as a whole number in text", () => {
    expect(interactEntityParams(" 1234 ")).toEqual({ id: "1234" });
    expect(interactEntityParams("-5")).toEqual({ id: "-5" });
    expect(typeof interactEntityParams("12.5")).toBe("string");
    expect(typeof interactEntityParams("")).toBe("string");
    expect(typeof interactEntityParams("the villager")).toBe("string");
  });

  it("reads a container:slot reference from a command line", () => {
    expect(parseSlotRef("container:3")).toEqual({ container: "container", slot: 3 });
    expect(parseSlotRef("player:0")).toEqual({ container: "player", slot: 0 });
    expect(typeof parseSlotRef("container")).toBe("string");
    expect(typeof parseSlotRef(":2")).toBe("string");
    expect(typeof parseSlotRef("container:-1")).toBe("string");
    expect(typeof parseSlotRef("container:2.5")).toBe("string");
  });

  it("takes a move between two containers, with an optional count", () => {
    expect(screenMoveParams({ from: { container: "container", slot: 3 }, to: { container: "player", slot: 0 } })).toEqual({
      from: { container: "container", slot: 3 },
      to: { container: "player", slot: 0 },
    });
    expect(screenMoveParams({ from: { container: "container", slot: 0 }, to: { container: "player", slot: 0 }, count: 2 })).toHaveProperty("count", 2);
    expect(typeof screenMoveParams({ from: { container: "", slot: 0 }, to: { container: "player", slot: 0 } })).toBe("string");
    expect(typeof screenMoveParams({ from: { container: "container", slot: 0 }, to: { container: "player", slot: 0 }, count: 0 })).toBe("string");
  });

  it("takes each screen action with its own parameters and no others", () => {
    expect(screenActParams({ action: "craft", recipe: " minecraft:planks " })).toEqual({ action: "craft", recipe: "minecraft:planks" });
    expect(screenActParams({ action: "craft", recipe: "planks", times: 3 })).toEqual({ action: "craft", recipe: "planks", times: 3 });
    expect(typeof screenActParams({ action: "craft" })).toBe("string");
    expect(typeof screenActParams({ action: "craft", recipe: "planks", times: 0 })).toBe("string");
    expect(typeof screenActParams({ action: "craft", recipe: "planks", times: 1001 })).toBe("string");

    // The stonecutter takes the index of a recipe in data.recipes; a CLI flag arrives as digits.
    expect(screenActParams({ action: "stonecut", recipe: 2, times: 3 })).toEqual({ action: "stonecut", recipe: 2, times: 3 });
    expect(screenActParams({ action: "stonecut", recipe: " 0 " })).toEqual({ action: "stonecut", recipe: 0 });
    expect(typeof screenActParams({ action: "stonecut", recipe: "stonecutter.stone_slab" })).toBe("string");
    expect(typeof screenActParams({ action: "stonecut", recipe: -1 })).toBe("string");
    expect(typeof screenActParams({ action: "stonecut", recipe: 256 })).toBe("string");
    expect(typeof screenActParams({ action: "stonecut" })).toBe("string");
    expect(typeof screenActParams({ action: "craft", recipe: 2 })).toBe("string");
    expect(screenActParams({ action: "anvil", name: "Pick" })).toEqual({ action: "anvil", name: "Pick" });
    expect(screenActParams({ action: "anvil", name: "" })).toEqual({ action: "anvil", name: "" });
    expect(screenActParams({ action: "anvil" })).toEqual({ action: "anvil" });
    expect(screenActParams({ action: "grindstone" })).toEqual({ action: "grindstone" });
    expect(screenActParams({ action: "smithing" })).toEqual({ action: "smithing" });
    expect(screenActParams({ action: "cartography" })).toEqual({ action: "cartography" });
    expect(screenActParams({ action: "take_result" })).toEqual({ action: "take_result" });

    expect(screenActParams({ action: "loom", pattern: "crest" })).toEqual({ action: "loom", pattern: "crest" });
    expect(typeof screenActParams({ action: "loom" })).toBe("string");
    expect(screenActParams({ action: "enchant", option: 2 })).toEqual({ action: "enchant", option: 2 });
    expect(typeof screenActParams({ action: "enchant", option: 3 })).toBe("string");
    expect(typeof screenActParams({ action: "enchant" })).toBe("string");
    expect(screenActParams({ action: "trade", offer: 0, times: 5 })).toEqual({ action: "trade", offer: 0, times: 5 });
    expect(typeof screenActParams({ action: "trade" })).toBe("string");
    expect(screenActParams({ action: "beacon", beaconPrimary: "minecraft:speed", beaconSecondary: "minecraft:haste" })).toEqual({
      action: "beacon",
      primary: "minecraft:speed",
      secondary: "minecraft:haste",
    });
    expect(typeof screenActParams({ action: "beacon" })).toBe("string");
    expect(typeof screenActParams({ action: "fly" as never })).toBe("string");
  });
});

describe("typed calls", () => {
  it("uses a block and an entity through their own methods", async () => {
    const { session, calls } = recording({
      "interact.block": { screen: "chest_screen", changed: true },
      "interact.entity": { screen: "trade_screen", changed: true },
    });
    const block = await interactBlock({ x: 4, y: 64, z: -2, face: "up" }, session);
    expect(block.ok && block.value.screen).toBe("chest_screen");
    expect(calls[0]).toEqual({ method: "interact.block", params: { x: 4, y: 64, z: -2, face: "up" } });
    const entity = await interactEntity("1234", session);
    expect(entity.ok && entity.value.target).toBe("entity");
    expect(calls[1]).toEqual({ method: "interact.entity", params: { id: "1234" } });
  });

  it("refuses a bad position and a bad id before anything reaches the agent", async () => {
    const { session, calls } = recording();
    const block = await interactBlock({ x: 0.5, y: 64, z: 0 }, session);
    expect(!block.ok && block.reason).toBe("invalid_params");
    const entity = await interactEntity("the villager", session);
    expect(!entity.ok && entity.reason).toBe("invalid_params");
    expect(calls).toHaveLength(0);
  });

  it("reads the open screen", async () => {
    const { session, calls } = recording({
      "screen.state": { screen: "furnace_screen", kind: "furnace", containers: { container: [slot("minecraft:iron_ore")] }, data: { burn: 0.5, cook: 0.25 } },
    });
    const result = await screenState(session);
    expect(result.ok && result.value.kind).toBe("furnace");
    expect(result.ok && result.value.data?.cook).toBe(0.25);
    expect(calls[0]?.method).toBe("screen.state");
  });

  it("moves items and reports the count the agent did not send", async () => {
    const { session, calls } = recording({ "screen.move": {} });
    const result = await screenMove({ from: { container: "container", slot: 3 }, to: { container: "player", slot: 0 }, count: 4 }, session);
    expect(result.ok && result.value.moved).toBe(4);
    expect(calls[0]?.params).toEqual({ from: { container: "container", slot: 3 }, to: { container: "player", slot: 0 }, count: 4 });
  });

  it("keeps a move that moved nothing at zero rather than the count asked for", async () => {
    const { session } = recording({ "screen.move": { moved: 0 } });
    const result = await screenMove({ from: { container: "container", slot: 0 }, to: { container: "player", slot: 0 } }, session);
    expect(result.ok && result.value.moved).toBe(0);
  });

  it("runs a screen action as the screen's own request", async () => {
    const { session, calls } = recording({
      "screen.act": { done: true, result: slot("minecraft:oak_planks", 4), consumed: [slot("minecraft:oak_log")], xpCost: 0 },
    });
    const result = await screenAct({ action: "craft", recipe: "minecraft:planks", times: 2 }, session);
    expect(result.ok && result.value.done).toBe(true);
    expect(result.ok && result.value.result).toEqual({ item: "minecraft:oak_planks", count: 4, enchantments: [] });
    expect(calls[0]).toEqual({ method: "screen.act", params: { action: "craft", recipe: "minecraft:planks", times: 2 } });
  });

  it("closes the screen", async () => {
    const { session, calls } = recording({ "screen.close": { closed: true } });
    const result = await screenClose(session);
    expect(result.ok && result.value.closed).toBe(true);
    expect(calls[0]?.method).toBe("screen.close");
  });

  it("passes an agent failure through and refuses an answer it cannot read", async () => {
    const older = await screenState(recording().session);
    expect(!older.ok && older.reason).toBe("unknown_method");
    const wrong = await screenClose(recording({ "screen.close": "yes" }).session);
    expect(!wrong.ok && wrong.reason).toBe("protocol");
  });
});

describe("the screen tool", () => {
  type Handler = (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;
  interface Tool {
    config: { inputSchema: z.ZodRawShape; outputSchema: z.ZodRawShape };
    handler: Handler;
  }
  const screenTool = (): Tool => {
    const tools = new Map<string, Tool>();
    const server = { registerTool: (name: string, config: Tool["config"], handler: Handler) => void tools.set(name, { config, handler }) };
    registerWorkstationTools(server as unknown as McpServer);
    const tool = tools.get("screen");
    if (!tool) throw new Error("no screen tool");
    return tool;
  };

  afterEach(() => vi.restoreAllMocks());

  it("takes a stonecutter recipe index and a craft recipe id, and sends the index as a number", async () => {
    const tool = screenTool();
    const input = z.object(tool.config.inputSchema).strict();
    expect(input.parse({ action: "act", act: "stonecut", recipe: 2 }).recipe).toBe(2);
    expect(input.parse({ action: "act", act: "craft", recipe: "minecraft:planks" }).recipe).toBe("minecraft:planks");
    expect(input.safeParse({ action: "act", act: "stonecut", recipe: -1 }).success).toBe(false);
    expect(input.safeParse({ action: "act", act: "stonecut", recipe: 1.5 }).success).toBe(false);

    const call = vi.spyOn(engine, "call").mockResolvedValue({
      ok: true,
      value: { done: true, result: slot("minecraft:stone_slab", 2), consumed: [slot("minecraft:stone")], reason: null },
    } as EngineResult<never>);
    const result = await tool.handler(input.parse({ action: "act", act: "stonecut", recipe: 2 }));
    expect(result.isError).toBeFalsy();
    expect(call).toHaveBeenCalledWith("screen.act", { action: "stonecut", recipe: 2 });
    const out = z.object(tool.config.outputSchema).strict().parse(result.structuredContent);
    expect(out.result).toEqual({ item: "minecraft:stone_slab", count: 2, enchantments: [] });
  });
});

describe("text for tool results", () => {
  it("says what an interaction opened", () => {
    expect(interactText({ target: "block", screen: "chest_screen", changed: true })).toBe("used the block: chest_screen opened");
    expect(interactText({ target: "entity", screen: null, changed: false })).toBe("used the entity: no screen opened, nothing changed");
    expect(interactText({ target: "block", screen: null, changed: true })).toBe("used the block: no screen opened, something changed");
  });

  it("describes a screen: its family, what its containers hold and its own data", () => {
    const chest = parseScreenState({
      screen: "chest_screen",
      kind: "chest",
      containers: { container: [slot("minecraft:coal", 9), null], player: [null] },
    });
    expect(chest && screenStateText(chest)).toBe("chest_screen (chest): container 1/2, player 0/1");
    const anvil = parseScreenState({
      screen: "anvil_screen",
      kind: "anvil",
      data: { result: slot("minecraft:iron_pickaxe"), xpCost: 5, tooExpensive: false, name: "Pick" },
    });
    expect(anvil && screenStateText(anvil)).toBe('anvil_screen (anvil): result minecraft:iron_pickaxe x1, 5 level(s), name "Pick"');
    const trade = parseScreenState({
      screen: "trade_screen",
      kind: "trade",
      data: { offers: [{ index: 0, buyA: slot("minecraft:wheat", 20), buyB: null, sell: slot("minecraft:emerald"), uses: 0, maxUses: 16, locked: false, netId: 1 }], selected: -1, trader: "12" },
    });
    expect(trade && screenStateText(trade)).toBe("trade_screen (trade): 1 offer(s), selected none, trader 12");
    const furnace = parseScreenState({ screen: "furnace_screen", kind: "furnace", data: { burn: 0.75, cook: null } });
    expect(furnace && screenStateText(furnace)).toBe("furnace_screen (furnace): burn 75%, cook ?");
    const enchanting = parseScreenState({
      screen: "enchanting_screen",
      kind: "enchanting_table",
      data: { options: [{ option: 0, cost: 1, hint: "efficiency", level: 1, lapis: 1, levelsTaken: 1, enchants: [], netId: 9 }] },
    });
    expect(enchanting && screenStateText(enchanting)).toBe("enchanting_screen (enchanting_table): options 1 (1 lapis) efficiency");
    const beacon = parseScreenState({ screen: "beacon_screen", kind: "beacon", data: { primary: "speed", secondary: null } });
    expect(beacon && screenStateText(beacon)).toBe("beacon_screen (beacon): primary speed, secondary none");
    const unavailable = parseScreenState({ screen: "loom_screen", kind: "loom", data: { unavailable: "no loom controller", anchor: "screen.loom" } });
    expect(unavailable && screenStateText(unavailable)).toBe("loom_screen (loom): data unavailable: no loom controller (screen.loom)");
    const tooExpensive = parseScreenState({ screen: "anvil_screen", kind: "anvil", data: { result: null, xpCost: 41, tooExpensive: true, name: "" } });
    expect(tooExpensive && screenStateText(tooExpensive)).toBe("anvil_screen (anvil): result empty, 41 level(s) (too expensive), name (empty)");
  });

  it("says what an act did, and why it was refused", () => {
    expect(
      screenActText({
        done: true,
        result: { item: "minecraft:oak_planks", count: 4, enchantments: [] },
        consumed: [{ item: "minecraft:oak_log", count: 1, enchantments: [] }],
        xpCost: 3,
      }),
    ).toBe("done minecraft:oak_planks x4, 1 stack(s) consumed, 3 level(s)");
    expect(screenActText({ done: false, result: null, consumed: [], reason: "no recipe" })).toBe("refused: no recipe");
    expect(screenActText({ done: false, result: null, consumed: [] })).toBe("refused");
  });
});
