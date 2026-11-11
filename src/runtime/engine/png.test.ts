import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { recompressPng, recompressPngFile } from "./png.ts";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Scanlines of a 64x64 RGBA image of 16x16 tiles, each with filter byte 0. */
function pixels(): Buffer {
  const width = 64;
  const raw = Buffer.alloc(64 * (1 + width * 4));
  for (let y = 0; y < 64; y++) {
    const row = y * (1 + width * 4);
    for (let x = 0; x < width; x++) raw.set([(x >> 4) * 60, (y >> 4) * 60, 128, 255], row + 1 + x * 4);
  }
  return raw;
}

/** A PNG as the agent writes it: stored deflate, split over two IDAT chunks, with a text chunk to keep. */
function png(level: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const stream = deflateSync(pixels(), { level });
  const half = stream.length >> 1;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from("Software\0sculkwire", "latin1")),
    chunk("IDAT", stream.subarray(0, half)),
    chunk("IDAT", stream.subarray(half)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function parse(file: Buffer): { type: string; data: Buffer; crcOk: boolean }[] {
  const out = [];
  let at = 8;
  while (at < file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString("latin1", at + 4, at + 8);
    const crcOk = file.readUInt32BE(at + 8 + length) === crc32(file.subarray(at + 4, at + 8 + length));
    out.push({ type, data: file.subarray(at + 8, at + 8 + length), crcOk });
    at += 12 + length;
  }
  return out;
}

describe("recompressPng", () => {
  it("deflates a stored PNG into one IDAT with the same pixels and keeps the other chunks", () => {
    const stored = png(0);
    const out = recompressPng(stored);
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThan(stored.length / 2);
    expect(out!.subarray(0, 8).equals(SIGNATURE)).toBe(true);
    const parsed = parse(out!);
    expect(parsed.map((c) => c.type)).toEqual(["IHDR", "tEXt", "IDAT", "IEND"]);
    expect(parsed.every((c) => c.crcOk)).toBe(true);
    expect(parsed[1]!.data.toString("latin1")).toBe("Software\0sculkwire");
    expect(inflateSync(parsed[2]!.data).equals(pixels())).toBe(true);
  });

  it("leaves an already compressed PNG alone", () => {
    expect(recompressPng(png(9))).toBeUndefined();
  });

  it("leaves a JPEG and a truncated PNG alone", () => {
    expect(recompressPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 0xff, 0xd9]))).toBeUndefined();
    expect(recompressPng(png(0).subarray(0, 60))).toBeUndefined();
  });
});

describe("recompressPngFile", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("rewrites a stored PNG in place and leaves a JPEG untouched", async () => {
    dir = await mkdtemp(join(tmpdir(), "sculkwire-png-"));
    const pngPath = join(dir, "shot.png");
    const jpegPath = join(dir, "shot.jpg");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 0xff, 0xd9]);
    await writeFile(pngPath, png(0));
    await writeFile(jpegPath, jpeg);
    expect(await recompressPngFile(pngPath)).toBe(true);
    expect(await recompressPngFile(jpegPath)).toBe(false);
    expect((await readFile(jpegPath)).equals(jpeg)).toBe(true);
    const idat = parse(await readFile(pngPath)).find((c) => c.type === "IDAT")!;
    expect(inflateSync(idat.data).equals(pixels())).toBe(true);
  });
});
