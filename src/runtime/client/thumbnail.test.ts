import { describe, expect, it } from "vitest";
import { drawPicture, fill, frame, png, testPicture } from "../../testing/screenshots.ts";
import { decodePng, type Pixels } from "./png.ts";
import { LAYOUT } from "./screens.ts";
import { findThumbnailTiles, thumbnailTemplate, type Rect, type Template } from "./thumbnail.ts";

const template = (seed: string): Template => thumbnailTemplate(testPicture(seed)) as Template;

/** The thumbnail of a Play-screen tile in the 4-column layout: `scale` of the frame's width, 16:9, centred on the tile. */
function thumb(width: number, height: number, slot: number, scale = 0.2): Rect {
  const w = width * scale;
  const h = (w * 9) / 16;
  const c = LAYOUT.worldTile(slot);
  return { x: c.x * width - w / 2, y: c.y * height - h / 2, width: w, height: h };
}

/**
 * Draw a tile's thumbnail as the retail Play screen does: a 4 px frame of (30,30,31) around it, the picture, and the
 * dark "Creative" badge over its bottom-left corner (with a yellow "Experimental" one beside it when asked).
 */
function tile(image: Pixels, r: Rect, id: string | undefined, opts: { light?: number; experimental?: boolean } = {}): void {
  fill(image, { x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 }, [30, 30, 31]);
  if (id === "LAN") fill(image, r, [30, 90, 160]);
  else if (id) drawPicture(image, r, testPicture(id), opts.light);
  const badge = { x: r.x, y: r.y + r.height * 0.865, width: r.width * 0.28, height: r.height * 0.135 };
  fill(image, badge, [49, 50, 51]);
  for (let i = 0; i < 6; i++) fill(image, { x: badge.x + 6 + i * badge.width * 0.15, y: badge.y + 8, width: 3, height: badge.height - 16 }, [255, 255, 255]);
  if (opts.experimental) fill(image, { x: badge.x + badge.width, y: badge.y, width: r.width * 0.33, height: badge.height }, [250, 230, 60]);
}

function playScreen(width: number, height: number, tiles: (string | undefined)[], opts: { scale?: number; light?: number } = {}): Pixels {
  const image = frame(width, height);
  tiles.forEach((id, slot) => tile(image, thumb(width, height, slot, opts.scale), id, opts.light !== undefined ? { light: opts.light } : {}));
  return decodePng(png(image)) as Pixels;
}

/** The retail Play screen at 1920x1080: 3 tiles across of 573x322, the tab strip covering everything above y 208. */
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
  expect(Math.abs(r.x - b.x)).toBeLessThan(b.width * 0.04);
  expect(Math.abs(r.y - b.y)).toBeLessThan(b.height * 0.06);
  expect(Math.abs(r.width - b.width)).toBeLessThan(b.width * 0.06);
};

describe("finding a world's tile by its own thumbnail", () => {
  const mine = template("My Base");

  it("finds the one tile showing the picture, wherever the list puts it", () => {
    const [match, ...others] = findThumbnailTiles(playScreen(1280, 720, ["LAN", "Other World", "My Base", "Third"]), mine);
    expect(others).toEqual([]);
    expect(match?.whole).toBe(true);
    near(match?.rect, thumb(1280, 720, 2));
    const centre = LAYOUT.worldTile(2);
    expect(Math.abs((match?.at.x ?? 0) / 1280 - centre.x)).toBeLessThan(0.02);
  });

  it("finds a darker or smaller thumbnail, and one under the Creative and Experimental badges", () => {
    near(findThumbnailTiles(playScreen(1280, 720, ["Other", "My Base"], { scale: 0.12, light: 0.6 }), mine)[0]?.rect, thumb(1280, 720, 1, 0.12));
    const retail = findThumbnailTiles(retailScreen(["Other", "My Base", "Third"], 0, [1]), mine);
    expect(retail).toHaveLength(1);
    near(retail[0]?.rect, retailThumb(1, 0));
  });

  it("finds nothing when no tile shows the picture", () => {
    expect(findThumbnailTiles(playScreen(1280, 720, ["LAN", "Other", "Third"]), mine)).toEqual([]);
    expect(findThumbnailTiles(playScreen(1280, 720, []), mine)).toEqual([]);
  });

  it("returns both tiles when two show the same picture, so neither is taken", () => {
    expect(findThumbnailTiles(playScreen(1280, 720, ["My Base", "Other", "My Base"]), mine)).toHaveLength(2);
  });

  it("matches a tile cut off under the tab strip by its visible part and says which side is hidden", () => {
    const [match] = findThumbnailTiles(retailScreen(["My Base", "Other", undefined], 122), mine);
    expect(match).toMatchObject({ whole: false, hidden: "top" });
    expect(match?.at.y).toBeGreaterThan(208);
  });

  it("has no template for a flat picture", () => {
    expect(thumbnailTemplate(frame(160, 90, 120))).toBeUndefined();
  });
});
