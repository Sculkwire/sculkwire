/**
 * `sculk bench --stance`: how the fight uses the shield (`auto`, `kite` or `guard`), set on the action every scenario
 * returns, so the same scenarios are measured per stance. Pure, so the tests check the parsing and the actions.
 */
import type { PlayerAction } from "../types.ts";
import type { PlayAction } from "../skills/play.ts";

export type BenchStance = NonNullable<PlayAction["stance"]>;

const STANCES: readonly BenchStance[] = ["auto", "kite", "guard"];

/** One of `allowed` or a comma list of them (any order, any case, spaces allowed, repeats dropped). Undefined for anything else. */
export function parseEnumList<T extends string>(text: string, allowed: readonly T[]): T[] | undefined {
  const parts = text.split(",").map((p) => p.trim().toLowerCase());
  if (parts.some((p) => !(allowed as readonly string[]).includes(p))) return undefined;
  return [...new Set(parts as T[])];
}

export function parseStances(text: string): BenchStance[] | undefined {
  return parseEnumList(text, STANCES);
}

/** The scenario's action with `stance` set when it is a `play` goal or a `fight`; any other action unchanged. */
export function withStance(spec: PlayerAction | PlayAction, stance: BenchStance | undefined): PlayerAction | PlayAction {
  if (stance === undefined || (spec.action !== "play" && spec.action !== "fight")) return spec;
  return { ...spec, stance };
}
