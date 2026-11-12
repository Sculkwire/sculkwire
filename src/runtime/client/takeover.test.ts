/** How the client's player controller and play jobs react when the user takes control with F9 under the input lock. */
import { describe, expect, it } from "vitest";
import { InputLock, type LockState } from "../engine/lock.ts";
import type { EngineResult } from "../engine/failure.ts";
import { pauseOnTakeover } from "./jobs.ts";
import { TAKEOVER_MESSAGE, type EngineInput } from "./inputprovider.ts";
import { PlayerController } from "./player.ts";
import type { PlayerState, PlayerWorld } from "./types.ts";

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

function world(lock: InputLock): { world: PlayerWorld; released: () => number } {
  let releases = 0;
  const s: PlayerState = {
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
  const engine: EngineInput = {
    prepare: async () => undefined,
    reachable: async () => true,
    look: async () => undefined,
    move: async () => undefined,
    release: async () => {
      releases++;
    },
    attack: async () => null,
    use: async () => undefined,
    takeover: lock,
  };
  return {
    world: {
      input: { keyDown: async () => undefined, keyUp: async () => undefined, look: async () => undefined, button: async () => undefined },
      state: async () => structuredClone(s),
      engine,
      entity: async () => null,
      nearest: async () => null,
      impacts: async () => ({ tick: 0, impacts: [] }),
    },
    released: () => releases,
  };
}

describe("PlayerController under the input lock", () => {
  it("stops a running action when the user takes control and refuses new ones until it comes back", async () => {
    const { lock } = fakeLock();
    const { world: w, released } = world(lock);
    const pc = new PlayerController(w);
    expect(await pc.selectInput("engine")).toBe("engine");
    const running = pc.run({ action: "wait", ms: 5000 });
    // run() registers its takeover listener before its first await, so the F9 can arrive right away.
    lock.update({ ...base, locked: false, user: true, by: "user" });
    const r = await running;
    expect(r).toMatchObject({ ok: false, message: TAKEOVER_MESSAGE, input: "engine" });
    expect(r.durationMs).toBeLessThan(2000);
    expect(released()).toBeGreaterThan(0);
    expect(await pc.run({ action: "wait", ms: 1 })).toMatchObject({ ok: false, message: TAKEOVER_MESSAGE });
    lock.update({ ...base, by: "user" });
    expect(await pc.run({ action: "wait", ms: 1 })).toMatchObject({ ok: true });
  });

  it("pauses a play job's view of the world while the user holds control", async () => {
    const { lock } = fakeLock();
    lock.update({ ...base, locked: false, user: true });
    let looked = 0;
    const env = pauseOnTakeover({ entities: async (_radius: number) => ++looked }, lock, new AbortController().signal);
    const pending = env.entities(16);
    await Promise.resolve();
    lock.update(base);
    expect(await pending).toBe(1);
  });
});
