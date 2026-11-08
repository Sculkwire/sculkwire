/**
 * Fighting a group the way a player does: hit the closest mob (or the one that is hitting you), back off to the
 * side so the others line up in front instead of walking around you, and only jump for critical hits when the
 * target is alone. Pure functions, so the fight loop and the tests share them.
 */
import { angleDiff, horizontalDistance, yawTo, type Vec3 } from "../player.ts";
import { escapeYaw } from "./flee.ts";

export interface Mob {
  id: string;
  location: Vec3;
  /** Type id, so a creeper can be told apart. */
  typeId?: string;
}

/** Others this close count as part of the fight. */
export const CROWD_RADIUS = 5;
/** An other more than this many degrees off the line to the target is flanking (getting beside or behind). */
export const FLANK_DEG = 70;
/** Switch to a mob that is this much closer than the target. */
const SWITCH_CLOSER = 0.8;
/** A mob this close while the player is getting hurt is the one hitting: switch to it. */
const HITTING_RANGE = 2.5;
/** No crits with another mob this close: the jump lets it hit freely. */
export const ISOLATED_RADIUS = 4;
/** A creeper this close comes first: only the creeper footwork keeps its fuse from finishing. */
export const CREEPER_FIRST = 5;
/** A creeper target is kept while it is this close, even with others nearer (its fuse burns until the player is past 7). */
const CREEPER_KEEP = 7.5;

/**
 * The mob to fight now: a creeper within `CREEPER_FIRST` (or one whose fuse burns, `lit`, within `CREEPER_KEEP`)
 * before anything else, a creeper target kept as long; else the current target, unless another is clearly closer,
 * or the player is getting hurt and another is within hitting range and closer than the target. An unlit creeper
 * farther out is not kept: backing off from the zombies in front of it would never end.
 */
export function pickDuelTarget(me: Vec3, currentId: string, mobs: readonly Mob[], hurt: boolean, lit: ReadonlySet<string> = new Set()): string {
  const dist = (m: Mob) => horizontalDistance(me, m.location);
  const current = mobs.find((m) => m.id === currentId);
  const creeper = (m: Mob) => m.typeId === "minecraft:creeper";
  const first = (m: Mob) => creeper(m) && dist(m) < (lit.has(m.id) ? CREEPER_KEEP : CREEPER_FIRST);
  if (current && first(current)) return currentId;
  const near = mobs.filter(first).sort((a, b) => dist(a) - dist(b))[0];
  if (near) return near.id;
  const closest = [...mobs].sort((a, b) => dist(a) - dist(b))[0];
  if (!closest || !current || closest.id === currentId) return current ? currentId : (closest?.id ?? currentId);
  const dc = dist(current);
  const dn = dist(closest);
  if (dn < dc - SWITCH_CLOSER) return closest.id;
  if (hurt && dn < HITTING_RANGE && dn < dc) return closest.id;
  return currentId;
}

/** The target fights alone: no other mob within `ISOLATED_RADIUS` of the player. */
export function isolated(me: Vec3, targetId: string, mobs: readonly Mob[]): boolean {
  return !mobs.some((m) => m.id !== targetId && horizontalDistance(me, m.location) < ISOLATED_RADIUS);
}

export interface CrowdMove {
  /** World yaw to walk toward (the view stays on the target). */
  heading: number;
  /** `flanked`: a mob is beside or behind, get them all in front. `kite`: back off to the side away from the group. */
  reason: "flanked" | "kite";
}

/**
 * Where to step with other mobs around: away from all of them when one is beside or behind the player (so they
 * end up in front), else backward and to the side opposite the group, so they come at the player one after another
 * along the line of sight. Undefined when no other mob is near.
 */
export function crowdMove(me: Vec3, target: Mob, mobs: readonly Mob[]): CrowdMove | undefined {
  const others = mobs.filter((m) => m.id !== target.id && horizontalDistance(me, m.location) < CROWD_RADIUS);
  if (others.length === 0) return undefined;
  const toward = yawTo(me, target.location);
  // + is clockwise from the line to the target, to the player's right.
  const offsets = others.map((m) => angleDiff(toward, yawTo(me, m.location)));
  if (offsets.some((a) => Math.abs(a) > FLANK_DEG)) {
    const away = escapeYaw(me, [target, ...others].map((m) => ({ location: m.location, weight: 1 })));
    return { heading: away ?? toward + 180, reason: "flanked" };
  }
  const mean = offsets.reduce((s, a) => s + a, 0) / offsets.length;
  // Back-left (toward + 225) when the group is on the right, back-right (toward + 135) when it is on the left.
  return { heading: toward + 180 + (mean >= 0 ? 45 : -45), reason: "kite" };
}
