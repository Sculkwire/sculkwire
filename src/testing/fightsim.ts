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
 *   answers a move after `ENGINE_CALL_MS` and an attack after `ENGINE_ATTACK_MS` (measured on retail with calls 25 ms
 *   apart: 57 ms for `input.move`, 6 ms median and 17 ms p90 for `input.attack`), and applies one look per game frame
 *   (`LOOK_FRAME_MS`), first come first served, answering it then.
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
import { EYE_HEIGHT, PLAYER_REACH, WALK_SPEED } from "../runtime/client/bedrock.ts";
import { seededRandom } from "./faketime.ts";
import { encodeRegions } from "./grid.ts";
import { angleDiff, yawTo } from "../runtime/client/geometry.ts";
import { STILL, type MoveVector, type PlayerInput } from "../runtime/client/input.ts";
import type { EngineInput } from "../runtime/client/inputprovider.ts";
import type { EntityInfo, HurtLog, PlayerState, PlayerWorld } from "../runtime/client/types.ts";

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
  /** The main-hand item the helper reports (`*_spear`: it fights as `spearMob` says). */
  held?: string;
  /** A spear mob: charging the player, or backing off to `backTo` blocks after a hit. */
  spear?: { phase: "charge" | "back"; backTo: number; lastDist?: number; jabAt?: number };
}

/** Measured sprinting, sneaking and in-air speeds, blocks per second (walking is `WALK_SPEED`, any direction). */
const SPRINT = 5.61;
const SNEAK = 1.29;
const SPRINT_JUMP = 7.06;
const BACK_JUMP = 3.78;
/** Iron sword on a husk or zombie, and a husk's hit on full iron armor. */
const SWORD = 6.89;
const MOB_HIT = 1.62;
/** Ticks from an input being sent to the server acting on it. */
const ENGINE_INPUT_TICKS = 2;
/** The engine agent's answer to a move, and to an attack (the pessimistic measured case). */
const ENGINE_CALL_MS = 50;
const ENGINE_ATTACK_MS = 10;
/**
 * The engine agent applies one `input.look` per game frame, on its main-thread drain, in the order they came, and
 * answers it then: views sent faster than the frame rate queue up (live, 2026-11-11: the streamed aim error stood still
 * for 100 to 200 ms after a target change while the camera sent at 120 Hz, then the view jumped tens of degrees).
 */
const LOOK_FRAME_MS = 17; // one 60 fps frame, whole milliseconds
/**
 * A swing at a zombie or husk walking in (closing faster than `WALKING_IN_CLOSING` blocks a second; a creeper is struck
 * where it is, live 2.92 to 2.99 still walking) lands as the distance its
 * reading showed at the swing says, as measured live (2026-11-11, N=60 bench, every swing at a mob walking in by the
 * target's centre distance in the frame: 3.20 to 3.35 hit 2 of 115, 3.15 9 of 240, 3.10 5 of 196, 3.05 12 of 81, 3.00
 * 45 of 135, 2.95 63 of 137, 2.90 50 of 104, 2.85 123 of 162, 2.75 to 2.80 115 of 180, 2.60 to 2.70 84 of 115, 2.35
 * to 2.55 57 of 67). Taken relative to the 76 % at 2.85, inside which the misses left are the aim's and the jump's
 * (the simulator draws those itself): none from 3.05, 43 % at 3.0, 60 % at 2.95, 63 % at 2.9, all from 2.85.
 */
const WALKING_IN_CLOSING = 1.5;
const WALKING_IN_HIT: readonly [number, number][] = [
  [2.85, 1],
  [2.9, 0.63],
  [2.95, 0.6],
  [3.0, 0.43],
  [3.05, 0],
];
function walkingInHit(readDist: number): number {
  if (readDist <= 2.85) return 1;
  if (readDist >= 3.05) return 0;
  for (let k = 1; k < WALKING_IN_HIT.length; k++) {
    const [d1, p1] = WALKING_IN_HIT[k] as [number, number];
    const [d0, p0] = WALKING_IN_HIT[k - 1] as [number, number];
    if (readDist <= d1) return p0 + ((p1 - p0) * (readDist - d0)) / (d1 - d0);
  }
  return 0;
}
/** Ticks the server must have seen the sneak before a hit for the shield to block it. */
const SHIELD_TICKS = 6;
const SHIELD_ARC = 90;
/** A swing lowers the raised shield: an attack 12 ticks or less after it lands, 13 or more is blocked (measured). */
const SWING_OPEN_TICKS = 12;
/**
 * Letting go of the sneak holds the feet still this many ticks. Read from the live `auto` traces of 2026-11-11 (bench
 * combat zombies3+husks3+cornered, engine route, median player speed over the first 100 / 200 / 300 / 400 ms of a
 * retreat): right after lowering the shield 0 / 0.05 / 0.81 / 1.5 blocks a second (about 300 retreats), without a
 * shield before 0.34 / 1.24 / 2.06 / 2.07 (about 320): the feet start some 4 ticks later after a sneak.
 */
const UNSNEAK_TICKS = 4;
/**
 * Share of the player's ground motion kept from one tick to the next (the rest comes from the held input): vanilla's
 * ground friction (0.6 x 0.91). A sprint let go coasts about 0.34 blocks, on top of the 2 ticks the release takes to
 * reach the server (about 0.9 blocks after the stop is sent). It fits the live traces of 2026-11-11: a retreat from
 * standing averaged 1.24 blocks a second over its first 200 ms (the model: 1.25), and 170 ms after a strike at 2.99
 * with backward already sent, the sprint in had carried the player to 2.22 and 1.94 (the knockback 3 ticks late).
 */
const GROUND_KEEP = 0.546;
/**
 * Mobs carry their walk too, with the same ground friction. Read from the live `mixed` trace of 2026-11-11: a creeper
 * that stopped to swell at 3.16 still read closing 1.45, 0.82, 0.45, 0.19 and 0 blocks a second over the next ticks.
 */
const MOB_GROUND_KEEP = 0.546;
/**
 * Mob readings (`entity`, `entities`) show where a mob was this many ticks ago. Read from the live traces of
 * 2026-11-11 (two N=60 bench files, 41 hurts): the nearest mob 100 ms before a hurt read 1.6 to 2.5 blocks (median 2.0,
 * a quarter at 2.3 to 2.5), where its box reach is 1.4 to 1.98: a zombie closing at 2.3 blocks a second covers the
 * difference in about 2 ticks besides those 100 ms.
 */
const ENTITY_LAG_TICKS = 2;
/**
 * A creeper lights its fuse when the gap between its box and the player's (both 0.6 wide) is under this (its data
 * value), give or take `CREEPER_LIGHT_JITTER` per approach, and then coasts to a stop. Along an axis that is a centre
 * distance of 3.1, on a diagonal about 3.35. Live (2026-11-11): along the z axis (bench `creeper`) it was struck at 2.92
 * to 2.99 still walking; from the side (`mixed`, spawned at -8, 6) it slowed at 3.2 to 3.3 and stood at 3.08 to 3.16.
 */
export const CREEPER_LIGHT_GAP = 2.5;
const CREEPER_LIGHT_JITTER = 0.05;
/**
 * A skeleton walks up to `SKELETON_STAND`, shoots every `SKELETON_SHOT_MS` within `SKELETON_RANGE`, and an arrow hits
 * `ARROW_HIT_RATE` of the time for `ARROW_HIT` (vanilla-like, not measured; seeded so a run repeats).
 */
const SKELETON_STAND = 8;
const SKELETON_RANGE = 15;
const SKELETON_SHOT_MS = 2500;
const ARROW_HIT_RATE = 0.5;
const ARROW_HIT = 2;
/**
 * While the view swings round, the feet push less: by the share the view turned in the tick out of this many degrees
 * (none at this or more). Fitted to the live turn-and-sprint escapes from a creeper of 2026-11-11 (player
 * displacement after the run starts: 0 at 200 ms, 0.25 at 400, 0.82 at 600, 1.54 at 800, 2.06 at 1000, 3.8 at 1400).
 */
const TURN_PUSH_DEG = 20;
/**
 * A hit's knockback shows this many ticks after the swing's answer. Read from the live traces of 2026-11-11 (median
 * change of the struck mob's distance with the player standing, 50 ms bins after the hit, about 500 hits each): -0.14,
 * -0.23, -0.23 at 50 to 150 ms (still walking in), then +0.3 at 200 ms and +0.94 at 550 ms.
 */
const KNOCKBACK_DELAY_TICKS = 3;
/**
 * Knockback of a hit struck while sneaking, as a share of a normal one. Read from the same traces: with the shield up
 * the struck mob was +0.57 at 400 ms and +0.79 at 550 ms, without +0.74 and +0.94.
 */
const SNEAK_KNOCKBACK = 0.75;
/** Ground friction on knockback, per tick. */
const KNOCK_DECAY = 0.546;
const MOB_HEIGHT = 1.95;
const SPACING = 0.6;

/** One thing that happened in the sim, on its tick (ms on the fake clock). */
interface SimEvent {
  at: number;
  kind: "hurt" | "block" | "hit" | "miss";
  mob?: string;
}

interface SimLog {
  blast: number;
  meleeDamage: number;
  /** Swings the miss rate (`missRate`) took: not the gate's. */
  drawnMisses: number;
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
  /** Delay of the engine's answer to a move (default `ENGINE_CALL_MS`) and to an attack (`ENGINE_ATTACK_MS`). */
  callMs?: number;
  /** Leave `held` out of the readings (a helper that cannot read it): the fight sees bare-handed mobs. */
  hideHeld?: boolean;
  /** One look applied per this many milliseconds, first come first served (default `LOOK_FRAME_MS`). */
  lookFrameMs?: number;
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

/**
 * A husk holding a spear, as the game's files say (`minecraft:behavior.use_kinetic_weapon`, the spear's
 * `kinetic_weapon`): it charges at its walk (2.2 blocks a second), hits on contact at `SPEAR_HIT` (2.25 reach plus the
 * 0.25 hitbox margin plus half the player's box, centre to centre) only while the two close faster than
 * `SPEAR_MIN_CLOSING`, then backs off to 9 to 11 blocks and comes again. No box attack.
 */
export const spearMob = (id: string, typeId: string, x: number, z: number, appearTick?: number): SimMob => ({
  ...simMob(id, typeId, x, z, 2.2, appearTick),
  held: "minecraft:iron_spear",
  spear: { phase: "charge", backTo: 10 },
});
/**
 * The centre distance the spear lands at. The files give up to 2.8 (2.25 + 0.25 + 0.3); live (`combat/spears3`, five
 * runs) every hurt came with the nearest husk read at 2.4 to 2.6 and swings at it from 2.5 landing first, so the
 * simulator takes 2.5: within that the player's strike and the spear meet as they did live.
 */
const SPEAR_HIT = 2.5;
export const SPEAR_MIN_CLOSING = 0.92;
/**
 * Its hit also lands from `SPEAR_JAB` when the player moves fast (live, round 2: all 8 hurts came with the husk read
 * at 3.0 to 3.35 and the player at 4.1 to 5.7 blocks a second: sprinting after it, or backing off at full speed; none
 * standing or walking slowly there), at most once per the item's `cooldown`, 0.95 s.
 */
const SPEAR_JAB = 3.35;
const SPEAR_JAB_PLAYER_SPEED = 3.5;
const SPEAR_JAB_COOLDOWN_MS = 950;
/** A spear hit on iron armor (live, `combat/spears3`: 2.5 a hurt). */
const SPEAR_DAMAGE = 2.5;

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
  return encodeRegions(bx, by, bz, (wx, wy, wz) => {
    const inside = !pen || (wx >= pen.x0 && wx <= pen.x1 && wz >= pen.z0 && wz <= pen.z1);
    return wy < 0 ? "#" : (wy === 0 || wy === 1) && !inside ? "#" : ".";
  });
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
  const reachRoll = seededRandom((o.missSeed ?? 11) + 1000);
  /** The helper's `hurts` log as the game would fill it: cause, damager type and id. */
  const hurtRecords: HurtLog["hurts"] = [];
  const spearRoll = seededRandom((o.missSeed ?? 11) + 2000);
  const log: SimLog = { drawnMisses: 0, blast: 0, meleeDamage: 0, hitsTaken: 0, arrowHits: 0, blocked: 0, exploded: 0, swings: 0, hits: 0, events: [] };
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
      const speed = len < 0.01 || unsneaking ? 0 : (slow ? SNEAK : sprinting ? SPRINT : WALK_SPEED) * len;
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
          const air = (slow ? SNEAK : sprinting ? SPRINT_JUMP : p.move.forward < -0.5 ? BACK_JUMP : WALK_SPEED) * len;
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
      // A spear mob backing off walks away until it is `backTo` out, then charges again.
      if (m.spear?.phase === "back" && d >= m.spear.backTo) m.spear.phase = "charge";
      const away = m.spear?.phase === "back" ? -1 : 1;
      const walk = (d > 0.8 || away < 0) && !(archer && d < SKELETON_STAND) ? (sp / 20) * away : 0;
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
            hurtRecords.push({ tick, damage: ARROW_HIT, cause: "projectile", damager: m.typeId, damagerId: m.id });
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
            hurtRecords.push({ tick, damage: dmg, cause: "entityExplosion", damager: m.typeId, damagerId: m.id });
            p.health -= dmg;
          }
        }
      } else if (m.spear) {
        // The spear: contact at `SPEAR_HIT` while the two close faster than `SPEAR_MIN_CLOSING` (from the last tick).
        const closingNow = m.spear.lastDist !== undefined ? (m.spear.lastDist - dist) * 20 : 0;
        m.spear.lastDist = dist;
        const charge = m.spear.phase === "charge" && dist <= SPEAR_HIT && closingNow > SPEAR_MIN_CLOSING && now - (m.spear.jabAt ?? Number.NEGATIVE_INFINITY) >= SPEAR_JAB_COOLDOWN_MS;
        const playerSpeed = Math.hypot(p.vx, p.vz) * 20;
        const ready = now - (m.spear.jabAt ?? Number.NEGATIVE_INFINITY) >= SPEAR_JAB_COOLDOWN_MS;
        const jab = !charge && ready && dist <= SPEAR_JAB && playerSpeed > SPEAR_JAB_PLAYER_SPEED;
        if ((charge || jab) && p.y < MOB_HEIGHT) {
          if (charge) {
            m.spear.phase = "back";
            m.spear.backTo = 9 + spearRoll() * 2;
          }
          m.spear.jabAt = now;
          // The raised shield does not stop it (live, 19 of 34 spear hits came through one).
          p.health -= SPEAR_DAMAGE;
          const dd = Math.max(0.1, dist);
          p.kx = ((p.x - m.x) / dd) * 0.4;
          p.kz = ((p.z - m.z) / dd) * 0.4;
          log.meleeDamage += SPEAR_DAMAGE;
          log.hitsTaken++;
          log.events.push({ at: now, kind: "hurt", mob: m.id });
          hurtRecords.push({ tick, damage: SPEAR_DAMAGE, cause: "entityAttack", damager: m.typeId, damagerId: m.id });
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
          hurtRecords.push({ tick, damage: MOB_HIT, cause: "entityAttack", damager: m.typeId, damagerId: m.id });
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
  const looks: { pitch: number; yaw: number; resolve: () => void }[] = [];
  const lookTimer = setInterval(() => {
    const l = looks.shift();
    if (!l) return;
    p.pitch = l.pitch;
    p.yaw = l.yaw;
    l.resolve();
  }, o.lookFrameMs ?? LOOK_FRAME_MS);
  /** The mob the view ray meets first, and the distance from the eye. */
  const aimed = (): { m: SimMob; dist: number } | undefined => {
    const cp = Math.cos((p.pitch * Math.PI) / 180);
    const dir: [number, number, number] = [-Math.sin((p.yaw * Math.PI) / 180) * cp, -Math.sin((p.pitch * Math.PI) / 180), Math.cos((p.yaw * Math.PI) / 180) * cp];
    const eye: [number, number, number] = [p.x, p.y + EYE_HEIGHT, p.z];
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
    ...(m.held && !o.hideHeld ? { held: m.held } : {}),
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
    // A mob walking in is struck as its reading's distance says (`WALKING_IN_HIT`), not where it is by then.
    const read = m ? (m.trail?.[0] ?? m) : undefined;
    const readDist = m && read ? Math.hypot(p.x - read.x, p.z - read.z) : 0;
    const walkingIn = m !== undefined && m.typeId !== "minecraft:creeper" && readDist > 0.01 && read !== undefined && ((m.vx * (p.x - read.x) + m.vz * (p.z - read.z)) / readDist) * 20 > WALKING_IN_CLOSING;
    const outOfReading = walkingIn && reachRoll() >= walkingInHit(readDist);
    const drawn = !(!a || !m || outOfReading || Math.hypot(p.x - m.x, p.z - m.z) > PLAYER_REACH || Date.now() < m.hurtUntil) && o.missRate !== undefined && missRoll() < o.missRate;
    if (!a || !m || outOfReading || Math.hypot(p.x - m.x, p.z - m.z) > PLAYER_REACH || Date.now() < m.hurtUntil || drawn) {
      if (drawn) log.drawnMisses++;
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
    look: (pitch, yaw) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      looks.push({ pitch, yaw, resolve });
      return promise;
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
    hurts: async (since) => ({ tick, hurts: hurtRecords.filter((h) => h.tick > since) }),
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
  return { world, log, player: () => ({ x: p.x, z: p.z, sneak: p.move.sneak }), stop: () => {
      clearInterval(timer);
      clearInterval(lookTimer);
    },
  };
}
