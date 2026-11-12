/** Item, block and entity ids with or without their namespace. No imports, so any module can use them cheaply. */

/** `minecraft:` for an id without a namespace. */
export function namespaced(id: string): string {
  const trimmed = id.trim();
  return trimmed.includes(":") ? trimmed : `minecraft:${trimmed}`;
}

/** The id without its namespace. */
export function bareId(id: string): string {
  const colon = id.indexOf(":");
  return colon < 0 ? id : id.slice(colon + 1);
}
