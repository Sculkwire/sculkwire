import { describe, expect, it } from "vitest";
import { stem, tokenize } from "./tokenize.ts";

describe("tokenize", () => {
  it("keeps namespaced ids whole and splits them", () => {
    const t = tokenize("Use minecraft:behavior.tempt here");
    expect(t).toEqual(expect.arrayContaining(["minecraft:behavior.tempt", "behavior.tempt", "minecraft", "behavior", "tempt", "use"]));
    expect(t).not.toContain("here.");
  });
  it("splits camelCase and snake_case but keeps the whole identifier", () => {
    expect(tokenize("getComponent")).toEqual(expect.arrayContaining(["getcomponent", "get", "component"]));
    expect(tokenize("EntityHealthComponent")).toEqual(
      expect.arrayContaining(["entityhealthcomponent", "entity", "health", "component"]),
    );
    expect(tokenize("query.is_baby")).toEqual(expect.arrayContaining(["query.is_baby", "is_baby", "baby"]));
  });
  it("drops stop words and trailing sentence punctuation", () => {
    expect(tokenize("The mob. Then it runs")).toEqual(["mob", "then", "runs"]);
  });
  it("stems plain plurals consistently", () => {
    expect(stem("properties")).toBe("property");
    expect(stem("entities")).toBe("entity");
    expect(stem("class")).toBe("class");
    expect(stem("status")).toBe("status");
    expect(tokenize("dynamic properties")).toEqual(tokenize("dynamic property"));
  });
});
