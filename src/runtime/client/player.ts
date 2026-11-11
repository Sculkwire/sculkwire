/**
 * Player control the way a person plays: held movement keys, relative mouse look and mouse clicks, driven in a tight
 * closed loop on the player state the helper pack streams (20 per second while an action runs). The mouse hand
 * (`Camera`) runs at 120 Hz beside the keys, so the player walks, strafes and sprints while it turns and tracks.
 * One MCP call can run a whole sequence (walk there, look at it, hit it, switch slot, use item).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { NO_INPUT_PROVIDER } from "./inputprovider.ts";
import type { PlayerInput } from "./launcher.ts";
import { moveToAction, navigate } from "./nav/navigate.ts";
import { eat, fight, flee, useOn, type EatArgs, type FightArgs, type FleeArgs, type UseOnArgs } from "./skills/index.ts";
import { shortType } from "./skills/mobs.ts";

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
}

const EYE_HEIGHT = 1.62;
/** Shots aim this far above an entity's feet: inside the box of everything from chickens to zombies. */
const AIM_HEIGHT = 0.6;
/** Ticks from the click to the projectile's first tick in the game (input delivery plus the next server tick). */
const FIRE_LATENCY_TICKS = 2;
/** Default key names (xdotool names; Windows maps them to virtual keys) for Bedrock's default keyboard layout. */
const KEYS = { forward: "w", left: "a", back: "s", right: "d", jump: "space", sneak: "Shift_L", sprint: "Control_L" } as const;

/** The keys Bedrock's default layout moves with: WASD, space to jump, shift to sneak, ctrl to sprint. */
const MOVEMENT_KEY = /^(?:[wasd]|space|shift(?:_[lr])?|ctrl(?:_[lr])?|control(?:_[lr])?)$/i;

/** Split held keys into the movement they give and the rest. `move` is undefined when no key moves. */
function movementKeys(keys: readonly string[]): { move?: Partial<MoveVector>; keys: string[] } {
  const held = (re: RegExp) => keys.some((k) => re.test(k));
  const move: Partial<MoveVector> = {};
  if (held(/^[ws]$/i)) move.forward = (held(/^w$/i) ? 1 : 0) - (held(/^s$/i) ? 1 : 0);
  if (held(/^[ad]$/i)) move.strafe = (held(/^d$/i) ? 1 : 0) - (held(/^a$/i) ? 1 : 0);
  if (held(/^space$/i)) move.jump = true;
  if (held(/^shift(?:_[lr])?$/i)) move.sneak = true;
  if (held(/^(?:ctrl|control)(?:_[lr])?$/i)) move.sprint = true;
  const rest = keys.filter((k) => !MOVEMENT_KEY.test(k));
  return rest.length === keys.length ? { keys: rest } : { move, keys: rest };
}

/** Signed smallest difference `to - from` in degrees, in (-180, 180]. */
export function angleDiff(from: number, to: number): number {
  const d = (((to - from) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

/** Yaw that faces `to` from `from` (Bedrock: 0 = +Z, 90 = -X). */
export function yawTo(from: Vec3, to: Vec3): number {
  return (Math.atan2(-(to.x - from.x), to.z - from.z) * 180) / Math.PI;
}

/** Pitch that looks from the eye at `to` (+ is down). */
export function pitchTo(eye: Vec3, to: Vec3): number {
  const horizontal = Math.hypot(to.x - eye.x, to.z - eye.z);
  return (-Math.atan2(to.y - eye.y, horizontal) * 180) / Math.PI;
}

export function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Flight model of one projectile, per game tick (20 per second), with the vanilla update order: move by the
 * velocity, multiply it by `drag`, then subtract `gravity` from its vertical part. `spawnDrop` is how far below the
 * eye the projectile spawns (`offset` [0, -0.1, 0] from the eye anchor).
 */
export interface Ballistics {
  /** Launch speed in blocks per tick. */
  speed: number;
  gravity: number;
  drag: number;
  spawnDrop: number;
  /** Entity id of the flying projectile, as impacts report it. */
  entity: string;
  /** Held items that launch it. */
  items: string[];
  /** Launched by releasing a held right click (bow) instead of a click. */
  charged: boolean;
}

export type ProjectileKind = "snowball" | "egg" | "ender_pearl" | "arrow" | "trident";

/**
 * Bedrock values. Snowball, egg, ender pearl and trident come from the vanilla behavior pack's `minecraft:projectile`
 * (`power`, `gravity`, `inertia`, whose default is 0.99). The arrow speed is a full-charge bow (1 s draw), which
 * scales the launch speed to 3 blocks per tick as in Java Edition; its gravity is the vanilla arrow's 0.05.
 */
export const PROJECTILES: Record<ProjectileKind, Ballistics> = {
  snowball: { speed: 1.5, gravity: 0.03, drag: 0.99, spawnDrop: 0.1, entity: "minecraft:snowball", items: ["minecraft:snowball"], charged: false },
  egg: { speed: 1.5, gravity: 0.03, drag: 0.99, spawnDrop: 0, entity: "minecraft:egg", items: ["minecraft:egg", "minecraft:brown_egg", "minecraft:blue_egg"], charged: false },
  ender_pearl: { speed: 1.5, gravity: 0.025, drag: 1, spawnDrop: 0, entity: "minecraft:ender_pearl", items: ["minecraft:ender_pearl"], charged: false },
  arrow: { speed: 3, gravity: 0.05, drag: 0.99, spawnDrop: 0.1, entity: "minecraft:arrow", items: ["minecraft:bow"], charged: true },
  trident: { speed: 4, gravity: 0.1, drag: 0.99, spawnDrop: 0.1, entity: "minecraft:thrown_trident", items: ["minecraft:trident"], charged: true },
};

/** The projectile a held item launches, if any. */
export function projectileFor(itemId: string | undefined): ProjectileKind | undefined {
  if (!itemId) return undefined;
  return (Object.keys(PROJECTILES) as ProjectileKind[]).find((k) => PROJECTILES[k].items.includes(itemId));
}

/** Longest flight the solver considers (5 s). */
const MAX_FLIGHT_TICKS = 100;

/**
 * Where a projectile launched at `elevationDeg` (+ is up) is when it has covered `horizontal` blocks: its height
 * relative to the launch point and the flight time in (fractional) ticks. Null when it never gets that far.
 */
export function flightTo(b: Ballistics, elevationDeg: number, horizontal: number): { height: number; ticks: number } | null {
  const rad = (elevationDeg * Math.PI) / 180;
  let vh = b.speed * Math.cos(rad);
  let vy = b.speed * Math.sin(rad);
  let h = 0;
  let y = 0;
  for (let n = 1; n <= MAX_FLIGHT_TICKS; n++) {
    const nh = h + vh;
    const ny = y + vy;
    if (nh >= horizontal) {
      const f = vh > 0 ? (horizontal - h) / vh : 0;
      return { height: y + (ny - y) * f, ticks: n - 1 + f };
    }
    h = nh;
    y = ny;
    vh *= b.drag;
    vy = vy * b.drag - b.gravity;
  }
  return null;
}

/**
 * The lower (flatter) launch elevation that reaches a point `horizontal` blocks away and `height` blocks above the
 * launch point, or null when no elevation reaches it.
 */
export function solveElevation(b: Ballistics, horizontal: number, height: number): { elevation: number; ticks: number } | null {
  const miss = (deg: number) => {
    const f = flightTo(b, deg, horizontal);
    return f ? f.height - height : Number.NEGATIVE_INFINITY;
  };
  // Scan upwards to the first elevation that passes at or above the point: the height there rises with elevation
  // until the angle of longest reach, so this is the lower solution.
  let lo = -89;
  if (miss(lo) >= 0) return { elevation: lo, ticks: flightTo(b, lo, horizontal)?.ticks ?? 0 };
  for (let deg = -88.5; deg <= 89; deg += 0.5) {
    const m = miss(deg);
    if (m >= 0) {
      let hi = deg;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (miss(mid) >= 0) hi = mid;
        else lo = mid;
      }
      const f = flightTo(b, hi, horizontal);
      return f ? { elevation: hi, ticks: f.ticks } : null;
    }
    lo = deg;
  }
  return null;
}

export type Intercept =
  | { ok: true; yaw: number; pitch: number; ticks: number; aim: Vec3 }
  | { ok: false; message: string };

/**
 * Aim that hits a target moving at constant `velocity` (blocks per tick) from `origin` (where the projectile spawns).
 * `leadTicks` is how long until the launch, during which the target keeps moving. Returns the view yaw and pitch
 * (Bedrock convention), the flight time and the point the projectile meets the target.
 */
export function solveIntercept(b: Ballistics, origin: Vec3, target: Vec3, velocity: Vec3, leadTicks = 0): Intercept {
  const at = (t: number): Vec3 => ({ x: target.x + velocity.x * t, y: target.y + velocity.y * t, z: target.z + velocity.z * t });
  let ticks = horizontalDistance(origin, target) / b.speed;
  let aim = at(leadTicks + ticks);
  for (let i = 0; i < 30; i++) {
    aim = at(leadTicks + ticks);
    const sol = solveElevation(b, horizontalDistance(origin, aim), aim.y - origin.y);
    if (!sol) {
      const d = horizontalDistance(origin, aim);
      return { ok: false, message: `the target is out of range: ${d.toFixed(1)} blocks away and ${(aim.y - origin.y).toFixed(1)} up, which no ${b.entity.replace("minecraft:", "")} launch angle reaches. Get closer` };
    }
    const converged = Math.abs(sol.ticks - ticks) < 0.01;
    ticks = sol.ticks;
    if (converged) {
      aim = at(leadTicks + ticks);
      return { ok: true, yaw: yawTo(origin, aim), pitch: -sol.elevation, ticks, aim };
    }
  }
  return { ok: false, message: "the target moves too fast to intercept" };
}

/** Horizontal velocity (blocks per tick) from timestamped positions, by a least-squares line over game ticks. */
export function estimateVelocity(samples: readonly { tick: number; location: Vec3 }[]): Vec3 {
  if (samples.length < 2) return { x: 0, y: 0, z: 0 };
  const n = samples.length;
  const mt = samples.reduce((a, s) => a + s.tick, 0) / n;
  const mx = samples.reduce((a, s) => a + s.location.x, 0) / n;
  const mz = samples.reduce((a, s) => a + s.location.z, 0) / n;
  let stt = 0;
  let stx = 0;
  let stz = 0;
  for (const s of samples) {
    const dt = s.tick - mt;
    stt += dt * dt;
    stx += dt * (s.location.x - mx);
    stz += dt * (s.location.z - mz);
  }
  if (stt === 0) return { x: 0, y: 0, z: 0 };
  return { x: stx / stt, y: 0, z: stz / stt };
}

/**
 * Degrees of rotation per pixel of mouse motion. Starts from the game's default sensitivity and learns from every
 * turn, so it adapts to the user's sensitivity setting.
 */
export class LookCalibration {
  degPerPx: number;
  constructor(degPerPx = 0.26) {
    this.degPerPx = degPerPx;
  }
  /**
   * Update from a move of `px` pixels that turned the view by `deg` degrees, trusting it by `weight` (0 to 1). One
   * reading moves the estimate by at most half again, so a view turned by something else (a teleport) cannot wreck it.
   */
  observe(px: number, deg: number, weight = 0.5): void {
    if (Math.abs(px) < 15 || Math.abs(deg) < 1) return;
    const measured = Math.max(this.degPerPx / 1.5, Math.min(this.degPerPx * 1.5, Math.abs(deg / px)));
    if (measured > 0.01 && measured < 5) this.degPerPx = this.degPerPx * (1 - weight) + measured * weight;
  }
}

/** Wall clock and timer of the control loops. */
export interface Clock {
  now(): number;
  /** Rejects with the signal's reason when it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => sleep(Math.max(0, ms), undefined, signal ? { signal } : undefined),
};

/** Mouse steps per second, like a gaming mouse polled at 120 Hz. */
export const CAMERA_HZ = 120;
const FRAME_MS = 1000 / CAMERA_HZ;
/** The engine applies a view on the next frame, and the tick stream shows it on the next tick. */
const ENGINE_LATENCY_MS = 50;
export const TURN_MIN_MS = 150;
export const TURN_MAX_MS = 450;
/** Fitts' law constants: movement time = a + b * log2(distance / width + 1). */
const FITTS_A_MS = 120;
const FITTS_B_MS = 55;
/** A streamed state older than this is not steered on: the camera holds still until the stream is back. */
const STALE_STATE_MS = 300;

/** Minimum-jerk position profile: the fraction of a movement done at fraction `t` of its duration (0 to 1). */
export function minimumJerk(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return u * u * u * (10 + u * (6 * u - 15));
}

/** How long a hand takes to turn `distanceDeg` onto a target `widthDeg` wide (Fitts' law), in milliseconds. */
export function turnDurationMs(distanceDeg: number, widthDeg: number): number {
  const id = Math.log2(Math.abs(distanceDeg) / Math.max(0.5, widthDeg) + 1);
  return Math.max(TURN_MIN_MS, Math.min(TURN_MAX_MS, FITTS_A_MS + FITTS_B_MS * id));
}

/** One aimed mouse movement (a submovement), relative to the view when it started. */
export interface TurnPlan {
  startedAt: number;
  durationMs: number;
  /** Planned rotation in degrees, the overshoot or undershoot included. */
  yaw: number;
  pitch: number;
  /** Where the plan ends relative to the target: + is past it (overshoot), - short of it. */
  missYaw: number;
  missPitch: number;
  /** Sideways bow of the path as a fraction of its length: hands move in slight arcs, not straight lines. */
  bow: number;
}

/**
 * Plan a turn by `errYaw`/`errPitch` degrees. A primary movement over 8 degrees lands a few percent long or short
 * and bows slightly, as a hand does, and the camera follows it with a short correction.
 */
export function planTurn(errYaw: number, errPitch: number, widthDeg: number, startedAt: number, random: () => number = Math.random, primary = true): TurnPlan {
  const len = Math.hypot(errYaw, errPitch);
  const human = primary && len > 8;
  const miss = human ? random() * 0.07 - 0.03 : 0;
  const bow = human ? (random() - 0.5) * 0.08 : 0;
  return {
    startedAt,
    durationMs: turnDurationMs(len, widthDeg),
    yaw: errYaw * (1 + miss),
    pitch: errPitch * (1 + miss),
    missYaw: errYaw * miss,
    missPitch: errPitch * miss,
    bow,
  };
}

/** The rotation a plan has reached at time `atMs`, relative to its start. */
export function planOffset(plan: TurnPlan, atMs: number): { yaw: number; pitch: number } {
  const tau = Math.max(0, Math.min(1, (atMs - plan.startedAt) / plan.durationMs));
  const s = minimumJerk(tau);
  const len = Math.hypot(plan.yaw, plan.pitch);
  if (len === 0) return { yaw: 0, pitch: 0 };
  const side = plan.bow * len * Math.sin(Math.PI * tau);
  return { yaw: plan.yaw * s - (plan.pitch / len) * side, pitch: plan.pitch * s + (plan.yaw / len) * side };
}

function gauss(random: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, random()))) * Math.cos(2 * Math.PI * random());
}

/** A view direction; an undefined part is left as it is. */
export interface Aim {
  yaw?: number;
  pitch?: number;
}

/** What the camera keeps the crosshair on. `aim` runs every frame with the latest state, so a moving target is followed. */
export interface AimTarget {
  aim(me: PlayerState): Aim | undefined;
  /** Angular size of the target: wider targets get faster turns (Fitts' law) and a looser hold. */
  widthDeg: number;
}

interface Sample {
  at: number;
  state: PlayerState;
}

/** The view yaw/pitch that looks from the player's eye at `point`. */
export function aimAt(me: PlayerState, point: Vec3): Aim {
  const eye = { ...me.location, y: me.location.y + EYE_HEIGHT };
  // Straight above or below, the yaw is meaningless and would swing wildly with every step, so it is kept.
  if (horizontalDistance(eye, point) < 0.3) return { pitch: pitchTo(eye, point) };
  return { yaw: yawTo(eye, point), pitch: pitchTo(eye, point) };
}

/**
 * The mouse hand. A loop at 120 Hz moves the view in small relative steps along minimum-jerk submovements whose
 * duration follows Fitts' law, with slight jitter and a correction after the primary movement. It closes the loop on
 * the streamed state like a Smith predictor: the view now is the latest state plus the steps sent since that state
 * left the game (`latencyMs`), so it never waits for the view to settle before the next step and never double-counts
 * a step still in flight. The target is re-read every frame, so moving targets are tracked continuously.
 *
 * With an absolute view setter (`useAbsolute`, the engine route) the same curve, overshoot and jitter are sent as
 * the view itself every frame: the commanded view is exact, so there is no sensitivity to learn and no steps in
 * flight to predict.
 */
export class Camera {
  readonly yawCalibration = new LookCalibration();
  readonly pitchCalibration = new LookCalibration();
  /** Milliseconds from a mouse step to the streamed state showing it, fitted after every turn (one tick on the engine route). */
  get latencyMs(): number {
    return this.#absolute ? ENGINE_LATENCY_MS : this.#mouseLatencyMs;
  }

  set latencyMs(ms: number) {
    this.#mouseLatencyMs = ms;
  }

  #mouseLatencyMs = 150;
  /** The engine's view setter; undefined sends relative mouse pixels. */
  #absolute?: (pitch: number, yaw: number) => Promise<void>;
  /** The view last commanded through `#absolute`. */
  #cmd?: { yaw: number; pitch: number };
  readonly #world: PlayerWorld;
  readonly #clock: Clock;
  readonly #random: () => number;
  #target?: AimTarget;
  #plan?: TurnPlan;
  /** How much of the plan's rotation has been sent. */
  #planSent = { yaw: 0, pitch: 0 };
  /** The aim when the plan started: a target that moves far from it gets a new plan. */
  #planAim = { yaw: 0, pitch: 0 };
  /** Arrival time minus game time of the least delayed state lately (see `#dejitter`). */
  #tickOffset?: number;
  #loop?: Promise<void>;
  #failure?: unknown;
  #sends: { at: number; x: number; y: number }[] = [];
  #carry = { x: 0, y: 0 };
  #lastSendAt = Number.NEGATIVE_INFINITY;
  #pxTotal = { x: 0, y: 0 };
  #calStart?: { at: number; yaw: number; pitch: number; x: number; y: number };
  /** Recent streamed rotations, for the latency fit. */
  #history: { at: number; yaw: number; pitch: number }[] = [];
  #sample?: Sample;
  #view?: { yaw: number; pitch: number };
  #error = { predicted: Number.POSITIVE_INFINITY, observed: Number.POSITIVE_INFINITY };
  /** The aim at the last frame, to follow the target's own motion. */
  #lastAim?: Aim;
  /** When the state will show where the last movement landed (see `#frame`). */
  #landsAt = Number.NEGATIVE_INFINITY;

  constructor(world: PlayerWorld, clock: Clock = realClock, random: () => number = Math.random) {
    this.#world = world;
    this.#clock = clock;
    this.#random = random;
  }

  /** Send absolute views through `set` (the engine route), or relative mouse pixels again (undefined). */
  useAbsolute(set: ((pitch: number, yaw: number) => Promise<void>) | undefined): void {
    this.#absolute = set;
    this.#cmd = undefined;
    this.#plan = undefined;
  }

  /** True while views go through the engine's absolute setter. */
  get absolute(): boolean {
    return this.#absolute !== undefined;
  }

  /** Keep the crosshair on `target`, or stop moving the mouse (undefined). */
  track(target: AimTarget | undefined): void {
    this.#target = target;
    this.#plan = undefined;
    this.#error = { predicted: Number.POSITIVE_INFINITY, observed: Number.POSITIVE_INFINITY };
    this.#lastAim = undefined;
    if (!target) return;
    this.#failure = undefined;
    this.#loop ??= this.#run();
  }

  /** The view the game will show once the steps in flight land (the latest state while idle). */
  view(): { yaw: number; pitch: number } | undefined {
    if (this.#target && this.#view) return this.#view;
    const s = this.#world.sample?.()?.state ?? this.#sample?.state;
    return s ? { yaw: s.rotation.y, pitch: s.rotation.x } : undefined;
  }

  /**
   * The player's state with its position where the client has it now. The client moves the player itself, and on
   * the mouse route the streamed state shows that movement `latencyMs` late (0.6 to 0.9 blocks at walking speed), so
   * the horizontal position is carried forward by the velocity. The engine route's state is one tick old and is
   * returned as it is.
   */
  present(s: PlayerState): PlayerState {
    if (this.#absolute || s.source === "engine") return s;
    const ticks = this.latencyMs / 50;
    return { ...s, location: { x: s.location.x + s.velocity.x * ticks, y: s.location.y, z: s.location.z + s.velocity.z * ticks } };
  }

  /** Angle to the target in degrees, predicted from the steps sent and as the latest streamed state shows it. */
  error(): { predicted: number; observed: number } {
    if (this.#failure) throw this.#failure;
    return this.#error;
  }

  /** On the target within `toleranceDeg`, by prediction and in the game, with no movement under way. */
  onTarget(toleranceDeg: number): boolean {
    const e = this.error();
    return !this.#plan && e.predicted <= toleranceDeg && e.observed <= toleranceDeg;
  }

  /** Wait until on target; false after `timeoutMs`. */
  async settle(toleranceDeg: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = this.#clock.now() + timeoutMs;
    for (;;) {
      if (this.onTarget(toleranceDeg)) return true;
      if (this.#clock.now() > deadline) return false;
      await this.#clock.sleep(FRAME_MS, signal);
    }
  }

  async #run(): Promise<void> {
    let next = this.#clock.now();
    try {
      // After the target is dropped, keep reading states (without moving) until the last steps show in one, so
      // every turn teaches the sensitivity.
      while (this.#target || this.#learning()) {
        await this.#frame();
        next += FRAME_MS;
        const now = this.#clock.now();
        // Fell behind (a slow step or a busy event loop): skip frames instead of bursting.
        if (next < now - 4 * FRAME_MS) next = now;
        await this.#clock.sleep(next - now);
      }
    } catch (err) {
      this.#failure = err;
      this.#target = undefined;
    }
    // Synchronously after the loop condition, so a track() racing the exit always starts a new loop.
    this.#loop = undefined;
  }

  /** Steps were sent that no quiet state has shown yet. */
  #learning(): boolean {
    const start = this.#calStart;
    return start !== undefined && (start.x !== this.#pxTotal.x || start.y !== this.#pxTotal.y) && this.#clock.now() - this.#lastSendAt < 1000;
  }

  /** Resolves once the mouse loop has stopped (and finished learning from the last turn). */
  async idle(): Promise<void> {
    await this.#loop;
  }

  async #latest(now: number): Promise<Sample | undefined> {
    const streamed = this.#world.sample ? this.#world.sample() : { at: now, state: await this.#world.state(STALE_STATE_MS) };
    if (!streamed || now - streamed.at > STALE_STATE_MS) {
      // Never steer blind: wait for a fresh state (this also starts the stream).
      await this.#world.state(STALE_STATE_MS);
      return undefined;
    }
    return this.#dejitter(streamed);
  }

  /**
   * Date a state by its game tick instead of its arrival. States leave the game every 50 ms but reach us in uneven
   * batches (±15 ms), which at turning speed would read as degrees of error. The least delayed arrival is closest to
   * when the game made the state, so the offset follows the lower envelope and creeps up slowly (lag spikes). The
   * server takes the client's rotation every second tick, so a rotation equal to the last one is a tick older.
   */
  #dejitter(s: Sample): Sample {
    const tick = s.state.tick;
    // The agent's tick notifications arrive over loopback as they are made, so their arrival time is their date.
    if (!(tick > 0) || s.state.source === "engine") return s;
    const o = s.at - tick * 50;
    if (this.#tickOffset === undefined || o < this.#tickOffset || o - this.#tickOffset > 500) this.#tickOffset = o;
    else this.#tickOffset += (o - this.#tickOffset) * 0.02;
    const prev = this.#sample?.state;
    const same = prev !== undefined && tick > prev.tick && prev.rotation.x === s.state.rotation.x && prev.rotation.y === s.state.rotation.y;
    return { at: tick * 50 + this.#tickOffset - (same ? 50 : 0), state: s.state };
  }

  /** Learn the sensitivity and the latency from the rotation between two quiet states (no step in flight). */
  #learn(sample: Sample): void {
    if (this.#sample && sample.at <= this.#sample.at) return;
    this.#sample = sample;
    const r = sample.state.rotation;
    this.#history.push({ at: sample.at, yaw: r.y, pitch: r.x });
    while (this.#history.length > 2 && (this.#history[0]?.at ?? sample.at) < sample.at - 3000) this.#history.shift();
    if (!this.#quiet(sample)) return;
    const start = this.#calStart;
    const px = this.#pxTotal;
    if (start && (px.x !== start.x || px.y !== start.y)) {
      const dx = px.x - start.x;
      const dy = px.y - start.y;
      // A quiet-to-quiet window measures the sensitivity exactly. Yaw wraps at ±180, so the turn is taken as the
      // wrap closest to what the pixels should have done.
      const turned = angleDiff(start.yaw, r.y);
      const expected = dx * this.yawCalibration.degPerPx;
      this.yawCalibration.observe(dx, turned + 360 * Math.round((expected - turned) / 360), Math.min(0.9, Math.abs(dx) / 300));
      if (Math.abs(start.pitch) < 88 && Math.abs(r.x) < 88) this.pitchCalibration.observe(dy, r.x - start.pitch, Math.min(0.9, Math.abs(dy) / 300));
      this.#fitLatency(start, sample.at);
    }
    this.#calStart = { at: sample.at, yaw: r.y, pitch: r.x, x: px.x, y: px.y };
  }

  /**
   * The latency that best explains the states of a quiet-to-quiet window: each state should show exactly the steps
   * sent `latencyMs` or more before it.
   */
  #fitLatency(start: { at: number; yaw: number; pitch: number }, end: number): void {
    const states = this.#history.filter((h) => h.at > start.at && h.at <= end);
    const sends = this.#sends.filter((s) => s.at > start.at - this.latencyMs - 40 && s.at <= end);
    if (states.length < 4 || sends.length < 5) return;
    const usePitch = Math.abs(start.pitch) < 88 && states.every((h) => Math.abs(h.pitch) < 88);
    let best = this.latencyMs;
    let bestErr = Number.POSITIVE_INFINITY;
    for (let latency = 20; latency <= 300; latency += 10) {
      let err = 0;
      for (const h of states) {
        let x = 0;
        let y = 0;
        for (const s of sends) {
          if (s.at <= h.at - latency) {
            x += s.x;
            y += s.y;
          }
        }
        const ey = angleDiff(start.yaw + x * this.yawCalibration.degPerPx, h.yaw);
        const ep = usePitch ? start.pitch + y * this.pitchCalibration.degPerPx - h.pitch : 0;
        err += ey * ey + ep * ep;
      }
      if (err < bestErr) {
        bestErr = err;
        best = latency;
      }
    }
    // The correction after a fast movement waits for the landing to show (see `#frame`), so the estimate does not
    // need a safety margin.
    this.latencyMs = this.latencyMs * 0.5 + Math.max(60, best) * 0.5;
  }

  /** The sample shows every step sent so far. */
  #quiet(sample: Sample): boolean {
    return sample.at - this.#lastSendAt > this.latencyMs + 40;
  }

  /** Pixels sent after the sample left the game. */
  #inflight(sampleAt: number, now: number): { x: number; y: number } {
    while (this.#sends.length > 0 && (this.#sends[0]?.at ?? now) < now - 3000) this.#sends.shift();
    let x = 0;
    let y = 0;
    for (const s of this.#sends) {
      if (s.at > sampleAt - this.latencyMs) {
        x += s.x;
        y += s.y;
      }
    }
    return { x, y };
  }

  async #frame(): Promise<void> {
    const target = this.#target;
    const now = this.#clock.now();
    const sample = await this.#latest(now);
    if (!sample) return;
    this.#learn(sample);
    if (!target || this.#target !== target) return;
    const s = sample.state;
    // From where the player is now: the target is aimed at from the client's position, not the streamed one.
    const aim = target.aim(this.present(s));
    if (!aim) {
      this.#plan = undefined;
      this.#error = { predicted: Number.POSITIVE_INFINITY, observed: Number.POSITIVE_INFINITY };
      return;
    }
    const view = this.#absolute ? this.#commanded(sample, now) : this.#predicted(sample, now);
    this.#view = view;
    const goalPitch = aim.pitch === undefined ? undefined : Math.max(-89, Math.min(89, aim.pitch));
    const ey = aim.yaw === undefined ? 0 : angleDiff(view.yaw, aim.yaw);
    const ep = goalPitch === undefined ? 0 : goalPitch - view.pitch;
    const oy = aim.yaw === undefined ? 0 : angleDiff(s.rotation.y, aim.yaw);
    const op = goalPitch === undefined ? 0 : goalPitch - s.rotation.x;
    const err = Math.hypot(ey, ep);
    this.#error = { predicted: err, observed: Math.hypot(oy, op) };

    let dy = 0;
    let dp = 0;
    let plan = this.#plan;
    const aimYaw = aim.yaw ?? view.yaw;
    const aimPitch = goalPitch ?? view.pitch;
    // The target's own motion since the last frame, followed directly (feed-forward) so tracking does not lag. A
    // jump (a new target) is not motion.
    const last = this.#lastAim;
    const ffY = last?.yaw !== undefined && aim.yaw !== undefined ? angleDiff(last.yaw, aim.yaw) : 0;
    const ffP = last?.pitch !== undefined && goalPitch !== undefined ? goalPitch - last.pitch : 0;
    this.#lastAim = { ...(aim.yaw !== undefined ? { yaw: aim.yaw } : {}), ...(goalPitch !== undefined ? { pitch: goalPitch } : {}) };
    const smooth = Math.abs(ffY) + Math.abs(ffP) < 10;
    // Smooth target motion is followed by the feed-forward, so the plan's aim moves with it. Only a jump (a new
    // target, a teleport) beyond the plan's reach makes a new plan.
    if (plan && smooth) this.#planAim = { yaw: this.#planAim.yaw + ffY, pitch: this.#planAim.pitch + ffP };
    if (plan && Math.hypot(angleDiff(this.#planAim.yaw, aimYaw), aimPitch - this.#planAim.pitch) > Math.max(4, 0.3 * Math.hypot(plan.yaw, plan.pitch))) plan = this.#plan = undefined;
    // After a fast movement the prediction is only as good as the latency estimate, so the correction waits until
    // the state shows where the movement landed, as a hand waits for the eye.
    const landed = sample.at >= this.#landsAt;
    if (!plan && landed && err > Math.max(0.4, target.widthDeg * 0.3)) {
      plan = this.#plan = planTurn(ey, ep, target.widthDeg, now, this.#random);
      this.#planSent = { yaw: 0, pitch: 0 };
      this.#planAim = { yaw: aimYaw, pitch: aimPitch };
    }
    if (plan) {
      const next = planOffset(plan, now + FRAME_MS);
      const stepY = next.yaw - this.#planSent.yaw;
      const stepP = next.pitch - this.#planSent.pitch;
      // How far off the plan the view is: the target moved, a step landed differently, or the sensitivity is off.
      const residualY = ey + plan.missYaw - (plan.yaw - this.#planSent.yaw);
      const residualP = ep + plan.missPitch - (plan.pitch - this.#planSent.pitch);
      this.#planSent = next;
      // Follow the profile, pull a little of the residual in per frame, and shake a little with the speed. The gains
      // stay low so a misjudged latency cannot make the view swing.
      const speed = Math.hypot(stepY, stepP);
      dy = stepY + (smooth ? ffY : 0) + 0.05 * residualY + gauss(this.#random) * 0.04 * speed;
      dp = stepP + (smooth ? ffP : 0) + 0.05 * residualP + gauss(this.#random) * 0.04 * speed;
      if (now + FRAME_MS >= plan.startedAt + plan.durationMs) {
        this.#plan = undefined;
        this.#landsAt = now + FRAME_MS + this.latencyMs;
      }
    } else {
      if (smooth) {
        dy = ffY;
        dp = ffP;
      }
      // Holding on a target: small proportional corrections once the view has landed.
      if (landed && err > 0.15) {
        dy += 0.1 * ey;
        dp += 0.1 * ep;
      }
    }
    if (goalPitch === undefined) dp = 0;
    dp = Math.max(-89.5 - view.pitch, Math.min(89.5 - view.pitch, dp));
    await this.#send(dy, dp, now);
  }

  /** The view the engine shows: the last commanded one, re-read from the game when something else turned it. */
  #commanded(sample: Sample, now: number): { yaw: number; pitch: number } {
    const r = sample.state.rotation;
    const cmd = this.#cmd;
    // A state taken after the last command that disagrees with it means the game turned the view (a respawn, a
    // teleport, a server correction): start from where the game is.
    const settled = sample.at > this.#lastSendAt + ENGINE_LATENCY_MS && now - this.#lastSendAt > 250;
    if (!cmd || (settled && Math.hypot(angleDiff(cmd.yaw, r.y), cmd.pitch - r.x) > 1)) this.#cmd = { yaw: r.y, pitch: r.x };
    return { ...(this.#cmd ?? { yaw: r.y, pitch: r.x }) };
  }

  /** The view the mouse steps in flight will land on (Smith predictor). */
  #predicted(sample: Sample, now: number): { yaw: number; pitch: number } {
    const s = sample.state;
    const inflight = this.#inflight(sample.at, now);
    return { yaw: s.rotation.y + inflight.x * this.yawCalibration.degPerPx, pitch: s.rotation.x + inflight.y * this.pitchCalibration.degPerPx };
  }

  async #send(dyDeg: number, dpDeg: number, now: number): Promise<void> {
    const set = this.#absolute;
    if (set) {
      if (Math.abs(dyDeg) < 1e-3 && Math.abs(dpDeg) < 1e-3) return;
      const cmd = this.#cmd ?? { yaw: 0, pitch: 0 };
      const next = { yaw: ((((cmd.yaw + dyDeg + 180) % 360) + 360) % 360) - 180, pitch: Math.max(-89.5, Math.min(89.5, cmd.pitch + dpDeg)) };
      await set(next.pitch, next.yaw);
      this.#cmd = next;
      this.#lastSendAt = now;
      return;
    }
    const fx = dyDeg / this.yawCalibration.degPerPx + this.#carry.x;
    const fy = dpDeg / this.pitchCalibration.degPerPx + this.#carry.y;
    const x = Math.max(-300, Math.min(300, Math.round(fx)));
    const y = Math.max(-300, Math.min(300, Math.round(fy)));
    this.#carry = { x: Math.abs(fx - x) < 1 ? fx - x : 0, y: Math.abs(fy - y) < 1 ? fy - y : 0 };
    if (!x && !y) return;
    await this.#world.input.look(x, y);
    this.#sends.push({ at: now, x, y });
    this.#pxTotal = { x: this.#pxTotal.x + x, y: this.#pxTotal.y + y };
    this.#lastSendAt = now;
  }
}

/** The keys (WASD, eight directions) that walk toward world yaw `heading` with the view at `viewYaw`. */
export function moveKeys(viewYaw: number, heading: number): string[] {
  // Yaw grows clockwise seen from above, so a positive difference is to the right.
  const sector = Math.round(angleDiff(viewYaw, heading) / 45);
  switch (sector) {
    case 0:
      return [KEYS.forward];
    case 1:
      return [KEYS.forward, KEYS.right];
    case 2:
      return [KEYS.right];
    case 3:
      return [KEYS.back, KEYS.right];
    case -1:
      return [KEYS.forward, KEYS.left];
    case -2:
      return [KEYS.left];
    case -3:
      return [KEYS.back, KEYS.left];
    default:
      return [KEYS.back];
  }
}

/** Held movement: forward +1 is W, strafe +1 is D (right), both from -1 to 1. */
export interface MoveVector {
  forward: number;
  strafe: number;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
}

export const STILL: Readonly<MoveVector> = Object.freeze({ forward: 0, strafe: 0, jump: false, sneak: false, sprint: false });

/** The analog walk toward world yaw `heading` with the view at `viewYaw` (full speed, any direction). */
export function walkVector(viewYaw: number, heading: number): { forward: number; strafe: number } {
  const d = (angleDiff(viewYaw, heading) * Math.PI) / 180;
  // Rounded so a steady heading repeats the same vector and the engine route can skip the resend.
  return { forward: Math.round(Math.cos(d) * 1000) / 1000, strafe: Math.round(Math.sin(d) * 1000) / 1000 };
}

/** The engine route's input methods as the controller needs them. Every method throws on failure. */
export interface EngineInput {
  /** Connect and start the motion stream. Throws when the engine route cannot be used now or the stream sent nothing yet. */
  prepare(): Promise<void>;
  /** The provider answers right now. */
  reachable(): Promise<boolean>;
  look(pitch: number, yaw: number): Promise<void>;
  move(move: MoveVector): Promise<void>;
  release(): Promise<void>;
  /** One attack through the game mode, as a click. Returns the struck entity's id (the script `Entity.id`) or null. */
  attack(): Promise<string | null>;
  /**
   * Press (true) or let go of (false) the use button with the held item: throws, draws, eats, places. A press is held
   * while it is repeated: the engine route repeats it every 300 ms.
   */
  use(down: boolean): Promise<void>;
  /**
   * Press (true) or let go of (false) the attack button and keep it held, which breaks the block under the crosshair in
   * survival (`mine`). A press is held while it is repeated: the engine route repeats it every 300 ms. Optional:
   * without it `mine` needs the keyboard route.
   */
  attackHold?(down: boolean): Promise<void>;
  /**
   * Press (true) or let go of (false) one key on the game's own keyboard, by its xdotool name (`1`, `e`, `F5`): the
   * hotbar keys of `select_slot` and the keys `hold` names. Optional: without it those keys need the keyboard route.
   */
  key?(key: string, down: boolean): Promise<void>;
  /** The provider's input lock: the user can take control with F9 while an action runs. */
  takeover?: InputTakeover;
}

/** The user's side of the input provider's input lock. */
export interface InputTakeover {
  /** The user pressed F9 to take control and has not given it back. */
  readonly userHasControl: boolean;
  /** `listener` runs each time the user takes control. Returns the function that removes it. */
  onTakeover(listener: () => void): () => void;
  /** Resolves once the user gave control back (at once when they do not hold it), or when `signal` aborts. */
  untilControl(signal?: AbortSignal): Promise<void>;
}

/** An action the user interrupted with F9 ends with this message. */
export const TAKEOVER_MESSAGE = "the user took control (F9)";

export type InputKind = "engine" | "keyboard";
export type InputMode = "auto" | InputKind;

/** The engine route failed. The controller lets go of everything and finishes with the keyboard. */
export class EngineInputError extends Error {}

/** How the controller's hands reach the game. */
export interface InputBackend {
  readonly kind: InputKind;
  /** The absolute view setter of the engine route. Undefined: the camera sends relative mouse pixels. */
  readonly look?: (pitch: number, yaw: number) => Promise<void>;
  /** Hold exactly this movement. */
  move(move: MoveVector): Promise<void>;
  /** One attack click: the struck entity's id or null when the route can tell, undefined when it cannot. */
  attack(): Promise<string | null | undefined>;
  /** Press (true) or let go of (false) the use button. */
  use(down: boolean): Promise<void>;
  /** Let go of everything this route holds. Never throws. */
  release(): Promise<void>;
}

/** The system's keyboard and mouse route (xdotool in gamescope, SendInput on Windows): held keys, mouse buttons, relative mouse look. */
export class KeyboardBackend implements InputBackend {
  readonly kind = "keyboard";
  readonly #input: PlayerInput;
  readonly #held = new Set<string>();
  #attackRelease?: NodeJS.Timeout;
  #using = false;

  constructor(input: PlayerInput) {
    this.#input = input;
  }

  async move(move: MoveVector): Promise<void> {
    const want: string[] = [];
    // Sprint goes down before the walking keys, as a player holds it.
    if (move.sprint) want.push(KEYS.sprint);
    if (Math.hypot(move.forward, move.strafe) > 0.3) want.push(...moveKeys(0, (Math.atan2(move.strafe, move.forward) * 180) / Math.PI));
    if (move.jump) want.push(KEYS.jump);
    if (move.sneak) want.push(KEYS.sneak);
    for (const k of [...this.#held]) {
      if (want.includes(k)) continue;
      await this.#input.keyUp(k);
      this.#held.delete(k);
    }
    for (const k of want) {
      if (this.#held.has(k)) continue;
      await this.#input.keyDown(k);
      this.#held.add(k);
    }
  }

  async attack(): Promise<undefined> {
    clearTimeout(this.#attackRelease);
    await this.#input.button(1, true);
    // Released without blocking, so steering and aiming go on.
    this.#attackRelease = setTimeout(() => {
      this.#attackRelease = undefined;
      void this.#input.button(1, false).catch(() => undefined);
    }, 60);
    return undefined;
  }

  async use(down: boolean): Promise<void> {
    if (down === this.#using) return;
    await this.#input.button(3, down);
    this.#using = down;
  }

  async release(): Promise<void> {
    if (this.#attackRelease) {
      clearTimeout(this.#attackRelease);
      this.#attackRelease = undefined;
      await this.#input.button(1, false).catch(() => undefined);
    }
    if (this.#using) await this.use(false).catch(() => undefined);
    this.#using = false;
    for (const k of [...this.#held]) {
      await this.#input.keyUp(k).catch(() => undefined);
      this.#held.delete(k);
    }
  }
}

/** The agent drops held movement after a second without an update, so a held move is repeated this often. */
const MOVE_REFRESH_MS = 300;

/** Views sent before the oldest one's answer is awaited: about 70 ms of camera frames at 120 Hz. */
const MAX_LOOKS_IN_FLIGHT = 8;

/**
 * The engine route: absolute view every frame, a movement vector held by the game every tick, and attacks and item
 * use through the game's own click callbacks. The first failure is kept and thrown by every later call as an
 * `EngineInputError`.
 */
export class EngineBackend implements InputBackend {
  readonly kind = "engine";
  readonly look: (pitch: number, yaw: number) => Promise<void>;
  readonly #engine: EngineInput;
  #move: MoveVector = { ...STILL };
  #sentAt = Number.NEGATIVE_INFINITY;
  #keepalive?: NodeJS.Timeout;
  #failure?: EngineInputError;
  #looksInFlight = 0;
  /** Keys this route holds down through `EngineInput.key`. */
  readonly #keys = new Set<string>();
  /** Buttons this route holds, pressed again every `MOVE_REFRESH_MS`: the agent lets a held button go a second after its last press. */
  readonly #buttons = new Set<"use" | "attack">();
  #buttonRenewal?: NodeJS.Timeout;

  constructor(engine: EngineInput) {
    this.#engine = engine;
    this.look = (pitch, yaw) => this.#look(pitch, yaw);
  }

  /** The failure that ended this route, if any. */
  get failure(): EngineInputError | undefined {
    return this.#failure;
  }

  #fail(err: unknown): EngineInputError {
    this.#failure ??= new EngineInputError(err instanceof Error ? err.message : String(err), { cause: err });
    this.#stopKeepalive();
    this.#stopRenewal();
    return this.#failure;
  }

  #press(button: "use" | "attack", down: boolean): Promise<void> {
    if (button === "use") return this.#engine.use(down);
    if (!this.#engine.attackHold) return Promise.reject(new Error("the input provider cannot hold the attack button"));
    return this.#engine.attackHold(down);
  }

  async #hold(button: "use" | "attack", down: boolean): Promise<void> {
    await this.#do(() => this.#press(button, down));
    if (down) this.#buttons.add(button);
    else this.#buttons.delete(button);
    if (this.#buttons.size === 0) this.#stopRenewal();
    else
      this.#buttonRenewal ??= setInterval(() => {
        for (const b of this.#buttons) void this.#press(b, true).catch((err: unknown) => void this.#fail(err));
      }, MOVE_REFRESH_MS);
    this.#buttonRenewal?.unref?.();
  }

  #stopRenewal(): void {
    clearInterval(this.#buttonRenewal);
    this.#buttonRenewal = undefined;
  }

  async #do<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#failure) throw this.#failure;
    try {
      return await fn();
    } catch (err) {
      throw this.#fail(err);
    }
  }

  /**
   * `input.look` answers after a frame or so (25 ms median, measured live), which would hold a 120 Hz camera to the
   * game's frame rate and let a slow answer stall it. Views go out in order over the one connection, so a few may be
   * in flight; a failure surfaces on the next view.
   */
  async #look(pitch: number, yaw: number): Promise<void> {
    if (this.#failure) throw this.#failure;
    this.#looksInFlight++;
    const sent = this.#engine
      .look(pitch, yaw)
      .catch((err: unknown) => void this.#fail(err))
      .finally(() => this.#looksInFlight--);
    if (this.#looksInFlight > MAX_LOOKS_IN_FLIGHT) await sent;
    if (this.#failure) throw this.#failure;
  }

  async move(move: MoveVector): Promise<void> {
    const same =
      move.forward === this.#move.forward && move.strafe === this.#move.strafe && move.jump === this.#move.jump && move.sneak === this.#move.sneak && move.sprint === this.#move.sprint;
    if (same && Date.now() - this.#sentAt < MOVE_REFRESH_MS) return;
    const next = { ...move };
    await this.#do(() => this.#engine.move(next));
    this.#move = next;
    this.#sentAt = Date.now();
    const still = !next.forward && !next.strafe && !next.jump && !next.sneak && !next.sprint;
    if (still) this.#stopKeepalive();
    else this.#keepalive ??= this.#startKeepalive();
  }

  #startKeepalive(): NodeJS.Timeout {
    const timer = setInterval(() => {
      if (Date.now() - this.#sentAt < MOVE_REFRESH_MS - 20) return;
      void this.move(this.#move).catch(() => undefined);
    }, MOVE_REFRESH_MS / 2);
    timer.unref?.();
    return timer;
  }

  #stopKeepalive(): void {
    clearInterval(this.#keepalive);
    this.#keepalive = undefined;
  }

  attack(): Promise<string | null> {
    return this.#do(() => this.#engine.attack());
  }

  use(down: boolean): Promise<void> {
    return this.#hold("use", down);
  }

  /** The provider holds the attack button (`EngineInput.attackHold`). */
  get holdsAttack(): boolean {
    return this.#engine.attackHold !== undefined;
  }

  /** Press and keep holding (true) or let go of (false) the attack button (`holdsAttack` must be true). */
  holdAttack(down: boolean): Promise<void> {
    return this.#hold("attack", down);
  }

  /** The provider takes keys on the game's own keyboard. */
  get keys(): boolean {
    return this.#engine.key !== undefined;
  }

  /** Press or let go of a key through the provider (`keys` must be true). */
  async key(name: string, down: boolean): Promise<void> {
    if (this.#keys.has(name) === down) return;
    await this.#do(async () => {
      if (!this.#engine.key) throw new Error("the input provider takes no keys");
      await this.#engine.key(name, down);
    });
    if (down) this.#keys.add(name);
    else this.#keys.delete(name);
  }

  async release(): Promise<void> {
    this.#stopKeepalive();
    this.#stopRenewal();
    this.#buttons.clear();
    this.#move = { ...STILL };
    this.#sentAt = Number.NEGATIVE_INFINITY;
    const keys = [...this.#keys];
    this.#keys.clear();
    if (this.#failure) return;
    for (const k of keys) await this.#engine.key?.(k, false).catch(() => undefined);
    await this.#engine.use(false).catch(() => undefined);
    await this.#engine.release().catch(() => undefined);
  }
}

/** Position readings of one entity, polled in the background, with velocity and extrapolation for aiming. */
export class Follow {
  readonly id: string;
  readonly typeId: string;
  readonly samples: { tick: number; location: Vec3; wall: number }[] = [];
  last: EntityInfo;
  lastWall: number;
  gone = false;
  failure?: unknown;
  #stopped = false;

  constructor(world: PlayerWorld, clock: Clock, first: EntityInfo) {
    this.id = first.id;
    this.typeId = first.typeId;
    this.last = first;
    this.lastWall = clock.now();
    this.samples.push({ tick: first.tick ?? 0, location: first.location, wall: this.lastWall });
    void this.#poll(world, clock);
  }

  async #poll(world: PlayerWorld, clock: Clock): Promise<void> {
    try {
      while (!this.#stopped) {
        const t0 = clock.now();
        const e = await world.entity(this.id);
        const t1 = clock.now();
        if (this.#stopped) return;
        if (!e) {
          this.gone = true;
          return;
        }
        // The reply's game tick dates the position; the middle of the round trip dates the tick.
        const wall = (t0 + t1) / 2;
        const prev = this.samples.at(-1);
        const tick = e.tick ?? (prev ? prev.tick + (wall - prev.wall) / 50 : 0);
        if (!prev || tick > prev.tick) this.samples.push({ tick, location: e.location, wall });
        // About the last 0.6 s: long enough to smooth the readings, short enough to follow a change of direction.
        while (this.samples.length > 2 && (this.samples[0]?.tick ?? tick) < tick - 12) this.samples.shift();
        this.last = e;
        this.lastWall = wall;
        await clock.sleep(Math.max(0, 25 - (t1 - t0)));
      }
    } catch (err) {
      this.failure = err;
    }
  }

  velocity(): Vec3 {
    return estimateVelocity(this.samples);
  }

  /** Where the entity's feet are at wall time `wall`, extrapolated along its velocity. */
  at(wall: number): Vec3 {
    const v = this.velocity();
    const ticks = Math.max(0, Math.min(10, (wall - this.lastWall) / 50));
    const l = this.last.location;
    return { x: l.x + v.x * ticks, y: l.y, z: l.z + v.z * ticks };
  }

  stop(): void {
    this.#stopped = true;
  }
}

export interface ControllerOptions {
  clock?: Clock;
  random?: () => number;
}

export class PlayerController {
  readonly world: PlayerWorld;
  readonly camera: Camera;
  /** Milliseconds the last look_at or turnTo took. */
  lastTurnMs?: number;
  /** Why the last `selectInput` took the route it did, when that needs saying (a fallback or a late tick stream). */
  inputNote?: string;
  readonly #clock: Clock;
  /** Raw keys and mouse buttons outside the input route (hotbar digits, `hold`, `mine`): always the keyboard. */
  #held = new Set<string>();
  #buttons = new Set<1 | 2 | 3>();
  #timers = new Set<NodeJS.Timeout>();
  #busy = 0;
  #idleTimer?: NodeJS.Timeout;
  readonly #keyboard: KeyboardBackend;
  #backend: InputBackend;
  /** The movement the route holds, sneak included, so it survives a change of route. */
  #move: MoveVector = { ...STILL };

  constructor(world: PlayerWorld, options: ControllerOptions = {}) {
    this.world = world;
    this.#clock = options.clock ?? realClock;
    this.camera = new Camera(world, this.#clock, options.random);
    this.#keyboard = new KeyboardBackend(world.input);
    this.#backend = this.#keyboard;
  }

  /** The input route actions use now. */
  get input(): InputKind {
    return this.#backend.kind;
  }

  /**
   * Pick the input route for the next actions. `auto` takes the engine whenever the input provider answers, else
   * the keyboard. A motion stream that has not sent its first sample yet does not send `auto` to the keyboard: the
   * engine route then reads the helper's state until the stream starts. `engine` fails when the engine route cannot
   * be used.
   */
  async selectInput(mode: InputMode = "auto"): Promise<InputKind> {
    this.inputNote = undefined;
    const noKeyboard = this.world.input.unavailable;
    if (mode === "keyboard") {
      if (noKeyboard) throw new Error(noKeyboard);
      await this.#use(this.#keyboard);
      return "keyboard";
    }
    const engine = this.world.engine;
    if (!engine) {
      if (mode === "engine") throw new Error(`no engine route for this game: ${NO_INPUT_PROVIDER}`);
      if (noKeyboard) throw new Error(noKeyboard);
      await this.#use(this.#keyboard);
      return "keyboard";
    }
    try {
      await engine.prepare();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (mode === "engine") throw new Error(`engine input is not available: ${why}`, { cause: err });
      if (!(await engine.reachable().catch(() => false))) {
        if (noKeyboard) throw new Error(`engine input is not available (${why}), and the keyboard route is unavailable: ${noKeyboard}`, { cause: err });
        this.inputNote = `engine route not used: ${why}`;
        await this.#use(this.#keyboard);
        return "keyboard";
      }
      this.inputNote = `engine tick stream not ready (${why}), so the player state comes from the helper until it starts`;
    }
    // A working route is kept (its held movement with it). `prepare` above has restarted a tick stream that a
    // re-attach or reconnect stopped.
    const current = this.#backend;
    if (!(current instanceof EngineBackend && !current.failure)) await this.#use(new EngineBackend(engine));
    return "engine";
  }

  /** Switch routes: let go of everything on the old one and hold the same movement on the new one. */
  async #use(backend: InputBackend): Promise<void> {
    if (backend === this.#backend) return;
    this.camera.track(undefined);
    await this.#backend.release();
    this.#backend = backend;
    this.camera.useAbsolute(backend.look);
    const m = this.#move;
    if (m.forward || m.strafe || m.jump || m.sneak || m.sprint) await backend.move(m);
  }

  /** Horizontal and vertical sensitivity can differ (and a pitch move clamps at ±90), so each has its own. */
  get yawCalibration(): LookCalibration {
    return this.camera.yawCalibration;
  }

  get pitchCalibration(): LookCalibration {
    return this.camera.pitchCalibration;
  }

  async #down(key: string): Promise<void> {
    if (this.#held.has(key)) return;
    await this.world.input.keyDown(key);
    this.#held.add(key);
  }

  async #up(key: string): Promise<void> {
    if (!this.#held.has(key)) return;
    await this.world.input.keyUp(key);
    this.#held.delete(key);
  }

  /**
   * A key on the route that carries the action: the provider's own game keyboard on the engine route when it takes
   * keys, else the system keyboard.
   */
  async #key(key: string, down: boolean): Promise<void> {
    const backend = this.#backend;
    if (backend instanceof EngineBackend && backend.keys) return backend.key(key, down);
    return down ? this.#down(key) : this.#up(key);
  }

  async #tap(key: string, ms: number, signal?: AbortSignal): Promise<void> {
    await this.#key(key, true);
    try {
      await this.#clock.sleep(ms, signal);
    } finally {
      await this.#key(key, false);
    }
  }

  /** Release `release` after `ms` without waiting, so steering and aiming go on meanwhile. */
  #later(ms: number, release: () => Promise<void>): void {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      void release().catch(() => undefined);
    }, ms);
    this.#timers.add(t);
  }

  /** Change part of the held movement. */
  async #setMove(change: Partial<MoveVector>): Promise<void> {
    this.#move = { ...this.#move, ...change };
    await this.#backend.move(this.#move);
  }

  /** Walk toward world yaw `heading` with the view at `view` (stand still when undefined). */
  async #walk(view: number, heading: number | undefined, sprint = false): Promise<void> {
    await this.#setMove(heading === undefined ? { forward: 0, strafe: 0, sprint: false } : { ...walkVector(view, heading), sprint });
  }

  /** Jump for `ms` without blocking (a jump while walking). */
  async #jump(ms: number): Promise<void> {
    if (this.#move.jump) return;
    await this.#setMove({ jump: true });
    this.#later(ms, () => this.#setMove({ jump: false }));
  }

  /** A use click that does not block the control loop. */
  async #useClick(ms: number): Promise<void> {
    await this.#backend.use(true);
    const backend = this.#backend;
    this.#later(ms, () => backend.use(false));
  }

  async #buttonDown(button: 1 | 3): Promise<void> {
    await this.world.input.button(button, true);
    this.#buttons.add(button);
  }

  async #buttonUp(button: 1 | 3): Promise<void> {
    this.#buttons.delete(button);
    await this.world.input.button(button, false);
  }

  /** Let go of every key and button this controller holds and stop the mouse (after errors, and when a sequence ends). */
  async releaseAll(): Promise<void> {
    this.camera.track(undefined);
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.#move = { ...STILL };
    await this.#backend.release();
    for (const key of [...this.#held]) await this.#up(key).catch(() => undefined);
    for (const b of [...this.#buttons]) await this.#buttonUp(b as 1 | 3).catch(() => undefined);
  }

  /** Stream the state every tick while an action runs, back to every 2 ticks a moment after the last one ends. */
  async #begin(): Promise<void> {
    this.#busy++;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    await this.world.stateRate?.(1).catch(() => undefined);
  }

  #end(): void {
    this.#busy = Math.max(0, this.#busy - 1);
    if (this.#busy > 0 || !this.world.stateRate) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (this.#busy === 0) void this.world.stateRate?.(2).catch(() => undefined);
    }, 1500);
    this.#idleTimer.unref?.();
  }

  /** Turn the view to `yaw`/`pitch` until within `toleranceDeg`. */
  async turnTo(yaw: number | undefined, pitch: number | undefined, toleranceDeg = 2, timeoutMs = 4000, signal?: AbortSignal): Promise<boolean> {
    return this.#look({ widthDeg: toleranceDeg * 2, aim: () => ({ yaw, pitch }) }, toleranceDeg, timeoutMs, signal);
  }

  async lookAtPoint(target: Vec3, toleranceDeg = 2, signal?: AbortSignal): Promise<boolean> {
    return this.#look({ widthDeg: toleranceDeg * 2, aim: (me) => aimAt(me, target) }, toleranceDeg, 4000, signal);
  }

  async #look(target: AimTarget, toleranceDeg: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const started = this.#clock.now();
    this.camera.track(target);
    try {
      const ok = await this.camera.settle(toleranceDeg, timeoutMs, signal);
      this.lastTurnMs = this.#clock.now() - started;
      return ok;
    } finally {
      this.camera.track(undefined);
    }
  }

  async #follow(id: string): Promise<Follow | undefined> {
    const e = await this.world.entity(id);
    return e ? new Follow(this.world, this.#clock, e) : undefined;
  }

  /** Aim at the middle of a followed entity, `height` above its feet, where it will be when the view gets there. */
  #aimAtEntity(f: Follow, height: number, widthDeg: number): AimTarget {
    return {
      widthDeg,
      aim: (me) => {
        const p = f.at(this.#clock.now() + this.camera.latencyMs);
        return aimAt(me, { ...p, y: p.y + height });
      },
    };
  }

  /**
   * Walk to x/z. The movement keys (WASD) are chosen every step from the direction to the goal relative to the view,
   * so the player walks while turning. Without `look` the camera turns to the walking direction, with `look` (an
   * entity id) it keeps the crosshair on that entity and the player strafes. Jumps over one-block steps.
   */
  async moveTo(
    target: { x: number; z: number; y?: number },
    radius = 0.7,
    sprint = false,
    timeoutMs = 30_000,
    options: { look?: string; signal?: AbortSignal } = {},
  ): Promise<{ ok: boolean; message: string }> {
    const goal: Vec3 = { x: target.x, y: target.y ?? 0, z: target.z };
    const started = this.#clock.now();
    const deadline = started + timeoutMs;
    const watched = options.look ? await this.#follow(options.look) : undefined;
    if (options.look && !watched) return { ok: false, message: `no entity ${options.look} to look at` };
    this.camera.track(watched ? this.#aimAtEntity(watched, 0.9, 8) : { widthDeg: 8, aim: (me) => ({ yaw: yawTo(me.location, goal) }) });
    let lastProgress = { at: started, dist: Number.POSITIVE_INFINITY };
    try {
      for (;;) {
        const s = await this.world.state();
        const now = this.#clock.now();
        const dist = horizontalDistance(s.location, goal);
        const looking = watched ? `, looking at ${shortType(watched.typeId)}${watched.gone ? " until it was gone" : ""}` : "";
        if (dist <= radius) return { ok: true, message: `arrived ${dist.toFixed(2)} blocks from the target${looking}` };
        if (now > deadline) return { ok: false, message: `timed out ${dist.toFixed(1)} blocks from the target` };
        if (watched?.gone) this.camera.track({ widthDeg: 8, aim: (me) => ({ yaw: yawTo(me.location, goal) }) });
        const view = this.camera.view()?.yaw ?? s.rotation.y;
        const heading = yawTo(s.location, goal);
        const off = Math.abs(angleDiff(view, heading));
        // Short pulses near the goal instead of overshooting at walking speed.
        const coast = dist < 1.5 && Math.floor((now - started) / 100) % 2 === 1;
        await this.#walk(view, coast ? undefined : heading, sprint && dist > 3 && off < 50);
        if (dist < lastProgress.dist - 0.3) lastProgress = { at: now, dist };
        else if (now - lastProgress.at > 700) {
          if (now - lastProgress.at > 4000) return { ok: false, message: `stuck ${dist.toFixed(1)} blocks from the target` };
          if (s.onGround) await this.#jump(120);
        }
        await this.#clock.sleep(25, options.signal);
      }
    } finally {
      watched?.stop();
      this.camera.track(undefined);
      await this.#walk(0, undefined);
      await this.#setMove({ jump: false });
    }
  }

  /**
   * Melee: keep the crosshair on the entity every frame while walking (sprinting when far) into reach, and click
   * whenever it is under the crosshair and the last hit's invulnerability (10 ticks) is over. The engine route says
   * what each swing struck, so only real hits count there; it also swings when the aim and distance put the target
   * in reach before the helper's crosshair reading shows it.
   */
  async attack(spec: { entity?: string; type?: string; hits?: number; timeoutMs?: number }, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
    const target = spec.entity ? await this.world.entity(spec.entity) : await this.world.nearest(spec.type, 32);
    if (!target) return { ok: false, message: `no ${spec.entity ? `entity ${spec.entity}` : spec.type ? `${spec.type} nearby` : "entity nearby"}` };
    const hits = spec.hits ?? 1;
    const started = this.#clock.now();
    const deadline = started + (spec.timeoutMs ?? 30_000);
    const f = new Follow(this.world, this.#clock, target);
    const name = shortType(target.typeId);
    this.camera.track(this.#aimAtEntity(f, 0.8, 10));
    let done = 0;
    let swings = 0;
    let lastHit = Number.NEGATIVE_INFINITY;
    /** Where the player last made headway, to tell a blocked walk (jump) from following a moving target. */
    let moved = { at: started, x: Number.NaN, z: Number.NaN };
    try {
      while (done < hits) {
        if (f.failure) throw f.failure;
        if (f.gone) return { ok: true, message: `${name} is gone after ${done} hit(s)` };
        const now = this.#clock.now();
        if (now > deadline) return { ok: false, message: `timed out after ${done} hit(s)` };
        const s = await this.world.state();
        // The latest reading, not the extrapolation: walking in on a guess can stop out of reach.
        const e = f.last.location;
        const dist = horizontalDistance(s.location, e);
        const view = this.camera.view()?.yaw ?? s.rotation.y;
        const toward = yawTo(s.location, e);
        const reach = s.lookingAtEntity?.id === target.id ? s.lookingAtEntity.distance : undefined;
        const engine = this.#backend.kind === "engine";
        const eyeDist = Math.hypot(e.x - s.location.x, e.y + 0.8 - s.location.y - EYE_HEIGHT, e.z - s.location.z);
        const aimedClose = engine && eyeDist <= 3 && this.camera.error().observed <= Math.max(5, (Math.atan2(0.4, eyeDist) * 180) / Math.PI);
        // Something else in the line of the swing: step around it, as a player would.
        const blocked = s.lookingAtEntity !== undefined && s.lookingAtEntity.id !== target.id && s.lookingAtEntity.distance < dist + 0.5;
        if (dist > 2.2 || (reach !== undefined && reach > 3)) {
          await this.#walk(view, toward + (blocked ? 60 : 0), dist > 6 && !blocked && Math.abs(angleDiff(view, toward)) < 50);
          if (!(Math.hypot(s.location.x - moved.x, s.location.z - moved.z) < 0.3)) moved = { at: now, x: s.location.x, z: s.location.z };
          else if (now - moved.at > 700 && s.onGround) await this.#jump(120);
        } else {
          moved = { at: now, x: s.location.x, z: s.location.z };
          // Too close to swing comfortably: step back a little.
          await this.#walk(view, dist < 1 ? toward + 180 : blocked ? toward + 90 : undefined);
        }
        if (((reach !== undefined && reach <= 3.2) || aimedClose) && now - lastHit >= 500) {
          const struck = await this.#backend.attack();
          swings++;
          lastHit = now;
          if (struck === undefined || struck === target.id) done++;
        }
        await this.#clock.sleep(10, signal);
      }
      await this.#walk(0, undefined);
      await this.#clock.sleep(300, signal);
      const after = await this.world.entity(target.id);
      const health = after?.health ? `, health ${after.health.current}/${after.health.max}` : after ? "" : ", it is gone";
      const missed = swings > done ? `, ${swings - done} swing(s) missed` : "";
      return { ok: true, message: `hit ${name} ${done} time(s) in ${((this.#clock.now() - started) / 1000).toFixed(1)} s${missed}${health}` };
    } finally {
      f.stop();
      this.camera.track(undefined);
      await this.#walk(0, undefined);
      await this.#setMove({ jump: false });
    }
  }

  /**
   * Throw or shoot at an entity like a player leading a moving target: the camera tracks the ballistic intercept
   * every frame (re-solved from the entity's latest position and velocity) and the shot goes off once the aim is
   * within the target's angular size, by prediction and in the game. Then the helper's impact log tells a hit from a
   * miss. Tries up to `shots` times, stopping at the first hit.
   */
  async shoot(
    spec: { entity?: string; type?: string; projectile?: ProjectileKind; holdMs?: number; shots?: number; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; message: string }> {
    const target = spec.entity ? await this.world.entity(spec.entity) : await this.world.nearest(spec.type, 64);
    if (!target) return { ok: false, message: `no ${spec.entity ? `entity ${spec.entity}` : spec.type ? `${spec.type} nearby` : "entity nearby"}` };
    const s = await this.world.state();
    const kind = spec.projectile ?? projectileFor(s.holding?.typeId);
    if (!kind) return { ok: false, message: `hold a snowball, egg, ender pearl, bow or trident, or name the projectile (holding ${s.holding?.typeId ?? "nothing"})` };
    const b = PROJECTILES[kind];
    if (!s.holding || !b.items.includes(s.holding.typeId)) {
      return { ok: false, message: `${kind} needs ${b.items.join(" or ")} in hand, but the player holds ${s.holding?.typeId ?? "nothing"}. Use select_slot first` };
    }
    const shots = spec.shots ?? 1;
    const holdMs = spec.holdMs ?? (b.charged ? 1100 : 60);
    const lines: string[] = [];
    for (let i = 1; i <= shots; i++) {
      const started = this.#clock.now();
      const r = await this.#shootOnce(target, b, holdMs, spec.timeoutMs ?? 15_000, signal);
      lines.push(`shot ${i}: ${r.message} (${((this.#clock.now() - started) / 1000).toFixed(1)} s)`);
      if (r.outcome === "hit") return { ok: true, message: `hit ${target.typeId} on shot ${i} of ${shots}. ${lines.join(". ")}` };
      if (r.outcome === "gone") return { ok: true, message: `${target.typeId} is gone. ${lines.join(". ")}` };
      if (r.outcome === "error") return { ok: false, message: lines.join(". ") };
    }
    return { ok: false, message: `missed ${target.typeId} ${shots} time(s). ${lines.join(". ")}` };
  }

  /** Game tick of the last impact a shot consumed, so the next shot never counts it again. */
  #lastImpactTick = -1;

  async #shootOnce(
    target: EntityInfo,
    b: Ballistics,
    holdMs: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ outcome: "hit" | "miss" | "gone" | "error"; message: string }> {
    const deadline = this.#clock.now() + timeoutMs;
    const first = await this.world.entity(target.id);
    if (!first) return { outcome: "gone", message: "the target is gone" };
    const f = new Follow(this.world, this.#clock, first);
    const healthBefore = first.health?.current;
    const solved: { now?: Intercept } = {};
    this.camera.track({
      widthDeg: 3,
      aim: (me) => {
        const origin = { x: me.location.x, y: me.location.y + EYE_HEIGHT - b.spawnDrop, z: me.location.z };
        const centre = { ...f.last.location, y: f.last.location.y + AIM_HEIGHT };
        // From the reading to the projectile's first tick, during which the target keeps moving.
        const lead = (this.#clock.now() - f.lastWall) / 50 + FIRE_LATENCY_TICKS;
        const sol = solveIntercept(b, origin, centre, f.velocity(), lead);
        solved.now = sol;
        return sol.ok ? { yaw: sol.yaw, pitch: sol.pitch } : undefined;
      },
    });
    let drawingSince: number | undefined;
    try {
      if (b.charged) {
        await this.#backend.use(true);
        drawingSince = this.#clock.now();
      }
      for (;;) {
        await this.#clock.sleep(FRAME_MS, signal);
        if (f.failure) throw f.failure;
        if (f.gone) return { outcome: "gone", message: "the target is gone" };
        const sol = solved.now;
        if (sol && !sol.ok) return { outcome: "error", message: sol.message };
        if (this.#clock.now() > deadline) return { outcome: "error", message: "timed out before the aim settled" };
        if (!sol) continue;
        const me = await this.world.state();
        const distance = Math.hypot(sol.aim.x - me.location.x, sol.aim.y - me.location.y - EYE_HEIGHT, sol.aim.z - me.location.z);
        // Inside the target's angular half-width, with margin. The streamed view lags a moving aim a little.
        const tolerance = Math.max(0.5, Math.min(3, (Math.atan2(0.3, distance) * 180) / Math.PI));
        const e = this.camera.error();
        const aimed = e.predicted <= tolerance && e.observed <= tolerance + 1;
        const drawn = drawingSince === undefined || this.#clock.now() - drawingSince >= holdMs;
        if (!aimed || !drawn) continue;
        if (drawingSince !== undefined) {
          await this.#backend.use(false);
          drawingSince = undefined;
        } else await this.#useClick(holdMs);
        const fired = await this.world.state(100);
        f.stop();
        this.camera.track(undefined);
        return await this.#watchFlight(target.id, b, fired.tick, sol, healthBefore, signal);
      }
    } finally {
      f.stop();
      this.camera.track(undefined);
      if (drawingSince !== undefined) await this.#backend.use(false);
    }
  }

  /** Follow a launched projectile until the helper logs its impact, then say whether and by how much it missed. */
  async #watchFlight(
    id: string,
    b: Ballistics,
    firedTick: number,
    aim: Intercept & { ok: true },
    healthBefore: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ outcome: "hit" | "miss" | "gone"; message: string }> {
    // The streamed state can be a few ticks old, so accept impacts from just before the reading.
    const since = Math.max(firedTick - 6, this.#lastImpactTick);
    const until = this.#clock.now() + aim.ticks * 50 + 1500;
    const track: { tick: number; location: Vec3 }[] = [];
    let impact: Impact | undefined;
    while (this.#clock.now() < until && !impact) {
      await this.#clock.sleep(100, signal);
      const e = await this.world.entity(id);
      if (e?.tick !== undefined) track.push({ tick: e.tick, location: e.location });
      impact = (await this.world.impacts(since)).impacts.find((i) => i.projectile === b.entity);
    }
    const name = b.entity.replace("minecraft:", "");
    const predicted = `predicted ${aim.ticks.toFixed(1)} ticks of flight`;
    if (impact) {
      this.#lastImpactTick = impact.tick;
      const flight = `${impact.tick - firedTick} ticks after launch, ${predicted}`;
      if (impact.entity?.id === id) return { outcome: "hit", message: `${name} hit ${impact.entity.typeId} ${flight}` };
      // Where the target stood when the projectile landed.
      const there = track.reduce<{ tick: number; location: Vec3 } | undefined>((best, t) => (!best || Math.abs(t.tick - impact.tick) < Math.abs(best.tick - impact.tick) ? t : best), undefined);
      const off = there ? `, ${horizontalDistance(impact.location, there.location).toFixed(1)} blocks from the target` : "";
      const what = impact.entity ? `hit ${impact.entity.typeId} instead` : `landed on ${impact.block ?? "a block"}`;
      return { outcome: "miss", message: `missed: ${name} ${what} at ${impact.location.x}, ${impact.location.y}, ${impact.location.z}${off}, ${flight}` };
    }
    const after = await this.world.entity(id);
    if (!after) return { outcome: "gone", message: `the target is gone after the ${name}` };
    if (healthBefore !== undefined && after.health && after.health.current < healthBefore) {
      return { outcome: "hit", message: `health ${healthBefore} -> ${after.health.current}, no impact logged, ${predicted}` };
    }
    return { outcome: "miss", message: `no ${name} impact logged and no damage (out of ammo, or it flew out of range), ${predicted}` };
  }

  /**
   * Run one action. An aborted `signal` stops it promptly, releases every key and button and returns "cancelled".
   * When the engine route fails during the action, everything is let go, the controller switches to the keyboard
   * for good (until `selectInput` again) and the action runs again from the start; the message says so. A game with
   * no keyboard route (`PlayerInput.unavailable`) fails the action instead, with the engine error and why.
   * On the engine route, an action does not start while the user holds control (F9), and one that runs when the user
   * takes control stops, lets go of everything and fails with TAKEOVER_MESSAGE.
   */
  async run(action: PlayerAction, signal?: AbortSignal): Promise<ActionResult> {
    const takeover = this.#backend.kind === "engine" ? this.world.engine?.takeover : undefined;
    return takeover ? this.#runTakeover(takeover, action, signal) : this.#runAction(action, signal);
  }

  async #runTakeover(takeover: InputTakeover, action: PlayerAction, signal?: AbortSignal): Promise<ActionResult> {
    const started = this.#clock.now();
    const taken = (): ActionResult => ({ action: action.action, ok: false, message: TAKEOVER_MESSAGE, durationMs: this.#clock.now() - started, input: "engine" });
    if (takeover.userHasControl) return taken();
    const stop = new AbortController();
    const off = takeover.onTakeover(() => stop.abort());
    try {
      const r = await this.#runAction(action, signal ? AbortSignal.any([signal, stop.signal]) : stop.signal);
      if (!stop.signal.aborted || signal?.aborted) return r;
      await this.releaseAll();
      return taken();
    } finally {
      off();
    }
  }

  async #runAction(action: PlayerAction, signal?: AbortSignal): Promise<ActionResult> {
    const started = this.#clock.now();
    const result = (ok: boolean, message: string, input: InputKind): ActionResult => ({ action: action.action, ok, message, durationMs: this.#clock.now() - started, input });
    const text = (err: unknown) => (err instanceof Error ? err.message : String(err));
    if (signal?.aborted) return result(false, "cancelled", this.#backend.kind);
    await this.#begin();
    try {
      const kind = this.#backend.kind;
      try {
        const r = await this.#act(action, signal);
        return result(r.ok, r.message, kind);
      } catch (err) {
        await this.releaseAll();
        if (signal?.aborted) return result(false, "cancelled", kind);
        if (!(err instanceof EngineInputError) || kind !== "engine") return result(false, text(err), kind);
        const noKeyboard = this.world.input.unavailable;
        if (noKeyboard) return result(false, `engine input failed (${err.message}), and the keyboard route is unavailable: ${noKeyboard}`, "engine");
        await this.#use(this.#keyboard);
        const note = `engine input failed (${err.message}), finished with keyboard input`;
        try {
          const r = await this.#act(action, signal);
          return result(r.ok, `${r.message} (${note})`, "keyboard");
        } catch (again) {
          await this.releaseAll();
          if (signal?.aborted) return result(false, "cancelled", "keyboard");
          return result(false, `${text(again)} (${note})`, "keyboard");
        }
      }
    } finally {
      this.#end();
    }
  }

  async #act(action: PlayerAction, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
    const result = (ok: boolean, message: string) => ({ ok, message });
    switch (action.action) {
      case "move_to":
        return moveToAction(this, action, signal);
      case "goto": {
        const { entity, x, y, z, radius, sprint, timeoutMs, look } = action;
        const opts = { ...(radius !== undefined ? { radius } : {}), ...(sprint !== undefined ? { sprint } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(look ? { look } : {}) };
        if (entity) return navigate(this, { entity }, opts, signal);
        if (x === undefined || z === undefined) return result(false, "goto needs x and z (y optional), or an entity id");
        return navigate(this, { x, z, ...(y !== undefined ? { y } : {}) }, opts, signal);
      }
      case "look_at": {
        const turned = (ok: boolean, what: string) => result(ok, `${ok ? "looking at" : "could not settle on"} ${what} after ${this.lastTurnMs ?? 0} ms`);
        if (action.entity) {
          const f = await this.#follow(action.entity);
          if (!f) return result(false, `no entity ${action.entity}`);
          try {
            return turned(await this.#look(this.#aimAtEntity(f, 0.9, 4), 2, 4000, signal), shortType(f.typeId));
          } finally {
            f.stop();
          }
        }
        if (action.x !== undefined && action.y !== undefined && action.z !== undefined) {
          return turned(await this.lookAtPoint({ x: action.x, y: action.y, z: action.z }, 2, signal), "the point");
        }
        if (action.yaw !== undefined || action.pitch !== undefined) {
          return turned(await this.turnTo(action.yaw, action.pitch, 2, 4000, signal), `yaw ${action.yaw ?? "unchanged"} pitch ${action.pitch ?? "unchanged"}`);
        }
        return result(false, "look_at needs entity, x/y/z, or yaw/pitch");
      }
      case "attack":
        return this.attack(action, signal);
      case "shoot":
        return this.shoot(action, signal);
      case "use_item":
        await this.#backend.use(true);
        try {
          await this.#clock.sleep(action.holdMs ?? 100, signal);
        } finally {
          await this.#backend.use(false);
        }
        return result(true, "used the held item");
      case "mine": {
        // On the engine route the provider holds the attack button in the game (the agent's `input.attack {hold}`).
        const backend = this.#backend;
        if (backend instanceof EngineBackend && backend.holdsAttack) {
          await backend.holdAttack(true);
          try {
            await this.#clock.sleep(action.holdMs ?? 1000, signal);
          } finally {
            await backend.holdAttack(false);
          }
          return result(true, "held the attack button");
        }
        if (backend.kind === "engine" && this.world.input.unavailable) {
          return result(false, `mine holds the attack button, which this input provider cannot hold, and the keyboard route is unavailable: ${this.world.input.unavailable}`);
        }
        await this.#buttonDown(1);
        try {
          await this.#clock.sleep(action.holdMs ?? 1000, signal);
        } finally {
          await this.#buttonUp(1);
        }
        return result(true, "held the attack button");
      }
      case "select_slot":
        if (!Number.isInteger(action.slot) || action.slot < 1 || action.slot > 9) return result(false, "slot must be 1-9");
        await this.#tap(String(action.slot), 80, signal);
        await this.#clock.sleep(250, signal);
        {
          const s = await this.world.state(100);
          return s.selectedSlot === action.slot
            ? result(true, `selected slot ${action.slot}${s.holding ? ` (${s.holding.typeId})` : " (empty)"}`)
            : result(false, `pressed ${action.slot} but slot ${s.selectedSlot} is selected (is a menu open?)`);
        }
      case "jump":
        await this.#setMove({ jump: true });
        try {
          await this.#clock.sleep(120, signal);
        } finally {
          await this.#setMove({ jump: false });
        }
        return result(true, "jumped");
      case "sneak":
        await this.#setMove({ sneak: action.on });
        return result(true, action.on ? "sneaking" : "stopped sneaking");
      case "hold": {
        // On the engine route the movement keys become the held movement vector, the way move_to walks; the other
        // keys go to the game's keyboard through the provider.
        const { move, keys } = this.#backend.kind === "engine" ? movementKeys(action.keys) : { move: undefined, keys: action.keys };
        const before = { ...this.#move };
        try {
          if (move) await this.#setMove(move);
          for (const k of keys) await this.#key(k, true);
          await this.#clock.sleep(action.ms, signal);
        } finally {
          for (const k of keys) await this.#key(k, false);
          if (move) await this.#setMove(Object.fromEntries(Object.keys(move).map((k) => [k, before[k as keyof MoveVector]])));
        }
        return result(true, `held ${action.keys.join("+")} for ${action.ms} ms`);
      }
      case "wait":
        await this.#clock.sleep(action.ms, signal);
        return result(true, `waited ${action.ms} ms`);
      case "fight":
        return fight(this, action, signal);
      case "flee":
        return flee(this, action, signal);
      case "eat":
        return eat(this, action, signal);
      case "use_on":
        return useOn(this, action, signal);
    }
  }

  /**
   * The hands the skills in `skills/` drive frame by frame: held movement relative to the camera's view, attack
   * clicks, the use button, hotbar keys and the camera's target. Run skills through `run` so the stream rate, the
   * engine fallback and the release on errors apply.
   */
  get hands(): Hands {
    const view = async () => this.camera.view()?.yaw ?? (await this.world.state()).rotation.y;
    return {
      now: () => this.#clock.now(),
      sleep: (ms, signal) => this.#clock.sleep(ms, signal),
      walk: async (heading, sprint = false) => this.#walk(await view(), heading, sprint),
      move: (change) => this.#setMove(change),
      movement: () => ({ ...this.#move }),
      jump: (ms = 120) => this.#jump(ms),
      swing: () => this.#backend.attack(),
      use: (down) => this.#backend.use(down),
      selectSlot: async (slot, signal) => {
        const before = await this.world.state(200);
        if (before.selectedSlot === slot) return true;
        await this.#tap(String(slot), 60, signal);
        for (let i = 0; i < 6; i++) {
          await this.#clock.sleep(50, signal);
          if ((await this.world.state(100)).selectedSlot === slot) return true;
        }
        return false;
      },
      follow: (id) => this.#follow(id),
      track: (f, height = 0.9, widthDeg = 8) => this.camera.track(this.#aimAtEntity(f, height, widthDeg)),
      look: (aim) => this.camera.track(aim),
      stop: async () => {
        this.camera.track(undefined);
        await this.#setMove({ forward: 0, strafe: 0, jump: false, sprint: false });
      },
    };
  }
}

/** See `PlayerController.hands`. */
export interface Hands {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Walk toward world yaw `heading` with the camera's current view (stand still when undefined). */
  walk(heading: number | undefined, sprint?: boolean): Promise<void>;
  /** Change raw parts of the held movement. */
  move(change: Partial<MoveVector>): Promise<void>;
  movement(): MoveVector;
  /** Hold jump for `ms` without blocking. */
  jump(ms?: number): Promise<void>;
  /** One attack click: the struck entity id or null on the engine route, undefined on the keyboard. */
  swing(): Promise<string | null | undefined>;
  use(down: boolean): Promise<void>;
  /** Press the hotbar key and wait until the slot is selected. */
  selectSlot(slot: number, signal?: AbortSignal): Promise<boolean>;
  follow(id: string): Promise<Follow | undefined>;
  /** Keep the crosshair on a followed entity, `height` above its feet, ahead of its motion. */
  track(f: Follow, height?: number, widthDeg?: number): void;
  look(aim: AimTarget | undefined): void;
  /** Stop walking, jumping and sprinting and free the camera. */
  stop(): Promise<void>;
}
