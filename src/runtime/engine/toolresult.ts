/** How the engine's MCP tools answer a failure; success uses `ok` from `core/mcp.ts`. */
import type { ToolResult } from "../../core/mcp.ts";
import { errorMessage } from "../../core/errors.ts";
import { invalid, type EngineFailure } from "./failure.ts";

export function failureResult(failure: EngineFailure): ToolResult {
  const anchor = failure.anchor ? ` anchor ${failure.anchor}` : "";
  const text = `${failure.reason} (${failure.code})${anchor}: ${failure.message}`;
  return { content: [{ type: "text", text }], structuredContent: { ...failure }, isError: true };
}

/** Arguments a tool can see are wrong before anything is sent, in the shape the engine's own -32602 answers use. */
export function invalidParamsResult(message: string): ToolResult {
  return failureResult(invalid(message));
}

/** A thrown error carries no RPC code: it is always a prerequisite the caller can fix (attach, file routes). */
export function prerequisiteResult(err: unknown): ToolResult {
  const text = errorMessage(err);
  return { content: [{ type: "text", text }], structuredContent: { ok: false, reason: "prerequisite", message: text }, isError: true };
}
