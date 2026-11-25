import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testPicture } from "../../testing/screenshots.ts";
import { decodeJpeg } from "./jpeg.ts";

/** Made-up pictures (`testPicture("jpeg fixture", 48, 27)`) saved as JPEG by another encoder. */
const FIXTURES = join(import.meta.dirname, "..", "..", "..", "test", "fixtures", "jpeg");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

/** Mean absolute difference per channel from the picture the fixtures were made of (grey: from its luma). */
function difference(name: string, grey = false): number {
  const decoded = decodeJpeg(fixture(name));
  const want = testPicture("jpeg fixture", 48, 27);
  expect(decoded).toMatchObject({ width: 48, height: 27, channels: 3 });
  let sum = 0;
  for (let i = 0; i < 48 * 27; i++) {
    const [r, g, b] = [want.data[i * 3] ?? 0, want.data[i * 3 + 1] ?? 0, want.data[i * 3 + 2] ?? 0];
    for (let c = 0; c < 3; c++) {
      const expected = grey ? 0.299 * r + 0.587 * g + 0.114 * b : [r, g, b][c] ?? 0;
      sum += Math.abs((decoded?.data[i * 3 + c] ?? 0) - expected);
    }
  }
  return sum / (48 * 27 * 3);
}

describe("decodeJpeg", () => {
  it("decodes baseline files with and without chroma subsampling and with restart markers", () => {
    expect(difference("sub444.jpg")).toBeLessThan(4);
    expect(difference("sub420-restarts.jpg")).toBeLessThan(12);
    expect(difference("grey.jpg", true)).toBeLessThan(4);
  });

  it("leaves progressive files and what is not a JPEG undecoded", () => {
    expect(decodeJpeg(fixture("progressive.jpg"))).toBeUndefined();
    expect(decodeJpeg(Buffer.from("not a picture"))).toBeUndefined();
    expect(decodeJpeg(fixture("sub444.jpg").subarray(0, 200))).toBeUndefined();
  });
});
