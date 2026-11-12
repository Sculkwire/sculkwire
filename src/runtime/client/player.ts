/**
 * Player control the way a person plays: held movement, the view and clicks, driven in a tight closed loop on the
 * player state the helper pack (or the input provider's motion stream) delivers, 20 per second while an action runs.
 * The camera (`camera.ts`) runs at 120 Hz beside the movement, so the player walks, strafes and sprints while it turns
 * and tracks; the hands reach the game by the keyboard and mouse or the engine route (`input.ts`). One MCP call can run
 * a whole sequence (walk there, look at it, hit it, switch slot, use item), and the skills in `skills/` run on top.
 */
import { errorMessage } from "../../core/errors.ts";
import { estimateVelocity, PROJECTILES, projectileFor, solveIntercept, type Ballistics, type Intercept, type ProjectileKind } from "./ballistics.ts";
import { EYE_HEIGHT } from "./bedrock.ts";
import { aimAt, Camera, FRAME_MS, type AimTarget } from "./camera.ts";
import { realClock, type Clock } from "./clock.ts";
import { angleDiff, horizontalDistance, yawTo } from "./geometry.ts";
import { EngineBackend, EngineInputError, KeyboardBackend, movementKeys, STILL, walkVector, type InputBackend, type InputKind, type InputMode, type MoveVector } from "./input.ts";
import { NO_INPUT_PROVIDER, TAKEOVER_MESSAGE, type InputTakeover } from "./inputprovider.ts";
import { moveToAction, navigate } from "./nav/navigate.ts";
import { eat } from "./skills/eat.ts";
import { fight } from "./skills/fight.ts";
import { flee } from "./skills/flee.ts";
import { shortType } from "./skills/mobs.ts";
import type { FightStats } from "./skills/types.ts";
import { useOn } from "./skills/useon.ts";
import type { ActionResult, EntityInfo, Impact, PlayerAction, PlayerWorld, Vec3 } from "./types.ts";

/** Shots aim this far above an entity's feet: inside the box of everything from chickens to zombies. */
const AIM_HEIGHT = 0.6;
/** Ticks from the click to the projectile's first tick in the game (input delivery plus the next server tick). */
const FIRE_LATENCY_TICKS = 2;

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

interface ControllerOptions {
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
      const why = errorMessage(err);
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
  async #walk(view: number, heading: number | undefined, sprint = false, speed = 1): Promise<void> {
    if (heading === undefined) return this.#setMove({ forward: 0, strafe: 0, sprint: false });
    const v = walkVector(view, heading);
    const k = Math.max(0, Math.min(1, speed));
    await this.#setMove(k === 1 ? { ...v, sprint } : { forward: Math.round(v.forward * k * 1000) / 1000, strafe: Math.round(v.strafe * k * 1000) / 1000, sprint: false });
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
      return { ...taken(), ...(r.fight ? { fight: r.fight } : {}) };
    } finally {
      off();
    }
  }

  async #runAction(action: PlayerAction, signal?: AbortSignal): Promise<ActionResult> {
    const started = this.#clock.now();
    const result = (ok: boolean, message: string, input: InputKind, fight?: FightStats): ActionResult => ({
      action: action.action,
      ok,
      message,
      durationMs: this.#clock.now() - started,
      input,
      ...(fight ? { fight } : {}),
    });
    if (signal?.aborted) return result(false, "cancelled", this.#backend.kind);
    await this.#begin();
    try {
      const kind = this.#backend.kind;
      try {
        const r = await this.#act(action, signal);
        // A skill that reports its numbers when cancelled returns instead of throwing: let go as a throw would.
        if (signal?.aborted) await this.releaseAll();
        return result(r.ok, r.message, kind, r.stats);
      } catch (err) {
        await this.releaseAll();
        if (signal?.aborted) return result(false, "cancelled", kind);
        if (!(err instanceof EngineInputError) || kind !== "engine") return result(false, errorMessage(err), kind);
        const noKeyboard = this.world.input.unavailable;
        if (noKeyboard) return result(false, `engine input failed (${err.message}), and the keyboard route is unavailable: ${noKeyboard}`, "engine");
        await this.#use(this.#keyboard);
        const note = `engine input failed (${err.message}), finished with keyboard input`;
        try {
          const r = await this.#act(action, signal);
          if (signal?.aborted) await this.releaseAll();
          return result(r.ok, `${r.message} (${note})`, "keyboard", r.stats);
        } catch (again) {
          await this.releaseAll();
          if (signal?.aborted) return result(false, "cancelled", "keyboard");
          return result(false, `${errorMessage(again)} (${note})`, "keyboard");
        }
      }
    } finally {
      this.#end();
    }
  }

  async #act(action: PlayerAction, signal?: AbortSignal): Promise<{ ok: boolean; message: string; stats?: FightStats }> {
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
      walk: async (heading, sprint = false, speed = 1) => this.#walk(await view(), heading, sprint, speed),
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
interface Hands {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /**
   * Walk toward world yaw `heading` with the camera's current view (stand still when undefined), at `speed` of the
   * walking speed (0 to 1, default 1: the engine route's movement vector is analog; the keyboard's keys are full).
   */
  walk(heading: number | undefined, sprint?: boolean, speed?: number): Promise<void>;
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
