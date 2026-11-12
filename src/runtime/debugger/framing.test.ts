import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, FrameError } from "./framing.ts";

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
