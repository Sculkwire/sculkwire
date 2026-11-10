import { describe, expect, it } from "vitest";
import { focusBackend, HostFocus, kwinScript, parseActiveWindow, parseKwinReport, parseWmPid, type FocusDeps } from "./focus.ts";

const KDE = { WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "KDE" };

/** Fake processes: `push` feeds the watched process's output, `end` makes it exit. */
function fakeDeps(opts: { loadFails?: boolean } = {}) {
  const calls: string[][] = [];
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  async function* lines(): AsyncGenerator<string> {
    for (;;) {
      while (queue.length) yield queue.shift() as string;
      if (ended) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      wake = resolve;
      await promise;
    }
  }
  const kick = () => {
    wake?.();
    wake = undefined;
  };
  const deps: FocusDeps = {
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (args.some((a) => a.endsWith(".loadScript"))) {
        if (opts.loadFails) throw new Error("org.kde.KWin is not running");
        return "(3,)\n";
      }
      return "()\n";
    },
    watch: (file, args) => {
      calls.push([file, ...args]);
      return { lines: lines(), kill: () => ((ended = true), kick()) };
    },
    writeFile: async () => undefined,
    removeFile: async () => undefined,
  };
  const tick = () => new Promise<void>((r) => setImmediate(r));
  return {
    deps,
    calls,
    push: async (line: string) => {
      queue.push(line);
      kick();
      await tick();
      await tick();
    },
    end: async () => {
      ended = true;
      kick();
      await tick();
      await tick();
    },
  };
}

/** The tag the script was loaded with, read back from the plugin name passed to loadScript. */
function tagOf(calls: string[][]): string {
  const load = calls.find((c) => c.some((a) => a.endsWith(".loadScript"))) as string[];
  return (load.at(-1) as string).replace("sculkwire_focus_", "");
}

describe("host focus", () => {
  it("picks KWin on KDE Wayland, xprop on X11, and nothing elsewhere", () => {
    expect(focusBackend(KDE, "linux")).toBe("kwin");
    expect(focusBackend({ WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "GNOME" }, "linux")).toBe("none");
    expect(focusBackend({ DISPLAY: ":0" }, "linux")).toBe("x11");
    expect(focusBackend({}, "linux")).toBe("none");
  });

  it("parses reports, active windows and window pids", () => {
    expect(parseKwinReport('   string "sculkwire.focus.t1x2.out"', "t1x2")).toEqual({ focused: false });
    expect(parseKwinReport('   string "sculkwire.focus.t1x2.in.p4242"', "t1x2")).toEqual({ focused: true, activePid: 4242 });
    expect(parseKwinReport('   string "sculkwire.focus.t1x2.out.p77"', "t1x2")).toEqual({ focused: false, activePid: 77 });
    expect(parseKwinReport('   string "sculkwire.focus.other.in"', "t1x2")).toBeUndefined();
    expect(parseActiveWindow("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007")).toBe("0x3a00007");
    expect(parseWmPid("_NET_WM_PID(CARDINAL) = 4242\n")).toBe(4242);
    expect(kwinScript(4242, "t1x2")).toContain("w.pid === pid");
  });

  it("fails open: no watcher on other desktops, and the game stays focused", async () => {
    const f = fakeDeps();
    const changes: boolean[] = [];
    const focus = await HostFocus.start({ pid: 42, env: {}, platform: "linux", deps: f.deps, onChange: (v) => changes.push(v) });
    expect(focus.backend).toBe("none");
    expect(focus.focused).toBe(true);
    expect(f.calls).toHaveLength(0);
    expect(changes).toEqual([]);
  });

  it("fails open when KWin does not load the script, and cleans up what it started", async () => {
    const f = fakeDeps({ loadFails: true });
    const changes: boolean[] = [];
    const focus = await HostFocus.start({ pid: 42, env: KDE, platform: "linux", deps: f.deps, onChange: (v) => changes.push(v) });
    expect(focus.focused).toBe(true);
    expect(focus.error).toMatch(/not running/);
    expect(changes).toEqual([]);
    expect(f.calls.some((c) => c.some((a) => a.endsWith(".unloadScript")))).toBe(true);
    await f.push('   string "sculkwire.focus.whatever.out"');
    expect(focus.focused).toBe(true);
  });

  it("is focused until a report arrives, follows reports, and is focused again when stopped", async () => {
    const f = fakeDeps();
    const changes: boolean[] = [];
    const focus = await HostFocus.start({ pid: 42, env: KDE, platform: "linux", deps: f.deps, onChange: (v) => changes.push(v) });
    expect(focus.backend).toBe("kwin");
    expect(focus.focused).toBe(true);
    const tag = tagOf(f.calls);
    await f.push(`   string "sculkwire.focus.${tag}.out"`);
    expect(focus.focused).toBe(false);
    await f.push(`   string "sculkwire.focus.${tag}.in"`);
    await f.push(`   string "sculkwire.focus.${tag}.out"`);
    expect(changes).toEqual([false, true, false]);
    await focus.stop();
    expect(focus.focused).toBe(true);
    expect(changes.at(-1)).toBe(true);
    expect(f.calls.some((c) => c.some((a) => a.endsWith(".unloadScript")))).toBe(true);
  });

  it("is focused again when the watcher dies", async () => {
    const f = fakeDeps();
    const changes: boolean[] = [];
    const focus = await HostFocus.start({ pid: 42, env: KDE, platform: "linux", deps: f.deps, onChange: (v) => changes.push(v) });
    await f.push(`   string "sculkwire.focus.${tagOf(f.calls)}.out"`);
    await f.end();
    expect(focus.focused).toBe(true);
    expect(changes).toEqual([false, true]);
  });

  it("watches nothing on Windows, where the game sees its own focus, and says so", async () => {
    expect(focusBackend(KDE, "win32")).toBe("windows");
    const f = fakeDeps();
    const changes: boolean[] = [];
    const focus = await HostFocus.start({ pid: 0, env: KDE, platform: "win32", deps: f.deps, onChange: (v) => changes.push(v) });
    expect(focus.state()).toEqual({ backend: "windows", gamePid: 0, running: false, reports: 0, focused: true });
    expect(f.calls).toHaveLength(0);
    await focus.stop();
    expect(changes).toEqual([]);
  });
});
