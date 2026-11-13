/**
 * Where a project's packs go in the client's `development_*_packs` folders. A plain project deploys its source
 * dirs. A Regolith project whose profile runs filters deploys what rgl last built (`regolithOutput`), because the
 * source dirs hold the filter inputs (TypeScript, JSON sources) and not what the game loads: sculkwire never runs
 * rgl. The planning is pure so the bridge and its tests share one rule set.
 *
 * One uuid, one folder: the game picks any one of several dev packs that share a header uuid, so a stale copy can
 * win over the fresh one. sculkwire's own copy of a pack is therefore one `sculkwire_*` folder, replaced on every
 * deploy and deleted when another folder serves the pack. A folder sculkwire did not make is never written or
 * deleted, a folder rgl exported to included; when it shares the uuid without serving the pack, the plan lists it
 * for a warning.
 */
import { cp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import type { Diagnostic } from "../../core/diagnostic.ts";
import { sameFiles } from "../../core/fs.ts";
import { discoverProject } from "../../core/project.ts";
import { regolithExportFolders, regolithOutput, regolithPlan, RGL_NOT_BUILT, type RegolithExportFolders } from "../../core/regolith.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import type { PackRef } from "./world.ts";

/** Pack kinds a world can activate. */
export type DeployKind = "behavior" | "resource";

/** One project pack. */
export interface PackToDeploy {
  kind: DeployKind;
  /** Absolute source pack dir (the one holding the project's manifest.json). */
  dir: string;
  /** Manifest header uuid actually deployed (the built manifest when `built` is set). */
  uuid: string;
  /** Manifest header version actually deployed. */
  version: string;
  /**
   * rgl's output dir for the pack (`regolithOutput`), set when the Regolith profile runs filters: what the game
   * loads, in place of the source dir.
   */
  built?: string;
  /**
   * The folder under `development_<kind>_packs` rgl exported the pack to, when that is in this client's dev packs:
   * the folder `built` is, or with `rgl --compat` the one holding the same files. Used as it is and never written.
   */
  exported?: string;
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
  /** Dir to copy (rgl's output, else the source dir); absent when an existing folder is used as it is. */
  copyFrom?: string;
  /** True when `path` holds what rgl built, not a copy of the sources. */
  built: boolean;
  /** True when `path` is a `sculkwire_*` copy that sculkwire removes when the game stops. */
  owned: boolean;
  /** The project's stale `sculkwire_*` copy of the pack, when another folder serves it now: delete. */
  remove: string[];
  /** Absolute dirs sculkwire leaves alone that share the uuid: reported as a warning. */
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
 * sculkwire writes and deletes one folder per pack only: the project's own `sculkwire_*` folder
 * (`deployFolderName`). Every other folder holding the pack's uuid is left as it is, and listed in `foreign` unless
 * it is the one that serves the pack.
 *
 * A folder rgl exported the project to serves the pack as it is: it is the user's folder, rgl is what updates it,
 * and sculkwire never writes or deletes it, on a launch or on a `refresh`. For a pack with a `built` dir that is
 * `exported`; for a Regolith project without filters it is a folder named by the project's profiles
 * (`rglExports`). The project's `sculkwire_*` copy of the pack is then listed in `remove`.
 *
 * A pack with a `built` dir that rgl did not export into these dev packs (a `local` or `exact` export, another
 * client's com.mojang) is copied from it into the project's `sculkwire_*` folder on every launch and refresh, also
 * with `deploy: false`, because its source dir is not loadable.
 *
 * Any other pack, with `deploy` on, always goes to the project's `sculkwire_*` folder, copied again from the
 * project on every launch and refresh, even when an earlier launch or another sculkwire process left it behind, so
 * a stale copy never stands in for the project. Another folder with the uuid, another project's `sculkwire_*` copy
 * included, is never reused as the project's deployment while `deploy` is on: it stays in `foreign`. `refresh` (a
 * redeploy before `/reload`) also copies the project into its `sculkwire_*` folder with `deploy: false`. With
 * `deploy: false` such a pack is only deployed when an existing folder already serves its uuid, and then that folder
 * is used as it is.
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
  /** Copy the project again into its `sculkwire_*` folder (a redeploy before `/reload`). */
  refresh?: boolean;
}): PackDeploy[] {
  return opts.packs.map((pack): PackDeploy => {
    const base = { kind: pack.kind, uuid: pack.uuid, version: pack.version, ...(pack.name ? { name: pack.name } : {}) };
    const parent = join(opts.comMojang, `development_${pack.kind}_packs`);
    const at = (folder: string): string => join(parent, folder);
    const uuid = pack.uuid.toLowerCase();
    const same = opts.deployed.filter((d) => d.kind === pack.kind && d.uuid === uuid).map((d) => d.folder);
    const sculkFolder = deployFolderName(opts.project, pack.dir);
    const hasSculkCopy = same.includes(sculkFolder);
    // The folder rgl exported the pack to: the built dir itself, else (no filters) one the project's profiles name.
    const rglFolder = pack.exported ?? (pack.built ? undefined : (opts.rglExports?.[pack.kind] ?? []).find((f) => same.includes(f)));
    const plan = (folder: string, rest: { copyFrom?: string; owned: boolean }): PackDeploy => ({
      ...base,
      folder,
      path: at(folder),
      ...rest,
      built: pack.built !== undefined,
      remove: hasSculkCopy && folder !== sculkFolder ? [at(sculkFolder)] : [],
      foreign: same.filter((f) => f !== folder && f !== sculkFolder).map(at),
    });

    if (rglFolder) return plan(rglFolder, { owned: false });
    if (pack.built) return plan(sculkFolder, { copyFrom: pack.built, owned: true });
    if (hasSculkCopy) return opts.deploy || opts.refresh ? plan(sculkFolder, { copyFrom: pack.dir, owned: true }) : plan(sculkFolder, { owned: false });
    // With `deploy` on, the project's own copy always goes to its `sculkwire_*` folder, so every reload copies the
    // current files; another folder with the uuid (including another project's `sculkwire_*` copy) is only reported.
    if (opts.deploy) return plan(sculkFolder, { copyFrom: pack.dir, owned: true });
    const existing = same[0];
    if (existing) return plan(existing, { owned: false });
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
          "that folder instead, so project edits may not show up. sculkwire leaves it alone because it did not put it " +
          `there for this project${basename(dir).startsWith("sculkwire_") ? " (it is the sculkwire copy of another project folder, left by a session of that project)" : ""}: ` +
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
 * each dir in order (the rgl export first when it serves the pack, then the source dir). Falls back to the name itself.
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
  /** True when the folder holds what rgl built (the Regolith profile runs filters), not a copy of the sources. */
  built: boolean;
}

/**
 * Put the project's packs into `development_*_packs` per `planPackDeploy` and `applyPackDeploy`, which keep
 * sculkwire's copy of a pack to one `sculkwire_*` folder and warn about other folders sharing the uuid. `refresh`
 * (game_reload) copies the project again into its `sculkwire_*` folders.
 *
 * sculkwire never runs rgl. When the Regolith profile runs filters, the packs are what rgl last built
 * (`regolithOutput`): used in place when rgl exported them into this client's dev packs, copied otherwise. Throws
 * with the step to take, before anything is changed, when rgl has not built the project. A folder rgl exported a
 * profile without filters to is used as rgl left it, with a warning when its files differ from the source pack.
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
  const regolith = layout.regolith ? await regolithPlan(project) : undefined;
  const sources = layout.packs.filter((p) => p.kind === "behavior" || p.kind === "resource");
  const packs: PackToDeploy[] = [];
  if (regolith?.hasFilters) {
    const why = `the Regolith profile "${regolith.profile}" runs filters, so the game loads what rgl builds and not the source packs`;
    const output = await regolithOutput(project);
    if (!output) throw new Error(`${why}. ${RGL_NOT_BUILT}, so nothing was deployed`);
    // Only the packs config.json names are rgl's to build; any other pack below the project is no part of the game's.
    const configured = [layout.regolith?.behaviorPack, layout.regolith?.resourcePack].filter((d) => d !== undefined).map((d) => resolve(d));
    const unbuilt = sources
      .filter((p) => configured.includes(resolve(p.dir)) && !output.outputs.some((o) => resolve(o.source) === resolve(p.dir)))
      .map((p) => p.relDir || ".");
    if (unbuilt.length) {
      throw new Error(`${why}. rgl's last build in .regolith/tmp has no pack for ${unbuilt.join(", ")}, so nothing was deployed: run \`rgl run\` first. sculkwire does not run rgl`);
    }
    for (const o of output.outputs) {
      // rgl's manifest, not the source one, is what the game reads: a filter may write or change it.
      const built = (await discoverProject(o.built)).packs[0];
      if ((built?.kind !== "behavior" && built?.kind !== "resource") || !built.uuid || !built.version) {
        throw new Error(`rgl built ${o.built} without a behavior or resource pack manifest (header uuid and version, modules), so nothing was deployed`);
      }
      const devDir = join(comMojang, `development_${built.kind}_packs`);
      const devPacks = await realpath(devDir).catch(() => undefined);
      let exported = devPacks !== undefined && dirname(o.built) === devPacks ? basename(o.built) : undefined;
      if (!exported) {
        // `rgl run --compat` builds in a real folder and then copies it to the export folder, so the dev pack with
        // the uuid that holds the same files is that export. A `sculkwire_*` folder is a sculkwire copy (this
        // project's or another's, removed when its game stops), never an export.
        for (const d of deployed) {
          if (d.kind !== built.kind || d.uuid !== built.uuid.toLowerCase() || d.folder.startsWith("sculkwire_")) continue;
          if (await sameFiles(o.built, join(devDir, d.folder))) {
            exported = d.folder;
            break;
          }
        }
      }
      const name = built.name ? await packDisplayName(built.name, [o.built, o.source]) : undefined;
      packs.push({
        kind: built.kind,
        dir: resolve(o.source),
        uuid: built.uuid,
        version: built.version,
        built: o.built,
        ...(exported ? { exported } : {}),
        ...(name ? { name } : {}),
      });
    }
  } else {
    for (const pack of sources) {
      if ((pack.kind !== "behavior" && pack.kind !== "resource") || !pack.uuid || !pack.version) throw new Error(`${pack.relDir || "."}/manifest.json has no header uuid/version`);
      const name = pack.name ? await packDisplayName(pack.name, [pack.dir]) : undefined;
      packs.push({ kind: pack.kind, dir: resolve(pack.dir), uuid: pack.uuid, version: pack.version, ...(name ? { name } : {}) });
    }
  }
  const plan = planPackDeploy({ project, packs, comMojang, deploy, deployed, refresh, ...(rglExports ? { rglExports } : {}) });
  const applied = await applyPackDeploy(plan);
  const result: { packs: DeployedPack[]; refs: PackRef[]; copied: string[]; owned: string[]; diagnostics: Diagnostic[] } = {
    packs: [],
    refs: [],
    copied: applied.copied,
    owned: applied.owned,
    diagnostics: applied.diagnostics,
  };
  if (layout.regolith && !regolith?.hasFilters) {
    // Without filters rgl's export is a copy of the source pack, so a difference means the export is out of date.
    for (const [i, entry] of plan.entries()) {
      const source = sources[i];
      if (!source || !entry.path || !entry.folder || entry.copyFrom || !rglExports?.[entry.kind].includes(entry.folder)) continue;
      if (await sameFiles(source.dir, entry.path)) continue;
      result.diagnostics.push({
        severity: "warning",
        code: "client.rgl-export-differs",
        message:
          `development_${entry.kind}_packs/${entry.folder} is the folder rgl exported ${source.relDir || "."} to, and the game loads it ` +
          `as rgl left it, but its files differ from ${source.relDir || "."}: run \`rgl run\` (or keep \`rgl watch\` running) so the ` +
          "game gets the current packs. sculkwire never writes a folder rgl exported to.",
        source: "client",
        file: layout.regolith.configPath,
      });
    }
  }
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
  return result;
}
