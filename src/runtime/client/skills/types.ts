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

/** How the fight uses the shield: `auto` (`kite`, plus the shield boxed in), `kite` (never: footwork only), `guard` (always near mobs). */
export type Stance = "auto" | "kite" | "guard";

export interface EatArgs {
  /** Hotbar slot (1-9) to eat from. Default: the best food for the current hunger. */
  slot?: number;
  timeoutMs?: number;
}

export interface FightArgs {
  /** Entity id, or a type (`zombie`, `minecraft:zombie`). Default: the nearest hostile mob. */
  target?: string;
  /** Keep fighting the next hostile (of the type) after this one dies. Default true unless `target` is an id. */
  all?: boolean;
  /** Only targets within this many blocks (default 16). */
  radius?: number;
  /** Jump for critical hits (default true). */
  crits?: boolean;
  /**
   * The shield against melee mobs: `auto` (default: `kite`'s footwork, the shield only boxed in), `kite` (never,
   * footwork only), `guard` (up whenever a melee mob is within about 3.6 blocks: block, strike in the cooldown,
   * block). The creeper rule holds in all.
   */
  stance?: Stance;
  timeoutMs?: number;
}

export interface FleeArgs {
  /** Entity id or type to get away from. Default: every hostile mob within 24 blocks. */
  from?: string;
  /** Done once every threat is at least this far (default 12). */
  distance?: number;
  timeoutMs?: number;
}

export interface UseOnArgs {
  /** Entity id or type to hit. */
  target: string;
  /** Go on to the next one of the type that has not been hit yet (default true for a type). */
  all?: boolean;
  radius?: number;
  timeoutMs?: number;
}
