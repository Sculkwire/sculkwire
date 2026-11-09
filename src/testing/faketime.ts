/**
 * Virtual time for control-loop tests. Under `vi.useFakeTimers()` a test drives the controller's clock, the
 * controller's own timers and the fake game's timers and `Date.now()` from one fake clock, so a turn or a fight
 * plays out the same on a fast desktop, a loaded CI runner and Windows' coarse timers.
 */
import { vi } from "vitest";
import type { Clock } from "../runtime/client/player.ts";

/** The controller clock on the global (faked) `Date` and `setTimeout`, resolved at call time. */
export const fakeClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    if (signal?.aborted) {
      reject(signal.reason);
      return promise;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
    return promise;
  },
};

/** Mulberry32: a seeded `Math.random` replacement, so the camera's hand jitter repeats run to run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Advance fake time in `stepMs` slices until `work` settles (or `limitMs` of fake time passed), then return it. */
export async function drive<T>(work: Promise<T>, stepMs = 10, limitMs = 120_000): Promise<T> {
  let settled = false;
  work.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let t = 0; !settled && t < limitMs; t += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
  return work;
}
