/** `update.json`: when the last check ran, what it found, and the version before the last switch. */
import { readJsonOr, writeJsonAtomic } from "../core/fs.ts";
import type { Layout } from "./layout.ts";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateState {
  /** Version that was current before the last switch (`update --rollback` target). */
  previous?: string;
  /** Last automatic or manual check (ms since epoch). */
  lastCheck?: number;
  /** Newest version seen at the last check. */
  latest?: string;
  /** Why the last check or install failed. */
  lastError?: string;
  /** Last version `update` switched to. */
  applied?: { version: string; at: number };
}

export async function readState(l: Layout): Promise<UpdateState> {
  return (await readJsonOr<UpdateState>(l.stateFile)) ?? {};
}

export async function patchState(l: Layout, patch: Partial<UpdateState>): Promise<UpdateState> {
  const next = { ...(await readState(l)), ...patch };
  await writeJsonAtomic(l.stateFile, next);
  return next;
}

/** Once a check is due: never checked, 24 h passed, or the clock went backwards. */
export function dueForCheck(state: UpdateState, now: number = Date.now(), intervalMs: number = CHECK_INTERVAL_MS): boolean {
  return state.lastCheck === undefined || now < state.lastCheck || now - state.lastCheck >= intervalMs;
}
