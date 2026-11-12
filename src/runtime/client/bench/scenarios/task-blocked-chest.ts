/**
 * The `task` suite: a chest that cannot be used from the side the player walks up to. Run i plays phrasing i. Success
 * is read from the player's inventory after the run.
 *
 * - `blocked-chest`: two blocks of stone stand on the chest's side facing the player's start, so the agent's crosshair
 *   check refuses the use from there; the step has to try the faces and then another spot around the chest.
 * - `blocked-chest-villager`: a villager in a one-block fence pen stands on that side instead.
 * Both have an empty decoy chest two blocks to the side (not touching the wanted one, so it cannot pair with it): a use
 * that opens it must be noticed from `container.open`'s position and not taken for the wanted chest.
 *
 * Assumptions about the game, checked by the parent's live runs: `replaceitem block <xyz> slot.container 0 diamond 1`
 * fills the chest; `summon minecraft:villager ... minecraft:become_farmer` makes an adult villager (`villager_v2` to
 * scripts) and the fence pen keeps it on its block for the length of a run.
 */
import { xyz } from "../../geometry.ts";
import { atLeast, carried, distanceTo, phrased, planExtras } from "../plankit.ts";
import type { BenchContext, Offset, Scenario } from "../types.ts";

const BLOCKED_CHEST_PHRASINGS = [
  "get the diamond from the chest",
  "take the diamond out of the chest",
  "grab the diamond in the chest",
  "fetch the diamond",
  "bring me the diamond from that chest",
  "the chest has a diamond, I want it",
  "loot the diamond",
  "pull the diamond out of the chest over there",
  "retrieve one diamond from the chest",
  "go get that diamond",
];

const AREA = { radius: 10, height: 6 };
const CHEST: Offset = { dx: 0, dy: 0, dz: 4 };
const DECOY: Offset = { dx: 2, dy: 0, dz: 4 };

/** The wanted chest with one diamond and the empty decoy chest. */
function chests(ctx: BenchContext): string[] {
  const chest = xyz(ctx.at(CHEST));
  return [`setblock ${chest} chest`, `replaceitem block ${chest} slot.container 0 diamond 1`, `setblock ${xyz(ctx.at(DECOY))} chest`];
}

const player = { gameMode: "survival" as const, time: "day" as const };

/** Both scenarios read the same: the diamond carried, and how far from the chest the run ended. */
const judged: Pick<Scenario, "measure" | "success"> = {
  measure: async (ctx, o) => ({ ...planExtras(o.play), diamonds: await carried(ctx, "minecraft:diamond"), chestDistance: distanceTo(ctx, o, CHEST) }),
  success: atLeast("diamonds", 1),
};

const byBlock = phrased({
  name: "blocked-chest",
  suite: "task",
  summary: "a chest 4 blocks away with 1 diamond, its side facing the player covered by 2 stone blocks, an empty decoy chest 2 blocks beside it; success: the diamond in the inventory",
  runs: 10,
  timeoutMs: 60_000,
  area: AREA,
  build: (ctx) => [...chests(ctx), `setblock ${xyz(ctx.at({ dx: 0, dy: 0, dz: 3 }))} stone`, `setblock ${xyz(ctx.at({ dx: 0, dy: 1, dz: 3 }))} stone`],
  player,
  goals: BLOCKED_CHEST_PHRASINGS,
  ...judged,
});

const byVillager = phrased({
  name: "blocked-chest-villager",
  suite: "task",
  summary: "a chest 4 blocks away with 1 diamond, a villager penned in fences on its side facing the player, an empty decoy chest 2 blocks beside it; success: the diamond in the inventory",
  runs: 10,
  timeoutMs: 60_000,
  area: AREA,
  build: (ctx) => {
    // The pen: fences west, east and south of the villager's block; the chest closes it on the north.
    const pen: Offset[] = [
      { dx: -1, dy: 0, dz: 3 },
      { dx: 1, dy: 0, dz: 3 },
      { dx: 0, dy: 0, dz: 2 },
    ];
    const v = ctx.at({ dx: 0, dy: 0, dz: 3 });
    // `villager`: the command's name for the entity scripts report as `minecraft:villager_v2` (see `task-phrased.ts`).
    return [...chests(ctx), ...pen.map((o) => `setblock ${xyz(ctx.at(o))} oak_fence`), `summon minecraft:villager ${v.x + 0.5} ${v.y} ${v.z + 0.5} 0 0 minecraft:become_farmer`];
  },
  player,
  goals: BLOCKED_CHEST_PHRASINGS,
  ...judged,
});

export const scenarios = [byBlock, byVillager];
