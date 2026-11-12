import { setTimeout as sleep } from "node:timers/promises";

/** Wall clock and timer of the control loops. */
export interface Clock {
  now(): number;
  /** Rejects with the signal's reason when it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => sleep(Math.max(0, ms), undefined, signal ? { signal } : undefined),
};
