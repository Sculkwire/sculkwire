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
  /** The main-hand item id; `throws` makes the equippable component throw. */
  held?: string;
  /** A main-hand item only the `hasitem` selector sees (no equippable component, as on mobs). */
  selectorHeld?: string;
}

/** A player handle as the fake world lists it: where it says the player stands, and whether the API calls it valid. */
interface FakePlayer {
  id?: string;
  location?: Vec;
  isValid?: boolean;
  /** The off-hand item: a durability damage, an item without durability (`null`), or an equipment read that throws. */
  offhand?: { damage: number } | null | "throws";
}

/** The helper script with a fake world: the given players (one at the origin by default), the given entities, entity events fired by hand. */
function loadHelper(entities: FakeEntity[], opts: { players?: FakePlayer[] } = {}) {
  let tick = 100;
  let interval: (() => void) | undefined;
  let onQuery: Handler | undefined;
  const handlers = new Map<string, Handler>();
  const on = (name: string) => ({ subscribe: (h: Handler) => void handlers.set(name, h) });
  /** Commands the helper ran on entities, `<id> <command>`. */
  const commands: string[] = [];
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
    runCommand: (cmd: string) => {
      commands.push(`${e.id} ${cmd}`);
      const m = /hasitem=\{item=([^,]+),location=slot\.weapon\.mainhand\}/.exec(cmd);
      return { successCount: m && m[1] === e.selectorHeld ? 1 : 0 };
    },
    getComponent: (c: string) => {
      if (c === "minecraft:health" && e.health !== undefined) return { currentValue: e.health, effectiveMax: 20 };
      if (c === "minecraft:equippable" && e.held !== undefined)
        return {
          getEquipment: (slot: string) => {
            if (e.held === "throws") throw new Error("fake: equipment unavailable");
            return slot === "Mainhand" ? { typeId: e.held } : undefined;
          },
        };
      return undefined;
    },
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
  const makePlayer = (p: FakePlayer) => ({
    id: p.id ?? "-1",
    name: "Steve",
    location: p.location ?? { x: 0, y: 0, z: 0 },
    ...(p.isValid !== undefined ? { isValid: p.isValid } : {}),
    dimension: dim,
    isOnGround: true,
    isSneaking: false,
    isSprinting: false,
    selectedSlotIndex: 0,
    getVelocity: () => ({ x: 0, y: 0, z: 0 }),
    getRotation: () => ({ x: 0, y: 0 }),
    getGameMode: () => "survival",
    getComponent: (c: string) => {
      if (c !== "minecraft:equippable" || p.offhand === undefined) return undefined;
      const off = p.offhand;
      return {
        getEquipment: (slot: string) => {
          if (off === "throws") throw new Error("fake: equipment unavailable");
          if (slot !== "Offhand") return undefined;
          return { typeId: "minecraft:shield", getComponent: (id: string) => (id === "minecraft:durability" && off ? { damage: off.damage, maxDurability: 336 } : undefined) };
        },
      };
    },
    getBlockFromViewDirection: () => undefined,
    getEntitiesFromViewDirection: () => [],
  });
  const players = (opts.players ?? [{}]).map(makePlayer);
  const world = {
    getAllPlayers: () => players,
    getDimension: () => dim,
    getEntity: (id: string) => {
      const e = entities.find((m) => m.id === id);
      return e ? asEntity(e) : undefined;
    },
    afterEvents: Object.fromEntries(["projectileHitEntity", "projectileHitBlock", "entityDie", "entityHurt", "playerSpawn", "playerLeave", "dataDrivenEntityTrigger", "entityRemove"].map((n) => [n, on(n)])),
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
    players,
    commands,
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
    lastState(): { tick: number; location: Vec; entities?: { radius: number; limit: number; list: Record<string, unknown>[] } } {
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

describe("helper held items", () => {
  it("reports a mob's main-hand item in the stream and the entity query, and nothing when it cannot be read", () => {
    const h = loadHelper([
      { id: "1", typeId: "minecraft:husk", location: { x: 3, y: 0, z: 0 }, health: 20, held: "minecraft:iron_spear" },
      { id: "2", typeId: "minecraft:zombie", location: { x: 4, y: 0, z: 0 }, health: 20 },
      { id: "3", typeId: "minecraft:zombie", location: { x: 5, y: 0, z: 0 }, health: 20, held: "throws" },
    ]);
    h.query({ kind: "stream", every: 1 });
    h.advance(1);
    const list = h.lastState().entities?.list ?? [];
    expect(list[0]).toMatchObject({ held: "minecraft:iron_spear" });
    expect(list[1]?.held).toBeUndefined();
    expect(list[2]?.held).toBeUndefined();
    expect(h.query({ kind: "entity", entityId: "1" })).toMatchObject({ held: "minecraft:iron_spear" });
  });

  it("asks the game with hasitem when a mob has no equippable component: one entity a tick, cached, spear carriers only", () => {
    const h = loadHelper([
      { id: "1", typeId: "minecraft:husk", location: { x: 3, y: 0, z: 0 }, health: 20, selectorHeld: "minecraft:iron_spear" },
      { id: "2", typeId: "minecraft:zombie", location: { x: 4, y: 0, z: 0 }, health: 20, selectorHeld: "minecraft:diamond_spear" },
      { id: "3", typeId: "minecraft:spider", location: { x: 5, y: 0, z: 0 }, health: 16 },
      { id: "4", typeId: "minecraft:husk", location: { x: 6, y: 0, z: 0 }, health: 20 },
    ]);
    h.query({ kind: "stream", every: 1 });
    h.advance(1);
    // One entity checked this tick: the husk, which holds an iron spear (wooden, stone, copper, then iron).
    expect(h.lastState().entities?.list[0]).toMatchObject({ held: "minecraft:iron_spear" });
    expect(h.lastState().entities?.list[1]?.held).toBeUndefined();
    expect(new Set(h.commands.map((c) => c.split(" ")[0]))).toEqual(new Set(["1"]));
    expect(h.commands[0]).toBe("1 testfor @s[hasitem={item=minecraft:wooden_spear,location=slot.weapon.mainhand}]");
    h.advance(3);
    const list = h.lastState().entities?.list ?? [];
    expect(list[1]).toMatchObject({ held: "minecraft:diamond_spear" });
    expect(list[2]?.held).toBeUndefined();
    expect(list[3]?.held).toBeUndefined();
    // Cached: no spider asked, and each carrier asked once (all seven spears for the bare husk).
    expect(h.commands.filter((c) => c.startsWith("3 "))).toEqual([]);
    expect(h.commands.filter((c) => c.startsWith("4 ")).length).toBe(7);
    const asked = h.commands.length;
    h.advance(10);
    expect(h.commands.length).toBe(asked);
    expect(h.lastState().entities?.list[0]).toMatchObject({ held: "minecraft:iron_spear" });
  });
});

describe("helper player choice", () => {
  const ghost = { location: { x: 0, y: -60, z: 0 } };
  const real = { location: { x: 100.5, y: -60, z: 40.5 } };

  it("reports the handle of the newest spawn when the world lists two", () => {
    // The stale handle is listed last, where the fallback would take it: the spawn event decides.
    const h = loadHelper([], { players: [real, ghost] });
    h.fire("playerSpawn", { player: h.players[0], initialSpawn: true });
    h.query({ kind: "stream", every: 1, radius: 0 });
    h.advance(1);
    expect(h.lastState().location).toEqual(real.location);
    expect(h.query({ kind: "state" })).toMatchObject({ location: real.location });
  });

  it("never reports a handle the API marks invalid, and falls back to the newest listed", () => {
    const h = loadHelper([], { players: [ghost, { ...real, isValid: false }, { location: { x: 5, y: -60, z: 5 } }] });
    h.query({ kind: "stream", every: 1, radius: 0 });
    h.advance(1);
    expect(h.lastState().location).toEqual({ x: 5, y: -60, z: 5 });
  });
});

describe("helper player state", () => {
  it("streams the off-hand item's durability damage, and nothing when there is none or the read throws", () => {
    const state = (offhand: FakePlayer["offhand"]) => {
      const h = loadHelper([], { players: [{ offhand }] });
      h.query({ kind: "stream", every: 1, radius: 0 });
      h.advance(1);
      return { streamed: h.lastState() as Record<string, unknown>, queried: h.query({ kind: "state" }) as Record<string, unknown> };
    };
    const shield = state({ damage: 7 });
    expect(shield.streamed.offhandDamage).toBe(7);
    expect(shield.queried.offhandDamage).toBe(7);
    expect(state({ damage: 0 }).streamed.offhandDamage).toBe(0);
    for (const none of [undefined, null, "throws"] as const) {
      const s = state(none);
      expect(s.streamed).not.toHaveProperty("offhandDamage");
      expect(s.streamed.location).toEqual({ x: 0, y: 0, z: 0 });
    }
  });
});
