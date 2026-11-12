/** How the controller's hands reach the game: held movement, the keyboard and mouse route and the engine route. */
import { errorMessage } from "../../core/errors.ts";
import { angleDiff } from "./geometry.ts";
import type { EngineInput, InputTakeover } from "./inputprovider.ts";

/** Default key names (xdotool names; Windows maps them to virtual keys) for Bedrock's default keyboard layout. */
const KEYS = { forward: "w", left: "a", back: "s", right: "d", jump: "space", sneak: "Shift_L", sprint: "Control_L" } as const;

/** The keys Bedrock's default layout moves with: WASD, space to jump, shift to sneak, ctrl to sprint. */
const MOVEMENT_KEY = /^(?:[wasd]|space|shift(?:_[lr])?|ctrl(?:_[lr])?|control(?:_[lr])?)$/i;

/** Split held keys into the movement they give and the rest. `move` is undefined when no key moves. */
export function movementKeys(keys: readonly string[]): { move?: Partial<MoveVector>; keys: string[] } {
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
  /** The movement last asked for, and the update loop sending it while one is in flight. */
  #want: MoveVector = { ...STILL };
  #sending?: Promise<void>;
  #sentAt = Number.NEGATIVE_INFINITY;
  #keepalive?: NodeJS.Timeout;
  #failure?: EngineInputError;
  /** A look is out and not answered yet; `#lookNext` is the newest view asked for meanwhile. */
  #lookOut = false;
  #lookNext?: { pitch: number; yaw: number };
  /** Keys this route holds down through `EngineInput.key`. */
  readonly #keys = new Set<string>();
  /** Buttons this route holds, pressed again every `MOVE_REFRESH_MS`: the agent lets a held button go a second after its last press. */
  readonly #buttons = new Set<"use" | "attack">();
  #buttonRenewal?: NodeJS.Timeout;

  constructor(engine: EngineInput) {
    this.#engine = engine;
    this.look = (pitch, yaw) => this.#look(pitch, yaw);
  }

  get failure(): EngineInputError | undefined {
    return this.#failure;
  }

  #fail(err: unknown): EngineInputError {
    this.#failure ??= new EngineInputError(errorMessage(err), { cause: err });
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
   * The agent applies one `input.look` per game frame, on its main-thread drain, and answers it then (a call costs
   * about 8 ms). A 120 Hz camera sending every view would queue them: live, with up to 8 in flight, each view reached the
   * game about 8 frames late, the streamed aim stood still for 100 to 200 ms after a target change and then jumped.
   * So one look is out at a time, and when its answer is back the newest view asked for meanwhile goes next (the views
   * between are dropped: the camera's curve is absolute, the newest view is where it is). Never waits; a failure
   * surfaces on the next view.
   */
  async #look(pitch: number, yaw: number): Promise<void> {
    if (this.#failure) throw this.#failure;
    if (this.#lookOut) {
      this.#lookNext = { pitch, yaw };
      return;
    }
    this.#lookOut = true;
    void this.#engine
      .look(pitch, yaw)
      .then(
        () => {
          this.#lookOut = false;
          const next = this.#lookNext;
          this.#lookNext = undefined;
          if (next && !this.#failure) void this.#look(next.pitch, next.yaw).catch(() => undefined);
        },
        (err: unknown) => {
          this.#lookOut = false;
          this.#lookNext = undefined;
          this.#fail(err);
        },
      );
  }

  /**
   * Hold `move` from now on, without waiting for the agent's answer (a frame or a tick): a control loop that changes
   * its feet every tick would otherwise run at the round trip's pace. One update is in flight at a time; what is asked
   * meanwhile replaces the waiting one, so only the newest movement is sent and never a stale one. A failure
   * surfaces on the next call.
   */
  async move(move: MoveVector): Promise<void> {
    if (this.#failure) throw this.#failure;
    this.#want = { ...move };
    this.#kick();
  }

  #kick(): void {
    if (this.#sending) return;
    const sending = this.#pump().finally(() => {
      if (this.#sending === sending) this.#sending = undefined;
    });
    this.#sending = sending;
  }

  /** Send the newest wanted movement until what was sent is what is wanted (repeated every `MOVE_REFRESH_MS`). */
  async #pump(): Promise<void> {
    try {
      for (;;) {
        const next = this.#want;
        const m = this.#move;
        const same = next.forward === m.forward && next.strafe === m.strafe && next.jump === m.jump && next.sneak === m.sneak && next.sprint === m.sprint;
        if (same && Date.now() - this.#sentAt < MOVE_REFRESH_MS) return;
        await this.#engine.move(next);
        this.#move = next;
        this.#sentAt = Date.now();
        const still = !next.forward && !next.strafe && !next.jump && !next.sneak && !next.sprint;
        if (still) this.#stopKeepalive();
        else this.#keepalive ??= this.#startKeepalive();
      }
    } catch (err) {
      this.#fail(err);
    }
  }

  #startKeepalive(): NodeJS.Timeout {
    const timer = setInterval(() => {
      if (Date.now() - this.#sentAt < MOVE_REFRESH_MS - 20) return;
      this.#kick();
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
    // Let the update in flight land first, so it cannot hold movement again after the release.
    this.#want = { ...STILL };
    await this.#sending;
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

/** Where `sendInput` delivers: xdotool into gamescope's own display, or SendInput on Windows. */
export type InputRoute = "gamescope" | "windows";

/**
 * Windows only: input reaches the game only while its window is in the foreground. `userHasControl` is true while it
 * is not, `onTakeover` fires on each loss and `untilControl` waits for the window to come back (the input lock
 * interface, so a play job pauses the same way as on an F9 takeover).
 */
export interface ForegroundGate extends InputTakeover {
  /** Bring the game window to the foreground: once when an action or job starts, never in the middle of one. */
  activate(): Promise<void>;
}

/** Held keys, relative mouse look and mouse buttons: what a player's hands do. */
export interface PlayerInput {
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  /** Relative mouse motion in pixels: +x turns right, +y looks down. */
  look(dx: number, dy: number): Promise<void>;
  button(button: 1 | 2 | 3, down: boolean): Promise<void>;
  /** End the input route's helper process, if it has one (the game stopped). */
  close?(): void;
  /** Windows: the foreground the input depends on. Absent where input does not need it (gamescope). */
  foreground?: ForegroundGate;
  /** Why this game has no keyboard and mouse route (a Linux desktop window); every method then rejects with it. */
  unavailable?: string;
}

/**
 * The keyboard and mouse route of a game that has none, for a player driven through the engine route alone: every
 * call rejects with `reason`, and `close` does nothing.
 */
export function unavailableInput(reason: string): PlayerInput {
  const refuse = async (): Promise<never> => Promise.reject(new Error(reason));
  return { keyDown: refuse, keyUp: refuse, look: refuse, button: refuse, close: () => undefined, unavailable: reason };
}
