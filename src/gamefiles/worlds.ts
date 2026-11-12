/** The `sculkwire-` worlds sculkwire creates and the level.dat values they set. */
import { TAG, type NbtCompound } from "./nbt.ts";

export const WORLD_PREFIX = "sculkwire-";

export function worldName(name: string): string {
  return name.startsWith(WORLD_PREFIX) ? name : `${WORLD_PREFIX}${name}`;
}

/** Folder-safe level id derived from the world name (stable, so a re-create replaces the same world). */
export function levelIdFor(name: string): string {
  return worldName(name).replace(/[^A-Za-z0-9_-]+/g, "_");
}

/** Cheats and commands on in a level.dat root: the bridge's commands need them. */
export function setCheats(root: NbtCompound): void {
  root.set("commandsEnabled", { type: TAG.Byte, value: 1 });
  root.set("cheatsEnabled", { type: TAG.Byte, value: 1 });
}

/** Single player in a level.dat root: multiplayer and every broadcast off (no LAN, Xbox Live or platform), so nobody can join. */
export function setSinglePlayer(root: NbtCompound): void {
  root.set("MultiplayerGame", { type: TAG.Byte, value: 0 });
  root.set("MultiplayerGameIntent", { type: TAG.Byte, value: 0 });
  root.set("LANBroadcast", { type: TAG.Byte, value: 0 });
  root.set("LANBroadcastIntent", { type: TAG.Byte, value: 0 });
  // Broadcast setting 0 is "no multiplayer" (1 invite only, 2 friends, 3 friends of friends, 4 public).
  root.set("XBLBroadcastIntent", { type: TAG.Int, value: 0 });
  root.set("PlatformBroadcastIntent", { type: TAG.Int, value: 0 });
}

/** Level.dat `Difficulty` values. */
export const DIFFICULTIES = { peaceful: 0, easy: 1, normal: 2, hard: 3 } as const;
export type Difficulty = keyof typeof DIFFICULTIES;

/** Level.dat `GameType` values, by index. */
export const GAME_TYPES = ["survival", "creative", "adventure", "spectator"] as const;
export type GameType = (typeof GAME_TYPES)[number];

/** A difficulty from its name or its level.dat number, or undefined. */
export function difficultyOf(raw: unknown): Difficulty | undefined {
  const names = Object.keys(DIFFICULTIES) as Difficulty[];
  if (typeof raw === "string") return names.find((name) => name === raw);
  return typeof raw === "number" && Number.isInteger(raw) ? names[raw] : undefined;
}

/** A game type from its name or its level.dat number, or undefined. */
export function gameTypeOf(raw: unknown): GameType | undefined {
  if (typeof raw === "string" && (GAME_TYPES as readonly string[]).includes(raw)) return raw as GameType;
  return typeof raw === "number" && Number.isInteger(raw) ? GAME_TYPES[raw] : undefined;
}

/**
 * Game rules as `level.dat` stores them: the key of the same name, a byte for a switch and an int for a number.
 * Reading reports only these names, so a stray level.dat field is never mistaken for a rule.
 */
export const GAMERULES: Readonly<Record<string, "bool" | "int">> = {
  commandblockoutput: "bool",
  commandblocksenabled: "bool",
  dodaylightcycle: "bool",
  doentitydrops: "bool",
  dofiretick: "bool",
  doimmediaterespawn: "bool",
  doinsomnia: "bool",
  domobloot: "bool",
  domobspawning: "bool",
  dotiledrops: "bool",
  doweathercycle: "bool",
  drowningdamage: "bool",
  falldamage: "bool",
  firedamage: "bool",
  freezedamage: "bool",
  keepinventory: "bool",
  mobgriefing: "bool",
  naturalregeneration: "bool",
  pvp: "bool",
  respawnblocksexplode: "bool",
  sendcommandfeedback: "bool",
  showcoordinates: "bool",
  showdeathmessages: "bool",
  showtags: "bool",
  tntexplodes: "bool",
  maxcommandchainlength: "int",
  randomtickspeed: "int",
  playerssleepingpercentage: "int",
};
