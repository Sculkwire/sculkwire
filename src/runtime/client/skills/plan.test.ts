import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drive, fakeClock } from "../../../testing/faketime.ts";
import { KILL_PHRASINGS, REACH_PHRASINGS, TWO_STEP_PHRASINGS } from "../bench/scenarios/goal-phrased.ts";
import { SHULKER_PHRASINGS, SMELT_CRAFT_PHRASINGS, TRADE_PHRASINGS } from "../bench/scenarios/task-phrased.ts";
import type { PlayerInput } from "../launcher.ts";
import { PlayerController, type EntityInfo, type Loadout, type PlayerState, type PlayerWorld } from "../player.ts";
import { FakeWorld } from "../tasks/fakeworld.ts";
import { parseRecipe, RecipeIndex, type Recipe } from "../tasks/recipes.ts";
import { parseGoal } from "./goal.ts";
import { compileGoal, stepLabel } from "./plan.ts";
import { play, type Death, type PlayEnvironment } from "./play.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** What the grammar alone makes of a phrasing: one label per step. */
const labels = (goal: string) => compileGoal(goal, 60_000).steps.map(stepLabel);

describe("the goal grammar on the bench phrasings", () => {
  // Honest coverage: which phrasings the grammar places by itself and which it leaves free (or half placed).
  it("kill-phrased: 7 of 10", () => {
    expect(KILL_PHRASINGS.map(labels)).toEqual([
      ["kill every zombie"],
      ["kill 3 zombie"],
      ["kill every zombie"],
      ["kill 3 hostile"],
      ["kill every hostile"],
      ["kill every zombie"],
      ["free: make sure none of those zombies are left standing"],
      ["free: the undead are coming, put them down"],
      ["free: zombies incoming, handle it"],
      ["kill every zombie"],
    ]);
  });

  it("reach-phrased: 8 of 10 (\"that yellow block\" is placed but names no block)", () => {
    expect(REACH_PHRASINGS.map(labels)).toEqual([
      ["go to the gold block"],
      ["go to the gold block"],
      ["go to the yellow block"],
      ["go to the block of gold"],
      ["go to the gold block"],
      ["go to the gold block"],
      ["free: the gold block, go there"],
      ["free: i want you right beside the gold block"],
      ["go to the gold block"],
      ["go to the gold block"],
    ]);
  });

  it("two-step: 7 of 10 both steps, 1 only the second", () => {
    const both = ["kill 1 zombie", "go to the gold block"];
    expect(TWO_STEP_PHRASINGS.map(labels)).toEqual([
      both,
      both,
      both,
      both,
      both,
      both,
      ["go to the gold block"],
      ["free: zombie first, gold block second"],
      both,
      ["free: after killing the zombie, head for the gold block"],
    ]);
  });

  it("smelt-craft: 8 of 10 (some as the craft alone, which smelts what it needs)", () => {
    expect(SMELT_CRAFT_PHRASINGS.map(labels)).toEqual([
      ["smelt ore", "craft iron sword"],
      ["smelt raw iron", "craft iron sword"],
      ["craft iron sword"],
      ["craft iron sword"],
      ["smelt iron", "craft sword"],
      ["free: i need an iron sword, use the furnace for the ore"],
      ["craft iron sword"],
      ["craft sword"],
      ["smelt 3 raw iron", "craft sword"],
      ["free: sword time, iron"],
    ]);
  });

  it("trade: 7 of 10", () => {
    expect(TRADE_PHRASINGS.map(labels)).toEqual([
      ["trade emerald"],
      ["trade emerald"],
      ["trade emerald"],
      ["trade emerald"],
      ["free: sell some crops to the farmer"],
      ["trade 1 emerald"],
      ["trade emerald"],
      ["free: i'd like an emerald"],
      ["trade emerald"],
      ["free: earn an emerald from the farmer"],
    ]);
  });

  it("nested-shulker: 7 of 10, a plural meaning every one there is", () => {
    expect(SHULKER_PHRASINGS.map(labels)).toEqual([
      ["fetch all diamonds"],
      ["fetch 3 diamonds"],
      ["fetch all diamonds"],
      ["fetch 3 diamonds"],
      ["fetch all diamonds"],
      ["fetch all diamonds"],
      ["free: the chest has diamonds in it, i want them"],
      ["fetch all diamonds"],
      ["free: empty the shulker box of its diamonds"],
      ["free: loot the chest for diamonds"],
    ]);
  });
});

describe("compileGoal", () => {
  it("gives one-clause goals the same goal parseGoal gives", async () => {
    for (const g of [
      "kill the hostile mobs near you",
      "Kill 3 zombies",
      "kill all the skeletons",
      "kill the creeper",
      "kill two cave spiders",
      "walk to 10, -5",
      "go to 10 64 -20",
      "hit every cow near you once with the held item",
    ]) {
      const old = parseGoal(g);
      expect(old.kind).not.toBe("free");
      const { steps } = compileGoal(g);
      expect(steps).toHaveLength(1);
      const { clause: _c, ...goal } = steps[0] as (typeof steps)[number];
      expect(goal).toEqual(old);
    }
  });

  it("splits steps, reorders \"after\", and reads standing orders", async () => {
    expect((compileGoal("go to the gold block after you kill 2 zombies")).steps.map(stepLabel)).toEqual(["kill 2 zombie", "go to the gold block"]);
    expect((compileGoal("kill the skeletons with the shield up")).orders).toEqual({ stance: "guard" });
    expect((compileGoal("keep your distance, do not use the shield, kill the creeper")).orders).toEqual({ stance: "kite" });
    expect((compileGoal("survive for 2 minutes")).steps[0]).toMatchObject({ kind: "survive", seconds: 120 });
    expect((compileGoal("equip the shield, then kill the creeper")).steps.map(stepLabel)).toEqual(["equip shield", "kill 1 creeper"]);
    // A plural without a number is the task step's own `all`, not a made-up count.
    expect((compileGoal("get the diamonds out of the chest")).steps[0]).toEqual({ kind: "fetch", item: "diamonds", all: true, clause: "get the diamonds out of the chest" });
    expect((compileGoal("take 3 diamonds from the chest")).steps[0]).toEqual({ kind: "fetch", item: "diamonds", count: 3, clause: "take 3 diamonds from the chest" });
  });
});

/* ------------------------------------------------------------------------------------------------------------ */
/* play with a plan                                                                                               */
/* ------------------------------------------------------------------------------------------------------------ */

function me(): PlayerState {
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
  };
}

const zombie = (id: string, z = 2.5): EntityInfo => ({ id, typeId: "minecraft:zombie", location: { x: 0, y: 0, z }, health: { current: 20, max: 20 } });

/** A game where nothing moves: the crosshair is on the first entity and a click kills it (as the play-loop tests' fake). */
function arena(entities: EntityInfo[], over: Partial<PlayerState> = {}) {
  const state = { ...me(), ...over };
  const deaths: Death[] = [];
  let tick = 0;
  const aim = () => {
    const e = entities[0];
    if (e) state.lookingAtEntity = { id: e.id, typeId: e.typeId, distance: Math.hypot(e.location.x, e.location.z) };
    else delete state.lookingAtEntity;
  };
  const input: PlayerInput = {
    keyDown: async () => {},
    keyUp: async () => {},
    look: async () => {},
    button: async (b, down) => {
      aim();
      if (b !== 1 || !down) return;
      const target = entities.find((e) => e.id === state.lookingAtEntity?.id);
      if (!target) return;
      entities.splice(entities.indexOf(target), 1);
      deaths.push({ tick: ++tick, id: target.id, typeId: target.typeId, killer: "minecraft:player" });
      aim();
    },
  };
  const loadout: Loadout = { hotbar: [{ typeId: "minecraft:iron_sword", amount: 1 }, null, null, null, null, null, null, null, null], hunger: 20 };
  const world: PlayerWorld = {
    input,
    state: async () => {
      aim();
      return structuredClone(state);
    },
    entity: async (id) => structuredClone(entities.find((e) => e.id === id) ?? null),
    nearest: async () => structuredClone(entities[0] ?? null),
    impacts: async () => ({ tick: 0, impacts: [] }),
    entities: async () => structuredClone(entities),
    loadout: async () => loadout,
  };
  const env: PlayEnvironment = {
    controller: new PlayerController(world, { clock: fakeClock }),
    entities: async () => structuredClone(entities),
    loadout: async () => loadout,
    deaths: async (since: number) => ({ tick, deaths: deaths.filter((d) => d.tick > since) }),
    clock: fakeClock,
  };
  /** A death the helper logged now, not by the player (another mob's attack): the mob is gone from the world. */
  const otherKill = (id: string, killer: string) => {
    const e = entities.find((x) => x.id === id);
    if (!e) return;
    entities.splice(entities.indexOf(e), 1);
    deaths.push({ tick: ++tick, id, typeId: e.typeId, cause: "entityAttack", killer });
  };
  return { env, entities, otherKill };
}

const RECIPES = [
  JSON.stringify({
    format_version: "1.20.10",
    "minecraft:recipe_furnace": { description: { identifier: "test:smelt_iron" }, tags: ["furnace"], input: "minecraft:raw_iron", output: "minecraft:iron_ingot" },
  }),
];

function taskWorld(): FakeWorld {
  return new FakeWorld(fakeClock, new RecipeIndex(RECIPES.map((t) => parseRecipe(t, "vanilla")).filter((r): r is Recipe => !!r), "the test recipes"));
}

describe("a goal that was not understood", () => {
  it("stops 5 s after there is nothing to do, quoting the part and listing the forms play understands", async () => {
    const r = await drive(play({ action: "play", goal: "dance a little", durationMs: 60_000 }, arena([]).env), 50, 70_000);
    expect(r.stoppedBy).toBe("goal_unknown");
    expect(r.durationMs).toBeLessThan(7000);
    expect(r.message).toMatch(/^did not understand "dance a little"/);
    expect(r.message).toContain('kill ("kill 3 zombies")');
    expect(r.message).toContain('survive ("survive for 30 seconds")');
    expect(r.plan).toMatchObject([{ kind: "free", status: "failed", ok: false, message: 'not understood: "dance a little"' }]);
  });

  it("defends itself first: the 5 s count only from when no hostile is near", async () => {
    const a = arena([]);
    setTimeout(() => a.entities.push(zombie("-3")), 3000);
    const r = await drive(play({ action: "play", goal: "dance a little", durationMs: 60_000 }, a.env), 50, 70_000);
    expect(r.stoppedBy).toBe("goal_unknown");
    expect(r.stats.kills).toBe(1);
    expect(r.trace.some((t) => t.action === "fight")).toBe(true);
    expect(r.durationMs).toBeGreaterThanOrEqual(8000);
  });

  it("runs the placed steps, then stops naming the part it did not understand", async () => {
    const r = await drive(play({ action: "play", goal: "go to 1 1 then do a little dance", durationMs: 60_000 }, arena([]).env), 50, 70_000);
    expect(r.stoppedBy).toBe("goal_unknown");
    expect(r.message).toMatch(/^did 1 step\(s\) \(go to 1 1\), then did not understand "do a little dance"/);
    expect(r.plan.map((s) => [s.kind, s.status])).toEqual([
      ["reach", "done"],
      ["free", "failed"],
    ]);
  });

  it("keeps a goal that says to survive, defend or wait running to its time, and does not take a duration alone for one", async () => {
    expect((compileGoal("defend yourself")).steps[0]).toMatchObject({ kind: "survive" });
    expect((compileGoal("dance around for 10 seconds")).steps[0]).toMatchObject({ kind: "free" });
    const r = await drive(play({ action: "play", goal: "wait here for 10 seconds", durationMs: 60_000 }, arena([]).env), 50, 70_000);
    expect(r.plan).toMatchObject([{ kind: "survive", status: "done" }]);
    expect(r.stoppedBy).toBe("goal_done");
    expect(r.durationMs).toBeGreaterThanOrEqual(10_000);
  });
});

describe("a kill step with its target keeping away", () => {
  const husk = { ...zombie("-9", 10), typeId: "minecraft:husk" };
  it("fights a goal target that stands 10 blocks away and never comes, instead of idling", async () => {
    const r = await drive(play({ action: "play", goal: "kill the husk", durationMs: 20_000 }, arena([husk]).env), 50, 30_000);
    expect(r.trace.filter((t) => t.action === "idle")).toEqual([]);
    expect(r.trace[0]).toMatchObject({ action: "fight", target: { id: "-9" } });
  });

  it("goes after it also while low on health, when no flee or fight at hand is offered (the live spears3 idle)", async () => {
    // Health 7 is at or below the recovery line: no seeking out fights, and a husk at 10 blocks is past the 8 blocks a
    // flee needs, so before the fix nothing but idle was offered for the whole run.
    const r = await drive(play({ action: "play", goal: "kill the husk", durationMs: 10_000 }, arena([husk], { health: 7 }).env), 50, 20_000);
    expect(r.trace.filter((t) => t.action === "idle")).toEqual([]);
    expect(r.trace[0]).toMatchObject({ action: "fight", target: { id: "-9" }, reason: expect.stringMatching(/keeps away: go after it/) });
  });
});

describe("a kill step whose targets die or leave", () => {
  const husk = (id: string, z: number): EntityInfo => ({ ...zombie(id, z), typeId: "minecraft:husk" });

  it("counts a target another mob killed: the step ends ok with both numbers apart", async () => {
    const a = arena([husk("-1", 2.5), husk("-2", 20)]);
    // The far husk is run through by another husk's spear charge.
    setTimeout(() => a.otherKill("-2", "minecraft:husk"), 200);
    const r = await drive(play({ action: "play", goal: "kill 2 husks", durationMs: 30_000 }, a.env), 50, 40_000);
    expect(r.stoppedBy).toBe("goal_done");
    expect(r.message).toBe("goal done: 2 of 2 husk dead (1 killed by the player, 1 by another husk)");
    expect(r.stats).toMatchObject({ kills: 1, killed: { husk: 1 }, otherDeaths: { husk: 1 } });
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it("stops at once when none of its targets is left within the radius and the count is not reached", async () => {
    const a = arena([husk("-1", 2.5), husk("-2", 20)]);
    // The far husk walks out of the area: gone without a death.
    setTimeout(() => a.entities.splice(a.entities.findIndex((e) => e.id === "-2"), 1), 100);
    const r = await drive(play({ action: "play", goal: "kill 3 husks", durationMs: 60_000 }, a.env), 50, 70_000);
    expect(r.stoppedBy).toBe("targets_gone");
    expect(r.message).toBe("1 of 3 husk killed, none left within 24 blocks");
    expect(r.plan).toMatchObject([{ kind: "kill", status: "failed", ok: false }]);
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it("does not stop before any target was there (mobs summoned after the run started)", async () => {
    const a = arena([]);
    setTimeout(() => a.entities.push(husk("-3", 2.5)), 3000);
    const r = await drive(play({ action: "play", goal: "kill 1 husk", durationMs: 20_000 }, a.env), 50, 30_000);
    expect(r.stoppedBy).toBe("goal_done");
    expect(r.stats.kills).toBe(1);
  });
});

describe("play runs the plan", () => {
  it("runs a task step, aborts it for a hostile, fights, and retries it until its check holds", async () => {
    const w = taskWorld();
    w.give("raw_iron", 2);
    w.give("coal", 2);
    w.place("furnace", { x: 4, y: 64, z: 0 });
    const a = arena([]);
    const plans: string[] = [];
    // A zombie walks up 3 s into the smelting (one item takes 10 s).
    setTimeout(() => a.entities.push(zombie("-7")), 3000);
    const r = await drive(play({ action: "play", goal: "smelt the raw iron", durationMs: 120_000 }, { ...a.env, tasks: async () => w.env() }, { onPlan: (t) => plans.push(t) }), 50, 200_000);
    expect(r.stoppedBy).toBe("goal_done");
    expect(r.plan).toHaveLength(1);
    expect(r.plan[0]).toMatchObject({ kind: "smelt", status: "done", ok: true, retries: 1 });
    expect(r.plan[0]?.actions?.length).toBeGreaterThan(0);
    expect(r.stats.kills).toBe(1);
    expect(r.trace.some((t) => t.action === "fight")).toBe(true);
    expect(w.count("iron_ingot")).toBeGreaterThanOrEqual(1);
    expect(w.screen).toBeNull();
    expect(plans).toContain("step 1 of 1: smelt raw iron, attempt 2");
  });

  it("ends the plan with a failed step's message, the later steps not reached", async () => {
    const w = taskWorld();
    const a = arena([]);
    const r = await drive(play({ action: "play", goal: "smelt the raw iron then go to 5 5", durationMs: 60_000 }, { ...a.env, tasks: async () => w.env() }), 50, 100_000);
    expect(r.stoppedBy).toBe("error");
    expect(r.message).toMatch(/^step 1 \(smelt the raw iron\) failed: /);
    expect(r.plan.map((s) => [s.kind, s.status, s.ok])).toEqual([
      ["smelt", "failed", false],
      ["reach", "pending", false],
    ]);
    expect(r.plan[0]?.reason).toBeDefined();
    expect(r.goalCheck.known).toBe(true);
  });

  it("fails a task step at once when the run has no task environment", async () => {
    const r = await drive(play({ action: "play", goal: "craft an iron sword", durationMs: 5000 }, arena([]).env), 50);
    expect([r.stoppedBy, r.plan[0]?.status]).toEqual(["error", "failed"]);
    expect(r.message).toMatch(/no task environment/);
  });
});
