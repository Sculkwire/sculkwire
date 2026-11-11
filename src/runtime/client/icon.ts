/**
 * The test world's icon, and finding its tile on the Play screen by it.
 *
 * `createWorld` writes `world_icon.jpeg` into each `sculkwire-` world: a 256x144 picture of 16 px squares, whose outer
 * ring is a checker of black and sculk teal (the same in every sculkwire icon, so any of them is recognisable) and
 * whose inside is 4 x 2 cells of flat colours chosen by a hash of the world's level id. The Play screen shows the icon
 * as the world's thumbnail, so the tile with these cells is the test world's and no other world's: the join recovery
 * opens only that tile, wherever the list puts it.
 *
 * `findIcons` reads a screenshot: it finds pieces of the ring (a row or a column of alternating black and teal squares),
 * tries each piece at every place it can have in the ring, keeps the guess that agrees with most of the ring, and reads
 * the middle of each cell. The game draws a "Creative" badge over the thumbnail's bottom-left corner and the list's
 * edges cut tiles off, so neither the whole ring nor every cell has to be visible; scaling, JPEG and the UI's
 * filtering do not matter because only the middles of squares and cells are read.
 */
import { createHash } from "node:crypto";
import { encodeFlatJpeg, type Rgb } from "./jpeg.ts";
import type { Pixels } from "./screens.ts";

export type { Rgb } from "./jpeg.ts";

export const ICON_FILE = "world_icon.jpeg";
export const ICON_WIDTH = 256;
export const ICON_HEIGHT = 144;
/** Side of one border square, in icon pixels. */
const SQUARE = 16;
const ACROSS = ICON_WIDTH / SQUARE;
const DOWN = ICON_HEIGHT / SQUARE;
/** The cells inside the ring: columns, rows, and the side of one cell in icon pixels. */
const CELL_COLUMNS = 4;
const CELL_ROWS = 2;
const CELL = (ICON_WIDTH - 2 * SQUARE) / CELL_COLUMNS;

const BORDER_DARK: Rgb = [0, 0, 0];
const BORDER_TEAL: Rgb = [0, 190, 160];

/** The cell colours: saturated and far apart in hue, so a darker or blurred thumbnail still reads the same. */
export const ICON_PALETTE: readonly Rgb[] = [
  [220, 40, 40],
  [40, 200, 60],
  [40, 80, 230],
  [240, 220, 40],
  [210, 50, 210],
  [40, 210, 220],
  [240, 240, 240],
];

/** The 8 cell colours of a world's icon, in reading order: a SHA-256 of the level id picks each from the palette. */
export function iconCells(levelId: string): Rgb[] {
  const hash = createHash("sha256").update(levelId).digest();
  return Array.from({ length: CELL_COLUMNS * CELL_ROWS }, (_, i) => ICON_PALETTE[(hash[i] ?? 0) % ICON_PALETTE.length] as Rgb);
}

/** Whether the square at column `sx`, row `sy` of the ring is black (else teal): a checker starting black at the top left. */
function darkSquare(sx: number, sy: number): boolean {
  return (sx + sy) % 2 === 0;
}

function onRing(sx: number, sy: number): boolean {
  return sx === 0 || sy === 0 || sx === ACROSS - 1 || sy === DOWN - 1;
}

/** The icon's colour at icon pixel `x`, `y`. */
export function iconPixel(cells: readonly Rgb[], x: number, y: number): Rgb {
  const sx = Math.floor(x / SQUARE);
  const sy = Math.floor(y / SQUARE);
  if (onRing(sx, sy)) return darkSquare(sx, sy) ? BORDER_DARK : BORDER_TEAL;
  const column = Math.floor((x - SQUARE) / CELL);
  const row = Math.floor((y - SQUARE) / CELL);
  return cells[row * CELL_COLUMNS + column] ?? BORDER_DARK;
}

/** `world_icon.jpeg` for a world. */
export function worldIcon(levelId: string): Buffer {
  const cells = iconCells(levelId);
  return encodeFlatJpeg(ICON_WIDTH, ICON_HEIGHT, (bx, by) => iconPixel(cells, bx * 8, by * 8));
}

/** A rectangle in screenshot pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A sculkwire icon seen in a screenshot: the whole icon's rectangle (parts of it may be off screen or covered), the
 * palette index each cell reads as (-1 where the cell's middle is hidden or fits no palette colour), and how many ring
 * squares were seen.
 */
export interface FoundIcon {
  rect: Rect;
  cells: number[];
  ring: number;
}

type Shade = "dark" | "teal" | "other";

/** The ring's two colours. Dark is the icon's pure black, darker than any grey of the game's UI (30,30,31 and up). */
function shade(r: number, g: number, b: number): Shade {
  if (Math.max(r, g, b) < 22) return "dark";
  if (g >= 70 && b >= 60 && r * 2 < Math.min(g, b)) return "teal";
  return "other";
}

/** Mean colour over a rectangle, from a grid of up to 5 x 5 samples; undefined when none of it is on screen. */
function meanColour(image: Pixels, x0: number, y0: number, x1: number, y1: number): Rgb | undefined {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let j = 0; j < 5; j++) {
    const y = Math.round(y0 + ((y1 - y0) * (j + 0.5)) / 5);
    if (y < 0 || y >= image.height) continue;
    for (let i = 0; i < 5; i++) {
      const x = Math.round(x0 + ((x1 - x0) * (i + 0.5)) / 5);
      if (x < 0 || x >= image.width) continue;
      const at = (y * image.width + x) * image.channels;
      r += image.data[at] ?? 0;
      g += image.data[at + 1] ?? 0;
      b += image.data[at + 2] ?? 0;
      n++;
    }
  }
  return n ? [r / n, g / n, b / n] : undefined;
}

/**
 * The palette colour nearest by hue and saturation (each colour scaled to its brightest channel), or -1. White needs
 * all three channels bright, so the game's greys (a tab strip over a cut-off tile) never read as a white cell.
 */
export function paletteIndex(colour: Rgb): number {
  const top = Math.max(...colour);
  if (top < 60) return -1;
  let best = -1;
  let bestDistance = 0.35;
  ICON_PALETTE.forEach((p, i) => {
    const pTop = Math.max(...p);
    const d = Math.hypot(colour[0] / top - p[0] / pTop, colour[1] / top - p[1] / pTop, colour[2] / top - p[2] / pTop);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  const white = ICON_PALETTE.findIndex((p) => p[0] === p[1] && p[1] === p[2]);
  return best === white && Math.min(...colour) < 120 ? -1 : best;
}

interface Run {
  shade: Shade;
  start: number;
  end: number;
}

/** Shades along a line as runs; runs of `other` up to 3 px between black and teal (a blurred edge) join the run before. */
function lineRuns(n: number, at: (i: number) => Shade): Run[] {
  const runs: Run[] = [];
  for (let i = 0; i < n; i++) {
    const s = at(i);
    const last = runs.at(-1);
    if (last?.shade === s) last.end = i + 1;
    else runs.push({ shade: s, start: i, end: i + 1 });
  }
  const merged: Run[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i] as Run;
    const before = merged.at(-1);
    const after = runs[i + 1];
    if (run.shade === "other" && run.end - run.start <= 3 && before && after && before.shade !== "other" && after.shade !== "other" && before.shade !== after.shade) {
      before.end = run.end;
      continue;
    }
    merged.push({ ...run });
  }
  return merged;
}

/** A piece of the ring along a line: an inner square's start and shade, and the square's side. */
interface Ladder {
  edge: number;
  shade: Shade;
  side: number;
}

/** Ring pieces on a line: at least 4 alternating black and teal runs whose inner runs share one width. */
function ladders(runs: readonly Run[]): Ladder[] {
  const out: Ladder[] = [];
  let i = 0;
  while (i < runs.length) {
    if (runs[i]?.shade === "other") {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < runs.length && runs[j + 1]?.shade !== "other" && runs[j + 1]?.shade !== runs[j]?.shade) j++;
    const seq = runs.slice(i, j + 1);
    i = j + 1;
    if (seq.length < 4) continue;
    // The end runs may be cut by a badge, the screen edge or a dark surrounding: only the inner ones set the side.
    const inner = seq.slice(1, -1);
    const side = inner.reduce((sum, r) => sum + r.end - r.start, 0) / inner.length;
    if (side < 4 || inner.some((r) => r.end - r.start < side * 0.7 || r.end - r.start > side * 1.3)) continue;
    const first = inner[0] as Run;
    out.push({ edge: first.start, shade: first.shade, side });
  }
  return out;
}

/**
 * Read the icon a grid guess puts at `x0`, `y0` with squares of `side` px: each ring square's middle is compared with
 * the ring, each cell's middle read. Undefined when too little of the ring agrees, or when it agrees on one side only
 * (one row of squares fits a guess shifted by a whole icon height just as well).
 */
function readIcon(image: Pixels, x0: number, y0: number, side: number): (FoundIcon & { score: number }) | undefined {
  let match = 0;
  let wrong = 0;
  /** Matching squares per side: top row, bottom row, left column, right column (corners count for their row). */
  const sides = [0, 0, 0, 0];
  const middle = (x: number, y: number, w: number, h: number) => meanColour(image, x + w * 0.3, y + h * 0.3, x + w * 0.7, y + h * 0.7);
  for (let sy = 0; sy < DOWN; sy++) {
    for (let sx = 0; sx < ACROSS; sx++) {
      if (!onRing(sx, sy)) continue;
      const c = middle(x0 + sx * side, y0 + sy * side, side, side);
      if (!c) continue;
      const s = shade(c[0], c[1], c[2]);
      if (s === (darkSquare(sx, sy) ? "dark" : "teal")) {
        match++;
        const at = sy === 0 ? 0 : sy === DOWN - 1 ? 1 : sx === 0 ? 2 : 3;
        sides[at] = (sides[at] as number) + 1;
      } else if (s !== "other") wrong++;
    }
  }
  if (match < 8 || wrong * 5 > match || sides.filter((n) => n >= 2).length < 2) return undefined;
  const cell = (side * CELL) / SQUARE;
  const cells: number[] = [];
  for (let row = 0; row < CELL_ROWS; row++) {
    for (let column = 0; column < CELL_COLUMNS; column++) {
      const c = middle(x0 + side + column * cell, y0 + side + row * cell, cell, cell);
      cells.push(c ? paletteIndex(c) : -1);
    }
  }
  return { rect: { x: x0, y: y0, width: side * ACROSS, height: side * DOWN }, cells, ring: match, score: match - 3 * wrong };
}

/** Overlap of two rectangles over the smaller one's area. */
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.min(a.width * a.height, b.width * b.height) : 0;
}

/**
 * Every sculkwire icon visible in a screenshot, whole or in part. The ring is found as pieces: a row of alternating
 * squares (the top or bottom row) or a column of them (the left or right column), so an icon whose top is under the tab
 * strip, whose bottom is off screen or whose bottom-left corner is under the game's "Creative" badge is still seen.
 * Each piece is tried at every place it can have in the ring; the guess that agrees with most of the ring wins.
 */
export function findIcons(image: Pixels): FoundIcon[] {
  const shadeAt = (x: number, y: number): Shade => {
    const at = (y * image.width + x) * image.channels;
    return shade(image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0);
  };
  /** How far a square of this shade reaches from a point, walking one way. */
  const reach = (x: number, y: number, dx: number, dy: number, s: Shade, limit: number): number => {
    let n = 0;
    while (n < limit) {
      const nx = x + dx * (n + 1);
      const ny = y + dy * (n + 1);
      if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height || shadeAt(nx, ny) !== s) break;
      n++;
    }
    return n;
  };
  const guesses: { x0: number; y0: number; side: number }[] = [];
  const seen = new Set<string>();
  const guess = (x0: number, y0: number, side: number) => {
    const key = `${Math.round(x0 / 2)},${Math.round(y0 / 2)},${Math.round(side)}`;
    if (seen.has(key)) return;
    seen.add(key);
    guesses.push({ x0, y0, side });
  };
  for (let y = 0; y < image.height; y += 2) {
    for (const l of ladders(lineRuns(image.width, (x) => shadeAt(x, y)))) {
      const mid = Math.round(l.edge + l.side / 2);
      const top = y - reach(mid, y, 0, -1, l.shade, Math.ceil(l.side * 1.5));
      const bottom = y + reach(mid, y, 0, 1, l.shade, Math.ceil(l.side * 1.5)) + 1;
      for (const sy of [0, DOWN - 1]) {
        for (let sx = 0; sx < ACROSS; sx++) {
          if (darkSquare(sx, sy) !== (l.shade === "dark")) continue;
          const x0 = l.edge - sx * l.side;
          guess(x0, top - sy * l.side, l.side);
          guess(x0, bottom - (sy + 1) * l.side, l.side);
        }
      }
    }
  }
  for (let x = 0; x < image.width; x += 2) {
    for (const l of ladders(lineRuns(image.height, (y) => shadeAt(x, y)))) {
      const mid = Math.round(l.edge + l.side / 2);
      const left = x - reach(x, mid, -1, 0, l.shade, Math.ceil(l.side * 1.5));
      const right = x + reach(x, mid, 1, 0, l.shade, Math.ceil(l.side * 1.5)) + 1;
      for (const sx of [0, ACROSS - 1]) {
        for (let sy = 0; sy < DOWN; sy++) {
          if (darkSquare(sx, sy) !== (l.shade === "dark")) continue;
          const y0 = l.edge - sy * l.side;
          guess(left - sx * l.side, y0, l.side);
          guess(right - (sx + 1) * l.side, y0, l.side);
        }
      }
    }
  }
  const read = guesses.map((g) => readIcon(image, g.x0, g.y0, g.side)).filter((icon) => icon !== undefined);
  read.sort((a, b) => b.score - a.score || b.cells.filter((c) => c >= 0).length - a.cells.filter((c) => c >= 0).length);
  const found: FoundIcon[] = [];
  for (const icon of read) {
    if (found.some((f) => overlap(f.rect, icon.rect) > 0.25)) continue;
    found.push({ rect: icon.rect, cells: icon.cells, ring: icon.ring });
  }
  return found.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

/** The test world's tile as the screenshot shows it. */
export interface TileMatch {
  /** The whole thumbnail, also where it is off screen or covered. */
  rect: Rect;
  /** Every cell is visible and matches: the tile is identified. */
  whole: boolean;
  /** Cells seen and matching (all the visible ones match; hidden ones are unknown). */
  visibleCells: number;
  /** Where to click: the middle of the visible matching cells. */
  at: { x: number; y: number };
  /** For a tile not wholly visible, the side that is hidden. */
  hidden?: "top" | "bottom";
}

/**
 * The tile whose thumbnail shows this icon (cell colours as `iconCells` gives them): a whole match first, else one
 * whose visible cells all match and whose others are hidden (cut off by the list's edge). An icon with a visible cell
 * that differs is another world's and never returned.
 */
export function findIconTile(image: Pixels, cells: readonly Rgb[]): TileMatch | undefined {
  const want = cells.map(paletteIndex);
  if (want.includes(-1)) return undefined;
  const matches: TileMatch[] = [];
  for (const icon of findIcons(image)) {
    if (icon.cells.some((c, i) => c !== -1 && c !== want[i])) continue;
    const visible = icon.cells.flatMap((c, i) => (c === -1 ? [] : [i]));
    const side = icon.rect.width / ACROSS;
    const cell = (side * CELL) / SQUARE;
    const centres = visible.map((i) => ({
      x: icon.rect.x + side + ((i % CELL_COLUMNS) + 0.5) * cell,
      y: icon.rect.y + side + (Math.floor(i / CELL_COLUMNS) + 0.5) * cell,
    }));
    const mean = (key: "x" | "y") => centres.reduce((sum, c) => sum + c[key], 0) / Math.max(1, centres.length);
    const whole = visible.length === icon.cells.length;
    const topHidden = icon.cells.slice(0, CELL_COLUMNS).filter((c) => c === -1).length;
    const bottomHidden = icon.cells.slice(CELL_COLUMNS).filter((c) => c === -1).length;
    const middle = icon.rect.y + icon.rect.height / 2;
    matches.push({
      rect: icon.rect,
      whole,
      visibleCells: visible.length,
      at: centres.length ? { x: mean("x"), y: mean("y") } : { x: icon.rect.x + icon.rect.width / 2, y: middle },
      ...(whole ? {} : { hidden: topHidden > bottomHidden || (topHidden === bottomHidden && middle < image.height / 2) ? ("top" as const) : ("bottom" as const) }),
    });
  }
  return matches.find((m) => m.whole) ?? matches.sort((a, b) => b.visibleCells - a.visibleCells)[0];
}
