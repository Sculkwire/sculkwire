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

/** The armor slot an item is worn in (0 head, 1 chest, 2 legs, 3 feet); undefined for an item that is not worn. */
export function armorSlotOf(item: string): number | undefined {
  const id = bareId(item);
  if (/_helmet$|^carved_pumpkin$|_skull$|_head$/.test(id)) return 0;
  if (/_chestplate$|^elytra$/.test(id)) return 1;
  if (/_leggings$/.test(id)) return 2;
  if (/_boots$/.test(id)) return 3;
  return undefined;
}
