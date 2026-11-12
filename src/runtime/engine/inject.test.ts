import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { gamePath } from "./gamepath.ts";
import { agentPrefix, agentWine, injectorCommand } from "./inject.ts";

function install(appData: string, kind: ClientInstall["kind"], wine: boolean): ClientInstall {
  return {
    kind,
    label: kind === "windows" ? "Windows" : kind,
    appData,
    sharedComMojang: "",
    userComMojang: "",
    logsDir: "",
    passesArgs: wine,
    wine,
    preview: false,
    gameDir: "/games/mc",
  };
}

/** A file at `path` with empty content: the Wine lookup only asks whether it is there. */
function touch(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  return path;
}

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function tempRoot(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "sculkwire-inject-"));
  return dir;
}

describe("injector command", () => {
  it("runs the injector natively on Windows with the DLL's native path", () => {
    const appData = "C:\\Users\\Steve\\AppData\\Roaming\\Minecraft Bedrock";
    const dll = "C:\\Users\\Steve\\AppData\\Local\\sculkwire\\cache\\agent\\h1\\sculkwire-agent-h1.dll";
    const injector = "C:\\Users\\Steve\\AppData\\Local\\sculkwire\\cache\\agent\\h1\\sculkwire-injector.exe";
    const command = injectorCommand(install(appData, "windows", false), injector, dll, "Minecraft.Windows.exe", "win32", { env: {} });
    expect(command.cmd).toBe(injector);
    expect(command.args).toEqual(["Minecraft.Windows.exe", dll]);
    expect(command.prefix).toBeUndefined();
    expect(command.wine).toBeUndefined();
    expect(command.env.WINEPREFIX).toBe(process.env.WINEPREFIX);
  });

  it("runs the injector with the install's own Proton inside the prefix the game runs in", async () => {
    const root = join(await tempRoot(), "Flarial", "Linux");
    const appData = join(root, "compatdata", "pfx", "drive_c", "users", "steamuser", "AppData", "Roaming", "Minecraft Bedrock");
    mkdirSync(appData, { recursive: true });
    // Proton links `<prefix>/pfx` back to the prefix, and umu-run sets WINEPREFIX to that nested path.
    symlinkSync(".", join(root, "compatdata", "pfx", "pfx"));
    const wine = touch(join(root, "proton", "GDK-Proton-xuser", "files", "bin", "wine"));
    const dll = join(root, "cache", "sculkwire-agent-h1.dll");
    const command = injectorCommand(install(appData, "wine-prefix", true), "/cache/sculkwire-injector.exe", dll, "Minecraft.Windows.exe", "linux", {
      env: {},
    });
    expect(command.cmd).toBe(wine);
    expect(command.args).toEqual(["/cache/sculkwire-injector.exe", "Minecraft.Windows.exe", gamePath(dll, "linux")]);
    expect(command.args[2]).toMatch(/^Z:\\/);
    // The link resolves to the same folder, so the injector joins the wineserver the game is already talking to.
    expect(command.prefix).toBe(join(root, "compatdata", "pfx"));
    expect(command.env.WINEPREFIX).toBe(join(root, "compatdata", "pfx"));
    expect(command.env.WINEDEBUG).toBe("-all");
  });

  it("finds the engine of an mcbe-gdk-installer install beside its profile", async () => {
    const installerRoot = join(await tempRoot(), "mcbe-gdk-linux");
    const appData = join(installerRoot, "profile", "compatdata", "pfx", "drive_c", "users", "steamuser", "AppData", "Roaming", "Minecraft Bedrock");
    mkdirSync(appData, { recursive: true });
    const wine = touch(join(installerRoot, "engine", "GDK-Proton-mcbe-gdk", "files", "bin", "wine"));
    const check = { env: {}, installerRoot: () => installerRoot };
    const fromInstall = install(appData, "mcbe-gdk-installer", true);
    expect(agentPrefix(fromInstall, check)).toBe(join(installerRoot, "profile", "compatdata", "pfx"));
    expect(agentWine(fromInstall, check)).toBe(wine);
  });

  it("prefers SCULKWIRE_WINE, and refuses a path that is not there", async () => {
    const root = await tempRoot();
    const appData = join(root, "compatdata", "pfx", "drive_c", "users", "steamuser", "AppData", "Roaming", "Minecraft Bedrock");
    mkdirSync(appData, { recursive: true });
    const fromInstall = install(appData, "wine-prefix", true);
    touch(join(root, "proton", "GDK-Proton-xuser", "files", "bin", "wine"));
    const chosen = touch(join(root, "wine"));
    expect(agentWine(fromInstall, { env: { SCULKWIRE_WINE: chosen } })).toBe(chosen);
    expect(() => agentWine(fromInstall, { env: { SCULKWIRE_WINE: join(root, "absent") } })).toThrow(/SCULKWIRE_WINE does not exist/);
  });

  it("falls back to wine on PATH when the install has no engine of its own", async () => {
    const root = await tempRoot();
    const appData = join(root, "compatdata", "pfx", "drive_c", "users", "steamuser", "AppData", "Roaming", "Minecraft Bedrock");
    mkdirSync(appData, { recursive: true });
    const command = injectorCommand(install(appData, "wine-prefix", true), "/cache/sculkwire-injector.exe", "/cache/a.dll", "Minecraft.Windows.exe", "linux", {
      env: {},
      installerRoot: () => join(root, "no-installer"),
    });
    expect(command.cmd).toBe("wine");
    expect(command.env.WINEPREFIX).toBe(join(root, "compatdata", "pfx"));
    expect(command.env.LD_LIBRARY_PATH).toBeUndefined();
  });
});
