import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

type Vec = { x: number; y: number; z: number };
type Handler = (ev: Record<string, unknown>) => void;

interface FakeEntity {
  id: string;
  typeId: string;
  location: Vec;
  velocity?: Vec;
  health?: number;
}

/** The helper script with a fake world: one player, the given entities, entity events fired by hand. */
function loadHelper(entities: FakeEntity[]) {
  let tick = 100;
  let interval: (() => void) | undefined;
  let onQuery: Handler | undefined;
  const handlers = new Map<string, Handler>();
  const on = (name: string) => ({ subscribe: (h: Handler) => void handlers.set(name, h) });
  const asEntity = (e: FakeEntity) => ({
    id: e.id,
    typeId: e.typeId,
    location: e.location,
    isValid: true,
    nameTag: "",
    dimension: { id: "minecraft:overworld" },
    getVelocity: () => e.velocity ?? { x: 0, y: 0, z: 0 },
    getTags: () => [],
    getEffects: () => [],
    getComponent: (c: string) => (c === "minecraft:health" && e.health !== undefined ? { currentValue: e.health, effectiveMax: 20 } : undefined),
  });
  const dim = {
    id: "minecraft:overworld",
    getEntities: (q: { location: Vec; maxDistance: number; closest: number; excludeTypes: string[] }) =>
      entities
        .filter((e) => !q.excludeTypes.includes(e.typeId) && Math.hypot(e.location.x - q.location.x, e.location.y - q.location.y, e.location.z - q.location.z) <= q.maxDistance)
        .sort((a, b) => Math.hypot(a.location.x - q.location.x, a.location.z - q.location.z) - Math.hypot(b.location.x - q.location.x, b.location.z - q.location.z))
        .slice(0, q.closest)
        .map(asEntity),
  };
  const player = {
    id: "-1",
    name: "p",
    location: { x: 0, y: 0, z: 0 },
    dimension: dim,
    isOnGround: true,
    isSneaking: false,
    isSprinting: false,
    selectedSlotIndex: 0,
    getVelocity: () => ({ x: 0, y: 0, z: 0 }),
    getRotation: () => ({ x: 0, y: 0 }),
    getGameMode: () => "survival",
    getComponent: () => undefined,
    getBlockFromViewDirection: () => undefined,
    getEntitiesFromViewDirection: () => [],
  };
  const world = {
    getAllPlayers: () => [player],
    getDimension: () => dim,
    getEntity: (id: string) => {
      const e = entities.find((m) => m.id === id);
      return e ? asEntity(e) : undefined;
    },
    afterEvents: Object.fromEntries(["projectileHitEntity", "projectileHitBlock", "entityDie", "entityHurt", "playerSpawn", "dataDrivenEntityTrigger", "entityRemove"].map((n) => [n, on(n)])),
  };
  const system = {
    get currentTick() {
      return tick;
    },
    run: () => 0,
    runInterval: (fn: () => void) => {
      interval = fn;
      return 1;
    },
    clearRun: () => {
      interval = undefined;
    },
    afterEvents: { scriptEventReceive: { subscribe: (h: Handler) => void (onQuery = h) } },
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "scripts", "main.js"), "utf8").replace(/^import .*$/m, "");
  new Function("BlockVolume", "system", "world", source)(class {}, system, world);
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
  let id = 0;
  return {
    lines,
    advance(ticks: number) {
      for (let i = 0; i < ticks; i++) {
        tick++;
        interval?.();
      }
    },
    fire(name: string, ev: Record<string, unknown>) {
      handlers.get(name)?.(ev);
    },
    query(params: Record<string, unknown>): unknown {
      const qid = ++id;
      onQuery?.({ id: "sculkwire:query", message: JSON.stringify({ ...params, id: qid }) });
      const line = lines.find((l) => l.includes(`"id":${qid},`)) ?? "";
      return (JSON.parse(line.slice("[sculkwire:reply] ".length)) as { result: unknown }).result;
    },
    lastState(): { tick: number; entities?: { radius: number; limit: number; list: Record<string, unknown>[] } } {
      const line = lines.findLast((l) => l.startsWith("[sculkwire:state] ")) ?? "";
      return JSON.parse(line.slice("[sculkwire:state] ".length));
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("helper state stream", () => {
  it("carries the closest living entities with velocity and health, leaving out players and items", () => {
    const h = loadHelper([
      { id: "1", typeId: "minecraft:zombie", location: { x: 3, y: 0, z: 0 }, velocity: { x: -0.1, y: 0, z: 0 }, health: 20 },
      { id: "2", typeId: "minecraft:item", location: { x: 1, y: 0, z: 0 } },
      { id: "3", typeId: "minecraft:skeleton", location: { x: 0, y: 0, z: 20 }, health: 20 },
      { id: "4", typeId: "minecraft:creeper", location: { x: 0, y: 0, z: 5 }, health: 20 },
    ]);
    h.query({ kind: "stream", every: 1 });
    h.advance(1);
    const s = h.lastState();
    expect(s.entities?.radius).toBe(16);
    expect(s.entities?.list.map((e) => e.id)).toEqual(["1", "4"]);
    expect(s.entities?.list[0]).toMatchObject({ typeId: "minecraft:zombie", velocity: { x: -0.1 }, health: { current: 20 } });
    expect(s.entities?.list[1]).toMatchObject({ ignited: false });
  });

  it("stops at the limit and streams no entities with radius 0", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: String(i), typeId: "minecraft:zombie", location: { x: i + 1, y: 0, z: 0 }, health: 20 }));
    const h = loadHelper(many);
    h.query({ kind: "stream", every: 1, limit: 8 });
    h.advance(1);
    expect(h.lastState().entities?.list.length).toBe(8);
    h.query({ kind: "stream", every: 1, radius: 0 });
    h.advance(1);
    expect(h.lastState().entities).toBeUndefined();
  });

  it("reports a creeper's fuse from its entity events: lit tick, burn time, out again", () => {
    const creeper = { id: "7", typeId: "minecraft:creeper", location: { x: 2, y: 0, z: 0 }, health: 20 };
    const h = loadHelper([creeper]);
    h.query({ kind: "stream", every: 1 });
    h.advance(1);
    expect(h.lastState().entities?.list[0]).toMatchObject({ ignited: false });
    h.fire("dataDrivenEntityTrigger", { entity: { id: "7" }, eventId: "minecraft:start_exploding" });
    h.advance(10);
    // The sensor fires again while the creeper stays in range: the fuse still counts from the first.
    h.fire("dataDrivenEntityTrigger", { entity: { id: "7" }, eventId: "minecraft:start_exploding" });
    h.advance(2);
    expect(h.lastState().entities?.list[0]).toMatchObject({ ignited: true, fuseTicks: 12 });
    expect(h.query({ kind: "entity", entityId: "7" })).toMatchObject({ ignited: true, fuseTicks: 12 });
    h.fire("dataDrivenEntityTrigger", { entity: { id: "7" }, eventId: "minecraft:stop_exploding" });
    h.advance(1);
    const after = h.lastState().entities?.list[0];
    expect(after).toMatchObject({ ignited: false });
    expect(after?.fuseTicks).toBeUndefined();
  });
});
