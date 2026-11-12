/**
 * The `/connect` (Automation WebSocket) protocol: the game dials our WebSocket server and exchanges
 * `{header, body}` JSON messages. Requests carry a `requestId`; the game echoes it in the response header.
 */
import { randomUUID } from "node:crypto";

export interface Header {
  version: number;
  requestId: string;
  /** `commandRequest`, `commandResponse`, `data:<kind>`, `error`, `event`, … */
  messagePurpose: string;
  messageType?: string;
}

export interface Message<B = unknown> {
  header: Header;
  body: B;
}

export type DataKind = "block" | "item" | "mob";

/** The game rejects requests beyond this many unanswered commands ("Too many commands have been requested"). */
export const MAX_IN_FLIGHT = 100;

function newRequestId(): string {
  return randomUUID();
}

/**
 * Command parser version for `commandRequest`. 1 is the legacy parser, which rejects current syntax such as
 * `execute … run`; 42 parses commands the way the chat box does.
 */
export const COMMAND_VERSION = 42;

export function commandRequest(commandLine: string, requestId = newRequestId()): Message<{ version: number; commandLine: string; origin: { type: string } }> {
  return {
    header: { version: 1, requestId, messagePurpose: "commandRequest", messageType: "commandRequest" },
    body: { version: COMMAND_VERSION, commandLine: commandLine.replace(/^\//, ""), origin: { type: "player" } },
  };
}

export function dataRequest(kind: DataKind, requestId = newRequestId()): Message<Record<string, never>> {
  return { header: { version: 1, requestId, messagePurpose: `data:${kind}`, messageType: "commandRequest" }, body: {} };
}

/** Parse one frame from the game; returns undefined for anything that is not a `{header, body}` object. */
export function parseMessage(data: string): Message | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || !("header" in value)) return undefined;
  const h = value.header;
  if (!h || typeof h !== "object" || !("messagePurpose" in h) || typeof h.messagePurpose !== "string") return undefined;
  const header: Header = {
    version: "version" in h ? Number(h.version) || 1 : 1,
    requestId: "requestId" in h && typeof h.requestId === "string" ? h.requestId : "",
    messagePurpose: h.messagePurpose,
  };
  if ("messageType" in h && typeof h.messageType === "string") header.messageType = h.messageType;
  return { header, body: "body" in value && value.body !== undefined ? value.body : {} };
}
