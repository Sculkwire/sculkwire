/** The `sculkwire-` worlds sculkwire creates and the level.dat values they set. */

export const WORLD_PREFIX = "sculkwire-";

export function worldName(name: string): string {
  return name.startsWith(WORLD_PREFIX) ? name : `${WORLD_PREFIX}${name}`;
}

/** Folder-safe level id derived from the world name (stable, so a re-create replaces the same world). */
export function levelIdFor(name: string): string {
  return worldName(name).replace(/[^A-Za-z0-9_-]+/g, "_");
}

/** Level.dat `Difficulty` values. */
export const DIFFICULTIES = { peaceful: 0, easy: 1, normal: 2, hard: 3 } as const;
export type Difficulty = keyof typeof DIFFICULTIES;
