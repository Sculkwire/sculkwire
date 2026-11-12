/** Finds installed PC (GDK) copies of Bedrock and reads their version without launching anything. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { formatGameVersion, type GameVersion } from "../core/version.ts";
import { GAME_EXE, installerRoot } from "./gdk.ts";
import { wineGameDirs } from "./wine.ts";

export interface GameBuild {
  /** Absolute game directory (contains `Minecraft.Windows.exe`). */
  root: string;
  /** Stable key for cache paths: the game version, else a hash of the root. */
  key: string;
  /** Game version in 1.x numbering, e.g. `1.21.120.1`, derived from the appx manifest. */
  version?: string;
  /** Raw `<Identity Version>` from appxmanifest.xml, e.g. `1.21.12001.0`. */
  appxVersion?: string;
  packageName?: string;
  packRoots: { behavior?: string; resource?: string };
}

/** GDK install folders the Xbox app creates on Windows (under `<drive>\XboxGames`), stable first. */
const WINDOWS_GDK_TITLES = ["Minecraft for Windows", "Minecraft Preview for Windows"];

/** Package family names of the stable and Preview GDK builds. */
export const STABLE_PACKAGE = "Microsoft.MinecraftUWP";
export const PREVIEW_PACKAGE = "Microsoft.MinecraftWindowsBeta";

/** What Windows says about installed copies: the packages' install folders and the fixed drives. */
export interface WindowsGameProbe {
  packages: { name: string; installLocation: string }[];
  /** Fixed drive roots, e.g. `C:\`, `D:\`. */
  fixedDrives: string[];
}

export const NO_WINDOWS_PROBE: WindowsGameProbe = { packages: [], fixedDrives: [] };

/** Lines `package\t<name>\t<install location>` and `drive\t<root>` written by the probe script. */
export function parseWindowsProbe(text: string): WindowsGameProbe {
  const out: WindowsGameProbe = { packages: [], fixedDrives: [] };
  for (const line of text.split(/\r?\n/)) {
    const [kind, a, b] = line.split("\t").map((s) => s.trim());
    if (kind === "package" && a && b) out.packages.push({ name: a, installLocation: b });
    else if (kind === "drive" && a) out.fixedDrives.push(a);
  }
  return out;
}

// Get-AppxPackage lists the current user's packages without admin rights; a missing cmdlet or package prints nothing.
const PROBE_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Get-AppxPackage -Name 'Microsoft.Minecraft*' | ForEach-Object { \"package`t$($_.Name)`t$($_.InstallLocation)\" }",
  "[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' } | ForEach-Object { \"drive`t$($_.Name)\" }",
  "exit 0",
].join("\n");

let probed: WindowsGameProbe | undefined;

/** Ask Windows once per process (PowerShell, about a second); empty when it cannot answer. */
export function windowsGameProbe(): WindowsGameProbe {
  if (probed) return probed;
  try {
    const encoded = Buffer.from(PROBE_SCRIPT, "utf16le").toString("base64");
    const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    probed = parseWindowsProbe(text);
  } catch {
    probed = NO_WINDOWS_PROBE;
  }
  return probed;
}

/**
 * Windows game folders in preference order: the install folder Windows registered for the stable and Preview
 * packages, then `<drive>\XboxGames\<title>\Content` on every fixed drive (the Xbox app installs on the drive the user
 * picks; `%SystemDrive%` when the drives are unknown), then `SCULKWIRE_GAME_DIRS` (`;` separated).
 */
export function windowsGameDirs(env: NodeJS.ProcessEnv, probe: WindowsGameProbe): string[] {
  const dirs: string[] = [];
  for (const name of [STABLE_PACKAGE, PREVIEW_PACKAGE]) {
    for (const p of probe.packages) if (p.name === name) dirs.push(p.installLocation);
  }
  const drives = probe.fixedDrives.length ? probe.fixedDrives : [`${env.SystemDrive || "C:"}\\`];
  for (const title of WINDOWS_GDK_TITLES) for (const drive of drives) dirs.push(win32.join(drive, "XboxGames", title, "Content"));
  for (const part of (env.SCULKWIRE_GAME_DIRS ?? "").split(";")) if (part.trim()) dirs.push(part.trim());
  return [...new Set(dirs.map((d) => win32.resolve(d)))];
}

/**
 * Game directories to probe. Linux and macOS: the mcbe-gdk-linux install (`installerRoot`) and its `game-dir` pointer, the
 * game folders of every Wine/Proton client install (BedrockOnLinux, Flarial, Bottles, Lutris, Steam: `wineGameDirs`),
 * then `SCULKWIRE_GAME_DIRS` (`:` separated). Windows: `windowsGameDirs`.
 */
export function gameDirCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  probe: WindowsGameProbe = platform === "win32" && process.platform === "win32" ? windowsGameProbe() : NO_WINDOWS_PROBE,
): string[] {
  if (platform === "win32") return windowsGameDirs(env, probe);
  const p = posix;
  const dirs: string[] = [];
  const gdkLinux = installerRoot(env, home);
  dirs.push(p.join(gdkLinux, "game"));
  const pointer = p.join(gdkLinux, "game-dir");
  if (existsSync(pointer)) {
    const target = readFileSync(pointer, "utf8").trim();
    if (target) dirs.push(target);
  }
  dirs.push(...wineGameDirs(home));
  for (const part of (env.SCULKWIRE_GAME_DIRS ?? "").split(p.delimiter)) if (part.trim()) dirs.push(part.trim());
  return [...new Set(dirs.map((d) => p.resolve(d)))];
}

/** Whether a game folder holds the Preview build: its appx package name, else the folder name. */
export function isPreviewGameDir(dir: string): boolean {
  const pkg = readManifest(dir).packageName;
  return pkg ? pkg === PREVIEW_PACKAGE : /preview/i.test(dir);
}

/** `1.21.12001.0` (appx Identity) → `1.21.120.1` (GDK packs patch and revision as patch*100+revision). */
export function appxToGameVersion(appx: string): GameVersion | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(appx.trim());
  if (!m) return undefined;
  const packed = Number(m[3]);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Math.floor(packed / 100), build: packed % 100 };
}

/** The `<Identity>` of a game folder's appx manifest: its version and package name. */
export function readManifest(root: string): { appxVersion?: string; packageName?: string } {
  for (const name of ["appxmanifest.xml", "AppxManifest.xml"]) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    const identity = /<Identity\b[^>]*>/.exec(readFileSync(file, "utf8"))?.[0];
    if (!identity) return {};
    const out: { appxVersion?: string; packageName?: string } = {};
    const version = /\bVersion="([^"]+)"/.exec(identity)?.[1];
    const pkg = /\bName="([^"]+)"/.exec(identity)?.[1];
    if (version) out.appxVersion = version;
    if (pkg) out.packageName = pkg;
    return out;
  }
  return {};
}

/** Reads one game directory; undefined when it holds no `Minecraft.Windows.exe`. */
export function inspectBuild(dir: string): GameBuild | undefined {
  const root = resolve(dir);
  const exe = join(root, GAME_EXE);
  if (!existsSync(exe) || !statSync(exe).isFile()) return undefined;
  const { appxVersion, packageName } = readManifest(root);
  const parsed = appxVersion ? appxToGameVersion(appxVersion) : undefined;
  const version = parsed ? formatGameVersion(parsed) : undefined;
  const key = version ?? createHash("sha256").update(root).digest("hex").slice(0, 12);
  const packRoots: GameBuild["packRoots"] = {};
  const bp = join(root, "data", "behavior_packs");
  const rp = join(root, "data", "resource_packs");
  if (existsSync(bp)) packRoots.behavior = bp;
  if (existsSync(rp)) packRoots.resource = rp;
  const build: GameBuild = { root, key, packRoots };
  if (version) build.version = version;
  if (appxVersion) build.appxVersion = appxVersion;
  if (packageName) build.packageName = packageName;
  return build;
}

export function detectBuilds(dirs: readonly string[] = gameDirCandidates()): GameBuild[] {
  const seen = new Set<string>();
  const builds: GameBuild[] = [];
  for (const dir of dirs) {
    const build = inspectBuild(dir);
    if (!build || seen.has(build.root)) continue;
    seen.add(build.root);
    builds.push(build);
  }
  return builds;
}

/** Picks a build by key, version, or root; the first detected one when no selector is given. */
export function selectBuild(builds: readonly GameBuild[], selector?: string): GameBuild | undefined {
  if (!selector) return builds[0];
  const abs = resolve(selector);
  return builds.find((b) => b.key === selector || b.version === selector || b.root === abs) ?? inspectBuild(selector);
}

/** The error text when no build matches (or none was found at all in `searched`). */
export function noBuildMessage(selector?: string, searched?: readonly string[]): string {
  return selector
    ? `no Bedrock GDK build matches ${JSON.stringify(selector)}`
    : `no Bedrock GDK build found (searched ${(searched ?? gameDirCandidates()).join(", ")}; add directories with SCULKWIRE_GAME_DIRS)`;
}

/** The build `selector` picks (see `selectBuild`). Throws `noBuildMessage` when there is none. */
export function requireBuild(selector?: string): GameBuild {
  const searched = gameDirCandidates();
  const build = selectBuild(detectBuilds(searched), selector);
  if (!build) throw new Error(noBuildMessage(selector, searched));
  return build;
}
