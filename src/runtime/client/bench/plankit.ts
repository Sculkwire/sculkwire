/**
 * Shared pieces of the `goal` and `task` suites, which measure what `play` makes of a goal in plain words: the
 * scenario shape, the plan's numbers for the table, the distance to a block, and item counts from the helper's
 * inventory query.
 */
import type { PlayerInventory } from "../../engine/inventory.ts";
import type { PlayResult } from "../skills/play.ts";
import { countsOf } from "../tasks/stock.ts";
import { num, type BenchContext, type Metric, type Offset, type RunOutcome, type Scenario } from "./types.ts";

/** A `play` scenario over phrasings: the action plays `goals[0]` (the runner swaps in run i's phrasing) for `timeoutMs`. */
export function phrased(s: Omit<Scenario, "action" | "goals"> & { goals: string[] }): Scenario {
  return { ...s, action: () => ({ action: "play", goal: s.goals[0] as string, durationMs: s.timeoutMs }) };
}

/** Success when the extra `key` is a number of at least `n` (items carried at the end of the run). */
export function atLeast(key: string, n: number): NonNullable<Scenario["success"]> {
  return (_o, extra) => num(extra, key) >= n;
}

/**
 * The plan's numbers: `planSteps`, `freeSteps` (parts the grammar did not understand, which end the run with
 * `goal_unknown`), `retries` (task steps a hostile interrupted).
 */
export function planExtras(play: PlayResult | undefined): Record<string, Metric> {
  const plan = play?.plan ?? [];
  return {
    planSteps: plan.length,
    freeSteps: plan.filter((s) => s.kind === "free").length,
    retries: plan.reduce((n, s) => n + (s.retries ?? 0), 0),
  };
}

/** Horizontal distance from the player at the end of the run to the centre of the block at `o`. */
export function distanceTo(ctx: BenchContext, o: RunOutcome, block: Offset): number {
  const at = ctx.at(block);
  const me = o.state?.location;
  if (!me) return Number.POSITIVE_INFINITY;
  return Math.round(Math.hypot(me.x - (at.x + 0.5), me.z - (at.z + 0.5)) * 10) / 10;
}

/** How many of `item` (namespaced) the player carries, from the helper's `inventory` query; 0 when it cannot be read. */
export async function carried(ctx: BenchContext, item: string): Promise<number> {
  const read = (await ctx.query("inventory").catch(() => undefined)) as { inventory?: PlayerInventory } | undefined;
  return read?.inventory ? (countsOf(read.inventory)[item] ?? 0) : 0;
}

/** What the last trader the plan's trade steps opened offered (`offers of the villager at x y z: ...`), "" when none. */
export function offerText(play: PlayResult | undefined): string {
  const lines = (play?.plan ?? []).filter((s) => s.kind === "trade").flatMap((s) => s.actions ?? []);
  return lines.findLast((line) => line.startsWith("offers of ")) ?? "";
}

/** At most this many lines of task-step detail per run in the bench JSON. */
const STEP_LINES_MAX = 60;

/**
 * The plan's task steps for the bench JSON: per step a header line (`fetch "all diamonds": failed not_found: took 1 of
 * the 3 diamond ...`) and its action lines indented. Bounded to `STEP_LINES_MAX` lines, the last saying how many were
 * left out.
 */
export function planStepLines(play: PlayResult | undefined): string[] {
  const lines: string[] = [];
  for (const step of play?.plan ?? []) {
    if (!step.actions && step.kind === "free") continue;
    lines.push(`${step.kind} "${step.text}": ${step.status}${step.reason ? ` ${step.reason}` : ""}${step.message ? `: ${step.message}` : ""}`);
    for (const action of step.actions ?? []) lines.push(`  ${action}`);
  }
  if (lines.length <= STEP_LINES_MAX) return lines;
  return [...lines.slice(0, STEP_LINES_MAX - 1), `... ${lines.length - (STEP_LINES_MAX - 1)} more lines`];
}
