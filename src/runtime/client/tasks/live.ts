/**
 * The real `TaskEnv`: the player controller and the pathfinder (as `goto` uses them), the in-game agent's calls behind
 * `interact`, `screen`, `container`, `craft` and `player_inventory`, the helper pack's queries and registry, and the
 * recipe index from the cached bedrock-samples behavior pack plus the project's packs.
 */
import type { Channel } from "../../../core/version.ts";
import { engine } from "../../engine/engine.ts";
import { containerOpen, craftMatch, readContainer, readPlayerInventory } from "../../engine/inventory.ts";
import { interactBlock, interactEntity, screenAct, screenClose, screenMove, screenState } from "../../engine/workstation.ts";
import { bridge } from "../bridge.ts";
import { navigate } from "../nav/navigate.ts";
import { realClock, type PlayerController, type Vec3 } from "../player.ts";
import { loadRecipeIndex, type RecipeIndex } from "./recipes.ts";
import type { BlockInfo, EntitySeen, TaskEnv } from "./types.ts";

/** The helper's `blocks` query reads at most this far (`helper-pack/scripts/main.js`). */
const BLOCKS_RADIUS_MAX = 16;
/** A walk to a station gives up after this long. */
const WALK_TIMEOUT_MS = 60_000;
/** The game's default key for the inventory screen. */
const INVENTORY_KEY = "e";
/** The view counts as on an entity within this many degrees; the helper's pick then says what it rests on. */
const LOOK_TOLERANCE_DEG = 3;
/** A crosshair reading older than this is read again (the helper streams it every tick or two). */
const LOOKING_MAX_AGE_MS = 150;

function vec(value: unknown): Vec3 | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { x, y, z } = value as Record<string, unknown>;
  return typeof x === "number" && typeof y === "number" && typeof z === "number" ? { x, y, z } : undefined;
}

function blockOf(raw: unknown): BlockInfo | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { typeId, location } = raw as Record<string, unknown>;
  const at = vec(location);
  return typeof typeId === "string" && at ? { typeId, location: at } : undefined;
}

function entityOf(raw: unknown): EntitySeen | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { id, typeId, location } = raw as Record<string, unknown>;
  const at = vec(location);
  return typeof id === "string" && typeof typeId === "string" && at ? { id, typeId, location: at } : undefined;
}

/** A registry entry as an id: the helper pack lists strings, `/connect` lists the game's entry objects. */
function entryId(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return undefined;
  const { id, name } = entry as Record<string, unknown>;
  return typeof id === "string" ? id : typeof name === "string" ? name : undefined;
}

/** The index is read once per channel and project; a failed read is tried again next time. */
const indexes = new Map<string, Promise<{ index?: RecipeIndex; note?: string }>>();

export interface LiveTaskEnvOptions {
  controller: PlayerController;
  radius?: number;
}

export async function liveTaskEnv(options: LiveTaskEnvOptions): Promise<TaskEnv> {
  const pc = options.controller;
  const channel: Channel = bridge.install?.preview ? "preview" : "stable";
  const key = `${channel}\n${bridge.project ?? ""}`;
  let loading = indexes.get(key);
  if (!loading) {
    loading = loadRecipeIndex({ channel, ...(bridge.project ? { project: bridge.project } : {}) });
    indexes.set(key, loading);
  }
  const recipes = await loading.catch((err: unknown) => ({ note: err instanceof Error ? err.message : String(err) }) as { index?: RecipeIndex; note?: string });
  if (!recipes.index) indexes.delete(key);
  const registries = new Map<string, Promise<string[]>>();
  return {
    controller: {
      walkTo: (target, radius, signal) => navigate(pc, target, { radius, timeoutMs: WALK_TIMEOUT_MS }, signal),
      position: async () => (await pc.world.state()).location,
      selectSlot: (slot, signal) => pc.hands.selectSlot(slot, signal),
      // The step polls the screen until the inventory shows its crafting grid (`Run.openInventory`).
      openInventory: () => engine.uiKey(INVENTORY_KEY),
      release: () => pc.releaseAll(),
      lookAt: (point, signal) => pc.lookAtPoint(point, LOOK_TOLERANCE_DEG, signal),
      lookingAt: async () => {
        const state = await pc.world.state(LOOKING_MAX_AGE_MS);
        return {
          ...(state.lookingAtEntity ? { entity: state.lookingAtEntity.id } : {}),
          ...(state.lookingAtBlock ? { block: state.lookingAtBlock.location } : {}),
        };
      },
    },
    engine: {
      interactBlock: (use) => interactBlock(use),
      interactEntity: (id) => interactEntity(id),
      screenState: () => screenState(),
      screenMove: (request) => screenMove(request),
      screenAct: (request) => screenAct(request),
      screenClose: () => screenClose(),
      readContainer: (at) => readContainer(at),
      readInventory: () => readPlayerInventory(),
      craftMatch: (request) => craftMatch(request),
      containerOpen: () => containerOpen(),
    },
    query: {
      blocks: async (types, radius, at) => {
        // `type` too: a helper pack deployed before `types` existed filters by it (the first type only).
        const params = { type: types[0], types: [...types], radius: Math.min(radius, BLOCKS_RADIUS_MAX), ...(at ? { x: at.x, y: at.y, z: at.z } : {}) };
        const rows = await bridge.query("blocks", params);
        return Array.isArray(rows) ? rows.flatMap((row) => blockOf(row) ?? []) : [];
      },
      entities: async (type, radius) => {
        const rows = await bridge.query("entities", { type, radius });
        return Array.isArray(rows) ? rows.flatMap((row) => entityOf(row) ?? []) : [];
      },
      block: async (at) => blockOf(await bridge.query("block", { x: at.x, y: at.y, z: at.z })) ?? null,
    },
    registry: (kind) => {
      let ids = registries.get(kind);
      if (!ids) {
        ids = bridge.registry(kind).then((result) => result.entries.flatMap((entry) => entryId(entry) ?? []));
        registries.set(kind, ids);
      }
      return ids;
    },
    ...(recipes.index ? { recipes: recipes.index } : {}),
    ...(recipes.note ? { recipesNote: recipes.note } : {}),
    ...(options.radius !== undefined ? { radius: options.radius } : {}),
    clock: realClock,
  };
}
