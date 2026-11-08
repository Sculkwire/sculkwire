import { blocks, course } from "./nav-kit.ts";
import type { BenchContext } from "../types.ts";

const AREA = { radius: 12, height: 6 };
const GOAL = { dx: 0, dy: 0, dz: 8 };

/** Whether the door or gate at an origin-relative block is closed after the run. */
async function closedAfter(ctx: BenchContext, dx: number, dz: number): Promise<{ closedBehind: boolean }> {
  const at = ctx.at({ dx, dy: 0, dz });
  const b = (await ctx.query("block", { ...at })) as { states?: Record<string, unknown> } | null;
  return { closedBehind: b?.states?.["open_bit"] === false };
}

export const scenarios = [
  course({
    name: "gate",
    summary: "through a closed fence gate in a fence across the arena, closing it behind",
    area: AREA,
    goal: GOAL,
    build: (o) => {
      const b = blocks(o);
      return [...b.fill(-12, 0, 4, 12, 0, 4, "oak_fence"), b.set(0, 0, 4, "fence_gate", { direction: 0, open_bit: false })];
    },
    measure: (ctx) => closedAfter(ctx, 0, 4),
    also: (_o, extra) => extra.closedBehind === true,
  }),
  course({
    name: "door",
    summary: "through a closed oak door in a stone wall across the arena, closing it behind",
    area: AREA,
    goal: GOAL,
    build: (o) => {
      const b = blocks(o);
      return [
        ...b.fill(-12, 0, 4, 12, 2, 4, "stone"),
        ...b.fill(0, 0, 4, 0, 1, 4, "air"),
        b.set(0, 0, 4, "wooden_door", { direction: 1, upper_block_bit: false, open_bit: false }),
        b.set(0, 1, 4, "wooden_door", { direction: 1, upper_block_bit: true, open_bit: false }),
      ];
    },
    measure: (ctx) => closedAfter(ctx, 0, 4),
    also: (_o, extra) => extra.closedBehind === true,
  }),
];
