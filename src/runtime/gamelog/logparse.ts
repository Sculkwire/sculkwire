/**
 * BDS console + content log parsing, and mapping of game messages back to pack files (pack-relative paths,
 * `Function <name>`, script frames, identifiers, pack name/uuid,
 * category follow-up), plus baseline subtraction of what a pack-less server prints anyway.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import type { Diagnostic, DiagnosticSource, Range, Severity } from "../../core/diagnostic.ts";
import type { PackInfo } from "../../core/project.ts";
import { parseLocations } from "./frames.ts";

export interface LogEntry {
  severity: Severity;
  /** Content-log area, e.g. `Scripting`, `Recipes`, `Commands`. */
  category?: string;
  message: string;
  origin: "console" | "content-log";
}

/** `[2026-11-07 17:05:35:898 ERROR] [Scripting] message` */
const CONSOLE_RE = /^\[(\d{4}-\d\d-\d\d [\d:]+) (ERROR|WARN|INFO|DEBUG|VERBOSE)\] ?(.*)$/;
/** `17:05:36[Recipes][error]-message` */
const CONTENT_LOG_RE = /^[\d:]+\[([^\]]+)\]\[(error|warning|warn|inform\w*|info|verbose)\]-?(.*)$/i;
const CATEGORY_RE = /^\[([^\]]+)\]\s*(.*)$/s;

/** Lines that are never findings (connection chatter, telemetry); shared with the client's debugger prints. */
export const NOISE =
  /telemetry|NO LOG FILE|Network port occupied|IPv6|Opening level|Content logging to|Debugger auto-attach|Debugger attached|Debugger detached|Received unhandled ScriptDebuggerPacket|signaling service/i;

/** BDS logs these as warnings, but the function (and everything calling it) never runs. */
const FATAL_WARNINGS =
  /failed to load correctly|command failed to parse|Function .* not found|listed in tick\.json|^\[?Commands\]? ?Error on line/i;

function severityOf(level: string): Severity {
  const l = level.toLowerCase();
  if (l === "error") return "error";
  if (l === "warn" || l === "warning") return "warning";
  return "info";
}

function finish(entries: LogEntry[], keepInfo: boolean): LogEntry[] {
  const out: LogEntry[] = [];
  for (const e of entries) {
    e.message = e.message.replace(/\s+/g, " ").trim();
    if (!e.message || e.message.startsWith("===") || NOISE.test(e.message)) continue;
    if (!keepInfo && e.severity === "info") continue;
    out.push(e);
  }
  return out;
}

function withCategory(origin: LogEntry["origin"], severity: Severity, text: string): LogEntry {
  const m = CATEGORY_RE.exec(text);
  return m?.[1] && !/^\d/.test(m[1])
    ? { severity, category: m[1], message: m[2] ?? "", origin }
    : { severity, message: text, origin };
}

/**
 * Console lines → entries. Lines directly following an entry (stack traces, wrapped messages) are folded into
 * it; a blank line or an unprefixed line after a blank ends it. INFO entries are dropped unless `keepInfo`.
 */
export function parseConsole(lines: readonly string[], keepInfo = false): LogEntry[] {
  const entries: LogEntry[] = [];
  let open: LogEntry | undefined;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const m = CONSOLE_RE.exec(line);
    if (m) {
      open = withCategory("console", severityOf(m[2]!), m[3] ?? "");
      entries.push(open);
      continue;
    }
    if (!line.trim()) {
      open = undefined;
      continue;
    }
    if (open) open.message += `\n${line}`;
  }
  return finish(entries, keepInfo);
}

/** Content log file text → entries (same folding rules as the console). */
export function parseContentLog(text: string, keepInfo = false): LogEntry[] {
  const entries: LogEntry[] = [];
  let open: LogEntry | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const m = CONTENT_LOG_RE.exec(raw);
    if (m) {
      open = { severity: severityOf(m[2]!.startsWith("inform") ? "info" : m[2]!), category: m[1]!, message: m[3] ?? "", origin: "content-log" };
      entries.push(open);
      continue;
    }
    if (!raw.trim()) {
      open = undefined;
      continue;
    }
    if (open) open.message += `\n${raw}`;
  }
  return finish(entries, keepInfo);
}

/** Digits → `#`, whitespace collapsed: stable across runs (ports, times, ids). */
export function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().replace(/\d+/g, "#");
}

export function entryKey(e: Pick<LogEntry, "category" | "message">): string {
  return normalizeMessage(`${e.category ?? ""}|${e.message}`);
}

/** Merge console and content-log entries, dropping duplicates (the console mirrors the content log). */
export function mergeEntries(...lists: LogEntry[][]): LogEntry[] {
  const seen = new Set<string>();
  const out: LogEntry[] = [];
  for (const list of lists) {
    for (const e of list) {
      const key = entryKey(e);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

export interface IndexedPack {
  pack: PackInfo;
  /** Folder of the pack inside the BDS world (`0_BP`), when loaded there. */
  folder?: string;
  /** Pack-relative POSIX paths. */
  files: string[];
  /** `description.identifier` → pack-relative file. */
  identifiers: Map<string, string>;
  /** Text of small text files, for locating needles. */
  texts: Map<string, string>;
  /**
   * Set when `pack.dir` is a Regolith build: maps a pack file and a range in the built text to the file the user
   * edits (see `indexBuiltPack`). Without it a pack file is reported as `projectPath(pack, rel)`.
   */
  toSource?: (rel: string, range?: Range) => SourceLocation;
}

/** Where a finding goes in a Diagnostic; `note` is appended to the message (e.g. why it points at build output). */
export interface SourceLocation {
  file: string;
  range?: Range;
  note?: string;
}

/** File (and range) a Diagnostic reports for a pack file and a range in the text the server loaded. */
export function sourceLocation(pack: IndexedPack, rel: string, range?: Range): SourceLocation {
  if (pack.toSource) return pack.toSource(rel, range);
  return range ? { file: projectPath(pack.pack, rel), range } : { file: projectPath(pack.pack, rel) };
}

const TEXT_EXT = /\.(json|mcfunction|js|mjs|lang|material|txt)$/i;
const MAX_TEXT = 1_000_000;

async function walkFiles(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(p, root, out);
    else out.push(relative(root, p).split(sep).join("/"));
  }
}

export async function indexPack(pack: PackInfo, folder?: string): Promise<IndexedPack> {
  const files: string[] = [];
  await walkFiles(pack.dir, pack.dir, files);
  const identifiers = new Map<string, string>();
  const texts = new Map<string, string>();
  for (const rel of files) {
    if (!TEXT_EXT.test(rel)) continue;
    let text: string;
    try {
      text = await readFile(join(pack.dir, rel), "utf8");
    } catch {
      continue;
    }
    if (text.length > MAX_TEXT) continue;
    texts.set(rel, text);
    if (!rel.endsWith(".json")) continue;
    const data: unknown = parseJsonc(text, [], { allowTrailingComma: true });
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    for (const v of Object.values(data)) {
      if (!v || typeof v !== "object" || !("description" in v)) continue;
      const desc = v.description;
      if (desc && typeof desc === "object" && "identifier" in desc && typeof desc.identifier === "string") {
        if (!identifiers.has(desc.identifier)) identifiers.set(desc.identifier, rel);
      }
    }
  }
  const out: IndexedPack = { pack, files, identifiers, texts };
  if (folder) out.folder = folder;
  return out;
}

export interface Location {
  pack: IndexedPack;
  rel: string;
  range?: Range;
}

/** 1-based position of the first occurrence of `needle` in `text`. */
export function locate(text: string, needle: string): Range | undefined {
  const at = text.indexOf(needle);
  if (at < 0) return undefined;
  const before = text.slice(0, at);
  const line = before.split("\n").length;
  const column = at - before.lastIndexOf("\n");
  const endLines = needle.split("\n");
  const endLine = line + endLines.length - 1;
  const endColumn = endLines.length > 1 ? endLines.at(-1)!.length + 1 : column + needle.length;
  return { start: { line, column }, end: { line: endLine, column: endColumn } };
}

function lineRange(line: number, column = 1): Range {
  return { start: { line, column }, end: { line, column } };
}

const ID_RE = /\b[a-z0-9_.-]+:[a-z0-9_./-]+[a-z0-9_]\b/gi;
const QUOTED_RE = /['"`]([^'"`\n]{3,120})['"`]/g;

/** Range of the most specific needle from `message` found in the file. */
function rangeInFile(loc: Location, message: string): Range | undefined {
  const fnLine = /\bError on line (\d+)/i.exec(message);
  if (fnLine && loc.rel.endsWith(".mcfunction")) return lineRange(Number(fnLine[1]));
  const text = loc.pack.texts.get(loc.rel);
  if (!text) return undefined;
  const needles = new Set<string>();
  for (const m of message.matchAll(ID_RE)) needles.add(m[0]);
  for (const m of message.matchAll(QUOTED_RE)) needles.add(m[1]!);
  let best: Range | undefined;
  let bestLen = 0;
  for (const n of needles) {
    if (n.length <= bestLen || n === loc.rel) continue;
    const r = locate(text, `"${n}"`) ?? locate(text, n);
    if (r) {
      best = r;
      bestLen = n.length;
    }
  }
  return best;
}

/** Pack named in the message as `[Pack Name]`, `Plugin [Pack Name - 1.0.0]`, or by uuid. */
function namedPack(message: string, packs: readonly IndexedPack[]): IndexedPack | undefined {
  return packs.find(
    (p) => (p.pack.name && (message.includes(`[${p.pack.name}]`) || message.includes(`[${p.pack.name} -`))) || (p.pack.uuid && message.includes(p.pack.uuid)),
  );
}

interface PackLookup {
  files: Set<string>;
  /** Pack-relative paths of at least 5 characters, with their lowercase form. */
  lowerFiles: [rel: string, lower: string][];
  identifiers: [matcher: RegExp, rel: string][];
}

const lookups = new WeakMap<IndexedPack, PackLookup>();

/** The pack's lookup tables for `mapMessage`, built once per indexed pack. */
function lookupOf(p: IndexedPack): PackLookup {
  let l = lookups.get(p);
  if (!l) {
    l = {
      files: new Set(p.files),
      lowerFiles: p.files.filter((rel) => rel.length >= 5).map((rel) => [rel, rel.toLowerCase()]),
      identifiers: [...p.identifiers].map(([ident, rel]) => [new RegExp(`(?<![\\w:.])${ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.])`), rel]),
    };
    lookups.set(p, l);
  }
  return l;
}

const BP_CATEGORIES = /^(Scripting|Commands|Recipes|Entity|Item|Block|Loot|Spawning|Feature|Biome|Trading|Molang|Json|Function|GameTest)/i;

/** Resolve a message to a pack file (and range when one can be located). */
export function mapMessage(message: string, packs: readonly IndexedPack[], category?: string): Location | undefined {
  const named = namedPack(message, packs);
  const low = message.toLowerCase();

  // World paths: worlds/<level>/behavior_packs/<folder>/<rel>
  for (const m of message.matchAll(/(?:behavior|resource)_packs\/([^/\s]+)\/([^\s|,;:'")\]]+)/g)) {
    const p = packs.find((x) => x.folder === m[1]);
    if (p && lookupOf(p).files.has(m[2]!)) return { pack: p, rel: m[2]! };
  }

  // Script frames: (main.js:7) relative to scripts/.
  for (const frame of parseLocations(message)) {
    const candidates = [frame.file, `scripts/${frame.file.replace(/^\.?\//, "")}`];
    const order = named ? [named, ...packs.filter((p) => p !== named)] : packs;
    for (const p of order) {
      const files = lookupOf(p).files;
      const rel = candidates.find((c) => files.has(c));
      if (rel) return { pack: p, rel, range: lineRange(frame.line, frame.column ?? 1) };
    }
  }

  // Longest pack-relative path mentioned.
  let best: Location | undefined;
  for (const p of packs) {
    for (const [rel, lower] of lookupOf(p).lowerFiles) {
      if (!low.includes(lower)) continue;
      const better =
        !best ||
        rel.length > best.rel.length ||
        (rel.length === best.rel.length && (p === named || (best.pack !== named && p.pack.kind === "behavior" && BP_CATEGORIES.test(category ?? ""))));
      if (better) best = { pack: p, rel };
    }
  }
  if (best) return best;

  for (const m of message.matchAll(/\bFunction\s+'?([\w./-]+)'?/g)) {
    const rel = `functions/${m[1]!.replace(/\.mcfunction$/, "")}.mcfunction`;
    const p = packs.find((x) => lookupOf(x).files.has(rel));
    if (p) return { pack: p, rel };
  }

  for (const p of named ? [named, ...packs.filter((x) => x !== named)] : packs) {
    for (const [re, rel] of lookupOf(p).identifiers) {
      if (re.test(message)) return { pack: p, rel };
    }
  }

  if (named && lookupOf(named).files.has("manifest.json")) return { pack: named, rel: "manifest.json" };
  return undefined;
}

export interface ToDiagnosticsOptions {
  /** Normalized entry keys (`entryKey`) a pack-less server prints too: dropped. */
  baseline?: ReadonlySet<string>;
  source?: DiagnosticSource;
  /** Prefix for messages, e.g. `BDS 1.26.63.1`. */
  label?: string;
}

/** Project-relative path of a pack file. */
export function projectPath(pack: PackInfo, rel: string): string {
  return pack.relDir ? `${pack.relDir}/${rel}` : rel;
}

function codeFor(e: LogEntry, isScript: boolean): string {
  if (isScript) return e.severity === "error" ? "script.error" : "script.warning";
  if (e.category) return `content-log.${e.category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return `bds.${e.severity}`;
}

const RAN_WITH_ERROR = /^Plugin \[.*?\] - \[.*?\] ran with error: /;

/** Map log entries to Diagnostics: baseline subtraction, fatal-warning upgrade, file + range mapping. */
export function entriesToDiagnostics(entries: readonly LogEntry[], packs: readonly IndexedPack[], opts: ToDiagnosticsOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  let prev: { category?: string; loc?: Location } = {};
  for (const e of entries) {
    if (e.severity === "info") continue;
    if (opts.baseline?.has(entryKey(e))) continue;
    let loc = mapMessage(e.message, packs, e.category);
    if (!loc && e.category && e.category === prev.category) loc = prev.loc;
    prev = { loc };
    if (e.category) prev.category = e.category;
    if (loc && !loc.range) {
      const range = rangeInFile(loc, e.message);
      if (range) loc = { ...loc, range };
    }
    const isScript = e.category === "Scripting" && parseLocations(e.message).length > 0;
    const severity: Severity = e.severity === "warning" && FATAL_WARNINGS.test(`${e.category ? `[${e.category}] ` : ""}${e.message}`) ? "error" : e.severity;
    const d: Diagnostic = {
      severity,
      code: codeFor({ ...e, severity }, isScript),
      message: `${opts.label ? `${opts.label}: ` : ""}${e.category ? `[${e.category}] ` : ""}${e.message}`,
      source: opts.source ?? "bds",
    };
    if (loc) {
      const where = sourceLocation(loc.pack, loc.rel, loc.range);
      d.file = where.file;
      if (where.range) d.range = where.range;
      if (where.note) d.message += ` (${where.note})`;
    }
    // The plugin summary line repeats the error already reported at the same place.
    if (RAN_WITH_ERROR.test(e.message) && out.some((o) => o.file === d.file && o.range?.start.line === d.range?.start.line && o.code === d.code)) continue;
    out.push(d);
  }
  return out;
}
