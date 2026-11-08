import { blocks, course } from "./nav-kit.ts";
import type { Vec3 } from "../../player.ts";

const AREA = { radius: 16, height: 8 };

/** A pool 3 deep and 10 long across the whole arena, so swimming is the only way over. */
function pool(origin: Vec3): string[] {
  return blocks(origin).fill(-16, -3, 2, 16, -1, 11, "water");
}

export const scenarios = [
  course({
    name: "swim",
    summary: "swim across a 10-block pool 3 deep and climb out the other side",
    area: AREA,
    goal: { dx: 0, dy: 0, dz: 14 },
    build: pool,
  }),
  course({
    name: "swim-dive",
    summary: "drop 3 blocks into a 3-deep pool, surface for air, swim 10 blocks and climb out",
    area: AREA,
    start: { dx: 0, dy: 3, dz: 0 },
    goal: { dx: 0, dy: 0, dz: 14 },
    build: (o) => [...pool(o), ...blocks(o).fill(-1, 0, -2, 1, 2, 1, "stone")],
  }),
];
