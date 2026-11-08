import { combat } from "../kit.ts";

/** Three zombies coming from one side: spacing, hit-and-step-back and W-taps against a group. */
export default combat({
  name: "zombies3",
  summary: "3 zombies at night, iron sword, iron armor, shield, cooked beef",
  runs: 10,
  goal: "kill all the zombies",
  mobs: [
    { type: "zombie", at: { dx: -3, dy: 0, dz: 10 } },
    { type: "zombie", at: { dx: 0, dy: 0, dz: 11 } },
    { type: "zombie", at: { dx: 3, dy: 0, dz: 10 } },
  ],
});
