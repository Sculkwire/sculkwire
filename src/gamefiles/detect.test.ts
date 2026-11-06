import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gameDirCandidates, NO_WINDOWS_PROBE, parseWindowsProbe, windowsGameDirs } from "./detect.ts";

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
});
