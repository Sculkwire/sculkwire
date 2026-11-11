import { describe, expect, it } from "vitest";
import { editDistance, suggestNames } from "./suggest.ts";

const COMMANDS = ["give", "gamemode", "gamerule", "tp", "teleport", "time", "tell", "summon", "kill", "list"];

describe("editDistance", () => {
  it("counts a swap of adjacent letters as one edit", () => {
    expect(editDistance("gvie", "give")).toBe(1);
    expect(editDistance("tpp", "tp")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
  });
});

describe("suggestNames", () => {
  it("suggests give for gvie", () => {
    expect(suggestNames("gvie", COMMANDS)[0]).toBe("give");
  });

  it("suggests tp for tpp", () => {
    expect(suggestNames("tpp", COMMANDS)).toEqual(["tp"]);
  });

  it("suggests nothing for a far-off word", () => {
    expect(suggestNames("xyzzyplugh", COMMANDS)).toEqual([]);
    expect(suggestNames("banana", COMMANDS)).toEqual([]);
  });

  it("ranks substring matches before edit-distance matches, then by closeness and name", () => {
    expect(suggestNames("tim", COMMANDS)).toEqual(["time"]);
    expect(suggestNames("tel", COMMANDS)).toEqual(["tell", "teleport"]);
  });

  it("gives the same order whatever the candidate order", () => {
    const reversed = [...COMMANDS].reverse();
    for (const q of ["gvie", "game", "tel", "tpp", "kil"]) {
      expect(suggestNames(q, reversed)).toEqual(suggestNames(q, COMMANDS));
    }
  });

  it("compares the key, dedupes and honours the limit", () => {
    const names = ["Entity.applyDamage", "Player.applyImpulse", "Entity.applyDamage", "world"];
    expect(suggestNames("applyDamgae", names, { key: (n) => n.slice(n.lastIndexOf(".") + 1) })).toEqual([
      "Entity.applyDamage",
    ]);
    expect(suggestNames("t", COMMANDS, { limit: 2 })).toEqual(["tp", "list"]);
  });
});
