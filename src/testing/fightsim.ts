/**
 * A small kinematic Bedrock game for the fight loop's tests, in 50 ms ticks on fake time (`src/testing/faketime.ts`):
 * the game's ticks, the controller's clock and timers and `Date.now()` all advance together, so a fight plays out the
 * same on a loaded CI runner as on a quiet desktop.
 *
 * What it reproduces, as measured on retail 1.26.63.1 (engine route, 2026-11-11):
 * - The player walks 4.32 blocks a second in every direction (backward too), sprints 5.61 forward, sneaks 1.29, and
 *   stands still `UNSNEAK_TICKS` after letting go of the sneak (read from live traces); on the ground it carries its
 *   motion (`GROUND_KEEP`), so a sprint let go coasts about 0.34 blocks;
 *   a jump rises 0.42 blocks a tick under the game's gravity (apex 1.25 after 6 ticks, down after 12) and keeps its
 *   take-off motion in the air: 7.06 sprint-jumping forward, 4.32 walking, 3.78 backward.
 * - Input reaches the server 2 ticks after it is sent (engine route; the keyboard's key 1 tick). The engine agent
 *   answers a move or a look after `ENGINE_CALL_MS` and an attack after `ENGINE_ATTACK_MS` (measured on retail with
 *   calls 25 ms apart: 57 ms for `input.move` and `input.look`, 6 ms median and 17 ms p90 for `input.attack`).
 * - A zombie or husk chases at its speed, attacks when its box reach covers the player (centre gap under 1.4 on both
 *   x and z, `melee_box_attack`) and then every 20 ticks while it does (30 after an attack the shield blocked), for
 *   `MOB_HIT` health on iron armor.
 * - A raised shield blocks a melee hit only when the server saw the player sneaking at least 6 ticks before it, and
 *   only from an attacker within 90 degrees of the view, and not within `shieldOpenTicks` (12) after a swing; each
 *   blocked hit adds one to `offhandDamage`.
 * - The attack click strikes the mob whose box the view ray meets, up to a centre distance of 3.0 (measured: 3.0
 *   struck, 3.1 did not), for 6.89 (iron sword;
 *   150 % falling, a critical hit), then the mob ignores hits for 10 ticks. Knockback is vanilla's (0.4 blocks a tick
 *   under ground friction, about 0.9 blocks, twice that for a sprint hit), and as live traces show it, 3 ticks late
 *   and weaker struck while sneaking. A hit taken throws the
 *   player about a block back and up.
 * - Mobs do not overlap each other or the player (pushed apart to 0.6 blocks), and a `pen` (block bounds) keeps
 *   everything inside it, reported to `clearRun` through the helper's `grid` query.
 * - A creeper lights within 3 blocks, goes out past 7 and blows after 1.5 s (a raised shield facing it blocks the
 *   blast); like the game's helper it reports the fuse only with `reportFuse`.
 */
import type { PlayerInput } from "../runtime/client/launcher.ts";
import { seededRandom } from "./faketime.ts";
import { angleDiff, STILL, yawTo, type EngineInput, type EntityInfo, type MoveVector, type PlayerState, type PlayerWorld } from "../runtime/client/player.ts";

export interface SimMob {
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
  /** A creeper: the box gap it lights its fuse at on this approach (`CREEPER_LIGHT_GAP` give or take the jitter). */
  lightAt?: number;
  /** Its last positions, oldest first: the readings show the first (`ENTITY_LAG_TICKS`). */
  trail?: { x: number; z: number }[];
  /** Its own walk, blocks per tick (it carries on a little after it stops). */
  wx?: number;
  wz?: number;
  /** A knockback that lands on this tick (`KNOCKBACK_DELAY_TICKS` after the hit), blocks per tick. */
  knockAt?: number;
  knockX?: number;
  knockZ?: number;
  /** When (fake clock ms) it can attack next. */
  nextAttack: number;
  /** The tick it died: it lies there (thrown back by the blow, not hittable) for the death animation. */
  diedAt?: number;
  /** The tick it is summoned (absent from the world before). */
  appearTick?: number;
}

/** Measured walking (any direction), sprinting, sneaking and in-air speeds, blocks per second. */
export const WALK = 4.32;
export const SPRINT = 5.61;
export const SNEAK = 1.29;
export const SPRINT_JUMP = 7.06;
export const BACK_JUMP = 3.78;
/** Iron sword on a husk or zombie, and a husk's hit on full iron armor. */
export const SWORD = 6.89;
export const MOB_HIT = 1.62;
/** Ticks from an input being sent to the server acting on it. */
export const ENGINE_INPUT_TICKS = 2;
/** The engine agent's answer to a move or a look, and to an attack (the pessimistic measured case). */
export const ENGINE_CALL_MS = 50;
export const ENGINE_ATTACK_MS = 10;
/** Ticks the server must have seen the sneak before a hit for the shield to block it. */
export const SHIELD_TICKS = 6;
export const SHIELD_ARC = 90;
/** A swing lowers the raised shield: an attack 12 ticks or less after it lands, 13 or more is blocked (measured). */
export const SWING_OPEN_TICKS = 12;
/**
 * Letting go of the sneak holds the feet still this many ticks. Read from the live `auto` traces of 2026-11-11 (bench
 * combat zombies3+husks3+cornered, engine route, median player speed over the first 100 / 200 / 300 / 400 ms of a
 * retreat): right after lowering the shield 0 / 0.05 / 0.81 / 1.5 blocks a second (about 300 retreats), without a
 * shield before 0.34 / 1.24 / 2.06 / 2.07 (about 320): the feet start some 4 ticks later after a sneak.
 */
export const UNSNEAK_TICKS = 4;
/**
 * Share of the player's ground motion kept from one tick to the next (the rest comes from the held input): vanilla's
 * ground friction (0.6 x 0.91). A sprint let go coasts about 0.34 blocks, on top of the 2 ticks the release takes to
 * reach the server (about 0.9 blocks after the stop is sent). It fits the live traces of 2026-11-11: a retreat from
 * standing averaged 1.24 blocks a second over its first 200 ms (the model: 1.25), and 170 ms after a strike at 2.99
 * with backward already sent, the sprint in had carried the player to 2.22 and 1.94 (the knockback 3 ticks late).
 */
export const GROUND_KEEP = 0.546;
/**
 * Mobs carry their walk too, with the same ground friction. Read from the live `mixed` trace of 2026-11-11: a creeper
 * that stopped to swell at 3.16 still read closing 1.45, 0.82, 0.45, 0.19 and 0 blocks a second over the next ticks.
 */
export const MOB_GROUND_KEEP = 0.546;
/**
 * Mob readings (`entity`, `entities`) show where a mob was this many ticks ago. Read from the live traces of
 * 2026-11-11 (two N=60 bench files, 41 hurts): the nearest mob 100 ms before a hurt read 1.6 to 2.5 blocks (median 2.0,
 * a quarter at 2.3 to 2.5), where its box reach is 1.4 to 1.98: a zombie closing at 2.3 blocks a second covers the
 * difference in about 2 ticks besides those 100 ms.
 */
export const ENTITY_LAG_TICKS = 2;
/**
 * A creeper lights its fuse when the gap between its box and the player's (both 0.6 wide) is under this (its data
 * value), give or take `CREEPER_LIGHT_JITTER` per approach, and then coasts to a stop. Along an axis that is a centre
 * distance of 3.1, on a diagonal about 3.35. Live (2026-11-11): along the z axis (bench `creeper`) it was struck at 2.92
 * to 2.99 still walking; from the side (`mixed`, spawned at -8, 6) it slowed at 3.2 to 3.3 and stood at 3.08 to 3.16.
 */
export const CREEPER_LIGHT_GAP = 2.5;
export const CREEPER_LIGHT_JITTER = 0.05;
/**
 * A skeleton walks up to `SKELETON_STAND`, shoots every `SKELETON_SHOT_MS` within `SKELETON_RANGE`, and an arrow hits
 * `ARROW_HIT_RATE` of the time for `ARROW_HIT` (vanilla-like, not measured; seeded so a run repeats).
 */
export const SKELETON_STAND = 8;
export const SKELETON_RANGE = 15;
export const SKELETON_SHOT_MS = 2500;
export const ARROW_HIT_RATE = 0.5;
export const ARROW_HIT = 2;
/**
 * While the view swings round, the feet push less: by the share the view turned in the tick out of this many degrees
 * (none at this or more). Fitted to the live turn-and-sprint escapes from a creeper of 2026-11-11 (player
 * displacement after the run starts: 0 at 200 ms, 0.25 at 400, 0.82 at 600, 1.54 at 800, 2.06 at 1000, 3.8 at 1400).
 */
export const TURN_PUSH_DEG = 20;
/**
 * A hit's knockback shows this many ticks after the swing's answer. Read from the live traces of 2026-11-11 (median
 * change of the struck mob's distance with the player standing, 50 ms bins after the hit, about 500 hits each): -0.14,
 * -0.23, -0.23 at 50 to 150 ms (still walking in), then +0.3 at 200 ms and +0.94 at 550 ms.
 */
export const KNOCKBACK_DELAY_TICKS = 3;
/**
 * Knockback of a hit struck while sneaking, as a share of a normal one. Read from the same traces: with the shield up
 * the struck mob was +0.57 at 400 ms and +0.79 at 550 ms, without +0.74 and +0.94.
 */
export const SNEAK_KNOCKBACK = 0.75;
/** A swing lands within this horizontal centre distance (measured: struck at 3.0, not at 3.1). */
const REACH = 3.0;
/** Ground friction on knockback, per tick. */
const KNOCK_DECAY = 0.546;
const EYE = 1.62;
const MOB_HEIGHT = 1.95;
const SPACING = 0.6;

/** One thing that happened in the sim, on its tick (ms on the fake clock). */
export interface SimEvent {
  at: number;
  kind: "hurt" | "block" | "hit" | "miss";
  mob?: string;
}

export interface SimLog {
  blast: number;
  meleeDamage: number;
  /** Melee hits the player took and blocked. */
  hitsTaken: number;
  /** Of the hits taken, the arrows that hit. */
  arrowHits: number;
  blocked: number;
  exploded: number;
  swings: number;
  hits: number;
  events: SimEvent[];
}

export interface Sim {
  world: PlayerWorld;
  log: SimLog;
  /** The player's position and whether it is sneaking as the server sees it. */
  player(): { x: number; z: number; sneak: boolean };
  stop(): void;
}

export interface SimOptions {
  /**
   * Drive the player through keys, relative mouse pixels and clicks instead of the engine: the view turns at once in
   * the client, but the streamed state (position, rotation, crosshair) is that many ticks old, as the helper's is.
   */
  keyboardLagTicks?: number;
  /** Report every creeper's fuse as the helper's entity events do (lit or not, and the ticks it burned). */
  reportFuse?: boolean;
  /** Keep a killed mob in the entity lists at health 0 that many ticks, as the game's death animation does. */
  deathTicks?: number;
  /** Interior block bounds (inclusive) nothing can leave; the helper's `grid` query reports the walls around. */
  pen?: { x0: number; x1: number; z0: number; z1: number };
  /** The player's start (default the origin, looking at +Z). */
  start?: { x: number; z: number; yaw?: number };
  /** Delay of the engine's answer to a move or a look (default `ENGINE_CALL_MS`) and to an attack (`ENGINE_ATTACK_MS`). */
  callMs?: number;
  attackMs?: number;
  /**
   * Share of swings that miss although the view ray meets the mob in reach (seeded, so a run repeats). Live on retail
   * half the swings missed with the aim within 10 degrees and the mob within 3 blocks, for a reason not known yet;
   * `LIVE_MISS_RATE` reproduces that.
   */
  missRate?: number;
  /** Ticks a hit's knockback shows after the swing (default `KNOCKBACK_DELAY_TICKS`). */
  knockbackDelayTicks?: number;
  /** Share of the ground motion kept per tick (default `GROUND_KEEP`; 0: the input sets the speed at once). */
  groundKeep?: number;
  /** Ticks old the mob readings are (default `ENTITY_LAG_TICKS`). */
  entityLagTicks?: number;
  /** Seed of the creepers' fuse distance rolls (default 17). */
  creeperSeed?: number;
  /** Seed of the missed-swing rolls (default 11). */
  missSeed?: number;
  /** Share of a mob's walk kept per tick (default `MOB_GROUND_KEEP`). */
  mobGroundKeep?: number;
  /** Share of a skeleton's arrows that hit (default `ARROW_HIT_RATE`), and the seed of its rolls. */
  arrowHitRate?: number;
  arrowSeed?: number;
  /** Degrees of view swing per tick that stop the feet pushing (default `TURN_PUSH_DEG`). */
  turnPushDeg?: number;
  /** Ticks the feet stand still after the sneak is let go (default `UNSNEAK_TICKS`). */
  unsneakTicks?: number;
  /** Ticks a swing lowers the raised shield (default `SWING_OPEN_TICKS`). */
  shieldOpenTicks?: number;
  /** Damage of a plain hit (default `SWORD`): a weaker weapon makes a fight last more of the mobs' attack clocks. */
  damage?: number;
}

/** Measured on retail (engine route, zombies3 and lone husks, 2026-11-11): 279 of 550 swings missed. */
export const LIVE_MISS_RATE = 0.5;

export const simMob = (id: string, typeId: string, x: number, z: number, speed: number, appearTick?: number): SimMob => ({
  id,
  typeId,
  x,
  z,
  health: 20,
  speed,
  kx: 0,
  kz: 0,
  vx: 0,
  vz: 0,
  hurtUntil: 0,
  nextAttack: Number.NEGATIVE_INFINITY,
  ...(appearTick !== undefined ? { appearTick } : {}),
});

function later(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Distance along the ray from `o` in direction `d` to the box, or undefined when it misses. */
function rayBox(o: [number, number, number], d: [number, number, number], lo: [number, number, number], hi: [number, number, number]): number | undefined {
  let t0 = 0;
  let t1 = Number.POSITIVE_INFINITY;
  for (let k = 0; k < 3; k++) {
    const dk = d[k] as number;
    const ok = o[k] as number;
    if (Math.abs(dk) < 1e-9) {
      if (ok < (lo[k] as number) || ok > (hi[k] as number)) return undefined;
      continue;
    }
    let a = ((lo[k] as number) - ok) / dk;
    let b = ((hi[k] as number) - ok) / dk;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return undefined;
  }
  return t0;
}

/** The grid text of one 16-block box: ground below y 0, walls outside the pen at y 0 and 1, air elsewhere. */
function gridBox(bx: number, by: number, bz: number, pen?: SimOptions["pen"]): string {
  const d = (n: number) => n.toString(36);
  let out = "";
  for (let y = 0; y < 16; y++) {
    const wy = by + y;
    for (let z = 0; z < 16; z++) {
      const wz = bz + z;
      let runStart = 0;
      let runClass = "";
      const flush = (end: number) => {
        if (runClass) out += `${runClass}${d(runStart)}${d(y)}${d(z)}${d(end)}${d(y)}${d(z)}`;
      };
      for (let x = 0; x < 16; x++) {
        const wx = bx + x;
        const inside = !pen || (wx >= pen.x0 && wx <= pen.x1 && wz >= pen.z0 && wz <= pen.z1);
        const c = wy < 0 ? "#" : (wy === 0 || wy === 1) && !inside ? "#" : ".";
        if (c !== runClass) {
          flush(x - 1);
          runStart = x;
          runClass = c;
        }
      }
      flush(15);
    }
  }
  return out;
}

export function sim(mobs: SimMob[], o: SimOptions = {}): Sim {
  const keyboard = o.keyboardLagTicks !== undefined;
  const callMs = o.callMs ?? ENGINE_CALL_MS;
  const inputTicks = keyboard ? 1 : ENGINE_INPUT_TICKS;
  const p = {
    x: o.start?.x ?? 0,
    y: 0,
    z: o.start?.z ?? 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: o.start?.yaw ?? 0,
    pitch: 0,
    health: 20,
    onGround: true,
    offhandDamage: 0,
    /** Knockback still to apply from a hit taken, blocks per tick. */
    kx: 0,
    kz: 0,
    /** Movement as the server acts on it, and since which tick it has been sneaking. */
    move: { ...STILL } as MoveVector,
    sneakSince: Number.POSITIVE_INFINITY,
    /** The tick the server last saw the sneak let go. */
    unsneakAt: Number.NEGATIVE_INFINITY,
  };
  const missRoll = seededRandom(o.missSeed ?? 11);
  const arrowRoll = seededRandom(o.arrowSeed ?? 13);
  const creeperRoll = seededRandom(o.creeperSeed ?? 17);
  const log: SimLog = { blast: 0, meleeDamage: 0, hitsTaken: 0, arrowHits: 0, blocked: 0, exploded: 0, swings: 0, hits: 0, events: [] };
  /** Movement sent and the tick the server acts on it. */
  const inbox: { tick: number; move: MoveVector }[] = [];
  let tick = 0;
  let viewWas = o.start?.yaw ?? 0;
  /** The tick of the last swing (it lowers the raised shield). */
  let swingTick = Number.NEGATIVE_INFINITY;
  const present = () => mobs.filter((m) => m.appearTick === undefined || tick >= m.appearTick);
  const clampX = (x: number) => (o.pen ? Math.max(o.pen.x0 + 0.3, Math.min(o.pen.x1 + 0.7, x)) : x);
  const clampZ = (z: number) => (o.pen ? Math.max(o.pen.z0 + 0.3, Math.min(o.pen.z1 + 0.7, z)) : z);
  const sent = (move: MoveVector) => inbox.push({ tick: tick + inputTicks, move: { ...move } });
  const facingOff = (m: { x: number; z: number }) => Math.abs(angleDiff(p.yaw, yawTo({ x: p.x, y: 0, z: p.z }, { x: m.x, y: 0, z: m.z })));

  const step = () => {
    tick++;
    const now = Date.now();
    for (let next = inbox[0]; next && next.tick <= tick; next = inbox[0]) {
      inbox.shift();
      if (next.move.sneak && !p.move.sneak) p.sneakSince = tick;
      if (!next.move.sneak && p.move.sneak) p.unsneakAt = tick;
      if (!next.move.sneak) p.sneakSince = Number.POSITIVE_INFINITY;
      p.move = next.move;
    }
    // The view a tick ago, for how fast it swings.
    const lastYaw = viewWas;
    viewWas = p.yaw;
    // Player: on the ground the held movement sets the speed; a jump keeps its take-off motion until it lands.
    const len = Math.min(1, Math.hypot(p.move.forward, p.move.strafe));
    const heading = p.yaw + (Math.atan2(p.move.strafe, p.move.forward) * 180) / Math.PI;
    const r = (heading * Math.PI) / 180;
    // Letting go of the sneak holds the feet still for `unsneakTicks`.
    const unsneaking = tick - p.unsneakAt < (o.unsneakTicks ?? UNSNEAK_TICKS);
    const slow = p.move.sneak;
    const sprinting = p.move.sprint && p.move.forward > 0.5 && !slow;
    if (p.onGround) {
      const speed = len < 0.01 || unsneaking ? 0 : (slow ? SNEAK : sprinting ? SPRINT : WALK) * len;
      // The feet carry their motion: each tick keeps `GROUND_KEEP` of it and the held input adds the rest, less while
      // the view swings round (`TURN_PUSH_DEG`).
      const keep = o.groundKeep ?? GROUND_KEEP;
      const turned = Math.abs(angleDiff(lastYaw, p.yaw));
      const push = (1 - keep) * Math.max(0, 1 - turned / (o.turnPushDeg ?? TURN_PUSH_DEG));
      p.vx = p.vx * keep + ((-Math.sin(r) * speed) / 20) * push;
      p.vz = p.vz * keep + ((Math.cos(r) * speed) / 20) * push;
      if (p.move.jump) {
        p.onGround = false;
        p.vy = 0.42;
        if (len > 0.01) {
          const air = (slow ? SNEAK : sprinting ? SPRINT_JUMP : p.move.forward < -0.5 ? BACK_JUMP : WALK) * len;
          p.vx = (-Math.sin(r) * air) / 20;
          p.vz = (Math.cos(r) * air) / 20;
        }
      }
    }
    p.x = clampX(p.x + p.vx + p.kx);
    p.z = clampZ(p.z + p.vz + p.kz);
    p.kx *= 0.6;
    p.kz *= 0.6;
    if (!p.onGround) {
      p.y += p.vy;
      p.vy = (p.vy - 0.08) * 0.98;
      if (p.y <= 0) {
        p.y = 0;
        p.vy = 0;
        p.onGround = true;
      }
    }
    for (const m of [...mobs]) {
      if (m.appearTick !== undefined && tick < m.appearTick) continue;
      if (m.diedAt !== undefined) {
        m.x += m.kx;
        m.z += m.kz;
        m.kx *= KNOCK_DECAY;
        m.kz *= KNOCK_DECAY;
        if (tick - m.diedAt >= (o.deathTicks ?? 0)) mobs.splice(mobs.indexOf(m), 1);
        continue;
      }
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      const lit = m.litAt !== undefined;
      // A swelling creeper stands still (the swell goal holds its movement).
      const sp = m.typeId === "minecraft:creeper" && lit ? 0 : m.speed;
      const x0 = m.x;
      const z0 = m.z;
      // Its walk carries its motion as the player's does (`MOB_GROUND_KEEP`): a creeper that stops to swell drifts on a
      // few ticks. A skeleton keeps its distance (`SKELETON_RANGE`) and shoots.
      const archer = m.typeId === "minecraft:skeleton";
      const walk = d > 0.8 && !(archer && d < SKELETON_STAND) ? sp / 20 : 0;
      const mk = o.mobGroundKeep ?? MOB_GROUND_KEEP;
      m.wx = (m.wx ?? 0) * mk + (d > 1e-6 ? ((p.x - m.x) / d) * walk : 0) * (1 - mk);
      m.wz = (m.wz ?? 0) * mk + (d > 1e-6 ? ((p.z - m.z) / d) * walk : 0) * (1 - mk);
      m.x += m.wx;
      m.z += m.wz;
      if (archer && d <= SKELETON_RANGE && now >= m.nextAttack) {
        m.nextAttack = now + SKELETON_SHOT_MS;
        if (arrowRoll() < (o.arrowHitRate ?? ARROW_HIT_RATE)) {
          if (p.move.sneak && tick - p.sneakSince >= SHIELD_TICKS && tick - swingTick > (o.shieldOpenTicks ?? SWING_OPEN_TICKS) && facingOff(m) < SHIELD_ARC) {
            p.offhandDamage++;
            log.blocked++;
            log.events.push({ at: now, kind: "block", mob: m.id });
          } else {
            p.health -= ARROW_HIT;
            log.hitsTaken++;
            log.arrowHits++;
            log.events.push({ at: now, kind: "hurt", mob: m.id });
          }
        }
      }
      if (m.knockAt !== undefined && tick >= m.knockAt) {
        m.kx = m.knockX ?? 0;
        m.kz = m.knockZ ?? 0;
        delete m.knockAt;
      }
      m.x = clampX(m.x + m.kx);
      m.z = clampZ(m.z + m.kz);
      m.kx *= KNOCK_DECAY;
      m.kz *= KNOCK_DECAY;
      m.vx = m.x - x0;
      m.vz = m.z - z0;
    }
    // Nothing overlaps: mobs pushed apart, and mob and player pushed apart.
    const live = present().filter((m) => m.diedAt === undefined);
    for (let i = 0; i < live.length; i++) {
      const a = live[i] as SimMob;
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j] as SimMob;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d >= SPACING) continue;
        const ux = d > 1e-6 ? (a.x - b.x) / d : 1;
        const uz = d > 1e-6 ? (a.z - b.z) / d : 0;
        const push = (SPACING - d) / 2;
        a.x = clampX(a.x + ux * push);
        a.z = clampZ(a.z + uz * push);
        b.x = clampX(b.x - ux * push);
        b.z = clampZ(b.z - uz * push);
      }
      const d = Math.hypot(a.x - p.x, a.z - p.z);
      if (d < SPACING) {
        const ux = d > 1e-6 ? (a.x - p.x) / d : 1;
        const uz = d > 1e-6 ? (a.z - p.z) / d : 0;
        const push = (SPACING - d) / 2;
        a.x = clampX(a.x + ux * push);
        a.z = clampZ(a.z + uz * push);
        p.x = clampX(p.x - ux * push);
        p.z = clampZ(p.z - uz * push);
      }
    }
    for (const m of live) {
      const dist = Math.hypot(p.x - m.x, p.z - m.z);
      if (m.typeId === "minecraft:creeper") {
        const lit = m.litAt !== undefined;
        const gap = Math.hypot(Math.max(0, Math.abs(p.x - m.x) - 0.6), Math.max(0, Math.abs(p.z - m.z) - 0.6));
        if (!lit && gap < (m.lightAt ??= CREEPER_LIGHT_GAP + (creeperRoll() * 2 - 1) * CREEPER_LIGHT_JITTER)) m.litAt = now;
        else if (lit && dist > 7) {
          delete m.litAt;
          delete m.lightAt;
        }
        if (m.litAt !== undefined && now - m.litAt >= 1500) {
          mobs.splice(mobs.indexOf(m), 1);
          log.exploded++;
          if (dist < 6 && !(p.move.sneak && facingOff(m) < 60)) {
            const dmg = Math.round((1 - dist / 6) * 25 * 10) / 10;
            log.blast += dmg;
            p.health -= dmg;
          }
        }
      } else if (m.typeId !== "minecraft:skeleton" && Math.max(Math.abs(p.x - m.x), Math.abs(p.z - m.z)) < 1.4 && p.y < MOB_HEIGHT && now >= m.nextAttack) {
        if (p.move.sneak && tick - p.sneakSince >= SHIELD_TICKS && tick - swingTick > (o.shieldOpenTicks ?? SWING_OPEN_TICKS) && facingOff(m) < SHIELD_ARC) {
          m.nextAttack = now + 1500;
          p.offhandDamage++;
          log.blocked++;
          log.events.push({ at: now, kind: "block", mob: m.id });
        } else {
          m.nextAttack = now + 1000;
          p.health -= MOB_HIT;
          // Thrown back and up, as a hit taken does: about a block away from the mob.
          const d = Math.max(0.1, Math.hypot(p.x - m.x, p.z - m.z));
          p.kx = ((p.x - m.x) / d) * 0.4;
          p.kz = ((p.z - m.z) / d) * 0.4;
          if (p.onGround) {
            p.onGround = false;
            p.vy = 0.36;
            p.vx = 0;
            p.vz = 0;
          }
          log.meleeDamage += MOB_HIT;
          log.hitsTaken++;
          log.events.push({ at: now, kind: "hurt", mob: m.id });
        }
      }
    }
    for (const m of mobs) {
      m.trail = [...(m.trail ?? []), { x: m.x, z: m.z }];
      while (m.trail.length > (o.entityLagTicks ?? ENTITY_LAG_TICKS) + 1) m.trail.shift();
    }
    history.push(state());
    while (history.length > 20) history.shift();
  };
  const history: PlayerState[] = [];
  const timer = setInterval(step, 50);
  /** The mob the view ray meets first, and the distance from the eye. */
  const aimed = (): { m: SimMob; dist: number } | undefined => {
    const cp = Math.cos((p.pitch * Math.PI) / 180);
    const dir: [number, number, number] = [-Math.sin((p.yaw * Math.PI) / 180) * cp, -Math.sin((p.pitch * Math.PI) / 180), Math.cos((p.yaw * Math.PI) / 180) * cp];
    const eye: [number, number, number] = [p.x, p.y + EYE, p.z];
    let best: { m: SimMob; dist: number } | undefined;
    for (const m of present()) {
      if (m.diedAt !== undefined) continue;
      const t = rayBox(eye, dir, [m.x - 0.3, 0, m.z - 0.3], [m.x + 0.3, MOB_HEIGHT, m.z + 0.3]);
      if (t !== undefined && t <= 8 && (!best || t < best.dist)) best = { m, dist: t };
    }
    return best;
  };
  const info = (m: SimMob): EntityInfo => ({
    id: m.id,
    typeId: m.typeId,
    // Where it was `entityLagTicks` ago (the reading's age), as the game's readings show it.
    location: { x: (m.trail?.[0] ?? m).x, y: 0, z: (m.trail?.[0] ?? m).z },
    health: { current: Math.max(0, m.health), max: 20 },
    tick: tick - Math.min(o.entityLagTicks ?? ENTITY_LAG_TICKS, (m.trail?.length ?? 1) - 1),
    velocity: { x: m.vx, y: 0, z: m.vz },
    ...(o.reportFuse && m.typeId === "minecraft:creeper" ? { ignited: m.litAt !== undefined, ...(m.litAt !== undefined ? { fuseTicks: Math.floor((Date.now() - m.litAt) / 50) } : {}) } : {}),
  });
  const state = (): PlayerState => {
    const a = aimed();
    return {
      tick,
      name: "p",
      location: { x: p.x, y: p.y, z: p.z },
      velocity: { x: p.vx, y: p.onGround ? 0 : p.vy, z: p.vz },
      rotation: { x: p.pitch, y: p.yaw },
      dimension: "minecraft:overworld",
      onGround: p.onGround,
      sneaking: p.move.sneak,
      sprinting: p.move.sprint,
      gameMode: "survival",
      selectedSlot: 1,
      health: p.health,
      offhandDamage: p.offhandDamage,
      holding: { typeId: "minecraft:iron_sword", amount: 1 },
      ...(a ? { lookingAtEntity: { id: a.m.id, typeId: a.m.typeId, distance: a.dist } } : {}),
    };
  };
  /** One attack click with the client's view now. */
  const strike = (): string | null => {
    log.swings++;
    swingTick = tick;
    const a = aimed();
    const m = a?.m;
    if (!a || !m || Math.hypot(p.x - m.x, p.z - m.z) > REACH || Date.now() < m.hurtUntil || (o.missRate !== undefined && missRoll() < o.missRate)) {
      log.events.push({ at: Date.now(), kind: "miss" });
      return null;
    }
    log.hits++;
    log.events.push({ at: Date.now(), kind: "hit", mob: m.id });
    const crit = !p.onGround && p.vy < 0;
    m.health -= (o.damage ?? SWORD) * (crit ? 1.5 : 1);
    m.hurtUntil = Date.now() + 500;
    const d = Math.max(0.1, Math.hypot(m.x - p.x, m.z - p.z));
    // Vanilla knockback: 0.4 blocks a tick (0.9 for a sprint hit), lost to ground friction (x 0.546 a tick): about 0.9
    // blocks, weaker struck while sneaking (`SNEAK_KNOCKBACK`). It shows `KNOCKBACK_DELAY_TICKS` later.
    const k = (p.move.sprint ? 0.9 : 0.4) * (p.move.sneak ? SNEAK_KNOCKBACK : 1);
    m.knockAt = tick + (o.knockbackDelayTicks ?? KNOCKBACK_DELAY_TICKS);
    m.knockX = ((m.x - p.x) / d) * k;
    m.knockZ = ((m.z - p.z) / d) * k;
    if (m.health <= 0) {
      if (o.deathTicks) m.diedAt = tick;
      else mobs.splice(mobs.indexOf(m), 1);
    }
    return m.id;
  };
  const engine: EngineInput = {
    prepare: async () => {},
    reachable: async () => true,
    look: async (pitch, yaw) => {
      p.pitch = pitch;
      p.yaw = yaw;
      await later(callMs);
    },
    move: async (m) => {
      sent(m);
      await later(callMs);
    },
    release: async () => {
      sent(STILL);
      await later(callMs);
    },
    attack: async () => {
      await later(o.attackMs ?? ENGINE_ATTACK_MS);
      return strike();
    },
    use: async () => {},
  };
  // Bedrock's default keys, held as the keyboard backend presses them.
  const held = new Set<string>();
  const keys = () => {
    const forward = (held.has("w") ? 1 : 0) - (held.has("s") ? 1 : 0);
    const strafe = (held.has("d") ? 1 : 0) - (held.has("a") ? 1 : 0);
    const len = Math.hypot(forward, strafe) || 1;
    sent({ ...STILL, forward: forward / len, strafe: strafe / len, sprint: held.has("Control_L"), sneak: held.has("Shift_L"), jump: held.has("space") });
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
    ...(keyboard ? {} : { engine, sample: () => ({ at: Date.now(), state: state() }) }),
    state: async () => (keyboard ? (history[Math.max(0, history.length - 1 - (o.keyboardLagTicks as number))] ?? state()) : state()),
    entity: async (id) => {
      const m = present().find((x) => x.id === id);
      return m ? info(m) : null;
    },
    nearest: async () => {
      const m = present()[0];
      return m ? info(m) : null;
    },
    impacts: async () => ({ tick, impacts: [] }),
    entities: async () => present().map(info),
    loadout: async () => ({ hotbar: [{ typeId: "minecraft:iron_sword", amount: 1 }], hunger: 20, armor: [{ slot: "Offhand", typeId: "minecraft:shield" }] }),
    ...(o.pen
      ? {
          query: async (kind: string, params?: Record<string, unknown>) => {
            if (kind !== "grid") throw new Error(`no ${kind} query in the sim`);
            const boxes = (params?.boxes ?? []) as number[][];
            return { boxes: boxes.map(([x, y, z]) => gridBox(x as number, y as number, z as number, o.pen)) };
          },
        }
      : {}),
  };
  return { world, log, player: () => ({ x: p.x, z: p.z, sneak: p.move.sneak }), stop: () => clearInterval(timer) };
}
