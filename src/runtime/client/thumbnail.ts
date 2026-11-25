/**
 * Finding a world's tile on the Play screen by its own thumbnail: the picture in the world's `world_icon.jpeg`, which
 * the game shows as the tile's thumbnail. sculkwire writes nothing into the world for this.
 *
 * The picture is shrunk to a 16 x 9 grid of cell colours (`thumbnailTemplate`). A screenshot is searched for that grid
 * at every tile size from a tenth to two fifths of the frame's width, wherever it lies: each place is scored by the
 * zero-mean normalised correlation of its cell colours with the grid, so the thumbnail matches however the UI darkens
 * or brightens it (a hovered tile, the game's filtering). The bottom row is left out because the game draws its
 * "Creative" and "Experimental" badges over it. A tile cut off by the list's edge or under the tab strip matches by its
 * top or bottom half alone and reports the side that is hidden.
 *
 * A tile is taken only when it is the one place that matches: two tiles showing the same picture (a world and its
 * copy) are both returned, and the caller opens neither.
 */
import type { Pixels } from "./png.ts";

/** Cells of the template: across, down. The thumbnail is drawn 16:9. */
const CELLS_ACROSS = 16;
const CELLS_DOWN = 9;
/** Rows of the template compared (the bottom row is under the game's badges). */
const ROWS_COMPARED = CELLS_DOWN - 1;
/** Rows of a band for a tile partly out of view or covered: the top or the bottom half of the compared rows. */
const BAND_ROWS = ROWS_COMPARED / 2;
/** Thumbnail widths searched, as fractions of the frame's width, and the step between two sizes. */
const SMALLEST = 0.1;
const LARGEST = 0.42;
const SIZE_STEP = 1.06;
/** A place scoring this in the coarse search (a cell apart, so up to half a cell off) is looked at closely. */
const COARSE_SCORE = 0.7;
/**
 * A place scoring this after the close look is the picture: the whole thumbnail, or its visible half, which has fewer
 * cells and so needs a closer fit (other worlds' halves reached 0.95 in tests; the picture itself scores above 0.99).
 */
const WHOLE_SCORE = 0.95;
const HALF_SCORE = 0.975;

const accepted = (m: TileMatch): boolean => m.score >= (m.whole ? WHOLE_SCORE : HALF_SCORE);
/** Of two looks at one place: an accepted one first, the whole thumbnail before half of it, then the higher score. */
const rank = (m: TileMatch): number => (accepted(m) ? 2 : 0) + (m.whole ? 1 : 0);
/** A picture whose cells vary less than this (standard deviation of the 0-255 channels) is too flat to find. */
const FLAT = 6;

/** A rectangle in screenshot pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A world's picture shrunk for the search: cell colours row by row, 3 channels each. */
export interface Template {
  cells: Float64Array;
}

/** A tile whose thumbnail shows the picture. */
export interface TileMatch {
  /** The whole thumbnail, also where it is off screen or covered. */
  rect: Rect;
  /** The whole thumbnail matched; else only its `hidden` side's opposite band did. */
  whole: boolean;
  /** Where to click: the middle of the part that matched. */
  at: { x: number; y: number };
  /** For a tile not wholly visible, the side that is hidden. */
  hidden?: "top" | "bottom";
  /** Correlation of the part that matched, up to 1. */
  score: number;
}

/** Sums of each channel over every rectangle from the origin, for box means in four lookups. */
interface Integral {
  width: number;
  height: number;
  sums: Float64Array;
}

function integral(image: Pixels): Integral {
  const { width, height, channels, data } = image;
  const stride = (width + 1) * 3;
  const sums = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    const row = [0, 0, 0];
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels;
      for (let c = 0; c < 3; c++) {
        row[c] = (row[c] as number) + (data[at + (channels >= 3 ? c : 0)] ?? 0);
        const o = (y + 1) * stride + (x + 1) * 3 + c;
        sums[o] = (sums[o - stride] as number) + (row[c] as number);
      }
    }
  }
  return { width, height, sums };
}

/** Mean colour of a box into `out` (3 values); false when the box is not wholly inside the image. */
function boxMean(img: Integral, x0: number, y0: number, w: number, h: number, out: Float64Array, at: number): boolean {
  const ax = Math.round(x0);
  const ay = Math.round(y0);
  const bx = Math.round(x0 + w);
  const by = Math.round(y0 + h);
  if (ax < 0 || ay < 0 || bx > img.width || by > img.height || bx <= ax || by <= ay) return false;
  const stride = (img.width + 1) * 3;
  const area = (bx - ax) * (by - ay);
  for (let c = 0; c < 3; c++) {
    const s = img.sums;
    const sum = (s[by * stride + bx * 3 + c] as number) - (s[ay * stride + bx * 3 + c] as number) - (s[by * stride + ax * 3 + c] as number) + (s[ay * stride + ax * 3 + c] as number);
    out[at + c] = sum / area;
  }
  return true;
}

/** The picture as the search's template, or undefined when it is too flat to tell apart from the UI's own panels. */
export function thumbnailTemplate(picture: Pixels): Template | undefined {
  const img = integral(picture);
  const cells = new Float64Array(CELLS_ACROSS * CELLS_DOWN * 3);
  const w = picture.width / CELLS_ACROSS;
  const h = picture.height / CELLS_DOWN;
  for (let j = 0; j < CELLS_DOWN; j++) {
    for (let i = 0; i < CELLS_ACROSS; i++) boxMean(img, i * w, j * h, Math.max(1, w), Math.max(1, h), cells, (j * CELLS_ACROSS + i) * 3);
  }
  const compared = cells.subarray(0, ROWS_COMPARED * CELLS_ACROSS * 3);
  const mean = compared.reduce((a, b) => a + b, 0) / compared.length;
  const sd = Math.sqrt(compared.reduce((a, b) => a + (b - mean) ** 2, 0) / compared.length);
  return sd < FLAT ? undefined : { cells };
}

/** Per template row: sums of the screen's values, their squares, and their products with the template's. */
interface RowStats {
  n: Float64Array;
  sx: Float64Array;
  sxx: Float64Array;
  sxy: Float64Array;
  /** The row is wholly inside the image. */
  inside: Uint8Array;
}

/** Template sums per row (values and squares), for the correlation of any band. */
interface TemplateRows {
  sy: Float64Array;
  syy: Float64Array;
}

function templateRows(t: Template): TemplateRows {
  const sy = new Float64Array(CELLS_DOWN);
  const syy = new Float64Array(CELLS_DOWN);
  for (let j = 0; j < ROWS_COMPARED; j++) {
    for (let k = 0; k < CELLS_ACROSS * 3; k++) {
      const v = t.cells[j * CELLS_ACROSS * 3 + k] as number;
      sy[j] = (sy[j] as number) + v;
      syy[j] = (syy[j] as number) + v * v;
    }
  }
  return { sy, syy };
}

/** Correlation over template rows `from` to `to` (exclusive), or -1 when one of them is not wholly in view. */
function bandScore(s: RowStats, t: TemplateRows, from: number, to: number): number {
  let n = 0;
  let sx = 0;
  let sxx = 0;
  let sy = 0;
  let syy = 0;
  let sxy = 0;
  for (let j = from; j < to; j++) {
    if (!s.inside[j]) return -1;
    n += s.n[j] as number;
    sx += s.sx[j] as number;
    sxx += s.sxx[j] as number;
    sxy += s.sxy[j] as number;
    sy += t.sy[j] as number;
    syy += t.syy[j] as number;
  }
  if (n === 0) return -1;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (vx <= n * 4 || vy <= 0) return -1;
  return (sxy - (sx * sy) / n) / Math.sqrt(vx * vy);
}

/** The best of the whole thumbnail, its top band and its bottom band, as a match for the rectangle. */
function judge(s: RowStats, t: TemplateRows, rect: Rect, image: { width: number; height: number }): TileMatch | undefined {
  const whole = bandScore(s, t, 0, ROWS_COMPARED);
  const cellHeight = rect.height / CELLS_DOWN;
  const centre = (from: number, to: number) => ({
    x: Math.min(image.width - 1, Math.max(0, rect.x + rect.width / 2)),
    y: rect.y + ((from + to) / 2) * cellHeight,
  });
  if (whole >= WHOLE_SCORE) return { rect, whole: true, at: centre(0, CELLS_DOWN), score: whole };
  const top = bandScore(s, t, 0, BAND_ROWS);
  const bottom = bandScore(s, t, ROWS_COMPARED - BAND_ROWS, ROWS_COMPARED);
  if (whole >= Math.max(top, bottom)) return whole < 0 ? undefined : { rect, whole: true, at: centre(0, CELLS_DOWN), score: whole };
  return bottom >= top
    ? { rect, whole: false, hidden: "top", at: centre(ROWS_COMPARED - BAND_ROWS, ROWS_COMPARED), score: bottom }
    : { rect, whole: false, hidden: "bottom", at: centre(0, BAND_ROWS), score: top };
}

/** Score the template at `x0`, `y0` with cells of `w` x `h` screenshot pixels. */
function scoreAt(img: Integral, t: Template, rows: TemplateRows, x0: number, y0: number, w: number, h: number, stats: RowStats, cell: Float64Array): TileMatch | undefined {
  for (let j = 0; j < ROWS_COMPARED; j++) {
    let n = 0;
    let sx = 0;
    let sxx = 0;
    let sxy = 0;
    let inside = 1;
    for (let i = 0; i < CELLS_ACROSS; i++) {
      if (!boxMean(img, x0 + i * w, y0 + j * h, w, h, cell, 0)) {
        inside = 0;
        break;
      }
      for (let c = 0; c < 3; c++) {
        const x = cell[c] as number;
        n++;
        sx += x;
        sxx += x * x;
        sxy += x * (t.cells[(j * CELLS_ACROSS + i) * 3 + c] as number);
      }
    }
    stats.n[j] = n;
    stats.sx[j] = sx;
    stats.sxx[j] = sxx;
    stats.sxy[j] = sxy;
    stats.inside[j] = inside;
  }
  return judge(stats, rows, { x: x0, y: y0, width: w * CELLS_ACROSS, height: h * CELLS_DOWN }, img);
}

/** Overlap of two rectangles over the smaller one's area. */
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.min(a.width * a.height, b.width * b.height) : 0;
}

/** The best match of each place, keeping only the better of two that overlap. */
function distinct(matches: TileMatch[]): TileMatch[] {
  const sorted = [...matches].sort((a, b) => rank(b) - rank(a) || b.score - a.score);
  const out: TileMatch[] = [];
  for (const m of sorted) if (!out.some((o) => overlap(o.rect, m.rect) > 0.25)) out.push(m);
  return out;
}

/**
 * Every tile in the screenshot whose thumbnail shows the template's picture, best first, one per place. More than one
 * means the picture does not identify a tile.
 */
export function findThumbnailTiles(image: Pixels, t: Template): TileMatch[] {
  const img = integral(image);
  const rows = templateRows(t);
  const stats: RowStats = {
    n: new Float64Array(CELLS_DOWN),
    sx: new Float64Array(CELLS_DOWN),
    sxx: new Float64Array(CELLS_DOWN),
    sxy: new Float64Array(CELLS_DOWN),
    inside: new Uint8Array(CELLS_DOWN),
  };
  const cell = new Float64Array(3);
  const coarse: TileMatch[] = [];
  for (let width = image.width * SMALLEST; width <= image.width * LARGEST; width *= SIZE_STEP) {
    const w = width / CELLS_ACROSS;
    const h = (width * 9) / 16 / CELLS_DOWN;
    // Cell means on a grid one cell apart, starting half a tile above the frame: a tile may reach out of the frame by
    // up to half its height. A cell not wholly in the frame is marked out.
    const top = -Math.floor(CELLS_DOWN / 2);
    const cols = Math.floor(image.width / w);
    const gridRows = Math.floor(image.height / h) - top + Math.floor(CELLS_DOWN / 2);
    const grid = new Float64Array(cols * gridRows * 3);
    const inGrid = new Uint8Array(cols * gridRows);
    for (let r = 0; r < gridRows; r++) {
      for (let c = 0; c < cols; c++) inGrid[r * cols + c] = boxMean(img, c * w, (top + r) * h, w, h, grid, (r * cols + c) * 3) ? 1 : 0;
    }
    for (let gy = 0; gy + CELLS_DOWN <= gridRows; gy++) {
      for (let gx = 0; gx + CELLS_ACROSS <= cols; gx++) {
        for (let j = 0; j < ROWS_COMPARED; j++) {
          let sx = 0;
          let sxx = 0;
          let sxy = 0;
          let inside = 1;
          const row = (gy + j) * cols + gx;
          for (let i = 0; i < CELLS_ACROSS && inside; i++) {
            if (!inGrid[row + i]) inside = 0;
            for (let c = 0; c < 3; c++) {
              const x = grid[(row + i) * 3 + c] as number;
              sx += x;
              sxx += x * x;
              sxy += x * (t.cells[(j * CELLS_ACROSS + i) * 3 + c] as number);
            }
          }
          stats.n[j] = CELLS_ACROSS * 3;
          stats.sx[j] = sx;
          stats.sxx[j] = sxx;
          stats.sxy[j] = sxy;
          stats.inside[j] = inside;
        }
        const m = judge(stats, rows, { x: gx * w, y: (top + gy) * h, width: width, height: h * CELLS_DOWN }, image);
        if (m && m.score >= COARSE_SCORE) coarse.push(m);
      }
    }
  }
  const refined: TileMatch[] = [];
  // Whole and half matches are refined apart: a half of the picture can fit some other size of tile better than the
  // whole picture fits before refinement.
  const candidates = [...distinct(coarse.filter((m) => m.whole)).slice(0, 16), ...distinct(coarse.filter((m) => !m.whole)).slice(0, 16)];
  for (const c of candidates) {
    let best = c;
    for (const size of [0.97, 0.985, 1, 1.015, 1.03]) {
      const w = (c.rect.width * size) / CELLS_ACROSS;
      const h = (c.rect.height * size) / CELLS_DOWN;
      const cx = c.rect.x + c.rect.width / 2;
      const cy = c.rect.y + c.rect.height / 2;
      for (let dy = -0.5; dy <= 0.5; dy += 0.25) {
        for (let dx = -0.5; dx <= 0.5; dx += 0.25) {
          const m = scoreAt(img, t, rows, cx - (w * CELLS_ACROSS) / 2 + dx * w, cy - (h * CELLS_DOWN) / 2 + dy * h, w, h, stats, cell);
          if (m && (rank(m) > rank(best) || (rank(m) === rank(best) && m.score > best.score))) best = m;
        }
      }
    }
    if (accepted(best)) refined.push(best);
  }
  return distinct(refined);
}
