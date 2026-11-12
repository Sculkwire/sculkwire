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
  /** The world the running game has loaded, or undefined when none runs. */
  loadedWorld(): { levelId: string; name: string } | undefined;
}

export interface EngineDeps {
  script: ScriptRoute;
}
