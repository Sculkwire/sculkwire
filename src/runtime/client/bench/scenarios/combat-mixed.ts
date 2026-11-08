import { combat } from "../kit.ts";

/**
 * Two zombies, a skeleton and a creeper at once: target choice, creeper spacing and arrows together. As in real
 * play, a zombie the skeleton's arrows kill is fine: success is the player alive, the goal done (no hostile left),
 * no blast damage, and the creeper not blown up.
 */
export default combat({
  name: "mixed",
  summary: "2 zombies, a skeleton and a creeper at night",
  runs: 5,
  goal: "kill the hostile mobs near you",
  timeoutMs: 120_000,
  mobs: [
    { type: "zombie", at: { dx: -4, dy: 0, dz: 10 } },
    { type: "zombie", at: { dx: 4, dy: 0, dz: 10 } },
    { type: "skeleton", at: { dx: 0, dy: 0, dz: 12 } },
    { type: "creeper", at: { dx: -8, dy: 0, dz: 6 } },
  ],
  success: (o) => o.deaths === 0 && o.ok && o.blastDamage === 0 && o.exploded === 0,
});
