/**
 * The non-combat task steps: crafting, smelting, trading, fetching from containers, equipping and reaching a block or
 * an entity, each a deterministic procedure run inside sculkwire against the in-process engine calls, the pathfinder
 * and the helper queries (no MCP round trip inside a step). Every call a step makes goes through `TaskEnv`, so tests
 * run the steps against a fake world; `liveTaskEnv` (`live.ts`) builds the real one.
 */
import type { EngineResult } from "../../engine/failure.ts";
import type { BlockRef, ContainerView, CraftMatch, CraftRequest, OpenContainer, PlayerInventoryState } from "../../engine/inventory.ts";
import type {
  BlockUse,
  InteractOutcome,
  ScreenActOutcome,
  ScreenActRequest,
  ScreenCloseOutcome,
  ScreenMoveOutcome,
  ScreenMoveRequest,
  ScreenState,
} from "../../engine/workstation.ts";
import type { Clock } from "../clock.ts";
import type { Vec3 } from "../types.ts";
import type { RecipeIndex } from "./recipes.ts";

export type TaskStep =
  /** End with `count` (default 1) more of `item` in the inventory. */
  | { kind: "craft"; item: string; count?: number }
  /** `item` is the wanted result (iron_ingot) or the input (raw_iron): resolved by the recipe index. */
  | { kind: "smelt"; item: string; count?: number }
  /** Get `item` from a villager or a wandering trader near. */
  | { kind: "trade"; item: string; count?: number }
  /**
   * Take `item` out of the containers around, also from inside a shulker box lying in one. `all`: every one the
   * containers hold (no count given), done once some were taken and none are left.
   */
  | { kind: "fetch"; item: string; count?: number; all?: true }
  /** Hold it (hotbar) or wear it (armor; a shield goes to the off hand). */
  | { kind: "equip"; item: string }
  /** Stand next to the nearest block of this type. */
  | { kind: "reach_block"; block: string }
  /** Stand next to the nearest entity of this type. */
  | { kind: "reach_entity"; type: string };

export type TaskFailure =
  | "missing_ingredient"
  | "no_station"
  | "no_offer"
  | "not_found"
  | "refused"
  | "timeout"
  | "cancelled"
  | "no_agent"
  | "unreachable";

export interface TaskStepResult {
  step: TaskStep;
  ok: boolean;
  /** One sentence a caller can act on: what was made, or what is missing and where it looked. */
  message: string;
  ms: number;
  /** What was done, in order, one short line each. */
  actions: string[];
  /** Inventory change over the step, measured before and after: item id -> count (negative for used up). */
  gained: Record<string, number>;
  reason?: TaskFailure;
}

/** Item id (namespaced) -> count over the player's hotbar, inventory, armor, off hand and cursor. */
export type InventoryCounts = Record<string, number>;

/** A block the helper pack reported. */
export interface BlockInfo {
  typeId: string;
  location: Vec3;
}

/** An entity the helper pack reported. */
export interface EntitySeen {
  id: string;
  typeId: string;
  location: Vec3;
}

/** The player's hands and feet for a step. */
export interface TaskController {
  /** Walk until within `radius` blocks of the point (horizontally) or of the entity; the pathfinder as `goto` uses it. */
  walkTo(target: Vec3 | { entity: string }, radius: number, signal?: AbortSignal): Promise<{ ok: boolean; message: string }>;
  /** The player's feet. */
  position(): Promise<Vec3>;
  /** Select hotbar slot 1 to 9; true once the game shows it selected. */
  selectSlot(slot: number, signal?: AbortSignal): Promise<boolean>;
  /** Open the player's own inventory screen (the 2x2 crafting grid, armor and off-hand slots). */
  openInventory(): Promise<EngineResult<unknown>>;
  /** Let go of every key and button and free the camera. */
  release(): Promise<void>;
  /** Turn the view onto a point; true once it rests there. Absent: entity views are not checked before a use. */
  lookAt?(point: Vec3, signal?: AbortSignal): Promise<boolean>;
  /** What the crosshair rests on now (the helper's `lookingAtEntity` id and `lookingAtBlock` position), when known. */
  lookingAt?(): Promise<{ entity?: string; block?: Vec3 } | undefined>;
}

/** The engine calls behind the `interact`, `screen`, `container`, `craft` and `player_inventory` tools. */
export interface TaskEngine {
  interactBlock(use: BlockUse): Promise<EngineResult<InteractOutcome>>;
  interactEntity(id: string): Promise<EngineResult<InteractOutcome>>;
  screenState(): Promise<EngineResult<ScreenState>>;
  screenMove(request: ScreenMoveRequest): Promise<EngineResult<ScreenMoveOutcome>>;
  screenAct(request: ScreenActRequest): Promise<EngineResult<ScreenActOutcome>>;
  screenClose(): Promise<EngineResult<ScreenCloseOutcome>>;
  readContainer(at: BlockRef): Promise<EngineResult<ContainerView>>;
  readInventory(): Promise<EngineResult<PlayerInventoryState>>;
  craftMatch(request: CraftRequest): Promise<EngineResult<CraftMatch>>;
  /** `container.open`: the open container screen and the block position it belongs to (null for an entity's). */
  containerOpen(): Promise<EngineResult<OpenContainer>>;
}

/** The helper pack's world queries. */
export interface TaskQueries {
  /** Blocks of any of `types` (namespaced) in the cube of `radius` (at most 16) around `at`, default the player. */
  blocks(types: readonly string[], radius: number, at?: Vec3): Promise<BlockInfo[]>;
  /** Entities of `type` (namespaced) within `radius` of the player. */
  entities(type: string, radius: number): Promise<EntitySeen[]>;
  /** The block at a position, null when it cannot be read. */
  block(at: Vec3): Promise<BlockInfo | null>;
}

/** Everything a step needs, injected so tests fake it. */
export interface TaskEnv {
  controller: TaskController;
  engine: TaskEngine;
  query: TaskQueries;
  /** The game's ids (item or block), namespaced; absent or failing: names resolve against what else is known. */
  registry?(kind: "item" | "block"): Promise<string[]>;
  /** Recipes from the vanilla and project behavior packs; absent when they could not be read. */
  recipes?: RecipeIndex;
  /** Why `recipes` is absent, said in a craft's message. */
  recipesNote?: string;
  /** Search radius for stations, containers, villagers, blocks and entities (default 16). */
  radius?: number;
  clock: Clock;
}

/** What `taskStepDone` checks besides the inventory counts, for the steps whose aim is not an item count. */
export interface TaskProbe {
  /** The resolved item id when the step's own name is not one (`smelt raw_iron` -> `minecraft:iron_ingot`). */
  item?: string;
  /** How many more of the item the aim needed, when the step settled it (a `fetch` of `all`: what the containers held). */
  count?: number;
  /** The held item id. */
  held?: string | null;
  /** Worn armor item ids. */
  armor?: string[];
  /** The off-hand item id. */
  offhand?: string | null;
  /** Horizontal distance from the player to the block or entity the step reaches for. */
  distance?: number;
}
