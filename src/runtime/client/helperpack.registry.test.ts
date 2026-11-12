/**
 * `game_registry`: the `/connect` data request first, the helper pack's Script API registries when /connect is
 * missing or answers nothing (the retail client answers `[]`), paged through the helper's `registry` query.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryEvent, replyIn, runHelperScript } from "../../testing/helperpack.ts";
import { readRegistry } from "./bridge.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `minecraft:${prefix}_${String(i).padStart(4, "0")}`);

/** The helper script with fake Script API registries; returns its query function (one reply print per call). */
function loadHelper(registries: { block: string[]; item: string[]; mob: string[] }) {
  type Handler = (ev: { id: string; message: string }) => void;
  let onQuery: Handler | undefined;
  const on = { subscribe: () => undefined };
  const world = { getAllPlayers: () => [], afterEvents: new Proxy({}, { get: () => on }) };
  const system = {
    currentTick: 1,
    run: () => 0,
    runInterval: () => 1,
    clearRun: () => undefined,
    afterEvents: { scriptEventReceive: { subscribe: (h: Handler) => void (onQuery = h) } },
  };
  // The game hands out type objects (and, for entities, once an iterator), in no particular order.
  const types = (list: string[]) => ({ getAll: () => [...list].reverse().map((id) => ({ id })) });
  const lines = runHelperScript({
    BlockTypes: types(registries.block),
    BlockVolume: class {},
    EntityTypes: { getAll: () => types(registries.mob).getAll()[Symbol.iterator]() },
    ItemTypes: types(registries.item),
    system,
    world,
  });
  let id = 0;
  return async (params: Record<string, unknown>): Promise<unknown> => {
    const qid = ++id;
    onQuery?.(queryEvent(params, qid));
    const reply = replyIn(lines, qid);
    if (!reply) throw new Error("no reply");
    if (!reply.ok) throw new Error(reply.error);
    return reply.result;
  };
}

describe("helper registry query", () => {
  it("pages sorted ids of each registry", async () => {
    const query = loadHelper({ block: ids("block", 950), item: ids("item", 3), mob: ["minecraft:zombie", "minecraft:cow"] });
    const first = (await query({ kind: "registry", registry: "block", offset: 0 })) as { total: number; offset: number; ids: string[] };
    expect(first.total).toBe(950);
    expect(first.ids).toHaveLength(400);
    expect(first.ids[0]).toBe("minecraft:block_0000");
    const last = (await query({ kind: "registry", registry: "block", offset: 800 })) as { ids: string[] };
    expect(last.ids).toEqual(ids("block", 950).slice(800));
    expect(await query({ kind: "registry", registry: "mob" })).toEqual({ total: 2, offset: 0, ids: ["minecraft:cow", "minecraft:zombie"] });
    await expect(query({ kind: "registry", registry: "biome" })).rejects.toThrow(/block, item, mob/);
  });
});

describe("game_registry routing", () => {
  it("takes /connect's answer when it lists something", async () => {
    const script = vi.fn();
    const r = await readRegistry("item", { connect: async () => [{ id: "minecraft:apple" }], script });
    expect(r).toEqual({ kind: "item", source: "connect", entries: [{ id: "minecraft:apple" }] });
    expect(script).not.toHaveBeenCalled();
  });

  it("falls back to the helper pack when /connect answers an empty list, reading every page", async () => {
    const query = loadHelper({ block: ids("block", 950), item: [], mob: [] });
    const offsets: number[] = [];
    const r = await readRegistry("block", {
      connect: async () => [],
      script: (offset) => {
        offsets.push(offset);
        return query({ kind: "registry", registry: "block", offset });
      },
    });
    expect(r.source).toBe("script");
    expect(r.entries).toEqual(ids("block", 950));
    expect(offsets).toEqual([0, 400, 800]);
    expect(r.note).toBe("/connect answered data:block with an empty list");
  });

  it("uses the helper pack without /connect, and when /connect fails", async () => {
    const query = loadHelper({ block: [], item: [], mob: ["minecraft:pig"] });
    const script = (offset: number) => query({ kind: "registry", registry: "mob", offset });
    expect(await readRegistry("mob", { script })).toEqual({ kind: "mob", source: "script", entries: ["minecraft:pig"], note: "no /connect client attached" });
    const failed = await readRegistry("mob", { connect: async () => Promise.reject(new Error("timed out")), script });
    expect(failed).toMatchObject({ source: "script", note: "/connect data:mob failed: timed out" });
  });

  it("says why when neither route answers", async () => {
    await expect(readRegistry("item", { connect: async () => [] })).rejects.toThrow(
      "/connect answered data:item with an empty list, and the helper pack's registry query needs the script debugger",
    );
    await expect(readRegistry("item", { script: async () => ({ nope: 1 }) })).rejects.toThrow(/registry query failed: malformed helper registry page/);
  });
});
