import { describe, expect, it } from "vitest";
import type { EntityInfo } from "../types.ts";
import { arenaOrigin } from "./arena.ts";
import { claimSpawned, countKills } from "./spawns.ts";

describe("spawned mobs", () => {
  const o = arenaOrigin(0);
  const at = (x: { dx: number; dy: number; dz: number }) => ({ x: o.x + x.dx, y: o.y + x.dy, z: o.z + x.dz });
  const spawns = [
    { type: "husk", at: { dx: -1, dy: 0, dz: 10 } },
    { type: "husk", at: { dx: 0, dy: 0, dz: 10 } },
    { type: "husk", at: { dx: 1, dy: 0, dz: 10 } },
  ];
  const ent = (id: string, dx: number, typeId = "minecraft:husk") => ({ id, typeId, location: { x: o.x + dx + 0.5, y: o.y, z: o.z + 10.5 } }) as EntityInfo;
  it("claims the nearest unclaimed entity per spawn, keeping what earlier polls found", () => {
    const first = claimSpawned(spawns, at, [ent("b", 0), ent("z", -1, "minecraft:zombie")], [undefined, undefined, undefined]);
    // One husk so far: the first spawn takes it, the others wait for the next poll.
    expect(first).toEqual([{ id: "b", typeId: "minecraft:husk" }, undefined, undefined]);
    const second = claimSpawned(spawns, at, [ent("b", 0), ent("a", -1), ent("c", 1)], first);
    expect(second.map((m) => m?.id)).toEqual(["b", "a", "c"]);
  });
  it("counts kills by id, and a never-seen spawn by a player kill of its type, at most one each", () => {
    const found = [{ id: "a", typeId: "minecraft:husk" }, undefined, undefined];
    const deaths = [
      { tick: 1, id: "a", typeId: "minecraft:husk", killer: "minecraft:player" },
      { tick: 2, id: "x", typeId: "minecraft:husk", killer: "minecraft:player" },
      { tick: 3, id: "y", typeId: "minecraft:husk", killer: "minecraft:zombie" },
      { tick: 4, id: "z", typeId: "minecraft:zombie", killer: "minecraft:player" },
    ];
    expect(countKills(spawns, found, deaths)).toEqual({ resolved: 1, unresolved: 1 });
    const extra = [...deaths, { tick: 5, id: "w", typeId: "minecraft:husk", killer: "minecraft:player" }, { tick: 6, id: "v", typeId: "minecraft:husk", killer: "minecraft:player" }];
    expect(countKills(spawns, found, extra)).toEqual({ resolved: 1, unresolved: 2 });
    // Every spawn resolved: other player kills of the type do not count.
    expect(countKills(spawns, [found[0], { id: "b", typeId: "minecraft:husk" }, { id: "c", typeId: "minecraft:husk" }], extra)).toEqual({ resolved: 1, unresolved: 0 });
  });
});
