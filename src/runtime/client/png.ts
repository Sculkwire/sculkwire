/** The PNG reading the screen recovery needs: a frame's size, and its pixels for icon and tile matching. */
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

/** A decoded 8-bit RGB or RGBA PNG. */
export interface Pixels {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

/** Decode a non-interlaced 8-bit RGB/RGBA PNG (what gamescope and PrintWindow write), or undefined for anything else. */
export function decodePng(png: Buffer): Pixels | undefined {
  const size = pngSize(png);
  if (!size) return undefined;
  const depth = png[24];
  const color = png[25];
  const interlace = png[28];
  const channels = color === 2 ? 3 : color === 6 ? 4 : 0;
  if (depth !== 8 || !channels || interlace !== 0) return undefined;
  const parts: Buffer[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") parts.push(png.subarray(at + 8, at + 8 + length));
    if (type === "IEND") break;
    at += 12 + length;
  }
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(parts));
  } catch {
    return undefined;
  }
  const stride = size.width * channels;
  if (raw.length < (stride + 1) * size.height) return undefined;
  const data = new Uint8Array(stride * size.height);
  for (let y = 0; y < size.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= channels ? (data[line + i - channels] ?? 0) : 0;
      const b = y > 0 ? (data[line - stride + i] ?? 0) : 0;
      const c = i >= channels && y > 0 ? (data[line - stride + i - channels] ?? 0) : 0;
      let v = x;
      if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      data[line + i] = v & 0xff;
    }
  }
  return { ...size, channels, data };
}

/** Width and height of a PNG from its header. */
export function pngSize(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < 24 || png.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Read a screenshot file for `RecoveryIO.screenshot`. */
export async function readShot(path: string): Promise<{ path: string; png: Buffer }> {
  return { path, png: await readFile(path) };
}
