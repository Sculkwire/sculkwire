import type { Vec3 } from "../../player.ts";
import { fillBox } from "../arena.ts";
import { combat } from "../kit.ts";

/**
 * A dead-end pen of stone 3 high around the start: a wall directly behind the player and one block to each side (a
 * 3-wide, 2-deep alcove), open only to the front, toward +z where the player faces.
 */
export function pen(o: Vec3): string[] {
  const stone = (x0: number, z0: number, x1: number, z1: number) => fillBox({ x: o.x + x0, y: o.y, z: o.z + z0 }, { x: o.x + x1, y: o.y + 2, z: o.z + z1 }, "minecraft:stone");
  return [...stone(-1, -1, 1, -1), ...stone(-1, 0, -1, 0), ...stone(1, 0, 1, 0)];
}

/** Three zombies coming at a player who cannot step back: the shield has to take the hits instead of the footwork. */
export default combat({
  name: "cornered",
  summary: "3 zombies at night 8 blocks out, the player in a dead-end stone alcove, iron sword, iron armor, shield, cooked beef",
  runs: 10,
  goal: "kill all the zombies",
  build: pen,
  mobs: [
    { type: "zombie", at: { dx: -2, dy: 0, dz: 8 } },
    { type: "zombie", at: { dx: 0, dy: 0, dz: 8 } },
    { type: "zombie", at: { dx: 2, dy: 0, dz: 8 } },
  ],
});
