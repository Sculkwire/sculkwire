/**
 * What the skills know about mobs: whether a mob attacks the player and how. Values are Bedrock's vanilla behavior
 * pack (attack reach, cooldown, collision box, movement speed, ranged attack radius, the creeper's swell distances and
 * fuse).
 *
 * Most melee mobs attack with `minecraft:behavior.melee_box_attack`: their collision box grown by `horizontal_reach`
 * (0.8 by default) on x and z is the attack box, and they hit when it overlaps the target's box. Boxes are axis
 * aligned, so the reach depends on the direction: a zombie (0.6 wide) reaches a player (0.6 wide) 1.4 blocks centre to
 * centre straight along x or z and 1.98 on a diagonal. Between two attacks a mob waits `cooldown_time` (1 s default).
 */

/** Half the player's collision box width. */
export const PLAYER_HALF_WIDTH = 0.3;
/** `melee_box_attack`'s default `horizontal_reach`. */
export const BOX_REACH = 0.8;
/** `melee_box_attack`'s default `cooldown_time`. */
export const MELEE_COOLDOWN_MS = 1000;

export type MobKind = "melee" | "ranged" | "exploder" | "neutral" | "passive";

export interface MobInfo {
  kind: MobKind;
  /** Attacks the player on sight (neutral mobs only when provoked). */
  hostile: boolean;
  /**
   * Ground speed when chasing, in blocks per second: about 10 × its `minecraft:movement` × the attack goal's
   * `speed_multiplier` (a zombie's 0.23 chases at 2.3, measured 2.2 to 2.3 in the bench; a creeper's 0.2 × 1.25 at 2.5).
   */
  speed: number;
  /**
   * How close it must be to hurt the player: the farthest melee reach (centre to centre, on a diagonal for a box
   * attack), the ranged attack radius, or the creeper's swell start.
   */
  range: number;
  /** A full-health hit on the player without armor, in health points (normal difficulty). */
  damage: number;
  /** Climbs walls (spiders), so a pillar or a wall does not stop it. */
  climbs?: boolean;
  /** Collision box width of a mob that attacks with `melee_box_attack` (its reach then depends on the direction). */
  width?: number;
  /** Time between two of its melee attacks. */
  cooldownMs?: number;
  /** Holds an axe: a hit on a raised shield disables the shield for 5 s, so blocking it is worse than backing off. */
  axe?: boolean;
  /** Creeper only: the fuse starts within `range` and stops when the target is farther than this. */
  swellStop?: number;
  /** Creeper only: fuse length in milliseconds. */
  fuseMs?: number;
}

/** Per-axis centre gap below which a box attack of a mob `width` wide reaches the player. */
export function boxReach(width: number, pad = BOX_REACH): number {
  return width / 2 + pad + PLAYER_HALF_WIDTH;
}

/**
 * A melee mob's reach toward the player along the line (dx, dz) from it, centre to centre: the box reach divided by
 * the larger of |cos| and |sin| of the line (a box reaches farthest on a diagonal). `range` for other mobs.
 */
export function meleeReach(info: MobInfo, dx: number, dz: number): number {
  if (info.width === undefined) return info.range;
  const d = Math.hypot(dx, dz);
  const r = boxReach(info.width);
  if (d < 1e-6) return r;
  return r / Math.max(Math.abs(dx), Math.abs(dz)) * d;
}

/** A melee mob; with `width`, a box attack whose `range` is its diagonal reach. */
const melee = (speed: number, damage: number, extra: Partial<MobInfo> = {}): MobInfo => ({
  kind: "melee",
  hostile: true,
  speed,
  range: extra.width !== undefined ? Math.round(boxReach(extra.width) * Math.SQRT2 * 100) / 100 : 2,
  damage,
  cooldownMs: MELEE_COOLDOWN_MS,
  ...extra,
});
const ranged = (speed: number, range: number, damage: number): MobInfo => ({ kind: "ranged", hostile: true, speed, range, damage });

export const MOBS: Record<string, MobInfo> = {
  zombie: melee(2.3, 3, { width: 0.6 }),
  husk: melee(2.3, 3, { width: 0.6 }),
  drowned: melee(2.3, 3, { width: 0.6 }),
  zombie_villager: melee(2.3, 3, { width: 0.6 }),
  zombie_pigman: { kind: "neutral", hostile: false, speed: 2.3, range: 2, damage: 5 },
  zombified_piglin: { kind: "neutral", hostile: false, speed: 2.3, range: 2, damage: 5 },
  skeleton: ranged(2.5, 15, 3),
  stray: ranged(2.5, 15, 3),
  bogged: ranged(2.5, 15, 3),
  pillager: ranged(7, 8, 4),
  witch: ranged(5, 10, 6),
  blaze: ranged(4.6, 16, 5),
  ghast: ranged(3, 64, 9),
  // Swell distances as measured in the game (`CREEPER_START` and `CREEPER_STOP` in defense.ts), not the data's 2.5 and 6.
  creeper: { kind: "exploder", hostile: true, speed: 2.5, range: 3, damage: 30, swellStop: 7, fuseMs: 1500 },
  spider: melee(3, 2, { climbs: true, width: 1.4 }),
  cave_spider: melee(3, 2, { climbs: true, width: 0.7 }),
  enderman: { kind: "neutral", hostile: false, speed: 9, range: 2, damage: 7 },
  vindicator: melee(3.5, 13, { width: 0.6, axe: true }),
  evoker: ranged(5, 12, 6),
  ravager: melee(6, 12),
  slime: melee(4, 4),
  magma_cube: melee(4, 6),
  phantom: melee(9, 6),
  silverfish: melee(2.5, 1, { width: 0.4 }),
  endermite: melee(2.5, 2, { width: 0.4 }),
  piglin_brute: melee(3.5, 13, { width: 0.6, axe: true }),
  hoglin: melee(3.6, 8, { width: 0.6, cooldownMs: 750 }),
  zoglin: melee(2.9, 8, { width: 1.4 }),
  warden: melee(3.6, 30, { width: 0.9 }),
  guardian: ranged(4, 8, 6),
  vex: melee(10, 9),
  breeze: ranged(6, 16, 4),
  wolf: { kind: "neutral", hostile: false, speed: 6, range: 2, damage: 4 },
  iron_golem: { kind: "neutral", hostile: false, speed: 5, range: 2, damage: 21 },
  bee: { kind: "neutral", hostile: false, speed: 6, range: 2, damage: 2 },
  polar_bear: { kind: "neutral", hostile: false, speed: 5, range: 2, damage: 6 },
};

const PASSIVE: MobInfo = { kind: "passive", hostile: false, speed: 2.5, range: 0, damage: 0 };

export function shortType(typeId: string): string {
  return typeId.replace(/^minecraft:/, "");
}

/** What is known about a mob type (`minecraft:zombie` or `zombie`). Unknown types count as passive. */
export function mobInfo(typeId: string): MobInfo {
  return MOBS[shortType(typeId)] ?? PASSIVE;
}

export function isHostile(typeId: string): boolean {
  return mobInfo(typeId).hostile;
}
