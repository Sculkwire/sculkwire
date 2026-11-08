import { blocks, course } from "./nav-kit.ts";

/**
 * A 1-block-wide line of stone pillars 4 high with 2-block gaps between them, from a start platform to an end
 * platform. A fall lands 4 blocks down (fall damage) with no way back up.
 */
export default course({
  name: "parkour",
  summary: "four 2-block gap jumps along 1-wide pillars 4 high",
  area: { radius: 18, height: 8 },
  start: { dx: 0, dy: 4, dz: -1 },
  goal: { dx: 0, dy: 4, dz: 16 },
  timeoutMs: 30_000,
  build: (o) => {
    const b = blocks(o);
    return [
      ...b.fill(-1, 0, -3, 1, 3, 0, "stone"),
      ...[3, 6, 9, 12].flatMap((dz) => b.fill(0, 0, dz, 0, 3, dz, "stone")),
      ...b.fill(-1, 0, 15, 1, 3, 17, "stone"),
    ];
  },
});
