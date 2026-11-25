/**
 * `game_query` inspection kinds answered by the helper pack: `components`, `dynamic_properties`, `scores`, `raycast`
 * and `entity_properties`, plus the host's lookup of the property ids a project's entity file declares.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryEvent, replyIn, runHelperScript } from "../../testing/helperpack.ts";
import type { IndexedPack } from "../gamelog/logparse.ts";
import { declaredEntityProperties, entityPropertyIdsFor } from "./entityproperties.ts";

type Vec = { x: number; y: number; z: number };

afterEach(() => {
  vi.restoreAllMocks();
});

/** A component the way the game hands one out: values behind prototype getters, one of which may throw. */
function component(typeId: string, fields: Record<string, () => unknown>): unknown {
  const proto = { getValue: () => 1 };
  for (const [name, get] of Object.entries(fields)) Object.defineProperty(proto, name, { get, enumerable: false });
  const c = Object.create(proto) as Record<string, unknown>;
  Object.defineProperty(c, "typeId", { get: () => typeId });
  return c;
}

interface World {
  dynamic?: Record<string, unknown>;
  objectives?: { id: string; displayName: string; scores: { name: string; type: string; score: number; entityId?: string }[] }[];
  blockHit?: { block: string; at: Vec; face: string; faceLocation: Vec };
  rayEntities?: { id: string; typeId: string; distance: number }[];
}

function loadHelper(w: World = {}) {
  let onQuery: ((ev: { id: string; message: string }) => void) | undefined;
  const rays: { from: Vec; direction: Vec; options: Record<string, unknown> }[] = [];
  const zombie = {
    id: "-77",
    typeId: "test:zombie",
    isValid: true,
    getComponents: () => [
      component("minecraft:health", { currentValue: () => 14, effectiveMax: () => 20, defaultValue: () => 20 }),
      component("minecraft:movement", {
        currentValue: () => 0.23,
        effectiveMin: () => {
          throw new Error("not readable now");
        },
      }),
      component("minecraft:is_baby", {}),
    ],
    getProperty: (id: string) => ({ "test:phase": 2, "test:angry": false })[id],
    getDynamicPropertyIds: () => ["test:home"],
    getDynamicProperty: () => ({ x: 4, y: 70, z: -9 }),
    getDynamicPropertyTotalByteCount: () => 24,
  };
  const dim = {
    id: "minecraft:overworld",
    heightRange: { min: -64, max: 320 },
    getEntities: (opts: { type?: string }) => (opts.type === zombie.typeId ? [zombie] : []),
    getBlockFromRay: (from: Vec, direction: Vec, options: Record<string, unknown>) => {
      rays.push({ from, direction, options });
      const hit = w.blockHit;
      if (!hit) return undefined;
      return {
        block: { typeId: hit.block, location: hit.at, permutation: { getAllStates: () => ({}) } },
        face: hit.face,
        faceLocation: hit.faceLocation,
      };
    },
    getEntitiesFromRay: () => (w.rayEntities ?? []).map((e) => ({ distance: e.distance, entity: { id: e.id, typeId: e.typeId } })),
  };
  const player = {
    id: "-1",
    typeId: "minecraft:player",
    name: "Steve",
    location: { x: 0, y: 64, z: 0 },
    dimension: dim,
    getHeadLocation: () => ({ x: 0, y: 65.62, z: 0 }),
    getViewDirection: () => ({ x: 0, y: 0, z: 1 }),
  };
  const dynamic = w.dynamic ?? {};
  const objectives = (w.objectives ?? []).map((o) => ({
    id: o.id,
    displayName: o.displayName,
    getScores: () =>
      o.scores.map((s) => ({
        score: s.score,
        participant: { displayName: s.name, type: s.type, getEntity: () => (s.entityId ? { id: s.entityId } : undefined) },
      })),
  }));
  const afterEvents = new Proxy({}, { get: () => ({ subscribe: () => undefined }) });
  const fakeWorld = {
    getAllPlayers: () => [player],
    getDimension: () => dim,
    getEntity: (id: string) => (id === zombie.id ? zombie : undefined),
    getDynamicPropertyIds: () => Object.keys(dynamic),
    getDynamicProperty: (id: string) => dynamic[id],
    getDynamicPropertyTotalByteCount: () => 99,
    scoreboard: { getObjectives: () => objectives, getObjective: (id: string) => objectives.find((o) => o.id === id) },
    afterEvents,
  };
  const fakeSystem = {
    currentTick: 1,
    run: () => 0,
    runInterval: () => 1,
    clearRun: () => undefined,
    afterEvents: { scriptEventReceive: { subscribe: (h: typeof onQuery) => (onQuery = h) } },
  };
  const lines = runHelperScript({ BlockVolume: class {}, system: fakeSystem, world: fakeWorld });
  let id = 0;
  const query = async (params: Record<string, unknown>): Promise<unknown> => {
    const qid = ++id;
    onQuery?.(queryEvent(params, qid));
    const reply = replyIn(lines, qid);
    if (!reply) throw new Error("no reply");
    if (!reply.ok) throw new Error(reply.error);
    return reply.result;
  };
  return { query, rays };
}

describe("helper components query", () => {
  it("reads getter values, leaves out a field that throws and names it", async () => {
    const { query } = loadHelper();
    const r = (await query({ kind: "components", entity: "-77" })) as { typeId: string; components: unknown[] };
    expect(r.typeId).toBe("test:zombie");
    expect(r.components).toEqual([
      { typeId: "minecraft:health", values: { currentValue: 14, effectiveMax: 20, defaultValue: 20 } },
      { typeId: "minecraft:is_baby", values: {} },
      { typeId: "minecraft:movement", values: { currentValue: 0.23 }, unreadable: ["effectiveMin"] },
    ]);
  });

  it("keeps only the ids asked for and lists the ones the entity lacks", async () => {
    const { query } = loadHelper();
    const r = (await query({ kind: "components", type: "test:zombie", ids: ["health", "minecraft:tameable"] })) as Record<string, unknown>;
    expect(r.components).toEqual([{ typeId: "minecraft:health", values: { currentValue: 14, effectiveMax: 20, defaultValue: 20 } }]);
    expect(r.missing).toEqual(["minecraft:tameable"]);
  });

  it("refuses an entity id that is not in the world", async () => {
    const { query } = loadHelper();
    await expect(query({ kind: "components", entity: "-5" })).rejects.toThrow(/no entity with id -5/);
  });
});

describe("helper dynamic_properties query", () => {
  it("reads the world's properties by prefix, a Vector3 as x/y/z, with the byte total", async () => {
    const { query } = loadHelper({ dynamic: { "test:spawn": { x: 1.5, y: 64, z: -3 }, "test:round": 3, "other:flag": true } });
    expect(await query({ kind: "dynamic_properties", prefix: "test:" })).toEqual({
      target: "world",
      totalBytes: 99,
      count: 2,
      properties: { "test:round": 3, "test:spawn": { x: 1.5, y: 64, z: -3 } },
    });
  });

  it("reads an entity's properties when given its id", async () => {
    const { query } = loadHelper();
    expect(await query({ kind: "dynamic_properties", entity: "-77" })).toEqual({
      target: "entity",
      id: "-77",
      typeId: "test:zombie",
      totalBytes: 24,
      count: 1,
      properties: { "test:home": { x: 4, y: 70, z: -9 } },
    });
  });
});

describe("helper scores query", () => {
  const objectives = [
    { id: "kills", displayName: "Kills", scores: [{ name: "Steve", type: "Player", score: 3, entityId: "-1" }, { name: "#round", type: "FakePlayer", score: 7 }] },
    { id: "deaths", displayName: "Deaths", scores: [{ name: "Steve", type: "Player", score: 1, entityId: "-1" }] },
  ];

  it("keeps one objective and one participant", async () => {
    const { query } = loadHelper({ objectives });
    expect(await query({ kind: "scores", objective: "kills", participant: "#round" })).toEqual({
      objectives: [{ id: "kills", displayName: "Kills", criteria: "dummy", scores: [{ participant: "#round", type: "FakePlayer", score: 7 }] }],
    });
  });

  it("matches a participant by entity id and caps the rows", async () => {
    const { query } = loadHelper({ objectives });
    const r = (await query({ kind: "scores", participant: "-1", limit: 1 })) as { objectives: { scores: unknown[] }[]; truncated?: boolean };
    expect(r.objectives[0]?.scores).toEqual([{ participant: "Steve", type: "Player", score: 3, entityId: "-1" }]);
    expect(r.objectives[1]?.scores).toEqual([]);
    expect(r.truncated).toBe(true);
  });

  it("names the objectives there are when the one asked for is missing", async () => {
    const { query } = loadHelper({ objectives });
    await expect(query({ kind: "scores", objective: "wins" })).rejects.toThrow(/no scoreboard objective wins; objectives: kills, deaths/);
  });
});

describe("helper raycast query", () => {
  it("answers null and no entities when the ray hits nothing, from the player's head along the view", async () => {
    const { query, rays } = loadHelper();
    expect(await query({ kind: "raycast" })).toEqual({ from: { x: 0, y: 65.62, z: 0 }, direction: { x: 0, y: 0, z: 1 }, maxDistance: 16, block: null, entities: [] });
    expect(rays[0]?.options).toEqual({ maxDistance: 16, includeLiquidBlocks: false, includePassableBlocks: false });
  });

  it("casts toward a point, reports the block face and distance, and leaves the player out", async () => {
    const { query, rays } = loadHelper({
      blockHit: { block: "minecraft:stone", at: { x: 0, y: 65, z: 5 }, face: "North", faceLocation: { x: 0.5, y: 0.62, z: 0 } },
      rayEntities: [
        { id: "-1", typeId: "minecraft:player", distance: 0 },
        { id: "-77", typeId: "test:zombie", distance: 2.5 },
      ],
    });
    const r = (await query({ kind: "raycast", x: 0.5, y: 65.62, z: 0, to: { x: 0.5, y: 65.62, z: 8 } })) as Record<string, unknown>;
    expect(rays[0]?.direction).toEqual({ x: 0, y: 0, z: 1 });
    expect(r.maxDistance).toBe(8);
    expect(r.block).toEqual({ typeId: "minecraft:stone", location: { x: 0, y: 65, z: 5 }, face: "North", faceLocation: { x: 0.5, y: 0.62, z: 0 }, distance: 5 });
    // Cast from x/y/z, not from the player: the player on the ray is reported like any entity.
    expect(r.entities).toEqual([
      { id: "-1", typeId: "minecraft:player", distance: 0 },
      { id: "-77", typeId: "test:zombie", distance: 2.5 },
    ]);
  });
});

describe("helper entity_properties query", () => {
  it("reads declared properties and lists an id with no value as missing", async () => {
    const { query } = loadHelper();
    expect(await query({ kind: "entity_properties", entity: "-77", ids: ["test:phase", "test:angry", "test:gone"] })).toEqual({
      id: "-77",
      typeId: "test:zombie",
      properties: { "test:phase": 2, "test:angry": false },
      missing: ["test:gone"],
    });
  });
});

describe("entity property ids from the project", () => {
  const pack = (texts: Record<string, string>, kind: "behavior" | "resource" = "behavior"): IndexedPack => ({
    pack: { kind, dir: "/p", relDir: "BP" },
    files: Object.keys(texts),
    identifiers: new Map(),
    texts: new Map(Object.entries(texts)),
  });
  const zombieFile = `{
    // comments and trailing commas are allowed
    "format_version": "1.21.0",
    "minecraft:entity": { "description": { "identifier": "test:zombie", "properties": { "test:phase": { "type": "int", "range": [0, 3], "default": 0 }, "test:angry": { "type": "bool", "default": false }, } } }
  }`;

  it("reads the property ids the behavior pack's entity file declares", () => {
    const packs = [pack({ "entities/zombie.json": zombieFile }, "resource"), pack({ "entities/zombie.json": zombieFile })];
    expect(declaredEntityProperties(packs, "test:zombie")).toEqual(["test:phase", "test:angry"]);
    expect(declaredEntityProperties([packs[0] as IndexedPack], "test:zombie")).toEqual([]);
  });

  it("finds the type of an entity id and refuses a type the project declares nothing for", async () => {
    const packs = [pack({ "entities/zombie.json": zombieFile })];
    const source = { query: async () => ({ typeId: "test:zombie" }), declared: (t: string) => declaredEntityProperties(packs, t) };
    expect(await entityPropertyIdsFor({ entity: "-77" }, source)).toEqual(["test:phase", "test:angry"]);
    await expect(entityPropertyIdsFor({ type: "minecraft:pig" }, source)).rejects.toThrow(/declare no properties for minecraft:pig; pass ids/);
  });
});
