/**
 * The user's default dev world: one of their worlds they chose (game_worlds `use`), which game_launch then enters when
 * no `userWorld` is given. Saved in the `devWorlds` section of `config.json`, one per game user folder
 * (`install.userComMojang`), as `{ "devWorlds": { "<userComMojang>": { "levelId": "…", "name": "…" } } }`. Other
 * sections of the file are kept as they are.
 */
import { readFile, stat } from "node:fs/promises";
import { writeFileAtomic } from "../../core/fs.ts";
import { configDir } from "../../core/paths.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { findWorld } from "./worldstore.ts";

export interface DevWorld {
  /** Folder under minecraftWorlds: how the world is found again, whatever it is renamed to. */
  levelId: string;
  /** Level name when it was chosen. */
  name: string;
}

const configPath = (): string => configDir("config.json");

async function readConfig(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const json: unknown = JSON.parse(text);
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`${path} is not a JSON object`);
  return json as Record<string, unknown>;
}

function section(config: Record<string, unknown>): Record<string, unknown> {
  const value = config.devWorlds;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The saved dev world of the install's game user, or undefined (none saved, or an unreadable config). */
export async function readDevWorld(install: Pick<ClientInstall, "userComMojang">, path = configPath()): Promise<DevWorld | undefined> {
  try {
    const entry = section(await readConfig(path))[install.userComMojang] as Partial<DevWorld> | undefined;
    return typeof entry?.levelId === "string" && typeof entry.name === "string" ? { levelId: entry.levelId, name: entry.name } : undefined;
  } catch {
    return undefined;
  }
}

/** Save (or with undefined, forget) the dev world of the install's game user. Returns the config file's path. */
export async function saveDevWorld(install: Pick<ClientInstall, "userComMojang">, world: DevWorld | undefined, path = configPath()): Promise<string> {
  const config = await readConfig(path);
  const worlds = { ...section(config) };
  if (world) worlds[install.userComMojang] = { levelId: world.levelId, name: world.name };
  else delete worlds[install.userComMojang];
  const mode = await stat(path).then(
    (s) => s.mode & 0o777,
    () => 0o644,
  );
  await writeFileAtomic(path, `${JSON.stringify({ ...config, devWorlds: worlds }, null, 2)}\n`, { mode });
  return path;
}

/**
 * Save `wanted` (level name or level id of one of the user's worlds; a name several worlds share is refused) as the
 * game user's dev world, or forget the saved one when `wanted` is undefined. A `sculkwire-` world an earlier version
 * made (a copy of one of the user's worlds, say) may be chosen too; the next launches then never remove it. Returns the
 * saved world, or undefined after forgetting. Nothing is written into the world.
 */
export async function useDevWorld(install: ClientInstall, wanted: string | undefined, path = configPath()): Promise<DevWorld | undefined> {
  if (wanted === undefined) {
    await saveDevWorld(install, undefined, path);
    return undefined;
  }
  const world = await findWorld(install, wanted);
  const saved = { levelId: world.levelId, name: world.name };
  await saveDevWorld(install, saved, path);
  return saved;
}