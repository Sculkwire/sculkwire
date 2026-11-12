/** The mouse hand: turn planning (Fitts' law, minimum jerk), sensitivity and latency learning, and the 120 Hz camera loop. */
import { EYE_HEIGHT } from "./bedrock.ts";
import { realClock, type Clock } from "./clock.ts";
import { angleDiff, horizontalDistance, pitchTo, yawTo } from "./geometry.ts";
import type { PlayerState, PlayerWorld, Vec3 } from "./types.ts";

/**
 * Degrees of rotation per pixel of mouse motion. Starts from the game's default sensitivity and learns from every
 * turn, so it adapts to the user's sensitivity setting.
 */
class LookCalibration {
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

/** Mouse steps per second, like a gaming mouse polled at 120 Hz. */
const CAMERA_HZ = 120;
export const FRAME_MS = 1000 / CAMERA_HZ;
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
interface TurnPlan {
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
export function planTurn(errYaw: number, errPitch: number, widthDeg: number, startedAt: number, random: () => number = Math.random): TurnPlan {
  const len = Math.hypot(errYaw, errPitch);
  const human = len > 8;
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
  /** Engine route without a stream: the newest state a background read brought, and the read under way. */
  #read?: Sample;
  #reading?: Promise<void>;

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

  /** The controller's random source (seeded in tests), for the fight's other human variation too. */
  get random(): () => number {
    return this.#random;
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
    // The engine route steers on its own commanded view, so its loop never waits on a `state()` round trip: it takes
    // the newest stream sample, or the newest state a background read brought, however old (live, a frame loop held up
    // by that round trip froze the aim 100 to 200 ms and let the curve land as one jump).
    if (this.#absolute) {
      const streamed = this.#world.sample?.();
      if (streamed) return this.#dejitter(streamed);
      this.#reading ??= this.#world
        .state(STALE_STATE_MS)
        .then((state) => void (this.#read = { at: this.#clock.now(), state }))
        .catch(() => undefined)
        .finally(() => (this.#reading = undefined));
      return this.#read;
    }
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
