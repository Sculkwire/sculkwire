/**
 * The in-game agent as sculkwire's built-in in-process input provider: the player controller's engine route (absolute
 * view, held movement, attacks and item use through the game), the tick stream that replaces the helper's position and
 * rotation while it is fresh, the pause guard, the input lock around actions and play jobs, and the desktop focus
 * watcher of a window-mode game that gates polled input in the agent.
 *
 * `agentProvider` is installed as the built-in provider when this module loads, which is why `src/mcp/server.ts` and
 * `src/cli.ts` import the engine feature. An extension's `registerInputProvider` replaces it while that extension is
 * active; nothing has to be registered for the agent to be the default route.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { setBuiltinInputProvider, type InputProvider, type ProviderGame, type ProviderMotion } from "../client/inputprovider.ts";
import type { EngineInput } from "../client/player.ts";
import { engine, type EngineResult, type EngineSession, type EngineTick } from "./engine.ts";
import { HostFocus, type FocusWatchState } from "./focus.ts";
import { KEYBOARD_LOCK_NOTE } from "./lock.ts";

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
  /** The desktop focus watcher of a window-mode game, or the `windows` record of a game on Windows. */
  #focus?: HostFocus;
  /** The game to watch, kept from `launched` until an engine call starts the watcher. */
  #gamePid?: number;
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

  async attach(): Promise<void> {
    await this.#session.attach();
    await this.#watch();
  }

  /**
   * Start the desktop focus watcher once the agent is in use. A keyboard-only game never starts one: the watcher gates
   * the agent's polled input, so it belongs to the engine route.
   */
  async #watch(): Promise<void> {
    const pid = this.#gamePid;
    if (pid === undefined || this.#focus || !this.#session.attached) return;
    const session = this.#session;
    this.#focus = await HostFocus.start({ pid, platform: this.#platform, onChange: (focused) => void session.setHostFocus(focused) });
    if (this.#focus.state().running) await session.setHostFocus(this.#focus.focused);
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
    await this.#focus?.stop();
    this.#focus = undefined;
    this.#gamePid = undefined;
    await this.#session.setHostFocus(undefined);
    this.#session.close();
    this.#tick = undefined;
    this.#tickOff = undefined;
  }

  close(): void {
    void this.#focus?.stop();
    this.#focus = undefined;
    this.#gamePid = undefined;
    this.#session.close();
  }

  /** The desktop focus watcher's state; undefined when no window-mode game runs (Linux) or no game was launched. */
  focusWatch(): FocusWatchState | undefined {
    return this.#focus?.state();
  }
}

/** The process-wide provider sculkwire installs for itself. */
export const agentProvider = new AgentInputProvider();
setBuiltinInputProvider(agentProvider);
