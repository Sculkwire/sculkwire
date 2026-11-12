import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findInstalls } from "../../gamefiles/install.ts";
import { gamePids, playerInput, screenshot, sendInput, type LaunchState } from "./launcher.ts";
import { FOREGROUND_MESSAGE, WindowsInputHelper, windowsScreenshot } from "./windows.ts";

// These run the real OS tools (tasklist, ps, PowerShell). CI runs them on Linux, Windows and macOS.

describe("client on this OS", () => {
  it("lists game processes and finds installs without throwing, with or without a game running", async () => {
    const pids = await gamePids();
    expect(Array.isArray(pids)).toBe(true);
    for (const pid of pids) expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(Array.isArray(await findInstalls())).toBe(true);
  });
});

/**
 * A WinForms window that appends what it receives to a log file: key down/up (virtual-key code), typed characters,
 * mouse down/up and moves with client coordinates. `SCULKWIRE_UNIFORM=1` leaves it one colour (an empty frame).
 */
const WINDOW_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$log = $env:SCULKWIRE_LOG
function Log([string]$line) { [System.IO.File]::AppendAllText($log, $line + [Environment]::NewLine) }
$form = New-Object System.Windows.Forms.Form
$form.Text = 'sculkwire test window'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point([int]$env:SCULKWIRE_X, 120)
$form.ClientSize = New-Object System.Drawing.Size(520, 360)
$form.BackColor = [System.Drawing.Color]::FromArgb(40, 90, 160)
$form.KeyPreview = $true
$form.Add_KeyDown({ Log ("keydown " + [int]$_.KeyCode) })
$form.Add_KeyUp({ Log ("keyup " + [int]$_.KeyCode) })
$form.Add_KeyPress({ Log ("char " + [int]$_.KeyChar) })
$form.Add_MouseDown({ Log ("mousedown " + $_.Button + " " + $_.X + " " + $_.Y) })
$form.Add_MouseUp({ Log ("mouseup " + $_.Button + " " + $_.X + " " + $_.Y) })
$form.Add_MouseMove({ Log ("mousemove " + $_.X + " " + $_.Y) })
if ($env:SCULKWIRE_UNIFORM -ne '1') {
  $form.Add_Paint({ $_.Graphics.FillRectangle([System.Drawing.Brushes]::OrangeRed, 20, 20, 200, 120) })
}
$form.Add_Shown({ Log 'ready' })
[System.Windows.Forms.Application]::Run($form)
`;

interface TestWindow {
  pid: number;
  child: ChildProcess;
  lines(): string[];
}

async function until(what: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

describe.runIf(process.platform === "win32")("Windows input helper and capture against a test window", () => {
  const dir = mkdtempSync(join(tmpdir(), "sculkwire-native-"));
  let recorder: TestWindow;
  let other: TestWindow;
  let state: LaunchState;
  const helpers: WindowsInputHelper[] = [];

  async function openWindow(name: string, x: number, uniform: boolean): Promise<TestWindow> {
    const log = join(dir, `${name}.log`);
    writeFileSync(log, "");
    // -WindowStyle Hidden hides the console; windowsHide would also hide the form's first ShowWindow.
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(WINDOW_SCRIPT, "utf16le").toString("base64")],
      { env: { ...process.env, SCULKWIRE_LOG: log, SCULKWIRE_X: String(x), SCULKWIRE_UNIFORM: uniform ? "1" : "0" }, stdio: "ignore" },
    );
    const lines = () => readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean);
    await until(`${name} to show`, () => lines().includes("ready"), 60_000);
    if (!child.pid) throw new Error(`${name} did not start`);
    return { pid: child.pid, child, lines };
  }

  async function helperFor(w: TestWindow): Promise<WindowsInputHelper> {
    const h = new WindowsInputHelper(w.pid);
    helpers.push(h);
    await h.ready;
    return h;
  }

  /** Retry bringing a window forward: a runner's desktop sometimes refuses the first attempts. */
  async function retry(activate: () => Promise<void>): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await activate();
        return;
      } catch (e) {
        last = e;
        await sleep(500);
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  async function focus(h: WindowsInputHelper): Promise<void> {
    await retry(async () => {
      await h.request({ verb: "activate" });
      await until("the foreground report", () => h.foreground, 2_000);
    });
  }

  /** Log lines written after `mark` lines existed. */
  const after = (w: TestWindow, mark: number) => w.lines().slice(mark);

  beforeAll(async () => {
    recorder = await openWindow("recorder", 40, false);
    other = await openWindow("other", 640, true);
    state = { mode: "window", startedAt: Date.now(), pid: 0, argv: [], launchLog: "", notes: [], gamePid: recorder.pid };
  }, 180_000);

  afterAll(() => {
    for (const h of helpers) h.close();
    recorder?.child.kill();
    other?.child.kill();
  });

  it("captures the window with PrintWindow while it is not in the foreground", async () => {
    const out = join(dir, "recorder.png");
    expect(await screenshot(state, out)).toMatchObject({ path: out });
    expect(readFileSync(out).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(await windowsScreenshot(join(dir, "recorder2.png"), recorder.pid)).toBe("window");
  }, 120_000);

  it("captures an empty (one-colour) frame from the screen only while that window is in the foreground", async () => {
    const h = await helperFor(other);
    await focus(h);
    expect(await windowsScreenshot(join(dir, "other.png"), other.pid)).toBe("screen");
    await focus(await helperFor(recorder));
    await expect(windowsScreenshot(join(dir, "other2.png"), other.pid)).rejects.toThrow(/not in the foreground/);
  }, 120_000);

  it("brings the window forward, and a held key goes down and comes up", async () => {
    const input = playerInput(state);
    await retry(async () => input.foreground?.activate());
    const mark = recorder.lines().length;
    await input.keyDown("w");
    await sleep(200);
    await input.keyUp("w");
    await until("W down and up", () => after(recorder, mark).includes("keyup 87"));
    const lines = after(recorder, mark);
    expect(lines.indexOf("keydown 87")).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("keydown 87")).toBeLessThan(lines.indexOf("keyup 87"));
  }, 120_000);

  it("presses a chord: modifiers down first, released in reverse", async () => {
    const mark = recorder.lines().length;
    await sendInput(state, { action: "key", keys: "ctrl+a" });
    await until("ctrl+a", () => after(recorder, mark).includes("keyup 17"));
    const lines = after(recorder, mark);
    const order = ["keydown 17", "keydown 65", "keyup 65", "keyup 17"].map((l) => lines.indexOf(l));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  }, 120_000);

  it("types Unicode text", async () => {
    const mark = recorder.lines().length;
    const text = "héllo ✓/";
    await sendInput(state, { action: "type", text });
    await until("the typed text", () => after(recorder, mark).filter((l) => l.startsWith("char ")).length >= text.length);
    const typed = after(recorder, mark)
      .filter((l) => l.startsWith("char "))
      .map((l) => String.fromCharCode(Number(l.slice(5))))
      .join("");
    expect(typed).toBe(text);
  }, 120_000);

  it("clicks the requested client pixel", async () => {
    const mark = recorder.lines().length;
    await sendInput(state, { action: "click", x: 300, y: 200 });
    await until("the click", () => after(recorder, mark).some((l) => l.startsWith("mouseup Left")));
    const down = after(recorder, mark).find((l) => l.startsWith("mousedown Left"));
    const [, , x, y] = (down ?? "").split(" ").map(Number);
    expect(Math.abs((x ?? -99) - 300)).toBeLessThanOrEqual(1);
    expect(Math.abs((y ?? -99) - 200)).toBeLessThanOrEqual(1);
  }, 120_000);

  it("moves the pointer by relative motion", async () => {
    await sendInput(state, { action: "move", x: 150, y: 150 });
    await sleep(200);
    const mark = recorder.lines().length;
    await playerInput(state).look(60, 0);
    await until("the relative move", () => after(recorder, mark).some((l) => l.startsWith("mousemove ")));
    const moves = after(recorder, mark).filter((l) => l.startsWith("mousemove "));
    expect(Number(moves.at(-1)?.split(" ")[1])).toBeGreaterThan(150);
  }, 120_000);

  it("delivers nothing while another window is in the foreground, and reports the loss once", async () => {
    const input = playerInput(state);
    await retry(async () => input.foreground?.activate());
    const h = await helperFor(recorder);
    let losses = 0;
    h.onLost(() => losses++);
    let takeovers = 0;
    input.foreground?.onTakeover(() => takeovers++);
    await focus(h);
    await focus(await helperFor(other));
    await until("the loss report", () => !h.foreground && takeovers > 0, 5_000);
    const mark = recorder.lines().length;
    expect(await h.request({ verb: "down", key: 0x41 })).toBe("blocked");
    expect(await h.request({ verb: "move", x: 5, y: 5 })).toBe("blocked");
    await expect(input.keyDown("b")).rejects.toThrow(FOREGROUND_MESSAGE);
    expect(input.foreground?.userHasControl).toBe(true);
    await sleep(500);
    // Windows itself may send a mouse move to a window that changes z-order; keys, characters and clicks must not arrive.
    expect(after(recorder, mark).filter((l) => /^key|^char|^mousedown|^mouseup/.test(l))).toEqual([]);
    expect(losses).toBe(1);
  }, 120_000);

  it("lets go of a held key when the helper closes", async () => {
    const h = await helperFor(recorder);
    await focus(h);
    const mark = recorder.lines().length;
    expect(await h.request({ verb: "down", key: 0x42 })).toBe("ok");
    await until("B down", () => after(recorder, mark).includes("keydown 66"));
    h.close();
    await until("B up", () => after(recorder, mark).includes("keyup 66"), 10_000);
  }, 120_000);
});
