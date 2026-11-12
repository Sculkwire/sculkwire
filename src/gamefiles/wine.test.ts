import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gameDirCandidates } from "./detect.ts";
import { launcherGameDirs, wineAppDataDirs, winePrefix, wineGameDirs } from "./wine.ts";

let home: string;

/** A launcher root like BedrockOnLinux and Flarial: `<root>/compatdata/pfx` plus `<root>/games/<edition>/<version>`. */
function launcher(name: string, versions: string[]): string {
  const root = join(home, ".local", "share", name);
  mkdirSync(join(root, "compatdata", "pfx", "drive_c", "users", "steamuser", "AppData", "Roaming", "Minecraft Bedrock", "Users"), { recursive: true });
  versions.forEach((v, i) => {
    const dir = join(root, "games", "release", v);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Minecraft.Windows.exe"), "");
    const t = new Date(Date.UTC(2026, 0, 1 + i));
    utimesSync(join(dir, "Minecraft.Windows.exe"), t, t);
  });
  return root;
}

describe("winePrefix", () => {
  it("finds the Wine prefix an install's data folder lives in, so only that prefix's game is managed", () => {
    expect(winePrefix("/home/u/.local/share/Flarial/Linux/compatdata/pfx/drive_c/users/steamuser/AppData/Roaming/Minecraft Bedrock")).toBe(
      "/home/u/.local/share/Flarial/Linux/compatdata/pfx",
    );
    expect(winePrefix("C:\\Users\\u\\AppData\\Roaming\\Minecraft Bedrock")).toBeUndefined();
  });
});

// POSIX homes with real files; the Wine branch never runs on a Windows host.
describe.skipIf(process.platform === "win32")("wine prefix game folders", () => {
  beforeEach(() => {
    // Real path: the walk resolves Proton's user links, and macOS keeps the temp folder behind `/var` -> `/private/var`.
    home = realpathSync(mkdtempSync(join(tmpdir(), "sculk-wine-")));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("finds the AppData folder of every prefix, sorted by path, and its prefix", () => {
    const flarial = launcher("Flarial", ["9.1.0"]);
    const bol = launcher("bedrock-on-linux", ["9.2.0"]);
    const appData = wineAppDataDirs(home);
    expect(appData.map(winePrefix)).toEqual([join(bol, "compatdata", "pfx"), join(flarial, "compatdata", "pfx")]);
  });

  it("puts the launcher's settings.json game_dir first, then the other game folders newest first", () => {
    const root = launcher("bedrock-on-linux", ["9.1.0", "9.2.0", "9.3.0"]);
    const prefix = join(root, "compatdata", "pfx");
    const games = join(root, "games", "release");
    expect(launcherGameDirs(prefix)).toEqual([join(games, "9.3.0"), join(games, "9.2.0"), join(games, "9.1.0")]);
    writeFileSync(join(root, "settings.json"), JSON.stringify({ game_dir: join(games, "9.1.0") }));
    expect(launcherGameDirs(prefix)).toEqual([join(games, "9.1.0"), join(games, "9.3.0"), join(games, "9.2.0")]);
  });

  it("ignores a settings.json game_dir without the game", () => {
    const root = launcher("bedrock-on-linux", ["9.1.0"]);
    writeFileSync(join(root, "settings.json"), JSON.stringify({ game_dir: join(root, "games", "release", "gone") }));
    expect(launcherGameDirs(join(root, "compatdata", "pfx"))).toEqual([join(root, "games", "release", "9.1.0")]);
  });

  it("lists every launcher's game folders and gameDirCandidates probes them after mcbe-gdk-linux", () => {
    const bol = launcher("bedrock-on-linux", ["9.2.0"]);
    const flarial = launcher("Flarial", ["9.1.0"]);
    const found = [join(bol, "games", "release", "9.2.0"), join(flarial, "games", "release", "9.1.0")];
    expect(wineGameDirs(home)).toEqual(found);
    expect(gameDirCandidates({ SCULKWIRE_GAME_DIRS: "/a" }, "linux", home)).toEqual([join(home, ".local", "share", "mcbe-gdk-linux", "game"), ...found, "/a"]);
  });
});
