import { blocks, course } from "./nav-kit.ts";
import type { Vec3 } from "../../player.ts";

const AREA = { radius: 16, height: 8 };

/**
 * A ridge across the whole arena, 3 blocks high: bottom slabs and full blocks in turn up its -z side (half a block
 * per step), oak stairs down its +z side.
 */
function ridge(origin: Vec3): string[] {
  const b = blocks(origin);
  const row = (dz: number, top: number, block?: string) => [
    ...(top >= 0 ? b.fill(-16, 0, dz, 16, top, dz, "stone") : []),
    ...(block ? b.fill(-16, top + 1, dz, 16, top + 1, dz, block) : []),
  ];
  const slab = `smooth_stone_slab ["minecraft:vertical_half"="bottom"]`;
  // Stairs that climb toward -z (their tall back on the -z side).
  const stairs = `oak_stairs ["weirdo_direction"=3]`;
  return [
    ...row(2, -1, slab),
    ...row(3, 0),
    ...row(4, 0, slab),
    ...row(5, 1),
    ...row(6, 1, slab),
    ...row(7, 2),
    ...row(8, 2),
    ...row(9, 2),
    ...row(10, 1, stairs),
    ...row(11, 0, stairs),
    ...row(12, -1, stairs),
  ];
}

export const scenarios = [
  course({
    name: "stairs",
    summary: "up a slab staircase 3 blocks high, down oak stairs",
    area: AREA,
    start: { dx: 0, dy: 0, dz: -4 },
    goal: { dx: 0, dy: 0, dz: 15 },
    build: ridge,
  }),
  course({
    name: "stairs-back",
    summary: "up oak stairs 3 blocks high, down a slab staircase",
    area: AREA,
    start: { dx: 0, dy: 0, dz: 15 },
    yaw: 180,
    goal: { dx: 0, dy: 0, dz: -4 },
    build: ridge,
  }),
];
