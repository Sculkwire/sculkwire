import { describe, expect, it } from "vitest";
import { drawIcon, fill, frame, png } from "../../testing/screenshots.ts";
import { findIcons, findIconTile, ICON_HEIGHT, ICON_PALETTE, ICON_WIDTH, iconCells, iconPixel, worldIcon, type Rect } from "./icon.ts";
import { AC_CHROMINANCE, AC_LUMINANCE, DC_LUMINANCE, encodeFlatJpeg, huffmanCodes, type HuffmanSpec, type Rgb } from "./jpeg.ts";
import { decodePng, type Pixels } from "./png.ts";
import { LAYOUT } from "./screens.ts";

/** Markers in file order, up to and including SOS (the entropy-coded data follows it). */
function markers(jpeg: Buffer): number[] {
  const out: number[] = [];
  let at = 2;
  for (;;) {
    expect(jpeg[at]).toBe(0xff);
    const marker = jpeg[at + 1] as number;
    out.push(marker);
    if (marker === 0xda) return out;
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
}

/**
 * A decoder for exactly what the encoder writes: baseline, three components without subsampling, every block flat
 * (a DC difference, then end-of-block). Returns each block's RGB in reading order.
 */
function decodeFlat(jpeg: Buffer): { width: number; height: number; blocks: Rgb[] } {
  expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
  const tables = new Map<number, Map<string, number>>();
  let quant = 1;
  let width = 0;
  let height = 0;
  let selectors: [number, number][] = [];
  let at = 2;
  for (;;) {
    const marker = jpeg[at + 1] as number;
    const length = jpeg.readUInt16BE(at + 2);
    const body = jpeg.subarray(at + 4, at + 2 + length);
    if (marker === 0xdb) quant = body[1] as number;
    if (marker === 0xc0) {
      height = body.readUInt16BE(1);
      width = body.readUInt16BE(3);
      expect(body[5]).toBe(3);
    }
    if (marker === 0xc4) {
      for (let p = 0; p < body.length; ) {
        const id = body[p] as number;
        const bits = [...body.subarray(p + 1, p + 17)];
        const count = bits.reduce((a, b) => a + b, 0);
        const values = [...body.subarray(p + 17, p + 17 + count)];
        const codes = new Map<string, number>();
        for (const [symbol, code] of huffmanCodes({ bits, values })) codes.set(`${code.length}:${code.code}`, symbol);
        tables.set(id, codes);
        p += 17 + count;
      }
    }
    at += 2 + length;
    if (marker === 0xda) {
      selectors = [0, 1, 2].map((c) => [(body[2 + c * 2] as number) >> 4, (body[2 + c * 2] as number) & 15]);
      break;
    }
  }
  const data: number[] = [];
  for (let p = at; p < jpeg.length - 2; p++) {
    data.push(jpeg[p] as number);
    if (jpeg[p] === 0xff) {
      expect(jpeg[p + 1]).toBe(0);
      p++;
    }
  }
  expect([jpeg.at(-2), jpeg.at(-1)]).toEqual([0xff, 0xd9]);
  let bit = 0;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | (((data[bit >> 3] as number) >> (7 - (bit & 7))) & 1);
    return v;
  };
  const symbol = (codes: Map<string, number>) => {
    let code = 0;
    for (let length = 1; length <= 16; length++) {
      code = (code << 1) | read(1);
      const s = codes.get(`${length}:${code}`);
      if (s !== undefined) return s;
    }
    throw new Error("bad code");
  };
  const previous = [0, 0, 0];
  const blocks: Rgb[] = [];
  for (let b = 0; b < (width / 8) * (height / 8); b++) {
    const ycc = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const [dc, ac] = selectors[c] as [number, number];
      const size = symbol(tables.get(dc) as Map<string, number>);
      const raw = size ? read(size) : 0;
      const diff = size && raw < 1 << (size - 1) ? raw - ((1 << size) - 1) : raw;
      previous[c] = (previous[c] as number) + diff;
      expect(symbol(tables.get(0x10 | ac) as Map<string, number>)).toBe(0x00);
      ycc[c] = ((previous[c] as number) * quant) / 8 + 128;
    }
    const [y, cb, cr] = ycc as [number, number, number];
    blocks.push([y + 1.402 * (cr - 128), y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128), y + 1.772 * (cb - 128)]);
  }
  return { width, height, blocks };
}

describe("flat-block JPEG encoder", () => {
  it("writes a baseline JFIF with the segments in order and the size in SOF0", () => {
    const jpeg = encodeFlatJpeg(16, 8, (bx) => (bx === 0 ? [255, 0, 0] : [0, 0, 255]));
    expect(markers(jpeg)).toEqual([0xe0, 0xdb, 0xc0, 0xc4, 0xda]);
    expect(jpeg.toString("ascii", 6, 10)).toBe("JFIF");
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    expect(jpeg.readUInt16BE(sof + 5)).toBe(8);
    expect(jpeg.readUInt16BE(sof + 7)).toBe(16);
    expect([jpeg.at(-2), jpeg.at(-1)]).toEqual([0xff, 0xd9]);
    expect(() => encodeFlatJpeg(10, 8, () => [0, 0, 0])).toThrow(/multiples of 8/);
  });

  it("uses the standard Huffman tables", () => {
    const check = (spec: HuffmanSpec, count: number) => {
      expect(spec.bits.reduce((a, b) => a + b, 0)).toBe(count);
      expect(new Set(spec.values).size).toBe(count);
    };
    check(DC_LUMINANCE, 12);
    check(AC_LUMINANCE, 162);
    check(AC_CHROMINANCE, 162);
    // Annex K: luminance EOB is 1010, chrominance EOB 00, luminance DC category 0 is 00 and category 1 is 010.
    expect(huffmanCodes(AC_LUMINANCE).get(0)).toEqual({ code: 0b1010, length: 4 });
    expect(huffmanCodes(AC_CHROMINANCE).get(0)).toEqual({ code: 0, length: 2 });
    expect(huffmanCodes(DC_LUMINANCE).get(0)).toEqual({ code: 0, length: 2 });
    expect(huffmanCodes(DC_LUMINANCE).get(1)).toEqual({ code: 0b010, length: 3 });
    expect(AC_LUMINANCE.values.slice(37, 42)).toEqual([0x09, 0x0a, 0x16, 0x17, 0x18]);
  });

  it("decodes back to the colours it was given", () => {
    const colours: Rgb[] = [[255, 255, 255], [0, 0, 0], ...ICON_PALETTE, [0, 190, 160]];
    const jpeg = encodeFlatJpeg(8 * colours.length, 8, (bx) => colours[bx] as Rgb);
    const decoded = decodeFlat(jpeg);
    expect(decoded.blocks).toHaveLength(colours.length);
    decoded.blocks.forEach((rgb, i) => rgb.forEach((v, k) => expect(Math.abs(v - ((colours[i] as Rgb)[k] as number))).toBeLessThan(3)));
  });
});

describe("world icon", () => {
  it("gives two level ids different cells, the same id the same cells", () => {
    expect(iconCells("sculkwire-bench")).toEqual(iconCells("sculkwire-bench"));
    expect(iconCells("sculkwire-bench")).not.toEqual(iconCells("sculkwire-bridge"));
    expect(iconCells("sculkwire-bench")).toHaveLength(8);
  });

  it("writes a 256x144 JPEG of the ring and the cells", () => {
    const decoded = decodeFlat(worldIcon("sculkwire-bench"));
    expect([decoded.width, decoded.height]).toEqual([ICON_WIDTH, ICON_HEIGHT]);
    const cells = iconCells("sculkwire-bench");
    decoded.blocks.forEach((rgb, i) => {
      const want = iconPixel(cells, (i % (ICON_WIDTH / 8)) * 8, Math.floor(i / (ICON_WIDTH / 8)) * 8);
      rgb.forEach((v, k) => expect(Math.abs(v - (want[k] as number))).toBeLessThan(3));
    });
  });
});

/** The thumbnail of a Play-screen tile: `scale` of the frame's width, 16:9, centred on the tile. */
function thumb(width: number, height: number, slot: number, scale = 0.2): Rect {
  const w = width * scale;
  const h = (w * 9) / 16;
  const c = LAYOUT.worldTile(slot);
  return { x: c.x * width - w / 2, y: c.y * height - h / 2, width: w, height: h };
}

/**
 * Draw a tile's thumbnail as the retail Play screen does: a 4 px frame of (30,30,31) around it, the picture, and the
 * dark "Creative" badge over its bottom-left corner (with a yellow "Experimental" one beside it when asked), which
 * hides the left part of the ring's bottom row and the bottom of its left column.
 */
function tile(image: Pixels, r: Rect, id: string | undefined, opts: { light?: number; experimental?: boolean } = {}): void {
  fill(image, { x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 }, [30, 30, 31]);
  if (id === "LAN") fill(image, r, [30, 90, 160]);
  else if (id) drawIcon(image, r, id, opts.light);
  const badge = { x: r.x, y: r.y + r.height * 0.865, width: r.width * 0.28, height: r.height * 0.135 };
  fill(image, badge, [49, 50, 51]);
  for (let i = 0; i < 6; i++) fill(image, { x: badge.x + 6 + i * badge.width * 0.15, y: badge.y + 8, width: 3, height: badge.height - 16 }, [255, 255, 255]);
  if (opts.experimental) fill(image, { x: badge.x + badge.width, y: badge.y, width: r.width * 0.33, height: badge.height }, [250, 230, 60]);
}

/** A Play screen with these tiles in the 4-column layout: a level id gets its icon, `LAN` a featured server's picture. */
function playScreen(width: number, height: number, tiles: (string | undefined)[], opts: { scale?: number; light?: number } = {}): Pixels {
  const image = frame(width, height);
  tiles.forEach((id, slot) => {
    const r = thumb(width, height, slot, opts.scale);
    fill(image, { x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height * 1.5 }, [72, 73, 74]);
    tile(image, r, id, { ...(opts.light !== undefined ? { light: opts.light } : {}) });
  });
  return decodePng(png(image)) as Pixels;
}

/** The retail Play screen at 1920x1080: 3 tiles across of 574x322, the tab strip covering everything above y 208. */
function retailThumb(slot: number, scrolled: number): Rect {
  return { x: 44 + (slot % 3) * 613, y: 210 + Math.floor(slot / 3) * 490 - scrolled, width: 573, height: 322 };
}

function retailScreen(tiles: (string | undefined)[], scrolled = 0, experimental: number[] = []): Pixels {
  const image = frame(1920, 1080, 60);
  tiles.forEach((id, slot) => tile(image, retailThumb(slot, scrolled), id, { experimental: experimental.includes(slot) }));
  fill(image, { x: 0, y: 0, width: 1920, height: 95 }, [230, 230, 230]);
  fill(image, { x: 0, y: 95, width: 1920, height: 113 }, [49, 50, 51]);
  return decodePng(png(image)) as Pixels;
}

const near = (a: Rect | undefined, b: Rect) => {
  expect(a).toBeDefined();
  const r = a as Rect;
  expect(Math.abs(r.x - b.x)).toBeLessThan(3);
  expect(Math.abs(r.y - b.y)).toBeLessThan(3);
  expect(Math.abs(r.width - b.width)).toBeLessThan(4);
  expect(Math.abs(r.height - b.height)).toBeLessThan(4);
};

describe("finding the world's tile by its icon", () => {
  const bench = iconCells("sculkwire-bench");

  it("finds the tile first in the list at 1280x720, under its Creative badge", () => {
    const match = findIconTile(playScreen(1280, 720, ["sculkwire-bench", "sculkwire-a"]), bench);
    near(match?.rect, thumb(1280, 720, 0));
    expect(match).toMatchObject({ whole: true, visibleCells: 8 });
  });

  it("finds it in another slot and in the second row at 1920x1080", () => {
    near(findIconTile(playScreen(1920, 1080, ["LAN", "LAN", "sculkwire-a", "sculkwire-bench"]), bench)?.rect, thumb(1920, 1080, 3));
    near(findIconTile(playScreen(1920, 1080, ["LAN", "sculkwire-a", undefined, "sculkwire-b", "LAN", "sculkwire-c", "sculkwire-bench"]), bench)?.rect, thumb(1920, 1080, 6));
  });

  it("finds nothing when the tile is not on screen", () => {
    expect(findIconTile(playScreen(1280, 720, ["LAN", "sculkwire-a", "sculkwire-b"]), bench)).toBeUndefined();
    expect(findIconTile(playScreen(1920, 1080, []), bench)).toBeUndefined();
  });

  it("tells a look-alike sculkwire icon of another level from the test world's", () => {
    const image = playScreen(1280, 720, ["sculkwire-bridge", "sculkwire-bench"]);
    expect(findIcons(image)).toHaveLength(2);
    near(findIconTile(image, bench)?.rect, thumb(1280, 720, 1));
    near(findIconTile(image, iconCells("sculkwire-bridge"))?.rect, thumb(1280, 720, 0));
  });

  it("finds a small, darkened thumbnail", () => {
    near(findIconTile(playScreen(1280, 720, ["LAN", "sculkwire-bench"], { scale: 0.12, light: 0.6 }), bench)?.rect, thumb(1280, 720, 1, 0.12));
  });

  it("finds the tile on the retail layout under the Creative and Experimental badges", () => {
    const image = retailScreen(["sculkwire-frostforge", "sculkwire-bench", undefined], 0, [0, 1]);
    const match = findIconTile(image, bench);
    near(match?.rect, retailThumb(1, 0));
    expect(match?.whole).toBe(true);
    near(findIconTile(image, iconCells("sculkwire-frostforge"))?.rect, retailThumb(0, 0));
  });

  it("matches a tile whose top is under the tab strip on its visible cells, and clicks inside what is visible", () => {
    const match = findIconTile(retailScreen(["sculkwire-bench", "sculkwire-a", undefined], 122), bench);
    near(match?.rect, retailThumb(0, 122));
    expect(match).toMatchObject({ whole: false, hidden: "top", visibleCells: 4 });
    expect(match?.at.y).toBeGreaterThan(208);
    expect(match?.at.x).toBeGreaterThan(44);
    expect(match?.at.x).toBeLessThan(617);
    // Another world's icon cut the same way is told apart on its visible cells.
    expect(findIconTile(retailScreen(["sculkwire-a", "sculkwire-b", undefined], 122), bench)).toBeUndefined();
  });

  it("matches a tile cut off at the bottom of the screen on its visible cells", () => {
    const match = findIconTile(retailScreen(["sculkwire-a", "sculkwire-b", undefined, "sculkwire-bench"], -200), bench);
    expect(match).toMatchObject({ whole: false, hidden: "bottom" });
    expect(match?.visibleCells).toBeGreaterThanOrEqual(4);
    expect(match?.at.y).toBeLessThan(1080);
  });
});
