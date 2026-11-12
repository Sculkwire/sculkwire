/**
 * Lists and extracts packs of an installed GDK build. A pack directory holds loose files plus `__brarchive/<dir>.brarchive`
 * containers whose entries belong in `<dir>/`. Zero-size archive entries are placeholders for loose files (sounds,
 * lang, nbt, ...): loose files always win, non-empty entries fill the rest.
 */
import { constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { cacheDir } from "../core/paths.ts";
import { compareGameVersions, parseGameVersion } from "../core/version.ts";
import { BrarchiveError, parseBrarchive } from "./brarchive.ts";
import type { GameBuild } from "./detect.ts";

export type PackKind = "behavior" | "resource";
export const PACK_KINDS: readonly PackKind[] = ["behavior", "resource"];
/** The kind `extract` and `game_extract_pack` use when none is given. */
export const DEFAULT_PACK_KIND: PackKind = "behavior";

export interface PackInfo {
  kind: PackKind;
  name: string;
  dir: string;
  /** `vanilla_1.21.0` → `1.21.0`; undefined for unversioned packs (`vanilla`, `editor`, ...). */
  baseGameVersion?: string;
  /** Pack family: the name without its version suffix (`vanilla`, `chemistry`, `editor`, ...). */
  family: string;
  archives: number;
}

const VERSIONED = /^(.+?)_(\d+\.\d+(?:\.\d+)*)$/;

function countArchives(dir: string): number {
  const root = join(dir, "__brarchive");
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".brarchive")) n++;
  }
  return n;
}

export function listPacks(build: GameBuild): PackInfo[] {
  const out: PackInfo[] = [];
  for (const kind of PACK_KINDS) {
    const root = build.packRoots[kind];
    if (!root) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const m = VERSIONED.exec(entry.name);
      const info: PackInfo = { kind, name: entry.name, dir, family: m ? m[1]! : entry.name, archives: countArchives(dir) };
      if (m) info.baseGameVersion = m[2]!;
      out.push(info);
    }
  }
  return out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.family !== b.family) return a.family.localeCompare(b.family);
    const va = a.baseGameVersion ? parseGameVersion(a.baseGameVersion) : undefined;
    const vb = b.baseGameVersion ? parseGameVersion(b.baseGameVersion) : undefined;
    if (!va || !vb) return va ? 1 : vb ? -1 : a.name.localeCompare(b.name);
    return compareGameVersions(va, vb);
  });
}

/** Versioned `vanilla_X.Y[.Z]` packs: the per-version base-game packs a world's base_game_version pins. */
export function listVanillaPacks(build: GameBuild): PackInfo[] {
  return listPacks(build).filter((p) => p.family === "vanilla" && p.baseGameVersion !== undefined);
}

export interface ArchiveFailure {
  /** Archive path relative to the pack directory. */
  archive: string;
  reason: string;
  detail: string;
}

export interface ExtractResult {
  kind: PackKind;
  pack: string;
  out: string;
  looseFiles: number;
  archives: number;
  archiveEntries: number;
  /** Zero-size archive entries resolved by a loose file of the same path. */
  placeholders: number;
  /** Zero-size entries with no loose file: written as empty files. */
  emptyEntries: number;
  failures: ArchiveFailure[];
  cached: boolean;
}

export function defaultExtractDir(build: GameBuild, kind: PackKind, pack: string): string {
  return cacheDir("gamefiles", build.key, "packs", kind, pack);
}

const MARKER = ".sculkwire-extract.json";

function walkFiles(dir: string, skip: (rel: string) => boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (!skip(rel)) files.push(rel);
  }
  return files.sort();
}

export function findPack(build: GameBuild, pack: string, kind?: PackKind): PackInfo | undefined {
  const matches = listPacks(build).filter((p) => p.name === pack && (!kind || p.kind === kind));
  return matches[0];
}

/**
 * Extracts one pack into `out` (default: `cacheDir('gamefiles', <build key>, 'packs', <kind>, <pack>)`). A previous
 * complete extraction of the same build is reused unless `force`.
 */
export async function extractPack(
  build: GameBuild,
  info: PackInfo,
  options: { out?: string; force?: boolean } = {},
): Promise<ExtractResult> {
  const out = options.out ?? defaultExtractDir(build, info.kind, info.name);
  const markerPath = join(out, MARKER);
  if (!options.force && existsSync(markerPath)) {
    try {
      // Our own marker, written below: { ...ExtractResult, buildKey, source }.
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as ExtractResult & { buildKey?: string; source?: string };
      const { buildKey, source, ...prev } = marker;
      if (buildKey === build.key && source === info.dir) return { ...prev, out, cached: true };
    } catch {
      // Corrupt marker: re-extract.
    }
  }
  // Only replace a directory we created: a previous extraction (marker) or an empty/missing one.
  if (existsSync(out) && !existsSync(markerPath) && readdirSync(out).length > 0) {
    throw new Error(`refusing to overwrite non-empty directory without ${MARKER}: ${out}`);
  }
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const loose = walkFiles(info.dir, (rel) => rel === "__brarchive" || rel.startsWith("__brarchive/"));
  const looseSet = new Set(loose);
  const made = new Set<string>();
  const ensureDir = async (file: string): Promise<void> => {
    const d = dirname(file);
    if (made.has(d)) return;
    await mkdir(d, { recursive: true });
    made.add(d);
  };
  for (const rel of loose) {
    const dest = join(out, rel);
    await ensureDir(dest);
    await copyFile(join(info.dir, rel), dest, constants.COPYFILE_FICLONE);
  }

  const result: ExtractResult = {
    kind: info.kind,
    pack: info.name,
    out,
    looseFiles: loose.length,
    archives: 0,
    archiveEntries: 0,
    placeholders: 0,
    emptyEntries: 0,
    failures: [],
    cached: false,
  };
  const archiveRoot = join(info.dir, "__brarchive");
  const archives = existsSync(archiveRoot) ? walkFiles(archiveRoot, (rel) => !rel.endsWith(".brarchive")) : [];
  for (const rel of archives) {
    result.archives++;
    const archiveRel = `__brarchive/${rel}`;
    let entries;
    try {
      entries = parseBrarchive(await readFile(join(archiveRoot, rel)));
    } catch (err) {
      if (!(err instanceof BrarchiveError)) throw err;
      result.failures.push({ archive: archiveRel, reason: err.reason, detail: err.message });
      continue;
    }
    const targetDir = rel.slice(0, -".brarchive".length);
    for (const entry of entries) {
      const relPath = `${targetDir}/${entry.name}`;
      result.archiveEntries++;
      if (looseSet.has(relPath)) {
        if (entry.data.length === 0) result.placeholders++;
        continue;
      }
      if (entry.data.length === 0) result.emptyEntries++;
      const dest = join(out, relPath);
      await ensureDir(dest);
      await writeFile(dest, entry.data);
    }
  }
  await writeFile(markerPath, `${JSON.stringify({ ...result, buildKey: build.key, source: info.dir }, null, 2)}\n`);
  return result;
}
