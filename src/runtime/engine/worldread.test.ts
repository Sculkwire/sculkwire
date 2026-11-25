/**
 * What the agent's world reads (`world.entities`, `world.block`, `world.blocks`) and its content-log ring (`log.content`)
 * become before anything trusts them, and what the client sends for them.
 */
import { describe, expect, it } from "vitest";
import { EngineSession } from "./engine.ts";
import type { EngineResult } from "./failure.ts";
import { contentLog, contentLogText, parseBlock, parseContentLog, parseEntities, worldBlock, worldBlocks, worldEntities } from "./worldread.ts";

/** A session that records what it was asked and answers `value`. */
function recording(value: unknown): { session: EngineSession; calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  const session = new EngineSession({ port: 9, timeoutMs: 100 });
  session.call = async <T>(method: string, params?: unknown): Promise<EngineResult<T>> => {
    calls.push({ method, params });
    return { ok: true, value: value as T };
  };
  return { session, calls };
}

describe("world.entities answers", () => {
  it("keeps the helper's fields and rounds positions to two decimals", () => {
    const parsed = parseEntities([
      {
        id: "-4294967295",
        typeId: "minecraft:pig",
        location: { x: 1.23456, y: -60, z: 2.005 },
        dimension: "minecraft:overworld",
        velocity: { x: 0, y: -0.0784, z: 0 },
        health: { current: 10, max: 10 },
      },
    ]);
    expect(parsed).toEqual([
      {
        id: "-4294967295",
        typeId: "minecraft:pig",
        location: { x: 1.23, y: -60, z: 2.01 },
        dimension: "minecraft:overworld",
        velocity: { x: 0, y: -0.08, z: 0 },
        health: { current: 10, max: 10 },
      },
    ]);
  });

  it("keeps a type the agent could not read as null instead of dropping the entity", () => {
    expect(parseEntities([{ id: "12", typeId: null, location: { x: 0, y: 1, z: 0 }, dimension: null }])).toEqual([
      { id: "12", typeId: null, location: { x: 0, y: 1, z: 0 }, dimension: null },
    ]);
  });

  it("refuses an answer whose id or position is not one", () => {
    expect(parseEntities([{ id: 12, location: { x: 0, y: 1, z: 0 } }])).toBeUndefined();
    expect(parseEntities([{ id: "12", location: { x: null, y: 1, z: 0 } }])).toBeUndefined();
    expect(parseEntities({})).toBeUndefined();
  });

  it("sends the point only with all three coordinates and the dimension as its bare name", async () => {
    const { session, calls } = recording([]);
    expect(await worldEntities({ x: 1, y: 2, z: 3, radius: 8, type: "pig", dimension: "minecraft:nether" }, session)).toEqual({ ok: true, value: [] });
    expect(calls).toEqual([{ method: "world.entities", params: { x: 1, y: 2, z: 3, radius: 8, type: "pig", dimension: "nether" } }]);
    const partial = await worldEntities({ x: 1 }, session);
    expect(partial.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("world.block and world.blocks answers", () => {
  it("keeps states and drops values that are not state values", () => {
    expect(parseBlock({ typeId: "minecraft:lever", location: { x: 1, y: 2, z: 3 }, states: { open_bit: true, lever_direction: "north", nested: {} } })).toEqual({
      typeId: "minecraft:lever",
      location: { x: 1, y: 2, z: 3 },
      states: { open_bit: true, lever_direction: "north" },
    });
  });

  it("answers null for a block in an unloaded chunk", async () => {
    const { session, calls } = recording(null);
    expect(await worldBlock({ x: 1, y: 2, z: 3, dimension: 1 }, session)).toEqual({ ok: true, value: null });
    expect(calls[0]).toEqual({ method: "world.block", params: { x: 1, y: 2, z: 3, dimension: "nether" } });
  });

  it("sends the type filters of a cube", async () => {
    const { session, calls } = recording([{ typeId: "minecraft:stone", location: { x: 0, y: 0, z: 0 } }]);
    const result = await worldBlocks({ radius: 2, types: ["stone", "dirt"] }, session);
    expect(result).toEqual({ ok: true, value: [{ typeId: "minecraft:stone", location: { x: 0, y: 0, z: 0 } }] });
    expect(calls[0]).toEqual({ method: "world.blocks", params: { radius: 2, types: ["stone", "dirt"] } });
  });
});

describe("log.content answers", () => {
  const page = {
    entries: [{ seq: 4, time: Date.UTC(2026, 0, 1, 12, 30, 5), area: "Scripting", level: "error", message: "boom" }],
    next: 4,
    dropped: 0,
    emitting: true,
    forced: false,
  };

  it("parses a page and sends the cursor", async () => {
    const { session, calls } = recording(page);
    expect(await contentLog(3, undefined, session)).toEqual({ ok: true, value: page });
    expect(calls[0]).toEqual({ method: "log.content", params: { since: 3 } });
  });

  it("refuses a page without a cursor", () => {
    expect(parseContentLog({ entries: [] })).toBeUndefined();
  });

  it("writes entries as content-log text, naming an unreadable area the way the game's file writer does", () => {
    expect(contentLogText(page.entries)).toBe("12:30:05[Scripting][error]-boom\n");
    expect(contentLogText([{ ...page.entries[0]!, area: null }])).toBe("12:30:05[unknown][error]-boom\n");
  });
});
