/**
 * Melee timing. Bedrock has no attack-strength cooldown, but a struck mob ignores hits for 10 ticks (0.5 s), so a
 * swing before that is wasted. A hit while falling (not on the ground, moving down) is a critical hit for 150 %
 * damage. A jump from the ground peaks after about 6 ticks and lands after about 12, so the player jumps a little
 * before the next hit is due and swings on the way down.
 */

/** The struck mob's invulnerability after a hit, the shortest useful time between swings. */
export const HIT_COOLDOWN_MS = 500;
/** Jump this long before the next hit is due, so the player is falling when it is (apex at about 300 ms plus input latency). */
export const CRIT_JUMP_LEAD_MS = 400;
/** A crit that has not come this long after the hit was due (blocked jump, low ceiling) gives way to a plain hit. */
export const CRIT_GIVE_UP_MS = 700;
/** Downward speed (blocks per tick) that counts as falling. */
const FALLING_VY = -0.03;
/** Airborne this long without a chance to crit: a long fall, so hit anyway. */
const LONG_AIR_MS = 900;

export interface MeleeInput {
  now: number;
  /** When the last swing that struck went out. */
  lastHit: number;
  cooldownMs?: number;
  onGround: boolean;
  /** Vertical velocity in blocks per tick (+ is up). */
  vy: number;
  /** When the player left the ground, while airborne. */
  airborneSince?: number;
  /** The target is under the crosshair within reach now. */
  inReach: boolean;
  /** The target will be in reach by the time a jump comes down (about 3.6 blocks or closer). */
  nearReach: boolean;
  /** Try for critical hits. */
  crits: boolean;
}

export type MeleeMove = "swing" | "crit" | "jump" | "wait";

/** What the hand does now: a plain swing, a critical swing, a jump to set one up, or nothing. */
export function meleePlan(i: MeleeInput): MeleeMove {
  const cooldown = i.cooldownMs ?? HIT_COOLDOWN_MS;
  const sinceHit = i.now - i.lastHit;
  const ready = sinceHit >= cooldown;
  if (!i.crits) return ready && i.inReach ? "swing" : "wait";
  if (!i.onGround) {
    if (!ready || !i.inReach) return "wait";
    if (i.vy < FALLING_VY) return "crit";
    if (i.airborneSince !== undefined && i.now - i.airborneSince > LONG_AIR_MS) return "swing";
    return "wait";
  }
  if (ready && i.inReach && sinceHit - cooldown > CRIT_GIVE_UP_MS) return "swing";
  if (i.nearReach && cooldown - sinceHit <= CRIT_JUMP_LEAD_MS) return "jump";
  return "wait";
}

/**
 * The keyboard route clicks without learning what the click struck, so a hit shows as a drop in the target's health
 * reading: the click's delivery, the server tick and the entity poll take 150 to 350 ms. A reading that has not dropped
 * after `HIT_DOUBT_MS` makes the swing doubtful (the hand may swing again), and one that has not dropped after
 * `HIT_CONFIRM_MS` makes it a miss.
 */
export const HIT_DOUBT_MS = 400;
export const HIT_CONFIRM_MS = 900;

/** A click whose outcome the input route could not tell. */
export interface PendingSwing {
  at: number;
  /** The target's health when the click went out. */
  health: number;
}

/** What a pending click came to by `now`, from the target's latest health reading. */
export function swingOutcome(p: PendingSwing, now: number, health: number | undefined): "hit" | "pending" | "doubt" | "miss" {
  if (health !== undefined && health < p.health) return "hit";
  const since = now - p.at;
  if (since >= HIT_CONFIRM_MS) return "miss";
  return since >= HIT_DOUBT_MS ? "doubt" : "pending";
}
