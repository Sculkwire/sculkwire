/**
 * Where the Bedrock client lives and how to start it, on every OS and launcher:
 * - `SCULKWIRE_MINECRAFT_DIR` (the `Minecraft Bedrock` data folder) + optional `SCULKWIRE_CLIENT_LAUNCH` / `_STOP`
 *   for any launcher;
 * - mcbe-gdk-installer on Linux (launch/stop commands, launch lock);
 * - native Windows GDK installs (stable and Preview), started through the `minecraft://` protocol;
 * - any other Wine/Proton prefix on Linux or macOS (Flarial, Bottles, Lutris, Steam…): data is found, the user
 *   starts the game unless a launch command is configured.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GameVersion } from "../../core/version.ts";
import { formatGameVersion } from "../../core/version.ts";
import { gameDirCandidates, isPreviewGameDir } from "../../gamefiles/detect.ts";
import { launcherGameDirs, prefixOf, wineAppDataDirs } from "../../gamefiles/wine.ts";

export type InstallKind = "custom" | "mcbe-gdk-installer" | "windows" | "wine-prefix";

export interface ClientInstall {
  kind: InstallKind;
  /** Human-readable origin, e.g. `mcbe-gdk-installer`, `Windows (Preview)`, the prefix path. */
  label: string;
  /** Directory holding Minecraft.Windows.exe, when known. */
  gameDir?: string;
  /** The `Minecraft Bedrock` (or `Minecraft Bedrock Preview`) data folder: Users/, logs/. */
  appData: string;
  /** `Users/Shared/games/com.mojang`: development packs live here. */
  sharedComMojang: string;
  /** `Users/<id>/games/com.mojang` of the account that played last (worlds, options), or the shared one. */
  userComMojang: string;
  logsDir: string;
  /**
   * Launch command (argv). `{uri}` becomes the world deeplink (`minecraft://` or `minecraft-preview://`), appended
   * when absent; `{args}` expands to `-key value` activation arguments (and is dropped when there are none).
   * Absent: sculkwire cannot start the game and the user starts it.
   */
  launch?: string[];
  /** Stop command (argv). Absent: the game process is terminated directly. */
  stop?: string[];
  /** The launch command passes `{args}` to Minecraft.Windows.exe, so `-key value` activation arguments work. */
  passesArgs: boolean;
  /** Runs under Wine/Proton on Linux: headless gamescope mode is available. */
  wine: boolean;
  preview: boolean;
  /** mcbe-gdk-installer's launch flock; held while its launcher runs. */
  launchLock?: string;
  version?: string;
}

/** What a detector knows before the data folder is read. */
type InstallBase = Omit<ClientInstall, "appData" | "sharedComMojang" | "userComMojang" | "logsDir" | "preview">;

/** `1.26.6030.0` (appx Identity) → `1.26.60.30`. */
export function appxToGameVersion(appx: string): GameVersion | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(appx.trim());
  if (!m) return undefined;
  const packed = Number(m[3]);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Math.floor(packed / 100), build: packed % 100 };
}

async function readVersion(gameDir: string | undefined): Promise<string | undefined> {
  if (!gameDir) return undefined;
  try {
    const xml = await readFile(join(gameDir, "appxmanifest.xml"), "utf8");
    const m = /<Identity\b[^>]*\bVersion="([^"]+)"/.exec(xml);
    const v = m?.[1] ? appxToGameVersion(m[1]) : undefined;
    return v ? formatGameVersion(v) : undefined;
  } catch {
    return undefined;
  }
}

/** The numbered user folder whose options.txt changed last (the account that played last). */
async function activeUserDir(usersDir: string): Promise<string | undefined> {
  let best: { dir: string; mtime: number } | undefined;
  let entries: string[];
  try {
    entries = await readdir(usersDir);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const dir = join(usersDir, name, "games", "com.mojang");
    try {
      const s = await stat(join(dir, "minecraftpe", "options.txt"));
      if (!best || s.mtimeMs > best.mtime) best = { dir, mtime: s.mtimeMs };
    } catch {
      // not a played account
    }
  }
  return best?.dir;
}

/**
 * Split a command line into argv: whitespace separates, single and double quotes group. Enough for
 * `SCULKWIRE_CLIENT_LAUNCH="flatpak run com.example.Launcher --play {uri}"`.
 */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Common fields from a `Minecraft Bedrock` data folder. */
async function fromAppData(
  appData: string,
  base: InstallBase,
): Promise<ClientInstall> {
  const usersDir = join(appData, "Users");
  const sharedComMojang = join(usersDir, "Shared", "games", "com.mojang");
  const install: ClientInstall = {
    ...base,
    appData,
    sharedComMojang,
    userComMojang: (await activeUserDir(usersDir)) ?? sharedComMojang,
    logsDir: join(appData, "logs"),
    preview: /Preview$/i.test(appData.replace(/[\\/]+$/, "")),
  };
  const version = await readVersion(base.gameDir);
  if (version) install.version = version;
  return install;
}

function envCommand(name: string): string[] | undefined {
  const v = process.env[name]?.trim();
  return v ? splitCommand(v) : undefined;
}

/** `SCULKWIRE_MINECRAFT_DIR` (+ `SCULKWIRE_CLIENT_LAUNCH`, `SCULKWIRE_CLIENT_STOP`, `SCULKWIRE_GAME_DIR`). */
async function fromEnv(): Promise<ClientInstall | undefined> {
  const appData = process.env.SCULKWIRE_MINECRAFT_DIR;
  if (!appData) return undefined;
  if (!existsSync(appData)) throw new Error(`SCULKWIRE_MINECRAFT_DIR does not exist: ${appData}`);
  const launch = envCommand("SCULKWIRE_CLIENT_LAUNCH");
  const stop = envCommand("SCULKWIRE_CLIENT_STOP");
  const gameDir = process.env.SCULKWIRE_GAME_DIR;
  const base: InstallBase = {
    kind: "custom",
    label: `custom (${appData})`,
    passesArgs: launch?.includes("{args}") ?? false,
    wine: process.platform !== "win32" && /drive_c/i.test(appData),
  };
  if (launch) base.launch = launch;
  if (stop) base.stop = stop;
  if (gameDir) base.gameDir = gameDir;
  return fromAppData(appData, base);
}

export function installerRoot(): string {
  return process.env.SCULKWIRE_GDK_ROOT ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "mcbe-gdk-linux");
}

function findInstallerLauncher(): string | undefined {
  const candidates = [join(homedir(), ".local", "bin", "mcbe-gdk-linux")];
  for (const p of (process.env.PATH ?? "").split(":")) if (p) candidates.push(join(p, "mcbe-gdk-linux"));
  return candidates.find((c) => existsSync(c));
}

async function fromGdkInstaller(): Promise<ClientInstall | undefined> {
  if (process.platform !== "linux") return undefined;
  const root = installerRoot();
  let gameDir: string;
  try {
    gameDir = (await readFile(join(root, "game-dir"), "utf8")).trim();
  } catch {
    return undefined;
  }
  if (!existsSync(join(gameDir, "Minecraft.Windows.exe"))) return undefined;
  const appData = join(root, "profile", "compatdata", "pfx", "drive_c", "users", "steamuser", "AppData", "Roaming", "Minecraft Bedrock");
  const launcher = findInstallerLauncher();
  const base: InstallBase = {
    kind: "mcbe-gdk-installer",
    label: "mcbe-gdk-installer",
    gameDir,
    passesArgs: true,
    wine: true,
    launchLock: join(root, "profile", ".desktop-launch.lock"),
  };
  if (launcher) {
    // `{uri}` last: the installer passes every argument to Minecraft.Windows.exe, and the deeplink must be the
    // first non-dash one, after any `-key value` activation arguments.
    base.launch = [launcher, "launch", "{args}", "{uri}"];
    base.stop = [launcher, "stop"];
  }
  return fromAppData(appData, base);
}

/**
 * Native GDK installs: `%APPDATA%\Minecraft Bedrock[ Preview]`, started through the protocol handler. The game folder
 * is `SCULKWIRE_GAME_DIR`, else the first folder of that channel from `gameDirCandidates` (the package's registered
 * install folder, `<drive>:\XboxGames` on every fixed drive, `SCULKWIRE_GAME_DIRS`).
 */
async function fromWindows(): Promise<ClientInstall[]> {
  if (process.platform !== "win32") return [];
  const roaming = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const hasGame = (d: string | undefined): d is string => !!d && existsSync(join(d, "Minecraft.Windows.exe"));
  const found = gameDirCandidates().filter(hasGame);
  const out: ClientInstall[] = [];
  for (const preview of [false, true]) {
    const appData = join(roaming, preview ? "Minecraft Bedrock Preview" : "Minecraft Bedrock");
    if (!existsSync(appData)) continue;
    const env = process.env.SCULKWIRE_GAME_DIR;
    const gameDir = hasGame(env) ? env : found.find((d) => isPreviewGameDir(d) === preview);
    const base: InstallBase = {
      kind: "windows",
      label: preview ? "Windows (Preview)" : "Windows",
      // `start` hands the URI to the registered protocol handler; the empty string is start's window title.
      launch: ["cmd", "/c", "start", '""', "{uri}"],
      passesArgs: false,
      wine: false,
    };
    if (gameDir) base.gameDir = gameDir;
    out.push(await fromAppData(appData, base));
  }
  return out;
}

/**
 * `…/drive_c/users/<u>/AppData/Roaming/Minecraft Bedrock` under the usual Wine/Proton/launcher roots; the game folder
 * is the launcher's current one (`launcherGameDirs`).
 */
async function fromWinePrefixes(): Promise<ClientInstall[]> {
  if (process.platform === "win32") return [];
  const gdk = installerRoot();
  return Promise.all(
    wineAppDataDirs(homedir())
      .filter((a) => !a.startsWith(gdk))
      .map(async (appData) => {
        const prefix = prefixOf(appData);
        const base: InstallBase = { kind: "wine-prefix", label: prefix, passesArgs: false, wine: true };
        const gameDir = launcherGameDirs(prefix)[0];
        if (gameDir) base.gameDir = gameDir;
        return fromAppData(appData, base);
      }),
  );
}

/** Every client install found, in preference order. */
export async function findInstalls(): Promise<ClientInstall[]> {
  const env = await fromEnv();
  const out: ClientInstall[] = env ? [env] : [];
  const gdk = await fromGdkInstaller();
  if (gdk) out.push(gdk);
  out.push(...(await fromWindows()));
  out.push(...(await fromWinePrefixes()));
  return out;
}

/** The install to use; `SCULKWIRE_CLIENT` picks by kind or label substring. Throws with setup help when none. */
export async function findInstall(): Promise<ClientInstall> {
  const all = await findInstalls();
  const want = process.env.SCULKWIRE_CLIENT;
  const pick = want ? all.find((i) => i.kind === want || i.label.toLowerCase().includes(want.toLowerCase())) : all[0];
  if (pick) return pick;
  throw new Error(
    want
      ? `no client install matches SCULKWIRE_CLIENT=${want} (found: ${all.map((i) => i.label).join(", ") || "none"})`
      : "no Minecraft Bedrock client found. Set SCULKWIRE_MINECRAFT_DIR to its 'Minecraft Bedrock' data folder " +
          "(and SCULKWIRE_CLIENT_LAUNCH to a launch command), or install the GDK build",
  );
}

/** options.txt files the game reads: the active user's and the shared one. */
export function optionsFiles(install: ClientInstall): string[] {
  const files = [join(install.userComMojang, "minecraftpe", "options.txt")];
  const shared = join(install.sharedComMojang, "minecraftpe", "options.txt");
  if (!files.includes(shared)) files.push(shared);
  return files;
}
