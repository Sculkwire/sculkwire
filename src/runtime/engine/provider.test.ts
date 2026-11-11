import { describe, expect, it } from "vitest";
import { EngineSession, type EngineResult } from "./engine.ts";
import { AgentInputProvider } from "./provider.ts";

describe("AgentInputProvider without an agent", () => {
  it("reports no motion and no pause, fails the engine route, and starts no watcher outside window mode on Linux", async () => {
    // Port 9 (discard) has no agent listening.
    const provider = new AgentInputProvider(new EngineSession({ port: 9, timeoutMs: 500 }), "linux");
    expect(provider.motion()).toBeUndefined();
    expect(provider.pausedReason()).toBeUndefined();
    expect(await provider.input.reachable()).toBe(false);
    await expect(provider.input.prepare()).rejects.toThrow(/not_attached/);
    await provider.launched({ mode: "headless", pid: 0 });
    expect(provider.focusWatch()).toBeUndefined();
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
    expect(provider.focusWatch()).toBeUndefined();
    expect(sent).toEqual([]);
    await provider.stopped();
    expect(provider.focusWatch()).toBeUndefined();
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
