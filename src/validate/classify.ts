/**
 * File classification: what a pack-relative path is (entity, client entity, loot table, ...) and which
 * `format_version` it declares. Kinds drive schema choice, cross-file indexing and line-level checks.
 */
import type { PackKind } from "../core/project.ts";

export type FileKind =
  // behavior pack
  | "manifest"
  | "entity"
  | "item"
  | "block"
  | "biome"
  | "feature"
  | "feature_rule"
  | "loot_table"
  | "recipe"
  | "spawn_rule"
  | "trade_table"
  | "dialogue"
  | "animation_bp"
  | "animation_controller_bp"
  | "voxel_shape"
  | "tick_json"
  | "mcfunction"
  | "script"
  | "dimension"
  | "camera_preset"
  | "crafting_catalog"
  | "jigsaw_structure"
  | "structure_set"
  | "processor_list"
  | "template_pool"
  | "structure"
  // resource pack
  | "client_entity"
  | "attachable"
  | "geometry"
  | "particle"
  | "animation_rp"
  | "animation_controller_rp"
  | "render_controller"
  | "sound_definitions"
  | "sounds_json"
  | "music_definitions"
  | "item_texture"
  | "terrain_texture"
  | "flipbook_textures"
  | "blocks_json"
  | "biomes_client"
  | "client_biome"
  | "fog"
  | "block_culling"
  | "ui"
  | "global_variables"
  | "texture_set"
  | "languages"
  | "lang"
  | "deferred_rendering"
  | "rp_item"
  | "material"
  | "texture_file"
  | "sound_file"
  // anything else
  | "json"
  | "other";

const IMAGE_EXT = /\.(png|tga|jpe?g)$/i;
const SOUND_EXT = /\.(ogg|wav|fsb|mp3)$/i;
export const JSON_EXT = /\.(json|jsonc|json5|material)$/i;

const BP_DIRS: Record<string, FileKind> = {
  entities: "entity",
  items: "item",
  blocks: "block",
  biomes: "biome",
  features: "feature",
  feature_rules: "feature_rule",
  loot_tables: "loot_table",
  recipes: "recipe",
  spawn_rules: "spawn_rule",
  trading: "trade_table",
  dialogue: "dialogue",
  animations: "animation_bp",
  animation_controllers: "animation_controller_bp",
  voxel_shapes: "voxel_shape",
  shapes: "voxel_shape",
  dimensions: "dimension",
};

const RP_DIRS: Record<string, FileKind> = {
  entity: "client_entity",
  attachables: "attachable",
  models: "geometry",
  particles: "particle",
  animations: "animation_rp",
  animation_controllers: "animation_controller_rp",
  render_controllers: "render_controller",
  fogs: "fog",
  block_culling: "block_culling",
  ui: "ui",
  biomes: "client_biome",
  items: "rp_item",
  atmospherics: "deferred_rendering",
  color_grading: "deferred_rendering",
  lighting: "deferred_rendering",
  water: "deferred_rendering",
  pbr: "deferred_rendering",
  point_lights: "deferred_rendering",
  shadows: "deferred_rendering",
};

const RP_FILES: Record<string, FileKind> = {
  "sounds.json": "sounds_json",
  "blocks.json": "blocks_json",
  "biomes_client.json": "biomes_client",
  "sounds/sound_definitions.json": "sound_definitions",
  "sounds/music_definitions.json": "music_definitions",
  "textures/item_texture.json": "item_texture",
  "textures/terrain_texture.json": "terrain_texture",
  "textures/flipbook_textures.json": "flipbook_textures",
  "texts/languages.json": "languages",
  "ui/_global_variables.json": "global_variables",
};

/** Strip a leading `subpacks/<name>/` so subpack files classify like their top-level twins. */
function unsubpack(rel: string): string {
  const m = /^subpacks\/[^/]+\/(.*)$/.exec(rel);
  return m ? (m[1] as string) : rel;
}

export function classifyFile(packKind: PackKind, relPath: string): FileKind {
  const rel = unsubpack(relPath);
  const lower = rel.toLowerCase();
  if (rel === "manifest.json") return "manifest";
  const top = rel.split("/", 1)[0] as string;
  if (packKind === "behavior") {
    if (rel === "functions/tick.json") return "tick_json";
    if (top === "functions" && lower.endsWith(".mcfunction")) return "mcfunction";
    if (top === "scripts" && /\.(m?[jt]s)$/i.test(rel)) return "script";
    if (top === "structures" && lower.endsWith(".mcstructure")) return "structure";
    if (top === "cameras" && JSON_EXT.test(rel)) return "camera_preset";
    if (rel === "crafting_item_catalog.json" || top === "item_catalog") return "crafting_catalog";
    if (top === "worldgen") {
      const sub = rel.split("/")[1];
      if (sub === "jigsaw_structures" || sub === "structures") return "jigsaw_structure";
      if (sub === "structure_sets") return "structure_set";
      if (sub === "processors") return "processor_list";
      if (sub === "template_pools") return "template_pool";
    }
    const kind = BP_DIRS[top];
    if (kind && JSON_EXT.test(rel)) return kind;
  } else if (packKind === "resource") {
    const exact = RP_FILES[rel];
    if (exact) return exact;
    if (top === "texts" && lower.endsWith(".lang")) return "lang";
    if (top === "textures" && rel.endsWith("texture_set.json")) return "texture_set";
    if (top === "textures" && IMAGE_EXT.test(rel)) return "texture_file";
    if (top === "sounds" && SOUND_EXT.test(rel)) return "sound_file";
    if (top === "materials" && lower.endsWith(".material")) return "material";
    if (top === "ui" && rel.endsWith("_global_variables.json")) return "global_variables";
    const kind = RP_DIRS[top];
    if (kind && JSON_EXT.test(rel)) return kind;
  }
  return JSON_EXT.test(rel) ? "json" : "other";
}

/** `format_version` as declared (string or number), when the file has one. */
export function formatVersionOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fv = (value as Record<string, unknown>).format_version;
  if (typeof fv === "string") return fv;
  if (typeof fv === "number") return String(fv);
  return undefined;
}

/** Numeric tuple of a dotted version (`"1.21.60"` -> [1, 21, 60]); empty when unparsable. */
export function versionTuple(v: string): number[] {
  return /^\d+(\.\d+)*$/.test(v.trim()) ? v.trim().split(".").map(Number) : [];
}

export function compareVersionTuples(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
