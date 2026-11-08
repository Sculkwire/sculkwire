import { describe, expect, it } from "vitest";
import type { Answer, Decision, DecisionModel, Question } from "../../../decision/types.ts";
import type { PlayerInput } from "../launcher.ts";
import { PlayerController, type EntityInfo, type Loadout, type PlayerState, type PlayerWorld } from "../player.ts";
import { checkGoal, parseGoal } from "./goal.ts";
import { armorPoints, bestFoodSlot, bestWeaponSlot } from "./items.ts";
import { CRIT_GIVE_UP_MS, HIT_CONFIRM_MS, HIT_COOLDOWN_MS, HIT_DOUBT_MS, meleePlan, swingOutcome, type MeleeInput } from "./melee.ts";
import { adviseTactic, play, type Death } from "./play.ts";
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

  it("keeps the running tactic unless another is clearly better, and honours the allow list", () => {
    const m = mapOf([mob("a", "zombie", 0, 3), mob("b", "zombie", 0, 3.5)]);
    const scored = scoreTactics(m, killHostiles);
    expect(tacticKey(chooseTactic(scored, "fight:b"))).toBe("fight:b");
    expect(tacticKey(chooseTactic(scored))).toBe("fight:a");
    const noFight = scoreTactics(m, killHostiles, { allowed: new Set(["flee", "idle"]) });
    expect(noFight.map((t) => t.kind)).toEqual(["idle"]);
  });
});

describe("advisor", () => {
  const m = mapOf([mob("a", "zombie", 0, 3), mob("b", "skeleton", 0, 10)]);
  const scored = scoreTactics(m, killHostiles);
  const choice = (c: string, p: number): Answer => ({ type: "choice", choice: c, probabilities: { [c]: p } });

  it("follows a confident model's tactic and target", () => {
    const r = adviseTactic(scored, { tactic: choice("fight", 0.8), target: choice("skeleton_1", 0.7) });
    expect([r.by, r.tactic.kind, r.tactic.target?.id]).toEqual(["model", "fight", "b"]);
  });

  it("keeps the built-in choice for a weak, impossible or targetless answer", () => {
    expect(adviseTactic(scored, { tactic: choice("flee", 0.1) })).toMatchObject({ by: "builtin", tactic: { kind: "fight" }, fallback: expect.stringMatching(/under/) });
    expect(adviseTactic(scored, { tactic: choice("eat", 0.9) })).toMatchObject({ by: "builtin", fallback: "eat is not possible now" });
    const t = adviseTactic(scored, { tactic: choice("fight", 0.9), target: choice("none", 0.9) });
    expect([t.by, t.tactic.target?.id]).toEqual(["model", "a"]);
  });

  it("lets an emergency override the model", () => {
    const t = new ThreatTracker();
    t.update(0, me(), [mob("c", "creeper", 2, 0)]);
    const burning = scoreTactics(t.update(800, me(), [mob("c", "creeper", 2, 0)]), killHostiles);
    const r = adviseTactic(burning, { tactic: choice("fight", 0.95), target: choice("creeper_1", 0.95) });
    expect(r).toMatchObject({ by: "builtin", tactic: { kind: "flee" }, fallback: expect.stringMatching(/^emergency/) });
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
 * A fake game: the crosshair stays on the first entity, every click on it takes `damage` health, and a mob at 0
 * dies (removed, with a death record killed by the player).
 */
function fakeGame(entities: EntityInfo[], state: PlayerState = me(), damage = 20) {
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
  };
  const env = {
    controller: new PlayerController(world),
    entities: async () => structuredClone(entities),
    loadout: async () => loadout,
    deaths: async (since: number) => ({ tick, deaths: deaths.filter((d) => d.tick > since) }),
  };
  return { env, clicks, state, entities };
}

/** A model that answers from a script and records what it was asked. */
function fakeModel(script: (n: number) => Record<string, Answer>): DecisionModel & { asked: Record<string, Question>[] } {
  const asked: Record<string, Question>[] = [];
  return {
    label: "fake",
    images: false,
    asked,
    async decide(_state, questions): Promise<Decision> {
      asked.push(questions);
      return { answers: script(asked.length), latencyMs: 5 };
    },
  };
}

const pick = (c: string, p: number): Answer => ({ type: "choice", choice: c, probabilities: { [c]: p } });

describe("play loop", () => {
  it("kills every hostile without a decision model and stops on the built-in goal check", async () => {
    const game = fakeGame([mob("-11", "zombie", 0, 2.5), mob("-12", "zombie", 0, 3)]);
    const r = await play({ action: "play", goal: "kill the hostile mobs near you", durationMs: 15_000 }, game.env);
    expect(r).toMatchObject({ stoppedBy: "goal_done", model: "none", goalCheck: { kind: "kill", known: true } });
    expect(r.stats).toMatchObject({ kills: 2, killed: { zombie: 2 }, hits: 2, deaths: 0 });
    expect(r.trace.map((t) => [t.action, t.target?.id, t.by])).toEqual([
      ["fight", "-11", "builtin"],
      ["fight", "-12", "builtin"],
      // Idles while the goal check confirms nothing is left.
      ["idle", undefined, "builtin"],
    ]);
    expect(game.entities).toEqual([]);
  });

  it("asks the advisor without goal_done for checked goals, and follows its tactic", async () => {
    const game = fakeGame([mob("c", "cow", 0, 3)]);
    const model = fakeModel(() => ({ tactic: pick("idle", 0.9), target: pick("none", 1), goal_done: { type: "noul", noul: 1 } }));
    const r = await play({ action: "play", goal: "kill 2 zombies", durationMs: 1200, stepMs: 100 }, { ...game.env, model });
    expect(r.stoppedBy).toBe("timeout");
    expect(Object.keys(model.asked[0] ?? {})).toEqual(["tactic", "target"]);
    expect(r.trace[0]).toMatchObject({ action: "idle", by: "model", state: expect.stringMatching(/Progress: 0 of 2 zombie killed/) });
    expect(r.model).toBe("fake");
  });

  it("stops on the advisor's goal_done for goals without a check", async () => {
    const game = fakeGame([]);
    const model = fakeModel((n) => ({ tactic: pick("idle", 0.9), target: pick("none", 1), goal_done: { type: "noul", noul: n >= 3 ? 0.95 : 0 } }));
    const r = await play({ action: "play", goal: "dance a little", stepMs: 100 }, { ...game.env, model });
    expect(r.stoppedBy).toBe("goal_done");
    expect(r.stats.decisions).toBe(3);
    expect(model.asked[0]?.goal_done).toBeDefined();
  });

  it("runs on the built-in choice when the advisor fails or is turned off", async () => {
    const game = fakeGame([mob("-11", "zombie", 0, 2.5)]);
    const broken: DecisionModel = { label: "down", images: false, decide: async () => Promise.reject(new Error("model down")) };
    const r = await play({ action: "play", goal: "kill the zombie", durationMs: 10_000 }, { ...game.env, model: broken });
    expect(r).toMatchObject({ stoppedBy: "goal_done", stats: { kills: 1 } });
    const off = fakeGame([]);
    const model = fakeModel(() => ({ tactic: pick("idle", 1) }));
    const r2 = await play({ action: "play", goal: "dance", durationMs: 1000, advisor: false }, { ...off.env, model });
    expect([r2.model, model.asked.length]).toEqual(["none", 0]);
  });

  it("stops when the player dies, when the simulation is paused, and on a slow advisor at the time limit", async () => {
    const dead = fakeGame([], me({ health: 0 }));
    expect(await play({ action: "play", goal: "g" }, dead.env)).toMatchObject({ stoppedBy: "died", stats: { deaths: 1 } });
    const paused = fakeGame([]);
    const p = await play({ action: "play", goal: "g" }, { ...paused.env, paused: () => true });
    expect([p.stoppedBy, p.message]).toEqual(["error", expect.stringMatching(/paused/)]);
    const slow: DecisionModel = {
      label: "slow",
      images: false,
      decide: (_s, _q, options) => {
        const { promise, reject } = Promise.withResolvers<Decision>();
        options?.signal?.addEventListener("abort", () => reject(new Error("decision request was cancelled")));
        return promise;
      },
    };
    const t = await play({ action: "play", goal: "g", durationMs: 1000 }, { ...fakeGame([]).env, model: slow });
    expect(t.stoppedBy).toBe("timeout");
  });

  it("rejects unknown tactics in allow", async () => {
    await expect(play({ action: "play", goal: "g", allow: ["fly"] }, fakeGame([]).env)).rejects.toThrow(/unknown play tactic/);
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
