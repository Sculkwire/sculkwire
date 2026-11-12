/**
 * Every scenario's definition, pinned: its arena slot, the readable fields, and a digest of everything a run reads
 * from it (summary, player, mobs, phrasings, build commands, action, the extras `measure` returns and the `success`
 * verdict over a set of outcomes). A refactor of the scenario files or their kits must leave all of it unchanged; a
 * deliberate change to a scenario updates its row here.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { arenaOrigin, offsetAt } from "./arena.ts";
import { parseGoal } from "../skills/goal.ts";
import type { PlayAction } from "../skills/play.ts";
import { loadScenarios } from "./run.ts";
import cornered from "./scenarios/combat-cornered.ts";
import husks3 from "./scenarios/combat-husks3.ts";
import mixed from "./scenarios/combat-mixed.ts";
import type { BenchContext, RunOutcome, Scenario } from "./types.ts";

/** JSON with sorted keys and no `undefined` or function fields, so equal definitions give equal text whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined && typeof v !== "function")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const HELD = [
  { item: "minecraft:diamond", count: 3 },
  { item: "minecraft:wooden_pickaxe", count: 1 },
  { item: "minecraft:emerald", count: 1 },
  { item: "minecraft:iron_sword", count: 1 },
];

function context(s: Scenario, index: number, carrying: boolean): BenchContext {
  const origin = arenaOrigin(index);
  const ctx: Pick<BenchContext, "scenario" | "run" | "origin" | "at" | "mobs" | "query"> = {
    scenario: s.name,
    run: 1,
    origin,
    at: (o) => offsetAt(origin, o),
    mobs: [],
    query: async (kind) => {
      if (kind === "inventory") return { inventory: { selectedSlot: 0, hotbar: carrying ? HELD : [], inventory: [], armor: {} } };
      if (kind === "block") return { states: { open_bit: false } };
      return null;
    },
  };
  // The hooks read only these fields; the rest of the context is the live game's.
  return ctx as BenchContext;
}

/** What a run reads from a scenario, with the outcome variants its `success` is judged on. */
async function definition(s: Scenario, index: number): Promise<Record<string, unknown>> {
  const origin = arenaOrigin(index);
  const action = s.action(context(s, index, true));
  const here = { x: origin.x + 0.5, y: origin.y, z: origin.z + 0.5 };
  const target = action.action === "goto" ? { x: action.x ?? here.x, y: action.y ?? here.y, z: action.z ?? here.z } : here;
  const located = (x: number, y: number, z: number): RunOutcome["state"] => ({ location: { x, y, z } }) as RunOutcome["state"];
  const base: RunOutcome = {
    ok: true,
    message: "arrived, 3 jump(s), 1 gap jump(s), 2 door(s) opened, 1 closed behind, 2 replan(s). The closest reachable spot is 1 2 3, closed in",
    durationMs: 10_000,
    healthStart: 20,
    healthEnd: 20,
    damageTaken: 0,
    blastDamage: 0,
    fallDamage: 0,
    falls: 0,
    deaths: 0,
    kills: s.mobs?.length ?? 0,
    lost: 0,
    exploded: 0,
    hurts: [{ tick: 1, damage: 2, damager: "minecraft:zombie" }],
    state: located(target.x, target.y, target.z),
    play: {
      plan: [
        { text: "a", kind: "trade", status: "done", ok: true, retries: 1, actions: ["offers of the villager at 1 2 3: x"] },
        { text: "b", kind: "free", status: "pending", ok: false },
      ],
      stats: { swings: 4, hits: 3, misses: 1, crits: 1, blocked: 2, otherDeaths: { "minecraft:husk": 1 } },
      trace: [
        { action: "eat", result: { ok: true } },
        { action: "flee", result: { ok: true } },
      ],
    } as unknown as RunOutcome["play"],
  };
  const variants: [string, RunOutcome, boolean][] = [
    ["base", base, true],
    ["deaths", { ...base, deaths: 1 }, true],
    ["notOk", { ...base, ok: false }, true],
    ["empty", { ...base, kills: 0 }, false],
    ["blast", { ...base, blastDamage: 2, exploded: 1, damageTaken: 2 }, true],
    ["slow", { ...base, durationMs: 70_000 }, true],
    ["atGold", { ...base, state: located(origin.x + 0.5, origin.y, origin.z + 12.5) }, true],
    ["atGoldTwoStep", { ...base, state: located(origin.x + 8.5, origin.y, origin.z - 7.5) }, true],
    ["away", { ...base, state: located(target.x + 5, target.y + 3, target.z + 5) }, true],
  ];
  const measured: Record<string, unknown> = {};
  const success: Record<string, boolean> = {};
  for (const [name, outcome, carrying] of variants) {
    const extra = (await s.measure?.(context(s, index, carrying), outcome)) ?? {};
    measured[name] = extra;
    success[name] = s.success ? s.success(outcome, extra) : outcome.ok && outcome.deaths === 0;
  }
  return { ...s, build: s.build?.(context(s, index, true)), action, measured, success };
}

/** Slot (arena index), suite/name, runs, timeout, area, then the digest of the whole definition. */
const EXPECTED: string[] = [
  "0 combat/cornered runs 10 timeout 90000 area 14x6 3d658f41d11e9f9b",
  "1 combat/creeper-bow runs 5 timeout 90000 area 14x6 d8c718991a6fa13e",
  "2 combat/creeper runs 10 timeout 90000 area 14x6 3ac275bc95482b91",
  "3 combat/husks3 runs 10 timeout 90000 area 14x6 3a7d50a7287871c1",
  "4 combat/mixed runs 5 timeout 120000 area 14x6 2c259f528474c238",
  "5 combat/skeleton2 runs 5 timeout 90000 area 14x6 c3ee5c1d94103317",
  "6 combat/spears3 runs 10 timeout 90000 area 14x6 b85372ad4ed6a2de",
  "7 combat/spider2 runs 5 timeout 90000 area 14x6 504bbe94d643eff1",
  "8 combat/zombies3 runs 10 timeout 90000 area 14x6 abecf7c585dc9f01",
  "9 goal/kill-phrased runs 10 timeout 60000 area 14x6 476ed02e137af32d",
  "10 goal/reach-phrased runs 10 timeout 30000 area 16x6 d0f8637d3d91a071",
  "11 goal/two-step runs 10 timeout 60000 area 14x6 ba5aef4634a561fb",
  "12 nav/course runs 3 timeout 45000 area 18x8 aac3cf55cb26708e",
  "13 nav/detour runs 3 timeout 60000 area 36x6 4b2da545dfc46a4c",
  "14 nav/gate runs 3 timeout 45000 area 12x6 364575161ab01bcb",
  "15 nav/door runs 3 timeout 45000 area 12x6 50748e42c57c2d2f",
  "16 nav/ladder-up runs 3 timeout 45000 area 12x10 9eac8813e2942774",
  "17 nav/ladder-down runs 3 timeout 45000 area 12x10 488407d1543a581c",
  "18 nav/parkour runs 3 timeout 30000 area 18x8 4b96f31fd9c22825",
  "19 nav/sealed runs 3 timeout 15000 area 12x6 15101436da9c70a9",
  "20 nav/stairs runs 3 timeout 45000 area 16x8 008e8ec906038900",
  "21 nav/stairs-back runs 3 timeout 45000 area 16x8 fb41ff6961218fd5",
  "22 nav/swim runs 3 timeout 45000 area 16x8 aca89e2e04ecd1ef",
  "23 nav/swim-dive runs 3 timeout 45000 area 16x8 f49a73e321b7825e",
  "24 task/blocked-chest runs 10 timeout 60000 area 10x6 0e582945c6d747f1",
  "25 task/blocked-chest-villager runs 10 timeout 60000 area 10x6 ade573d745930c3d",
  "26 task/far-table runs 10 timeout 120000 area 34x6 ae4540023491cc01",
  "27 task/smelt-craft runs 10 timeout 120000 area 10x6 80456e835f1f5079",
  "28 task/trade runs 10 timeout 60000 area 10x6 cce30473f3bfafab",
  "29 task/nested-shulker runs 10 timeout 60000 area 10x6 8fa42ae88973f1cc",
];

describe("scenario definitions", () => {
  it("keeps every scenario's slot, fields, commands, extras and verdicts", async () => {
    const all = await loadScenarios();
    const rows: string[] = [];
    for (const [index, s] of all.entries()) {
      const digest = createHash("sha256").update(canonical(await definition(s, index))).digest("hex").slice(0, 16);
      rows.push(`${index} ${s.suite}/${s.name} runs ${s.runs} timeout ${s.timeoutMs} area ${s.area.radius}x${s.area.height} ${digest}`);
    }
    expect(rows).toEqual(EXPECTED);
  });
});

describe("scenarios", () => {
  const outcome = (over: Partial<RunOutcome>): RunOutcome => ({ ok: true, message: "", durationMs: 1, healthStart: 20, healthEnd: 20, damageTaken: 0, blastDamage: 0, fallDamage: 0, falls: 0, deaths: 0, kills: 3, lost: 0, exploded: 0, hurts: [], ...over });
  const ctxAt = (index: number) => {
    const o = arenaOrigin(index);
    return { origin: o, at: (x: { dx: number; dy: number; dz: number }) => offsetAt(o, x) } as BenchContext;
  };
  it("gives every scenario its own name", async () => {
    const all = await loadScenarios();
    expect(new Set(all.map((s) => s.name)).size).toBe(all.length);
  });
  it("gives every goal and task scenario ten different phrasings", async () => {
    const phrased = (await loadScenarios()).filter((s) => s.suite === "goal" || s.suite === "task");
    expect(phrased.length).toBeGreaterThan(0);
    for (const s of phrased) expect(new Set(s.goals ?? []).size).toBe(10);
  });
  it("summons villagers by the name the summon command takes (villager, not villager_v2)", async () => {
    const summons = (await loadScenarios()).flatMap((s) => s.build?.(ctxAt(2)) ?? []).filter((line) => line.startsWith("summon "));
    expect(summons.some((line) => line.startsWith("summon minecraft:villager "))).toBe(true);
    expect(summons.filter((line) => /_v2\b/.test(line))).toEqual([]);
  });
  it("fixes the trade villager's profession with become_farmer", async () => {
    const trade = (await loadScenarios()).find((s) => s.suite === "task" && s.name === "trade");
    const o = arenaOrigin(2);
    expect((trade?.build?.(ctxAt(2)) ?? []).filter((line) => line.startsWith("summon "))).toEqual([`summon minecraft:villager ${o.x + 0.5} ${o.y} ${o.z + 4.5} 0 0 minecraft:become_farmer`]);
  });
  it("gives husks3 a goal that counts kills, so it is not done before the husks exist", () => {
    // A count goal is done at 3 kills; "all the husks" would be done before they exist (none left near).
    const spec = husks3.action({} as BenchContext);
    expect(spec.action).toBe("play");
    expect(parseGoal((spec as PlayAction).goal)).toMatchObject({ kind: "kill", type: "minecraft:husk", count: 3 });
  });
  it("judges cornered on every zombie killed and no death", () => {
    expect(parseGoal((cornered.action({} as BenchContext) as PlayAction).goal)).toMatchObject({ kind: "kill", type: "minecraft:zombie" });
    expect(cornered.success?.(outcome({}), {})).toBe(true);
    expect(cornered.success?.(outcome({ kills: 2 }), {})).toBe(false);
    expect(cornered.success?.(outcome({ deaths: 1 }), {})).toBe(false);
  });
  it("judges mixed on the creeper and the player, not on mobs the skeleton killed", () => {
    const judge = (x: RunOutcome) => mixed.success?.(x, {});
    expect(judge(outcome({ kills: 3, lost: 1 }))).toBe(true);
    expect(judge(outcome({ kills: 3, lost: 1, exploded: 1 }))).toBe(false);
    expect(judge(outcome({ blastDamage: 2 }))).toBe(false);
    expect(judge(outcome({ deaths: 1 }))).toBe(false);
  });
});
