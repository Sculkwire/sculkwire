import { describe, expect, it } from "vitest";
import type { PlayerWorld } from "../types.ts";
import { decodeRegions, GridCache, sectionOrder } from "./grid.ts";

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
});
