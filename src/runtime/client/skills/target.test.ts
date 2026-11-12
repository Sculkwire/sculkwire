import { describe, expect, it } from "vitest";
import { escapeYaw } from "./target.ts";

describe("flee direction", () => {
  it("points away from the threats, the nearest weighing most", () => {
    // A zombie at +Z: run toward -Z (yaw 180).
    expect(Math.abs(escapeYaw({ x: 0, y: 0, z: 0 }, [{ location: { x: 0, y: 0, z: 3 }, weight: 1 }]) ?? 0)).toBeCloseTo(180, 0);
    const between = escapeYaw({ x: 0, y: 0, z: 0 }, [
      { location: { x: 0, y: 0, z: 2 }, weight: 1 },
      { location: { x: 0, y: 0, z: -8 }, weight: 1 },
    ]);
    expect(Math.abs(between ?? 0)).toBeCloseTo(180, 0);
    expect(escapeYaw({ x: 0, y: 0, z: 0 }, [])).toBeUndefined();
  });
});
