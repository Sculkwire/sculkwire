import { describe, expect, it } from "vitest";
import { parseLocations } from "./frames.ts";

describe("script frames", () => {
  it("extracts script frames as Minecraft prints them", () => {
    expect(parseLocations("[Pack] Error: boom    at <anonymous> (main.js:7)")).toEqual([{ file: "main.js", line: 7 }]);
    expect(parseLocations("Error: x\n    at f (lib/util.js:12:5)\n    at <anonymous> (main.js:3)")).toEqual([
      { file: "lib/util.js", line: 12, column: 5 },
      { file: "main.js", line: 3 },
    ]);
    expect(parseLocations("sculkwire fixture: hello")).toEqual([]);
  });
});
