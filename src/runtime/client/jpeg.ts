/**
 * A baseline JPEG encoder for pictures made of flat 8x8 blocks, which is all sculkwire draws (the world icon in
 * icon.ts). A flat block has only a DC coefficient, so each block of each component is its DC difference and an
 * end-of-block code: no DCT, no image dependency. YCbCr without subsampling, one quantisation table of ones (the DC
 * value survives exactly), and the standard Huffman tables of the JPEG specification (Annex K.3).
 */

export type Rgb = readonly [number, number, number];

export interface HuffmanSpec {
  /** Number of codes of each length 1..16. */
  bits: readonly number[];
  /** Symbols in code order. */
  values: readonly number[];
}

/** Every AC symbol (run << 4 | size, plus EOB 0x00 and ZRL 0xf0) after `head`, in ascending order as Annex K lists them. */
function acValues(head: readonly number[]): number[] {
  const all = [0x00, 0xf0];
  for (let run = 0; run < 16; run++) for (let size = 1; size <= 10; size++) all.push((run << 4) | size);
  const rest = all.filter((v) => !head.includes(v)).sort((a, b) => a - b);
  return [...head, ...rest];
}

const DC_VALUES = Array.from({ length: 12 }, (_, i) => i);

export const DC_LUMINANCE: HuffmanSpec = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], values: DC_VALUES };
export const DC_CHROMINANCE: HuffmanSpec = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], values: DC_VALUES };
export const AC_LUMINANCE: HuffmanSpec = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  values: acValues([
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82,
  ]),
};
export const AC_CHROMINANCE: HuffmanSpec = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  values: acValues([
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
    0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1,
  ]),
};

export interface HuffmanCode {
  code: number;
  length: number;
}

/** The canonical codes of a table (Annex C), by symbol. */
export function huffmanCodes(spec: HuffmanSpec): Map<number, HuffmanCode> {
  const codes = new Map<number, HuffmanCode>();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < (spec.bits[length - 1] ?? 0); i++) codes.set(spec.values[k++] as number, { code: code++, length });
    code <<= 1;
  }
  return codes;
}

/** Entropy-coded bits, with a 0x00 stuffed after every 0xff byte. */
class BitWriter {
  readonly bytes: number[] = [];
  #acc = 0;
  #n = 0;
  write(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.#acc = (this.#acc << 1) | ((value >> i) & 1);
      if (++this.#n === 8) this.#flushByte();
    }
  }
  #flushByte(): void {
    this.bytes.push(this.#acc);
    if (this.#acc === 0xff) this.bytes.push(0);
    this.#acc = 0;
    this.#n = 0;
  }
  /** Pad the last byte with ones. */
  end(): void {
    while (this.#n !== 0) this.write(1, 1);
  }
}

function segment(marker: number, body: readonly number[]): number[] {
  const length = body.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...body];
}

/** JFIF's RGB to YCbCr. */
export function toYCbCr([r, g, b]: Rgb): [number, number, number] {
  return [0.299 * r + 0.587 * g + 0.114 * b, -0.168736 * r - 0.331264 * g + 0.5 * b + 128, 0.5 * r - 0.418688 * g - 0.081312 * b + 128];
}

/** Bit length of |v| (the JPEG magnitude category). */
function category(v: number): number {
  let a = Math.abs(v);
  let n = 0;
  while (a > 0) {
    n++;
    a >>= 1;
  }
  return n;
}

/**
 * Encode a `width` x `height` picture (both multiples of 8) whose 8x8 block at block column `bx`, row `by` is the flat
 * colour `block(bx, by)`.
 */
export function encodeFlatJpeg(width: number, height: number, block: (bx: number, by: number) => Rgb): Buffer {
  if (width <= 0 || height <= 0 || width % 8 || height % 8 || width > 0xffff || height > 0xffff) {
    throw new Error(`a flat-block JPEG needs a size in multiples of 8 up to 65535, not ${width}x${height}`);
  }
  const tables: [number, HuffmanSpec][] = [
    [0x00, DC_LUMINANCE],
    [0x10, AC_LUMINANCE],
    [0x01, DC_CHROMINANCE],
    [0x11, AC_CHROMINANCE],
  ];
  const dc = [huffmanCodes(DC_LUMINANCE), huffmanCodes(DC_CHROMINANCE), huffmanCodes(DC_CHROMINANCE)];
  const eob = [huffmanCodes(AC_LUMINANCE).get(0), huffmanCodes(AC_CHROMINANCE).get(0), huffmanCodes(AC_CHROMINANCE).get(0)] as HuffmanCode[];
  const bits = new BitWriter();
  const previous = [0, 0, 0];
  for (let by = 0; by < height / 8; by++) {
    for (let bx = 0; bx < width / 8; bx++) {
      const ycc = toYCbCr(block(bx, by));
      for (let c = 0; c < 3; c++) {
        // A flat block's DC coefficient is 8 times its level-shifted sample; with a quantiser of 1 it stays exact.
        const level = Math.min(255, Math.max(0, Math.round(ycc[c] as number)));
        const coefficient = 8 * (level - 128);
        const diff = coefficient - (previous[c] as number);
        previous[c] = coefficient;
        const size = category(diff);
        const code = dc[c]?.get(size) as HuffmanCode;
        bits.write(code.code, code.length);
        if (size > 0) bits.write(diff > 0 ? diff : diff + (1 << size) - 1, size);
        const end = eob[c] as HuffmanCode;
        bits.write(end.code, end.length);
      }
    }
  }
  bits.end();
  const jfif = [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const dqt = [0x00, ...new Array<number>(64).fill(1)];
  const sof = [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0];
  const dht = tables.flatMap(([id, spec]) => [id, ...spec.bits, ...spec.values]);
  const sos = [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0];
  return Buffer.from([
    0xff,
    0xd8,
    ...segment(0xe0, jfif),
    ...segment(0xdb, dqt),
    ...segment(0xc0, sof),
    ...segment(0xc4, dht),
    ...segment(0xda, sos),
    ...bits.bytes,
    0xff,
    0xd9,
  ]);
}
