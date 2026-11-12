import { describe, expect, it } from "vitest";
import { isPlainObject } from "./json.ts";

describe("isPlainObject", () => {
  it("passes objects only: not null, arrays or primitives", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: [1] })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    for (const value of [null, undefined, [], [{}], "x", 0, true]) expect(isPlainObject(value)).toBe(false);
  });
});
