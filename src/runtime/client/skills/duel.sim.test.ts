/**
 * A small kinematic game in real time (50 ms ticks) for the fight loop: the player walks at Bedrock speeds from the
 * held movement, mobs chase, hits knock back, a creeper lights its fuse within 3 blocks, puts it out past 7 and
 * blows after 1.5 s (the distances measured in the game; a raised shield facing it blocks the blast), and like the
 * game's helper it never reports the fuse, a zombie hits once a second when its box reach
 * overlaps the player (centre gap under 1.4 on both x and z, as `melee_box_attack` does). It
 * checks that the footwork keeps the player out of trouble, not the exact numbers the real game gives. It runs on
 * fake time (`src/testing/faketime.ts`): the game's ticks, the controller's clock and timers and `Date.now()` all advance
 * together, so a fight plays out the same on a loaded CI runner as on a quiet desktop, and a seeded hand jitter makes
 * it repeat run to run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drive, fakeClock, seededRandom } from "../../../testing/faketime.ts";
import type { PlayerInput } from "../launcher.ts";
import { angleDiff, PlayerController, STILL, yawTo, type EngineInput, type EntityInfo, type MoveVector, type PlayerState, type PlayerWorld } from "../player.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const controller = (world: PlayerWorld) => new PlayerController(world, { clock: fakeClock, random: seededRandom(7) });

interface SimMob {
  id: string;
  typeId: string;
  x: number;
  z: number;
  health: number;
  speed: number;
  /** Knockback still to apply, blocks per tick. */
  kx: number;
  kz: number;
  /** Last tick's movement, blocks per tick (reported as the velocity). */
  vx: number;
  vz: number;
  hurtUntil: number;
  litAt?: number;
  lastAttack: number;
}

interface Sim {
  world: PlayerWorld;
  log: { blast: number; meleeDamage: number; exploded: number; swings: number; hits: number };
  stop(): void;
}

/**
 * `keyboardLagTicks` drives the player through keys, relative mouse pixels and clicks instead of the engine: the view
 * turns at once in the client, but the streamed state (position, rotation, crosshair) is that many ticks old, as the
 * helper's stream is.
 * `reportFuse` reports every creeper's fuse as the helper's entity events do (lit or not, and the ticks it burned).
 */
function sim(mobs: SimMob[], keyboardLagTicks?: number, reportFuse = false): Sim {
  const p = { x: 0, z: 0, vx: 0, vz: 0, yaw: 0, pitch: 0, health: 20, move: { ...STILL } as MoveVector };
  const log = { blast: 0, meleeDamage: 0, exploded: 0, swings: 0, hits: 0 };
  let tick = 0;
  const step = () => {
    tick++;
    const now = Date.now();
    // Player: Bedrock speeds in blocks per second.
    const len = Math.hypot(p.move.forward, p.move.strafe);
    p.vx = 0;
    p.vz = 0;
    if (len > 0.01) {
      const speed = p.move.sneak ? 1.3 : p.move.sprint && p.move.forward > 0.5 ? 5.6 : 4.3;
      const heading = p.yaw + (Math.atan2(p.move.strafe, p.move.forward) * 180) / Math.PI;
      const r = (heading * Math.PI) / 180;
      p.vx = (-Math.sin(r) * speed * Math.min(1, len)) / 20;
      p.vz = (Math.cos(r) * speed * Math.min(1, len)) / 20;
      p.x += p.vx;
      p.z += p.vz;
    }
    for (const m of [...mobs]) {
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      const lit = m.litAt !== undefined;
      // A swelling creeper stands still (the swell goal holds its movement).
      const sp = m.typeId === "minecraft:creeper" && lit ? 0 : m.speed;
      const x0 = m.x;
      const z0 = m.z;
      if (d > 0.8) {
        m.x += ((p.x - m.x) / d) * (sp / 20);
        m.z += ((p.z - m.z) / d) * (sp / 20);
      }
      m.x += m.kx;
      m.z += m.kz;
      m.kx *= 0.6;
      m.kz *= 0.6;
      m.vx = m.x - x0;
      m.vz = m.z - z0;
      const dist = Math.hypot(p.x - m.x, p.z - m.z);
      if (m.typeId === "minecraft:creeper") {
        if (!lit && dist <= 3) m.litAt = now;
        else if (lit && dist > 7) delete m.litAt;
        if (m.litAt !== undefined && now - m.litAt >= 1500) {
          mobs.splice(mobs.indexOf(m), 1);
          log.exploded++;
          const facing = Math.abs(angleDiff(p.yaw, yawTo({ x: p.x, y: 0, z: p.z }, { x: m.x, y: 0, z: m.z }))) < 60;
          if (dist < 6 && !(p.move.sneak && facing)) {
            const dmg = Math.round((1 - dist / 6) * 25 * 10) / 10;
            log.blast += dmg;
            p.health -= dmg;
          }
        }
      } else if (Math.max(Math.abs(p.x - m.x), Math.abs(p.z - m.z)) < 1.4 && now - m.lastAttack >= 1000) {
        m.lastAttack = now;
        const facing = Math.abs(angleDiff(p.yaw, yawTo({ x: p.x, y: 0, z: p.z }, { x: m.x, y: 0, z: m.z }))) < 60;
        if (!(p.move.sneak && facing)) {
          p.health -= 2;
          log.meleeDamage += 2;
        }
      }
    }
    history.push(state());
    while (history.length > 20) history.shift();
  };
  const history: PlayerState[] = [];
  const timer = setInterval(step, 50);
  const aimed = (): SimMob | undefined =>
    mobs
      .filter((m) => Math.abs(angleDiff(p.yaw, yawTo({ x: p.x, y: 0, z: p.z }, { x: m.x, y: 0, z: m.z }))) < 15)
      .sort((a, b) => Math.hypot(p.x - a.x, p.z - a.z) - Math.hypot(p.x - b.x, p.z - b.z))[0];
  const info = (m: SimMob): EntityInfo => ({
    id: m.id,
    typeId: m.typeId,
    location: { x: m.x, y: 0, z: m.z },
    health: { current: m.health, max: 20 },
    tick,
    velocity: { x: m.vx, y: 0, z: m.vz },
    ...(reportFuse && m.typeId === "minecraft:creeper" ? { ignited: m.litAt !== undefined, ...(m.litAt !== undefined ? { fuseTicks: Math.floor((Date.now() - m.litAt) / 50) } : {}) } : {}),
  });
  const state = (): PlayerState => {
    const a = aimed();
    return {
      tick,
      name: "p",
      location: { x: p.x, y: 0, z: p.z },
      velocity: { x: p.vx, y: 0, z: p.vz },
      rotation: { x: p.pitch, y: p.yaw },
      dimension: "minecraft:overworld",
      onGround: true,
      sneaking: p.move.sneak,
      sprinting: p.move.sprint,
      gameMode: "survival",
      selectedSlot: 1,
      health: p.health,
      holding: { typeId: "minecraft:iron_sword", amount: 1 },
      ...(a ? { lookingAtEntity: { id: a.id, typeId: a.typeId, distance: Math.max(0, Math.hypot(p.x - a.x, p.z - a.z) - 0.3) } } : {}),
    };
  };
  const engine: EngineInput = {
    prepare: async () => {},
    reachable: async () => true,
    look: async (pitch, yaw) => {
      p.pitch = pitch;
      p.yaw = yaw;
    },
    move: async (m) => {
      p.move = { ...m };
    },
    release: async () => {
      p.move = { ...STILL };
    },
    attack: async () => strike(),
    use: async () => {},
  };
  /** One attack click with the client's view now. */
  const strike = (): string | null => {
    log.swings++;
    const m = aimed();
    if (!m || Math.hypot(p.x - m.x, p.z - m.z) > 3.3 || Date.now() < m.hurtUntil) return null;
    log.hits++;
    m.health -= 6;
    m.hurtUntil = Date.now() + 500;
    const d = Math.max(0.1, Math.hypot(m.x - p.x, m.z - p.z));
    const k = p.move.sprint ? 0.9 : 0.45;
    m.kx = ((m.x - p.x) / d) * k;
    m.kz = ((m.z - p.z) / d) * k;
    if (m.health <= 0) mobs.splice(mobs.indexOf(m), 1);
    return m.id;
  };
  // Bedrock's default keys, held as the keyboard backend presses them.
  const held = new Set<string>();
  const keys = () => {
    const forward = (held.has("w") ? 1 : 0) - (held.has("s") ? 1 : 0);
    const strafe = (held.has("d") ? 1 : 0) - (held.has("a") ? 1 : 0);
    const len = Math.hypot(forward, strafe) || 1;
    p.move = { ...STILL, forward: forward / len, strafe: strafe / len, sprint: held.has("Control_L"), sneak: held.has("Shift_L"), jump: held.has("space") };
  };
  const input: PlayerInput = {
    keyDown: async (k) => {
      held.add(k);
      keys();
    },
    keyUp: async (k) => {
      held.delete(k);
      keys();
    },
    look: async (dx, dy) => {
      p.yaw = angleDiff(0, p.yaw + dx * 0.26);
      p.pitch = Math.max(-90, Math.min(90, p.pitch + dy * 0.26));
    },
    button: async (b, down) => {
      if (b === 1 && down) strike();
    },
  };
  const world: PlayerWorld = {
    input,
    ...(keyboardLagTicks === undefined ? { engine, sample: () => ({ at: Date.now(), state: state() }) } : {}),
    state: async () => (keyboardLagTicks === undefined ? state() : (history[Math.max(0, history.length - 1 - keyboardLagTicks)] ?? state())),
    entity: async (id) => {
      const m = mobs.find((x) => x.id === id);
      return m ? info(m) : null;
    },
    nearest: async () => (mobs[0] ? info(mobs[0]) : null),
    impacts: async () => ({ tick, impacts: [] }),
    entities: async () => mobs.map(info),
    loadout: async () => ({ hotbar: [{ typeId: "minecraft:iron_sword", amount: 1 }], hunger: 20, armor: [{ slot: "Offhand", typeId: "minecraft:shield" }] }),
  };
  return { world, log, stop: () => clearInterval(timer) };
}

const mob = (id: string, typeId: string, x: number, z: number, speed: number): SimMob => ({ id, typeId, x, z, health: 20, speed, kx: 0, kz: 0, vx: 0, vz: 0, hurtUntil: 0, lastAttack: 0 });

describe("fight loop in a kinematic game", () => {
  let game: Sim | undefined;
  afterEach(() => game?.stop());

  it("kills a creeper without letting it blow up next to the player", async () => {
    game = sim([mob("-1", "minecraft:creeper", 0, 8, 2.5)]);
    const pc = controller(game.world);
    expect(await drive(pc.selectInput("engine"))).toBe("engine");
    const r = await drive(pc.run({ action: "fight", target: "-1", timeoutMs: 15_000 }));
    expect(r.message).toMatch(/killed creeper/);
    expect(game.log.blast).toBe(0);
  }, 20_000);

  it("gets away from or shields against a creeper that starts inside its fuse range", async () => {
    game = sim([mob("-6", "minecraft:creeper", 0, 2.2, 2.5)]);
    const pc = controller(game.world);
    await drive(pc.selectInput("engine"));
    await drive(pc.run({ action: "fight", target: "-6", timeoutMs: 12_000 }));
    expect(game.log.blast).toBe(0);
  }, 20_000);

  it("kills a zombie hitting and stepping back, taking few hits", async () => {
    game = sim([mob("-2", "minecraft:zombie", 0, 8, 2.3)]);
    const pc = controller(game.world);
    await drive(pc.selectInput("engine"));
    const r = await drive(pc.run({ action: "fight", target: "-2", crits: false, timeoutMs: 15_000 }));
    expect(r.message).toMatch(/killed zombie/);
    expect(game.log.meleeDamage).toBeLessThanOrEqual(4);
  }, 20_000);

  it("clears three zombies with health to spare", async () => {
    const zombies = [mob("-3", "minecraft:zombie", -3, 9, 2.3), mob("-4", "minecraft:zombie", 0, 10, 2.3), mob("-5", "minecraft:zombie", 3, 9, 2.3)];
    game = sim(zombies);
    const pc = controller(game.world);
    await drive(pc.selectInput("engine"));
    await drive(pc.run({ action: "fight", crits: false, timeoutMs: 25_000 }));
    // A swing can strike a zombie next to the target, so the arena is the count, not the message.
    expect(zombies).toEqual([]);
    expect(game.log.meleeDamage).toBeLessThanOrEqual(10);
  }, 30_000);

  it("kills a creeper that comes with two zombies without letting it blow up", async () => {
    const mobs = [mob("-7", "minecraft:creeper", -2, 7, 2.7), mob("-8", "minecraft:zombie", -1, 8, 2.3), mob("-9", "minecraft:zombie", 2, 8, 2.3)];
    game = sim(mobs);
    const pc = controller(game.world);
    await drive(pc.selectInput("engine"));
    await drive(pc.run({ action: "fight", crits: false, timeoutMs: 25_000 }));
    expect(game.log.exploded).toBe(0);
    expect(mobs).toEqual([]);
  }, 30_000);

  it("handles the bench's mixed layout (creeper from the side, two zombies ahead) without a blast", async () => {
    const mobs = [mob("-10", "minecraft:zombie", -4, 10, 2.3), mob("-11", "minecraft:zombie", 4, 10, 2.3), mob("-12", "minecraft:creeper", -8, 6, 2.5)];
    game = sim(mobs);
    const pc = controller(game.world);
    await drive(pc.selectInput("engine"));
    await drive(pc.run({ action: "fight", crits: false, timeoutMs: 30_000 }));
    expect(game.log.exploded).toBe(0);
    expect(mobs).toEqual([]);
  }, 35_000);

  it("with the fuse reported: the mixed layout and a creeper starting inside its fuse range, no blast", async () => {
    const mobs = [mob("-13", "minecraft:zombie", -4, 10, 2.3), mob("-14", "minecraft:zombie", 4, 10, 2.3), mob("-15", "minecraft:creeper", -8, 6, 2.5)];
    game = sim(mobs, undefined, true);
    const pc = controller(game.world);
    await drive(pc.selectInput("engine"));
    await drive(pc.run({ action: "fight", crits: false, timeoutMs: 30_000 }));
    expect(game.log.exploded).toBe(0);
    expect(mobs).toEqual([]);
    game.stop();
    game = sim([mob("-16", "minecraft:creeper", 0, 2.2, 2.5)], undefined, true);
    const pc2 = controller(game.world);
    await drive(pc2.selectInput("engine"));
    await drive(pc2.run({ action: "fight", target: "-16", timeoutMs: 12_000 }));
    expect(game.log.blast).toBe(0);
  }, 50_000);
});

describe("fight loop on the keyboard route", () => {
  let game: Sim | undefined;
  afterEach(() => game?.stop());
  // The helper's stream as the bench measures it: position, rotation and crosshair about 200 ms old.
  const LAG_TICKS = 4;

  it("swings with the crosshair on a zombie and counts only the clicks its health shows", async () => {
    game = sim([mob("-20", "minecraft:zombie", 0, 8, 2.3)], LAG_TICKS);
    const pc = controller(game.world);
    expect(await drive(pc.selectInput("keyboard"))).toBe("keyboard");
    const r = await drive(pc.run({ action: "fight", target: "-20", crits: false, timeoutMs: 15_000 }));
    expect(r.message).toMatch(/killed zombie/);
    const counted = Number(/(\d+) hit\(s\)/.exec(r.message)?.[1]);
    expect(counted).toBe(game.log.hits);
    expect(game.log.meleeDamage).toBeLessThanOrEqual(6);
  }, 20_000);

  it("clears three zombies", async () => {
    const zombies = [mob("-21", "minecraft:zombie", -3, 9, 2.3), mob("-22", "minecraft:zombie", 0, 10, 2.3), mob("-23", "minecraft:zombie", 3, 9, 2.3)];
    game = sim(zombies, LAG_TICKS);
    const pc = controller(game.world);
    await drive(pc.selectInput("keyboard"));
    await drive(pc.run({ action: "fight", crits: false, timeoutMs: 25_000 }));
    expect(zombies).toEqual([]);
    expect(game.log.meleeDamage).toBeLessThanOrEqual(12);
  }, 30_000);

  it("kills a creeper without a blast", async () => {
    game = sim([mob("-24", "minecraft:creeper", 0, 8, 2.5)], LAG_TICKS);
    const pc = controller(game.world);
    await drive(pc.selectInput("keyboard"));
    const r = await drive(pc.run({ action: "fight", target: "-24", timeoutMs: 15_000 }));
    expect(r.message).toMatch(/killed creeper/);
    expect(game.log.blast).toBe(0);
  }, 20_000);
});
