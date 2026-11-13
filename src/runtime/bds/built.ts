/**
 * Regolith-built packs on BDS: the server loads what rgl last built (the folders `.regolith/tmp/BP` and `RP` lead
 * to), but a Diagnostic should name the file the user edits. `indexBuiltPack` indexes the built pack (paths and text
 * as the server sees them) and attaches `toSource`, which maps a built file and a range in its text back to the project:
 * 1. a source map next to or inside a built file (`//# sourceMappingURL=`) leads to the original, e.g. the
 *    TypeScript under `data/scripts`;
 * 2. a file that also exists in the source pack is reported there; its range is kept when the texts are equal, or
 *    moved to the one source line with the same text when a filter changed the file;
 * 3. a file only the build has (bundled JS without a source map) points at rgl's output, and the message says so,
 *    because no project file can be computed.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { SourceMap, type SourceMapPayload } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Position, Range } from "../../core/diagnostic.ts";
import type { PackInfo } from "../../core/project.ts";
import { indexPack, projectPath, type IndexedPack, type SourceLocation } from "../gamelog/logparse.ts";

const SOURCE_MAP_URL = /\/\/[#@] sourceMappingURL=(\S+)\s*$/;

/** Source map of a built script: inline `data:` URL or a file relative to the script. */
async function loadSourceMap(builtFile: string, text: string): Promise<SourceMap | undefined> {
  const lines = text.trimEnd().split("\n");
  const m = SOURCE_MAP_URL.exec(lines.at(-1) ?? "");
  if (!m) return undefined;
  const url = m[1]!;
  try {
    let json: string;
    if (url.startsWith("data:")) {
      const comma = url.indexOf(",");
      const body = url.slice(comma + 1);
      json = url.slice(0, comma).endsWith(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
    } else {
      json = await readFile(resolve(dirname(builtFile), decodeURIComponent(url)), "utf8");
    }
    const payload = JSON.parse(json) as SourceMapPayload;
    return Array.isArray(payload.sources) && typeof payload.mappings === "string" ? new SourceMap(payload) : undefined;
  } catch {
    return undefined;
  }
}

/** `path` relative to `dir` when it lies inside it, else undefined. */
function inside(dir: string, path: string): string | undefined {
  const rel = relative(dir, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : undefined;
}

/**
 * Project-relative POSIX path of a source map `sources` entry. rgl runs the filters in `<project>/.regolith/tmp`,
 * where the pack is `BP` or `RP` and the project's data folder (`regolith.dataPath`) is `data`, so a relative entry
 * is resolved from where the filter saw the built file, then from the built file itself. A path below
 * `.regolith/tmp` maps to the source pack (`BP/...`), the data folder (`data/...`) or the project folder of the same
 * name; any other path inside the project is taken as it is. Failing that, the longest trailing part of the path
 * that names a project file wins (`../../../data/scripts/main.ts` → `data/scripts/main.ts`).
 */
function projectFileOf(entry: string, at: { projectRoot: string; dataDir: string; source: PackInfo; tmpName: string; tmpFile: string; builtFile: string }): string | undefined {
  let raw = entry;
  if (entry.startsWith("file://")) {
    try {
      raw = fileURLToPath(entry);
    } catch {
      raw = entry.slice("file://".length);
    }
  }
  const cleaned = raw.replace(/^(?:webpack|rolldown|vite):\/{0,3}/, "").replace(/\\/g, "/");
  const tmpRoot = join(at.projectRoot, ".regolith", "tmp");
  const candidates = isAbsolute(cleaned) ? [cleaned] : [resolve(dirname(at.tmpFile), cleaned), resolve(dirname(at.builtFile), cleaned)];
  for (const path of candidates) {
    const inTmp = inside(tmpRoot, path);
    if (inTmp !== undefined) {
      const [head, ...rest] = inTmp.split("/");
      if (head === at.tmpName && rest.length && existsSync(join(at.source.dir, ...rest))) return projectPath(at.source, rest.join("/"));
      const inData = head === "data" && rest.length ? inside(at.projectRoot, join(at.dataDir, ...rest)) : undefined;
      if (inData !== undefined && existsSync(join(at.projectRoot, inData))) return inData;
      if (existsSync(join(at.projectRoot, inTmp))) return inTmp;
      continue;
    }
    const inProject = inside(at.projectRoot, path);
    if (inProject !== undefined && existsSync(path)) return inProject;
  }
  const parts = cleaned.split("/").filter((p) => p && p !== "." && p !== "..");
  for (let i = 0; i < parts.length; i++) {
    const rel = parts.slice(i).join("/");
    if (existsSync(join(at.projectRoot, rel))) return rel;
  }
  return undefined;
}

function origin(map: SourceMap, at: Position): { fileName: string; position: Position } | undefined {
  const o = map.findOrigin(at.line, at.column);
  return "fileName" in o ? { fileName: o.fileName, position: { line: o.lineNumber, column: o.columnNumber } } : undefined;
}

/** The single source line whose trimmed text equals the built line, with the column shifted by the indent change. */
function sameLine(builtText: string, sourceText: string, range: Range): Range | undefined {
  const builtLine = builtText.split("\n")[range.start.line - 1];
  const needle = builtLine?.trim();
  if (!builtLine || !needle) return undefined;
  const lines = sourceText.split("\n");
  const hits = lines.flatMap((l, i) => (l.trim() === needle ? [i] : []));
  if (hits.length !== 1) return undefined;
  const line = hits[0]! + 1;
  const shift = lines[hits[0]!]!.indexOf(needle) - builtLine.indexOf(needle);
  const height = range.end.line - range.start.line;
  return { start: { line, column: Math.max(1, range.start.column + shift) }, end: { line: line + height, column: Math.max(1, range.end.column + shift) } };
}

/**
 * Index a built pack (`built.dir` is rgl's output, `built.relDir` the source pack's) and attach `toSource`.
 * `projectRoot` is the project rgl built, whose `.regolith/tmp` the filters ran in, and `dataDir` its data folder.
 */
export async function indexBuiltPack(built: PackInfo, source: PackInfo, projectRoot: string, dataDir: string, folder?: string): Promise<IndexedPack> {
  const indexed = await indexPack(built, folder);
  const src = await indexPack(source);
  const sourceFiles = new Set(src.files);
  const tmpName = built.kind === "resource" ? "RP" : "BP";
  const maps = new Map<string, SourceMap>();
  for (const [rel, text] of indexed.texts) {
    if (!/\.(js|mjs)$/i.test(rel)) continue;
    const map = await loadSourceMap(join(built.dir, rel), text);
    if (map) maps.set(rel, map);
  }
  indexed.toSource = (rel: string, range?: Range): SourceLocation => {
    const map = range ? maps.get(rel) : undefined;
    if (map && range) {
      const start = origin(map, range.start);
      const at = { projectRoot, dataDir, source, tmpName, tmpFile: join(projectRoot, ".regolith", "tmp", tmpName, rel), builtFile: join(built.dir, rel) };
      const file = start ? projectFileOf(start.fileName, at) : undefined;
      if (start && file) {
        const end = origin(map, range.end);
        return { file, range: { start: start.position, end: end && end.fileName === start.fileName ? end.position : start.position } };
      }
    }
    if (sourceFiles.has(rel)) {
      const file = projectPath(source, rel);
      if (!range) return { file };
      const builtText = indexed.texts.get(rel);
      const sourceText = src.texts.get(rel);
      if (builtText === undefined || sourceText === undefined) return { file };
      if (builtText === sourceText) return { file, range };
      const moved = sameLine(builtText, sourceText, range);
      return moved ? { file, range: moved } : { file };
    }
    const out: SourceLocation = {
      file: join(built.dir, rel),
      note: `${rel} is rgl output with no source map back to a project file, so the location is in rgl's output`,
    };
    if (range) out.range = range;
    return out;
  };
  return indexed;
}
