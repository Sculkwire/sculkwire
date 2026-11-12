/**
 * The host side of the helper pack's wire (`helper-pack/scripts/main.js`): the pack prints marked lines to the
 * script debugger, and the host asks it with `/scriptevent sculkwire:query <json>`. The strings must match main.js;
 * the helper pack tests load main.js and read its prints through these constants.
 */

export const HELPER_MARK = {
  /** Printed when the pack's scripts (re)start: after a world load, `/reload` or a rejoin. */
  ready: "[sculkwire:ready]",
  /** Printed on the player's first spawn: the loading screen is gone and keys reach the game. */
  spawned: "[sculkwire:spawned]",
  /** Followed by a `HelperReply` as JSON. */
  reply: "[sculkwire:reply] ",
  /** Followed by the streamed player state as JSON. */
  state: "[sculkwire:state] ",
} as const;

/** Every helper print starts with this. */
export const HELPER_PRINT_PREFIX = "[sculkwire:";
/** The `/scriptevent` id the pack listens on. */
export const HELPER_QUERY_EVENT = "sculkwire:query";

export interface HelperReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** The handler's machine-readable label for a refusal (`no_container`), when it set one. */
  reason?: string;
}

/** The debugger command that sends query `kind` with id `id`. */
export function queryCommand(kind: string, params: Record<string, unknown>, id: number): string {
  return `scriptevent ${HELPER_QUERY_EVENT} ${JSON.stringify({ ...params, kind, id })}`;
}

/**
 * Whether a print is the reply to query `id`. main.js serialises `id` first (`{"id":7,"ok":…}`), so the id is
 * matched in the text without parsing every print.
 */
export function isReplyTo(message: string, id: number): boolean {
  return message.startsWith(HELPER_MARK.reply) && message.includes(`"id":${id},`);
}

/** The reply a reply print carries; throws on a print that is not one. */
export function parseReply(message: string): HelperReply {
  const reply: unknown = JSON.parse(message.slice(HELPER_MARK.reply.length));
  if (!reply || typeof reply !== "object" || !("ok" in reply)) throw new Error(`malformed helper reply: ${message}`);
  return reply as HelperReply;
}
