/**
 * The input lock of the in-game agent (`input.lock`, implemented in `native/agent-core`).
 *
 * While the lock is on, the DLL drops the user's own keyboard and mouse input to the game window (and its focus loss,
 * so the game does not pause), and the agent's engine input still works. F9 in the game hands control to the user and
 * gives it back. `mode` lives in the DLL so every process sees the same one: `on`, `off`, or `auto` (locked while an
 * action or play job runs, which this process declares with `hold`). Each change arrives as a `lock` notification.
 */
import { malformed, type EngineResult } from "./failure.ts";
import { finiteOrZero } from "./wire.ts";

export const LOCK_MODES = ["on", "off", "auto"] as const;
export type LockMode = (typeof LOCK_MODES)[number];

/** Why the keyboard route has no lock, and what to do instead. */
export const KEYBOARD_LOCK_NOTE =
  "input lock: not available on the keyboard route, because its keys and mouse reach the game the same way as the user's. " +
  "Attach the agent (engine_attach) so actions use the engine route and the lock, or launch with display: headless so " +
  "the user's keyboard and mouse cannot reach the game";

export interface LockState {
  /** The user's input is dropped right now. */
  locked: boolean;
  mode: LockMode;
  /** Who made the last change: F9 in the game (`user`) or an `input.lock` call (`agent`). */
  by: "agent" | "user";
  /** The user took control with F9 and has not given it back. */
  user: boolean;
  /** Some connection declared an action or play job running (what `auto` locks for). */
  active: boolean;
  /**
   * Some connection holds a session lock (game_launch `inputLock: on`), which locks in `auto` until that connection
   * ends it or closes. Undefined: the loaded agent predates session locks.
   */
  session?: boolean;
  /**
   * Some connection holds the game's focus (`input.lock {focus: true}`): the game never sees its window lose focus, so
   * background clicks work and switching away never pauses it. Ends with that connection. Undefined: an older agent.
   */
  focusHeld?: boolean;
  /** The camera permission follows the lock (`input.lock {cameraGate: true}`); off by default. Undefined: an older agent. */
  cameraGate?: boolean;
  /** The game window is hooked. False until the first frame after injection. */
  window: boolean;
  /** User input events dropped since injection. */
  dropped: number;
  /** Focus-loss events seen (window messages and the engine's focus-lost handler), and how many the lock kept from the game. */
  focusLost: number;
  focusKept: number;
  /**
   * How often the lock told a game whose window was in the background that it is active (so it takes the agent's
   * clicks on its menus), and how many cursor clips and mouse captures it skipped there. Absent from older agents.
   */
  focusGiven?: number;
  cursorKept?: number;
  /**
   * Focus as the game process sees it (diagnostic only). Under Wine in gamescope, Wine never learns about desktop
   * focus changes, so this stays true; on native Windows it is the real window focus. `hostFocused` is the desktop
   * focus sculkwire reported.
   */
  wineFocused: boolean;
  /** The game window was the process's foreground window on the last frame (diagnostic, same caveat as `wineFocused`). */
  wineForeground: boolean;
  /** Shift presses seen by path, `[background, foreground]`: window messages and raw input. Shows how a Shift pressed in another window reaches the game. */
  shift: { message: [number, number]; raw: [number, number] };
  /** Polled key-state answers (GetAsyncKeyState and friends) the DLL turned into "not pressed". */
  keysHidden: number;
  /** The game window has focus on the host desktop, as sculkwire last reported it (`input.focus`). True until a report says otherwise. */
  hostFocused: boolean;
  /** The gamepad gate: XInput functions hooked, successful reads, reads with a pressed button or moved stick, and those the DLL turned neutral. */
  pad: { hooked: number; reads: number; active: number; hidden: number };
  /**
   * The camera gate in this world: `disabled` while the lock owns the view, `enabled` once given back, null before
   * the first gate command ran (the world is loading, or no player command was seen yet to replay; turning the lock
   * on primes one).
   */
  camera: "disabled" | "enabled" | null;
}

function shiftOf(r: Record<string, unknown>, key: "message" | "raw"): unknown {
  const shift = r.shift;
  return shift && typeof shift === "object" && key in shift ? (shift as Record<string, unknown>)[key] : undefined;
}

function pair(v: unknown): [number, number] {
  return Array.isArray(v) ? [finiteOrZero(v[0]), finiteOrZero(v[1])] : [0, 0];
}

function padOf(r: Record<string, unknown>): Record<string, unknown> {
  return r.pad && typeof r.pad === "object" ? (r.pad as Record<string, unknown>) : {};
}

/** A `lock` notification or `input.lock` result, or undefined when it is not one. */
export function parseLockState(raw: unknown): LockState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.locked !== "boolean" || !LOCK_MODES.includes(r.mode as LockMode)) return undefined;
  return {
    locked: r.locked,
    mode: r.mode as LockMode,
    by: r.by === "user" ? "user" : "agent",
    user: r.user === true,
    active: r.active === true,
    window: r.window === true,
    dropped: finiteOrZero(r.dropped),
    focusLost: finiteOrZero(r.focusLost),
    focusKept: finiteOrZero(r.focusKept),
    ...(typeof r.focusGiven === "number" ? { focusGiven: finiteOrZero(r.focusGiven) } : {}),
    ...(typeof r.cursorKept === "number" ? { cursorKept: finiteOrZero(r.cursorKept) } : {}),
    wineFocused: r.focused !== false,
    wineForeground: r.foreground !== false,
    shift: { message: pair(shiftOf(r, "message")), raw: pair(shiftOf(r, "raw")) },
    keysHidden: finiteOrZero(r.keysHidden),
    hostFocused: r.hostFocused !== false,
    pad: { hooked: finiteOrZero(padOf(r).hooked), reads: finiteOrZero(padOf(r).reads), active: finiteOrZero(padOf(r).active), hidden: finiteOrZero(padOf(r).hidden) },
    ...(typeof r.session === "boolean" ? { session: r.session } : {}),
    ...(typeof r.focusHeld === "boolean" ? { focusHeld: r.focusHeld } : {}),
    ...(typeof r.cameraGate === "boolean" ? { cameraGate: r.cameraGate } : {}),
    camera: r.camera === "disabled" || r.camera === "enabled" ? r.camera : null,
  };
}

/** One line for tool and CLI output. */
export function lockText(s: LockState): string {
  const now = s.locked
    ? "locked: sculkwire is playing and the user's keyboard and mouse are kept out of the game (F9 takes over)"
    : s.user
      ? "unlocked: the user took control with F9 (F9 gives it back)"
      : "unlocked: the user's input reaches the game";
  const window = s.window ? "" : ". The game window is not hooked yet (it is, from the first frame after injection)";
  const host = s.hostFocused ? "" : ". The game window is not focused on the desktop, so its controller and polled keys are kept out";
  const session = s.session ? " (game_launch holds the lock for its session)" : "";
  const focus = s.focusHeld ? ". The game's focus is held: it does not pause when its window is in the background" : "";
  return `${now}. mode ${s.mode}${session}${window}${host}${focus}`;
}

/**
 * One `input.lock` call's parameters. `active`, `session` and `focus` belong to the calling connection and end with it;
 * `cameraGate` is the agent's own setting.
 */
export type LockParams = { mode?: LockMode; active?: boolean; session?: boolean; focus?: boolean; cameraGate?: boolean };
type Send = (params: LockParams) => Promise<EngineResult<unknown>>;

/**
 * This process's view of the lock: the last state the DLL reported, takeover listeners, `auto` holds, and the
 * per-connection session lock and focus hold. Nothing here types or runs a command in the game.
 */
export class InputLock {
  readonly #send: Send;
  #state: LockState | undefined;
  #takeover = new Set<() => void>();
  #change = new Set<(s: LockState) => void>();
  #holds = 0;
  /** This process holds a session lock, which a new connection declares again (`reassert`). */
  #session = false;
  /** This process holds the game's focus, which a new connection declares again (`reassert`). */
  #focus = false;

  constructor(send: Send) {
    this.#send = send;
  }

  /** The last state reported by the DLL, if any arrived on this connection. */
  get state(): LockState | undefined {
    return this.#state;
  }

  /** True while the user holds control (pressed F9 and did not give it back). */
  get userHasControl(): boolean {
    return this.#state?.user === true;
  }

  /** Feed a reported state (notification or call result). Fires takeover listeners on the user's F9. */
  update(state: LockState): void {
    const before = this.#state?.user === true;
    this.#state = state;
    if (state.user && !before) for (const l of [...this.#takeover]) l();
    for (const l of [...this.#change]) l(state);
  }

  /** `listener` runs each time the user takes control. Returns the function that removes it. */
  onTakeover(listener: () => void): () => void {
    this.#takeover.add(listener);
    return () => this.#takeover.delete(listener);
  }

  /** Resolves once the user does not hold control (at once if they do not), or when `signal` aborts. */
  untilControl(signal?: AbortSignal): Promise<void> {
    if (!this.userHasControl || signal?.aborted) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const done = () => {
      this.#change.delete(onChange);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const onChange = (s: LockState) => {
      if (!s.user) done();
    };
    this.#change.add(onChange);
    signal?.addEventListener("abort", done, { once: true });
    return promise;
  }

  async #ask(params: LockParams): Promise<EngineResult<LockState>> {
    const result = await this.#send(params);
    if (!result.ok) return result;
    const state = parseLockState(result.value);
    if (!state) return malformed("input.lock", result.value);
    this.update(state);
    return { ok: true, value: state };
  }

  /** Read the state, or set the mode, and with `cameraGate` whether the camera permission follows the lock. */
  request(mode?: LockMode, opts: { cameraGate?: boolean } = {}): Promise<EngineResult<LockState>> {
    return this.#ask({ ...(mode ? { mode } : {}), ...(opts.cameraGate !== undefined ? { cameraGate: opts.cameraGate } : {}) });
  }

  /**
   * Declare an action or play job running, which `auto` locks for, until the returned function runs. Holds nest. A
   * failed call (no agent, an older DLL) is ignored: the action still runs, only unlocked.
   */
  async hold(): Promise<() => Promise<void>> {
    if (this.#holds++ === 0) await this.#active(true);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (--this.#holds === 0) await this.#active(false);
    };
  }

  async #active(active: boolean): Promise<void> {
    const result = await this.#send({ active }).catch(() => undefined);
    // A running action is declared again on a new connection only once the agent took it on one.
    if (result?.ok) this.#activeDeclared = active;
    const state = result?.ok ? parseLockState(result.value) : undefined;
    if (state) this.update(state);
  }

  /** The agent took this process's running action (`active`), so a new connection declares it again. */
  #activeDeclared = false;

  /**
   * Hold (true) or end (false) a session lock on this connection: locked in `auto` until it ends or the connection
   * closes, so a host that dies never leaves the lock on. A new connection declares it again (`reassert`).
   */
  async session(on: boolean): Promise<EngineResult<LockState>> {
    const result = await this.#ask({ session: on });
    if (result.ok) this.#session = on;
    return result;
  }

  /** This process holds a session lock. */
  get sessionHeld(): boolean {
    return this.#session;
  }

  /**
   * Hold (true) or end (false) the game's focus on this connection: the game never sees its window lose focus while
   * held, which locks nothing. Ends when the connection closes; a new connection declares it again (`reassert`).
   */
  async focus(on: boolean): Promise<EngineResult<LockState>> {
    const result = await this.#ask({ focus: on });
    if (result.ok) this.#focus = on;
    return result;
  }

  /** This process holds the game's focus. */
  get focusHeld(): boolean {
    return this.#focus;
  }

  /**
   * What a new connection to the same agent must declare again, because the agent dropped the old connection's bits
   * when it closed: the session lock, the focus hold and a running action. Undefined when nothing is held.
   */
  reassert(): LockParams | undefined {
    const active = this.#activeDeclared && this.#holds > 0;
    if (!this.#session && !this.#focus && !active) return undefined;
    return {
      ...(this.#session ? { session: true } : {}),
      ...(this.#focus ? { focus: true } : {}),
      ...(active ? { active: true } : {}),
    };
  }

  /** Forget the reported state, the session lock and the focus hold (the connection was closed on purpose). Holds and listeners stay. */
  reset(): void {
    this.#state = undefined;
    this.#session = false;
    this.#focus = false;
  }
}
