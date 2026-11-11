import { describe, expect, it } from "vitest";
import type { PlayerInput } from "../launcher.ts";
import { PlayerController, type EntityInfo, type Loadout, type PlayerState, type PlayerWorld } from "../player.ts";
import { checkGoal, parseGoal } from "./goal.ts";
import { armorPoints, bestFoodSlot, bestWeaponSlot } from "./items.ts";
import { CRIT_GIVE_UP_MS, HIT_CONFIRM_MS, HIT_COOLDOWN_MS, HIT_DOUBT_MS, meleePlan, swingOutcome, type MeleeInput } from "./melee.ts";
import { play, type Death } from "./play.ts";
import { fightKills, type Struck } from "./fight.ts";
import { combatStats, MAX_TRACE_FRAMES, resetStats, traceFights, traceFrame, type TraceFrame } from "./stats.ts";
import { chooseTactic, scoreTactics, tacticKey } from "./tactics.ts";
import { ThreatTracker, type ThreatMap } from "./threat.ts";
import { escapeYaw } from "./flee.ts";
import { crowdMove, isolated, pickDuelTarget } from "./crowd.ts";
import { angleDiff } from "../player.ts";

function me(over: Partial<PlayerState> = {}): PlayerState {
  return {
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
    health: 20,
    holding: { typeId: "minecraft:iron_sword", amount: 1 },
    ...over,
  };
}

const mob = (id: string, type: string, x: number, z: number, over: Partial<EntityInfo> = {}): EntityInfo => ({
  id,
  typeId: `minecraft:${type}`,
  location: { x, y: 0, z },
  health: { current: 20, max: 20 },
  ...over,
});

const hotbar = [
  { typeId: "minecraft:iron_sword", amount: 1 },
  { typeId: "minecraft:cooked_beef", amount: 8 },
  null,
  null,
  null,
  null,
  null,
  null,
  null,
];
const ironArmor = ["head", "chest", "legs", "feet"].map((slot, i) => ({ slot, typeId: `minecraft:iron_${["helmet", "chestplate", "leggings", "boots"][i]}` }));
const kit = (hunger = 20): Loadout => ({ hotbar, hunger, armor: ironArmor });

function mapOf(entities: EntityInfo[], state: Partial<PlayerState> = {}, loadout: Loadout = kit()): ThreatMap {
  return new ThreatTracker().update(0, me(state), entities, loadout);
}

const killHostiles = parseGoal("kill the hostile mobs near you");

describe("items", () => {
  it("ranks weapons, food and armor", () => {
    expect(bestWeaponSlot([{ typeId: "minecraft:stone_sword", amount: 1 }, { typeId: "minecraft:diamond_sword", amount: 1 }, null])).toMatchObject({ slot: 2, damage: 7 });
    expect(bestWeaponSlot([{ typeId: "minecraft:dirt", amount: 1 }])).toBeUndefined();
    expect(armorPoints(ironArmor.map((a) => a.typeId))).toBe(15);
    const food = [{ typeId: "minecraft:rotten_flesh", amount: 4 }, { typeId: "minecraft:bread", amount: 2 }, { typeId: "minecraft:cooked_beef", amount: 1 }];
    expect(bestFoodSlot(food, 4)?.typeId).toBe("minecraft:cooked_beef");
    // Two missing points: bread wastes less than steak; rotten flesh only when it is all there is.
    expect(bestFoodSlot(food, 18)?.typeId).toBe("minecraft:bread");
    expect(bestFoodSlot([{ typeId: "minecraft:rotten_flesh", amount: 4 }], 10)?.typeId).toBe("minecraft:rotten_flesh");
    expect(bestFoodSlot(food, 20)).toBeUndefined();
  });
});

describe("threat map", () => {
  it("measures how fast mobs close in and estimates a creeper's fuse", () => {
    const t = new ThreatTracker();
    t.update(0, me(), [mob("z", "zombie", 0, 8), mob("c", "creeper", 5, 0)]);
    const m = t.update(500, me(), [mob("z", "zombie", 0, 7), mob("c", "creeper", 2.5, 0)]);
    const z = m.entities.find((e) => e.id === "z");
    expect(z?.approach).toBeCloseTo(2, 1);
    expect(m.entities.find((e) => e.id === "c")?.fuse).toEqual({ lit: true, ms: 0 });
    const later = t.update(1200, me(), [mob("z", "zombie", 0, 6), mob("c", "creeper", 2, 0)]);
    expect(later.entities.find((e) => e.id === "c")?.fuse).toEqual({ lit: true, ms: 700 });
    expect(later.hostiles[0]?.key).toBe("creeper_1");
    expect(later.entities.find((e) => e.id === "c")?.danger).toBe(1);
  });

  it("takes the reported velocity and ignition, drops players, and lists what vanished", () => {
    const t = new ThreatTracker();
    t.update(0, me(), [mob("z", "zombie", 0, 5, { velocity: { x: 0, y: 0, z: -0.1 } }), mob("p", "player", 1, 1)]);
    const m = t.update(100, me(), [mob("c", "creeper", 6, 0, { ignited: true })]);
    expect(m.entities.map((e) => e.id)).toEqual(["c"]);
    expect(m.entities[0]?.fuse?.lit).toBe(true);
    expect(m.vanished.map((e) => [e.id, e.approach])).toEqual([["z", 2]]);
  });

  it("reads the vitals from the loadout", () => {
    const m = mapOf([], { health: 12 }, kit(15));
    expect(m.vitals).toMatchObject({ health: 12, hunger: 15, armor: 15, heldDamage: 6, weapon: { slot: 1 }, food: { slot: 2, typeId: "minecraft:cooked_beef" } });
  });

  it("names the carried food at full hunger without offering to eat it", () => {
    // Live retail: steak in slot 2 at food 20/20 was reported as `Food: none`.
    const full = mapOf([], { health: 5 }, kit(20));
    expect(full.vitals).toMatchObject({ hunger: 20, armor: 15, weapon: { slot: 1 }, food: { slot: 2, typeId: "minecraft:cooked_beef" } });
    expect(scoreTactics(full, parseGoal("explore")).some((t) => t.kind === "eat")).toBe(false);
  });
});

describe("tactic scores", () => {
  it("fights the nearest of several zombies", () => {
    const m = mapOf([mob("far", "zombie", 0, 9), mob("near", "zombie", 3, 0), mob("mid", "zombie", 0, -5)]);
    const best = chooseTactic(scoreTactics(m, killHostiles));
    expect(best.kind).toBe("fight");
    expect(best.target?.id).toBe("near");
  });

  it("flees when nearly dead with a zombie close, and eats once it is safe", () => {
    const close = chooseTactic(scoreTactics(mapOf([mob("z", "zombie", 0, 3)], { health: 4 }, kit(16)), killHostiles));
    expect(close.kind).toBe("flee");
    const safe = chooseTactic(scoreTactics(mapOf([mob("z", "zombie", 0, 15)], { health: 4 }, kit(16)), killHostiles));
    expect(safe.kind).toBe("eat");
    const nothing = chooseTactic(scoreTactics(mapOf([], { health: 9 }, kit(19)), parseGoal("explore")));
    expect(nothing.kind).toBe("eat");
  });

  it("eats when hungry but not with a mob at hand, and never at a full food bar", () => {
    expect(chooseTactic(scoreTactics(mapOf([], {}, kit(6)), parseGoal("explore"))).kind).toBe("eat");
    expect(chooseTactic(scoreTactics(mapOf([mob("z", "zombie", 0, 3)], {}, kit(6)), killHostiles)).kind).toBe("fight");
    expect(scoreTactics(mapOf([], { health: 5 }, kit(20)), parseGoal("explore")).some((t) => t.kind === "eat")).toBe(false);
  });

  it("backs off from a creeper whose fuse has burned, and fights one that just came close", () => {
    const t = new ThreatTracker();
    t.update(0, me(), [mob("c", "creeper", 2, 0)]);
    const fresh = chooseTactic(scoreTactics(t.update(100, me(), [mob("c", "creeper", 2, 0)]), killHostiles));
    expect(fresh.kind).toBe("fight");
    const burning = t.update(700, me(), [mob("c", "creeper", 2, 0)]);
    const run = chooseTactic(scoreTactics(burning, killHostiles), "fight:c");
    expect(run.kind).toBe("flee");
    expect(run.target?.id).toBe("c");
    expect(run.score).toBeGreaterThanOrEqual(0.9);
  });

  it("walks to a reach goal, uses the item on goal targets not hit yet, and idles otherwise", () => {
    expect(chooseTactic(scoreTactics(mapOf([]), parseGoal("go to 10 64 -20"))).kind).toBe("goto");
    const cows = mapOf([mob("a", "cow", 0, 4), mob("b", "cow", 0, 8)]);
    const goal = parseGoal("hit every cow near you once with the held item");
    const first = chooseTactic(scoreTactics(cows, goal));
    expect([first.kind, first.target?.id]).toEqual(["use_on", "a"]);
    const second = chooseTactic(scoreTactics(cows, goal, { usedOn: new Map([["a", "minecraft:cow"]]) }));
    expect(second.target?.id).toBe("b");
    expect(chooseTactic(scoreTactics(mapOf([mob("a", "cow", 0, 4)]), killHostiles)).kind).toBe("idle");
  });

  it("keeps the running tactic unless another is clearly better, keeps one fight across targets, and honours the allow list", () => {
    const m = mapOf([mob("a", "zombie", 0, 3), mob("b", "zombie", 0, 3.5)]);
    const scored = scoreTactics(m, killHostiles);
    // A fight moves from mob to mob by itself: one tactic, started on the best-scored target.
    expect(tacticKey(chooseTactic(scored, "fight"))).toBe("fight");
    expect(chooseTactic(scored, "fight").target?.id).toBe("a");
    const cows = mapOf([mob("a", "cow", 0, 4), mob("b", "cow", 0, 4.5)]);
    const use = scoreTactics(cows, parseGoal("hit every cow near you once with the held item"));
    expect(tacticKey(chooseTactic(use, "use_on:b"))).toBe("use_on:b");
    expect(tacticKey(chooseTactic(use))).toBe("use_on:a");
    const noFight = scoreTactics(m, killHostiles, { allowed: new Set(["flee", "idle"]) });
    expect(noFight.map((t) => t.kind)).toEqual(["idle"]);
  });
});

describe("emergency", () => {
  it("preempts the running tactic at once", () => {
    const t = new ThreatTracker();
    t.update(0, me(), [mob("c", "creeper", 2, 0)]);
    const burning = scoreTactics(t.update(800, me(), [mob("c", "creeper", 2, 0)]), killHostiles);
    expect(chooseTactic(burning, "fight:c").kind).toBe("flee");
  });
});

describe("melee timing", () => {
  const base: MeleeInput = { now: 10_000, lastHit: 0, onGround: true, vy: 0, inReach: true, nearReach: true, crits: true };

  it("jumps shortly before the next hit is due and swings on the way down", () => {
    expect(meleePlan({ ...base, lastHit: base.now - HIT_COOLDOWN_MS + 450 })).toBe("wait");
    expect(meleePlan({ ...base, lastHit: base.now - HIT_COOLDOWN_MS + 300 })).toBe("jump");
    // Rising: hold the swing until the fall.
    expect(meleePlan({ ...base, onGround: false, vy: 0.3, airborneSince: base.now - 100 })).toBe("wait");
    expect(meleePlan({ ...base, onGround: false, vy: -0.15, airborneSince: base.now - 400 })).toBe("crit");
    // Falling but the target is still invulnerable: no wasted swing.
    expect(meleePlan({ ...base, lastHit: base.now - 200, onGround: false, vy: -0.15 })).toBe("wait");
  });

  it("gives up on a crit that does not come, and hits plainly without crits", () => {
    expect(meleePlan({ ...base, lastHit: base.now - HIT_COOLDOWN_MS - CRIT_GIVE_UP_MS - 1 })).toBe("swing");
    expect(meleePlan({ ...base, crits: false })).toBe("swing");
    expect(meleePlan({ ...base, crits: false, lastHit: base.now - 100 })).toBe("wait");
    expect(meleePlan({ ...base, crits: false, inReach: false })).toBe("wait");
    expect(meleePlan({ ...base, onGround: false, vy: 0, airborneSince: base.now - 1000 })).toBe("swing");
    expect(meleePlan({ ...base, nearReach: false, inReach: false })).toBe("wait");
  });

  it("judges a keyboard click by the target's health reading", () => {
    const p = { at: 1000, health: 20 };
    expect(swingOutcome(p, 1100, 20)).toBe("pending");
    expect(swingOutcome(p, 1250, 14)).toBe("hit");
    expect(swingOutcome(p, 1000 + HIT_DOUBT_MS, 20)).toBe("doubt");
    // A reading that drops late still makes it a hit.
    expect(swingOutcome(p, 1000 + HIT_CONFIRM_MS - 1, 17)).toBe("hit");
    expect(swingOutcome(p, 1000 + HIT_CONFIRM_MS, 20)).toBe("miss");
    expect(swingOutcome(p, 1000 + HIT_CONFIRM_MS, undefined)).toBe("miss");
  });
});

describe("goals", () => {
  it("reads common goals", () => {
    expect(killHostiles).toEqual({ kind: "kill", radius: 24 });
    expect(parseGoal("Kill 3 zombies")).toEqual({ kind: "kill", type: "minecraft:zombie", count: 3, radius: 24 });
    expect(parseGoal("kill all the skeletons")).toEqual({ kind: "kill", type: "minecraft:skeleton", radius: 24 });
    expect(parseGoal("kill the creeper")).toEqual({ kind: "kill", type: "minecraft:creeper", count: 1, radius: 24 });
    expect(parseGoal("kill two cave spiders")).toEqual({ kind: "kill", type: "minecraft:cave_spider", count: 2, radius: 24 });
    expect(parseGoal("walk to 10, -5")).toEqual({ kind: "reach", x: 10, z: -5, radius: 2 });
    expect(parseGoal("go to 10 64 -20")).toEqual({ kind: "reach", x: 10, y: 64, z: -20, radius: 2 });
    expect(parseGoal("hit every cow near you once with the held item")).toEqual({ kind: "use_on", type: "minecraft:cow", radius: 24 });
    expect(parseGoal("build a house")).toEqual({ kind: "free" });
  });

  it("checks kill, reach and use goals against the game", () => {
    const kills = new Map([["1", "minecraft:zombie"], ["2", "minecraft:zombie"], ["3", "minecraft:cow"]]);
    const none = new Map<string, string>();
    const zombieLeft = mapOf([mob("z", "zombie", 0, 5), mob("c", "cow", 0, 3)]);
    expect(checkGoal(parseGoal("kill 2 zombies"), { map: zombieLeft, kills, usedOn: none })).toMatchObject({ known: true, done: true, progress: "2 of 2 zombie killed" });
    expect(checkGoal(parseGoal("kill 3 zombies"), { map: zombieLeft, kills, usedOn: none }).done).toBe(false);
    expect(checkGoal(killHostiles, { map: zombieLeft, kills, usedOn: none })).toMatchObject({ done: false, progress: "2 hostile killed, 1 left within 24 blocks" });
    expect(checkGoal(killHostiles, { map: mapOf([mob("c", "cow", 0, 3)]), kills, usedOn: none }).done).toBe(true);
    expect(checkGoal(parseGoal("go to 1 1"), { map: zombieLeft, kills, usedOn: none }).done).toBe(true);
    const cows = mapOf([mob("a", "cow", 0, 3), mob("b", "cow", 0, 6)]);
    const hitCows = parseGoal("hit each cow once");
    expect(checkGoal(hitCows, { map: cows, kills, usedOn: new Map([["a", "minecraft:cow"]]) }).done).toBe(false);
    expect(checkGoal(hitCows, { map: cows, kills, usedOn: new Map([["a", "minecraft:cow"], ["b", "minecraft:cow"]]) })).toMatchObject({ done: true, progress: "2 cow hit, 0 left within 24 blocks" });
    expect(checkGoal(parseGoal("dance"), { map: cows, kills, usedOn: none }).known).toBe(false);
  });
});

describe("flee direction", () => {
  it("points away from the threats, the nearest weighing most", () => {
    // A zombie at +Z: run toward -Z (yaw 180).
    expect(Math.abs(escapeYaw({ x: 0, y: 0, z: 0 }, [{ location: { x: 0, y: 0, z: 3 }, weight: 1 }]) ?? 0)).toBeCloseTo(180, 0);
    const between = escapeYaw({ x: 0, y: 0, z: 0 }, [
      { location: { x: 0, y: 0, z: 2 }, weight: 1 },
      { location: { x: 0, y: 0, z: -8 }, weight: 1 },
    ]);
    expect(Math.abs(between ?? 0)).toBeCloseTo(180, 0);
    expect(escapeYaw({ x: 0, y: 0, z: 0 }, [])).toBeUndefined();
  });
});

/**
 * A fake game where nothing moves (so its mobs stand within the measured 3.0 strike reach): the crosshair stays on the
 * first entity, every click on it takes `damage` health, and a mob at 0
 * dies (removed, with a death record killed by the player). `deathQuery` answers the helper's `deaths` query on the
 * world, as the fight reads it.
 */
function fakeGame(entities: EntityInfo[], state: PlayerState = me(), damage = 20, deathQuery = false) {
  const deaths: Death[] = [];
  const clicks: number[] = [];
  let tick = 0;
  const aim = () => {
    const e = entities[0];
    if (e) state.lookingAtEntity = { id: e.id, typeId: e.typeId, distance: Math.hypot(e.location.x - state.location.x, e.location.z - state.location.z) };
    else delete state.lookingAtEntity;
  };
  const input: PlayerInput = {
    keyDown: async (k) => {
      if (/^[1-9]$/.test(k)) state.selectedSlot = Number(k);
    },
    keyUp: async () => {},
    look: async () => {},
    button: async (b, down) => {
      if (b !== 1 || !down) return;
      clicks.push(b);
      const target = entities.find((e) => e.id === state.lookingAtEntity?.id);
      if (!target?.health) return;
      target.health.current -= damage;
      if (target.health.current <= 0) {
        entities.splice(entities.indexOf(target), 1);
        deaths.push({ tick: ++tick, id: target.id, typeId: target.typeId, killer: "minecraft:player" });
        aim();
      }
    },
  };
  aim();
  const loadout: Loadout = { hotbar: [{ typeId: "minecraft:iron_sword", amount: 1 }, null, null, null, null, null, null, null, null], hunger: 20 };
  const world: PlayerWorld = {
    input,
    state: async () => structuredClone(state),
    entity: async (id) => structuredClone(entities.find((e) => e.id === id) ?? null),
    nearest: async () => structuredClone(entities[0] ?? null),
    impacts: async () => ({ tick: 0, impacts: [] }),
    entities: async () => structuredClone(entities),
    loadout: async () => loadout,
    ...(deathQuery
      ? {
          query: async (kind: string, params?: Record<string, unknown>) => {
            if (kind !== "deaths") throw new Error(`no ${kind} query in this fake`);
            return { tick, deaths: deaths.filter((d) => d.tick > Number(params?.since ?? -1)) };
          },
        }
      : {}),
  };
  const env = {
    controller: new PlayerController(world),
    entities: async () => structuredClone(entities),
    loadout: async () => loadout,
    deaths: async (since: number) => ({ tick, deaths: deaths.filter((d) => d.tick > since) }),
  };
  /** A death the helper logged now (not by this fight). */
  const logDeath = (d: Omit<Death, "tick">) => deaths.push({ tick: ++tick, ...d });
  return { env, clicks, state, entities, logDeath };
}

describe("play loop", () => {
  it("kills every hostile and stops on the built-in goal check", async () => {
    const game = fakeGame([mob("-11", "zombie", 0, 2.5), mob("-12", "zombie", 0, 2.8)]);
    const r = await play({ action: "play", goal: "kill the hostile mobs near you", durationMs: 15_000 }, game.env);
    expect(r).toMatchObject({ stoppedBy: "goal_done", goalCheck: { kind: "kill", known: true } });
    expect(r.stats).toMatchObject({ kills: 2, killed: { zombie: 2 }, hits: 2, misses: 0, hitsTaken: 0, blocked: 0, deaths: 0 });
    // One fight for both: it moves on to the next hostile by itself.
    expect(r.trace.map((t) => [t.action, t.target?.id])).toEqual([
      ["fight", "-11"],
      // Idles while the goal check confirms nothing is left.
      ["idle", undefined],
    ]);
    expect(game.entities).toEqual([]);
  });

  it("runs a goal the built-in checks cannot verify until the time limit", async () => {
    const r = await play({ action: "play", goal: "dance a little", durationMs: 1000, stepMs: 100 }, fakeGame([]).env);
    expect([r.stoppedBy, r.goalCheck.known]).toEqual(["timeout", false]);
    expect(r.message).toMatch(/time limit: the built-in checks cannot verify this goal/);
    expect(r.trace[0]).toMatchObject({ action: "idle", score: expect.any(Number), reason: expect.any(String) });
  });

  it("stops when the player dies and when the simulation is paused", async () => {
    const dead = fakeGame([], me({ health: 0 }));
    expect(await play({ action: "play", goal: "g" }, dead.env)).toMatchObject({ stoppedBy: "died", stats: { deaths: 1 } });
    const paused = fakeGame([]);
    const p = await play({ action: "play", goal: "g" }, { ...paused.env, paused: () => true });
    expect([p.stoppedBy, p.message]).toEqual(["error", expect.stringMatching(/paused/)]);
  });

  it("rejects unknown tactics in allow", async () => {
    await expect(play({ action: "play", goal: "g", allow: ["fly"] }, fakeGame([]).env)).rejects.toThrow(/unknown play tactic/);
  });
});

describe("fight results", () => {
  it("counts the player's kills from the death log, else what the fight struck that is gone", () => {
    const struck = new Map<string, Struck>([
      ["a", { typeId: "minecraft:husk", health: { current: 2, max: 20 } }],
      ["b", { typeId: "minecraft:husk", health: { current: 6, max: 20 } }],
      ["c", { typeId: "minecraft:creeper", health: { current: 20, max: 20 } }],
      ["d", { typeId: "minecraft:zombie" }],
    ]);
    // Husk a died of the last blow before the fight turned to husk b; the creeper blew up.
    const deaths: Death[] = [
      { tick: 5, id: "a", typeId: "minecraft:husk", killer: "minecraft:player" },
      { tick: 9, id: "b", typeId: "minecraft:husk", killer: "minecraft:player" },
      { tick: 9, id: "c", typeId: "minecraft:creeper", cause: "entityExplosion" },
    ];
    expect(fightKills(deaths, struck, new Set())).toEqual({ husk: 2 });
    expect(fightKills(undefined, struck, new Set(["a", "b", "c"]))).toEqual({ husk: 2 });
    expect(fightKills(undefined, struck, new Set(["a", "b", "c", "d"]))).toEqual({ husk: 2, zombie: 1 });
  });

  it("reports kills from the helper's death log since the fight started, and every swing as a hit or a miss", async () => {
    const game = fakeGame([mob("-41", "zombie", 0, 2.5), mob("-42", "zombie", 0, 2.8)], me(), 20, true);
    // Killed before the fight: not its kill.
    game.logDeath({ id: "-40", typeId: "minecraft:zombie", killer: "minecraft:player" });
    const r = await game.env.controller.run({ action: "fight", timeoutMs: 10_000 });
    expect(r.fight).toMatchObject({ kills: { zombie: 2 }, hits: 2, hitsTaken: 0, damageTaken: 0 });
    expect(r.fight?.swings).toBe(game.clicks.length);
    expect((r.fight?.hits ?? 0) + (r.fight?.misses ?? 0)).toBe(r.fight?.swings);
    expect(r.message).toMatch(/^killed 2 zombie with iron_sword: /);
  });

  it("keeps tracing on across resetStats, capped at MAX_TRACE_FRAMES", () => {
    const pc = fakeGame([]).env.controller;
    const frame: Omit<TraceFrame, "t"> = { x: 0, z: 0, onGround: true, mobs: [], foot: "hold", plan: "wait", readyMs: 0, shield: false, aimErr: 0, aimTol: 5, fwd: 0, strafe: 0, sprint: false };
    expect(combatStats(pc).trace).toBeUndefined();
    traceFights(pc, true);
    for (let i = 0; i < MAX_TRACE_FRAMES + 5; i++) traceFrame(combatStats(pc), pc.hands.now(), frame);
    expect(combatStats(pc).trace).toHaveLength(MAX_TRACE_FRAMES);
    expect(resetStats(pc).trace).toEqual([]);
    traceFights(pc, false);
    expect(resetStats(pc).trace).toBeUndefined();
  });
});

describe("recovery", () => {
  it("keeps away while recovering until health is back, fighting only a mob at hand", () => {
    const far = mapOf([mob("z", "zombie", 0, 10)], { health: 9 });
    expect(chooseTactic(scoreTactics(far, killHostiles)).kind).toBe("fight");
    const away = chooseTactic(scoreTactics(far, killHostiles, { recovering: true }));
    expect([away.kind, away.recover]).toEqual(["flee", true]);
    const gone = scoreTactics(mapOf([mob("z", "zombie", 0, 15)], { health: 9 }), killHostiles, { recovering: true });
    expect(gone.map((t) => t.kind)).toEqual(["idle"]);
    expect(chooseTactic(scoreTactics(mapOf([mob("z", "zombie", 0, 10)], { health: 13 }), killHostiles, { recovering: true })).kind).toBe("fight");
  });
});

describe("cornered", () => {
  it("fights back the mob at hand when running just failed", () => {
    const m = mapOf([mob("z", "zombie", 0, 2)], { health: 5 });
    expect(chooseTactic(scoreTactics(m, killHostiles)).kind).toBe("flee");
    const back = chooseTactic(scoreTactics(m, killHostiles, { recovering: true, cornered: true }));
    expect([back.kind, back.target?.id]).toEqual(["fight", "z"]);
  });
});

describe("fighting a group", () => {
  const origin = { x: 0, y: 0, z: 0 };
  const at = (id: string, x: number, z: number) => ({ id, location: { x, y: 0, z } });

  it("fights the closest mob, or the one hitting the player", () => {
    expect(pickDuelTarget(origin, "a", [at("a", 0, 3), at("b", 0, 1.5)], false)).toBe("b");
    expect(pickDuelTarget(origin, "a", [at("a", 0, 3), at("b", 0, 2.4)], false)).toBe("a");
    expect(pickDuelTarget(origin, "a", [at("a", 0, 3), at("b", 0, 2.4)], true)).toBe("b");
    expect(pickDuelTarget(origin, "a", [at("a", 0, 3)], true)).toBe("a");
  });

  it("jumps for crits only against a lone mob", () => {
    expect(isolated(origin, "a", [at("a", 0, 3), at("b", 3, 0)])).toBe(false);
    expect(isolated(origin, "a", [at("a", 0, 3), at("b", 6, 0)])).toBe(true);
  });

  it("backs off to the side away from the group, and away from all when one flanks", () => {
    const target = at("a", 0, 3);
    expect(crowdMove(origin, target, [target])).toBeUndefined();
    // A second zombie ahead and to the right (-X): step back and to the left (+X, -Z).
    const kite = crowdMove(origin, target, [target, at("b", -1.5, 3)]);
    expect(kite?.reason).toBe("kite");
    expect(Math.abs(angleDiff(-135, kite?.heading ?? 0))).toBeLessThan(1);
    // One beside on the left (+X): get away from both, toward -X and -Z, so both end up in front.
    const flank = crowdMove(origin, target, [target, at("b", 3, 0)]);
    expect(flank?.reason).toBe("flanked");
    expect(Math.abs(angleDiff(135, flank?.heading ?? 0))).toBeLessThan(1);
  });
});
