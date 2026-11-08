/** Per-scenario aggregates and the markdown table the bench prints. Pure, so the tests check the numbers. */
import type { StalenessSummary } from "../entitystream.ts";
import type { Metric, RunOutcome } from "./types.ts";

export interface RunRecord {
  run: number;
  success: boolean;
  outcome: Omit<RunOutcome, "play" | "state" | "action" | "hurts"> & { hurts: number };
  extra: Record<string, Metric>;
  /** The play trace's tactic summary or the action message, for reading failures. */
  note: string;
  /** What the fight saw around every hit the player took (`CombatStats.events`), for finding out why it landed. */
  trace?: string[];
}

export interface ScenarioReport {
  scenario: string;
  suite: string;
  input: string;
  runs: RunRecord[];
  summary: {
    runs: number;
    successes: number;
    avgTimeS: number;
    avgDamage: number;
    avgHealthLeft: number;
    minHealthLeft: number;
    deaths: number;
    kills: number;
    lost: number;
    blastDamage: number;
    falls: number;
    /** Numeric extras averaged over the runs, booleans as the count of true. */
    extra: Record<string, number>;
  };
  /** How old the entity readings the skills got were (ms), by source: the state stream or a helper query. */
  entityAge?: Record<string, StalenessSummary>;
}

function avg(xs: readonly number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function summarize(scenario: string, suite: string, input: string, runs: RunRecord[]): ScenarioReport {
  const o = runs.map((r) => r.outcome);
  const extra: Record<string, number> = {};
  const keys = new Set(runs.flatMap((r) => Object.keys(r.extra)));
  for (const k of keys) {
    const vals = runs.map((r) => r.extra[k]).filter((v) => v !== undefined);
    if (vals.every((v) => typeof v === "boolean")) extra[k] = vals.filter(Boolean).length;
    else if (vals.every((v) => typeof v === "number")) extra[k] = r1(avg(vals as number[]));
  }
  return {
    scenario,
    suite,
    input,
    runs,
    summary: {
      runs: runs.length,
      successes: runs.filter((r) => r.success).length,
      avgTimeS: r1(avg(o.map((x) => x.durationMs / 1000))),
      avgDamage: r1(avg(o.map((x) => x.damageTaken))),
      avgHealthLeft: r1(avg(o.map((x) => x.healthEnd))),
      minHealthLeft: r1(Math.min(...o.map((x) => x.healthEnd))),
      deaths: o.reduce((s, x) => s + x.deaths, 0),
      kills: o.reduce((s, x) => s + x.kills, 0),
      lost: o.reduce((s, x) => s + x.lost, 0),
      blastDamage: r1(o.reduce((s, x) => s + x.blastDamage, 0)),
      falls: o.reduce((s, x) => s + x.falls, 0),
      extra,
    },
  };
}

/** One markdown table, a row per scenario. Extras go into the last column as `name value`. */
export function markdownTable(reports: readonly ScenarioReport[]): string {
  const head = "| scenario | input | success | avg time s | avg damage | avg health left | min health | deaths | kills | lost | blast dmg | falls | extra |";
  const rule = "|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = reports.map((r) => {
    const s = r.summary;
    const extra = Object.entries(s.extra)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    return `| ${r.scenario} | ${r.input} | ${s.successes}/${s.runs} | ${s.avgTimeS} | ${s.avgDamage} | ${s.avgHealthLeft} | ${s.minHealthLeft} | ${s.deaths} | ${s.kills} | ${s.lost} | ${s.blastDamage} | ${s.falls} | ${extra} |`;
  });
  return [head, rule, ...rows].join("\n");
}
