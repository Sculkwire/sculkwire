/**
 * Regolith/rgl projects: when the chosen profile runs filters, build a copy of the project into a temp dir with
 * `rgl run` (export forced to `exact` paths inside the temp dir) so the validator sees what the game will load;
 * diagnostics are reported under the source pack paths. Without filters the source packs are validated as-is.
 */
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, posix, relative, resolve, sep, win32 } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { isPlainObject, type JsonObject } from "./json.ts";
import { run, type RunOptions } from "./process.ts";
import { findOnPath } from "./which.ts";

export interface RegolithBuild {
  profile: string;
  rgl: string;
  /** Temp dir to delete when done. */
  workDir: string;
  /** Built pack dirs keyed by the configured source dir (absolute). */
  outputs: { source: string; built: string }[];
}

export interface RegolithFailure {
  profile: string;
  /** `unavailable`: no rgl; `unreadable`: config.json cannot be read; `failed`: `rgl run` failed. */
  kind: "unavailable" | "unreadable" | "failed";
  message: string;
}


const SKIP_TOP: Record<string, true> = { ".git": true, build: true, node_modules: true, dist: true };

/**
 * Where rgl lives outside PATH, in order: `~/.local/bin`, then rgl's installer location `~/.rgl/bin`. Windows uses
 * `rgl.exe` under `%USERPROFILE%`.
 */
export function rglCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  const win = platform === "win32";
  const p = win ? win32 : posix;
  const exe = win ? "rgl.exe" : "rgl";
  const homeDir = (win ? env.USERPROFILE : undefined) || home;
  return [p.join(homeDir, ".local", "bin", exe), p.join(homeDir, ".rgl", "bin", exe)];
}

/**
 * The rgl to run: `explicit`, else the first of `rglCandidates` that exists, else rgl on PATH (on Windows with any
 * PATHEXT extension; a `.cmd` shim runs through cmd.exe).
 */
export function findRgl(explicit?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string | undefined {
  if (explicit) return explicit;
  return rglCandidates(platform, env, home).find((f) => existsSync(f)) ?? findOnPath("rgl", env, platform);
}

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

/** Profile to build (`default`, else the first) and whether it (transitively) runs any filter. */
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

/**
 * Copy the project to a temp dir and build `profile` with rgl into `<tmp>/out/{BP,RP}`. `projectRoot` may be relative:
 * it is resolved first, because the copy links back to the project's `node_modules` and a relative link target would
 * point the link at itself.
 */
export async function buildRegolith(projectRoot: string, profile: string, rglPath?: string): Promise<RegolithBuild | RegolithFailure> {
  const root = resolve(projectRoot);
  const rgl = findRgl(rglPath);
  if (!rgl) return { profile, kind: "unavailable", message: "rgl not found (~/.local/bin, ~/.rgl/bin or PATH)" };
  const config = await readConfig(root);
  if (!config) return { profile, kind: "unreadable", message: "config.json is not readable" };
  const workDir = await mkdtemp(join(tmpdir(), "sculk-rgl-"));
  const work = join(workDir, "project");
  const out = join(workDir, "out");
  await cp(root, work, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = relative(root, src);
      if (!rel) return true;
      const parts = rel.split(sep);
      if (parts.length === 1 && SKIP_TOP[parts[0] as string]) return false;
      return !(parts[0] === ".regolith" && parts[1] === "tmp");
    },
  });
  // Filters (esbuild, rolldown, typegen) may need the project's dependencies: link instead of copying.
  if (existsSync(join(root, "node_modules"))) {
    await symlink(join(root, "node_modules"), join(work, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
  const profiles = profilesOf(config);
  const p = (profiles[profile] && typeof profiles[profile] === "object" ? profiles[profile] : { filters: [] }) as JsonObject;
  profiles[profile] = { ...p, export: { target: "exact", bpPath: join(out, "BP"), rpPath: join(out, "RP") } };
  (config.regolith as JsonObject).profiles = profiles;
  await writeFile(join(work, "config.json"), JSON.stringify(config, null, 2));
  const rglOptions: RunOptions = { cwd: work, env: { ...process.env, NO_COLOR: "1" }, timeoutMs: 900_000, killSignal: "SIGTERM" };
  let r = await run(rgl, ["run", profile], rglOptions);
  if (r.code !== 0 && /\bget\b|not installed|install/i.test(r.stdout + r.stderr)) {
    await run(rgl, ["get"], rglOptions);
    r = await run(rgl, ["run", profile], rglOptions);
  }
  if (r.code !== 0) {
    await rm(workDir, { recursive: true, force: true });
    // rgl colours its log even with NO_COLOR, and the message is read as plain text.
    const output = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "").trim();
    const tail = output.slice(-2000);
    return { profile, kind: "failed", message: `rgl run ${profile} failed: ${tail.length < output.length ? tail.slice(tail.indexOf("\n") + 1) : tail}` };
  }
  const packs = (config.packs && typeof config.packs === "object" ? config.packs : {}) as JsonObject;
  const outputs: { source: string; built: string }[] = [];
  for (const [key, def] of [
    ["behaviorPack", "./packs/BP"],
    ["resourcePack", "./packs/RP"],
  ] as const) {
    const src = typeof packs[key] === "string" ? (packs[key] as string) : def;
    const built = join(out, key === "behaviorPack" ? "BP" : "RP");
    if (existsSync(join(built, "manifest.json"))) outputs.push({ source: join(root, src), built });
  }
  return { profile, rgl, workDir, outputs };
}
