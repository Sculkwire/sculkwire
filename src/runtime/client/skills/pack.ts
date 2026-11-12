/**
 * Fighting melee mobs, one or a pack, the way a skilled Bedrock player does, as pure functions the fight loop and the
 * tests share. Measured on retail 1.26.63.1 (engine route): a zombie or husk attacks once the player is in its box
 * reach (1.4 blocks along an axis to 1.98 on a diagonal, `mobs.ts`) and then exactly every 20 ticks while the player
 * stays in it (30 ticks after an attack the shield blocked); the player strikes a mob up to 3.0 blocks away (centre to
 * centre); a raised shield blocks a hit from within 90 degrees of the view, but only when the server saw the sneak 6
 * ticks (300 ms) before the hit, and a swing opens it for 12 ticks; the input reaches the server 1.5 to 2 ticks after
 * it is sent.
 *
 * So, per mob, the fight keeps an attack clock (when its next attack can come: `CombatStats.nextAttack`), and per tick
 * `packMove` decides:
 * - the feet (every stance): wait for a chasing mob at the edge of reach instead of walking into a pack, walk up to
 *   one that does not come, step back when a mob would have the player in reach within the latency (`kite`), and turn
 *   or walk out when a mob gets beside or behind;
 * - the shield: `auto` is `kite`'s footwork exactly, plus the shield only boxed in (under `BOXED_ROOM` of free run
 *   behind), raised `raiseLeadMs` before the attack. `guard` holds it whenever a melee mob is near (the shield-forward
 *   rhythm: block, strike in the cooldown, block), and steps out when its clocks leave no window to swing in, raising
 *   it then only in time for an attack;
 * - the hand (`shieldSwingOk`): behind the raised shield only in a window where no mob can attack while the swing
 *   holds the shield open (right after a block: the blocked mob waits 1500 ms);
 * - the mob to strike: one in reach that can take a hit now, the one nearest the view first (`strikeTarget`).
 */
import { angleDiff } from "../player.ts";
import { escapeYaw } from "./flee.ts";
import { BACKPEDAL_SPEED, openHeading, SHIELD_RAISE_MS } from "./defense.ts";
import { SPEAR_HIT_DIST } from "./mobs.ts";

/** How the fight uses the shield: `auto` (`kite`, plus the shield boxed in), `kite` (never: footwork only), `guard` (always near mobs). */
export const STANCES = ["auto", "kite", "guard"] as const;
export type Stance = (typeof STANCES)[number];

export type PackFoot = "advance" | "hold" | "retreat" | "guard";

/** One melee mob as the fight sees it this tick. */
export interface PackMob {
  id: string;
  /** Horizontal centre distance. */
  dist: number;
  /** World yaw from the player to it. */
  bearing: number;
  /** Degrees off the view, + clockwise. */
  offViewDeg: number;
  /** Its attack reach toward the player, centre to centre. */
  mobReach: number;
  /** Blocks per second toward the player (negative: moving away). */
  closing: number;
  /** Its chase speed, blocks per second. */
  speed: number;
  /** Milliseconds until its attack clock lets it attack again (0 when it can now, or its clock is unknown; see `nextAttackMs`). */
  dueMs: number;
  /** Milliseconds its clock has been ready (0 while it is not; undefined: unknown, never seen attacking). */
  overdueMs?: number;
  /**
   * Milliseconds until the hand can strike it: its invulnerability left, or the camera's turn onto it when the view is
   * off it by more than `STRIKE_AIM_DEG` (default: just the invulnerability).
   */
  strikeInMs?: number;
  /** Milliseconds until it can take a hit again (its 10-tick invulnerability after the player's last hit on it). */
  hittableMs: number;
  /**
   * The hand can strike it this tick once it is inside the strike range: it can take a hit, and the view is on it within
   * the aim tolerance as the game shows it (undefined: not known, the estimate `strikeInMs` decides alone).
   */
  strikeNow?: boolean;
  /** It swings an axe: a hit on the raised shield disables the shield. */
  axe?: boolean;
  /** It holds a spear (`holdsSpear`): it charges, hurts only while closing fast, then backs off and comes again. */
  spear?: boolean;
}

export interface PackInput {
  /** The melee mobs around, any order. */
  mobs: readonly PackMob[];
  stance: Stance;
  hasShield: boolean;
  /** Milliseconds since the raised shield's sneak was sent; undefined while it is down. */
  guardMs?: number;
  /** Milliseconds since the last swing (it lowers the raised shield for `SWING_OPENS_SHIELD_MS`); undefined: none yet. */
  swingAgoMs?: number;
  /** How late what the fighter does reaches the server, counting the reading's age. */
  latencyMs: number;
  /** World yaw of the view. */
  view: number;
  /** Free run (blocks) toward a world yaw: walls, holes and water end it (`clearRun`). */
  room: (yaw: number) => number;
  /** The mob the camera is on. */
  targetId?: string;
  /**
   * `guard` has not swung for `GUARD_STEP_OUT_MS` behind its shield and there is room: it fights as `auto` does when
   * trapped (shield only for an attack it can block in time, footwork otherwise) until the next block.
   */
  stepOut?: boolean;
}

export interface PackMove {
  foot: PackFoot;
  /** Hold the shield up (sneak). */
  shield: boolean;
  /** World yaw to walk toward (undefined: stand). */
  heading?: number;
  sprint: boolean;
  /** Fraction of the walking speed (undefined: full): giving ground to a spear just fast enough. */
  speed?: number;
  /** Turn the view to this world yaw instead of onto a mob: the pack is beside the player and must get in front. */
  face?: number;
  /** Free run (blocks) along the retreat heading. */
  room: number;
  /** Why, for the trace. */
  reason: string;
}

/** Engine route: input reaches the server 1.5 to 2 ticks after it is sent, and the readings are about 25 ms old. */
export const ENGINE_LATENCY_MS = 100;
/** Keyboard route: the key's delivery plus the helper stream's age (150 to 250 ms, carried forward by the velocity). */
export const KEYBOARD_LATENCY_MS = 170;
/** The shield's sneak is sent this long before the hit it must block (`SHIELD_RAISE_MS` plus the latency): 400 ms on the engine route. */
export function raiseLeadMs(latencyMs: number): number {
  return SHIELD_RAISE_MS + latencyMs;
}
/**
 * A swing lowers the raised shield for this long: an attack 12 ticks or less after the swing lands, 13 or more is
 * blocked again (measured on retail 2026-11-11, a husk on a 30-tick clock, the shield held up, one swing k ticks before
 * its attack, 4 trials each: k = 4, 6, 8, 10, 11, 12 landed 24 of 24, k = 13 blocked 4 of 4; swinging every 300, 600
 * and 1000 ms behind the shield let 14 of 14, 14 of 15 and 10 of 12 attacks land).
 */
export const SWING_OPENS_SHIELD_MS = 650;
/** A zombie or husk attacks again this long after an attack the shield blocked (measured: 30 ticks; 20 after one that landed). */
export const BLOCKED_ATTACK_MS = 1500;
/** When a mob's next attack can come after one it made at `at`: its cooldown, longer after a blocked one. */
export function nextAttackMs(at: number, blocked: boolean, cooldownMs: number): number {
  return at + (blocked ? BLOCKED_ATTACK_MS : cooldownMs);
}
/** A mob within this many degrees of the view is covered (measured: blocked at 85, not at 95; 75 leaves room for the turn and aim jitter). */
export const COVER_DEG = 75;
/** One loop tick and the reading's age: a raise is decided this much ahead of the lead. */
const RAISE_SLACK_MS = 100;
/** The shield stays up this much longer past the raise window, so it does not flicker between two ticks. */
const LOWER_SLACK_MS = 150;
/** A mob closing at least this fast is coming by itself: it is waited for, not met. */
const CHASING = 1;
/** Against a mob that comes: sprint while farther than this, walk while farther than `WAIT_DIST`, then stand. */
const SPRINT_DIST = 6;
const WAIT_DIST = 4;
/**
 * The farthest a swing lands, eye to the aim point on the mob's body (feet + 1.0). Measured on retail 2026-11-11, a
 * husk held still, the view steady on its chest, 5 attacks per centre distance (about a third of all attacks failed
 * for another reason, the agent's tick phase):
 *
 * | Centre distance | Attacks that struck |
 * |---|---|
 * | 2.6 | 4 of 5 |
 * | 2.8 | 3 of 5 |
 * | 3.0 | 3 of 5 |
 * | 3.1 | 0 of 5 |
 * | 3.2, 3.3, 3.4, 3.6 | 0 of 5 each |
 *
 * So eye to aim point 3.06 strikes and 3.16 does not: a swing goes out only within 3.05 where it will land.
 */
export const STRIKE_REACH = 3.05;
/** The same reach as a horizontal centre distance on level ground (struck at 3.0, not at 3.1). */
export const STRIKE_CENTRE = 3.0;
/**
 * The swing goes out at a mob once its reading (the horizontal centre distance, as read now: no lead for its walk) is
 * this close. Live (2026-11-11, N=60 bench, every swing at a mob walking in, closing above 1.5, by that reading;
 * hits/misses): 3.20 to 3.35 2/113, 3.15 9/231, 3.10 5/191, 3.05 12/69, 3.00 45/90, 2.95 63/74, 2.90 50/54, 2.85
 * 123/39, 2.75 to 2.80 115/65, 2.60 to 2.70 84/31, 2.35 to 2.55 57/10. The gate with a closing lead sent 600 of about
 * 1000 misses at 3.05 or more. So 2.9 for a mob walking in (one tick of its walk inside 3.0; 48 % at 2.9, 76 % at
 * 2.85), and 2.99 for one standing or backing off.
 */
export const STRIKE_DIST_WALKING_IN = 2.9;
export const STRIKE_DIST_STILL = 2.99;
/** A mob closing faster than this (blocks a second) is walking in. */
export const WALKING_IN = 1.5;
/** Where the swing at a mob goes out, by its closing speed. */
export function strikeDistance(closing: number): number {
  return closing > WALKING_IN ? STRIKE_DIST_WALKING_IN : STRIKE_DIST_STILL;
}
/** The feet hold a target this far (centre to centre): inside the strike reach with margin, outside a zombie's 1.4 to 1.98. */
export const STRIKE_DIST = 2.8;
/** `guard`: the shield goes up with a melee mob this close. */
const GUARD_DIST = 3.6;
/** The view within this many degrees of a mob strikes it without a turn. */
export const STRIKE_AIM_DEG = 8;
/**
 * A mob coming in counts as inside the 3.0 strike range this much beyond it: at 2.3 blocks a second it covers 0.1 in
 * about 40 ms, under a tick, so holding one there the hand cannot strike leaves it inside the range with the hand still
 * off. Whether the hand can strike it (`strikeNow`) is the view and its invulnerability only, not the swing's
 * distance (`strikeDistance`): a mob coming in that the hand is on is waited for and struck at 2.9, never stepped back
 * from first.
 */
export const UNANSWERED_EDGE = 0.1;
const STRUCK_FIRST = true;
/**
 * Without the this-tick reading (`strikeNow`, the creeper duel's keep-out), a mob coming in this close that the hand
 * cannot strike within the latency is stepped away from: measured on retail 2026-11-11 (two N=60 bench files, 41
 * hurts), the nearest mob 100 ms before a hurt read 1.6 to 2.5 blocks (median 2.0, a quarter at 2.3 to 2.5).
 */
export const HIT_READING_DIST = 2.5;
/** Footwork without the shield keeps this much time between a mob and its reach (beyond the input latency). */
const KITE_MARGIN_MS = 150;
/**
 * With less free run than this behind the player is boxed in: `auto` raises the shield there (in time for an attack,
 * or late for the one after when nothing else is left), and nowhere else. With more, the feet keep walking at full
 * speed: live, a shield held while standing cost about one hit a fight (lowering it holds the feet still some 4 ticks,
 * and a hit struck sneaking knocks back less), against `kite`'s 0.1 to 0.3 damage a fight.
 */
const BOXED_ROOM = 1;
/** `guard` steps out (shield down, footwork) after this long behind the shield without a swing. */
export const GUARD_STEP_OUT_MS = 1500;
/** A retreat needs at least this much free run behind to count as a way out (else the player is boxed in). */
export const ROOM_NEEDED = 1.5;
/** The step an advance is checked for: no mob may have the player in its reach (plus `ADVANCE_MARGIN`) after it. */
const ADVANCE_LOOK_MS = 250;
const ADVANCE_MARGIN = 0.3;
/** Mobs this close press the player: the retreat heading is away from them. */
const PRESS_DIST = 4.5;

/** Milliseconds until a mob has the player in its reach, coming at least at its chase speed (0: it has). */
function reachInMs(m: PackMob): number {
  if (m.dist <= m.mobReach) return 0;
  return ((m.dist - m.mobReach) / Math.max(0.5, m.closing, m.speed)) * 1000;
}

/** Milliseconds until a mob's next attack can land: in reach and its clock ready. */
export function attackInMs(m: PackMob): number {
  return Math.max(reachInMs(m), m.dueMs);
}

/** The shield covers a mob: within `COVER_DEG` of the view, and no axe. */
function covered(m: PackMob): boolean {
  return Math.abs(m.offViewDeg) <= COVER_DEG && !m.axe;
}

/**
 * Whether stepping back keeps (or gets) the player out of `m`'s reach before its attack in `inMs`: walking backward
 * (4.32) must outrun it with a block and a half of free run, and get out of its reach in time when inside it.
 */
export function feetClear(m: PackMob, inMs: number, latencyMs: number, room: number): boolean {
  const gain = BACKPEDAL_SPEED - Math.max(0, m.closing, m.speed);
  if (gain < 0.5 || room < ROOM_NEEDED) return false;
  const need = Math.max(0, m.mobReach + 0.1 - m.dist);
  return latencyMs + (need / gain) * 1000 <= inMs;
}

/** The world yaw away from the mobs that press (nearest weighing most), through open ground. */
function retreatHeading(mobs: readonly PackMob[], room: (yaw: number) => number): number {
  const at = (m: PackMob) => {
    const r = (m.bearing * Math.PI) / 180;
    return { x: -Math.sin(r) * m.dist, y: 0, z: Math.cos(r) * m.dist };
  };
  const me = { x: 0, y: 0, z: 0 };
  const pressing = mobs.filter((m) => m.dist < PRESS_DIST);
  const from = pressing.length ? pressing : mobs;
  const away = escapeYaw(me, from.map((m) => ({ location: at(m), weight: 1 }))) ?? (from[0] ? from[0].bearing + 180 : 180);
  // Up to 90 degrees aside, so the retreat runs along a wall instead of into a corner.
  return openHeading({ me, desired: away, spreadDeg: 90, mobs: from.map((m) => ({ location: at(m), clearance: m.mobReach + 0.4 })), clear: room });
}

/**
 * The smallest arc (degrees) holding every bearing, and its middle: the pack fits in front of the shield when the
 * arc is at most twice `COVER_DEG`.
 */
export function bearingArc(bearings: readonly number[]): { width: number; middle: number } {
  if (bearings.length === 0) return { width: 0, middle: 0 };
  const sorted = [...bearings].map((b) => ((b % 360) + 360) % 360).sort((a, b) => a - b);
  // The arc is the circle minus its largest gap between neighbouring bearings.
  let gap = -1;
  let start = sorted[0] as number;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i] as number;
    const b = i + 1 < sorted.length ? (sorted[i + 1] as number) : (sorted[0] as number) + 360;
    if (b - a > gap) {
      gap = b - a;
      start = b % 360;
    }
  }
  const width = 360 - gap;
  return { width, middle: start + width / 2 };
}

/**
 * Against a spear: the feet give ground once a spear mob charging is this close (centre to centre): its hit lands from
 * 3.35 (`SPEAR_HIT_DIST`; live round 2), plus the distance it charges in the input latency and a tick.
 */
export const SPEAR_GIVE_DIST = 3.8;
/**
 * Giving ground, the two still close at this much (blocks a second), under the spear's 0.92 (`SPEAR_MIN_CLOSING`): it
 * comes on slowly without its charge hurting.
 */
export const SPEAR_SAFE_CLOSING = 0.3;
/**
 * The feet never move faster than this (blocks a second) with a spear mob within `SPEAR_GIVE_DIST`: live (round 2),
 * all 8 spear hits came with the husk at 3.0 to 3.35 and the player at 4.1 to 5.7 (sprinting after it, or backing off
 * at full speed); none with the player standing or walking slowly there.
 */
export const SPEAR_SAFE_SPEED = 3.0;
/** A spear mob backing off is chased at a sprint only beyond this; nearer, at its retreat speed plus `SPEAR_CHASE_GAIN`. */
export const SPEAR_SPRINT_DIST = 5;
export const SPEAR_CHASE_GAIN = 0.8;
/** A spear mob charging within this is waited for standing, not walked up to. */
export const SPEAR_WAIT_DIST = 7;
/** A spear mob backing off (opening faster than `WALKING_IN`) is struck from this reading: it lags behind the mob. */
export const SPEAR_OPENING_STRIKE = 2.8;

/**
 * The feet against spear mobs, or undefined when none is near enough to decide them:
 * - One within `SPEAR_GIVE_DIST` the hand can strike now (swing ready, view on it): step in to the strike distance at
 *   `SPEAR_SAFE_SPEED` (or stand once there: the swing goes this tick); the strike is short.
 * - Else one charging within `SPEAR_GIVE_DIST`: give ground at its speed less `SPEAR_SAFE_CLOSING`.
 * - Else one standing within its reach plus 0.15: back off at `SPEAR_SAFE_SPEED` (never linger at 3.0 to 3.35).
 * - The target backing off: after it, sprinting beyond `SPEAR_SPRINT_DIST`, nearer at its retreat speed plus
 *   `SPEAR_CHASE_GAIN`, never toward another one charging within 2 blocks of `SPEAR_GIVE_DIST`.
 */
function spearFootwork(near: readonly PackMob[], i: PackInput): Omit<PackMove, "room"> | undefined {
  const spears = near.filter((m) => m.spear);
  if (spears.length === 0) return undefined;
  const safe = SPEAR_SAFE_SPEED / BACKPEDAL_SPEED;
  const close = spears.filter((m) => m.dist <= SPEAR_GIVE_DIST);
  const target = spears.find((m) => m.id === i.targetId);
  const away = (from: readonly PackMob[], speed: number, reason: string): Omit<PackMove, "room"> => ({ foot: "retreat", shield: false, heading: retreatHeading(from, i.room), sprint: false, speed, reason });
  // One charging: give ground at its speed less `SPEAR_SAFE_CLOSING`, struck or not, the hand striking it on the way
  // when it reads in the strike distance. Standing, its contact hit lands before the knockback of a swing at 2.9 does
  // (it lands 3 ticks after the hit); faster, the spear lands from 3.35.
  const charging = close.filter((m) => m.closing > 0);
  if (charging.length > 0) {
    const fastest = charging.reduce((a, b) => (b.closing > a.closing ? b : a));
    return away(charging, Math.max(0.15, Math.min(safe, (fastest.closing - SPEAR_SAFE_CLOSING) / BACKPEDAL_SPEED)), `giving ground to ${fastest.id}'s spear`);
  }
  // One charging farther out: wait for it standing (walking in on top of its charge runs onto the spear).
  const coming = spears.find((m) => m.closing > 0 && m.dist <= SPEAR_WAIT_DIST);
  if (coming) return { foot: "hold", shield: false, sprint: false, reason: `waiting for ${coming.id}'s charge` };
  // Not charging: step in to the strike distance only with the swing ready and the view on it, and strike.
  if (target && target.dist <= SPEAR_GIVE_DIST && target.strikeNow === true && target.hittableMs === 0) {
    if (target.dist <= (target.closing < -WALKING_IN ? SPEAR_OPENING_STRIKE : strikeDistance(target.closing))) return { foot: "hold", shield: false, sprint: false, reason: `striking ${target.id} inside its spear's reach` };
    return { foot: "advance", shield: false, heading: target.bearing, sprint: false, speed: safe, reason: `stepping in to strike ${target.id}` };
  }
  const inReach = close.filter((m) => m.dist <= SPEAR_HIT_DIST + 0.15);
  if (inReach.length > 0) return away(inReach, safe, `out of ${inReach[0]?.id}'s spear reach`);
  if (target && target.closing < 0 && target.dist > SPEAR_GIVE_DIST) {
    const charges = spears.some((m) => m.id !== target.id && m.closing > 0 && m.dist <= SPEAR_GIVE_DIST + 2);
    if (charges) return undefined;
    if (target.dist > SPEAR_SPRINT_DIST) return { foot: "advance", shield: false, heading: target.bearing, sprint: Math.abs(angleDiff(i.view, target.bearing)) < 30, reason: `after ${target.id}, backing off with its spear` };
    const speed = Math.max(0.15, Math.min(safe, (-target.closing + SPEAR_CHASE_GAIN) / BACKPEDAL_SPEED));
    return { foot: "advance", shield: false, heading: target.bearing, sprint: false, speed, reason: `closing on ${target.id}, backing off with its spear` };
  }
  return undefined;
}

/** What the player does about the melee mobs around this tick. */
export function packMove(i: PackInput): PackMove {
  const lead = raiseLeadMs(i.latencyMs);
  const near = i.mobs.filter((m) => m.dist < 12);
  // No shield with a spear mob near: live, 19 spear hits of 34 came through a raised shield.
  const shieldOk = i.hasShield && i.stance !== "kite" && !near.some((m) => m.spear);
  if (near.length === 0) return { foot: "hold", shield: false, sprint: false, room: i.room(i.view + 180), reason: "no melee mob near" };
  const timed = near.map((m) => ({ m, at: attackInMs(m) })).sort((a, b) => a.at - b.at);
  const retreatYaw = retreatHeading(near, i.room);
  const room = i.room(retreatYaw);
  const move = (m: Omit<PackMove, "room">): PackMove => ({ ...m, room });
  const retreat = (reason: string): PackMove => move({ foot: "retreat", shield: false, heading: retreatYaw, sprint: false, reason });
  const guard = (reason: string): PackMove => move({ foot: "guard", shield: true, sprint: false, reason });

  // Spear mobs (live, `combat/spears3`): never stand in reach of one that cannot be struck, never move fast near one.
  const spearMove = spearFootwork(near, i);
  if (spearMove) return move(spearMove);

  // Mobs beside or behind, about to have the player in reach: the shield does not cover them.
  const window = lead + RAISE_SLACK_MS;
  const pressing = timed.filter((t) => t.at <= window + LOWER_SLACK_MS || t.m.dist <= t.m.mobReach + 0.5);
  const flank = pressing.filter((t) => Math.abs(t.m.offViewDeg) > COVER_DEG);
  let face: number | undefined;
  if (flank.length > 0) {
    const arc = bearingArc(pressing.map((t) => t.m.bearing));
    const soonest = flank[0] as { m: PackMob; at: number };
    // Behind a raised shield, turn the pack in front and keep it up: lowering it to walk away opens the front too.
    // Else out of their reach first when the feet can do it; else turn so the whole pack is in front, or walk out.
    const keepGuard = shieldOk && i.guardMs !== undefined && arc.width <= 2 * COVER_DEG;
    if (!keepGuard && feetClear(soonest.m, soonest.at, i.latencyMs, room)) return retreat(`flanked by ${soonest.m.id}`);
    if (arc.width > 2 * COVER_DEG) return retreat(`surrounded (${Math.round(arc.width)} degrees)`);
    face = arc.middle;
  }
  const withFace = (m: PackMove): PackMove => (face === undefined ? m : { ...m, face, reason: `${m.reason}, turning the pack in front` });
  const front = timed.filter((t) => covered(t.m) || face !== undefined);

  if (shieldOk) {
    if (i.stance === "guard" && !i.stepOut) {
      if (front.some((t) => t.m.dist <= GUARD_DIST)) {
        // Raised now it would come up after the next attack: out of reach first when the feet can.
        const next = front[0];
        if (next && i.guardMs === undefined && next.at < lead && feetClear(next.m, next.at, i.latencyMs, room)) return retreat(`${next.m.id} attacks in ${Math.round(next.at)} ms, too soon for the shield`);
        return withFace(guard("guard stance"));
      }
    } else {
      // `auto` raises the shield for an attack only boxed in, and `guard` stepping out only in time for it.
      const trapped = i.stance === "guard" || room < BOXED_ROOM + (i.guardMs !== undefined ? 0.5 : 0);
      // Stepping out, the shield up behind the stalled `guard` comes down: it counts only when raised again in time.
      const up = i.stepOut ? undefined : i.guardMs;
      const next = front[0];
      const keep = up !== undefined ? window + LOWER_SLACK_MS : window;
      if (trapped && next && next.at <= keep) {
        // Up in time when it is already up long enough, or when it goes up now ahead of the lead; and not still lowered
        // by a swing when the attack comes.
        const swingClear = (i.swingAgoMs ?? Number.POSITIVE_INFINITY) + next.at >= SWING_OPENS_SHIELD_MS + i.latencyMs;
        const ready = swingClear && (up !== undefined ? up + next.at >= lead : next.at >= lead);
        if (ready) return withFace(guard(`${next.m.id} attacks in ${Math.round(next.at)} ms`));
        // Too late for the shield (a raise sent less than the lead before the hit does not protect, and sneaking slows
        // the feet, and lowering it again holds them still): keep walking away. Only a stalled `guard` raises it anyway,
        // for the next one, with nowhere to go.
        if (i.stance === "auto" || room >= BOXED_ROOM) return retreat(`${next.m.id} attacks in ${Math.round(next.at)} ms, too soon for the shield`);
        return withFace(guard(`${next.m.id} attacks in ${Math.round(next.at)} ms: nowhere to go, shield for the next one`));
      }
    }
  }

  // No shield for an attack now: keep out of the mobs' reach with the feet.
  const kiteBy = i.latencyMs + KITE_MARGIN_MS;
  const threat = timed.find((t) => reachInMs(t.m) <= kiteBy);
  // Never stand where the hand cannot answer. A mob coming in inside the strike range that the hand cannot strike this
  // tick (its invulnerability, or the view off it by more than the tolerance as the game shows it) is stepped away
  // from now, without weighing how soon the turn will land: walking back (4.32) the mob (2.3) cannot close, the view
  // keeps turning, and the hand strikes on the way the tick it can. Live (2026-11-11, 3 runs of 60), every hurt in the
  // slow runs came with the feet holding while the turn onto a mob walking in was estimated to land in time, and the
  // aim stood still for 100 to 200 ms. Beyond the strike range, a mob that would have the player in its reach before
  // the hand can strike it (`strikeInMs`) is stepped away from too.
  const strikeIn = (m: PackMob) => m.strikeInMs ?? m.hittableMs;
  // A mob the hand cannot strike is not stepped back from while another one coming in, as near or nearer, is under the
  // crosshair now: that one is struck first (its knockback throws it back) and the view turns on from there. Two mobs
  // side by side a few degrees apart otherwise keep the feet backing off with the hand on neither in reach of its
  // swing (in the simulator's dead end, until the player stood boxed in at the wall).
  const struckFirst = (m: PackMob) => near.some((o) => o !== m && o.strikeNow === true && o.closing > 0 && o.dist <= m.dist);
  const unanswered = threat
    ? undefined
    : timed.find(
        (t) =>
          (t.m.dist <= STRIKE_CENTRE + UNANSWERED_EDGE && t.m.closing > 0 && t.m.strikeNow === false && !(STRUCK_FIRST && struckFirst(t.m))) ||
          (t.m.dist <= STRIKE_CENTRE + 0.2 && (reachInMs(t.m) <= strikeIn(t.m) + i.latencyMs || (t.m.strikeNow === undefined && t.m.dist <= HIT_READING_DIST && t.m.closing > 0 && strikeIn(t.m) > i.latencyMs))),
      );
  if (unanswered && room >= BOXED_ROOM) return withFace(retreat(`${unanswered.m.id} reaches the player before the hand can strike it`));
  if (threat) {
    if (room >= BOXED_ROOM || !shieldOk || i.stance === "auto") return withFace(retreat(`${threat.m.id} ${threat.m.dist.toFixed(2)} from its reach ${threat.m.mobReach.toFixed(2)}`));
    return withFace(guard("boxed in"));
  }
  const hold = (reason: string): PackMove => move({ foot: "hold", shield: false, sprint: false, reason });
  if (face !== undefined) return { ...hold("turning the pack in front"), face };

  // Close in on the mob to strike, but never into the pack.
  const target = near.find((m) => m.id === i.targetId) ?? near.reduce((a, b) => (b.dist < a.dist ? b : a));
  if (target.dist <= STRIKE_DIST) return hold("in reach");
  const comes = target.closing >= CHASING;
  if (comes && target.dist <= WAIT_DIST) return hold(`waiting for ${target.id} at the edge of reach`);
  const heading = target.bearing;
  const step = (BACKPEDAL_SPEED * (i.latencyMs + ADVANCE_LOOK_MS)) / 1000;
  const safe = near.every((m) => {
    const ahead = Math.cos((angleDiff(heading, m.bearing) * Math.PI) / 180) * step;
    return m.dist - ahead - (Math.max(0, m.closing, m.speed) * (i.latencyMs + ADVANCE_LOOK_MS)) / 1000 > m.mobReach + ADVANCE_MARGIN;
  });
  if (!safe) return hold("a step in would walk into a mob's reach");
  return move({ foot: "advance", shield: false, heading, sprint: target.dist > SPRINT_DIST && Math.abs(angleDiff(i.view, heading)) < 30, reason: comes ? `meeting ${target.id}` : `closing on ${target.id}` });
}

/**
 * The mob to aim at: of those within striking distance that can take a hit, the one the hand can strike soonest
 * (`strikeInMs`: under the crosshair, or the shortest turn), the current one kept while it is within 100 ms of that;
 * else the current target while it stays among the nearest, else the nearest.
 */
export function strikeTarget(mobs: readonly PackMob[], currentId: string | undefined, latencyMs: number): string | undefined {
  if (mobs.length === 0) return currentId;
  const current = mobs.find((m) => m.id === currentId);
  const strikeIn = (m: PackMob) => m.strikeInMs ?? m.hittableMs;
  const hittable = mobs.filter((m) => m.dist <= STRIKE_CENTRE && m.hittableMs <= latencyMs + 150);
  // The one the hand can strike soonest (under the crosshair, the smallest turn), the current one while it is about as soon.
  const best = [...hittable].sort((a, b) => strikeIn(a) - strikeIn(b) || a.dist - b.dist)[0];
  if (current && hittable.includes(current) && (!best || strikeIn(current) <= strikeIn(best) + 100)) return current.id;
  if (best) return best.id;
  const nearest = mobs.reduce((a, b) => (b.dist < a.dist ? b : a));
  if (current && current.dist <= nearest.dist + 0.8) return current.id;
  return nearest.id;
}

/**
 * A mob in reach whose clock has been ready this long has attacked by now (a zombie attacks the moment it can): the
 * fight's clocks run up to `HURT_SEEN_LAG_MS` (150) early and a tick or two off, so less than this is not proof.
 */
export const OVERDUE_MS = 250;

/**
 * Which mobs just attacked (a hit taken or a hit the shield blocked): of the mobs whose reach covers the player (plus
 * `slack` for the reading's age; for a block, only those in front), the one whose attack was due first (the nearest
 * of equals), and with it every mob inside its reach whose clock is overdue by `OVERDUE_MS` or unknown: two attacks
 * on one tick show as one rise. A mob whose clock only just came due is not credited: two clocks a tick apart look
 * alike, and crediting one that has not attacked yet would open a swing window right before its attack. Empty when
 * none could have.
 */
export function attackers(mobs: readonly PackMob[], blocked: boolean, slack = 0.35): string[] {
  const could = mobs.filter((m) => m.dist <= m.mobReach + slack && (!blocked || Math.abs(m.offViewDeg) < 90));
  const first = [...could].sort((a, b) => a.dueMs - b.dueMs || a.dist - b.dist)[0];
  if (!first) return [];
  const overdue = could.filter((m) => m !== first && m.dist <= m.mobReach && m.dueMs === 0 && (m.overdueMs ?? Number.POSITIVE_INFINITY) >= OVERDUE_MS);
  return [first.id, ...overdue.map((m) => m.id)];
}

/**
 * Behind the raised shield with no window to swing in for this long (three or more mobs whose clocks interleave
 * closer than the shield-open time, which can last forever in a corner), the fight strikes once right after a block,
 * shield down, taking at most the next attack: a landed attack puts that mob on its 1000 ms clock instead of 1500, so
 * the clocks shift and a window opens.
 */
export const NO_WINDOW_MS = 3000;
/** The forced strike goes out this soon after a block, when the next attack is as far as it gets. */
export const AFTER_BLOCK_MS = 200;

/**
 * A swing from behind the raised shield lowers it for `SWING_OPENS_SHIELD_MS`: allowed only when no mob can attack
 * before the shield is back, counting the input latency (right after a block, the blocked mob waits 1500 ms). Every
 * mob counts, not only those within `COVER_DEG`: one at the arc's edge (75 to 90 degrees) is still blocked while the
 * shield stays up.
 */
export function shieldSwingOk(mobs: readonly PackMob[], latencyMs: number): boolean {
  const bound = SWING_OPENS_SHIELD_MS + latencyMs;
  return mobs.every((m) => attackInMs(m) > bound);
}
