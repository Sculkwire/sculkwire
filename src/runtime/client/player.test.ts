import { afterEach, describe, expect, it, vi } from "vitest";
import { drive, fakeClock, seededRandom } from "../../testing/faketime.ts";
import { unavailableInput, type PlayerInput } from "./launcher.ts";
import {
  angleDiff,
  estimateVelocity,
  flightTo,
  minimumJerk,
  moveKeys,
  pitchTo,
  planOffset,
  planTurn,
  PlayerController,
  PROJECTILES,
  projectileFor,
  solveIntercept,
  TURN_MAX_MS,
  TURN_MIN_MS,
  turnDurationMs,
  yawTo,
  type Ballistics,
  type EngineInput,
  type EntityInfo,
  type MoveVector,
  type PlayerState,
  type PlayerWorld,
  type Vec3,
} from "./player.ts";

describe("motion profile", () => {
  it("follows a minimum-jerk curve: 0 to 1, monotonic, symmetric", () => {
    expect(minimumJerk(0)).toBe(0);
    expect(minimumJerk(1)).toBe(1);
    expect(minimumJerk(0.5)).toBeCloseTo(0.5, 10);
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const v = minimumJerk(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(minimumJerk(0.2) + minimumJerk(0.8)).toBeCloseTo(1, 10);
  });

  it("takes longer for farther and narrower turns (Fitts' law), within 150 to 450 ms", () => {
    const d = [2, 10, 30, 90, 180].map((deg) => turnDurationMs(deg, 4));
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1] ?? 0);
    expect(d[1]).toBeGreaterThan(d[0] ?? 0);
    expect(d[3]).toBeGreaterThan(d[1] ?? 0);
    expect(Math.min(...d)).toBeGreaterThanOrEqual(TURN_MIN_MS);
    expect(Math.max(...d)).toBeLessThanOrEqual(TURN_MAX_MS);
    expect(turnDurationMs(30, 1)).toBeGreaterThan(turnDurationMs(30, 8));
  });

  it("plans a turn that moves monotonically along its axis and ends within a few percent of the target", () => {
    const values = [0.1, 0.9, 0.3, 0.7];
    let n = 0;
    const random = () => values[n++ % values.length] ?? 0.5;
    const plan = planTurn(120, -30, 4, 1000, random);
    expect(plan.durationMs).toBe(turnDurationMs(Math.hypot(120, -30), 4));
    const len = Math.hypot(120, -30);
    const ux = 120 / len;
    const uy = -30 / len;
    let prev = -1;
    for (let t = 1000; t <= 1000 + plan.durationMs; t += 1000 / 120) {
      const o = planOffset(plan, t);
      const along = o.yaw * ux + o.pitch * uy;
      expect(along).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = along;
    }
    const end = planOffset(plan, 1000 + plan.durationMs);
    expect(end.yaw).toBeCloseTo(plan.yaw, 9);
    expect(end.pitch).toBeCloseTo(plan.pitch, 9);
    // The overshoot or undershoot of a primary movement is small, and none for a short correction.
    expect(Math.abs(end.yaw - 120)).toBeLessThanOrEqual(120 * 0.08);
    expect(planTurn(5, 0, 4, 0, random).missYaw).toBe(0);
  });

  it("picks the WASD keys that walk toward a heading relative to the view", () => {
    expect(moveKeys(0, 0)).toEqual(["w"]);
    expect(moveKeys(0, 90)).toEqual(["d"]);
    expect(moveKeys(0, -45)).toEqual(["w", "a"]);
    expect(moveKeys(90, -90)).toEqual(["s"]);
    expect(moveKeys(170, -145)).toEqual(["w", "d"]);
  });
});

describe("view angles", () => {
  it("wraps the shortest turn across ±180", () => {
    expect(angleDiff(170, -170)).toBe(20);
    expect(angleDiff(-170, 170)).toBe(-20);
    expect(angleDiff(0, 180)).toBe(180);
  });

  it("uses Bedrock's yaw (0 = +Z, 90 = -X) and pitch (+ = down)", () => {
    const o = { x: 0, y: 0, z: 0 };
    expect(yawTo(o, { x: 0, y: 0, z: 5 })).toBeCloseTo(0);
    expect(yawTo(o, { x: -5, y: 0, z: 0 })).toBeCloseTo(90);
    expect(yawTo(o, { x: 5, y: 0, z: 0 })).toBeCloseTo(-90);
    expect(pitchTo(o, { x: 0, y: -5, z: 5 })).toBeCloseTo(45);
  });
});

/** Fly a projectile tick by tick from the solution's yaw and pitch and return its closest approach to `at(tick)`. */
function closestApproach(b: Ballistics, origin: Vec3, yaw: number, pitch: number, at: (tick: number) => Vec3): number {
  const y = (yaw * Math.PI) / 180;
  const p = (-pitch * Math.PI) / 180;
  const v = { x: -Math.sin(y) * Math.cos(p) * b.speed, y: Math.sin(p) * b.speed, z: Math.cos(y) * Math.cos(p) * b.speed };
  let pos = { ...origin };
  let best = Number.POSITIVE_INFINITY;
  for (let n = 0; n < 100; n++) {
    // Sub-steps between ticks, since the target point is crossed mid-tick.
    for (let k = 0; k < 10; k++) {
      const f = k / 10;
      const q = { x: pos.x + v.x * f, y: pos.y + v.y * f, z: pos.z + v.z * f };
      const t = at(n + f);
      best = Math.min(best, Math.hypot(q.x - t.x, q.y - t.y, q.z - t.z));
    }
    pos = { x: pos.x + v.x, y: pos.y + v.y, z: pos.z + v.z };
    v.x *= b.drag;
    v.z *= b.drag;
    v.y = v.y * b.drag - b.gravity;
  }
  return best;
}

describe("projectile intercept", () => {
  const origin = { x: 0, y: 65.52, z: 0 };
  const snowball = PROJECTILES.snowball;

  it("hits a stationary target with the lower arc", () => {
    const target = { x: 3, y: 64.6, z: 7.5 };
    const r = solveIntercept(snowball, origin, target, { x: 0, y: 0, z: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.yaw).toBeCloseTo(yawTo(origin, target), 6);
    // Lower solution: a flat throw at 8 blocks, not a lob.
    expect(Math.abs(r.pitch)).toBeLessThan(15);
    expect(r.ticks).toBeGreaterThan(5);
    expect(r.ticks).toBeLessThan(7);
    expect(closestApproach(snowball, origin, r.yaw, r.pitch, () => target)).toBeLessThan(0.05);
  });

  it("leads a moving target so both arrive at the same point", () => {
    const start = { x: 0, y: 64.6, z: 8 };
    const velocity = { x: 0.1, y: 0, z: 0 }; // 2 blocks per second sideways
    const lead = 3;
    const r = solveIntercept(snowball, origin, start, velocity, lead);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Aims ahead of the target: it walks towards -yaw (+X), so the yaw is negative.
    expect(r.yaw).toBeLessThan(yawTo(origin, start) - 2);
    expect(r.aim.x).toBeCloseTo(0.1 * (lead + r.ticks), 6);
    const at = (t: number) => ({ x: start.x + velocity.x * (lead + t), y: start.y, z: start.z + velocity.z * (lead + t) });
    expect(closestApproach(snowball, origin, r.yaw, r.pitch, at)).toBeLessThan(0.05);
    // Aiming where the target is now would miss by about its travel during the flight.
    const naive = solveIntercept(snowball, origin, at(0), { x: 0, y: 0, z: 0 });
    if (!naive.ok) throw new Error(naive.message);
    expect(closestApproach(snowball, origin, naive.yaw, naive.pitch, at)).toBeGreaterThan(0.4);
  });

  it("hits uphill and with an arrow's faster, heavier flight", () => {
    const target = { x: -10, y: 70, z: 12 };
    const r = solveIntercept(PROJECTILES.arrow, origin, target, { x: 0, y: 0, z: 0 });
    if (!r.ok) throw new Error(r.message);
    expect(r.pitch).toBeLessThan(0);
    expect(closestApproach(PROJECTILES.arrow, origin, r.yaw, r.pitch, () => target)).toBeLessThan(0.05);
  });

  it("says clearly when no launch angle reaches the target", () => {
    const r = solveIntercept(snowball, origin, { x: 0, y: 64, z: 120 }, { x: 0, y: 0, z: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/out of range: 120\.0 blocks away/);
    expect(r.message).toMatch(/snowball/);
    // A target running away faster than the drag-limited snowball can follow is out of range too.
    expect(solveIntercept(snowball, origin, { x: 0, y: 64, z: 10 }, { x: 0, y: 0, z: 2 }).ok).toBe(false);
  });

  it("models drag and gravity per tick", () => {
    // Flat throw: after one tick it has moved the full launch speed and not yet fallen.
    expect(flightTo(snowball, 0, 1.5)).toEqual({ height: 0, ticks: 1 });
    // Second tick: speed 1.485 after drag, falling 0.03.
    const f = flightTo(snowball, 0, 1.5 + 1.485);
    expect(f?.ticks).toBeCloseTo(2, 9);
    expect(f?.height).toBeCloseTo(-0.03, 9);
  });

  it("estimates velocity from noisy timestamped samples and picks the projectile from the held item", () => {
    const samples = [0, 2, 4, 6, 8].map((tick, i) => ({ tick, location: { x: 1 + 0.05 * tick + (i % 2 ? 0.01 : -0.01), y: 64, z: 2 - 0.02 * tick } }));
    const v = estimateVelocity(samples);
    expect(v.x).toBeCloseTo(0.05, 2);
    expect(v.z).toBeCloseTo(-0.02, 3);
    expect(estimateVelocity(samples.slice(0, 1))).toEqual({ x: 0, y: 0, z: 0 });
    expect(projectileFor("minecraft:bow")).toBe("arrow");
    expect(projectileFor("minecraft:snowball")).toBe("snowball");
    expect(projectileFor("minecraft:stick")).toBeUndefined();
  });
});

/**
 * A fake game: mouse motion turns the view at `degPerPx`, WASD walk relative to the yaw. With `latencyMs`, the
 * state streams like the helper's (every 50 ms tick) and shows the game `latencyMs` before it arrives. With `engine`,
 * the world also has the agent's input route: absolute views, an analog movement vector and attacks that strike
 * whatever entity lies within 8 degrees of the view and 3 blocks; `failAfter` makes it fail from that call on.
 */
function fakeWorld(
  degPerPx: number,
  opts: { blocked?: boolean; latencyMs?: number; entities?: EntityInfo[]; engine?: { failAfter?: number; prepareFails?: boolean; noTick?: boolean; noKeys?: boolean } } = {},
) {
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
  const held = new Set<string>();
  const pressed = new Set<string>();
  const clicks: number[] = [];
  const history: { at: number; state: PlayerState }[] = [];
  const steps: number[] = [];
  let last = Date.now();
  const engineLog: { method: string; params: unknown; at: number }[] = [];
  let engineMove: MoveVector | undefined;
  /** Move for the time since the last event, with the keys held during it. */
  const advance = () => {
    const now = Date.now();
    const f = engineMove ? engineMove.forward : (held.has("w") ? 1 : 0) - (held.has("s") ? 1 : 0);
    const r = engineMove ? engineMove.strafe : (held.has("d") ? 1 : 0) - (held.has("a") ? 1 : 0);
    if ((f || r) && !opts.blocked) {
      const step = (4.3 * (now - last)) / 1000 / Math.max(1, Math.hypot(f, r));
      const yaw = (s.rotation.y * Math.PI) / 180;
      // Forward is (-sin, cos), right is (-cos, -sin) in Bedrock's yaw.
      s.location = { x: s.location.x + (-Math.sin(yaw) * f - Math.cos(yaw) * r) * step, y: 0, z: s.location.z + (Math.cos(yaw) * f - Math.sin(yaw) * r) * step };
    }
    last = now;
    history.push({ at: now, state: structuredClone(s) });
    while (history.length > 2 && (history[1]?.at ?? now) < now - 1000) history.shift();
  };
  const input: PlayerInput = {
    keyDown: async (k) => {
      advance();
      held.add(k);
      pressed.add(k);
    },
    keyUp: async (k) => {
      advance();
      held.delete(k);
    },
    look: async (dx, dy) => {
      advance();
      steps.push(Math.hypot(Math.round(dx) * degPerPx, Math.round(dy) * degPerPx));
      s.rotation.y = ((s.rotation.y + Math.round(dx) * degPerPx + 540) % 360) - 180;
      s.rotation.x = Math.max(-90, Math.min(90, s.rotation.x + Math.round(dy) * degPerPx));
      advance();
    },
    button: async (b, down) => {
      if (b === 1 && down) clicks.push(Date.now());
    },
  };
  /** The state as the stream shows it: one per 50 ms tick, `latencyMs` old when it arrives. */
  const streamed = () => {
    advance();
    const latency = opts.latencyMs ?? 0;
    const at = Math.floor(Date.now() / 50) * 50;
    const seen = [...history].reverse().find((h) => h.at <= at - latency) ?? history[0];
    return { at, state: structuredClone(seen?.state ?? s) };
  };
  let calls = 0;
  /** One engine call: logged, and failing once `failAfter` calls were made. */
  const call = (method: string, params: unknown) => {
    advance();
    engineLog.push({ method, params, at: Date.now() });
    if (opts.engine?.failAfter !== undefined && ++calls > opts.engine.failAfter) throw new Error("disconnected: agent closed the connection");
  };
  const engine: EngineInput | undefined = opts.engine && {
    prepare: async () => {
      if (opts.engine?.prepareFails) throw new Error("not_attached: no agent is listening");
      if (opts.engine?.noTick) throw new Error("the agent accepted stream.subscribe but sent no tick notification within 1.5 s");
      s.source = "engine";
    },
    reachable: async () => !opts.engine?.prepareFails,
    look: async (pitch, yaw) => {
      call("look", { pitch, yaw });
      s.rotation = { x: pitch, y: yaw };
      advance();
    },
    move: async (m) => {
      call("move", m);
      engineMove = { ...m };
    },
    release: async () => {
      call("release", {});
      engineMove = undefined;
    },
    attack: async () => {
      call("attack", {});
      const eye = { ...s.location, y: s.location.y + 1.62 };
      const hit = opts.entities?.find((e) => {
        const centre = { ...e.location, y: e.location.y + 0.8 };
        const off = Math.hypot(angleDiff(s.rotation.y, yawTo(eye, centre)), s.rotation.x - pitchTo(eye, centre));
        return off < 8 && Math.hypot(centre.x - eye.x, centre.y - eye.y, centre.z - eye.z) <= 3;
      });
      return hit?.id ?? null;
    },
    use: async (down) => {
      call("use", { down });
    },
    // The game's keyboard: a digit key picks that hotbar slot.
    ...(opts.engine.noKeys
      ? {}
      : {
          key: async (key: string, down: boolean) => {
            call("key", { key, down });
            if (down && /^[1-9]$/.test(key)) s.selectedSlot = Number(key);
          },
        }),
  };
  const world: PlayerWorld = {
    input,
    state: async () => (opts.latencyMs === undefined ? (advance(), structuredClone(s)) : streamed().state),
    ...(opts.latencyMs === undefined ? {} : { sample: streamed }),
    ...(engine ? { engine } : {}),
    entity: async (id) => opts.entities?.find((e) => e.id === id) ?? null,
    nearest: async () => opts.entities?.[0] ?? null,
    impacts: async () => ({ tick: 0, impacts: [] }),
  };
  return { world, held, pressed, steps, s, engineLog, clicks };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PlayerController", () => {
  it("turns to the requested view with a mouse sensitivity it has to learn", async () => {
    const { world, s } = fakeWorld(0.15);
    const pc = new PlayerController(world);
    expect(await pc.turnTo(-120, 30)).toBe(true);
    expect(Math.abs(angleDiff(s.rotation.y, -120))).toBeLessThanOrEqual(2);
    expect(Math.abs(s.rotation.x - 30)).toBeLessThanOrEqual(2);
    // The sensitivity is learned from the first state that shows the whole turn.
    await pc.camera.idle();
    expect(pc.yawCalibration.degPerPx).toBeCloseTo(0.15, 1);
  });

  it("carries the streamed position forward by the mouse route's latency, and leaves engine states alone", () => {
    const { world, s } = fakeWorld(0.26);
    const pc = new PlayerController(world);
    pc.camera.latencyMs = 200;
    const walking = { ...s, location: { x: 1, y: 64, z: 2 }, velocity: { x: 0.2, y: -0.08, z: -0.1 } };
    // 200 ms is 4 ticks: x + 0.8, z - 0.4, the height as streamed.
    const now = pc.camera.present(walking).location;
    expect(now.x).toBeCloseTo(1.8);
    expect(now.y).toBe(64);
    expect(now.z).toBeCloseTo(1.6);
    expect(pc.camera.present({ ...walking, source: "engine" }).location).toEqual(walking.location);
  });

  it("turns smoothly in small steps, closing the loop over a lagging state stream", async () => {
    // On fake time: frames come every 1/120 s exactly, as they do on a quiet desktop. On real time a loaded runner
    // or Windows' 15.6 ms timer tick stretches frames, and each step covers more of the curve.
    vi.useFakeTimers();
    const { world, s, steps } = fakeWorld(0.26, { latencyMs: 60 });
    const pc = new PlayerController(world, { clock: fakeClock, random: seededRandom(1) });
    expect(await drive(pc.turnTo(90, -20))).toBe(true);
    // turnTo accepts 2°, and a step still in flight when it returns can add a fraction of a degree of hand jitter.
    expect(Math.abs(angleDiff(s.rotation.y, 90))).toBeLessThanOrEqual(3);
    expect(Math.abs(s.rotation.x + 20)).toBeLessThanOrEqual(3);
    // Many small steps (about 120 per second), none of them a jump.
    expect(steps.length).toBeGreaterThan(20);
    expect(Math.max(...steps)).toBeLessThan(6);
  });

  it("walks to a target and releases the forward key", async () => {
    const { world, held, s } = fakeWorld(0.26);
    const pc = new PlayerController(world);
    const r = await pc.moveTo({ x: -3, z: 3 }, 0.7, false, 10_000);
    expect(r.ok).toBe(true);
    expect(Math.hypot(s.location.x + 3, s.location.z - 3)).toBeLessThanOrEqual(0.7);
    expect(held.size).toBe(0);
  });

  it("walks while keeping the crosshair on an entity off to the side, strafing", async () => {
    const cow: EntityInfo = { id: "cow", typeId: "minecraft:cow", location: { x: 6, y: 0, z: 4 }, health: { current: 10, max: 10 } };
    const { world, held, pressed, s } = fakeWorld(0.26, { latencyMs: 40, entities: [cow] });
    const pc = new PlayerController(world);
    const r = await pc.moveTo({ x: 0, z: 6 }, 0.7, false, 10_000, { look: "cow" });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/looking at cow/);
    expect(Math.hypot(s.location.x, s.location.z - 6)).toBeLessThanOrEqual(0.7);
    const eye = { ...s.location, y: 1.62 };
    expect(Math.abs(angleDiff(s.rotation.y, yawTo(eye, cow.location)))).toBeLessThan(8);
    expect(pressed.has("a") || pressed.has("d")).toBe(true);
    expect(held.size).toBe(0);
  });

  it("stops a long action at once when its signal aborts, with nothing left held", async () => {
    const { world, held } = fakeWorld(0.26);
    const pc = new PlayerController(world);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const started = Date.now();
    const r = await pc.run({ action: "hold", keys: ["w"], ms: 10_000 }, ac.signal);
    expect(r).toMatchObject({ ok: false, message: "cancelled" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(held.size).toBe(0);
    const turn = new AbortController();
    setTimeout(() => turn.abort(), 50);
    expect(await pc.run({ action: "look_at", yaw: 170, pitch: 40 }, turn.signal)).toMatchObject({ ok: false, message: "cancelled" });
  });

  it("walks to a target and releases the forward key", async () => {
    const { world, held, s } = fakeWorld(0.26);
    const pc = new PlayerController(world);
    const r = await pc.moveTo({ x: -3, z: 3 }, 0.7, false, 10_000);
    expect(r.ok).toBe(true);
    expect(Math.hypot(s.location.x + 3, s.location.z - 3)).toBeLessThanOrEqual(0.7);
    expect(held.size).toBe(0);
  });

  it("gives up when the player cannot make progress, with no key left held", async () => {
    const { world, held } = fakeWorld(0.26, { blocked: true });
    const pc = new PlayerController(world);
    const r = await pc.moveTo({ x: 0, z: 10 }, 0.7, false, 10_000);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/stuck/);
    expect(held.size).toBe(0);
  });
});

describe("PlayerController on the engine route", () => {
  it("picks the engine when the world has one that answers, the keyboard otherwise", async () => {
    expect(await new PlayerController(fakeWorld(0.26, { engine: {} }).world).selectInput()).toBe("engine");
    expect(await new PlayerController(fakeWorld(0.26).world).selectInput()).toBe("keyboard");
    const down = new PlayerController(fakeWorld(0.26, { engine: { prepareFails: true } }).world);
    expect(await down.selectInput("auto")).toBe("keyboard");
    expect(down.inputNote).toMatch(/engine route not used: not_attached/);
    await expect(down.selectInput("engine")).rejects.toThrow(/engine input is not available: not_attached/);
    await expect(new PlayerController(fakeWorld(0.26).world).selectInput("engine")).rejects.toThrow(/no in-process input provider/);
  });

  it("keeps auto on the engine when the agent answers but its tick stream has not started yet", async () => {
    const pc = new PlayerController(fakeWorld(0.26, { engine: { noTick: true } }).world);
    expect(await pc.selectInput("auto")).toBe("engine");
    expect(pc.input).toBe("engine");
    expect(pc.inputNote).toMatch(/tick stream not ready/);
    await expect(pc.selectInput("engine")).rejects.toThrow(/no tick notification/);
  });

  it("turns with absolute views every frame along the same smooth curve, without moving the mouse", async () => {
    // On fake time, like the mouse turn above: the step bound is about the curve, not the runner's timer tick.
    vi.useFakeTimers();
    const { world, s, steps, engineLog } = fakeWorld(0.26, { latencyMs: 20, engine: {} });
    const pc = new PlayerController(world, { clock: fakeClock, random: seededRandom(1) });
    expect(await drive(pc.selectInput())).toBe("engine");
    const started = Date.now();
    const r = await drive(pc.run({ action: "look_at", yaw: 90, pitch: -20 }));
    const took = Date.now() - started;
    expect(r).toMatchObject({ ok: true, input: "engine" });
    expect(Math.abs(angleDiff(s.rotation.y, 90))).toBeLessThanOrEqual(2);
    expect(Math.abs(s.rotation.x + 20)).toBeLessThanOrEqual(2);
    expect(steps).toHaveLength(0);
    // Human speed (Fitts' law), not a snap: many absolute views, each a small step from the one before.
    expect(took).toBeGreaterThanOrEqual(150);
    expect(took).toBeLessThan(1500);
    const looks = engineLog.filter((e) => e.method === "look").map((e) => e.params as { pitch: number; yaw: number });
    expect(looks.length).toBeGreaterThan(15);
    let prev = { pitch: 0, yaw: 0 };
    for (const l of looks) {
      expect(Math.hypot(angleDiff(prev.yaw, l.yaw), l.pitch - prev.pitch)).toBeLessThan(6);
      prev = l;
    }
  });

  it("walks with an analog movement vector held through the engine and swings only for real hits", async () => {
    const zombie: EntityInfo = { id: "-77", typeId: "minecraft:zombie", location: { x: 4, y: 0, z: 6 }, health: { current: 20, max: 20 } };
    const { world, s, pressed, engineLog, clicks } = fakeWorld(0.26, { latencyMs: 20, engine: {}, entities: [zombie] });
    const pc = new PlayerController(world);
    await pc.selectInput();
    const walked = await pc.run({ action: "move_to", x: 0, z: 3 });
    expect(walked).toMatchObject({ ok: true, input: "engine" });
    expect(Math.hypot(s.location.x, s.location.z - 3)).toBeLessThanOrEqual(0.7);
    const moves = engineLog.filter((e) => e.method === "move").map((e) => e.params as MoveVector);
    expect(moves.some((m) => m.forward > 0.9)).toBe(true);
    // The walk ends standing still.
    expect(moves.at(-1)).toMatchObject({ forward: 0, strafe: 0 });
    const hit = await pc.run({ action: "attack", entity: "-77", hits: 2, timeoutMs: 8000 });
    expect(hit).toMatchObject({ ok: true, input: "engine" });
    expect(hit.message).toMatch(/hit zombie 2 time\(s\)/);
    expect(engineLog.filter((e) => e.method === "attack").length).toBeGreaterThanOrEqual(2);
    expect(clicks).toEqual([]);
    expect(pressed.size).toBe(0);
  });

  it("lets go and finishes with the keyboard when the engine fails mid-action, and says so", async () => {
    const { world, s, steps, engineLog } = fakeWorld(0.26, { latencyMs: 20, engine: { failAfter: 5 } });
    const pc = new PlayerController(world);
    await pc.selectInput();
    const r = await pc.run({ action: "look_at", yaw: -120, pitch: 30 });
    expect(r).toMatchObject({ ok: true, input: "keyboard" });
    expect(r.message).toMatch(/engine input failed \(disconnected: agent closed the connection\), finished with keyboard input/);
    // turnTo accepts 2°, and a step still in flight when it returns can add a fraction of a degree of hand jitter.
    expect(Math.abs(angleDiff(s.rotation.y, -120))).toBeLessThanOrEqual(3);
    expect(steps.length).toBeGreaterThan(0);
    expect(engineLog.filter((e) => e.method === "look").length).toBe(6);
    expect(pc.input).toBe("keyboard");
    // The next action stays on the keyboard until the route is picked again.
    expect(await pc.run({ action: "look_at", yaw: -100, pitch: 30 })).toMatchObject({ ok: true, input: "keyboard" });
  });
  it("drives a game without a keyboard route (a Linux desktop window) on the engine alone", async () => {
    const reason = "player control needs window or off-screen mode on Linux (game_launch with display: window or headless), or Windows";
    const game = (engine: { failAfter?: number; prepareFails?: boolean }) => {
      const fake = fakeWorld(0.26, { latencyMs: 20, engine });
      return { ...fake, world: { ...fake.world, input: unavailableInput(reason) } };
    };
    const { world, s } = game({});
    const pc = new PlayerController(world);
    expect(await pc.selectInput("auto")).toBe("engine");
    expect(await pc.run({ action: "look_at", yaw: 60, pitch: 10 })).toMatchObject({ ok: true, input: "engine" });
    expect(Math.abs(angleDiff(s.rotation.y, 60))).toBeLessThanOrEqual(2);
    await expect(pc.selectInput("keyboard")).rejects.toThrow(reason);
    // An agent that does not answer leaves no route at all.
    await expect(new PlayerController(game({ prepareFails: true }).world).selectInput("auto")).rejects.toThrow(
      `engine input is not available (not_attached: no agent is listening), and the keyboard route is unavailable: ${reason}`,
    );
    // An engine failure mid-action fails the action instead of redoing it on a keyboard that is not there.
    const failing = new PlayerController(game({ failAfter: 5 }).world);
    await failing.selectInput();
    const r = await failing.run({ action: "look_at", yaw: -120, pitch: 30 });
    expect(r).toMatchObject({ ok: false, input: "engine" });
    expect(r.message).toBe(`engine input failed (disconnected: agent closed the connection), and the keyboard route is unavailable: ${reason}`);
    await failing.releaseAll();
  });

  it("picks hotbar slots and holds keys through the provider's game keyboard when there is no keyboard route", async () => {
    const reason = "player control needs window or off-screen mode on Linux (game_launch with display: window or headless), or Windows";
    const game = (engine: { noKeys?: boolean }) => {
      const fake = fakeWorld(0.26, { latencyMs: 20, engine });
      return { ...fake, world: { ...fake.world, input: unavailableInput(reason) } };
    };
    const { world, s, engineLog } = game({});
    const pc = new PlayerController(world);
    expect(await pc.selectInput("auto")).toBe("engine");

    const picked = await pc.run({ action: "select_slot", slot: 3 });
    expect(picked).toMatchObject({ ok: true, input: "engine" });
    expect(s.selectedSlot).toBe(3);
    const keys = () => engineLog.filter((e) => e.method === "key").map((e) => e.params);
    expect(keys()).toEqual([{ key: "3", down: true }, { key: "3", down: false }]);
    // The skills' hands use the same key.
    expect(await pc.hands.selectSlot(5)).toBe(true);
    expect(s.selectedSlot).toBe(5);

    // Movement keys become the held movement vector; the others go to the game's keyboard, and all are let go after.
    engineLog.length = 0;
    const held = await pc.run({ action: "hold", keys: ["w", "Control_L", "e"], ms: 300 });
    expect(held).toMatchObject({ ok: true, input: "engine" });
    expect(Math.hypot(s.location.x, s.location.z)).toBeGreaterThan(0.5);
    const moves = engineLog.filter((e) => e.method === "move").map((e) => e.params as MoveVector);
    expect(moves[0]).toMatchObject({ forward: 1, strafe: 0, sprint: true });
    expect(moves.at(-1)).toMatchObject({ forward: 0, sprint: false });
    expect(keys()).toEqual([{ key: "e", down: true }, { key: "e", down: false }]);

    // The agent's attack is one click, so a held attack needs the keyboard route's mouse.
    const mined = await pc.run({ action: "mine", holdMs: 100 });
    expect(mined).toMatchObject({ ok: false, input: "engine" });
    expect(mined.message).toBe(`mine holds the attack button, which the engine route cannot hold (input.attack is one click), and the keyboard route is unavailable: ${reason}`);

    // A provider that takes no keys leaves the hotbar to the keyboard route, which is not there.
    const keyless = new PlayerController(game({ noKeys: true }).world);
    await keyless.selectInput();
    const r = await keyless.run({ action: "select_slot", slot: 2 });
    expect(r).toMatchObject({ ok: false, input: "engine" });
    expect(r.message).toBe(reason);
    await keyless.releaseAll();
  });

  it("lets go of a key held through the provider when the action is cancelled", async () => {
    const { world, engineLog } = fakeWorld(0.26, { latencyMs: 20, engine: {} });
    const ac = new AbortController();
    const engine = world.engine!;
    // Cancelled as soon as the key is down, while the hold waits.
    const key = engine.key!;
    const pc = new PlayerController({
      ...world,
      engine: {
        ...engine,
        key: async (k, down) => {
          await key(k, down);
          if (down) ac.abort();
        },
      },
    });
    await pc.selectInput();
    const r = await pc.run({ action: "hold", keys: ["q"], ms: 5000 }, ac.signal);
    expect(r).toMatchObject({ ok: false, message: "cancelled" });
    expect(engineLog.filter((e) => e.method === "key").map((e) => e.params)).toEqual([{ key: "q", down: true }, { key: "q", down: false }]);
  });
});
