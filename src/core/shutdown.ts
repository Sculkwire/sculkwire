/**
 * Cleanup that must run when the MCP server goes away (the client closed stdin, or a signal). Features register
 * hooks; `serveStdio` runs them once before exiting. A game or server sculkwire started must not outlive it.
 */
import { errorMessage } from "./errors.ts";

const hooks = new Set<() => Promise<unknown> | unknown>();

export function onShutdown(hook: () => Promise<unknown> | unknown): void {
  hooks.add(hook);
}

let running: Promise<void> | undefined;

/** Run every hook once (later calls wait for the first run). Hook failures are reported, not thrown. */
export function runShutdown(): Promise<void> {
  running ??= (async () => {
    for (const hook of hooks) {
      try {
        await hook();
      } catch (err) {
        process.stderr.write(`sculkwire: shutdown hook failed: ${errorMessage(err)}\n`);
      }
    }
  })();
  return running;
}
