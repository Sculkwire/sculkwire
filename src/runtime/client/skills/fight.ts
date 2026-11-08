/**
 * `fight`: melee like a decent player. Hits a mob from the edge of reach and steps back out of its reach while the
 * swing cools down (Bedrock's 10-tick invulnerability), steps in again as the swing comes ready, sprint-hits with a
 * W-tap so every hit knocks back, jumps for critical hits against a lone mob, keeps a group in front so only one can
 * hit at a time, raises the shield when a hit cannot be avoided, keeps a creeper from lighting its fuse (about 3
 * blocks) and gets out past 7 blocks, shield up, once it burns, shoots a creeper from range when there is a bow, weaves
 * toward archers, waits for a leaping spider to land, and moves on to the next hostile.
 */
import { angleDiff, horizontalDistance, yawTo, type EntityInfo, type Loadout, type PlayerController } from "../player.ts";
import { navigate } from "../nav/navigate.ts";
import { CROWD_RADIUS, crowdMove, isolated, pickDuelTarget } from "./crowd.ts";
import { clearRun, CREEPER_START, creeperMove, critSafe, crowdedCreeper, findCover, type FuseMemory, LATENCY_MS, openHeading, readyInMs, shouldBlock, spacing, spiderAirborne, STRIKE_LEAD_S, trackFuse, weaveDeg, whoHit } from "./defense.ts";
import { gridFor } from "../nav/grid.ts";
import { bestWeaponSlot, bowSlot, hasShield } from "./items.ts";
import { HIT_COOLDOWN_MS, meleePlan, type PendingSwing, swingOutcome } from "./melee.ts";
import { isHostile, MELEE_COOLDOWN_MS, meleeReach, mobInfo, shortType } from "./mobs.ts";
import { combatStats, logEvent } from "./stats.ts";
import type { SkillResult } from "./types.ts";

export interface FightArgs {
  /** Entity id, or a type (`zombie`, `minecraft:zombie`). Default: the nearest hostile mob. */
  target?: string;
  /** Keep fighting the next hostile (of the type) after this one dies. Default true unless `target` is an id. */
  all?: boolean;
  /** Only targets within this many blocks (default 16). */
  radius?: number;
  /** Jump for critical hits (default true). */
  crits?: boolean;
  /** Switch to a closer mob, or the one hitting the player, mid-fight (default true). */
  retarget?: boolean;
  timeoutMs?: number;
}

const EYE_HEIGHT = 1.62;
/** Melee reach in Bedrock survival, from the eye. */
const REACH = 3;
/** Shortest time between two clicks, so a missed swing is not repeated every frame. */
const MIN_SWING_GAP_MS = 150;
/** Forward is let go this long after a sprint hit (W-tap), so the next hit sprints again and knocks back. */
const WTAP_MS = 120;
/** A bow is worth drawing on a creeper this far away; closer, the sword. */
const BOW_MIN_DISTANCE = 5;

export function isEntityId(s: string): boolean {
  return /^-?\d+$/.test(s);
}

export function typeIdOf(type: string): string {
  return type.includes(":") ? type : `minecraft:${type}`;
}

/** The nearest fight target: of `type` when given, else hostile; never one in `skip`. */
export async function pickTarget(pc: PlayerController, type: string | undefined, radius: number, skip: ReadonlySet<string> = new Set()): Promise<EntityInfo | undefined> {
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

/** Hold the hardest-hitting weapon in the hotbar. */
export async function equipWeapon(pc: PlayerController, signal?: AbortSignal, loadout?: Loadout): Promise<string | undefined> {
  const l = loadout ?? (await pc.world.loadout?.().catch(() => undefined));
  const best = l ? bestWeaponSlot(l.hotbar) : undefined;
  if (!best) return undefined;
  const me = await pc.world.state(300);
  if (me.selectedSlot !== best.slot) await pc.hands.selectSlot(best.slot, signal);
  return best.typeId;
}

interface Duel {
  outcome: "dead" | "gone" | "timeout" | "switch";
  hits: number;
  crits: number;
  /** The mob to fight instead (`switch`). */
  next?: EntityInfo;
}

/** How often the fighter looks around for the other mobs (the streamed list comes every tick). */
const CROWD_POLL_MS = 50;
/** Health lost this recently means something is hitting the player. */
const HURT_MS = 800;
/** A hit shows in the player state this long after it landed (at most): a mob's cooldown is counted from then. */
const HURT_SEEN_LAG_MS = 150;
/** How much of the fight before a hit the hurt log keeps (against a creeper: back to when its fuse was lit). */
const FRAME_LOG_MS = 1200;
const CREEPER_FRAME_LOG_MS = 2200;
/** After striking a creeper, wait this long for it to walk back before walking up to it (it may have lit). */
const STRUCK_WAIT_MS = 1500;
/** Running from a fuse: progress is checked this often, and less than `RUN_STUCK` blocks means something blocks the way. */
const RUN_CHECK_MS = 400;
const RUN_STUCK = 0.8;

interface Kit {
  shield: boolean;
  bow?: { slot: number; arrows: number };
}

export async function fight(pc: PlayerController, args: FightArgs, signal?: AbortSignal): Promise<SkillResult> {
  const h = pc.hands;
  const started = h.now();
  const deadline = started + (args.timeoutMs ?? 60_000);
  const radius = args.radius ?? 16;
  const byId = args.target !== undefined && isEntityId(args.target);
  const all = args.all ?? !byId;
  const type = byId ? undefined : args.target;
  let target = byId ? ((await pc.world.entity(args.target as string)) ?? undefined) : await pickTarget(pc, type, radius);
  if (!target) return { ok: false, message: byId ? `no entity ${args.target}` : `no ${type ? shortType(typeIdOf(type)) : "hostile mob"} within ${radius} blocks` };
  const loadout = await pc.world.loadout?.().catch(() => undefined);
  const kit: Kit = { shield: hasShield(loadout?.armor), ...(loadout && bowSlot(loadout.hotbar) ? { bow: bowSlot(loadout.hotbar) } : {}) };
  const weapon = await equipWeapon(pc, signal, loadout);
  const done: string[] = [];
  const skip = new Set<string>();
  let hits = 0;
  let crits = 0;
  let arrows = 0;
  const retarget = args.retarget ?? true;
  try {
    while (target) {
      if (kit.bow && mobInfo(target.typeId).kind === "exploder") {
        const shot = await archery(pc, target, kit.bow.slot, deadline, signal);
        arrows += shot.shots;
        if (shot.dead) {
          skip.add(target.id);
          done.push(shortType(target.typeId));
          if (!all) break;
          target = await pickTarget(pc, type, radius, skip);
          continue;
        }
        if (weapon) await equipWeapon(pc, signal);
      }
      const d = await duel(pc, target, deadline, args.crits ?? true, retarget, kit, signal);
      hits += d.hits;
      crits += d.crits;
      if (d.outcome === "switch" && d.next) {
        target = d.next;
        continue;
      }
      skip.add(target.id);
      if (d.outcome === "timeout") break;
      if (d.outcome === "dead") done.push(shortType(target.typeId));
      if (!all) break;
      target = await pickTarget(pc, type, radius, skip);
    }
  } finally {
    await h.move({ sneak: false });
    await h.stop();
  }
  const timedOut = h.now() > deadline;
  const killed = done.length ? `killed ${done.join(", ")}` : "killed nothing";
  const with_ = weapon ? ` with ${shortType(weapon)}` : "";
  return {
    ok: done.length > 0 || (!timedOut && hits > 0),
    message: `${killed}${with_}: ${hits} hit(s), ${crits} critical${arrows ? `, ${arrows} arrow(s)` : ""}, in ${((h.now() - started) / 1000).toFixed(1)} s${timedOut ? ", timed out" : ""}`,
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

/** One target until it dies, disappears or time runs out. */
async function duel(pc: PlayerController, target: EntityInfo, deadline: number, critsWanted: boolean, retarget: boolean, kit: Kit, signal?: AbortSignal): Promise<Duel> {
  const h = pc.hands;
  const stats = combatStats(pc);
  const attacks = stats.attacks;
  const info = mobInfo(target.typeId);
  const f = await h.follow(target.id);
  if (!f) return { outcome: "gone", hits: 0, crits: 0 };
  // The other hostile mobs around, read in the background: who is closest, who is flanking.
  let crowd: EntityInfo[] = [];
  let crowdAt = h.now();
  let watching = true;
  const watch = (async () => {
    while (watching && pc.world.entities) {
      const list = await pc.world.entities(CROWD_RADIUS + 3).catch(() => undefined);
      if (list) {
        crowd = list.filter((m) => m.typeId !== "minecraft:player" && isHostile(m.typeId) && m.health !== undefined);
        crowdAt = h.now();
      }
      await h.sleep(CROWD_POLL_MS).catch(() => undefined);
    }
  })();
  let lastHealth: number | undefined;
  let hurtAt = Number.NEGATIVE_INFINITY;
  /** The last fight frames, logged with each hit the player takes. */
  const frames: { at: number; line: string }[] = [];
  const exploder = info.kind === "exploder";
  // No jumping against a creeper (a jump lets it close in) or a spider (it leaps at the player).
  const crits = critsWanted && !exploder && !info.climbs;
  // Aim at the middle of the body: low for spiders and other small mobs, chest height for zombies and skeletons.
  const aimHeight = info.climbs ? 0.45 : 1.0;
  h.track(f, aimHeight, 10);
  let hits = 0;
  let critHits = 0;
  let lastHit = Number.NEGATIVE_INFINITY;
  let lastSwing = Number.NEGATIVE_INFINITY;
  /** A keyboard click waiting for the target's health reading, and the last hit before it in case it missed. */
  let pending: (PendingSwing & { crit: boolean; lastHit: number }) | undefined;
  let airborneSince: number | undefined;
  let wtapUntil = 0;
  let strafe = Math.random() < 0.5 ? 1 : -1;
  let strafeUntil = h.now() + 800 + Math.random() * 800;
  /** Each creeper's fuse as the fight takes it, shared with the later duels of this `play` run. */
  const fuseOf = (id: string): FuseMemory => {
    let m = stats.creepers.get(id);
    if (!m) stats.creepers.set(id, (m = {}));
    return m;
  };
  const fuse = fuseOf(target.id);
  /** A swing that struck the target. */
  const landed = (at: number, crit: boolean) => {
    lastHit = at;
    // The struck creeper is thrown back: its close reading no longer says it stopped to swell.
    fuse.struckAt = at;
    delete fuse.closeAt;
    hits++;
    stats.hits++;
    stats.struck.set(target.id, target.typeId);
    if (crit) {
      critHits++;
      stats.crits++;
    }
  };
  /** Turned away from a burning creeper and sprinting, toward `runHeading`. */
  let running = false;
  /** Degrees turned aside from straight away while running (stuck against a wall), and the last progress check. */
  let runTurn = 0;
  let runCheck = { at: 0, x: 0, z: 0 };
  let runHeading = 0;
  let blocking = false;
  let moved = { at: h.now(), x: Number.NaN, z: Number.NaN };
  let lastPath = Number.NEGATIVE_INFINITY;
  /** Against an archer: the cover spot being run to, the ones already reached, and when the grid was last read. */
  let cover: { x: number; y: number; z: number } | undefined;
  const usedCover = new Set<string>();
  let coverScan = Number.NEGATIVE_INFINITY;
  // The blocks around: walls and holes for the footwork, cover against an archer.
  const nav = pc.world.query ? gridFor(pc.world) : undefined;
  const grid = info.kind === "ranged" ? nav : undefined;
  let navScan = Number.NEGATIVE_INFINITY;
  const block = async (on: boolean) => {
    if (on === blocking) return;
    blocking = on;
    await h.move({ sneak: on });
  };
  try {
    for (;;) {
      if (f.failure) throw f.failure;
      if (f.gone) {
        // A mob gone right after a click died of it (a creeper may have blown up instead).
        if (pending && !exploder) landed(pending.at, pending.crit);
        // A creeper that is gone without a kill blew up: what the fight saw before it.
        if (exploder && !(f.last.health && f.last.health.current <= 0)) logEvent(stats, `creeper gone after ${hits} hits`, ...frames.map((fr) => `  ${fr.at - h.now()} ${fr.line}`));
        return { outcome: hits > 0 ? "dead" : "gone", hits, crits: critHits };
      }
      const now = h.now();
      if (now > deadline) return { outcome: "timeout", hits, crits: critHits };
      // Where the client has the player now (the keyboard route's stream shows it 150 to 250 ms late).
      const s = pc.camera.present(await pc.world.state());
      const lost = s.health !== undefined && lastHealth !== undefined && s.health < lastHealth ? lastHealth - s.health : 0;
      if (lost > 0) hurtAt = now;
      if (s.health !== undefined) lastHealth = s.health;
      const e = f.last;
      const dist = horizontalDistance(s.location, e.location);
      const dist3 = Math.hypot(e.location.x - s.location.x, e.location.y - s.location.y, e.location.z - s.location.z);
      const toward = yawTo(s.location, e.location);
      const view = pc.camera.view()?.yaw ?? s.rotation.y;
      const eyeDist = Math.hypot(e.location.x - s.location.x, e.location.y + aimHeight - s.location.y - EYE_HEIGHT, e.location.z - s.location.z);
      // The reported velocity is instant (blocks per tick); the follow's estimate smooths over 0.6 s.
      const vel = e.velocity ?? f.velocity();
      const closing = dist > 0.01 ? ((vel.x * (s.location.x - e.location.x) + vel.z * (s.location.z - e.location.z)) / dist) * 20 : 0;
      if (s.onGround) airborneSince = undefined;
      else airborneSince ??= now;
      if (nav && now - navScan > 5000) {
        navScan = now;
        void nav.ensure({ x: s.location.x - 12, y: s.location.y - 2, z: s.location.z - 12 }, { x: s.location.x + 12, y: s.location.y + 3, z: s.location.z + 12 }, 30_000).catch(() => undefined);
      }
      /** Free run toward a heading on the blocks known around (all open while none are). */
      const clear = (yaw: number) => (nav ? clearRun(nav, s.location, yaw) : 6);
      // With others around: the closest mob, or the one hitting the player, is the one to fight. The crowd's
      // positions are carried forward by their velocity since the poll; the target's come from the follow.
      const ticks = (now - crowdAt) / 50;
      const polled = crowd.map((m) =>
        m.id === target.id ? { ...m, location: e.location } : m.velocity ? { ...m, location: { x: m.location.x + m.velocity.x * ticks, y: m.location.y, z: m.location.z + m.velocity.z * ticks } } : m,
      );
      const mobs = polled.some((m) => m.id === target.id) ? polled : [...polled, { ...target, location: e.location }];
      // What the footwork steers around: a creeper widely (its fuse lights within 3), the others by their reach.
      const avoid = mobs.map((m) => ({ location: m.location, ...(mobInfo(m.typeId).kind === "exploder" ? { clearance: CREEPER_START + 1 } : {}) }));
      // The other creepers around: remember when they came close or lit, for a later duel against them.
      for (const m of mobs) {
        if (m.id === target.id || mobInfo(m.typeId).kind !== "exploder") continue;
        const d = horizontalDistance(s.location, m.location);
        const v = m.velocity;
        const c = v && d > 0.01 ? ((v.x * (s.location.x - m.location.x) + v.z * (s.location.z - m.location.z)) / d) * 20 : 0;
        trackFuse(fuseOf(m.id), now, d, c, m.ignited, mobInfo(m.typeId).fuseMs, v ? Math.hypot(v.x, v.z) * 20 : Math.abs(c), m.fuseTicks !== undefined ? m.fuseTicks * 50 + (m.ageMs ?? 0) + now - crowdAt : undefined);
      }
      // The melee mobs: their box reach toward the player, and how long until each can attack again.
      const near = mobs
        .filter((m) => mobInfo(m.typeId).kind === "melee")
        .map((m) => {
          const mi = mobInfo(m.typeId);
          const dx = s.location.x - m.location.x;
          const dz = s.location.z - m.location.z;
          const d = Math.hypot(dx, dz);
          const v = m.id === target.id ? vel : m.velocity;
          return { m, id: m.id, info: mi, dist: d, mobReach: meleeReach(mi, dx, dz), closing: v && d > 0.01 ? ((v.x * dx + v.z * dz) / d) * 20 : 0, coolMs: 0 };
        })
        .sort((a, b) => a.dist - b.dist);
      if (lost > 0) {
        // An arrow may have done it when an archer has the player in range: then no melee mob is credited.
        const archer = mobs.some((m) => mobInfo(m.typeId).kind === "ranged" && horizontalDistance(s.location, m.location) <= mobInfo(m.typeId).range);
        const by = archer ? undefined : whoHit(near);
        if (by) attacks.set(by, now - HURT_SEEN_LAG_MS);
        logEvent(stats, `hurt ${lost.toFixed(1)} -> ${s.health} in duel ${shortType(target.typeId)}, credited ${by ? shortType(near.find((n) => n.id === by)?.m.typeId ?? "?") : "none"}`, ...frames.map((fr) => `  ${fr.at - now} ${fr.line}`));
      }
      for (const n of near) n.coolMs = Math.max(0, (attacks.get(n.id) ?? Number.NEGATIVE_INFINITY) + (n.info.cooldownMs ?? MELEE_COOLDOWN_MS) - now);
      if (retarget && mobs.length > 1) {
        const lit = new Set([...stats.creepers].filter(([, c]) => c.fuseSince !== undefined).map(([id]) => id));
        const pick = pickDuelTarget(s.location, target.id, mobs, now - hurtAt < HURT_MS, lit);
        const next = pick !== target.id ? mobs.find((m) => m.id === pick) : undefined;
        if (next) return { outcome: "switch", next, hits, crits: critHits };
      }
      const group = crowdMove(s.location, { id: target.id, location: e.location }, mobs);
      const ready = readyInMs(now, lastHit, HIT_COOLDOWN_MS);
      if (now > strafeUntil) {
        strafe = -strafe;
        strafeUntil = now + 700 + Math.random() * 900;
      }
      const blocked = s.lookingAtEntity !== undefined && s.lookingAtEntity.id !== target.id && s.lookingAtEntity.distance < dist + 0.5;
      const backHeading = toward + 180 - 30 * strafe;
      /** Swinging is allowed this frame (a creeper only on `strike`, a spider only once it is down). */
      let mayStrike = true;
      /** The footwork chosen this frame, for the hurt log. */
      let foot: string;

      if (exploder) {
        const burnedMs = e.fuseTicks !== undefined ? e.fuseTicks * 50 + (e.ageMs ?? 0) + now - f.lastWall : undefined;
        const lit = trackFuse(fuse, now, dist3, closing, e.ignited, info.fuseMs, Math.hypot(vel.x, vel.z) * 20, burnedMs);
        const move = creeperMove({ dist: dist3, lit, fuseMs: lit ? now - (fuse.fuseSince ?? now) : 0, readyInMs: ready, hasShield: kit.shield, closing, running });
        mayStrike = move === "strike";
        foot = move;
        // Running from the fuse faces away from the creeper; everything else faces it.
        if (move !== "run" && running) {
          running = false;
          h.track(f, aimHeight, 10);
        }
        await block(move === "block");
        if (move === "run") {
          // Turn away and sprint: backing off (about 3.3 blocks a second in the bench) is too slow to get from 3 to 7
          // blocks within the fuse. The way is the open one (no wall, hole or water on the blocks known), around the
          // other mobs rather than through them. Stuck all the same (a mob or a block the grid missed), turn 75
          // degrees aside, and to the other side if that does not help either.
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
        } else if (now < wtapUntil) await h.walk(undefined);
        // Backing off (the swing cooling down, or shielding from the blast): nearly straight back (a diagonal gains
        // too little on a creeper), leaning away from the other mobs when there are some.
        else if (move === "retreat" || move === "block") {
          const lean = group ? Math.max(-25, Math.min(25, angleDiff(toward + 180, group.heading))) : -30 * strafe;
          await h.walk(openHeading({ me: s.location, desired: toward + 180 + lean, spreadDeg: 60, mobs: avoid, clear }), false);
        }
        // A creeper that comes on by itself is met standing: walking into it on top of the input latency
        // would carry the player inside its fuse range. With other melee mobs in the way or about to reach the
        // player, back off from them instead: the creeper (2.5 to 2.8 blocks a second) outruns zombies (2.3), so it
        // comes out ahead of them, and the player (4.3 backward) keeps clear of both.
        else if (move === "approach" && group && crowdedCreeper(near, target.id, dist)) await h.walk(openHeading({ me: s.location, desired: group.heading, spreadDeg: 60, mobs: avoid, clear }), false);
        // A creeper that waits or backs off is closed in on, sprinting while it is more than 4 blocks away. With the
        // fuse reported, an unlit creeper is safe to walk up to at any distance; without the report one standing
        // within 4.5 blocks may be swelling, and one just struck may have lit as the hit landed, so neither is.
        else if (move === "approach") {
          const guessing = e.ignited === undefined;
          const walkIn = closing < 1 && (!guessing || (dist > 4.5 && !(fuse.struckAt !== undefined && now - fuse.struckAt < STRUCK_WAIT_MS)));
          await h.walk(walkIn ? toward : undefined, walkIn && dist > 4 && Math.abs(angleDiff(view, toward)) < 40);
        }
        else if (move === "strike") await h.walk(undefined);
        else await h.walk(group ? openHeading({ me: s.location, desired: group.heading, spreadDeg: 60, mobs: avoid, clear }) : toward + 90 * strafe, false);
      } else {
        const airborne = info.climbs === true && spiderAirborne(vel.y, e.location.y - s.location.y);
        const self = near.find((n) => n.id === target.id);
        foot = spacing({
          dist,
          readyInMs: ready,
          mobReach: self?.mobReach ?? 1,
          closing: Math.max(closing, info.kind === "melee" ? info.speed : 0),
          ...(self ? { mobCoolMs: self.coolMs } : {}),
        });
        const nearest = near[0];
        const stuck = Math.hypot(s.location.x - moved.x, s.location.z - moved.z) < 0.15 && now - moved.at > 500;
        await block(
          (airborne && dist < 3.5 && kit.shield) ||
            shouldBlock({
              hasShield: kit.shield,
              readyInMs: ready,
              cornered: stuck,
              ...(nearest
                ? {
                    melee: {
                      dist: nearest.dist,
                      mobReach: nearest.mobReach,
                      closing: Math.max(0, nearest.closing),
                      offViewDeg: angleDiff(view, yawTo(s.location, nearest.m.location)),
                      coolMs: nearest.coolMs,
                      ...(nearest.info.axe ? { axe: true } : {}),
                    },
                  }
                : {}),
            }),
        );
        if (airborne) mayStrike = !(Math.abs(vel.y) > 0.25);
        if (now < wtapUntil) await h.walk(undefined);
        // With others around, back off to the side while the swing cools down (so they line up in front); with the
        // swing ready, stand and let the target walk into reach, which is longer than its own.
        else if (group && (group.reason === "flanked" || foot === "retreat" || (foot === "hold" && ready > LATENCY_MS))) await h.walk(openHeading({ me: s.location, desired: group.heading, spreadDeg: 60, mobs: avoid, clear }), false);
        else if (foot === "retreat") await h.walk(openHeading({ me: s.location, desired: backHeading, spreadDeg: 45, mobs: avoid, clear }), false);
        else if (dist > REACH + 0.5) {
          // From cover to cover toward an archer when the blocks around give some, else weave so its arrows miss.
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
          const heading = cover ? yawTo(s.location, cover) : toward + weaveDeg(now, dist, info) + (blocked ? 60 : 0);
          await h.walk(heading, dist > 3.5 && !blocked && !blocking && Math.abs(angleDiff(view, heading)) < 40);
          if (!(Math.hypot(s.location.x - moved.x, s.location.z - moved.z) < 0.3)) moved = { at: now, x: s.location.x, z: s.location.z };
          else if (now - moved.at > 600 && s.onGround) await h.jump(120);
          // The straight walk is blocked (a wall, a ledge, a hole): find a way over the blocks, then fight on.
          const ledge = Math.abs(e.location.y - s.location.y) > 1.2;
          if (pc.world.query && now - moved.at > (ledge ? 700 : 1500) && now - lastPath > 2500) {
            lastPath = now;
            await block(false);
            await navigate(pc, { entity: target.id }, { radius: REACH - 0.2, timeoutMs: Math.min(8000, Math.max(1000, deadline - now)) }, signal);
            h.track(f, aimHeight, 10);
            moved = { at: h.now(), x: Number.NaN, z: Number.NaN };
          }
        } else if (foot === "advance") await h.walk(toward, !blocking && Math.abs(angleDiff(view, toward)) < 30);
        else await h.walk(ready > LATENCY_MS ? toward + 90 * strafe : undefined, false);
        if (dist <= REACH + 0.5 && !(Math.hypot(s.location.x - moved.x, s.location.z - moved.z) < 0.15)) moved = { at: now, x: s.location.x, z: s.location.z };
      }

      // Hand: hit when the target is in reach and its invulnerability is over, jumping first for a critical hit.
      // The helper's crosshair reading lags 50 to 100 ms, so it only counts while the camera is still on the target.
      // On the engine route the streamed view is one tick old. On the keyboard it is 150 to 250 ms old (tens of degrees
      // at close range), while the click lands after the mouse steps already sent: there the predicted view decides.
      const camError = pc.camera.error();
      const aimError = pc.input === "engine" ? camError.observed : camError.predicted;
      const tolerance = Math.max(5, (Math.atan2(0.4, eyeDist) * 180) / Math.PI);
      const aimedAt = s.lookingAtEntity?.id === target.id && s.lookingAtEntity.distance <= REACH + 0.2 && aimError <= tolerance * 2;
      // With the view on the target, the distance decides. Reach is to the hitbox, about 0.3 blocks short of the aim
      // point. A creeper walking in is taken where it will be when the swing lands.
      const lead = exploder ? Math.max(0, closing) * STRIKE_LEAD_S : 0;
      const aimedClose = eyeDist - lead <= REACH + 0.3 && aimError <= tolerance;
      // A keyboard click is judged by the target's health reading.
      if (pending) {
        const outcome = swingOutcome(pending, now, e.health?.current);
        if (outcome === "hit") {
          landed(pending.at, pending.crit);
          pending = undefined;
        } else if (outcome === "miss") pending = undefined;
        // Probably a miss: the hand may swing again before the invulnerability a hit would have started is over.
        else if (outcome === "doubt" && lastHit === pending.at) lastHit = pending.lastHit;
      }
      const plan = meleePlan({
        now,
        lastHit,
        onGround: s.onGround,
        vy: s.velocity.y,
        ...(airborneSince !== undefined ? { airborneSince } : {}),
        inReach: mayStrike && (aimedAt || aimedClose),
        // Jump for a crit only facing the target, so the fall is not wasted turning.
        nearReach: eyeDist <= REACH + 0.8 && aimError <= 15,
        // Crits only against a lone mob, and only when no melee mob can hit the player before the falling swing: the
        // jump leaves the player unable to swing for its rise.
        crits: crits && !blocking && isolated(s.location, target.id, mobs) && critSafe(near.map((n) => ({ ...n, closing: Math.max(n.closing, n.info.speed) }))),
      });
      if (plan === "jump") await h.jump(120);
      else if ((plan === "swing" || plan === "crit") && now - lastSwing >= MIN_SWING_GAP_MS) {
        // The shield goes down for the swing.
        await block(false);
        const sprinting = s.sprinting || h.movement().sprint;
        const crit = !s.onGround && s.velocity.y < 0;
        const struck = await h.swing();
        lastSwing = now;
        stats.swings++;
        if (struck === undefined) {
          // The keyboard: judged by the target's health reading (see `swingOutcome`). Until then a melee mob is
          // taken as struck, so the footwork backs off while the swing cools down. A creeper is not: a strike that
          // missed must not send the player back as if it had landed, so the next swing follows as it walks in.
          if (e.health === undefined) {
            if (aimedAt || aimedClose) landed(now, crit);
          } else {
            pending = { at: now, health: e.health.current, crit, lastHit };
            if (!exploder) lastHit = now;
          }
          if (sprinting) wtapUntil = now + WTAP_MS;
        } else {
          // The swing struck another mob in the way: it still counts for the kill tally.
          const other = struck ? mobs.find((m) => m.id === struck && m.id !== target.id) : undefined;
          if (other) {
            stats.hits++;
            stats.struck.set(other.id, other.typeId);
          }
          if (struck === target.id) {
            landed(now, crit);
            if (sprinting) wtapUntil = now + WTAP_MS;
          }
        }
      }
      const mv = h.movement();
      const others = [
        ...near
          .filter((n) => n.id !== target.id)
          .map((n) => `${shortType(n.m.typeId)} ${n.dist.toFixed(2)}/${n.mobReach.toFixed(2)} cool ${Math.round(n.coolMs)} off ${Math.round(angleDiff(view, yawTo(s.location, n.m.location)))}`),
        ...mobs.filter((m) => m.id !== target.id && mobInfo(m.typeId).kind === "exploder").map((m) => `${shortType(m.typeId)} ${horizontalDistance(s.location, m.location).toFixed(2)}`),
      ];
      frames.push({
        at: now,
        line:
          `${shortType(target.typeId)} d ${dist.toFixed(2)}/${(near.find((n) => n.id === target.id)?.mobReach ?? 0).toFixed(2)} closing ${closing.toFixed(1)} ready ${Math.round(ready)} ` +
          `cool ${Math.round(near.find((n) => n.id === target.id)?.coolMs ?? 0)}${e.ignited ? " ignited" : ""}${fuse.fuseSince !== undefined ? ` fuse ${now - fuse.fuseSince}` : ""} ` +
          `${foot}${group ? ` group ${group.reason}` : ""} plan ${plan}${blocking ? " block" : ""} ` +
          `move ${mv.forward.toFixed(1)}/${mv.strafe.toFixed(1)}${mv.sprint ? " sprint" : ""} hp ${s.health ?? "?"} ` +
          `aim ${camError.observed.toFixed(1)}/${camError.predicted.toFixed(1)}/${tolerance.toFixed(1)} lat ${Math.round(pc.camera.latencyMs)}${pending ? ` pending ${now - pending.at}` : ""} ` +
          `eye ${eyeDist.toFixed(2)} look ${s.lookingAtEntity ? `${s.lookingAtEntity.id === target.id ? "target" : shortType(s.lookingAtEntity.typeId)} ${s.lookingAtEntity.distance.toFixed(2)}` : "none"}` +
          `${others.length ? ` | ${others.join(", ")}` : ""}`,
      });
      while (frames.length > 0 && (frames[0]?.at ?? now) < now - (exploder ? CREEPER_FRAME_LOG_MS : FRAME_LOG_MS)) frames.shift();
      await h.sleep(25, signal);
    }
  } finally {
    watching = false;
    // A creeper duel that ends any other way (a switch, a timeout, the tactic preempted): what it saw last.
    if (exploder && !f.gone) logEvent(stats, `creeper duel ended after ${hits} hits, ${stats.swings} swings in the run`, ...frames.map((fr) => `  ${fr.at - h.now()} ${fr.line}`));
    f.stop();
    await watch;
    await h.move({ sneak: false });
    await h.stop();
  }
}
