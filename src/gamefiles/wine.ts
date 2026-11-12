/**
 * Wine/Proton prefixes that hold a Bedrock client on Linux and macOS (Bottles, Lutris, Steam, BedrockOnLinux,
 * Flarial…) and the game folders their launchers keep next to them. The one place that walks for them:
 * `install.ts` builds client installs from it, `detect.ts` probes its game folders.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { GAME_EXE } from "./gdk.ts";

/** Where Wine, Proton and the launchers put their prefixes, under a home folder. */
export function winePrefixRoots(home: string): string[] {
  return [
    join(home, ".local", "share"),
    join(home, ".var", "app"),
    join(home, "Games"),
    join(home, ".wine"),
    join(home, ".steam", "steam", "steamapps", "compatdata"),
    join(home, "Library", "Application Support"),
  ];
}

/** Never holds a prefix, and can be large: Wine's drive links, npm trees, sculkwire's own data. */
const SKIP_DIRS = new Set(["dosdevices", "node_modules", "sculkwire"]);
/** Stop walking after this many data folders. */
const MAX_APPDATA_DIRS = 16;

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Real `…/drive_c/users/<u>/AppData/Roaming/Minecraft Bedrock[ Preview]` folders (with a `Users` folder) under the
 * prefix roots, sorted by path. Proton links `users/<login>` to `users/steamuser`; each real folder counts once.
 */
export function wineAppDataDirs(home: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 7 || found.length >= MAX_APPDATA_DIRS) return;
    for (const e of entries(dir)) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.name !== "drive_c") {
        walk(p, depth + 1);
        continue;
      }
      const users = join(p, "users");
      for (const u of entries(users)) {
        for (const folder of ["Minecraft Bedrock", "Minecraft Bedrock Preview"]) {
          const appData = join(users, u.name, "AppData", "Roaming", folder);
          if (!existsSync(join(appData, "Users"))) continue;
          const real = realpathSync(appData);
          if (!found.includes(real)) found.push(real);
        }
      }
    }
  };
  for (const r of winePrefixRoots(home)) walk(r, 0);
  return found.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

/** The Wine prefix (`…/pfx`) an install's data folder lives in; undefined for native Windows installs. */
export function winePrefix(appData: string): string | undefined {
  const i = appData.search(/[\\/]drive_c[\\/]/);
  return i > 0 ? appData.slice(0, i) : undefined;
}

/** A launcher's `settings.json` `game_dir` (BedrockOnLinux names its current game folder there). */
function settingsGameDir(root: string): string | undefined {
  try {
    const settings: unknown = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
    const dir = settings && typeof settings === "object" && "game_dir" in settings ? settings.game_dir : undefined;
    return typeof dir === "string" && existsSync(join(dir, GAME_EXE)) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Game folders a launcher keeps next to its prefix (BedrockOnLinux and Flarial: `<root>/games/<edition>/<version>/`,
 * prefix `<root>/compatdata/pfx`), searched a few levels deep in the launcher root. The launcher's current one
 * (`settings.json` `game_dir`) first, then the rest newest `Minecraft.Windows.exe` first.
 */
export function launcherGameDirs(prefix: string): string[] {
  const root = join(prefix, "..", "..");
  const found: { dir: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const e of entries(dir)) {
      if (e.isFile() && e.name === GAME_EXE) {
        found.push({ dir, mtime: statSync(join(dir, e.name)).mtimeMs });
      } else if (e.isDirectory() && depth < 4 && e.name !== "compatdata" && e.name !== "pfx" && e.name !== "drive_c") {
        walk(join(dir, e.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  const dirs = found.sort((a, b) => b.mtime - a.mtime).map((f) => f.dir);
  const current = settingsGameDir(root);
  return current ? [current, ...dirs.filter((d) => d !== current)] : dirs;
}

/** Every game folder of every Wine/Proton client install under a home folder, prefix by prefix. */
export function wineGameDirs(home: string): string[] {
  const dirs: string[] = [];
  for (const appData of wineAppDataDirs(home)) {
    const prefix = winePrefix(appData);
    if (!prefix) continue;
    for (const dir of launcherGameDirs(prefix)) if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}
