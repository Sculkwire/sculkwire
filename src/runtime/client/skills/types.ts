/** What one `fight` did, from its start to its end. */
export interface FightStats {
  /** short type -> kills by the player */
  kills: Record<string, number>;
  swings: number;
  hits: number;
  misses: number;
  crits: number;
  hitsTaken: number;
  damageTaken: number;
  /** Hits the raised shield took (counted when the helper reports the off-hand item's durability). */
  blocked: number;
  timeMs: number;
}

/** What every skill returns: whether it achieved its aim and a short message for traces; `fight` adds its numbers. */
export interface SkillResult {
  ok: boolean;
  message: string;
  stats?: FightStats;
}
