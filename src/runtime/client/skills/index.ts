/**
 * Skills: continuous, preemptible behaviors with the shape `(pc, args, signal) => Promise<{ ok, message }>`. They run
 * through `PlayerController.run` (actions `fight`, `flee`, `eat`, `use_on`), and the tactic layer of `play` picks
 * among them. They import the controller's helpers only inside functions, so the import cycle with `player.ts` is safe.
 */
export { eat, type EatArgs } from "./eat.ts";
export { fight, type FightArgs } from "./fight.ts";
export { flee, type FleeArgs } from "./flee.ts";
export { useOn, type UseOnArgs } from "./useon.ts";
export type { FightStats, SkillResult } from "./types.ts";
