/**
 * Using a block or an entity from where the player can: the faces of a block the eye is on the side of, the standing
 * spots around a target within reach, and the caps on how long one target is tried. The agent's own pick (the
 * crosshair check `interact.block` makes before it uses anything) is the only occlusion truth; these helpers only
 * choose what to try next.
 */
import type { BlockFace } from "../../engine/workstation.ts";
import type { Vec3 } from "../player.ts";
import type { BlockInfo } from "./types.ts";

/** The player's eye above the feet (Bedrock, standing). */
export const EYE_HEIGHT = 1.62;
/** Uses tried on one block or one entity, over every spot and face, before the next one is tried. */
export const USES_PER_TARGET = 12;
/** Time spent on one target (walks between spots included) before the next one is tried. */
export const MS_PER_TARGET = 30_000;
/** Standing spots tried around one target besides the one the player walked to. */
export const SPOTS_PER_TARGET = 4;
/** Spots are looked for within this many blocks (horizontally) of the target's cell. */
export const SPOT_RADIUS = 2;
/** Arrive this close to a spot's center: the spot itself, not the next one. */
export const SPOT_ARRIVE = 0.4;

export function cellOf(at: Vec3): Vec3 {
  return { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) };
}

export function sameCell(a: Vec3, b: Vec3): boolean {
  return Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.y) === Math.floor(b.y) && Math.floor(a.z) === Math.floor(b.z);
}

/** The faces of the block cell the eye is outside of (the agent refuses a face the eye is not on the side of). */
export function facesToward(eye: Vec3, cell: Vec3): BlockFace[] {
  const out: BlockFace[] = [];
  if (eye.y > cell.y + 1) out.push("up");
  if (eye.y < cell.y) out.push("down");
  if (eye.z < cell.z) out.push("north");
  if (eye.z > cell.z + 1) out.push("south");
  if (eye.x < cell.x) out.push("west");
  if (eye.x > cell.x + 1) out.push("east");
  return out;
}

/**
 * Feet cells around `target` (a block or entity cell) within `SPOT_RADIUS` horizontally, on the target's level and
 * one up or down, nearest to the player first. The player's own cell and the target's cell are left out.
 */
export function spotCandidates(target: Vec3, player: Vec3): Vec3[] {
  const t = cellOf(target);
  const me = cellOf(player);
  const out: Vec3[] = [];
  for (let dx = -SPOT_RADIUS; dx <= SPOT_RADIUS; dx++) {
    for (let dz = -SPOT_RADIUS; dz <= SPOT_RADIUS; dz++) {
      if ((dx === 0 && dz === 0) || Math.hypot(dx, dz) > SPOT_RADIUS) continue;
      for (const dy of [0, -1, 1]) {
        const cell = { x: t.x + dx, y: t.y + dy, z: t.z + dz };
        if (!sameCell(cell, me)) out.push(cell);
      }
    }
  }
  const away = (c: Vec3) => Math.hypot(c.x + 0.5 - player.x, c.y - player.y, c.z + 0.5 - player.z);
  return out.sort((a, b) => away(a) - away(b));
}

/** Blocks the feet and the head pass through. */
const PASSABLE = /(^|:)(air|short_grass|tall_grass|fern|large_fern|snow_layer|torch|.*_carpet|.*_flower|dandelion|poppy)$/;
/** Blocks nothing stands on. */
const NO_FLOOR = /(^|:)(air|water|flowing_water|lava|flowing_lava|.*_fence|.*_wall|.*_fence_gate|.*_carpet|short_grass|tall_grass)$/;

/** Whether a player can stand with the feet in `feet`: two passable cells over a floor. */
export function standable(feet: BlockInfo | null, head: BlockInfo | null, floor: BlockInfo | null): boolean {
  return !!feet && !!head && !!floor && PASSABLE.test(feet.typeId) && PASSABLE.test(head.typeId) && !NO_FLOOR.test(floor.typeId);
}

/** The first clause of the agent's message: what it saw, without the advice that follows. */
export function shortReason(message: string): string {
  return message.split(/; (?=move|walk)/)[0] ?? message;
}
