import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fitsInventoryGrid, fuelValue, inTag, loadRecipeIndex, parseRecipe, RecipeIndex, type Recipe } from "./recipes.ts";

/** Recipe fixtures written for these tests in the behavior pack's recipe format (comments and trailing commas too). */
const STICK = `{
  "format_version": "1.20.10",
  // planks of any wood
  "minecraft:recipe_shaped": {
    "description": { "identifier": "test:stick" },
    "tags": [ "crafting_table" ],
    "pattern": [ "A", "A", ],
    "key": { "A": { "tag": "minecraft:planks" } },
    "result": { "item": "stick", "count": 4 }
  }
}`;
const SOUP = JSON.stringify({
  format_version: "1.20.10",
  "minecraft:recipe_shapeless": {
    description: { identifier: "test:soup" },
    tags: ["crafting_table"],
    ingredients: [{ item: "minecraft:bowl" }, { item: "minecraft:beetroot", count: 6 }],
    result: [{ item: "minecraft:beetroot_soup" }],
  },
});
const SMELT = JSON.stringify({
  format_version: "1.20.10",
  "minecraft:recipe_furnace": { description: { identifier: "test:smelt" }, tags: ["furnace", "campfire"], input: { tag: "minecraft:logs_that_burn" }, output: "minecraft:charcoal" },
});
const AUX = JSON.stringify({ "minecraft:recipe_furnace": { description: { identifier: "test:aux" }, tags: ["furnace"], input: "minecraft:wood:4", output: "minecraft:charcoal" } });
const OLD = JSON.stringify({ "minecraft:recipe_furnace": { description: { identifier: "test:old" }, tags: ["deprecated"], input: "minecraft:stone", output: "minecraft:smooth_stone" } });
const SMITH = JSON.stringify({
  "minecraft:recipe_smithing_transform": {
    description: { identifier: "test:smith" },
    tags: ["smithing_table"],
    template: "minecraft:netherite_upgrade_smithing_template",
    base: "minecraft:diamond_sword",
    addition: "minecraft:netherite_ingot",
    result: "minecraft:netherite_sword",
  },
});

function parsed(text: string): Recipe {
  const recipe = parseRecipe(text, "vanilla");
  if (!recipe) throw new Error("fixture did not parse");
  return recipe;
}

describe("parseRecipe", () => {
  it("reads a shaped recipe with a tag, comments and a namespace-less result", () => {
    const recipe = parsed(STICK);
    expect(recipe).toMatchObject({ id: "test:stick", kind: "shaped", stations: ["crafting_table"], result: { item: "minecraft:stick", count: 4 } });
    expect(recipe.inputs).toEqual([{ ingredient: { tag: "minecraft:planks" }, count: 2 }]);
    expect(fitsInventoryGrid(recipe)).toBe(true);
  });

  it("reads shapeless counts, a result array, furnace tag inputs and smithing transforms", () => {
    const soup = parsed(SOUP);
    expect(soup.inputs).toEqual([
      { ingredient: { item: "minecraft:bowl" }, count: 1 },
      { ingredient: { item: "minecraft:beetroot" }, count: 6 },
    ]);
    expect(soup.result).toEqual({ item: "minecraft:beetroot_soup", count: 1 });
    expect(fitsInventoryGrid(soup)).toBe(false);
    expect(parsed(SMELT)).toMatchObject({ kind: "furnace", stations: ["furnace"], inputs: [{ ingredient: { tag: "minecraft:logs_that_burn" }, count: 1 }] });
    expect(parsed(SMITH).smithing).toEqual({ template: "minecraft:netherite_upgrade_smithing_template", base: "minecraft:diamond_sword", addition: "minecraft:netherite_ingot" });
  });

  it("leaves out aux-data variants and deprecated recipes", () => {
    expect(parseRecipe(AUX, "vanilla")).toBeUndefined();
    expect(parseRecipe(OLD, "vanilla")).toBeUndefined();
  });
});

describe("tags and fuels", () => {
  it("resolves the vanilla item tags the recipes use", () => {
    expect(inTag("minecraft:planks", "minecraft:cherry_planks")).toBe(true);
    expect(inTag("minecraft:logs_that_burn", "minecraft:oak_log")).toBe(true);
    expect(inTag("minecraft:logs_that_burn", "minecraft:crimson_stem")).toBe(false);
    expect(inTag("minecraft:logs", "minecraft:crimson_stem")).toBe(true);
    expect(inTag("minecraft:coals", "minecraft:charcoal")).toBe(true);
    expect(inTag("minecraft:planks", "custom:oak_planks")).toBe(false);
  });

  it("knows what a fuel smelts", () => {
    expect(fuelValue("minecraft:coal")).toBe(8);
    expect(fuelValue("minecraft:oak_planks")).toBe(1.5);
    expect(fuelValue("minecraft:crimson_planks")).toBeUndefined();
    expect(fuelValue("minecraft:diamond")).toBeUndefined();
  });
});

describe("RecipeIndex", () => {
  it("finds recipes by result and furnace recipes by input, tags included", () => {
    const index = new RecipeIndex([parsed(STICK), parsed(SMELT)]);
    expect(index.recipesFor("stick").map((recipe) => recipe.id)).toEqual(["test:stick"]);
    expect(index.smeltingFrom("minecraft:birch_log").map((recipe) => recipe.result.item)).toEqual(["minecraft:charcoal"]);
    expect(index.size).toBe(2);
  });
});

describe("loadRecipeIndex", () => {
  const saved = process.env.SCULKWIRE_CACHE;
  let dir = "";
  afterEach(async () => {
    if (saved === undefined) delete process.env.SCULKWIRE_CACHE;
    else process.env.SCULKWIRE_CACHE = saved;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reads the cached samples' recipes and lets the project's own recipe with the same id replace one", async () => {
    dir = await mkdtemp(join(tmpdir(), "sculkwire-recipes-"));
    process.env.SCULKWIRE_CACHE = join(dir, "cache");
    const samples = join(dir, "cache", "knowledge", "samples", "v1.26.60.5");
    await mkdir(join(samples, "behavior_pack", "recipes"), { recursive: true });
    await writeFile(join(samples, ".sculkwire-samples.json"), JSON.stringify({ tag: "v1.26.60.5", commit: "0", parts: ["behavior_pack"], images: false }));
    await writeFile(join(samples, "behavior_pack", "recipes", "stick.json"), STICK);
    await writeFile(join(samples, "behavior_pack", "recipes", "soup.json"), SOUP);
    const pack = join(dir, "project", "BP");
    await mkdir(join(pack, "recipes", "nested"), { recursive: true });
    await writeFile(join(pack, "manifest.json"), JSON.stringify({ format_version: 2, header: { name: "t", uuid: "00000000-0000-4000-8000-000000000001", version: [1, 0, 0] }, modules: [{ type: "data", uuid: "00000000-0000-4000-8000-000000000002", version: [1, 0, 0] }] }));
    await writeFile(join(pack, "recipes", "nested", "stick.json"), STICK.replace('"count": 4', '"count": 8'));
    const { index, note } = await loadRecipeIndex({ channel: "stable", project: join(dir, "project") });
    expect(note).toBeUndefined();
    expect(index?.source).toBe("bedrock-samples v1.26.60.5 and 1 project recipes");
    expect(index?.recipesFor("minecraft:stick")[0]?.result.count).toBe(8);
    expect(index?.recipesFor("minecraft:beetroot_soup")).toHaveLength(1);
  });

  it("says why when no samples are cached", async () => {
    dir = await mkdtemp(join(tmpdir(), "sculkwire-recipes-"));
    process.env.SCULKWIRE_CACHE = join(dir, "cache");
    const { index, note } = await loadRecipeIndex({ channel: "preview" });
    expect(index).toBeUndefined();
    expect(note).toContain("no bedrock-samples behavior pack is cached for the preview channel");
  });
});
