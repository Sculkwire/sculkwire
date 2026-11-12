import { describe, expect, it } from "vitest";
import { fakeGame, me, mob } from "../../../testing/skillgame.ts";
import { fightKills, type Struck } from "./fight.ts";
import type { Death } from "./play.ts";

describe("fight results", () => {
  it("counts the player's kills from the death log, else what the fight struck that is gone", () => {
    const struck = new Map<string, Struck>([
      ["a", { typeId: "minecraft:husk", health: { current: 2, max: 20 } }],
      ["b", { typeId: "minecraft:husk", health: { current: 6, max: 20 } }],
      ["c", { typeId: "minecraft:creeper", health: { current: 20, max: 20 } }],
      ["d", { typeId: "minecraft:zombie" }],
    ]);
    // Husk a died of the last blow before the fight turned to husk b; the creeper blew up.
    const deaths: Death[] = [
      { tick: 5, id: "a", typeId: "minecraft:husk", killer: "minecraft:player" },
      { tick: 9, id: "b", typeId: "minecraft:husk", killer: "minecraft:player" },
      { tick: 9, id: "c", typeId: "minecraft:creeper", cause: "entityExplosion" },
    ];
    expect(fightKills(deaths, struck, new Set())).toEqual({ husk: 2 });
    expect(fightKills(undefined, struck, new Set(["a", "b", "c"]))).toEqual({ husk: 2 });
    expect(fightKills(undefined, struck, new Set(["a", "b", "c", "d"]))).toEqual({ husk: 2, zombie: 1 });
  });

  it("reports kills from the helper's death log since the fight started, and every swing as a hit or a miss", async () => {
    const game = fakeGame([mob("-41", "zombie", 0, 2.5), mob("-42", "zombie", 0, 2.8)], me(), 20, true);
    // Killed before the fight: not its kill.
    game.logDeath({ id: "-40", typeId: "minecraft:zombie", killer: "minecraft:player" });
    const r = await game.env.controller.run({ action: "fight", timeoutMs: 10_000 });
    expect(r.fight).toMatchObject({ kills: { zombie: 2 }, hits: 2, hitsTaken: 0, damageTaken: 0 });
    expect(r.fight?.swings).toBe(game.clicks.length);
    expect((r.fight?.hits ?? 0) + (r.fight?.misses ?? 0)).toBe(r.fight?.swings);
    expect(r.message).toMatch(/^killed 2 zombie with iron_sword: /);
  });
});
