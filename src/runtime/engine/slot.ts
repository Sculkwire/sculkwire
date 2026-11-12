/**
 * One inventory slot as every engine answer carries it (the player's inventory, a container, a screen's containers, a
 * trade offer): parsed before it is trusted. A slot's id is namespaced, a count is a whole number, a damage is clamped
 * into its own maximum.
 */
import { z } from "zod";
import { finiteOrUndefined, integerOrUndefined, isPlainObject } from "./wire.ts";

/** One enchantment on an item: the game's `minecraft:` id and its level (1 = I). */
export interface ItemEnchantment {
  id: string;
  level: number;
}

/** A durability-bearing item: `damage` points taken out of `max`. */
export interface ItemDurability {
  damage: number;
  max: number;
}

/**
 * One inventory slot's contents. `item` is always namespaced; `enchantments` is always present (empty when the item
 * has none) so a reader never has to tell "no enchantments" from "not reported". `contents` holds what is inside a
 * bundle or a shulker box, when the engine can read it.
 */
export interface ItemSlot {
  item: string;
  count: number;
  data?: number;
  name?: string;
  durability?: ItemDurability;
  enchantments: ItemEnchantment[];
  lore?: string[];
  /** What a bundle or a shulker box item holds, in the slot shape the contract uses everywhere; an empty slot is null. */
  contents?: Slot[];
}

/** A slot, or null when it is empty. */
export type Slot = ItemSlot | null;

/**
 * The slot's output schema, shared by every tool that reports slots. One instance that refers to itself: the JSON
 * Schema conversion finds the cycle by identity and writes a `$ref`. A schema built anew at every level never repeats,
 * and the conversion recurses until the stack overflows.
 */
export const itemSlotSchema: z.ZodType<ItemSlot> = z.lazy(() =>
  z.object({
    item: z.string(),
    count: z.number(),
    data: z.number().optional(),
    name: z.string().optional(),
    durability: z.object({ damage: z.number(), max: z.number() }).optional(),
    enchantments: z.array(z.object({ id: z.string(), level: z.number() })),
    lore: z.array(z.string()).optional(),
    contents: z.array(itemSlotSchema.nullable()).optional(),
  }),
);

/** `minecraft:` for an id written without a namespace of its own (`oak_planks`). */
export function itemId(raw: string): string {
  const id = raw.trim();
  return id.includes(":") ? id : `minecraft:${id}`;
}

/** An item id on a command line or in a grid, or undefined when it is empty. */
export function itemName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const id = raw.trim();
  return id ? itemId(id) : undefined;
}

function durabilityOf(raw: unknown): ItemDurability | undefined {
  if (!isPlainObject(raw)) return undefined;
  const damage = finiteOrUndefined(raw.damage);
  const max = finiteOrUndefined(raw.max);
  // A maximum is what gives damage meaning; without it the pair is not reported.
  if (damage === undefined || max === undefined || max < 1) return undefined;
  return { damage: Math.min(Math.max(0, Math.round(damage)), Math.round(max)), max: Math.round(max) };
}

/**
 * Bedrock's numeric enchantment ids (the order the game keeps in item data and the network protocol), indexed by
 * id. The names are the Script API's `minecraft:` enchantment type ids.
 */
const ENCHANTMENT_IDS = [
  "protection", "fire_protection", "feather_falling", "blast_protection", "projectile_protection", "thorns",
  "respiration", "depth_strider", "aqua_affinity", "sharpness", "smite", "bane_of_arthropods", "knockback",
  "fire_aspect", "looting", "efficiency", "silk_touch", "unbreaking", "fortune", "power", "punch", "flame",
  "infinity", "luck_of_the_sea", "lure", "frost_walker", "mending", "binding", "vanishing", "impaling", "riptide",
  "loyalty", "channeling", "multishot", "piercing", "quick_charge", "soul_speed", "swift_sneak", "wind_burst",
  "density", "breach",
] as const;

/** A numeric enchantment id's name; an id past the table reads `minecraft:unknown_<n>` so the level is not lost. */
export function enchantmentName(id: number): string {
  return `minecraft:${ENCHANTMENT_IDS[id] ?? `unknown_${id}`}`;
}

/**
 * The game's enchantment shape (`{id, level}`, `id` numeric or a name), and the Script API's (`{type: {id}, level}`).
 */
export function enchantmentsOf(raw: unknown): ItemEnchantment[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return undefined;
  const out: ItemEnchantment[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const numeric = typeof entry.id === "number" ? integerOrUndefined(entry.id) : undefined;
    const id =
      numeric !== undefined && numeric >= 0
        ? enchantmentName(numeric)
        : (itemName(entry.id) ??
          (typeof entry.type === "string" ? itemName(entry.type) : isPlainObject(entry.type) ? itemName(entry.type.id) : undefined));
    if (!id) continue;
    const level = integerOrUndefined(entry.level) ?? 1;
    out.push({ id, level: Math.max(1, level) });
  }
  return out;
}

function loreOf(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((line): line is string => typeof line === "string" && line.length > 0);
}

/** A slot: null is empty, undefined is a shape this client cannot read. */
export function parseSlot(raw: unknown): Slot | undefined {
  if (raw === null) return null;
  if (!isPlainObject(raw)) return undefined;
  const item = itemName(raw.item);
  if (!item) return undefined;
  const count = raw.count === undefined ? 1 : integerOrUndefined(raw.count);
  if (count === undefined || count < 1) return undefined;
  const enchantments = enchantmentsOf(raw.enchantments);
  const durability = durabilityOf(raw.durability);
  const lore = loreOf(raw.lore);
  if (!enchantments || !lore) return undefined;
  const slot: ItemSlot = { item, count, enchantments };
  const data = integerOrUndefined(raw.data);
  if (data !== undefined && data >= 0) slot.data = data;
  if (typeof raw.name === "string" && raw.name.trim()) slot.name = raw.name;
  if (durability) slot.durability = durability;
  if (lore.length) slot.lore = lore;
  if (raw.contents !== undefined) {
    const contents = parseSlots(raw.contents);
    if (!contents) return undefined;
    slot.contents = contents;
  }
  return slot;
}

export function parseSlots(raw: unknown): Slot[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Slot[] = [];
  for (const entry of raw) {
    const slot = parseSlot(entry);
    if (slot === undefined) return undefined;
    out.push(slot);
  }
  return out;
}
