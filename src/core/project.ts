import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

export type PackKind = "behavior" | "resource" | "skin" | "world_template" | "unknown";

export interface PackInfo {
  kind: PackKind;
  /** Absolute pack directory (the one holding manifest.json). */
  dir: string;
  /** Pack directory relative to the project root, POSIX separators ("" when the root is the pack). */
  relDir: string;
  uuid?: string;
  version?: string;
  name?: string;
  /** `header.min_engine_version` joined with dots. */
  minEngineVersion?: string;
  /** `manifest.format_version`. */
  manifestFormat?: number;
}

export interface ProjectLayout {
  root: string;
  /** Present when the root is a Regolith/rgl project (`config.json` with a `regolith` section). */
  regolith?: { configPath: string; behaviorPack?: string; resourcePack?: string };
  packs: PackInfo[];
}

const SKIP_DIRS: Record<string, true> = { node_modules: true, ".git": true, ".regolith": true, dist: true, build: true, ".cache": true };
const MAX_DEPTH = 5;

function kindOf(modules: unknown): PackKind {
  if (!Array.isArray(modules)) return "unknown";
  const types = new Set(modules.map((m) => (m && typeof m === "object" && "type" in m ? m.type : undefined)));
  if (types.has("data") || types.has("script") || types.has("javascript")) return "behavior";
  if (types.has("resources")) return "resource";
  if (types.has("skin_pack")) return "skin";
  if (types.has("world_template")) return "world_template";
  return "unknown";
}

async function readManifest(dir: string, root: string): Promise<PackInfo | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, "manifest.json"), "utf8");
  } catch {
    return undefined;
  }
  const manifest = parseJsonc(text, [], { allowTrailingComma: true }) as Record<string, unknown> | undefined;
  const header = (manifest?.header ?? {}) as Record<string, unknown>;
  const asVersion = (v: unknown): string | undefined =>
    Array.isArray(v) ? v.join(".") : typeof v === "string" ? v : undefined;
  const info: PackInfo = { kind: kindOf(manifest?.modules), dir, relDir: relative(root, dir).split(sep).join("/") };
  if (typeof header.uuid === "string") info.uuid = header.uuid;
  const version = asVersion(header.version);
  if (version) info.version = version;
  if (typeof header.name === "string") info.name = header.name;
  const minEngine = asVersion(header.min_engine_version);
  if (minEngine) info.minEngineVersion = minEngine;
  if (typeof manifest?.format_version === "number") info.manifestFormat = manifest.format_version;
  return info;
}

async function walk(dir: string, root: string, depth: number, out: PackInfo[]): Promise<void> {
  const pack = await readManifest(dir, root);
  if (pack) {
    out.push(pack);
    return;
  }
  if (depth >= MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS[e.name] && !e.name.startsWith(".")) {
      await walk(join(dir, e.name), root, depth + 1, out);
    }
  }
}

async function readRegolith(root: string): Promise<ProjectLayout["regolith"]> {
  const configPath = join(root, "config.json");
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return undefined;
  }
  const config = parseJsonc(text, [], { allowTrailingComma: true }) as Record<string, unknown> | undefined;
  if (!config || typeof config.regolith !== "object") return undefined;
  const packs = (config.packs ?? {}) as Record<string, unknown>;
  const result: NonNullable<ProjectLayout["regolith"]> = { configPath };
  if (typeof packs.behaviorPack === "string") result.behaviorPack = join(root, packs.behaviorPack);
  if (typeof packs.resourcePack === "string") result.resourcePack = join(root, packs.resourcePack);
  return result;
}

/** Find every pack (directory with a manifest.json) under `root`, plus Regolith project info. */
export async function discoverProject(root: string): Promise<ProjectLayout> {
  if (!(await stat(root)).isDirectory()) throw new Error(`not a directory: ${root}`);
  const packs: PackInfo[] = [];
  await walk(root, root, 0, packs);
  packs.sort((a, b) => a.relDir.localeCompare(b.relDir));
  const layout: ProjectLayout = { root, packs };
  const regolith = await readRegolith(root);
  if (regolith) layout.regolith = regolith;
  return layout;
}
