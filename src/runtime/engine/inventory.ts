/**
 * Player attributes, inventory, containers and crafting through the in-game agent, plus the helper-pack fallback for
 * the two reads the Script API can answer on its own.
 *
 * The agent answers `player.attributes`, `player.inventory`, `container.get`, `container.open` and `craft.match` from
 * the game's own data, and a craft runs as the screen action `screen act craft` (`workstation.ts`), so a durability,
 * an enchantment or a container beyond the Script API's reach is the game's value, not a reconstruction. Every answer
 * is parsed into the shapes below before it is trusted: a slot's id is namespaced, a count is a whole number, a
 * damage is clamped into its own maximum.
 *
 * Without an attached agent, `player_inventory` and `container get` ask the helper pack instead
 * (`/scriptevent sculkwire:query`, answered by `src/runtime/client/helper-pack/scripts/main.js`): the Script API's
 * inventory, equippable and block inventory components. That answer is marked `source: "script"` and says only what
 * the Script API exposes — no item aux value, no bundle contents, no cursor stack, and attributes only for the
 * components the running game has. Crafting has no Script API equivalent, so `craft` needs the agent and says so.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CliCommand } from "../../core/cli.ts";
import { ExitCode } from "../../core/diagnostic.ts";
import { bridge, HelperQueryError } from "../client/bridge.ts";
import {
  engine,
  isSetupFailure,
  type EngineFailure,
  type EngineFailureReason,
  type EngineResult,
  type EngineSession,
} from "./engine.ts";
import { dimensionName, dimensionParam, dimensionSchema, itemSlotSchema, screenAct } from "./workstation.ts";

/** A container walk touches every slot; a craft runs the game's own recipe request. Both deserve more than 15 s. */
const CONTAINER_TIMEOUT_MS = 20_000;
const CRAFT_TIMEOUT_MS = 60_000;

/** Where an answer came from: the agent's own reads, or the helper pack's Script API components. */
export type InventorySource = "engine" | "script";

/** One enchantment on an item: the game's `minecraft:` id and its level (1 = I). */
export interface ItemEnchantment {
  id: string;
  level: number;
}

/** A durability-bearing item: `damage` points taken out of `max`. */
export interface ItemDurability {
  damage: number;
  max: number;
}

/**
 * One inventory slot's contents. `item` is always namespaced; `enchantments` is always present (empty when the item
 * has none) so a reader never has to tell "no enchantments" from "not reported". `contents` holds what is inside a
 * bundle or a shulker box, when the engine can read it.
 */
export interface ItemSlot {
  item: string;
  count: number;
  data?: number;
  name?: string;
  durability?: ItemDurability;
  enchantments: ItemEnchantment[];
  lore?: string[];
  /** What a bundle or a shulker box item holds, in the slot shape the contract uses everywhere. */
  contents?: Slot[];
}

/** A slot, or null when it is empty. */
export type Slot = ItemSlot | null;

export interface ArmorSlots {
  head: Slot;
  chest: Slot;
  legs: Slot;
  feet: Slot;
}

/**
 * The player's whole inventory. Array indices are 0-based, as the engine and the Script API report them; `selectedSlot`
 * is the hotbar slot 1 to 9 (`hotbar[selectedSlot - 1]`), the number `player_state` and `player_act select_slot` use.
 */
export interface PlayerInventory {
  selectedSlot: number;
  hotbar: Slot[];
  inventory: Slot[];
  armor: ArmorSlots;
  offhand: Slot;
  cursor: Slot;
}

/**
 * One player attribute. `current` is always there; `min`, `max`, `default` and `base` are the game's own values where
 * they exist. `base` is the value before modifiers (movement 0.1 while sprinting raises `current`). The agent reports
 * all five; the helper pack reports what the Script API's component knows.
 */
export interface PlayerAttribute {
  current: number;
  min?: number;
  max?: number;
  default?: number;
  base?: number;
}

export type PlayerAttributes = Record<string, PlayerAttribute>;

/** Attributes and inventory from one route, named, so a caller can tell a script answer from the agent's. */
export interface PlayerInventoryState {
  source: InventorySource;
  attributes: PlayerAttributes;
  inventory: PlayerInventory;
}

/** A block position; `dimension` is a dimension (`nether`, `minecraft:nether` or 1), sent to the agent as its bare name. */
export interface BlockRef {
  x: number;
  y: number;
  z: number;
  dimension?: string | number;
}

/** What a block's container holds. `slots` is exactly `size` entries, empty ones as null. */
export interface ContainerView {
  block: string | null;
  size: number;
  slots: Slot[];
}

/** The container screen the player has open, with its own slots and the player's inventory beside it. */
export interface OpenContainer {
  screen: string;
  /** The block the screen belongs to and where it stands; both null for an entity's screen or the inventory. */
  block: string | null;
  position: { x: number; y: number; z: number } | null;
  slots: Slot[];
  playerSlots: Slot[];
}

/** One recipe the game matched: its id, its type (`shaped`, `shapeless`, `furnace`, ...) and its tag when it has one. */
export interface CraftRecipe {
  id: string;
  type: string;
  tag?: string;
}

/** What `craft.match` answers. `result` is null when nothing in the game matches. */
export interface CraftMatch {
  result: Slot;
  recipe: CraftRecipe | null;
}

/** What a craft run did: how many items it made, what it made and what it took. */
export interface CraftRun {
  crafted: number;
  result: Slot;
  consumed: Slot[];
}

/** A craft to look up: a 3x3 grid (a 2x2 is padded) or a shapeless ingredient list, and whether a table is open. */
export interface CraftRequest {
  grid?: (string | null)[][];
  ingredients?: string[];
  table?: boolean;
}

function invalid(messageText: string): EngineFailure {
  return { ok: false, code: -32602, reason: "invalid_params", message: messageText };
}

/** The agent answered with a shape this client does not know, so the value cannot be trusted. */
function malformed(method: string, value: unknown): EngineFailure {
  return { ok: false, code: -32000, reason: "protocol", message: `${method} answered ${JSON.stringify(value)}` };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function whole(value: unknown): number | undefined {
  const n = finite(value);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

/** `minecraft:` for an id written without a namespace of its own (`oak_planks`). */
export function itemId(raw: string): string {
  const id = raw.trim();
  return id.includes(":") ? id : `minecraft:${id}`;
}

/** An item id on a command line or in a grid, or undefined when it is empty. */
function itemName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const id = raw.trim();
  return id ? itemId(id) : undefined;
}

function durabilityOf(raw: unknown): ItemDurability | undefined {
  if (!isRecord(raw)) return undefined;
  const damage = finite(raw.damage);
  const max = finite(raw.max);
  // A maximum is what gives damage meaning; without it the pair is not reported.
  if (damage === undefined || max === undefined || max < 1) return undefined;
  return { damage: Math.min(Math.max(0, Math.round(damage)), Math.round(max)), max: Math.round(max) };
}

/**
 * Bedrock's numeric enchantment ids (the order the game keeps in item data and the network protocol), indexed by
 * id. The names are the Script API's `minecraft:` enchantment type ids.
 */
const ENCHANTMENT_IDS = [
  "protection", "fire_protection", "feather_falling", "blast_protection", "projectile_protection", "thorns",
  "respiration", "depth_strider", "aqua_affinity", "sharpness", "smite", "bane_of_arthropods", "knockback",
  "fire_aspect", "looting", "efficiency", "silk_touch", "unbreaking", "fortune", "power", "punch", "flame",
  "infinity", "luck_of_the_sea", "lure", "frost_walker", "mending", "binding", "vanishing", "impaling", "riptide",
  "loyalty", "channeling", "multishot", "piercing", "quick_charge", "soul_speed", "swift_sneak", "wind_burst",
  "density", "breach",
] as const;

/** A numeric enchantment id's name; an id past the table reads `minecraft:unknown_<n>` so the level is not lost. */
export function enchantmentName(id: number): string {
  return `minecraft:${ENCHANTMENT_IDS[id] ?? `unknown_${id}`}`;
}

/**
 * The game's enchantment shape (`{id, level}`, `id` numeric or a name), and the Script API's (`{type: {id}, level}`).
 */
export function enchantmentsOf(raw: unknown): ItemEnchantment[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return undefined;
  const out: ItemEnchantment[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const numeric = typeof entry.id === "number" ? whole(entry.id) : undefined;
    const id =
      numeric !== undefined && numeric >= 0
        ? enchantmentName(numeric)
        : (itemName(entry.id) ??
          (typeof entry.type === "string" ? itemName(entry.type) : isRecord(entry.type) ? itemName(entry.type.id) : undefined));
    if (!id) continue;
    const level = whole(entry.level) ?? 1;
    out.push({ id, level: Math.max(1, level) });
  }
  return out;
}

function loreOf(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((line): line is string => typeof line === "string" && line.length > 0);
}

/** A slot: null is empty, undefined is a shape this client cannot read. */
export function parseSlot(raw: unknown): Slot | undefined {
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;
  const item = itemName(raw.item);
  if (!item) return undefined;
  const count = raw.count === undefined ? 1 : whole(raw.count);
  if (count === undefined || count < 1) return undefined;
  const enchantments = enchantmentsOf(raw.enchantments);
  const durability = durabilityOf(raw.durability);
  const lore = loreOf(raw.lore);
  if (!enchantments || !lore) return undefined;
  const slot: ItemSlot = { item, count, enchantments };
  const data = whole(raw.data);
  if (data !== undefined && data >= 0) slot.data = data;
  if (typeof raw.name === "string" && raw.name.trim()) slot.name = raw.name;
  if (durability) slot.durability = durability;
  if (lore.length) slot.lore = lore;
  if (raw.contents !== undefined) {
    const contents = parseSlots(raw.contents);
    if (!contents) return undefined;
    slot.contents = contents;
  }
  return slot;
}

export function parseSlots(raw: unknown): Slot[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Slot[] = [];
  for (const entry of raw) {
    const slot = parseSlot(entry);
    if (slot === undefined) return undefined;
    out.push(slot);
  }
  return out;
}

export function parseInventory(raw: unknown): PlayerInventory | undefined {
  if (!isRecord(raw)) return undefined;
  // Both sources count from 0 (the engine and `selectedSlotIndex`); the result counts hotbar slots 1 to 9.
  const index = raw.selectedSlot === undefined ? 0 : whole(raw.selectedSlot);
  if (index === undefined || index < 0) return undefined;
  const selectedSlot = index + 1;
  const hotbar = parseSlots(raw.hotbar);
  const inventory = parseSlots(raw.inventory);
  if (!hotbar || !inventory) return undefined;
  const armor = isRecord(raw.armor) ? raw.armor : {};
  const slot = (value: unknown): Slot | undefined => (value === undefined ? null : parseSlot(value));
  const head = slot(armor.head);
  const chest = slot(armor.chest);
  const legs = slot(armor.legs);
  const feet = slot(armor.feet);
  const offhand = slot(raw.offhand);
  const cursor = slot(raw.cursor);
  if (head === undefined || chest === undefined || legs === undefined || feet === undefined) return undefined;
  if (offhand === undefined || cursor === undefined) return undefined;
  return { selectedSlot, hotbar, inventory, armor: { head, chest, legs, feet }, offhand, cursor };
}

export function parseAttribute(raw: unknown): PlayerAttribute | undefined {
  if (!isRecord(raw)) return undefined;
  const current = finite(raw.current);
  if (current === undefined) return undefined;
  const attribute: PlayerAttribute = { current };
  const min = finite(raw.min);
  const max = finite(raw.max);
  const fallback = finite(raw.default);
  const base = finite(raw.base);
  if (min !== undefined) attribute.min = min;
  if (max !== undefined) attribute.max = max;
  if (fallback !== undefined) attribute.default = fallback;
  if (base !== undefined) attribute.base = base;
  return attribute;
}

/**
 * The agent answers the derived `armor` and `armorToughness` as bare numbers (`null` when the game's own function
 * cannot value the worn pieces); they become `{current}` like the helper pack's, and a `null` is left out.
 */
const DERIVED_ATTRIBUTES: Readonly<Record<string, true>> = { armor: true, armorToughness: true };

export function parseAttributes(raw: unknown): PlayerAttributes | undefined {
  if (!isRecord(raw)) return undefined;
  const out: PlayerAttributes = {};
  for (const [name, value] of Object.entries(raw)) {
    if (DERIVED_ATTRIBUTES[name] && (value === null || typeof value === "number")) {
      const current = finite(value);
      if (current !== undefined) out[name] = { current };
      continue;
    }
    const attribute = parseAttribute(value);
    if (!attribute) return undefined;
    out[name] = attribute;
  }
  return out;
}

/** A container answer: `slots` is made exactly as long as the game's `size`, so a reader can index it. */
export function parseContainer(raw: unknown): ContainerView | undefined {
  if (!isRecord(raw)) return undefined;
  const slots = parseSlots(raw.slots);
  if (!slots) return undefined;
  const size = whole(raw.size) ?? slots.length;
  if (size < 0) return undefined;
  const block = itemName(raw.block) ?? null;
  if (slots.length > size) slots.length = size;
  while (slots.length < size) slots.push(null);
  return { block, size, slots };
}

export function parseOpenContainer(raw: unknown): OpenContainer | undefined {
  if (!isRecord(raw)) return undefined;
  const screen = typeof raw.screen === "string" ? raw.screen.trim() : "";
  if (!screen) return undefined;
  const slots = parseSlots(raw.slots);
  const playerSlots = parseSlots(raw.playerSlots);
  if (!slots || !playerSlots) return undefined;
  const at = Array.isArray(raw.position) && raw.position.length === 3 && raw.position.every(Number.isInteger) ? (raw.position as number[]) : null;
  const position = at ? { x: at[0] as number, y: at[1] as number, z: at[2] as number } : null;
  return { screen, block: itemName(raw.block) ?? null, position, slots, playerSlots };
}

function parseRecipe(raw: unknown): CraftRecipe | undefined {
  if (!isRecord(raw)) return undefined;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return undefined;
  const type = typeof raw.type === "string" && raw.type.trim() ? raw.type.trim() : "unknown";
  const tag = itemName(raw.tag);
  return { id, type, ...(tag ? { tag } : {}) };
}

/** `craft.match`: a null result is a real answer (nothing matches), so the key itself must be there. */
export function parseCraftMatch(raw: unknown): CraftMatch | undefined {
  if (!isRecord(raw) || raw.result === undefined) return undefined;
  const result = parseSlot(raw.result);
  if (result === undefined) return undefined;
  const recipe = raw.recipe === undefined ? null : raw.recipe === null ? null : parseRecipe(raw.recipe);
  if (recipe === undefined) return undefined;
  return { result, recipe };
}

/** A grid as the engine takes it: exactly 3 rows of exactly 3 cells, short rows padded with null. */
export function normalizeGrid(grid: unknown): (string | null)[][] | undefined {
  if (!Array.isArray(grid) || grid.length === 0 || grid.length > 3) return undefined;
  const rows: (string | null)[][] = [];
  for (const row of grid) {
    if (!Array.isArray(row) || row.length === 0 || row.length > 3) return undefined;
    const cells: (string | null)[] = [];
    for (const cell of row) {
      if (cell === null || cell === undefined || cell === "") cells.push(null);
      else {
        const id = itemName(cell);
        if (!id) return undefined;
        cells.push(id);
      }
    }
    while (cells.length < 3) cells.push(null);
    rows.push(cells);
  }
  while (rows.length < 3) rows.push([null, null, null]);
  return rows;
}

/** A `--grid` argument: rows separated by `;` or `/`, cells by `,`, an empty cell or `-` for nothing. */
export function parseCraftGrid(text: string): (string | null)[][] | undefined {
  const rows = text
    .split(/[;/]/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0);
  const grid = rows.map((row) =>
    row
      .split(",")
      .map((cell) => cell.trim())
      .map((cell) => (cell === "-" ? null : cell)),
  );
  return normalizeGrid(grid);
}

/** `craft.match` parameters, or why the request cannot be expressed. */
export function craftMatchParams(request: CraftRequest): Record<string, unknown> | string {
  const hasGrid = request.grid !== undefined;
  const hasIngredients = request.ingredients !== undefined;
  if (hasGrid === hasIngredients) return "give exactly one of grid or ingredients";
  if (request.table !== undefined && typeof request.table !== "boolean") return "table must be a boolean";
  const table = request.table === true ? { table: true } : {};
  if (hasGrid) {
    const grid = normalizeGrid(request.grid);
    if (!grid) return "grid must be 1 to 3 rows of 1 to 3 item ids or nulls";
    return { grid, ...table };
  }
  const raw = request.ingredients ?? [];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 9) return "ingredients must be 1 to 9 item ids";
  const ingredients: string[] = [];
  for (const entry of raw) {
    const id = itemName(entry);
    if (!id) return "every ingredient must be an item id";
    ingredients.push(id);
  }
  return { ingredients, ...table };
}

/** `player.attributes`: every attribute the player has, plus the armour values the game derives. */
export async function playerAttributes(session: EngineSession = engine): Promise<EngineResult<PlayerAttributes>> {
  const result = await session.call<unknown>("player.attributes", {});
  if (!result.ok) return result;
  const attributes = parseAttributes(result.value);
  return attributes ? { ok: true, value: attributes } : malformed("player.attributes", result.value);
}

/** `player.inventory`: hotbar, main inventory, armour, offhand and cursor stack. */
export async function playerInventory(session: EngineSession = engine): Promise<EngineResult<PlayerInventory>> {
  const result = await session.call<unknown>("player.inventory", {});
  if (!result.ok) return result;
  const inventory = parseInventory(result.value);
  return inventory ? { ok: true, value: inventory } : malformed("player.inventory", result.value);
}

/** `container.get`: what a block's container holds. A block without one answers `invalid_params`. */
export async function containerGet(at: BlockRef, session: EngineSession = engine): Promise<EngineResult<ContainerView>> {
  const params = blockParams(at);
  if (typeof params === "string") return invalid(params);
  const result = await session.call<unknown>("container.get", params, { timeoutMs: CONTAINER_TIMEOUT_MS });
  if (!result.ok) return result;
  const view = parseContainer(result.value);
  return view ? { ok: true, value: view } : malformed("container.get", result.value);
}

/** `container.open`: the container screen the player has open now, plus their own inventory. */
export async function containerOpen(session: EngineSession = engine): Promise<EngineResult<OpenContainer>> {
  const result = await session.call<unknown>("container.open", {}, { timeoutMs: CONTAINER_TIMEOUT_MS });
  if (!result.ok) return result;
  const view = parseOpenContainer(result.value);
  return view ? { ok: true, value: view } : malformed("container.open", result.value);
}

/** `craft.match`: what the game's own recipe lookup makes of a grid or an ingredient list. */
export async function craftMatch(request: CraftRequest, session: EngineSession = engine): Promise<EngineResult<CraftMatch>> {
  const params = craftMatchParams(request);
  if (typeof params === "string") return invalid(params);
  const result = await session.call<unknown>("craft.match", params, { timeoutMs: CRAFT_TIMEOUT_MS });
  if (!result.ok) return result;
  const match = parseCraftMatch(result.value);
  return match ? { ok: true, value: match } : malformed("craft.match", result.value);
}

/**
 * `screen act craft`, as the `craft` tool's `run` action: the same game request the crafting table sends, through the
 * screen the player has open. `craft.match` stays its own lookup, but what a craft *does* is a screen action, so this
 * is the thin alias of it and answers in this tool's own shape.
 */
export async function craftRun(recipe: string, times?: number, session: EngineSession = engine): Promise<EngineResult<CraftRun>> {
  const id = recipe.trim();
  if (!id) return invalid("a recipe id cannot be empty");
  if (times !== undefined && (!Number.isInteger(times) || times < 1 || times > 1000)) {
    return invalid("times must be an integer from 1 to 1000");
  }
  const act = await screenAct({ action: "craft", recipe: id, ...(times !== undefined ? { times } : {}) }, session);
  if (!act.ok) return act;
  const run = act.value;
  return { ok: true, value: { crafted: run.done ? (times ?? 1) : 0, result: run.result, consumed: run.consumed } };
}

function blockParams(at: BlockRef): Record<string, unknown> | string {
  if (!Number.isInteger(at.x) || !Number.isInteger(at.y) || !Number.isInteger(at.z)) {
    return "x, y and z must be whole block coordinates";
  }
  const dimension = dimensionParam(at.dimension);
  if (typeof dimension === "string") return dimension;
  return { x: at.x, y: at.y, z: at.z, ...dimension };
}

/**
 * Reasons that mean the agent cannot answer here rather than that the answer is bad: nothing is listening, or an
 * older agent does not have these methods. Both go to the helper pack.
 */
const SCRIPT_FALLBACK: Readonly<Partial<Record<EngineFailureReason, boolean>>> = { not_attached: true, unknown_method: true };

function scriptInventory(agentFailure?: EngineFailure): Promise<EngineResult<PlayerInventoryState>> {
  return (async () => {
    try {
      const raw = await bridge.query("inventory");
      if (!isRecord(raw)) return malformed("helper pack inventory", raw);
      const inventory = parseInventory(raw.inventory);
      const attributes = raw.attributes === undefined ? {} : parseAttributes(raw.attributes);
      if (!inventory) return malformed("helper pack inventory", raw.inventory);
      if (!attributes) return malformed("helper pack attributes", raw.attributes);
      return { ok: true, value: { source: "script", attributes, inventory } };
    } catch (err) {
      const agent = agentFailure ? ` (agent: ${agentFailure.reason}: ${agentFailure.message})` : "";
      return {
        ok: false,
        code: -32000,
        reason: "not_attached",
        message: `no agent is attached and the helper pack could not answer${agent}: ${messageOf(err)}`,
      };
    }
  })();
}

function scriptContainer(at: BlockRef, agentFailure?: EngineFailure): Promise<EngineResult<ContainerView>> {
  return (async () => {
    const params = blockParams(at);
    if (typeof params === "string") return invalid(params);
    try {
      const raw = await bridge.query("container", params);
      const view = parseContainer(raw);
      if (view) return { ok: true, value: view };
      return malformed("helper pack container", raw);
    } catch (err) {
      // A block with no container is a bad request, not a missing helper: the agent answers -32602 for it too.
      if (err instanceof HelperQueryError && (err.reason === "no_container" || err.reason === "no_block")) {
        return { ok: false, code: -32602, reason: "invalid_params", message: messageOf(err) };
      }
      const agent = agentFailure ? ` (agent: ${agentFailure.reason}: ${agentFailure.message})` : "";
      return {
        ok: false,
        code: -32000,
        reason: "not_attached",
        message: `no agent is attached and the helper pack could not answer${agent}: ${messageOf(err)}`,
      };
    }
  })();
}

/** Attributes and inventory: the agent, else the helper pack. `source` says which answered. */
export async function readPlayerInventory(session: EngineSession = engine): Promise<EngineResult<PlayerInventoryState>> {
  const inventory = await playerInventory(session);
  if (!inventory.ok) return SCRIPT_FALLBACK[inventory.reason] ? scriptInventory(inventory) : inventory;
  const attributes = await playerAttributes(session);
  if (!attributes.ok) return attributes;
  return { ok: true, value: { source: "engine", attributes: attributes.value, inventory: inventory.value } };
}

/** `container.get`: the agent, else the helper pack's block inventory component. */
export async function readContainer(at: BlockRef, session: EngineSession = engine): Promise<EngineResult<ContainerView>> {
  const result = await containerGet(at, session);
  if (result.ok || !SCRIPT_FALLBACK[result.reason]) return result;
  return scriptContainer(at, result);
}

/* -------------------------------------------------------------------------------------------------------------- */
/* MCP                                                                                                             */
/* -------------------------------------------------------------------------------------------------------------- */

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(text: string, structured: object): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: { ...structured } };
}

function failureOf(failure: EngineFailure): ToolResult {
  const anchor = failure.anchor ? ` anchor ${failure.anchor}` : "";
  const text = `${failure.reason} (${failure.code})${anchor}: ${failure.message}`;
  return { content: [{ type: "text", text }], structuredContent: { ...failure }, isError: true };
}

function failedWith(err: unknown): ToolResult {
  const text = messageOf(err);
  return { content: [{ type: "text", text }], structuredContent: { ok: false, reason: "prerequisite", message: text }, isError: true };
}

/** A short summary of an inventory: how much of it is filled, and the slot the hotbar points at. */
function inventoryText(source: InventorySource, state: PlayerInventoryState): string {
  const held = state.inventory.hotbar[state.inventory.selectedSlot - 1] ?? null;
  const stacks = [...state.inventory.hotbar, ...state.inventory.inventory].filter((slot) => slot !== null).length;
  const health = state.attributes.health;
  const parts = [`${stacks} stack(s)`, `slot ${state.inventory.selectedSlot}`];
  if (held) parts.push(`holding ${held.item} x${held.count}`);
  if (health) parts.push(`health ${health.current}/${health.max ?? "?"}`);
  const armor = state.attributes.armor;
  if (armor) parts.push(`armor ${armor.current}`);
  return `${source}: ${parts.join(", ")}`;
}

function containerText(view: ContainerView): string {
  const filled = view.slots.filter((slot) => slot !== null).length;
  return `${view.block ?? "container"} (${view.size} slots, ${filled} filled)`;
}

function craftMatchText(match: CraftMatch): string {
  if (!match.result) return "no recipe matches";
  const recipe = match.recipe ? ` ${match.recipe.id} (${match.recipe.type})` : "";
  return `${match.result.item} x${match.result.count}${recipe}`;
}

/** Output schemas, built from the zod sculkwire depends on. */
function schemas() {
  // A slot in a container and a slot in a screen are one shape, so both schemas are built from the same definition.
  const maybeSlot = itemSlotSchema.nullable();

  const failureSchema = {
    ok: z.boolean(),
    code: z.number().optional(),
    reason: z.string().optional(),
    anchor: z.string().optional(),
    message: z.string().optional(),
  };

  const playerInventorySchema = {
    ...failureSchema,
    source: z.enum(["engine", "script"]).optional(),
    attributes: z.record(z.string(), z.object({
      current: z.number(),
      min: z.number().optional(),
      max: z.number().optional(),
      default: z.number().optional(),
      base: z.number().optional(),
    })).optional(),
    inventory: z
      .object({
        selectedSlot: z.number().describe("Hotbar slot 1 to 9, as player_state counts it: hotbar[selectedSlot - 1]"),
        hotbar: z.array(maybeSlot),
        inventory: z.array(maybeSlot),
        armor: z.object({ head: maybeSlot, chest: maybeSlot, legs: maybeSlot, feet: maybeSlot }),
        offhand: maybeSlot,
        cursor: maybeSlot,
      })
      .optional(),
  };

  const recipeSchema = z.object({ id: z.string(), type: z.string(), tag: z.string().optional() });

  const containerSchema = {
    ...failureSchema,
    action: z.enum(["get", "open"]).optional(),
    block: z.string().nullable().optional(),
    position: z.object({ x: z.number(), y: z.number(), z: z.number() }).nullable().optional(),
    size: z.number().optional(),
    slots: z.array(maybeSlot).optional(),
    screen: z.string().optional(),
    playerSlots: z.array(maybeSlot).optional(),
  };

  const craftSchema = {
    ...failureSchema,
    action: z.enum(["match", "run"]).optional(),
    result: maybeSlot.optional(),
    recipe: recipeSchema.nullable().optional(),
    crafted: z.number().optional(),
    consumed: z.array(maybeSlot).optional(),
  };

  return { playerInventorySchema, containerSchema, craftSchema };
}

/** `player_inventory`, `container` and `craft`. Called by the engine feature's `register`. */
export function registerInventoryTools(server: McpServer): void {
  const { playerInventorySchema, containerSchema, craftSchema } = schemas();

  server.registerTool(
    "player_inventory",
    {
      title: "Player attributes and inventory",
      description:
        "The local player's attributes (health, absorption, movement, attack damage, luck, hunger, saturation, level, " +
        "experience, ... plus armour points and armour toughness the game derives) and the whole inventory: hotbar, " +
        "main inventory, armour, offhand and cursor stack, with each item's id, count, custom name, lore, durability " +
        "and enchantments. selectedSlot is the hotbar slot 1 to 9, as player_state counts it. Through the agent it is the game's own data. Without the agent it comes from the helper " +
        "pack's Script API components (source: script), which has no aux value, no bundle contents and no cursor " +
        "stack, and only the attributes the running game exposes as components.",
      inputSchema: {},
      outputSchema: playerInventorySchema,
    },
    async () => {
      try {
        const result = await readPlayerInventory();
        if (!result.ok) return failureOf(result);
        const state = result.value;
        return ok(inventoryText(state.source, state), { ok: true, ...state });
      } catch (err) {
        return failedWith(err);
      }
    },
  );

  server.registerTool(
    "container",
    {
      title: "Block container and open container screen",
      description:
        "get: what a block's container holds (chest, trapped chest, barrel, shulker box, hopper, dispenser, dropper, " +
        "furnace family, brewing stand, crafter, ...), by block position, with every slot's item. open: the container " +
        "screen the player has open right now, with its slots and the player's inventory beside it. Through the agent " +
        "it is the game's own container. Without the agent, get falls back to the helper pack's block inventory " +
        "component (source: script); a block without a container is an invalid_params error.",
      inputSchema: {
        action: z.enum(["get", "open"]).describe("get a block's container, or the container screen the player has open"),
        x: z.number().int().optional().describe("get: block x"),
        y: z.number().int().optional().describe("get: block y"),
        z: z.number().int().optional().describe("get: block z"),
        dimension: dimensionSchema.optional().describe("get: overworld, nether or the_end (also minecraft:nether, or 0, 1, 2; default: the player's)"),
      },
      outputSchema: containerSchema,
    },
    async ({ action, x, y, z: bz, dimension }) => {
      try {
        if (action === "open") {
          const result = await containerOpen();
          if (!result.ok) return failureOf(result);
          const open = result.value;
          const where = open.position ? ` at ${open.position.x} ${open.position.y} ${open.position.z}` : "";
          return ok(`${open.screen}${where}: ${containerText({ block: open.block, size: open.slots.length, slots: open.slots })}`, {
            ok: true,
            action,
            ...open,
          });
        }
        if (x === undefined || y === undefined || bz === undefined) {
          return failureOf(invalid("get needs x, y and z"));
        }
        const result = await readContainer({ x, y, z: bz, ...(dimension !== undefined ? { dimension } : {}) });
        if (!result.ok) return failureOf(result);
        const view = result.value;
        return ok(`${containerText(view)} at ${x} ${y} ${bz}`, { ok: true, action, ...view });
      } catch (err) {
        return failedWith(err);
      }
    },
  );

  server.registerTool(
    "craft",
    {
      title: "Match and run a crafting recipe",
      description:
        "match: ask the game's own recipe lookup what a 3x3 grid (a 2x2 is padded) or a shapeless ingredient list " +
        "makes, the way the crafting table would show it. run: the same as `screen act craft` — the game's own " +
        "crafting request through the screen the player has open, taking the ingredients out of the player's " +
        "inventory and putting the result there; a 3x3 recipe needs a crafting table open, like the player. Crafting " +
        "has no Script API equivalent, so it needs the agent: without it the call fails and says so. Set up " +
        "inventories and containers with commands (/give, /clear, /replaceitem, /setblock) through engine_command.",
      inputSchema: {
        action: z.enum(["match", "run"]).describe("match a recipe, or run one the match returned"),
        grid: z
          .array(z.array(z.string().nullable()))
          .optional()
          .describe("match: up to 3 rows of up to 3 item ids, null for an empty cell; short rows are padded"),
        ingredients: z.array(z.string()).optional().describe("match: up to 9 item ids for a shapeless recipe"),
        table: z.boolean().optional().describe("match: a crafting table is open (3x3) rather than the 2x2 inventory grid"),
        recipe: z.string().optional().describe("run: the recipe id craft match returned"),
        times: z.number().int().min(1).max(1000).optional().describe("run: how many times to craft"),
      },
      outputSchema: craftSchema,
    },
    async ({ action, grid, ingredients, table, recipe, times }) => {
      try {
        if (action === "match") {
          const result = await craftMatch({
            ...(grid !== undefined ? { grid } : {}),
            ...(ingredients !== undefined ? { ingredients } : {}),
            ...(table !== undefined ? { table } : {}),
          });
          if (!result.ok) return failureOf(result);
          return ok(craftMatchText(result.value), { ok: true, action, ...result.value });
        }
        if (!recipe) return failureOf(invalid("run needs the recipe id craft match returned"));
        const result = await craftRun(recipe, times);
        if (!result.ok) {
          const missing = result.reason === "not_attached" ? { ...result, message: `${result.message}. Crafting needs the agent (engine_attach)` } : result;
          return failureOf(missing);
        }
        const run = result.value;
        const made = run.result ? `${run.result.item} x${run.result.count}` : "nothing";
        return ok(`crafted ${run.crafted} (${made}), ${run.consumed.length} stack(s) consumed`, { ok: true, action, ...run });
      } catch (err) {
        return failedWith(err);
      }
    },
  );
}

/* -------------------------------------------------------------------------------------------------------------- */
/* CLI                                                                                                             */
/* -------------------------------------------------------------------------------------------------------------- */

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

/** The failure as JSON, and the exit code it maps to. */
function failed(failure: EngineFailure): number {
  out(failure);
  const anchor = failure.anchor ? ` (anchor ${failure.anchor})` : "";
  err(`${failure.reason}: ${failure.message}${anchor}`);
  return isSetupFailure(failure) ? ExitCode.usage : ExitCode.findings;
}

/** One CLI call is one process, so the agent socket must not keep it alive after the answer is printed. */
async function oneShot(body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } finally {
    engine.close();
  }
}

const CRAFT_USAGE =
  "usage: sculk craft match --grid \"oak_planks,oak_planks,-;oak_planks,oak_planks,-\" | --ingredients oak_log,oak_log [--table] | sculk craft run <recipe> [--times N]";

const playerInventoryCommand: CliCommand = {
  name: "player inventory",
  summary: "Player attributes and full inventory, through the agent or the helper pack's Script API fallback",
  async run(args) {
    return oneShot(async () => {
      if (args.length) {
        err("player inventory takes no arguments");
        return ExitCode.usage;
      }
      try {
        const result = await readPlayerInventory();
        if (!result.ok) return failed(result);
        out(result.value);
        err(inventoryText(result.value.source, result.value));
        return ExitCode.ok;
      } catch (e) {
        const text = messageOf(e);
        out({ ok: false, reason: "prerequisite", message: text });
        err(text);
        return ExitCode.usage;
      }
    });
  },
};

const containerCommand: CliCommand = {
  name: "container get",
  summary: "What a block's container holds: container get <x> <y> <z> [--dimension overworld|nether|the_end]",
  async run(args) {
    return oneShot(async () => {
      const dot = args.indexOf("--dimension");
      const coords = dot === -1 ? args : args.slice(0, dot);
      const dimension = dot === -1 ? undefined : args[dot + 1];
      if (coords.length !== 3 || (dot !== -1 && (!dimension || !dimensionName(dimension)))) {
        err("usage: sculk container get <x> <y> <z> [--dimension overworld|nether|the_end]");
        return ExitCode.usage;
      }
      const [cx, cy, cz] = coords.map(Number);
      const at = { x: cx ?? NaN, y: cy ?? NaN, z: cz ?? NaN };
      if (!Number.isInteger(at.x) || !Number.isInteger(at.y) || !Number.isInteger(at.z)) {
        err("x, y and z must be whole block coordinates");
        return ExitCode.usage;
      }
      try {
        const result = await readContainer({ ...at, ...(dimension ? { dimension } : {}) });
        if (!result.ok) return failed(result);
        out(result.value);
        err(containerText(result.value));
        return ExitCode.ok;
      } catch (e) {
        const text = messageOf(e);
        out({ ok: false, reason: "prerequisite", message: text });
        err(text);
        return ExitCode.usage;
      }
    });
  },
};

const craftCommand: CliCommand = {
  name: "craft",
  summary:
    "Match or run a crafting recipe through the game's own recipe lookup (craft run is screen act craft): " +
    "craft match|run (needs the agent)",
  async run(args) {
    return oneShot(async () => {
      const [action, ...rest] = args;
      if (action === "match") {
        let grid: (string | null)[][] | undefined;
        let ingredients: string[] | undefined;
        let table = false;
        for (let i = 0; i < rest.length; i++) {
          const arg = rest[i];
          if (arg === undefined) break;
          if (arg === "--table") table = true;
          else if (arg === "--grid" || arg.startsWith("--grid=")) {
            const text = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : rest[++i];
            if (!text) {
              err("--grid needs rows of item ids");
              return ExitCode.usage;
            }
            const parsed = parseCraftGrid(text);
            if (!parsed) {
              err(`cannot read the grid ${JSON.stringify(text)}: rows of up to 3 item ids, "-" for an empty cell`);
              return ExitCode.usage;
            }
            grid = parsed;
          } else if (arg === "--ingredients" || arg.startsWith("--ingredients=")) {
            const text = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : rest[++i];
            if (!text) {
              err("--ingredients needs a comma-separated list of item ids");
              return ExitCode.usage;
            }
            ingredients = text
              .split(",")
              .map((id) => id.trim())
              .filter((id) => id.length > 0);
          } else {
            err(CRAFT_USAGE);
            return ExitCode.usage;
          }
        }
        try {
          const result = await craftMatch({ ...(grid ? { grid } : {}), ...(ingredients ? { ingredients } : {}), ...(table ? { table } : {}) });
          if (!result.ok) return failed(result);
          out(result.value);
          err(craftMatchText(result.value));
          return ExitCode.ok;
        } catch (e) {
          const text = messageOf(e);
          out({ ok: false, reason: "prerequisite", message: text });
          err(text);
          return ExitCode.usage;
        }
      }
      if (action === "run") {
        const recipe = rest[0];
        const timesAt = rest.indexOf("--times");
        const times = timesAt === -1 ? undefined : Number(rest[timesAt + 1]);
        const extra = rest.filter((arg) => arg !== recipe && arg !== "--times" && String(times) !== arg);
        if (!recipe || extra.length || (timesAt !== -1 && !Number.isInteger(times))) {
          err(CRAFT_USAGE);
          return ExitCode.usage;
        }
        try {
          const result = await craftRun(recipe, times);
          if (!result.ok) {
            if (result.reason === "not_attached") err("crafting needs the agent: run sculk engine attach first");
            return failed(result);
          }
          out(result.value);
          err(`crafted ${result.value.crafted}`);
          return ExitCode.ok;
        } catch (e) {
          const text = messageOf(e);
          out({ ok: false, reason: "prerequisite", message: text });
          err(text);
          return ExitCode.usage;
        }
      }
      err(CRAFT_USAGE);
      return ExitCode.usage;
    });
  },
};

export const inventoryCommands: CliCommand[] = [playerInventoryCommand, containerCommand, craftCommand];
