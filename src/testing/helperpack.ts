/**
 * Runs the helper pack's `scripts/main.js` in Node with stand-ins for `@minecraft/server`, and reads what it prints.
 * Test-only: nothing outside the tests imports it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { HELPER_MARK, HELPER_QUERY_EVENT, isReplyTo, parseReply, type HelperReply } from "../runtime/client/helperprotocol.ts";
import { HELPER_PACK_DIR } from "../runtime/client/world.ts";

/**
 * Run main.js with `modules` standing in for the names it imports from `@minecraft/server` (`system`, `world`,
 * `BlockVolume`, …), then collect its `console.log` lines. Restore with `vi.restoreAllMocks()`.
 */
export function runHelperScript(modules: Record<string, unknown>): string[] {
  const source = readFileSync(join(HELPER_PACK_DIR, "scripts", "main.js"), "utf8").replace(/^import .*$/m, "");
  new Function(...Object.keys(modules), source)(...Object.values(modules));
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
  return lines;
}

/** The `/scriptevent` the bridge sends for a query, as the pack's `scriptEventReceive` handler gets it. */
export function queryEvent(params: Record<string, unknown>, id: number): { id: string; message: string } {
  return { id: HELPER_QUERY_EVENT, message: JSON.stringify({ ...params, id }) };
}

/** The pack's reply to query `id` among its prints, once it printed one. */
export function replyIn(lines: readonly string[], id: number): HelperReply | undefined {
  const line = lines.find((l) => isReplyTo(l, id));
  return line === undefined ? undefined : parseReply(line);
}

/** The newest streamed player state among the pack's prints. */
export function lastStateIn(lines: readonly string[]): unknown {
  const line = lines.findLast((l) => l.startsWith(HELPER_MARK.state)) ?? "";
  return JSON.parse(line.slice(HELPER_MARK.state.length));
}
