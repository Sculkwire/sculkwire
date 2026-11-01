import type { Diagnostic, Severity } from "../../core/diagnostic.ts";
import type { PrintLevel } from "./protocol.ts";

export interface SourceLocation {
  /** Path as the game reported it (relative to the pack's `scripts/` folder, or with a `scripts/` prefix). */
  file: string;
  line: number;
  column?: number;
}

/** `(main.js:7)`, `at fn (lib/util.js:12:5)`, `at lib/util.js:3`: the frames Minecraft prints for script code. */
const FRAME_RE = /(?:\(|\bat\s+)([\w\-./\\ @]+?\.(?:js|mjs|cjs|ts)):(\d+)(?::(\d+))?\)?/g;

/** Every script location in a print or log message, in order of appearance (first = throw site). */
export function parseLocations(message: string): SourceLocation[] {
  const out: SourceLocation[] = [];
  for (const m of message.matchAll(FRAME_RE)) {
    const loc: SourceLocation = { file: m[1]!.trim().replaceAll("\\", "/"), line: Number(m[2]) };
    if (m[3] !== undefined) loc.column = Number(m[3]);
    out.push(loc);
  }
  return out;
}

export interface PrintEvent {
  /** Monotonic sequence number within a session. */
  seq: number;
  time: number;
  level: PrintLevel;
  message: string;
  /** First script frame of the message, when it has one. */
  location?: SourceLocation;
}

/** Errors in script output: error/warn prints, plus log prints that carry an uncaught-exception banner. */
const JS_ERROR_RE = /\b(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|InternalError|Unhandled promise rejection)\b/;

/**
 * Map a script print to a Diagnostic (source `debugger`). `resolveFile` turns a game script path into a
 * project-relative file; without a match the diagnostic keeps the game path. Returns undefined for plain logs.
 */
export function printToDiagnostic(
  print: Pick<PrintEvent, "level" | "message" | "location">,
  resolveFile?: (gamePath: string) => string | undefined,
): Diagnostic | undefined {
  let severity: Severity;
  if (print.level === "error" || print.level === "stop") severity = "error";
  else if (print.level === "warn") severity = JS_ERROR_RE.test(print.message) ? "error" : "warning";
  else if (JS_ERROR_RE.test(print.message) && print.location) severity = "error";
  else return undefined;
  const message = print.message.trim();
  const d: Diagnostic = {
    severity,
    code: severity === "error" ? "script.error" : "script.warning",
    message,
    source: "debugger",
  };
  if (print.location) {
    d.file = resolveFile?.(print.location.file) ?? print.location.file;
    const column = print.location.column ?? 1;
    d.range = { start: { line: print.location.line, column }, end: { line: print.location.line, column } };
  }
  return d;
}
