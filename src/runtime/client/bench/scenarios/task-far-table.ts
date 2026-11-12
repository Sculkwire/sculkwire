/**
 * A station beyond the first lookup: the only crafting table stands 30 blocks from the player, outside the helper's
 * 16-block `blocks` cube around it, so the craft finds it in the cubes around that one (`tasks/search.ts`). Each run
 * plays one phrasing; success is read from the player's inventory.
 */
import { xyz } from "../../geometry.ts";
import { atLeast, carried, distanceTo, phrased, planExtras } from "../plankit.ts";
import type { Offset } from "../types.ts";

const FAR_TABLE_PHRASINGS = [
  "craft a wooden pickaxe",
  "make a wooden pickaxe",
  "I need a wooden pickaxe",
  "build me a wood pickaxe",
  "craft a pickaxe out of the planks",
  "use the crafting table to make a wooden pickaxe",
  "get a wooden pickaxe made at the crafting table over there",
  "make me a pickaxe from wood",
  "wooden pickaxe, please",
  "turn the planks into a wooden pickaxe",
];

const TABLE: Offset = { dx: 0, dy: 0, dz: 30 };

const farTable = phrased({
  name: "far-table",
  suite: "task",
  summary: "a crafting table 30 blocks away, the player holds 8 oak planks; success: a wooden_pickaxe in the inventory",
  runs: 10,
  timeoutMs: 120_000,
  area: { radius: 34, height: 6 },
  build: (ctx) => [`setblock ${xyz(ctx.at(TABLE))} crafting_table`],
  player: { gameMode: "survival", time: "day", hotbar: [{ item: "oak_planks", amount: 8 }] },
  goals: FAR_TABLE_PHRASINGS,
  measure: async (ctx, o) => ({ ...planExtras(o.play), pickaxes: await carried(ctx, "minecraft:wooden_pickaxe"), tableDistance: distanceTo(ctx, o, TABLE) }),
  success: atLeast("pickaxes", 1),
});

export default farTable;
