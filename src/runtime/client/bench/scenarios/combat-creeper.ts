import { FIGHTER, combat } from "../kit.ts";

/** One creeper, sword only: sprint-hit it back, step out when it hisses, never take blast damage. */
export default combat({
  name: "creeper",
  summary: "1 creeper at night, iron sword only (iron armor, shield, beef), no blast damage allowed",
  runs: 10,
  goal: "kill the creeper",
  player: { ...FIGHTER, hotbar: [{ item: "iron_sword" }, { item: "cooked_beef", amount: 16 }] },
  mobs: [{ type: "creeper", at: { dx: 0, dy: 0, dz: 10 } }],
  also: (o) => o.blastDamage === 0,
});
