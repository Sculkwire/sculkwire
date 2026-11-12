/**
 * Defensive decisions, as pure functions the fight loop and the tests share: when the next swing is ready, whether a
 * jump for a critical hit is safe, how to react to a creeper's fuse, weaving toward archers and waiting out a leaping
 * spider. Which way is open and cover from archers are in `steer.ts`; the footwork and shield against melee mobs are in
 * `pack.ts`.
 *
 * Bedrock values: the player reaches 3 blocks; a struck mob ignores hits for 10 ticks; zombies, spiders and most
 * other melee mobs attack with a box reach (see `mobs.ts`, 1.4 to 1.98 blocks for a zombie) at most once a second; a
 * creeper's data says its fuse lights within 2.5 blocks and goes out past 6, but measured in the game (horizontal
 * centre distance, as the fight reads it) it lights at 2.9 and not at 3.1, and still blows when the player is put 6.6
 * blocks away after it lit, but not 7. It blows 1.5 s after lighting with power 3 (damage out to 6 blocks). A raised shield
 * (sneaking with a shield in either hand) blocks melee hits, arrows and explosions from the front half, and an axe
 * hit on it disables it for 5 s.
 */
import { PLAYER_REACH, WALK_SPEED } from "../bedrock.ts";
import { HIT_COOLDOWN_MS } from "./melee.ts";
import type { MobInfo } from "./mobs.ts";

/**
 * Ready to swing with a standing creeper (closing under `CREEPER_STANDING`) this far beyond reach: step in to it, a
 * tick or two at a walk, rather than wait. One that walks in is met standing still: live, sprinting in at one closing
 * at 2.5 blocks a second carried the player to 2.2 after the strike (the momentum, the knockback 3 ticks late), and
 * the run from there lost every creeper (0 of 10), where striking standing at 2.9 to 3.1 and running from there won.
 */
const STEP_IN = 0.3;
/**
 * The step in to a standing creeper is a tap: forward for one tick, then let go, and the next tap only after the
 * reading caught up (2 ticks old) and the coast ended. Held, the step overshot live: forward stayed down until the
 * reading showed reach, and the momentum carried the player from 3.1 to 2.24.
 */
export const STEP_TAP_MS = 250;
/**
 * A creeper lights its fuse when the gap between its box and the player's (both 0.6 wide) is under this (its data
 * value), then coasts to a stop: along an axis that is a centre distance of 3.1, at 45 degrees 3.35. Live
 * (2026-11-11): along the z axis it was struck at 2.92 to 2.99 still walking; from the side (bench `mixed`) it stood at
 * 3.08 to 3.16, outside the 2.99 reach. The "lights at 2.9, not at 3.1" measured earlier was along an axis.
 */
export const CREEPER_LIGHT_GAP = 2.5;
/** How far a creeper walking at 2.5 blocks a second coasts after it lights (live about 0.25, the simulator 0.15). */
const CREEPER_COAST = 0.2;

/** The centre distance a creeper lights at, coming from the direction (dx, dz) relative to the player. */
export function creeperLightDist(dx: number, dz: number): number {
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return CREEPER_LIGHT_GAP + 0.6;
  const ux = Math.abs(dx) / d;
  const uz = Math.abs(dz) / d;
  const gap = (r: number) => Math.hypot(Math.max(0, r * ux - 0.6), Math.max(0, r * uz - 0.6));
  let lo = 0;
  let hi = 6;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (gap(mid) < CREEPER_LIGHT_GAP) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Where a lit creeper will stand, seen before it slows: its light distance for the bearing, less the coast. */
export function creeperStand(dx: number, dz: number): number {
  return creeperLightDist(dx, dz) - CREEPER_COAST;
}

/**
 * A creeper's walk keeps this share of its speed each tick once it stops pushing: live (2026-11-11, `mixed`) it began to
 * slow at 3.2 to 3.3 and stood at 3.08 to 3.16, about 0.15 of coast from 2.5 blocks a second.
 */
const CREEPER_SLOW_KEEP = 0.546;
/** Below this closing speed (blocks a second) the reading shows a lit creeper already slowing. */
const CREEPER_SLOWING = 2;

/**
 * Where a lit creeper still moving will stand. Once the reading shows it slowing, from that reading: the rest of its
 * coast at `CREEPER_SLOW_KEEP` (the light distance's spread and the bearing drop out). Before, from the bearing.
 */
export function creeperStandFrom(dist: number, closing: number, dx: number, dz: number): number {
  if (closing < CREEPER_SLOWING) return dist - (closing / 20) * (CREEPER_SLOW_KEEP / (1 - CREEPER_SLOW_KEEP));
  return Math.min(dist, creeperStand(dx, dz));
}

/**
 * What a few ticks of forward input gain from standing, the coast included: fitted to the live tap frames of
 * 2026-11-11 (one tick and its coast took the reading from 3.09 to 2.98) and the walk's ramp (about 0.1 blocks the
 * first tick, 0.16 the second, about 0.1 of coast).
 */
const CLOSE_IN_GAIN = [0.11, 0.27, 0.43];
/** The most a close-in covers: a lit creeper standing farther than this outside reach is left to the escape. */
const CLOSE_IN_MAX = 0.45;

/** A close-in aims this far inside reach: the predicted stand is off by a few hundredths. */
export const CLOSE_IN_MARGIN = 0.06;
/**
 * A further close-in only this long after the last one's input ended: the reading is 2 ticks old and the coast takes
 * about one more. Live, taps 250 ms apart were too slow for the 0.1 to 0.35 a lit creeper stood outside reach.
 */
export const CLOSE_IN_SETTLE_MS = 100;
/** Ticks of forward input that close `gap` blocks (at least 1, at most `CLOSE_IN_GAIN.length`). */
export function closeInTicks(gap: number): number {
  const n = CLOSE_IN_GAIN.findIndex((g) => g >= gap);
  return n < 0 ? CLOSE_IN_GAIN.length : n + 1;
}

/** A struck creeper is past 7 blocks about this long after the hit (knockback plus the backward walk). */
const STRUCK_ESCAPE_MS = 800;
/** A creeper struck this recently is counted as thrown `STRUCK_THROW` blocks farther by its knockback. */
export const STRUCK_THROW_MS = 600;
export const STRUCK_THROW = 2;
/** A creeper closing slower than this (blocks a second) stands: swelling, or waiting. */
export const CREEPER_STANDING = 0.5;
/** Input to the game's tick plus the state's age: how late what the fighter does lands (the creeper footwork's margin). */
const LATENCY_MS = 120;
/** Walking speed backward, blocks per second (the same in every direction). */
export const BACKPEDAL_SPEED = WALK_SPEED;
/** A creeper blast hurts out to 2 × power blocks. */
const BLAST_RADIUS = 6;
/**
 * The server must have seen the sneak this long before a hit for the raised shield to block it (measured on retail:
 * a lead of 6 to 9 ticks blocked 12 hits of 12, 1 to 5 ticks blocked none of 22). The input latency comes on top.
 */
export const SHIELD_RAISE_MS = 300;

/**
 * Milliseconds until the next swing can land (0 when ready). Bedrock has no attack-strength cooldown, so every
 * weapon (sword, axe, trident, fist) shares the struck mob's 10-tick invulnerability: a swing before it ends does
 * nothing.
 */
export function readyInMs(now: number, lastHit: number, cooldownMs = HIT_COOLDOWN_MS): number {
  return Math.max(0, lastHit + cooldownMs - now);
}

/** Time needed to get from `dist` out of the blast by walking backward. */
function escapeMs(dist: number, speed = BACKPEDAL_SPEED): number {
  return Math.max(0, ((BLAST_RADIUS + 0.5 - dist) / speed) * 1000) + LATENCY_MS;
}

/** A melee mob as the fight sees it: distance and reach (centre to centre), closing speed and its attack cooldown. */
interface MeleeThreat {
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
const CRIT_EXPOSED_MS = 700;

/** Jumping for a critical hit is safe when no melee mob can hit the player before the falling swing. */
export function critSafe(mobs: readonly MeleeThreat[]): boolean {
  return mobs.every((m) => untilMobHitMs(m) > CRIT_EXPOSED_MS);
}

/**
 * What to do about a creeper. `run`: turn away from a burning creeper and sprint out of its fuse range. `step`: walk
 * in to a creeper just beyond reach with the swing ready, and strike as it comes inside.
 */
type CreeperMove = "strike" | "step" | "retreat" | "run" | "block" | "approach" | "hold";

interface CreeperInput {
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
  /** The escape on this fuse is under way walking back: with room it carries on, the shield never raised mid-run. */
  backingOff?: boolean;
  /** Milliseconds since the player's last hit on it; undefined: not struck lately. */
  struckAgoMs?: number;
  /** Where it will stand once its walk has coasted out (`creeperStandFrom`), when it is lit and still moving. */
  stand?: number;
  /** A strike attempt on it has started and its swing has not gone out yet. */
  committed?: boolean;
  /** Free run straight back from it (`clearRun`), blocks; undefined: open. */
  roomBehind?: number;
  /** Another mob stands in the line to it (under the crosshair, nearer): a swing would strike that one instead. */
  lineBlocked?: boolean;
}

/** Sprinting speed, blocks per second: a burning creeper is outrun facing away from it. */
const SPRINT_SPEED = 5.6;
/** Turning the camera around (away from the creeper, or back to it for the shield). */
const TURN_MS = 150;

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
const CREEPER_STRIKE_FLOOR = 2.8;

/** A creeper closing in faster than this is walking, so it is not swelling (the swell goal holds it still). */
const CREEPER_WALKING = 1.2;
/**
 * A creeper that came within `CREEPER_START + CREEPER_MARGIN` this recently and now stands still has lit its fuse,
 * even with the player already farther away (backing off while it swelled).
 */
const CREEPER_CLOSE_MEMORY_MS = 900;

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
const FUSE_OVERDUE_MS = 700;
/**
 * A creeper with a target always walks at it, unless its fuse burns (the swell goal holds it). So one that stands
 * still this long within its fuse's reach is taken as lit, and one within `STILL_NEAR` at once (the bench saw
 * creepers stop to light at readings of 3.1 to 3.6). Readings are up to 250 ms stale, so a creeper's walk counts
 * only this long after a strike.
 */
const STILL_LIT_MS = 300;
const STILL_NEAR = 4.5;
/** How old a reading is, on average: a stop or close reading seen now happened about this long ago. */
const READING_AGE_MS = 150;

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
const SHIELD_WITHIN = 5;

/**
 * Against a creeper: strike it once it is inside reach (where a swing lands: no swing goes out beyond it), standing
 * still; one that walks in is met standing. An unlit creeper standing just beyond reach (up to `STEP_IN`) is stepped
 * to by taps. A lit one is judged by where it will stand (`creeperStandFrom`: the box gap it lit at, then its coast):
 * inside reach, wait for it; up to `CLOSE_IN_MAX` outside, close in with a few ticks forward while it still slows. A
 * swing at a lit creeper goes out while a hit leaves the run time (`STRUCK_ESCAPE_MS`); a mob passing through the line
 * is waited out. Back off while the swing cools down with it in reach, or once the strike is no longer possible: walk
 * straight back past 7 blocks, which puts the fuse out, and once chosen the escape stays the decision for that fuse.
 * Only when the run cannot get out before the blast (and never in an escape with room after a hit on this fuse) and
 * the creeper is within `SHIELD_WITHIN`, raise the shield toward it: the shield saves the player, but the creeper
 * still blows up (a lost kill, and the blast hurts the other mobs around).
 */
export function creeperMove(i: CreeperInput): CreeperMove {
  const reach = i.reach ?? PLAYER_REACH;
  const left = (i.fuseLengthMs ?? 1500) - i.fuseMs;
  const ready = i.readyInMs <= LATENCY_MS && !i.lineBlocked;
  const strike = ready && i.dist <= reach;
  // A standing creeper just beyond reach: the walk in at walking speed, and the input latency.
  const step = ready && !strike && (i.closing ?? 0) < CREEPER_STANDING && i.dist <= reach + STEP_IN;
  if (i.lit) {
    if (i.dist > CREEPER_STOP + CREEPER_MARGIN) return "hold";
    // A swing at a lit creeper while a hit still leaves time for the run (a struck creeper is past 7 about 0.8 s after
    // the hit); a miss then falls back on the shield, which blocks the blast.
    const hitAllows = left > STRUCK_ESCAPE_MS + LATENCY_MS;
    // Another mob passing through the line with the creeper about in reach: stand and wait for the line to clear (the
    // swing only goes out at the creeper itself) rather than give the strike up while the fuse allows it.
    if (i.lineBlocked && i.readyInMs <= LATENCY_MS && !i.running && hitAllows && i.dist <= reach + CLOSE_IN_MAX) return "strike";
    if (ready && !i.running && hitAllows) {
      if (strike) return "strike";
      // Where it will stand once its walk has coasted out (`creeperStandFrom`): inside reach, stand and strike as it comes;
      // just outside, close the difference with a few ticks forward while it still slows (`closeInTicks`). Once a
      // strike attempt started (`committed`) it stays with it until the swing went out or the fuse budget is used up.
      const stand = Math.min(i.dist, i.stand ?? i.dist);
      if (stand <= reach) return "strike";
      if (stand <= reach + CLOSE_IN_MAX || (i.committed && i.dist <= reach + 2 * CLOSE_IN_MAX)) return "step";
    }
    // The shield only when the run cannot get out of the blast before it: with room behind the run is the backward
    // walk (no turn), and a creeper struck in the last 600 ms counts as thrown `STRUCK_THROW` farther (live, the
    // escape from 2.24 after a hit was shielded on the old estimate, and the creeper was thrown to about 5 meanwhile).
    // Without room, the turn and the sprint.
    const roomy = (i.roomBehind ?? Number.POSITIVE_INFINITY) >= Math.min(CREEPER_STOP + CREEPER_MARGIN - i.dist, 5.5);
    const thrown = i.struckAgoMs !== undefined && i.struckAgoMs < STRUCK_THROW_MS ? STRUCK_THROW : 0;
    const escape = roomy ? escapeMs(i.dist + thrown, BACKPEDAL_SPEED) : escapeMs(i.dist + thrown, SPRINT_SPEED) + TURN_MS;
    // An escape after a hit on this fuse, with room behind, is never cut short for the shield: raising it slows the walk
    // to a sneak (1.3 blocks a second) right where the run was gaining 4.3, and the knockback has the creeper about 5
    // off by then. An escape without a hit (the swing missed) still raises it when the walk cannot make it.
    if (i.backingOff && roomy && i.struckAgoMs !== undefined && i.struckAgoMs <= i.fuseMs) return "run";
    if (i.hasShield && i.dist < SHIELD_WITHIN && left < Math.max(escape, SHIELD_RAISE_MS + LATENCY_MS)) return "block";
    return "run";
  }
  if (strike) return "strike";
  if (step) return "step";
  if (!ready) return i.dist < reach + 0.6 ? "retreat" : "hold";
  return "approach";
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
