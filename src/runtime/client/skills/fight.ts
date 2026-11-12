/**
 * `fight`: melee like a skilled player. One loop runs the whole fight: among melee mobs the target changes inside it
 * without stopping the feet, and the hand strikes whichever mob in reach can take a hit (each mob has its own 10-tick
 * invulnerability). Against melee mobs (`pack.ts`) it waits for a chasing mob at the edge of reach instead of walking
 * into a pack, keeps out of the mobs' reach with the feet, and turns or walks out when a mob gets beside or behind.
 * It keeps an attack clock per mob, and boxed in (`auto`; always near mobs with `guard`) it raises the shield 400 ms
 * before the next attack is due and swings from behind it only in a window where no mob can attack while
 * the swing holds the shield open. It jumps in place for critical hits when no attack is due, keeps a creeper from
 * lighting its fuse (about 3 blocks) and gets out past 7 blocks, shield up, once it burns, shoots a creeper from range
 * when there is a bow, weaves toward archers, waits for a leaping spider to land, and moves on to the next hostile.
 */
import { turnDurationMs } from "../camera.ts";
import { EYE_HEIGHT, PLAYER_REACH } from "../bedrock.ts";
import { angleDiff, horizontalDistance, yawTo } from "../geometry.ts";
import type { Follow, PlayerController } from "../player.ts";
import type { EntityInfo, HurtLog, Loadout, PlayerState } from "../types.ts";
import { navigate } from "../nav/navigate.ts";
import { CROWD_RADIUS, crowdMove, isolated, pickDuelTarget } from "./crowd.ts";
import { CLOSE_IN_MARGIN, CLOSE_IN_SETTLE_MS, closeInTicks, CREEPER_MARGIN, CREEPER_STANDING, creeperStandFrom, STEP_TAP_MS, STRUCK_THROW, STRUCK_THROW_MS, CREEPER_START, CREEPER_STOP, creeperMove, critSafe, crowdedCreeper, type FuseMemory, readyInMs, spiderAirborne, trackFuse, weaveDeg } from "./defense.ts";
import { gridFor, type GridCache } from "../nav/grid.ts";
import { bestWeaponSlot, bowSlot, hasShield } from "./items.ts";
import { HIT_COOLDOWN_MS, meleePlan, type PendingSwing, swingOutcome } from "./melee.ts";
import { aimHeightOf, closingSpeed, holdsSpear, isHostile, SPEAR_CARRIERS, MELEE_COOLDOWN_MS, meleeReach, mobInfo, shortType, type MobInfo } from "./mobs.ts";
import { STRIKE_AIM_DEG, AFTER_BLOCK_MS, attackInMs, attackers, ENGINE_LATENCY_MS, GUARD_STEP_OUT_MS, ROOM_NEEDED, KEYBOARD_LATENCY_MS, nextAttackMs, NO_WINDOW_MS, packMove, shieldSwingOk, type PackMob, SPEAR_OPENING_STRIKE, strikeDistance, strikeTarget, STRIKE_DIST, STRIKE_REACH, WALKING_IN } from "./pack.ts";
import { combatStats, fightText, logEvent, traceFrame, type CombatStats, type TraceEvent, type TraceMob } from "./stats.ts";
import type { Death } from "./play.ts";
import { isEntityId, typeIdOf } from "./target.ts";
import { clearRun, findCover, openHeading } from "./steer.ts";
import type { Counters, FightArgs, FightStats, SkillResult, Stance } from "./types.ts";

/** Shortest time between two clicks, so a missed swing is not repeated every frame. */
const MIN_SWING_GAP_MS = 150;
/** A bow is worth drawing on a creeper this far away; closer, the sword. */
const BOW_MIN_DISTANCE = 5;
/** Toward a standing creeper the sprint stops this far out: a sprint let go carries the player on for nearly a block. */
const SPRINT_TO = 5;

/** The nearest fight target: of `type` when given, else hostile; never one in `skip`. */
async function pickTarget(pc: PlayerController, type: string | undefined, radius: number, skip: ReadonlySet<string> = new Set()): Promise<EntityInfo | undefined> {
  const me = await pc.world.state(300);
  const wanted = type ? typeIdOf(type) : undefined;
  const fits = (e: EntityInfo) => !skip.has(e.id) && e.typeId !== "minecraft:player" && (wanted ? e.typeId === wanted : isHostile(e.typeId));
  if (pc.world.entities) {
    const list = (await pc.world.entities(radius)).filter(fits);
    list.sort((a, b) => horizontalDistance(a.location, me.location) - horizontalDistance(b.location, me.location));
    return list[0];
  }
  const e = await pc.world.nearest(wanted, radius);
  return e && fits(e) ? e : undefined;
}

/** The helper's player hurts after game tick `since`: the world's own `hurts`, else its `hurts` query. */
async function hurtLog(pc: PlayerController, since: number): Promise<HurtLog | undefined> {
  if (pc.world.hurts) return pc.world.hurts(since).catch(() => undefined);
  const r = (await pc.world.query?.("hurts", { since }).catch(() => undefined)) as { tick?: unknown; hurts?: unknown } | undefined;
  return r && typeof r.tick === "number" && Array.isArray(r.hurts) ? { tick: r.tick, hurts: r.hurts as HurtLog["hurts"] } : undefined;
}

/** A melee mob that hurts the player from this far or more (and not past `SPEAR_LEARN_MAX`) is taken to hold a spear. */
export const SPEAR_LEARN_DIST = 2.3;
const SPEAR_LEARN_MAX = 3.5;

/** A hostile mob the fight has struck still alive within this many blocks keeps a fight over `all` going. */
const FOUGHT_RADIUS = 24;

/**
 * The nearest mob the fight struck that is still alive within `FOUGHT_RADIUS`, even one set aside as gone (a spear
 * husk backs off to 9 to 11 blocks after its charge; live, the fight ended there and `play` idled to its timeout).
 * Each one is taken up again at most `tries` times.
 */
async function foughtNear(pc: PlayerController, struck: ReadonlyMap<string, unknown>, again: Map<string, number>, tries = 5): Promise<EntityInfo | undefined> {
  if (!pc.world.entities || struck.size === 0) return undefined;
  const me = await pc.world.state(300);
  const list = (await pc.world.entities(FOUGHT_RADIUS).catch(() => [] as EntityInfo[])).filter((e) => struck.has(e.id) && (e.health?.current ?? 1) > 0 && (again.get(e.id) ?? 0) < tries);
  list.sort((a, b) => horizontalDistance(a.location, me.location) - horizontalDistance(b.location, me.location));
  const e = list[0];
  if (e) again.set(e.id, (again.get(e.id) ?? 0) + 1);
  return e;
}

async function equipWeapon(pc: PlayerController, signal?: AbortSignal, loadout?: Loadout): Promise<string | undefined> {
  const l = loadout ?? (await pc.world.loadout?.().catch(() => undefined));
  const best = l ? bestWeaponSlot(l.hotbar) : undefined;
  if (!best) return undefined;
  const me = await pc.world.state(300);
  if (me.selectedSlot !== best.slot) await pc.hands.selectSlot(best.slot, signal);
  return best.typeId;
}

interface Duel {
  outcome: "dead" | "gone" | "timeout" | "switch";
  /** The mob to fight next (`switch`, and after a kill when the crowd shows one). */
  next?: EntityInfo;
}

/**
 * Against an archer the feet stand within `STRIKE_DIST` and walk in again only past it by this much: still inside the
 * 3.0 strike reach, so standing never waits where no swing lands.
 */
const HOLD_BAND = 0.15;
/** A crit jump is sent once: the readings show the player off the ground 2 to 4 ticks later. */
const JUMP_ONCE_MS = 400;
/** After a switch between duels, the next one waits this long (unless to a burning or close creeper). */
const SWITCH_HOLD_MS = 600;
/** How often the fighter looks around for the other mobs (the streamed list comes every tick). */
const CROWD_POLL_MS = 50;
/** Health lost this recently means something is hitting the player. */
const HURT_MS = 800;
/** A hit shows in the player state this long after it landed (at most): a mob's attack clock is counted from then. */
const HURT_SEEN_LAG_MS = 150;
/** How much of the fight before a hit the hurt log keeps (against a creeper: back to when its fuse was lit). */
const FRAME_LOG_MS = 1200;
const CREEPER_FRAME_LOG_MS = 2200;
/** After striking a creeper, wait this long for it to walk back before walking up to it (it may have lit). */
const STRUCK_WAIT_MS = 1500;
/** Running from a fuse: progress is checked this often, and less than `RUN_STUCK` blocks means something blocks the way. */
const RUN_CHECK_MS = 400;
const RUN_STUCK = 0.8;
/** Trace numbers to the centimetre, so a long trace stays small. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** What the fight brings, and what it struck. */
interface Kit {
  shield: boolean;
  bow?: { slot: number; arrows: number };
  /** Entity id -> type and last health reading of everything this fight's swings struck or its arrows killed. */
  struck: Map<string, Struck>;
}

export interface Struck {
  typeId: string;
  health?: { current: number; max: number };
}

/**
 * The player's kills in one fight, by short type. With the helper's death log (`deaths` since the fight started):
 * every death the player caused. Without one: everything the fight struck that is gone at its end, except a creeper
 * last seen at full health (it blew up).
 */
export function fightKills(deaths: readonly Death[] | undefined, struck: ReadonlyMap<string, Struck>, gone: ReadonlySet<string>): Record<string, number> {
  const kills: Record<string, number> = {};
  const add = (typeId: string) => {
    const t = shortType(typeId);
    kills[t] = (kills[t] ?? 0) + 1;
  };
  if (deaths) {
    for (const d of deaths) if (d.killer === "minecraft:player") add(d.typeId);
    return kills;
  }
  for (const [id, s] of struck) {
    if (!gone.has(id)) continue;
    if (mobInfo(s.typeId).kind === "exploder" && s.health && s.health.current >= s.health.max) continue;
    add(s.typeId);
  }
  return kills;
}

/** The helper's death log after game tick `since`, when the world offers it. */
async function deathLog(pc: PlayerController, since: number): Promise<{ tick: number; deaths: Death[] } | undefined> {
  const r = (await pc.world.query?.("deaths", { since }).catch(() => undefined)) as { tick?: unknown; deaths?: unknown } | undefined;
  return r && typeof r.tick === "number" && Array.isArray(r.deaths) ? { tick: r.tick, deaths: r.deaths as Death[] } : undefined;
}

/** The counters a fight reports, read so the fight can report its own share of a `play` run's shared stats. */
function counters(s: CombatStats): Counters {
  return { swings: s.swings, hits: s.hits, misses: s.misses, crits: s.crits, hitsTaken: s.hitsTaken, damageTaken: s.damageTaken, blocked: s.blocked };
}

/** A keyboard click waiting for the struck mob's health reading, and that mob's last hit before it in case it missed. */
interface Pending extends PendingSwing {
  id: string;
  crit: boolean;
  previous?: number;
}

/** What lives across the fight's targets: the crowd, the shield, the player's health and the hand. */
interface FightContext {
  readonly deadline: number;
  readonly crits: boolean;
  readonly stance: Stance;
  readonly all: boolean;
  /** The type the fight is after (`all` moves on only to these), undefined for any hostile. */
  readonly wanted?: string;
  readonly kit: Kit;
  /** Mobs done with (killed, gone or given up). */
  readonly skip: Set<string>;
  /** How late what the fighter does reaches the server, counting the reading's age (`pack.ts`). */
  readonly latencyMs: number;
  /** The hostile mobs around, polled in the background, and when. */
  crowd: EntityInfo[];
  crowdAt: number;
  /** The shield is raised (sneak sent), since when. */
  blocking: boolean;
  guardSince: number;
  /** The last crit jump sent. */
  jumpAt: number;
  /** The last switch between duels (to or from a creeper or an archer). */
  switchedAt: number;
  /** The last block seen, and since when the raised shield has had no window to swing in. */
  blockedAt: number;
  noWindowSince?: number;
  /** Swings from behind the raised shield keep the discipline (`shieldSwingOk`): false for the shield against a leaping spider. */
  disciplined: boolean;
  /** `guard` stepped out (no window to swing in) at this time, until its next block. */
  stepOutSince?: number;
  /** Free run along the retreat heading, as the footwork last read it. */
  room: number;
  /** The helper's hurt log read up to this game tick (undefined: no log to learn spears from). */
  hurtTick?: number;
  lastHealth?: number;
  lastOffhand?: number;
  hurtAt: number;
  /** The last fight frames, logged with each hit the player takes. */
  frames: { at: number; line: string }[];
  lastSwing: number;
  pending?: Pending;
  airborneSince?: number;
  /** Blocks around (walls, holes) for the footwork, cover against archers. */
  nav?: GridCache;
  navScan: number;
}

export async function fight(pc: PlayerController, args: FightArgs, signal?: AbortSignal): Promise<SkillResult & { stats: FightStats }> {
  const h = pc.hands;
  const started = h.now();
  const stats = combatStats(pc);
  const before = counters(stats);
  const radius = args.radius ?? 16;
  const byId = args.target !== undefined && isEntityId(args.target);
  const type = byId ? undefined : args.target;
  const kit: Kit = { shield: false, struck: new Map() };
  const ctx: FightContext = {
    deadline: started + (args.timeoutMs ?? 60_000),
    crits: args.crits ?? true,
    stance: args.stance ?? "auto",
    all: args.all ?? !byId,
    ...(type ? { wanted: typeIdOf(type) } : {}),
    kit,
    skip: new Set(),
    latencyMs: pc.input === "engine" ? ENGINE_LATENCY_MS : KEYBOARD_LATENCY_MS,
    crowd: [],
    crowdAt: h.now(),
    blocking: false,
    guardSince: Number.NEGATIVE_INFINITY,
    blockedAt: Number.NEGATIVE_INFINITY,
    switchedAt: Number.NEGATIVE_INFINITY,
    jumpAt: Number.NEGATIVE_INFINITY,
    disciplined: false,
    room: Number.POSITIVE_INFINITY,
    hurtAt: Number.NEGATIVE_INFINITY,
    frames: [],
    lastSwing: Number.NEGATIVE_INFINITY,
    ...(pc.world.query ? { nav: gridFor(pc.world) } : {}),
    navScan: Number.NEGATIVE_INFINITY,
  };
  let deathTick: number | undefined;
  /** This fight's numbers: the controller's counters now minus at the start, and the kills. */
  const result = async (): Promise<FightStats> => {
    const now = counters(stats);
    let kills: Record<string, number>;
    const deaths = deathTick !== undefined ? await deathLog(pc, deathTick) : undefined;
    if (deaths) kills = fightKills(deaths.deaths, kit.struck, new Set());
    else {
      const gone = new Set<string>();
      for (const id of kit.struck.keys()) if (!(await pc.world.entity(id).catch(() => null))) gone.add(id);
      kills = fightKills(undefined, kit.struck, gone);
    }
    return {
      kills,
      swings: now.swings - before.swings,
      hits: now.hits - before.hits,
      misses: now.misses - before.misses,
      crits: now.crits - before.crits,
      hitsTaken: now.hitsTaken - before.hitsTaken,
      damageTaken: Math.round((now.damageTaken - before.damageTaken) * 10) / 10,
      blocked: now.blocked - before.blocked,
      timeMs: h.now() - started,
    };
  };
  let target = byId ? ((await pc.world.entity(args.target as string)) ?? undefined) : await pickTarget(pc, type, radius);
  if (!target) {
    const s = await result();
    return { ok: false, message: `${byId ? `no entity ${args.target}` : `no ${type ? shortType(typeIdOf(type)) : "hostile mob"} within ${radius} blocks`}, ${fightText(s)}`, stats: s };
  }
  // The death log's tick now: the player's kills are the deaths after it.
  deathTick = (await deathLog(pc, Number.MAX_SAFE_INTEGER))?.tick;
  if (pc.world.hurts || pc.world.query) {
    const hurtsNow = (await hurtLog(pc, Number.MAX_SAFE_INTEGER))?.tick;
    if (hurtsNow !== undefined) ctx.hurtTick = hurtsNow;
  }
  const loadout = await pc.world.loadout?.().catch(() => undefined);
  kit.shield = hasShield(loadout?.armor);
  const bow = loadout ? bowSlot(loadout.hotbar) : undefined;
  if (bow) kit.bow = bow;
  const weapon = await equipWeapon(pc, signal, loadout);
  // The other hostile mobs around, read in the background for the whole fight: who is closest, who is flanking.
  let watching = true;
  const watch = (async () => {
    while (watching && pc.world.entities) {
      const list = await pc.world.entities(CROWD_RADIUS + 3).catch(() => undefined);
      if (list) {
        ctx.crowd = list.filter((m) => m.typeId !== "minecraft:player" && isHostile(m.typeId) && m.health !== undefined);
        ctx.crowdAt = h.now();
      }
      await h.sleep(CROWD_POLL_MS).catch(() => undefined);
    }
  })();
  let arrows = 0;
  let cancelled = false;
  /** How often each struck mob was taken up again after it was set aside (`foughtNear`). */
  const again = new Map<string, number>();
  try {
    while (target) {
      if (kit.bow && mobInfo(target.typeId).kind === "exploder") {
        const shot = await archery(pc, target, kit.bow.slot, ctx.deadline, signal);
        arrows += shot.shots;
        if (shot.dead) {
          ctx.skip.add(target.id);
          kit.struck.set(target.id, { typeId: target.typeId });
          if (!ctx.all) break;
          target = await pickTarget(pc, type, radius, ctx.skip);
          continue;
        }
        if (weapon) await equipWeapon(pc, signal);
      }
      const d = await duel(pc, target, ctx, signal);
      if (d.outcome === "switch" && d.next) {
        target = d.next;
        continue;
      }
      if (d.outcome === "timeout") break;
      if (!ctx.all) break;
      // The next mob without stopping: the crowd's when it has one, else a fresh look around, else one it fought that is
      // still alive near.
      target = d.next ?? (await pickTarget(pc, type, radius, ctx.skip)) ?? (await foughtNear(pc, kit.struck, again));
    }
  } catch (err) {
    // Cancelled (preempted by `play`, the request cancelled): still report what the fight did.
    if (!signal?.aborted) throw err;
    cancelled = true;
  } finally {
    watching = false;
    await watch;
    delete stats.fighting;
    // A click still unjudged when the fight ends counts as a miss.
    if (ctx.pending) {
      stats.misses++;
      delete ctx.pending;
    }
    await h.move({ sneak: false });
    await h.stop();
  }
  const timedOut = h.now() > ctx.deadline;
  const s = await result();
  if (cancelled) return { ok: false, message: "cancelled", stats: s };
  const killed = Object.keys(s.kills).length > 0;
  const text = fightText(s, weapon ? shortType(weapon) : undefined);
  return {
    ok: killed || (!timedOut && s.hits > 0),
    message: `${text}${arrows ? `, ${arrows} arrow(s)` : ""}${timedOut ? ", timed out" : ""}`,
    stats: s,
  };
}

/**
 * Shoot a creeper while it is farther than `BOW_MIN_DISTANCE`, walking backward to keep the distance. Returns when
 * it is dead, gone, or too close for the bow.
 */
async function archery(pc: PlayerController, target: EntityInfo, slot: number, deadline: number, signal?: AbortSignal): Promise<{ dead: boolean; shots: number }> {
  const h = pc.hands;
  let shots = 0;
  if (!(await h.selectSlot(slot, signal))) return { dead: false, shots };
  try {
    for (;;) {
      const e = await pc.world.entity(target.id);
      if (!e) return { dead: shots > 0, shots };
      const s = await pc.world.state(200);
      const dist = horizontalDistance(s.location, e.location);
      if (dist < BOW_MIN_DISTANCE || h.now() > deadline || signal?.aborted) return { dead: false, shots };
      // Back away while drawing (slowed, but it keeps the gap), unless the creeper is still far.
      await h.walk(dist < 9 ? yawTo(s.location, e.location) + 180 : undefined, false);
      const r = await pc.shoot({ entity: target.id, shots: 1, timeoutMs: 3000 }, signal);
      shots++;
      if (/is gone/.test(r.message)) return { dead: true, shots };
      if (!r.ok && /hold a|needs .* in hand/.test(r.message)) return { dead: false, shots };
    }
  } finally {
    await h.walk(undefined);
  }
}

/**
 * Fight `first` and, among melee mobs, whoever the hand should strike next, until the target dies (the next one
 * from the crowd is returned in `next`), disappears or time runs out. A turn to or from a creeper or an archer
 * returns `switch`, which sets that one up; the feet keep going either way.
 */
async function duel(pc: PlayerController, first: EntityInfo, ctx: FightContext, signal?: AbortSignal): Promise<Duel> {
  const h = pc.hands;
  const stats = combatStats(pc);
  const nextAttack = stats.nextAttack;
  const kit = ctx.kit;
  const followed = await h.follow(first.id);
  if (!followed) {
    ctx.skip.add(first.id);
    return { outcome: "gone" };
  }
  let f: Follow = followed;
  let target = first;
  let info: MobInfo = mobInfo(target.typeId);
  let exploder = info.kind === "exploder";
  let aimHeight = aimHeightOf(info);
  /** Each creeper's fuse as the fight takes it, shared with the later duels of this `play` run. */
  const fuseOf = (id: string): FuseMemory => {
    let m = stats.creepers.get(id);
    if (!m) stats.creepers.set(id, (m = {}));
    return m;
  };
  let fuse = fuseOf(target.id);
  let hits = 0;
  /** Ticks this duel has run. */
  let duelTicks = 0;
  h.track(f, aimHeight, 10);
  stats.fighting = target.id;
  /** The yaw the camera holds while the pack is turned in front, instead of tracking the target. */
  let facing: number | undefined;
  /** Turn to another melee mob inside the loop: the feet keep going, the camera moves over. */
  const turnTo = async (next: EntityInfo): Promise<boolean> => {
    const nf = await h.follow(next.id);
    if (!nf) return false;
    f.stop();
    f = nf;
    target = next;
    info = mobInfo(next.typeId);
    exploder = info.kind === "exploder";
    aimHeight = aimHeightOf(info);
    fuse = fuseOf(next.id);
    hits = 0;
    facing = undefined;
    h.track(f, aimHeight, 10);
    stats.fighting = next.id;
    return true;
  };
  const healthOf = (id: string) => (id === target.id ? f.last.health?.current : ctx.crowd.find((m) => m.id === id)?.health?.current);
  /** What happened this tick, for the trace (only while tracing is on). */
  let ev: TraceEvent[] | undefined;
  /** A swing that struck `id` (the target or another hostile mob in the way). */
  const landed = (id: string, typeId: string, at: number, crit: boolean, health?: { current: number; max: number }) => {
    stats.struckAt.set(id, at);
    stats.hits++;
    stats.struck.set(id, typeId);
    kit.struck.set(id, { typeId, ...(health ? { health } : {}) });
    ev?.push("hit");
    if (mobInfo(typeId).kind === "exploder") {
      // The struck creeper is thrown back: its close reading no longer says it stopped to swell.
      const fm = fuseOf(id);
      fm.struckAt = at;
      delete fm.closeAt;
    }
    if (id === target.id) hits++;
    if (crit) {
      stats.crits++;
      ev?.push("crit");
    }
  };
  /** A swing that struck nothing (or nothing hostile), or a click whose hit never showed. */
  const missed = () => {
    stats.misses++;
    ev?.push("miss");
  };
  /** Turned away from a burning creeper and sprinting, toward `runHeading`. */
  let running = false;
  /** Degrees turned aside from straight away while running (stuck against a wall), and the last progress check. */
  let runTurn = 0;
  let runCheck = { at: 0, x: 0, z: 0 };
  let runHeading = 0;
  const random = pc.camera.random;
  let strafe = random() < 0.5 ? 1 : -1;
  let strafeUntil = h.now() + 800 + random() * 800;
  /** The last tap of a step in to a creeper. */
  let stepTapAt = Number.NEGATIVE_INFINITY;
  /** A close-in on a lit creeper: forward until `until`, held as the strike attempt until its swing goes out. */
  let closeIn: { id: string; until: number } | undefined;
  /** The creeper whose burning fuse the escape was chosen on. */
  let fled: { id: string; back: boolean } | undefined;
  /** Against an archer: standing at the strike distance (see `HOLD_BAND`). */
  let standing = false;
  let moved = { at: h.now(), x: Number.NaN, z: Number.NaN };
  let lastPath = Number.NEGATIVE_INFINITY;
  /** Against an archer: the cover spot being run to, the ones already reached, and when the grid was last read. */
  let cover: { x: number; y: number; z: number } | undefined;
  const usedCover = new Set<string>();
  let coverScan = Number.NEGATIVE_INFINITY;
  const nav = ctx.nav;
  const block = async (on: boolean) => {
    if (on === ctx.blocking) return;
    ctx.blocking = on;
    if (on) ctx.guardSince = h.now();
    await h.move({ sneak: on });
  };
  /**
   * Walking in on the target: note headway, jump after a while without it, and when the straight walk stays blocked
   * (a wall, a ledge, a hole) find a way over the blocks, then fight on. `lowerShield` lets go of the shield first.
   */
  const unstick = async (s: PlayerState, e: EntityInfo, now: number, lowerShield: boolean): Promise<void> => {
    if (!(Math.hypot(s.location.x - moved.x, s.location.z - moved.z) < 0.3)) moved = { at: now, x: s.location.x, z: s.location.z };
    else if (now - moved.at > 600 && s.onGround) {
      await h.jump(120);
      ev?.push("jump");
    }
    const ledge = Math.abs(e.location.y - s.location.y) > 1.2;
    if (pc.world.query && now - moved.at > (ledge ? 700 : 1500) && now - lastPath > 2500) {
      lastPath = now;
      if (lowerShield) await block(false);
      await navigate(pc, { entity: target.id }, { radius: PLAYER_REACH - 0.2, timeoutMs: Math.min(8000, Math.max(1000, ctx.deadline - now)) }, signal);
      h.track(f, aimHeight, 10);
      moved = { at: h.now(), x: Number.NaN, z: Number.NaN };
    }
  };
  const fits = (m: EntityInfo) => !ctx.skip.has(m.id) && (ctx.wanted ? m.typeId === ctx.wanted : isHostile(m.typeId)) && (m.health === undefined || m.health.current > 0);
  try {
    for (;;) {
      if (f.failure) throw f.failure;
      ev = stats.trace ? [] : undefined;
      if (f.gone) {
        // A mob gone right after a click died of it (a creeper may have blown up instead, unless its health showed 0).
        const p = ctx.pending;
        if (p && p.id === target.id) {
          if (!exploder || (f.last.health !== undefined && f.last.health.current <= 0)) landed(p.id, target.typeId, p.at, p.crit);
          else missed();
          delete ctx.pending;
        }
        // A creeper that is gone without a kill blew up: what the fight saw before it.
        if (exploder && !(f.last.health && f.last.health.current <= 0)) logEvent(stats, `creeper gone after ${hits} hits`, ...ctx.frames.map((fr) => `  ${fr.at - h.now()} ${fr.line}`));
        ctx.skip.add(target.id);
        const outcome = hits > 0 ? "dead" : "gone";
        if (!ctx.all) return { outcome };
        // The next one from the crowd: a melee mob is turned to inside the loop, anything else set up by the fight.
        const me = (await pc.world.state()).location;
        const next = ctx.crowd.filter(fits).sort((a, b) => horizontalDistance(me, a.location) - horizontalDistance(me, b.location))[0];
        if (!next) return { outcome };
        if (mobInfo(next.typeId).kind !== "melee" || exploder) return { outcome, next };
        if (!(await turnTo(next))) return { outcome };
        await h.sleep(25, signal);
        continue;
      }
      const now = h.now();
      if (now > ctx.deadline) return { outcome: "timeout" };
      // Where the client has the player now (the keyboard route's stream shows it 150 to 250 ms late).
      const s = pc.camera.present(await pc.world.state());
      const lost = s.health !== undefined && ctx.lastHealth !== undefined && s.health < ctx.lastHealth ? ctx.lastHealth - s.health : 0;
      if (lost > 0) {
        ctx.hurtAt = now;
        stats.hitsTaken++;
        stats.damageTaken += lost;
        ev?.push("hurt");
      }
      if (s.health !== undefined) ctx.lastHealth = s.health;
      // The off-hand item's durability went up: the raised shield took a hit.
      const blockedNow = s.offhandDamage !== undefined && ctx.lastOffhand !== undefined && s.offhandDamage > ctx.lastOffhand;
      if (blockedNow) {
        stats.blocked++;
        ev?.push("block");
      }
      if (s.offhandDamage !== undefined) ctx.lastOffhand = s.offhandDamage;
      const e = f.last;
      const dist = horizontalDistance(s.location, e.location);
      const dist3 = Math.hypot(e.location.x - s.location.x, e.location.y - s.location.y, e.location.z - s.location.z);
      const toward = yawTo(s.location, e.location);
      const view = pc.camera.view()?.yaw ?? s.rotation.y;
      const eyeDist = Math.hypot(e.location.x - s.location.x, e.location.y + aimHeight - s.location.y - EYE_HEIGHT, e.location.z - s.location.z);
      // The reported velocity is instant (blocks per tick); the follow's estimate smooths over 0.6 s.
      const vel = e.velocity ?? f.velocity();
      const closing = closingSpeed(s.location, e.location, vel, dist);
      if (s.onGround) delete ctx.airborneSince;
      else ctx.airborneSince ??= now;
      if (nav && now - ctx.navScan > 5000) {
        ctx.navScan = now;
        void nav.ensure({ x: s.location.x - 12, y: s.location.y - 2, z: s.location.z - 12 }, { x: s.location.x + 12, y: s.location.y + 3, z: s.location.z + 12 }, 30_000).catch(() => undefined);
      }
      /** Free run toward a heading on the blocks known around (all open while none are). */
      const clear = (yaw: number) => (nav ? clearRun(nav, s.location, yaw) : 6);
      // The crowd's positions are carried forward by their velocity since the poll; the target's come from the follow.
      const ticks = (now - ctx.crowdAt) / 50;
      const polled = ctx.crowd
        .filter((m) => !ctx.skip.has(m.id) || m.id === target.id)
        .map((m) => (m.id === target.id ? { ...m, location: e.location } : m.velocity ? { ...m, location: { x: m.location.x + m.velocity.x * ticks, y: m.location.y, z: m.location.z + m.velocity.z * ticks } } : m));
      const mobs = polled.some((m) => m.id === target.id) ? polled : [...polled, { ...target, location: e.location }];
      // What the footwork steers around: a creeper widely (its fuse lights within 3), the others by their reach.
      const avoid = mobs.map((m) => ({ location: m.location, ...(mobInfo(m.typeId).kind === "exploder" ? { clearance: CREEPER_START + 1 } : {}) }));
      // The other creepers around: remember when they came close or lit, for a later duel against them.
      for (const m of mobs) {
        if (m.id === target.id || mobInfo(m.typeId).kind !== "exploder") continue;
        const d = horizontalDistance(s.location, m.location);
        const v = m.velocity;
        const c = closingSpeed(s.location, m.location, v, d);
        trackFuse(fuseOf(m.id), now, d, c, m.ignited, mobInfo(m.typeId).fuseMs, v ? Math.hypot(v.x, v.z) * 20 : Math.abs(c), m.fuseTicks !== undefined ? m.fuseTicks * 50 + (m.ageMs ?? 0) + now - ctx.crowdAt : undefined);
      }
      // Where the game shows the view (engine: the streamed rotation, a tick old; keyboard: the predicted one) and how far
      // off the target it is: the hand strikes this tick only with the view within the tolerance of a mob.
      const aimNow = pc.camera.error();
      const targetAim = pc.input === "engine" ? aimNow.observed : aimNow.predicted;
      const shownYaw = pc.input === "engine" ? s.rotation.y : view;
      // The melee mobs as the pack footwork reads them: reach toward the player, attack clock, invulnerability.
      const near = mobs
        .filter((m) => mobInfo(m.typeId).kind === "melee" && (m.health === undefined || m.health.current > 0))
        .map((m): PackMob & { m: EntityInfo; info: MobInfo } => {
          const mi = mobInfo(m.typeId);
          const dx = s.location.x - m.location.x;
          const dz = s.location.z - m.location.z;
          const d = Math.hypot(dx, dz);
          const v = m.id === target.id ? vel : m.velocity;
          const bearing = yawTo(s.location, m.location);
          const off = angleDiff(view, bearing);
          const hittableMs = Math.max(0, (stats.struckAt.get(m.id) ?? Number.NEGATIVE_INFINITY) + HIT_COOLDOWN_MS - now);
          // The hand can strike it once its invulnerability is over and the view is on it: the camera's turn for that
          // angle (150 to 450 ms), plus the view's latency.
          const turnMs = Math.abs(off) > STRIKE_AIM_DEG ? turnDurationMs(Math.abs(off), 10) + pc.camera.latencyMs : 0;
          // The tolerance the swing uses: the mob's half width at its distance from the eye.
          const eyeD = Math.hypot(d, m.location.y + aimHeightOf(mi) - s.location.y - EYE_HEIGHT);
          const tol = Math.max(5, (Math.atan2(0.4, eyeD) * 180) / Math.PI);
          const aimed = m.id === target.id ? targetAim <= tol : Math.abs(angleDiff(shownYaw, bearing)) <= tol;
          return {
            m,
            info: mi,
            id: m.id,
            dist: d,
            bearing,
            offViewDeg: off,
            mobReach: meleeReach(mi, dx, dz),
            strikeInMs: Math.max(hittableMs, turnMs),
            closing: closingSpeed(s.location, m.location, v, d),
            speed: mi.speed,
            dueMs: Math.max(0, (nextAttack.get(m.id) ?? Number.NEGATIVE_INFINITY) - now),
            ...(nextAttack.has(m.id) ? { overdueMs: Math.max(0, now - (nextAttack.get(m.id) as number)) } : {}),
            hittableMs,
            strikeNow: hittableMs <= ctx.latencyMs && aimed,
            ...(mi.axe ? { axe: true } : {}),
            ...(holdsSpear(m) || stats.spears.has(m.id) ? { spear: true } : {}),
          };
        })
        .sort((a, b) => a.dist - b.dist);
      // An attack seen (a hit taken or blocked): the mob that made it restarts its clock. An arrow may have made a
      // hit when an archer has the player in range: then no melee mob is credited.
      if (lost > 0 || blockedNow) {
        const archer = lost > 0 && mobs.some((m) => mobInfo(m.typeId).kind === "ranged" && horizontalDistance(s.location, m.location) <= mobInfo(m.typeId).range);
        const by = archer ? [] : attackers(near, !(lost > 0));
        for (const id of by) nextAttack.set(id, nextAttackMs(now - HURT_SEEN_LAG_MS, !(lost > 0), near.find((n) => n.id === id)?.info.cooldownMs ?? MELEE_COOLDOWN_MS));
        if (blockedNow) ctx.blockedAt = now;
        // A melee mob that hurt the player from `SPEAR_LEARN_DIST` or more holds a spear, whatever the helper said (it
        // may not see mobs' hands): fought as one from then on. Live, a husk's spear hit from 2.3 to 2.9; a bare zombie's
        // readings at its hit are 1.6 to 2.5, median 2.0.
        // Only from a hurt the helper's log puts down to a melee attack (`entityAttack`) by a mob type that can carry
        // a spear: never an arrow, a blast or anything else (live `mixed`: a skeleton's arrows from 10 blocks marked the
        // zombies and broke the creeper's handling). The damager's id names the one mob; without it, its type's mobs
        // at that distance.
        if (lost > 0 && ctx.hurtTick !== undefined) {
          const log = await hurtLog(pc, ctx.hurtTick);
          if (log) {
            ctx.hurtTick = log.tick;
            for (const hurt of log.hurts) {
              if (hurt.cause !== "entityAttack" || !hurt.damager || !SPEAR_CARRIERS.has(hurt.damager)) continue;
              for (const n of near) {
                if (hurt.damagerId ? n.id !== hurt.damagerId : n.m.typeId !== hurt.damager) continue;
                if (n.dist < SPEAR_LEARN_DIST || n.dist > SPEAR_LEARN_MAX || n.spear || stats.spears.has(n.id)) continue;
                stats.spears.add(n.id);
                n.spear = true;
                if (!ev?.includes("spear: learned")) ev?.push("spear: learned");
                logEvent(stats, `${shortType(n.m.typeId)} ${n.id} hurt the player from ${n.dist.toFixed(2)}: taken to hold a spear`);
              }
            }
          }
        }
        if (lost > 0) logEvent(stats, `hurt ${lost.toFixed(1)} -> ${s.health} fighting ${shortType(target.typeId)}, credited ${by.map((id) => shortType(near.find((n) => n.id === id)?.m.typeId ?? "?")).join(", ") || "none"}`, ...ctx.frames.map((fr) => `  ${fr.at - now} ${fr.line}`));
      }
      if (mobs.length > 1) {
        const lit = new Set([...stats.creepers].filter(([, c]) => c.fuseSince !== undefined).map(([id]) => id));
        const pick = pickDuelTarget(s.location, target.id, mobs, now - ctx.hurtAt < HURT_MS, lit);
        const picked = pick !== target.id ? mobs.find((m) => m.id === pick) : undefined;
        const kind = (m: EntityInfo) => mobInfo(m.typeId).kind;
        // To or from a creeper or an archer: that duel sets itself up. Among melee mobs: the one the hand should strike.
        // Not on the duel's first tick: a switch back and forth then would spin without the clock moving.
        // And not within `SWITCH_HOLD_MS` of the last switch, unless it is to a burning or close creeper: two duels that
        // pick each other would flip every tick, and the feet with them.
        const urgent = picked !== undefined && kind(picked) === "exploder" && (lit.has(picked.id) || horizontalDistance(s.location, picked.location) < 4);
        if (picked && duelTicks > 0 && (kind(picked) !== "melee" || info.kind !== "melee") && (urgent || now - ctx.switchedAt >= SWITCH_HOLD_MS)) {
          ctx.switchedAt = now;
          return { outcome: "switch", next: picked };
        }
        if (info.kind === "melee") {
          const want = strikeTarget(near, target.id, ctx.latencyMs);
          const next = want !== target.id ? near.find((n) => n.id === want)?.m : undefined;
          if (next && (await turnTo(next))) {
            await h.sleep(25, signal);
            continue;
          }
        }
      }
      const ready = readyInMs(now, stats.struckAt.get(target.id) ?? Number.NEGATIVE_INFINITY, HIT_COOLDOWN_MS);
      const blockedLine = s.lookingAtEntity !== undefined && s.lookingAtEntity.id !== target.id && s.lookingAtEntity.distance < dist + 0.5;
      /** Swinging at the target is allowed this frame (a creeper only on `strike`, a spider only once it is down). */
      let mayStrike = true;
      /** The footwork chosen this frame, and why. */
      let foot: string;
      let why = "";
      const group = exploder ? crowdMove(s.location, { id: target.id, location: e.location }, mobs) : undefined;

      if (exploder) {
        const burnedMs = e.fuseTicks !== undefined ? e.fuseTicks * 50 + (e.ageMs ?? 0) + now - f.lastWall : undefined;
        const lit = trackFuse(fuse, now, dist3, closing, e.ignited, info.fuseMs, Math.hypot(vel.x, vel.z) * 20, burnedMs);
        // Its reach as a centre distance: where the eye is `STRIKE_REACH` from the aim point on its body.
        const dyEye = e.location.y + aimHeight - s.location.y - EYE_HEIGHT;
        const reach = Math.sqrt(Math.max(0, STRIKE_REACH * STRIKE_REACH - dyEye * dyEye)) + dist3 - dist;
        // Lit and still slowing: where it will stand once its walk has coasted out, from the box gap it lit at.
        const stand = lit && closing > CREEPER_STANDING ? creeperStandFrom(dist, closing, e.location.x - s.location.x, e.location.z - s.location.z) + dist3 - dist : undefined;
        const struckAgoMs = stats.struckAt.has(target.id) ? now - (stats.struckAt.get(target.id) as number) : undefined;
        const move = creeperMove({
          dist: dist3,
          lit,
          fuseMs: lit ? now - (fuse.fuseSince ?? now) : 0,
          readyInMs: ready,
          hasShield: kit.shield,
          closing,
          // Once the escape was chosen on this fuse it stays the one decision: no strike or step back into it.
          running: running || (lit && fled?.id === target.id),
          ...(lit && fled?.id === target.id && fled.back ? { backingOff: true } : {}),
          reach,
          lineBlocked: blockedLine,
          roomBehind: clear(toward + 180),
          ...(struckAgoMs !== undefined ? { struckAgoMs } : {}),
          ...(stand !== undefined ? { stand } : {}),
          ...(lit && closeIn?.id === target.id ? { committed: true } : {}),
        });
        if (!lit && fled?.id === target.id) fled = undefined;
        else if (lit && (move === "run" || move === "block") && !(fled?.id === target.id && fled.back)) fled = { id: target.id, back: move === "run" };
        // A strike attempt on a lit creeper holds until the swing went out or the move gives it up.
        if (closeIn && (closeIn.id !== target.id || (move !== "step" && move !== "strike"))) closeIn = undefined;
        mayStrike = move === "strike" || move === "step";
        foot = move;
        // One set of feet for both kinds: the pack's keep-out rule (no melee mob gets the player in its reach) holds
        // while the creeper is the target too, except for the strike itself and the escape from the fuse.
        // The keep-out reads the mobs by the estimate (`strikeInMs`), not this tick's aim: the view is on the creeper.
        const pack = near.length > 0 ? packMove({ mobs: near.map(({ strikeNow: _, ...m }) => m), stance: "kite", hasShield: false, latencyMs: ctx.latencyMs, view, room: clear }) : undefined;
        const keepOut = pack?.foot === "retreat" ? pack.heading : undefined;
        // Running from the fuse faces away from the creeper; everything else faces it.
        if (move !== "run" && running) {
          running = false;
          h.track(f, aimHeight, 10);
        }
        await block(move === "block");
        if (move === "run") {
          // Back straight off, the view kept on the creeper, at full backward input from this tick: backward is as fast
          // as forward (4.32), needs no turn, and with the hit's knockback puts the creeper past 7 blocks (the fuse goes
          // out) about 0.8 s after the hit. Live, turning round to sprint moved the player only 1.5 to 2 blocks in the
          // first second (the turn, no forward push while turning) and lost the creeper. The way back is the open one
          // nearest straight back, leaning only as far as walls and the other mobs require.
          // Backward or sideways (strafing is as fast), along the open heading; a hit's knockback gives 2 blocks free.
          const back = openHeading({ me: s.location, desired: toward + 180, spreadDeg: 90, mobs: avoid, clear, previous: runHeading });
          const need = CREEPER_STOP + CREEPER_MARGIN - dist - (struckAgoMs !== undefined && struckAgoMs < STRUCK_THROW_MS ? STRUCK_THROW : 0);
          if (!running && clear(back) >= Math.min(need, 5.5)) {
            runHeading = back;
            await h.walk(back, false);
          } else {
            // Not enough free run behind: turn toward the open heading straight away and sprint. Stuck all the same (a
            // mob or a block the grid missed), turn 75 degrees aside, and to the other side if that does not help either.
            if (!running) {
              running = true;
              runTurn = 0;
              runCheck = { at: now, x: s.location.x, z: s.location.z };
              h.look({ widthDeg: 20, aim: () => ({ yaw: runHeading, pitch: 5 }) });
            } else if (now - runCheck.at > RUN_CHECK_MS) {
              if (Math.hypot(s.location.x - runCheck.x, s.location.z - runCheck.z) < RUN_STUCK) runTurn = runTurn === 0 ? 75 * strafe : -runTurn;
              runCheck = { at: now, x: s.location.x, z: s.location.z };
            }
            runHeading = openHeading({ me: s.location, desired: toward + 180 + runTurn, spreadDeg: 120, mobs: avoid, clear, previous: runHeading });
            await h.walk(runHeading, Math.abs(angleDiff(view, runHeading)) < 40);
          }
        }
        // Backing off (the swing cooling down, or shielding from the blast): nearly straight back (a diagonal gains
        // too little on a creeper), leaning away from the other mobs when there are some.
        else if (move === "retreat" || move === "block") {
          const lean = group ? Math.max(-25, Math.min(25, angleDiff(toward + 180, group.heading))) : 0;
          await h.walk(openHeading({ me: s.location, desired: toward + 180 + lean, spreadDeg: 60, mobs: avoid, clear }), false);
        }
        // A melee mob about to have the player in its reach: back off from it, as the pack's footwork does.
        // (Also while `strike` only waits out another mob in the line: live in the simulator, a zombie walking into the
        // line took the swing and then hit the player standing there.)
        else if (keepOut !== undefined && (move !== "strike" || blockedLine)) {
          foot = `${move} keep-out`;
          // On a burning fuse the keep-out ends the strike attempt: the feet give ground from the zombie and then from
          // the creeper for the rest of this fuse, and the creeper is taken on its next approach (live, run 4 of
          // `mixed`: step and keep-out took turns every tick with a zombie at 2.3 to 2.8 until the creeper blew).
          if (lit) fled = { id: target.id, back: true };
          await h.walk(openHeading({ me: s.location, desired: keepOut, spreadDeg: 60, mobs: avoid, clear }), false);
        }
        // A creeper that comes on by itself is met standing: walking into it on top of the input latency would carry
        // the player inside its fuse range. With other melee mobs around it is waited for standing too (the keep-out
        // rule above backs off from them when they come close): it outruns zombies (2.5 to 2.8 blocks a second against
        // 2.3) and leads them by about a block, so it is struck first, and the backward escape outruns them all.
        else if (move === "approach" && group && crowdedCreeper(near, target.id, dist)) await h.walk(undefined);
        // A creeper that waits or backs off is closed in on, sprinting while it is more than 4 blocks away. With the
        // fuse reported, an unlit creeper is safe to walk up to at any distance; without the report one standing
        // within 4.5 blocks may be swelling, and one just struck may have lit as the hit landed, so neither is.
        else if (move === "approach") {
          const guessing = e.ignited === undefined;
          const walkIn = closing < CREEPER_STANDING && (!guessing || (dist > 4.5 && !(fuse.struckAt !== undefined && now - fuse.struckAt < STRUCK_WAIT_MS)));
          // Sprinting only while far: a sprint let go carries the player on for nearly a block.
          await h.walk(walkIn ? toward : undefined, walkIn && dist > SPRINT_TO && Math.abs(angleDiff(view, toward)) < 40);
        }
        // In reach: stand still and strike, so the run starts from where the strike stood.
        else if (move === "strike") await h.walk(undefined);
        // A standing creeper just beyond reach with the swing ready: walk (never sprint) in to it; the next tick in
        // reach is `strike`, which lets go of forward at once.
        else if (move === "step") {
          if (lit) {
            // Close the difference to where it will stand, while it still slows: forward for as many ticks as the gap
            // needs, then let go; the swing goes out the first tick the reading is inside reach. A new close-in only
            // after the reading caught up with the last one.
            if (!closeIn || now - closeIn.until >= CLOSE_IN_SETTLE_MS) {
              const gap = Math.min(dist3, stand ?? dist3) - reach + CLOSE_IN_MARGIN;
              closeIn = { id: target.id, until: now + closeInTicks(gap) * 50 };
            }
            await h.walk(now < closeIn.until ? toward : undefined, false);
          } else {
            // A standing unlit creeper: a tap, forward this tick only, the next after the reading caught up.
            const tap = now - stepTapAt >= STEP_TAP_MS;
            if (tap) stepTapAt = now;
            await h.walk(tap ? toward : undefined, false);
          }
        }
        else await h.walk(group ? openHeading({ me: s.location, desired: group.heading, spreadDeg: 60, mobs: avoid, clear }) : toward + 90 * strafe, false);
      } else if (info.kind === "melee") {
        const stance = ctx.stance;
        // `guard` steps out until its next block once its clocks left no window to swing in.
        if (ctx.stepOutSince !== undefined && (ctx.blockedAt > ctx.stepOutSince || now - ctx.stepOutSince > 2 * GUARD_STEP_OUT_MS)) delete ctx.stepOutSince;
        const mv = packMove({
          mobs: near,
          stance,
          ...(stance === "guard" && ctx.stepOutSince !== undefined ? { stepOut: true } : {}),
          hasShield: kit.shield,
          ...(ctx.blocking ? { guardMs: now - ctx.guardSince } : {}),
          ...(Number.isFinite(ctx.lastSwing) ? { swingAgoMs: now - ctx.lastSwing } : {}),
          latencyMs: ctx.latencyMs,
          view,
          room: clear,
          targetId: target.id,
        });
        // A leaping spider is waited for behind the shield, and struck once it is down.
        const airborne = info.climbs === true && spiderAirborne(vel.y, e.location.y - s.location.y);
        if (airborne) mayStrike = !(Math.abs(vel.y) > 0.25);
        foot = mv.foot;
        why = mv.reason;
        ctx.room = mv.room;
        await block(mv.shield || (airborne && dist < 3.5 && kit.shield));
        ctx.disciplined = mv.shield;
        if (mv.face !== undefined) {
          // A new yaw only when it moved: every new aim restarts the camera's turn.
          if (facing === undefined || Math.abs(angleDiff(facing, mv.face)) > 10) {
            const yaw = mv.face;
            facing = yaw;
            h.look({ widthDeg: 20, aim: () => ({ yaw, pitch: 10 }) });
          }
        } else if (facing !== undefined) {
          facing = undefined;
          h.track(f, aimHeight, 10);
        }
        await h.walk(mv.heading, mv.sprint && !ctx.blocking, mv.speed);
        if (mv.foot === "advance") await unstick(s, e, now, true);
        else moved = { at: now, x: s.location.x, z: s.location.z };
      } else {
        // Standing within the strike distance, walking in again only past it plus `HOLD_BAND`, so the feet do not flip
        // between the two every tick at the edge.
        standing = dist <= STRIKE_DIST || (standing && dist <= STRIKE_DIST + HOLD_BAND);
        foot = standing ? "hold" : "advance";
        await block(false);
        ctx.disciplined = false;
        if (dist > PLAYER_REACH + 0.5) {
          // From cover to cover toward an archer when the blocks around give some, else weave so its arrows miss.
          const grid = nav;
          if (grid && dist > 6) {
            if (now - coverScan > 1500) {
              coverScan = now;
              // The archer moves: choose again from what is known now.
              cover = undefined;
              const lo = { x: Math.min(s.location.x, e.location.x) - 6, y: s.location.y - 2, z: Math.min(s.location.z, e.location.z) - 6 };
              const hi = { x: Math.max(s.location.x, e.location.x) + 6, y: s.location.y + 3, z: Math.max(s.location.z, e.location.z) + 6 };
              void grid.ensure(lo, hi, 10_000).catch(() => undefined);
            }
            if (cover && Math.hypot(cover.x - s.location.x, cover.z - s.location.z) < 0.8) {
              usedCover.add(`${Math.floor(cover.x)},${Math.floor(cover.z)}`);
              cover = undefined;
            }
            cover ??= findCover(grid, s.location, e.location, usedCover);
          } else cover = undefined;
          const heading = cover ? yawTo(s.location, cover) : toward + weaveDeg(now, dist, info) + (blockedLine ? 60 : 0);
          await h.walk(heading, dist > 3.5 && !blockedLine && Math.abs(angleDiff(view, heading)) < 40);
          await unstick(s, e, now, false);
        } else {
          await h.walk(standing ? undefined : toward, false);
          moved = { at: now, x: s.location.x, z: s.location.z };
        }
      }

      // Hand: strike a hostile mob under the crosshair within reach whose invulnerability is over, jumping in place
      // first for a critical hit when no attack is due. The helper's crosshair reading lags 50 to 100 ms: on the
      // engine route the streamed view is one tick old, so any mob under it counts; on the keyboard it is 150 to 250
      // ms old (tens of degrees at close range), so only the target counts, by the predicted view.
      const camError = pc.camera.error();
      const aimError = pc.input === "engine" ? camError.observed : camError.predicted;
      const tolerance = Math.max(5, (Math.atan2(0.4, eyeDist) * 180) / Math.PI);
      const hittable = (id: string) => now - (stats.struckAt.get(id) ?? Number.NEGATIVE_INFINITY) >= HIT_COOLDOWN_MS;
      const look = s.lookingAtEntity;
      // A swing lands where the mob reads now, within `STRIKE_REACH` of the eye (to the aim point): no lead for its walk
      // (the reading is fresher than the latency, and the click runs within a frame; live, a closing lead sent 600 of
      // about 1000 misses at 3.05 or more). A melee mob also by its reading's centre distance, `strikeDistance` (2.9
      // walking in, 2.99 else). The eye distance keeps a swing from the top of a jump from going out (live, 58 of 69
      // swings in the air at 2.6 to 2.85 missed: the raised eye is out of reach of the aim point).
      // A spear mob backing off is struck from 2.8 (its reading lags behind it, as a walking-in one's lags ahead).
      const landsIn = (eye: number, centre: number, closingSpeed: number, isCreeper: boolean, spear = false) =>
        eye <= STRIKE_REACH && (isCreeper || centre <= (spear && closingSpeed < -WALKING_IN ? SPEAR_OPENING_STRIKE : strikeDistance(closingSpeed)));
      const eyeTo = (m: EntityInfo) => Math.hypot(m.location.x - s.location.x, m.location.y + 1.0 - s.location.y - EYE_HEIGHT, m.location.z - s.location.z);
      const lookedAt = pc.input === "engine" && look && look.id !== target.id ? near.find((n) => n.id === look.id) : undefined;
      const other = lookedAt && landsIn(eyeTo(lookedAt.m), lookedAt.dist, lookedAt.closing, false, lookedAt.spear === true) ? lookedAt.m : undefined;
      const inStrike = landsIn(eyeDist, dist, closing, exploder, near.find((n) => n.id === target.id)?.spear === true);
      const aimedAt = look?.id === target.id && inStrike && aimError <= tolerance * 2;
      // With the view on the target (before the helper's crosshair reading shows it), the distance decides.
      const aimedClose = inStrike && aimError <= tolerance;
      // A keyboard click is judged by the struck mob's health reading.
      const p = ctx.pending;
      if (p) {
        const outcome = swingOutcome(p, now, healthOf(p.id));
        if (outcome === "hit") {
          const mt = p.id === target.id ? target.typeId : (mobs.find((m) => m.id === p.id)?.typeId ?? target.typeId);
          landed(p.id, mt, p.at, p.crit);
          delete ctx.pending;
        } else if (outcome === "miss") {
          missed();
          delete ctx.pending;
        }
        // Probably a miss: the hand may swing again before the invulnerability a hit would have started is over.
        else if (outcome === "doubt" && stats.struckAt.get(p.id) === p.at) {
          if (p.previous === undefined) stats.struckAt.delete(p.id);
          else stats.struckAt.set(p.id, p.previous);
        }
      }
      // A swing lowers the raised shield for 650 ms: from behind it only when no covered mob can attack meanwhile.
      // With no such window for `NO_WINDOW_MS`, one strike right after a block, shield down (see `NO_WINDOW_MS`).
      const windowNow = !ctx.blocking || !ctx.disciplined || shieldSwingOk(near, ctx.latencyMs);
      if (windowNow) delete ctx.noWindowSince;
      else ctx.noWindowSince ??= now;
      const stalled = ctx.noWindowSince !== undefined ? now - ctx.noWindowSince : 0;
      // `guard` steps out after `GUARD_STEP_OUT_MS` behind the shield without a swing (the windows its clocks leave are
      // too rare or too short to strike in), when there is room.
      const unswung = ctx.blocking && ctx.disciplined ? now - Math.max(ctx.lastSwing, ctx.guardSince) : 0;
      if (ctx.stance === "guard" && unswung >= GUARD_STEP_OUT_MS && ctx.room >= ROOM_NEEDED && ctx.stepOutSince === undefined) ctx.stepOutSince = now;
      const forced = !windowNow && stalled >= NO_WINDOW_MS && ctx.room < ROOM_NEEDED && now - ctx.blockedAt <= AFTER_BLOCK_MS;
      const shieldOpen = windowNow || forced;
      const onTarget = shieldOpen && mayStrike && (aimedAt || aimedClose) && hittable(target.id);
      const strikeAt = onTarget ? target : shieldOpen && other && hittable(other.id) ? other : undefined;
      // Critical hits only when no melee mob can attack before the falling swing (the jump leaves the player unable to
      // swing for its rise), never from behind the shield, and in place: a jump forward lands in the mob's reach.
      // Never against a spear mob near: the jump holds the player in place for its charge.
      const critsNow = ctx.crits && !exploder && !info.climbs && !near.some((n) => n.spear && n.dist < 8) && !ctx.blocking && isolated(s.location, target.id, mobs) && critSafe(near.map((n) => ({ ...n, closing: Math.max(n.closing, n.speed), coolMs: n.dueMs })));
      const plan = meleePlan({
        now,
        lastHit: stats.struckAt.get((strikeAt ?? target).id) ?? Number.NEGATIVE_INFINITY,
        onGround: s.onGround,
        vy: s.velocity.y,
        ...(ctx.airborneSince !== undefined ? { airborneSince: ctx.airborneSince } : {}),
        inReach: strikeAt !== undefined,
        // Jump for a crit only facing the target, so the fall is not wasted turning.
        nearReach: eyeDist <= STRIKE_REACH + 0.6 && aimError <= 15,
        crits: critsNow,
      });
      if (plan === "jump") {
        // One jump per crit: the plan says `jump` until the readings show the player off the ground.
        if (now - ctx.jumpAt >= JUMP_ONCE_MS) {
          ctx.jumpAt = now;
          await h.walk(undefined);
          await h.jump(120);
          ev?.push("jump");
        }
      } else if ((plan === "swing" || plan === "crit") && strikeAt && now - ctx.lastSwing >= MIN_SWING_GAP_MS) {
        if (forced) {
          await block(false);
          delete ctx.noWindowSince;
        }
        const crit = !s.onGround && s.velocity.y < 0;
        const struck = await h.swing();
        ctx.lastSwing = now;
        // The strike attempt on a creeper ends with its swing.
        closeIn = undefined;
        stats.swings++;
        ev?.push("swing");
        if (struck === undefined) {
          // The keyboard: judged by the target's health reading (see `swingOutcome`). Until then a melee mob is
          // taken as struck, so the footwork backs off while the swing cools down. A creeper is not: a strike that
          // missed must not send the player back as if it had landed, so the next swing follows as it walks in.
          const health = healthOf(strikeAt.id);
          if (health === undefined) landed(strikeAt.id, strikeAt.typeId, now, crit);
          else {
            // A click still unjudged is dropped: its hit never showed.
            if (ctx.pending) missed();
            const previous = stats.struckAt.get(strikeAt.id);
            ctx.pending = { id: strikeAt.id, at: now, health, crit, ...(previous !== undefined ? { previous } : {}) };
            if (mobInfo(strikeAt.typeId).kind !== "exploder") stats.struckAt.set(strikeAt.id, now);
          }
        } else {
          const hit = struck ? mobs.find((m) => m.id === struck) : undefined;
          if (hit) landed(hit.id, hit.typeId, now, crit, hit.id === target.id ? f.last.health : hit.health);
          else missed();
        }
      }
      const mv = h.movement();
      const others = [
        ...near
          .filter((n) => n.id !== target.id)
          .map((n) => `${shortType(n.m.typeId)} ${n.dist.toFixed(2)}/${n.mobReach.toFixed(2)} due ${Math.round(n.dueMs)} off ${Math.round(n.offViewDeg)}`),
        ...mobs.filter((m) => m.id !== target.id && mobInfo(m.typeId).kind === "exploder").map((m) => `${shortType(m.typeId)} ${horizontalDistance(s.location, m.location).toFixed(2)}`),
      ];
      const self = near.find((n) => n.id === target.id);
      ctx.frames.push({
        at: now,
        line:
          `${shortType(target.typeId)} d ${dist.toFixed(2)}/${(self?.mobReach ?? 0).toFixed(2)} closing ${closing.toFixed(1)} ready ${Math.round(ready)} ` +
          `due ${Math.round(self?.dueMs ?? 0)}${e.ignited ? " ignited" : ""}${fuse.fuseSince !== undefined ? ` fuse ${now - fuse.fuseSince}` : ""} ` +
          `${foot}${why ? ` (${why})` : ""}${group ? ` group ${group.reason}` : ""} plan ${plan}${ctx.blocking ? " block" : ""} ` +
          `move ${mv.forward.toFixed(1)}/${mv.strafe.toFixed(1)}${mv.sprint ? " sprint" : ""} hp ${s.health ?? "?"} ` +
          `aim ${camError.observed.toFixed(1)}/${camError.predicted.toFixed(1)}/${tolerance.toFixed(1)} lat ${Math.round(pc.camera.latencyMs)}${ctx.pending ? ` pending ${now - ctx.pending.at}` : ""} ` +
          `eye ${eyeDist.toFixed(2)} look ${look ? `${look.id === target.id ? "target" : shortType(look.typeId)} ${look.distance.toFixed(2)}` : "none"}` +
          `${others.length ? ` | ${others.join(", ")}` : ""}`,
      });
      if (stats.trace) {
        const trackedMobs = mobs.map((m): TraceMob => {
          const n = near.find((x) => x.id === m.id);
          const d = n?.dist ?? horizontalDistance(s.location, m.location);
          const v = m.id === target.id ? vel : m.velocity;
          const c = n?.closing ?? closingSpeed(s.location, m.location, v, d);
          return {
            id: m.id,
            type: shortType(m.typeId),
            dist: round2(d),
            reach: round2(n?.mobReach ?? mobInfo(m.typeId).range),
            coolMs: Math.round(n ? attackInMs(n) : 0),
            offViewDeg: Math.round(angleDiff(view, yawTo(s.location, m.location)) * 10) / 10,
            closing: round2(c),
            target: m.id === target.id,
          };
        });
        traceFrame(stats, now, {
          x: round2(s.location.x),
          z: round2(s.location.z),
          ...(s.health !== undefined ? { hp: s.health } : {}),
          onGround: s.onGround,
          mobs: trackedMobs,
          foot,
          ...(group ? { group: group.reason } : {}),
          plan,
          readyMs: Math.round(ready),
          shield: ctx.blocking,
          ...(info.kind === "melee" ? { room: Math.round(ctx.room * 100) / 100 } : {}),
          aimErr: Math.round(aimError * 10) / 10,
          aimTol: Math.round(tolerance * 10) / 10,
          fwd: round2(mv.forward),
          strafe: round2(mv.strafe),
          sprint: mv.sprint,
          ...(ev?.length ? { ev } : {}),
          ...(lost > 0 ? { lost: Math.round(lost * 10) / 10 } : {}),
        });
      }
      while (ctx.frames.length > 0 && (ctx.frames[0]?.at ?? now) < now - (exploder ? CREEPER_FRAME_LOG_MS : FRAME_LOG_MS)) ctx.frames.shift();
      if (now > strafeUntil) {
        strafe = -strafe;
        strafeUntil = now + 700 + random() * 900;
      }
      duelTicks++;
      await h.sleep(25, signal);
    }
  } finally {
    // The last health reading of the target, for the kill count without a death log.
    const mine = kit.struck.get(target.id);
    if (mine && f.last.health) mine.health = f.last.health;
    // A creeper duel that ends any other way (a switch, a timeout, the tactic preempted): what it saw last.
    if (exploder && !f.gone) logEvent(stats, `creeper duel ended after ${hits} hits, ${stats.swings} swings in the run`, ...ctx.frames.map((fr) => `  ${fr.at - h.now()} ${fr.line}`));
    f.stop();
  }
}
