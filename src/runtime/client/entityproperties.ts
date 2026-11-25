/**
 * Entity property ids for `game_query` `entity_properties`: the Script API reads a property's value but cannot list
 * an entity's property ids, so they come from the project's behavior packs (`minecraft:entity.description.properties`).
 */
import { parse as parseJsonc } from "jsonc-parser";
import type { IndexedPack } from "../gamelog/logparse.ts";

/** Property ids the behavior packs among `packs` declare for entity `typeId`, in file order; [] when none does. */
export function declaredEntityProperties(packs: readonly IndexedPack[], typeId: string): string[] {
  for (const p of packs) {
    if (p.pack.kind !== "behavior") continue;
    for (const [rel, text] of p.texts) {
      if (!rel.endsWith(".json") || !text.includes(typeId)) continue;
      const data: unknown = parseJsonc(text, [], { allowTrailingComma: true });
      const entity = data && typeof data === "object" ? (data as Record<string, unknown>)["minecraft:entity"] : undefined;
      const desc = entity && typeof entity === "object" ? (entity as Record<string, unknown>).description : undefined;
      if (!desc || typeof desc !== "object") continue;
      const { identifier, properties } = desc as Record<string, unknown>;
      if (identifier !== typeId) continue;
      return properties && typeof properties === "object" && !Array.isArray(properties) ? Object.keys(properties) : [];
    }
  }
  return [];
}

/** What `entityPropertyIdsFor` reads: the helper's `entity` query and the project's declared ids for a type. */
export interface PropertyIdSource {
  query: (kind: string, params: Record<string, unknown>) => Promise<unknown>;
  declared: (typeId: string) => string[];
}

/**
 * The property ids to read for a `game_query` `entity_properties` call without `ids`: those the project declares for
 * the entity's type (`type`, else the type of entity id `entity`, else the player). Throws, naming the type, when the
 * project's behavior packs declare none, since the Script API cannot list them.
 */
export async function entityPropertyIdsFor(input: { entity?: string; type?: string; target?: string }, source: PropertyIdSource): Promise<string[]> {
  let typeId: string | undefined;
  if (input.entity !== undefined) {
    const info = (await source.query("entity", { entityId: input.entity })) as { typeId?: unknown } | null;
    if (!info) throw new Error(`no entity with id ${input.entity}`);
    typeId = typeof info.typeId === "string" ? info.typeId : undefined;
  } else typeId = input.type && input.target !== "player" ? input.type : "minecraft:player";
  if (!typeId) throw new Error(`could not read the type of entity ${input.entity}; pass ids`);
  const ids = source.declared(typeId);
  if (!ids.length) throw new Error(`the project's behavior packs declare no properties for ${typeId}; pass ids (the Script API cannot list them)`);
  return ids;
}
