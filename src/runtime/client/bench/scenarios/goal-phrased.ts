/**
 * The `goal` suite: the same intent written ten ways, run i playing phrasing i. Some phrasings match the goal grammar
 * and some do not on purpose: the success rate measures what the grammar understands (a phrasing it does not ends in
 * seconds with `goal_unknown`).
 */
import { COMBAT_AREA, FIGHTER, wall } from "../kit.ts";
import { distanceTo, planExtras } from "../plankit.ts";
import type { Offset, Scenario } from "../types.ts";

/** Three zombies as in `combat/zombies3`. */
export const KILL_PHRASINGS = [
  "kill all the zombies",
  "kill the 3 zombies",
  "take out the zombies",
  "get rid of those three undead",
  "clear the arena",
  "deal with the zombies",
  "make sure none of those zombies are left standing",
  "the undead are coming, put them down",
  "zombies incoming, handle it",
  "slay every zombie in here",
];

export const REACH_PHRASINGS = [
  "go to the gold block",
  "stand next to the gold block",
  "head over to that yellow block",
  "walk up to the block of gold",
  "find the gold block",
  "make your way to the gold block",
  "the gold block, go there",
  "I want you right beside the gold block",
  "move next to the gold block",
  "get close to the gold block",
];

export const TWO_STEP_PHRASINGS = [
  "kill the zombie then go to the gold block",
  "kill the zombie, then walk to the gold block",
  "first take out the zombie and then stand next to the gold block",
  "go to the gold block after you kill the zombie",
  "slay the zombie; afterwards head to the gold block",
  "deal with the zombie and go to the gold block",
  "once the zombie is dead, go stand on the gold block",
  "zombie first, gold block second",
  "kill the zombie and walk over to the gold block",
  "after killing the zombie, head for the gold block",
];

/** Standing within this of the gold block's centre counts as next to it. */
const NEXT_TO = 2.5;
const GOLD: Offset = { dx: 0, dy: 0, dz: 12 };
const GOLD_TWO_STEP: Offset = { dx: 8, dy: 0, dz: -8 };

const killPhrased: Scenario = {
  name: "kill-phrased",
  suite: "goal",
  summary: "3 zombies at night as combat/zombies3, the kill goal in ten phrasings; success: 3 kills and goal_done within 60 s",
  runs: 10,
  timeoutMs: 60_000,
  area: COMBAT_AREA,
  build: (ctx) => wall(ctx.origin),
  player: FIGHTER,
  mobs: [
    { type: "zombie", at: { dx: -3, dy: 0, dz: 10 } },
    { type: "zombie", at: { dx: 0, dy: 0, dz: 11 } },
    { type: "zombie", at: { dx: 3, dy: 0, dz: 10 } },
  ],
  goals: KILL_PHRASINGS,
  action: () => ({ action: "play", goal: KILL_PHRASINGS[0] as string, durationMs: 60_000 }),
  measure: (_ctx, o) => ({ ...planExtras(o.play), cleared: o.kills === 3 }),
  success: (o) => o.kills === 3 && o.ok && o.deaths === 0 && o.durationMs < 60_000,
};

const reachPhrased: Scenario = {
  name: "reach-phrased",
  suite: "goal",
  summary: "a gold block 12 blocks away by day, the reach goal in ten phrasings; success: within 2.5 blocks of it and goal_done",
  runs: 10,
  timeoutMs: 30_000,
  area: { radius: 16, height: 6 },
  build: (ctx) => [`setblock ${xyz(ctx.at(GOLD))} gold_block`],
  player: { gameMode: "survival", time: "day" },
  goals: REACH_PHRASINGS,
  action: () => ({ action: "play", goal: REACH_PHRASINGS[0] as string, durationMs: 30_000 }),
  measure: (ctx, o) => ({ ...planExtras(o.play), distance: distanceTo(ctx, o, GOLD) }),
  success: (o, extra) => o.ok && typeof extra.distance === "number" && extra.distance <= NEXT_TO,
};

const twoStep: Scenario = {
  name: "two-step",
  suite: "goal",
  summary: "one zombie at night and a gold block 11 blocks away, \"kill the zombie then go to the gold block\" in ten phrasings; success: both",
  runs: 10,
  timeoutMs: 60_000,
  area: COMBAT_AREA,
  build: (ctx) => [...wall(ctx.origin), `setblock ${xyz(ctx.at(GOLD_TWO_STEP))} gold_block`],
  player: FIGHTER,
  mobs: [{ type: "zombie", at: { dx: 0, dy: 0, dz: 9 } }],
  goals: TWO_STEP_PHRASINGS,
  action: () => ({ action: "play", goal: TWO_STEP_PHRASINGS[0] as string, durationMs: 60_000 }),
  measure: (ctx, o) => ({ ...planExtras(o.play), distance: distanceTo(ctx, o, GOLD_TWO_STEP) }),
  success: (o, extra) => o.ok && o.kills === 1 && o.deaths === 0 && typeof extra.distance === "number" && extra.distance <= NEXT_TO,
};

function xyz(v: { x: number; y: number; z: number }): string {
  return `${Math.floor(v.x)} ${Math.floor(v.y)} ${Math.floor(v.z)}`;
}

export const scenarios = [killPhrased, reachPhrased, twoStep];
