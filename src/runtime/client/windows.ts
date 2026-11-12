/**
 * Windows-native client helpers through Windows PowerShell 5.1 and C# compiled by `Add-Type` (no extra installs):
 * - list and close the game process;
 * - capture the game window with PrintWindow (works while covered), or from the screen when the window delivers an
 *   empty frame and is in the foreground;
 * - keyboard and mouse through `SendInput`, the path a real keyboard and mouse take (the game reads them through raw
 *   input/GameInput, so posted window messages are not used). One long-lived helper process per game reads one
 *   command per line on stdin. It sends nothing unless the game window is in the foreground, reports each loss of
 *   the foreground, and lets go of every key and button it holds when the foreground is lost, when stdin closes and
 *   on any error;
 * - mute and unmute the game's audio sessions (WASAPI).
 * Every helper is per-monitor DPI aware, so the client rectangle a screenshot captures is the one clicks land in.
 */
import { errorMessage } from "../../core/errors.ts";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * C# 5 (what Windows PowerShell 5.1's Add-Type compiles). It travels in the `SCULKWIRE_CS` environment variable: as
 * part of -EncodedCommand it would pass the 32767-character command-line limit.
 */
const NATIVE_CS = String.raw`
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class SculkDeviceEnumerator {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISculkDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out ISculkDeviceCollection devices);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISculkDeviceCollection {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int Item(uint index, out ISculkDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISculkDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISculkSessionManager2 {
  [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
  [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
  [PreserveSig] int GetSessionEnumerator(out ISculkSessionEnumerator sessions);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISculkSessionEnumerator {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
}
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISculkSessionControl2 {
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName(out IntPtr name);
  [PreserveSig] int SetDisplayName(IntPtr name, IntPtr context);
  [PreserveSig] int GetIconPath(out IntPtr path);
  [PreserveSig] int SetIconPath(IntPtr path, IntPtr context);
  [PreserveSig] int GetGroupingParam(out Guid grouping);
  [PreserveSig] int SetGroupingParam(IntPtr grouping, IntPtr context);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
  [PreserveSig] int GetSessionIdentifier(out IntPtr id);
  [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
  [PreserveSig] int GetProcessId(out uint pid);
}
[ComImport, Guid("87CE5498-68D6-44E5-9215-6F9D0AEDDA7B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISculkSimpleVolume {
  [PreserveSig] int SetMasterVolume(float level, IntPtr context);
  [PreserveSig] int GetMasterVolume(out float level);
  [PreserveSig] int SetMute(int mute, IntPtr context);
  [PreserveSig] int GetMute(out int mute);
}

public static class SculkNative {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  /** Per-monitor DPI awareness for this thread: window rectangles and cursor positions in physical pixels. */
  static void DpiAware() {
    try {
      if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return;
      if (SetThreadDpiAwarenessContext(new IntPtr(-3)) != IntPtr.Zero) return;
    } catch (EntryPointNotFoundException) {
    }
    SetProcessDPIAware();
  }

  /** The process's largest visible unowned top-level window. */
  static IntPtr MainWindow(int pid) {
    IntPtr best = IntPtr.Zero;
    long bestArea = -1;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner != (uint)pid || !IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      RECT r;
      GetClientRect(h, out r);
      long area = (long)(r.R - r.L) * (r.B - r.T);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  static IntPtr RequireWindow(int pid) {
    IntPtr h = MainWindow(pid);
    if (h == IntPtr.Zero) throw new Exception("the game window was not found");
    return h;
  }

  static bool IsForeground(int pid) {
    uint owner;
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero) return false;
    GetWindowThreadProcessId(fg, out owner);
    return owner == (uint)pid;
  }

  /** True when every pixel has the same colour (alpha ignored): the window did not deliver its frame. */
  static bool Uniform(Bitmap bmp) {
    BitmapData d = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      int stride = d.Stride / 4;
      int[] px = new int[stride * bmp.Height];
      Marshal.Copy(d.Scan0, px, 0, px.Length);
      int first = px[0] & 0xFFFFFF;
      for (int y = 0; y < bmp.Height; y++) {
        for (int x = 0; x < bmp.Width; x++) {
          if ((px[y * stride + x] & 0xFFFFFF) != first) return false;
        }
      }
      return true;
    } finally {
      bmp.UnlockBits(d);
    }
  }

  /**
   * PNG of the window's client area: PrintWindow(PW_CLIENTONLY | PW_RENDERFULLCONTENT), which works while the window is
   * covered. An all-one-colour frame means the DirectX surface was not delivered: then the client rectangle is copied
   * from the screen, which needs the window in the foreground. Returns "window" or "screen".
   */
  public static string Capture(int pid, string path) {
    DpiAware();
    IntPtr h = RequireWindow(pid);
    RECT r;
    GetClientRect(h, out r);
    int w = Math.Max(1, r.R - r.L), hh = Math.Max(1, r.B - r.T);
    using (Bitmap bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb)) {
      using (Graphics g = Graphics.FromImage(bmp)) {
        IntPtr hdc = g.GetHdc();
        try { PrintWindow(h, hdc, 3); } finally { g.ReleaseHdc(hdc); }
      }
      string source = "window";
      if (Uniform(bmp)) {
        if (!IsForeground(pid)) {
          throw new Exception("the game window delivered an empty frame and is not in the foreground, so it cannot be captured from the screen either; bring the game window to the front and try again");
        }
        POINT p = new POINT();
        ClientToScreen(h, ref p);
        using (Graphics g = Graphics.FromImage(bmp)) g.CopyFromScreen(p.X, p.Y, 0, 0, new Size(w, hh));
        source = "screen";
      }
      bmp.Save(path, ImageFormat.Png);
      return source;
    }
  }

  /**
   * Mute or unmute every audio session of these processes on every active output device. Sessions appear only after
   * the process opens its audio device, so this retries until one changed or timeoutMs passed. Returns the number of
   * sessions changed, or -1 when Windows has no active output device.
   */
  public static int Mute(string pidList, bool mute, int timeoutMs) {
    List<uint> pids = new List<uint>();
    foreach (string s in pidList.Split(',')) if (s.Trim().Length > 0) pids.Add(uint.Parse(s.Trim(), CultureInfo.InvariantCulture));
    DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    Guid iid = typeof(ISculkSessionManager2).GUID;
    while (true) {
      ISculkDeviceEnumerator devices = (ISculkDeviceEnumerator)new SculkDeviceEnumerator();
      ISculkDeviceCollection list;
      uint count = 0;
      if (devices.EnumAudioEndpoints(0, 1, out list) != 0 || list.GetCount(out count) != 0 || count == 0) return -1;
      int changed = 0;
      for (uint i = 0; i < count; i++) {
        ISculkDevice device;
        object o;
        if (list.Item(i, out device) != 0 || device.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
        ISculkSessionEnumerator sessions;
        if (((ISculkSessionManager2)o).GetSessionEnumerator(out sessions) != 0) continue;
        int n;
        sessions.GetCount(out n);
        for (int j = 0; j < n; j++) {
          object so;
          if (sessions.GetSession(j, out so) != 0) continue;
          ISculkSessionControl2 control = so as ISculkSessionControl2;
          ISculkSimpleVolume volume = so as ISculkSimpleVolume;
          uint pid;
          if (control == null || volume == null || control.GetProcessId(out pid) != 0 || !pids.Contains(pid)) continue;
          if (volume.SetMute(mute ? 1 : 0, IntPtr.Zero) == 0) changed++;
        }
      }
      if (changed > 0 || DateTime.UtcNow >= deadline) return changed;
      Thread.Sleep(1000);
    }
  }

  // ---- input helper ----

  static int target;
  /** The game window is not in the foreground: nothing is sent until it is again. */
  static bool background;
  static readonly HashSet<int> keys = new HashSet<int>();
  static readonly HashSet<int> buttons = new HashSet<int>();
  static readonly object outLock = new object();

  static void Emit(string line) {
    lock (outLock) {
      Console.Out.WriteLine(line);
      Console.Out.Flush();
    }
  }

  static void Send(INPUT input) {
    INPUT[] one = new INPUT[] { input };
    if (SendInput(1, one, Marshal.SizeOf(typeof(INPUT))) != 1) {
      throw new Exception("Windows refused the input (SendInput error " + Marshal.GetLastWin32Error() + "); is the game running as administrator?");
    }
  }

  static bool Extended(int vk) {
    switch (vk) {
      case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27: case 0x28:
      case 0x2D: case 0x2E: case 0x5B: case 0x5C: case 0x5D: case 0x6F: case 0x90: case 0xA3: case 0xA5:
        return true;
    }
    return false;
  }

  /** A key by virtual-key code (bit 0x100 forces the extended flag), sent as its scan code. */
  static void Key(int code, bool up) {
    int vk = code & 0xFF;
    uint scan = MapVirtualKey((uint)vk, 0);
    INPUT i = new INPUT();
    i.type = 1;
    i.u.ki.wVk = (ushort)vk;
    i.u.ki.wScan = (ushort)scan;
    uint flags = scan != 0 ? 0x0008u : 0u;
    if ((code & 0x100) != 0 || Extended(vk)) flags |= 0x0001u;
    if (up) flags |= 0x0002u;
    i.u.ki.dwFlags = flags;
    Send(i);
  }

  static void Unicode(char ch, bool up) {
    INPUT i = new INPUT();
    i.type = 1;
    i.u.ki.wScan = ch;
    i.u.ki.dwFlags = 0x0004u | (up ? 0x0002u : 0u);
    Send(i);
  }

  static void Mouse(int dx, int dy, uint flags) {
    INPUT i = new INPUT();
    i.type = 0;
    i.u.mi.dx = dx;
    i.u.mi.dy = dy;
    i.u.mi.dwFlags = flags;
    Send(i);
  }

  static uint ButtonFlag(int button, bool up) {
    if (button == 1) return up ? 0x0004u : 0x0002u;
    if (button == 2) return up ? 0x0040u : 0x0020u;
    if (button == 3) return up ? 0x0010u : 0x0008u;
    throw new Exception("mouse button must be 1, 2 or 3");
  }

  /** Let go of every key and button this helper holds. Key-up and button-up are sent wherever the focus is. */
  static void ReleaseAll() {
    foreach (int k in new List<int>(keys)) { try { Key(k, true); } catch (Exception) { } }
    keys.Clear();
    foreach (int b in new List<int>(buttons)) { try { Mouse(0, 0, ButtonFlag(b, true)); } catch (Exception) { } }
    buttons.Clear();
  }

  /** Track the foreground: on a loss let go of everything and report it once; report getting it back. */
  static void Watch() {
    bool fg = IsForeground(target);
    if (!fg && !background) {
      background = true;
      ReleaseAll();
      Emit("fg 0");
    } else if (fg && background) {
      background = false;
      Emit("fg 1");
    }
  }

  /** May an event be sent now? Only while the game window is in the foreground. */
  static bool Gate() {
    Watch();
    return !background;
  }

  static bool WaitForeground(int ms) {
    for (int waited = 0; ; waited += 25) {
      if (IsForeground(target)) return true;
      if (waited >= ms) return false;
      Thread.Sleep(25);
    }
  }

  /** Bring the game window to the foreground: restore it, then SetForegroundWindow with the AttachThreadInput and ALT workarounds. */
  static void Activate() {
    IntPtr h = RequireWindow(target);
    if (IsForeground(target)) return;
    if (IsIconic(h)) ShowWindow(h, 9);
    for (int attempt = 0; attempt < 3; attempt++) {
      uint ignored;
      uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
      uint me = GetCurrentThreadId();
      bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
      try {
        BringWindowToTop(h);
        SetForegroundWindow(h);
      } finally {
        if (attached) AttachThreadInput(me, fgThread, false);
      }
      if (WaitForeground(400)) return;
      if (attempt == 1) {
        // A process that just sent input may set the foreground window.
        Key(0xA4, false);
        try { SetForegroundWindow(h); } finally { Key(0xA4, true); }
        if (WaitForeground(400)) return;
      }
      SwitchToThisWindow(h, true);
      if (WaitForeground(400)) return;
    }
    throw new Exception("the game window could not be brought to the foreground");
  }

  /** Pointer to a client-area pixel: client -> screen -> normalized virtual-desktop coordinates. */
  static void MoveTo(int x, int y) {
    IntPtr h = RequireWindow(target);
    POINT p = new POINT();
    p.X = x;
    p.Y = y;
    ClientToScreen(h, ref p);
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
    int vw = Math.Max(1, GetSystemMetrics(78)), vh = Math.Max(1, GetSystemMetrics(79));
    int nx = (int)(((long)(p.X - vx) * 65536 + vw - 1) / vw);
    int ny = (int)(((long)(p.Y - vy) * 65536 + vh - 1) / vh);
    Mouse(nx, ny, 0x0001u | 0x8000u | 0x4000u);
    POINT c;
    if (GetCursorPos(out c) && (c.X != p.X || c.Y != p.Y)) SetCursorPos(p.X, p.Y);
  }

  static bool Text(string s) {
    foreach (char ch in s) {
      if (!Gate()) return false;
      if (ch == '\n') {
        Key(0x0D, false);
        Key(0x0D, true);
      } else if (ch != '\r') {
        Unicode(ch, false);
        Unicode(ch, true);
      }
      Thread.Sleep(20);
    }
    return true;
  }

  static int Arg(string[] p, int i) {
    if (p.Length <= i) throw new Exception("missing argument");
    return int.Parse(p[i], CultureInfo.InvariantCulture);
  }

  /** One request: "<id> <verb> [args]". Answer "<id> ok", "<id> blocked" (not in the foreground) or "<id> err <message>". */
  static void Handle(string line) {
    string[] p = line.Trim().Split(' ');
    if (p.Length < 2) return;
    string id = p[0];
    try {
      bool sent = true;
      switch (p[1]) {
        case "probe":
          break;
        case "activate":
          Activate();
          Watch();
          break;
        case "down": {
          int k = Arg(p, 2);
          if (!Gate()) { sent = false; break; }
          Key(k, false);
          keys.Add(k);
          break;
        }
        case "up": {
          int k = Arg(p, 2);
          if (keys.Remove(k)) Key(k, true);
          break;
        }
        case "bdown": {
          int b = Arg(p, 2);
          uint flag = ButtonFlag(b, false);
          if (!Gate()) { sent = false; break; }
          Mouse(0, 0, flag);
          buttons.Add(b);
          break;
        }
        case "bup": {
          int b = Arg(p, 2);
          uint flag = ButtonFlag(b, true);
          if (buttons.Remove(b)) Mouse(0, 0, flag);
          break;
        }
        case "move": {
          int dx = Arg(p, 2), dy = Arg(p, 3);
          if (!Gate()) { sent = false; break; }
          Mouse(dx, dy, 0x0001u);
          break;
        }
        case "at": {
          int x = Arg(p, 2), y = Arg(p, 3);
          if (!Gate()) { sent = false; break; }
          MoveTo(x, y);
          break;
        }
        case "text":
          sent = Text(p.Length > 2 ? Encoding.UTF8.GetString(Convert.FromBase64String(p[2])) : "");
          break;
        case "release":
          ReleaseAll();
          break;
        default:
          throw new Exception("unknown command " + p[1]);
      }
      Emit(id + (sent ? " ok" : " blocked"));
    } catch (Exception e) {
      ReleaseAll();
      Emit(id + " err " + e.Message.Replace('\r', ' ').Replace('\n', ' '));
    }
  }

  /** Read requests from stdin until it closes; watch the foreground between them. Everything held is let go on exit. */
  public static void RunInput(int pid) {
    target = pid;
    DpiAware();
    BlockingCollection<string> lines = new BlockingCollection<string>();
    Thread reader = new Thread(delegate () {
      try {
        string l;
        while ((l = Console.In.ReadLine()) != null) lines.Add(l);
      } catch (Exception) {
      }
      lines.CompleteAdding();
    });
    reader.IsBackground = true;
    reader.Start();
    try {
      background = !IsForeground(target);
      Emit(background ? "fg 0" : "fg 1");
      while (true) {
        string line;
        if (lines.TryTake(out line, 50)) {
          Handle(line);
          continue;
        }
        if (lines.IsCompleted) break;
        Watch();
      }
    } finally {
      ReleaseAll();
    }
  }
}
`;

/**
 * A PowerShell script around NATIVE_CS: errors leave as one stderr line (the innermost message) and exit code 1.
 * Progress is off because Windows PowerShell writes progress records ("Preparing modules for first use") to a
 * redirected stderr as CLIXML, after the error line.
 */
function nativeScript(body: string): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition $env:SCULKWIRE_CS",
    body,
    "} catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; [Console]::Error.WriteLine($e.Message); exit 1 }",
  ].join("\n");
}

const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"];

/** -EncodedCommand takes the script as UTF-16LE base64, so nothing needs shell quoting. */
function encode(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Run a PowerShell script; a failure throws its last stderr line. */
async function powershell(script: string, env: Record<string, string>, timeoutMs = 30_000): Promise<string> {
  try {
    const { stdout } = await run("powershell.exe", [...POWERSHELL_ARGS, encode(script)], {
      env: { ...process.env, SCULKWIRE_CS: NATIVE_CS, ...env },
      timeout: timeoutMs,
      windowsHide: true,
    });
    return stdout;
  } catch (e) {
    const stderr = e && typeof e === "object" && "stderr" in e && typeof e.stderr === "string" ? e.stderr.trim().split(/\r?\n/).pop() : undefined;
    throw new Error(stderr || (errorMessage(e)));
  }
}

const SCREENSHOT_SCRIPT = nativeScript("[Console]::Out.WriteLine([SculkNative]::Capture([int]$env:SCULKWIRE_PID, $env:SCULKWIRE_OUT))");

/** Capture a process's window into a PNG; resolves to where the pixels came from. */
export async function windowsScreenshot(path: string, pid: number): Promise<"window" | "screen"> {
  const out = await powershell(SCREENSHOT_SCRIPT, { SCULKWIRE_PID: String(pid), SCULKWIRE_OUT: path });
  return out.trim() === "screen" ? "screen" : "window";
}

const MUTE_SCRIPT = nativeScript(
  "[Console]::Out.WriteLine([SculkNative]::Mute($env:SCULKWIRE_PIDS, ($env:SCULKWIRE_MUTE -eq '1'), [int]$env:SCULKWIRE_TIMEOUT))",
);

/**
 * Mute (or unmute) the audio sessions of these processes, retrying for `timeoutMs` until one exists. Resolves to the
 * number of sessions changed, or -1 when Windows has no active audio output device.
 */
export async function windowsMute(pids: readonly number[], mute: boolean, timeoutMs: number): Promise<number> {
  const out = await powershell(
    MUTE_SCRIPT,
    { SCULKWIRE_PIDS: pids.join(","), SCULKWIRE_MUTE: mute ? "1" : "0", SCULKWIRE_TIMEOUT: String(timeoutMs) },
    timeoutMs + 30_000,
  );
  const n = Number(out.trim());
  return Number.isInteger(n) ? n : 0;
}

/** Virtual-key codes for xdotool key names (the names the tools take on Linux). 0x100 marks a numpad/extended twin. */
const VK: Record<string, number> = {
  Return: 0x0d,
  Enter: 0x0d,
  KP_Enter: 0x10d,
  Escape: 0x1b,
  Tab: 0x09,
  BackSpace: 0x08,
  Delete: 0x2e,
  Insert: 0x2d,
  Home: 0x24,
  End: 0x23,
  Page_Up: 0x21,
  Prior: 0x21,
  Page_Down: 0x22,
  Next: 0x22,
  Up: 0x26,
  Down: 0x28,
  Left: 0x25,
  Right: 0x27,
  space: 0x20,
  Caps_Lock: 0x14,
  Num_Lock: 0x90,
  Scroll_Lock: 0x91,
  Menu: 0x5d,
  Shift_L: 0xa0,
  Shift_R: 0xa1,
  shift: 0xa0,
  Control_L: 0xa2,
  Control_R: 0xa3,
  ctrl: 0xa2,
  control: 0xa2,
  Alt_L: 0xa4,
  Alt_R: 0xa5,
  alt: 0xa4,
  Super_L: 0x5b,
  Super_R: 0x5c,
  super: 0x5b,
  minus: 0xbd,
  equal: 0xbb,
  comma: 0xbc,
  period: 0xbe,
  slash: 0xbf,
  semicolon: 0xba,
  apostrophe: 0xde,
  grave: 0xc0,
  bracketleft: 0xdb,
  bracketright: 0xdd,
  backslash: 0xdc,
  KP_Add: 0x6b,
  KP_Subtract: 0x6d,
  KP_Multiply: 0x6a,
  KP_Divide: 0x6f,
  KP_Decimal: 0x6e,
};

/** The same keys by the character they type on a US layout (the game binds keys by these virtual-key codes). */
const CHAR_VK: Record<string, number> = { "-": 0xbd, "=": 0xbb, ",": 0xbc, ".": 0xbe, "/": 0xbf, ";": 0xba, "'": 0xde, "`": 0xc0, "[": 0xdb, "]": 0xdd, "\\": 0xdc, " ": 0x20 };

const VK_LOWER = new Map(Object.entries(VK).map(([k, v]) => [k.toLowerCase(), v]));

/** The key names `virtualKey` accepts, for error messages. */
export function keyNames(): string {
  return `${Object.keys(VK).join(", ")}, a-z, 0-9, F1-F24, KP_0-KP_9, and chords joined with + (ctrl+a)`;
}

/** One xdotool key name (case-insensitive) → virtual-key code; unknown names fail with the list of valid ones. */
export function virtualKey(name: string): number {
  const named = VK[name] ?? VK_LOWER.get(name.toLowerCase());
  if (named !== undefined) return named;
  if (/^[a-z0-9]$/i.test(name)) return name.toUpperCase().charCodeAt(0);
  const char = CHAR_VK[name];
  if (char !== undefined) return char;
  const f = /^F([1-9]|1\d|2[0-4])$/i.exec(name);
  if (f) return 0x6f + Number(f[1]);
  const kp = /^KP_(\d)$/i.exec(name);
  if (kp) return 0x60 + Number(kp[1]);
  throw new Error(`unknown key '${name}'. Valid keys: ${keyNames()}`);
}

/** A chord such as `ctrl+shift+t` → its keys, pressed in this order and released in reverse. */
export function chordKeys(chord: string): number[] {
  const parts = chord === "+" ? ["+"] : chord.split("+");
  if (parts.some((p) => !p)) throw new Error(`malformed key chord '${chord}'. Valid keys: ${keyNames()}`);
  return parts.map(virtualKey);
}

/** One helper request line: `<id> <verb> [args]`. Text travels as base64 UTF-8 so a line never breaks. */
export type HelperCommand =
  | { verb: "probe" | "activate" | "release" }
  | { verb: "down" | "up"; key: number }
  | { verb: "bdown" | "bup"; button: 1 | 2 | 3 }
  | { verb: "move" | "at"; x: number; y: number }
  | { verb: "text"; text: string };

export function encodeCommand(id: number, c: HelperCommand): string {
  switch (c.verb) {
    case "down":
    case "up":
      return `${id} ${c.verb} ${c.key}`;
    case "bdown":
    case "bup":
      return `${id} ${c.verb} ${c.button}`;
    case "move":
    case "at":
      return `${id} ${c.verb} ${Math.round(c.x)} ${Math.round(c.y)}`;
    case "text":
      return `${id} text ${Buffer.from(c.text, "utf8").toString("base64")}`;
    default:
      return `${id} ${c.verb}`;
  }
}

export type HelperLine =
  | { kind: "reply"; id: number; status: "ok" | "blocked" }
  | { kind: "error"; id: number; message: string }
  | { kind: "foreground"; foreground: boolean };

/** Parse one helper output line; undefined for anything else (PowerShell noise). */
export function parseHelperLine(line: string): HelperLine | undefined {
  const t = line.trim();
  const fg = /^fg ([01])$/.exec(t);
  if (fg) return { kind: "foreground", foreground: fg[1] === "1" };
  const m = /^(\d+) (ok|blocked|err)(?: (.*))?$/.exec(t);
  if (!m) return undefined;
  const id = Number(m[1]);
  if (m[2] === "err") return { kind: "error", id, message: m[3] ?? "failed" };
  return { kind: "reply", id, status: m[2] as "ok" | "blocked" };
}

/** What input into a game window that is not in the foreground fails with. */
export const FOREGROUND_MESSAGE = "the game window is not in the foreground";

export class ForegroundError extends Error {
  constructor() {
    super(FOREGROUND_MESSAGE);
  }
}

const INPUT_SCRIPT = nativeScript("[SculkNative]::RunInput([int]$env:SCULKWIRE_PID)");

/**
 * The long-lived input helper for one game process (the Windows counterpart of the gamescope `xdotool -` pipe). A
 * probe has to answer before it is trusted. It never keeps a finished CLI or test process alive: its handles are
 * referenced only while a request waits for its answer.
 */
export class WindowsInputHelper {
  readonly pid: number;
  readonly ready: Promise<void>;
  /** The game window is in the foreground, as the helper last reported. */
  foreground = false;
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, { resolve: (s: "ok" | "blocked") => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  readonly #lost = new Set<() => void>();
  readonly #gained = new Set<() => void>();
  #nextId = 0;
  #alive = true;
  #stderr = "";

  constructor(pid: number) {
    this.pid = pid;
    this.#child = spawn("powershell.exe", [...POWERSHELL_ARGS, encode(INPUT_SCRIPT)], {
      env: { ...process.env, SCULKWIRE_CS: NATIVE_CS, SCULKWIRE_PID: String(pid) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const child = this.#child;
    child.on("error", (e) => this.#die(`the input helper could not start: ${e.message}`));
    child.on("exit", () => this.#die(`the input helper exited${this.#stderr.trim() ? `: ${this.#stderr.trim().split(/\r?\n/).pop()}` : ""}`));
    child.stdin?.on("error", () => undefined);
    child.stderr?.on("data", (d: Buffer) => {
      this.#stderr = (this.#stderr + d.toString()).slice(-4000);
    });
    if (child.stdout) createInterface({ input: child.stdout }).on("line", (l) => this.#line(l));
    // Compiling the C# with Add-Type takes a few seconds on a cold Windows PowerShell.
    this.ready = this.request({ verb: "probe" }, 60_000).then(() => undefined);
    this.ready.catch(() => this.close());
    this.#unref();
  }

  get alive(): boolean {
    return this.#alive;
  }

  /** `listener` runs on each loss of the foreground. Returns the function that removes it. */
  onLost(listener: () => void): () => void {
    this.#lost.add(listener);
    return () => this.#lost.delete(listener);
  }

  /** Resolves once the game window is in the foreground again, or when `signal` aborts. */
  untilForeground(signal?: AbortSignal): Promise<void> {
    if (this.foreground || signal?.aborted || !this.#alive) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const done = () => {
      this.#gained.delete(done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    this.#gained.add(done);
    signal?.addEventListener("abort", done, { once: true });
    return promise;
  }

  /** Send one command; resolves "ok" or "blocked" (the game window is not in the foreground), rejects on errors. */
  request(c: HelperCommand, timeoutMs = 10_000 + (c.verb === "text" ? c.text.length * 50 : 0)): Promise<"ok" | "blocked"> {
    if (!this.#alive || !this.#child.stdin?.writable) return Promise.reject(new Error("the input helper is not running"));
    const id = ++this.#nextId;
    const { promise, resolve, reject } = Promise.withResolvers<"ok" | "blocked">();
    const timer = setTimeout(() => this.#settle(id, new Error(`the input helper did not answer ${c.verb} within ${timeoutMs} ms`)), timeoutMs);
    if (this.#pending.size === 0) this.#ref();
    this.#pending.set(id, { resolve, reject, timer });
    this.#child.stdin.write(`${encodeCommand(id, c)}\n`);
    return promise;
  }

  /** Close stdin: the helper lets go of everything it holds and exits. Killed if it is still there 3 s later. */
  close(): void {
    if (!this.#alive) return;
    this.#die("the input helper was closed");
    this.#child.stdin?.end();
    const child = this.#child;
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 3_000).unref();
  }

  #line(line: string): void {
    const parsed = parseHelperLine(line);
    if (!parsed) return;
    if (parsed.kind === "foreground") {
      const was = this.foreground;
      this.foreground = parsed.foreground;
      if (was !== parsed.foreground) for (const l of [...(parsed.foreground ? this.#gained : this.#lost)]) l();
      return;
    }
    this.#settle(parsed.id, parsed.kind === "error" ? new Error(parsed.message) : parsed.status);
  }

  #settle(id: number, outcome: "ok" | "blocked" | Error): void {
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    if (outcome instanceof Error) p.reject(outcome);
    else p.resolve(outcome);
    if (this.#pending.size === 0) this.#unref();
  }

  #die(reason: string): void {
    if (!this.#alive && this.#pending.size === 0) return;
    this.#alive = false;
    for (const id of [...this.#pending.keys()]) this.#settle(id, new Error(reason));
    for (const l of [...this.#gained]) l();
  }

  #ref(): void {
    this.#child.ref();
    const out = this.#child.stdout;
    if (out && "ref" in out && typeof out.ref === "function") out.ref();
  }

  #unref(): void {
    this.#child.unref();
    for (const s of [this.#child.stdin, this.#child.stdout, this.#child.stderr]) {
      if (s && "unref" in s && typeof s.unref === "function") s.unref();
    }
  }
}

export interface WindowsProcess {
  pid: number;
  /** Full path of the executable; empty when Windows does not report it. */
  path: string;
}

/** Lines `<pid>\t<path>` written by the process-list script. */
export function parseProcessList(text: string): WindowsProcess[] {
  const out: WindowsProcess[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\t(.*?)\s*$/.exec(line);
    if (m?.[1]) out.push({ pid: Number(m[1]), path: (m[2] ?? "").trim() });
  }
  return out;
}

/**
 * Whether a game process belongs to an install. Stable and Preview both run `Minecraft.Windows.exe`, so the path
 * decides: under the install's game folder when that is known, else by the Preview folder name.
 */
export function belongsToInstall(path: string, install: { gameDir?: string; preview: boolean }): boolean {
  if (!path) return true;
  const p = path.toLowerCase().replaceAll("/", "\\");
  if (install.gameDir) return p.startsWith(`${install.gameDir.toLowerCase().replaceAll("/", "\\").replace(/\\+$/, "")}\\`);
  return /minecraft preview/.test(p) === install.preview;
}

// Get-Process with no match leaves $? false and PowerShell exits 1, so exit 0 explicitly: no process is a valid answer.
const PROCESS_LIST_SCRIPT = String.raw`
Get-Process -Name 'Minecraft.Windows' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)` + "`t" + String.raw`$($_.Path)" }
exit 0
`;

export async function windowsGameProcesses(): Promise<WindowsProcess[]> {
  return parseProcessList(await powershell(PROCESS_LIST_SCRIPT, {}));
}

/** Ask the game to close (WM_CLOSE via taskkill without /F), or force it. */
export async function windowsKill(pids: readonly number[], force: boolean): Promise<void> {
  if (!pids.length) return;
  await run("taskkill", [...pids.flatMap((p) => ["/PID", String(p)]), ...(force ? ["/F"] : [])], { windowsHide: true }).catch(() => undefined);
}
