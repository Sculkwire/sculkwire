/** The skills' unit-test fixtures: a player state, mobs, a kit, a threat map, and a fake game where nothing moves. */
import type { PlayerInput } from "../runtime/client/input.ts";
import { PlayerController } from "../runtime/client/player.ts";
import { parseGoal } from "../runtime/client/skills/goal.ts";
import type { Death } from "../runtime/client/skills/play.ts";
import { ThreatTracker, type ThreatMap } from "../runtime/client/skills/threat.ts";
import type { EntityInfo, Loadout, PlayerState, PlayerWorld } from "../runtime/client/types.ts";

export function me(over: Partial<PlayerState> = {}): PlayerState {
  return {
    tick: 0,
    name: "p",
    location: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0 },
    dimension: "minecraft:overworld",
    onGround: true,
    sneaking: false,
    sprinting: false,
    gameMode: "survival",
    selectedSlot: 1,
    health: 20,
    holding: { typeId: "minecraft:iron_sword", amount: 1 },
    ...over,
  };
}

export const mob = (id: string, type: string, x: number, z: number, over: Partial<EntityInfo> = {}): EntityInfo => ({
  id,
  typeId: `minecraft:${type}`,
  location: { x, y: 0, z },
  health: { current: 20, max: 20 },
  ...over,
});

const hotbar = [
  { typeId: "minecraft:iron_sword", amount: 1 },
  { typeId: "minecraft:cooked_beef", amount: 8 },
  null,
  null,
  null,
  null,
  null,
  null,
  null,
];
export const ironArmor = ["head", "chest", "legs", "feet"].map((slot, i) => ({ slot, typeId: `minecraft:iron_${["helmet", "chestplate", "leggings", "boots"][i]}` }));
export const kit = (hunger = 20): Loadout => ({ hotbar, hunger, armor: ironArmor });

export function mapOf(entities: EntityInfo[], state: Partial<PlayerState> = {}, loadout: Loadout = kit()): ThreatMap {
  return new ThreatTracker().update(0, me(state), entities, loadout);
}

export const killHostiles = parseGoal("kill the hostile mobs near you");

/**
 * A fake game where nothing moves (so its mobs stand within the measured 3.0 strike reach): the crosshair stays on the
 * first entity, every click on it takes `damage` health, and a mob at 0
 * dies (removed, with a death record killed by the player). `deathQuery` answers the helper's `deaths` query on the
 * world, as the fight reads it.
 */
export function fakeGame(entities: EntityInfo[], state: PlayerState = me(), damage = 20, deathQuery = false) {
  const deaths: Death[] = [];
  const clicks: number[] = [];
  let tick = 0;
  const aim = () => {
    const e = entities[0];
    if (e) state.lookingAtEntity = { id: e.id, typeId: e.typeId, distance: Math.hypot(e.location.x - state.location.x, e.location.z - state.location.z) };
    else delete state.lookingAtEntity;
  };
  const input: PlayerInput = {
    keyDown: async (k) => {
      if (/^[1-9]$/.test(k)) state.selectedSlot = Number(k);
    },
    keyUp: async () => {},
    look: async () => {},
    button: async (b, down) => {
      if (b !== 1 || !down) return;
      clicks.push(b);
      const target = entities.find((e) => e.id === state.lookingAtEntity?.id);
      if (!target?.health) return;
      target.health.current -= damage;
      if (target.health.current <= 0) {
        entities.splice(entities.indexOf(target), 1);
        deaths.push({ tick: ++tick, id: target.id, typeId: target.typeId, killer: "minecraft:player" });
        aim();
      }
    },
  };
  aim();
  const loadout: Loadout = { hotbar: [{ typeId: "minecraft:iron_sword", amount: 1 }, null, null, null, null, null, null, null, null], hunger: 20 };
  const world: PlayerWorld = {
    input,
    state: async () => structuredClone(state),
    entity: async (id) => structuredClone(entities.find((e) => e.id === id) ?? null),
    nearest: async () => structuredClone(entities[0] ?? null),
    impacts: async () => ({ tick: 0, impacts: [] }),
    entities: async () => structuredClone(entities),
    loadout: async () => loadout,
    ...(deathQuery
      ? {
          query: async (kind: string, params?: Record<string, unknown>) => {
            if (kind !== "deaths") throw new Error(`no ${kind} query in this fake`);
            return { tick, deaths: deaths.filter((d) => d.tick > Number(params?.since ?? -1)) };
          },
        }
      : {}),
  };
  const env = {
    controller: new PlayerController(world),
    entities: async () => structuredClone(entities),
    loadout: async () => loadout,
    deaths: async (since: number) => ({ tick, deaths: deaths.filter((d) => d.tick > since) }),
  };
  /** A death the helper logged now (not by this fight). */
  const logDeath = (d: Omit<Death, "tick">) => deaths.push({ tick: ++tick, ...d });
  return { env, clicks, state, entities, logDeath };
}
