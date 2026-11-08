import { fillBox } from "../arena.ts";
import { combat } from "../kit.ts";

/** Two skeletons across the arena, two stone pillars for cover in between. */
export default combat({
  name: "skeleton2",
  summary: "2 skeletons at night 12 blocks out, two pillars for cover",
  runs: 5,
  goal: "kill all the skeletons",
  mobs: [
    { type: "skeleton", at: { dx: -4, dy: 0, dz: 12 } },
    { type: "skeleton", at: { dx: 4, dy: 0, dz: 12 } },
  ],
  build: (o) => [
    ...fillBox({ x: o.x - 3, y: o.y, z: o.z + 5 }, { x: o.x - 2, y: o.y + 1, z: o.z + 5 }, "minecraft:stone"),
    ...fillBox({ x: o.x + 2, y: o.y, z: o.z + 5 }, { x: o.x + 3, y: o.y + 1, z: o.z + 5 }, "minecraft:stone"),
  ],
});
