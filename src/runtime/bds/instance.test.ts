import { describe, expect, it } from "vitest";
import { dirLinkType, setProperties } from "./instance.ts";

describe("server.properties", () => {
  it("rewrites and appends server.properties keys", () => {
    expect(setProperties("a=1\n# c\nb=2", { b: "3", d: "4" })).toBe("a=1\n# c\nb=3\nd=4");
  });
});

describe("dirLinkType", () => {
  it("uses junctions on Windows (no admin or Developer Mode needed)", () => {
    expect(dirLinkType("win32")).toBe("junction");
    expect(dirLinkType("linux")).toBe("dir");
    expect(dirLinkType("darwin")).toBe("dir");
  });
});
