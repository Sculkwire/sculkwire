import { describe, expect, it } from "vitest";
import { parseViews, viewValue } from "./view.ts";

describe("views", () => {
  it("parses one view or both, and refuses anything else", () => {
    expect(parseViews("first")).toEqual(["first"]);
    expect(parseViews("third, first")).toEqual(["third", "first"]);
    expect(parseViews("first,first")).toEqual(["first"]);
    expect(parseViews("")).toBeUndefined();
    expect(parseViews("first,")).toBeUndefined();
    expect(parseViews("front")).toBeUndefined();
  });
  it("writes game_thirdperson in the type the game reports", () => {
    expect(viewValue("first", { type: "int" })).toBe(0);
    expect(viewValue("third", { type: "int" })).toBe(1);
    expect(viewValue("third", { type: "bool" })).toBe(true);
    expect(viewValue("third", { type: "enum", values: ["first", "back", "front"] })).toBe("back");
  });
});
