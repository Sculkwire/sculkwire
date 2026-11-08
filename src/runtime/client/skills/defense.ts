/**
 * Defensive melee decisions, as pure functions the fight loop and the tests share: when the next swing is ready,
 * where to stand between swings (hit, step back out of the mob's reach, step in again as the swing comes ready),
 * when to raise the shield, and how to react to a creeper's fuse.
 *
 * Bedrock values: the player reaches 3 blocks; a struck mob ignores hits for 10 ticks; zombies, spiders and most
 * other melee mobs attack with a box reach (see `mobs.ts`, 1.4 to 1.98 blocks for a zombie) at most once a second; a
 * creeper's data says its fuse lights within 2.5 blocks and goes out past 6, but measured in the game (horizontal
 * centre distance, as the fight reads it) it lights at 2.9 and not at 3.1, and still blows when the player is put 6.6
 * blocks away after it lit, but not 7. It blows 1.5 s after lighting with power 3 (damage out to 6 blocks). A raised shield
 * (sneaking with a shield in either hand) blocks melee hits, arrows and explosions from the front half, and an axe
 * hit on it disables it for 5 s.
 */
import { angleDiff, type Vec3 } from "../player.ts";
import { HIT_COOLDOWN_MS } from "./melee.ts";
import type { MobInfo } from "./mobs.ts";

/** Player melee reach, centre of the player to the target's hitbox. */
export const PLAYER_REACH = 3;
/** Extra room kept outside a mob's reach between swings (its lunge, its hitbox and our input latency). */
export const SAFE_MARGIN = 0.9;
/** Input to the game's tick plus the state's age: how late what the fighter does lands. */
export const LATENCY_MS = 120;
/** Backward walking speed, blocks per second (forward sprint is 5.6). */
export const BACKPEDAL_SPEED = 4.3;
/** A creeper blast hurts out to 2 × power blocks. */
export const BLAST_RADIUS = 6;
/** A shield raised this long before the hit lands is up in time. */
export const SHIELD_RAISE_MS = 250;

/**
 * Milliseconds until the next swing can land (0 when ready). Bedrock has no attack-strength cooldown, so every
 * weapon (sword, axe, trident, fist) shares the struck mob's 10-tick invulnerability: a swing before it ends does
 * nothing.
 */
export function readyInMs(now: number, lastHit: number, cooldownMs = HIT_COOLDOWN_MS): number {
  return Math.max(0, lastHit + cooldownMs - now);
}

export type Footwork = "advance" | "hold" | "retreat";

export interface SpacingInput {
  /** Horizontal distance to the target's centre. */
  dist: number;
  /** Milliseconds until our next swing can land. */
  readyInMs: number;
  /** The target's attack reach (centre to centre). */
  mobReach: number;
  /** How fast it closes in, blocks per second (its chase speed when unknown). */
  closing: number;
  /** Milliseconds until the target can attack again (its `cooldown_time` since its last hit), 0 when it can now. */
  mobCoolMs?: number;
  reach?: number;
}

/**
 * Where to go relative to a melee target. While the swing is cooling down, stay out of its reach: back off when it
 * would get in (and be able to attack) before the swing is ready. A mob that has just attacked waits its cooldown, so
 * the player can stand inside its reach until then. Once the swing is (nearly) ready, step in to the edge of our
 * reach, which is longer than a zombie's, so the swing lands first and the knockback pushes it out again.
 */
export function spacing(i: SpacingInput): Footwork {
  const reach = i.reach ?? PLAYER_REACH;
  const safe = i.mobReach + SAFE_MARGIN;
  const closing = Math.max(0.5, i.closing);
  const cool = i.mobCoolMs ?? 0;
  // How long until it can hurt the player: in reach and its attack ready, counting our latency.
  const untilHit = Math.max(((i.dist - i.mobReach) / closing) * 1000, cool) - LATENCY_MS;
  // Close enough to swing as soon as it is ready, without walking into its reach.
  const strike = Math.max(safe - 0.2, reach - 0.3);
  if (i.readyInMs > LATENCY_MS) {
    if (untilHit < i.readyInMs || (i.dist < safe && cool <= i.readyInMs + LATENCY_MS)) return "retreat";
    return "hold";
  }
  return i.dist > strike ? "advance" : "hold";
}

export interface ShieldInput {
  hasShield: boolean;
  /**
   * Nearest melee mob that can hit the player now: distance, reach, closing speed, how far off the view it is
   * (degrees, the shield covers the front half), how long until its attack is ready, and whether it swings an axe.
   */
  melee?: { dist: number; mobReach: number; closing: number; offViewDeg?: number; coolMs?: number; axe?: boolean };
  /** Our next swing (0 when ready). */
  readyInMs: number;
  /** The player is boxed in or failed to get away (a wall behind). */
  cornered?: boolean;
  /** A creeper's fuse: how long until it blows and how far it is. */
  creeper?: { fuseLeftMs: number; dist: number };
}

/** The shield covers attacks from within this many degrees of the view. */
export const SHIELD_ARC_DEG = 90;

/** Time needed to get from `dist` out of the blast by walking backward. */
export function escapeMs(dist: number, speed = BACKPEDAL_SPEED): number {
  return Math.max(0, ((BLAST_RADIUS + 0.5 - dist) / speed) * 1000) + LATENCY_MS;
}

/**
 * Raise the shield when a hit is coming that footwork cannot avoid: a creeper that will blow before the player is
 * out of the blast, or, with the player cornered (it could not back off), a melee mob in front in (or a step from)
 * its reach with its attack ready, while our swing is not ready. A player who can back off does that instead: the
 * bench showed a shield raised 100 to 200 ms before a zombie's hit does not block it, and sneaking slows the player
 * to below a zombie's chase speed. Never against an axe, which disables the shield.
 */
export function shouldBlock(i: ShieldInput): boolean {
  if (!i.hasShield) return false;
  if (i.creeper && i.creeper.dist < BLAST_RADIUS + 0.5 && i.creeper.fuseLeftMs <= escapeMs(i.creeper.dist) + SHIELD_RAISE_MS) return true;
  const m = i.melee;
  if (!m || m.axe) return false;
  if (m.offViewDeg !== undefined && Math.abs(m.offViewDeg) >= SHIELD_ARC_DEG) return false;
  if ((m.coolMs ?? 0) > SHIELD_RAISE_MS + LATENCY_MS) return false;
  const inReach = m.dist <= m.mobReach + 0.3;
  const soon = ((m.dist - m.mobReach) / Math.max(0.5, m.closing)) * 1000 < SHIELD_RAISE_MS;
  return (inReach || soon) && i.readyInMs > SHIELD_RAISE_MS && i.cornered === true;
}

/**
 * Which melee mob just hit the player: the one mob whose reach covers the player (plus `slack` for the state's age),
 * or undefined when none or several could have.
 */
export function whoHit(mobs: readonly { id: string; dist: number; mobReach: number }[], slack = 0.35): string | undefined {
  const could = mobs.filter((m) => m.dist <= m.mobReach + slack);
  return could.length === 1 ? could[0]?.id : undefined;
}

/** A melee mob as the fight sees it: distance and reach (centre to centre), closing speed and its attack cooldown. */
export interface MeleeThreat {
  dist: number;
  mobReach: number;
  /** Blocks per second toward the player. */
  closing: number;
  /** Milliseconds until its attack is ready again. */
  coolMs?: number;
}

/** Milliseconds until a melee mob can hit the player: in its reach (closing at `closing`, at least 0.5) and its attack ready. */
export function untilMobHitMs(m: MeleeThreat): number {
  return Math.max(0, ((m.dist - m.mobReach) / Math.max(0.5, m.closing)) * 1000, m.coolMs ?? 0);
}

/**
 * A jump for a critical hit leaves the player unable to swing this long: the jump's rise (about 300 ms, a swing only
 * counts as critical on the way down) plus the input latency and some slack.
 */
export const CRIT_EXPOSED_MS = 700;

/** Jumping for a critical hit is safe when no melee mob can hit the player before the falling swing. */
export function critSafe(mobs: readonly MeleeThreat[]): boolean {
  return mobs.every((m) => untilMobHitMs(m) > CRIT_EXPOSED_MS);
}

/** `run`: turn away from a burning creeper and sprint out of its fuse range. */
export type CreeperMove = "strike" | "retreat" | "run" | "block" | "approach" | "hold";

export interface CreeperInput {
  /** Centre-to-centre 3D distance. */
  dist: number;
  /** The fuse burns (reported, or estimated from the distance history). */
  lit: boolean;
  /** How long it has burned. */
  fuseMs: number;
  fuseLengthMs?: number;
  readyInMs: number;
  hasShield: boolean;
  /** How fast it walks in, blocks per second (0 or less when it stands or moves away). */
  closing?: number;
  reach?: number;
  /** Already turned away and sprinting from its fuse: no turning back for a strike. */
  running?: boolean;
}

/** Sprinting speed, blocks per second: a burning creeper is outrun facing away from it. */
export const SPRINT_SPEED = 5.6;
/** Turning the camera around (away from the creeper, or back to it for the shield). */
export const TURN_MS = 150;
/**
 * A creeper walking in is struck this many seconds ahead: the swing lands about a tick after it is sent, and the
 * streamed reading is already carried forward to now (KeyboardFix's engine bench with 25 ms readings: the old 0.15 s
 * lead, sized for 200 to 250 ms old readings, sent every swing 0.4 blocks early and missed 35 of 35). One that comes
 * within 3 blocks stops and lights its fuse.
 */
export const STRIKE_LEAD_S = 0.06;

/**
 * The creeper lights its fuse within this (measured: a creeper held still lit with the player 2.9 blocks away and not
 * at 3.1, and a creeper walking in stopped to swell at a reading of 2.87). The data's `inside_range` is 2.5.
 */
export const CREEPER_START = 3;
/** Its fuse goes out once the player is farther than this (measured: still burning at 6.6, out at 7; data: 6). */
export const CREEPER_STOP = 7;
/** Positions the fight reads are 50 to 150 ms old, and a creeper closes at 2.5 blocks a second. */
export const CREEPER_MARGIN = 0.3;
/**
 * Against a creeper alone the footwork lets it come to this reading before backing off: it lights a little farther
 * out, but the strike lands first (a struck creeper is thrown back), and the bench saw no blasts in 10 runs with it.
 */
export const CREEPER_STRIKE_FLOOR = 2.8;

/** A creeper closing in faster than this is walking, so it is not swelling (the swell goal holds it still). */
export const CREEPER_WALKING = 1.2;
/**
 * A creeper that came within `CREEPER_START + CREEPER_MARGIN` this recently and now stands still has lit its fuse,
 * even with the player already farther away (backing off while it swelled).
 */
export const CREEPER_CLOSE_MEMORY_MS = 900;

/**
 * Whether the fuse is (taken as) burning after this reading: lit by the helper; else not while the creeper walks
 * toward the player (`closing`, blocks per second); else lit inside `CREEPER_STRIKE_FLOOR`; else, standing (not
 * walking in nor thrown back by a hit), lit within its start range now or in the last `CREEPER_CLOSE_MEMORY_MS`
 * (`closeMsAgo`); else burning before and not far enough yet.
 */
export function creeperLit(wasLit: boolean, dist: number, closing: number, ignited?: boolean, closeMsAgo = Number.POSITIVE_INFINITY): boolean {
  if (ignited) return true;
  if (closing > CREEPER_WALKING) return false;
  if (dist <= CREEPER_STRIKE_FLOOR) return true;
  if (closing >= -CREEPER_WALKING && (dist <= CREEPER_START + CREEPER_MARGIN || closeMsAgo <= CREEPER_CLOSE_MEMORY_MS)) return true;
  return wasLit && dist <= CREEPER_STOP + CREEPER_MARGIN;
}

/** What the fight remembers of one creeper's fuse (times on the hands' clock). */
export interface FuseMemory {
  /** The last reading within `CREEPER_START + CREEPER_MARGIN` (not thrown back), cleared by a hit. */
  closeAt?: number;
  /** When the fuse was taken as lit. */
  fuseSince?: number;
  /** Since when it has stood still (neither walking in nor moving away). */
  stillSince?: number;
  /** When the player last struck it (cleared once it walks back in, so the strike did not light it). */
  struckAt?: number;
}

/** A creeper fuse lasts 1.5 s; one taken as lit this much longer ago that has not blown was not lit. */
export const FUSE_OVERDUE_MS = 700;
/**
 * A creeper with a target always walks at it, unless its fuse burns (the swell goal holds it). So one that stands
 * still this long within its fuse's reach is taken as lit, and one within `STILL_NEAR` at once (the bench saw
 * creepers stop to light at readings of 3.1 to 3.6). Readings are up to 250 ms stale, so a creeper's walk counts
 * only this long after a strike.
 */
export const STILL_LIT_MS = 300;
export const STILL_NEAR = 4.5;
/** How old a reading is, on average: a stop or close reading seen now happened about this long ago. */
export const READING_AGE_MS = 150;

/**
 * Update a creeper's fuse memory from one reading (`dist` centre to centre, `closing` in blocks per second toward the
 * player, `speed` its horizontal speed when known). When the helper reports the fuse (`ignited` true or false, and
 * `burnedMs` how long it has burned by `now`), that is the answer. Otherwise it is guessed: a close reading counts
 * unless the creeper is being thrown back by a hit. A strike counts as lighting it (the bench saw strikes land as the
 * creeper came within 3 blocks and light it, which then stood where the knockback left it and blew) until it walks
 * back in. The fuse is taken as lit since the earliest of the strike, the close reading and the stop. Returns whether
 * the fuse burns.
 */
export function trackFuse(f: FuseMemory, now: number, dist: number, closing: number, ignited?: boolean, fuseMs = 1500, speed = Math.abs(closing), burnedMs?: number): boolean {
  if (ignited === false || (ignited && burnedMs !== undefined)) {
    delete f.closeAt;
    delete f.stillSince;
    if (ignited) f.fuseSince = now - (burnedMs ?? 0);
    else delete f.fuseSince;
    return ignited;
  }
  if (f.fuseSince !== undefined && now - f.fuseSince > fuseMs + FUSE_OVERDUE_MS) {
    delete f.fuseSince;
    delete f.closeAt;
    delete f.stillSince;
  }
  if (speed <= CREEPER_WALKING) f.stillSince ??= now;
  else delete f.stillSince;
  if (dist <= CREEPER_START + CREEPER_MARGIN && closing >= -CREEPER_WALKING) f.closeAt = now;
  const sinceStrike = f.struckAt === undefined ? Number.POSITIVE_INFINITY : now - f.struckAt;
  if (sinceStrike >= fuseMs || (sinceStrike > STILL_LIT_MS && closing > CREEPER_WALKING)) delete f.struckAt;
  const closeMsAgo = f.closeAt === undefined ? Number.POSITIVE_INFINITY : now - f.closeAt;
  const still = f.stillSince !== undefined && now - f.stillSince >= (dist <= STILL_NEAR ? 0 : STILL_LIT_MS) && dist <= CREEPER_STOP + CREEPER_MARGIN;
  if (f.struckAt !== undefined || still || creeperLit(f.fuseSince !== undefined, dist, closing, ignited, closeMsAgo)) {
    const seen = [f.stillSince, closeMsAgo <= CREEPER_CLOSE_MEMORY_MS ? f.closeAt : undefined].map((t) => (t === undefined ? t : t - READING_AGE_MS));
    const since = [...seen, f.struckAt].filter((t): t is number => t !== undefined && t > now - fuseMs);
    f.fuseSince ??= since.length > 0 ? Math.min(...since) : now - READING_AGE_MS;
  } else delete f.fuseSince;
  return f.fuseSince !== undefined;
}

/**
 * Against a creeper with other melee mobs around: one of them is in the way (nearer than the creeper) or within 1.5
 * blocks of its reach. Then walking up to the creeper means walking into their hits, so the player backs off instead.
 */
export function crowdedCreeper(near: readonly { id: string; dist: number; mobReach: number }[], creeperId: string, creeperDist: number): boolean {
  return near.some((n) => n.id !== creeperId && (n.dist < creeperDist || n.dist < n.mobReach + 1.5));
}

/**
 * A burning creeper this far out or farther is outrun, never shielded against: the blast does little there (power 3
 * reaches 6 blocks), and sneaking behind the shield (1.3 blocks a second) gives up the chance to get past 7 blocks
 * before the fuse ends, which would put it out.
 */
export const SHIELD_WITHIN = 5;

/**
 * A burning creeper in reach is still struck while this much fuse is left: the knockback throws it 2 to 3 blocks, and
 * the turn and sprint from there take about this long to get out of the blast.
 */
export const LIT_STRIKE_LEFT_MS = 700;

/**
 * Against a creeper: close in and strike it as it comes into reach (`STRIKE_LEAD_S` ahead, the sprint knockback
 * throws it back), and back off only while the swing cools down with it in reach, or once its fuse burns (the
 * helper's report). A burning creeper still in reach with the swing ready is struck first, the knockback gaining the
 * run a few blocks, while enough fuse is left. Then turn away and sprint out past 7 blocks, which puts the fuse out.
 * Only when that can no longer work before the blast and the creeper is within `SHIELD_WITHIN`, raise the shield
 * toward it: the shield saves the player, but the creeper still blows up (a lost kill, and the blast hurts the other
 * mobs around).
 */
export function creeperMove(i: CreeperInput): CreeperMove {
  const reach = i.reach ?? PLAYER_REACH;
  const left = (i.fuseLengthMs ?? 1500) - i.fuseMs;
  const strike = i.readyInMs <= LATENCY_MS && i.dist - Math.max(0, i.closing ?? 0) * STRIKE_LEAD_S <= reach + 0.2;
  if (i.lit) {
    if (i.dist > CREEPER_STOP + CREEPER_MARGIN) return "hold";
    if (strike && !i.running && left > LIT_STRIKE_LEFT_MS) return "strike";
    if (i.hasShield && i.dist < SHIELD_WITHIN && left < Math.max(escapeMs(i.dist, SPRINT_SPEED), SHIELD_RAISE_MS + LATENCY_MS) + TURN_MS) return "block";
    return "run";
  }
  if (strike) return "strike";
  if (i.readyInMs > LATENCY_MS) return i.dist < reach + 0.6 ? "retreat" : "hold";
  return "approach";
}

/** Grid classes a body can stand in (`u`: not fetched yet, taken as open). */
function open(c: string): boolean {
  return c === "." || c === "u";
}

/**
 * How far (blocks, up to `max`) the player can run from `me` toward `yaw` on level ground: feet and head free
 * across the body's width, something solid under the feet (no hole, no water or lava). A wall, a hole or a pool ends
 * the run.
 */
export function clearRun(grid: CoverGrid, me: Vec3, yaw: number, max = 6): number {
  const r = (yaw * Math.PI) / 180;
  const dx = -Math.sin(r);
  const dz = Math.cos(r);
  const fy = Math.floor(me.y + 0.01);
  for (let d = 0.5; d <= max; d += 0.5) {
    // The middle and both sides of the 0.6-wide body.
    for (const side of [0, -0.3, 0.3]) {
      const x = Math.floor(me.x + dx * d - dz * side);
      const z = Math.floor(me.z + dz * d + dx * side);
      const ground = grid.at(x, fy - 1, z);
      if (!open(grid.at(x, fy, z)) || !open(grid.at(x, fy + 1, z)) || ground === "." || ground === "w" || ground === "L") return d - 0.5;
    }
  }
  return max;
}

export interface HeadingInput {
  me: Vec3;
  /** Where the player wants to go (world yaw): away from a burning creeper, back and aside from a group. */
  desired: number;
  /** Headings up to this many degrees off `desired` are tried, every 15 degrees. */
  spreadDeg: number;
  /**
   * Mobs to stay clear of on the way, each by `clearance` blocks (default `PATH_CLEARANCE`; a creeper being run from
   * too, so the run never passes it).
   */
  mobs: readonly { location: Vec3; clearance?: number }[];
  /** Free run toward a heading (`clearRun` on the nav grid). */
  clear: (yaw: number) => number;
  /** The heading picked last frame: kept unless another is clearly better, so the run does not zigzag. */
  previous?: number;
  horizon?: number;
}

/** Closest horizontal distance from `p` to the segment `a`-`b`. */
function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const len2 = vx * vx + vz * vz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / len2)) : 0;
  return Math.hypot(p.x - a.x - vx * t, p.z - a.z - vz * t);
}

/** A mob this close to the way counts against it (a zombie's reach plus a step). */
export const PATH_CLEARANCE = 2.2;

/**
 * The heading to move along: the one that gets farthest along `desired` within the next `horizon` blocks, with the
 * free run cut short by walls, holes and water, and taking off for every mob near the way (so the player strafes
 * around a zombie instead of into it) and for a run blocked within a block and a half.
 */
export function openHeading(i: HeadingInput): number {
  const horizon = i.horizon ?? 6;
  let best = { yaw: i.desired, score: Number.NEGATIVE_INFINITY };
  for (let off = -i.spreadDeg; off <= i.spreadDeg; off += 15) {
    const yaw = i.desired + off;
    const run = Math.min(horizon, i.clear(yaw));
    const r = (yaw * Math.PI) / 180;
    const end = { x: i.me.x - Math.sin(r) * run, y: i.me.y, z: i.me.z + Math.cos(r) * run };
    let score = run * Math.cos((off * Math.PI) / 180) - Math.abs(off) / 360;
    if (run < 1.5) score -= 4;
    for (const m of i.mobs) {
      const d = segmentDistance(m.location, i.me, end);
      const keep = m.clearance ?? PATH_CLEARANCE;
      if (d < keep) score -= (keep - d) * 2.5;
    }
    if (i.previous !== undefined && Math.abs(angleDiff(i.previous, yaw)) <= 20) score += 0.5;
    if (score > best.score) best = { yaw, score };
  }
  return best.yaw;
}

/** A ranged mob is shooting: weave this many degrees off the line to it. */
export function weaveDeg(now: number, dist: number, info: MobInfo): number {
  if (info.kind !== "ranged" || dist <= 4) return 0;
  return Math.sin(now / 300) * 50;
}

/** A leaping or climbing spider (vertical speed in blocks per tick, feet above the player's): wait for it to land. */
export function spiderAirborne(vy: number, dy: number): boolean {
  return Math.abs(vy) > 0.08 || dy > 0.6;
}

/** What `findCover` reads: the nav grid's block classes (`#` solid, `.` passable, `s`/`t` slabs and stairs). */
export interface CoverGrid {
  at(x: number, y: number, z: number): string;
}

/** Skeleton eyes and the player's chest, above the feet: the line an arrow takes. */
const ARCHER_EYE = 1.5;
const CHEST = 1.2;

/** Whether a solid block stands on the straight line from `from` to `to` (sampled every quarter block). */
export function lineBlocked(grid: CoverGrid, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): boolean {
  const len = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const steps = Math.ceil(len / 0.25);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (grid.at(Math.floor(from.x + (to.x - from.x) * t), Math.floor(from.y + (to.y - from.y) * t), Math.floor(from.z + (to.z - from.z) * t)) === "#") return true;
  }
  return false;
}

/**
 * A spot to run to while closing on an archer: standable, within `maxDist` of the player, at least 1.5 blocks nearer
 * the archer than the player is, with a solid block between the archer's eyes and the player's chest there. The one
 * that gains the most ground for the least walking, or undefined when the grid has no cover on the way.
 */
export function findCover(grid: CoverGrid, me: { x: number; y: number; z: number }, archer: { x: number; y: number; z: number }, skip: ReadonlySet<string> = new Set(), maxDist = 6): { x: number; y: number; z: number } | undefined {
  const fx = Math.floor(me.x);
  const fy = Math.floor(me.y);
  const fz = Math.floor(me.z);
  const now = Math.hypot(archer.x - me.x, archer.z - me.z);
  const eye = { x: archer.x, y: archer.y + ARCHER_EYE, z: archer.z };
  let best: { at: { x: number; y: number; z: number }; score: number } | undefined;
  for (let dx = -maxDist; dx <= maxDist; dx++) {
    for (let dz = -maxDist; dz <= maxDist; dz++) {
      const x = fx + dx;
      const z = fz + dz;
      if (skip.has(`${x},${z}`)) continue;
      const at = { x: x + 0.5, y: fy, z: z + 0.5 };
      const walk = Math.hypot(at.x - me.x, at.z - me.z);
      if (walk > maxDist) continue;
      const gain = now - Math.hypot(archer.x - at.x, archer.z - at.z);
      if (gain < 1.5) continue;
      const ground = grid.at(x, fy - 1, z);
      if (!(ground === "#" || ground === "s" || ground === "t") || grid.at(x, fy, z) !== "." || grid.at(x, fy + 1, z) !== ".") continue;
      if (!lineBlocked(grid, eye, { x: at.x, y: fy + CHEST, z: at.z })) continue;
      const score = gain - 0.3 * walk;
      if (!best || score > best.score) best = { at, score };
    }
  }
  return best?.at;
}
