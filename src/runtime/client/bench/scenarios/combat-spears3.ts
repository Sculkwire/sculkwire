import { combat, FIGHTER } from "../kit.ts";

/**
 * Three husks with iron spears at day. A spear husk does not walk in and swing: it lowers the spear, charges
 * through the player from 6 to 7 blocks out (the hit is the contact at speed), then backs off to 9 to 11 blocks
 * and comes again (`minecraft:behavior.use_kinetic_weapon` in the vanilla husk). Their charges also run each other
 * through, so a run succeeds when every husk is dead, by the player or by another husk, and the player is alive;
 * `kills` stays the player's kills and `otherDeaths` counts the rest.
 */
export default combat({
  name: "spears3",
  summary: "3 husks with iron spears at day 10 blocks out, iron sword, iron armor, shield, cooked beef",
  runs: 10,
  goal: "kill 3 husks",
  player: { ...FIGHTER, time: "day" },
  mobs: [
    { type: "husk", at: { dx: -2, dy: 0, dz: 10 }, held: "iron_spear" },
    { type: "husk", at: { dx: 0, dy: 0, dz: 10 }, held: "iron_spear" },
    { type: "husk", at: { dx: 2, dy: 0, dz: 10 }, held: "iron_spear" },
  ],
  success: (o, extra) => o.kills + (typeof extra.otherDeaths === "number" ? extra.otherDeaths : 0) >= 3 && o.deaths === 0,
});
