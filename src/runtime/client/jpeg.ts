/**
 * A baseline JPEG decoder for a world's own `world_icon.jpeg` (the picture the game shows as the world's thumbnail on
 * the Play screen), which the join recovery compares with the screenshot to find the world's tile (thumbnail.ts).
 *
 * Sequential Huffman JPEG only (SOF0 and SOF1, 8-bit samples), one component (grey) or three (YCbCr), any sampling
 * factors, interleaved or one scan per component, restart intervals. A progressive, arithmetic-coded or lossless file
 * is not decoded (undefined): the recovery then has no picture to match and leaves opening the world to the user.
 */
import type { Pixels } from "./png.ts";

/** Natural-order index of each zig-zag position. */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** `COS[x * 8 + u]` = C(u) cos((2x + 1) u pi / 16) / 2, the 1-D inverse DCT basis. */
const COS = Float64Array.from({ length: 64 }, (_, i) => {
  const x = Math.floor(i / 8);
  const u = i % 8;
  return ((u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2;
});

interface Huffman {
  /** Largest code of each length (1-16), -1 when none. */
  maxCode: Int32Array;
  /** Index into `values` of the first code of each length, minus that code. */
  offset: Int32Array;
  values: Uint8Array;
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxCode = new Int32Array(18).fill(-1);
  const offset = new Int32Array(18);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    const n = counts[length - 1] ?? 0;
    offset[length] = k - code;
    if (n > 0) maxCode[length] = code + n - 1;
    code = (code + n) << 1;
    k += n;
  }
  return { maxCode, offset, values };
}

interface Component {
  id: number;
  h: number;
  v: number;
  quant: number;
  /** Blocks per line and per column in the component's padded plane. */
  blocksWide: number;
  blocksHigh: number;
  plane: Uint8ClampedArray;
  dc: number;
  dcTable: number;
  acTable: number;
}

class Bits {
  readonly data: Uint8Array;
  #at: number;
  #buffer = 0;
  #count = 0;
  /** A marker ended the entropy-coded data: the rest reads as zero bits. */
  #marker = false;
  constructor(data: Uint8Array, at: number) {
    this.data = data;
    this.#at = at;
  }
  get at(): number {
    return this.#at;
  }
  bit(): number {
    if (this.#count === 0) {
      if (this.#marker || this.#at >= this.data.length) return 0;
      let byte = this.data[this.#at++] as number;
      if (byte === 0xff) {
        const next = this.data[this.#at] ?? 0;
        if (next === 0) this.#at++;
        else {
          this.#marker = true;
          this.#at--;
          return 0;
        }
        byte = 0xff;
      }
      this.#buffer = byte;
      this.#count = 8;
    }
    this.#count--;
    return (this.#buffer >> this.#count) & 1;
  }
  receive(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }
  decode(table: Huffman): number {
    let code = 0;
    for (let length = 1; length <= 16; length++) {
      code = (code << 1) | this.bit();
      if (code <= (table.maxCode[length] as number)) return table.values[code + (table.offset[length] as number)] as number;
    }
    throw new Error("bad Huffman code");
  }
  /** Skip to just after the next RSTn marker, dropping buffered bits. */
  restart(): void {
    this.#count = 0;
    this.#marker = false;
    while (this.#at + 1 < this.data.length) {
      if (this.data[this.#at] === 0xff && (this.data[this.#at + 1] as number) >= 0xd0 && (this.data[this.#at + 1] as number) <= 0xd7) {
        this.#at += 2;
        return;
      }
      this.#at++;
    }
  }
}

const extend = (v: number, n: number): number => (n === 0 ? 0 : v < 1 << (n - 1) ? v - (1 << n) + 1 : v);

/** Decode one 8x8 block into `out` (natural order, level-shifted samples). */
function readBlock(bits: Bits, c: Component, dc: Huffman, ac: Huffman, quant: Uint16Array, coef: Float64Array): void {
  coef.fill(0);
  const t = bits.decode(dc);
  c.dc += t === 0 ? 0 : extend(bits.receive(t), t);
  coef[0] = c.dc * (quant[0] as number);
  for (let k = 1; k < 64; ) {
    const rs = bits.decode(ac);
    const r = rs >> 4;
    const s = rs & 15;
    if (s === 0) {
      if (r !== 15) break;
      k += 16;
      continue;
    }
    k += r;
    if (k > 63) break;
    coef[ZIGZAG[k] as number] = extend(bits.receive(s), s) * (quant[k] as number);
    k++;
  }
}

/** Inverse DCT of `coef` into the component's plane at block column `bx`, row `by`. */
function storeBlock(c: Component, bx: number, by: number, coef: Float64Array, tmp: Float64Array): void {
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) sum += (COS[y * 8 + v] as number) * (coef[v * 8 + u] as number);
      tmp[y * 8 + u] = sum;
    }
  }
  const stride = c.blocksWide * 8;
  for (let y = 0; y < 8; y++) {
    const row = (by * 8 + y) * stride + bx * 8;
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) sum += (COS[x * 8 + u] as number) * (tmp[y * 8 + u] as number);
      c.plane[row + x] = Math.round(sum + 128);
    }
  }
}

function decode(data: Uint8Array): Pixels | undefined {
  if (data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  const quants: Uint16Array[] = [];
  const dcTables: Huffman[] = [];
  const acTables: Huffman[] = [];
  let components: Component[] = [];
  let width = 0;
  let height = 0;
  let hMax = 1;
  let vMax = 1;
  let restartInterval = 0;
  let at = 2;
  let scanned = false;
  while (at + 4 <= data.length) {
    if (data[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = data[at + 1] as number;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = ((data[at + 2] as number) << 8) | (data[at + 3] as number);
    const body = at + 4;
    const end = at + 2 + length;
    if (end > data.length) return undefined;
    if (marker === 0xdb) {
      for (let p = body; p < end; ) {
        const pq = (data[p] as number) >> 4;
        const id = (data[p] as number) & 15;
        p++;
        const table = new Uint16Array(64);
        for (let k = 0; k < 64; k++) {
          table[k] = pq ? ((data[p] as number) << 8) | (data[p + 1] as number) : (data[p] as number);
          p += pq ? 2 : 1;
        }
        quants[id] = table;
      }
    } else if (marker === 0xc4) {
      for (let p = body; p < end; ) {
        const kind = (data[p] as number) >> 4;
        const id = (data[p] as number) & 15;
        const counts = data.subarray(p + 1, p + 17);
        const total = counts.reduce((a, b) => a + b, 0);
        const table = buildHuffman(counts, data.subarray(p + 17, p + 17 + total));
        if (kind === 0) dcTables[id] = table;
        else acTables[id] = table;
        p += 17 + total;
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      if (data[body] !== 8) return undefined;
      height = ((data[body + 1] as number) << 8) | (data[body + 2] as number);
      width = ((data[body + 3] as number) << 8) | (data[body + 4] as number);
      const n = data[body + 5] as number;
      if ((n !== 1 && n !== 3) || width === 0 || height === 0) return undefined;
      components = [];
      for (let i = 0; i < n; i++) {
        const p = body + 6 + i * 3;
        const sampling = data[p + 1] as number;
        components.push({
          id: data[p] as number,
          h: sampling >> 4 || 1,
          v: sampling & 15 || 1,
          quant: data[p + 2] as number,
          blocksWide: 0,
          blocksHigh: 0,
          plane: new Uint8ClampedArray(0),
          dc: 0,
          dcTable: 0,
          acTable: 0,
        });
      }
      hMax = Math.max(...components.map((c) => c.h));
      vMax = Math.max(...components.map((c) => c.v));
      const mcusWide = Math.ceil(width / (8 * hMax));
      const mcusHigh = Math.ceil(height / (8 * vMax));
      for (const c of components) {
        c.blocksWide = mcusWide * c.h;
        c.blocksHigh = mcusHigh * c.v;
        c.plane = new Uint8ClampedArray(c.blocksWide * c.blocksHigh * 64);
      }
    } else if (marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // Progressive, lossless or arithmetic coding.
      return undefined;
    } else if (marker === 0xdd) {
      restartInterval = ((data[body] as number) << 8) | (data[body + 1] as number);
    } else if (marker === 0xda) {
      if (components.length === 0) return undefined;
      const n = data[body] as number;
      const scan: Component[] = [];
      for (let i = 0; i < n; i++) {
        const c = components.find((x) => x.id === data[body + 1 + i * 2]);
        if (!c) return undefined;
        const tables = data[body + 2 + i * 2] as number;
        c.dcTable = tables >> 4;
        c.acTable = tables & 15;
        c.dc = 0;
        scan.push(c);
      }
      const bits = new Bits(data, end);
      const coef = new Float64Array(64);
      const tmp = new Float64Array(64);
      const block = (c: Component, bx: number, by: number) => {
        const dc = dcTables[c.dcTable];
        const ac = acTables[c.acTable];
        const quant = quants[c.quant];
        if (!dc || !ac || !quant) throw new Error("missing table");
        readBlock(bits, c, dc, ac, quant, coef);
        storeBlock(c, bx, by, coef, tmp);
      };
      let units = 0;
      const nextUnit = () => {
        if (restartInterval > 0 && units > 0 && units % restartInterval === 0) {
          bits.restart();
          for (const c of scan) c.dc = 0;
        }
        units++;
      };
      if (scan.length === 1) {
        const c = scan[0] as Component;
        const wide = Math.ceil(Math.ceil((width * c.h) / hMax) / 8);
        const high = Math.ceil(Math.ceil((height * c.v) / vMax) / 8);
        for (let by = 0; by < high; by++) {
          for (let bx = 0; bx < wide; bx++) {
            nextUnit();
            block(c, bx, by);
          }
        }
      } else {
        const mcusWide = Math.ceil(width / (8 * hMax));
        const mcusHigh = Math.ceil(height / (8 * vMax));
        for (let my = 0; my < mcusHigh; my++) {
          for (let mx = 0; mx < mcusWide; mx++) {
            nextUnit();
            for (const c of scan) {
              for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) block(c, mx * c.h + h, my * c.v + v);
            }
          }
        }
      }
      scanned = true;
      at = bits.at;
      continue;
    }
    at = end;
  }
  if (!scanned) return undefined;
  const out = new Uint8Array(width * height * 3);
  const sample = (c: Component, x: number, y: number) =>
    c.plane[Math.floor((y * c.v) / vMax) * c.blocksWide * 8 + Math.floor((x * c.h) / hMax)] as number;
  const [first, second, third] = components as [Component, Component?, Component?];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const luma = sample(first, x, y);
      if (!second || !third) {
        out[o] = out[o + 1] = out[o + 2] = luma;
        continue;
      }
      const cb = sample(second, x, y) - 128;
      const cr = sample(third, x, y) - 128;
      out[o] = clamp(luma + 1.402 * cr);
      out[o + 1] = clamp(luma - 0.344136 * cb - 0.714136 * cr);
      out[o + 2] = clamp(luma + 1.772 * cb);
    }
  }
  return { width, height, channels: 3, data: out };
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Decode a baseline JPEG to 8-bit RGB, or undefined for a file this decoder does not read (see the module comment). */
export function decodeJpeg(data: Uint8Array): Pixels | undefined {
  try {
    return decode(data);
  } catch {
    return undefined;
  }
}
