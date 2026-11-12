/** Checks on the JSON the agent and the helper pack send. Each name says exactly what passes. */

/** Any non-null object, arrays included. */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A JSON object: non-null and not an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isObjectLike(value) && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The value when it is a finite number, else undefined. */
export function finiteOrUndefined(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

/** The value when it is a whole number of any sign (an `i32` the agent reads from the game), else undefined. */
export function integerOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** The value when it is a whole number from 0 up (a count, a slot index, a tick count), else undefined. */
export function countOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The value when it is a finite number, else 0: a counter the agent may leave out. */
export function finiteOrZero(value: unknown): number {
  return isFiniteNumber(value) ? value : 0;
}

/** Non-empty trimmed text, or undefined: an id, a screen name, an effect. */
export function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
