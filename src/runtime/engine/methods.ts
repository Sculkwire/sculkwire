/**
 * Every JSON-RPC method this client sends to the agent, with the client-side timeout of its call. A method without one
 * uses the connection's default (`EngineSession.timeoutMs`). The agent routes them in `native/agent/src/lib.rs`
 * (`METHODS`) and `native/agent-core/src/rpc.rs`; `methods.test.ts` checks the names against both.
 */

/** `input.*` answer before the next frame, so a slow answer means the drain is stuck rather than busy. */
export const INPUT_TIMEOUT_MS = 2_000;
/** `ui.*` answer on the game's next UI frame, so a slow answer means the frame hook is not running. */
const UI_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 60_000;
const SCREENSHOT_TIMEOUT_MS = 60_000;
/** Reading a container or a screen touches every slot it shows; so does using a block or an entity that opens one. */
const SLOTS_TIMEOUT_MS = 20_000;
/** A screen action and a recipe lookup run the game's own request. */
const REQUEST_TIMEOUT_MS = 60_000;

export const METHODS = {
  ping: {},
  "engine.status": {},
  "stream.subscribe": {},
  "stream.unsubscribe": {},
  command: { timeoutMs: COMMAND_TIMEOUT_MS },
  "command.prime": {},
  "tick.pause": {},
  "tick.step": { timeoutMs: STEP_TIMEOUT_MS },
  "tick.scale": {},
  screenshot: { timeoutMs: SCREENSHOT_TIMEOUT_MS },
  "player.state": {},
  "input.look": { timeoutMs: INPUT_TIMEOUT_MS },
  "input.move": { timeoutMs: INPUT_TIMEOUT_MS },
  "input.release": { timeoutMs: INPUT_TIMEOUT_MS },
  "input.attack": { timeoutMs: INPUT_TIMEOUT_MS },
  "input.use": { timeoutMs: INPUT_TIMEOUT_MS },
  "input.lock": { timeoutMs: INPUT_TIMEOUT_MS },
  "input.focus": { timeoutMs: INPUT_TIMEOUT_MS },
  "settings.list": {},
  "settings.get": {},
  "settings.set": {},
  "world.settings": {},
  "world.set": {},
  "ui.screen": { timeoutMs: UI_TIMEOUT_MS },
  "ui.controls": { timeoutMs: UI_TIMEOUT_MS },
  "ui.press": { timeoutMs: UI_TIMEOUT_MS },
  "ui.key": { timeoutMs: UI_TIMEOUT_MS },
  "ui.text": { timeoutMs: UI_TIMEOUT_MS },
  "ui.click": { timeoutMs: UI_TIMEOUT_MS },
  "ui.scroll": { timeoutMs: UI_TIMEOUT_MS },
  "player.attributes": {},
  "player.inventory": {},
  "container.get": { timeoutMs: SLOTS_TIMEOUT_MS },
  "container.open": { timeoutMs: SLOTS_TIMEOUT_MS },
  "craft.match": { timeoutMs: REQUEST_TIMEOUT_MS },
  "interact.block": { timeoutMs: SLOTS_TIMEOUT_MS },
  "interact.entity": { timeoutMs: SLOTS_TIMEOUT_MS },
  "screen.state": { timeoutMs: SLOTS_TIMEOUT_MS },
  "screen.move": { timeoutMs: SLOTS_TIMEOUT_MS },
  "screen.act": { timeoutMs: REQUEST_TIMEOUT_MS },
  "screen.close": { timeoutMs: SLOTS_TIMEOUT_MS },
} as const satisfies Record<string, { timeoutMs?: number }>;

export type MethodName = keyof typeof METHODS;

/** The method's own timeout, or undefined for the connection's default. */
export function methodTimeout(method: MethodName): number | undefined {
  const entry: { timeoutMs?: number } = METHODS[method];
  return entry.timeoutMs;
}
