import { describe, expect, it } from "vitest";
import { dimensionName, dimensionSchema } from "./dimension.ts";

describe("dimensions", () => {
  it("reads a dimension as the bare name, the minecraft: id or the numeric id", () => {
    expect(["overworld", "minecraft:overworld", 0, "0"].map((d) => dimensionName(d))).toEqual(["overworld", "overworld", "overworld", "overworld"]);
    expect(["the_end", "minecraft:the_end", 2, "2"].map((d) => dimensionName(d))).toEqual(["the_end", "the_end", "the_end", "the_end"]);
    expect(["end", "minecraft:", 3, -1, 1.5, ""].map((d) => dimensionName(d))).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    for (const accepted of ["nether", "minecraft:nether", 1]) expect(dimensionSchema.safeParse(accepted).success).toBe(true);
    for (const refused of ["Nether", "minecraft:aether", 3, 1.5]) expect(dimensionSchema.safeParse(refused).success).toBe(false);
  });
});
