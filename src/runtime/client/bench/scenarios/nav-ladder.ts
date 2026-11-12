import { blocks, course } from "../navkit.ts";
import type { Vec3 } from "../../types.ts";

/** A stone tower 6 high and 5 wide with a ladder up its front: the only way up or down without a fall. */
function tower(origin: Vec3): string[] {
  const b = blocks(origin);
  return [...b.fill(-2, 0, 5, 2, 5, 8, "stone"), ...b.fill(0, 0, 4, 0, 5, 4, `ladder ["facing_direction"=2]`)];
}

export const scenarios = [
  course({
    name: "ladder-up",
    summary: "climb a 6-block ladder onto a tower",
    goal: { dx: 0, dy: 6, dz: 6 },
    build: tower,
  }),
  course({
    name: "ladder-down",
    summary: "climb down a 6-block ladder from a tower (a jump would hurt)",
    start: { dx: 0, dy: 6, dz: 7 },
    yaw: 180,
    goal: { dx: 0, dy: 0, dz: 0 },
    build: tower,
  }),
];
