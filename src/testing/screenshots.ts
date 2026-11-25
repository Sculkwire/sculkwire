/**
 * Synthetic game screenshots for the join recovery's tests: a flat RGB frame, made-up world thumbnails drawn into it
 * the way the game shows one (scaled with bilinear filtering, optionally darkened), and the PNG the screenshot routes
 * return.
 */
import { crc32, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { Rect } from "../runtime/client/thumbnail.ts";
import type { Pixels } from "../runtime/client/png.ts";

/** A `width` x `height` RGB frame of one grey (the Play screen's dark background by default). */
export function frame(width: number, height: number, grey = 49): Pixels {
  return { width, height, channels: 3, data: new Uint8Array(width * height * 3).fill(grey) };
}

/** Fill a rectangle with one colour. */
export function fill(image: Pixels, rect: Rect, colour: readonly [number, number, number]): void {
  for (let y = Math.max(0, Math.round(rect.y)); y < Math.min(image.height, Math.round(rect.y + rect.height)); y++) {
    for (let x = Math.max(0, Math.round(rect.x)); x < Math.min(image.width, Math.round(rect.x + rect.width)); x++) {
      const at = (y * image.width + x) * 3;
      image.data[at] = colour[0];
      image.data[at + 1] = colour[1];
      image.data[at + 2] = colour[2];
    }
  }
}

/**
 * A made-up world thumbnail for `seed`: a soft colour gradient with a few discs and bars placed and coloured by a hash
 * of the seed, so every seed gives a picture no other seed matches.
 */
export function testPicture(seed: string, width = 160, height = 90): Pixels {
  const hash = createHash("sha256").update(seed).digest();
  const byte = (i: number) => hash[i % hash.length] as number;
  const image = frame(width, height, 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      image.data[at] = (byte(0) + (x * byte(1)) / width) % 256;
      image.data[at + 1] = (byte(2) + (y * byte(3)) / height) % 256;
      image.data[at + 2] = (byte(4) + ((x + y) * byte(5)) / (width + height)) % 256;
    }
  }
  for (let k = 0; k < 6; k++) {
    const cx = (byte(6 + k * 5) / 255) * width;
    const cy = (byte(7 + k * 5) / 255) * height;
    const r = (0.1 + (byte(8 + k * 5) / 255) * 0.25) * height;
    const colour = [byte(9 + k * 5), byte(10 + k * 5), byte(11 + k * 5)] as const;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const inside = k % 2 === 0 ? (x - cx) ** 2 + (y - cy) ** 2 < r * r : Math.abs(x - cx) < r * 1.6 && Math.abs(y - cy) < r * 0.5;
        if (!inside) continue;
        const at = (y * width + x) * 3;
        image.data.set(colour, at);
      }
    }
  }
  return image;
}

/** Draw `picture` into `rect`, bilinearly filtered, times `light` (1 = as drawn): a thumbnail as the game shows it. */
export function drawPicture(image: Pixels, rect: Rect, picture: Pixels, light = 1): void {
  const at = (x: number, y: number) => {
    const o = (Math.min(picture.height - 1, Math.max(0, y)) * picture.width + Math.min(picture.width - 1, Math.max(0, x))) * picture.channels;
    return [picture.data[o] ?? 0, picture.data[o + 1] ?? 0, picture.data[o + 2] ?? 0];
  };
  for (let y = Math.round(rect.y); y < Math.round(rect.y + rect.height); y++) {
    if (y < 0 || y >= image.height) continue;
    for (let x = Math.round(rect.x); x < Math.round(rect.x + rect.width); x++) {
      if (x < 0 || x >= image.width) continue;
      const u = ((x - rect.x + 0.5) / rect.width) * picture.width - 0.5;
      const v = ((y - rect.y + 0.5) / rect.height) * picture.height - 0.5;
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const fx = u - x0;
      const fy = v - y0;
      const [a, b, c, d] = [at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1)];
      const out = (y * image.width + x) * 3;
      for (let k = 0; k < 3; k++) {
        const top = (a[k] as number) * (1 - fx) + (b[k] as number) * fx;
        const bottom = (c[k] as number) * (1 - fx) + (d[k] as number) * fx;
        image.data[out + k] = Math.round((top * (1 - fy) + bottom * fy) * light);
      }
    }
  }
}

/** The frame as an 8-bit RGB PNG, rows with filter 1 (Sub) so the decoder's filters are exercised. */
export function png(image: Pixels): Buffer {
  const { width, height } = image;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 1;
    for (let i = 0; i < width * 3; i++) {
      const left = i >= 3 ? (image.data[y * width * 3 + i - 3] ?? 0) : 0;
      raw[y * (width * 3 + 1) + 1 + i] = ((image.data[y * width * 3 + i] ?? 0) - left) & 0xff;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
