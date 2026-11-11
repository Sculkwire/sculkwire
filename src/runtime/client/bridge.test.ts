import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ClientBridge, connectView } from "./bridge.ts";
import type { LaunchState } from "./launcher.ts";

const launch = (gamePid?: number): LaunchState => ({
  mode: "desktop",
  startedAt: 0,
  pid: 0,
  argv: [],
  launchLog: "",
  notes: ["start Minecraft yourself"],
  ...(gamePid !== undefined ? { gamePid } : {}),
});

/** A pid that existed and is gone now. */
const exitedPid = (): number => {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (!pid) throw new Error("no child pid");
  return pid;
};

describe("client bridge liveness", () => {
  it("counts a launch as running while its game process lives, and before the user started it", () => {
    const bridge = new ClientBridge();
    expect(bridge.status()).toMatchObject({ running: false, ready: false });
    bridge.launchState = launch();
    expect(bridge.running).toBe(true);
    bridge.launchState = launch(process.pid);
    expect(bridge.running).toBe(true);
    expect(bridge.status().gameExited).toBeUndefined();
  });

  it("reports a game whose process exited as not running, with game_stop as the step", async () => {
    const bridge = new ClientBridge();
    const pid = exitedPid();
    bridge.launchState = launch(pid);
    expect(bridge.running).toBe(false);
    const s = bridge.status();
    expect(s).toMatchObject({ running: false, ready: false, mode: "desktop", gameExited: true });
    expect(s.manualSteps).toEqual([`the game process (pid ${pid}) exited: call game_stop to clean up, then game_launch`]);
    await expect(bridge.command("say hi")).rejects.toThrow(`the game process (pid ${pid}) exited`);
  });
});

describe("/connect manual step", () => {
  const step = 'type "/connect localhost:19131" in the game chat to enable /connect';

  it("drops the step once a client attached, names the method chat, and shows it again when the client is gone", () => {
    expect(connectView(step, undefined, 0)).toEqual({ status: { clients: 0 }, steps: [step] });
    expect(connectView(step, undefined, 1)).toEqual({ status: { clients: 1, method: "chat" }, steps: [] });
    expect(connectView(step, undefined, 0)).toEqual({ status: { clients: 0 }, steps: [step] });
  });

  it("keeps a known method and has no step when the game dialled in by itself", () => {
    expect(connectView(undefined, "automatic", 1)).toEqual({ status: { clients: 1, method: "automatic" }, steps: [] });
    expect(connectView(undefined, undefined, 0)).toEqual({ status: { clients: 0 }, steps: [] });
  });
});
