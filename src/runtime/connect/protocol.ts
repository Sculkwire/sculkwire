/**
 * The `/connect` (Automation WebSocket) protocol: the game dials our WebSocket server and exchanges
 * `{header, body}` JSON messages. Requests carry a `requestId`; the game echoes it in the response header.
 */
import { randomUUID } from "node:crypto";

export type MessagePurpose =
  | "commandRequest"
  | "commandResponse"
  | "subscribe"
  | "unsubscribe"
  | "event"
  | "error"
  | "data:block"
  | "data:item"
  | "data:mob"
  | "ws:encrypt";

export interface Header {
  version: number;
  requestId: string;
  messagePurpose: MessagePurpose | string;
  messageType?: string;
  /** Present on `event` messages. */
  eventName?: string;
}

export interface Message<B = unknown> {
  header: Header;
  body: B;
}

export interface CommandResponseBody {
  statusCode: number;
  statusMessage?: string;
  [key: string]: unknown;
}

export type DataKind = "block" | "item" | "mob";

/** The game rejects requests beyond this many unanswered commands ("Too many commands have been requested"). */
export const MAX_IN_FLIGHT = 100;

export function newRequestId(): string {
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

export function subscribeRequest(eventName: string, unsubscribe = false, requestId = newRequestId()): Message<{ eventName: string }> {
  const purpose = unsubscribe ? "unsubscribe" : "subscribe";
  return { header: { version: 1, requestId, messagePurpose: purpose, messageType: "commandRequest" }, body: { eventName } };
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
  if ("eventName" in h && typeof h.eventName === "string") header.eventName = h.eventName;
  return { header, body: "body" in value && value.body !== undefined ? value.body : {} };
}

/** Legacy telemetry events the game accepts subscriptions for (many fire only on some platforms). */
export const KNOWN_EVENTS = [
  "PlayerMessage",
  "PlayerTransform",
  "PlayerTravelled",
  "PlayerTeleported",
  "PlayerDied",
  "BlockPlaced",
  "BlockBroken",
  "ItemUsed",
  "ItemAcquired",
  "ItemCrafted",
  "ItemEquipped",
  "ItemInteracted",
  "MobKilled",
  "MobInteracted",
  "EndOfDay",
  "ScriptLoaded",
  "ScriptRan",
  "SlashCommandExecuted",
  "WorldLoaded",
] as const;
