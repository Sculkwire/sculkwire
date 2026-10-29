import { describe, expect, it } from "vitest";
import { LineIndex, nodeAtPointer, parseJson, pointerFromPath, rangeAtPointer } from "./jsonc.ts";

describe("LineIndex", () => {
  it("maps offsets to 1-based line/column, LF and CRLF", () => {
    const text = "ab\ncd\r\nef";
    const idx = new LineIndex(text);
    expect(idx.position(0)).toEqual({ line: 1, column: 1 });
    expect(idx.position(2)).toEqual({ line: 1, column: 3 });
    expect(idx.position(3)).toEqual({ line: 2, column: 1 });
    expect(idx.position(text.indexOf("e"))).toEqual({ line: 3, column: 1 });
    expect(idx.position(999)).toEqual({ line: 3, column: 3 });
    expect(idx.lineRange(2)).toEqual({ start: { line: 2, column: 1 }, end: { line: 2, column: 3 } });
  });
});

describe("pointer -> range", () => {
  const doc = parseJson('{\n  "a": {\n    "b": [1, "x"],\n    "c/d": true\n  }\n}');
  it("finds values, keys and escaped segments", () => {
    expect(rangeAtPointer(doc, "/a/b/1")).toEqual({ start: { line: 3, column: 14 }, end: { line: 3, column: 17 } });
    expect(rangeAtPointer(doc, "/a/c~1d")).toEqual({ start: { line: 4, column: 12 }, end: { line: 4, column: 16 } });
    expect(rangeAtPointer(doc, "/a/c~1d", true)).toEqual({ start: { line: 4, column: 5 }, end: { line: 4, column: 10 } });
    expect(pointerFromPath(["a", "c/d"])).toBe("/a/c~1d");
  });
  it("highlights the key of an object value and falls back to the nearest ancestor", () => {
    expect(rangeAtPointer(doc, "/a").start).toEqual({ line: 2, column: 3 });
    expect(nodeAtPointer(doc.root, "/a/missing")).toBeUndefined();
    expect(rangeAtPointer(doc, "/a/missing/deeper").start).toEqual({ line: 2, column: 3 });
  });
});

describe("parseJson (game semantics)", () => {
  it("accepts comments", () => {
    const d = parseJson('// head\n{ /* block */ "a": 1 }');
    expect(d.ok).toBe(true);
    expect(d.problems).toEqual([]);
    expect(d.value).toEqual({ a: 1 });
  });
  it("reports a missing comma as an error at its line/column and drops the value", () => {
    const d = parseJson('{\n  "a": 1\n  "b": 2\n}');
    expect(d.ok).toBe(false);
    expect(d.value).toBeUndefined();
    expect(d.problems).toMatchObject([{ severity: "error", code: "json.syntax", range: { start: { line: 3, column: 3 } } }]);
  });
  it("warns on what the game tolerates: trailing commas, duplicate keys, BOM, trailing content", () => {
    const d = parseJson('\uFEFF{"a": [1,], "a": 2} x');
    expect(d.ok).toBe(true);
    expect(d.problems.map((p) => [p.code, p.severity])).toEqual([
      ["json.bom", "warning"],
      ["json.trailing-comma", "warning"],
      ["json.duplicate-key", "warning"],
      ["json.trailing-content", "warning"],
    ]);
    expect(d.value).toEqual({ a: 2 });
  });
  it("treats an unclosed root as an error, not trailing content", () => {
    const d = parseJson('{"a": {"b": 1}');
    expect(d.ok).toBe(false);
    expect(d.problems[0]?.code).toBe("json.syntax");
  });
  it("rejects single quotes with a hint", () => {
    const d = parseJson("{'a': 1}");
    expect(d.ok).toBe(false);
    expect(d.problems[0]?.message).toContain("double quotes");
  });
});
