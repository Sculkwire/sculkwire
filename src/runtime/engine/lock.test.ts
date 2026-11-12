import { describe, expect, it } from "vitest";
import type { EngineResult } from "./failure.ts";
import { InputLock, lockText, parseLockState, type LockState } from "./lock.ts";

const base: LockState = {
  locked: true,
  mode: "auto",
  by: "agent",
  user: false,
  active: true,
  window: true,
  dropped: 0,
  focusLost: 0,
  focusKept: 0,
  wineFocused: true,
  wineForeground: true,
  shift: { message: [0, 0], raw: [0, 0] },
  keysHidden: 0,
  hostFocused: true,
  pad: { hooked: 0, reads: 0, active: 0, hidden: 0 },
  camera: null,
};

/** An InputLock whose DLL is a function that records every request and answers from `state`. */
function fakeLock() {
  const sent: unknown[] = [];
  let state = { ...base, active: false, locked: false };
  const lock = new InputLock(async (params): Promise<EngineResult<unknown>> => {
    sent.push(params);
    if (params.active !== undefined) state = { ...state, active: params.active, locked: params.active && !state.user };
    if (params.mode) state = { ...state, mode: params.mode };
    return { ok: true, value: state };
  });
  return { lock, sent };
}

describe("parseLockState", () => {
  it("reads the DLL's result and rejects other shapes", () => {
    expect(
      parseLockState({
        locked: true,
        mode: "on",
        by: "user",
        user: false,
        active: false,
        window: true,
        dropped: 3,
        shift: { message: [2, 1], raw: [4] },
        hostFocused: false,
        pad: { hooked: 2, reads: 10, active: 3, hidden: 3 },
        camera: "disabled",
      }),
    ).toEqual({
      locked: true,
      mode: "on",
      by: "user",
      user: false,
      active: false,
      window: true,
      dropped: 3,
      focusLost: 0,
      focusKept: 0,
      wineFocused: true,
      wineForeground: true,
      shift: { message: [2, 1], raw: [4, 0] },
      keysHidden: 0,
      hostFocused: false,
      pad: { hooked: 2, reads: 10, active: 3, hidden: 3 },
      camera: "disabled",
    });
    expect(parseLockState({ locked: true, mode: "sometimes" })).toBeUndefined();
    expect(parseLockState(null)).toBeUndefined();
    expect(lockText({ ...base, locked: false, user: true })).toContain("F9 gives it back");
    expect(lockText({ ...base, hostFocused: false })).toContain("not focused on the desktop");
  });
});

describe("InputLock", () => {
  it("declares active once for nested holds and drops it after the last", async () => {
    const { lock, sent } = fakeLock();
    const a = await lock.hold();
    const b = await lock.hold();
    await a();
    await a();
    expect(sent).toEqual([{ active: true }]);
    await b();
    expect(sent).toEqual([{ active: true }, { active: false }]);
  });

  it("fires takeover listeners on the user's F9 and waits for control to come back", async () => {
    const { lock } = fakeLock();
    let takeovers = 0;
    lock.onTakeover(() => takeovers++);
    lock.update({ ...base, locked: false, user: true, by: "user" });
    lock.update({ ...base, locked: false, user: true, by: "user" });
    expect(takeovers).toBe(1);
    let back = false;
    const waiting = lock.untilControl().then(() => (back = true));
    await Promise.resolve();
    expect(back).toBe(false);
    lock.update({ ...base, by: "user" });
    await waiting;
    expect(back).toBe(true);
  });

  it("stops waiting when the signal aborts", async () => {
    const { lock } = fakeLock();
    lock.update({ ...base, locked: false, user: true });
    const stop = new AbortController();
    const waiting = lock.untilControl(stop.signal);
    stop.abort();
    await expect(waiting).resolves.toBeUndefined();
  });
});
