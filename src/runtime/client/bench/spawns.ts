/**
 * Which entities are a scenario's spawned mobs, and how many of them the player killed. Pure, so the tests check
 * them on hand-built entity lists and death logs.
 */
import type { EntityInfo, Vec3 } from "../player.ts";
import type { Death } from "../skills/play.ts";
import { typeId } from "./arena.ts";
import type { MobSpawn, Offset } from "./types.ts";

/** How often the runner looks for the summoned mobs, and for how long at most after the summons were sent. */
export const SPAWN_POLL_MS = 100;
export const SPAWN_FIND_MS = 3000;

const PLAYER = "minecraft:player";

export interface SpawnedMob {
  id: string;
  typeId: string;
}

/**
 * Claim an entity for every spawn not resolved yet (`found[i]` undefined): the nearest entity of the spawn's type to
 * its spawn point that no spawn claimed. Resolved spawns keep their entity. Same length and order as `spawns`.
 */
export function claimSpawned(spawns: readonly MobSpawn[], at: (o: Offset) => Vec3, list: readonly EntityInfo[], found: readonly (SpawnedMob | undefined)[]): (SpawnedMob | undefined)[] {
  const claimed = new Set(found.flatMap((m) => (m ? [m.id] : [])));
  return spawns.map((m, i) => {
    const had = found[i];
    if (had) return had;
    const t = typeId(m.type);
    const p = at(m.at);
    const pick = list
      .filter((e) => e.typeId === t && !claimed.has(e.id))
      .sort((a, b) => Math.hypot(a.location.x - p.x, a.location.z - p.z) - Math.hypot(b.location.x - p.x, b.location.z - p.z))[0];
    if (!pick) return undefined;
    claimed.add(pick.id);
    return { id: pick.id, typeId: pick.typeId };
  });
}

/**
 * The player's kills of a run's spawned mobs, from the deaths logged since the run started. `resolved`: deaths of the
 * resolved ids with the player as killer. `unresolved`: for a spawn whose id was never found (it died before it was
 * seen), a player kill of that spawn's type whose id is none of the resolved ones, at most one per such spawn.
 */
export function countKills(spawns: readonly MobSpawn[], found: readonly (SpawnedMob | undefined)[], deaths: readonly Death[]): { resolved: number; unresolved: number } {
  const ids = new Set(found.flatMap((m) => (m ? [m.id] : [])));
  const byPlayer = deaths.filter((d) => d.killer === PLAYER);
  const resolved = byPlayer.filter((d) => ids.has(d.id)).length;
  const spare = byPlayer.filter((d) => !ids.has(d.id));
  let unresolved = 0;
  spawns.forEach((m, i) => {
    if (found[i]) return;
    const k = spare.findIndex((d) => d.typeId === typeId(m.type));
    if (k < 0) return;
    spare.splice(k, 1);
    unresolved++;
  });
  return { resolved, unresolved };
}
