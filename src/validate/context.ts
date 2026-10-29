/**
 * Shared state of one validation run: the packs, their file lists, parsed documents (each file is read and
 * parsed once) and the diagnostic sink that turns pack-relative locations into project-relative ones.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Diagnostic, Range } from "../core/diagnostic.ts";
import type { PackInfo, PackKind } from "../core/project.ts";
import { classifyFile, type FileKind } from "./classify.ts";
import { type JsonDocument, LineIndex, parseJson, rangeAtPointer } from "./jsonc.ts";

const SKIP_DIRS: Record<string, true> = { ".git": true, node_modules: true, ".regolith": true, __pycache__: true };

export interface Pack {
  kind: PackKind;
  /** Absolute directory the files are read from (for Regolith builds: the build output). */
  dir: string;
  /** Pack-relative paths, POSIX, sorted. */
  files: string[];
  fileSet: Set<string>;
  info: PackInfo;
  /** Project-relative directory diagnostics are reported under (POSIX, "" for the root). */
  displayDir: string;
  /** Absolute source directory when `dir` is a build output (Regolith); files absent there are generated. */
  sourceDir?: string;
  /** manifest.json parsed, when it is a JSON object. */
  manifest?: Record<string, unknown>;
}

export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".DS_Store") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS[e.name]) await walk(join(abs, e.name), r);
      } else if (e.isFile() || e.isSymbolicLink()) {
        out.push(r);
      }
    }
  }
  await walk(dir, "");
  return out.sort();
}

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export async function loadPack(
  info: PackInfo,
  root: string,
  opts: { dir?: string; displayDir?: string; sourceDir?: string } = {},
): Promise<Pack> {
  const dir = opts.dir ?? info.dir;
  const files = await listFiles(dir);
  const pack: Pack = {
    kind: info.kind,
    dir,
    files,
    fileSet: new Set(files),
    info,
    displayDir: opts.displayDir ?? toPosix(relative(root, info.dir)),
  };
  if (opts.sourceDir) pack.sourceDir = opts.sourceDir;
  return pack;
}

export interface FileRef {
  pack: Pack;
  rel: string;
}

export class Context {
  readonly root: string;
  readonly packs: Pack[];
  readonly diagnostics: Diagnostic[] = [];
  /** In-memory contents that override disk (validate_file with unsaved content). Keyed by absolute path. */
  readonly overlay: Map<string, string>;
  private readonly texts = new Map<string, string | null>();
  private readonly docs = new Map<string, JsonDocument | null>();
  private readonly seen = new Set<string>();
  /** Note appended to diagnostics in Regolith build output, keyed by display path ("" = same as source). */
  private readonly buildNotes = new Map<string, string>();

  constructor(root: string, packs: Pack[], overlay: Map<string, string> = new Map()) {
    this.root = root;
    this.packs = packs;
    this.overlay = overlay;
  }

  abs(pack: Pack, rel: string): string {
    return join(pack.dir, ...rel.split("/"));
  }

  /** Project-relative display path of a pack file. */
  label(pack: Pack, rel: string): string {
    return pack.displayDir ? `${pack.displayDir}/${rel}` : rel;
  }

  kind(pack: Pack, rel: string): FileKind {
    return classifyFile(pack.kind, rel);
  }

  /** File text (BOM kept), or undefined when unreadable. */
  async text(pack: Pack, rel: string): Promise<string | undefined> {
    const abs = this.abs(pack, rel);
    const over = this.overlay.get(abs);
    if (over !== undefined) return over;
    if (!this.texts.has(abs)) {
      let t: string | null = null;
      try {
        const buf = await readFile(abs);
        t = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      } catch {
        t = null;
      }
      this.texts.set(abs, t);
    }
    return this.texts.get(abs) ?? undefined;
  }

  /** Parsed JSON document (cached). Syntax problems are reported by the json check, not here. */
  async json(pack: Pack, rel: string): Promise<JsonDocument | undefined> {
    const abs = this.abs(pack, rel);
    if (!this.docs.has(abs)) {
      const t = await this.text(pack, rel);
      this.docs.set(abs, t === undefined ? null : parseJson(t));
    }
    return this.docs.get(abs) ?? undefined;
  }

  /** Parsed value of a JSON file the game can load, else undefined. */
  async value(pack: Pack, rel: string): Promise<unknown> {
    return (await this.json(pack, rel))?.value;
  }

  /** Range of a JSON pointer in a pack file (whole-document fallback). */
  async range(pack: Pack, rel: string, pointer: string, key = false): Promise<Range | undefined> {
    const doc = await this.json(pack, rel);
    return doc ? rangeAtPointer(doc, pointer, key) : undefined;
  }

  /** Range of a 1-based line in a text file. */
  async lineRange(pack: Pack, rel: string, line: number): Promise<Range | undefined> {
    const t = await this.text(pack, rel);
    return t === undefined ? undefined : new LineIndex(t).lineRange(line);
  }

  /**
   * Report a diagnostic located in a pack file. For Regolith build output the path is the source path; when
   * the file was generated or changed by filters the message says so (positions then refer to the build).
   */
  async add(pack: Pack, rel: string, d: Omit<Diagnostic, "file">): Promise<void> {
    const out: Diagnostic = { ...d, file: this.label(pack, rel) };
    if (pack.sourceDir) {
      const note = await this.buildNote(pack, rel);
      if (note) out.message = `${out.message} ${note}`;
    }
    this.push(out);
  }

  /** Report at a JSON pointer, computing the range. */
  async at(
    pack: Pack,
    rel: string,
    pointer: string,
    d: Omit<Diagnostic, "file" | "range" | "pointer">,
    key = false,
  ): Promise<void> {
    const range = await this.range(pack, rel, pointer, key);
    const full: Omit<Diagnostic, "file"> = { ...d, pointer };
    if (range) full.range = range;
    await this.add(pack, rel, full);
  }

  push(d: Diagnostic): void {
    const k = `${d.file}|${d.range?.start.line}:${d.range?.start.column}|${d.code}|${d.message}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.diagnostics.push(d);
  }

  private async buildNote(pack: Pack, rel: string): Promise<string | undefined> {
    const key = this.label(pack, rel);
    let note = this.buildNotes.get(key);
    if (note === undefined) {
      let src: string | undefined;
      try {
        src = await readFile(join(pack.sourceDir as string, ...rel.split("/")), "utf8");
      } catch {
        src = undefined;
      }
      if (src === undefined) note = "[generated by Regolith filters; position refers to the build output]";
      else if (src !== (await this.text(pack, rel))) note = "[changed by Regolith filters; position refers to the build output]";
      else note = "";
      this.buildNotes.set(key, note);
    }
    return note || undefined;
  }
}
