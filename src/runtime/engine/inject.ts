/**
 * Injects the built agent DLL into the running game with the injector exe, which finds the process by executable name
 * and loads the DLL with `CreateRemoteThread(LoadLibraryW)`.
 *
 * - Windows: the injector runs natively and gets the DLL's native path.
 * - Linux and macOS (any Wine or Proton install sculkwire finds: Flarial, mcbe-gdk-installer, Bottles, Lutris…): the
 *   injector runs on the Wine binary of the install's own Proton/Wine engine, with the prefix the game runs in.
 *   Proton's real prefix is the nested `<prefix>/pfx` that umu-run sets as `WINEPREFIX` (a link back to the prefix
 *   folder), so the injector joins the wineserver the game already talks to instead of starting a second one. The DLL
 *   path is Wine's `Z:` mapping (`gamePath`).
 *
 * The game has to be running: the injector fails when it finds no `Minecraft.Windows.exe`.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { findInstall, installerRoot, type ClientInstall } from "../client/install.ts";
import { winePrefix } from "../client/launcher.ts";
import { gamePath } from "./gamepath.ts";
import { buildAgent, type AgentBuild } from "./build.ts";

export class AgentInjectError extends Error {
  readonly stage: "prerequisite" | "prefix" | "wine" | "inject";
  constructor(stage: AgentInjectError["stage"], message: string) {
    super(message);
    this.stage = stage;
  }
}

export interface InjectionResult {
  /** Windows pid (the Wine pid on Linux) of the process the injector loaded the DLL into. */
  pid: number;
  /** The Wine prefix and binary the injector ran with; absent on Windows. */
  prefix?: string;
  wine?: string;
  dll: string;
  exe: string;
  stdout: string;
  stderr: string;
}

/** Filesystem questions the Wine lookup asks, so a test can answer them without the real layout. */
export interface WineLookup {
  exists?: (path: string) => boolean;
  /** Directory names inside `path`, empty when it cannot be listed. */
  dirs?: (path: string) => string[];
  realpath?: (path: string) => string;
  env?: NodeJS.ProcessEnv;
  /** The mcbe-gdk-installer root, which keeps its engine beside the profile rather than beside the prefix. */
  installerRoot?: () => string;
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The Wine prefix the game runs in: `<prefix>/pfx` when umu-run or Proton created it (the game's `WINEPREFIX`,
 * a link back to the prefix), else the prefix folder itself. Resolved to its real path, so the path handed to Wine is
 * the one the running wineserver was started with.
 */
export function agentPrefix(install: ClientInstall, check: WineLookup = {}): string {
  const exists = check.exists ?? existsSync;
  const outer = winePrefix(install.appData);
  if (!outer) throw new AgentInjectError("prefix", `install ${install.label} is not inside a Wine prefix (appData: ${install.appData})`);
  const nested = join(outer, "pfx");
  const prefix = exists(nested) ? nested : outer;
  try {
    return (check.realpath ?? realpathSync)(prefix);
  } catch {
    return prefix;
  }
}

/**
 * The install's Proton/Wine binary: `SCULKWIRE_WINE` when set, else the engine shipped next to the install's prefix
 * (`<root>/proton/<engine>/files/bin/wine` for Flarial and other umu installs, `<root>/engine/<engine>/files/bin/wine`
 * for mcbe-gdk-installer), else `wine` on PATH. The game's own binary matters: a different Wine build starts a second
 * wineserver and the injector would not see the running game.
 */
export function agentWine(install: ClientInstall, check: WineLookup = {}): string {
  const env = check.env ?? process.env;
  const exists = check.exists ?? existsSync;
  const dirs = check.dirs ?? listDirs;
  const explicit = env.SCULKWIRE_WINE?.trim();
  if (explicit) {
    if (!exists(explicit)) throw new AgentInjectError("prerequisite", `SCULKWIRE_WINE does not exist: ${explicit}`);
    return explicit;
  }
  const roots: string[] = [];
  try {
    // The launcher keeps its engines beside the data folder: `<root>/compatdata/pfx` → `<root>`.
    const parent = dirname(agentPrefix(install, check));
    if (basename(parent) === "compatdata") roots.push(dirname(parent));
  } catch {
    // No Wine prefix at all: only an engine next to the game folder could still apply.
  }
  // mcbe-gdk-installer keeps its engine at `<root>/engine/...`, away from the profile's data folder.
  if (install.kind === "mcbe-gdk-installer") roots.push((check.installerRoot ?? installerRoot)());
  for (const root of roots) {
    for (const folder of ["proton", "engine"]) {
      for (const engine of dirs(join(root, folder))) {
        const wine = join(root, folder, engine, "files", "bin", "wine");
        if (exists(wine)) return wine;
      }
    }
  }
  return "wine";
}

/** Proton's Wine needs its own `lib/wine/x86_64-unix` on LD_LIBRARY_PATH; system Wine does not. */
function wineEnv(wine: string, prefix: string): NodeJS.ProcessEnv {
  const lib = join(dirname(dirname(wine)), "lib", "wine", "x86_64-unix");
  const env: NodeJS.ProcessEnv = { ...process.env, WINEPREFIX: prefix, WINEDEBUG: "-all" };
  if (existsSync(lib)) env.LD_LIBRARY_PATH = lib;
  return env;
}

/** How the injector runs: the command, its arguments and environment, and the Wine route's prefix and binary. */
export interface InjectorCommand {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  prefix?: string;
  wine?: string;
}

/**
 * The injector invocation for `install` on `platform`: native on Windows, inside the install's own Wine prefix
 * elsewhere. `env` carries the `WINEPREFIX` the game runs with, which is what makes the injector join its wineserver.
 */
export function injectorCommand(
  install: ClientInstall,
  injector: string,
  dll: string,
  exe: string,
  platform: NodeJS.Platform = process.platform,
  check: WineLookup = {},
): InjectorCommand {
  if (platform === "win32") return { cmd: injector, args: [exe, gamePath(dll, platform)], env: process.env };
  const prefix = agentPrefix(install, check);
  const wine = agentWine(install, check);
  return { cmd: wine, args: [injector, exe, gamePath(dll, platform)], env: wineEnv(wine, prefix), prefix, wine };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const { promise, resolve: done } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>();
  const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString("utf8")).slice(-16_000);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-16_000);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  child.on("error", (err) => {
    clearTimeout(timer);
    done({ code: null, stdout, stderr: `${cmd}: ${err.message}`, timedOut: false });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    done({ code, stdout, stderr, timedOut });
  });
  return promise;
}

export interface InjectOptions {
  dll: string;
  injector: string;
  /** Executable name of the game process, default `Minecraft.Windows.exe`. */
  exe?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  check?: WineLookup;
}

/** Runs the injector for `install`. Throws when the process is absent or LoadLibraryW fails. */
export async function injectAgent(install: ClientInstall, options: InjectOptions): Promise<InjectionResult> {
  if (!existsSync(options.dll)) throw new AgentInjectError("prerequisite", `agent DLL does not exist: ${options.dll}`);
  if (!existsSync(options.injector)) throw new AgentInjectError("prerequisite", `injector does not exist: ${options.injector}`);
  const exe = options.exe ?? "Minecraft.Windows.exe";
  const command = injectorCommand(install, options.injector, options.dll, exe, options.platform ?? process.platform, options.check);
  const result = await run(command.cmd, command.args, command.env, options.timeoutMs ?? 90_000);
  const ok = /^OK\s+(\d+)/m.exec(result.stdout);
  if (result.code !== 0 || !ok) {
    const why = result.timedOut ? "injector timed out" : `injector exit code ${result.code}`;
    const route = command.wine ? ` (wine: ${command.wine}, prefix: ${command.prefix})` : "";
    throw new AgentInjectError("inject", `${why}: ${(result.stdout || result.stderr || "(no output)").trim()}${route}`);
  }
  const injected: InjectionResult = { pid: Number(ok[1]), dll: options.dll, exe, stdout: result.stdout, stderr: result.stderr };
  if (command.prefix) injected.prefix = command.prefix;
  if (command.wine) injected.wine = command.wine;
  return injected;
}

export interface InjectClientOptions {
  install?: ClientInstall;
  build?: AgentBuild;
  exe?: string;
  timeoutMs?: number;
}

/** `findInstall()` + `buildAgent()` + injection: the one call a CLI/MCP tool needs. */
export async function injectClient(options: InjectClientOptions = {}): Promise<InjectionResult & { build: AgentBuild }> {
  const install = options.install ?? (await findInstall());
  const build = options.build ?? (await buildAgent());
  const injected = await injectAgent(install, { dll: build.dll, injector: build.injector, exe: options.exe, timeoutMs: options.timeoutMs });
  return { ...injected, build };
}
