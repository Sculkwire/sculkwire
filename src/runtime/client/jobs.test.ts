import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { readLevelDat } from "../bds/nbt.ts";
import type { ClientInstall } from "./install.ts";
import { PlayJobs, runActions, type PlayRunner } from "./jobs.ts";
import type { PlayerInput } from "./launcher.ts";
import { PlayerController, type PlayerState, type PlayerWorld } from "./player.ts";
import type { PlayResult, PlayStep } from "./skills/play.ts";
import { createWorld, type CreatedWorld } from "./world.ts";

function step(n: number): PlayStep {
  return {
    step: n,
    atMs: n * 10,
    action: "fight",
    target: { key: "zombie_1", id: "-1", typeId: "minecraft:zombie" },
    score: 0.7,
    reason: "goal target",
    result: { ok: true, message: "hit", durationMs: 5 },
  };
}

/**
 * A fake play loop: one step every `everyMs` until `steps` are done or the signal aborts, like `play`. Real short
 * timers, because the jobs race a running loop against stop, wait timeouts and replacement.
 */
function fakeLoop(steps: number, everyMs: number, log: string[] = []): PlayRunner {
  return async ({ signal, onStep }) => {
    const trace: PlayStep[] = [];
    let stoppedBy: PlayResult["stoppedBy"] = "goal_done";
    let message = "done";
    for (let i = 1; i <= steps; i++) {
      if (signal.aborted) {
        stoppedBy = "error";
        message = "cancelled";
        break;
      }
      await sleep(everyMs);
      const s = step(i);
      trace.push(s);
      onStep(s);
    }
    log.push("released");
    return {
      goal: "g",
      steps: trace.length,
      stoppedBy,
      message,
      durationMs: 0,
      goalCheck: { kind: "free", known: false, progress: "" },
      stats: { decisions: trace.length, kills: 0, killed: {}, swings: 0, hits: 0, crits: 0, damageTaken: 0, deaths: 0 },
      trace,
    };
  };
}

describe("PlayJobs", () => {
  it("starts a job that reports progress while it runs and the full result when done", async () => {
    const jobs = new PlayJobs();
    const started = await jobs.start("kill the zombies", fakeLoop(4, 20));
    expect(started).toMatchObject({ id: "play-1", status: "running", goal: "kill the zombies" });
    expect(jobs.current?.id).toBe("play-1");
    await sleep(50);
    const mid = jobs.status();
    expect(mid.status).toBe("running");
    expect(mid.progress.steps).toBeGreaterThan(0);
    expect(mid.progress.lastActions[0]).toMatch(/^step 1: fight zombie_1 ok: hit$/);
    const seen: number[] = [];
    const done = await jobs.wait(undefined, 5000, { onStep: (s) => seen.push(s.step) });
    expect(done.status).toBe("done");
    expect(done.result?.steps).toBe(4);
    expect(done.progress.steps).toBe(4);
    expect(seen.at(-1)).toBe(4);
    expect(jobs.current).toBeUndefined();
    expect(jobs.status("play-1")).toMatchObject({ status: "done", stopReason: "goal_done" });
  });

  it("returns from wait at the timeout while the job keeps running", async () => {
    const jobs = new PlayJobs();
    await jobs.start("g", fakeLoop(100, 20));
    const t = Date.now();
    const r = await jobs.wait(undefined, 60);
    expect(Date.now() - t).toBeLessThan(500);
    expect(r.status).toBe("running");
    await jobs.stopAll("test over");
  });

  it("returns from wait when the request is cancelled", async () => {
    const jobs = new PlayJobs();
    await jobs.start("g", fakeLoop(100, 20));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const r = await jobs.wait(undefined, 10_000, { signal: ac.signal });
    expect(r.status).toBe("running");
    await jobs.stopAll("test over");
  });

  it("stops a job and waits until it let go of the input", async () => {
    const jobs = new PlayJobs();
    const log: string[] = [];
    await jobs.start("g", fakeLoop(100, 20, log));
    await sleep(30);
    const r = await jobs.stop();
    expect(log).toEqual(["released"]);
    expect(r.status).toBe("stopped");
    expect(r.stopReason).toBe("stopped by player_job");
    expect(r.result?.message).toBe("cancelled");
  });

  it("stops the running job when a second one starts", async () => {
    const jobs = new PlayJobs();
    const first: string[] = [];
    await jobs.start("first", fakeLoop(100, 20, first));
    const second = await jobs.start("second", fakeLoop(100, 20));
    expect(first).toEqual(["released"]);
    expect(jobs.status("play-1")).toMatchObject({ status: "stopped", stopReason: "replaced by a new play job" });
    expect(second.id).toBe("play-2");
    expect(jobs.current?.id).toBe("play-2");
    await jobs.stopAll("test over");
  });

  it("stops the running job on shutdown and reports a failed loop", async () => {
    const jobs = new PlayJobs();
    await jobs.start("g", fakeLoop(100, 20));
    await jobs.stopAll("the MCP server is shutting down");
    expect(jobs.status()).toMatchObject({ status: "stopped", stopReason: "the MCP server is shutting down" });
    await jobs.start("boom", async () => {
      throw new Error("model unreachable");
    });
    const r = await jobs.wait(undefined, 1000);
    expect(r).toMatchObject({ status: "failed", error: "model unreachable", stopReason: "error" });
  });

  it("names a job that does not exist", async () => {
    const jobs = new PlayJobs();
    expect(() => jobs.status()).toThrow(/no play job/);
    expect(() => jobs.status("play-9")).toThrow(/no play job play-9/);
  });
});

describe("runActions", () => {
  it("stops a long action when the request is cancelled and releases every key", async () => {
    const held = new Set<string>();
    const state: PlayerState = {
      tick: 0,
      name: "p",
      location: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0 },
      dimension: "minecraft:overworld",
      onGround: true,
      sneaking: false,
      sprinting: false,
      gameMode: "survival",
      selectedSlot: 1,
    };
    const input: PlayerInput = {
      keyDown: async (k) => {
        held.add(k);
      },
      keyUp: async (k) => {
        held.delete(k);
      },
      look: async () => {},
      button: async () => {},
    };
    const world: PlayerWorld = {
      input,
      state: async () => structuredClone(state),
      entity: async () => null,
      nearest: async () => null,
      impacts: async () => ({ tick: 0, impacts: [] }),
    };
    const controller = new PlayerController(world);
    const ac = new AbortController();
    const t = Date.now();
    setTimeout(() => {
      expect(held.has("w")).toBe(true);
      ac.abort();
    }, 100);
    const results = await runActions(
      controller,
      [
        { action: "hold", keys: ["w"], ms: 10_000 },
        { action: "wait", ms: 10_000 },
      ],
      { signal: ac.signal },
    );
    expect(Date.now() - t).toBeLessThan(2000);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(held.size).toBe(0);
  });
});

describe("world difficulty", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("writes normal by default and the chosen difficulty into level.dat", async () => {
    dir = await mkdtemp(join(tmpdir(), "sculkwire-difficulty-"));
    const install = { userComMojang: dir, sharedComMojang: dir } as ClientInstall;
    const difficulty = async (world: CreatedWorld) => readLevelDat(await readFile(join(world.dir, "level.dat"))).root.get("Difficulty")?.value;
    expect(await difficulty(await createWorld(install, { name: "d1", helper: false }))).toBe(2);
    expect(await difficulty(await createWorld(install, { name: "d2", helper: false, difficulty: "hard" }))).toBe(3);
    expect(await difficulty(await createWorld(install, { name: "d3", helper: false, difficulty: "peaceful" }))).toBe(0);
  });

  it("turns multiplayer and every broadcast off, so nobody can join a test session", async () => {
    dir = await mkdtemp(join(tmpdir(), "sculkwire-private-"));
    const install = { userComMojang: dir, sharedComMojang: dir } as ClientInstall;
    const world = await createWorld(install, { name: "private", helper: false });
    const root = readLevelDat(await readFile(join(world.dir, "level.dat"))).root;
    const keys = ["MultiplayerGame", "MultiplayerGameIntent", "LANBroadcast", "LANBroadcastIntent", "XBLBroadcastIntent", "PlatformBroadcastIntent"];
    expect(Object.fromEntries(keys.map((k) => [k, root.get(k)?.value]))).toEqual(Object.fromEntries(keys.map((k) => [k, 0])));
  });
});
