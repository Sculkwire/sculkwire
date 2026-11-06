import { describe, expect, it } from "vitest";
import { BRARCHIVE_MAGIC, BrarchiveError, buildBrarchive, isBrarchive, parseBrarchive } from "./brarchive.ts";

const enc = (s: string): Buffer => Buffer.from(s, "utf8");

describe("brarchive", () => {
  it("parses a synthetic archive byte-for-byte at the documented offsets", () => {
    const buf = buildBrarchive([
      { name: "agent.json", data: enc('{"format_version":"1.26.0"}') },
      { name: "empty.ogg", data: new Uint8Array(0) },
      { name: "allay.json", data: enc("{}") },
    ]);
    expect(buf.readBigUInt64LE(0)).toBe(BRARCHIVE_MAGIC);
    expect(buf.readUInt32LE(8)).toBe(3);
    expect(buf.readUInt32LE(12)).toBe(1);
    // entry 2: name length byte, name, then offset/size at +248/+252 relative to the blob after the table
    expect(buf[16 + 2 * 256]).toBe("allay.json".length);
    expect(buf.readUInt32LE(16 + 2 * 256 + 248)).toBe(27);
    expect(buf.readUInt32LE(16 + 2 * 256 + 252)).toBe(2);
    const entries = parseBrarchive(buf);
    expect(entries.map((e) => [e.name, e.data.toString("utf8")])).toEqual([
      ["agent.json", '{"format_version":"1.26.0"}'],
      ["empty.ogg", ""],
      ["allay.json", "{}"],
    ]);
  });

  it("accepts an empty archive", () => {
    expect(parseBrarchive(buildBrarchive([]))).toEqual([]);
  });

  it("rejects non-brarchive data such as encrypted packs", () => {
    const random = Buffer.from("bda343222f85ae13bca9940e9313c49bc0c15078630ba7735fd115a0fc863494", "hex");
    expect(isBrarchive(random)).toBe(false);
    expect(() => parseBrarchive(random)).toThrowError(expect.objectContaining({ reason: "not-brarchive" }));
  });

  it("rejects unknown versions, truncated tables and out-of-range data", () => {
    const good = buildBrarchive([{ name: "a.json", data: enc("12345") }]);
    const v2 = Buffer.from(good);
    v2.writeUInt32LE(2, 12);
    expect(() => parseBrarchive(v2)).toThrowError(expect.objectContaining({ reason: "unsupported-version" }));
    expect(() => parseBrarchive(good.subarray(0, 100))).toThrowError(expect.objectContaining({ reason: "truncated" }));
    expect(() => parseBrarchive(good.subarray(0, good.length - 1))).toThrowError(BrarchiveError);
  });

  it("rejects path traversal in entry names", () => {
    const bad = buildBrarchive([{ name: "../escape.json", data: enc("{}") }]);
    expect(() => parseBrarchive(bad)).toThrowError(expect.objectContaining({ reason: "bad-entry" }));
  });
});
