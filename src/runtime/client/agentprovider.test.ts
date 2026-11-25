import { describe, expect, it } from "vitest";
import { EngineSession } from "../engine/engine.ts";
import type { EngineResult } from "../engine/failure.ts";
import { InputLock, type LockMode } from "../engine/lock.ts";
import { AgentInputProvider } from "./agentprovider.ts";

/**
 * A session whose agent answers `input.lock` like the DLL for one connection: `mode`, and a session lock that locks in
 * `auto`. `old`: an agent that predates session locks (ignores `session`, never reports it). Records each call's params.
 */
function lockingSession(mode: LockMode, { attached = true, old = false } = {}): { session: EngineSession; sent: unknown[] } {
  const session = new EngineSession({ port: 9, timeoutMs: 500 });
  const sent: unknown[] = [];
  let current = mode;
  let held = false;
  const lock = new InputLock(async (params): Promise<EngineResult<unknown>> => {
    sent.push(params);
    if (params.mode) current = params.mode;
    if (params.session !== undefined && !old) held = params.session;
    const locked = current === "on" || (current === "auto" && held);
    return { ok: true, value: { locked, mode: current, by: "agent", user: false, ...(old ? {} : { session: held }) } };
  });
  Object.assign(session, { lock });
  Object.defineProperty(session, "attached", { get: () => attached });
  return { session, sent };
}

describe("AgentInputProvider session lock", () => {
  it("holds a session lock that locks in auto, leaves the mode alone, and ends it on release", async () => {
    const { session, sent } = lockingSession("auto");
    const provider = new AgentInputProvider(session, "linux");
    expect(await provider.sessionLock("on")).toBeUndefined();
    expect(provider.lockStatus()).toEqual({ mode: "auto", locked: true, user: false, session: true });
    await provider.releaseSessionLock();
    expect(sent).toEqual([{ session: true }, { session: false }]);
    expect(provider.lockStatus()).toEqual({ mode: "auto", locked: false, user: false, session: false });
    // Released once: a second release sends nothing.
    await provider.releaseSessionLock();
    expect(sent.length).toBe(2);
  });

  it("says why when the loaded agent predates session locks, or game_input_lock set off", async () => {
    const old = lockingSession("auto", { old: true });
    expect(await new AgentInputProvider(old.session, "linux").sessionLock("on")).toBe(
      "the in-game agent loaded in the game predates session locks: restart the game so the next attach loads the current agent",
    );
    const off = lockingSession("off");
    expect(await new AgentInputProvider(off.session, "linux").sessionLock("on")).toBe(
      "game_input_lock set mode off, which never locks: set mode auto to let the session lock apply",
    );
  });

  it("auto: sets mode auto when another mode is set, and puts back an off but never an on", async () => {
    const stale = lockingSession("on");
    const fromStale = new AgentInputProvider(stale.session, "linux");
    await fromStale.sessionLock("auto");
    await fromStale.releaseSessionLock();
    expect(stale.sent).toEqual([{}, { mode: "auto" }]);

    const off = lockingSession("off");
    const fromOff = new AgentInputProvider(off.session, "linux");
    await fromOff.sessionLock("auto");
    await fromOff.releaseSessionLock();
    expect(off.sent).toEqual([{}, { mode: "auto" }, { mode: "off" }]);
  });

  it("turns an on set by game_input_lock into auto on release, and sends nothing without an agent", async () => {
    const { session, sent } = lockingSession("auto");
    const provider = new AgentInputProvider(session, "linux");
    await session.lock.request("on");
    await provider.releaseSessionLock();
    expect(sent.at(-1)).toEqual({ mode: "auto" });

    const gone = lockingSession("on", { attached: false });
    await new AgentInputProvider(gone.session, "linux").releaseSessionLock();
    expect(gone.sent).toEqual([]);
  });

  it("says why when the agent cannot be attached, and sets nothing", async () => {
    const { session, sent } = lockingSession("auto", { attached: false });
    session.attach = async () => {
      throw new Error("no game is running");
    };
    const provider = new AgentInputProvider(session, "linux");
    expect(await provider.sessionLock("on")).toBe("the in-game agent could not be attached (no game is running)");
    expect(sent).toEqual([]);
  });
});

describe("AgentInputProvider without an agent", () => {
  it("reports no motion and no pause, fails the engine route, and starts no watcher outside window mode on Linux", async () => {
    // Port 9 (discard) has no agent listening.
    const session = new EngineSession({ port: 9, timeoutMs: 500 });
    const provider = new AgentInputProvider(session, "linux");
    expect(provider.motion()).toBeUndefined();
    expect(provider.pausedReason()).toBeUndefined();
    expect(await provider.input.reachable()).toBe(false);
    await expect(provider.input.prepare()).rejects.toThrow(/not_attached/);
    await provider.launched({ mode: "headless", pid: 0 });
    expect(session.focusWatch()).toBeUndefined();
    await provider.stopped();
    provider.close();
  });

  it("starts no focus watcher for a game it never drives, on Windows either", async () => {
    const session = new EngineSession({ port: 9, timeoutMs: 500 });
    const sent: (boolean | undefined)[] = [];
    session.setHostFocus = async (focused) => void sent.push(focused);
    const provider = new AgentInputProvider(session, "win32");
    // The watcher gates the agent's polled input, so it belongs to the engine route: a keyboard-only game gets none.
    await provider.launched({ mode: "desktop", pid: 0 });
    expect(session.focusWatch()).toBeUndefined();
    expect(sent).toEqual([]);
    await provider.stopped();
    expect(session.focusWatch()).toBeUndefined();
    provider.close();
  });

  it("sends a key's press and release through ui.key and fails the call when the agent refuses it", async () => {
    const session = new EngineSession({ port: 9, timeoutMs: 500 });
    const sent: unknown[] = [];
    let refuse = false;
    session.uiKey = async (key, action): Promise<EngineResult<unknown>> => {
      sent.push({ key, action });
      return refuse ? { ok: false, code: -32001, reason: "anchor_missing", message: "no game window" } : { ok: true, value: {} };
    };
    const provider = new AgentInputProvider(session, "linux");
    await provider.input.key?.("3", true);
    await provider.input.key?.("3", false);
    expect(sent).toEqual([
      { key: "3", action: "down" },
      { key: "3", action: "up" },
    ]);
    refuse = true;
    await expect(provider.input.key?.("e", true)).rejects.toThrow("anchor_missing: no game window");
    provider.close();
  });

  it("holds and lets go of the attack button through input.attack {hold} and fails the call when the agent refuses it", async () => {
    const session = new EngineSession({ port: 9, timeoutMs: 500 });
    const sent: boolean[] = [];
    let refuse = false;
    session.attackHold = async (hold): Promise<EngineResult<unknown>> => {
      sent.push(hold);
      return refuse ? { ok: false, code: -32001, reason: "anchor_missing", message: "no game window" } : { ok: true, value: { held: hold } };
    };
    const provider = new AgentInputProvider(session, "linux");
    await provider.input.attackHold?.(true);
    await provider.input.attackHold?.(false);
    expect(sent).toEqual([true, false]);
    refuse = true;
    await expect(provider.input.attackHold?.(true)).rejects.toThrow("anchor_missing: no game window");
    provider.close();
  });
});
