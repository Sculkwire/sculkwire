/** The combat counters a controller keeps and a fight reports its share of. */
export interface Counters {
  /** Attack clicks the skills sent. */
  swings: number;
  /** Swings that struck the target or another hostile mob. */
  hits: number;
  /** Swings that struck nothing (or nothing hostile): `swings === hits + misses` once every swing is judged. */
  misses: number;
  crits: number;
  /** Health drops the fight saw, and the health they took. */
  hitsTaken: number;
  damageTaken: number;
  /** Hits the raised shield took (the off-hand item's durability went up while it was raised). */
  blocked: number;
}

/** What one `fight` did, from its start to its end. */
export interface FightStats extends Counters {
  /** short type -> kills by the player */
  kills: Record<string, number>;
  timeMs: number;
}

/** What every skill returns: whether it achieved its aim and a short message for traces; `fight` adds its numbers. */
export interface SkillResult {
  ok: boolean;
  message: string;
  stats?: FightStats;
}
