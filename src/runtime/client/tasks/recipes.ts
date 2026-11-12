/**
 * The recipe index: result item -> the recipes that make it, with their ingredients (items or item tags), their
 * station (crafting grid 2x2 or 3x3, furnace family, stonecutter, smithing table), read from recipe JSON. The vanilla
 * recipes come from the bedrock-samples behavior pack sculkwire already keeps in its cache (`knowledge/samples.ts`,
 * read at run time, never committed); the project's own behavior packs add theirs and replace a vanilla recipe with
 * the same identifier. When no samples are cached the index holds only the project's recipes (or is absent), and the
 * craft step says so and falls back to the game's own lookup on what the inventory holds.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { discoverProject } from "../../../core/project.ts";
import type { Channel } from "../../../core/version.ts";
import { newestCachedSamples } from "../../../knowledge/samples.ts";
import { bareId, namespaced } from "./ids.ts";

export type Ingredient = { item: string } | { tag: string };

/** The stations the steps drive. A recipe tagged only with others (campfire, brewing stand) is left out. */
const STATIONS = ["crafting_table", "furnace", "blast_furnace", "smoker", "stonecutter", "smithing_table"] as const;
export type Station = (typeof STATIONS)[number];

export const FURNACE_STATIONS: readonly Station[] = ["furnace", "blast_furnace", "smoker"];

export interface RecipeInput {
  ingredient: Ingredient;
  /** Items of this ingredient one craft uses. */
  count: number;
}

export interface Recipe {
  /** The recipe's identifier (`minecraft:iron_sword`). */
  id: string;
  kind: "shaped" | "shapeless" | "furnace" | "smithing";
  stations: Station[];
  result: { item: string; count: number };
  /** Each distinct ingredient once, with what one craft uses of it. */
  inputs: RecipeInput[];
  /** Shaped recipes: the pattern as rows of cells (null = empty). */
  grid?: (Ingredient | null)[][];
  /** Smithing transform: the template, base and addition items in their slots. */
  smithing?: { template: string; base: string; addition: string };
  priority: number;
  source: "vanilla" | "project";
}

export function ingredientKey(ingredient: Ingredient): string {
  return "item" in ingredient ? ingredient.item : `#${ingredient.tag}`;
}

export function ingredientText(ingredient: Ingredient): string {
  return "item" in ingredient ? bareId(ingredient.item) : `any ${bareId(ingredient.tag)}`;
}

const LOG = /_(log|wood|stem|hyphae)$/;
const NETHER_WOOD = /^(stripped_)?(crimson|warped)_/;

/**
 * Item tags used in recipe ingredients. Bedrock defines vanilla item tags in the game's item code, not in the behavior
 * pack, so they are listed here by the vanilla id patterns (every tag the bedrock-samples recipes use). A tag not
 * listed matches nothing, and a recipe that needs it cannot be planned.
 */
const TAGS: Record<string, (bare: string) => boolean> = {
  "minecraft:planks": (id) => id.endsWith("_planks"),
  "minecraft:logs": (id) => LOG.test(id),
  "minecraft:logs_that_burn": (id) => LOG.test(id) && !NETHER_WOOD.test(id),
  "minecraft:wooden_slabs": (id) => /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_slab$/.test(id) || id === "bamboo_mosaic_slab",
  "minecraft:coals": (id) => id === "coal" || id === "charcoal",
  "minecraft:stone_crafting_materials": (id) => id === "cobblestone" || id === "blackstone" || id === "cobbled_deepslate",
  "minecraft:stone_tool_materials": (id) => id === "cobblestone" || id === "blackstone" || id === "cobbled_deepslate",
  "minecraft:wool": (id) => id.endsWith("_wool"),
  "minecraft:metal_nuggets": (id) => id === "iron_nugget" || id === "gold_nugget" || id === "copper_nugget",
  "minecraft:egg": (id) => id === "egg" || id === "brown_egg" || id === "blue_egg",
  "minecraft:mushrooms_for_stew": (id) => id === "red_mushroom" || id === "brown_mushroom",
  "minecraft:soul_fire_base_blocks": (id) => id === "soul_sand" || id === "soul_soil",
  "minecraft:is_pickaxe": (id) => id.endsWith("_pickaxe"),
};

/** Whether the item id is in the tag. Only vanilla (`minecraft:`) items are members of the vanilla tags. */
export function inTag(tag: string, item: string): boolean {
  const test = TAGS[namespaced(tag)];
  if (!test) return false;
  return namespaced(item).startsWith("minecraft:") && test(bareId(item));
}

export function matches(ingredient: Ingredient, item: string): boolean {
  return "item" in ingredient ? ingredient.item === namespaced(item) : inTag(ingredient.tag, item);
}

/**
 * Furnace fuels, best first, with the items each one smelts. The values are the vanilla burn times divided by the
 * 10 s one item takes (Minecraft Wiki, "Smelting" fuel table for Bedrock Edition); the game keeps them in code, not in
 * the behavior pack. Only common fuels are listed: anything else is not used as fuel.
 */
export const FUELS: readonly { match: (bare: string) => boolean; label: string; smelts: number }[] = [
  { match: (id) => id === "coal", label: "coal", smelts: 8 },
  { match: (id) => id === "charcoal", label: "charcoal", smelts: 8 },
  { match: (id) => id === "coal_block", label: "coal_block", smelts: 80 },
  { match: (id) => id === "blaze_rod", label: "blaze_rod", smelts: 12 },
  { match: (id) => id === "dried_kelp_block", label: "dried_kelp_block", smelts: 20 },
  { match: (id) => id.endsWith("_planks") && !NETHER_WOOD.test(id), label: "planks", smelts: 1.5 },
  { match: (id) => LOG.test(id) && !NETHER_WOOD.test(id), label: "logs", smelts: 1.5 },
  { match: (id) => id === "stick", label: "stick", smelts: 0.5 },
];

/** How many items one of `item` smelts as fuel, or undefined when it is not a listed fuel. */
export function fuelValue(item: string): number | undefined {
  if (!namespaced(item).startsWith("minecraft:")) return undefined;
  const bare = bareId(item);
  return FUELS.find((fuel) => fuel.match(bare))?.smelts;
}

/** The rank of a fuel in `FUELS` (lower is preferred), Infinity for a non-fuel. */
export function fuelRank(item: string): number {
  if (!namespaced(item).startsWith("minecraft:")) return Number.POSITIVE_INFINITY;
  const bare = bareId(item);
  const rank = FUELS.findIndex((fuel) => fuel.match(bare));
  return rank < 0 ? Number.POSITIVE_INFINITY : rank;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * An item reference: `"minecraft:stick"`, `"stick"`, `"minecraft:wool:3"` or `{item, data?, count?}`. A data value
 * other than 0 is an aux variant the steps cannot tell apart in the inventory, so it reads as undefined.
 */
function itemRef(value: unknown): { item: string; count: number } | undefined {
  let id: string | undefined;
  let data: unknown;
  let count = 1;
  if (typeof value === "string") {
    id = value;
  } else {
    const r = record(value);
    if (!r || typeof r.item !== "string") return undefined;
    id = r.item;
    data = r.data;
    if (typeof r.count === "number" && Number.isInteger(r.count) && r.count > 0) count = r.count;
  }
  const parts = id.trim().split(":");
  if (parts.length === 3 || (parts.length === 2 && /^\d+$/.test(parts[1] ?? ""))) {
    data = Number(parts.pop());
  }
  if (data !== undefined && data !== 0) return undefined;
  const bare = parts.join(":");
  if (!bare) return undefined;
  return { item: namespaced(bare), count };
}

function ingredientOf(value: unknown): { ingredient: Ingredient; count: number } | undefined {
  const r = record(value);
  if (r && typeof r.tag === "string") {
    const count = typeof r.count === "number" && Number.isInteger(r.count) && r.count > 0 ? r.count : 1;
    return { ingredient: { tag: namespaced(r.tag) }, count };
  }
  const ref = itemRef(value);
  return ref ? { ingredient: { item: ref.item }, count: ref.count } : undefined;
}

function resultOf(value: unknown): { item: string; count: number } | undefined {
  return itemRef(Array.isArray(value) ? value[0] : value);
}

function stationsOf(tags: unknown): Station[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is Station => typeof tag === "string" && (STATIONS as readonly string[]).includes(tag));
}

function addInput(inputs: RecipeInput[], ingredient: Ingredient, count: number): void {
  const key = ingredientKey(ingredient);
  const found = inputs.find((input) => ingredientKey(input.ingredient) === key);
  if (found) found.count += count;
  else inputs.push({ ingredient, count });
}

/** One recipe file's recipe, or undefined when it is not one the steps can plan (deprecated, aux data, brewing). */
export function parseRecipe(text: string, source: Recipe["source"]): Recipe | undefined {
  const root = record(parseJsonc(text, [], { allowTrailingComma: true }));
  if (!root) return undefined;
  for (const [key, value] of Object.entries(root)) {
    const body = record(value);
    if (!body || key === "format_version") continue;
    const id = record(body.description)?.identifier;
    if (typeof id !== "string") return undefined;
    const stations = stationsOf(body.tags);
    if (!stations.length) return undefined;
    const priority = typeof body.priority === "number" ? body.priority : 0;
    const base = { id: namespaced(id), stations, priority, source };
    if (key === "minecraft:recipe_shaped") {
      const pattern = Array.isArray(body.pattern) ? body.pattern.filter((row): row is string => typeof row === "string") : [];
      const keys = record(body.key) ?? {};
      const result = resultOf(body.result);
      if (!pattern.length || !result) return undefined;
      const inputs: RecipeInput[] = [];
      const grid: (Ingredient | null)[][] = [];
      for (const row of pattern) {
        const cells: (Ingredient | null)[] = [];
        for (const symbol of row) {
          if (symbol === " ") {
            cells.push(null);
            continue;
          }
          const found = ingredientOf(keys[symbol]);
          if (!found) return undefined;
          cells.push(found.ingredient);
          addInput(inputs, found.ingredient, 1);
        }
        grid.push(cells);
      }
      return { ...base, kind: "shaped", result, inputs, grid };
    }
    if (key === "minecraft:recipe_shapeless") {
      const list = Array.isArray(body.ingredients) ? body.ingredients : [];
      const result = resultOf(body.result);
      if (!list.length || !result) return undefined;
      const inputs: RecipeInput[] = [];
      for (const entry of list) {
        const found = ingredientOf(entry);
        if (!found) return undefined;
        addInput(inputs, found.ingredient, found.count);
      }
      return { ...base, kind: "shapeless", result, inputs };
    }
    if (key === "minecraft:recipe_furnace") {
      const input = ingredientOf(body.input);
      const output = resultOf(body.output);
      if (!input || !output) return undefined;
      return { ...base, kind: "furnace", result: output, inputs: [{ ingredient: input.ingredient, count: 1 }] };
    }
    if (key === "minecraft:recipe_smithing_transform") {
      const template = itemRef(body.template);
      const baseItem = itemRef(body.base);
      const addition = itemRef(body.addition);
      const result = resultOf(body.result);
      if (!template || !baseItem || !addition || !result) return undefined;
      return {
        ...base,
        kind: "smithing",
        result,
        inputs: [
          { ingredient: { item: template.item }, count: 1 },
          { ingredient: { item: baseItem.item }, count: 1 },
          { ingredient: { item: addition.item }, count: 1 },
        ],
        smithing: { template: template.item, base: baseItem.item, addition: addition.item },
      };
    }
    return undefined;
  }
  return undefined;
}

/** How many grid cells a crafting recipe needs, and whether it fits the inventory's 2x2 grid. */
export function fitsInventoryGrid(recipe: Recipe): boolean {
  if (recipe.kind === "shaped") {
    const grid = recipe.grid ?? [];
    return grid.length <= 2 && grid.every((row) => row.length <= 2);
  }
  if (recipe.kind === "shapeless") return recipe.inputs.reduce((sum, input) => sum + input.count, 0) <= 4;
  return false;
}

export class RecipeIndex {
  readonly #byResult = new Map<string, Recipe[]>();
  readonly #byInput = new Map<string, Recipe[]>();
  readonly #items = new Set<string>();
  /** Where the recipes came from, for messages: `bedrock-samples v1.26.60.5 and 3 project recipes`. */
  readonly source: string;

  constructor(recipes: Iterable<Recipe>, source = "the given recipes") {
    this.source = source;
    const byId = new Map<string, Recipe>();
    for (const recipe of recipes) {
      const known = byId.get(recipe.id);
      if (!known || recipe.source === "project" || known.source === "vanilla") byId.set(recipe.id, recipe);
    }
    for (const recipe of byId.values()) {
      const list = this.#byResult.get(recipe.result.item) ?? [];
      list.push(recipe);
      this.#byResult.set(recipe.result.item, list);
      this.#items.add(recipe.result.item);
      for (const input of recipe.inputs) {
        if (!("item" in input.ingredient)) continue;
        this.#items.add(input.ingredient.item);
        if (recipe.kind !== "furnace") continue;
        const from = this.#byInput.get(input.ingredient.item) ?? [];
        from.push(recipe);
        this.#byInput.set(input.ingredient.item, from);
      }
    }
    // Higher priority first (the game's own order among recipes that match), then by id so the order is stable.
    const order = (a: Recipe, b: Recipe) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const list of this.#byResult.values()) list.sort(order);
    for (const list of this.#byInput.values()) list.sort(order);
  }

  get size(): number {
    let n = 0;
    for (const list of this.#byResult.values()) n += list.length;
    return n;
  }

  /** Every recipe that makes `item`. */
  recipesFor(item: string): Recipe[] {
    return this.#byResult.get(namespaced(item)) ?? [];
  }

  /** Furnace-family recipes that take `item` as input (tag inputs such as logs included). */
  smeltingFrom(item: string): Recipe[] {
    const id = namespaced(item);
    const direct = this.#byInput.get(id) ?? [];
    const tagged: Recipe[] = [];
    for (const list of this.#byResult.values()) {
      for (const recipe of list) {
        const input = recipe.inputs[0]?.ingredient;
        if (recipe.kind === "furnace" && input && "tag" in input && inTag(input.tag, id)) tagged.push(recipe);
      }
    }
    return [...direct, ...tagged];
  }

  /** Every item id a recipe makes or takes by name. */
  items(): Iterable<string> {
    return this.#items;
  }
}

/** Every `*.json` file under `dir`, recursively; a missing folder is none. */
async function jsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsonFiles(path)));
    else if (/\.json$/i.test(entry.name)) out.push(path);
  }
  return out;
}

async function readRecipes(dir: string, source: Recipe["source"]): Promise<Recipe[]> {
  const out: Recipe[] = [];
  for (const file of await jsonFiles(dir)) {
    const text = await readFile(file, "utf8").catch(() => undefined);
    const recipe = text === undefined ? undefined : parseRecipe(text, source);
    if (recipe) out.push(recipe);
  }
  return out;
}

export interface LoadRecipesOptions {
  channel: Channel;
  /** The project folder the bridge deploys; its behavior packs' `recipes/` add to (and override) the vanilla ones. */
  project?: string;
}

/**
 * The index from the newest cached bedrock-samples behavior pack of the channel (no network: a step never waits on a
 * download) plus the project's behavior packs. `note` says what is missing when the vanilla recipes are.
 */
export async function loadRecipeIndex(options: LoadRecipesOptions): Promise<{ index?: RecipeIndex; note?: string }> {
  const samples = await newestCachedSamples(options.channel, ["behavior_pack"]).catch(() => undefined);
  const vanilla = samples ? await readRecipes(join(samples.root, "behavior_pack", "recipes"), "vanilla") : [];
  const project: Recipe[] = [];
  if (options.project) {
    const layout = await discoverProject(options.project).catch(() => undefined);
    for (const pack of layout?.packs ?? []) {
      if (pack.kind === "behavior") project.push(...(await readRecipes(join(pack.dir, "recipes"), "project")));
    }
  }
  const parts = [samples ? `bedrock-samples ${samples.tag}` : undefined, project.length ? `${project.length} project recipes` : undefined].filter(Boolean);
  const note = samples ? undefined : `no bedrock-samples behavior pack is cached for the ${options.channel} channel (run any knowledge lookup online once)`;
  if (!vanilla.length && !project.length) return { note: note ?? "no recipes were found" };
  return { index: new RecipeIndex([...vanilla, ...project], parts.join(" and ")), ...(note ? { note } : {}) };
}
