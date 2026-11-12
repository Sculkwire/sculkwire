/**
 * How an agent call fails: a value, not an exception. RPC error codes become `{ ok: false, code, reason, anchor? }` so
 * CLI exit codes and MCP results stay mechanical.
 */
import { z } from "zod";

export type EngineFailureReason =
  | "anchor_missing"
  | "not_in_world"
  | "wrong_thread"
  | "timeout"
  | "command_failed"
  | "path_not_writable"
  | "scripting_unavailable"
  | "unknown_method"
  | "invalid_params"
  | "not_attached"
  | "disconnected"
  | "protocol"
  | "rpc_error";

export interface EngineFailure {
  ok: false;
  /** JSON-RPC error code from the agent, -32602 for input this client rejected, -32000 for transport failures. */
  code: number;
  reason: EngineFailureReason;
  anchor?: string;
  message: string;
}

export type EngineResult<T> = { ok: true; value: T } | EngineFailure;

/** Reasons that mean the caller has to fix the setup, so the CLI exits 2 rather than 1. */
const SETUP_REASONS: ReadonlySet<EngineFailureReason> = new Set(["not_attached", "disconnected", "invalid_params"]);

export function isSetupFailure(failure: EngineFailure): boolean {
  return SETUP_REASONS.has(failure.reason);
}

export const RPC_REASONS: Readonly<Record<number, EngineFailureReason>> = {
  [-32601]: "unknown_method",
  [-32602]: "invalid_params",
  [-32001]: "anchor_missing",
  [-32002]: "not_in_world",
  [-32003]: "wrong_thread",
  [-32004]: "timeout",
  [-32006]: "command_failed",
  [-32007]: "path_not_writable",
  [-32014]: "scripting_unavailable",
};

/** Input this client rejects before anything is sent, in the shape the agent's own -32602 answers use. */
export function invalid(message: string): EngineFailure {
  return { ok: false, code: -32602, reason: "invalid_params", message };
}

/** The agent answered with a shape this client does not know, so the value cannot be trusted. */
export function malformed(method: string, value: unknown): EngineFailure {
  return { ok: false, code: -32000, reason: "protocol", message: `${method} answered ${JSON.stringify(value)}` };
}

/** The failure fields every engine tool's output schema starts with. */
export const failureSchema = {
  ok: z.boolean(),
  code: z.number().optional(),
  reason: z.string().optional(),
  anchor: z.string().optional(),
  message: z.string().optional(),
};
