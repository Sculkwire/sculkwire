/**
 * The bench runner: launch a sculkwire world (waiting for the user on an install they start by hand), attach the
 * input provider when one is installed, set the camera for each `--view`, then for every `--stance`, scenario and run
 * clear and build its arena, set the player up, spawn the mobs (before the action, or during it with `spawnAfterMs`),
 * run the action or `play` goal (with the stance) with the fight's per-tick trace on, measure, and reset. Ends with
 * the camera put back and the game stopped (unless asked to keep it).
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { cacheDir } from "../../../core/paths.ts";
import { engine, type GameSetting, type SettingValue } from "../../engine/engine.ts";
import { getSetting, setSetting } from "../../engine/settings.ts";
import { inputProvider } from "../inputprovider.ts";
import { bridge, type BridgeStatus } from "../bridge.ts";
import type { LaunchMode } from "../launcher.ts";
import { FOREGROUND_MESSAGE } from "../windows.ts";
import type { ActionResult, EntityInfo, InputMode, Loadout, PlayerAction, PlayerController } from "../player.ts";
import { play, type Death, type PlayAction, type PlayResult } from "../skills/play.ts";
import { combatStats, traceFights, type TraceFrame } from "../skills/stats.ts";
import { arenaCommands, arenaOrigin, clearMobsCommand, offsetAt, playerCommands, summonCommand, WORLD_RULES } from "./arena.ts";
import { markdownTable, summarize, type RunRecord, type ScenarioReport } from "./report.ts";
import { claimSpawned, countKills, SPAWN_FIND_MS, SPAWN_POLL_MS, type SpawnedMob } from "./spawns.ts";
import { withStance, type BenchStance } from "./stance.ts";
import type { BenchContext, Hurt, Metric, RunOutcome, Scenario } from "./types.ts";
import { VIEW_OPTION, viewValue, type BenchView } from "./view.ts";

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
  /** Run every picked scenario once per view, with the game's camera set to it (needs the in-game agent). */
  views?: BenchView[];
  /** Run every picked scenario once per stance (per view), with `stance` set on its `play` or `fight` action. */
  stances?: BenchStance[];
  /** Seconds to wait for the user to open the world on an install they start by hand. Default `DEFAULT_WAIT_S`. */
  waitS?: number;
  log?: (line: string) => void;
}

/** Seconds `sculk bench` waits for a world the user opens by hand. */
export const DEFAULT_WAIT_S = 900;

/** One run's per-tick fight trace, as the `.trace.json` file lists them. */
export interface BenchTrace {
  scenario: string;
  view?: BenchView;
  stance?: BenchStance;
  run: number;
  frames: TraceFrame[];
}

export interface BenchReport {
  suite: string;
  startedAt: string;
  input: string;
  reports: ScenarioReport[];
  table: string;
  jsonPath: string;
  /** `<jsonPath without .json>.trace.json`: every run's `BenchTrace`, present when some run recorded fight frames. */
  tracePath?: string;
}

/** The command route: /connect when it answers, the script debugger once /connect has timed out. */
let route: "auto" | "debugger" = "auto";

/**
 * Failures that mean the command itself is wrong. Both routes also report a command that found nothing to change as
 * a failure (`No targets matched`, `0 blocks filled`, `no items to remove`, a door half already placed), which the
 * reset hits every run, so only these count.
 */
const COMMAND_WRONG = /^Syntax error|^Unknown command/i;

/**
 * Whether commands go through the in-game agent: it runs a command on the game's next tick and answers with its
 * output, where the script debugger waits out a quiet gap after every command (about 0.7 s, some 25 s per reset).
 */
let agentCommands = false;

async function command(line: string): Promise<void> {
  if (agentCommands) {
    const done = await engine.command(line);
    if (done.ok) {
      if (done.value.success === false && COMMAND_WRONG.test(done.value.message)) throw new Error(`/${line} failed: ${done.value.message}`);
      return;
    }
    // The agent stopped answering (a screen over the HUD, an unload): the bridge's routes from here on.
    agentCommands = false;
  }
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

/** The entities around the arena the spawned mobs are claimed from; none when the query fails (the poll tries again). */
async function arenaEntities(s: Scenario, ctx: Pick<BenchContext, "at">): Promise<EntityInfo[]> {
  return ((await bridge.query("entities", { ...ctx.at({ dx: 0, dy: 0, dz: 0 }), radius: s.area.radius + 8, limit: 100 }).catch(() => [])) as EntityInfo[]) ?? [];
}

function shortNote(play: PlayResult | undefined, action: ActionResult | undefined): string {
  if (play) {
    const counts = new Map<string, number>();
    for (const st of play.trace) counts.set(st.action, (counts.get(st.action) ?? 0) + 1);
    return `${play.stoppedBy}: ${play.message}; tactics ${[...counts].map(([k, v]) => `${k} ${v}`).join(", ")}`;
  }
  return action ? action.message : "";
}

async function runOnce(s: Scenario, index: number, run: number, controller: PlayerController, log: (l: string) => void, stance?: BenchStance): Promise<{ record: RunRecord; frames?: TraceFrame[] }> {
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
  // Each spawn's entity, in `mobs` order; undefined until found (or when it died before it was seen).
  let found: (SpawnedMob | undefined)[] = (s.mobs ?? []).map(() => undefined);
  const spawn = async () => {
    const mobs = s.mobs ?? [];
    for (const m of mobs) await commandRetry(summonCommand(m, origin));
    // Look right away and every SPAWN_POLL_MS until every spawn is claimed: slow summons and quick kills both happen.
    const deadline = Date.now() + SPAWN_FIND_MS;
    while (mobs.length > 0) {
      found = claimSpawned(mobs, ctx.at, await arenaEntities(s, ctx), found);
      ctx.mobs = found.filter((m): m is SpawnedMob => m !== undefined);
      if (found.every((m) => m !== undefined) || Date.now() >= deadline) return;
      await sleep(SPAWN_POLL_MS);
    }
  };
  const spawnAfterMs = s.spawnAfterMs;
  if (spawnAfterMs === undefined) await spawn();

  const before = await bridge.playerState(200);
  const hurtTick = (await hurtsSince(Number.MAX_SAFE_INTEGER))?.tick;
  const deathTick = (await deathsSince(Number.MAX_SAFE_INTEGER)).tick;
  const healthStart = before.health ?? 20;
  const spec = withStance(s.action(ctx), stance);
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
  let frames: TraceFrame[] | undefined;
  let spawnError: unknown;
  const limit = setTimeout(() => ctrl.abort(), s.timeoutMs + 5000);
  // The fight records a frame per tick from here; a `play` run starts its own stats and keeps tracing on.
  traceFights(controller, true);
  // A late spawn summons the mobs while the action already runs; a failed summon ends the run.
  const late =
    spawnAfterMs === undefined
      ? undefined
      : sleep(spawnAfterMs)
          .then(spawn)
          .catch((err: unknown) => {
            spawnError = err;
            ctrl.abort();
          });
  try {
    if (spec.action === "play") {
      played = await play({ ...(spec as PlayAction), durationMs: (spec as PlayAction).durationMs ?? s.timeoutMs }, playEnv(controller), { signal: ctrl.signal });
    } else {
      action = await controller.run(spec as PlayerAction, ctrl.signal);
    }
  } finally {
    clearTimeout(limit);
    const trace = combatStats(controller).trace;
    if (trace?.length) frames = [...trace];
    traceFights(controller, false);
    watching = false;
    await watch;
    await late;
    await controller.releaseAll();
  }
  if (spawnError !== undefined) throw new Error(`summoning the mobs during the action failed: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`);
  const durationMs = Date.now() - started;
  const after = await bridge.playerState(300);
  const hurts = hurtTick !== undefined ? ((await hurtsSince(hurtTick))?.hurts ?? []) : [];
  const deaths = (await deathsSince(deathTick)).deaths;
  const killCount = countKills(s.mobs ?? [], found, deaths);
  const kills = killCount.resolved + killCount.unresolved;
  const alive = new Set(((await bridge.query("entities", { ...origin, radius: s.area.radius + 24, limit: 100 })) as EntityInfo[]).map((e) => e.id));
  const lost = ctx.mobs.filter((m) => !alive.has(m.id)).length - killCount.resolved;
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
    ...(frames ? { frames } : {}),
  };
  const extra: Record<string, Metric> = (await s.measure?.(ctx, outcome)) ?? {};
  const success = s.success ? s.success(outcome, extra) : outcome.ok && outcome.deaths === 0;
  const note = shortNote(played, action);
  log(
    `${s.name} run ${run}: ${success ? "ok" : "FAIL"} in ${(durationMs / 1000).toFixed(1)} s, health ${healthStart} -> ${healthEnd}, ` +
      `damage ${outcome.damageTaken}${outcome.blastDamage ? ` (blast ${outcome.blastDamage})` : ""}, kills ${kills}, lost ${outcome.lost}, deaths ${playerDeaths}. ${note}`,
  );
  await command(clearMobsCommand(s, origin)).catch(() => undefined);
  const { hurts: _h, state: _s, action: _a, play: _p, frames: _f, ...rest } = outcome;
  // The helper's hurt log (who hit, how hard) and what the fight saw around each hit.
  const trace = played ? [...hurts.map((h) => `hurt tick ${h.tick} ${h.damage} by ${h.damager ?? h.cause ?? "?"}`), ...combatStats(controller).events] : [];
  return { record: { run, success, outcome: { ...rest, hurts: hurts.length }, extra, note, ...(trace.length ? { trace } : {}) }, ...(frames ? { frames } : {}) };
}

/** A bench option that cannot work in this setup (exit 2), e.g. `--view` with no in-game agent to change the option. */
export class BenchUsageError extends Error {}

/** How often the manual-start wait looks at the bridge status. */
const WAIT_POLL_MS = 2000;

/**
 * On an install the user starts by hand, `bridge.start` returns at once with the steps to do: print them and the world
 * to open, then wait until the bridge reports the world ready, the game exits, or `waitS` passes.
 */
async function waitForWorld(status: BridgeStatus, waitS: number, log: (l: string) => void): Promise<void> {
  if (status.ready) return;
  log(`start the game yourself and open the world ${status.world ?? "sculkwire-bench"}; waiting up to ${waitS} s (--wait)`);
  const shown = new Set<string>();
  const show = (steps: readonly string[]) => {
    for (const step of steps) {
      if (shown.has(step)) continue;
      shown.add(step);
      log(`  - ${step}`);
    }
  };
  show(status.manualSteps);
  const deadline = Date.now() + waitS * 1000;
  for (;;) {
    await sleep(WAIT_POLL_MS);
    const s = bridge.status();
    if (s.ready) {
      log("the world is open");
      return;
    }
    if (s.gameExited) throw new Error(`the game exited before the world was ready: ${s.manualSteps.join("; ")}`);
    show(s.manualSteps);
    if (Date.now() >= deadline) {
      throw new Error(`the world was not ready within ${waitS} s (--wait); still to do: ${s.manualSteps.join("; ") || "nothing listed, the helper pack never reported ready"}`);
    }
  }
}

/** Attach the input provider; an agent another process already attached keeps serving the engine route. */
async function attachProvider(input: InputMode, log: (l: string) => void): Promise<void> {
  const provider = inputProvider();
  if (!provider || input === "keyboard") return;
  try {
    await provider.attach();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // The injector refuses a second load of an agent DLL that is already loaded, but that agent still answers on its port.
    const route = bridge.playerController().world.engine;
    if (route && (await route.reachable().catch(() => false))) {
      log(`${provider.name} attach failed (${why}); an agent already answers on its port, using it`);
      return;
    }
    if (input === "engine") throw err;
    log(`${provider.name} attach failed, using the keyboard: ${why}`);
  }
}

const NO_AGENT_FOR_VIEW =
  `--view changes the game's ${VIEW_OPTION} option through the in-game agent, and no agent is attached` +
  " (--input keyboard does not attach one). Use --input auto or engine, attach one first with `sculk engine attach`, or leave --view out";

/** The game's `game_thirdperson` before the bench changed it, read through the attached agent. */
async function readView(): Promise<GameSetting> {
  if (!(await engine.reachable())) throw new BenchUsageError(NO_AGENT_FOR_VIEW);
  const got = await getSetting(VIEW_OPTION);
  if (!got.ok) throw new Error(`reading ${VIEW_OPTION} failed: ${got.message}`);
  if (got.value.source !== "engine") throw new BenchUsageError(NO_AGENT_FOR_VIEW);
  return got.value.setting;
}

/** Set the option in the running game; never the `options.txt` fallback, which would only apply at the next launch. */
async function setView(value: SettingValue): Promise<void> {
  if (!(await engine.reachable())) throw new Error(`no in-game agent answers to set ${VIEW_OPTION}`);
  const r = await setSetting(VIEW_OPTION, value);
  if (!r.ok) throw new Error(`setting ${VIEW_OPTION} to ${JSON.stringify(value)} failed: ${r.message}`);
}

/** The trace file next to a report JSON: `<name>.trace.json`. */
export function tracePathFor(jsonPath: string): string {
  return jsonPath.replace(/\.json$/, ".trace.json");
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
  const started = await bridge.start({ mode: opts.display ?? "window", mute: true, difficulty: "normal", world: "bench" });
  const reports: ScenarioReport[] = [];
  const traces: BenchTrace[] = [];
  let originalView: GameSetting | undefined;
  try {
    await waitForWorld(started, opts.waitS ?? DEFAULT_WAIT_S, log);
    await attachProvider(opts.input, log);
    const controller = bridge.playerController();
    const input = await controller.selectInput(opts.input);
    log(`input: ${input}`);
    agentCommands = input === "engine" && (await engine.reachable());
    if (agentCommands) log("commands: through the in-game agent");
    if (opts.views?.length) {
      originalView = await readView();
      log(`${VIEW_OPTION} is ${JSON.stringify(originalView.value)}; it is put back at the end`);
    }
    // Windows keyboard input reaches the game only while its window is in the foreground: bring it forward once.
    const gate = input === "keyboard" ? controller.world.input.foreground : undefined;
    if (gate) {
      log("bringing the game window to the foreground; leave it there until the bench ends");
      await gate.activate();
    }
    for (const r of WORLD_RULES) await command(r).catch((err: unknown) => log(`warning: ${err instanceof Error ? err.message : String(err)}`));
    for (const view of opts.views?.length ? opts.views : [undefined]) {
      if (view && originalView) {
        await setView(viewValue(view, originalView));
        log(`view: ${view} person`);
      }
      for (const stance of opts.stances?.length ? opts.stances : [undefined]) {
        for (const s of picked) {
          const index = all.indexOf(s);
          const runs: RunRecord[] = [];
          const n = opts.runs ?? s.runs;
          const tags = [view, stance].filter((t) => t !== undefined);
          const label = tags.length ? `${s.name} (${tags.join(", ")})` : s.name;
          bridge.staleness.reset();
          for (let run = 1; run <= n; run++) {
            try {
              if (gate?.userHasControl) throw new Error(`${FOREGROUND_MESSAGE}; bring it back to the front for the remaining runs`);
              const done = await runOnce(s, index, run, controller, log, stance);
              runs.push(done.record);
              if (done.frames) traces.push({ scenario: s.name, ...(view ? { view } : {}), ...(stance ? { stance } : {}), run, frames: done.frames });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              log(`${label} run ${run}: error ${message}`);
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
          if (view) report.view = view;
          if (stance) report.stance = stance;
          report.entityAge = bridge.staleness.summary();
          log(`${label} entity reading age (ms): ${JSON.stringify(report.entityAge)}`);
          reports.push(report);
        }
      }
    }
    await command("gamemode creative @a").catch(() => undefined);
  } finally {
    // Put the camera back while the agent still runs, also with --keep and after an error.
    if (originalView) {
      const value = originalView.value;
      await setView(value).then(
        () => log(`${VIEW_OPTION} restored to ${JSON.stringify(value)}`),
        (err: unknown) => log(`restoring ${VIEW_OPTION} failed (game_stop restores it): ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    if (!opts.keep) await bridge.stop().catch((err: unknown) => log(`stopping the game failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  const table = markdownTable(reports);
  const stamp = startedAt.replace(/[:.]/g, "-");
  const jsonPath = cacheDir("bench", `${opts.suite}${opts.scenario ? `-${opts.scenario.replace(/,/g, "+")}` : ""}-${stamp}.json`);
  await mkdir(dirname(jsonPath), { recursive: true });
  const tracePath = traces.length ? tracePathFor(jsonPath) : undefined;
  const report: BenchReport = { suite: opts.suite, startedAt, input: reports[0]?.input ?? opts.input, reports, table, jsonPath, ...(tracePath ? { tracePath } : {}) };
  if (tracePath) await writeFile(tracePath, `${JSON.stringify(traces)}\n`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
