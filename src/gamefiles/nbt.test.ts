import { describe, expect, it } from "vitest";
import { enableExperiments, readLevelDat, TAG, writeLevelDat, type NbtCompound } from "./nbt.ts";

describe("level.dat NBT", () => {
  it("round-trips every tag type and enables experiments", () => {
    const root: NbtCompound = new Map([
      ["LevelName", { type: TAG.String, value: "wörld" }],
      ["b", { type: TAG.Byte, value: -3 }],
      ["s", { type: TAG.Short, value: 1234 }],
      ["i", { type: TAG.Int, value: -70000 }],
      ["l", { type: TAG.Long, value: 1n << 40n }],
      ["f", { type: TAG.Float, value: 0.5 }],
      ["d", { type: TAG.Double, value: Math.PI }],
      ["ba", { type: TAG.ByteArray, value: new Uint8Array([1, 2, 3]) }],
      ["ia", { type: TAG.IntArray, value: [1, -1] }],
      ["la", { type: TAG.LongArray, value: [5n] }],
      ["list", { type: TAG.List, value: { elementType: TAG.Int, items: [{ type: TAG.Int, value: 7 }] } }],
    ]);
    const bytes = writeLevelDat({ storageVersion: 10, rootName: "", root });
    expect(new DataView(bytes.buffer).getInt32(4, true)).toBe(bytes.byteLength - 8);
    const back = readLevelDat(bytes);
    expect(back.storageVersion).toBe(10);
    expect(back.root).toEqual(root);

    enableExperiments(back.root, ["gametest"]);
    const exp = readLevelDat(writeLevelDat(back)).root.get("experiments")!.value as NbtCompound;
    expect([...exp.keys()].sort()).toEqual(["experiments_ever_used", "gametest", "saved_with_toggled_experiments"]);
  });
});
