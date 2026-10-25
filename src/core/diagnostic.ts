/**
 * The one diagnostic shape every producer emits: validator rules, tsc, BDS and client content logs,
 * the script debugger and GameTest. Agents consume it as JSON; the CLI maps it to exit codes.
 */

export type Severity = "error" | "warning" | "info";

/** 1-based line and column, matching editors and `tsc --pretty false`. */
export interface Position {
  line: number;
  column: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export type DiagnosticSource =
  | "json"
  | "schema"
  | "manifest"
  | "reference"
  | "mcfunction"
  | "typescript"
  | "lang"
  | "bds"
  | "client"
  | "debugger"
  | "gametest";

export interface RelatedLocation {
  file: string;
  range?: Range;
  message: string;
}

export interface Diagnostic {
  severity: Severity;
  /** Stable rule id, e.g. `json.syntax`, `schema.required`, `reference.texture-missing`, `ts.2322`, `content-log.entity`. */
  code: string;
  message: string;
  source: DiagnosticSource;
  /** Path relative to the validated project root, POSIX separators. Absent only when the game gave no location. */
  file?: string;
  range?: Range;
  /** RFC 6901 pointer into a JSON document, when the issue is inside one. */
  pointer?: string;
  /** Short actionable fix. */
  hint?: string;
  related?: RelatedLocation[];
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

export function atLeast(severity: Severity, threshold: Severity): boolean {
  return RANK[severity] >= RANK[threshold];
}

/** Process exit codes shared by every CLI command. */
export const ExitCode = {
  ok: 0,
  /** Diagnostics at or above the fail-on threshold, or a failed GameTest. */
  findings: 1,
  /** Bad arguments, missing prerequisites, or an internal error. */
  usage: 2,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export function exitCodeFor(diagnostics: readonly Diagnostic[], failOn: Severity = "error"): ExitCode {
  return diagnostics.some((d) => atLeast(d.severity, failOn)) ? ExitCode.findings : ExitCode.ok;
}

export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    (a.file ?? "").localeCompare(b.file ?? "") ||
    (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0) ||
    (a.range?.start.column ?? 0) - (b.range?.start.column ?? 0) ||
    RANK[b.severity] - RANK[a.severity] ||
    a.code.localeCompare(b.code)
  );
}

export interface DiagnosticSummary {
  errors: number;
  warnings: number;
  infos: number;
}

export function summarize(diagnostics: readonly Diagnostic[]): DiagnosticSummary {
  const s: DiagnosticSummary = { errors: 0, warnings: 0, infos: 0 };
  for (const d of diagnostics) {
    if (d.severity === "error") s.errors++;
    else if (d.severity === "warning") s.warnings++;
    else s.infos++;
  }
  return s;
}

/** `file:line:col: severity code: message`, the format editors and CI annotate from. */
export function formatDiagnostic(d: Diagnostic): string {
  const loc = d.file ? `${d.file}${d.range ? `:${d.range.start.line}:${d.range.start.column}` : ""}` : "<game>";
  return `${loc}: ${d.severity} ${d.code}: ${d.message}${d.hint ? ` (hint: ${d.hint})` : ""}`;
}
