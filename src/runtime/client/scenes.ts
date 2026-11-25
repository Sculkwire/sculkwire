/**
 * Scenes: named test starts saved in the world by the helper pack (`scene_*` handlers in `helper-pack/scripts/main.js`).
 * The box's blocks and entities are a world structure and the player's state a world dynamic property, so a scene
 * lasts exactly as long as its world: one session for the default test world, longer for a kept or copied one.
 */
import { bridge } from "./bridge.ts";

/** What a scene name may be: also the suffix of its structure id and dynamic property. */
export const SCENE_NAME = /^[a-z0-9_-]{1,32}$/;
export const SCENE_DEFAULT_RADIUS = 8;
/** A structure is at most 64 blocks wide and deep: a box of `2 * radius + 1` fits up to 31. */
export const SCENE_MAX_RADIUS = 31;
/** scene_reset waits up to 100 ticks (5 s) for the box's chunks after the teleport. */
const RESET_TIMEOUT_MS = 20_000;

type Vec = { x: number; y: number; z: number };
export interface SceneBox {
  min: Vec;
  max: Vec;
}

export interface SceneSaved {
  name: string;
  /** True when a scene of that name was replaced. */
  overwritten: boolean;
  dimension: string;
  box: SceneBox;
  /** Non-player entities in the box when it was saved. */
  entities: number;
  /** Non-empty inventory, armour and off-hand slots saved. */
  items: number;
  notes: string[];
}

export interface SceneRestored {
  name: string;
  dimension: string;
  box: SceneBox;
  /** Non-player entities removed from the box before the saved ones were placed back. */
  removedEntities: number;
  restored: string[];
  /** What could not be restored, and why. */
  notes: string[];
}

export interface SceneInfo {
  name: string;
  savedAt?: number;
  dimension?: string;
  box?: SceneBox;
  position?: Vec;
  /** Whether the scene's structure is still in the world. */
  structure?: boolean;
  /** Why the stored scene could not be read. */
  error?: string;
}

export async function saveScene(params: { name: string; radius?: number; x?: number; y?: number; z?: number }): Promise<SceneSaved> {
  const { x, y, z } = params;
  const given = [x, y, z].filter((v) => v !== undefined).length;
  if (given !== 0 && given !== 3) throw new Error("give all of x, y and z for the center, or none for the player's position");
  const sent = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
  return (await bridge.query("scene_save", sent)) as SceneSaved;
}

export async function resetScene(name: string): Promise<SceneRestored> {
  return (await bridge.query("scene_reset", { name }, RESET_TIMEOUT_MS)) as SceneRestored;
}

export async function listScenes(): Promise<SceneInfo[]> {
  return (await bridge.query("scene_list")) as SceneInfo[];
}

export async function deleteScene(name: string): Promise<{ name: string; deleted: boolean }> {
  return (await bridge.query("scene_delete", { name })) as { name: string; deleted: boolean };
}
