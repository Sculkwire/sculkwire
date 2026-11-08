/**
 * What the skills did, per controller: swings, hits, critical hits, which entities were struck and which were hit
 * with `use_on`, and a short log of what the fight saw around every hit the player took. `play` reads it for its
 * result and its goal checks, the bench for its per-run trace.
 */
import type { PlayerController } from "../player.ts";

export interface CombatStats {
  swings: number;
  hits: number;
  crits: number;
  /** Entity id -> type of everything a swing struck. */
  struck: Map<string, string>;
  /** Entities a `use_on` skill hit. */
  usedOn: Map<string, string>;
  /** One line per hit the player took (and the fight frames before it), oldest first, at most `MAX_EVENTS`. */
  events: string[];
  /** Entity id -> when (the hands' clock) that melee mob last hit the player, as the fight credited it. */
  attacks: Map<string, number>;
  /**
   * Creeper id -> the last reading within its fuse start range since the player last struck it, and when its fuse
   * was taken as lit (the hands' clock). Kept across duels, so a fight that turns to a creeper knows it lit.
   */
  creepers: Map<string, { closeAt?: number; fuseSince?: number }>;
}

/** Lines kept in `events`. */
export const MAX_EVENTS = 1200;

const STATS = new WeakMap<PlayerController, CombatStats>();

export function newStats(): CombatStats {
  return { swings: 0, hits: 0, crits: 0, struck: new Map(), usedOn: new Map(), events: [], attacks: new Map(), creepers: new Map() };
}

/** Append lines to the event log, dropping the oldest past `MAX_EVENTS`. */
export function logEvent(stats: CombatStats, ...lines: string[]): void {
  stats.events.push(...lines);
  if (stats.events.length > MAX_EVENTS) stats.events.splice(0, stats.events.length - MAX_EVENTS);
}

export function combatStats(pc: PlayerController): CombatStats {
  let s = STATS.get(pc);
  if (!s) {
    s = newStats();
    STATS.set(pc, s);
  }
  return s;
}

/** Start counting from zero (a new `play` run). */
export function resetStats(pc: PlayerController): CombatStats {
  const s = newStats();
  STATS.set(pc, s);
  return s;
}
