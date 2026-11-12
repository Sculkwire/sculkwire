/** Weapons, food and armor as the skills rank them (Bedrock values). */
import { shortType } from "./mobs.ts";

/** Melee damage of a held item; anything not listed hits like a fist (1). */
const WEAPON_DAMAGE: Record<string, number> = {
  wooden_sword: 4,
  golden_sword: 4,
  stone_sword: 5,
  iron_sword: 6,
  diamond_sword: 7,
  netherite_sword: 8,
  wooden_axe: 3,
  golden_axe: 3,
  stone_axe: 4,
  iron_axe: 5,
  diamond_axe: 6,
  netherite_axe: 7,
  trident: 8,
  mace: 6,
};

/** Hunger points a food restores. Raw chicken, rotten flesh and similar come last because of their effects. */
export const FOOD: Record<string, { nutrition: number; risky?: boolean; always?: boolean }> = {
  cooked_beef: { nutrition: 8 },
  cooked_porkchop: { nutrition: 8 },
  pumpkin_pie: { nutrition: 8 },
  rabbit_stew: { nutrition: 10 },
  cooked_mutton: { nutrition: 6 },
  cooked_chicken: { nutrition: 6 },
  cooked_salmon: { nutrition: 6 },
  golden_carrot: { nutrition: 6 },
  mushroom_stew: { nutrition: 6 },
  beetroot_soup: { nutrition: 6 },
  bread: { nutrition: 5 },
  baked_potato: { nutrition: 5 },
  cooked_cod: { nutrition: 5 },
  cooked_rabbit: { nutrition: 5 },
  apple: { nutrition: 4 },
  golden_apple: { nutrition: 4, always: true },
  enchanted_golden_apple: { nutrition: 4, always: true },
  carrot: { nutrition: 3 },
  beef: { nutrition: 3 },
  porkchop: { nutrition: 3 },
  rabbit: { nutrition: 3 },
  mutton: { nutrition: 2 },
  cookie: { nutrition: 2 },
  melon_slice: { nutrition: 2 },
  sweet_berries: { nutrition: 2 },
  potato: { nutrition: 1 },
  chicken: { nutrition: 2, risky: true },
  rotten_flesh: { nutrition: 4, risky: true },
  spider_eye: { nutrition: 2, risky: true },
};

const ARMOR_POINTS: Record<string, readonly [number, number, number, number]> = {
  // helmet, chestplate, leggings, boots
  leather: [1, 3, 2, 1],
  golden: [2, 5, 3, 1],
  chainmail: [2, 5, 4, 1],
  iron: [2, 6, 5, 2],
  diamond: [3, 8, 6, 3],
  netherite: [3, 8, 6, 3],
};
const PIECES = ["helmet", "chestplate", "leggings", "boots"] as const;

type HotbarItem = { typeId: string; amount: number } | null;

export function weaponDamage(typeId: string | undefined): number {
  return typeId ? (WEAPON_DAMAGE[shortType(typeId)] ?? 1) : 1;
}

/** Armor points of worn items (`minecraft:iron_chestplate` …), 0 to 20. */
export function armorPoints(worn: readonly (string | undefined)[]): number {
  let total = 0;
  for (const t of worn) {
    if (!t) continue;
    const name = shortType(t);
    if (name === "turtle_helmet") {
      total += 2;
      continue;
    }
    const [material, piece] = name.split("_") as [string, string];
    const i = PIECES.indexOf(piece as (typeof PIECES)[number]);
    const row = ARMOR_POINTS[material];
    if (row && i >= 0) total += row[i] ?? 0;
  }
  return Math.min(20, total);
}

/** The hotbar slot (1-9) with the hardest-hitting weapon, or undefined when nothing beats a fist. */
export function bestWeaponSlot(hotbar: readonly HotbarItem[]): { slot: number; typeId: string; damage: number } | undefined {
  let best: { slot: number; typeId: string; damage: number } | undefined;
  hotbar.forEach((it, i) => {
    if (!it) return;
    const damage = weaponDamage(it.typeId);
    if (damage > 1 && (!best || damage > best.damage)) best = { slot: i + 1, typeId: it.typeId, damage };
  });
  return best;
}

/**
 * The hotbar slot with the food to eat now: the most filling safe food that does not overfill much, risky food
 * (raw chicken, rotten flesh) only when nothing else is there. Food that needs hunger below 20 is skipped at 20.
 */
export function bestFoodSlot(hotbar: readonly HotbarItem[], hunger = 0): { slot: number; typeId: string; nutrition: number } | undefined {
  const missing = 20 - hunger;
  let best: { slot: number; typeId: string; nutrition: number; rank: number } | undefined;
  hotbar.forEach((it, i) => {
    if (!it) return;
    const food = FOOD[shortType(it.typeId)];
    if (!food || (missing <= 0 && !food.always)) return;
    // Prefer food that fills the gap without much waste; risky food only as a last resort.
    const waste = Math.max(0, food.nutrition - missing);
    const rank = (food.risky ? -100 : 0) + food.nutrition - waste * 1.5;
    if (!best || rank > best.rank) best = { slot: i + 1, typeId: it.typeId, nutrition: food.nutrition, rank };
  });
  return best ? { slot: best.slot, typeId: best.typeId, nutrition: best.nutrition } : undefined;
}

/** The hotbar slot (1-9) of a bow with arrows in the hotbar to shoot, or undefined. */
export function bowSlot(hotbar: readonly HotbarItem[]): { slot: number; arrows: number } | undefined {
  const arrows = hotbar.reduce((n, it) => n + (it && shortType(it.typeId) === "arrow" ? it.amount : 0), 0);
  const i = hotbar.findIndex((it) => it !== null && shortType(it.typeId) === "bow");
  return i >= 0 && arrows > 0 ? { slot: i + 1, arrows } : undefined;
}

/** A shield in the off hand (raised by sneaking). */
export function hasShield(worn: readonly { slot: string; typeId: string }[] | undefined): boolean {
  return (worn ?? []).some((a) => a.slot === "Offhand" && shortType(a.typeId) === "shield");
}
