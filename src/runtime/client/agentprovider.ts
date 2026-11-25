/**
 * The in-game agent as sculkwire's built-in in-process input provider: the player controller's engine route (absolute
 * view, held movement, attacks, item use and keys through the game), the tick stream that replaces the helper's position and
 * rotation while it is fresh, the pause guard, the input lock around actions and play jobs, and the desktop focus
 * watcher of a window-mode game that gates polled input in the agent.
 *
 * `installAgentProvider()` installs it as the built-in provider; `wireFeatures()` (`src/features.ts`) calls it once for
 * the MCP server and the CLI. An extension's `registerInputProvider` replaces it while that extension is active;
 * nothing has to be registered for the agent to be the default route.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "../../core/errors.ts";
import { setBuiltinInputProvider, type EngineInput, type InputLockStatus, type InputProvider, type ProviderGame, type ProviderMotion } from "./inputprovider.ts";
import { engine, type EngineSession, type EngineTick } from "../engine/engine.ts";
import type { EngineResult } from "../engine/failure.ts";
import { HostFocus } from "../engine/focus.ts";
import { KEYBOARD_LOCK_NOTE, type LockMode } from "../engine/lock.ts";

/** A tick older than this no longer counts as a running stream (a missed tick is 50 ms). */
const TICK_FRESH_MS = 250;

async function must<T>(pending: Promise<EngineResult<T>>): Promise<T> {
  const r = await pending;
  if (!r.ok) throw new Error(`${r.reason}${r.anchor ? ` (anchor ${r.anchor})` : ""}: ${r.message}`);
  return r.value;
}

export class AgentInputProvider implements InputProvider {
  readonly name = "in-game agent";
  readonly keyboardNote = KEYBOARD_LOCK_NOTE;
  readonly input: EngineInput;
  readonly #session: EngineSession;
  /** Newest `tick` notification, while the controller's engine route subscribed to them. */
  #tick?: { at: number; tick: EngineTick };
  /** Removes this provider's tick listener from the session. */
  #tickOff?: () => Promise<void>;
  /** The game to watch, kept from `launched` until an engine call starts the watcher. */
  #gamePid?: number;
  /** The mode `releaseSessionLock` puts back after `sessionLock("auto")` changed it (`on` becomes `auto`). */
  #restoreMode?: LockMode;
  readonly #platform: NodeJS.Platform;

  constructor(session: EngineSession = engine, platform: NodeJS.Platform = process.platform) {
    this.#session = session;
    this.#platform = platform;
    const fresh = () => this.#tick !== undefined && Date.now() - this.#tick.at <= TICK_FRESH_MS;
    this.input = {
      // Also starts the focus watcher and the tick stream, and waits for its first tick.
      prepare: async () => {
        await this.#watch();
        if (fresh()) return;
        await this.#tickOff?.();
        this.#tickOff = undefined;
        this.#tickOff = await must(session.subscribeTicks((tick, at) => (this.#tick = { at, tick })));
        const deadline = Date.now() + 1500;
        while (!fresh()) {
          if (Date.now() > deadline) throw new Error("the agent accepted stream.subscribe but sent no tick notification within 1.5 s (is the player in a world?)");
          await sleep(20);
        }
      },
      look: async (pitch, yaw) => {
        await must(session.look(pitch, yaw));
      },
      move: async (m) => {
        await must(session.move(m));
      },
      release: async () => {
        await must(session.release());
      },
      attack: async () => (await must(session.attack())).hit,
      use: async (down) => {
        await must(session.use(down));
      },
      // `input.attack {hold}` holds the left button in the game (GameInput's reading, or the window message).
      attackHold: async (down) => {
        await must(session.attackHold(down));
      },
      // `ui.key` hands the key to the game's own window procedure, where the game reads its keyboard.
      key: async (key, down) => {
        await must(session.uiKey(key, down ? "down" : "up"));
      },
      reachable: async () => (await session.status()).ok,
      takeover: session.lock,
    };
  }

  motion(): { at: number; motion: ProviderMotion } | undefined {
    const t = this.#tick;
    if (!t) return undefined;
    // The agent's `selectedSlot` is not on the helper's 1 to 9 scale (it reports 0 with the first slot selected), so
    // it is not part of the motion and the helper's value stays.
    const { position, rotation, velocity, onGround, health } = t.tick;
    return { at: t.at, motion: { position, rotation, velocity, onGround, health } };
  }

  pausedReason(): string | undefined {
    return this.#session.paused
      ? "the simulation is paused (engine_tick), so the player cannot move and its state does not update. " +
          "Resume with engine_tick pause: false, or slow the game with engine_tick scale instead of pausing"
      : undefined;
  }

  hold(): Promise<() => Promise<void>> {
    return this.#session.lock.hold();
  }

  lockStatus(): InputLockStatus | undefined {
    const s = this.#session.lock.state;
    return s ? { mode: s.mode, locked: s.locked, user: s.user, ...(s.session !== undefined ? { session: s.session } : {}) } : undefined;
  }

  /**
   * `on` is a session lock on this provider's connection, not mode `on`: the agent drops it when the connection
   * closes, so a sculkwire process that dies never leaves the game locked, and the engine session declares it again
   * on its own reconnect. `auto` makes sure the mode is `auto` (the agent's default), which locks only while an
   * action or play job runs; `off` sets the mode off, so nothing locks. `releaseSessionLock` puts the earlier mode back.
   */
  async sessionLock(mode: LockMode): Promise<string | undefined> {
    // Attached already, this only refreshes the status and holds the focus.
    try {
      await this.attach();
    } catch (e) {
      return `the in-game agent could not be attached (${errorMessage(e)})`;
    }
    const lock = this.#session.lock;
    if (mode === "on") {
      const held = await lock.session(true);
      if (!held.ok) return `the agent refused the session lock (${held.message})`;
      if (held.value.session === undefined) {
        return "the in-game agent loaded in the game predates session locks: restart the game so the next attach loads the current agent";
      }
      if (held.value.mode === "off") return "game_input_lock set mode off, which never locks: set mode auto to let the session lock apply";
      return undefined;
    }
    const before = await lock.request();
    if (!before.ok) return `the agent did not report its lock (${before.message})`;
    if (before.value.mode === mode) return undefined;
    const set = await lock.request(mode);
    if (!set.ok) return `the agent refused mode ${mode} (${set.message})`;
    // An `on` found here would lock with nobody to release it: never put that back.
    this.#restoreMode ??= before.value.mode === "on" ? "auto" : before.value.mode;
    return undefined;
  }

  /**
   * End the session lock and put back a mode `sessionLock` changed, so the lock never outlives sculkwire's hold on the
   * game. A mode `on` set some other way (game_input_lock) becomes `auto` too. Only while connected: a closed
   * connection already released the session lock, and a stopped game needs nothing.
   */
  async releaseSessionLock(): Promise<void> {
    const lock = this.#session.lock;
    const mode = this.#restoreMode ?? (lock.state?.mode === "on" ? "auto" : undefined);
    this.#restoreMode = undefined;
    if (!this.#session.attached) return;
    if (lock.sessionHeld) await lock.session(false).catch(() => undefined);
    if (mode !== undefined && mode !== lock.state?.mode) await lock.request(mode).catch(() => undefined);
  }

  /**
   * Attach the agent and hold the game's focus for this connection, like bedrock-mcp: the game never sees its window
   * lose focus, so the agent's clicks work in the background and switching away never pauses it. The agent lets go of
   * the focus when the connection closes. An older agent without the focus hold is used as it is.
   */
  async attach(): Promise<void> {
    await this.#session.attach();
    await this.#watch();
    if (!this.#session.lock.focusHeld) await this.#session.lock.focus(true).catch(() => undefined);
  }

  /**
   * Start the desktop focus watcher once the agent is in use. A keyboard-only game never starts one: the watcher gates
   * the agent's polled input, so it belongs to the engine route.
   */
  async #watch(): Promise<void> {
    const pid = this.#gamePid;
    if (pid === undefined || this.#session.focusWatch() || !this.#session.attached) return;
    const session = this.#session;
    const focus = await HostFocus.start({ pid, platform: this.#platform, onChange: (focused) => void session.setHostFocus(focused) });
    session.setFocusWatcher(focus);
    if (focus.state().running) await session.setHostFocus(focus.focused);
  }

  /**
   * A window-mode game is a gamescope window on the desktop: its host focus gates polled input in the agent. On
   * Windows the game sees its own focus, so nothing is watched or sent; the `windows` record only makes
   * `game_input_lock` say so.
   */
  async launched(game: ProviderGame): Promise<void> {
    if (game.mode !== "window" && this.#platform !== "win32") return;
    this.#gamePid = game.pid;
    if (this.#session.attached) await this.#watch();
  }

  /** A new game has no agent and no pause: drop what the session remembered, and stop watching focus. */
  async stopped(): Promise<void> {
    await this.#session.stopFocusWatcher();
    this.#gamePid = undefined;
    this.#restoreMode = undefined;
    this.#session.close();
    this.#tick = undefined;
    this.#tickOff = undefined;
  }

  close(): void {
    void this.#session.stopFocusWatcher();
    this.#gamePid = undefined;
    this.#session.close();
  }
}

let installed: AgentInputProvider | undefined;

/** Install the process-wide provider sculkwire uses for itself (once; later calls keep the first). */
export function installAgentProvider(): void {
  if (installed) return;
  installed = new AgentInputProvider();
  setBuiltinInputProvider(installed);
}
