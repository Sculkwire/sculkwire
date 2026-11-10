import { describe, expect, it } from "vitest";
import { EngineSession } from "./engine.ts";
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
});
