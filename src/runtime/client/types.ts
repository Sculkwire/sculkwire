/** What the controller reads from the game and the actions it runs: the types every player module shares. */
import type { ProjectileKind } from "./ballistics.ts";
import type { InputKind } from "./input.ts";
import type { EngineInput } from "./inputprovider.ts";
import type { PlayerInput } from "./input.ts";
import type { EatArgs, FightArgs, FightStats, FleeArgs, UseOnArgs } from "./skills/types.ts";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** What the helper pack streams (`[sculkwire:state]`). Rotation: x = pitch (+ looks down), y = yaw (0 = +Z). */
export interface PlayerState {
  tick: number;
  name: string;
  location: Vec3;
  velocity: Vec3;
  rotation: { x: number; y: number };
  dimension: string;
  onGround: boolean;
  sneaking: boolean;
  sprinting: boolean;
  gameMode: string;
  selectedSlot: number;
  health?: number;
  /** Durability damage of the off-hand item (a shield loses durability with each hit it blocks), when the helper reports it. */
  offhandDamage?: number;
  holding?: { typeId: string; amount: number };
  lookingAtBlock?: { typeId: string; location: Vec3; face: string };
  lookingAtEntity?: { id: string; typeId: string; distance: number };
  /**
   * `engine` when position, rotation, velocity, ground, health and slot come from the input provider's motion stream
   * (the rest, and `tick`, from the helper), absent for the helper alone.
   */
  source?: "engine";
}

export interface EntityInfo {
  id: string;
  typeId: string;
  location: Vec3;
  health?: { current: number; max: number };
  /** Game tick the position was read at (the helper's `entity` query sets it). */
  tick?: number;
  /** Blocks per tick, when the helper reports it. */
  velocity?: Vec3;
  /** A creeper whose fuse is lit. The helper sets it on every creeper (false too), so a false can be trusted. */
  ignited?: boolean;
  /** Game ticks a lit creeper's fuse has burned when it was read (30 ticks is the blast). */
  fuseTicks?: number;
  /** The item id in its main hand, when the helper can read it (a spear changes how a husk or zombie fights). */
  held?: string;
  /** Milliseconds the reading was old when handed out (streamed readings, already carried forward by it). */
  ageMs?: number;
}

/** One projectile impact the helper pack recorded (`impacts` query). */
export interface Impact {
  tick: number;
  projectile: string;
  source?: string;
  location: Vec3;
  entity?: { id: string; typeId: string };
  block?: string;
}

/** What the controller needs from the running game. */
export interface PlayerWorld {
  /** Player state no older than `maxAgeMs`. */
  state(maxAgeMs?: number): Promise<PlayerState>;
  entity(id: string): Promise<EntityInfo | null>;
  /** Nearest entity (optionally of a type) within `radius` blocks of the player, excluding players. */
  nearest(type: string | undefined, radius: number): Promise<EntityInfo | null>;
  /** Projectile impacts recorded after game tick `since`, and the current game tick. */
  impacts(since: number): Promise<{ tick: number; impacts: Impact[] }>;
  input: PlayerInput;
  /** The latest streamed state and when it arrived, without waiting (undefined before the stream starts). */
  sample?(): { at: number; state: PlayerState } | undefined;
  /** Stream the state every `every` game ticks: 1 while an action runs, 2 when idle. */
  stateRate?(every: number): Promise<void>;
  /** The engine route of the installed input provider (`inputprovider.ts`), when there is one. */
  engine?: EngineInput;
  /** Entities within `radius` blocks of the player, players included (the skills drop them). */
  entities?(radius: number): Promise<EntityInfo[]>;
  /** Hotbar, food level and worn armor (the helper's `loadout` query). */
  loadout?(): Promise<Loadout>;
  /** Any helper-pack query (`grid` for navigation). */
  query?(kind: string, params?: Record<string, unknown>): Promise<unknown>;
  /** The helper's player hurts after game tick `since` (the `hurts` query), for a world that has no `query`. */
  hurts?(since: number): Promise<HurtLog>;
}

/** The helper's player hurt records (`hurts` query): who hurt the player and how. */
export interface HurtLog {
  tick: number;
  hurts: { tick: number; damage: number; cause?: string; damager?: string; damagerId?: string }[];
}

/** Hotbar slots 1-9 (null when empty), the food level and worn armor (the helper's `loadout` query). */
export interface Loadout {
  hotbar: ({ typeId: string; amount: number } | null)[];
  hunger?: number;
  saturation?: number;
  armor?: { slot: string; typeId: string }[];
}

export type PlayerAction =
  | { action: "move_to"; x: number; z: number; y?: number; radius?: number; sprint?: boolean; timeoutMs?: number; look?: string }
  | { action: "goto"; x?: number; y?: number; z?: number; entity?: string; radius?: number; sprint?: boolean; timeoutMs?: number; look?: string }
  | { action: "look_at"; x?: number; y?: number; z?: number; entity?: string; yaw?: number; pitch?: number }
  | { action: "attack"; entity?: string; type?: string; hits?: number; timeoutMs?: number }
  | { action: "use_item"; holdMs?: number }
  | { action: "shoot"; entity?: string; type?: string; projectile?: ProjectileKind; holdMs?: number; shots?: number; timeoutMs?: number }
  | { action: "mine"; holdMs?: number }
  | { action: "select_slot"; slot: number }
  | { action: "jump" }
  | { action: "sneak"; on: boolean }
  | { action: "hold"; keys: string[]; ms: number }
  | { action: "wait"; ms: number }
  | ({ action: "fight" } & FightArgs)
  | ({ action: "flee" } & FleeArgs)
  | ({ action: "eat" } & EatArgs)
  | ({ action: "use_on" } & UseOnArgs);

export interface ActionResult {
  action: PlayerAction["action"];
  ok: boolean;
  message: string;
  durationMs: number;
  /** The input route that carried the action out. */
  input?: InputKind;
  /** What a `fight` did: kills by type, swings, hits, misses, critical hits, hits taken, damage taken and its time. */
  fight?: FightStats;
}
