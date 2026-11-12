import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appxToGameVersion, gameDirCandidates, NO_WINDOWS_PROBE, parseWindowsProbe, windowsGameDirs } from "./detect.ts";

describe("gameDirCandidates", () => {
  it("probes the Xbox app GDK installs and ;-separated SCULKWIRE_GAME_DIRS on Windows", () => {
    expect(gameDirCandidates({ SCULKWIRE_GAME_DIRS: "D:\\Games\\mc;;E:\\XboxGames\\Minecraft for Windows\\Content" }, "win32", "C:\\Users\\me", NO_WINDOWS_PROBE)).toEqual([
      "C:\\XboxGames\\Minecraft for Windows\\Content",
      "C:\\XboxGames\\Minecraft Preview for Windows\\Content",
      "D:\\Games\\mc",
      "E:\\XboxGames\\Minecraft for Windows\\Content",
    ]);
  });

  it("uses %SystemDrive% for the Xbox app install root when the fixed drives are unknown", () => {
    expect(gameDirCandidates({ SystemDrive: "D:" }, "win32", "C:\\Users\\me", NO_WINDOWS_PROBE)[0]).toBe("D:\\XboxGames\\Minecraft for Windows\\Content");
  });

  it("puts the registered package folders first, then XboxGames on every fixed drive", () => {
    const probe = parseWindowsProbe(
      [
        "package\tMicrosoft.MinecraftWindowsBeta\tF:\\XboxGames\\Minecraft Preview for Windows\\Content",
        "package\tMicrosoft.MinecraftUWP\tE:\\Games\\Minecraft for Windows\\Content\r",
        "package\tMicrosoft.MinecraftEducationEdition\t",
        "drive\tC:\\",
        "drive\tE:\\",
        "",
      ].join("\n"),
    );
    expect(probe.fixedDrives).toEqual(["C:\\", "E:\\"]);
    expect(windowsGameDirs({ SCULKWIRE_GAME_DIRS: "G:\\mc" }, probe)).toEqual([
      "E:\\Games\\Minecraft for Windows\\Content",
      "F:\\XboxGames\\Minecraft Preview for Windows\\Content",
      "C:\\XboxGames\\Minecraft for Windows\\Content",
      "E:\\XboxGames\\Minecraft for Windows\\Content",
      "C:\\XboxGames\\Minecraft Preview for Windows\\Content",
      "E:\\XboxGames\\Minecraft Preview for Windows\\Content",
      "G:\\mc",
    ]);
  });

  // Uses real files under a POSIX home; the Linux branch never runs on a Windows host.
  it.skipIf(process.platform === "win32")("probes the mcbe-gdk-linux install, its game-dir pointer, then :-separated SCULKWIRE_GAME_DIRS on Linux", () => {
    const home = mkdtempSync(join(tmpdir(), "sculk-detect-"));
    try {
      const share = join(home, ".local", "share", "mcbe-gdk-linux");
      mkdirSync(share, { recursive: true });
      writeFileSync(join(share, "game-dir"), "/srv/mc\n");
      expect(gameDirCandidates({ SCULKWIRE_GAME_DIRS: "/a:/b" }, "linux", home)).toEqual([join(share, "game"), "/srv/mc", "/a", "/b"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The client install (`gamefiles/install.ts`) reads the same root, so `game_builds` and the client agree.
  it.skipIf(process.platform === "win32")("probes the mcbe-gdk-linux root that SCULKWIRE_GDK_ROOT or XDG_DATA_HOME names", () => {
    expect(gameDirCandidates({ SCULKWIRE_GDK_ROOT: "/gdk" }, "linux", "/nohome")[0]).toBe("/gdk/game");
    expect(gameDirCandidates({ XDG_DATA_HOME: "/data" }, "linux", "/nohome")[0]).toBe("/data/mcbe-gdk-linux/game");
    expect(gameDirCandidates({ XDG_DATA_HOME: "" }, "linux", "/nohome")[0]).toBe("/nohome/.local/share/mcbe-gdk-linux/game");
  });
});

describe("appxToGameVersion", () => {
  it("unpacks patch and revision from the appx identity", () => {
    expect(appxToGameVersion("1.21.12001.0")).toEqual({ major: 1, minor: 21, patch: 120, build: 1 });
    expect(appxToGameVersion("1.26.6030.0")).toEqual({ major: 1, minor: 26, patch: 60, build: 30 });
    expect(appxToGameVersion("1.26.603")).toBeUndefined();
    expect(appxToGameVersion("garbage")).toBeUndefined();
  });
});
