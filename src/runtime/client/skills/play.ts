/**
 * `play`: pursue a goal like a decent player. Every 200 to 300 ms the loop builds the threat map, checks the goal,
 * scores the tactics (fight X, flee, eat, goto, use the held item on X, idle) and keeps the best one running as a
 * preemptible skill. Without a decision model the built-in scores decide. With one (Jev or Kev), the model is asked
 * as an advisor with the threat map as its state (Choice `tactic`, Choice `target`, Noul `goal_done`); emergencies
 * and the built-in goal checks override it.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { Answer, DecisionModel, DecisionState, Question } from "../../../decision/types.ts";
import type { ActionResult, EntityInfo, Loadout, PlayerAction, PlayerController, PlayerState } from "../player.ts";
import { checkGoal, parseGoal, type Goal, type GoalCheck } from "./goal.ts";
import { shortType } from "./mobs.ts";
import { logEvent, resetStats, type CombatStats } from "./stats.ts";
import { chooseTactic, EMERGENCY, RECOVERED_HEALTH, scoreTactics, TACTIC_TEXT, TACTICS, tacticKey, TARGETED, type Tactic, type TacticKind } from "./tactics.ts";
import { THREAT_RADIUS, ThreatTracker, type Threat, type ThreatMap } from "./threat.ts";

export interface PlayAction {
  action: "play";
  goal: string;
  durationMs?: number;
  /** Time between tactic decisions. */
  stepMs?: number;
  /** Tactics the loop may use (default all). `idle` is always in. */
  allow?: string[];
  /** Send a screenshot to the model with every decision (Jev only). */
  vision?: boolean;
  /** Ask the configured decision model as an advisor (default true). False: the built-in scores alone. */
  advisor?: boolean;
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
  /** The advisor. Undefined: the built-in tactic scores decide alone. */
  model?: DecisionModel;
  /** Entities around the player (players are dropped). */
  entities(radius: number): Promise<EntityInfo[]>;
  loadout?(): Promise<Loadout>;
  /** Deaths after game tick `since`, for exact kill counts. Without it a struck mob that vanished counts as killed. */
  deaths?(since: number): Promise<{ tick: number; deaths: Death[] }>;
  /** A PNG screenshot as a `data:` URL, for models that accept images. */
  screenshot?(): Promise<string>;
  /** True while the simulation is paused, when the player cannot act. */
  paused?(): boolean;
}

/** Below this probability the model's tactic is not trusted and the built-in choice runs. Six options: 0.3 is a clear lead. */
export const PLAY_MIN_CONFIDENCE = 0.3;
/** The model's `goal_done` stops the loop at or above this, for goals without a built-in check. */
export const PLAY_STOP_THRESHOLD = 0.8;
export const PLAY_DEFAULT_DURATION_MS = 30_000;
export const PLAY_MAX_DURATION_MS = 300_000;
export const PLAY_DEFAULT_STEP_MS = 250;
/** Longest the loop waits for the advisor before it goes with the built-in choice. */
const ADVISOR_TIMEOUT_MS = 1500;
/** After a failed flee, the player fights back this long before trying to run again. */
const CORNERED_HOLD_MS = 4000;
/** The goal check must hold on this many decisions in a row (entity lists can miss a mob for one read). */
const DONE_STREAK = 2;
const LOADOUT_EVERY_MS = 1000;
const MAX_TRACE = 300;
const MAX_LISTED = 8;

export type PlayStop = "goal_done" | "timeout" | "died" | "error";

/** One tactic run in the trace: what was chosen, by whom and why, and how it ended. */
export interface PlayStep {
  step: number;
  /** Milliseconds since the loop started. */
  atMs: number;
  /** The tactic (`fight`, `flee`, `eat`, `goto`, `use_on`, `idle`). */
  action: TacticKind;
  target?: { key: string; id: string; typeId: string };
  by: "builtin" | "model";
  score: number;
  reason: string;
  /** Why the model's answer was not used, when it was not. */
  fallback?: string;
  /** The state the model read and its answers, when a model was asked. */
  state?: string;
  answers?: Record<string, Answer>;
  decisionMs: number;
  result: { ok: boolean; message: string; durationMs: number };
}

export interface PlayStats {
  decisions: number;
  kills: number;
  killed: Record<string, number>;
  swings: number;
  hits: number;
  crits: number;
  damageTaken: number;
  deaths: number;
  health?: number;
}

export interface PlayResult {
  goal: string;
  /** The advisor's label, or `none`. */
  model: string;
  steps: number;
  stoppedBy: PlayStop;
  message: string;
  durationMs: number;
  /** Advisor latency (zeros without one). */
  latency: { medianMs: number; p90Ms: number; maxMs: number };
  /**
   * Decisions the model answered (`answered`), the ones where its tactic ran (`used`), and the ones where that tactic
   * (kind and target) differs from what the built-in scores would have run (`differed`). All zero without a model.
   */
  advice: { answered: number; used: number; differed: number };
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

function threatLine(t: Threat): string {
  const parts = [`${t.key}: ${shortType(t.typeId)}, ${round(t.distance)} blocks`];
  if (Math.abs(t.approach) >= 0.5) parts.push(t.approach > 0 ? `closing ${round(t.approach)} b/s` : `moving away ${round(-t.approach)} b/s`);
  if (t.fuse?.lit) parts.push(`FUSE LIT ${t.fuse.ms} ms`);
  if (t.hostile) parts.push(`danger ${round(t.danger, 2)}`);
  if (t.health) parts.push(`health ${round(t.health.current)}/${round(t.health.max)}`);
  if (t.aimed) parts.push("under the crosshair");
  return `- ${parts.join(", ")}`;
}

/** The compact text state the advisor reads. */
export function playStateText(input: { goal: string; check: GoalCheck; map: ThreatMap; doing?: string; last?: string; timeLeftMs: number }): string {
  const { map } = input;
  const v = map.vitals;
  const lines = [`Goal: ${input.goal}`, `Progress: ${input.check.progress}`, `Time left: ${round(input.timeLeftMs / 1000, 0)} s`];
  lines.push(
    `Player: health ${round(v.health)}/20${v.hunger !== undefined ? `, food ${round(v.hunger)}/20` : ""}, armor ${v.armor}, ` +
      `holding ${v.held ? shortType(v.held) : "nothing"}${map.me.onGround ? ", on ground" : ", in the air"}`,
  );
  lines.push(`Best weapon: ${v.weapon ? `${shortType(v.weapon.typeId)} (slot ${v.weapon.slot})` : "none"}. Food: ${v.food ? `${shortType(v.food.typeId)} (slot ${v.food.slot})` : "none"}`);
  const hostiles = map.hostiles.slice(0, MAX_LISTED);
  lines.push(hostiles.length ? "Hostile:" : "Hostile: none near");
  for (const t of hostiles) lines.push(threatLine(t));
  const others = map.entities.filter((t) => !t.hostile).slice(0, MAX_LISTED);
  if (others.length) {
    lines.push("Other:");
    for (const t of others) lines.push(threatLine(t));
  }
  lines.push(`Doing: ${input.doing ?? "nothing yet"}`);
  lines.push(`Last result: ${input.last ?? "none yet"}`);
  return lines.join("\n");
}

/** The advisor's questions for the tactics on offer and the entities they can target. */
export function playQuestions(scored: readonly Tactic[], map: ThreatMap, askDone: boolean): Record<string, Question> {
  const tacticCriteria: Record<string, string> = {};
  for (const t of scored) tacticCriteria[t.kind] ??= TACTIC_TEXT[t.kind];
  const targetCriteria: Record<string, string> = { none: "no target" };
  for (const t of map.entities.slice(0, MAX_LISTED)) targetCriteria[t.key] = `${shortType(t.typeId)} ${round(t.distance)} blocks away`;
  return {
    tactic: { type: "choice", instructions: "Which tactic should the player follow now to make progress on the goal while staying alive?", criteria: tacticCriteria },
    target: { type: "choice", instructions: "Which entity should the tactic be aimed at?", criteria: targetCriteria },
    ...(askDone ? { goal_done: { type: "noul", instructions: "Is the goal already fully achieved?" } as Question } : {}),
  };
}

function choiceP(a: Answer | undefined): number {
  if (!a || a.type !== "choice") return 0;
  return a.probabilities[a.choice] ?? a.confidence ?? 0;
}

function noulP(a: Answer | undefined): number {
  return a && a.type === "noul" ? a.noul : 0;
}

/**
 * The tactic to run from the built-in scores and the advisor's answers. An emergency, a low-confidence or infeasible
 * answer keeps the built-in choice; a targeted tactic without a usable target answer takes its best-scored target.
 */
export function adviseTactic(
  scored: readonly Tactic[],
  answers: Record<string, Answer> | undefined,
  running?: string,
  minConfidence = PLAY_MIN_CONFIDENCE,
): { tactic: Tactic; by: "builtin" | "model"; fallback?: string; builtin: Tactic } {
  const builtin = chooseTactic(scored, running);
  const pick = adviseFrom(scored, answers, running, minConfidence, builtin);
  return { ...pick, builtin };
}

function adviseFrom(
  scored: readonly Tactic[],
  answers: Record<string, Answer> | undefined,
  running: string | undefined,
  minConfidence: number,
  builtin: Tactic,
): { tactic: Tactic; by: "builtin" | "model"; fallback?: string } {
  if (!answers) return { tactic: builtin, by: "builtin" };
  if (builtin.score >= EMERGENCY) return { tactic: builtin, by: "builtin", fallback: `emergency: ${builtin.reason}` };
  const a = answers.tactic;
  if (!a || a.type !== "choice") return { tactic: builtin, by: "builtin", fallback: "no usable tactic answer" };
  const p = choiceP(a);
  if (p < minConfidence) return { tactic: builtin, by: "builtin", fallback: `${a.choice} at ${round(p, 2)} is under ${minConfidence}` };
  const options = scored.filter((t) => t.kind === a.choice);
  if (options.length === 0) return { tactic: builtin, by: "builtin", fallback: `${a.choice} is not possible now` };
  const t = answers.target;
  if (TARGETED[a.choice as TacticKind]) {
    const named = t && t.type === "choice" ? options.find((o) => o.target?.key === t.choice) : undefined;
    if (named) return { tactic: named, by: "model" };
    const best = (running && options.find((o) => tacticKey(o) === running)) || options[0];
    return { tactic: best as Tactic, by: "model", fallback: `target ${t && t.type === "choice" ? t.choice : "missing"} does not fit ${a.choice}, took ${best?.target?.key}` };
  }
  return { tactic: options[0] as Tactic, by: "model" };
}

/** The controller action that carries a tactic out. */
export function tacticAction(t: Tactic, goal: Goal, stepMs: number, timeLeftMs: number): PlayerAction {
  const left = Math.max(1000, timeLeftMs);
  switch (t.kind) {
    case "fight":
      return { action: "fight", ...(t.target ? { target: t.target.id } : {}), all: false, timeoutMs: left };
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

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
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

/**
 * Run the tactic loop until the goal is done (by the built-in check, or the advisor's `goal_done` for goals without
 * one), the player dies, time runs out, or something fails.
 */
export async function play(
  spec: PlayAction,
  env: PlayEnvironment,
  options: { minConfidence?: number; stopThreshold?: number; signal?: AbortSignal; onStep?: (step: PlayStep) => void } = {},
): Promise<PlayResult> {
  const durationMs = Math.min(spec.durationMs ?? PLAY_DEFAULT_DURATION_MS, PLAY_MAX_DURATION_MS);
  const stepMs = spec.stepMs ?? PLAY_DEFAULT_STEP_MS;
  const allowed = allowedTactics(spec.allow);
  const minConfidence = options.minConfidence ?? PLAY_MIN_CONFIDENCE;
  const stopThreshold = options.stopThreshold ?? PLAY_STOP_THRESHOLD;
  const model = spec.advisor === false ? undefined : env.model;
  const vision = spec.vision === true && model?.images === true && env.screenshot !== undefined;
  const c = env.controller;
  const goal = parseGoal(spec.goal);
  const stats = resetStats(c);
  const tracker = new ThreatTracker();
  const kills = new Map<string, string>();
  const started = Date.now();
  const deadline = started + durationMs;
  const trace: PlayStep[] = [];
  const latencies: number[] = [];
  let steps = 0;
  let decisions = 0;
  let damageTaken = 0;
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
  let message = `ran for ${round(durationMs / 1000, 0)} s without the goal being done`;

  const finish = async (why?: string): Promise<void> => {
    const r = running;
    if (!r) return;
    running = undefined;
    if (!r.result) r.ctrl.abort();
    const result = await r.promise;
    const text = why && result.message === "cancelled" ? `preempted (${why})` : result.message;
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

  const advice = { answered: 0, used: 0, differed: 0 };
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
      const fighting = running?.step.action === "fight" ? running.step.target?.id : undefined;
      const scored = scoreTactics(map, goal, { usedOn: stats.usedOn, allowed, recovering, cornered: Date.now() < cornerUntil, ...(fighting ? { fighting } : {}) });
      decisions++;
      let answers: Record<string, Answer> | undefined;
      let text: string | undefined;
      let decisionMs = 0;
      if (model) {
        const doing = running ? `${running.step.action}${running.step.target ? ` ${running.step.target.key}` : ""} for ${round((Date.now() - running.started) / 1000)} s` : undefined;
        text = playStateText({ goal: spec.goal, check, map, ...(doing ? { doing } : {}), ...(last ? { last } : {}), timeLeftMs: deadline - Date.now() });
        const state: DecisionState = vision && env.screenshot ? [text, { type: "image_url", image_url: { url: await env.screenshot() } }] : text;
        const limit = AbortSignal.timeout(Math.max(1, Math.min(ADVISOR_TIMEOUT_MS, deadline - Date.now())));
        const signal = options.signal ? AbortSignal.any([options.signal, limit]) : limit;
        try {
          const decision = await model.decide(state, playQuestions(scored, map, !check.known), { signal });
          answers = decision.answers;
          decisionMs = decision.latencyMs;
          latencies.push(decision.latencyMs);
        } catch (err) {
          if (options.signal?.aborted) throw err;
          // A slow or failed answer: the built-in choice runs this time.
          decisionMs = Date.now() - tickStarted;
          last = `advisor failed (${err instanceof Error ? err.message : String(err)}), built-in choice used`;
        }
        if (!check.known && noulP(answers?.goal_done) >= stopThreshold) {
          stoppedBy = "goal_done";
          message = `the model judged the goal done (p ${round(noulP(answers?.goal_done), 2)})`;
          break;
        }
      }
      const picked = adviseTactic(scored, answers, running?.key, minConfidence);
      if (answers) {
        advice.answered++;
        if (picked.by === "model") {
          advice.used++;
          if (tacticKey(picked.tactic) !== tacticKey(picked.builtin)) advice.differed++;
        }
      }
      if (picked.tactic.recover) recovering = true;
      const key = tacticKey(picked.tactic);
      if (running?.key !== key) {
        await finish(`${picked.tactic.kind}${picked.tactic.target ? ` ${picked.tactic.target.key}` : ""}: ${picked.tactic.reason}`);
        const t = picked.tactic;
        const ctrl = new AbortController();
        const signal = options.signal ? AbortSignal.any([options.signal, ctrl.signal]) : ctrl.signal;
        const r: Running = {
          key,
          ctrl,
          started: Date.now(),
          promise: c.run(tacticAction(t, goal, stepMs, deadline - Date.now()), signal),
          step: {
            step: steps + 1,
            atMs: tickStarted - started,
            action: t.kind,
            ...(t.target ? { target: { key: t.target.key, id: t.target.id, typeId: t.target.typeId } } : {}),
            by: picked.by,
            score: Math.round(t.score * 100) / 100,
            reason: t.reason,
            ...(picked.fallback ? { fallback: picked.fallback } : {}),
            ...(text ? { state: text } : {}),
            ...(answers ? { answers } : {}),
            decisionMs,
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
  const sorted = [...latencies].sort((a, b) => a - b);
  const state = await c.world.state(1000).catch(() => undefined);
  const killed: Record<string, number> = {};
  for (const t of kills.values()) killed[shortType(t)] = (killed[shortType(t)] ?? 0) + 1;
  return {
    goal: spec.goal,
    model: model?.label ?? "none",
    steps,
    stoppedBy,
    message,
    durationMs: Date.now() - started,
    latency: { medianMs: percentile(sorted, 0.5), p90Ms: percentile(sorted, 0.9), maxMs: sorted.at(-1) ?? 0 },
    advice,
    goalCheck: { kind: goal.kind, known: check.known, progress: check.progress },
    stats: {
      decisions,
      kills: kills.size,
      killed,
      swings: stats.swings,
      hits: stats.hits,
      crits: stats.crits,
      damageTaken: Math.round(damageTaken * 10) / 10,
      deaths,
      ...(state?.health !== undefined ? { health: state.health } : {}),
    },
    trace,
    ...(state ? { state } : {}),
  };
}
