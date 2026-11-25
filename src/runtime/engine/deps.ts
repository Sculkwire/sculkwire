/**
 * What the engine feature needs from the game client above it, handed in by `src/features.ts` (and by the client code
 * that calls engine functions) so this layer never imports `runtime/client`.
 */

/** The helper pack's Script API route and the client's view of the running game. */
export interface ScriptRoute {
  /**
   * One `/scriptevent sculkwire:query` answered by the helper pack. Rejects when it cannot answer; a refusal of the
   * request itself carries the helper's reason as the error's `reason` (`no_container`, `no_block`, ...).
   */
  query(kind: string, params?: Record<string, unknown>): Promise<unknown>;
  /**
   * The world of the game this process's bridge runs: the world it entered, or the one the game it attached to has
   * open. Undefined when none runs (or the attached game sits in a menu).
   */
  loadedWorld(): { levelId: string; name: string } | undefined;
  /** The user's saved default dev world (game_worlds `use`), or undefined. */
  devWorld(): Promise<{ levelId: string; name: string } | undefined>;
  /** Whether the install's game process runs, started by sculkwire or not. */
  gameRunning(): Promise<boolean>;
}

export interface EngineDeps {
  script: ScriptRoute;
}
