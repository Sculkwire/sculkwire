/**
 * Readers of a bedrock-samples checkout's engine-generated data (`version.json`, `metadata/`) and of JSON schema
 * files (engine `json_schemas`, rockide/schemas). The knowledge lookups and the validator both read through here.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { readJsonOr } from "../core/fs.ts";
import { memoAsync } from "../core/memo.ts";

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Files under `dir` (recursive) ending in `ext`, absolute and sorted; empty when `dir` is unreadable. */
export async function listFiles(dir: string, ext: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(ext))
      .map((e) => join(e.parentPath, e.name))
      .sort();
  } catch {
    return [];
  }
}

/** Game version (`version.json` "latest") of a samples checkout. */
export async function readSamplesVersion(root: string): Promise<string | undefined> {
  const v = (await readJsonOr<{ latest?: { version?: unknown } }>(join(root, "version.json")))?.latest?.version;
  return typeof v === "string" ? v : undefined;
}

/** Commit checked out at `root` (`.git/HEAD`, following a branch ref), or "" when it is no git checkout. */
export async function checkoutCommit(root: string): Promise<string> {
  const head = (await readText(join(root, ".git", "HEAD")))?.trim();
  if (!head) return "";
  const ref = /^ref: (.+)$/.exec(head)?.[1];
  if (!ref) return head;
  return (await readText(join(root, ".git", ...ref.split("/"))))?.trim() ?? ref;
}

export interface RawCommand {
  name: string;
  description: string;
  aliases: { name: string }[] | string[];
  permission_level: number;
  requires_cheats: boolean;
  overloads: { name: string; params: { name: string; is_optional: boolean; type: { name: string } }[] }[];
}

export interface RawCommands {
  commands: RawCommand[];
  command_enums: { name: string; values: { value: string }[] }[];
}

const commandsPath = (root: string): string => join(root, "metadata", "command_modules", "mojang-commands.json");

/** `metadata/command_modules/mojang-commands.json`; rejects when it is missing or unreadable. */
export async function readCommands(root: string): Promise<RawCommands> {
  return JSON.parse(await readFile(commandsPath(root), "utf8")) as RawCommands;
}

/** Command names and aliases (lowercase); empty when the samples lack command metadata. */
export async function readCommandNames(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  const j = await readJsonOr<{ commands?: { name?: unknown; aliases?: unknown }[] }>(commandsPath(root));
  for (const c of j?.commands ?? []) {
    if (typeof c.name === "string") out.add(c.name.toLowerCase());
    for (const a of Array.isArray(c.aliases) ? c.aliases : []) {
      const n = typeof a === "string" ? a : a && typeof a === "object" && "name" in a ? a.name : undefined;
      if (typeof n === "string") out.add(n.toLowerCase());
    }
  }
  return out;
}

export interface VanillaDataFile {
  /** Path relative to `metadata/vanilladata_modules` (`mojang-items.json`). */
  file: string;
  /** `vanilla_data_type`, else the file name without `mojang-` and `.json`. */
  type: string;
  items: { name: string; [k: string]: unknown }[];
}

/** Every readable `metadata/vanilladata_modules` file. */
export async function readVanillaData(root: string): Promise<VanillaDataFile[]> {
  const dir = join(root, "metadata", "vanilladata_modules");
  const out: VanillaDataFile[] = [];
  for (const path of await listFiles(dir, ".json")) {
    const raw = await readJsonOr<{ vanilla_data_type?: string; data_items?: { name: string; [k: string]: unknown }[] }>(path);
    if (!raw) continue;
    out.push({
      file: relative(dir, path).split("\\").join("/"),
      type: raw.vanilla_data_type ?? path.replace(/^.*mojang-|\.json$/g, ""),
      items: raw.data_items ?? [],
    });
  }
  return out;
}

/** `@minecraft/<module>` -> manifest version -> module uuid, from `metadata/script_modules` (`-bindings` files skipped). */
export async function readScriptModuleVersions(root: string): Promise<Map<string, Map<string, string | undefined>>> {
  const out = new Map<string, Map<string, string | undefined>>();
  async function walk(d: string, scope: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        await walk(join(d, e.name), e.name.startsWith("@") ? e.name : scope);
        continue;
      }
      const m = /^(.+)_(\d+\.\d+\.\d+(?:-\w+)?)\.json$/.exec(e.name);
      if (!m) continue;
      const name = scope ? `${scope}/${m[1]}` : (m[1] as string);
      if (name.endsWith("-bindings")) continue;
      const uuid = (await readJsonOr<{ uuid?: unknown }>(join(d, e.name)))?.uuid;
      let versions = out.get(name);
      if (!versions) out.set(name, (versions = new Map()));
      versions.set(m[2] as string, typeof uuid === "string" ? uuid : undefined);
    }
  }
  await walk(join(root, "metadata", "script_modules"), "");
  return out;
}

export interface ScriptModuleFile {
  /** `@minecraft/server` (a `-bindings` file counts as its module). */
  module: string;
  /** Module version (`2.1.0`, `2.2.0-beta`). */
  version: string;
  path: string;
}

/** Every `metadata/script_modules/@minecraft/<module>_<version>.json`; rejects when the folder is missing. */
export async function readScriptModuleFiles(root: string): Promise<ScriptModuleFile[]> {
  const dir = join(root, "metadata", "script_modules", "@minecraft");
  const out: ScriptModuleFile[] = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".json"))) {
    const m = /^(.+?)_(\d+\.\d+\.\d+(?:-[\w.]+)?)\.json$/.exec(file);
    if (!m?.[1] || !m[2]) continue;
    out.push({ module: `@minecraft/${m[1].replace(/-bindings$/, "")}`, version: m[2], path: join(dir, file) });
  }
  return out;
}

export interface EngineSchemaFile {
  /** `<side>/<kind>` (`server/entity`). */
  scope: string;
  /** Version folder (`1.26.50`, `legacy`, `beta`). */
  formatVersion: string;
  /** File name (`ActorDocument.json`, `minecraft_health.json`). */
  name: string;
  /** Path relative to the dump root, POSIX. */
  rel: string;
}

/** Every schema of an engine dump in the `<side>/<kind>/<format_version>/<file>.json` layout under `base`. */
export async function listEngineSchemas(base: string): Promise<EngineSchemaFile[]> {
  const out: EngineSchemaFile[] = [];
  for (const file of await listFiles(base, ".json")) {
    const rel = relative(base, file).split("\\").join("/");
    const parts = rel.split("/");
    if (parts.length !== 4) continue;
    const [side, kind, formatVersion, name] = parts as [string, string, string, string];
    out.push({ scope: `${side}/${kind}`, formatVersion, name, rel });
  }
  return out;
}

const schemaFiles = memoAsync<unknown>();

/** A JSON schema file parsed as JSONC (comments and trailing commas allowed), once per path and process. */
export function readSchemaJson(path: string): Promise<unknown> {
  return schemaFiles(path, async () => parseJsonc(await readFile(path, "utf8"), [], { allowTrailingComma: true }) as unknown);
}
