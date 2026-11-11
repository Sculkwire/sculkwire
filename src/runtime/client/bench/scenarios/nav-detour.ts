import { blocks, course } from "./nav-kit.ts";

/**
 * A stone wall 61 blocks wide and 3 high across the arena 4 blocks ahead, the goal 12 blocks behind it: the way
 * around starts 31 blocks to either side, past the edge of the first 48 x 48 planning window, so `goto` has to plan
 * again in a wider one.
 */
export default course({
  name: "detour",
  summary: "a stone wall 61 wide 4 blocks ahead, the goal 12 behind it: the way around lies outside the first planning window",
  area: { radius: 36, height: 6 },
  timeoutMs: 60_000,
  goal: { dx: 0, dy: 0, dz: 16 },
  build: (o) => blocks(o).fill(-30, 0, 4, 30, 2, 4, "stone"),
});
