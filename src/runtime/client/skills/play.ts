/**
 * `play`: pursue a goal like a decent player. Every 200 to 300 ms the loop builds the threat map, checks the goal,
 * scores the tactics (fight X, flee, eat, goto, use the held item on X, idle) and keeps the best one running as a
 * preemptible skill. A goal the built-in checks cannot verify runs until the time limit.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { ActionResult, EntityInfo, Loadout, PlayerAction, PlayerController, PlayerState } from "../player.ts";
import type { Stance } from "./pack.ts";
import { checkGoal, parseGoal, type Goal, type GoalCheck } from "./goal.ts";
import { shortType } from "./mobs.ts";
import { fightText, logEvent, resetStats, type CombatStats } from "./stats.ts";
import { chooseTactic, RECOVERED_HEALTH, scoreTactics, TACTICS, tacticKey, type Tactic, type TacticKind } from "./tactics.ts";
import { THREAT_RADIUS, ThreatTracker, type ThreatMap } from "./threat.ts";

export interface PlayAction {
  action: "play";
  goal: string;
  durationMs?: number;
  /** Time between tactic decisions. */
  stepMs?: number;
  /** Tactics the loop may use (default all). `idle` is always in. */
  allow?: string[];
  /** The fights' shield stance (`fight`'s `stance`, default `auto`). */
  stance?: Stance;
}

/** One entity death the helper recorded (`deaths` query). */
export interface Death {
  tick: number;
  id: string;
  typeId: string;
  cause?: string;
  /** Type of the killer, `minecraft:player` for the player's kills. */
  killer?: string;
}

/** What the play loop needs beyond the controller. */
export interface PlayEnvironment {
  controller: PlayerController;
  /** Entities around the player (players are dropped). */
  entities(radius: number): Promise<EntityInfo[]>;
  loadout?(): Promise<Loadout>;
  /** Deaths after game tick `since`, for exact kill counts. Without it a struck mob that vanished counts as killed. */
  deaths?(since: number): Promise<{ tick: number; deaths: Death[] }>;
  /** True while the simulation is paused, when the player cannot act. */
  paused?(): boolean;
}

export const PLAY_DEFAULT_DURATION_MS = 30_000;
export const PLAY_MAX_DURATION_MS = 300_000;
export const PLAY_DEFAULT_STEP_MS = 250;
/** After a failed flee, the player fights back this long before trying to run again. */
const CORNERED_HOLD_MS = 4000;
/** The goal check must hold on this many decisions in a row (entity lists can miss a mob for one read). */
const DONE_STREAK = 2;
const LOADOUT_EVERY_MS = 1000;
const MAX_TRACE = 300;

export type PlayStop = "goal_done" | "timeout" | "died" | "error";

/** One tactic run in the trace: what was chosen and why, and how it ended. */
export interface PlayStep {
  step: number;
  /** Milliseconds since the loop started. */
  atMs: number;
  /** The tactic (`fight`, `flee`, `eat`, `goto`, `use_on`, `idle`). */
  action: TacticKind;
  target?: { key: string; id: string; typeId: string };
  score: number;
  reason: string;
  result: { ok: boolean; message: string; durationMs: number };
}

export interface PlayStats {
  decisions: number;
  kills: number;
  killed: Record<string, number>;
  swings: number;
  hits: number;
  /** Swings that struck nothing. */
  misses: number;
  crits: number;
  /** Health drops the loop saw (a few hits within one decision step count once). */
  hitsTaken: number;
  damageTaken: number;
  /** Hits the raised shield took during the run's fights. */
  blocked: number;
  deaths: number;
  health?: number;
}

export interface PlayResult {
  goal: string;
  steps: number;
  stoppedBy: PlayStop;
  message: string;
  durationMs: number;
  goalCheck: { kind: Goal["kind"]; known: boolean; progress: string };
  stats: PlayStats;
  trace: PlayStep[];
  state?: PlayerState;
}

/** The tactics `allow` permits. `idle` is always in. */
export function allowedTactics(allow?: readonly string[]): Set<TacticKind> {
  if (!allow || allow.length === 0) return new Set(TACTICS);
  const unknown = allow.filter((a) => !(TACTICS as readonly string[]).includes(a));
  if (unknown.length) throw new Error(`unknown play tactic(s) ${unknown.join(", ")}; one of ${TACTICS.join(", ")}`);
  return new Set([...(allow as TacticKind[]), "idle"]);
}

function round(n: number, digits = 1): string {
  return n.toFixed(digits).replace(/\.0+$/, "");
}

/**
 * The controller action that carries a tactic out. A fight is one continuing action: it starts on the tactic's target
 * and moves on to the next hostile by itself (`all`), choosing whom to strike tick by tick.
 */
export function tacticAction(t: Tactic, goal: Goal, stepMs: number, timeLeftMs: number, stance?: Stance): PlayerAction {
  const left = Math.max(1000, timeLeftMs);
  switch (t.kind) {
    case "fight":
      return { action: "fight", ...(t.target ? { target: t.target.id } : {}), all: true, ...(stance ? { stance } : {}), timeoutMs: left };
    case "flee":
      return t.target?.info.kind === "exploder"
        ? { action: "flee", from: t.target.id, distance: 7, timeoutMs: Math.min(left, 4000) }
        : { action: "flee", ...(t.target ? { from: t.target.id } : {}), distance: 12, timeoutMs: Math.min(left, 8000) };
    case "eat":
      return { action: "eat" };
    case "goto":
      if (goal.kind !== "reach") return { action: "wait", ms: stepMs };
      return { action: "move_to", x: goal.x, z: goal.z, ...(goal.y !== undefined ? { y: goal.y } : {}), radius: goal.radius * 0.8, sprint: true, timeoutMs: left };
    case "use_on":
      return { action: "use_on", target: t.target?.id ?? "", all: false, timeoutMs: left };
    case "idle":
      return { action: "wait", ms: stepMs };
  }
}

interface Running {
  key: string;
  ctrl: AbortController;
  promise: Promise<ActionResult>;
  result?: ActionResult;
  started: number;
  step: Omit<PlayStep, "result">;
}

/** Kills: the helper's death log when there is one, else struck mobs that vanished (a creeper that blew up at full health is not a kill). */
function countKills(kills: Map<string, string>, map: ThreatMap, stats: CombatStats, deaths: Death[] | undefined): void {
  if (deaths) {
    for (const d of deaths) if (d.killer === "minecraft:player") kills.set(d.id, d.typeId);
    return;
  }
  for (const v of map.vanished) {
    if (!stats.struck.has(v.id)) continue;
    if (v.info.kind === "exploder" && v.health && v.health.current >= v.health.max) continue;
    kills.set(v.id, v.typeId);
  }
}

/** Run the tactic loop until the built-in check finds the goal done, the player dies, time runs out, or something fails. */
export async function play(spec: PlayAction, env: PlayEnvironment, options: { signal?: AbortSignal; onStep?: (step: PlayStep) => void } = {}): Promise<PlayResult> {
  const durationMs = Math.min(spec.durationMs ?? PLAY_DEFAULT_DURATION_MS, PLAY_MAX_DURATION_MS);
  const stepMs = spec.stepMs ?? PLAY_DEFAULT_STEP_MS;
  const allowed = allowedTactics(spec.allow);
  const c = env.controller;
  const goal = parseGoal(spec.goal);
  const stats = resetStats(c);
  const tracker = new ThreatTracker();
  const kills = new Map<string, string>();
  const started = Date.now();
  const deadline = started + durationMs;
  const trace: PlayStep[] = [];
  let steps = 0;
  let decisions = 0;
  let damageTaken = 0;
  let hitsTaken = 0;
  let deaths = 0;
  let lastHealth: number | undefined;
  let loadout: Loadout | undefined;
  let loadoutAt = Number.NEGATIVE_INFINITY;
  let deathTick: number | undefined;
  let doneStreak = 0;
  /** Fled to get health back, until it is at `RECOVERED_HEALTH` again. */
  let recovering = false;
  /** A flee failed: no recovery flee until then. */
  let cornerUntil = 0;
  let check: GoalCheck = checkGoal(goal, { map: tracker.update(started, await c.world.state(1000), []), kills, usedOn: stats.usedOn });
  let last: string | undefined;
  let running: Running | undefined;
  let stoppedBy: PlayStop = "timeout";
  let message = check.known
    ? `ran for ${round(durationMs / 1000, 0)} s without the goal being done`
    : `ran for ${round(durationMs / 1000, 0)} s, the time limit: the built-in checks cannot verify this goal`;

  const finish = async (why?: string): Promise<void> => {
    const r = running;
    if (!r) return;
    running = undefined;
    if (!r.result) r.ctrl.abort();
    const result = await r.promise;
    // A preempted fight still says what it did.
    const text = why && result.message === "cancelled" ? `preempted (${why})${result.fight ? `, ${fightText(result.fight)}` : ""}` : result.message;
    const step: PlayStep = { ...r.step, result: { ok: result.ok || result.message === "cancelled", message: text, durationMs: Date.now() - r.started } };
    steps++;
    trace.push(step);
    if (trace.length > MAX_TRACE) trace.shift();
    options.onStep?.(step);
    last = `${step.action}${step.target ? ` ${step.target.key}` : ""} ${result.ok ? "ok" : "failed"}: ${text}`;
    if (step.action === "eat") loadoutAt = Number.NEGATIVE_INFINITY;
    // Running did not work (a wall, a corner): fight back for a while instead of trying again.
    if (step.action === "flee" && !result.ok && result.message !== "cancelled") cornerUntil = Date.now() + CORNERED_HOLD_MS;
  };

  try {
    if (env.deaths) deathTick = (await env.deaths(Number.MAX_SAFE_INTEGER).catch(() => undefined))?.tick;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        stoppedBy = "error";
        message = "cancelled";
        break;
      }
      if (env.paused?.()) {
        stoppedBy = "error";
        message = "the simulation was paused, so the player cannot act";
        break;
      }
      const tickStarted = Date.now();
      const me = await c.world.state(300);
      let lostNow = 0;
      if (me.health !== undefined) {
        if (lastHealth !== undefined && me.health < lastHealth) lostNow = lastHealth - me.health;
        damageTaken += lostNow;
        if (lostNow > 0) hitsTaken++;
        lastHealth = me.health;
        if (me.health <= 0) {
          deaths++;
          stoppedBy = "died";
          message = "the player died";
          break;
        }
      }
      if (env.loadout && tickStarted - loadoutAt >= LOADOUT_EVERY_MS) {
        loadout = await env.loadout().catch(() => loadout);
        loadoutAt = tickStarted;
      }
      const map = tracker.update(tickStarted, me, await env.entities(THREAT_RADIUS), loadout);
      // A hit outside a fight (the fight logs its own with its frames): what was running and what was near.
      if (lostNow > 0 && running?.step.action !== "fight") {
        const around = map.hostiles.slice(0, 4).map((t) => `${t.key} ${t.distance.toFixed(1)}`);
        logEvent(stats, `hurt ${lostNow.toFixed(1)} -> ${me.health} at ${Math.round((tickStarted - started) / 100) / 10} s during ${running?.step.action ?? "nothing"}: ${around.join(", ") || "no hostile near"}`);
      }
      let newDeaths: Death[] | undefined;
      if (env.deaths && deathTick !== undefined) {
        const d = await env.deaths(deathTick).catch(() => undefined);
        if (d) {
          newDeaths = d.deaths;
          deathTick = Math.max(deathTick, ...d.deaths.map((x) => x.tick));
        }
      }
      countKills(kills, map, stats, newDeaths);
      check = checkGoal(goal, { map, kills, usedOn: stats.usedOn });
      doneStreak = check.done ? doneStreak + 1 : 0;
      if (check.known && doneStreak >= DONE_STREAK) {
        stoppedBy = "goal_done";
        message = `goal done: ${check.progress}`;
        break;
      }
      if (running?.result) await finish();
      if (map.vitals.health >= RECOVERED_HEALTH) recovering = false;
      // The running fight's current mob (it changes targets by itself), else the one it started on.
      const fighting = running?.step.action === "fight" ? (stats.fighting ?? running.step.target?.id) : undefined;
      const scored = scoreTactics(map, goal, { usedOn: stats.usedOn, allowed, recovering, cornered: Date.now() < cornerUntil, ...(fighting ? { fighting } : {}) });
      decisions++;
      const tactic = chooseTactic(scored, running?.key);
      if (tactic.recover) recovering = true;
      const key = tacticKey(tactic);
      if (running?.key !== key) {
        await finish(`${tactic.kind}${tactic.target ? ` ${tactic.target.key}` : ""}: ${tactic.reason}`);
        const t = tactic;
        const ctrl = new AbortController();
        const signal = options.signal ? AbortSignal.any([options.signal, ctrl.signal]) : ctrl.signal;
        const r: Running = {
          key,
          ctrl,
          started: Date.now(),
          promise: c.run(tacticAction(t, goal, stepMs, deadline - Date.now(), spec.stance), signal),
          step: {
            step: steps + 1,
            atMs: tickStarted - started,
            action: t.kind,
            ...(t.target ? { target: { key: t.target.key, id: t.target.id, typeId: t.target.typeId } } : {}),
            score: Math.round(t.score * 100) / 100,
            reason: t.kind === "fight" ? `${t.reason}; the fight moves on to the next hostile by itself` : t.reason,
          },
        };
        void r.promise.then((res) => {
          r.result = res;
        });
        running = r;
        logEvent(stats, `${Math.round((tickStarted - started) / 100) / 10} s ${t.kind}${t.target ? ` ${t.target.key}` : ""} (${t.reason}), health ${me.health ?? "?"}`);
      }
      const rest = stepMs - (Date.now() - tickStarted);
      if (rest > 0 && Date.now() + rest < deadline) {
        // Wake early when the running skill ends, so the next one starts at once.
        const nap = sleep(rest, undefined, options.signal ? { signal: options.signal } : undefined);
        await (running ? Promise.race([nap, running.promise]) : nap);
      }
    }
  } catch (err) {
    if (options.signal?.aborted) {
      stoppedBy = "error";
      message = "cancelled";
    } else if (Date.now() < deadline) {
      stoppedBy = "error";
      message = err instanceof Error ? err.message : String(err);
    }
  } finally {
    await finish(stoppedBy === "timeout" ? "time is up" : stoppedBy === "goal_done" ? "the goal is done" : message).catch(() => undefined);
    await c.releaseAll();
  }
  const state = await c.world.state(1000).catch(() => undefined);
  const killed: Record<string, number> = {};
  for (const t of kills.values()) killed[shortType(t)] = (killed[shortType(t)] ?? 0) + 1;
  return {
    goal: spec.goal,
    steps,
    stoppedBy,
    message,
    durationMs: Date.now() - started,
    goalCheck: { kind: goal.kind, known: check.known, progress: check.progress },
    stats: {
      decisions,
      kills: kills.size,
      killed,
      swings: stats.swings,
      hits: stats.hits,
      misses: stats.misses,
      crits: stats.crits,
      hitsTaken,
      damageTaken: Math.round(damageTaken * 10) / 10,
      blocked: stats.blocked,
      deaths,
      ...(state?.health !== undefined ? { health: state.health } : {}),
    },
    trace,
    ...(state ? { state } : {}),
  };
}
