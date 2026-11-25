/**
 * The helper pack's scenes: `scene_save` keeps the box as a world structure and the player's state in a world dynamic
 * property, `scene_reset` puts both back, `scene_list` and `scene_delete` manage them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryEvent, replyIn, runHelperScript } from "../../testing/helperpack.ts";
import type { HelperReply } from "./helperprotocol.ts";

type Vec = { x: number; y: number; z: number };

/** An item as the test sees it: what a scene must carry across a reset. */
interface Item {
  id: string;
  amount: number;
  name?: string;
  lore?: string[];
  damage?: number;
  enchantments?: { id: string; level: number }[];
}

const KNOWN_ENCHANTMENTS = new Set(["minecraft:sharpness", "minecraft:unbreaking", "minecraft:protection"]);

/** Stands in for the Script API's EnchantmentType: an unknown id throws, as the game's does. */
class FakeEnchantmentType {
  id: string;
  constructor(id: string) {
    if (!KNOWN_ENCHANTMENTS.has(id)) throw new Error(`unknown enchantment ${id}`);
    this.id = id;
  }
}

/** Stands in for ItemStack: tools and armour have durability and take enchantments, other items neither. */
class FakeItemStack {
  typeId: string;
  amount: number;
  nameTag: string | undefined;
  lore: string[] = [];
  damage = 0;
  enchantments: { type: { id: string }; level: number }[] = [];
  constructor(typeId: string, amount = 1) {
    if (!typeId.startsWith("minecraft:")) throw new Error(`unknown item ${typeId}`);
    this.typeId = typeId;
    this.amount = amount;
  }
  get durable(): boolean {
    return /sword|helmet|shield/.test(this.typeId);
  }
  getLore(): string[] {
    return this.lore;
  }
  setLore(lore: string[]): void {
    this.lore = [...lore];
  }
  getComponent(id: string): unknown {
    if (!this.durable) return undefined;
    if (id === "minecraft:durability") {
      const self = this;
      return {
        maxDurability: 1561,
        get damage() {
          return self.damage;
        },
        set damage(v: number) {
          self.damage = v;
        },
      };
    }
    if (id === "minecraft:enchantable") {
      return {
        getEnchantments: () => this.enchantments,
        addEnchantment: (e: { type: { id: string }; level: number }) => void this.enchantments.push(e),
      };
    }
    return undefined;
  }
}

function stack(item: Item): FakeItemStack {
  const s = new FakeItemStack(item.id, item.amount);
  s.nameTag = item.name;
  s.lore = item.lore ?? [];
  s.damage = item.damage ?? 0;
  s.enchantments = (item.enchantments ?? []).map((e) => ({ type: { id: e.id }, level: e.level }));
  return s;
}

/** A stack read back in the test's own terms. */
function view(s: FakeItemStack | undefined): Item | null {
  if (!s) return null;
  const out: Item = { id: s.typeId, amount: s.amount };
  if (s.nameTag) out.name = s.nameTag;
  if (s.lore.length) out.lore = s.lore;
  if (s.damage) out.damage = s.damage;
  if (s.enchantments.length) out.enchantments = s.enchantments.map((e) => ({ id: e.type.id, level: e.level }));
  return out;
}

interface FakeEntity {
  typeId: string;
  location: Vec;
  removed?: boolean;
  remove: () => void;
}

/** The helper script in a fake world with one player standing at 0.5 -60 0.5 in a flat overworld. */
function loadHelper() {
  let onQuery: ((ev: { id: string; message: string }) => void) | undefined;
  let onWeather: ((ev: { dimension: string; newWeather: string; previousWeather: string }) => void) | undefined;
  const slots: (FakeItemStack | undefined)[] = Array.from({ length: 36 }, () => undefined);
  const equipment: Record<string, FakeItemStack | undefined> = {};
  const attributes: Record<string, number> = { "minecraft:health": 20, "minecraft:player.hunger": 20, "minecraft:player.saturation": 5 };
  const attribute = (id: string) => ({
    get currentValue() {
      return attributes[id];
    },
    setCurrentValue: (v: number) => {
      attributes[id] = v;
      return true;
    },
  });
  const effects = new Set<string>();
  const player = {
    typeId: "minecraft:player",
    name: "Steve",
    id: "-1",
    location: { x: 0.5, y: -60, z: 0.5 } as Vec,
    rotation: { x: 0, y: 90 },
    /** The one fake dimension (declared below; read only once queries run). */
    get dimension() {
      return dim;
    },
    gameMode: "Creative",
    selectedSlotIndex: 0,
    getRotation() {
      return this.rotation;
    },
    getGameMode() {
      return this.gameMode;
    },
    setGameMode(mode: string) {
      this.gameMode = mode;
    },
    teleport(location: Vec, options: { rotation?: { x: number; y: number } }) {
      this.location = { ...location };
      if (options.rotation) this.rotation = { ...options.rotation };
    },
    getEffects: () => [...effects].map((typeId) => ({ typeId, amplifier: 0, duration: 200 })),
    removeEffect: (typeId: string) => effects.delete(typeId),
    getComponent: (id: string) => {
      if (id === "minecraft:inventory") {
        return {
          container: {
            size: slots.length,
            getItem: (i: number) => slots[i],
            setItem: (i: number, item?: FakeItemStack) => void (slots[i] = item),
            clearAll: () => slots.fill(undefined),
          },
        };
      }
      if (id === "minecraft:equippable") {
        return {
          getEquipment: (slot: string) => equipment[slot],
          setEquipment: (slot: string, item?: FakeItemStack) => {
            equipment[slot] = item;
            return true;
          },
        };
      }
      if (id in attributes) return attribute(id);
      return undefined;
    },
  };
  const entities: FakeEntity[] = [];
  const spawn = (typeId: string, location: Vec): FakeEntity => {
    const e: FakeEntity = { typeId, location, remove: () => void (e.removed = true) };
    entities.push(e);
    return e;
  };
  const inBox = (at: Vec, min: Vec, size: Vec) =>
    at.x >= min.x && at.x < min.x + size.x && at.y >= min.y && at.y < min.y + size.y && at.z >= min.z && at.z < min.z + size.z;
  let weather = "Clear";
  const dim = {
    id: "minecraft:overworld",
    heightRange: { min: -64, max: 320 },
    getBlock: (at: Vec) => ({ typeId: "minecraft:air", location: at }),
    getEntities: (q: { location: Vec; volume: Vec }): { typeId: string; location: Vec }[] =>
      [...entities, player].filter((e) => !("removed" in e && e.removed) && inBox(e.location, q.location, q.volume)),
    setWeather: (w: string) => void (weather = w),
  };
  const properties = new Map<string, unknown>();
  /** Saved structures: id -> the entities it holds. */
  const structures = new Map<string, { from: Vec; to: Vec; entities: { typeId: string; location: Vec }[] }>();
  const placed: { id: string; at: Vec }[] = [];
  let timeOfDay = 6000;
  const fakeWorld = {
    getAllPlayers: () => [player],
    getDimension: () => dim,
    getDynamicProperty: (id: string) => properties.get(id),
    setDynamicProperty: (id: string, value: unknown) => (value === undefined ? properties.delete(id) : properties.set(id, value)),
    getDynamicPropertyIds: () => [...properties.keys()],
    getTimeOfDay: () => timeOfDay,
    setTimeOfDay: (t: number) => void (timeOfDay = t),
    structureManager: {
      get: (id: string) => (structures.has(id) ? { id } : undefined),
      delete: (id: string) => structures.delete(id),
      createFromWorld: (id: string, _dim: unknown, from: Vec, to: Vec, options: { includeEntities?: boolean; saveMode?: string }) => {
        if (structures.has(id)) throw new Error(`structure ${id} already exists`);
        const size = { x: to.x - from.x + 1, y: to.y - from.y + 1, z: to.z - from.z + 1 };
        const held = options.includeEntities ? dim.getEntities({ location: from, volume: size }).filter((e) => e !== player) : [];
        structures.set(id, { from, to, entities: held.map((e) => ({ typeId: e.typeId, location: { ...e.location } })) });
        return { id };
      },
      place: (id: string, _dim: unknown, at: Vec) => {
        const s = structures.get(id);
        if (!s) throw new Error(`no structure ${id}`);
        placed.push({ id, at });
        for (const e of s.entities) spawn(e.typeId, { ...e.location });
      },
    },
    afterEvents: new Proxy({} as Record<string, unknown>, {
      get: (_t, key) => ({
        subscribe: (h: never) => {
          if (key === "weatherChange") onWeather = h;
        },
      }),
    }),
  };
  const fakeSystem = {
    currentTick: 1,
    run: (cb: () => void) => {
      queueMicrotask(cb);
      return 0;
    },
    runInterval: () => 1,
    clearRun: () => undefined,
    afterEvents: { scriptEventReceive: { subscribe: (h: typeof onQuery) => (onQuery = h) } },
  };
  const lines = runHelperScript({
    BlockVolume: class {},
    EnchantmentType: FakeEnchantmentType,
    ItemStack: FakeItemStack,
    system: fakeSystem,
    world: fakeWorld,
  });
  let id = 0;
  async function ask(params: Record<string, unknown>): Promise<HelperReply> {
    const qid = ++id;
    onQuery?.(queryEvent(params, qid));
    for (let n = 0; n < 200; n++) {
      const reply = replyIn(lines, qid);
      if (reply) return reply;
      await Promise.resolve();
    }
    throw new Error("no reply");
  }
  async function query(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await ask(params);
    if (!reply.ok) throw new Error(reply.error);
    return reply.result as Record<string, unknown>;
  }
  return {
    ask,
    query,
    player,
    slots,
    equipment,
    attributes,
    effects,
    entities,
    spawn,
    properties,
    placed,
    weatherChange: (newWeather: string) => onWeather?.({ dimension: "minecraft:overworld", newWeather, previousWeather: weather }),
    get weather() {
      return weather;
    },
    get timeOfDay() {
      return timeOfDay;
    },
    set timeOfDay(t: number) {
      timeOfDay = t;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const SWORD: Item = {
  id: "minecraft:diamond_sword",
  amount: 1,
  name: "Edge",
  lore: ["first blood"],
  damage: 40,
  enchantments: [{ id: "minecraft:sharpness", level: 5 }],
};
const BREAD: Item = { id: "minecraft:bread", amount: 12, name: "Ration" };
const HELMET: Item = { id: "minecraft:iron_helmet", amount: 1, damage: 7, enchantments: [{ id: "minecraft:protection", level: 2 }] };
const SHIELD: Item = { id: "minecraft:shield", amount: 1, damage: 3 };

describe("helper scenes", () => {
  it("scene_reset puts back what scene_save kept: player state, inventory, equipment, box, time and weather", async () => {
    const h = loadHelper();
    h.slots[0] = stack(SWORD);
    h.slots[20] = stack(BREAD);
    h.equipment.Head = stack(HELMET);
    h.equipment.Offhand = stack(SHIELD);
    h.player.selectedSlotIndex = 3;
    h.player.gameMode = "Survival";
    h.player.rotation = { x: 10, y: -45 };
    h.attributes["minecraft:health"] = 14;
    h.attributes["minecraft:player.hunger"] = 17;
    h.weatherChange("Rain");
    h.timeOfDay = 13000;
    h.spawn("minecraft:pig", { x: 3, y: -60, z: 2 });

    const saved = await h.query({ kind: "scene_save", name: "arena-1", radius: 4 });
    expect(saved).toMatchObject({
      name: "arena-1",
      overwritten: false,
      dimension: "minecraft:overworld",
      box: { min: { x: -4, y: -64, z: -4 }, max: { x: 4, y: -56, z: 4 } },
      entities: 1,
      items: 4,
      notes: [],
    });

    // The test changes everything a scene covers.
    h.slots.fill(undefined);
    h.slots[5] = stack({ id: "minecraft:dirt", amount: 64 });
    h.equipment.Head = undefined;
    h.equipment.Offhand = undefined;
    h.equipment.Feet = stack({ id: "minecraft:iron_boots", amount: 1 });
    h.player.teleport({ x: 100, y: 70, z: -30 }, { rotation: { x: 0, y: 0 } });
    h.player.gameMode = "Creative";
    h.player.selectedSlotIndex = 8;
    h.attributes["minecraft:health"] = 3;
    h.attributes["minecraft:player.hunger"] = 2;
    h.effects.add("minecraft:poison");
    h.timeOfDay = 18000;
    h.weatherChange("Thunder");
    for (const e of h.entities) e.remove();
    h.spawn("minecraft:zombie", { x: 1, y: -60, z: 1 });
    h.spawn("minecraft:cow", { x: 50, y: -60, z: 50 }); // outside the box: left alone

    const reset = await h.query({ kind: "scene_reset", name: "arena-1" });
    expect(reset).toMatchObject({ name: "arena-1", removedEntities: 1, notes: [] });
    expect(reset.restored).toEqual(expect.arrayContaining(["blocks", "entities", "inventory", "equipment", "gameMode", "health", "timeOfDay", "weather"]));

    expect(h.slots.map(view)).toEqual(Array.from({ length: 36 }, (_, i) => (i === 0 ? SWORD : i === 20 ? BREAD : null)));
    expect(view(h.equipment.Head)).toEqual(HELMET);
    expect(view(h.equipment.Offhand)).toEqual(SHIELD);
    expect(h.equipment.Feet).toBeUndefined();
    expect(h.player.location).toEqual({ x: 0.5, y: -60, z: 0.5 });
    expect(h.player.rotation).toEqual({ x: 10, y: -45 });
    expect(h.player.gameMode).toBe("Survival");
    expect(h.player.selectedSlotIndex).toBe(3);
    expect(h.attributes["minecraft:health"]).toBe(14);
    expect(h.attributes["minecraft:player.hunger"]).toBe(17);
    expect(h.effects.size).toBe(0);
    expect(h.timeOfDay).toBe(13000);
    expect(h.weather).toBe("Rain");
    expect(h.placed).toEqual([{ id: "sculkwire:scene_arena-1", at: { x: -4, y: -64, z: -4 } }]);
    const alive = h.entities.filter((e) => !e.removed).map((e) => e.typeId);
    expect(alive.sort()).toEqual(["minecraft:cow", "minecraft:pig"]);
  });

  it("lists, overwrites and deletes scenes", async () => {
    const h = loadHelper();
    await h.query({ kind: "scene_save", name: "b" });
    await h.query({ kind: "scene_save", name: "a", x: 10, y: 0, z: 10, radius: 0 });
    expect(await h.query({ kind: "scene_save", name: "b" })).toMatchObject({ overwritten: true });
    const list = (await h.query({ kind: "scene_list" })) as unknown as { name: string; structure: boolean; box: unknown }[];
    expect(list.map((s) => s.name)).toEqual(["a", "b"]);
    expect(list[0]).toMatchObject({ structure: true, box: { min: { x: 10, y: 0, z: 10 }, max: { x: 10, y: 0, z: 10 } } });
    await h.query({ kind: "scene_delete", name: "b" });
    expect(((await h.query({ kind: "scene_list" })) as unknown as { name: string }[]).map((s) => s.name)).toEqual(["a"]);
  });

  it("keeps a scene too long for one dynamic property in parts", async () => {
    const h = loadHelper();
    const lore = Array.from({ length: 20 }, (_, i) => `line ${i} ${"x".repeat(60)}`);
    for (let i = 0; i < 36; i++) h.slots[i] = stack({ id: "minecraft:paper", amount: 1, lore });
    await h.query({ kind: "scene_save", name: "big" });
    expect(typeof h.properties.get("sculkwire:scene:big")).toBe("number");
    h.slots.fill(undefined);
    await h.query({ kind: "scene_reset", name: "big" });
    expect(h.slots.every((s) => s?.getLore().length === 20)).toBe(true);
    expect(((await h.query({ kind: "scene_list" })) as unknown as { name: string }[]).map((s) => s.name)).toEqual(["big"]);
  });

  it("reports what it could not restore instead of failing the reset", async () => {
    const h = loadHelper();
    await h.query({ kind: "scene_save", name: "odd" });
    // A scene saved by a game that knew an item and an enchantment this one does not.
    const scene = JSON.parse(String(h.properties.get("sculkwire:scene:odd")));
    scene.player.slots[0] = { id: "custom:wand", amount: 1 };
    scene.player.slots[1] = { id: "minecraft:iron_sword", amount: 1, enchantments: [{ id: "minecraft:gone", level: 1 }, { id: "minecraft:unbreaking", level: 3 }] };
    h.properties.set("sculkwire:scene:odd", JSON.stringify(scene));

    const reset = await h.query({ kind: "scene_reset", name: "odd" });
    const notes = reset.notes as string[];
    expect(notes.some((n) => n.includes("slot 0: custom:wand x1 not restored"))).toBe(true);
    expect(notes.some((n) => n.includes("enchantment minecraft:gone 1 not restored"))).toBe(true);
    // The weather never changed since the helper started, so the save did not know it.
    expect(notes.some((n) => n.startsWith("weather was unknown"))).toBe(true);
    expect(h.slots[0]).toBeUndefined();
    expect(view(h.slots[1])).toEqual({ id: "minecraft:iron_sword", amount: 1, enchantments: [{ id: "minecraft:unbreaking", level: 3 }] });
  });

  it("refuses a missing scene, a bad name and a box wider than a structure", async () => {
    const h = loadHelper();
    expect(await h.ask({ kind: "scene_reset", name: "nope" })).toMatchObject({ ok: false, reason: "no_scene" });
    expect(await h.ask({ kind: "scene_delete", name: "nope" })).toMatchObject({ ok: false, reason: "no_scene" });
    for (const name of ["Arena", "a b", "", "x".repeat(33), "a:b"]) {
      expect(await h.ask({ kind: "scene_save", name })).toMatchObject({ ok: false, reason: "bad_name" });
    }
    expect(await h.ask({ kind: "scene_save", name: "wide", radius: 32 })).toMatchObject({ ok: false, reason: "bad_radius" });
    expect(h.properties.size).toBe(0);
  });
});
