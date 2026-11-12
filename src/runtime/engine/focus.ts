/**
 * Host focus of the game window. Inside Wine under gamescope the game never sees the desktop's focus changes, so a
 * controller (which no window message carries) reached the game from any window. sculkwire watches the desktop and
 * the injected agent (`input.focus`) keeps polled input out while the game window is not focused.
 *
 * Backends:
 * - KDE Plasma on Wayland: a KWin script loaded at runtime over D-Bus (`org.kde.KWin /Scripting loadScript`, from a
 *   temporary file, never installed into the user's KWin scripts or config). It reports every activation with a
 *   harmless `GetNameOwner` call to the bus itself, which carries the report in its argument; `dbus-monitor` reads it.
 *   The game window is the one whose pid is gamescope's, never matched by caption. Unloaded on stop.
 * - X11: `xprop -root -spy _NET_ACTIVE_WINDOW` and the active window's `_NET_WM_PID`.
 * - Windows (`windows`): no watcher and no report. The game runs as a native window, so Windows delivers its focus
 *   changes to the game itself (window messages and the engine's own focus handlers) and the game handles focus as an
 *   unmodified one does. The agent's host-focus gate stays at its focused default.
 * - Anything else: no watcher.
 *
 * Fail open: the game counts as focused until a report says otherwise, and again whenever the watcher cannot start,
 * dies or stops. A bad focus signal must never block the user's own input.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { errorMessage } from "../../core/errors.ts";

export type FocusBackend = "kwin" | "x11" | "windows" | "none";

/** The watcher this desktop supports, from the MCP server's own environment (not the game's). */
export function focusBackend(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): FocusBackend {
  if (platform === "win32") return "windows";
  const desktops = (env.XDG_CURRENT_DESKTOP ?? "").toUpperCase().split(":");
  if (env.WAYLAND_DISPLAY && desktops.includes("KDE")) return "kwin";
  if (env.DISPLAY && !env.WAYLAND_DISPLAY) return "x11";
  return "none";
}

/**
 * The KWin script: reports `in` or `out` for the window whose pid is `pid`, plus the active window's pid, now and on
 * every activation. KWin 6 and 5.
 */
export function kwinScript(pid: number, tag: string): string {
  return `(function () {
  var pid = ${Math.trunc(pid)};
  var tag = ${JSON.stringify(tag)};
  function active() { return workspace.activeWindow !== undefined ? workspace.activeWindow : workspace.activeClient; }
  function report() {
    var w = active();
    var focused = !!w && w.pid === pid;
    callDBus("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner",
      "sculkwire.focus." + tag + (focused ? ".in" : ".out") + ".p" + (w ? w.pid : 0));
  }
  if (workspace.windowActivated) workspace.windowActivated.connect(report);
  else workspace.clientActivated.connect(report);
  report();
})();
`;
}

/** A report in one `dbus-monitor` line for this `tag`, with the active window's pid when the script sent it. */
export function parseKwinReport(line: string, tag: string): { focused: boolean; activePid?: number } | undefined {
  const m = /string "sculkwire\.focus\.([A-Za-z0-9_]+)\.(in|out)(?:\.p(\d+))?"/.exec(line);
  if (!m || m[1] !== tag) return undefined;
  return m[3] === undefined ? { focused: m[2] === "in" } : { focused: m[2] === "in", activePid: Number(m[3]) };
}

/** The window id in an `xprop -spy _NET_ACTIVE_WINDOW` line, or undefined. */
export function parseActiveWindow(line: string): string | undefined {
  return /window id # (0x[0-9a-fA-F]+)/.exec(line)?.[1];
}

/** The pid in an `xprop _NET_WM_PID` answer, or undefined. */
export function parseWmPid(text: string): number | undefined {
  const m = /_NET_WM_PID\(CARDINAL\) = (\d+)/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** A child process as the watcher needs it: its output lines, and a way to end it. */
export interface Watch {
  lines: AsyncIterable<string>;
  kill(): void;
}

export interface FocusDeps {
  exec(file: string, args: string[]): Promise<string>;
  watch(file: string, args: string[]): Watch;
  writeFile(path: string, text: string): Promise<void>;
  removeFile(path: string): Promise<void>;
}

const execFileAsync = promisify(execFile);

const realDeps: FocusDeps = {
  exec: async (file, args) => (await execFileAsync(file, args, { encoding: "utf8", timeout: 5000 })).stdout,
  watch: (file, args) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"] });
    child.on("error", () => undefined);
    return { lines: createInterface({ input: child.stdout }), kill: () => child.kill() };
  },
  writeFile: (path, text) => writeFile(path, text),
  removeFile: (path) => rm(path, { force: true }),
};

export interface HostFocusOptions {
  /** gamescope's pid: the game window on the desktop belongs to it. Unused on Windows. */
  pid: number;
  /** Called on every change, and with true when the watcher ends. */
  onChange: (focused: boolean) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  deps?: FocusDeps;
}

/** What the focus watcher is doing, for `game_input_lock`: enough to tell a watcher that never loaded from a wrong window match. */
export interface FocusWatchState {
  backend: FocusBackend;
  /** gamescope's pid, the window the watcher counts as the game. */
  gamePid: number;
  /** The watcher started (script loaded, xprop running) and has not stopped. Always false for `windows` and `none`. */
  running: boolean;
  /** Focus reports received so far. */
  reports: number;
  /** The active window's pid in the last report (0 when no window was active). */
  activePid?: number;
  focused: boolean;
  error?: string;
}

export class HostFocus {
  /** The game window has focus on the desktop. True until a report says otherwise. */
  focused = true;
  /** The watcher that runs, or why none does. */
  backend: FocusBackend;
  /** Why the watcher could not start, when it could not. */
  error?: string;
  readonly #onChange: (focused: boolean) => void;
  readonly #deps: FocusDeps;
  #cleanup: (() => Promise<void>) | undefined;
  #stopped = false;
  #gamePid = 0;
  #reports = 0;
  #activePid: number | undefined;

  /** Watcher diagnostics. */
  state(): FocusWatchState {
    return {
      backend: this.backend,
      gamePid: this.#gamePid,
      running: (this.backend === "kwin" || this.backend === "x11") && !this.#stopped,
      reports: this.#reports,
      ...(this.#activePid !== undefined ? { activePid: this.#activePid } : {}),
      focused: this.focused,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private constructor(backend: FocusBackend, onChange: (focused: boolean) => void, deps: FocusDeps) {
    this.backend = backend;
    this.#onChange = onChange;
    this.#deps = deps;
  }

  /** Start the watcher this desktop supports. Never throws: a watcher that cannot start leaves the game focused. */
  static async start(options: HostFocusOptions): Promise<HostFocus> {
    const deps = options.deps ?? realDeps;
    const platform = options.platform ?? process.platform;
    const backend = options.pid > 0 || platform === "win32" ? focusBackend(options.env, platform) : "none";
    const focus = new HostFocus(backend, options.onChange, deps);
    focus.#gamePid = options.pid;
    try {
      if (backend === "kwin") await focus.#startKwin(options.pid);
      else if (backend === "x11") focus.#startX11(options.pid);
    } catch (err) {
      focus.error = errorMessage(err);
      await focus.stop();
    }
    return focus;
  }

  #report(focused: boolean, activePid?: number): void {
    if (this.#stopped) return;
    this.#reports++;
    if (activePid !== undefined) this.#activePid = activePid;
    if (focused === this.focused) return;
    this.focused = focused;
    this.#onChange(focused);
  }

  /** The watcher ended on its own: back to focused. */
  #ended(): void {
    if (!this.#stopped) void this.stop();
  }

  async #startKwin(pid: number): Promise<void> {
    const tag = `t${process.pid}x${Date.now()}`;
    const plugin = `sculkwire_focus_${tag}`;
    const file = join(tmpdir(), `${plugin}.js`);
    const monitor = this.#deps.watch("dbus-monitor", ["--session", "type='method_call',interface='org.freedesktop.DBus',member='GetNameOwner'"]);
    const kwin = (method: string, ...args: string[]) =>
      this.#deps.exec("gdbus", ["call", "--session", "--dest", "org.kde.KWin", "--object-path", "/Scripting", "--method", `org.kde.kwin.Scripting.${method}`, ...args]);
    this.#cleanup = async () => {
      monitor.kill();
      await kwin("unloadScript", plugin).catch(() => undefined);
      await this.#deps.removeFile(file).catch(() => undefined);
    };
    void (async () => {
      for await (const line of monitor.lines) {
        const f = parseKwinReport(line, tag);
        if (f !== undefined) this.#report(f.focused, f.activePid);
      }
      this.#ended();
    })();
    await this.#deps.writeFile(file, kwinScript(pid, tag));
    const id = /-?\d+/.exec(await kwin("loadScript", file, plugin))?.[0];
    if (id === undefined || Number(id) < 0) throw new Error(`KWin did not load the focus script (loadScript answered ${id ?? "nothing"})`);
    await kwin("start");
  }

  #startX11(pid: number): void {
    const spy = this.#deps.watch("xprop", ["-root", "-spy", "_NET_ACTIVE_WINDOW"]);
    this.#cleanup = async () => spy.kill();
    void (async () => {
      for await (const line of spy.lines) {
        const id = parseActiveWindow(line);
        if (!id) continue;
        const owner = id === "0x0" ? undefined : parseWmPid(await this.#deps.exec("xprop", ["-id", id, "_NET_WM_PID"]).catch(() => ""));
        this.#report(owner === pid, owner ?? 0);
      }
      this.#ended();
    })();
  }

  /** Stop watching and unload what was loaded. The game counts as focused again. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    if (!this.focused) {
      this.focused = true;
      this.#onChange(true);
    }
    this.#stopped = true;
    const cleanup = this.#cleanup;
    this.#cleanup = undefined;
    await cleanup?.();
  }
}
