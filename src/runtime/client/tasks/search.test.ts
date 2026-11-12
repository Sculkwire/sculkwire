import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeTaskWorld, runFakeStep as run, shapedRecipe } from "../../../testing/fakeworld.ts";
import { findBlocks, findEntities, ringCubes } from "./search.ts";

const TABLE = "minecraft:crafting_table";

const SWORD = shapedRecipe("test:sword", ["X", "X", "#"], { X: { item: "minecraft:iron_ingot" }, "#": { item: "minecraft:stick" } }, { item: "minecraft:iron_sword" });

const world = () => fakeTaskWorld([SWORD]);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ringCubes", () => {
  it("tiles the ring around the player nearest first, the four sides before the corners", () => {
    const ring = ringCubes({ x: 0.5, y: 64, z: 0.5 }, 16, 48);
    expect(ring).toHaveLength(8);
    expect(ring.map((c) => c.near)).toEqual([...ring.map((c) => c.near)].sort((a, b) => a - b));
    for (const c of ring.slice(0, 4)) expect(c.center.x === 0 || c.center.z === 0).toBe(true);
    for (const c of ring.slice(4)) expect(Math.abs(c.center.x)).toBe(33);
    expect(ring[0]?.center).toEqual({ x: 0, y: 64, z: 33 });
  });

  it("covers the rest of the player's own 16-block cube first when the first lookup was smaller", () => {
    const ring = ringCubes({ x: 0.5, y: 64, z: 0.5 }, 8, 48);
    expect(ring[0]).toEqual({ center: { x: 0, y: 64, z: 0 }, near: 0 });
    expect(ring).toHaveLength(9);
  });
});

describe("findBlocks", () => {
  it("asks no more cubes when the player's own cube has a match", async () => {
    const w = world();
    w.place("crafting_table", { x: 8, y: 64, z: 0 });
    const search = await findBlocks(w.env(), [TABLE]);
    expect(search.found.map((b) => b.location)).toEqual([{ x: 8, y: 64, z: 0 }]);
    expect(search.within).toBe("16 blocks");
    expect(w.blockQueries).toEqual(["0,64,0"]);
  });

  it("goes on around the player and sorts what it finds by distance", async () => {
    const w = world();
    w.place("crafting_table", { x: 40, y: 64, z: 0 });
    w.place("crafting_table", { x: 0, y: 64, z: -30 });
    const search = await findBlocks(w.env(), [TABLE]);
    expect(search.found.map((b) => b.location)).toEqual([
      { x: 0, y: 64, z: -30 },
      { x: 40, y: 64, z: 0 },
    ]);
    expect(search.within).toBe(`48 blocks (searched ${w.blockQueries.length} cubes)`);
    // Each query's centre goes to the helper: the player's cube, then the ring.
    expect(w.blockQueries[0]).toBe("0,64,0");
    expect(w.blockQueries.slice(1, 5).sort()).toEqual(["-33,64,0", "0,64,-33", "0,64,33", "33,64,0"]);
  });

  it("stops once no cube left can hold a nearer block", async () => {
    const w = world();
    w.place("crafting_table", { x: 18, y: 64, z: 0 });
    const search = await findBlocks(w.env(), [TABLE]);
    expect(search.found).toHaveLength(1);
    // The four side cubes start 16.5 to 17.5 blocks away, the corners 23 or more: past the table at 18.
    expect(w.blockQueries).toHaveLength(5);
  });

  it("keeps to the cap of cubes and skips cubes whose chunk is not loaded", async () => {
    const w = world();
    const capped = await findBlocks(w.env(), [TABLE], { maxCubes: 3 });
    expect(capped.found).toEqual([]);
    expect(w.blockQueries).toHaveLength(3);
    expect(capped.within).toBe("48 blocks (searched 3 cubes)");
    w.blockQueries = [];
    w.loaded = (at) => at.x < 20;
    await findBlocks(w.env(), [TABLE]);
    expect(w.blockQueries.some((c) => c.startsWith("33,"))).toBe(false);
    expect(w.blockQueries).toHaveLength(6);
  });

  it("leaves out blocks of a ring cube beyond the reach", async () => {
    const w = world();
    w.place("crafting_table", { x: 47, y: 64, z: 47 });
    const search = await findBlocks(w.env(), [TABLE]);
    expect(search.found).toEqual([]);
  });

  it("queries one cube for every type at once", async () => {
    const w = world();
    w.place("chest", { x: 30, y: 64, z: 0 });
    w.place("barrel", { x: -30, y: 64, z: 0 });
    const search = await findBlocks(w.env(), ["minecraft:chest", "minecraft:barrel"]);
    expect(search.found.map((b) => b.typeId)).toEqual(["minecraft:chest", "minecraft:barrel"]);
    expect(w.blockQueries).toHaveLength(9);
  });
});

describe("findEntities", () => {
  it("asks once more with the reach when none is within the radius", async () => {
    const w = world();
    w.villager("-7", { x: 30, y: 64, z: 0 }, []);
    const env = w.env();
    const search = await findEntities(env, ["minecraft:villager_v2"]);
    expect(search.found.map((e) => e.id)).toEqual(["-7"]);
    expect(search).toMatchObject({ within: "48 blocks", queries: 2 });
    w.villager("-8", { x: 5, y: 64, z: 0 }, []);
    expect(await findEntities(env, ["minecraft:villager_v2"])).toMatchObject({ within: "16 blocks", queries: 1 });
  });
});

describe("task lookups beyond the first cube", () => {
  it("walks to a crafting table 30 blocks away and crafts there", async () => {
    const w = world();
    w.give("iron_ingot", 2);
    w.give("stick", 1);
    w.place("crafting_table", { x: 30, y: 64, z: 0 });
    const result = await run(w, { kind: "craft", item: "iron sword" });
    expect(result.ok).toBe(true);
    expect(result.actions).toContain("walked to the crafting_table at 30 64 0");
  });

  it("says how far it searched when nothing is found", async () => {
    const w = world();
    w.give("iron_ingot", 2);
    w.give("stick", 1);
    const craft = await run(w, { kind: "craft", item: "iron sword" });
    expect(craft.reason).toBe("no_station");
    expect(craft.message).toBe("no crafting table within 48 blocks (searched 9 cubes) (asked for minecraft:crafting_table)");
    const reach = await run(w, { kind: "reach_block", block: "minecraft:crafting_table" });
    expect(reach.reason).toBe("not_found");
    expect(reach.message).toBe("no crafting_table within 48 blocks (searched 9 cubes) (asked for minecraft:crafting_table)");
  });
});
