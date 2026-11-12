import { describe, expect, it } from "vitest";
import { parseStances, withStance } from "./stance.ts";

describe("stances", () => {
  it("parses one stance or a list, and refuses anything else", () => {
    expect(parseStances("guard")).toEqual(["guard"]);
    expect(parseStances("kite, guard,auto,kite")).toEqual(["kite", "guard", "auto"]);
    expect(parseStances("")).toBeUndefined();
    expect(parseStances("kite,")).toBeUndefined();
    expect(parseStances("block")).toBeUndefined();
  });
  it("sets the stance on a play goal and a fight, and leaves other actions alone", () => {
    expect(withStance({ action: "play", goal: "kill all the zombies" }, "guard")).toEqual({ action: "play", goal: "kill all the zombies", stance: "guard" });
    expect(withStance({ action: "fight", target: "zombie" }, "kite")).toEqual({ action: "fight", target: "zombie", stance: "kite" });
    expect(withStance({ action: "goto", x: 1, z: 2 }, "kite")).toEqual({ action: "goto", x: 1, z: 2 });
    expect(withStance({ action: "play", goal: "kill 3 husks" }, undefined)).toEqual({ action: "play", goal: "kill 3 husks" });
  });
});
