/** Parsing shared by the bench's command-line options. Pure. */

/** One of `allowed` or a comma list of them (any order, any case, spaces allowed, repeats dropped). Undefined for anything else. */
export function parseEnumList<T extends string>(text: string, allowed: readonly T[]): T[] | undefined {
  const parts = text.split(",").map((p) => p.trim().toLowerCase());
  if (parts.some((p) => !(allowed as readonly string[]).includes(p))) return undefined;
  return [...new Set(parts as T[])];
}
