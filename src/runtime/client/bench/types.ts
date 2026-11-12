/**
 * The bench's contracts. A scenario is a small declarative object (one per file under `scenarios/`): the arena it
 * builds, how the player is set up, the mobs it spawns, the action or `play` goal it runs, and how a run is judged.
 * The runner (`run.ts`) does the rest: clearing, building, resetting between runs, measuring and reporting.
 */
import type { CommandOutput } from "../bridge.ts";
import type { InputKind } from "../input.ts";
import type { PlayerController } from "../player.ts";
import type { ActionResult, PlayerAction, PlayerState, Vec3 } from "../types.ts";
import type { PlayAction, PlayResult } from "../skills/play.ts";
import type { TraceFrame } from "../skills/stats.ts";

/** A position relative to the arena origin (the centre of the arena floor's top face, where feet stand). */
export interface Offset {
  dx: number;
  dy: number;
  dz: number;
}

export type ArmorSet = "leather" | "golden" | "chainmail" | "iron" | "diamond" | "netherite";

export interface PlayerSetup {
  /** Default survival. */
  gameMode?: "survival" | "creative" | "adventure";
  /** `day` (1000), `noon`, `night` (18000) or a time of day. Default day. */
  time?: "day" | "noon" | "night" | number;
  /** Hotbar contents in slot order from slot 1 (the first is selected). */
  hotbar?: { item: string; amount?: number }[];
  /** A full set of armor of this material. */
  armor?: ArmorSet;
  /** Item for the off hand (`shield`). */
  offhand?: string;
  effects?: { id: string; seconds: number; amplifier?: number }[];
  /** Where the player starts and which way it faces (yaw, 0 = +Z). Default the origin, facing +Z. */
  at?: Offset;
  yaw?: number;
}

export interface MobSpawn {
  /** `zombie` or `minecraft:zombie`. */
  type: string;
  at: Offset;
  /** Item put in the mob's main hand right after the summon (`iron_spear`). */
  held?: string;
}

/** What the runner hands a scenario's hooks. */
export interface BenchContext {
  scenario: string;
  /** 1-based run number. */
  run: number;
  input: InputKind;
  /** World position of the arena origin. */
  origin: Vec3;
  /** World position of an arena-relative offset. */
  at(o: Offset): Vec3;
  /** Run a game command (no leading slash). Throws when the game rejects it. */
  command(line: string): Promise<CommandOutput>;
  /** A helper-pack query (`entities`, `grid`, `loadout`, ...). */
  query(kind: string, params?: Record<string, unknown>): Promise<unknown>;
  controller: PlayerController;
  /** Ids of the mobs the runner spawned, in `mobs` order (missing ones are absent). */
  mobs: { id: string; typeId: string }[];
  sleep(ms: number): Promise<void>;
}

/** One player hurt event from the helper's `hurts` log. */
export interface Hurt {
  tick: number;
  damage: number;
  cause?: string;
  /** Type of the damaging entity. */
  damager?: string;
}

/** What one run measured. */
export interface RunOutcome {
  /** The action's or the play run's own verdict. */
  ok: boolean;
  message: string;
  durationMs: number;
  healthStart: number;
  healthEnd: number;
  damageTaken: number;
  /** Damage from explosions (creepers). */
  blastDamage: number;
  /** Damage from falling. */
  fallDamage: number;
  /** Hurt events from falling. */
  falls: number;
  deaths: number;
  /** Spawned mobs the player killed. */
  kills: number;
  /** Spawned mobs that are gone without a player kill (a creeper that blew up, a fall). */
  lost: number;
  /** Spawned creepers gone without a player kill (they blew up). */
  exploded: number;
  hurts: Hurt[];
  state?: PlayerState;
  action?: ActionResult;
  play?: PlayResult;
  /** The fight's per-tick trace over the action (`traceFights`), when the action fought. */
  frames?: TraceFrame[];
}

export type Metric = number | string | boolean;

/** The extra `key` when it is a number, else `fallback` (NaN by default, which fails every comparison). */
export function num(extra: Record<string, Metric>, key: string, fallback = Number.NaN): number {
  const value = extra[key];
  return typeof value === "number" ? value : fallback;
}

export interface Scenario {
  name: string;
  /** Suite the scenario belongs to (`combat`, `nav`). */
  suite: string;
  summary: string;
  /** Runs when `--runs` is not given. */
  runs: number;
  /** Hard limit for one run's action. */
  timeoutMs: number;
  /** The cleared box around the origin: blocks out on x and z, blocks up. A floor is laid under it. */
  area: { radius: number; height: number };
  /** Floor block (default `grass_block`). */
  floor?: string;
  /** Extra building commands, run after clearing, with `~`-free absolute coordinates from `ctx.at`. */
  build?(ctx: BenchContext): string[];
  player: PlayerSetup;
  mobs?: MobSpawn[];
  /**
   * Summon the mobs this many ms after the action started instead of before it (their ids reach `ctx.mobs` once
   * found), so the action begins with no mob in sight. Undefined: the mobs are there before the action starts.
   */
  spawnAfterMs?: number;
  /** What the player does. `play` runs in the bench process. */
  action(ctx: BenchContext): PlayerAction | PlayAction;
  /**
   * Phrasings of the same `play` goal: run i plays phrasing i (wrapping around), replacing the action's `goal`. They
   * measure what the goal grammar understands.
   */
  goals?: string[];
  /** Extra numbers for the table and the JSON, read after the run. */
  measure?(ctx: BenchContext, outcome: RunOutcome): Promise<Record<string, Metric>> | Record<string, Metric>;
  /** Whether the run counts as a success. Default: `ok` and no death. */
  success?(outcome: RunOutcome, extra: Record<string, Metric>): boolean;
}
