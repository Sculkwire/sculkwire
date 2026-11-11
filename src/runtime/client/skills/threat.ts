/**
 * The threat map: every living thing near the player with what it can do to the player now, plus the player's own
 * vitals (health, hunger, armor, best weapon, food). A tracker keeps a short history per entity, so it knows how fast
 * each mob closes in and how long a creeper has been swelling.
 */
import type { EntityInfo, Loadout, PlayerState, Vec3 } from "../player.ts";
import { armorPoints, bestFoodSlot, bestWeaponSlot, weaponDamage } from "./items.ts";
import { CREEPER_MARGIN } from "./defense.ts";
import { mobInfo, shortType, type MobInfo } from "./mobs.ts";

export interface Threat {
  id: string;
  typeId: string;
  /** Short key for traces and logs (`zombie_1`), numbered by distance per type. */
  key: string;
  location: Vec3;
  /** From the player's feet, in 3D. */
  distance: number;
  /** How fast it closes in, blocks per second (negative when it moves away). */
  approach: number;
  info: MobInfo;
  hostile: boolean;
  health?: { current: number; max: number };
  /** Creepers: whether the fuse burns (reported or estimated) and for how long. */
  fuse?: { lit: boolean; ms: number };
  /** The crosshair is on it right now. */
  aimed: boolean;
  /** 0 to 1: how likely it is to hurt the player soon, and how badly. */
  danger: number;
}

export interface Vitals {
  health: number;
  hunger?: number;
  /** Armor points, 0 to 20. */
  armor: number;
  held?: string;
  heldDamage: number;
  weapon?: { slot: number; typeId: string; damage: number };
  food?: { slot: number; typeId: string; nutrition: number };
}

export interface ThreatMap {
  at: number;
  me: PlayerState;
  vitals: Vitals;
  /** Living things except players, nearest first. */
  entities: Threat[];
  /** The hostile part of `entities`, nearest first. */
  hostiles: Threat[];
  /** Sum of the hostiles' danger. */
  pressure: number;
  /** Entities seen on the last update that are gone now although they were well inside the radius. */
  vanished: Threat[];
}

/** Entities farther than this are left out. */
export const THREAT_RADIUS = 24;
const HISTORY_MS = 600;

interface Track {
  samples: { at: number; distance: number }[];
  /** When a creeper came within swell range (or was first seen ignited). */
  swellSince?: number;
  last?: Threat;
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** How dangerous one mob is now, 0 to 1. */
export function dangerOf(info: MobInfo, distance: number, approach: number, fuse?: { lit: boolean; ms: number }): number {
  if (!info.hostile) return 0;
  const harm = Math.min(1, info.damage / 6);
  if (info.kind === "exploder") {
    if (fuse?.lit) return 1;
    if (distance <= (info.range ?? 2.5) + 1) return 0.9;
    if (distance <= 7) return 0.6;
    return Math.max(0.05, 0.4 * (1 - distance / THREAT_RADIUS));
  }
  if (info.kind === "ranged") {
    const inRange = distance <= info.range;
    return Math.min(1, (inRange ? 0.5 : 0.15) * harm + (distance < 4 ? 0.2 : 0));
  }
  // Melee: how soon it can reach the player, sooner when it is already coming.
  const gap = Math.max(0, distance - info.range);
  const speed = Math.max(info.speed, approach);
  const secondsToReach = gap / Math.max(0.5, speed);
  const soon = 1 / (1 + secondsToReach);
  return Math.min(1, harm * soon);
}

export function vitalsOf(me: PlayerState, loadout?: Loadout): Vitals {
  const weapon = loadout ? bestWeaponSlot(loadout.hotbar) : undefined;
  // A full player still carries food: name what would be eaten once hungry (hunger 0 ranks by nutrition alone).
  // The eat tactic gates on hunger itself, so this does not make it eat at 20.
  const food = loadout ? (bestFoodSlot(loadout.hotbar, loadout.hunger ?? 0) ?? bestFoodSlot(loadout.hotbar)) : undefined;
  return {
    health: me.health ?? 20,
    ...(loadout?.hunger !== undefined ? { hunger: loadout.hunger } : {}),
    armor: armorPoints((loadout?.armor ?? []).map((a) => a.typeId)),
    ...(me.holding ? { held: me.holding.typeId } : {}),
    heldDamage: weaponDamage(me.holding?.typeId),
    ...(weapon ? { weapon } : {}),
    ...(food ? { food } : {}),
  };
}

/** Keeps a short history per entity across updates. One tracker per play run or skill. */
export class ThreatTracker {
  readonly #tracks = new Map<string, Track>();
  #seen = new Map<string, Threat>();

  update(now: number, me: PlayerState, list: readonly EntityInfo[], loadout?: Loadout): ThreatMap {
    const living = list
      .filter((e) => e.typeId !== "minecraft:player" && e.health !== undefined)
      .map((e) => ({ e, distance: dist3(e.location, me.location) }))
      .filter((x) => x.distance <= THREAT_RADIUS)
      .sort((a, b) => a.distance - b.distance);
    const counts = new Map<string, number>();
    const entities: Threat[] = [];
    const ids = new Set<string>();
    for (const { e, distance } of living) {
      ids.add(e.id);
      const type = shortType(e.typeId);
      const n = (counts.get(type) ?? 0) + 1;
      counts.set(type, n);
      const info = mobInfo(e.typeId);
      const track = this.#tracks.get(e.id) ?? { samples: [] };
      this.#tracks.set(e.id, track);
      track.samples.push({ at: now, distance });
      while (track.samples.length > 2 && (track.samples[0]?.at ?? now) < now - HISTORY_MS) track.samples.shift();
      const approach = approachSpeed(e, me, distance, track, now);
      let fuse: Threat["fuse"];
      if (info.kind === "exploder") {
        // The helper reports every creeper's fuse (lit or not, and how long it burned): trust it.
        if (e.ignited === false) track.swellSince = undefined;
        else if (e.ignited && e.fuseTicks !== undefined) track.swellSince = now - e.fuseTicks * 50 - (e.ageMs ?? 0);
        else {
          const close = distance <= info.range + CREEPER_MARGIN;
          if (e.ignited || close) track.swellSince ??= now;
          else if (distance > (info.swellStop ?? 6) + CREEPER_MARGIN) track.swellSince = undefined;
        }
        fuse = { lit: e.ignited === true || track.swellSince !== undefined, ms: track.swellSince !== undefined ? now - track.swellSince : 0 };
      }
      const threat: Threat = {
        id: e.id,
        typeId: e.typeId,
        key: `${type}_${n}`,
        location: e.location,
        distance,
        approach,
        info,
        hostile: info.hostile,
        ...(e.health ? { health: e.health } : {}),
        ...(fuse ? { fuse } : {}),
        aimed: me.lookingAtEntity?.id === e.id,
        danger: dangerOf(info, distance, approach, fuse),
      };
      track.last = threat;
      entities.push(threat);
    }
    const vanished: Threat[] = [];
    for (const [id, t] of this.#seen) {
      if (ids.has(id)) continue;
      if (t.distance < THREAT_RADIUS - 4) vanished.push(t);
      this.#tracks.delete(id);
    }
    this.#seen = new Map(entities.map((t) => [t.id, t]));
    const hostiles = entities.filter((t) => t.hostile);
    return { at: now, me, vitals: vitalsOf(me, loadout), entities, hostiles, pressure: hostiles.reduce((s, t) => s + t.danger, 0), vanished };
  }
}

/** Closing speed in blocks per second: from the reported velocity when there is one, else from the distance history. */
function approachSpeed(e: EntityInfo, me: PlayerState, distance: number, track: Track, now: number): number {
  if (e.velocity && distance > 0.01) {
    const dx = (me.location.x - e.location.x) / distance;
    const dz = (me.location.z - e.location.z) / distance;
    return (e.velocity.x * dx + e.velocity.z * dz) * 20;
  }
  const first = track.samples[0];
  if (!first || now - first.at < 100) return 0;
  return ((first.distance - distance) * 1000) / (now - first.at);
}
