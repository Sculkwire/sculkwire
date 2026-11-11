/**
 * The `task` suite: non-combat work at stations as steps of a `play` plan, each intent written ten ways (run i plays
 * phrasing i). Success is read from the player's inventory after the run, not from the plan's own verdict.
 *
 * Assumptions about the game, checked by the parent's live runs:
 * - `trade`: `summon minecraft:villager <x y z> 0 0 minecraft:become_farmer` makes an adult farmer. The command takes
 *   `villager` (its entity enum lists no `villager_v2`; retail 1.26.63 refuses that with a syntax error), and the entity
 *   it makes reports `minecraft:villager_v2` to scripts. In the vanilla `villager_v2.json` the event
 *   `minecraft:become_farmer` adds the `farmer` group (with its `farmer_trades.json` trade table) and `adult` with no
 *   randomizing, and the command's `EntityEvents` list names it. `minecraft:spawn_farmer` does not fix the profession:
 *   it picks farmer, fisherman, shepherd, fletcher or mason at random (a live run got a fletcher). The farmer's first
 *   tier picks one of four buy offers, each 1 emerald for 20 wheat, 26 potatoes, 15 beetroot or 22 carrots; the player
 *   carries 64 of each, so whichever was picked is accepted, and 64 sticks for the fletcher's 32-stick offer as well. A
 *   composter next to the pen is the farmer's job site. `offer` in the run's extras is what the villager offered.
 * - `nested-shulker`: Bedrock commands cannot fill a shulker box item inside a chest (no item NBT in `give` or
 *   `replaceitem`), so `build` places an undyed shulker box above a hopper that feeds the chest below it, fills the box
 *   with `replaceitem block ... slot.container`, and breaks it with `setblock ... air destroy`: the box drops as an item
 *   that keeps its contents, falls into the hopper (glass around it keeps it there) and goes into the chest within a
 *   second, before the run starts.
 */
import { carried, distanceTo, offerText, planExtras } from "../plankit.ts";
import type { Offset, Scenario } from "../types.ts";

export const SMELT_CRAFT_PHRASINGS = [
  "smelt the ore and craft an iron sword",
  "smelt the raw iron, then craft an iron sword",
  "craft an iron sword",
  "make an iron sword",
  "cook the iron and make me a sword out of it",
  "I need an iron sword, use the furnace for the ore",
  "forge an iron sword",
  "turn the raw iron into ingots and build a sword",
  "smelt three raw iron and craft a sword from the ingots",
  "sword time: iron, please",
];

export const TRADE_PHRASINGS = [
  "trade for an emerald",
  "buy an emerald from the villager",
  "trade with the farmer for an emerald",
  "get an emerald from the villager",
  "sell some crops to the farmer",
  "barter with the villager for one emerald",
  "get me an emerald by trading",
  "I'd like an emerald",
  "swap your wheat for an emerald",
  "earn an emerald from the farmer",
];

export const SHULKER_PHRASINGS = [
  "get the diamonds out of the chest",
  "take the 3 diamonds from the chest",
  "grab the diamonds",
  "fetch three diamonds from the shulker box in the chest",
  "bring me the diamonds",
  "retrieve the diamonds from the box inside the chest",
  "the chest has diamonds in it, I want them",
  "pull the diamonds out",
  "empty the shulker box of its diamonds",
  "loot the chest for diamonds",
];

const AREA = { radius: 10, height: 6 };

function xyz(v: { x: number; y: number; z: number }): string {
  return `${Math.floor(v.x)} ${Math.floor(v.y)} ${Math.floor(v.z)}`;
}

const smeltCraft: Scenario = {
  name: "smelt-craft",
  suite: "task",
  summary: "an empty furnace and a crafting table, the player holds 3 raw_iron, 4 coal, 2 sticks; success: an iron_sword in the inventory",
  runs: 10,
  timeoutMs: 120_000,
  area: AREA,
  build: (ctx) => [`setblock ${xyz(ctx.at({ dx: 3, dy: 0, dz: 3 }))} furnace`, `setblock ${xyz(ctx.at({ dx: -3, dy: 0, dz: 3 }))} crafting_table`],
  player: {
    gameMode: "survival",
    time: "day",
    hotbar: [
      { item: "raw_iron", amount: 3 },
      { item: "coal", amount: 4 },
      { item: "stick", amount: 2 },
    ],
  },
  goals: SMELT_CRAFT_PHRASINGS,
  action: () => ({ action: "play", goal: SMELT_CRAFT_PHRASINGS[0] as string, durationMs: 120_000 }),
  measure: async (ctx, o) => ({ ...planExtras(o.play), swords: await carried(ctx, "minecraft:iron_sword") }),
  success: (_o, extra) => typeof extra.swords === "number" && extra.swords >= 1,
};

const VILLAGER: Offset = { dx: 0, dy: 0, dz: 4 };

const trade: Scenario = {
  name: "trade",
  suite: "task",
  summary: "a farmer villager (summoned with minecraft:become_farmer) penned in fences 4 blocks away, the player holds 64 wheat, potatoes, carrots, beetroot and sticks; success: an emerald in the inventory",
  runs: 10,
  timeoutMs: 60_000,
  area: AREA,
  build: (ctx) => {
    // A one-block pen: the villager stays put and the player trades over the fence.
    const pen: Offset[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dz = 3; dz <= 5; dz++) if (dx !== 0 || dz !== 4) pen.push({ dx, dy: 0, dz });
    // The farmer is summoned here, after the clear, with its spawn event (the runner's `mobs` summon has none for villagers).
    const v = ctx.at(VILLAGER);
    return [
      ...pen.map((o) => `setblock ${xyz(ctx.at(o))} oak_fence`),
      `setblock ${xyz(ctx.at({ dx: 2, dy: 0, dz: 4 }))} composter`,
      `summon minecraft:villager ${v.x + 0.5} ${v.y} ${v.z + 0.5} 0 0 minecraft:become_farmer`,
    ];
  },
  player: {
    gameMode: "survival",
    time: "day",
    hotbar: [
      { item: "wheat", amount: 64 },
      { item: "potato", amount: 64 },
      { item: "carrot", amount: 64 },
      { item: "beetroot", amount: 64 },
      // The fletcher's first-tier buy (32 sticks), in case the game picks another profession than the event names.
      { item: "stick", amount: 64 },
    ],
  },
  goals: TRADE_PHRASINGS,
  action: () => ({ action: "play", goal: TRADE_PHRASINGS[0] as string, durationMs: 60_000 }),
  measure: async (ctx, o) => ({
    ...planExtras(o.play),
    emeralds: await carried(ctx, "minecraft:emerald"),
    villagerDistance: distanceTo(ctx, o, VILLAGER),
    offer: offerText(o.play),
  }),
  success: (_o, extra) => typeof extra.emeralds === "number" && extra.emeralds >= 1,
};

const CHEST: Offset = { dx: 0, dy: 0, dz: 4 };

const nestedShulker: Scenario = {
  name: "nested-shulker",
  suite: "task",
  summary: "a chest 4 blocks away holding a shulker box with 3 diamonds; success: 3 diamonds in the inventory",
  runs: 10,
  timeoutMs: 60_000,
  area: AREA,
  build: (ctx) => {
    const c = ctx.at(CHEST);
    const at = (dx: number, dy: number, dz: number) => xyz({ x: c.x + dx, y: c.y + dy, z: c.z + dz });
    return [
      `setblock ${at(0, 0, 0)} chest`,
      // A hopper on the chest facing down (facing_direction 0) feeds it.
      `setblock ${at(0, 1, 0)} hopper ["facing_direction"=0]`,
      // Glass around the box's space so the dropped box falls straight into the hopper.
      `setblock ${at(1, 2, 0)} glass`,
      `setblock ${at(-1, 2, 0)} glass`,
      `setblock ${at(0, 2, 1)} glass`,
      `setblock ${at(0, 2, -1)} glass`,
      `setblock ${at(0, 2, 0)} undyed_shulker_box`,
      `replaceitem block ${at(0, 2, 0)} slot.container 0 diamond 3`,
      `setblock ${at(0, 2, 0)} air destroy`,
    ];
  },
  player: { gameMode: "survival", time: "day" },
  goals: SHULKER_PHRASINGS,
  action: () => ({ action: "play", goal: SHULKER_PHRASINGS[0] as string, durationMs: 60_000 }),
  measure: async (ctx, o) => ({ ...planExtras(o.play), diamonds: await carried(ctx, "minecraft:diamond") }),
  success: (_o, extra) => typeof extra.diamonds === "number" && extra.diamonds >= 3,
};

export const scenarios = [smeltCraft, trade, nestedShulker];
