/**
 * Start, find, capture and stop the Bedrock client on every OS:
 * - Linux window / headless (Wine/Proton installs with a launch command): inside gamescope, either as a normal window
 *   on the user's desktop or with no window at all. Screenshots via `gamescopectl`, input via xdotool on gamescope's
 *   own XWayland, so the user's cursor and keyboard are never used;
 * - Windows window (the default; `desktop` is the same there): the game's own desktop window. Screenshots through
 *   PrintWindow, keyboard and mouse through `SendInput` (windows.ts), which only reaches the game while its window is
 *   in the foreground;
 * - desktop elsewhere: the install's launch command (or the user starts the game), no background input.
 * Launch state is persisted so other processes (CLI) can find it.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { dataDir } from "../../core/paths.ts";
import { findOnPath } from "../../core/which.ts";
import type { ClientInstall } from "./install.ts";
import type { InputTakeover } from "./player.ts";
import {
  belongsToInstall,
  chordKeys,
  ForegroundError,
  virtualKey,
  windowsGameProcesses,
  WindowsInputHelper,
  windowsKill,
  windowsMute,
  windowsScreenshot,
  type HelperCommand,
} from "./windows.ts";

const run = promisify(execFile);

/**
 * `window`: Linux: inside gamescope, shown as a normal window on your desktop (screenshots and input stay inside
 * gamescope). Windows: the game's own window (screenshots work while it is covered; input needs it in the foreground).
 * `headless`: Linux: inside gamescope with no window at all (muted by default). Windows has no gamescope and runs the
 * game's own window instead.
 * `desktop`: started directly, the way the launcher always starts it (on Windows the same as `window`).
 */
export type LaunchMode = "window" | "headless" | "desktop";

export interface LaunchState {
  mode: LaunchMode;
  startedAt: number;
  /** PID of the process we spawned (gamescope or the launch command); 0 when the user starts the game. */
  pid: number;
  argv: string[];
  world?: string;
  launchLog: string;
  /** gamescope only: its Wayland socket name (`gamescope-0`) and XWayland display (`:2`). */
  gamescopeDisplay?: string;
  xDisplay?: string;
  width?: number;
  height?: number;
  /** What sculkwire could not do itself, e.g. "start Minecraft and open the world". */
  notes: string[];
  /** PulseAudio/PipeWire null-sink module that swallows the game's audio; unloaded on stop. */
  muteModule?: number;
  /** Windows: mute the game's audio sessions once it runs (`muteWindowsGame`). */
  muteRequested?: boolean;
  /** Windows: the game process whose audio sessions sculkwire muted; unmuted on stop. */
  mutedPid?: number;
  /** The game process this launch manages, once it is running (Windows: picks the right window). */
  gamePid?: number;
}

export interface LaunchOptions {
  mode: LaunchMode;
  /** Silence the game's audio (Linux: a silent sink; Windows: its audio sessions). Default: on in headless mode. */
  mute?: boolean;
  /** Deeplink target: world folder name under minecraftWorlds. */
  levelId?: string;
  width?: number;
  height?: number;
  /** gamescope frame rate (window and headless modes). Default 60. */
  fps?: number;
  extraArgs?: string[];
}

const statePath = () => dataDir("client", "launch.json");

export async function readLaunchState(): Promise<LaunchState | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath(), "utf8"));
    if (parsed && typeof parsed === "object" && "mode" in parsed && "pid" in parsed) {
      // Our own state file: defaults cover fields older files lack.
      const defaults: LaunchState = { mode: "desktop", startedAt: 0, pid: 0, argv: [], launchLog: "", notes: [] };
      return Object.assign(defaults, parsed);
    }
  } catch {
    // none
  }
  return undefined;
}

async function writeLaunchState(state: LaunchState): Promise<void> {
  await mkdir(dataDir("client"), { recursive: true });
  await writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`);
}

/** The Wine prefix (`…/pfx`) an install's data folder lives in; undefined for native Windows installs. */
export function winePrefix(appData: string): string | undefined {
  const i = appData.search(/[\\/]drive_c[\\/]/);
  return i > 0 ? appData.slice(0, i) : undefined;
}

/**
 * Process ids of Minecraft.Windows.exe: native on Windows, the Wine process on Linux and macOS. With `install`, only
 * the game running from that install's Wine prefix counts, so a game you play from another launcher is left alone.
 */
export async function gamePids(install?: ClientInstall): Promise<number[]> {
  if (process.platform === "win32") {
    const procs = await windowsGameProcesses();
    return (install ? procs.filter((p) => belongsToInstall(p.path, install)) : procs).map((p) => p.pid);
  }
  if (process.platform === "darwin") {
    const { stdout } = await run("ps", ["-axo", "pid=,command="]);
    return stdout
      .split("\n")
      .filter((l) => /Minecraft\.Windows\.exe/i.test(l) && !/\bgrep\b/.test(l))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((n) => n > 0);
  }
  // Proton runs the game with WINEPREFIX=<prefix>/pfx/, where `pfx` links back to the prefix: compare real paths.
  const prefixPath = install ? winePrefix(install.appData) : undefined;
  const prefix = prefixPath ? await realpath(prefixPath).catch(() => prefixPath) : undefined;
  const out: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = await readFile(`/proc/${name}/cmdline`, "utf8");
      const argv0 = cmd.split("\0")[0] ?? "";
      if (!/Minecraft\.Windows\.exe$/i.test(argv0)) continue;
      if (prefix) {
        const env = await readFile(`/proc/${name}/environ`, "utf8");
        const wp = /(?:^|\0)WINEPREFIX=([^\0]*)/.exec(env)?.[1];
        if (wp && (await realpath(wp).catch(() => wp.replace(/\/+$/, ""))) !== prefix) continue;
      }
      out.push(Number(name));
    } catch {
      // process gone
    }
  }
  return out;
}

export function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The world deeplink for the install's channel. */
export function worldUri(levelId: string, preview: boolean): string {
  return `${preview ? "minecraft-preview" : "minecraft"}://connect?localLevelId=${encodeURIComponent(levelId)}`;
}

/** `-key value` activation arguments for Minecraft.Windows.exe. */
export function activationArgs(opts: Pick<LaunchOptions, "extraArgs">): string[] {
  return [...(opts.extraArgs ?? [])];
}

/**
 * Expand the install's launch command: `{args}` → activation arguments (dropped when none), `{uri}` → world
 * deeplink (appended when the command has no `{uri}`). The deeplink must come after the `-key value` pairs: the game
 * treats the first non-dash argument as the deeplink.
 */
export function launchArgv(template: readonly string[], args: readonly string[], uri: string | undefined): string[] {
  const out: string[] = [];
  let usedUri = false;
  for (const part of template) {
    if (part === "{args}") out.push(...args);
    else if (part.includes("{uri}")) {
      usedUri = true;
      if (uri) out.push(part.replace("{uri}", uri));
    } else out.push(part);
  }
  if (!usedUri && uri) out.push(uri);
  return out;
}

/** Parse gamescope's startup log for its Wayland socket and XWayland display. */
export function parseGamescopeLog(text: string): { gamescopeDisplay?: string; xDisplay?: string } {
  const out: { gamescopeDisplay?: string; xDisplay?: string } = {};
  const wl = /Running compositor on wayland display '([^']+)'/.exec(text);
  if (wl?.[1]) out.gamescopeDisplay = wl[1];
  const x = /Starting Xwayland on (:\d+)/.exec(text);
  if (x?.[1]) out.xDisplay = x[1];
  return out;
}

/** Why gamescope (Linux window or headless mode) is unavailable for this install, or undefined when it works. */
export async function gamescopeBlocker(install: ClientInstall, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (platform !== "linux") return "gamescope (window and off-screen modes) needs Linux";
  if (!install.wine) return "window and off-screen modes need a Wine/Proton install";
  if (!install.launch) return "window and off-screen modes need a launch command (SCULKWIRE_CLIENT_LAUNCH)";
  if (!findOnPath("gamescope", sessionEnv())) return "window and off-screen modes need gamescope on PATH";
  return undefined;
}

/**
 * Windows: `window` (the game's own window). Elsewhere: window mode when gamescope works and there is a desktop to
 * show it on, headless without one, else desktop.
 */
export async function defaultMode(install: ClientInstall, platform: NodeJS.Platform = process.platform): Promise<LaunchMode> {
  if (platform === "win32") return "window";
  if (await gamescopeBlocker(install, platform)) return "desktop";
  const env = sessionEnv();
  return env.WAYLAND_DISPLAY || env.DISPLAY ? "window" : "headless";
}

/** The mode a Windows launch runs in: the game's own window, also for `headless`, which needs gamescope. */
export function windowsMode(requested: LaunchMode): { mode: LaunchMode; note?: string } {
  if (requested !== "headless") return { mode: requested };
  return { mode: "window", note: "headless mode needs Linux (gamescope); running in the game's own window instead" };
}

/** gamescope's backend for a mode: its own window on the user's Wayland or X11 desktop, or none. */
export function gamescopeBackend(mode: "window" | "headless", env: NodeJS.ProcessEnv = sessionEnv()): string {
  if (mode === "headless") return "headless";
  return env.WAYLAND_DISPLAY ? "wayland" : "sdl";
}

/**
 * The desktop session's environment. MCP clients may start sculkwire with a trimmed environment; gamescope, pactl and
 * xdotool need XDG_RUNTIME_DIR to find the user's Wayland, PipeWire and gamescope sockets.
 */
export function sessionEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  if (!env.XDG_RUNTIME_DIR && process.platform === "linux" && typeof process.getuid === "function") {
    const dir = `/run/user/${process.getuid()}`;
    if (existsSync(dir)) env.XDG_RUNTIME_DIR = dir;
  }
  return env;
}

/** A silent PulseAudio/PipeWire sink for the game's audio; returns the module id to unload later. */
async function loadMuteSink(sink: string): Promise<number | undefined> {
  try {
    const { stdout } = await run("pactl", ["load-module", "module-null-sink", `sink_name=${sink}`, "sink_properties=device.description=sculkwire-muted-game"], {
      env: sessionEnv(),
    });
    const id = Number(stdout.trim());
    return Number.isInteger(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export async function launch(install: ClientInstall, opts: LaunchOptions): Promise<LaunchState> {
  if ((await gamePids(install)).length > 0) {
    throw new Error(
      `Minecraft from ${install.label} is already running. sculkwire needs that install to itself: close the game first, ` +
        "or keep playing on another install (another launcher or prefix) while sculkwire uses this one",
    );
  }
  const notes: string[] = [];
  let mode = opts.mode;
  // gamescope runs the game: Linux window and headless modes once nothing blocks them.
  let gamescope = false;
  if (process.platform === "win32") {
    const resolved = windowsMode(mode);
    mode = resolved.mode;
    if (resolved.note) notes.push(resolved.note);
  } else if (mode !== "desktop") {
    const blocker = await gamescopeBlocker(install);
    if (blocker) {
      notes.push(`${blocker}; running on the desktop instead`);
      mode = "desktop";
    } else gamescope = true;
  }
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const args = activationArgs(opts);
  if (args.length && !install.passesArgs) notes.push(`this launcher cannot pass ${args.join(" ")} to the game; ignored`);
  const uri = opts.levelId ? worldUri(opts.levelId, install.preview) : undefined;
  const launchLog = dataDir("client", "launch.log");
  const state: LaunchState = { mode, startedAt: Date.now(), pid: 0, argv: [], launchLog, width, height, notes };
  if (opts.levelId) state.world = opts.levelId;
  if (process.platform === "win32") {
    // The game's audio sessions exist only once it runs: the bridge mutes them then (muteWindowsGame).
    if (opts.mute ?? opts.mode === "headless") state.muteRequested = true;
  } else if (opts.mute && process.platform !== "linux") notes.push("muting needs Linux or Windows; the game's sound plays normally");
  if (!install.launch) {
    notes.push(
      `start Minecraft yourself${opts.levelId ? ` and open the world "${opts.levelId}"` : ""} ` +
        "(set SCULKWIRE_CLIENT_LAUNCH to let sculkwire start it)",
    );
    await writeLaunchState(state);
    return state;
  }

  if (install.launchLock && existsSync(install.launchLock) && process.platform === "linux") {
    // mcbe-gdk-installer holds this flock while the game runs; Wine children keep it a few seconds after a stop.
    // Launching while it is held exits silently ("already running"), so wait for it.
    try {
      await run("flock", ["-w", "60", install.launchLock, "true"]);
    } catch {
      throw new Error(`the installer's launch lock ${install.launchLock} stayed busy for 60 s; is another Minecraft instance starting?`);
    }
  }
  const game = launchArgv(install.launch, install.passesArgs ? args : [], uri);
  const argv = !gamescope
    ? game
    : [
        "gamescope",
        "--backend",
        gamescopeBackend(mode === "headless" ? "headless" : "window"),
        ...["-W", String(width), "-H", String(height), "-w", String(width), "-h", String(height)],
        ...["-r", String(opts.fps ?? 60)],
        "--",
        ...game,
      ];
  state.argv = argv;
  const env = sessionEnv();
  if ((opts.mute ?? mode === "headless") && process.platform === "linux") {
    const sink = "sculkwire_muted_game";
    const module = await loadMuteSink(sink);
    if (module !== undefined) {
      state.muteModule = module;
      env.PULSE_SINK = sink;
    } else notes.push("could not mute the game (pactl unavailable); its sound plays normally");
  }
  await mkdir(dataDir("client"), { recursive: true });
  const fd = openSync(launchLog, "w");
  const child = spawn(argv[0]!, argv.slice(1), { detached: process.platform !== "win32", stdio: ["ignore", fd, fd], env, windowsHide: true });
  closeSync(fd);
  child.unref();
  if (!child.pid) throw new Error(`could not start ${argv[0]}`);
  state.pid = child.pid;
  // Saved before waiting so a failed start can still be cleaned up (mute sink, gamescope).
  await writeLaunchState(state);
  if (gamescope) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const found = parseGamescopeLog(await readFile(launchLog, "utf8").catch(() => ""));
      if (found.gamescopeDisplay && found.xDisplay) {
        Object.assign(state, found);
        break;
      }
      if (!isAlive(child.pid)) throw new Error(`gamescope exited early; see ${launchLog}`);
      await sleep(250);
    }
    if (!state.gamescopeDisplay) throw new Error(`gamescope did not report its displays within 15 s; see ${launchLog}`);
  }
  await writeLaunchState(state);
  return state;
}

/** Wait for this install's game process to exist (launchers take a few seconds; a user may take minutes). */
export async function waitForGame(install: ClientInstall, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [pid] = await gamePids(install);
    if (pid) return pid;
    if (Date.now() > deadline) throw new Error(`Minecraft.Windows.exe did not start within ${timeoutMs} ms`);
    await sleep(500);
  }
}

/**
 * Windows: mute the game's audio sessions (WASAPI), retrying for `timeoutMs` because they appear only once the game
 * opened its audio device. Resolves to a note for the user when the game could not be muted, else undefined.
 */
export async function muteWindowsGame(state: LaunchState, pid: number, timeoutMs = 20_000): Promise<string | undefined> {
  let changed: number;
  try {
    changed = await windowsMute([pid], true, timeoutMs);
  } catch (e) {
    return `could not mute the game (${e instanceof Error ? e.message : String(e)}); its sound plays normally`;
  }
  if (changed < 0) return "did not mute the game: Windows has no active audio output device";
  if (changed === 0) return `could not mute the game: it opened no audio session within ${Math.round(timeoutMs / 1000)} s; its sound plays normally`;
  state.mutedPid = pid;
  await writeLaunchState(state);
  return undefined;
}

/**
 * Stop through the install's stop command, else ask this install's game to close, then force it. Games running from
 * other installs are never touched.
 */
export async function stop(install: ClientInstall): Promise<{ stopped: boolean; message: string }> {
  const state = await readLaunchState();
  const before = await gamePids(install);
  closeWindowsInput();
  // Windows can keep an app's mute in its volume mixer: unmute while the game still runs, so it plays with sound later.
  if (process.platform === "win32" && state?.mutedPid && before.includes(state.mutedPid)) {
    await windowsMute([state.mutedPid], false, 0).catch(() => undefined);
  }
  // The stop command's own output can contradict what happened (mcbe-gdk-installer says "Minecraft is not running."
  // for a game started inside gamescope), so it only shows when the game was absent or survived.
  let toolOutput = "";
  if (install.stop) {
    try {
      const { stdout, stderr } = await run(install.stop[0]!, install.stop.slice(1), { timeout: 60_000, windowsHide: true });
      toolOutput = `${stdout}${stderr}`.trim();
    } catch (e) {
      toolOutput = e instanceof Error ? e.message : String(e);
    }
  } else {
    if (process.platform === "win32") await windowsKill(before, false);
    else for (const pid of before) process.kill(pid, "SIGTERM");
  }
  const deadline = Date.now() + 15_000;
  while ((await gamePids(install)).length > 0 && Date.now() < deadline) await sleep(500);
  const left = await gamePids(install);
  if (left.length) {
    if (process.platform === "win32") await windowsKill(left, true);
    else for (const pid of left) process.kill(pid, "SIGKILL");
  }
  // mcbe-gdk-installer's supervisor disarms its GPU-safety marker when the game returns; killing it first leaves the
  // marker and the installer then refuses to launch until a reboot. So give our spawned process (gamescope or the
  // launch command) time to exit on its own, and only then terminate it (never its process group).
  if (state && state.pid > 0) {
    const exitDeadline = Date.now() + 60_000;
    while (isAlive(state.pid) && Date.now() < exitDeadline) await sleep(500);
    if (isAlive(state.pid)) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  if (state?.muteModule !== undefined) await run("pactl", ["unload-module", String(state.muteModule)], { env: sessionEnv() }).catch(() => undefined);
  const stopped = (await gamePids(install)).length === 0;
  if (stopped) await rm(statePath(), { force: true });
  const n = before.length;
  let message: string;
  if (n === 0) message = "the game was not running";
  else if (!stopped) message = `the game is still running after asking ${n} process(es) to close and forcing them`;
  else if (left.length) message = `closed the game (${n} process(es)), forced after it ignored the request to close for 15 s`;
  else message = `closed the game (${n} process(es))`;
  if (toolOutput && (n === 0 || !stopped)) message += `. Stop command said: ${toolOutput}`;
  return { stopped, message };
}

/** Run xdotool against gamescope's private XWayland display. */
async function xdotool(state: LaunchState, args: string[]): Promise<string> {
  if (!state.xDisplay) throw new Error("input needs window or off-screen mode (gamescope)");
  const { stdout } = await run("xdotool", args, { env: { ...sessionEnv(), DISPLAY: state.xDisplay }, timeout: 15_000 });
  return stdout.trim();
}

async function gamescopeWindow(state: LaunchState): Promise<string> {
  const window = (await xdotool(state, ["search", "--name", "^Minecraft$"])).split("\n")[0];
  if (!window) throw new Error("game window not found on the gamescope display");
  return window;
}

/** Whether keyboard and mouse input can reach this launch's game: gamescope's display on Linux, SendInput on Windows. */
export function hasInput(state: LaunchState): boolean {
  return !!state.xDisplay || process.platform === "win32";
}

/** Where keyboard/mouse input can go for this launch, or an explanation why it cannot. */
/** Where `sendInput` delivers: xdotool into gamescope's own display, or SendInput on Windows. */
export type InputRoute = "gamescope" | "windows";

function inputRoute(state: LaunchState): InputRoute {
  if (state.xDisplay) return "gamescope";
  if (process.platform === "win32") return "windows";
  throw new Error(
    "input needs window or off-screen mode on Linux, or Windows; a plain Linux/macOS desktop window cannot receive background input",
  );
}

/** The game process this launch manages; Windows input and screenshots target its window. */
function gamePidOf(state: LaunchState): number {
  if (!state.gamePid) throw new Error("the game process is not running yet");
  return state.gamePid;
}

/** One Windows input helper per game process, started on first use. */
const helpers = new Map<number, WindowsInputHelper>();

async function windowsHelper(state: LaunchState): Promise<WindowsInputHelper> {
  const pid = gamePidOf(state);
  let helper = helpers.get(pid);
  if (!helper?.alive) {
    helper = new WindowsInputHelper(pid);
    helpers.set(pid, helper);
  }
  await helper.ready;
  return helper;
}

/** End every Windows input helper; each lets go of what it holds (the game stopped). */
export function closeWindowsInput(): void {
  for (const helper of helpers.values()) helper.close();
  helpers.clear();
}

/** A command that must reach the game: the helper refusing it (game window not in the foreground) throws. */
async function deliver(helper: WindowsInputHelper, command: HelperCommand): Promise<void> {
  if ((await helper.request(command)) === "blocked") throw new ForegroundError();
}

/** Chords one after another: each chord's keys go down in order and come up in reverse, also after a failure. */
async function pressChords(helper: WindowsInputHelper, chords: readonly number[][]): Promise<void> {
  for (const [i, chord] of chords.entries()) {
    if (i) await sleep(30);
    const held: number[] = [];
    try {
      for (const key of chord) {
        await deliver(helper, { verb: "down", key });
        held.push(key);
        await sleep(10);
      }
      await sleep(40);
    } finally {
      for (const key of held.reverse()) await helper.request({ verb: "up", key }).catch(() => undefined);
    }
  }
}

/** A one-shot Windows action: bring the game window to the foreground, then act. */
async function windowsOneShot(state: LaunchState, act: (helper: WindowsInputHelper) => Promise<void>): Promise<void> {
  const helper = await windowsHelper(state);
  await helper.request({ verb: "activate" });
  await act(helper);
}

/** Type a chat command into the game (opens chat with `/`). */
export async function typeChatCommand(state: LaunchState, command: string): Promise<void> {
  const text = command.replace(/^\//, "");
  if (inputRoute(state) === "windows") {
    await windowsOneShot(state, async (helper) => {
      await pressChords(helper, [[virtualKey("slash")]]);
      await sleep(1200);
      await deliver(helper, { verb: "text", text });
      await sleep(300);
      await pressChords(helper, [[virtualKey("Return")]]);
    });
    return;
  }
  const window = await gamescopeWindow(state);
  await xdotool(state, ["mousemove", "--window", window, String(Math.floor((state.width ?? 1280) / 2)), String(Math.floor((state.height ?? 720) / 2))]);
  await sleep(300);
  await xdotool(state, ["key", "slash"]);
  await sleep(1200);
  await xdotool(state, ["type", "--delay", "30", text]);
  await sleep(300);
  await xdotool(state, ["key", "Return"]);
}

/**
 * Windows only: input reaches the game only while its window is in the foreground. `userHasControl` is true while it
 * is not, `onTakeover` fires on each loss and `untilControl` waits for the window to come back (the input lock
 * interface, so a play job pauses the same way as on an F9 takeover).
 */
export interface ForegroundGate extends InputTakeover {
  /** Bring the game window to the foreground: once when an action or job starts, never in the middle of one. */
  activate(): Promise<void>;
}

/** Held keys, relative mouse look and mouse buttons: what a player's hands do. */
export interface PlayerInput {
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  /** Relative mouse motion in pixels: +x turns right, +y looks down. */
  look(dx: number, dy: number): Promise<void>;
  button(button: 1 | 2 | 3, down: boolean): Promise<void>;
  /** End the input route's helper process, if it has one (the game stopped). */
  close?(): void;
  /** Windows: the foreground the input depends on. Absent where input does not need it (gamescope). */
  foreground?: ForegroundGate;
  /** Why this game has no keyboard and mouse route (a Linux desktop window); every method then rejects with it. */
  unavailable?: string;
}

/**
 * The keyboard and mouse route of a game that has none, for a player driven through the engine route alone: every
 * call rejects with `reason`, and `close` does nothing.
 */
export function unavailableInput(reason: string): PlayerInput {
  const refuse = async (): Promise<never> => Promise.reject(new Error(reason));
  return { keyDown: refuse, keyUp: refuse, look: refuse, button: refuse, close: () => undefined, unavailable: reason };
}

/**
 * One long-lived `xdotool -` per gamescope display. It reads commands from stdin and runs each as it arrives, so a
 * mouse step or key event costs one line written to a pipe instead of a process spawn. A probe (`getmouselocation`)
 * has to answer before the pipe is trusted, and when the process dies the caller falls back to one xdotool per command.
 */
class XdotoolPipe {
  readonly #child: ChildProcess;
  readonly ready: Promise<boolean>;
  #alive = true;

  constructor(display: string) {
    this.#child = spawn("xdotool", ["-"], { env: { ...sessionEnv(), DISPLAY: display }, stdio: ["pipe", "pipe", "ignore"] });
    const child = this.#child;
    child.on("error", () => this.close());
    child.on("exit", () => (this.#alive = false));
    child.stdin?.on("error", () => this.close());
    const probe = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => probe.resolve(false), 3_000).unref();
    child.stdout?.once("data", () => probe.resolve(true));
    child.once("exit", () => probe.resolve(false));
    this.ready = probe.promise.finally(() => clearTimeout(timer));
    this.#write("getmouselocation");
    // Input for a running game must never keep a finished CLI or test process alive.
    child.unref();
    (child.stdin as { unref?: () => void } | null)?.unref?.();
    (child.stdout as { unref?: () => void } | null)?.unref?.();
  }

  get alive(): boolean {
    return this.#alive;
  }

  #write(line: string): boolean {
    if (!this.#alive || !this.#child.stdin?.writable) return false;
    this.#child.stdin.write(`${line}\n`);
    return true;
  }

  /** Send one command; false when the pipe cannot take it and the caller should spawn xdotool instead. */
  async send(args: readonly string[]): Promise<boolean> {
    if (!(await this.ready)) {
      this.close();
      return false;
    }
    return this.#write(args.join(" "));
  }

  close(): void {
    if (!this.#alive) return;
    this.#alive = false;
    this.#child.stdin?.end();
    this.#child.kill();
  }
}

const pipes = new Map<string, XdotoolPipe>();

/** xdotool commands without output, through the display's pipe when it works, else one process per command. */
async function xdotoolFast(state: LaunchState, args: string[]): Promise<void> {
  const display = state.xDisplay;
  if (!display) throw new Error("input needs window or off-screen mode (gamescope)");
  let pipe = pipes.get(display);
  if (!pipe) {
    pipe = new XdotoolPipe(display);
    pipes.set(display, pipe);
  }
  if (pipe.alive && (await pipe.send(args))) return;
  await xdotool(state, args);
}

/**
 * Windows player input through the game's input helper (SendInput). Nothing is sent while the game window is not in
 * the foreground: presses and mouse motion then throw ForegroundError, and the helper has already let go of
 * everything. After a loss the next press throws once even when the window is back, so the action that thought it
 * still held its keys stops and lets go of them (the helper did already). Releases never throw for focus.
 */
function windowsPlayerInput(state: LaunchState): PlayerInput {
  let lostSinceActivate = false;
  let watched: WindowsInputHelper | undefined;
  const takeoverListeners = new Set<() => void>();
  const helper = async (): Promise<WindowsInputHelper> => {
    const h = await windowsHelper(state);
    if (watched !== h) {
      watched = h;
      h.onLost(() => {
        lostSinceActivate = true;
        for (const l of [...takeoverListeners]) l();
      });
    }
    return h;
  };
  const press = async (command: HelperCommand): Promise<void> => {
    const h = await helper();
    if (lostSinceActivate) {
      lostSinceActivate = false;
      throw new ForegroundError();
    }
    await deliver(h, command);
  };
  const current = () => (state.gamePid ? helpers.get(state.gamePid) : undefined);
  // A release goes to the running helper only: one that is gone holds nothing, and starting one would outlive the game.
  const release = async (command: HelperCommand): Promise<void> => {
    const h = current();
    if (h?.alive) await h.request(command);
  };
  return {
    keyDown: (key) => press({ verb: "down", key: virtualKey(key) }),
    keyUp: (key) => release({ verb: "up", key: virtualKey(key) }),
    look: async (dx, dy) => {
      const x = Math.round(dx);
      const y = Math.round(dy);
      if (x || y) await press({ verb: "move", x, y });
    },
    button: (button, down) => (down ? press({ verb: "bdown", button }) : release({ verb: "bup", button })),
    close: () => {
      current()?.close();
      if (state.gamePid) helpers.delete(state.gamePid);
    },
    foreground: {
      get userHasControl() {
        const h = current();
        return h ? !h.foreground : false;
      },
      onTakeover: (listener) => {
        takeoverListeners.add(listener);
        return () => takeoverListeners.delete(listener);
      },
      untilControl: async (signal) => {
        await current()?.untilForeground(signal);
      },
      activate: async () => {
        await (await helper()).request({ verb: "activate" });
        lostSinceActivate = false;
      },
    },
  };
}

/**
 * Player input. Linux window or off-screen mode: gamescope's own XWayland, never the user's desktop. Windows: the
 * system keyboard and mouse through SendInput while the game window is in the foreground. A Linux or macOS desktop
 * window has no route for held keys and mouse look.
 */
export function playerInput(state: LaunchState): PlayerInput {
  if (process.platform === "win32") return windowsPlayerInput(state);
  const display = state.xDisplay;
  if (!display) {
    throw new Error("player control needs window or off-screen mode on Linux (game_launch with display: window or headless), or Windows");
  }
  return {
    keyDown: (key) => xdotoolFast(state, ["keydown", key]),
    keyUp: (key) => xdotoolFast(state, ["keyup", key]),
    look: async (dx, dy) => {
      const x = Math.round(dx);
      const y = Math.round(dy);
      if (x || y) await xdotoolFast(state, ["mousemove_relative", "--", String(x), String(y)]);
    },
    button: (button, down) => xdotoolFast(state, [down ? "mousedown" : "mouseup", String(button)]),
    close: () => {
      pipes.get(display)?.close();
      pipes.delete(display);
    },
  };
}

export type InputAction =
  | { action: "key"; keys: string }
  | { action: "type"; text: string }
  | { action: "click"; x: number; y: number; button?: 1 | 2 | 3 }
  | { action: "move"; x: number; y: number };

/**
 * Keyboard/mouse into the game. Coordinates are game-window client pixels (same frame as `screenshot`).
 * Linux window/off-screen mode: gamescope's private XWayland (clicks use real button down/up, the game ignores
 * synthetic XSendEvent clicks). Windows: SendInput after bringing the game window to the foreground; it fails with
 * "the game window is not in the foreground" when the window loses it before the input is sent. Returns the route taken.
 */
export async function sendInput(state: LaunchState, input: InputAction): Promise<InputRoute> {
  if (inputRoute(state) === "windows") {
    // Key names are checked before anything is sent.
    const chords = input.action === "key" ? input.keys.split(/\s+/).filter(Boolean).map(chordKeys) : [];
    await windowsOneShot(state, async (helper) => {
      if (input.action === "key") await pressChords(helper, chords);
      else if (input.action === "type") await deliver(helper, { verb: "text", text: input.text });
      else {
        await deliver(helper, { verb: "at", x: input.x, y: input.y });
        if (input.action === "click") {
          const button = input.button ?? 1;
          await deliver(helper, { verb: "bdown", button });
          await sleep(60);
          await helper.request({ verb: "bup", button });
        }
      }
    });
    return "windows";
  }
  const window = await gamescopeWindow(state);
  if (input.action === "key") await xdotool(state, ["key", "--window", window, ...input.keys.split(/\s+/).filter(Boolean)]);
  else if (input.action === "type") await xdotool(state, ["type", "--delay", "30", input.text]);
  else {
    await xdotool(state, ["mousemove", "--window", window, String(Math.round(input.x)), String(Math.round(input.y))]);
    if (input.action === "click") {
      const button = String(input.button ?? 1);
      await xdotool(state, ["mousedown", button]);
      await sleep(60);
      await xdotool(state, ["mouseup", button]);
    }
  }
  return "gamescope";
}

/** Wait until a file another process writes has a stable non-zero size. */
async function waitForFile(path: string, what: string): Promise<{ path: string; bytes: number }> {
  let prev = -1;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const size = existsSync(path) ? (await stat(path)).size : 0;
    if (size > 0 && size === prev) return { path, bytes: size };
    prev = size;
    await sleep(250);
  }
  throw new Error(`${what} did not write ${path} within 15 s`);
}

/**
 * PNG of the game. Linux window/off-screen mode: gamescope's composited output (`gamescopectl screenshot` returns before
 * the file is complete). Windows: PrintWindow of the game window's client area, which works while it is covered; when
 * that frame is empty (one colour) the client area is copied from the screen, which needs the window in the foreground.
 */
export async function screenshot(state: LaunchState, path: string): Promise<{ path: string; bytes: number }> {
  await rm(path, { force: true });
  if (state.gamescopeDisplay) {
    await run("gamescopectl", ["screenshot", path], { env: { ...sessionEnv(), GAMESCOPE_WAYLAND_DISPLAY: state.gamescopeDisplay }, timeout: 10_000 });
    return waitForFile(path, "gamescope");
  }
  if (process.platform === "win32") {
    await windowsScreenshot(path, gamePidOf(state));
    return waitForFile(path, "the screenshot helper");
  }
  throw new Error(
    "screenshots need window or off-screen mode on Linux, or Windows; a plain Linux/macOS desktop window cannot be captured in the background",
  );
}
