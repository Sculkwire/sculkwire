/**
 * Interactable blocks, entities and their screens: use one the way a right click does, then read and drive whatever
 * screen it opened, through the in-game agent.
 *
 * `interact.block {x, y, z, dimension?, face?}` and `interact.entity {id}` run the game's own interact path (open a
 * chest, a crafting table, a furnace, a trading screen or a horse's screen, sit in a boat or a minecart, press a
 * button, pull a lever) and answer the screen that opened: `{screen: string|null, changed: bool}`.
 *
 * `screen.state` answers the open screen in one shape: `{screen, kind, containers: {name: [slot]}, data}`. `kind` is
 * the family the screen belongs to (`SCREEN_KINDS`; a kind this client does not know is `other`), each container is
 * keyed by the game's own collection name (`hotbar_items`, `furnace_ingredient_items`, ...) and holds slots in the
 * same shape `player.inventory` uses, and `data` is the screen's own state in the agent's own shape (`ScreenData`):
 * a villager's offers, the stonecutter's recipes, the enchanting table's options, a furnace's burn and cook or a
 * brewing stand's brew and fuel (fractions 0..1), a result screen's result and inputs, the anvil's result, XP cost and
 * rename text, the beacon's effects and the loom's pattern. A screen whose state the agent does not decode (a chest,
 * a barrel, the inventory) reports `data: null`; a decoded state the agent cannot read right now reports
 * `{unavailable, anchor}`; a value the engine does not know is `null`, never guessed.
 *
 * `screen.move {from: {container, slot}, to: {container, slot}, count?}` moves items between those containers through
 * the game's own item stack requests, the way dragging with the mouse does; `count` omitted moves the whole stack. It
 * answers `{moved}`, the items that crossed.
 *
 * `screen.act {action, ...}` runs the screen's own action through the game's own request: `craft {recipe, times?}`,
 * `stonecut {recipe: index, times?}`, `anvil {name?}`, `grindstone`, `smithing`, `loom {pattern}`, `cartography`,
 * `enchant {option}`, `trade {offer, times?}`, `beacon {primary, secondary?}` and `take_result`. It answers
 * `{done, result, consumed, xpCost?, reason?}`.
 *
 * `screen.close` closes the screen like Escape and answers `{closed}`.
 *
 * All of them need the agent: no Script API call and no `level.dat` field stands in for using a block or reading a
 * screen, so without one the call fails with `not_attached` and says so (a setup failure: the CLI exits 2). Setting a
 * scene up stays on commands (`/setblock`, `/summon`, `/give`) through `engine_command`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { err, type CliCommand } from "../../core/cli.ts";
import { ExitCode } from "../../core/diagnostic.ts";
import { ok, type ToolResult } from "../../core/mcp.ts";
import { failed, oneShot, parseCommandLine, printJson, stringOption } from "./cliutil.ts";
import { dimensionName, dimensionParam, dimensionSchema } from "./dimension.ts";
import { engine, type EngineSession } from "./engine.ts";
import { failureSchema, invalid, malformed, type EngineFailure, type EngineResult } from "./failure.ts";
import { itemSlotSchema, parseSlot, parseSlots, type Slot } from "./slot.ts";
import { failureResult, invalidParamsResult } from "./toolresult.ts";
import { countOrUndefined, integerOrUndefined, isObjectLike, isPlainObject, nonEmptyText } from "./wire.ts";

/** The faces a block can be used on, in the game's own order (0 = down, 1 = up, then north, south, west, east). */
export const BLOCK_FACES = ["down", "up", "north", "south", "west", "east"] as const;
export type BlockFace = (typeof BLOCK_FACES)[number];

/** The screen families the agent names; anything else is `other`. */
export const SCREEN_KINDS = [
  "crafting_table",
  "inventory",
  "furnace",
  "blast_furnace",
  "smoker",
  "brewing_stand",
  "stonecutter",
  "anvil",
  "grindstone",
  "smithing_table",
  "loom",
  "cartography_table",
  "enchanting_table",
  "beacon",
  "trade",
  "chest",
  "barrel",
  "shulker_box",
  "hopper",
  "dispenser",
  "dropper",
  "crafter",
  "horse",
  "other",
] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];

/** The screen's own actions, as `screen.act` takes them. */
export const SCREEN_ACTIONS = [
  "craft",
  "stonecut",
  "anvil",
  "grindstone",
  "smithing",
  "loom",
  "cartography",
  "enchant",
  "trade",
  "beacon",
  "take_result",
] as const;
export type ScreenActAction = (typeof SCREEN_ACTIONS)[number];

/** A block to use like a right click; `dimension` is a dimension (`nether`, `minecraft:nether` or 1). */
export interface BlockUse {
  x: number;
  y: number;
  z: number;
  dimension?: string | number;
  face?: BlockFace;
}

/** What an interaction did: the screen it opened (null when it opened none) and whether anything changed. */
export interface InteractOutcome {
  target: "block" | "entity";
  screen: string | null;
  changed: boolean;
}

/** One slot of one of a screen's containers. */
export interface ScreenSlotRef {
  /** The collection's name as `screen.state` lists it (`hotbar_items`), or a container enum name (`HotbarContainer`). */
  container: string;
  /** 0-based, as the agent lists the container's slots. */
  slot: number;
}

/** One enchantment an enchanting option would apply: the game's numeric enchantment id and its level. */
export interface OptionEnchant {
  id: number;
  level: number;
}

/** One enchanting option as the table's model holds it; a value the agent cannot read is null. */
export interface EnchantOption {
  /** 0-based, the index `screen act enchant` takes. */
  option: number;
  /** The level it needs (the number on the button). */
  cost: number | null;
  /** The enchantment name the table hints at. */
  hint: string | null;
  /** The level of its first enchantment. */
  level: number | null;
  /** The lapis lazuli it takes: option + 1 (null from an agent that does not report it). */
  lapis: number | null;
  /** The levels it takes: option + 1, fewer than `cost` (null from an agent that does not report it). */
  levelsTaken: number | null;
  /** Every enchantment it would apply. */
  enchants: OptionEnchant[];
  /** The option's net id, the one the enchant request echoes. */
  netId: number | null;
}

/** One offer a villager or a wandering trader shows; a value the agent cannot read is null. */
export interface TradeOffer {
  /** 0-based, the index `screen act trade` takes. */
  index: number;
  /** What the offer costs: its first ingredient, and its second (null when it needs one). */
  buyA: Slot;
  buyB: Slot;
  /** What the trade gives. */
  sell: Slot;
  /** Uses so far, and the number the offer allows. */
  uses: number | null;
  maxUses: number | null;
  /** True once the offer is out of uses. */
  locked: boolean;
  /** The offer's net id, the one the trade request sends. */
  netId: number | null;
}

/** One recipe the stonecutter offers for the item in its input. */
export interface StonecutterRecipe {
  /** 0-based, the index `screen act stonecut` takes. */
  index: number;
  result: Slot;
  netId: number | null;
}

/**
 * The screen's own state, in the agent's shape per `kind`; a field is present only for the kinds that report it:
 * - trade: `offers`, `selected` (the selected offer, -1 = none), `trader` (the trader's unique id, as text)
 * - stonecutter: `recipes`, `selected` (-1 = none), `result` (the selected recipe's result)
 * - enchanting_table: `options` (`[]` with no item or lapis)
 * - furnace, blast_furnace, smoker: `burn` (fuel left), `cook` (smelt done), fractions 0..1
 * - brewing_stand: `brew` (brew done), `fuel` (fuel left), fractions 0..1
 * - grindstone, smithing_table, cartography_table: `result`, `inputs` (each input container's slots)
 * - anvil: `result`, `xpCost`, `tooExpensive`, `name` (the rename text)
 * - beacon: `primary`, `secondary` (an effect name such as `speed`, the numeric id of one the agent does not name, or
 *   null for none)
 * - loom: `pattern` (the selected pattern's id, "" = none)
 * - any decoded kind whose state cannot be read now: `unavailable` (why) and `anchor` (the anchor it blames)
 * A kind this client does not decode passes its fields through as the agent sent them.
 */
export interface ScreenData {
  offers?: TradeOffer[];
  selected?: number | null;
  trader?: string | null;
  recipes?: StonecutterRecipe[];
  result?: Slot;
  options?: EnchantOption[];
  burn?: number | null;
  cook?: number | null;
  brew?: number | null;
  fuel?: number | null;
  inputs?: Record<string, Slot[]>;
  xpCost?: number | null;
  tooExpensive?: boolean | null;
  name?: string | null;
  primary?: string | number | null;
  secondary?: string | number | null;
  pattern?: string | null;
  unavailable?: string;
  anchor?: string | null;
  [field: string]: unknown;
}

/** The screen the game has open, as `screen.state` reports it. */
export interface ScreenState {
  screen: string;
  kind: ScreenKind;
  /** Every container the screen shows, each in the slot shape the inventory tools use. */
  containers: Record<string, Slot[]>;
  /** The screen's own state; null for a screen with none the agent decodes. */
  data: ScreenData | null;
}

/** A move of items between a screen's containers. */
export interface ScreenMoveRequest {
  from: ScreenSlotRef;
  to: ScreenSlotRef;
  /** How many items to move; omitted moves the whole stack. */
  count?: number;
}

/** What a move did: how many items crossed. */
export interface ScreenMoveOutcome {
  moved: number;
}

/** What an act did. `done: false` with a `reason` is a screen that refused it. */
export interface ScreenActOutcome {
  done: boolean;
  result: Slot;
  consumed: Slot[];
  /** Anvil and enchanting: the levels it took or will take. */
  xpCost?: number;
  /** Why the screen refused, when it did. */
  reason?: string;
}

/** What closing the screen did. */
export interface ScreenCloseOutcome {
  closed: boolean;
  /** Escapes the agent sent: a screen with a focused text box (chat) spends its first on leaving the box. */
  escapes?: number;
}

/** A screen action to run, with the parameters that action takes. */
export interface ScreenActRequest {
  action: ScreenActAction;
  /** craft: the recipe id the screen lists. stonecut: the 0-based index of a recipe in `data.recipes`. */
  recipe?: string | number;
  /** craft, stonecut, trade: how many times to do it. */
  times?: number;
  /** anvil: the rename text; an empty string clears the name. */
  name?: string;
  /** loom: the pattern id the screen lists. */
  pattern?: string;
  /** enchant: which of the three options, 0 to 2. */
  option?: number;
  /** trade: the 0-based index of the offer. */
  offer?: number;
  /** beacon: the effect id, e.g. `minecraft:speed`. */
  beaconPrimary?: string;
  /** beacon: the second effect id. */
  beaconSecondary?: string;
}

/** An `interact.block` or `interact.entity` answer. A screen that opened is a change, whatever `changed` says. */
export function parseInteract(raw: unknown, target: "block" | "entity"): InteractOutcome | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (raw.screen !== undefined && raw.screen !== null && typeof raw.screen !== "string") return undefined;
  if (raw.changed !== undefined && typeof raw.changed !== "boolean") return undefined;
  const screen = nonEmptyText(raw.screen) ?? null;
  return { target, screen, changed: raw.changed === true || screen !== null };
}

/** Every container of a `screen.state` answer; an absent map is a screen that shows no container. */
function parseContainers(raw: unknown): Record<string, Slot[]> | undefined {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, Slot[]> = {};
  for (const [name, value] of Object.entries(raw)) {
    const slots = parseSlots(value);
    if (!slots) return undefined;
    out[name] = slots;
  }
  return out;
}

/** A fraction 0..1, as the furnace and brewing progress is. */
function fraction(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/** Text as the agent sent it, "" included: a rename text, a pattern id, a trader id. */
function rawText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A value the agent sends as null when it cannot read it: null (or absent) is null, a bad value is undefined. */
function orNull<T>(value: unknown, read: (value: unknown) => T | undefined): T | null | undefined {
  return value === undefined || value === null ? null : read(value);
}

/** An array whose every entry reads; undefined when it is not an array or one entry does not read. */
function arrayOf<T>(value: unknown, read: (entry: unknown, position: number) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const entry of value) {
    const parsed = read(entry, out.length);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

/** An entry's 0-based index: the agent's own, or its position when the agent leaves it out. */
function indexOf(value: unknown, position: number): number | undefined {
  return value === undefined ? position : countOrUndefined(value);
}

function parseOptionEnchant(raw: unknown): OptionEnchant | undefined {
  if (!isPlainObject(raw)) return undefined;
  const id = integerOrUndefined(raw.id);
  const level = integerOrUndefined(raw.level);
  return id === undefined || level === undefined ? undefined : { ...raw, id, level };
}

function parseEnchantOption(raw: unknown, position: number): EnchantOption | undefined {
  if (!isPlainObject(raw)) return undefined;
  const option = indexOf(raw.option, position);
  const cost = orNull(raw.cost, integerOrUndefined);
  const hint = orNull(raw.hint, rawText);
  const level = orNull(raw.level, integerOrUndefined);
  const lapis = raw.lapis === undefined ? null : orNull(raw.lapis, integerOrUndefined);
  const levelsTaken = raw.levelsTaken === undefined ? null : orNull(raw.levelsTaken, integerOrUndefined);
  const enchants = raw.enchants === undefined ? [] : arrayOf(raw.enchants, parseOptionEnchant);
  const netId = orNull(raw.netId, countOrUndefined);
  if (option === undefined || cost === undefined || hint === undefined || level === undefined) return undefined;
  if (lapis === undefined || levelsTaken === undefined || enchants === undefined || netId === undefined) return undefined;
  return { ...raw, option, cost, hint, level, lapis, levelsTaken, enchants, netId };
}

function parseTradeOffer(raw: unknown, position: number): TradeOffer | undefined {
  if (!isPlainObject(raw)) return undefined;
  const index = indexOf(raw.index, position);
  const buyA = parseSlot(raw.buyA ?? null);
  const buyB = parseSlot(raw.buyB ?? null);
  const sell = parseSlot(raw.sell ?? null);
  const uses = orNull(raw.uses, integerOrUndefined);
  const maxUses = orNull(raw.maxUses, integerOrUndefined);
  const netId = orNull(raw.netId, countOrUndefined);
  if (index === undefined || buyA === undefined || buyB === undefined || sell === undefined) return undefined;
  if (uses === undefined || maxUses === undefined || netId === undefined) return undefined;
  if (typeof raw.locked !== "boolean") return undefined;
  return { ...raw, index, buyA, buyB, sell, uses, maxUses, locked: raw.locked, netId };
}

function parseStonecutterRecipe(raw: unknown, position: number): StonecutterRecipe | undefined {
  if (!isPlainObject(raw)) return undefined;
  const index = indexOf(raw.index, position);
  const result = parseSlot(raw.result ?? null);
  const netId = orNull(raw.netId, countOrUndefined);
  if (index === undefined || result === undefined || netId === undefined) return undefined;
  return { ...raw, index, result, netId };
}

/** A beacon effect: the agent's name for it, or the numeric id of one it does not name. */
function beaconEffect(value: unknown): string | number | undefined {
  return typeof value === "string" ? value : countOrUndefined(value);
}

/** The kinds whose state the agent decodes; any other kind's data passes through as the agent sent it. */
const DECODED_KINDS: ReadonlySet<string> = new Set([
  "trade",
  "stonecutter",
  "enchanting_table",
  "furnace",
  "blast_furnace",
  "smoker",
  "brewing_stand",
  "grindstone",
  "smithing_table",
  "cartography_table",
  "anvil",
  "beacon",
  "loom",
]);

/** Each field a decoded kind reports, and how it reads; undefined is a value of the wrong shape. */
const DATA_FIELDS: Record<string, (value: unknown) => unknown> = {
  offers: (value) => arrayOf(value, parseTradeOffer),
  selected: (value) => orNull(value, integerOrUndefined),
  trader: (value) => orNull(value, rawText),
  recipes: (value) => arrayOf(value, parseStonecutterRecipe),
  result: (value) => parseSlot(value ?? null),
  options: (value) => arrayOf(value, parseEnchantOption),
  burn: (value) => orNull(value, fraction),
  cook: (value) => orNull(value, fraction),
  brew: (value) => orNull(value, fraction),
  fuel: (value) => orNull(value, fraction),
  inputs: parseContainers,
  xpCost: (value) => orNull(value, integerOrUndefined),
  tooExpensive: (value) => orNull(value, (flag) => (typeof flag === "boolean" ? flag : undefined)),
  name: (value) => orNull(value, rawText),
  primary: (value) => orNull(value, beaconEffect),
  secondary: (value) => orNull(value, beaconEffect),
  pattern: (value) => orNull(value, rawText),
};

/**
 * The screen's own state for `kind`, in the agent's shape. `null` (or absent) is a screen with no state the agent
 * decodes; `{unavailable, anchor}` is a decoded state it cannot read now; each known field of a decoded kind is
 * checked, a bad value rejects the answer, and a field this client does not know is kept as sent. A kind this client
 * does not decode passes its data through unchecked.
 */
export function parseScreenData(raw: unknown, kind: string): ScreenData | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) return undefined;
  const data: ScreenData = { ...raw };
  if (!DECODED_KINDS.has(kind)) return data;
  if (raw.unavailable !== undefined) {
    const anchor = orNull(raw.anchor, rawText);
    if (typeof raw.unavailable !== "string" || anchor === undefined) return undefined;
    return { ...data, unavailable: raw.unavailable, anchor };
  }
  for (const [field, read] of Object.entries(DATA_FIELDS)) {
    if (!(field in raw)) continue;
    const value = read(raw[field]);
    if (value === undefined) return undefined;
    data[field] = value;
  }
  return data;
}

/** One open screen: its name, its family, its containers and its own data. */
export function parseScreenState(raw: unknown): ScreenState | undefined {
  if (!isPlainObject(raw)) return undefined;
  const screen = nonEmptyText(raw.screen);
  if (!screen) return undefined;
  const containers = parseContainers(raw.containers);
  if (!containers) return undefined;
  const data = parseScreenData(raw.data, typeof raw.kind === "string" ? raw.kind : "");
  if (data === undefined) return undefined;
  const kind = (SCREEN_KINDS as readonly string[]).includes(raw.kind as string) ? (raw.kind as ScreenKind) : "other";
  return { screen, kind, containers, data };
}

/** A move answer: `{moved}`; a record without a count still says the move went through. */
export function parseScreenMove(raw: unknown): { moved?: number } | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (raw.moved === undefined) return {};
  const moved = countOrUndefined(raw.moved);
  return moved === undefined ? undefined : { moved };
}

export function parseScreenAct(raw: unknown): ScreenActOutcome | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.done !== "boolean") return undefined;
  const result = parseSlot(raw.result === undefined ? null : raw.result);
  const consumed = parseSlots(raw.consumed === undefined ? [] : raw.consumed);
  if (result === undefined || !consumed) return undefined;
  const act: ScreenActOutcome = { done: raw.done, result, consumed };
  if (raw.xpCost !== undefined) {
    const xpCost = countOrUndefined(raw.xpCost);
    if (xpCost === undefined) return undefined;
    act.xpCost = xpCost;
  }
  // The agent answers `reason: null` when nothing was refused (live: every successful trade and stonecut).
  if (raw.reason !== undefined && raw.reason !== null) {
    if (typeof raw.reason !== "string") return undefined;
    const reason = nonEmptyText(raw.reason);
    if (reason) act.reason = reason;
  }
  return act;
}

/**
 * A close answer `{closed, escapes}`. A call that returned without an error closed the screen; `closed: false` is
 * a refusal. `escapes` is kept when it is a count.
 */
export function parseScreenClose(raw: unknown): ScreenCloseOutcome | undefined {
  if (raw === undefined || raw === null) return { closed: true };
  if (!isPlainObject(raw)) return undefined;
  if (raw.closed !== undefined && typeof raw.closed !== "boolean") return undefined;
  const closed = typeof raw.closed === "boolean" ? raw.closed : true;
  const escapes = raw.escapes;
  return typeof escapes === "number" && Number.isInteger(escapes) && escapes >= 0 ? { closed, escapes } : { closed };
}

/** `interact.block` parameters, or why the use cannot be expressed. */
export function interactBlockParams(use: BlockUse): Record<string, unknown> | string {
  if (!Number.isInteger(use.x) || !Number.isInteger(use.y) || !Number.isInteger(use.z)) {
    return "x, y and z must be whole block coordinates";
  }
  if (use.face !== undefined && !(BLOCK_FACES as readonly string[]).includes(use.face)) {
    return `face must be one of ${BLOCK_FACES.join(", ")}`;
  }
  const dimension = dimensionParam(use.dimension);
  if (typeof dimension === "string") return dimension;
  return {
    x: use.x,
    y: use.y,
    z: use.z,
    ...dimension,
    ...(use.face ? { face: use.face } : {}),
  };
}

/** An entity's unique id is an int64, so it travels as text: beyond 2^53 a JSON number would be rounded. */
const ENTITY_ID = /^-?\d+$/;

/** `interact.entity` parameters, or why the id cannot be used. */
export function interactEntityParams(id: string): Record<string, unknown> | string {
  const unique = typeof id === "string" ? id.trim() : "";
  if (!ENTITY_ID.test(unique)) return "id must be an entity's unique id (a whole number, e.g. from game_query)";
  return { id: unique };
}

/** A container reference on a command line: `container:slot`, e.g. `furnace_ingredient_items:0`, `hotbar_items:3`. */
export function parseSlotRef(text: string): ScreenSlotRef | string {
  const at = text.lastIndexOf(":");
  if (at < 1) return `${text} is not container:slot`;
  const container = text.slice(0, at).trim();
  const slot = Number(text.slice(at + 1));
  if (!container || !Number.isInteger(slot) || slot < 0) return `${text} is not container:slot`;
  return { container, slot };
}

function slotRefParams(ref: ScreenSlotRef, what: string): Record<string, unknown> | string {
  if (!isObjectLike(ref)) return `${what} must be {container, slot}`;
  const container = typeof ref.container === "string" ? ref.container.trim() : "";
  if (!container) return `${what}.container must name a container the screen reports`;
  if (!Number.isInteger(ref.slot) || ref.slot < 0) return `${what}.slot must be a whole slot index from 0`;
  return { container, slot: ref.slot };
}

/** `screen.move` parameters, or why the move cannot be expressed. */
export function screenMoveParams(request: ScreenMoveRequest): Record<string, unknown> | string {
  const from = slotRefParams(request.from, "from");
  if (typeof from === "string") return from;
  const to = slotRefParams(request.to, "to");
  if (typeof to === "string") return to;
  if (request.count !== undefined && (!Number.isInteger(request.count) || request.count < 1)) {
    return "count must be a whole number of items from 1";
  }
  return { from, to, ...(request.count !== undefined ? { count: request.count } : {}) };
}

/** `screen.act` parameters, or why the action cannot be expressed. Each action takes only its own parameters. */
export function screenActParams(request: ScreenActRequest): Record<string, unknown> | string {
  const params: Record<string, unknown> = { action: request.action };
  if (!(SCREEN_ACTIONS as readonly string[]).includes(request.action)) {
    return `action must be one of ${SCREEN_ACTIONS.join(", ")}`;
  }
  if (request.times !== undefined && (!Number.isInteger(request.times) || request.times < 1 || request.times > 1000)) {
    return "times must be an integer from 1 to 1000";
  }
  if (request.action === "craft") {
    const recipe = typeof request.recipe === "string" ? nonEmptyText(request.recipe) : undefined;
    if (!recipe) return "craft needs recipe: the id the screen lists";
    params.recipe = recipe;
    if (request.times !== undefined) params.times = request.times;
    return params;
  }
  if (request.action === "stonecut") {
    // The agent indexes the stonecutter's list (`data.recipes[].index`, at most 256 entries); a CLI flag is text.
    const raw = typeof request.recipe === "string" && /^\s*\d+\s*$/.test(request.recipe) ? Number(request.recipe) : request.recipe;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 255) {
      return "stonecut needs recipe: the 0-based index of a recipe in the screen's data.recipes (0 to 255)";
    }
    params.recipe = raw;
    if (request.times !== undefined) params.times = request.times;
    return params;
  }
  if (request.action === "anvil") {
    if (request.name !== undefined) {
      if (typeof request.name !== "string") return "name must be text";
      params.name = request.name;
    }
    return params;
  }
  if (request.action === "loom") {
    const pattern = nonEmptyText(request.pattern);
    if (!pattern) return "loom needs pattern: the pattern id the screen lists";
    params.pattern = pattern;
    return params;
  }
  if (request.action === "enchant") {
    if (request.option !== 0 && request.option !== 1 && request.option !== 2) return "enchant needs option: 0, 1 or 2";
    params.option = request.option;
    return params;
  }
  if (request.action === "trade") {
    if (request.offer === undefined || !Number.isInteger(request.offer) || request.offer < 0) {
      return "trade needs offer: the 0-based index of the offer the screen lists";
    }
    params.offer = request.offer;
    if (request.times !== undefined) params.times = request.times;
    return params;
  }
  if (request.action === "beacon") {
    const primary = nonEmptyText(request.beaconPrimary);
    if (!primary) return "beacon needs primary: the effect id, e.g. minecraft:speed";
    params.primary = primary;
    const secondary = nonEmptyText(request.beaconSecondary);
    if (secondary) params.secondary = secondary;
    return params;
  }
  // grindstone, smithing, cartography and take_result act on the result the screen already shows.
  return params;
}

export async function interactBlock(use: BlockUse, session: EngineSession = engine): Promise<EngineResult<InteractOutcome>> {
  const params = interactBlockParams(use);
  if (typeof params === "string") return invalid(params);
  const result = await session.call<unknown>("interact.block", params);
  if (!result.ok) return result;
  const outcome = parseInteract(result.value, "block");
  return outcome ? { ok: true, value: outcome } : malformed("interact.block", result.value);
}

/** `interact.entity`: use an entity like a right click (a villager's trades, a horse's screen, a chest boat). */
export async function interactEntity(id: string, session: EngineSession = engine): Promise<EngineResult<InteractOutcome>> {
  const params = interactEntityParams(id);
  if (typeof params === "string") return invalid(params);
  const result = await session.call<unknown>("interact.entity", params);
  if (!result.ok) return result;
  const outcome = parseInteract(result.value, "entity");
  return outcome ? { ok: true, value: outcome } : malformed("interact.entity", result.value);
}

export async function screenState(session: EngineSession = engine): Promise<EngineResult<ScreenState>> {
  const result = await session.call<unknown>("screen.state", {});
  if (!result.ok) return result;
  const state = parseScreenState(result.value);
  return state ? { ok: true, value: state } : malformed("screen.state", result.value);
}

/** `screen.move`: move items between the screen's containers the way dragging with the mouse does. */
export async function screenMove(request: ScreenMoveRequest, session: EngineSession = engine): Promise<EngineResult<ScreenMoveOutcome>> {
  const params = screenMoveParams(request);
  if (typeof params === "string") return invalid(params);
  const result = await session.call<unknown>("screen.move", params);
  if (!result.ok) return result;
  const move = parseScreenMove(result.value);
  if (!move) return malformed("screen.move", result.value);
  // An agent that does not count still moved what was asked for; an answer of 0 items stays 0.
  return { ok: true, value: { moved: move.moved ?? request.count ?? 1 } };
}

export async function screenAct(request: ScreenActRequest, session: EngineSession = engine): Promise<EngineResult<ScreenActOutcome>> {
  const params = screenActParams(request);
  if (typeof params === "string") return invalid(params);
  const result = await session.call<unknown>("screen.act", params);
  if (!result.ok) return result;
  const act = parseScreenAct(result.value);
  return act ? { ok: true, value: act } : malformed("screen.act", result.value);
}

export async function screenClose(session: EngineSession = engine): Promise<EngineResult<ScreenCloseOutcome>> {
  const result = await session.call<unknown>("screen.close", {});
  if (!result.ok) return result;
  const close = parseScreenClose(result.value);
  return close ? { ok: true, value: close } : malformed("screen.close", result.value);
}

/** One line for an interaction: what opened, or that nothing did. */
export function interactText(outcome: InteractOutcome): string {
  const what = outcome.target === "block" ? "block" : "entity";
  if (outcome.screen) return `used the ${what}: ${outcome.screen} opened`;
  return `used the ${what}: no screen opened${outcome.changed ? ", something changed" : ", nothing changed"}`;
}

/** The screen's own data in one line, or "" when it reports none. */
export function screenDataText(data: ScreenData | null): string {
  if (!data) return "";
  if (data.unavailable !== undefined) return `data unavailable: ${data.unavailable}${data.anchor ? ` (${data.anchor})` : ""}`;
  const known = (value: unknown) => (value === null ? "?" : String(value));
  const percent = (value: number | null) => (value === null ? "?" : `${Math.round(value * 100)}%`);
  const effect = (value: string | number | null) => (value === null ? "none" : String(value));
  const parts: string[] = [];
  if (data.offers) parts.push(`${data.offers.length} offer(s)`);
  if (data.recipes) parts.push(`${data.recipes.length} recipe(s)`);
  if (data.selected !== undefined) parts.push(`selected ${data.selected === null || data.selected < 0 ? "none" : data.selected}`);
  if (data.trader !== undefined) parts.push(`trader ${known(data.trader)}`);
  if (data.options) {
    const options = data.options.map(
      (option) => `${known(option.cost)}${option.lapis === null ? "" : ` (${option.lapis} lapis)`}${option.hint ? ` ${option.hint}` : ""}`,
    );
    parts.push(options.length ? `options ${options.join(", ")}` : "no options");
  }
  if (data.result !== undefined) parts.push(`result ${data.result ? `${data.result.item} x${data.result.count}` : "empty"}`);
  if (data.inputs) {
    const filled = Object.values(data.inputs).reduce((sum, slots) => sum + slots.filter((slot) => slot !== null).length, 0);
    parts.push(`${filled} input(s)`);
  }
  if (data.xpCost !== undefined) parts.push(`${known(data.xpCost)} level(s)${data.tooExpensive ? " (too expensive)" : ""}`);
  if (data.name !== undefined) parts.push(`name ${data.name ? JSON.stringify(data.name) : "(empty)"}`);
  if (data.burn !== undefined) parts.push(`burn ${percent(data.burn)}`);
  if (data.cook !== undefined) parts.push(`cook ${percent(data.cook)}`);
  if (data.brew !== undefined) parts.push(`brew ${percent(data.brew)}`);
  if (data.fuel !== undefined) parts.push(`fuel ${percent(data.fuel)}`);
  if (data.primary !== undefined) parts.push(`primary ${effect(data.primary)}`);
  if (data.secondary !== undefined) parts.push(`secondary ${effect(data.secondary)}`);
  if (data.pattern !== undefined) parts.push(`pattern ${data.pattern ? data.pattern : "none"}`);
  return parts.join(", ");
}

/** One line for a screen: its name and family, what its containers hold, and its own data. */
export function screenStateText(state: ScreenState): string {
  const parts = [`${state.screen} (${state.kind})`];
  const containers = Object.entries(state.containers).map(
    ([name, slots]) => `${name} ${slots.filter((slot) => slot !== null).length}/${slots.length}`,
  );
  if (containers.length) parts.push(containers.join(", "));
  const data = screenDataText(state.data);
  if (data) parts.push(data);
  return parts.join(": ");
}

/** One line for an act: what it made, what it took, what it cost, or why it was refused. */
export function screenActText(act: ScreenActOutcome): string {
  if (!act.done) return `refused${act.reason ? `: ${act.reason}` : ""}`;
  const made = act.result ? ` ${act.result.item} x${act.result.count}` : "";
  const consumed = act.consumed.length ? `, ${act.consumed.length} stack(s) consumed` : "";
  const xp = act.xpCost ? `, ${act.xpCost} level(s)` : "";
  return `done${made}${consumed}${xp}`;
}

/** These methods have no fallback, so a missing or older agent is answered as the requirement it is. */
function agentRequired(failure: EngineFailure): ToolResult {
  if (failure.reason === "not_attached") {
    return failureResult({ ...failure, message: `${failure.message}; this needs the in-game agent (engine_attach)` });
  }
  if (failure.reason === "unknown_method") {
    return failureResult({ ...failure, message: `${failure.message}; this agent has no screen methods: rebuild it with engine_attach` });
  }
  return failureResult(failure);
}

/** Output schemas, built from the zod sculkwire depends on. */
function schemas() {
  const maybeSlot = itemSlotSchema.nullable();
  const slotRefSchema = z.object({ container: z.string(), slot: z.number() });

  const interactSchema = {
    ...failureSchema,
    target: z.enum(["block", "entity"]).optional(),
    screen: z.string().nullable().optional(),
    changed: z.boolean().optional(),
  };

  const offerSchema = z
    .object({
      index: z.number(),
      buyA: maybeSlot,
      buyB: maybeSlot,
      sell: maybeSlot,
      uses: z.number().nullable(),
      maxUses: z.number().nullable(),
      locked: z.boolean(),
      netId: z.number().nullable(),
    })
    .catchall(z.unknown());

  const optionSchema = z
    .object({
      option: z.number(),
      cost: z.number().nullable(),
      hint: z.string().nullable(),
      level: z.number().nullable(),
      lapis: z.number().nullable().describe("lapis lazuli the option takes (option + 1)"),
      levelsTaken: z.number().nullable().describe("levels the option takes (option + 1); cost is the level it needs"),
      enchants: z.array(z.object({ id: z.number(), level: z.number() }).catchall(z.unknown())),
      netId: z.number().nullable(),
    })
    .catchall(z.unknown());

  const recipeSchema = z.object({ index: z.number(), result: maybeSlot, netId: z.number().nullable() }).catchall(z.unknown());

  // The agent's shape per kind (`ScreenData`); a kind this client does not decode passes its own fields through.
  const dataSchema = z
    .object({
      offers: z.array(offerSchema).optional(),
      selected: z.number().nullable().optional(),
      trader: z.string().nullable().optional(),
      recipes: z.array(recipeSchema).optional(),
      result: maybeSlot.optional(),
      options: z.array(optionSchema).optional(),
      burn: z.number().nullable().optional(),
      cook: z.number().nullable().optional(),
      brew: z.number().nullable().optional(),
      fuel: z.number().nullable().optional(),
      inputs: z.record(z.string(), z.array(maybeSlot)).optional(),
      xpCost: z.number().nullable().optional(),
      tooExpensive: z.boolean().nullable().optional(),
      name: z.string().nullable().optional(),
      primary: z.union([z.string(), z.number()]).nullable().optional(),
      secondary: z.union([z.string(), z.number()]).nullable().optional(),
      pattern: z.string().nullable().optional(),
      unavailable: z.string().optional(),
      anchor: z.string().nullable().optional(),
    })
    .catchall(z.unknown());

  const screenSchema = {
    ...failureSchema,
    action: z.enum(["state", "move", "act", "close"]).optional(),
    screen: z.string().optional(),
    kind: z.enum(SCREEN_KINDS).optional(),
    containers: z.record(z.string(), z.array(maybeSlot)).optional(),
    data: dataSchema.nullable().optional(),
    moved: z.number().optional(),
    from: slotRefSchema.optional(),
    to: slotRefSchema.optional(),
    closed: z.boolean().optional(),
    escapes: z.number().optional(),
    done: z.boolean().optional(),
    result: maybeSlot.optional(),
    consumed: z.array(maybeSlot).optional(),
    xpCost: z.number().optional(),
  };

  return { interactSchema, screenSchema, slotRefSchema };
}

/** `interact` and `screen`. Called by the engine feature's `register`. */
export function registerWorkstationTools(server: McpServer): void {
  const { interactSchema, screenSchema, slotRefSchema } = schemas();

  server.registerTool(
    "interact",
    {
      title: "Use a block or an entity",
      description:
        "Use a block or an entity the way a right click does, through the game's own interact path: open a chest, a " +
        "barrel, a crafting table, a furnace, a brewing stand, an anvil, a stonecutter, a loom, a smithing or " +
        "cartography table, a beacon or a villager's trades; open a horse's screen; sit in a boat or a minecart; " +
        "press a button or pull a lever. Answers the screen it opened (`screen`, null when none) and whether anything " +
        "changed. Read and drive that screen with the `screen` tool. Set the scene up first with commands (/setblock, " +
        "/summon) through engine_command. Needs the agent (engine_attach): there is no fallback for it.",
      inputSchema: {
        target: z.enum(["block", "entity"]).describe("block: a block position. entity: an entity's unique id"),
        x: z.number().int().optional().describe("block: block x"),
        y: z.number().int().optional().describe("block: block y"),
        z: z.number().int().optional().describe("block: block z"),
        dimension: dimensionSchema.optional().describe("block: overworld, nether or the_end (also minecraft:nether, or 0, 1, 2; default: the player's)"),
        face: z.enum(BLOCK_FACES).optional().describe("block: which face to use (default: the side the player looks at)"),
        id: z.string().optional().describe("entity: the entity's unique id, as a whole number in text (from game_query)"),
      },
      outputSchema: interactSchema,
    },
    async ({ target, x, y, z: bz, dimension, face, id }) => {
      if (target === "entity") {
        if (id === undefined) return invalidParamsResult("entity needs id: an entity's unique id");
        const result = await interactEntity(id);
        if (!result.ok) return agentRequired(result);
        return ok(interactText(result.value), { ok: true, ...result.value });
      }
      if (x === undefined || y === undefined || bz === undefined) return invalidParamsResult("block needs x, y and z");
      const result = await interactBlock({ x, y, z: bz, ...(dimension !== undefined ? { dimension } : {}), ...(face ? { face } : {}) });
      if (!result.ok) return agentRequired(result);
      return ok(interactText(result.value), { ok: true, ...result.value });
    },
  );

  server.registerTool(
    "screen",
    {
      title: "The screen a block or an entity opened",
      description:
        "Read and drive the screen the game has open. state: the screen, its kind (crafting table, furnace, anvil, " +
        "enchanting table, brewing stand, stonecutter, loom, smithing or cartography table, beacon, villager trade, " +
        "chest and the other containers, horse, ...), every container's slots and the screen's own data (a villager's " +
        "offers with their uses and the selected one; the stonecutter's recipes; the enchanting options; furnace burn " +
        "and cook, brewing brew and fuel, as fractions; a result screen's result and inputs; the anvil's result, XP " +
        "cost and rename text; beacon effects; the loom's pattern; `unavailable` when it cannot be read). move: move " +
        "items between the screen's containers, the way dragging with the mouse does, through the game's own item " +
        "stack requests. act: the " +
        "screen's own action (craft, stonecut, anvil, grindstone, smithing, loom, cartography, enchant, trade, beacon, " +
        "take_result) and what it made and took. close: close the screen like Escape. Open the screen with the " +
        "`interact` tool first. Needs the agent (engine_attach): there is no fallback for it.",
      inputSchema: {
        action: z
          .enum(["state", "move", "act", "close"])
          .describe("state: read the open screen. move: move items. act: its own action. close: close it like Escape"),
        from: slotRefSchema.optional().describe("move: where the items come from, e.g. { container: \"hotbar_items\", slot: 0 }"),
        to: slotRefSchema.optional().describe("move: where they go, e.g. { container: \"furnace_ingredient_items\", slot: 0 }"),
        count: z.number().int().min(1).optional().describe("move: how many items (default: the whole stack)"),
        act: z.enum(SCREEN_ACTIONS).optional().describe("act: which action to run"),
        recipe: z
          .union([z.string(), z.number().int().min(0).max(255)])
          .optional()
          .describe("act craft: the recipe id craft match returned. act stonecut: the 0-based index of a recipe in data.recipes"),
        times: z.number().int().min(1).max(1000).optional().describe("act craft/stonecut/trade: how many times"),
        name: z.string().optional().describe("act anvil: the rename text; an empty string clears the name"),
        pattern: z.string().optional().describe("act loom: the pattern id the screen lists"),
        option: z.number().int().min(0).max(2).optional().describe("act enchant: which of the three options"),
        offer: z.number().int().min(0).optional().describe("act trade: the 0-based index of the offer"),
        primary: z.string().optional().describe("act beacon: the effect id, e.g. minecraft:speed"),
        secondary: z.string().optional().describe("act beacon: the second effect id"),
      },
      outputSchema: screenSchema,
    },
    async ({ action, from, to, count: items, act, recipe, times, name, pattern, option, offer, primary, secondary }) => {
      if (action === "state") {
        const result = await screenState();
        if (!result.ok) return agentRequired(result);
        return ok(screenStateText(result.value), { ok: true, action, ...result.value });
      }
      if (action === "close") {
        const result = await screenClose();
        if (!result.ok) return agentRequired(result);
        const summary = result.value.closed ? "screen closed" : "the game kept the screen open";
        return ok(summary, { ok: true, action, ...result.value });
      }
      if (action === "move") {
        if (!from || !to) return invalidParamsResult("move needs from and to: {container, slot} each");
        const result = await screenMove({ from, to, ...(items !== undefined ? { count: items } : {}) });
        if (!result.ok) return agentRequired(result);
        return ok(`moved ${result.value.moved} item(s): ${from.container} ${from.slot} to ${to.container} ${to.slot}`, {
          ok: true,
          action,
          ...result.value,
          from,
          to,
        });
      }
      if (act === undefined) return invalidParamsResult(`act needs act: one of ${SCREEN_ACTIONS.join(", ")}`);
      const result = await screenAct({
        action: act,
        ...(recipe !== undefined ? { recipe } : {}),
        ...(times !== undefined ? { times } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(pattern !== undefined ? { pattern } : {}),
        ...(option !== undefined ? { option } : {}),
        ...(offer !== undefined ? { offer } : {}),
        ...(primary !== undefined ? { beaconPrimary: primary } : {}),
        ...(secondary !== undefined ? { beaconSecondary: secondary } : {}),
      });
      if (!result.ok) return agentRequired(result);
      return ok(screenActText(result.value), { ok: true, action, ...result.value });
    },
  );
}

/** These methods have no fallback: a missing agent is setup to fix. */
const NEEDS_AGENT = "this needs the in-game agent: run sculk engine attach first";

const INTERACT_USAGE =
  "usage: sculk interact block <x> <y> <z> [--dimension overworld|nether|the_end] [--face up|down|north|south|east|west] | sculk interact entity <unique-id>";

const interactBlockCommand: CliCommand = {
  name: "interact block",
  summary: "Use a block like a right click and say what opened: interact block <x> <y> <z> [--face up] (needs the agent)",
  async run(args) {
    return oneShot(async () => {
      const line = parseCommandLine(args, { dimension: { type: "string" }, face: { type: "string" } });
      if (!line) return ExitCode.usage;
      const dimension = stringOption(line, "dimension");
      const face = stringOption(line, "face");
      if (
        line.positionals.length !== 3 ||
        (face !== undefined && !(BLOCK_FACES as readonly string[]).includes(face)) ||
        (dimension !== undefined && !dimensionName(dimension))
      ) {
        err(INTERACT_USAGE);
        return ExitCode.usage;
      }
      const [x, y, z] = line.positionals.map(Number) as [number, number, number];
      const result = await interactBlock({ x, y, z, ...(dimension ? { dimension } : {}), ...(face ? { face: face as BlockFace } : {}) });
      if (!result.ok) return failed(result, NEEDS_AGENT);
      printJson(result.value);
      err(interactText(result.value));
      return ExitCode.ok;
    });
  },
};

const interactEntityCommand: CliCommand = {
  name: "interact entity",
  summary: "Use an entity like a right click (a villager's trades, a horse's screen, a chest boat): interact entity <id>",
  async run(args) {
    return oneShot(async () => {
      const line = parseCommandLine(args);
      if (!line) return ExitCode.usage;
      const id = line.positionals.join(" ").trim();
      if (line.positionals.length !== 1 || !id) {
        err(INTERACT_USAGE);
        return ExitCode.usage;
      }
      const result = await interactEntity(id);
      if (!result.ok) return failed(result, NEEDS_AGENT);
      printJson(result.value);
      err(interactText(result.value));
      return ExitCode.ok;
    });
  },
};

const SCREEN_USAGE =
  "usage: sculk screen state | sculk screen move <container:slot> <container:slot> [--count N] | sculk screen act <action> [--recipe id|index] [--times N] [--name text] [--pattern id] [--option 0|1|2] [--offer N] [--primary effect] [--secondary effect] | sculk screen close";

const screenStateCommand: CliCommand = {
  name: "screen state",
  summary: "The open screen: its kind, its containers and its own data (anvil, offers, furnace progress, ...) (needs the agent)",
  async run(args) {
    return oneShot(async () => {
      const line = parseCommandLine(args);
      if (!line) return ExitCode.usage;
      if (line.positionals.length) {
        err("screen state takes no arguments");
        return ExitCode.usage;
      }
      const result = await screenState();
      if (!result.ok) return failed(result, NEEDS_AGENT);
      printJson(result.value);
      err(screenStateText(result.value));
      return ExitCode.ok;
    });
  },
};

const screenMoveCommand: CliCommand = {
  name: "screen move",
  summary: "Move items inside the open screen: screen move <container:slot> <container:slot> [--count N] (needs the agent)",
  async run(args) {
    return oneShot(async () => {
      const line = parseCommandLine(args, { count: { type: "string" } });
      if (!line) return ExitCode.usage;
      if (line.positionals.length !== 2) {
        err(SCREEN_USAGE);
        return ExitCode.usage;
      }
      const [fromText, toText] = line.positionals as [string, string];
      const from = parseSlotRef(fromText);
      if (typeof from === "string") {
        err(from);
        return ExitCode.usage;
      }
      const to = parseSlotRef(toText);
      if (typeof to === "string") {
        err(to);
        return ExitCode.usage;
      }
      const countText = stringOption(line, "count");
      const items = countText === undefined ? undefined : Number(countText);
      const result = await screenMove({ from, to, ...(items !== undefined ? { count: items } : {}) });
      if (!result.ok) return failed(result, NEEDS_AGENT);
      printJson({ ...result.value, from, to });
      err(`moved ${result.value.moved} item(s): ${from.container} ${from.slot} to ${to.container} ${to.slot}`);
      return ExitCode.ok;
    });
  },
};

const SCREEN_ACT_FLAGS = ["recipe", "times", "name", "pattern", "option", "offer", "primary", "secondary"] as const;

const screenActCommand: CliCommand = {
  name: "screen act",
  summary:
    "The open screen's own action: screen act craft|stonecut|anvil|grindstone|smithing|loom|cartography|enchant|trade|" +
    "beacon|take_result [its parameters] (needs the agent)",
  async run(args) {
    return oneShot(async () => {
      const line = parseCommandLine(args, Object.fromEntries(SCREEN_ACT_FLAGS.map((flag) => [flag, { type: "string" as const }])));
      if (!line) return ExitCode.usage;
      const [action, ...rest] = line.positionals;
      if (!action || rest.length) {
        err(SCREEN_USAGE);
        return ExitCode.usage;
      }
      const text = (name: (typeof SCREEN_ACT_FLAGS)[number]) => stringOption(line, name);
      const number = (name: (typeof SCREEN_ACT_FLAGS)[number]): number | undefined => {
        const value = text(name);
        return value === undefined ? undefined : Number(value);
      };
      const request: ScreenActRequest = {
        action: action as ScreenActAction,
        ...optional("recipe", text("recipe")),
        ...optional("times", number("times")),
        ...optional("name", text("name")),
        ...optional("pattern", text("pattern")),
        ...optional("option", number("option")),
        ...optional("offer", number("offer")),
        ...optional("beaconPrimary", text("primary")),
        ...optional("beaconSecondary", text("secondary")),
      };
      const result = await screenAct(request);
      if (!result.ok) return failed(result, NEEDS_AGENT);
      printJson(result.value);
      err(screenActText(result.value));
      return ExitCode.ok;
    });
  },
};

/** `{ [key]: value }` when the value was given, `{}` otherwise. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

const screenCloseCommand: CliCommand = {
  name: "screen close",
  summary: "Close the open screen like Escape (needs the agent)",
  async run(args) {
    return oneShot(async () => {
      const line = parseCommandLine(args);
      if (!line) return ExitCode.usage;
      if (line.positionals.length) {
        err("screen close takes no arguments");
        return ExitCode.usage;
      }
      const result = await screenClose();
      if (!result.ok) return failed(result, NEEDS_AGENT);
      printJson(result.value);
      err(result.value.closed ? "screen closed" : "the game kept the screen open");
      return ExitCode.ok;
    });
  },
};

export const workstationCommands: CliCommand[] = [
  interactBlockCommand,
  interactEntityCommand,
  screenStateCommand,
  screenMoveCommand,
  screenActCommand,
  screenCloseCommand,
];
