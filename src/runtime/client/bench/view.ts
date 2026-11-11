/**
 * `sculk bench --view`: which camera the game shows while the scenarios run. The runner sets the game's own
 * `game_thirdperson` option through the attached agent (the `game_settings` route) and puts the original value back at
 * the end of the bench. Pure, so the tests check the parsing and the values.
 */
import type { GameSetting, SettingValue } from "../../engine/engine.ts";

export type BenchView = "first" | "third";

/** The option the game saves the camera in: 0 first person, 1 third person behind the player. */
export const VIEW_OPTION = "game_thirdperson";

const VIEWS: readonly BenchView[] = ["first", "third"];

/** `first`, `third` or `first,third` (any order, spaces allowed, repeats dropped). Undefined for anything else. */
export function parseViews(text: string): BenchView[] | undefined {
  const parts = text.split(",").map((p) => p.trim().toLowerCase());
  if (parts.length === 0 || parts.some((p) => !(VIEWS as readonly string[]).includes(p))) return undefined;
  return [...new Set(parts as BenchView[])];
}

/** The value of `game_thirdperson` for a view, in the type the game reports for the option. */
export function viewValue(view: BenchView, setting: Pick<GameSetting, "type" | "values">): SettingValue {
  const index = view === "first" ? 0 : 1;
  if (setting.type === "bool") return index === 1;
  if (setting.type === "enum") return setting.values?.[index] ?? String(index);
  if (setting.type === "string") return String(index);
  return index;
}
