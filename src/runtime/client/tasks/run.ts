/**
 * One step's run: the shared moves every step is built from. It walks to stations, opens and reads their screens,
 * moves items through the screens' own requests, makes a missing ingredient first (fetched from the containers near
 * or made by a recipe from the index, three levels deep with a cycle guard), and repairs a refused move by a fixed
 * order of repairs (another slot, the missing item fetched, another station, giving up). It records what it did, in
 * order, in `actions`. The screen it opened is always closed (`close`), whatever ends the step.
 */
import type { EngineFailure, EngineResult } from "../../engine/engine.ts";
import type { PlayerInventory, Slot } from "../../engine/inventory.ts";
import type { BlockFace, ScreenKind, ScreenSlotRef, ScreenState } from "../../engine/workstation.ts";
import type { Vec3 } from "../player.ts";
import {
  bareId,
  FURNACE_STATIONS,
  fitsInventoryGrid,
  fuelRank,
  fuelValue,
  FUELS,
  ingredientKey,
  ingredientText,
  inTag,
  matches,
  namespaced,
  type Ingredient,
  type Recipe,
  type Station,
} from "./recipes.ts";
import { carriedStacks, countOf, countsIn, countsOf, refText, slotsOf, stationKey, type CarriedStack } from "./stock.ts";
import { findBlocks, findEntities, notFoundText, type Found } from "./search.ts";
import {
  cellOf,
  EYE_HEIGHT,
  facesToward,
  MS_PER_TARGET,
  sameCell,
  shortReason,
  SPOT_ARRIVE,
  SPOTS_PER_TARGET,
  spotCandidates,
  standable,
  USES_PER_TARGET,
} from "./aim.ts";
import type { BlockInfo, EntitySeen, InventoryCounts, TaskEnv, TaskFailure } from "./types.ts";

/** Sub-goals go this deep (an ingredient of an ingredient of an ingredient). */
export const MAX_DEPTH = 3;
/** Stations of one type tried before giving up on that type. */
const STATIONS_TRIED = 3;
/** Arrive this close to a station (blocks, horizontally from its center): well inside the reach to use it. */
export const STATION_RADIUS = 2;
/** The most items one screen move or one act may take: one stack. */
const STACK = 64;
/** A furnace smelts one item in 10 s, a blast furnace or smoker in 5 s; polled this often. */
const SMELT_MS: Record<string, number> = { furnace: 10_000, blast_furnace: 5_000, smoker: 5_000 };
const POLL_MS = 500;
/** After the inventory key, the screen is read every 100 ms until it shows its crafting grid, for at most 2 s. */
const INVENTORY_WAIT_MS = 2_000;
const INVENTORY_POLL_MS = 100;
/** An act the agent answers "not readable now" is tried this many times, this far apart. */
const ACT_TRIES = 3;
const ACT_RETRY_MS = 250;
/** After a move out of a container, the inventory is read every 100 ms until it shows the items, for at most 1 s. */
const SETTLE_MS = 1_000;
const SETTLE_POLL_MS = 100;
/** A fetch reads the containers again after each round and takes what is still there, at most this many rounds. */
const FETCH_ROUNDS = 4;
/** Cells tried for placing a shulker box from one standing spot. */
const PLACE_CELLS = 4;

const SHULKER_COLORS = ["undyed", "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"];

/** Containers a fetch looks in (vanilla block ids). */
export const CONTAINER_BLOCKS: readonly string[] = [
  "minecraft:chest",
  "minecraft:trapped_chest",
  "minecraft:barrel",
  ...["copper", "exposed_copper", "weathered_copper", "oxidized_copper"].flatMap((c) => [`minecraft:${c}_chest`, `minecraft:waxed_${c}_chest`]),
  ...SHULKER_COLORS.map((color) => `minecraft:${color}_shulker_box`),
];

/** The block ids of each station a recipe names. */
const STATION_BLOCKS: Record<Station, string[]> = {
  crafting_table: ["minecraft:crafting_table"],
  furnace: ["minecraft:furnace", "minecraft:lit_furnace"],
  blast_furnace: ["minecraft:blast_furnace", "minecraft:lit_blast_furnace"],
  smoker: ["minecraft:smoker", "minecraft:lit_smoker"],
  stonecutter: ["minecraft:stonecutter_block"],
  smithing_table: ["minecraft:smithing_table"],
};

/** The container enum each station role falls back to when the screen lists no collection matching it. */
const FURNACE_INPUT_ENUM: Record<string, string> = {
  furnace: "FurnaceIngredientContainer",
  blast_furnace: "BlastFurnaceIngredientContainer",
  smoker: "SmokerIngredientContainer",
};
const CHEST_ENUM: Record<string, string> = { chest: "LevelEntityContainer", barrel: "BarrelContainer", shulker_box: "ShulkerBoxContainer" };

export function isShulkerBox(id: string): boolean {
  return /shulker_box$/.test(id);
}

/** A step ends early with one of the contract's reasons. */
export class StepFail extends Error {
  readonly reason: TaskFailure;
  constructor(reason: TaskFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * A search that found nothing: `reason` when the helper answered, `no_agent` when every query it asked failed (the
 * helper's errors are in the text either way, with what was asked and how far).
 */
export function nothingFound(reason: TaskFailure, what: string, search: Found<unknown>, asked: readonly string[]): StepFail {
  return new StepFail(search.failed ? "no_agent" : reason, notFoundText(what, search, asked));
}

/** This station cannot do it (busy, a refused move, the wrong screen): the next one of its type is tried. */
class StationRefused extends Error {
  /** The repair chose to fetch this first and come back. */
  readonly fetch: { ingredient: Ingredient; count: number } | undefined;
  constructor(message: string, fetch?: { ingredient: Ingredient; count: number }) {
    super(message);
    this.fetch = fetch;
  }
}

const NO_AGENT: Partial<Record<EngineFailure["reason"], true>> = { not_attached: true, disconnected: true, unknown_method: true };

function failOf(failure: EngineFailure, what: string): StepFail {
  const reason: TaskFailure = NO_AGENT[failure.reason] ? "no_agent" : failure.reason === "timeout" ? "timeout" : "refused";
  return new StepFail(reason, `${what}: ${failure.message}`);
}

function xyz(at: Vec3): string {
  return `${Math.floor(at.x)} ${Math.floor(at.y)} ${Math.floor(at.z)}`;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function center(at: Vec3): Vec3 {
  return { x: Math.floor(at.x) + 0.5, y: Math.floor(at.y), z: Math.floor(at.z) + 0.5 };
}

/** A container read through `container.get`, with where it stands. */
interface ContainerSeen {
  block: string;
  at: Vec3;
  slots: Slot[];
  distance: number;
}

type Repair = "other_slot" | "other_station" | "fetch_missing" | "give_up";

const REPAIRS: Record<Repair, string> = {
  other_slot: "try the move with another slot",
  fetch_missing: "fetch the missing item from the containers near, then try again",
  other_station: "use another station of the same type",
  give_up: "give up the step",
};

export class Run {
  readonly env: TaskEnv;
  readonly signal: AbortSignal | undefined;
  readonly actions: string[] = [];
  /** What was made or fetched on the way, for the message: `smelted 2 iron_ingot`. */
  readonly notes: string[] = [];
  /** The shulker boxes the run placed and left standing (`the undyed_shulker_box at x y z`). */
  readonly placed: string[] = [];
  #screenOpen = false;
  #containers: ContainerSeen[] | undefined;
  /** How far the containers lookup searched, for messages (`16 blocks`, `48 blocks (searched 9 cubes)`). */
  #containersWithin: string | undefined;
  #universe: Set<string> | undefined;
  #inProgress = new Set<string>();
  /** Whether another station of the type in use is left to try, for the repair options. */
  #moreStations = false;

  constructor(env: TaskEnv, signal?: AbortSignal) {
    this.env = env;
    this.signal = signal;
  }

  get radius(): number {
    return this.env.radius ?? 16;
  }

  /** How far the last containers lookup searched: the radius until one ran. */
  get containersWithin(): string {
    return this.#containersWithin ?? `${this.radius} blocks`;
  }

  check(): void {
    if (this.signal?.aborted) throw new StepFail("cancelled", "the step was cancelled");
  }

  async sleep(ms: number): Promise<void> {
    this.check();
    await this.env.clock.sleep(ms, this.signal);
  }

  /** The value of an engine call, or the step's failure naming what was being done. */
  async call<T>(what: string, result: Promise<EngineResult<T>>): Promise<T> {
    this.check();
    const answer = await result;
    this.check();
    if (!answer.ok) throw failOf(answer, what);
    return answer.value;
  }

  async inventory(): Promise<PlayerInventory> {
    return (await this.call("reading the inventory", this.env.engine.readInventory())).inventory;
  }

  async counts(): Promise<InventoryCounts> {
    return countsOf(await this.inventory());
  }

  /* ------------------------------------------------------------------------------------------------------------ */
  /* Names                                                                                                          */
  /* ------------------------------------------------------------------------------------------------------------ */

  /** Every item id known: the registry, the recipe index and the inventory. */
  async universe(): Promise<Set<string>> {
    if (this.#universe) return this.#universe;
    const ids = new Set<string>();
    const registry = await this.env.registry?.("item").catch(() => [] as string[]);
    for (const id of registry ?? []) ids.add(namespaced(id));
    for (const id of this.env.recipes?.items() ?? []) ids.add(id);
    this.#universe = ids;
    return ids;
  }

  /* ------------------------------------------------------------------------------------------------------------ */
  /* Screens and stations                                                                                           */
  /* ------------------------------------------------------------------------------------------------------------ */

  async state(): Promise<ScreenState> {
    return this.call("reading the screen", this.env.engine.screenState());
  }

  /** Close the screen this run opened, if one is open. Never throws: it runs on every way out. */
  async close(): Promise<void> {
    if (!this.#screenOpen) return;
    this.#screenOpen = false;
    const closed = await this.env.engine.screenClose().catch((err: unknown) => ({ ok: false as const, message: String(err) }));
    this.actions.push(closed.ok ? "closed the screen" : `closing the screen failed: ${"message" in closed ? closed.message : ""}`);
  }

  /**
   * Open the player's own inventory screen and wait until it reads as the inventory with its crafting grid (polled
   * every 100 ms for up to 2 s); undefined (and why, in `actions`) when it does not.
   */
  async openInventory(): Promise<ScreenState | undefined> {
    const opened = await this.env.controller.openInventory();
    this.check();
    if (!opened.ok) {
      if (NO_AGENT[opened.reason]) throw failOf(opened, "opening the inventory");
      this.actions.push(`opening the inventory failed: ${opened.message}`);
      return undefined;
    }
    this.#screenOpen = true;
    const started = this.env.clock.now();
    let last = "no screen";
    for (;;) {
      const state = await this.env.engine.screenState();
      this.check();
      if (state.ok) {
        if (state.value.kind === "inventory" && Object.keys(state.value.containers).some((key) => /crafting_input/i.test(key))) {
          this.actions.push("opened the inventory screen");
          return state.value;
        }
        last = `${state.value.screen} (${state.value.kind})`;
      } else {
        if (NO_AGENT[state.reason]) throw failOf(state, "reading the inventory screen");
        last = state.message;
      }
      if (this.env.clock.now() - started >= INVENTORY_WAIT_MS) break;
      await this.sleep(INVENTORY_POLL_MS);
    }
    this.actions.push(`the inventory screen with its crafting grid did not show within ${INVENTORY_WAIT_MS / 1000} s (last: ${last})`);
    await this.close();
    return undefined;
  }

  /**
   * Blocks of these types, nearest first: within the radius, and when none is there, in the cubes around it out to
   * 48 blocks (`findBlocks`). `within` says how far it searched.
   */
  async blocksNear(types: readonly string[]): Promise<Found<BlockInfo>> {
    this.check();
    return findBlocks(this.env, types, { radius: this.radius });
  }

  /** Walk next to a block; the walk's failure message when the way is not found. */
  async walkToBlock(block: BlockInfo): Promise<string | undefined> {
    this.check();
    const walk = await this.env.controller.walkTo(center(block.location), STATION_RADIUS, this.signal);
    this.check();
    if (!walk.ok) return walk.message;
    this.actions.push(`walked to the ${bareId(block.typeId)} at ${xyz(block.location)}`);
    return undefined;
  }

  /**
   * Use a block like a right click (aimed at `face` when given) and check the screen it opened is one of `kinds` and
   * belongs to this block: `container.open` names the block position the screen is for. A double chest counts when the
   * other half opened: a chest of the same type in the next cell on the same level (the helper's block states do not
   * say which chests are paired, so any such neighbour is taken as the other half).
   */
  async openBlock(block: BlockInfo, kinds: readonly ScreenKind[], face?: BlockFace): Promise<ScreenState> {
    const at = cellOf(block.location);
    const used = await this.env.engine.interactBlock({ ...at, ...(face ? { face } : {}) });
    this.check();
    if (!used.ok) {
      if (used.reason === "invalid_params") throw new StationRefused(shortReason(used.message));
      throw failOf(used, `using the ${bareId(block.typeId)} at ${xyz(at)}`);
    }
    if (used.value.screen === null) throw new StationRefused("using it opened no screen");
    this.#screenOpen = true;
    const state = await this.state();
    if (!kinds.includes(state.kind)) throw new StationRefused(`it opened ${state.screen} (${state.kind}), not a ${kinds.join(" or ")} screen`);
    const opened = await this.env.engine.containerOpen();
    this.check();
    const position = opened.ok ? opened.value.position : null;
    if (position && !sameCell(position, at)) {
      const other = opened.ok && opened.value.block ? opened.value.block : ((await this.env.query.block(position).catch(() => null))?.typeId ?? "block");
      const half = /chest$/.test(block.typeId) && namespaced(other) === block.typeId && position.y === at.y && Math.abs(position.x - at.x) + Math.abs(position.z - at.z) === 1;
      if (!half) throw new StationRefused(`it opened the ${bareId(other)} at ${xyz(position)} instead`);
      this.actions.push(`opened the ${state.kind} screen (the other half of the double chest, at ${xyz(position)})`);
      return state;
    }
    this.actions.push(`opened the ${state.kind} screen${position ? "" : ` (its block position was not reported${opened.ok ? "" : `: ${opened.message}`})`}`);
    return state;
  }

  /** Feet cells to stand on around a target, standable by the helper's blocks, nearest to the player first. */
  async standSpots(target: Vec3): Promise<Vec3[]> {
    const me = await this.env.controller.position();
    const out: Vec3[] = [];
    for (const cell of spotCandidates(target, me)) {
      if (out.length >= SPOTS_PER_TARGET) break;
      this.check();
      const [feet, head, floor] = await Promise.all(
        [cell, { ...cell, y: cell.y + 1 }, { ...cell, y: cell.y - 1 }].map((at) => this.env.query.block(at).catch(() => null)),
      );
      if (standable(feet ?? null, head ?? null, floor ?? null)) out.push(cell);
    }
    return out;
  }

  /** Walk onto a spot found by `standSpots`; the walk's failure, or undefined once there. */
  async stepTo(spot: Vec3, what: string): Promise<string | undefined> {
    this.check();
    const walk = await this.env.controller.walkTo({ x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 }, SPOT_ARRIVE, this.signal);
    this.check();
    if (!walk.ok) return walk.message;
    this.actions.push(`stepped to ${xyz(spot)} to use ${what}`);
    return undefined;
  }

  /**
   * Open a block's screen from where the player can: where it stands (the nearest point, then each face the eye is on
   * the side of), then from up to `SPOTS_PER_TARGET` standable spots around it, nearest first, the same faces again.
   * Stops at the first screen of the right kind at the right position; gives up after `USES_PER_TARGET` uses or
   * `MS_PER_TARGET`, naming every spot and face tried.
   */
  async useBlock(block: BlockInfo, kinds: readonly ScreenKind[]): Promise<ScreenState> {
    const cell = cellOf(block.location);
    const what = `the ${bareId(block.typeId)} at ${xyz(cell)}`;
    const started = this.env.clock.now();
    const tried: string[] = [];
    let uses = 0;
    let spots: Vec3[] | undefined;
    for (let s = 0; ; s++) {
      if (s > 0) {
        spots ??= await this.standSpots(cell);
        const spot = spots[s - 1];
        if (!spot) break;
        const walked = await this.stepTo(spot, what);
        if (walked) {
          tried.push(`from ${xyz(spot)}: the walk failed (${walked})`);
          continue;
        }
      }
      const me = await this.env.controller.position();
      const eye = { ...me, y: me.y + EYE_HEIGHT };
      for (const face of [undefined, ...facesToward(eye, cell)]) {
        if (uses >= USES_PER_TARGET || this.env.clock.now() - started > MS_PER_TARGET) {
          tried.push(`stopped after ${uses} uses in ${Math.round((this.env.clock.now() - started) / 1000)} s`);
          throw new StationRefused(`tried ${uses} uses: ${tried.join("; ")}`);
        }
        uses++;
        try {
          return await this.openBlock(block, kinds, face);
        } catch (err) {
          if (!(err instanceof StationRefused)) throw err;
          await this.close();
          tried.push(`from ${xyz(me)} ${face ? `on its ${face} face` : "at its nearest point"}: ${err.message}`);
        }
      }
    }
    throw new StationRefused(`tried ${uses} use${uses === 1 ? "" : "s"} from ${1 + (spots?.length ?? 0)} spot${spots?.length ? "s" : ""}: ${tried.join("; ")}`);
  }

  /** Where an entity stands now (it may have walked), or undefined when the helper no longer lists it. */
  async entityNow(entity: EntitySeen): Promise<EntitySeen | undefined> {
    const seen = await this.env.query.entities(entity.typeId, this.radius).catch(() => [] as EntitySeen[]);
    return seen.find((other) => other.id === entity.id);
  }

  /**
   * Open an entity's trade screen from where the player can, by the same spots and caps as `useBlock`. Before a use the
   * view is turned onto the entity's body and the helper's crosshair pick checked: another entity or a nearer block in
   * the way moves the player to the next spot. After it, the trade screen's own `trader` id must be this entity's;
   * when the screen does not report one, a screen without a wanted offer while the crosshair rests on another entity
   * counts as the wrong trader.
   */
  async useEntity(entity: EntitySeen, wanted: (state: ScreenState) => boolean): Promise<ScreenState> {
    const what = `the ${bareId(entity.typeId).replace(/_v2$/, "")} ${entity.id}`;
    const controller = this.env.controller;
    const started = this.env.clock.now();
    const tried: string[] = [];
    let uses = 0;
    let spots: Vec3[] | undefined;
    for (let s = 0; ; s++) {
      const now = (await this.entityNow(entity)) ?? entity;
      if (s > 0) {
        spots ??= await this.standSpots(now.location);
        const spot = spots[s - 1];
        if (!spot) break;
        const walked = await this.stepTo(spot, what);
        if (walked) {
          tried.push(`from ${xyz(spot)}: the walk failed (${walked})`);
          continue;
        }
      }
      if (uses >= USES_PER_TARGET || this.env.clock.now() - started > MS_PER_TARGET) {
        tried.push(`stopped after ${uses} uses in ${Math.round((this.env.clock.now() - started) / 1000)} s`);
        break;
      }
      const me = await controller.position();
      const from = `from ${xyz(me)}`;
      if (controller.lookAt && controller.lookingAt) {
        const body = { ...now.location, y: now.location.y + 0.9 };
        await controller.lookAt(body, this.signal);
        this.check();
        const seen = await controller.lookingAt();
        const eye = { ...me, y: me.y + EYE_HEIGHT };
        if (seen?.entity && seen.entity !== entity.id) {
          tried.push(`${from}: the view rests on the entity ${seen.entity}`);
          continue;
        }
        if (!seen?.entity && seen?.block && distance(eye, { x: seen.block.x + 0.5, y: seen.block.y + 0.5, z: seen.block.z + 0.5 }) < distance(eye, body)) {
          tried.push(`${from}: the block at ${xyz(seen.block)} is in the way`);
          continue;
        }
      }
      uses++;
      const used = await this.env.engine.interactEntity(entity.id);
      this.check();
      if (!used.ok) {
        if (used.reason !== "invalid_params") throw failOf(used, `using ${what}`);
        tried.push(`${from}: ${shortReason(used.message)}`);
        continue;
      }
      if (used.value.screen !== null) this.#screenOpen = true;
      const state = await this.state();
      if (state.kind !== "trade") {
        await this.close();
        tried.push(`${from}: it opened ${state.screen} (${state.kind}), not the trade screen`);
        continue;
      }
      const trader = state.data?.trader;
      const after = trader ? undefined : await controller.lookingAt?.();
      const wrong = trader ? trader !== entity.id : !wanted(state) && !!after?.entity && after.entity !== entity.id;
      if (wrong) {
        await this.close();
        tried.push(`${from}: it opened the trade screen of ${trader ?? after?.entity} instead`);
        continue;
      }
      this.actions.push(`opened the trade screen of ${what}`);
      return state;
    }
    throw new StationRefused(`tried ${uses} use${uses === 1 ? "" : "s"} from ${1 + (spots?.length ?? 0)} spot${spots?.length ? "s" : ""}: ${tried.join("; ")}`);
  }

  /**
   * Use the nearest reachable station of `types` within the radius: walk to it, open it, run `use` on its screen,
   * close it. A station that refuses moves on to the next one (at most three); the failure names each one tried.
   */
  async atStation<T>(label: string, types: readonly string[], kinds: readonly ScreenKind[], use: (state: ScreenState, block: BlockInfo) => Promise<T>): Promise<T> {
    const search = await this.blocksNear(types);
    const blocks = search.found.slice(0, STATIONS_TRIED);
    if (!blocks.length) throw nothingFound("no_station", label, search, types);
    const tried: string[] = [];
    let reached = 0;
    let fetched = false;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as BlockInfo;
      const where = `the ${bareId(block.typeId)} at ${xyz(block.location)}`;
      const walked = await this.walkToBlock(block);
      if (walked) {
        tried.push(`${where}: ${walked}`);
        continue;
      }
      reached++;
      this.#moreStations = i < blocks.length - 1;
      try {
        return await use(await this.useBlock(block, kinds), block);
      } catch (err) {
        if (!(err instanceof StationRefused)) throw err;
        await this.close();
        if (err.fetch && !fetched) {
          // The repair chose to fetch what was missing: do it, then come back to this station once.
          fetched = true;
          await this.ensure(err.fetch.ingredient, err.fetch.count, 1);
          i--;
          continue;
        }
        this.actions.push(`${where} refused: ${err.message}`);
        tried.push(`${where}: ${err.message}`);
      } finally {
        await this.close();
      }
    }
    throw new StepFail(reached ? "refused" : "unreachable", `no ${label} within ${this.radius} blocks could be used (${tried.join("; ")})`);
  }

  /* ------------------------------------------------------------------------------------------------------------ */
  /* Moves                                                                                                          */
  /* ------------------------------------------------------------------------------------------------------------ */

  /**
   * The repair after the game refused a move: the first possible of another slot, fetching the missing item, another
   * station, else giving up.
   */
  repair(what: string, reason: string, possible: Repair[]): Repair {
    const repair = possible[0] ?? "give_up";
    this.actions.push(`the game refused ${what} (${reason}); repair: ${repair} (${REPAIRS[repair]})`);
    return repair;
  }

  /**
   * Move up to `count` items the player carries that `wanted` accepts into a station slot, stack by stack. A refused
   * move is repaired: another source stack, the missing item fetched first, another station, or giving up.
   */
  async moveIn(wanted: (id: string) => boolean, label: string, to: ScreenSlotRef, count: number, ingredient?: Ingredient): Promise<number> {
    let moved = 0;
    const skipped = new Set<string>();
    for (let attempt = 0; moved < count && attempt < 16; attempt++) {
      const state = await this.state();
      const sources = carriedStacks(state, await this.inventory())
        .filter((stack): stack is CarriedStack & { slot: NonNullable<Slot> } => !!stack.slot && wanted(stack.slot.item) && !skipped.has(refText(stack.ref)))
        .sort((a, b) => b.slot.count - a.slot.count);
      const source = sources[0];
      if (!source) break;
      const n = Math.min(source.slot.count, count - moved, STACK);
      const result = await this.env.engine.screenMove({ from: source.ref, to, count: n });
      this.check();
      if (result.ok) {
        moved += result.value.moved;
        this.actions.push(`moved ${result.value.moved} ${bareId(source.slot.item)} from ${refText(source.ref)} to ${refText(to)}`);
        if (result.value.moved === 0) skipped.add(refText(source.ref));
        continue;
      }
      if (result.reason !== "invalid_params") throw failOf(result, `moving ${label}`);
      const possible: Repair[] = [];
      if (sources.length > 1) possible.push("other_slot");
      if (ingredient && countOf(await this.nearCounts(), ingredient) > 0) possible.push("fetch_missing");
      if (this.#moreStations) possible.push("other_station");
      const repair = this.repair(`moving ${n} ${label} from ${refText(source.ref)} to ${refText(to)} (${moved} of ${count} moved so far)`, result.message, possible);
      if (repair === "other_slot") skipped.add(refText(source.ref));
      else if (repair === "fetch_missing" && ingredient) throw new StationRefused(result.message, { ingredient, count: count - moved });
      else if (repair === "other_station") throw new StationRefused(result.message);
      else throw new StepFail("refused", `the game refused moving ${label} to ${refText(to)}: ${result.message}`);
    }
    return moved;
  }

  /** Move up to `count` items out of a station slot into empty carried slots (hotbar first, or `hotbarOnly`). */
  async moveOut(from: ScreenSlotRef, item: string, count: number, hotbarOnly = false): Promise<{ moved: number; hotbar?: number }> {
    let moved = 0;
    let hotbar: number | undefined;
    const skipped = new Set<string>();
    for (let attempt = 0; moved < count && attempt < 16; attempt++) {
      const state = await this.state();
      const targets = carriedStacks(state, await this.inventory()).filter((stack) => !stack.slot && !skipped.has(refText(stack.ref)) && (!hotbarOnly || stack.hotbar !== undefined));
      const target = targets[0];
      if (!target) {
        if (moved > 0) break;
        throw new StepFail("refused", `no empty ${hotbarOnly ? "hotbar" : "inventory"} slot to take ${bareId(item)} into`);
      }
      const n = Math.min(count - moved, STACK);
      const had = (await this.counts())[item] ?? 0;
      const result = await this.env.engine.screenMove({ from, to: target.ref, count: n });
      this.check();
      if (result.ok) {
        if (result.value.moved === 0) break;
        moved += result.value.moved;
        hotbar ??= target.hotbar;
        this.actions.push(`moved ${result.value.moved} ${bareId(item)} from ${refText(from)} to ${refText(target.ref)}`);
        await this.awaitCount(item, had + result.value.moved);
        continue;
      }
      if (result.reason !== "invalid_params") throw failOf(result, `taking ${bareId(item)}`);
      const possible: Repair[] = targets.length > 1 ? ["other_slot"] : [];
      const repair = this.repair(`moving ${n} ${bareId(item)} from ${refText(from)} to ${refText(target.ref)} (${moved} of ${count} taken so far)`, result.message, possible);
      if (repair === "other_slot") skipped.add(refText(target.ref));
      else throw new StepFail("refused", `the game refused taking ${bareId(item)} out of ${refText(from)}: ${result.message}`);
    }
    return { moved, ...(hotbar !== undefined ? { hotbar } : {}) };
  }

  /** Wait until the inventory shows at least `want` of `item` (a move the game applies a tick later), at most 1 s. */
  async awaitCount(item: string, want: number): Promise<void> {
    const started = this.env.clock.now();
    while (((await this.counts())[item] ?? 0) < want && this.env.clock.now() - started < SETTLE_MS) await this.sleep(SETTLE_POLL_MS);
  }

  /** A screen action; a refusal is the step's failure with the game's reason. */
  async act(what: string, request: Parameters<TaskEnv["engine"]["screenAct"]>[0]): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      this.check();
      const answer = await this.env.engine.screenAct(request);
      this.check();
      if (answer.ok) {
        if (!answer.value.done) throw new StationRefused(`${what} was refused: ${answer.value.reason ?? "the screen gave no reason"}`);
        return;
      }
      // A screen just opened may not be readable for a frame or two: the agent says so, and the same act works later.
      const notYet = answer.reason === "anchor_missing" || /not readable now|anchor not resolved/i.test(answer.message);
      if (!notYet || attempt >= ACT_TRIES) throw failOf(answer, what);
      this.actions.push(`${what}: the screen was not readable yet (${answer.message}); trying again`);
      await this.sleep(ACT_RETRY_MS);
    }
  }

  /* ------------------------------------------------------------------------------------------------------------ */
  /* Containers near                                                                                                */
  /* ------------------------------------------------------------------------------------------------------------ */

  async containers(): Promise<ContainerSeen[]> {
    if (this.#containers) return this.#containers;
    const me = await this.env.controller.position();
    const out: ContainerSeen[] = [];
    const search = await this.blocksNear(CONTAINER_BLOCKS);
    this.#containersWithin = search.within;
    if (search.failed) throw nothingFound("not_found", "container", search, CONTAINER_BLOCKS);
    for (const block of search.found) {
      const at = block.location;
      const view = await this.env.engine.readContainer({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) });
      this.check();
      if (view.ok) out.push({ block: block.typeId, at, slots: view.value.slots, distance: distance(me, center(at)) });
    }
    this.#containers = out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  /** What the containers near hold, shulker box contents included. */
  async nearCounts(): Promise<InventoryCounts> {
    const counts: InventoryCounts = {};
    for (const container of await this.containers()) countsIn(container.slots, counts);
    return counts;
  }

  /**
   * Take up to `count` items of the ingredient out of the containers near (`all`: every one there is): loose stacks
   * first, nearest container first, then from inside a shulker box lying in one (the box is placed next to the
   * player, opened, emptied of what is needed, and left standing: `placed` lists it). After each round the containers
   * are read again, a placed box included, and another round takes what a read showed still there (at most
   * `FETCH_ROUNDS`, stopping when a round took nothing). Returns how many were taken, measured on the inventory.
   */
  async fetch(ingredient: Ingredient, count: number, all = false): Promise<number> {
    const before = countOf(await this.counts(), ingredient);
    const got = async () => countOf(await this.counts(), ingredient) - before;
    for (let round = 0; round < FETCH_ROUNDS; round++) {
      const start = await got();
      const want = () => (all ? Number.POSITIVE_INFINITY : count);
      for (const container of await this.containers()) {
        if ((await got()) >= want()) break;
        if (!container.slots.some((slot) => slot && matches(ingredient, slot.item))) continue;
        await this.fromContainer(container, async (state, key) => {
          for (const [index, slot] of slotsOf(state, key).entries()) {
            const left = want() - (await got());
            if (left <= 0) break;
            if (slot && matches(ingredient, slot.item)) await this.moveOut({ container: key, slot: index }, slot.item, Math.min(left, slot.count));
          }
        });
      }
      for (const container of await this.containers()) {
        if ((await got()) >= want()) break;
        const boxIndex = container.slots.findIndex((slot) => slot && isShulkerBox(slot.item) && (slot.contents ?? []).some((inner) => inner && matches(ingredient, inner.item)));
        if (boxIndex < 0) continue;
        await this.fromShulker(container, boxIndex, ingredient, all ? STACK * 27 : count - (await got()));
      }
      this.#containers = undefined;
      const taken = await got();
      if (!all && taken >= count) break;
      // What a fresh read shows still there: a nested box's contents read once may have been short, or a move was
      // applied after the screen closed. Nothing left, or a round that took nothing, ends it.
      const left = countOf(await this.nearCounts(), ingredient);
      if (left === 0 || taken === start) break;
      this.actions.push(`the containers still hold ${left} ${ingredientText(ingredient)}: another round`);
    }
    this.#containers = undefined;
    const taken = await got();
    if (taken > 0) this.notes.push(`fetched ${taken} ${ingredientText(ingredient)}`);
    return taken;
  }

  async fromContainer(container: ContainerSeen, use: (state: ScreenState, key: string) => Promise<void>): Promise<void> {
    const block: BlockInfo = { typeId: container.block, location: container.at };
    const walked = await this.walkToBlock(block);
    if (walked) {
      this.actions.push(`could not reach the ${bareId(container.block)} at ${xyz(container.at)}: ${walked}`);
      return;
    }
    try {
      const state = await this.useBlock(block, ["chest", "barrel", "shulker_box"]);
      // The block's own collection: not the player's, and not a carried bundle's `dynamic_container_<id>`.
      await use(state, stationKey(state, /^(?!dynamic)/, CHEST_ENUM[state.kind] ?? "LevelEntityContainer"));
    } catch (err) {
      if (!(err instanceof StationRefused)) throw err;
      this.actions.push(`the ${bareId(container.block)} at ${xyz(container.at)} refused: ${err.message}`);
    } finally {
      await this.close();
    }
  }

  /** Take the shulker box out of the container into the hotbar, place it next to the player, open it and take from it. */
  async fromShulker(container: ContainerSeen, boxIndex: number, ingredient: Ingredient, count: number): Promise<void> {
    let box: { item: string; hotbar?: number } | undefined;
    await this.fromContainer(container, async (state, key) => {
      const slot = slotsOf(state, key)[boxIndex];
      if (!slot || !isShulkerBox(slot.item)) throw new StationRefused(`slot ${boxIndex} no longer holds the shulker box`);
      const taken = await this.moveOut({ container: key, slot: boxIndex }, slot.item, 1, true);
      box = { item: slot.item, ...(taken.hotbar !== undefined ? { hotbar: taken.hotbar } : {}) };
    });
    if (!box?.hotbar) return;
    if (!(await this.env.controller.selectSlot(box.hotbar, this.signal))) throw new StepFail("refused", `selecting hotbar slot ${box.hotbar} with the ${bareId(box.item)} failed`);
    this.actions.push(`selected hotbar slot ${box.hotbar} (${bareId(box.item)})`);
    const spot = await this.placeBox(box.item, container.at);
    await this.fromContainer({ block: spot.typeId, at: spot.location, slots: [], distance: 0 }, async (state, key) => {
      let left = count;
      for (const [index, slot] of slotsOf(state, key).entries()) {
        if (left <= 0) break;
        if (slot && matches(ingredient, slot.item)) left -= (await this.moveOut({ container: key, slot: index }, slot.item, Math.min(left, slot.count))).moved;
      }
    });
    // The step never breaks a block, so the box it placed stays where it is, with whatever it still holds.
    this.placed.push(`the ${bareId(box.item)} at ${xyz(spot.location)}`);
    this.actions.push(`left the ${bareId(box.item)} placed at ${xyz(spot.location)}`);
  }

  /**
   * Cells next to the player a box can be placed in: air with air above (a shulker box opens upwards), on a floor
   * that is not air or liquid, within 2 blocks, not the player's own cells and not behind `avoid` (the container
   * the box came from) as seen from the player; nearest first.
   */
  async placeCells(avoid: Vec3): Promise<Vec3[]> {
    const me = await this.env.controller.position();
    const feet = cellOf(me);
    const behind = center(avoid);
    const out: Vec3[] = [];
    const around: Vec3[] = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if ((dx || dz) && Math.hypot(dx, dz) <= 2) around.push({ x: feet.x + dx, y: feet.y, z: feet.z + dz });
    const away = (c: Vec3) => Math.hypot(c.x + 0.5 - me.x, c.z + 0.5 - me.z);
    for (const spot of around.sort((a, b) => away(a) - away(b))) {
      if (out.length >= PLACE_CELLS) break;
      if (sameCell(spot, avoid)) continue;
      const mid = { x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 };
      if (distance(me, behind) + distance(behind, mid) - distance(me, mid) < 0.25) continue;
      const [cell, above, floor] = await Promise.all([spot, { ...spot, y: spot.y + 1 }, { ...spot, y: spot.y - 1 }].map((at) => this.env.query.block(at).catch(() => null)));
      if (cell?.typeId === "minecraft:air" && above?.typeId === "minecraft:air" && floor && !/air$|water$|lava$/.test(floor.typeId)) out.push(spot);
    }
    return out;
  }

  /**
   * Place the held shulker box: on each candidate cell from where the player stands (aimed at the floor's top face),
   * then from up to `SPOTS_PER_TARGET` other standing spots, within `USES_PER_TARGET` uses. The failure names every
   * cell tried and what the game answered.
   */
  async placeBox(item: string, avoid: Vec3): Promise<BlockInfo> {
    const tried: string[] = [];
    let uses = 0;
    let spots: Vec3[] | undefined;
    for (let s = 0; uses < USES_PER_TARGET; s++) {
      if (s > 0) {
        spots ??= await this.standSpots(await this.env.controller.position());
        const spot = spots[s - 1];
        if (!spot) break;
        const walked = await this.stepTo(spot, `a free cell for the ${bareId(item)}`);
        if (walked) {
          tried.push(`from ${xyz(spot)}: the walk failed (${walked})`);
          continue;
        }
      }
      for (const cell of await this.placeCells(avoid)) {
        if (uses >= USES_PER_TARGET) break;
        uses++;
        const placed = await this.env.engine.interactBlock({ x: cell.x, y: cell.y - 1, z: cell.z, face: "up" });
        this.check();
        if (!placed.ok) {
          if (NO_AGENT[placed.reason]) throw failOf(placed, `placing the ${bareId(item)}`);
          tried.push(`${xyz(cell)}: ${shortReason(placed.message)}`);
          continue;
        }
        if (placed.value.screen !== null) {
          this.#screenOpen = true;
          await this.close();
        }
        const there = await this.env.query.block(cell);
        if (there && isShulkerBox(there.typeId)) {
          if (tried.length) this.actions.push(`placing the ${bareId(item)} failed at ${tried.join("; ")}`);
          this.actions.push(`placed the ${bareId(item)} at ${xyz(cell)}`);
          return { typeId: there.typeId, location: cell };
        }
        tried.push(`${xyz(cell)}: the block there is ${there?.typeId ?? "unreadable"} after the use`);
      }
    }
    throw new StepFail("refused", `placing the ${bareId(item)} failed in ${uses} tries: ${tried.join("; ") || "no free cell next to the player"}`);
  }

  /* ------------------------------------------------------------------------------------------------------------ */
  /* Making things                                                                                                  */
  /* ------------------------------------------------------------------------------------------------------------ */

  /** Item ids that satisfy the ingredient and that the index knows a recipe for. */
  async candidates(ingredient: Ingredient, stock: InventoryCounts): Promise<string[]> {
    if ("item" in ingredient) return [ingredient.item];
    const out = new Set<string>();
    for (const id of [...Object.keys(stock), ...(await this.universe())]) if (inTag(ingredient.tag, id)) out.add(id);
    return [...out].sort((a, b) => (stock[b] ?? 0) - (stock[a] ?? 0) || (a < b ? -1 : 1));
  }

  /** The recipes the steps can run for `item`, crafting first when `prefer` is `craft`. */
  recipes(item: string, prefer?: "craft" | "smelt"): Recipe[] {
    const list = this.env.recipes?.recipesFor(item) ?? [];
    const rank = (recipe: Recipe) => {
      const crafting = recipe.kind === "shaped" || recipe.kind === "shapeless";
      if (prefer === "smelt") return recipe.kind === "furnace" ? 0 : 1;
      return crafting ? (recipe.stations.includes("crafting_table") ? 0 : 1) : 2;
    };
    return list.filter((recipe) => recipe.stations.length > 0).sort((a, b) => rank(a) - rank(b));
  }

  /**
   * Whether one `item` can be made from the inventory (`inventory`), or made or fetched with the containers near too
   * (`near`), by the recipe index: what a phrase naming several variants ("a pickaxe") picks by.
   */
  async makeable(item: string, from: "inventory" | "near"): Promise<boolean> {
    const stock = { ...(await this.counts()) };
    if (from === "near") {
      const near = await this.nearCounts();
      if ((near[item] ?? 0) > 0) return true;
      for (const [id, n] of Object.entries(near)) stock[id] = (stock[id] ?? 0) + n;
    }
    return (await this.feasible(item, 1, 0, stock, new Set())) !== undefined;
  }

  /** Whether `count` of `item` can be made from the stock (inventory and containers near), `depth` levels down. */
  async feasible(item: string, count: number, depth: number, stock: InventoryCounts, seen: Set<string>): Promise<Recipe | undefined> {
    if (depth > MAX_DEPTH || seen.has(item)) return undefined;
    const below = new Set([...seen, item]);
    for (const recipe of this.recipes(item)) {
      const crafts = Math.ceil(count / recipe.result.count);
      let ok = true;
      for (const input of recipe.inputs) {
        const need = input.count * crafts;
        const have = countOf(stock, input.ingredient);
        if (have >= need) continue;
        let made = false;
        for (const candidate of await this.candidates(input.ingredient, stock)) {
          if (await this.feasible(candidate, need - have, depth + 1, stock, below)) {
            made = true;
            break;
          }
        }
        if (!made) {
          ok = false;
          break;
        }
      }
      if (ok && recipe.kind === "furnace" && !Object.keys(stock).some((id) => fuelValue(id) !== undefined && !matches(recipe.inputs[0]?.ingredient ?? { item: "" }, id))) ok = false;
      if (ok) return recipe;
    }
    return undefined;
  }

  /**
   * Have at least `need` items of the ingredient: fetched from the containers near, else made by a recipe from what
   * is at hand or near (sub-goals `depth` levels down, up to `MAX_DEPTH`, never the item being made above).
   */
  async ensure(ingredient: Ingredient, need: number, depth: number): Promise<void> {
    let have = countOf(await this.counts(), ingredient);
    if (have >= need) return;
    const near = await this.nearCounts();
    if (countOf(near, ingredient) > 0) {
      await this.fetch(ingredient, need - have);
      have = countOf(await this.counts(), ingredient);
      if (have >= need) return;
    }
    let why = this.env.recipes ? "" : ` (no recipe index: ${this.env.recipesNote ?? "the recipes could not be read"})`;
    if (this.env.recipes && depth < MAX_DEPTH) {
      const stock = { ...(await this.counts()) };
      for (const [id, n] of Object.entries(await this.nearCounts())) stock[id] = (stock[id] ?? 0) + n;
      for (const candidate of await this.candidates(ingredient, stock)) {
        if (this.#inProgress.has(candidate)) continue;
        if (!(await this.feasible(candidate, need - have, depth + 1, stock, this.#inProgress))) continue;
        try {
          await this.make(candidate, need - have, depth + 1);
        } catch (err) {
          if (!(err instanceof StepFail) || err.reason !== "missing_ingredient") throw err;
          why = ` (${err.message})`;
        }
        have = countOf(await this.counts(), ingredient);
        if (have >= need) return;
      }
    }
    throw new StepFail(
      "missing_ingredient",
      `needs ${need - have} more ${ingredientText(ingredient)} (has ${have}); none in the containers within ${this.containersWithin}${why || " and no recipe makes it from what is at hand"}`,
    );
  }

  /** Make `count` more of `item` by the best recipe for it, its ingredients first. */
  async make(item: string, count: number, depth: number, prefer?: "craft" | "smelt", fixedInput?: string): Promise<void> {
    if (!this.env.recipes) throw new StepFail("not_found", `no recipe index to make ${bareId(item)} from: ${this.env.recipesNote ?? "the recipes could not be read"}`);
    let recipes = this.recipes(item, prefer);
    if (prefer === "smelt") recipes = recipes.filter((recipe) => recipe.kind === "furnace");
    if (fixedInput) recipes = recipes.filter((recipe) => recipe.inputs.some((input) => matches(input.ingredient, fixedInput)));
    if (!recipes.length) throw new StepFail("not_found", `no recipe in ${this.env.recipes.source} makes ${bareId(item)}`);
    this.#inProgress.add(item);
    try {
      const recipe = await this.chooseRecipe(item, count, recipes, depth);
      const before = (await this.counts())[item] ?? 0;
      if (recipe.kind === "furnace") await this.smelt(recipe, item, count, depth, fixedInput);
      else if (recipe.kind === "smithing") await this.smith(recipe, item, depth);
      else if (recipe.stations.includes("crafting_table")) await this.craft(recipe, item, count, depth);
      else if (recipe.stations.includes("stonecutter")) await this.stonecut(recipe, item, count, depth);
      else throw new StepFail("no_station", `${recipe.id} needs a ${recipe.stations.join(" or ")}, which the steps do not use`);
      const made = ((await this.counts())[item] ?? 0) - before;
      if (depth > 0) this.notes.push(`${recipe.kind === "furnace" ? "smelted" : "made"} ${made} ${bareId(item)}`);
    } finally {
      this.#inProgress.delete(item);
    }
  }

  /**
   * Which recipe: the one the inventory holds the ingredients of; of several, the first in the game's own order
   * (higher priority first, then by id), and the action lines say which and what else could have been used.
   */
  async chooseRecipe(item: string, count: number, recipes: Recipe[], depth: number): Promise<Recipe> {
    const counts = await this.counts();
    const atHand = recipes.filter((recipe) => {
      const crafts = Math.ceil(count / recipe.result.count);
      return recipe.inputs.every((input) => countOf(counts, input.ingredient) >= input.count * crafts);
    });
    const first = atHand[0];
    if (first) {
      if (atHand.length > 1) this.actions.push(`${atHand.length} recipes make ${bareId(item)} from what is at hand; took ${bareId(first.id)} (first in the game's order; also ${atHand.slice(1).map((recipe) => bareId(recipe.id)).join(", ")})`);
      return first;
    }
    const stock = { ...counts };
    for (const [id, n] of Object.entries(await this.nearCounts())) stock[id] = (stock[id] ?? 0) + n;
    for (const recipe of recipes) if (await this.feasible(item, count, depth, stock, new Set()) === recipe) return recipe;
    return recipes[0] as Recipe;
  }

  /** The concrete items a crafting recipe takes now: one item per tag (the one most at hand), and how often it fits. */
  static concrete(recipe: Recipe, counts: InventoryCounts): { grid?: (string | null)[][]; ingredients?: string[]; crafts: number } {
    const pick = new Map<string, string>();
    let crafts = Number.POSITIVE_INFINITY;
    for (const input of recipe.inputs) {
      const ingredient = input.ingredient;
      let id: string | undefined;
      if ("item" in ingredient) id = ingredient.item;
      else id = Object.keys(counts).filter((candidate) => inTag(ingredient.tag, candidate)).sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))[0];
      if (!id) return { crafts: 0 };
      pick.set(ingredientKey(ingredient), id);
      crafts = Math.min(crafts, Math.floor((counts[id] ?? 0) / input.count));
    }
    if (recipe.grid) return { grid: recipe.grid.map((row) => row.map((cell) => (cell ? (pick.get(ingredientKey(cell)) ?? null) : null))), crafts };
    return { ingredients: recipe.inputs.flatMap((input) => Array<string>(input.count).fill(pick.get(ingredientKey(input.ingredient)) ?? "")), crafts };
  }

  async craft(recipe: Recipe, item: string, count: number, depth: number): Promise<void> {
    const crafts = Math.ceil(count / recipe.result.count);
    for (const input of recipe.inputs) await this.ensure(input.ingredient, input.count * crafts, depth);
    const run = async (table: boolean) => {
      let done = 0;
      while (done < crafts) {
        const counts = await this.counts();
        const plan = Run.concrete(recipe, counts);
        const times = Math.min(crafts - done, plan.crafts, STACK);
        if (times <= 0) {
          const short = recipe.inputs.find((input) => countOf(counts, input.ingredient) < input.count);
          throw new StepFail("missing_ingredient", `the ingredients of ${bareId(recipe.id)} ran out after ${done} of ${crafts} crafts${short ? ` (needs ${short.count} ${ingredientText(short.ingredient)})` : ""}`);
        }
        const request = plan.grid ? { grid: plan.grid, table } : { ingredients: plan.ingredients ?? [], table };
        const match = await this.call("looking up the recipe", this.env.engine.craftMatch(request));
        const what = plan.grid ? plan.grid.map((row) => row.map((cell) => (cell ? bareId(cell) : "-")).join(",")).join(" / ") : (plan.ingredients ?? []).map(bareId).join(", ");
        if (!match.recipe || match.result?.item !== item) {
          throw new StepFail("refused", `the game's recipe lookup makes ${match.result ? bareId(match.result.item) : "nothing"} from ${what}, not ${bareId(item)}`);
        }
        await this.act(`crafting ${bareId(item)} (${match.recipe.id})`, { action: "craft", recipe: match.recipe.id, times });
        done += times;
        this.actions.push(`crafted ${bareId(item)} ${times} time${times === 1 ? "" : "s"} from ${what}`);
      }
    };
    if (fitsInventoryGrid(recipe)) {
      let failure: StepFail | undefined;
      const opened = await this.openInventory();
      if (opened) {
        try {
          await run(false);
          return;
        } catch (err) {
          const refused = err instanceof StationRefused || (err instanceof StepFail && (err.reason === "refused" || err.reason === "timeout"));
          if (!refused) throw err;
          failure = err instanceof StepFail ? err : new StepFail("refused", err.message);
          this.actions.push(`the inventory grid refused: ${err.message}`);
        } finally {
          await this.close();
        }
      }
      this.actions.push("using a crafting table instead");
      try {
        await this.atStation("crafting table", STATION_BLOCKS.crafting_table, ["crafting_table"], () => run(true));
      } catch (err) {
        // No table to fall back on: the inventory grid's own failure is the one to report.
        if (failure && err instanceof StepFail && err.reason === "no_station") throw new StepFail(failure.reason, `${failure.message} (and ${err.message})`);
        throw err;
      }
      return;
    }
    await this.atStation("crafting table", STATION_BLOCKS.crafting_table, ["crafting_table"], () => run(true));
  }

  /** The fuel items in the inventory that are not the item being smelted, best first. */
  static fuels(counts: InventoryCounts, smelting: string): string[] {
    return Object.keys(counts)
      .filter((id) => id !== smelting && fuelValue(id) !== undefined && (counts[id] ?? 0) > 0)
      .sort((a, b) => fuelRank(a) - fuelRank(b));
  }

  /** Have fuel for `smelts` items: in the inventory, else fetched from the containers near. */
  async ensureFuel(smelts: number, smelting: string): Promise<void> {
    const worth = (counts: InventoryCounts) => Run.fuels(counts, smelting).reduce((sum, id) => sum + (counts[id] ?? 0) * (fuelValue(id) ?? 0), 0);
    let have = worth(await this.counts());
    if (have >= smelts) return;
    const near = await this.nearCounts();
    for (const id of Run.fuels(near, smelting)) {
      const value = fuelValue(id) ?? 1;
      await this.fetch({ item: id }, Math.ceil((smelts - have) / value));
      have = worth(await this.counts());
      if (have >= smelts) return;
    }
    throw new StepFail(
      "missing_ingredient",
      `needs fuel for ${smelts} smelt${smelts === 1 ? "" : "s"} (has fuel for ${have}); none of ${FUELS.map((fuel) => fuel.label).join(", ")} in the inventory or the containers within ${this.containersWithin}`,
    );
  }

  async smelt(recipe: Recipe, item: string, count: number, depth: number, fixedInput?: string): Promise<void> {
    const input = recipe.inputs[0]?.ingredient;
    if (!input) throw new StepFail("not_found", `${recipe.id} has no input`);
    const ingredient: Ingredient = fixedInput ? { item: fixedInput } : input;
    await this.ensure(ingredient, count, depth);
    const counts = await this.counts();
    const source = "item" in ingredient ? ingredient.item : Object.keys(counts).filter((id) => inTag(ingredient.tag, id)).sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))[0];
    if (!source) throw new StepFail("missing_ingredient", `needs ${count} ${ingredientText(ingredient)}`);
    await this.ensureFuel(count, source);
    const families = recipe.stations.filter((station) => FURNACE_STATIONS.includes(station));
    const types = families.flatMap((station) => STATION_BLOCKS[station]);
    await this.atStation(families.join(" or "), types, families, async (state) => {
      const inKey = stationKey(state, /ingredient|input/i, FURNACE_INPUT_ENUM[state.kind] ?? "FurnaceIngredientContainer");
      const fuelKey = stationKey(state, /fuel/i, "FurnaceFuelContainer");
      const outKey = stationKey(state, /output|result/i, "FurnaceResultContainer");
      const busy = slotsOf(state, inKey)[0];
      if (busy && busy.item !== source) throw new StationRefused(`it is smelting ${busy.count} ${bareId(busy.item)}`);
      const output = slotsOf(state, outKey)[0];
      if (output && output.item !== item) throw new StationRefused(`its output holds ${output.count} ${bareId(output.item)}`);
      const outBefore = output?.count ?? 0;
      const queued = busy?.count ?? 0;
      const moved = await this.moveIn((id) => id === source, bareId(source), { container: inKey, slot: 0 }, Math.min(count, STACK - queued), ingredient);
      if (moved === 0 && queued === 0) throw new StationRefused(`no ${bareId(source)} could be put in`);
      const smelts = moved + queued;
      // Fuel: what the slot holds counts; more of the same fuel tops it up (a slot holds one kind).
      const inSlot = slotsOf(await this.state(), fuelKey)[0];
      const loaded = inSlot ? inSlot.count * (fuelValue(inSlot.item) ?? 0) : 0;
      const burning = (state.data?.burn ?? 0) > 0 ? 1 : 0;
      if (loaded + burning < smelts) {
        const fuels = Run.fuels(await this.counts(), source).filter((id) => !inSlot || id === inSlot.item);
        let missing = smelts - loaded - burning;
        for (const fuel of fuels) {
          if (missing <= 0) break;
          const value = fuelValue(fuel) ?? 1;
          const put = await this.moveIn((id) => id === fuel, bareId(fuel), { container: fuelKey, slot: 0 }, Math.ceil(missing / value), { item: fuel });
          missing -= put * value;
        }
        if (missing > 0 && !inSlot && !burning) throw new StepFail("missing_ingredient", `needs fuel for ${missing} more smelts at the furnace`);
      }
      const perItem = SMELT_MS[state.kind] ?? 10_000;
      const deadline = this.env.clock.now() + smelts * perItem * 1.5 + 5_000;
      let made = 0;
      let idle = 0;
      for (;;) {
        await this.sleep(POLL_MS);
        const now = await this.state();
        const out = slotsOf(now, outKey)[0];
        made = (out?.item === item ? out.count : 0) - outBefore;
        if (made >= smelts) break;
        const left = slotsOf(now, inKey)[0]?.count ?? 0;
        const burn = now.data?.burn ?? 0;
        idle = left > 0 && !burn && !slotsOf(now, fuelKey)[0] ? idle + 1 : 0;
        if (left === 0 || idle >= 4) break;
        if (this.env.clock.now() > deadline) {
          this.actions.push(`waited ${Math.round((smelts * perItem * 1.5 + 5_000) / 1000)} s; ${made} of ${smelts} smelted`);
          break;
        }
      }
      this.actions.push(`the ${state.kind} smelted ${made} ${bareId(item)}`);
      for (let take = 0; take < 3; take++) {
        const out = slotsOf(await this.state(), outKey)[0];
        if (!out) break;
        await this.act(`taking the ${bareId(out.item)}`, { action: "take_result" });
        this.actions.push(`took ${out.count} ${bareId(out.item)} from the output`);
      }
      if (made < Math.min(count, smelts)) {
        throw new StepFail(idle >= 4 ? "missing_ingredient" : "timeout", `the ${state.kind} smelted ${made} of ${smelts} ${bareId(item)}${idle >= 4 ? ": it ran out of fuel" : ""}`);
      }
    });
  }

  async stonecut(recipe: Recipe, item: string, count: number, depth: number): Promise<void> {
    const input = recipe.inputs[0];
    if (!input) throw new StepFail("not_found", `${recipe.id} has no input`);
    const crafts = Math.ceil(count / recipe.result.count);
    await this.ensure(input.ingredient, crafts * input.count, depth);
    await this.atStation("stonecutter", STATION_BLOCKS.stonecutter, ["stonecutter"], async (state) => {
      const inKey = stationKey(state, /input/i, "StonecutterInputContainer");
      await this.moveIn((id) => matches(input.ingredient, id), ingredientText(input.ingredient), { container: inKey, slot: 0 }, crafts * input.count, input.ingredient);
      const offered = (await this.state()).data?.recipes ?? [];
      const choice = offered.find((entry) => entry.result?.item === item);
      if (!choice) throw new StationRefused(`the stonecutter offers no ${bareId(item)} (it offers ${offered.map((entry) => bareId(entry.result?.item ?? "?")).join(", ") || "nothing"})`);
      await this.act(`cutting ${bareId(item)}`, { action: "stonecut", recipe: choice.index, times: Math.min(crafts, STACK) });
      this.actions.push(`cut ${bareId(item)} ${crafts} time${crafts === 1 ? "" : "s"}`);
    });
  }

  async smith(recipe: Recipe, item: string, depth: number): Promise<void> {
    const parts = recipe.smithing;
    if (!parts) throw new StepFail("not_found", `${recipe.id} has no smithing parts`);
    for (const id of [parts.template, parts.base, parts.addition]) await this.ensure({ item: id }, 1, depth);
    await this.atStation("smithing table", STATION_BLOCKS.smithing_table, ["smithing_table"], async (state) => {
      const slots: [string, RegExp, string][] = [
        [parts.template, /template/i, "SmithingTableTemplateContainer"],
        [parts.base, /input|base|equipment/i, "SmithingTableInputContainer"],
        [parts.addition, /material|addition/i, "SmithingTableMaterialContainer"],
      ];
      for (const [id, pattern, fallback] of slots) await this.moveIn((candidate) => candidate === id, bareId(id), { container: stationKey(state, pattern, fallback), slot: 0 }, 1, { item: id });
      await this.act(`upgrading to ${bareId(item)}`, { action: "smithing" });
      this.actions.push(`made ${bareId(item)} at the smithing table`);
    });
  }

  /* ------------------------------------------------------------------------------------------------------------ */
  /* Trading                                                                                                        */
  /* ------------------------------------------------------------------------------------------------------------ */

  /** Buy `count` of `item` from the nearest villager or wandering trader that offers it. */
  async trade(item: string, count: number): Promise<void> {
    const search = await findEntities(this.env, TRADERS, { radius: this.radius });
    const traders = search.found;
    if (!traders.length) throw nothingFound("no_station", "villager or wandering trader", search, TRADERS);
    const sells: string[] = [];
    const tried: string[] = [];
    let fetched = false;
    let reached = 0;
    for (let i = 0; i < Math.min(traders.length, 4); i++) {
      const trader = traders[i] as (typeof traders)[number];
      const who = `the ${bareId(trader.typeId).replace(/_v2$/, "")} at ${xyz(trader.location)}`;
      const walk = await this.env.controller.walkTo({ entity: trader.id }, STATION_RADIUS, this.signal);
      this.check();
      if (!walk.ok) {
        tried.push(`${who}: ${walk.message}`);
        continue;
      }
      this.actions.push(`walked to ${who}`);
      reached++;
      try {
        const sellsItem = (state: ScreenState) => (state.data?.offers ?? []).some((entry) => entry.sell?.item === item);
        const state = await this.useEntity(trader, sellsItem);
        const offers = state.data?.offers ?? [];
        for (const offer of offers) if (offer.sell) sells.push(`${offer.sell.count} ${bareId(offer.sell.item)}`);
        const costs = (offer: (typeof offers)[number]) =>
          [offer.buyA, offer.buyB].flatMap((slot) => (slot ? [`${slot.count} ${bareId(slot.item)}`] : [])).join(" + ");
        this.actions.push(`offers of ${who}: ${offers.map((offer) => `${offer.sell ? `${offer.sell.count} ${bareId(offer.sell.item)}` : "?"} for ${costs(offer) || "?"}${offer.locked ? " (locked)" : ""}`).join("; ") || "none"}`);
        const offer = offers.find((entry) => entry.sell?.item === item && !entry.locked && (entry.uses === null || entry.maxUses === null || entry.uses < entry.maxUses));
        if (!offer?.sell || !offer.buyA) {
          tried.push(`${who} does not sell ${bareId(item)}`);
          continue;
        }
        const left = offer.uses !== null && offer.maxUses !== null ? offer.maxUses - offer.uses : Number.POSITIVE_INFINITY;
        const times = Math.min(Math.ceil(count / offer.sell.count), left);
        const pay = [offer.buyA, offer.buyB].filter((slot): slot is NonNullable<Slot> => !!slot);
        const counts = await this.counts();
        const short = pay.find((slot) => (counts[slot.item] ?? 0) < slot.count * times);
        if (short) {
          if (fetched) throw new StepFail("missing_ingredient", `${who} sells ${offer.sell.count} ${bareId(item)} for ${pay.map((slot) => `${slot.count} ${bareId(slot.item)}`).join(" + ")}; needs ${short.count * times - (counts[short.item] ?? 0)} more ${bareId(short.item)} (has ${counts[short.item] ?? 0})`);
          await this.close();
          fetched = true;
          try {
            for (const slot of pay) await this.ensure({ item: slot.item }, slot.count * times, 1);
          } catch (err) {
            if (err instanceof StepFail && err.reason === "missing_ingredient") {
              throw new StepFail("missing_ingredient", `${who} sells ${offer.sell.count} ${bareId(item)} for ${pay.map((slot) => `${slot.count} ${bareId(slot.item)}`).join(" + ")}; ${err.message}`);
            }
            throw err;
          }
          i--;
          continue;
        }
        const in1 = stationKey(state, /ingredient_?1|ingredient1|buy_?a/i, "Trade2Ingredient1Container");
        const in2 = stationKey(state, /ingredient_?2|ingredient2|buy_?b/i, "Trade2Ingredient2Container");
        let done = 0;
        while (done < times) {
          const per = Math.max(1, Math.min(times - done, ...pay.map((slot) => Math.floor(STACK / slot.count))));
          const [a, b] = pay;
          if (a) await this.moveIn((id) => id === a.item, bareId(a.item), { container: in1, slot: 0 }, a.count * per, { item: a.item });
          if (b) await this.moveIn((id) => id === b.item, bareId(b.item), { container: in2, slot: 0 }, b.count * per, { item: b.item });
          await this.act(`trading for ${bareId(item)} (offer ${offer.index})`, { action: "trade", offer: offer.index, times: per });
          done += per;
          this.actions.push(`traded ${per} time${per === 1 ? "" : "s"}: ${pay.map((slot) => `${slot.count * per} ${bareId(slot.item)}`).join(" + ")} for ${offer.sell.count * per} ${bareId(item)}`);
        }
        return;
      } catch (err) {
        if (!(err instanceof StationRefused)) throw err;
        tried.push(`${who}: ${err.message}`);
      } finally {
        await this.close();
      }
    }
    if (sells.length && tried.every((line) => / does not sell /.test(line))) {
      throw new StepFail("no_offer", `no trader within ${this.radius} blocks sells ${bareId(item)} (they sell ${[...new Set(sells)].join(", ")})`);
    }
    throw new StepFail(reached ? "refused" : "unreachable", `no trader within ${this.radius} blocks could sell ${bareId(item)} (${tried.join("; ")})`);
  }
}

/** The entities a trade step deals with: villagers and wandering traders only. */
export const TRADERS: readonly string[] = ["minecraft:villager_v2", "minecraft:villager", "minecraft:wandering_trader"];

export { center, distance, xyz };
