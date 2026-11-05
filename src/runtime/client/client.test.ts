import { describe, expect, it } from "vitest";
import { clientDiagnostics, normalizeClientMessage } from "./contentlog.ts";
import { appxToGameVersion, splitCommand } from "./install.ts";
import { activationArgs, defaultMode, gamescopeBackend, gamescopeBlocker, launchArgv, parseGamescopeLog, winePrefix, windowsMode, worldUri } from "./launcher.ts";
import { applyOptions, parseOptions, removeOptions } from "./options.ts";
import { belongsToInstall, chordKeys, encodeCommand, parseHelperLine, parseProcessList, virtualKey } from "./windows.ts";

describe("launch arguments", () => {
  it("puts activation arguments before the deeplink, which must be the first non-dash argument", () => {
    const uri = worldUri("sculkwire-a b", false);
    expect(launchArgv(["mcbe-gdk-linux", "launch", "{args}", "{uri}"], activationArgs({ extraArgs: ["-x", "1"] }), uri)).toEqual([
      "mcbe-gdk-linux",
      "launch",
      "-x",
      "1",
      "minecraft://connect?localLevelId=sculkwire-a%20b",
    ]);
  });

  it("drops an empty {args}, appends the deeplink when the command has no {uri}, and uses the preview scheme", () => {
    expect(launchArgv(["launcher", "{args}", "--play"], [], worldUri("w", true))).toEqual(["launcher", "--play", "minecraft-preview://connect?localLevelId=w"]);
    expect(launchArgv(["cmd", "/c", "start", '""', "{uri}"], [], undefined)).toEqual(["cmd", "/c", "start", '""']);
  });

  it("splits a launch command line with quotes", () => {
    expect(splitCommand(`flatpak run "com.example.Mc Launcher" --play {uri} ''`)).toEqual(["flatpak", "run", "com.example.Mc Launcher", "--play", "{uri}", ""]);
  });

  it("reads gamescope's displays from its log", () => {
    const log = "x\n[gamescope] [Info]  wlserver: Running compositor on wayland display 'gamescope-1'\n[gamescope] [Info]  wlserver: [xwayland/server.c:108] Starting Xwayland on :3\n";
    expect(parseGamescopeLog(log)).toEqual({ gamescopeDisplay: "gamescope-1", xDisplay: ":3" });
  });

  it("maps the appx identity to the internal game version", () => {
    expect(appxToGameVersion("1.26.6030.0")).toEqual({ major: 1, minor: 26, patch: 60, build: 30 });
    expect(appxToGameVersion("1.26.603")).toBeUndefined();
  });
});

describe("options.txt", () => {
  it("replaces values in place, appends missing keys, and undoes appended keys", () => {
    const text = "gfx_vsync:1\nwebsockets_enabled:0\nmp_username:a:b\n";
    const changed = applyOptions(text, { websockets_enabled: "1", script_debugger_port: "19151" });
    expect(changed).toBe("gfx_vsync:1\nwebsockets_enabled:1\nmp_username:a:b\nscript_debugger_port:19151\n");
    expect(parseOptions(changed).get("mp_username")).toBe("a:b");
    const restored = removeOptions(applyOptions(changed, { websockets_enabled: "0" }), ["script_debugger_port"]);
    expect(restored).toBe(text);
  });
});

describe("client content log", () => {
  it("joins the deployed pack folder and file from the client's pipe-separated location", () => {
    const msg =
      "C:/users/steamuser/AppData/Roaming/Minecraft Bedrock/Users/Shared/games/com.mojang/development_behavior_packs/My BP | blocks/x.b.json | -> components -> minecraft:geometry: bad";
    expect(normalizeClientMessage(msg)).toBe("development_behavior_packs/My BP/blocks/x.b.json | -> components -> minecraft:geometry: bad");
  });

  it("collapses an error the game repeats every frame into one diagnostic", () => {
    const line = "12:00:01[Molang][error]-Error: unknown query 'query.nope'\n\n\n";
    const diagnostics = clientDiagnostics(line.repeat(3), []);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("(repeated 3×)");
    expect(diagnostics[0]?.severity).toBe("error");
  });
});

describe("Windows helpers", () => {
  it("reads pid and path per game process, including processes without a path", () => {
    const text = "4120\tC:\\XboxGames\\Minecraft for Windows\\Content\\Minecraft.Windows.exe\r\n5032\t\r\n";
    expect(parseProcessList(text)).toEqual([
      { pid: 4120, path: "C:\\XboxGames\\Minecraft for Windows\\Content\\Minecraft.Windows.exe" },
      { pid: 5032, path: "" },
    ]);
  });

  it("tells Stable and Preview apart by path, so the other edition is never managed", () => {
    const stable = "C:\\XboxGames\\Minecraft for Windows\\Content\\Minecraft.Windows.exe";
    const preview = "C:\\XboxGames\\Minecraft Preview for Windows\\Content\\Minecraft.Windows.exe";
    const stableInstall = { gameDir: "C:\\XboxGames\\Minecraft for Windows\\Content", preview: false };
    expect(belongsToInstall(stable, stableInstall)).toBe(true);
    expect(belongsToInstall(preview, stableInstall)).toBe(false);
    expect(belongsToInstall(preview, { preview: true })).toBe(true);
    expect(belongsToInstall(stable, { preview: true })).toBe(false);
  });

  it("maps xdotool key names to virtual keys, case-insensitively, and names the valid keys for an unknown one", () => {
    expect(virtualKey("w")).toBe(0x57);
    expect(virtualKey("W")).toBe(0x57);
    expect(virtualKey("7")).toBe(0x37);
    expect(virtualKey("slash")).toBe(0xbf);
    expect(virtualKey("/")).toBe(0xbf);
    expect(virtualKey("escape")).toBe(0x1b);
    expect(virtualKey("F12")).toBe(0x7b);
    expect(virtualKey("F24")).toBe(0x87);
    expect(virtualKey("KP_5")).toBe(0x65);
    expect(virtualKey("KP_Enter")).toBe(0x10d);
    expect(() => virtualKey("Hyper_L")).toThrow(/unknown key 'Hyper_L'. Valid keys: Return, .*Escape.*a-z, 0-9, F1-F24/);
    expect(() => virtualKey("F25")).toThrow(/unknown key/);
  });

  it("maps every key the player controller holds", () => {
    for (const k of ["w", "a", "s", "d", "space", "Shift_L", "Control_L", "1", "9"]) expect(() => virtualKey(k)).not.toThrow();
    expect([virtualKey("Shift_L"), virtualKey("Control_L"), virtualKey("space")]).toEqual([0xa0, 0xa2, 0x20]);
  });

  it("splits chords into keys pressed in order", () => {
    expect(chordKeys("ctrl+a")).toEqual([0xa2, 0x41]);
    expect(chordKeys("ctrl+shift+Tab")).toEqual([0xa2, 0xa0, 0x09]);
    expect(chordKeys("Return")).toEqual([0x0d]);
    expect(() => chordKeys("ctrl+")).toThrow(/malformed key chord/);
    expect(() => chordKeys("ctrl+nope")).toThrow(/unknown key 'nope'/);
  });

  it("encodes helper requests one per line, with text as base64 UTF-8", () => {
    expect(encodeCommand(1, { verb: "probe" })).toBe("1 probe");
    expect(encodeCommand(2, { verb: "down", key: 0x57 })).toBe("2 down 87");
    expect(encodeCommand(3, { verb: "bup", button: 3 })).toBe("3 bup 3");
    expect(encodeCommand(4, { verb: "move", x: -12.6, y: 4.2 })).toBe("4 move -13 4");
    expect(encodeCommand(5, { verb: "at", x: 640, y: 360 })).toBe("5 at 640 360");
    const text = encodeCommand(6, { verb: "text", text: "héllo\n/connect ✓" });
    expect(text).not.toMatch(/\n/);
    expect(Buffer.from(text.split(" ")[2] ?? "", "base64").toString("utf8")).toBe("héllo\n/connect ✓");
  });

  it("parses helper answers and foreground reports, ignoring other output", () => {
    expect(parseHelperLine("7 ok\r")).toEqual({ kind: "reply", id: 7, status: "ok" });
    expect(parseHelperLine("8 blocked")).toEqual({ kind: "reply", id: 8, status: "blocked" });
    expect(parseHelperLine("9 err the game window was not found")).toEqual({ kind: "error", id: 9, message: "the game window was not found" });
    expect(parseHelperLine("fg 0")).toEqual({ kind: "foreground", foreground: false });
    expect(parseHelperLine("fg 1")).toEqual({ kind: "foreground", foreground: true });
    expect(parseHelperLine("WARNING: something")).toBeUndefined();
  });
});

describe("launch modes", () => {
  const install = { kind: "windows", label: "Windows", appData: "", sharedComMojang: "", userComMojang: "", logsDir: "", passesArgs: false, wine: false, preview: false } as const;

  it("defaults to the game's own window on Windows, and runs it instead of headless", async () => {
    expect(await defaultMode(install, "win32")).toBe("window");
    expect(windowsMode("window")).toEqual({ mode: "window" });
    expect(windowsMode("desktop")).toEqual({ mode: "desktop" });
    expect(windowsMode("headless")).toEqual({ mode: "window", note: expect.stringMatching(/headless mode needs Linux \(gamescope\)/) });
  });

  it("needs Linux for gamescope and falls back to desktop elsewhere", async () => {
    expect(await gamescopeBlocker(install, "darwin")).toMatch(/needs Linux/);
    expect(await defaultMode(install, "darwin")).toBe("desktop");
  });

  it("shows the gamescope window on the user's Wayland or X11 desktop, and none in headless mode", () => {
    expect(gamescopeBackend("window", { WAYLAND_DISPLAY: "wayland-1" })).toBe("wayland");
    expect(gamescopeBackend("window", { DISPLAY: ":0" })).toBe("sdl");
    expect(gamescopeBackend("headless", { WAYLAND_DISPLAY: "wayland-1" })).toBe("headless");
  });

  it("finds the Wine prefix an install's data folder lives in, so only that prefix's game is managed", () => {
    expect(winePrefix("/home/u/.local/share/Flarial/Linux/compatdata/pfx/drive_c/users/steamuser/AppData/Roaming/Minecraft Bedrock")).toBe(
      "/home/u/.local/share/Flarial/Linux/compatdata/pfx",
    );
    expect(winePrefix("C:\\Users\\u\\AppData\\Roaming\\Minecraft Bedrock")).toBeUndefined();
  });
});
