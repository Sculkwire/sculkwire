/**
 * `sculk bench --stance`: how the fight uses the shield (`auto`, `kite` or `guard`), set on the action every scenario
 * returns, so the same scenarios are measured per stance. Pure, so the tests check the parsing and the actions.
 */
import type { PlayerAction } from "../types.ts";
import type { PlayAction } from "../skills/play.ts";
import { parseEnumList } from "./args.ts";

export type BenchStance = NonNullable<PlayAction["stance"]>;

const STANCES: readonly BenchStance[] = ["auto", "kite", "guard"];

export function parseStances(text: string): BenchStance[] | undefined {
  return parseEnumList(text, STANCES);
}

/** The scenario's action with `stance` set when it is a `play` goal or a `fight`; any other action unchanged. */
export function withStance(spec: PlayerAction | PlayAction, stance: BenchStance | undefined): PlayerAction | PlayAction {
  if (stance === undefined || (spec.action !== "play" && spec.action !== "fight")) return spec;
  return { ...spec, stance };
}
