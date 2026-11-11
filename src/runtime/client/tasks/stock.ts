/**
 * What the player and the containers hold, counted per item id: the before/after counts a step's `gained` is measured
 * from, and the screen's container names a step moves items between.
 */
import type { ItemSlot, PlayerInventory, Slot } from "../../engine/inventory.ts";
import type { ScreenSlotRef, ScreenState } from "../../engine/workstation.ts";
import { matches, type Ingredient } from "./recipes.ts";
import type { InventoryCounts } from "./types.ts";

function add(counts: InventoryCounts, slot: Slot | undefined): void {
  if (slot && slot.count > 0) counts[slot.item] = (counts[slot.item] ?? 0) + slot.count;
}

/** Every stack the player has: hotbar, main inventory, armor, off hand and the cursor. */
export function countsOf(inventory: PlayerInventory): InventoryCounts {
  const counts: InventoryCounts = {};
  for (const slot of inventory.hotbar) add(counts, slot);
  for (const slot of inventory.inventory) add(counts, slot);
  for (const slot of Object.values(inventory.armor)) add(counts, slot);
  add(counts, inventory.offhand);
  add(counts, inventory.cursor);
  return counts;
}

/** Counts of the stacks in `slots`, and of the stacks inside the shulker boxes and bundles among them. */
export function countsIn(slots: readonly Slot[], into: InventoryCounts = {}): InventoryCounts {
  for (const slot of slots) {
    add(into, slot);
    if (slot?.contents) countsIn(slot.contents, into);
  }
  return into;
}

/** `after - before` per item, without the zeros. */
export function gainedBetween(before: InventoryCounts, after: InventoryCounts): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const change = (after[id] ?? 0) - (before[id] ?? 0);
    if (change !== 0) out[id] = change;
  }
  return out;
}

/** How many items of the ingredient (an item, or any member of a tag) the counts hold. */
export function countOf(counts: InventoryCounts, ingredient: Ingredient): number {
  let total = 0;
  for (const [id, count] of Object.entries(counts)) if (matches(ingredient, id)) total += count;
  return total;
}

/* -------------------------------------------------------------------------------------------------------------- */
/* Screen containers                                                                                               */
/* -------------------------------------------------------------------------------------------------------------- */

/**
 * The player's own collections in a screen's `containers` (`hotbar_items`, `inventory_items`, `cursor_items`, ...),
 * and the crafting grids, which the agent reads as ranges of the player's UI container.
 */
const PLAYER_KEY = /hotbar|inventory|cursor|armor|offhand|crafting_(input|output)/i;

/**
 * The collection a screen lists for one role: the first key (not one of the player's) that matches `pattern`, else
 * the container enum name the agent maps to the open screen's collection (`FurnaceFuelContainer`).
 */
export function stationKey(state: ScreenState, pattern: RegExp, fallback: string): string {
  return Object.keys(state.containers).find((key) => !PLAYER_KEY.test(key) && pattern.test(key)) ?? fallback;
}

/** The slots of a collection, or [] when the screen does not list it under that key. */
export function slotsOf(state: ScreenState, key: string): Slot[] {
  return state.containers[key] ?? [];
}

/** One stack the player carries, as a screen reference. */
export interface CarriedStack {
  ref: ScreenSlotRef;
  slot: ItemSlot | null;
  /** The hotbar slot 1 to 9 it is, when it is one. */
  hotbar?: number;
}

/**
 * The player's carried slots as the open screen lists them: the hotbar (`hotbar_items`) and the main inventory
 * (`inventory_items`), or the combined collection some screens list instead (hotbar first). A screen that lists
 * none is answered with the enum names `HotbarContainer` and `InventoryContainer` and the inventory's own slots.
 */
export function carriedStacks(state: ScreenState, inventory?: PlayerInventory): CarriedStack[] {
  const keys = Object.keys(state.containers);
  const hotbar = keys.find((key) => /hotbar/i.test(key) && !/combined/i.test(key));
  const main = keys.find((key) => /^inventory_items$/i.test(key)) ?? keys.find((key) => /inventory/i.test(key) && !/combined|hotbar/i.test(key));
  const combined = keys.find((key) => /combined/i.test(key));
  const out: CarriedStack[] = [];
  if (hotbar || main) {
    (hotbar ? slotsOf(state, hotbar) : []).forEach((slot, slotIndex) => out.push({ ref: { container: hotbar ?? "", slot: slotIndex }, slot, hotbar: slotIndex + 1 }));
    (main ? slotsOf(state, main) : []).forEach((slot, slotIndex) => out.push({ ref: { container: main ?? "", slot: slotIndex }, slot }));
    return out;
  }
  if (combined) {
    slotsOf(state, combined).forEach((slot, slotIndex) =>
      out.push({ ref: { container: combined, slot: slotIndex }, slot, ...(slotIndex < 9 ? { hotbar: slotIndex + 1 } : {}) }),
    );
    return out;
  }
  if (!inventory) return out;
  inventory.hotbar.forEach((slot, slotIndex) => out.push({ ref: { container: "HotbarContainer", slot: slotIndex }, slot, hotbar: slotIndex + 1 }));
  inventory.inventory.forEach((slot, slotIndex) => out.push({ ref: { container: "InventoryContainer", slot: slotIndex }, slot }));
  return out;
}

export function refText(ref: ScreenSlotRef): string {
  return `${ref.container}:${ref.slot}`;
}
