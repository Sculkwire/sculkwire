import { blocks, course } from "../navkit.ts";

/**
 * A mixed course across the whole arena: two one-block steps up onto a ledge 3 high, a 3-block drop, a water
 * channel 1 deep, and a fence with a closed gate off to one side.
 */
export default course({
  name: "course",
  summary: "steps up 3, drop 3, water channel, fence gate off to the side",
  area: { radius: 18, height: 8 },
  start: { dx: 0, dy: 0, dz: -2 },
  goal: { dx: 0, dy: 0, dz: 17 },
  build: (o) => {
    const b = blocks(o);
    return [
      ...b.fill(-18, 0, 2, 18, 0, 2, "stone"),
      ...b.fill(-18, 0, 3, 18, 1, 3, "stone"),
      ...b.fill(-18, 0, 4, 18, 2, 5, "stone"),
      ...b.fill(-18, -1, 9, 18, -1, 11, "water"),
      ...b.fill(-18, 0, 14, 18, 0, 14, "oak_fence"),
      b.set(5, 0, 14, "fence_gate", { direction: 0, open_bit: false }),
    ];
  },
});
