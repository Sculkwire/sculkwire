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
import type { EngineInput } from "./player.ts";

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

/** Why `input: "engine"` cannot be used when no provider is installed. */
export const NO_INPUT_PROVIDER = "no in-process input provider is installed, so only the keyboard route exists";
