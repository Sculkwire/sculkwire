/**
 * The bench runner: launch a sculkwire world, attach the input provider when one is installed, then for every
 * scenario and run clear and build
 * its arena, set the player up, spawn the mobs, run the action or `play` goal, measure, and reset. Ends with the
 * game stopped (unless asked to keep it).
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { cacheDir } from "../../../core/paths.ts";
import { inputProvider } from "../inputprovider.ts";
import { bridge } from "../bridge.ts";
import type { LaunchMode } from "../launcher.ts";
import { FOREGROUND_MESSAGE } from "../windows.ts";
import type { ActionResult, EntityInfo, InputMode, Loadout, PlayerAction, PlayerController } from "../player.ts";
import { play, type Death, type PlayAction, type PlayResult } from "../skills/play.ts";
import { combatStats } from "../skills/stats.ts";
import { arenaCommands, arenaOrigin, clearMobsCommand, offsetAt, playerCommands, summonCommand, typeId, WORLD_RULES } from "./arena.ts";
import { markdownTable, summarize, type RunRecord, type ScenarioReport } from "./report.ts";
import type { BenchContext, Hurt, Metric, RunOutcome, Scenario } from "./types.ts";

const SCENARIO_DIR = join(dirname(fileURLToPath(import.meta.url)), "scenarios");

/**
 * Every scenario file in `scenarios/` (default export or `scenarios` array), in name order. The folder is scanned at
 * run time on purpose: each suite's owner adds files without editing a shared index.
 */
export async function loadScenarios(): Promise<Scenario[]> {
  const files = (await readdir(SCENARIO_DIR)).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f)).sort();
  const out: Scenario[] = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(join(SCENARIO_DIR, f)).href)) as { default?: Scenario; scenarios?: Scenario[] };
    if (mod.default) out.push(mod.default);
    if (mod.scenarios) out.push(...mod.scenarios);
  }
  return out;
}

export interface BenchOptions {
  suite: string;
  scenario?: string;
  runs?: number;
  input: InputMode;
  display?: LaunchMode;
  /** Leave the game running at the end. */
  keep?: boolean;
  log?: (line: string) => void;
}

export interface BenchReport {
  suite: string;
  startedAt: string;
  input: string;
  reports: ScenarioReport[];
  table: string;
  jsonPath: string;
}

/** The command route: /connect when it answers, the script debugger once /connect has timed out. */
let route: "auto" | "debugger" = "auto";

/**
 * Failures that mean the command itself is wrong. /connect also reports a command that found nothing to change as
 * an error (`No targets matched`, `0 blocks filled`, `no items to remove`, a door half already placed), which the
 * reset hits every run, so only these count, as on the script debugger route.
 */
const COMMAND_WRONG = /^Syntax error|^Unknown command/i;

async function command(line: string): Promise<void> {
  let r;
  try {
    r = await bridge.command(line, route);
  } catch (err) {
    if (route === "debugger" || !/time(d)? ?out/i.test(err instanceof Error ? err.message : String(err))) throw err;
    route = "debugger";
    r = await bridge.command(line, route);
  }
  if (!r.ok && r.output.some((o) => COMMAND_WRONG.test(o))) throw new Error(`/${line} failed: ${r.output.join(" ")}`);
}

/** Commands that touch blocks fail while the chunks load: retry a few times. */
async function commandRetry(line: string, tries = 6): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await command(line);
      return;
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(500);
    }
  }
}

async function hurtsSince(since: number): Promise<{ tick: number; hurts: Hurt[] } | undefined> {
  return (await bridge.query("hurts", { since }).catch(() => undefined)) as { tick: number; hurts: Hurt[] } | undefined;
}

async function deathsSince(since: number): Promise<{ tick: number; deaths: Death[] }> {
  return (await bridge.query("deaths", { since })) as { tick: number; deaths: Death[] };
}

function playEnv(controller: PlayerController) {
  return {
    controller,
    entities: async (radius: number) => (controller.world.entities ? controller.world.entities(radius) : ((await bridge.query("entities", { radius, limit: 50 })) as EntityInfo[])),
    loadout: async () => (await bridge.query("loadout")) as Loadout,
    deaths: (since: number) => deathsSince(since),
  };
}

/** Wait until the player stands near `at` (the teleport landed and the chunks are there). */
async function waitArrived(at: { x: number; z: number }, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await bridge.playerState(300);
    if (Math.hypot(s.location.x - at.x - 0.5, s.location.z - at.z - 0.5) < 1.5 && s.onGround) return;
    if (Date.now() > deadline) throw new Error(`the player did not arrive at ${at.x} ${at.z} (at ${s.location.x} ${s.location.z})`);
    await sleep(200);
  }
}

/** The spawned mobs' ids: the nearest unclaimed entity of each spawn's type to its spawn point. */
async function findSpawned(s: Scenario, ctx: Pick<BenchContext, "at">): Promise<{ id: string; typeId: string }[]> {
  if (!s.mobs?.length) return [];
  const list = (await bridge.query("entities", { ...ctx.at({ dx: 0, dy: 0, dz: 0 }), radius: s.area.radius + 8, limit: 100 })) as EntityInfo[];
  const claimed = new Set<string>();
  const out: { id: string; typeId: string }[] = [];
  for (const m of s.mobs) {
    const t = typeId(m.type);
    const p = ctx.at(m.at);
    const pick = list
      .filter((e) => e.typeId === t && !claimed.has(e.id))
      .sort((a, b) => Math.hypot(a.location.x - p.x, a.location.z - p.z) - Math.hypot(b.location.x - p.x, b.location.z - p.z))[0];
    if (pick) {
      claimed.add(pick.id);
      out.push({ id: pick.id, typeId: pick.typeId });
    }
  }
  return out;
}

function shortNote(play: PlayResult | undefined, action: ActionResult | undefined): string {
  if (play) {
    const counts = new Map<string, number>();
    for (const st of play.trace) counts.set(st.action, (counts.get(st.action) ?? 0) + 1);
    return `${play.stoppedBy}: ${play.message}; tactics ${[...counts].map(([k, v]) => `${k} ${v}`).join(", ")}`;
  }
  return action ? action.message : "";
}

async function runOnce(s: Scenario, index: number, run: number, controller: PlayerController, log: (l: string) => void): Promise<RunRecord> {
  const origin = arenaOrigin(index);
  const at = (o: { dx: number; dy: number; dz: number }) => offsetAt(origin, o);
  const start = at(s.player.at ?? { dx: 0, dy: 0, dz: 0 });
  // Get there first, so the arena's chunks are loaded before the blocks change.
  await command(`gamemode creative @a`);
  await command(`tp @a ${start.x + 0.5} ${start.y + 1} ${start.z + 0.5}`);
  await sleep(run === 1 ? 2500 : 600);
  await commandRetry(clearMobsCommand(s, origin));
  for (const c of arenaCommands(s, origin)) await commandRetry(c);
  const ctx: BenchContext = {
    scenario: s.name,
    run,
    input: controller.input,
    origin,
    at,
    command: (line) => bridge.command(line, route),
    query: (kind, params) => bridge.query(kind, params),
    controller,
    mobs: [],
    sleep: (ms) => sleep(ms),
  };
  for (const c of s.build?.(ctx) ?? []) await commandRetry(c);
  for (const c of playerCommands(s.player, origin)) await command(c);
  await waitArrived(start);
  await controller.hands.selectSlot(1).catch(() => false);
  // Let the heal and the saturation land before the clock starts.
  await sleep(700);
  for (const m of s.mobs ?? []) await commandRetry(summonCommand(m, origin));
  await sleep(250);
  ctx.mobs = await findSpawned(s, ctx);

  const before = await bridge.playerState(200);
  const hurtTick = (await hurtsSince(Number.MAX_SAFE_INTEGER))?.tick;
  const deathTick = (await deathsSince(Number.MAX_SAFE_INTEGER)).tick;
  const healthStart = before.health ?? 20;
  const spec = s.action(ctx);
  const ctrl = new AbortController();
  let died = false;
  let lowest = healthStart;
  let watching = true;
  // Watch health: a death ends the run at once (the player respawns far away).
  const watch = (async () => {
    while (watching) {
      const st = await bridge.playerState(300).catch(() => undefined);
      if (st?.health !== undefined) {
        lowest = Math.min(lowest, st.health);
        if (st.health <= 0) {
          died = true;
          ctrl.abort();
          return;
        }
      }
      await sleep(150);
    }
  })();
  const started = Date.now();
  let action: ActionResult | undefined;
  let played: PlayResult | undefined;
  const limit = setTimeout(() => ctrl.abort(), s.timeoutMs + 5000);
  try {
    if (spec.action === "play") {
      played = await play({ ...(spec as PlayAction), advisor: false, durationMs: (spec as PlayAction).durationMs ?? s.timeoutMs }, playEnv(controller), { signal: ctrl.signal });
    } else {
      action = await controller.run(spec as PlayerAction, ctrl.signal);
    }
  } finally {
    clearTimeout(limit);
    watching = false;
    await watch;
    await controller.releaseAll();
  }
  const durationMs = Date.now() - started;
  const after = await bridge.playerState(300);
  const hurts = hurtTick !== undefined ? ((await hurtsSince(hurtTick))?.hurts ?? []) : [];
  const deaths = (await deathsSince(deathTick)).deaths;
  const ids = new Set(ctx.mobs.map((m) => m.id));
  const kills = deaths.filter((d) => ids.has(d.id) && d.killer === "minecraft:player").length;
  const alive = new Set(((await bridge.query("entities", { ...origin, radius: s.area.radius + 24, limit: 100 })) as EntityInfo[]).map((e) => e.id));
  const lost = ctx.mobs.filter((m) => !alive.has(m.id)).length - kills;
  const killed = new Set(deaths.filter((d) => d.killer === "minecraft:player").map((d) => d.id));
  const exploded = ctx.mobs.filter((m) => m.typeId === "minecraft:creeper" && !alive.has(m.id) && !killed.has(m.id)).length;
  const playerDeaths = deaths.filter((d) => d.typeId === "minecraft:player").length || (died ? 1 : 0);
  const healthEnd = playerDeaths > 0 ? 0 : (after.health ?? 0);
  const sum = (f: (h: Hurt) => boolean) => Math.round(hurts.filter(f).reduce((t, h) => t + h.damage, 0) * 10) / 10;
  const blast = (h: Hurt) => /explosion/i.test(h.cause ?? "");
  const fall = (h: Hurt) => h.cause === "fall";
  const outcome: RunOutcome = {
    ok: played ? played.stoppedBy === "goal_done" : (action?.ok ?? false),
    message: played ? played.message : (action?.message ?? ""),
    durationMs,
    healthStart,
    healthEnd,
    // The helper's hurt log when it has one, else the play loop's count or the lowest health seen.
    damageTaken: hurtTick !== undefined ? sum(() => true) : (played?.stats.damageTaken ?? Math.max(0, healthStart - lowest)),
    blastDamage: sum(blast),
    fallDamage: sum(fall),
    falls: hurts.filter(fall).length,
    deaths: playerDeaths,
    kills,
    lost: Math.max(0, lost),
    exploded,
    hurts,
    state: after,
    ...(action ? { action } : {}),
    ...(played ? { play: played } : {}),
  };
  const extra: Record<string, Metric> = (await s.measure?.(ctx, outcome)) ?? {};
  const success = s.success ? s.success(outcome, extra) : outcome.ok && outcome.deaths === 0;
  const note = shortNote(played, action);
  log(
    `${s.name} run ${run}: ${success ? "ok" : "FAIL"} in ${(durationMs / 1000).toFixed(1)} s, health ${healthStart} -> ${healthEnd}, ` +
      `damage ${outcome.damageTaken}${outcome.blastDamage ? ` (blast ${outcome.blastDamage})` : ""}, kills ${kills}, lost ${outcome.lost}, deaths ${playerDeaths}. ${note}`,
  );
  await command(clearMobsCommand(s, origin)).catch(() => undefined);
  const { hurts: _h, state: _s, action: _a, play: _p, ...rest } = outcome;
  // The helper's hurt log (who hit, how hard) and what the fight saw around each hit.
  const trace = played ? [...hurts.map((h) => `hurt tick ${h.tick} ${h.damage} by ${h.damager ?? h.cause ?? "?"}`), ...combatStats(controller).events] : [];
  return { run, success, outcome: { ...rest, hurts: hurts.length }, extra, note, ...(trace.length ? { trace } : {}) };
}

export async function runBench(opts: BenchOptions): Promise<BenchReport> {
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const all = await loadScenarios();
  const names = opts.scenario?.split(",").map((n) => n.trim());
  const picked = all.filter((s) => (opts.suite === "all" || s.suite === opts.suite) && (!names || names.includes(s.name)));
  if (picked.length === 0) {
    const known = all.map((s) => `${s.suite}/${s.name}`).join(", ");
    throw new Error(`no scenario matches suite ${opts.suite}${opts.scenario ? ` and name ${opts.scenario}` : ""}; known: ${known}`);
  }
  const startedAt = new Date().toISOString();
  log(`launching the game (${opts.display ?? "window"}, muted, difficulty normal)`);
  await bridge.start({ mode: opts.display ?? "window", mute: true, difficulty: "normal", world: "bench" });
  const reports: ScenarioReport[] = [];
  try {
    const provider = inputProvider();
    if (provider && opts.input !== "keyboard") {
      try {
        await provider.attach();
      } catch (err) {
        if (opts.input === "engine") throw err;
        log(`${provider.name} attach failed, using the keyboard: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const controller = bridge.playerController();
    const input = await controller.selectInput(opts.input);
    log(`input: ${input}`);
    // Windows keyboard input reaches the game only while its window is in the foreground: bring it forward once.
    const gate = input === "keyboard" ? controller.world.input.foreground : undefined;
    if (gate) {
      log("bringing the game window to the foreground; leave it there until the bench ends");
      await gate.activate();
    }
    for (const r of WORLD_RULES) await command(r).catch((err: unknown) => log(`warning: ${err instanceof Error ? err.message : String(err)}`));
    for (const s of picked) {
      const index = all.indexOf(s);
      const runs: RunRecord[] = [];
      const n = opts.runs ?? s.runs;
      bridge.staleness.reset();
      for (let run = 1; run <= n; run++) {
        try {
          if (gate?.userHasControl) throw new Error(`${FOREGROUND_MESSAGE}; bring it back to the front for the remaining runs`);
          runs.push(await runOnce(s, index, run, controller, log));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`${s.name} run ${run}: error ${message}`);
          await controller.releaseAll().catch(() => undefined);
          runs.push({
            run,
            success: false,
            outcome: { ok: false, message, durationMs: 0, healthStart: 20, healthEnd: 0, damageTaken: 0, blastDamage: 0, fallDamage: 0, falls: 0, deaths: 0, kills: 0, lost: 0, exploded: 0, hurts: 0 },
            extra: {},
            note: `error: ${message}`,
          });
        }
      }
      const report = summarize(s.name, s.suite, input, runs);
      report.entityAge = bridge.staleness.summary();
      log(`${s.name} entity reading age (ms): ${JSON.stringify(report.entityAge)}`);
      reports.push(report);
    }
    await command("gamemode creative @a").catch(() => undefined);
  } finally {
    if (!opts.keep) await bridge.stop().catch((err: unknown) => log(`stopping the game failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  const table = markdownTable(reports);
  const stamp = startedAt.replace(/[:.]/g, "-");
  const jsonPath = cacheDir("bench", `${opts.suite}${opts.scenario ? `-${opts.scenario.replace(/,/g, "+")}` : ""}-${stamp}.json`);
  await mkdir(dirname(jsonPath), { recursive: true });
  const report: BenchReport = { suite: opts.suite, startedAt, input: reports[0]?.input ?? opts.input, reports, table, jsonPath };
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
