/**
 * `start` on an install the user starts: the bridge returns at once and keeps waiting for the world in the background.
 * The launcher is replaced so no game process is looked up, started or stopped.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Install from "../../gamefiles/install.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { ClientBridge } from "./bridge.ts";
import type * as ContentLog from "./contentlog.ts";
import { readDebugLogSince } from "./contentlog.ts";
import type * as Launcher from "./launcher.ts";
import type { LaunchState } from "./launcher.ts";

const state: LaunchState = { mode: "desktop", startedAt: 0, pid: 0, argv: [], launchLog: "", notes: ["start Minecraft yourself"] };
let install: ClientInstall;

vi.mock("../../gamefiles/install.ts", async (original) => ({
  ...(await original<typeof Install>()),
  findInstall: async () => install,
}));
vi.mock("./launcher.ts", async (original) => ({
  ...(await original<typeof Launcher>()),
  launch: async () => ({ ...state }),
  waitForGame: async () => process.pid,
  readLaunchState: async () => ({ ...state }),
  stop: async () => ({ stopped: true, message: "the game was not running" }),
}));
vi.mock("./contentlog.ts", async (original) => {
  const real = await original<typeof ContentLog>();
  return { ...real, readDebugLogSince: vi.fn(real.readDebugLogSince) };
});

describe("client bridge start", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sw-bridge-start-"));
    process.env.SCULKWIRE_DATA = join(dir, "data");
    install = {
      kind: "custom",
      label: "fake",
      appData: dir,
      sharedComMojang: dir,
      userComMojang: dir,
      logsDir: join(dir, "logs"),
      wine: false,
      preview: false,
    } as ClientInstall;
  });

  afterEach(async () => {
    delete process.env.SCULKWIRE_DATA;
    await rm(dir, { recursive: true, force: true });
  });

  it("ends the background wait for the world when the session stops", async () => {
    const bridge = new ClientBridge();
    const status = await bridge.start({ mode: "desktop", debuggerPort: 0, connectPort: 0 });
    expect(status.ready).toBe(false);
    // The background wait reads the engine log every 500 ms while the world is not up.
    await vi.waitFor(() => expect(vi.mocked(readDebugLogSince)).toHaveBeenCalled());
    await bridge.stop();
    const reads = vi.mocked(readDebugLogSince).mock.calls.length;
    await sleep(1_200);
    expect(vi.mocked(readDebugLogSince).mock.calls.length).toBe(reads);
    expect(bridge.status().manualSteps.filter((m) => m.includes("did not reach the world"))).toEqual([]);
  });
});
