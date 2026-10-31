/** Output formats for validation results: JSON (the result as-is), text (`formatDiagnostic`), SARIF 2.1.0. */
import { pathToFileURL } from "node:url";
import { type Diagnostic, formatDiagnostic } from "../core/diagnostic.ts";
import { VERSION } from "../core/meta.ts";
import type { ValidationResult } from "./index.ts";

export type OutputFormat = "json" | "text" | "sarif";

export function formatText(r: ValidationResult): string {
  const lines = r.diagnostics.map(formatDiagnostic);
  if (r.rockide?.note) lines.push(`note: rockide/schemas ${r.rockide.note}`);
  const s = r.summary;
  lines.push(
    `${r.filesChecked} files in ${r.packs.length} pack(s), target ${r.target.channel}${r.target.version ? ` ${r.target.version}` : ""}: ` +
      `${s.errors} error(s), ${s.warnings} warning(s), ${s.infos} info`,
  );
  return `${lines.join("\n")}\n`;
}

const LEVEL: Record<Diagnostic["severity"], "error" | "warning" | "note"> = { error: "error", warning: "warning", info: "note" };

export function toSarif(r: ValidationResult): object {
  const rules = [...new Set(r.diagnostics.map((d) => d.code))].sort().map((id) => ({ id, name: id }));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "sculkwire", version: VERSION, rules } },
        originalUriBaseIds: { PROJECTROOT: { uri: pathToFileURL(`${r.root}/`).href } },
        results: r.diagnostics.map((d) => {
          const result: Record<string, unknown> = {
            ruleId: d.code,
            level: LEVEL[d.severity],
            message: { text: d.hint ? `${d.message} (hint: ${d.hint})` : d.message },
          };
          if (d.file) {
            const physicalLocation: Record<string, unknown> = { artifactLocation: { uri: encodeURI(d.file), uriBaseId: "PROJECTROOT" } };
            if (d.range) {
              physicalLocation.region = {
                startLine: d.range.start.line,
                startColumn: d.range.start.column,
                endLine: d.range.end.line,
                endColumn: d.range.end.column,
              };
            }
            result.locations = [{ physicalLocation }];
          }
          if (d.pointer !== undefined) result.properties = { pointer: d.pointer, source: d.source };
          else result.properties = { source: d.source };
          return result;
        }),
      },
    ],
  };
}

export function render(r: ValidationResult, format: OutputFormat): string {
  if (format === "text") return formatText(r);
  return `${JSON.stringify(format === "sarif" ? toSarif(r) : r, null, 2)}\n`;
}
