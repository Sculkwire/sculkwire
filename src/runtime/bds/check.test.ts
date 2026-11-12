import { describe, expect, it } from "vitest";
import { packStackIds } from "./check.ts";

describe("helpers", () => {
  it("reads pack ids from the Pack Stack line", () => {
    const ids = packStackIds([
      "[2026-11-07 17:05:35:816 INFO] Pack Stack - [00] MCBE Fixture BP (id: 5b1c7a0e-2f1d-4c55-9a39-1e7d3b6a0b01, version: 1.0.0) @ worlds/x/behavior_packs/0_BP",
    ]);
    expect([...ids]).toEqual(["5b1c7a0e-2f1d-4c55-9a39-1e7d3b6a0b01"]);
  });
});
