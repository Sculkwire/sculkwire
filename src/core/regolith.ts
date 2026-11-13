/**
 * Regolith/rgl projects. sculkwire never runs rgl: the build is the project's own business (its profile, its flags,
 * its `rgl watch`). When the profile runs filters, the source packs hold the filter inputs and not what the game
 * loads, so every tool reads what rgl last built instead: `.regolith/tmp/BP` and `.regolith/tmp/RP`, which rgl leaves
 * behind after every `rgl run` and `rgl watch`, whatever the profile, the flags or the export target (`regolithOutput`).
 * Without filters the source packs are used as they are.
 */
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { isPlainObject, type JsonObject } from "./json.ts";

async function readConfig(root: string): Promise<JsonObject | undefined> {
  try {
    const v: unknown = parseJsonc(await readFile(join(root, "config.json"), "utf8"), [], { allowTrailingComma: true });
    return isPlainObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function profilesOf(config: JsonObject): JsonObject {
  const reg = config.regolith;
  const profiles = reg && typeof reg === "object" && "profiles" in reg ? reg.profiles : undefined;
  return isPlainObject(profiles) ? profiles : {};
}

/** The profile that decides (`wanted`, else `default`, else the first) and whether it (transitively) runs any filter. */
export async function regolithPlan(root: string, wanted?: string): Promise<{ profile: string; hasFilters: boolean } | undefined> {
  const config = await readConfig(root);
  if (!config || typeof config.regolith !== "object") return undefined;
  const profiles = profilesOf(config);
  const profile = wanted ?? ("default" in profiles ? "default" : (Object.keys(profiles)[0] ?? "default"));
  const seen = new Set<string>();
  const hasFilters = (name: string): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    const p = profiles[name];
    const filters = p && typeof p === "object" && "filters" in p && Array.isArray(p.filters) ? p.filters : [];
    return filters.some((f: unknown) => {
      if (!f || typeof f !== "object") return false;
      if ("profile" in f && typeof f.profile === "string") return hasFilters(f.profile);
      return !("disabled" in f && f.disabled === true);
    });
  };
  return { profile, hasFilters: hasFilters(profile) };
}

/** Pack folder names one Regolith export writes into the game's `development_*_packs` folders. */
export interface RegolithExportFolders {
  behavior: string[];
  resource: string[];
}

/** `bpName`/`rpName` are expressions; only a quoted literal (`"'my_bp'"`) is read, anything else is unknown. */
function exportName(expr: unknown, fallback: string): string | undefined {
  if (expr === undefined) return fallback;
  const m = typeof expr === "string" ? /^\s*(['"])(.*)\1\s*$/.exec(expr) : null;
  return m ? m[2] : undefined;
}

/**
 * Folder names this project's profiles export to inside `development_behavior_packs` / `development_resource_packs`:
 * `development`/`preview` targets write `<name>_bp` and `<name>_rp` (or a literal `bpName`/`rpName`), an `exact`
 * target names the folder by the last part of `bpPath`/`rpPath` when its parent is a development packs folder.
 * Every profile counts, because the folder may be left over from any of them.
 */
export async function regolithExportFolders(root: string): Promise<RegolithExportFolders> {
  const out: RegolithExportFolders = { behavior: [], resource: [] };
  const config = await readConfig(root);
  if (!config) return out;
  const name = typeof config.name === "string" ? config.name : undefined;
  const add = (list: string[], folder: string | undefined): void => {
    if (folder && !list.includes(folder)) list.push(folder);
  };
  for (const profile of Object.values(profilesOf(config))) {
    const exp = profile && typeof profile === "object" && "export" in profile ? profile.export : undefined;
    if (!exp || typeof exp !== "object") continue;
    const e = exp as JsonObject;
    if (e.target === "development" || e.target === "preview") {
      if (name !== undefined || e.bpName !== undefined) add(out.behavior, exportName(e.bpName, `${name}_bp`));
      if (name !== undefined || e.rpName !== undefined) add(out.resource, exportName(e.rpName, `${name}_rp`));
    } else if (e.target === "exact") {
      for (const [key, list, parent] of [
        ["bpPath", out.behavior, "development_behavior_packs"],
        ["rpPath", out.resource, "development_resource_packs"],
      ] as const) {
        const p = e[key];
        if (typeof p !== "string") continue;
        const parts = p.split(/[\\/]+/).filter(Boolean);
        if (parts.length >= 2 && parts.at(-2) === parent) add(list, parts.at(-1));
      }
    }
  }
  return out;
}

/** What rgl last built in a project. */
export interface RegolithOutput {
  /** The built pack dirs (real paths) keyed by the configured source dir (absolute). */
  outputs: { source: string; built: string }[];
  /** The project's data folder (`regolith.dataPath`, absolute), which the filters see as `.regolith/tmp/data`. */
  dataDir: string;
  /**
   * When rgl last ran. rgl links `.regolith/tmp/BP` and `RP` to the export folder again on every run, so the link's
   * own time is the run's; absent when rgl keeps real folders there (`--compat`, or a `none` export).
   */
  builtAt?: Date;
}

/** What a tool says when a profile runs filters and `regolithOutput` finds nothing. */
export const RGL_NOT_BUILT =
  "rgl has not built this project (.regolith/tmp holds no pack with a manifest.json): run `rgl run`, or keep " +
  "`rgl watch` running, first. sculkwire does not run rgl";

/**
 * The packs rgl last built for the project: `.regolith/tmp/BP` and `.regolith/tmp/RP`, each when it holds a
 * manifest.json. rgl leaves them after every `rgl run` and `rgl watch`, for any profile, flag and export target: a
 * link to the export folder (the filters ran in place there), or a real folder with `--compat` or a `none` export.
 * Undefined when rgl has not built the project. Nothing is written and rgl is never run.
 *
 * rgl copies the source packs there before the filters run, so while a run is under way, and after one that failed,
 * the folders hold a manifest but not the finished build: that cannot be told from here.
 */
export async function regolithOutput(projectRoot: string): Promise<RegolithOutput | undefined> {
  const root = resolve(projectRoot);
  const config = await readConfig(root);
  if (!config) return undefined;
  const packs = (config.packs && typeof config.packs === "object" ? config.packs : {}) as JsonObject;
  const outputs: { source: string; built: string }[] = [];
  let builtAt: Date | undefined;
  for (const [key, def, name] of [
    ["behaviorPack", "./packs/BP", "BP"],
    ["resourcePack", "./packs/RP", "RP"],
  ] as const) {
    const dir = join(root, ".regolith", "tmp", name);
    if (!existsSync(join(dir, "manifest.json"))) continue;
    const src = typeof packs[key] === "string" ? (packs[key] as string) : def;
    try {
      const built = await realpath(dir);
      const link = await lstat(dir);
      outputs.push({ source: join(root, src), built });
      if (link.isSymbolicLink() && (!builtAt || link.mtime > builtAt)) builtAt = link.mtime;
    } catch {
      // rgl removes the folder and links it again at the start of every run: a pack gone in between is not built.
    }
  }
  if (!outputs.length) return undefined;
  const regolith = isPlainObject(config.regolith) ? config.regolith : {};
  const dataDir = resolve(root, typeof regolith.dataPath === "string" ? regolith.dataPath : "./data");
  return { outputs, dataDir, ...(builtAt ? { builtAt } : {}) };
}
