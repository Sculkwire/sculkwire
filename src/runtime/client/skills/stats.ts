/**
 * What the skills did, per controller: swings, hits, misses, critical hits, hits taken, which entities were struck and
 * which were hit with `use_on`, a short log of what the fight saw around every hit the player took, and, while
 * tracing is on, one structured frame per fight tick. `play` reads it for its result and its goal checks, the bench
 * for its per-run trace.
 */
import type { PlayerController } from "../player.ts";
import type { Counters, FightStats } from "./types.ts";

/** One mob as a fight tick saw it. */
export interface TraceMob {
  id: string;
  type: string;
  /** horizontal centre distance */
  dist: number;
  /** its melee reach toward the player (centre to centre), range for non-melee */
  reach: number;
  /** ms until it can attack the player: in its reach and its attack clock ready (melee), else its attack clock */
  coolMs: number;
  /** degrees off the view, + clockwise */
  offViewDeg: number;
  /** blocks/s toward the player */
  closing: number;
  target: boolean;
}

/** What happened in one fight tick (`block`: the raised shield took a hit, seen as the off-hand item's durability). */
export type TraceEvent = "swing" | "hit" | "crit" | "miss" | "hurt" | "block" | "jump" | "spear: learned";

/** One fight tick (25 ms of the hands' clock, longer when a step blocks). */
export interface TraceFrame {
  /** ms on the hands' clock since tracing was switched on for this controller's current stats */
  t: number;
  x: number;
  z: number;
  hp?: number;
  onGround: boolean;
  mobs: TraceMob[];
  /** advance | hold | retreat | guard (holding the ground behind the shield), or the creeper move */
  foot: string;
  group?: "flanked" | "kite";
  /** swing | crit | jump | wait */
  plan: string;
  /** ms until the next swing can land */
  readyMs: number;
  shield: boolean;
  /** view error (degrees) the swing decision used, and its tolerance */
  aimErr: number;
  aimTol: number;
  /** movement input */
  fwd: number;
  strafe: number;
  sprint: boolean;
  /** what happened this frame */
  ev?: TraceEvent[];
  /** health lost this frame */
  lost?: number;
  /** free run (blocks) along the melee footwork's retreat heading */
  room?: number;
}

export interface CombatStats extends Counters {
  /** Entity id -> type of everything a swing struck. */
  struck: Map<string, string>;
  /** Entities a `use_on` skill hit. */
  usedOn: Map<string, string>;
  /** One line per hit the player took (and the fight frames before it), oldest first, at most `MAX_EVENTS`. */
  events: string[];
  /**
   * Entity id -> when (the hands' clock) that melee mob can attack the player next, from the last attack the fight
   * credited to it: `cooldownMs` after a hit that landed, `BLOCKED_ATTACK_MS` after one the shield blocked.
   */
  nextAttack: Map<string, number>;
  /** Entity id -> when a swing last struck it: it takes no other hit for `HIT_COOLDOWN_MS`. */
  struckAt: Map<string, number>;
  /** The mob the running fight is on now (`play` reads it for its burning-creeper rule). */
  fighting?: string;
  /**
   * Melee mobs taken to hold a spear because one hurt the player from `SPEAR_LEARN_DIST` or more (the helper's `held`
   * may be missing): fought as spear mobs from then on.
   */
  spears: Set<string>;
  /**
   * Creeper id -> the last reading within its fuse start range since the player last struck it, and when its fuse
   * was taken as lit (the hands' clock). Kept across duels, so a fight that turns to a creeper knows it lit.
   */
  creepers: Map<string, { closeAt?: number; fuseSince?: number }>;
  /** One frame per fight tick, oldest first, at most `MAX_TRACE_FRAMES`; present only while tracing is on. */
  trace?: TraceFrame[];
}

/** Lines kept in `events`. */
const MAX_EVENTS = 1200;
/** Frames kept in `trace` (200 s of fighting at 40 ticks a second). */
export const MAX_TRACE_FRAMES = 8000;

const STATS = new WeakMap<PlayerController, CombatStats>();
/** Controllers with tracing on. */
const TRACING = new WeakSet<PlayerController>();
/** When (the hands' clock) tracing started for a stats object: frame time 0. */
const TRACE_SINCE = new WeakMap<CombatStats, number>();

function newStats(): CombatStats {
  return { swings: 0, hits: 0, misses: 0, crits: 0, hitsTaken: 0, damageTaken: 0, blocked: 0, struck: new Map(), usedOn: new Map(), events: [], nextAttack: new Map(), struckAt: new Map(), creepers: new Map(), spears: new Set() };
}

/** Append lines to the event log, dropping the oldest past `MAX_EVENTS`. */
export function logEvent(stats: CombatStats, ...lines: string[]): void {
  stats.events.push(...lines);
  if (stats.events.length > MAX_EVENTS) stats.events.splice(0, stats.events.length - MAX_EVENTS);
}

/** Append one fight tick at `now` (the hands' clock) when tracing is on, dropping the oldest past `MAX_TRACE_FRAMES`. */
export function traceFrame(stats: CombatStats, now: number, frame: Omit<TraceFrame, "t">): void {
  const trace = stats.trace;
  if (!trace) return;
  trace.push({ t: now - (TRACE_SINCE.get(stats) ?? now), ...frame });
  if (trace.length > MAX_TRACE_FRAMES) trace.shift();
}

export function combatStats(pc: PlayerController): CombatStats {
  let s = STATS.get(pc);
  if (!s) {
    s = newStats();
    STATS.set(pc, s);
    if (TRACING.has(pc)) startTrace(pc, s);
  }
  return s;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `killed 3 husk with iron_sword: 11 swings, 6 hits, 5 misses, 1 critical, took 2 hits for 3.5 damage, blocked 4 hits, in 10.4 s`. */
export function fightText(s: FightStats, weapon?: string): string {
  const kills = Object.entries(s.kills).map(([t, n]) => `${n} ${t}`);
  return (
    `${kills.length ? `killed ${kills.join(", ")}` : "killed nothing"}${weapon ? ` with ${weapon}` : ""}: ` +
    `${count(s.swings, "swing")}, ${count(s.hits, "hit")}, ${count(s.misses, "miss", "misses")}, ${s.crits} critical, ` +
    `took ${count(s.hitsTaken, "hit")} for ${Math.round(s.damageTaken * 10) / 10} damage, ${s.blocked ? `blocked ${count(s.blocked, "hit")}, ` : ""}in ${(s.timeMs / 1000).toFixed(1)} s`
  );
}

function startTrace(pc: PlayerController, s: CombatStats): void {
  s.trace = [];
  TRACE_SINCE.set(s, pc.hands.now());
}

/** Switch per-tick fight tracing on (an empty trace, its clock starting now) or off for a controller; survives resetStats. */
export function traceFights(pc: PlayerController, on: boolean): void {
  if (on) {
    TRACING.add(pc);
    startTrace(pc, combatStats(pc));
  } else {
    TRACING.delete(pc);
    const s = STATS.get(pc);
    if (s) delete s.trace;
  }
}

/** Start counting from zero (a new `play` run); a controller with tracing on gets a fresh empty trace. */
export function resetStats(pc: PlayerController): CombatStats {
  const s = newStats();
  STATS.set(pc, s);
  if (TRACING.has(pc)) startTrace(pc, s);
  return s;
}
