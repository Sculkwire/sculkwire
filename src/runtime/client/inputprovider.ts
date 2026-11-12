/**
 * The in-process input provider: the second input route next to the keyboard (`input: "engine"` in `player_act` and
 * `sculk bench`). The bridge hands its `input` to the controller, merges its motion stream over the helper's player
 * state, tells it when a game starts and stops, and `player_act` asks it whether the simulation is paused and holds its
 * input lock around actions and play jobs.
 *
 * sculkwire installs its own provider, the in-game agent (`agentprovider.ts`), as the built-in one from `wireFeatures()`
 * (`src/features.ts`). An extension may replace it through `registerInputProvider`; removing that one falls back to the
 * built-in provider. There is one provider in use at a time, so the controller, `player_act` and `sculk bench` never
 * have to choose.
 *
 * Without a provider the keyboard route is the only one: `auto` uses it, `engine` fails, nothing is paused, locked,
 * watched or closed.
 */
import { onShutdown } from "../../core/shutdown.ts";
import type { LaunchMode } from "./launcher.ts";
import type { MoveVector } from "./input.ts";

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

/** Player motion as the provider streams it. Position is the feet, velocity in blocks per tick. */
export interface ProviderMotion {
  position: [number, number, number];
  /** Pitch (+ looks down) and yaw (0 = +Z) in degrees. */
  rotation: [number, number];
  velocity: [number, number, number];
  /** Null while not readable. */
  onGround: boolean | null;
  health: number | null;
}

/** A game the bridge launched. */
export interface ProviderGame {
  mode: LaunchMode;
  /** PID of the process sculkwire spawned (gamescope or the launch command); 0 when the user starts the game. */
  pid: number;
}

export interface InputProvider {
  /** Shown in error messages. */
  readonly name: string;
  /** The controller's engine route. */
  readonly input: EngineInput;
  /** The newest motion sample and when it arrived (`Date.now()`), while the provider streams one. */
  motion(): { at: number; motion: ProviderMotion } | undefined;
  /** Why the player cannot move right now (the simulation is paused), or undefined. */
  pausedReason(): string | undefined;
  /** Added to `player_act` output when the keyboard route was used although this provider is installed. */
  readonly keyboardNote?: string;
  /** Hold the input lock while an action or play job runs. Resolves to the function that releases it. Never throws. */
  hold(): Promise<() => Promise<void>>;
  /** Make the engine route usable before a bench run. Throws when it cannot be. */
  attach(): Promise<void>;
  /** The bridge launched a game. Never throws. */
  launched(game: ProviderGame): Promise<void>;
  /** No game runs any more (stopped, or a new one is about to start): forget per-game state. Never throws. */
  stopped(): Promise<void>;
  /** The process is shutting down. */
  close(): void;
}

/** sculkwire's own provider, and the extension provider that replaces it while installed. */
let builtin: InputProvider | undefined;
let extended: InputProvider | undefined;
let shutdownHooked = false;

/** Close whatever is installed when the process shuts down, and only once. */
function hookShutdown(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  onShutdown(() => {
    extended?.close();
    builtin?.close();
  });
}

/**
 * Install sculkwire's own provider. Called once by `installAgentProvider()`; an extension's provider replaces it and
 * falls back to it when removed.
 */
export function setBuiltinInputProvider(provider: InputProvider | undefined): void {
  builtin = provider;
  if (provider) hookShutdown();
}

/**
 * Install an extension's provider, which replaces the built-in one while it is installed. Registering again replaces
 * the previous extension provider; removing it falls back to the built-in one. Returns the function that removes it.
 */
export function registerInputProvider(provider: InputProvider): () => void {
  extended = provider;
  hookShutdown();
  return () => {
    if (extended === provider) extended = undefined;
  };
}

/** The provider in use: an extension's while installed, else sculkwire's own, else none. */
export function inputProvider(): InputProvider | undefined {
  return extended ?? builtin;
}

/**
 * Runs `body` while `locking` holds its input lock, so the user's keyboard and mouse stay out of the game, and
 * releases it either way. Pass undefined off the engine route: the body then runs unlocked.
 */
export async function withInputLock<T>(locking: InputProvider | undefined, body: () => Promise<T>): Promise<T> {
  const unhold = await locking?.hold();
  try {
    return await body();
  } finally {
    await unhold?.();
  }
}

/** Why `input: "engine"` cannot be used when no provider is installed. */
export const NO_INPUT_PROVIDER = "no in-process input provider is installed, so only the keyboard route exists";
