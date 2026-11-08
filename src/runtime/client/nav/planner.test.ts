import { describe, expect, it } from "vitest";
import { ArrayGrid, decodeRegions, GridCache, sectionOrder, type BlockClass, type BlockGrid } from "./grid.ts";
import type { PlayerWorld } from "../player.ts";
import { coastDistance, straightLineClear } from "./navigate.ts";
import { plan, type PathStep } from "./planner.ts";

/** A test world: solid ground at y = 0 over `w` x `d` blocks, air up to y = 12, unknown outside. */
class TestGrid implements BlockGrid {
  readonly #cells = new Map<string, BlockClass>();
  readonly w: number;
  readonly d: number;
  constructor(w = 20, d = 20) {
    this.w = w;
    this.d = d;
  }
  at(x: number, y: number, z: number): BlockClass {
    if (x < 0 || z < 0 || x >= this.w || z >= this.d || y < -12 || y > 12) return "u";
    return this.#cells.get(`${x},${y},${z}`) ?? (y <= 0 ? "#" : ".");
  }
  set(x: number, y: number, z: number, c: BlockClass): this {
    this.#cells.set(`${x},${y},${z}`, c);
    return this;
  }
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: BlockClass): this {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) this.set(x, y, z, c);
    return this;
  }
  get bounds() {
    return { min: { x: 0, y: -12, z: 0 }, max: { x: this.w - 1, y: 12, z: this.d - 1 } };
  }
}

const at = (x: number, y: number, z: number) => ({ x: x + 0.5, y, z: z + 0.5 });
const moves = (path: PathStep[]) => path.map((s) => s.move);

describe("planner", () => {
  it("walks straight on flat ground", () => {
    const g = new TestGrid();
    const r = plan(g, at(2, 1, 5), { ...at(12, 1, 5) }, { bounds: g.bounds });
    expect(r.status).toBe("found");
    expect(r.path.at(-1)).toMatchObject({ x: 12, y: 1, z: 5 });
    expect(r.path.length).toBe(11);
    expect(moves(r.path).slice(1).every((m) => m === "walk")).toBe(true);
  });

  it("detours around a wall through its gap", () => {
    const g = new TestGrid().fill(10, 1, 0, 10, 3, 14, "#");
    const r = plan(g, at(2, 1, 5), at(17, 1, 5), { bounds: g.bounds });
    expect(r.status).toBe("found");
    for (const s of r.path) if (s.x === 10) expect(s.z).toBeGreaterThanOrEqual(15);
    expect(moves(r.path)).not.toContain("jump");
  });

  it("does not cut corners diagonally past a block", () => {
    const g = new TestGrid().set(5, 1, 5, "#").set(5, 2, 5, "#");
    const r = plan(g, at(4, 1, 4), at(6, 1, 6), { bounds: g.bounds });
    expect(r.status).toBe("found");
    for (let i = 1; i < r.path.length; i++) {
      const a = r.path[i - 1] as PathStep;
      const b = r.path[i] as PathStep;
      if (a.x !== b.x && a.z !== b.z) {
        expect(g.at(b.x, 1, a.z)).toBe(".");
        expect(g.at(a.x, 1, b.z)).toBe(".");
      }
    }
  });

  it("climbs a three-step staircase of blocks by jumping, and stairs blocks without jumping", () => {
    const g = new TestGrid().fill(8, 1, 0, 8, 1, 19, "#").fill(9, 1, 0, 9, 2, 19, "#").fill(10, 1, 0, 19, 3, 19, "#");
    const r = plan(g, at(3, 1, 5), at(14, 4, 5), { bounds: g.bounds });
    expect(r.status).toBe("found");
    expect(moves(r.path).filter((m) => m === "jump")).toHaveLength(3);
    expect(r.path.at(-1)?.floor).toBe(4);

    const s = new TestGrid().fill(8, 1, 0, 8, 1, 19, "t").fill(9, 1, 0, 9, 1, 19, "#").fill(9, 2, 0, 9, 2, 19, "t").fill(10, 1, 0, 19, 2, 19, "#").fill(10, 3, 0, 10, 3, 19, "t").fill(11, 1, 0, 19, 3, 19, "#");
    const rs = plan(s, at(3, 1, 5), at(14, 4, 5), { bounds: s.bounds });
    expect(rs.status).toBe("found");
    expect(moves(rs.path)).not.toContain("jump");
    expect(rs.path.at(-1)?.floor).toBe(4);
  });

  it("walks onto bottom slabs without jumping", () => {
    const g = new TestGrid().fill(8, 1, 0, 8, 1, 19, "s").fill(9, 1, 0, 19, 1, 19, "#");
    const r = plan(g, at(3, 1, 5), at(14, 2, 5), { bounds: g.bounds });
    expect(r.status).toBe("found");
    expect(moves(r.path)).not.toContain("jump");
    expect(r.path.find((s) => s.x === 8)?.floor).toBe(1.5);
  });

  it("drops 3 blocks but refuses 5, unless water breaks the fall", () => {
    // A tower whose only way down is a drop from its top.
    const three = new TestGrid().fill(2, 1, 2, 6, 3, 6, "#");
    const r3 = plan(three, at(4, 4, 4), at(15, 1, 15), { bounds: three.bounds });
    expect(r3.status).toBe("found");
    expect(r3.path.find((s) => s.move === "drop")?.fall).toBe(3);

    const five = new TestGrid().fill(2, 1, 2, 6, 5, 6, "#");
    const r5 = plan(five, at(4, 6, 4), at(15, 1, 15), { bounds: five.bounds });
    expect(r5.status).toBe("unreachable");
    expect(r5.message).toMatch(/no way to reach/);

    const pool = new TestGrid().fill(2, 1, 2, 6, 5, 6, "#").fill(7, 0, 4, 7, 0, 4, "w").fill(7, 1, 4, 7, 1, 4, "w");
    const rw = plan(pool, at(4, 6, 4), at(15, 1, 15), { bounds: pool.bounds });
    expect(rw.status).toBe("found");
    expect(rw.path.find((s) => s.move === "drop")).toMatchObject({ x: 7, z: 4 });
  });

  it("goes around a lava strip when it can, and jumps a strip that spans the way", () => {
    const g = new TestGrid().fill(10, 0, 0, 10, 0, 14, "L");
    const r = plan(g, at(3, 1, 5), at(16, 1, 5), { bounds: g.bounds });
    expect(r.status).toBe("found");
    for (const s of r.path) if (s.x === 10) expect(s.z).toBeGreaterThanOrEqual(15);
    expect(moves(r.path)).not.toContain("gap");

    const across = new TestGrid().fill(10, 0, 0, 10, 0, 19, "L");
    const ra = plan(across, at(3, 1, 5), at(16, 1, 5), { bounds: across.bounds });
    expect(ra.status).toBe("found");
    expect(ra.path.find((s) => s.move === "gap")).toMatchObject({ gap: 1 });
    expect(ra.path.some((s) => s.x === 10)).toBe(false);
  });

  it("never walks into fire or cactus", () => {
    const g = new TestGrid().fill(10, 1, 0, 10, 1, 18, "X").fill(10, 2, 0, 10, 2, 18, "X");
    const r = plan(g, at(3, 1, 5), at(16, 1, 5), { bounds: g.bounds });
    expect(r.status).toBe("found");
    expect(r.path.some((s) => s.x === 10 && s.z <= 18)).toBe(false);
  });

  it("sprint-jumps a 2-block gap over a deep pit", () => {
    const g = new TestGrid().fill(10, -12, 0, 11, 0, 19, ".");
    const r = plan(g, at(3, 1, 5), at(16, 1, 5), { bounds: g.bounds });
    expect(r.status).toBe("found");
    const jump = r.path.find((s) => s.move === "gap");
    expect(jump).toMatchObject({ gap: 2, x: 12 });
  });

  it("refuses a 4-block gap", () => {
    const g = new TestGrid().fill(8, -12, 0, 11, 0, 19, ".");
    const r = plan(g, at(3, 1, 5), at(16, 1, 5), { bounds: g.bounds });
    expect(r.status).toBe("unreachable");
  });

  it("opens a door in a wall", () => {
    const g = new TestGrid().fill(10, 1, 0, 10, 3, 19, "#").set(10, 1, 5, "D").set(10, 2, 5, "D");
    const r = plan(g, at(3, 1, 5), at(16, 1, 5), { bounds: g.bounds });
    expect(r.status).toBe("found");
    expect(r.path.find((s) => s.move === "door")).toMatchObject({ x: 10, z: 5 });
  });

  it("climbs a ladder", () => {
    const g = new TestGrid().fill(10, 1, 0, 19, 4, 19, "#").fill(9, 1, 5, 9, 4, 5, "H");
    const r = plan(g, at(3, 1, 5), at(14, 5, 5), { bounds: g.bounds });
    expect(r.status).toBe("found");
    expect(moves(r.path).filter((m) => m === "climb").length).toBeGreaterThanOrEqual(3);
  });

  it("swims across water", () => {
    const g = new TestGrid().fill(8, -2, 0, 12, 0, 19, "w");
    const r = plan(g, at(3, 1, 5), at(16, 1, 5), { bounds: g.bounds });
    expect(r.status).toBe("found");
    expect(moves(r.path)).toContain("swim");
  });

  it("says clearly when the target is walled in", () => {
    const g = new TestGrid().fill(13, 1, 3, 17, 4, 7, "#").fill(14, 1, 4, 16, 4, 6, ".");
    const r = plan(g, at(3, 1, 5), at(15, 1, 5), { bounds: g.bounds });
    expect(r.status).toBe("unreachable");
    expect(r.message).toMatch(/^no way to reach 15\.5, 1, 5\.5 from 3, 1, 5/);
    expect(r.message).toMatch(/closest reachable spot is/);
  });

  it("plans a partial path toward a target outside the known blocks", () => {
    const g = new TestGrid();
    const r = plan(g, at(3, 1, 5), { x: 60, z: 5 }, { bounds: g.bounds });
    expect(r.status).toBe("partial");
    expect(r.path.at(-1)).toMatchObject({ x: 19, z: 5 });
  });

  it("reports no start when the player is in an unknown area", () => {
    const g = new TestGrid();
    expect(plan(g, { x: -5, y: 1, z: -5 }, at(3, 1, 3)).status).toBe("no_start");
  });

  it("chains 2-block gap jumps along a line of 1-block pillars", () => {
    // Pillars 4 high at x 3, 6, 9 between a start and an end platform, over a floor 4 below.
    const g = new TestGrid().fill(0, 1, 4, 1, 4, 6, "#").fill(12, 1, 4, 14, 4, 6, "#");
    for (const x of [4, 7, 10]) g.fill(x, 1, 5, x, 4, 5, "#");
    const r = plan(g, at(1, 5, 5), at(13, 5, 5), { bounds: g.bounds });
    expect(r.status).toBe("found");
    expect(r.path.filter((s) => s.move === "gap").map((s) => [s.x, s.gap])).toEqual([
      [4, 2],
      [7, 2],
      [10, 2],
      [12, 1],
    ]);
    expect(r.path.every((s) => s.floor === 5)).toBe(true);
  });

  it("climbs down a ladder from a tower instead of jumping off", () => {
    // A tower 6 high with a ladder on its west face.
    const g = new TestGrid().fill(10, 1, 3, 14, 6, 7, "#").fill(9, 1, 5, 9, 6, 5, "H");
    const r = plan(g, at(11, 7, 5), at(3, 1, 5), { bounds: g.bounds });
    expect(r.status).toBe("found");
    expect(r.path.find((s) => s.move === "drop")).toMatchObject({ x: 9, y: 6, fall: 1 });
    // Down the ladder until a drop is harmless (3 blocks or less).
    expect(r.path.filter((s) => s.move === "climb").length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...r.path.map((s) => s.fall ?? 0))).toBeLessThanOrEqual(3);
  });

  it("swims at the surface of a deep pool, not along its bottom", () => {
    const g = new TestGrid().fill(6, -3, 0, 15, 0, 19, "w");
    const r = plan(g, at(3, 1, 5), at(18, 1, 5), { bounds: g.bounds });
    expect(r.status).toBe("found");
    for (const s of r.path) if (s.x >= 6 && s.x <= 15) expect(s.y).toBe(0);
    expect(r.path.at(-1)).toMatchObject({ x: 18, y: 1 });
  });

  it("walks up a slab staircase and down stairs without a jump", () => {
    // The nav-stairs ridge: slab, block, block + slab, ... to a top 3 high, then stairs down.
    const g = new TestGrid()
      .fill(5, 1, 0, 5, 1, 19, "s")
      .fill(6, 1, 0, 6, 1, 19, "#")
      .fill(7, 1, 0, 7, 1, 19, "#")
      .fill(7, 2, 0, 7, 2, 19, "s")
      .fill(8, 1, 0, 8, 2, 19, "#")
      .fill(9, 1, 0, 9, 2, 19, "#")
      .fill(9, 3, 0, 9, 3, 19, "s")
      .fill(10, 1, 0, 12, 3, 19, "#")
      .fill(13, 1, 0, 13, 2, 19, "#")
      .fill(13, 3, 0, 13, 3, 19, "t")
      .fill(14, 1, 0, 14, 1, 19, "#")
      .fill(14, 2, 0, 14, 2, 19, "t")
      .fill(15, 1, 0, 15, 1, 19, "t");
    const r = plan(g, at(2, 1, 5), at(18, 1, 5), { bounds: g.bounds });
    expect(r.status).toBe("found");
    expect(moves(r.path)).not.toContain("jump");
    expect(Math.max(...r.path.map((s) => s.floor))).toBe(4);
  });
});

describe("straightLineClear", () => {
  it("is clear on flat ground and over a one-block step, blocked by a wall", () => {
    const g = new TestGrid();
    expect(straightLineClear(g, at(2, 1, 5), at(12, 1, 5))).toBe(true);
    g.fill(6, 1, 0, 6, 1, 19, "#");
    expect(straightLineClear(g, at(2, 1, 5), at(12, 2, 5))).toBe(true);
    g.fill(6, 2, 0, 6, 2, 19, "#");
    expect(straightLineClear(g, at(2, 1, 5), at(12, 1, 5))).toBe(false);
  });

  it("is blocked by lava on the line", () => {
    const g = new TestGrid().set(7, 0, 5, "L");
    expect(straightLineClear(g, at(2, 1, 5), at(12, 1, 5))).toBe(false);
  });
});

describe("coastDistance", () => {
  it("follows a jump back down to its takeoff height", () => {
    // A jump (0.42 up) comes back down after 12 ticks; 0.3 blocks per tick fades by 9 % each tick on the way.
    expect(coastDistance(0.3, 0.42, 0)).toBeCloseTo((0.3 * (1 - 0.91 ** 12)) / 0.09, 6);
    expect(coastDistance(0, 0.42, 0)).toBe(0);
  });

  it("is nothing once down, and shorter the lower the player already is", () => {
    expect(coastDistance(0.3, -0.1, 0)).toBe(0);
    expect(coastDistance(0.3, -0.2, 1)).toBeLessThan(coastDistance(0.3, 0.42, 0));
  });
});

describe("grid", () => {
  it("decodes region boxes", () => {
    // A 3 x 2 x 2 box: the bottom layer solid, one water block on top, the rest unknown.
    const cells = decodeRegions("#000201w111111", 3, 2, 2);
    expect(String.fromCharCode(...cells)).toBe("######uuuuwu");
    expect(() => decodeRegions("#00030", 3, 1, 1)).toThrow(/multiple of 7/);
    expect(() => decodeRegions("#000300", 3, 1, 1)).toThrow(/outside/);
  });

  it("orders sections nearest to the focus first", () => {
    const order = sectionOrder(
      [
        [3, 0, 0],
        [0, 1, 0],
        [1, 0, 0],
        [0, 0, 0],
      ],
      { x: 5, y: 3, z: 5 },
    );
    expect(order).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [3, 0, 0],
    ]);
  });

  it("fetches the sections nearest the focus first, all in flight at once, and shares pending ones", async () => {
    const asked: number[][][] = [];
    const replies: (() => void)[] = [];
    const world = {
      query: (_kind: string, params: Record<string, unknown>) => {
        const boxes = params.boxes as number[][];
        asked.push(boxes);
        const { promise, resolve } = Promise.withResolvers<unknown>();
        replies.push(() => resolve({ boxes: boxes.map(() => "#000fff") }));
        return promise;
      },
    } as unknown as PlayerWorld;
    const cache = new GridCache(world);
    const all = cache.ensure({ x: 0, y: 0, z: 0 }, { x: 47, y: 15, z: 15 }, 60_000, 0, { x: 40, y: 0, z: 0 });
    // Three sections in queries of two, nearest to x 40 first, both queries sent before any reply.
    expect(asked.map((b) => b.map((box) => box[0]))).toEqual([[32, 16], [0]]);
    const again = cache.ensure({ x: 32, y: 0, z: 0 }, { x: 47, y: 15, z: 15 }, 60_000, 0);
    expect(asked).toHaveLength(2);
    for (const r of replies) r();
    await Promise.all([all, again]);
    expect(cache.at(40, 3, 3)).toBe("#");
    expect(cache.at(48, 3, 3)).toBe("u");
    expect(cache.has({ x: 0, y: 0, z: 0 }, { x: 47, y: 15, z: 15 }, 60_000, 0)).toBe(true);
    expect(cache.version).toBe(2);
  });

  it("reads text layers", () => {
    const g = new ArrayGrid([["#.", ".w"]], { x: 10, y: 64, z: 20 });
    expect(g.at(10, 64, 20)).toBe("#");
    expect(g.at(11, 64, 21)).toBe("w");
    expect(g.at(12, 64, 20)).toBe("u");
  });
});
