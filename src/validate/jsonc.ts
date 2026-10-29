/**
 * Bedrock-flavoured JSON with source positions.
 *
 * The game reads add-on JSON with a JsonCpp-style reader: `//` and `/* *\/` comments are fine. What strict
 * JSON rejects but the game tolerates (trailing commas, a BOM, duplicate keys, content after the root value)
 * is a warning; anything the game cannot read is an error and the file does not load.
 */
import { createScanner, type Node, type ParseError, parseTree, printParseErrorCode } from "jsonc-parser";
import type { Position, Range, Severity } from "../core/diagnostic.ts";

export type { Node as JsonNode } from "jsonc-parser";

/** Offset -> 1-based line/column (UTF-16 columns, like editors and tsc). */
export class LineIndex {
  readonly text: string;
  readonly starts: number[];
  constructor(text: string) {
    this.text = text;
    const starts = [0];
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
    this.starts = starts;
  }

  position(offset: number): Position {
    const o = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] as number) <= o) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: o - (this.starts[lo] as number) + 1 };
  }

  range(offset: number, length: number): Range {
    return { start: this.position(offset), end: this.position(offset + Math.max(0, length)) };
  }

  /** Range covering a whole 1-based line, without its line break. */
  lineRange(line: number): Range {
    const start = this.starts[line - 1] ?? this.text.length;
    let end = this.starts[line] ?? this.text.length;
    if (end > start && this.text[end - 1] === "\n") end--;
    if (end > start && this.text[end - 1] === "\r") end--;
    return this.range(start, end - start);
  }

  get lineCount(): number {
    return this.starts.length;
  }
}

export interface JsonProblem {
  severity: Severity;
  code: string;
  message: string;
  range: Range;
  pointer?: string;
}

export interface JsonDocument {
  text: string;
  lines: LineIndex;
  root: Node | undefined;
  /** Parsed value; `undefined` when the game could not load the file (any error-level problem). */
  value: unknown;
  /** Value as far as it could be recovered, even with errors. */
  recovered: unknown;
  problems: JsonProblem[];
  ok: boolean;
}

/** RFC 6901 escaping of one segment. */
export function escapePointerSegment(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

export function pointerJoin(base: string, segment: string | number): string {
  return `${base}/${escapePointerSegment(segment)}`;
}

export function pointerFromPath(path: readonly (string | number)[]): string {
  return path.map((p) => `/${escapePointerSegment(p)}`).join("");
}

export function parsePointer(pointer: string): string[] {
  if (pointer === "" || pointer === "/") return pointer === "/" ? [""] : [];
  return pointer
    .replace(/^\//, "")
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

const MESSAGES: Record<string, string> = {
  InvalidSymbol: "unexpected character; expected a JSON value",
  InvalidNumberFormat: "invalid number",
  PropertyNameExpected: "expected a double-quoted property name",
  ValueExpected: "expected a value",
  ColonExpected: "expected ':' after the property name",
  CommaExpected: "expected ',' between values (missing comma?)",
  CloseBraceExpected: "expected '}' to close the object",
  CloseBracketExpected: "expected ']' to close the array",
  EndOfFileExpected: "content after the root value is ignored by the game",
  InvalidCommentToken: "invalid comment",
  UnexpectedEndOfComment: "unterminated /* comment",
  UnexpectedEndOfString: "unterminated string (strings cannot span lines)",
  UnexpectedEndOfNumber: "unexpected end of number",
  InvalidUnicode: "invalid \\u escape",
  InvalidEscapeCharacter: "invalid escape sequence",
  InvalidCharacter: "invalid character in string",
};

function nodeValue(node: Node | undefined): unknown {
  if (!node) return undefined;
  switch (node.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const prop of node.children ?? []) {
        const [k, v] = prop.children ?? [];
        if (k && typeof k.value === "string") out[k.value] = v ? nodeValue(v) : undefined;
      }
      return out;
    }
    case "array":
      return (node.children ?? []).map(nodeValue);
    default:
      return node.value;
  }
}

function collectDuplicates(node: Node | undefined, pointer: string, lines: LineIndex, out: JsonProblem[]): void {
  if (!node) return;
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const prop of node.children ?? []) {
      const [k, v] = prop.children ?? [];
      if (!k || typeof k.value !== "string") continue;
      const child = pointerJoin(pointer, k.value);
      if (seen.has(k.value)) {
        out.push({
          severity: "warning",
          code: "json.duplicate-key",
          message: `duplicate key "${k.value}"; the game keeps only the last value`,
          range: lines.range(k.offset, k.length),
          pointer: child,
        });
      }
      seen.add(k.value);
      collectDuplicates(v, child, lines, out);
    }
  } else if (node.type === "array") {
    (node.children ?? []).forEach((c, i) => collectDuplicates(c, pointerJoin(pointer, i), lines, out));
  }
}

function trailingCommas(text: string, lines: LineIndex, out: JsonProblem[]): void {
  const scanner = createScanner(text, true);
  let lastComma = -1;
  for (let kind = scanner.scan(); kind !== 17; kind = scanner.scan()) {
    if (kind === 5) {
      lastComma = scanner.getTokenOffset();
      continue;
    }
    if ((kind === 2 || kind === 4) && lastComma >= 0) {
      out.push({
        severity: "warning",
        code: "json.trailing-comma",
        message: `trailing comma before '${kind === 2 ? "}" : "]"}'`,
        range: lines.range(lastComma, 1),
      });
    }
    lastComma = -1;
  }
}

/** Parse Bedrock JSON, keeping node offsets for pointer -> range lookups. */
export function parseJson(input: string): JsonDocument {
  const problems: JsonProblem[] = [];
  let text = input;
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = ` ${text.slice(1)}`; // keep offsets stable: the BOM becomes one column of whitespace
  const lines = new LineIndex(text);
  if (bom) {
    problems.push({
      severity: "warning",
      code: "json.bom",
      message: "UTF-8 byte order mark at the start of the file; save without BOM",
      range: lines.range(0, 1),
    });
  }
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false });
  let fatal = false;
  let lastLine = 0;
  let reported = 0;
  const rootEnd = root ? root.offset + root.length : -1;
  const closer = root?.type === "object" ? "}" : root?.type === "array" ? "]" : undefined;
  const rootClosed = root !== undefined && (closer === undefined || text[rootEnd - 1] === closer);
  let trailingReported = false;
  for (const e of errors) {
    const name = printParseErrorCode(e.error);
    // Anything after a complete root value is ignored by the game (JsonCpp stops reading there).
    const afterRoot = rootClosed && e.offset >= rootEnd && name !== "CloseBraceExpected" && name !== "CloseBracketExpected";
    if (name === "EndOfFileExpected" || (afterRoot && !fatal)) {
      if (!trailingReported) {
        problems.push({
          severity: "warning",
          code: "json.trailing-content",
          message: MESSAGES.EndOfFileExpected as string,
          range: lines.range(e.offset, Math.max(1, e.length)),
        });
      }
      trailingReported = true;
      continue;
    }
    fatal = true;
    // The parser recovers and continues; keep one error per line (follow-on errors are noise), at most 5.
    const range = lines.range(e.offset, Math.max(1, e.length));
    if (range.start.line === lastLine || reported >= 5) continue;
    lastLine = range.start.line;
    reported++;
    const hint = text[e.offset] === "'" ? "JSON strings and keys use double quotes" : undefined;
    problems.push({
      severity: "error",
      code: "json.syntax",
      message: `${MESSAGES[name] ?? name}${hint ? ` (${hint})` : ""}`,
      range,
    });
  }
  if (!root && !fatal) {
    fatal = true;
    problems.push({ severity: "error", code: "json.syntax", message: "empty document", range: lines.range(0, 0) });
  }
  if (!fatal) {
    trailingCommas(text, lines, problems);
    collectDuplicates(root, "", lines, problems);
  }
  const recovered = nodeValue(root);
  problems.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.column - b.range.start.column);
  return { text, lines, root, value: fatal ? undefined : recovered, recovered, problems, ok: !fatal };
}

/** The node at a JSON pointer (value node), or the deepest existing ancestor when `nearest` is set. */
export function nodeAtPointer(root: Node | undefined, pointer: string, nearest = false): Node | undefined {
  let node = root;
  for (const seg of parsePointer(pointer)) {
    if (!node) return undefined;
    let next: Node | undefined;
    if (node.type === "object") {
      // Last duplicate wins, like the game.
      for (const prop of node.children ?? []) {
        const [k, v] = prop.children ?? [];
        if (k?.value === seg) next = v;
      }
    } else if (node.type === "array" && /^\d+$/.test(seg)) {
      next = node.children?.[Number(seg)];
    }
    if (!next) return nearest ? node : undefined;
    node = next;
  }
  return node;
}

/** The property key node for the last pointer segment (when it names an object member). */
export function keyNodeAtPointer(root: Node | undefined, pointer: string): Node | undefined {
  const value = nodeAtPointer(root, pointer);
  const prop = value?.parent;
  return prop?.type === "property" ? prop.children?.[0] : undefined;
}

/**
 * Source range of a JSON pointer: the value (or its key when `key` is set). Falls back to the deepest
 * existing ancestor, then the whole document, so a range is always available for a parsed file.
 */
export function rangeAtPointer(doc: Pick<JsonDocument, "root" | "lines">, pointer: string, key = false): Range {
  if (key) {
    const k = keyNodeAtPointer(doc.root, pointer);
    if (k) return doc.lines.range(k.offset, k.length);
  }
  const node = nodeAtPointer(doc.root, pointer, true);
  if (!node) return doc.lines.range(0, 0);
  // Objects and arrays: highlight the opening line only, not the whole block.
  if (node.type === "object" || node.type === "array") {
    const prop = node.parent?.type === "property" ? node.parent.children?.[0] : undefined;
    if (prop && !key) return doc.lines.range(prop.offset, prop.length);
    return doc.lines.range(node.offset, 1);
  }
  return doc.lines.range(node.offset, node.length);
}
