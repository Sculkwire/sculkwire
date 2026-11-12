/** What MCP tools return: the result shape, its two builders, and the schemas of the shared result fields. */
import { z } from "zod";
import { formatDiagnostic, type Diagnostic } from "./diagnostic.ts";
import { errorMessage } from "./errors.ts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export function ok(text: string, structured: object): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: { ...structured } };
}

export function fail(err: unknown): ToolResult {
  return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
}

/** The first `max` diagnostics, one per line, and how many more there are. */
export function diagText(diagnostics: readonly Diagnostic[], max = 20): string {
  const lines = diagnostics.slice(0, max).map(formatDiagnostic);
  if (diagnostics.length > max) lines.push(`… ${diagnostics.length - max} more`);
  return lines.join("\n");
}

const position = z.object({ line: z.number(), column: z.number() });
export const diagnosticSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: z.string(),
  source: z.string(),
  file: z.string().optional(),
  range: z.object({ start: position, end: position }).optional(),
  pointer: z.string().optional(),
  hint: z.string().optional(),
});
export const summarySchema = z.object({ errors: z.number(), warnings: z.number(), infos: z.number() });
