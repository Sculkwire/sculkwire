import { describe, expect, it } from "vitest";
import { angleDiff } from "../geometry.ts";
import { clearRun, findCover, lineBlocked, openHeading } from "./steer.ts";

describe("cover from archers", () => {
  it("finds cover behind a pillar on the way to an archer, and none on open ground", () => {
    // Flat ground at y -1, a 2-high pillar at x 0, z 5 (between the player at z 0 and the skeleton at z 12).
    const pillar = new Set(["0,0,5", "0,1,5"]);
    const grid = { at: (x: number, y: number, z: number) => (y < 0 ? "#" : pillar.has(`${x},${y},${z}`) ? "#" : ".") };
    const open = { at: (_x: number, y: number) => (y < 0 ? "#" : ".") };
    const me = { x: 0.5, y: 0, z: 0.5 };
    const skeleton = { x: 0.5, y: 0, z: 12.5 };
    expect(lineBlocked(grid, { x: 0.5, y: 1.5, z: 12.5 }, { x: 0.5, y: 1.2, z: 4.5 })).toBe(true);
    const spot = findCover(grid, me, skeleton);
    expect(spot).toBeDefined();
    expect(spot?.z).toBeLessThan(5);
    expect(spot?.z).toBeGreaterThan(2);
    expect(lineBlocked(grid, { x: skeleton.x, y: 1.5, z: skeleton.z }, { x: spot?.x ?? 0, y: 1.2, z: spot?.z ?? 0 })).toBe(true);
    expect(findCover(open, me, skeleton)).toBeUndefined();
    expect(findCover(grid, me, skeleton, new Set([`${Math.floor(spot?.x ?? 0)},${Math.floor(spot?.z ?? 0)}`]))).not.toEqual(spot);
  });
});

describe("open heading", () => {
  /** A grid: solid floor at y -1, air above, a glass wall along z = 3 (blocks z >= 3 solid at feet and head). */
  const walled = { at: (_x: number, y: number, z: number) => (y < 0 ? "#" : z >= 3 && y <= 2 ? "#" : ".") };

  it("measures the free run toward a heading up to a wall, a hole or water", () => {
    const at = { x: 0.5, y: 0, z: 0.5 };
    // Yaw 0 points to +z: the wall starts 2.5 blocks ahead.
    expect(clearRun(walled, at, 0)).toBe(2);
    expect(clearRun(walled, at, 180)).toBe(6);
    const hole = { at: (x: number, y: number) => (y < 0 ? (x === 2 ? "." : "#") : ".") };
    // Yaw -90 points to +x: the hole at x = 2 under the feet.
    expect(clearRun(hole, at, -90)).toBe(1);
  });

  it("turns aside from a wall right behind instead of running into it", () => {
    const me = { x: 0.5, y: 0, z: 2.2 };
    const yaw = openHeading({ me, desired: 0, spreadDeg: 120, mobs: [], clear: (y) => clearRun(walled, me, y) });
    expect(Math.abs(angleDiff(0, yaw))).toBeGreaterThanOrEqual(75);
  });

  it("strafes around a zombie standing on the way instead of into it", () => {
    const me = { x: 0, y: 0, z: 0 };
    const zombie = { location: { x: 0, y: 0, z: 2.5 } };
    const yaw = openHeading({ me, desired: 0, spreadDeg: 120, mobs: [zombie], clear: () => 6 });
    expect(Math.abs(angleDiff(0, yaw))).toBeGreaterThanOrEqual(30);
    // Nothing in the way: straight on.
    expect(openHeading({ me, desired: 0, spreadDeg: 120, mobs: [], clear: () => 6 })).toBe(0);
  });

  it("keeps a creeper's wider clearance", () => {
    const me = { x: 0, y: 0, z: 0 };
    const creeper = { location: { x: 3.5, y: 0, z: 3 }, clearance: 4 };
    const yaw = openHeading({ me, desired: -45, spreadDeg: 90, mobs: [creeper], clear: () => 6 });
    // -45 heads toward +x +z, past the creeper: the pick leans away from it (toward +z alone or farther).
    expect(angleDiff(-45, yaw)).toBeGreaterThan(0);
  });
});
