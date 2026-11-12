/**
 * A tiny in-memory world for the task step tests: the player's inventory, blocks with containers, stations whose
 * screens enforce their slot rules and refuse wrong moves, a furnace that needs fuel and time, villagers with offers
 * and walkable positions. It answers every `TaskEnv` call the way the game's agent and helper pack shape their answers.
 * Test-only: nothing outside the tests imports it.
 */
import type { EngineFailure, EngineResult } from "../runtime/engine/failure.ts";
import type { PlayerInventory } from "../runtime/engine/inventory.ts";
import type { ItemSlot, Slot } from "../runtime/engine/slot.ts";
import type { ScreenKind, ScreenSlotRef, ScreenState, TradeOffer } from "../runtime/engine/workstation.ts";
import type { Clock } from "../runtime/client/clock.ts";
import type { Vec3 } from "../runtime/client/types.ts";
import { armorSlotOf, namespaced } from "../runtime/client/tasks/ids.ts";
import { fuelValue, matches, parseRecipe, RecipeIndex, type Recipe } from "../runtime/client/tasks/recipes.ts";
import { runTaskStep } from "../runtime/client/tasks/steps.ts";
import type { BlockInfo, TaskEnv, TaskStep, TaskStepResult } from "../runtime/client/tasks/types.ts";
import { drive, fakeClock } from "./faketime.ts";

const GROUND_Y = 64;
const SMELT_MS = 10_000;

/** A shaped recipe in the behavior pack's recipe format, for a test's recipe index. */
export function shapedRecipe(id: string, pattern: string[], key: Record<string, object>, result: object, tags = ["crafting_table"]): string {
  return JSON.stringify({ format_version: "1.20.10", "minecraft:recipe_shaped": { description: { identifier: id }, tags, pattern, key, result } });
}

/** A furnace recipe in the behavior pack's recipe format. */
export function furnaceRecipe(id: string, input: string, output: string, tags = ["furnace"]): string {
  return JSON.stringify({ format_version: "1.20.10", "minecraft:recipe_furnace": { description: { identifier: id }, tags, input, output } });
}

/** A world on the fake clock whose recipe index holds these recipe texts. */
export function fakeTaskWorld(recipes: readonly string[]): FakeWorld {
  return new FakeWorld(fakeClock, new RecipeIndex(recipes.map((text) => parseRecipe(text, "vanilla")).filter((recipe): recipe is Recipe => !!recipe), "the test recipes"));
}

/** Run a task step in the world, advancing the fake clock (fake timers on) until it ends. */
export function runFakeStep(world: FakeWorld, step: TaskStep): Promise<TaskStepResult> {
  return drive(runTaskStep(step, world.env()), 100, 300_000);
}

export function stack(item: string, count = 1, contents?: Slot[]): ItemSlot {
  return { item: namespaced(item), count, enchantments: [], ...(contents ? { contents } : {}) };
}

function key(at: Vec3): string {
  return `${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}`;
}

function refused(message: string): EngineFailure {
  return { ok: false, code: -32602, reason: "invalid_params", message };
}

function ok<T>(value: T): EngineResult<T> {
  return { ok: true, value };
}

interface FakeBlock {
  typeId: string;
  /** Chests, barrels, shulker boxes: 27 slots. Furnaces: [input, fuel, output]. */
  slots?: Slot[];
  /** Furnace: time left on the burning fuel and progress on the current item, in ms; last time it was advanced. */
  burnMs?: number;
  burnTotalMs?: number;
  cookMs?: number;
  at?: number;
}

export interface FakeVillager {
  id: string;
  typeId: string;
  location: Vec3;
  offers: TradeOffer[];
}

interface OpenScreen {
  kind: ScreenKind;
  screen: string;
  block?: string;
  villager?: string;
  /** Trade ingredients and the inventory's crafting grid, returned to the player on close. */
  trade?: [Slot, Slot];
  armor?: Slot[];
}

/** A refusal the next matching move gets once: the game answering `invalid_params` with `reason`. */
export interface MoveRefusal {
  to?: string;
  from?: string;
  reason: string;
}

const KIND_BY_BLOCK: [RegExp, ScreenKind][] = [
  [/(^|:)crafting_table$/, "crafting_table"],
  [/(^|:)(lit_)?furnace$/, "furnace"],
  [/(^|:)(lit_)?blast_furnace$/, "blast_furnace"],
  [/(^|:)(lit_)?smoker$/, "smoker"],
  [/shulker_box$/, "shulker_box"],
  [/barrel$/, "barrel"],
  [/chest$/, "chest"],
];

export class FakeWorld {
  readonly clock: Clock;
  readonly recipes: RecipeIndex | undefined;
  position: Vec3 = { x: 0.5, y: GROUND_Y, z: 0.5 };
  inventory: PlayerInventory = {
    selectedSlot: 1,
    hotbar: Array<Slot>(9).fill(null),
    inventory: Array<Slot>(27).fill(null),
    armor: { head: null, chest: null, legs: null, feet: null },
    offhand: null,
    cursor: null,
  };
  readonly blocks = new Map<string, FakeBlock>();
  readonly villagers: FakeVillager[] = [];
  /** Block keys the pathfinder finds no way to. */
  readonly unreachable = new Set<string>();
  readonly refusals: MoveRefusal[] = [];
  screen: OpenScreen | null = null;
  /** Calls the tests count: screens closed, input releases, moves. */
  closes = 0;
  releases = 0;
  moves: string[] = [];
  /** Every use sent: `x,y,z[@face] from x,y,z` for blocks, `entity <id> from x,y,z` for entities. */
  uses: string[] = [];
  /** Block key -> the player cells (feet) from which the view to it is blocked; `*` blocks it from everywhere. */
  readonly blockedFrom = new Map<string, Set<string>>();
  /** Block key -> the block whose screen opens instead, from one player cell or from everywhere (`*`). */
  readonly opensInstead = new Map<string, { from: string; opens: string }>();
  /** Villager id -> the player cells from which a block stands between the eye and it. */
  readonly entityBlockedFrom = new Map<string, Set<string>>();
  /** Villager id -> another villager in the line of sight from these player cells (the use goes to it). */
  readonly entityInFront = new Map<string, { from: Set<string>; other: string }>();
  /** The centre of every `blocks` query, in order (`x,y,z`). */
  blockQueries: string[] = [];
  /** Whether the chunk at a position is loaded; the `block` query reads null where it is not. */
  loaded: (at: Vec3) => boolean = () => true;
  /** The trade screen does not report its trader's id. */
  hideTrader = false;
  /** Each walk takes this long. */
  walkMs = 0;
  /** The entity the view was last turned onto (or the agent aimed at). */
  aimedAt: string | undefined;
  /** The inventory screen reads as not open for this many more `screen.state` calls after the key. */
  inventoryLagPolls = 0;
  /** This many more screen acts are answered `anchor_missing` "not readable now". */
  notReadableActs = 0;
  /** Entity type -> the error the helper's `entities` query throws for it. */
  readonly entityErrors = new Map<string, string>();
  /** After a move into the player's slots, the next inventory read still shows the inventory from before it. */
  lagInventoryReads = false;
  #staleInventory: PlayerInventory | undefined;
  /** `readContainer` reports every stack inside a nested shulker box as 1 item. */
  nestedReadsShort = false;
  /** Floor block keys whose top face no view reaches (placing a box on them is refused). */
  readonly noViewFloors = new Set<string>();

  constructor(clock: Clock, recipes?: RecipeIndex) {
    this.clock = clock;
    this.recipes = recipes;
  }

  give(item: string, count: number, where: "hotbar" | "inventory" = "inventory"): void {
    const list = where === "hotbar" ? this.inventory.hotbar : this.inventory.inventory;
    const free = list.findIndex((slot) => !slot);
    list[free] = stack(item, count);
  }

  place(typeId: string, at: Vec3, slots?: Slot[]): void {
    const block: FakeBlock = { typeId: namespaced(typeId) };
    if (slots) {
      const size = /furnace|smoker/.test(typeId) ? 3 : 27;
      block.slots = [...slots, ...Array<Slot>(Math.max(0, size - slots.length)).fill(null)];
    }
    if (/furnace|smoker/.test(typeId)) {
      block.slots ??= [null, null, null];
      block.burnMs = 0;
      block.burnTotalMs = 0;
      block.cookMs = 0;
      block.at = this.clock.now();
    }
    this.blocks.set(key(at), block);
  }

  villager(id: string, at: Vec3, offers: Omit<TradeOffer, "index" | "netId" | "locked">[]): void {
    this.villagers.push({ id, typeId: "minecraft:villager_v2", location: at, offers: offers.map((offer, index) => ({ ...offer, index, netId: index + 1, locked: false })) });
  }

  count(item: string): number {
    let n = 0;
    for (const slot of [...this.inventory.hotbar, ...this.inventory.inventory, this.inventory.offhand, ...Object.values(this.inventory.armor)]) if (slot?.item === namespaced(item)) n += slot.count;
    return n;
  }

  blockAt(at: Vec3): FakeBlock | undefined {
    return this.blocks.get(key(at));
  }

  #smeltsTo(item: string): string | undefined {
    for (const recipe of this.recipes?.smeltingFrom(item) ?? []) return recipe.result.item;
    return undefined;
  }

  /** Run every furnace up to now, 50 ms at a time: fuel burns while something smelts, one item every 10 s. */
  #advance(): void {
    const now = this.clock.now();
    for (const block of this.blocks.values()) {
      if (block.at === undefined || !block.slots) continue;
      while (block.at < now) {
        const dt = Math.min(50, now - block.at);
        block.at += dt;
        const [input, fuel, output] = block.slots;
        const result = input ? this.#smeltsTo(input.item) : undefined;
        const fits = result && (!output || (output.item === result && output.count < 64));
        if (!fits) {
          block.cookMs = 0;
          block.burnMs = Math.max(0, (block.burnMs ?? 0) - dt);
          continue;
        }
        if ((block.burnMs ?? 0) <= 0) {
          const value = fuel ? fuelValue(fuel.item) : undefined;
          if (!fuel || value === undefined) {
            block.cookMs = 0;
            continue;
          }
          block.burnMs = value * SMELT_MS;
          block.burnTotalMs = block.burnMs;
          block.slots[1] = fuel.count > 1 ? { ...fuel, count: fuel.count - 1 } : null;
        }
        block.burnMs = (block.burnMs ?? 0) - dt;
        block.cookMs = (block.cookMs ?? 0) + dt;
        if (block.cookMs >= SMELT_MS && input && result) {
          block.cookMs = 0;
          block.slots[0] = input.count > 1 ? { ...input, count: input.count - 1 } : null;
          block.slots[2] = output ? { ...output, count: output.count + 1 } : stack(result, 1);
        }
      }
    }
  }

  /** The slot array and index a reference names in the open screen, or why it names none. */
  #resolve(ref: ScreenSlotRef): { slots: Slot[]; index: number; role: string } | string {
    const screen = this.screen;
    if (!screen) return "no screen is open";
    const name = ref.container;
    if (name === "hotbar_items" || name === "HotbarContainer") return { slots: this.inventory.hotbar, index: ref.slot, role: "hotbar" };
    if (name === "inventory_items" || name === "InventoryContainer") return { slots: this.inventory.inventory, index: ref.slot, role: "inventory" };
    const block = screen.block ? this.blocks.get(screen.block) : undefined;
    if (screen.kind === "inventory") {
      if (name === "armor_items" || name === "ArmorContainer") return { slots: screen.armor ?? [], index: ref.slot, role: "armor" };
      if (name === "offhand_items" || name === "OffhandContainer") return { slots: [this.inventory.offhand], index: 0, role: "offhand" };
    }
    if (block?.slots && (screen.kind === "furnace" || screen.kind === "blast_furnace" || screen.kind === "smoker")) {
      const roles: Record<string, number> = { furnace_ingredient_items: 0, furnace_fuel_items: 1, furnace_output_items: 2 };
      const at = roles[name];
      if (at !== undefined && ref.slot === 0) return { slots: block.slots, index: at, role: ["input", "fuel", "output"][at] ?? "" };
    }
    if (block?.slots && name === "container_items") return { slots: block.slots, index: ref.slot, role: "container" };
    if (screen.trade && (name === "trade2_ingredient1_item" || name === "trade2_ingredient2_item") && ref.slot === 0) {
      return { slots: screen.trade, index: name.endsWith("1_item") ? 0 : 1, role: "trade" };
    }
    return `the open screen has no container ${name}`;
  }

  #state(): ScreenState | undefined {
    const screen = this.screen;
    if (!screen) return undefined;
    this.#advance();
    const containers: Record<string, Slot[]> = { hotbar_items: [...this.inventory.hotbar], inventory_items: [...this.inventory.inventory] };
    const block = screen.block ? this.blocks.get(screen.block) : undefined;
    let data: ScreenState["data"] = null;
    if (screen.kind === "furnace" && block?.slots) {
      containers.furnace_ingredient_items = [block.slots[0] ?? null];
      containers.furnace_fuel_items = [block.slots[1] ?? null];
      containers.furnace_output_items = [block.slots[2] ?? null];
      data = { burn: block.burnTotalMs ? Math.max(0, (block.burnMs ?? 0) / block.burnTotalMs) : 0, cook: (block.cookMs ?? 0) / SMELT_MS };
    } else if ((screen.kind === "chest" || screen.kind === "barrel" || screen.kind === "shulker_box") && block?.slots) {
      containers.container_items = [...block.slots];
    } else if (screen.kind === "crafting_table") {
      containers.crafting_input_items = Array<Slot>(9).fill(null);
    } else if (screen.kind === "inventory") {
      containers.armor_items = [...(screen.armor ?? [])];
      containers.offhand_items = [this.inventory.offhand];
      containers.crafting_input_items = Array<Slot>(4).fill(null);
    } else if (screen.kind === "trade" && screen.trade) {
      containers.trade2_ingredient1_item = [screen.trade[0]];
      containers.trade2_ingredient2_item = [screen.trade[1]];
      const villager = this.villagers.find((v) => v.id === screen.villager);
      data = { offers: villager?.offers ?? [], selected: -1, trader: this.hideTrader ? null : (screen.villager ?? null) };
    }
    return { screen: screen.screen, kind: screen.kind, containers, data };
  }

  #emptyCarried(): { slots: Slot[]; index: number } | undefined {
    for (const slots of [this.inventory.hotbar, this.inventory.inventory]) {
      const index = slots.findIndex((slot) => !slot);
      if (index >= 0) return { slots, index };
    }
    return undefined;
  }

  #take(item: string, count: number): boolean {
    if (this.count(item) < count) return false;
    let left = count;
    for (const slots of [this.inventory.hotbar, this.inventory.inventory]) {
      for (let i = 0; i < slots.length && left > 0; i++) {
        const slot = slots[i];
        if (slot?.item !== namespaced(item)) continue;
        const n = Math.min(slot.count, left);
        left -= n;
        slots[i] = slot.count > n ? { ...slot, count: slot.count - n } : null;
      }
    }
    return true;
  }

  #giveResult(item: string, count: number): void {
    const target = this.#emptyCarried();
    if (target) target.slots[target.index] = stack(item, count);
  }

  #move(from: ScreenSlotRef, to: ScreenSlotRef, count?: number): EngineResult<{ moved: number }> {
    this.#advance();
    const before = structuredClone(this.inventory);
    const text = `${from.container}:${from.slot}>${to.container}:${to.slot}`;
    const refusal = this.refusals.findIndex((r) => (!r.to || r.to === `${to.container}:${to.slot}`) && (!r.from || r.from === `${from.container}:${from.slot}`));
    if (refusal >= 0) {
      const [r] = this.refusals.splice(refusal, 1);
      return refused(r?.reason ?? "refused");
    }
    const source = this.#resolve(from);
    const target = this.#resolve(to);
    if (typeof source === "string") return refused(source);
    if (typeof target === "string") return refused(target);
    const moving = source.slots[source.index];
    if (!moving) return refused(`${from.container}:${from.slot} is empty`);
    const there = target.slots[target.index];
    if (there && there.item !== moving.item) return refused(`${to.container}:${to.slot} holds ${there.item}`);
    if (target.role === "output") return refused("nothing can be put into a furnace's output");
    if (target.role === "fuel" && fuelValue(moving.item) === undefined) return refused(`${moving.item} is not a fuel`);
    if (target.role === "armor" && armorSlotOf(moving.item) === undefined) return refused(`${moving.item} cannot be worn`);
    if (target.role === "offhand" && moving.item !== "minecraft:shield") return refused(`${moving.item} cannot go in the off hand`);
    const n = Math.min(count ?? moving.count, moving.count, 64 - (there?.count ?? 0));
    source.slots[source.index] = moving.count > n ? { ...moving, count: moving.count - n } : null;
    target.slots[target.index] = there ? { ...there, count: there.count + n } : { ...moving, count: n };
    if (target.role === "offhand") this.inventory.offhand = target.slots[0] ?? null;
    if (source.role === "offhand") this.inventory.offhand = source.slots[0] ?? null;
    if (target.role === "armor" && this.screen?.armor) this.#syncArmor();
    this.moves.push(`${text} ${n}`);
    if (this.lagInventoryReads && (target.role === "hotbar" || target.role === "inventory")) this.#staleInventory = before;
    return ok({ moved: n });
  }

  #syncArmor(): void {
    const armor = this.screen?.armor ?? [];
    this.inventory.armor = { head: armor[0] ?? null, chest: armor[1] ?? null, legs: armor[2] ?? null, feet: armor[3] ?? null };
  }

  /** The game's own recipe lookup: the recipe whose shape (or ingredient list) the grid or list fills exactly. */
  #lookup(grid: (string | null)[][] | undefined, ingredients: string[] | undefined, table: boolean): Recipe | undefined {
    const all: Recipe[] = [];
    for (const id of this.recipes?.items() ?? []) for (const recipe of this.recipes?.recipesFor(id) ?? []) if (!all.includes(recipe)) all.push(recipe);
    for (const recipe of all) {
      if (!recipe.stations.includes("crafting_table")) continue;
      if (grid && recipe.grid) {
        const rows = recipe.grid;
        if (!table && (rows.length > 2 || rows.some((row) => row.length > 2))) continue;
        const okGrid = [0, 1, 2].every((r) =>
          [0, 1, 2].every((c) => {
            const want = rows[r]?.[c] ?? null;
            const have = grid[r]?.[c] ?? null;
            return want ? !!have && matches(want, have) : !have;
          }),
        );
        if (okGrid) return recipe;
      }
      if (ingredients && recipe.kind === "shapeless") {
        const left = [...ingredients];
        const fits = recipe.inputs.every((input) => {
          for (let n = 0; n < input.count; n++) {
            const at = left.findIndex((id) => matches(input.ingredient, id));
            if (at < 0) return false;
            left.splice(at, 1);
          }
          return true;
        });
        if (fits && !left.length) return recipe;
      }
    }
    return undefined;
  }

  env(extra: { recipesNote?: string; noLookAt?: boolean } = {}): TaskEnv {
    return {
      controller: {
        walkTo: async (target, _radius, signal) => {
          if (this.walkMs) await this.clock.sleep(this.walkMs, signal);
          if ("entity" in target) {
            const villager = this.villagers.find((v) => v.id === target.entity);
            if (!villager) return { ok: false, message: "the entity is gone" };
            this.position = { x: villager.location.x + 1, y: GROUND_Y, z: villager.location.z };
            return { ok: true, message: "arrived" };
          }
          if (this.unreachable.has(key(target))) return { ok: false, message: "no path found" };
          // A station's cell cannot be stood in: the walk ends one block east of it. Any other point is reached.
          this.position = this.blockAt(target) ? { x: target.x + 1, y: GROUND_Y, z: target.z } : { ...target };
          return { ok: true, message: "arrived" };
        },
        position: async () => ({ ...this.position }),
        selectSlot: async (slot) => {
          this.inventory.selectedSlot = slot;
          return true;
        },
        openInventory: async () => {
          const armor = [this.inventory.armor.head, this.inventory.armor.chest, this.inventory.armor.legs, this.inventory.armor.feet];
          this.screen = { kind: "inventory", screen: "inventory_screen", armor };
          return ok({});
        },
        release: async () => {
          this.releases++;
        },
        ...(extra.noLookAt
          ? {}
          : {
              lookAt: async (point: Vec3) => {
                this.aimedAt = this.villagers.reduce<FakeVillager | undefined>(
                  (best, v) => (!best || Math.hypot(v.location.x - point.x, v.location.z - point.z) < Math.hypot(best.location.x - point.x, best.location.z - point.z) ? v : best),
                  undefined,
                )?.id;
                return true;
              },
            }),
        lookingAt: async () => {
          const aimed = this.aimedAt;
          if (!aimed) return {};
          const spot = key(this.position);
          const hidden = this.entityBlockedFrom.get(aimed);
          if (hidden && (hidden.has("*") || hidden.has(spot))) return { block: { x: Math.floor(this.position.x), y: GROUND_Y + 1, z: Math.floor(this.position.z) } };
          const front = this.entityInFront.get(aimed);
          if (front?.from.has(spot)) return { entity: front.other };
          return { entity: aimed };
        },
      },
      engine: {
        interactBlock: async (use) => {
          const at = { x: use.x, y: use.y, z: use.z };
          const held = this.inventory.hotbar[this.inventory.selectedSlot - 1];
          const block = this.blockAt(at);
          if (held && /shulker_box$/.test(held.item) && use.face === "up" && !block) {
            if (this.noViewFloors.has(key(at))) {
              return refused(`no view from the player's eye reaches the block at ${key(at).replaceAll(",", " ")}: the crosshair lands on the block at ${key(this.position).replaceAll(",", " ")} instead; move the player so nothing is in the way`);
            }
            const above = { ...at, y: at.y + 1 };
            if (this.blockAt(above) || above.y !== GROUND_Y) return refused("the block above is not free");
            this.place(held.item, above, held.contents ?? []);
            this.inventory.hotbar[this.inventory.selectedSlot - 1] = null;
            return ok({ target: "block" as const, screen: null, changed: true });
          }
          const spot = key(this.position);
          this.uses.push(`${key(at)}${use.face ? `@${use.face}` : ""} from ${spot}`);
          const blocked = this.blockedFrom.get(key(at));
          if (blocked && (blocked.has("*") || blocked.has(spot))) {
            return refused(`no view from the player's eye reaches the block at ${key(at).replaceAll(",", " ")}: the crosshair lands on the block at ${spot.replaceAll(",", " ")} instead; move the player so nothing is in the way`);
          }
          const instead = this.opensInstead.get(key(at));
          const opened = instead && (instead.from === "*" || instead.from === spot) ? instead.opens : key(at);
          const target = this.blocks.get(opened);
          const kind = target && KIND_BY_BLOCK.find(([pattern]) => pattern.test(target.typeId))?.[1];
          if (!target || !kind) return ok({ target: "block" as const, screen: null, changed: false });
          this.screen = { kind, screen: `${kind}_screen`, block: opened };
          return ok({ target: "block" as const, screen: `${kind}_screen`, changed: true });
        },
        interactEntity: async (id) => {
          const villager = this.villagers.find((v) => v.id === id);
          if (!villager) return refused(`no entity ${id}`);
          this.uses.push(`entity ${id} from ${key(this.position)}`);
          this.aimedAt = id;
          // The agent does not check what its aim struck: another trader in the line of sight gets the use.
          const front = this.entityInFront.get(id);
          const used = front?.from.has(key(this.position)) ? front.other : id;
          this.screen = { kind: "trade", screen: "trade_screen", villager: used, trade: [null, null] };
          return ok({ target: "entity" as const, screen: "trade_screen", changed: true });
        },
        containerOpen: async () => {
          const screen = this.screen;
          if (!screen) return refused("no screen is open");
          const block = screen.block ? this.blocks.get(screen.block) : undefined;
          const [x = 0, y = 0, z = 0] = (screen.block ?? "").split(",").map(Number);
          return ok({
            screen: screen.screen,
            block: block?.typeId ?? null,
            position: screen.block ? { x, y, z } : null,
            slots: [...(block?.slots ?? [])],
            playerSlots: [...this.inventory.hotbar, ...this.inventory.inventory],
          });
        },
        screenState: async () => {
          if (this.screen?.kind === "inventory" && this.inventoryLagPolls > 0) {
            this.inventoryLagPolls--;
            return refused("no screen is open");
          }
          const state = this.#state();
          return state ? ok(state) : refused("no screen is open");
        },
        screenMove: async (request) => this.#move(request.from, request.to, request.count),
        screenAct: async (request) => {
          const screen = this.screen;
          if (!screen) return refused("no screen is open");
          if (this.notReadableActs > 0) {
            this.notReadableActs--;
            return { ok: false, code: -32001, reason: "anchor_missing", message: "anchor not resolved: the open screen's controller is not readable now" };
          }
          this.#advance();
          if (request.action === "craft") {
            if (screen.kind !== "crafting_table" && screen.kind !== "inventory") return refused("craft needs a crafting screen");
            const recipe = [...(this.recipes?.items() ?? [])].flatMap((id) => this.recipes?.recipesFor(id) ?? []).find((r) => r.id === request.recipe);
            if (!recipe) return refused(`no recipe ${String(request.recipe)}`);
            const times = request.times ?? 1;
            for (let t = 0; t < times; t++) {
              for (const input of recipe.inputs) {
                const id = Object.keys(this.#counts()).find((candidate) => matches(input.ingredient, candidate) && this.count(candidate) >= input.count);
                if (!id || !this.#take(id, input.count)) return ok({ done: false, result: null, consumed: [], reason: "the grid's ingredients ran out" });
              }
              this.#giveResult(recipe.result.item, recipe.result.count);
            }
            return ok({ done: true, result: stack(recipe.result.item, recipe.result.count * times), consumed: [] });
          }
          if (request.action === "take_result") {
            const block = screen.block ? this.blocks.get(screen.block) : undefined;
            const out = block?.slots?.[2];
            if (!block?.slots || !out) return refused("the screen's result is empty");
            block.slots[2] = null;
            this.#giveResult(out.item, out.count);
            return ok({ done: true, result: out, consumed: [] });
          }
          if (request.action === "trade") {
            const villager = this.villagers.find((v) => v.id === screen.villager);
            const offer = villager?.offers[request.offer ?? -1];
            if (!villager || !offer || !screen.trade) return refused("no such offer");
            const times = request.times ?? 1;
            const [a, b] = screen.trade;
            const short = (want: Slot, have: Slot) => !!want && (!have || have.item !== want.item || have.count < want.count * times);
            if (short(offer.buyA, a) || short(offer.buyB, b)) return ok({ done: false, result: null, consumed: [], reason: "the trade's inputs are short" });
            if (offer.buyA && a) screen.trade[0] = a.count > offer.buyA.count * times ? { ...a, count: a.count - offer.buyA.count * times } : null;
            if (offer.buyB && b) screen.trade[1] = b.count > offer.buyB.count * times ? { ...b, count: b.count - offer.buyB.count * times } : null;
            if (offer.sell) this.#giveResult(offer.sell.item, offer.sell.count * times);
            offer.uses = (offer.uses ?? 0) + times;
            return ok({ done: true, result: offer.sell, consumed: [] });
          }
          return refused(`${request.action} is not supported here`);
        },
        screenClose: async () => {
          if (!this.screen) return refused("no screen is open");
          for (const slot of this.screen.trade ?? []) if (slot) this.#giveResult(slot.item, slot.count);
          this.screen = null;
          this.closes++;
          return ok({ closed: true });
        },
        readContainer: async (at) => {
          this.#advance();
          const block = this.blockAt(at);
          if (!block?.slots) return refused("the block has no container");
          const read = (slot: Slot): Slot => {
            if (!slot) return null;
            // A nested box's contents read short: every stack inside reads as 1.
            const contents = slot.contents && this.nestedReadsShort ? slot.contents.map((inner) => (inner ? { ...inner, count: 1 } : null)) : slot.contents;
            return { ...slot, ...(contents ? { contents } : {}) };
          };
          return ok({ block: block.typeId, size: block.slots.length, slots: block.slots.map(read) });
        },
        readInventory: async () => {
          // A read that lags one move behind: the inventory as it was before the last move, once.
          const stale = this.#staleInventory;
          this.#staleInventory = undefined;
          return ok({ source: "engine" as const, attributes: {}, inventory: stale ?? structuredClone(this.inventory) });
        },
        craftMatch: async (request) => {
          const recipe = this.#lookup(request.grid, request.ingredients, request.table ?? false);
          return ok(recipe ? { result: stack(recipe.result.item, recipe.result.count), recipe: { id: recipe.id, type: recipe.kind } } : { result: null, recipe: null });
        },
      },
      query: {
        blocks: async (types, radius, at) => {
          // The helper's cube: at most 16 blocks from its centre on each axis, around `at` or the player.
          const c = at ?? this.position;
          const r = Math.min(radius, 16);
          const cx = Math.floor(c.x);
          const cy = Math.floor(c.y);
          const cz = Math.floor(c.z);
          this.blockQueries.push(`${cx},${cy},${cz}`);
          const out: BlockInfo[] = [];
          for (const [where, block] of this.blocks) {
            const [x = 0, y = 0, z = 0] = where.split(",").map(Number);
            if (types.includes(block.typeId) && Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) <= r) out.push({ typeId: block.typeId, location: { x, y, z } });
          }
          return out;
        },
        entities: async (type, radius) => {
          const error = this.entityErrors.get(type);
          if (error) throw new Error(error);
          return this.villagers.filter((v) => v.typeId === type && Math.hypot(v.location.x - this.position.x, v.location.z - this.position.z) <= radius).map((v) => ({ id: v.id, typeId: v.typeId, location: v.location }));
        },
        block: async (at) => {
          if (!this.loaded(at)) return null;
          const block = this.blockAt(at);
          if (block) return { typeId: block.typeId, location: { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } };
          return { typeId: Math.floor(at.y) < GROUND_Y ? "minecraft:stone" : "minecraft:air", location: { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } };
        },
      },
      ...(this.recipes ? { recipes: this.recipes } : {}),
      ...(extra.recipesNote ? { recipesNote: extra.recipesNote } : {}),
      clock: this.clock,
    };
  }

  #counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const slot of [...this.inventory.hotbar, ...this.inventory.inventory]) if (slot) out[slot.item] = (out[slot.item] ?? 0) + slot.count;
    return out;
  }
}
