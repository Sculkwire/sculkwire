/**
 * The commands that build an arena and set the player up. Pure functions, so the tests check the command text.
 * Coordinates are absolute (the bench never relies on `~`, since commands run from the server, not the player).
 */
import type { Vec3 } from "../player.ts";
import type { MobSpawn, Offset, PlayerSetup, Scenario } from "./types.ts";

/** Bedrock's `fill` refuses more than this many blocks. */
export const FILL_LIMIT = 32_768;
/** Feet height on the bench's flat world (grass top at -61). */
export const GROUND_Y = -60;
/** Arenas sit this far apart on x, far from spawn and from each other. */
export const ARENA_SPACING = 160;
const ARENA_BASE = { x: 1000, z: 1000 };

export function arenaOrigin(index: number): Vec3 {
  return { x: ARENA_BASE.x + ARENA_SPACING * index, y: GROUND_Y, z: ARENA_BASE.z };
}

export function offsetAt(origin: Vec3, o: Offset): Vec3 {
  return { x: origin.x + o.dx, y: origin.y + o.dy, z: origin.z + o.dz };
}

function xyz(v: Vec3): string {
  return `${Math.floor(v.x)} ${Math.floor(v.y)} ${Math.floor(v.z)}`;
}

/** `fill` commands for a box, split into slabs of whole y layers so each stays under the block limit. */
export function fillBox(from: Vec3, to: Vec3, block: string): string[] {
  const x0 = Math.min(from.x, to.x);
  const x1 = Math.max(from.x, to.x);
  const y0 = Math.min(from.y, to.y);
  const y1 = Math.max(from.y, to.y);
  const z0 = Math.min(from.z, to.z);
  const z1 = Math.max(from.z, to.z);
  const layer = (x1 - x0 + 1) * (z1 - z0 + 1);
  if (layer > FILL_LIMIT) throw new Error(`a ${x1 - x0 + 1} x ${z1 - z0 + 1} layer is over the fill limit`);
  const per = Math.max(1, Math.floor(FILL_LIMIT / layer));
  const out: string[] = [];
  for (let y = y0; y <= y1; y += per) {
    const top = Math.min(y1, y + per - 1);
    out.push(`fill ${xyz({ x: x0, y, z: z0 })} ${xyz({ x: x1, y: top, z: z1 })} ${block}`);
  }
  return out;
}

/** Clear the scenario's box to air and lay its floor. */
export function arenaCommands(s: Pick<Scenario, "area" | "floor">, origin: Vec3): string[] {
  const r = s.area.radius;
  const lo = { x: origin.x - r, y: origin.y, z: origin.z - r };
  const hi = { x: origin.x + r, y: origin.y + s.area.height, z: origin.z + r };
  return [
    ...fillBox(lo, hi, "air"),
    ...fillBox({ ...lo, y: origin.y - 1 }, { ...hi, y: origin.y - 1 }, typeId(s.floor ?? "grass_block")),
  ];
}

export function typeId(type: string): string {
  return type.includes(":") ? type : `minecraft:${type}`;
}

const ARMOR_SLOTS = [
  ["slot.armor.head", "helmet"],
  ["slot.armor.chest", "chestplate"],
  ["slot.armor.legs", "leggings"],
  ["slot.armor.feet", "boots"],
] as const;

export function timeOfDay(t: PlayerSetup["time"]): number {
  if (t === undefined || t === "day") return 1000;
  if (t === "noon") return 6000;
  if (t === "night") return 18000;
  return t;
}

/**
 * Reset the player for a run: the start position first (a course built over the spot the player fell to would
 * suffocate it once in survival), game mode, empty inventory and effects, the scenario's items, armor and effects,
 * full health and food, the time of day, and the start position and facing again (any drift since stopped).
 */
export function playerCommands(p: PlayerSetup, origin: Vec3): string[] {
  const at = offsetAt(origin, p.at ?? { dx: 0, dy: 0, dz: 0 });
  const tp = `tp @a ${at.x + 0.5} ${at.y} ${at.z + 0.5} ${p.yaw ?? 0} 0`;
  const out = [
    tp,
    `gamemode ${p.gameMode ?? "survival"} @a`,
    "clear @a",
    "effect @a clear",
    // Heal fully and fill the food bar (saturation fills hunger and saturation).
    "effect @a instant_health 1 10 true",
    "effect @a saturation 2 20 true",
    `time set ${timeOfDay(p.time)}`,
  ];
  (p.hotbar ?? []).forEach((it, i) => out.push(`replaceitem entity @a slot.hotbar ${i} ${typeId(it.item)} ${it.amount ?? 1}`));
  if (p.armor) for (const [slot, piece] of ARMOR_SLOTS) out.push(`replaceitem entity @a ${slot} 0 minecraft:${p.armor}_${piece} 1`);
  if (p.offhand) out.push(`replaceitem entity @a slot.weapon.offhand 0 ${typeId(p.offhand)} 1`);
  for (const e of p.effects ?? []) out.push(`effect @a ${e.id} ${e.seconds} ${e.amplifier ?? 0} true`);
  out.push(tp);
  return out;
}

/** Spawn events that pin a mob's random variant, so every run fights the same mob. */
const SPAWN_EVENTS: Record<string, string> = {
  "minecraft:zombie": "minecraft:as_adult",
  "minecraft:husk": "minecraft:as_adult",
};

export function summonCommand(m: MobSpawn, origin: Vec3): string {
  const at = offsetAt(origin, m.at);
  const t = typeId(m.type);
  const event = SPAWN_EVENTS[t];
  return `summon ${t} ${at.x + 0.5} ${at.y} ${at.z + 0.5}${event ? ` 0 0 ${event}` : ""}`;
}

/** Every entity but players in and around the arena, for the reset between runs. */
export function clearMobsCommand(s: Pick<Scenario, "area">, origin: Vec3): string {
  return `kill @e[type=!player,x=${origin.x},y=${origin.y},z=${origin.z},r=${s.area.radius + 24}]`;
}

/** Game rules for repeatable runs: no natural spawns, no block damage, immediate respawn, no phantoms. */
export const WORLD_RULES = [
  "difficulty normal",
  "gamerule domobspawning false",
  "gamerule mobgriefing false",
  "gamerule doimmediaterespawn true",
  "gamerule keepinventory true",
  "gamerule doinsomnia false",
  "gamerule dofiretick false",
  "gamerule dodaylightcycle false",
  "gamerule doweathercycle false",
  "gamerule naturalregeneration true",
  "gamerule showdeathmessages false",
  "weather clear",
];
