/**
 * Numbers read off a run's per-tick fight trace (`traceFights`, `CombatStats.trace`): how the player moved and
 * blocked while mobs could reach it. Pure, so the tests check them on hand-built frames.
 */
import type { TraceFrame, TraceMob } from "../skills/stats.ts";

/** A mob with a reach at most this far counts as a melee mob (a ranged mob's `reach` is its shooting range). */
const MELEE_REACH_MAX = 4;
/** Slack added to a mob's reach for "within its reach". */
const REACH_SLACK = 0.3;
/** One gap between frames counts for at most this long (a stalled frame does not count as seconds of anything). */
const MAX_FRAME_GAP_MS = 100;
/** Slower than this (blocks/s, horizontal) counts as standing still. */
const IDLE_SPEED = 0.5;
/** A swing this close to ready (ms) is about to go: standing in reach then is waiting for it, not idling. */
const READY_SOON_MS = 120;
/** The struck target's distance must grow this much (blocks) before the next swing to count as a step back. */
const STEP_BACK = 0.5;

export interface TraceMetrics {
  /** Frames with a `hit` or `crit` event. */
  hits: number;
  /** Hits after which the distance to the struck target grew by `STEP_BACK` before the next swing was sent. */
  stepBacks: number;
  /** `stepBacks` over `hits` (0 without a hit), two decimals. */
  stepBackShare: number;
  /** Frames with a `block` event (a hit the raised shield blocked). */
  blocks: number;
  /**
   * Ms the player stood still with the shield down while a melee mob could reach it and the next swing was more than
   * `READY_SOON_MS` away. Standing behind a raised shield is not idle exposure.
   */
  idleInReachMs: number;
  /** The same, shield up or down. */
  inReachStillMs: number;
  inReachMs: number;
  /** Ms with the shield raised. */
  shieldMs: number;
  retreatMs: number;
  advanceMs: number;
  holdMs: number;
  /** Most melee mobs within reach in one frame. */
  maxMobsInReach: number;
  /** Mean view error (degrees) on frames that sent a swing; absent without a swing. */
  aimErrAtSwing?: number;
}

const inReach = (m: TraceMob) => m.reach <= MELEE_REACH_MAX && m.dist <= m.reach + REACH_SLACK;

/**
 * The metrics of one run. Each gap between two frames counts for the earlier frame's state, at most
 * `MAX_FRAME_GAP_MS`; the speed over a gap is the x/z distance over the gap's real length.
 */
export function traceMetrics(frames: readonly TraceFrame[]): TraceMetrics {
  const m: TraceMetrics = { hits: 0, stepBacks: 0, stepBackShare: 0, blocks: 0, idleInReachMs: 0, inReachStillMs: 0, inReachMs: 0, shieldMs: 0, retreatMs: 0, advanceMs: 0, holdMs: 0, maxMobsInReach: 0 };
  let aimSum = 0;
  let aimCount = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i] as TraceFrame;
    const reaching = f.mobs.filter(inReach);
    m.maxMobsInReach = Math.max(m.maxMobsInReach, reaching.length);
    if (f.ev?.includes("swing")) {
      aimSum += f.aimErr;
      aimCount++;
    }
    if (f.ev?.includes("block")) m.blocks++;
    if (f.ev?.includes("hit") || f.ev?.includes("crit")) {
      m.hits++;
      const target = f.mobs.find((x) => x.target);
      if (target) {
        for (let j = i + 1; j < frames.length; j++) {
          const g = frames[j] as TraceFrame;
          if (g.ev?.includes("swing")) break;
          const d = g.mobs.find((x) => x.id === target.id)?.dist;
          if (d !== undefined && d >= target.dist + STEP_BACK) {
            m.stepBacks++;
            break;
          }
        }
      }
    }
    const next = frames[i + 1];
    if (!next) continue;
    const real = next.t - f.t;
    if (real <= 0) continue;
    const dt = Math.min(real, MAX_FRAME_GAP_MS);
    const speed = (Math.hypot(next.x - f.x, next.z - f.z) / real) * 1000;
    if (reaching.length > 0 && speed < IDLE_SPEED && f.readyMs > READY_SOON_MS) {
      m.inReachStillMs += dt;
      if (!f.shield) m.idleInReachMs += dt;
    }
    if (reaching.some((x) => x.coolMs <= 0)) m.inReachMs += dt;
    if (f.shield) m.shieldMs += dt;
    if (f.foot === "retreat") m.retreatMs += dt;
    else if (f.foot === "advance") m.advanceMs += dt;
    else if (f.foot === "hold") m.holdMs += dt;
  }
  const out: TraceMetrics = {
    ...m,
    stepBackShare: m.hits > 0 ? Math.round((m.stepBacks / m.hits) * 100) / 100 : 0,
    idleInReachMs: Math.round(m.idleInReachMs),
    inReachStillMs: Math.round(m.inReachStillMs),
    shieldMs: Math.round(m.shieldMs),
    retreatMs: Math.round(m.retreatMs),
    advanceMs: Math.round(m.advanceMs),
    holdMs: Math.round(m.holdMs),
  };
  if (aimCount > 0) out.aimErrAtSwing = Math.round((aimSum / aimCount) * 10) / 10;
  return out;
}
