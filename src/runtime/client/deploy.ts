/**
 * Where a project's packs go in the client's `development_*_packs` folders. A plain project deploys its source
 * dirs. A Regolith project whose profile runs filters deploys the dirs rgl built, because the source dirs hold the
 * filter inputs (TypeScript, JSON sources) and not what the game loads. The planning is pure so the bridge and its
 * tests share one rule set; `readManifestHeader` reads the manifest a built pack ships.
 *
 * One uuid, one folder: the game picks any one of several dev packs that share a header uuid, so a stale copy can
 * win over the fresh one. The plan therefore leaves exactly one folder of this project per deployed uuid. Folders
 * that share the uuid but are not derived from this project are never touched; the plan lists them for a warning.
 */
import { cp, readdir, readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import type { Diagnostic } from "../../core/diagnostic.ts";
import { discoverProject } from "../../core/project.ts";
import { buildRegolith, regolithExportFolders, regolithPlan, type RegolithExportFolders } from "../../core/regolith.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import type { PackRef } from "./world.ts";

/** Pack kinds a world can activate. */
export type DeployKind = "behavior" | "resource";

/** One project pack and, when a Regolith build ran, the dir rgl built it into. */
export interface PackToDeploy {
  kind: DeployKind;
  /** Absolute source pack dir (the one holding the project's manifest.json). */
  dir: string;
  /** Manifest header uuid actually deployed (the built manifest after a build). */
  uuid: string;
  /** Manifest header version actually deployed. */
  version: string;
  /** Absolute built pack dir from the Regolith build. */
  built?: string;
  /** Manifest header name, for status output. */
  name?: string;
}

/** What happens to one project pack. */
export interface PackDeploy {
  kind: DeployKind;
  uuid: string;
  version: string;
  name?: string;
  /** Folder under `development_<kind>_packs`; absent when the pack is not deployed. */
  folder?: string;
  /** Absolute deployed pack dir; absent when the pack is not deployed. */
  path?: string;
  /** Dir to copy (the built dir after a build, else the source dir); absent when an existing deployment is reused. */
  copyFrom?: string;
  /** True when `path` holds the Regolith build output. */
  built: boolean;
  /** True when `path` is a `sculkwire_*` copy that sculkwire removes when the game stops. */
  owned: boolean;
  /** Absolute dirs of other copies of this project's pack with the same uuid (stale rgl export or sculkwire copy): delete. */
  remove: string[];
  /** Absolute dirs of packs not derived from this project that share the uuid: left alone, reported as a warning. */
  foreign: string[];
}

/** One pack folder in `development_behavior_packs` / `development_resource_packs`. */
export interface DevPackFolder {
  kind: DeployKind;
  folder: string;
  /** Manifest header uuid, lowercase. */
  uuid: string;
}

/** Every pack folder with a manifest header uuid in the dev pack folders of `comMojang`. */
export async function listDevPacks(comMojang: string): Promise<DevPackFolder[]> {
  const out: DevPackFolder[] = [];
  for (const kind of ["behavior", "resource"] as const) {
    const parent = join(comMojang, `development_${kind}_packs`);
    let names: string[];
    try {
      names = await readdir(parent);
    } catch {
      continue;
    }
    for (const folder of names.sort()) {
      try {
        const manifest: unknown = parseJsonc(await readFile(join(parent, folder, "manifest.json"), "utf8"), [], { allowTrailingComma: true });
        if (manifest && typeof manifest === "object" && "header" in manifest && manifest.header && typeof manifest.header === "object" && "uuid" in manifest.header) {
          const uuid = manifest.header.uuid;
          if (typeof uuid === "string") out.push({ kind, folder, uuid: uuid.toLowerCase() });
        }
      } catch {
        // not a pack
      }
    }
  }
  return out;
}

/**
 * Folder sculkwire deploys a pack under: `sculkwire_<project folder>_<pack folder>`. The project part keeps two
 * projects with the same `packs/BP` layout apart, and both parts come from paths, so repeated launches of one project
 * replace the same folder.
 */
export function deployFolderName(projectRoot: string, sourceDir: string): string {
  return `sculkwire_${`${basename(resolve(projectRoot))}_${basename(resolve(sourceDir))}`.replace(/[^\w.-]+/g, "_")}`;
}

/**
 * Plan the copies into `development_<kind>_packs`.
 *
 * A folder holding the pack's uuid is derived from this project when it is the project's `sculkwire_*` folder
 * (`deployFolderName`) or one of the folders the project's own Regolith profiles export to (`rglExports`). Any
 * other folder with the uuid is foreign: never changed, only listed in `foreign`.
 *
 * A pack with a built dir always deploys the fresh build, even with `deploy: false`, because the source dir of a
 * filtered profile is not loadable. When `rgl run` already exported the project into the dev folders, the build is
 * copied into that export folder instead of a second `sculkwire_*` folder: it is the same project built the same
 * way (`rgl run` would write the same files there), the user's own export keeps working after the game stops, and
 * removing it instead would delete a folder the user made and that sculkwire would then have to recreate. The
 * export folder is not `owned`, so stopping the game leaves it in place. Without an export the build goes to the
 * project's `sculkwire_*` folder. Every other project-derived folder with the uuid is listed in `remove`.
 *
 * A pack without a build goes to the project's rgl export when there is one. Otherwise, with `deploy` on, it always
 * goes to the project's `sculkwire_*` folder, copied again from the project on every launch and refresh, even when an
 * earlier launch or another sculkwire process left it behind, so a stale copy never stands in for the project. A
 * foreign folder with the uuid, another project's `sculkwire_*` copy included, is never reused as the project's
 * deployment while `deploy` is on: it stays in `foreign`. `refresh` (a redeploy before `/reload`) also copies the
 * project into its rgl export and into its `sculkwire_*` folder with `deploy: false`: every project-derived folder
 * gets the current packs. A foreign folder is never written. With `deploy: false` a pack without a build is only
 * deployed when an existing folder already serves its uuid, and then that folder is used as it is.
 */
export function planPackDeploy(opts: {
  /** Project root; names the folders sculkwire deploys to. */
  project: string;
  packs: readonly PackToDeploy[];
  /** The client's shared com.mojang dir. */
  comMojang: string;
  /** Copy packs that are not deployed yet. */
  deploy: boolean;
  /** Pack folders already in the dev pack folders. */
  deployed: readonly DevPackFolder[];
  /** Folders this project's Regolith profiles export to (`regolithExportFolders`). */
  rglExports?: RegolithExportFolders;
  /** Copy the project again into every folder derived from it (a redeploy before `/reload`). */
  refresh?: boolean;
}): PackDeploy[] {
  return opts.packs.map((pack): PackDeploy => {
    const base = { kind: pack.kind, uuid: pack.uuid, version: pack.version, ...(pack.name ? { name: pack.name } : {}) };
    const parent = join(opts.comMojang, `development_${pack.kind}_packs`);
    const at = (folder: string): string => join(parent, folder);
    const uuid = pack.uuid.toLowerCase();
    const same = opts.deployed.filter((d) => d.kind === pack.kind && d.uuid === uuid).map((d) => d.folder);
    const sculkFolder = deployFolderName(opts.project, pack.dir);
    const exports = opts.rglExports?.[pack.kind] ?? [];
    const derived = same.filter((f) => f === sculkFolder || exports.includes(f));
    const foreign = same.filter((f) => !derived.includes(f));
    const rglExport = derived.find((f) => exports.includes(f));
    const sculkCopy = derived.find((f) => f === sculkFolder);
    const plan = (folder: string, rest: { copyFrom?: string; built: boolean; owned: boolean }, others: string[]): PackDeploy => ({
      ...base,
      folder,
      path: at(folder),
      ...rest,
      remove: derived.filter((f) => f !== folder).map(at),
      foreign: others.map(at),
    });

    if (pack.built) {
      return rglExport
        ? plan(rglExport, { copyFrom: pack.built, built: true, owned: false }, foreign)
        : plan(sculkFolder, { copyFrom: pack.built, built: true, owned: true }, foreign);
    }
    if (rglExport) {
      return opts.refresh
        ? plan(rglExport, { copyFrom: pack.dir, built: false, owned: false }, foreign)
        : plan(rglExport, { built: false, owned: false }, foreign);
    }
    if (sculkCopy) {
      return opts.deploy || opts.refresh
        ? plan(sculkCopy, { copyFrom: pack.dir, built: false, owned: true }, foreign)
        : plan(sculkCopy, { built: false, owned: false }, foreign);
    }
    // With `deploy` on, the project's own copy always goes to its `sculkwire_*` folder, so every reload copies the
    // current files; a foreign folder with the uuid (including another project's `sculkwire_*` copy) is only reported.
    if (opts.deploy) return plan(sculkFolder, { copyFrom: pack.dir, built: false, owned: true }, foreign);
    const [existing, ...others] = foreign;
    if (existing) return plan(existing, { built: false, owned: false }, others);
    return { ...base, built: false, owned: false, remove: [], foreign: [] };
  });
}

/**
 * Removing a pack folder the game (or an indexer or antivirus) still holds open fails on Windows with EBUSY, EPERM
 * or ENOTEMPTY until the handle closes: `rm` retries those, waiting 100 ms longer each time (about 5.5 s in total).
 */
const RM_PACK = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;

/**
 * Carry out a plan: replace each copied folder (rm first, so files an earlier build left behind go), delete the
 * project's other copies of the uuid, and turn each foreign folder sharing it into a warning. Returns every copied
 * dir, the ones sculkwire owns (removed when the game stops), and the warnings.
 */
export async function applyPackDeploy(plan: readonly PackDeploy[]): Promise<{ copied: string[]; owned: string[]; diagnostics: Diagnostic[] }> {
  const out: { copied: string[]; owned: string[]; diagnostics: Diagnostic[] } = { copied: [], owned: [], diagnostics: [] };
  for (const entry of plan) {
    if (entry.copyFrom && entry.path) {
      await rm(entry.path, RM_PACK);
      await cp(entry.copyFrom, entry.path, { recursive: true, force: true });
      out.copied.push(entry.path);
    }
    if (entry.owned && entry.path) out.owned.push(entry.path);
    for (const dir of entry.remove) await rm(dir, RM_PACK);
    for (const dir of entry.foreign) {
      out.diagnostics.push({
        severity: "warning",
        code: "client.duplicate-pack-uuid",
        message:
          `development_${entry.kind}_packs/${basename(dir)} has the same header uuid ${entry.uuid} as this project's ` +
          `${entry.kind} pack, deployed to development_${entry.kind}_packs/${entry.folder ?? ""}, and the game may load ` +
          "that folder instead, so project edits may not show up. sculkwire leaves it alone because it is not this " +
          `project's copy${basename(dir).startsWith("sculkwire_") ? " (it is the sculkwire copy of another project folder, left by a session of that project)" : ""}: ` +
          "delete that folder or give one of the two packs another header uuid, then relaunch with game_launch so the game loads this project's folder.",
        source: "client",
        file: join(dir, "manifest.json"),
      });
    }
  }
  return out;
}

export interface ManifestHeader {
  uuid: string;
  version: string;
  name?: string;
}

/** Read `header.uuid` and `header.version` from a pack dir's manifest.json, with JSON comments allowed. */
export async function readManifestHeader(dir: string): Promise<ManifestHeader | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, "manifest.json"), "utf8");
  } catch {
    return undefined;
  }
  const manifest = parseJsonc(text, [], { allowTrailingComma: true }) as { header?: Record<string, unknown> } | undefined;
  const header = manifest?.header;
  if (!header || typeof header.uuid !== "string") return undefined;
  const raw = header.version;
  const version = Array.isArray(raw) ? raw.join(".") : typeof raw === "string" ? raw : undefined;
  if (!version) return undefined;
  return { uuid: header.uuid, version, ...(typeof header.name === "string" ? { name: header.name } : {}) };
}

/** Manifest names like `pack.name` are keys the game translates through the pack's `texts/<lang>.lang`. */
const LANG_KEY = /^[\w-]+(?:\.[\w-]+)+$/;

/** Value of `key` in a `.lang` file's text (`key=value`, `##` and tab-`#` comments stripped), if it is defined. */
export function langValue(text: string, key: string): string | undefined {
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const eq = raw.indexOf("=");
    if (eq <= 0 || raw.trimStart().startsWith("#") || raw.slice(0, eq).trim() !== key) continue;
    const value = raw.slice(eq + 1).replace(/\t#.*$/, "").replace(/##.*$/, "").trim();
    return value || undefined;
  }
  return undefined;
}

/**
 * Name to show for a pack. A manifest name that is a lang key (`pack.name`) is looked up in `texts/en_US.lang` of
 * each dir in order (the built dir first after a Regolith build, then the source dir). Falls back to the name itself.
 */
export async function packDisplayName(name: string, dirs: readonly (string | undefined)[]): Promise<string> {
  if (!LANG_KEY.test(name)) return name;
  for (const dir of dirs) {
    if (!dir) continue;
    let text: string;
    try {
      text = await readFile(join(dir, "texts", "en_US.lang"), "utf8");
    } catch {
      continue;
    }
    const value = langValue(text, name);
    if (value) return value;
  }
  return name;
}

export interface DeployedPack {
  name?: string;
  uuid: string;
  kind: string;
  /** Folder under `development_<kind>_packs`; absent when the pack is not deployed. */
  folder?: string;
  /** Absolute deployed pack dir; absent when the pack is not deployed. */
  path?: string;
  /** True when the deployed copy is the Regolith build output. */
  built: boolean;
}

/**
 * Put the project's packs into `development_*_packs`: build with rgl when the Regolith profile runs filters (the
 * built packs are what the game loads), then copy per `planPackDeploy` and `applyPackDeploy`, which leave one
 * folder of this project per uuid and warn about foreign folders sharing it. `refresh` (game_reload) copies the
 * project again into every folder derived from it. Throws with the rgl message when the build fails.
 */
export async function deployProject(
  install: ClientInstall,
  project: string,
  deploy: boolean,
  refresh: boolean,
): Promise<{ packs: DeployedPack[]; refs: PackRef[]; copied: string[]; owned: string[]; diagnostics: Diagnostic[] }> {
  const layout = await discoverProject(project);
  const comMojang = install.sharedComMojang;
  const deployed = await listDevPacks(comMojang);
  const rglExports = layout.regolith ? await regolithExportFolders(project) : undefined;
  const builtHeaders = new Map<string, { dir: string; uuid: string; version: string; name?: string }>();
  const result: { packs: DeployedPack[]; refs: PackRef[]; copied: string[]; owned: string[]; diagnostics: Diagnostic[] } = {
    packs: [],
    refs: [],
    copied: [],
    owned: [],
    diagnostics: [],
  };
  let regolithProfile: string | undefined;
  let workDir: string | undefined;
  try {
    if (layout.regolith) {
      const regolith = await regolithPlan(project);
      if (regolith?.hasFilters) {
        regolithProfile = regolith.profile;
        const build = await buildRegolith(project, regolith.profile);
        if (!("outputs" in build)) throw new Error(`the Regolith build failed, so nothing was deployed. ${build.message}`);
        workDir = build.workDir;
        if (!build.outputs.length) throw new Error(`rgl run ${regolith.profile} built no pack with a manifest, so nothing was deployed`);
        for (const o of build.outputs) {
          const header = await readManifestHeader(o.built);
          if (!header) throw new Error(`rgl built ${o.built} without a header uuid/version, so nothing was deployed`);
          builtHeaders.set(resolve(o.source), { dir: o.built, ...header });
        }
      }
    }
    const relDirs = new Map(layout.packs.map((p) => [resolve(p.dir), p.relDir || "."]));
    const packs: PackToDeploy[] = [];
    for (const pack of layout.packs) {
      if (pack.kind !== "behavior" && pack.kind !== "resource") continue;
      const fresh = builtHeaders.get(resolve(pack.dir));
      const uuid = fresh?.uuid ?? pack.uuid;
      const version = fresh?.version ?? pack.version;
      if (!uuid || !version) throw new Error(`${pack.relDir || "."}/manifest.json has no header uuid/version`);
      const manifestName = fresh?.name ?? pack.name;
      // The built dir goes away after this deploy, so the lang lookup happens now (built text first, then source).
      const name = manifestName ? await packDisplayName(manifestName, [fresh?.dir, pack.dir]) : undefined;
      packs.push({ kind: pack.kind, dir: resolve(pack.dir), uuid, version, ...(fresh ? { built: fresh.dir } : {}), ...(name ? { name } : {}) });
    }
    if (regolithProfile) {
      const unbuilt = packs.filter((p) => !p.built).map((p) => relDirs.get(p.dir) ?? p.dir);
      if (unbuilt.length) {
        throw new Error(`rgl run ${regolithProfile} did not build ${unbuilt.join(", ")}, so nothing was deployed (deploying the source packs would leave out the filter output)`);
      }
    }
    const plan = planPackDeploy({ project, packs, comMojang, deploy, deployed, refresh, ...(rglExports ? { rglExports } : {}) });
    const applied = await applyPackDeploy(plan);
    result.copied = applied.copied;
    result.owned = applied.owned;
    result.diagnostics = applied.diagnostics;
    for (const entry of plan) {
      result.packs.push({
        ...(entry.name ? { name: entry.name } : {}),
        uuid: entry.uuid,
        kind: entry.kind,
        ...(entry.folder ? { folder: entry.folder } : {}),
        ...(entry.path ? { path: entry.path } : {}),
        built: entry.built,
      });
      result.refs.push({ uuid: entry.uuid, version: entry.version.split(".").map(Number), kind: entry.kind });
    }
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
  return result;
}
