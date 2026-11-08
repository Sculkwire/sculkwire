import { combat } from "../kit.ts";

/** Two spiders: they leap and climb, so the hits land as they come down. */
export default combat({
  name: "spider2",
  summary: "2 spiders at night 10 blocks out",
  runs: 5,
  goal: "kill all the spiders",
  mobs: [
    { type: "spider", at: { dx: -3, dy: 0, dz: 10 } },
    { type: "spider", at: { dx: 3, dy: 0, dz: 10 } },
  ],
});
