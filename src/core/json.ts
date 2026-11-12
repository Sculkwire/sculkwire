/** A parsed JSON object. */
export type JsonObject = Record<string, unknown>;

/** A JSON object: non-null and not an array. */
export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
