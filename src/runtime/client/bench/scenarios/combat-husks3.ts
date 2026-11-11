import { combat, FIGHTER } from "../kit.ts";

/**
 * Three husks in a tight group, summoned half a second after `play` started in daylight (husks do not burn): a group
 * that arrives together, against a player already in survival. The goal counts kills, so it cannot be done before
 * the husks exist.
 */
export default combat({
  name: "husks3",
  summary: "3 husks in a tight group at day, summoned after the fight started, iron sword, iron armor, shield, cooked beef",
  runs: 10,
  goal: "kill 3 husks",
  player: { ...FIGHTER, time: "day" },
  spawnAfterMs: 500,
  mobs: [
    { type: "husk", at: { dx: -1, dy: 0, dz: 10 } },
    { type: "husk", at: { dx: 0, dy: 0, dz: 10 } },
    { type: "husk", at: { dx: 1, dy: 0, dz: 10 } },
  ],
});
