/**
 * The helper pack's `inventory` and `container` queries: the Script API's inventory, equippable and block inventory
 * components, parsed by the same code the engine route uses, so the fallback's shape cannot drift from the agent's.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseContainer, parseInventory } from "../../engine/inventory.ts";

type Vec = { x: number; y: number; z: number };

interface FakeItem {
  typeId: string;
  amount: number;
  nameTag?: string;
  lore?: string[];
  damage?: number;
  maxDurability?: number;
  enchantments?: { id: string; level: number }[];
}

/** What the script reads off an ItemStack, and what `item()` builds from a `FakeItem`. */
interface FakeItemHandle {
  typeId: string;
  amount: number;
  nameTag?: string;
  getLore: () => string[];
  getComponent: (id: string) => unknown;
}

const item = (value: FakeItem): FakeItemHandle => ({
  typeId: value.typeId,
  amount: value.amount,
  nameTag: value.nameTag,
  getLore: () => value.lore ?? [],
  getComponent: (id: string) => {
    if (id === "minecraft:durability" && value.damage !== undefined) return { damage: value.damage, maxDurability: value.maxDurability ?? 250 };
    if (id === "minecraft:enchantable" && value.enchantments) {
      return { getEnchantments: () => value.enchantments?.map((e) => ({ level: e.level, type: { id: e.id } })) };
    }
    return undefined;
  },
});

const attribute = (current: number, min: number, max: number, fallback: number) => ({
  currentValue: current,
  effectiveMin: min,
  effectiveMax: max,
  defaultValue: fallback,
});

/** The helper script with a fake world: one player carrying `hotbar`, and one chest at 1 64 -2. */
function loadHelper(options: { hotbar?: FakeItem[]; chest?: FakeItem[]; chestBlock?: string } = {}) {
  let onQuery: ((ev: { id: string; message: string }) => void) | undefined;
  const hotbar = options.hotbar ?? [];
  const chest = options.chest ?? [];
  const inventory = {
    size: 36,
    getItem: (slot: number) => {
      const held = hotbar[slot];
      return held ? item(held) : undefined;
    },
  };
  const equipment: Record<string, FakeItemHandle | undefined> = {
    Head: item({ typeId: "minecraft:iron_helmet", amount: 1, damage: 30, maxDurability: 165 }),
    Chest: undefined,
    Legs: undefined,
    Feet: undefined,
    Offhand: undefined,
  };
  const player = {
    name: "Steve",
    location: { x: 1, y: 64, z: -2 },
    dimension: { id: "minecraft:overworld" },
    selectedSlotIndex: 1,
    level: 12,
    getTotalXp: () => 1050,
    getComponent: (id: string) => {
      if (id === "minecraft:inventory") return { container: inventory };
      if (id === "minecraft:equippable") {
        return { getEquipment: (slot: string) => equipment[slot], totalArmor: 2, totalToughness: 0 };
      }
      if (id === "minecraft:health") return attribute(20, 0, 20, 20);
      if (id === "minecraft:player.hunger") throw new Error("unknown component"); // an older API level
      if (id === "minecraft:player.saturation") return attribute(5, 0, 20, 5);
      return undefined;
    },
  };
  const chestContainer = {
    size: chest.length,
    getItem: (slot: number) => (chest[slot] ? item(chest[slot] as FakeItem) : undefined),
  };
  const dim = {
    id: "minecraft:overworld",
    heightRange: { min: -64, max: 320 },
    getBlock: ({ x, y, z }: Vec) =>
      x === 1 && y === 64 && z === -2
        ? {
            typeId: options.chestBlock ?? "minecraft:chest",
            location: { x, y, z },
            getComponent: (id: string) => (id === "minecraft:inventory" ? { container: chestContainer } : undefined),
          }
        : { typeId: "minecraft:stone", location: { x, y, z }, getComponent: () => undefined },
  };
  const afterEvents = new Proxy(
    { scriptEventReceive: { subscribe: (h: typeof onQuery) => (onQuery = h) } },
    { get: (target, key) => (key in target ? Reflect.get(target, key) : { subscribe: () => undefined }) },
  );
  const fakeWorld = { getAllPlayers: () => [player], getDimension: () => dim, afterEvents };
  const fakeSystem = {
    currentTick: 1,
    run: () => 0,
    runInterval: () => 1,
    clearRun: () => undefined,
    afterEvents: { scriptEventReceive: { subscribe: (h: typeof onQuery) => (onQuery = h) } },
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "scripts", "main.js"), "utf8").replace(/^import .*$/m, "");
  new Function("BlockVolume", "system", "world", source)(class {}, fakeSystem, fakeWorld);
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  let id = 0;
  return async function query(params: Record<string, unknown>): Promise<unknown> {
    const qid = ++id;
    onQuery?.({ id: "sculkwire:query", message: JSON.stringify({ ...params, id: qid }) });
    for (let n = 0; n < 100; n++) {
      const line = lines.find((l) => l.includes(`"id":${qid},`));
      if (line) {
        const reply = JSON.parse(line.slice("[sculkwire:reply] ".length)) as { ok: boolean; result: unknown; error?: string };
        if (!reply.ok) throw new Error(reply.error);
        return reply.result;
      }
      await Promise.resolve();
    }
    throw new Error("no reply");
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("helper inventory query", () => {
  it("reports the player's slots, equipment and the attributes the API has components for", async () => {
    const query = loadHelper({
      hotbar: [
        { typeId: "minecraft:diamond_sword", amount: 1, damage: 40, maxDurability: 1561, enchantments: [{ id: "minecraft:sharpness", level: 5 }] },
        { typeId: "minecraft:bread", amount: 12, nameTag: "Ration", lore: ["for the road"] },
      ],
    });
    const reply = (await query({ kind: "inventory" })) as { inventory: unknown; attributes: unknown };
    const parsed = parseInventory(reply.inventory);
    // selectedSlotIndex 1 is the second hotbar slot, which player_state calls 2 as well.
    expect(parsed?.selectedSlot).toBe(2);
    expect(parsed?.hotbar).toHaveLength(9);
    expect(parsed?.hotbar[0]).toEqual({
      item: "minecraft:diamond_sword",
      count: 1,
      enchantments: [{ id: "minecraft:sharpness", level: 5 }],
      durability: { damage: 40, max: 1561 },
    });
    expect(parsed?.hotbar[1]).toEqual({
      item: "minecraft:bread",
      count: 12,
      name: "Ration",
      lore: ["for the road"],
      enchantments: [],
    });
    expect(parsed?.hotbar[2]).toBeNull();
    expect(parsed?.armor.head?.item).toBe("minecraft:iron_helmet");
    expect(parsed?.armor.chest).toBeNull();
    expect(parsed?.cursor).toBeNull();
    expect(parsed?.inventory).toHaveLength(27);
  });

  it("skips an attribute component this game does not have and reports the derived armour values", async () => {
    const query = loadHelper();
    const reply = (await query({ kind: "inventory" })) as { attributes: unknown };
    expect(reply.attributes).toEqual({
      health: { current: 20, min: 0, max: 20, default: 20 },
      saturation: { current: 5, min: 0, max: 20, default: 5 },
      level: { current: 12 },
      experience: { current: 1050 },
      armor: { current: 2 },
      armorToughness: { current: 0 },
    });
  });
});

describe("helper container query", () => {
  it("reads a chest's slots by block position", async () => {
    const query = loadHelper({ chest: [{ typeId: "minecraft:coal", amount: 9 }, { typeId: "minecraft:oak_log", amount: 3 }] });
    const parsed = parseContainer(await query({ kind: "container", x: 1, y: 64, z: -2 }));
    expect(parsed).toEqual({
      block: "minecraft:chest",
      size: 2,
      slots: [
        { item: "minecraft:coal", count: 9, enchantments: [] },
        { item: "minecraft:oak_log", count: 3, enchantments: [] },
      ],
    });
  });

  it("names a block that has no container", async () => {
    const query = loadHelper();
    await expect(query({ kind: "container", x: 4, y: 64, z: -2 })).rejects.toThrow(/minecraft:stone at 4 64 -2 has no container/);
  });
});
