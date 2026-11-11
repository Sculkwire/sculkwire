/**
 * The tactic layer: every few hundred milliseconds `play` scores what the player could do now (fight a mob, flee,
 * eat, walk to the goal, use the held item on something, idle) from the threat map and the goal, and keeps doing
 * the best one. The scores are hand-tuned utilities in 0 to 1.
 */
import type { Goal } from "./goal.ts";
import type { Threat, ThreatMap } from "./threat.ts";

export const TACTICS = ["fight", "flee", "eat", "goto", "use_on", "idle"] as const;
export type TacticKind = (typeof TACTICS)[number];

export interface Tactic {
  kind: TacticKind;
  target?: Threat;
  /** Utility, 0 to 1. */
  score: number;
  reason: string;
  /** A flee to get health back: `play` keeps the player away until health reaches `RECOVERED_HEALTH`. */
  recover?: boolean;
}

/** A score at or above this is an emergency (a creeper about to blow, near death next to a mob): it preempts the running tactic at once. */
const EMERGENCY = 0.9;
/** A new tactic must beat the running one by this much, so the player does not flip between two close options. */
export const HYSTERESIS = 0.08;
/** A creeper's fuse that has burned this long, this close, means get away now. */
const CREEPER_RUN_MS = 500;
const CREEPER_RUN_DISTANCE = 5;
/** At or below this health the player gets away from mobs; armor buys a little more fighting (iron: 6, none: 8). */
export function lowHealth(armor: number): number {
  return 8 - 2 * Math.min(1, armor / 15);
}
/** Eat (food permitting) at or below this health, once no mob can reach the player before the food is eaten. */
export const EAT_HEALTH = 14;
/** Eating takes 1.6 s: a mob that would be at hand sooner than this makes it unsafe. */
const EAT_SAFE_MS = 1700;
/** A recovering player stays away until health is back to this. */
export const RECOVERED_HEALTH = 12;

function round1(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

export interface ScoreContext {
  /** Entity id -> type of everything `use_on` hit. */
  usedOn?: ReadonlyMap<string, string>;
  allowed?: ReadonlySet<TacticKind>;
  /** The player fled to recover health and has not got back to `RECOVERED_HEALTH` yet. */
  recovering?: boolean;
  /** Running just failed (a wall, a corner): fight back instead of fleeing again. */
  cornered?: boolean;
  /**
   * Id of the mob the running fight is on. A running fight turns to any creeper within 5 blocks and its footwork
   * handles the fuse, so no burning-creeper flee interrupts it.
   */
  fighting?: string;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Every feasible tactic with its utility, best first. */
export function scoreTactics(map: ThreatMap, goal: Goal, ctx: ScoreContext = {}): Tactic[] {
  const out: Tactic[] = [];
  const add = (t: Tactic) => {
    if (t.score > 0 && (!ctx.allowed || ctx.allowed.has(t.kind))) out.push(t);
  };
  const { vitals, hostiles } = map;
  const hp = vitals.health / 20;
  // Armor stretches health: full iron (15 points) takes a bit over half the damage.
  const toughness = hp * (1 + vitals.armor / 20);
  const nearest = hostiles[0];
  const close = hostiles.filter((t) => t.distance < 8);

  // A creeper about to explode: get out of the blast first.
  const burning = ctx.fighting ? undefined : hostiles.find((t) => t.fuse?.lit && t.fuse.ms >= CREEPER_RUN_MS && t.distance < CREEPER_RUN_DISTANCE);
  if (burning) add({ kind: "flee", target: burning, score: 0.98, reason: `${burning.key} fuse burning for ${burning.fuse?.ms} ms at ${burning.distance.toFixed(1)} blocks` });

  // Flee when nearly dead with mobs close, and keep away until health is back (it regenerates on a full food bar);
  // also when the pressure is far more than the player can take. Only mobs that chase count: running from an archer
  // keeps the player under its arrows (it shoots every 2 to 3 s out to 15 blocks), so it is fought instead.
  const recovering = !ctx.cornered && (vitals.health <= lowHealth(vitals.armor) || (ctx.recovering === true && vitals.health < RECOVERED_HEALTH));
  const chasing = hostiles.filter((t) => t.info.kind !== "ranged" && t.distance < (ctx.recovering ? 12 : 8));
  if (recovering && chasing.length > 0) {
    add({ kind: "flee", score: clamp01(0.75 + 0.2 * Math.min(1, map.pressure)), reason: `recovering: health ${round1(vitals.health)} with ${chasing.length} hostile(s) near`, recover: true });
  } else if (!ctx.cornered && close.length > 0 && map.pressure > 2.5 * toughness) {
    add({ kind: "flee", score: 0.7, reason: `outnumbered: pressure ${map.pressure.toFixed(2)} against toughness ${toughness.toFixed(2)}` });
  }

  // Eat when hungry or hurt (health only regenerates on a nearly full food bar): between engagements, or mid-fight
  // when no mob is within 4 blocks and none can get to the player before the food is eaten.
  if (vitals.food && (vitals.hunger ?? 0) < 20) {
    const hunger = vitals.hunger ?? 0;
    const need = Math.max((20 - hunger) / 20, 1 - hp);
    const hurt = vitals.health <= EAT_HEALTH;
    if (hunger <= 14 || hurt) {
      const d = nearest?.distance ?? Number.POSITIVE_INFINITY;
      // A mob knocked back still turns around: count it as coming at its chase speed at least.
      const arrive = Math.min(
        ...hostiles.filter((t) => t.info.kind !== "ranged").map((t) => ((t.distance - t.info.range) / Math.max(t.info.speed, t.approach)) * 1000),
        Number.POSITIVE_INFINITY,
      );
      const safe = d >= 4 && (nearest?.info.kind !== "ranged" || d > nearest.info.range) && arrive >= EAT_SAFE_MS;
      const safety = d < 4 ? 0 : safe ? 1 : 0.4;
      // Hurt and safe: eating beats walking to the next fight, since it heals while the mob comes.
      const base = hurt ? 0.82 + 0.15 * need : 0.45 + 0.5 * need;
      add({ kind: "eat", score: clamp01(base * safety), reason: `food ${hunger}/20, health ${vitals.health}/20${d < 10 ? `, nearest hostile ${d.toFixed(1)} blocks` : ""}` });
    }
  }

  // Fight: goal targets first, then anything hostile that is coming, nearest first.
  const killGoal = goal.kind === "kill";
  for (const t of map.entities) {
    if (t.fuse?.lit && t.fuse.ms >= CREEPER_RUN_MS && t.distance < CREEPER_RUN_DISTANCE && t.id !== ctx.fighting) continue;
    const wanted = killGoal && (goal.type ? t.typeId === goal.type : t.hostile);
    if (!wanted && !t.hostile) continue;
    if (t.distance > (wanted ? goal.radius : 16)) continue;
    const proximity = 1 - Math.min(1, t.distance / 24);
    let score = wanted ? 0.6 + 0.2 * proximity + 0.1 * t.danger : t.danger > 0.25 || t.distance < 6 ? 0.45 + 0.4 * t.danger : 0.15 * proximity;
    // Recovering: no seeking out fights, only the mob that is already at hand, or an archer that has the player in
    // range (standing still under its arrows heals nothing, so it is fought at full score).
    if (recovering) {
      const archer = t.info.kind === "ranged" && t.distance <= t.info.range;
      if (t.distance > 3 && !archer) continue;
      if (!archer) score *= 0.6;
    }
    add({ kind: "fight", target: t, score: clamp01(score), reason: `${wanted ? "goal target" : "hostile"} ${t.key} at ${t.distance.toFixed(1)} blocks, danger ${t.danger.toFixed(2)}` });
  }

  if (goal.kind === "reach") {
    const d = Math.hypot(map.me.location.x - goal.x, map.me.location.z - goal.z);
    if (d > goal.radius) add({ kind: "goto", score: 0.6, reason: `${d.toFixed(1)} blocks to the goal` });
  }

  if (goal.kind === "use_on") {
    for (const t of map.entities) {
      if (t.typeId !== goal.type || ctx.usedOn?.has(t.id) || t.distance > goal.radius) continue;
      add({ kind: "use_on", target: t, score: clamp01(0.65 + 0.1 * (1 - t.distance / 24)), reason: `${t.key} not hit yet, ${t.distance.toFixed(1)} blocks` });
    }
  }

  add({ kind: "idle", score: 0.05, reason: "nothing better to do" });
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Identity of a tactic: kind and target. A fight is one: it moves from mob to mob by itself, so a better-scored target
 * does not restart it.
 */
export function tacticKey(t: { kind: TacticKind; target?: { id: string } }): string {
  return t.target && t.kind !== "fight" ? `${t.kind}:${t.target.id}` : t.kind;
}

/** The best tactic, but the running one stays while it is still offered and within `HYSTERESIS` of the best. */
export function chooseTactic(scored: readonly Tactic[], running?: string): Tactic {
  const best = scored[0] ?? { kind: "idle", score: 0, reason: "nothing offered" };
  const current = running ? scored.find((t) => tacticKey(t) === running) : undefined;
  if (current && current.score >= best.score - HYSTERESIS && best.score < EMERGENCY) return current;
  return best;
}
