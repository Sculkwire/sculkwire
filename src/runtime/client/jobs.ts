/**
 * Background `play` jobs and cancellable action sequences for `player_act`.
 *
 * A `play` run lasts up to minutes, longer than an MCP client lets one call run, so it runs as a job that the caller
 * polls with `player_job`. Only one job runs at a time because they share the player's keys and mouse. Every other
 * action sequence takes the request's abort signal, so a cancelled or timed-out call lets go of the keys at once.
 */
import type { ActionResult, InputTakeover, PlayerAction, PlayerController } from "./player.ts";
import type { PlayResult, PlayStep } from "./skills/play.ts";

export type JobStatus = "running" | "done" | "stopped" | "failed";

export interface PlayProgress {
  steps: number;
  elapsedMs: number;
  /** The last few steps as `step 4: attack zombie_1 ok: hit`. */
  lastActions: string[];
  /** The plan step being worked on, e.g. `step 2 of 3: craft iron sword`; once the job ended, where it stopped. */
  planStep?: string;
}

export interface PlayJobInfo {
  id: string;
  goal: string;
  status: JobStatus;
  startedAt: number;
  progress: PlayProgress;
  /**
   * Why the job ended, present once it has: the outside reason when it was stopped (player_job stop, a new play job,
   * game_stop, shutdown), else the play loop's own `stoppedBy` (`goal_done`, `timeout`, `died`, `error`, `goal_unknown`), and `error`
   * when the run threw.
   */
  stopReason?: string;
  /** The finished run: trace, stop reason and final state. */
  result?: PlayResult;
  /** The run threw instead of returning a result. */
  error?: string;
}

/** Runs one play loop. It must stop soon after `signal` aborts and release its input. */
export type PlayRunner = (ctx: { signal: AbortSignal; onStep: (step: PlayStep) => void; onPlan: (text: string) => void }) => Promise<PlayResult>;

const LAST_ACTIONS = 5;
const KEEP_FINISHED = 5;


export function stepText(t: PlayStep): string {
  const target = t.target ? ` ${t.target.key}` : "";
  return `step ${t.step}: ${t.action}${target} ${t.result.ok ? "ok" : "failed"}: ${t.result.message}`;
}

class Job {
  readonly id: string;
  readonly goal: string;
  readonly startedAt = Date.now();
  readonly controller = new AbortController();
  readonly steps: PlayStep[] = [];
  readonly listeners = new Set<(step: PlayStep) => void>();
  status: JobStatus = "running";
  finishedAt?: number;
  stopReason?: string;
  result?: PlayResult;
  planStep?: string;
  error?: string;
  finished!: Promise<void>;

  constructor(id: string, goal: string) {
    this.id = id;
    this.goal = goal;
  }

  info(): PlayJobInfo {
    return {
      id: this.id,
      goal: this.goal,
      status: this.status,
      startedAt: this.startedAt,
      progress: {
        steps: this.result?.steps ?? this.steps.length,
        elapsedMs: (this.finishedAt ?? Date.now()) - this.startedAt,
        lastActions: (this.result?.trace ?? this.steps).slice(-LAST_ACTIONS).map(stepText),
        ...(this.planStep ? { planStep: this.planStep } : {}),
      },
      ...(this.stopReason ? { stopReason: this.stopReason } : {}),
      ...(this.result ? { result: this.result } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }
}

/** The play jobs of this process. One runs at a time; the last few finished ones stay readable. */
export class PlayJobs {
  #next = 1;
  #jobs: Job[] = [];

  /** The running job, if any. */
  get current(): PlayJobInfo | undefined {
    const j = this.#running();
    return j?.info();
  }

  #running(): Job | undefined {
    return this.#jobs.find((j) => j.status === "running");
  }

  #find(id?: string): Job {
    const j = id ? this.#jobs.find((x) => x.id === id) : (this.#running() ?? this.#jobs.at(-1));
    if (!j) throw new Error(id ? `no play job ${id} (finished jobs are kept for the last ${KEEP_FINISHED} runs)` : "no play job has run yet");
    return j;
  }

  /** Start a job, stopping the running one first so the two never share the keys. */
  async start(goal: string, runner: PlayRunner): Promise<PlayJobInfo> {
    const previous = this.#running();
    if (previous) await this.#stop(previous, `replaced by a new play job`);
    const job = new Job(`play-${this.#next++}`, goal);
    this.#jobs.push(job);
    const finishedOnes = this.#jobs.filter((j) => j.status !== "running");
    for (const old of finishedOnes.slice(0, Math.max(0, finishedOnes.length - KEEP_FINISHED))) this.#jobs.splice(this.#jobs.indexOf(old), 1);
    const onStep = (step: PlayStep) => {
      job.steps.push(step);
      for (const l of job.listeners) l(step);
    };
    job.finished = (async () => {
      try {
        job.result = await runner({
          signal: job.controller.signal,
          onStep,
          onPlan: (text) => {
            job.planStep = text;
          },
        });
        job.status = job.controller.signal.aborted ? "stopped" : "done";
      } catch (err) {
        job.error = err instanceof Error ? err.message : String(err);
        job.status = job.controller.signal.aborted ? "stopped" : "failed";
      } finally {
        job.finishedAt = Date.now();
        job.stopReason ??= job.result?.stoppedBy ?? "error";
        job.listeners.clear();
      }
    })();
    return job.info();
  }

  status(id?: string): PlayJobInfo {
    return this.#find(id).info();
  }

  /** Stop a job (default the running or latest one) and wait until it has let go of the input. */
  async stop(id?: string, reason = "stopped by player_job"): Promise<PlayJobInfo> {
    const job = this.#find(id);
    if (job.status === "running") await this.#stop(job, reason);
    return job.info();
  }

  /** Stop the running job, if any (game_stop, game_launch, shutdown). */
  async stopAll(reason: string): Promise<void> {
    const job = this.#running();
    if (job) await this.#stop(job, reason);
  }

  /**
   * Wait up to `timeoutMs` for a job to finish, or until `signal` aborts. Returns its state either way.
   * `onStep` sees every step taken while waiting.
   */
  async wait(id: string | undefined, timeoutMs: number, opts: { signal?: AbortSignal; onStep?: (step: PlayStep) => void } = {}): Promise<PlayJobInfo> {
    const job = this.#find(id);
    if (job.status !== "running") return job.info();
    if (opts.onStep) job.listeners.add(opts.onStep);
    const { promise: interrupted, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, timeoutMs);
    const onAbort = () => resolve();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([job.finished, interrupted]);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.onStep) job.listeners.delete(opts.onStep);
    }
    return job.info();
  }

  async #stop(job: Job, reason: string): Promise<void> {
    job.stopReason ??= reason;
    job.controller.abort(new Error(reason));
    await job.finished;
  }
}

/** The process-wide jobs used by the MCP tools. */
export const playJobs = new PlayJobs();

/**
 * While the user holds control (F9), a play job waits before it looks at the world again, so it neither decides nor
 * acts until the user gives control back or the job is stopped. The action it was running stops on the takeover
 * (PlayerController.run).
 */
export function pauseOnTakeover<E extends { entities(radius: number): Promise<unknown> }>(env: E, takeover: InputTakeover | undefined, signal: AbortSignal): E {
  if (!takeover) return env;
  const entities = env.entities.bind(env);
  return {
    ...env,
    entities: async (radius: number) => {
      await takeover.untilControl(signal);
      return entities(radius);
    },
  } as E;
}

/**
 * Run actions in order; stops at the first failure unless `continueOnError`, and at once when `signal` aborts. Keys
 * and buttons are released when the sequence ends either way.
 */
export async function runActions(
  controller: PlayerController,
  actions: readonly PlayerAction[],
  opts: { continueOnError?: boolean; signal?: AbortSignal; onResult?: (r: ActionResult, index: number) => void } = {},
): Promise<ActionResult[]> {
  const out: ActionResult[] = [];
  try {
    for (const [i, a] of actions.entries()) {
      if (opts.signal?.aborted) break;
      const r = await controller.run(a, opts.signal);
      out.push(r);
      opts.onResult?.(r, i);
      if (opts.signal?.aborted || (!r.ok && !opts.continueOnError)) break;
    }
  } finally {
    await controller.releaseAll();
  }
  return out;
}
