/**
 * `play`: pursue a goal like a decent player. The goal is compiled into a plan first (`plan.ts`): checkable steps run
 * one after another, and standing orders (the fights' shield stance). For a combat or movement step every 200 to
 * 300 ms the loop builds the threat map, checks the step, scores the tactics (fight X, flee, eat, goto, use the held
 * item on X, idle) and keeps the best one running as a preemptible skill. A task step (craft, smelt, trade, fetch,
 * equip, go to a block or a mob) runs as one procedure (`runTaskStep`) while the loop keeps watching: a hit or a
 * hostile close aborts it, the tactics fight or flee until it is clear, and the step is tried again. A step is done by
 * its check, never by assumption. A step the built-in checks cannot verify runs until the time limit.
 */
import { realClock, type Clock } from "../clock.ts";
import type { PlayerController } from "../player.ts";
import type { ActionResult, EntityInfo, Loadout, PlayerAction, PlayerState } from "../types.ts";
import { errorMessage } from "../../../core/errors.ts";
import { runTaskStep } from "../tasks/steps.ts";
import type { TaskEnv, TaskFailure, TaskStep, TaskStepResult } from "../tasks/types.ts";
import type { Stance } from "./types.ts";
import { checkGoal, GOAL_RADIUS, type Goal, type GoalCheck } from "./goal.ts";
import { shortType } from "./mobs.ts";
import { compileGoal, isTaskStep, stepLabel, UNDERSTOOD_FORMS, type PlanKind, type PlanStep } from "./plan.ts";
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
  /** The fights' shield stance (`fight`'s `stance`); default the goal's standing order, else `auto`. */
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
  /** The task steps' environment (`liveTaskEnv`), built on the first task step. */
  tasks?(): Promise<TaskEnv>;
  /** The loop's waits between decisions (default the real clock; tests pass a fake one). */
  clock?: Clock;
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
/** A hostile this close aborts a running task step. */
const TASK_ABORT_RADIUS = 6;
/** A task step starts (again) once no hostile is this close and no hit was taken. */
const TASK_CLEAR_RADIUS = 8;
/** An interrupted task step is tried again this many times, then the plan fails. */
const MAX_TASK_RETRIES = 2;

/**
 * `goal_unknown`: a part of the goal was not understood (a `free` step) and there was nothing to do for
 * `UNKNOWN_QUIET_MS`, so the run stopped instead of idling to the time limit.
 */
type PlayStop = "goal_done" | "timeout" | "died" | "error" | "goal_unknown" | "targets_gone";

/**
 * `targets_gone` (in the type above): a kill step with a count has none of its targets left alive within the goal
 * radius after some were there, and the count is not reached: they left the area. The run stops this long after.
 */
const TARGETS_GONE_MS = 1000;

/** A goal part nobody understood ends the run after this long with nothing to do (only idle, no hostile near). */
const UNKNOWN_QUIET_MS = 5000;
/** A hostile this close keeps a not-understood run going: the player defends itself (the tactics' fight range). */
const QUIET_RADIUS = 16;

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

interface PlayStats {
  decisions: number;
  kills: number;
  killed: Record<string, number>;
  /** Short mob type -> deaths not by the player of mobs seen within the goal radius (another mob's attack, a fall). */
  otherDeaths: Record<string, number>;
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

/** One plan step in the result. */
interface PlanStepReport {
  /** The clause of the goal it came from. */
  text: string;
  kind: PlanKind;
  /** `running`: the current step; `stopped`: the run ended (time, death, cancel) while it ran; `pending`: never reached. */
  status: "done" | "failed" | "running" | "stopped" | "pending";
  ok: boolean;
  message: string;
  ms: number;
  /** Task steps: what was done, in order, over every attempt. */
  actions?: string[];
  /** Task steps: inventory change over every attempt, item id -> count. */
  gained?: Record<string, number>;
  reason?: TaskFailure;
  /** Task steps: attempts a hit or a hostile close interrupted. */
  retries?: number;
}

export interface PlayResult {
  goal: string;
  steps: number;
  stoppedBy: PlayStop;
  message: string;
  durationMs: number;
  /** The current (or last) plan step's check; `known` when every plan step has a check. */
  goalCheck: { kind: PlanKind; known: boolean; progress: string };
  plan: PlanStepReport[];
  /** The standing orders read from the goal, and the stance the fights used. */
  orders: { stance?: Stance };
  stats: PlayStats;
  trace: PlayStep[];
  state?: PlayerState;
}

/** The tactics `allow` permits. `idle` is always in. */
function allowedTactics(allow?: readonly string[]): Set<TacticKind> {
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
function tacticAction(t: Tactic, goal: Goal, stepMs: number, timeLeftMs: number, stance?: Stance): PlayerAction {
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

interface RunningTask {
  ctrl: AbortController;
  promise: Promise<TaskStepResult>;
  done: boolean;
}

/** A death not by the player: the dead mob's type and its killer's. */
type OtherDeath = { typeId: string; killer?: string };

/**
 * Kills: the helper's death log when there is one, else struck mobs that vanished (a creeper that blew up at full
 * health is not a kill). With the log, the deaths not by the player of mobs seen within the goal radius (`near`) go
 * to `others`: a kill step's target that another mob killed is gone too.
 */
function countKills(kills: Map<string, string>, others: Map<string, OtherDeath>, near: ReadonlySet<string>, map: ThreatMap, stats: CombatStats, deaths: Death[] | undefined): void {
  if (deaths) {
    for (const d of deaths) {
      if (d.killer === "minecraft:player") kills.set(d.id, d.typeId);
      else if (near.has(d.id) && d.typeId !== "minecraft:player") others.set(d.id, { typeId: d.typeId, ...(d.killer ? { killer: d.killer } : {}) });
    }
    return;
  }
  for (const v of map.vanished) {
    if (!stats.struck.has(v.id)) continue;
    if (v.info.kind === "exploder" && v.health && v.health.current >= v.health.max) continue;
    kills.set(v.id, v.typeId);
  }
}

/** The goal the tactics see: the step itself for the combat and movement kinds, else none (they still fight, flee and eat). */
function tacticGoal(step: PlanStep | undefined): Goal {
  return step && (step.kind === "kill" || step.kind === "reach" || step.kind === "use_on") ? step : { kind: "free" };
}

/** Entries of `all` whose key is not in `before`: what happened during the current step. */
function since(all: ReadonlyMap<string, string>, before: ReadonlySet<string>): Map<string, string> {
  return new Map([...all].filter(([id]) => !before.has(id)));
}

/** The step `runTaskStep` runs: the plan's extras dropped. */
function taskOf(step: PlanStep & TaskStep): TaskStep {
  const { clause: _c, ...rest } = step;
  return rest;
}

/** Run the plan until every step's check holds, the player dies, time runs out, or a step fails. */
export async function play(
  spec: PlayAction,
  env: PlayEnvironment,
  options: { signal?: AbortSignal; onStep?: (step: PlayStep) => void; onPlan?: (text: string) => void } = {},
): Promise<PlayResult> {
  const durationMs = Math.min(spec.durationMs ?? PLAY_DEFAULT_DURATION_MS, PLAY_MAX_DURATION_MS);
  const stepMs = spec.stepMs ?? PLAY_DEFAULT_STEP_MS;
  const allowed = allowedTactics(spec.allow);
  const c = env.controller;
  const clock = env.clock ?? realClock;
  const started = Date.now();
  const deadline = started + durationMs;

  let taskEnv: Promise<TaskEnv | undefined> | undefined;
  const tasks = (): Promise<TaskEnv | undefined> => {
    taskEnv ??= (env.tasks?.() ?? Promise.resolve(undefined)).catch(() => undefined);
    return taskEnv;
  };
  const plan = compileGoal(spec.goal, durationMs);
  const planSteps = plan.steps;
  const stance = spec.stance ?? plan.orders.stance;
  const reports: PlanStepReport[] = planSteps.map((s) => ({ text: s.clause, kind: s.kind, status: "pending", ok: false, message: "not reached", ms: 0 }));

  const stats = resetStats(c);
  const tracker = new ThreatTracker();
  const kills = new Map<string, string>();
  const otherDeaths = new Map<string, OtherDeath>();
  /** Every mob seen within the goal radius during the run, so a death in the log can be placed. */
  const seenNear = new Set<string>();
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
  /** The current plan step, its start, and what had happened before it. */
  let idx = 0;
  let stepStart = Date.now();
  let killsBefore = new Set<string>();
  let othersBefore = new Set<string>();
  /** The current kill step has seen a target alive within its radius, and since when none is. */
  let targetsSeen = false;
  let targetsGoneSince: number | undefined;
  let usedBefore = new Set<string>();
  let task: RunningTask | undefined;
  /** On a not-understood step: since when there has been nothing to do. */
  let quietSince: number | undefined;
  let retries = 0;

  const allKnown = planSteps.every((s) => s.kind !== "free");
  const stepCheck = (step: PlanStep | undefined, map: ThreatMap): GoalCheck => {
    if (!step) return { known: allKnown, done: true, progress: "every step done" };
    if (step.kind === "survive") {
      const s = Math.min(step.seconds, (Date.now() - stepStart) / 1000);
      return { known: true, done: s >= step.seconds, progress: `alive for ${round(s, 0)} of ${step.seconds} s` };
    }
    if (isTaskStep(step)) {
      const r = reports[idx];
      return { known: true, done: false, progress: task ? `${stepLabel(step)}: running${retries ? ` (attempt ${retries + 1})` : ""}` : (r?.message ?? stepLabel(step)) };
    }
    if (step.kind === "free") return checkGoal({ kind: "free" }, { map, kills, usedOn: stats.usedOn });
    const others = new Map([...otherDeaths].filter(([id]) => !othersBefore.has(id)));
    return checkGoal(step, { map, kills: since(kills, killsBefore), usedOn: since(stats.usedOn, usedBefore), otherDeaths: others });
  };
  const planText = (): string => {
    const step = planSteps[idx];
    if (!step) return `all ${planSteps.length} step(s) done`;
    return `step ${idx + 1} of ${planSteps.length}: ${stepLabel(step)}${retries ? `, attempt ${retries + 1}` : ""}`;
  };
  const announce = () => {
    const r = reports[idx];
    if (r?.status === "pending") r.status = "running";
    options.onPlan?.(planText());
  };

  let check: GoalCheck = stepCheck(planSteps[0], tracker.update(started, await c.world.state(1000), []));
  let running: Running | undefined;
  let stoppedBy: PlayStop = "timeout";
  let message = "";

  /** The current step's check holds: record it and go on to the next. */
  const complete = (text: string): void => {
    const r = reports[idx];
    if (r) Object.assign(r, { status: "done", ok: true, message: text, ms: Date.now() - stepStart });
    idx++;
    stepStart = Date.now();
    killsBefore = new Set(kills.keys());
    othersBefore = new Set(otherDeaths.keys());
    targetsSeen = false;
    targetsGoneSince = undefined;
    usedBefore = new Set(stats.usedOn.keys());
    doneStreak = 0;
    retries = 0;
    announce();
  };

  /** Fold one attempt of a task step into its report. */
  const record = (r: TaskStepResult): void => {
    const rep = reports[idx];
    if (!rep) return;
    rep.actions = [...(rep.actions ?? []), ...r.actions];
    const gained = { ...rep.gained };
    for (const [id, n] of Object.entries(r.gained)) gained[id] = (gained[id] ?? 0) + n;
    rep.gained = gained;
    rep.message = r.message;
    if (r.reason) rep.reason = r.reason;
    else delete rep.reason;
  };

  const stopTask = async (why: string): Promise<TaskStepResult | undefined> => {
    const t = task;
    if (!t) return undefined;
    task = undefined;
    if (!t.done) t.ctrl.abort(new Error(why));
    const r = await t.promise;
    record(r);
    return r;
  };

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
    if (step.action === "eat") loadoutAt = Number.NEGATIVE_INFINITY;
    // Running did not work (a wall, a corner): fight back for a while instead of trying again.
    if (step.action === "flee" && !result.ok && result.message !== "cancelled") cornerUntil = Date.now() + CORNERED_HOLD_MS;
  };

  const fail = (text: string): void => {
    const r = reports[idx];
    if (r) Object.assign(r, { status: "failed", ok: false, message: text, ms: Date.now() - stepStart });
    stoppedBy = "error";
    message = planSteps.length > 1 ? `step ${idx + 1} (${planSteps[idx]?.clause ?? ""}) failed: ${text}` : text;
  };

  try {
    announce();
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
        const doing = running?.step.action ?? (task ? `task step ${stepLabel(planSteps[idx] as PlanStep)}` : "nothing");
        logEvent(stats, `hurt ${lostNow.toFixed(1)} -> ${me.health} at ${Math.round((tickStarted - started) / 100) / 10} s during ${doing}: ${around.join(", ") || "no hostile near"}`);
      }
      let newDeaths: Death[] | undefined;
      if (env.deaths && deathTick !== undefined) {
        const d = await env.deaths(deathTick).catch(() => undefined);
        if (d) {
          newDeaths = d.deaths;
          deathTick = Math.max(deathTick, ...d.deaths.map((x) => x.tick));
        }
      }
      for (const e of map.entities) if (e.distance <= GOAL_RADIUS) seenNear.add(e.id);
      countKills(kills, otherDeaths, seenNear, map, stats, newDeaths);
      const step = planSteps[idx];

      if (step && isTaskStep(step)) {
        const close = map.hostiles.find((t) => t.distance <= TASK_ABORT_RADIUS);
        const threat = lostNow > 0 ? `a hit for ${round(lostNow)}` : close ? `${close.key} at ${close.distance.toFixed(1)} blocks` : undefined;
        if (task && !task.done && threat) {
          await stopTask(`interrupted by ${threat}`);
          retries++;
          const rep = reports[idx];
          if (rep) rep.retries = retries;
          logEvent(stats, `${round((tickStarted - started) / 1000)} s task step ${stepLabel(step)} interrupted by ${threat}`);
          if (retries > MAX_TASK_RETRIES) {
            fail(`interrupted ${retries} times by hostiles, the last by ${threat}`);
            break;
          }
          announce();
        } else if (task?.done) {
          const r = (await stopTask("done")) as TaskStepResult;
          if (r.ok) {
            check = { known: true, done: true, progress: r.message };
            complete(r.message);
            if (idx >= planSteps.length) {
              stoppedBy = "goal_done";
              message = planSteps.length > 1 ? `goal done: all ${planSteps.length} steps, the last: ${r.message}` : `goal done: ${r.message}`;
              break;
            }
            continue;
          }
          fail(r.message);
          break;
        }
        check = stepCheck(step, map);
        const clear = lostNow === 0 && !map.hostiles.some((t) => t.distance <= TASK_CLEAR_RADIUS);
        if (!task && clear) {
          await finish(`plan step ${stepLabel(step)}`);
          const t = await tasks();
          if (!t) {
            fail(`${stepLabel(step)} is a task step, and this play run has no task environment (it needs the in-game agent)`);
            break;
          }
          const ctrl = new AbortController();
          const signal = options.signal ? AbortSignal.any([options.signal, ctrl.signal]) : ctrl.signal;
          const rt: RunningTask = { ctrl, promise: runTaskStep(taskOf(step), t, signal), done: false };
          void rt.promise.then(() => {
            rt.done = true;
          });
          task = rt;
          if (reports[idx]) (reports[idx] as PlanStepReport).status = "running";
          logEvent(stats, `${round((tickStarted - started) / 1000)} s task step ${stepLabel(step)}${retries ? ` (attempt ${retries + 1})` : ""}`);
        }
        if (task) {
          const rest = Math.min(stepMs - (Date.now() - tickStarted), deadline - Date.now());
          if (rest > 0) await Promise.race([clock.sleep(rest, options.signal), task.promise]);
          continue;
        }
        // Not clear yet: the tactics below fight, flee or eat until it is.
      } else {
        check = stepCheck(step, map);
        doneStreak = check.done ? doneStreak + 1 : 0;
        if (check.known && doneStreak >= DONE_STREAK) {
          const progress = check.progress;
          complete(progress);
          if (idx >= planSteps.length) {
            stoppedBy = "goal_done";
            message = planSteps.length > 1 ? `goal done: all ${planSteps.length} steps, the last: ${progress}` : `goal done: ${progress}`;
            break;
          }
          continue;
        }
        // A kill step with a count whose targets all left the area (none alive within its radius after some were):
        // nothing is left to kill, so stop instead of waiting for the time limit.
        if (step?.kind === "kill" && step.count !== undefined) {
          const left = map.entities.some((e) => (step.type ? e.typeId === step.type : e.hostile) && e.distance <= step.radius);
          if (left) {
            targetsSeen = true;
            targetsGoneSince = undefined;
          } else if (targetsSeen) {
            targetsGoneSince ??= tickStarted;
            if (tickStarted - targetsGoneSince >= TARGETS_GONE_MS) {
              stoppedBy = "targets_gone";
              message = `${check.progress}, none left within ${step.radius} blocks`;
              const rep = reports[idx];
              if (rep) Object.assign(rep, { status: "failed", ok: false, message, ms: Date.now() - stepStart });
              break;
            }
          }
        }
      }

      if (running?.result) await finish();
      if (map.vitals.health >= RECOVERED_HEALTH) recovering = false;
      const goal = tacticGoal(planSteps[idx]);
      // The running fight's current mob (it changes targets by itself), else the one it started on.
      const fighting = running?.step.action === "fight" ? (stats.fighting ?? running.step.target?.id) : undefined;
      const scored = scoreTactics(map, goal, { usedOn: since(stats.usedOn, usedBefore), allowed, recovering, cornered: Date.now() < cornerUntil, ...(fighting ? { fighting } : {}) });
      decisions++;
      const tactic = chooseTactic(scored, running?.key);
      // A part nobody understood: defend as always, but stop once there has been nothing to do for a while.
      const current = planSteps[idx];
      if (current?.kind === "free") {
        const busy = tactic.kind !== "idle" || map.hostiles.some((t) => t.distance <= QUIET_RADIUS);
        if (busy) quietSince = undefined;
        else quietSince ??= tickStarted;
        if (quietSince !== undefined && tickStarted - quietSince >= UNKNOWN_QUIET_MS) {
          const done = idx > 0 ? `did ${idx} step(s) (${planSteps.slice(0, idx).map(stepLabel).join(", ")}), then ` : "";
          stoppedBy = "goal_unknown";
          message = `${done}did not understand "${current.text}", and nothing else was to be done for ${round(UNKNOWN_QUIET_MS / 1000, 0)} s. play understands: ${UNDERSTOOD_FORMS}`;
          const rep = reports[idx];
          if (rep) Object.assign(rep, { status: "failed", ok: false, message: `not understood: "${current.text}"`, ms: Date.now() - stepStart });
          break;
        }
      }
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
          promise: c.run(tacticAction(t, goal, stepMs, deadline - Date.now(), stance), signal),
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
      // The last nap ends at the deadline, so the loop never spins without waiting.
      const rest = Math.min(stepMs - (Date.now() - tickStarted), deadline - Date.now());
      if (rest > 0) {
        // Wake early when the running skill ends, so the next one starts at once.
        const nap = clock.sleep(rest, options.signal);
        await (running ? Promise.race([nap, running.promise]) : nap);
      }
    }
  } catch (err) {
    if (options.signal?.aborted) {
      stoppedBy = "error";
      message = "cancelled";
    } else if (Date.now() < deadline) {
      stoppedBy = "error";
      message = errorMessage(err);
    }
  } finally {
    const why = stoppedBy === "timeout" ? "time is up" : stoppedBy === "goal_done" ? "the goal is done" : message;
    await stopTask(why).catch(() => undefined);
    await finish(why).catch(() => undefined);
    await c.releaseAll();
  }
  if (stoppedBy === "timeout") {
    const at = planSteps.length > 1 && planSteps[idx] ? ` (at step ${idx + 1} of ${planSteps.length}: ${stepLabel(planSteps[idx] as PlanStep)})` : "";
    message = allKnown
      ? `ran for ${round(durationMs / 1000, 0)} s without the goal being done${at}`
      : `ran for ${round(durationMs / 1000, 0)} s, the time limit: the built-in checks cannot verify this goal${at}`;
  }
  const current = reports[idx];
  if (current && stoppedBy !== "goal_done" && current.status !== "failed") {
    Object.assign(current, { status: "stopped", ok: false, message: current.actions ? current.message : check.progress, ms: Date.now() - stepStart });
  }
  const state = await c.world.state(1000).catch(() => undefined);
  const killed: Record<string, number> = {};
  for (const t of kills.values()) killed[shortType(t)] = (killed[shortType(t)] ?? 0) + 1;
  const otherDead: Record<string, number> = {};
  for (const d of otherDeaths.values()) otherDead[shortType(d.typeId)] = (otherDead[shortType(d.typeId)] ?? 0) + 1;
  const last = planSteps[Math.min(idx, planSteps.length - 1)] as PlanStep;
  return {
    goal: spec.goal,
    steps,
    stoppedBy,
    message,
    durationMs: Date.now() - started,
    goalCheck: { kind: last.kind, known: allKnown, progress: check.progress },
    plan: reports,
    orders: { ...(stance ? { stance } : {}) },
    stats: {
      decisions,
      kills: kills.size,
      killed,
      otherDeaths: otherDead,
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
