import { describe, expect, it } from "vitest";
import { killHostiles, mapOf, mob } from "../../../testing/skillgame.ts";
import { checkGoal, parseGoal } from "./goal.ts";

describe("goals", () => {
  it("reads common goals", () => {
    expect(killHostiles).toEqual({ kind: "kill", radius: 24 });
    expect(parseGoal("Kill 3 zombies")).toEqual({ kind: "kill", type: "minecraft:zombie", count: 3, radius: 24 });
    expect(parseGoal("kill all the skeletons")).toEqual({ kind: "kill", type: "minecraft:skeleton", radius: 24 });
    expect(parseGoal("kill the creeper")).toEqual({ kind: "kill", type: "minecraft:creeper", count: 1, radius: 24 });
    expect(parseGoal("kill two cave spiders")).toEqual({ kind: "kill", type: "minecraft:cave_spider", count: 2, radius: 24 });
    expect(parseGoal("walk to 10, -5")).toEqual({ kind: "reach", x: 10, z: -5, radius: 2 });
    expect(parseGoal("go to 10 64 -20")).toEqual({ kind: "reach", x: 10, y: 64, z: -20, radius: 2 });
    expect(parseGoal("hit every cow near you once with the held item")).toEqual({ kind: "use_on", type: "minecraft:cow", radius: 24 });
    expect(parseGoal("build a house")).toEqual({ kind: "free" });
  });

  it("checks kill, reach and use goals against the game", () => {
    const kills = new Map([["1", "minecraft:zombie"], ["2", "minecraft:zombie"], ["3", "minecraft:cow"]]);
    const none = new Map<string, string>();
    const zombieLeft = mapOf([mob("z", "zombie", 0, 5), mob("c", "cow", 0, 3)]);
    expect(checkGoal(parseGoal("kill 2 zombies"), { map: zombieLeft, kills, usedOn: none })).toMatchObject({ known: true, done: true, progress: "2 of 2 zombie killed" });
    expect(checkGoal(parseGoal("kill 3 zombies"), { map: zombieLeft, kills, usedOn: none }).done).toBe(false);
    expect(checkGoal(killHostiles, { map: zombieLeft, kills, usedOn: none })).toMatchObject({ done: false, progress: "2 hostile killed, 1 left within 24 blocks" });
    expect(checkGoal(killHostiles, { map: mapOf([mob("c", "cow", 0, 3)]), kills, usedOn: none }).done).toBe(true);
    expect(checkGoal(parseGoal("go to 1 1"), { map: zombieLeft, kills, usedOn: none }).done).toBe(true);
    const cows = mapOf([mob("a", "cow", 0, 3), mob("b", "cow", 0, 6)]);
    const hitCows = parseGoal("hit each cow once");
    expect(checkGoal(hitCows, { map: cows, kills, usedOn: new Map([["a", "minecraft:cow"]]) }).done).toBe(false);
    expect(checkGoal(hitCows, { map: cows, kills, usedOn: new Map([["a", "minecraft:cow"], ["b", "minecraft:cow"]]) })).toMatchObject({ done: true, progress: "2 cow hit, 0 left within 24 blocks" });
    expect(checkGoal(parseGoal("dance"), { map: cows, kills, usedOn: none }).known).toBe(false);
  });
});
