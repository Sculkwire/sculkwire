import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, FrameError } from "./framing.ts";
import { parseLocations, printToDiagnostic } from "./print.ts";
import { summarizeProfile } from "./profile.ts";

describe("debugger framing", () => {
  it("encodes 8 hex digits + newline, JSON, newline; length counts JSON + trailing newline", () => {
    const frame = encodeFrame({ type: "resume" });
    expect(frame.toString()).toBe('00000012\n{"type":"resume"}\n');
  });

  it("counts UTF-8 bytes, not characters", () => {
    const frame = encodeFrame({ m: "é" });
    const json = '{"m":"é"}';
    expect(frame.subarray(0, 9).toString()).toBe(`${(Buffer.byteLength(json) + 1).toString(16).padStart(8, "0")}\n`);
    expect(new FrameDecoder().push(frame)).toEqual([{ m: "é" }]);
  });

  it("decodes messages split across arbitrary chunk boundaries", () => {
    const msgs = [{ type: "event", event: { type: "PrintEvent", message: "a\nb", logLevel: 2 } }, { n: 1 }, { s: "ü".repeat(40) }];
    const wire = Buffer.concat(msgs.map(encodeFrame));
    for (const size of [1, 2, 3, 7, 9, 10, 64]) {
      const decoder = new FrameDecoder();
      const out: unknown[] = [];
      for (let i = 0; i < wire.byteLength; i += size) out.push(...decoder.push(wire.subarray(i, i + size)));
      expect(out).toEqual(msgs);
      expect(decoder.pending).toBe(0);
    }
  });

  it("decodes several messages merged into one chunk and keeps a trailing partial", () => {
    const a = encodeFrame({ a: 1 });
    const b = encodeFrame({ b: 2 });
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.concat([a, b, b.subarray(0, 5)]))).toEqual([{ a: 1 }, { b: 2 }]);
    expect(decoder.pending).toBe(5);
    expect(decoder.push(b.subarray(5))).toEqual([{ b: 2 }]);
  });

  it("rejects a malformed header", () => {
    expect(() => new FrameDecoder().push(Buffer.from("zzzzzzzz\n{}\n"))).toThrow(FrameError);
  });
});

describe("print parsing", () => {
  it("extracts script frames as Minecraft prints them", () => {
    expect(parseLocations("[Pack] Error: boom    at <anonymous> (main.js:7)")).toEqual([{ file: "main.js", line: 7 }]);
    expect(parseLocations("Error: x\n    at f (lib/util.js:12:5)\n    at <anonymous> (main.js:3)")).toEqual([
      { file: "lib/util.js", line: 12, column: 5 },
      { file: "main.js", line: 3 },
    ]);
    expect(parseLocations("sculkwire fixture: hello")).toEqual([]);
  });

  it("maps error prints to debugger diagnostics with file and line", () => {
    const d = printToDiagnostic(
      { level: "error", message: "[MCBE Fixture BP] Error: boom    at <anonymous> (main.js:7)", location: { file: "main.js", line: 7 } },
      (f) => `BP/scripts/${f}`,
    );
    expect(d).toMatchObject({ severity: "error", code: "script.error", source: "debugger", file: "BP/scripts/main.js", range: { start: { line: 7, column: 1 } } });
    expect(printToDiagnostic({ level: "warn", message: "careful" })).toMatchObject({ severity: "warning", code: "script.warning" });
    expect(printToDiagnostic({ level: "log", message: "Executing command [list]" })).toBeUndefined();
  });
});

describe("profile summary", () => {
  it("attributes sample time to self and subtree time to total", () => {
    const frame = (functionName: string, lineNumber: number) => ({ functionName, url: "main.js", lineNumber, columnNumber: 0 });
    const s = summarizeProfile({
      nodes: [
        { id: 1, callFrame: frame("(root)", -1), children: [2] },
        { id: 2, callFrame: frame("outer", 9), children: [3] },
        { id: 3, callFrame: frame("busyWork", 20) },
      ],
      startTime: 0,
      endTime: 4000,
      samples: [3, 3, 3, 2, 3],
      timeDeltas: [0, 1000, 1000, 1000, 1000],
    });
    expect(s.functions[0]).toMatchObject({ functionName: "busyWork", line: 20, selfMs: 3, totalMs: 3 });
    expect(s.functions[1]).toMatchObject({ functionName: "outer", selfMs: 1, totalMs: 4 });
  });

  it("places a native binding at the line of the script frame that called it", () => {
    // Recorded from BDS on src/runtime/bds/fixtures/gametest_pack: `test.succeed()` is on line 8 and `test.fail(...)` on
    // line 15 of scripts/main.js, but the capture gives the native frames the end of the calling function (10, 17).
    const frame = (functionName: string, lineNumber: number) => ({ functionName, url: "main.js", lineNumber, columnNumber: 0 });
    const s = summarizeProfile({
      nodes: [
        { id: 0, callFrame: frame("Test::succeed", 10), hitCount: 1 },
        { id: 1, callFrame: frame("<anonymous>", 8), hitCount: 1, children: [0] },
        { id: 2, callFrame: frame("Test::fail", 17), hitCount: 1 },
        { id: 3, callFrame: frame("<anonymous>", 15), hitCount: 1, children: [2] },
        { id: 4, callFrame: frame("busyWork", 24), hitCount: 299 },
        { id: 5, callFrame: frame("<anonymous>", 31), hitCount: 1, children: [4] },
      ],
      startTime: 0,
      endTime: 304_000,
    });
    const byName = new Map(s.functions.map((f) => [f.functionName, f]));
    expect(byName.get("Test::succeed")).toMatchObject({ line: 8, native: true });
    expect(byName.get("Test::fail")).toMatchObject({ line: 15, native: true });
    expect(byName.get("busyWork")).toMatchObject({ line: 24, native: false });
  });
});
