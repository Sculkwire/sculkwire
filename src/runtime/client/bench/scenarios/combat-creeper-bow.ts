import { FIGHTER, combat } from "../kit.ts";

/** One creeper with a bow and 16 arrows: shoot it from range before it gets close. */
export default combat({
  name: "creeper-bow",
  summary: "1 creeper at night, bow and 16 arrows plus the iron sword, no blast damage allowed",
  runs: 5,
  goal: "kill the creeper",
  player: { ...FIGHTER, hotbar: [{ item: "iron_sword" }, { item: "bow" }, { item: "arrow", amount: 16 }, { item: "cooked_beef", amount: 16 }] },
  mobs: [{ type: "creeper", at: { dx: 0, dy: 0, dz: 12 } }],
  also: (o) => o.blastDamage === 0,
});
