import { describe, expect, it } from "vitest";
import { defaultMode, gamescopeArgv, gamescopeBackend, gamescopeBlocker, launchArgv, parseGamescopeLog, windowsMode, worldUri } from "./launcher.ts";

describe("launch arguments", () => {
  it("puts the encoded deeplink where the command says {uri}", () => {
    expect(launchArgv(["mcbe-gdk-linux", "launch", "{uri}"], worldUri("sculkwire-a b", false))).toEqual([
      "mcbe-gdk-linux",
      "launch",
      "minecraft://connect?localLevelId=sculkwire-a%20b",
    ]);
  });

  it("appends the deeplink when the command has no {uri}, uses the preview scheme, and drops {uri} without a world", () => {
    expect(launchArgv(["launcher", "--play"], worldUri("w", true))).toEqual(["launcher", "--play", "minecraft-preview://connect?localLevelId=w"]);
    expect(launchArgv(["cmd", "/c", "start", '""', "{uri}"], undefined)).toEqual(["cmd", "/c", "start", '""']);
  });

  it("drops an {args} part, which older launch commands still carry", () => {
    expect(launchArgv(["launcher", "{args}", "{uri}"], worldUri("w", false))).toEqual(["launcher", "minecraft://connect?localLevelId=w"]);
  });

  it("reads gamescope's displays from its log", () => {
    const log = "x\n[gamescope] [Info]  wlserver: Running compositor on wayland display 'gamescope-1'\n[gamescope] [Info]  wlserver: [xwayland/server.c:108] Starting Xwayland on :3\n";
    expect(parseGamescopeLog(log)).toEqual({ gamescopeDisplay: "gamescope-1", xDisplay: ":3" });
  });
});

describe("launch modes", () => {
  const install = { kind: "windows", label: "Windows", appData: "", sharedComMojang: "", userComMojang: "", logsDir: "", wine: false, preview: false } as const;

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

  it("runs the game inside gamescope at the requested size, its window forced to the nested display", () => {
    expect(gamescopeArgv("wayland", 1920, 1080, 60, ["mcbe-gdk-linux", "launch"])).toEqual([
      "gamescope",
      ...["--backend", "wayland"],
      ...["-W", "1920", "-H", "1080", "-w", "1920", "-h", "1080"],
      ...["-r", "60"],
      "--force-windows-fullscreen",
      "--",
      "mcbe-gdk-linux",
      "launch",
    ]);
  });
});
