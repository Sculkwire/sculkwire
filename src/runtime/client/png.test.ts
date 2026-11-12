import { describe, expect, it } from "vitest";
import { frame, png } from "../../testing/screenshots.ts";
import { decodePng, pngSize } from "./png.ts";

describe("PNG", () => {
  it("reads PNG sizes", () => {
    const png = Buffer.alloc(24);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1280, 16);
    png.writeUInt32BE(668, 20);
    expect(pngSize(png)).toEqual({ width: 1280, height: 668 });
    expect(pngSize(Buffer.alloc(8))).toBeUndefined();
  });

  it("decodes the 8-bit RGB frames screenshots write, and nothing else", () => {
    const image = frame(4, 3, 49);
    expect(decodePng(png(image))).toEqual(image);
    expect(decodePng(Buffer.alloc(8))).toBeUndefined();
  });
});
