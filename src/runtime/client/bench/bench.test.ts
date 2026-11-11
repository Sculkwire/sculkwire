import { describe, expect, it } from "vitest";
import { arenaCommands, arenaOrigin, FILL_LIMIT, fillBox, playerCommands, summonCommand } from "./arena.ts";
import { markdownTable, summarize, worldEntryOf, type RunRecord } from "./report.ts";
import { CommandWrong, loadScenarios, tracePathFor, withPhrasing, wrongCommand } from "./run.ts";
import cornered, { pen } from "./scenarios/combat-cornered.ts";
import husks3 from "./scenarios/combat-husks3.ts";
import mixed from "./scenarios/combat-mixed.ts";
import { claimSpawned, countKills } from "./spawns.ts";
import { parseStances, withStance } from "./stance.ts";
import { traceMetrics } from "./trace.ts";
import type { BenchContext, RunOutcome } from "./types.ts";
import { parseViews, viewValue } from "./view.ts";
import type { EntityInfo } from "../player.ts";
import { parseGoal } from "../skills/goal.ts";
import type { PlayAction, PlayResult } from "../skills/play.ts";
import { offerText, planStepLines } from "./plankit.ts";
import type { TraceFrame, TraceMob } from "../skills/stats.ts";

describe("arena commands", () => {
  it("splits a big fill into slabs under the block limit", () => {
    const cmds = fillBox({ x: 0, y: 0, z: 0 }, { x: 99, y: 9, z: 99 }, "air");
    expect(cmds.length).toBe(4);
    for (const c of cmds) {
      const [x0, y0, z0, x1, y1, z1] = c.split(" ").slice(1, 7).map(Number) as number[];
      expect(((x1 as number) - (x0 as number) + 1) * ((y1 as number) - (y0 as number) + 1) * ((z1 as number) - (z0 as number) + 1)).toBeLessThanOrEqual(FILL_LIMIT);
    }
    expect(cmds.at(-1)).toMatch(/ 99 9 99 air$/);
  });
  it("clears the box, lays the floor, and sets the player up", () => {
    const o = arenaOrigin(1);
    const cmds = arenaCommands({ area: { radius: 2, height: 3 } }, o);
    expect(cmds).toEqual([`fill ${o.x - 2} ${o.y} ${o.z - 2} ${o.x + 2} ${o.y + 3} ${o.z + 2} air`, `fill ${o.x - 2} ${o.y - 1} ${o.z - 2} ${o.x + 2} ${o.y - 1} ${o.z + 2} minecraft:grass_block`]);
    const p = playerCommands({ time: "night", hotbar: [{ item: "iron_sword" }, { item: "cooked_beef", amount: 16 }], armor: "iron", offhand: "shield" }, o);
    expect(p).toContain("gamemode survival @a");
    expect(p).toContain("time set 18000");
    expect(p).toContain("replaceitem entity @a slot.hotbar 1 minecraft:cooked_beef 16");
    expect(p).toContain("replaceitem entity @a slot.armor.chest 0 minecraft:iron_chestplate 1");
    expect(p).toContain("replaceitem entity @a slot.weapon.offhand 0 minecraft:shield 1");
    expect(p.at(-1)).toBe(`tp @a ${o.x + 0.5} ${o.y} ${o.z + 0.5} 0 0`);
    expect(summonCommand({ type: "zombie", at: { dx: 0, dy: 0, dz: 10 } }, o)).toBe(`summon minecraft:zombie ${o.x + 0.5} ${o.y} ${o.z + 10.5} 0 0 minecraft:as_adult`);
  });
});

describe("build commands", () => {
  const LINE = "summon minecraft:villager_v2 5480.5 -60 1004.5 0 0 minecraft:spawn_farmer";
  const SYNTAX = 'Syntax error: Unexpected "minecraft:villager_v2": at "summon >>minecraft:villager_v2<< 5480.5 -6"';
  it("turns a syntax error into the run's failure with the game's text, whatever the success flag said", () => {
    const wrong = wrongCommand(LINE, [SYNTAX]);
    expect(wrong).toBeInstanceOf(CommandWrong);
    expect(wrong?.message).toBe(`/${LINE} failed: ${SYNTAX}`);
    expect(wrongCommand("summon x", ["", SYNTAX])).toBeInstanceOf(CommandWrong);
    expect(wrongCommand("frobnicate", ["Unknown command: frobnicate. Please check that the command exists"])).toBeInstanceOf(CommandWrong);
  });
  it("lets a command that found nothing to change pass", () => {
    expect(wrongCommand("kill @e[type=!player]", ["No targets matched selector"])).toBeUndefined();
    expect(wrongCommand("fill 0 0 0 1 1 1 air", ["0 blocks filled"])).toBeUndefined();
  });
  it("summons villagers by the name the summon command takes (villager, not villager_v2)", async () => {
    const o = arenaOrigin(2);
    const ctx = { origin: o, at: (x: { dx: number; dy: number; dz: number }) => ({ x: o.x + x.dx, y: o.y + x.dy, z: o.z + x.dz }) } as BenchContext;
    const summons = (await loadScenarios()).flatMap((s) => ("build" in s && s.build ? s.build(ctx) : [])).filter((line) => line.startsWith("summon "));
    expect(summons.some((line) => line.startsWith("summon minecraft:villager "))).toBe(true);
    expect(summons.filter((line) => /_v2\b/.test(line))).toEqual([]);
  });
  it("fixes the trade villager's profession with become_farmer and reports what it offered", async () => {
    const trade = (await loadScenarios()).find((s) => s.suite === "task" && s.name === "trade");
    const o = arenaOrigin(2);
    const ctx = { origin: o, at: (x: { dx: number; dy: number; dz: number }) => ({ x: o.x + x.dx, y: o.y + x.dy, z: o.z + x.dz }) } as BenchContext;
    const build = trade && "build" in trade && trade.build ? trade.build(ctx) : [];
    expect(build.filter((line) => line.startsWith("summon "))).toEqual([`summon minecraft:villager ${o.x + 0.5} ${o.y} ${o.z + 4.5} 0 0 minecraft:become_farmer`]);
    const line = "offers of the villager at 1 64 4: 1 emerald for 32 stick; 6 bread for 1 emerald";
    const play = { plan: [{ text: "trade for an emerald", kind: "trade", by: "builtin", status: "failed", ok: false, message: "", ms: 1, actions: ["walked to the villager at 1 64 4", line] }] } as unknown as PlayResult;
    expect(offerText(play)).toBe(line);
    expect(offerText(undefined)).toBe("");
  });
  it("writes each task step's header and actions into the run record, at most 60 lines", () => {
    const play = {
      plan: [
        { text: "fetch all diamonds", kind: "fetch", by: "builtin", status: "failed", ok: false, message: "took 1 of the 3 diamond", ms: 1, reason: "not_found", actions: ["walked to the chest at 3 64 4", "moved 1 diamond"] },
        { text: "go home", kind: "free", by: "builtin", status: "pending", ok: false, message: "", ms: 0 },
      ],
    } as unknown as PlayResult;
    expect(planStepLines(play)).toEqual(['fetch "fetch all diamonds": failed not_found: took 1 of the 3 diamond', "  walked to the chest at 3 64 4", "  moved 1 diamond"]);
    const long = { plan: [{ text: "t", kind: "fetch", by: "builtin", status: "done", ok: true, message: "ok", ms: 1, actions: Array.from({ length: 100 }, (_, i) => `a${i}`) }] } as unknown as PlayResult;
    const lines = planStepLines(long);
    expect(lines).toHaveLength(60);
    expect(lines.at(-1)).toBe("... 42 more lines");
  });
});

describe("report", () => {
  const rec = (run: number, success: boolean, health: number, extra: RunRecord["extra"] = {}): RunRecord => ({
    run,
    success,
    outcome: { ok: success, message: "", durationMs: 10_000, healthStart: 20, healthEnd: health, damageTaken: 20 - health, blastDamage: 0, fallDamage: 0, falls: 0, deaths: health === 0 ? 1 : 0, kills: success ? 3 : 1, lost: 0, exploded: 0, hurts: 2 },
    extra,
    note: "",
  });
  it("averages the runs and prints one row per scenario", () => {
    const r = summarize("zombies3", "combat", "engine", [rec(1, true, 14, { cleared: true, hits: 6 }), rec(2, false, 0, { cleared: false, hits: 4 })]);
    expect(r.summary).toMatchObject({ runs: 2, successes: 1, avgHealthLeft: 7, minHealthLeft: 0, deaths: 1, kills: 4, extra: { cleared: 1, hits: 5 } });
    expect(markdownTable([r])).toMatch(/\| zombies3 \| engine \| 1\/2 \| 10 \| 13 \| 7 \| 0 \| 1 \| 4 \|/);
  });
  it("judges mixed on the creeper and the player, not on mobs the skeleton killed", () => {
    const o = (over: Partial<RunOutcome>): RunOutcome => ({ ...rec(1, true, 14).outcome, hurts: [], ...over });
    const judge = (x: RunOutcome) => mixed.success?.(x, {});
    expect(judge(o({ kills: 3, lost: 1 }))).toBe(true);
    expect(judge(o({ kills: 3, lost: 1, exploded: 1 }))).toBe(false);
    expect(judge(o({ blastDamage: 2 }))).toBe(false);
    expect(judge(o({ deaths: 1 }))).toBe(false);
  });
  it("adds a view column only when the reports carry a view", () => {
    const first = { ...summarize("husks3", "combat", "engine", [rec(1, true, 14)]), view: "first" as const };
    const third = { ...summarize("husks3", "combat", "engine", [rec(1, false, 0)]), view: "third" as const };
    const table = markdownTable([first, third]).split("\n");
    expect(table[0]).toMatch(/^\| scenario \| input \| view \| success \|/);
    expect(table[1]?.split("|").length).toBe(table[0]?.split("|").length);
    expect(table[2]).toMatch(/^\| husks3 \| engine \| first \| 1\/1 \|/);
    expect(table[3]).toMatch(/^\| husks3 \| engine \| third \| 0\/1 \|/);
    expect(markdownTable([summarize("husks3", "combat", "engine", [rec(1, true, 14)])])).not.toMatch(/view/);
  });
  it("adds a stance column after the view only when the reports carry a stance", () => {
    const kite = { ...summarize("cornered", "combat", "engine", [rec(1, true, 14)]), view: "first" as const, stance: "kite" as const };
    const guard = { ...summarize("cornered", "combat", "engine", [rec(1, false, 0)]), view: "first" as const, stance: "guard" as const };
    const table = markdownTable([kite, guard]).split("\n");
    expect(table[0]).toMatch(/^\| scenario \| input \| view \| stance \| success \|/);
    expect(table[1]?.split("|").length).toBe(table[0]?.split("|").length);
    expect(table[2]).toMatch(/^\| cornered \| engine \| first \| kite \| 1\/1 \|/);
    expect(table[3]).toMatch(/^\| cornered \| engine \| first \| guard \| 0\/1 \|/);
    expect(markdownTable([summarize("cornered", "combat", "engine", [rec(1, true, 14)])])).not.toMatch(/stance/);
  });
});

describe("stances", () => {
  it("parses one stance or a list, and refuses anything else", () => {
    expect(parseStances("guard")).toEqual(["guard"]);
    expect(parseStances("kite, guard,auto,kite")).toEqual(["kite", "guard", "auto"]);
    expect(parseStances("")).toBeUndefined();
    expect(parseStances("kite,")).toBeUndefined();
    expect(parseStances("block")).toBeUndefined();
  });
  it("sets the stance on a play goal and a fight, and leaves other actions alone", () => {
    expect(withStance({ action: "play", goal: "kill all the zombies" }, "guard")).toEqual({ action: "play", goal: "kill all the zombies", stance: "guard" });
    expect(withStance({ action: "fight", target: "zombie" }, "kite")).toEqual({ action: "fight", target: "zombie", stance: "kite" });
    expect(withStance({ action: "goto", x: 1, z: 2 }, "kite")).toEqual({ action: "goto", x: 1, z: 2 });
    expect(withStance({ action: "play", goal: "kill 3 husks" }, undefined)).toEqual({ action: "play", goal: "kill 3 husks" });
  });
});

describe("phrasings", () => {
  it("plays phrasing i on run i, and leaves other actions alone", () => {
    const goals = ["a", "b", "c"];
    expect([1, 2, 3, 4].map((run) => (withPhrasing({ action: "play", goal: "x" }, goals, run) as PlayAction).goal)).toEqual(["a", "b", "c", "a"]);
    expect(withPhrasing({ action: "goto", x: 1, z: 2 }, goals, 1)).toEqual({ action: "goto", x: 1, z: 2 });
  });
  it("gives every goal and task scenario ten different phrasings", async () => {
    const all = await loadScenarios();
    const phrased = all.filter((s) => s.suite === "goal" || s.suite === "task");
    expect(phrased.map((s) => `${s.suite}/${s.name}`).sort()).toEqual([
      "goal/kill-phrased",
      "goal/reach-phrased",
      "goal/two-step",
      "task/blocked-chest",
      "task/blocked-chest-villager",
      "task/far-table",
      "task/nested-shulker",
      "task/smelt-craft",
      "task/trade",
    ]);
    for (const s of phrased) {
      const goals = "goals" in s ? (s.goals ?? []) : [];
      expect(new Set(goals).size).toBe(10);
    }
  });
});

describe("views", () => {
  it("parses one view or both, and refuses anything else", () => {
    expect(parseViews("first")).toEqual(["first"]);
    expect(parseViews("third, first")).toEqual(["third", "first"]);
    expect(parseViews("first,first")).toEqual(["first"]);
    expect(parseViews("")).toBeUndefined();
    expect(parseViews("first,")).toBeUndefined();
    expect(parseViews("front")).toBeUndefined();
  });
  it("writes game_thirdperson in the type the game reports", () => {
    expect(viewValue("first", { type: "int" })).toBe(0);
    expect(viewValue("third", { type: "int" })).toBe(1);
    expect(viewValue("third", { type: "bool" })).toBe(true);
    expect(viewValue("third", { type: "enum", values: ["first", "back", "front"] })).toBe("back");
  });
  it("puts the trace file next to the report", () => {
    expect(tracePathFor("/c/bench/combat-husks3-2026.json")).toBe("/c/bench/combat-husks3-2026.trace.json");
  });
});

describe("trace metrics", () => {
  const mob = (over: Partial<TraceMob> = {}): TraceMob => ({ id: "z1", type: "zombie", dist: 5, reach: 2.5, coolMs: 0, offViewDeg: 0, closing: 0, target: true, ...over });
  const frame = (t: number, over: Partial<TraceFrame> = {}): TraceFrame => ({
    t,
    x: 0,
    z: 0,
    onGround: true,
    mobs: [],
    foot: "hold",
    plan: "wait",
    readyMs: 0,
    shield: false,
    aimErr: 0,
    aimTol: 10,
    fwd: 0,
    strafe: 0,
    sprint: false,
    ...over,
  });
  // A hit, a step back out of reach, a second hit stood still in reach through a 200 ms stall, then a swing.
  const frames: TraceFrame[] = [
    frame(0, { mobs: [mob({ dist: 2.5 }), mob({ id: "s1", type: "skeleton", dist: 10, reach: 15, target: false })], readyMs: 300, shield: true, ev: ["swing", "hit"], aimErr: 4 }),
    frame(25, { x: 0.05, mobs: [mob({ dist: 2.7 })], foot: "retreat", readyMs: 275 }),
    frame(50, { x: 0.1, mobs: [mob({ dist: 3.1 })], foot: "retreat" }),
    frame(75, { x: 0.1, mobs: [mob({ dist: 2.4 }), mob({ id: "z2", dist: 1, reach: 2, target: false })], foot: "advance", readyMs: 500, ev: ["swing", "hit"], aimErr: 6 }),
    frame(275, { x: 0.1, mobs: [mob({ dist: 2.4, coolMs: 800 })], readyMs: 50 }),
    frame(300, { x: 0.1, mobs: [mob({ dist: 2.4 })], ev: ["swing"], aimErr: 8 }),
  ];
  it("reads step-backs, time in reach, idling, shield and footwork off the frames", () => {
    expect(traceMetrics(frames)).toEqual({
      hits: 2,
      stepBacks: 1,
      stepBackShare: 0.5,
      blocks: 0,
      idleInReachMs: 100,
      inReachStillMs: 100,
      inReachMs: 150,
      shieldMs: 25,
      retreatMs: 50,
      advanceMs: 100,
      holdMs: 50,
      maxMobsInReach: 2,
      aimErrAtSwing: 6,
    });
  });
  it("counts blocks, and standing still behind the raised shield is not idle exposure", () => {
    const guarded: TraceFrame[] = [
      frame(0, { mobs: [mob({ dist: 2 })], readyMs: 400, shield: true, foot: "guard" }),
      frame(25, { mobs: [mob({ dist: 2 })], readyMs: 375, shield: true, foot: "guard", ev: ["block"] }),
      frame(50, { mobs: [mob({ dist: 2 })], readyMs: 350, shield: false }),
      frame(75, { mobs: [mob({ dist: 2 })], readyMs: 325, shield: true, ev: ["block"] }),
      frame(100, { mobs: [mob({ dist: 2 })] }),
    ];
    expect(traceMetrics(guarded)).toMatchObject({ blocks: 2, idleInReachMs: 25, inReachStillMs: 100, shieldMs: 75, hits: 0, stepBacks: 0, stepBackShare: 0 });
  });
  it("is all zero for no frames, with no aim figure", () => {
    expect(traceMetrics([])).toEqual({
      hits: 0,
      stepBacks: 0,
      stepBackShare: 0,
      blocks: 0,
      idleInReachMs: 0,
      inReachStillMs: 0,
      inReachMs: 0,
      shieldMs: 0,
      retreatMs: 0,
      advanceMs: 0,
      holdMs: 0,
      maxMobsInReach: 0,
    });
  });
  it("lands in a combat scenario's extras next to the fight's own counts", async () => {
    const outcome: RunOutcome = { ok: true, message: "", durationMs: 1, healthStart: 20, healthEnd: 20, damageTaken: 0, blastDamage: 0, fallDamage: 0, falls: 0, deaths: 0, kills: 3, lost: 0, exploded: 0, hurts: [], frames };
    const extra = await husks3.measure?.({} as BenchContext, outcome);
    expect(extra).toMatchObject({ stepBacks: 1, stepBackShare: 0.5, blocks: 0, idleInReachMs: 100, inReachStillMs: 100, inReachMs: 150, maxMobsInReach: 2, aimErrAtSwing: 6, hits: 0, misses: 0, crits: 0, blocked: 0, cleared: true });
    const played = { ...outcome, play: { stats: { swings: 4, hits: 3, misses: 1, crits: 0, blocked: 2 }, trace: [] } } as unknown as RunOutcome;
    expect(await husks3.measure?.({} as BenchContext, played)).toMatchObject({ blocked: 2, hits: 3 });
  });
});

describe("scenarios", () => {
  it("loads every combat scenario with the standard loadout", async () => {
    const all = await loadScenarios();
    const combat = all.filter((s) => s.suite === "combat").map((s) => s.name);
    expect(combat).toEqual(expect.arrayContaining(["zombies3", "creeper", "creeper-bow", "skeleton2", "spider2", "mixed", "husks3", "cornered"]));
    expect(new Set(all.map((s) => s.name)).size).toBe(all.length);
  });
  it("summons husks3's group after the action started, with a goal that counts kills", () => {
    expect(husks3.spawnAfterMs).toBe(500);
    expect(husks3.player).toMatchObject({ gameMode: "survival", time: "day", armor: "iron", offhand: "shield" });
    expect(husks3.mobs?.map((m) => [m.type, m.at.dx, m.at.dz])).toEqual([
      ["husk", -1, 10],
      ["husk", 0, 10],
      ["husk", 1, 10],
    ]);
    const spec = husks3.action({} as BenchContext);
    // A count goal is done at 3 kills; "all the husks" would be done before they exist (none left near).
    expect(spec.action).toBe("play");
    expect(parseGoal((spec as PlayAction).goal)).toMatchObject({ kind: "kill", type: "minecraft:husk", count: 3 });
  });
  it("builds cornered's dead-end pen: stone behind and to each side, open to the front where the zombies come from", () => {
    const o = arenaOrigin(3);
    const stone = new Set<string>();
    for (const c of pen(o)) {
      const [x0, y0, z0, x1, y1, z1] = c.split(" ").slice(1, 7).map(Number) as [number, number, number, number, number, number];
      expect(c.endsWith(" minecraft:stone")).toBe(true);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) stone.add(`${x - o.x},${y - o.y},${z - o.z}`);
    }
    const expected = new Set<string>();
    for (let y = 0; y < 3; y++) for (const [dx, dz] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0]] as const) expected.add(`${dx},${y},${dz}`);
    expect(stone).toEqual(expected);
    // The pen is part of the arena build, after the glass ring.
    const build = cornered.build?.({ origin: o } as BenchContext) ?? [];
    expect(build.slice(-pen(o).length)).toEqual(pen(o));
    expect(cornered.player).toMatchObject({ gameMode: "survival", time: "night", armor: "iron", offhand: "shield" });
    expect(cornered.player.at ?? { dx: 0, dy: 0, dz: 0 }).toEqual({ dx: 0, dy: 0, dz: 0 });
    expect(cornered.player.yaw ?? 0).toBe(0);
    expect(cornered.runs).toBe(10);
    expect(cornered.mobs?.map((m) => [m.type, m.at.dx, m.at.dz])).toEqual([
      ["zombie", -2, 8],
      ["zombie", 0, 8],
      ["zombie", 2, 8],
    ]);
    expect(parseGoal((cornered.action({} as BenchContext) as PlayAction).goal)).toMatchObject({ kind: "kill", type: "minecraft:zombie" });
    const o3 = (over: Partial<RunOutcome>): RunOutcome => ({ ok: true, message: "", durationMs: 1, healthStart: 20, healthEnd: 20, damageTaken: 0, blastDamage: 0, fallDamage: 0, falls: 0, deaths: 0, kills: 3, lost: 0, exploded: 0, hurts: [], ...over });
    expect(cornered.success?.(o3({}), {})).toBe(true);
    expect(cornered.success?.(o3({ kills: 2 }), {})).toBe(false);
    expect(cornered.success?.(o3({ deaths: 1 }), {})).toBe(false);
  });
});

describe("spawned mobs", () => {
  const o = arenaOrigin(0);
  const at = (x: { dx: number; dy: number; dz: number }) => ({ x: o.x + x.dx, y: o.y + x.dy, z: o.z + x.dz });
  const spawns = [
    { type: "husk", at: { dx: -1, dy: 0, dz: 10 } },
    { type: "husk", at: { dx: 0, dy: 0, dz: 10 } },
    { type: "husk", at: { dx: 1, dy: 0, dz: 10 } },
  ];
  const ent = (id: string, dx: number, typeId = "minecraft:husk") => ({ id, typeId, location: { x: o.x + dx + 0.5, y: o.y, z: o.z + 10.5 } }) as EntityInfo;
  it("claims the nearest unclaimed entity per spawn, keeping what earlier polls found", () => {
    const first = claimSpawned(spawns, at, [ent("b", 0), ent("z", -1, "minecraft:zombie")], [undefined, undefined, undefined]);
    // One husk so far: the first spawn takes it, the others wait for the next poll.
    expect(first).toEqual([{ id: "b", typeId: "minecraft:husk" }, undefined, undefined]);
    const second = claimSpawned(spawns, at, [ent("b", 0), ent("a", -1), ent("c", 1)], first);
    expect(second.map((m) => m?.id)).toEqual(["b", "a", "c"]);
  });
  it("counts kills by id, and a never-seen spawn by a player kill of its type, at most one each", () => {
    const found = [{ id: "a", typeId: "minecraft:husk" }, undefined, undefined];
    const deaths = [
      { tick: 1, id: "a", typeId: "minecraft:husk", killer: "minecraft:player" },
      { tick: 2, id: "x", typeId: "minecraft:husk", killer: "minecraft:player" },
      { tick: 3, id: "y", typeId: "minecraft:husk", killer: "minecraft:zombie" },
      { tick: 4, id: "z", typeId: "minecraft:zombie", killer: "minecraft:player" },
    ];
    expect(countKills(spawns, found, deaths)).toEqual({ resolved: 1, unresolved: 1 });
    const extra = [...deaths, { tick: 5, id: "w", typeId: "minecraft:husk", killer: "minecraft:player" }, { tick: 6, id: "v", typeId: "minecraft:husk", killer: "minecraft:player" }];
    expect(countKills(spawns, found, extra)).toEqual({ resolved: 1, unresolved: 2 });
    // Every spawn resolved: other player kills of the type do not count.
    expect(countKills(spawns, [found[0], { id: "b", typeId: "minecraft:husk" }, { id: "c", typeId: "minecraft:husk" }], extra)).toEqual({ resolved: 1, unresolved: 0 });
  });
});

describe("world entry", () => {
  it("reports how the bridge reached the world, and says so when it never did", () => {
    const walked = worldEntryOf({ entry: () => ({ by: "auto-enter", seconds: 146.4, clicks: 3 }) });
    expect(walked.entry).toEqual({ by: "auto-enter", seconds: 146.4, clicks: 3 });
    expect(walked.footer).toBe("World entry: auto-enter in 146.4 s from the bridge's start, 3 inputs walking the menus");
    expect(worldEntryOf({ entry: () => ({ by: "launch", seconds: 41 }) }).footer).toBe("World entry: launch in 41 s from the bridge's start");
    const never = worldEntryOf({ entry: () => undefined });
    expect(never.entry).toBeUndefined();
    expect(never.footer).toMatch(/not recorded/);
  });
});
