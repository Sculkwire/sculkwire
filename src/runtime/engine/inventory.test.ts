/**
 * The inventory module's parsing and routing: what a slot, an inventory, an attribute, a container and a craft answer
 * become before anything is trusted, and which route answers when no agent is attached.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScriptRoute } from "./deps.ts";
import { EngineSession } from "./engine.ts";
import type { EngineResult } from "./failure.ts";
import {
  craftMatchParams,
  parseAttributes,
  parseContainer,
  parseCraftGrid,
  parseCraftMatch,
  parseInventory,
  parseOpenContainer,
  readContainer,
  readPlayerInventory,
  normalizeGrid,
  craftRun,
} from "./inventory.ts";

/** The helper pack's query, as `src/features.ts` hands it in. */
const query = vi.fn<ScriptRoute["query"]>();

const slot = (item: string, count = 1) => ({ item, count });

/** A session that answers exactly the methods in `values` and reports anything else as an older agent. */
function answered(values: Record<string, unknown>): EngineSession {
  const session = new EngineSession({ port: 9, timeoutMs: 100 });
  session.call = async <T>(method: string): Promise<EngineResult<T>> =>
    method in values
      ? { ok: true, value: values[method] as T }
      : { ok: false, code: -32601, reason: "unknown_method", message: `no ${method}` };
  return session;
}

/** A session with no agent listening. */
function detached(): EngineSession {
  const session = new EngineSession({ port: 9, timeoutMs: 100 });
  session.call = async () => ({ ok: false, code: -32000, reason: "not_attached", message: "no agent is listening" });
  return session;
}

beforeEach(() => {
  query.mockReset();
});

describe("parseInventory", () => {
  it("fills the slots an answer leaves out", () => {
    // The game's 0-based index becomes the hotbar slot 1 to 9 player_state reports.
    expect(parseInventory({ selectedSlot: 2, hotbar: [null], inventory: [] })).toEqual({
      selectedSlot: 3,
      hotbar: [null],
      inventory: [],
      armor: { head: null, chest: null, legs: null, feet: null },
      offhand: null,
      cursor: null,
    });
  });

  it("rejects an answer without the slot arrays", () => {
    expect(parseInventory({ selectedSlot: 0 })).toBeUndefined();
    expect(parseInventory({ selectedSlot: -1, hotbar: [], inventory: [] })).toBeUndefined();
  });
});

describe("parseAttributes", () => {
  it("keeps the bounds the game reports and the bare current value the Script API has", () => {
    expect(parseAttributes({ health: { current: 20, min: 0, max: 20, default: 20 }, armor: { current: 7 } })).toEqual({
      health: { current: 20, min: 0, max: 20, default: 20 },
      armor: { current: 7 },
    });
  });

  it("rejects an attribute without a current value", () => {
    expect(parseAttributes({ health: { max: 20 } })).toBeUndefined();
  });

  it("takes the agent's derived armour numbers as current values, its base value, and drops a null", () => {
    expect(
      parseAttributes({
        "minecraft:movement": { current: 0.13, min: 0, max: 3.4e38, default: 0.1, base: 0.1 },
        armor: 20,
        armorToughness: null,
      }),
    ).toEqual({
      "minecraft:movement": { current: 0.13, min: 0, max: 3.4e38, default: 0.1, base: 0.1 },
      armor: { current: 20 },
    });
  });
});

describe("parseContainer", () => {
  it("makes the slot list exactly as long as the container", () => {
    const view = parseContainer({ block: "chest", size: 3, slots: [slot("minecraft:stone", 2)] });
    expect(view).toEqual({
      block: "minecraft:chest",
      size: 3,
      slots: [{ item: "minecraft:stone", count: 2, enchantments: [] }, null, null],
    });
    expect(parseContainer({ block: "minecraft:chest", size: 1, slots: [slot("a"), slot("b")] })?.slots).toHaveLength(1);
  });

  it("takes its size from the slot list when the answer has none", () => {
    expect(parseContainer({ slots: [null, slot("minecraft:dirt")] })).toEqual({
      block: null,
      size: 2,
      slots: [null, { item: "minecraft:dirt", count: 1, enchantments: [] }],
    });
  });
});

describe("parseOpenContainer", () => {
  it("reads the block's position as x, y, z and keeps null for an entity's screen", () => {
    const open = parseOpenContainer({ screen: "small_chest_screen", block: "minecraft:chest", position: [2, -60, 1], slots: [], playerSlots: [] });
    expect(open).toEqual({ screen: "small_chest_screen", block: "minecraft:chest", position: { x: 2, y: -60, z: 1 }, slots: [], playerSlots: [] });
    expect(parseOpenContainer({ screen: "horse_screen", block: null, position: null, slots: [], playerSlots: [] })?.position).toBeNull();
  });
});

describe("craft", () => {
  it("pads a 2x2 grid to the 3x3 the engine takes", () => {
    expect(normalizeGrid([["oak_planks", "oak_planks"], ["oak_planks", null]])).toEqual([
      ["minecraft:oak_planks", "minecraft:oak_planks", null],
      ["minecraft:oak_planks", null, null],
      [null, null, null],
    ]);
  });

  it("rejects a grid larger than 3 by 3", () => {
    expect(normalizeGrid([[null, null, null, null]])).toBeUndefined();
    expect(normalizeGrid([[], [], [], []])).toBeUndefined();
  });

  it("reads a --grid argument with ; or / rows and - for an empty cell", () => {
    expect(parseCraftGrid("oak_planks,oak_planks,-;oak_planks,oak_planks")).toEqual([
      ["minecraft:oak_planks", "minecraft:oak_planks", null],
      ["minecraft:oak_planks", "minecraft:oak_planks", null],
      [null, null, null],
    ]);
    expect(parseCraftGrid("stone/stone/stone")?.[0]).toEqual(["minecraft:stone", null, null]);
  });

  it("takes exactly one of grid and ingredients", () => {
    expect(craftMatchParams({ grid: [["stone"]], ingredients: ["stone"] })).toBe("give exactly one of grid or ingredients");
    expect(craftMatchParams({})).toBe("give exactly one of grid or ingredients");
    expect(craftMatchParams({ ingredients: ["oak_log", "oak_log"] })).toEqual({
      ingredients: ["minecraft:oak_log", "minecraft:oak_log"],
    });
    expect(craftMatchParams({ grid: [["stone"]], table: true })).toHaveProperty("table", true);
  });

  it("keeps a null result: nothing matching is an answer, a missing result is not", () => {
    expect(parseCraftMatch({ result: null, recipe: null })).toEqual({ result: null, recipe: null });
    expect(parseCraftMatch({ recipe: null })).toBeUndefined();
    expect(parseCraftMatch({ result: slot("oak_planks", 4), recipe: { id: "planks", type: "shaped", tag: "crafting_table" } })).toEqual({
      result: { item: "minecraft:oak_planks", count: 4, enchantments: [] },
      recipe: { id: "planks", type: "shaped", tag: "minecraft:crafting_table" },
    });
  });

  it("refuses a times value outside 1 to 1000 before it reaches the agent", async () => {
    const result = await craftRun("planks", 0, detached());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("invalid_params");
  });
});

describe("routes", () => {
  it("reads the agent's own attributes and inventory", async () => {
    const session = answered({
      "player.inventory": { selectedSlot: 1, hotbar: [slot("minecraft:torch", 12)], inventory: [] },
      "player.attributes": { health: { current: 20, min: 0, max: 20, default: 20 } },
    });
    const result = await readPlayerInventory(query, session);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.source).toBe("engine");
    expect(result.ok && result.value.inventory.selectedSlot).toBe(2);
    expect(result.ok && result.value.inventory.hotbar[0]).toEqual({ item: "minecraft:torch", count: 12, enchantments: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it("falls back to the helper pack without an agent and says so", async () => {
    query.mockResolvedValue({
      attributes: { health: { current: 14 } },
      inventory: { selectedSlot: 0, hotbar: [slot("minecraft:bread", 2)], inventory: [] },
    });
    const result = await readPlayerInventory(query, detached());
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.source).toBe("script");
    expect(result.ok && result.value.inventory.selectedSlot).toBe(1);
    expect(result.ok && result.value.attributes.health?.current).toBe(14);
    expect(query).toHaveBeenCalledWith("inventory");
  });

  it("keeps an agent failure that the helper pack cannot answer", async () => {
    const session = new EngineSession({ port: 9, timeoutMs: 100 });
    session.call = async () => ({ ok: false, code: -32002, reason: "not_in_world", message: "no world is loaded" });
    const result = await readPlayerInventory(query, session);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("not_in_world");
    expect(query).not.toHaveBeenCalled();
  });

  it("names both routes when no agent is listening and the helper pack is not running either", async () => {
    query.mockRejectedValue(new Error("the game is not running"));
    const result = await readPlayerInventory(query, detached());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("not_attached");
    expect(!result.ok && result.message).toContain("the game is not running");
    expect(!result.ok && result.message).toContain("no agent is listening");
  });

  it("takes the helper pack when the agent this session attached is gone, and says why", async () => {
    // What EngineSession returns once an attached agent is unloaded or the game restarted: the reconnect is refused.
    const gone = (): EngineSession => {
      const session = new EngineSession({ port: 9, timeoutMs: 100 });
      session.call = async () => ({ ok: false, code: -32000, reason: "disconnected", message: "cannot connect to agent on 127.0.0.1:9: connect ECONNREFUSED 127.0.0.1:9" });
      return session;
    };
    query.mockResolvedValue({ attributes: {}, inventory: { selectedSlot: 0, hotbar: [], inventory: [] } });
    const inventory = await readPlayerInventory(query, gone());
    expect(inventory.ok && inventory.value.source).toBe("script");
    expect(inventory.ok && inventory.value.note).toMatch(/agent did not answer \(disconnected: .*ECONNREFUSED.*\); answered from the helper pack/);

    query.mockResolvedValue({ block: "minecraft:chest", size: 1, slots: [null] });
    const container = await readContainer({ x: 1, y: 64, z: -2 }, query, gone());
    expect(container.ok && container.value.block).toBe("minecraft:chest");
    expect(container.ok && container.value.note).toMatch(/disconnected/);

    // Neither route answers: the agent's reason stays.
    query.mockRejectedValue(new Error("the game is not running"));
    const failed = await readPlayerInventory(query, gone());
    expect(!failed.ok && failed.reason).toBe("disconnected");
    expect(!failed.ok && failed.message).toContain("ECONNREFUSED");
  });

  it("reads a container from the agent, and from the helper pack without one", async () => {
    const fromAgent = await readContainer(
      { x: 1, y: 64, z: -2 },
      query,
      answered({ "container.get": { block: "minecraft:barrel", size: 1, slots: [slot("minecraft:coal", 9)] } }),
    );
    expect(fromAgent.ok && fromAgent.value.block).toBe("minecraft:barrel");
    expect(fromAgent.ok && fromAgent.value.slots[0]).toEqual({ item: "minecraft:coal", count: 9, enchantments: [] });

    query.mockResolvedValue({ block: "minecraft:chest", size: 2, slots: [null, slot("minecraft:dirt", 3)] });
    const fromScript = await readContainer({ x: 1, y: 64, z: -2 }, query, detached());
    expect(fromScript.ok && fromScript.value.block).toBe("minecraft:chest");
    expect(query).toHaveBeenCalledWith("container", { x: 1, y: 64, z: -2 });
  });

  it("turns a block without a container into invalid_params, as the agent reports it", async () => {
    query.mockRejectedValue(Object.assign(new Error("helper: minecraft:stone at 4 64 -2 has no container"), { reason: "no_container" }));
    const result = await readContainer({ x: 4, y: 64, z: -2 }, query, detached());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("invalid_params");
    expect(!result.ok && result.code).toBe(-32602);
  });

  it("refuses a fractional block position before it reaches the agent", async () => {
    const result = await readContainer({ x: 1.5, y: 64, z: 0 }, query, detached());
    expect(!result.ok && result.reason).toBe("invalid_params");
  });

  it("sends the dimension as the bare name the agent and the helper pack take, whichever spelling was given", async () => {
    for (const dimension of ["nether", "minecraft:nether", 1, " Minecraft:Nether "]) {
      const session = answered({ "container.get": { block: "minecraft:barrel", size: 0, slots: [] } });
      const call = vi.spyOn(session, "call");
      await readContainer({ x: 1, y: 64, z: -2, dimension }, query, session);
      expect(call.mock.calls[0]?.[1]).toEqual({ x: 1, y: 64, z: -2, dimension: "nether" });
    }
    query.mockResolvedValue({ block: "minecraft:chest", size: 0, slots: [] });
    await readContainer({ x: 1, y: 64, z: -2, dimension: "minecraft:the_end" }, query, detached());
    expect(query).toHaveBeenCalledWith("container", { x: 1, y: 64, z: -2, dimension: "the_end" });
  });

  it("refuses a dimension the agent does not know instead of reading the overworld", async () => {
    for (const dimension of ["minecraft:aether", 3]) {
      const result = await readContainer({ x: 1, y: 64, z: -2, dimension }, query, detached());
      expect(!result.ok && result.reason).toBe("invalid_params");
    }
  });
});
