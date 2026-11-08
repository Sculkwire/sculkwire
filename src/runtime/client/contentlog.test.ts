import { copyFile, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientDiagnostics, contentEnd, contentLogFromDebugLog, entryDiagnostics, parseClientLog, printEntries, readContentSince, unmirroredPrints } from "./contentlog.ts";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "test", "fixtures", "client_logs");

/** A logs dir holding the previous launch's logs, as the bridge sees it just before it starts the game. */
async function previousLaunch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sculk-logs-"));
  await writeFile(join(dir, "ContentLog2026-11-08_18-40-19_1.txt"), "");
  const old = new Date(Date.now() - 3_600_000);
  await writeFile(join(dir, "Debug_Log2026-11-08_18-40-19.txt"), "[2026-11-08 18:40:54:916 INFO NETWORK 400 296] [400][V][XSAPI] Cleanup\n");
  for (const name of await readdir(dir)) await utimes(join(dir, name), old, old);
  return dir;
}

/** The game starts: a new engine log and a new, still unflushed content log (the fixtures), written just now. */
async function launch(dir: string): Promise<void> {
  const now = new Date();
  for (const name of await readdir(FIXTURES)) {
    await copyFile(join(FIXTURES, name), join(dir, name));
    await utimes(join(dir, name), now, now);
  }
}

describe("live content log", () => {
  it("reports load-time errors on the first read after launch, though the content log file is still empty", async () => {
    const dir = await previousLaunch();
    try {
      const cursor = await contentEnd(dir);
      expect(cursor?.file).toMatch(/Debug_Log2026-11-08_18-40-19\.txt$/);
      await launch(dir);
      const { text, end } = await readContentSince(dir, cursor);
      expect(end?.file).toMatch(/Debug_Log2026-11-08_20-49-09\.txt$/);
      expect(text).toContain("20:49:12[Scripting][error]-Plugin [Frost Wand Behavior Pack - 1.0.0] - does not contain main file [steve/frost_wand/main.js].");
      const diagnostics = clientDiagnostics(text, []);
      expect(diagnostics.map((d) => [d.code, d.severity, d.message])).toEqual(
        expect.arrayContaining([
          ["content-log.scripting", "error", "[Scripting] Plugin [Frost Wand Behavior Pack - 1.0.0] - does not contain main file [steve/frost_wand/main.js]."],
          ["content-log.scripting", "warning", "[Scripting] [frost] hit minecraft:cow slowness amp=1 dur=100"],
          ["content-log.ui", "error", "[UI] ui/hud_screen.json | hud_title | Unknown control type"],
          ["script.error", "error", expect.stringContaining("TypeError: cannot read property 'x' of undefined")],
        ]),
      );
      // Engine-only lines (level transitions, persona, network, stacks of engine errors) are not content-log entries.
      expect(text).not.toMatch(/PendingAppearance|Level-Level|XSAPI|Call stack|FileSystem\.cpp|websocket/);
      // The cursor moves on: a second read returns nothing new.
      await expect(readContentSince(dir, end)).resolves.toEqual({ text: "", end });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the content log file when there is no engine log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sculk-logs-"));
    try {
      await writeFile(join(dir, "ContentLog2026-11-08_20-49-09_1.txt"), "20:49:12[Json][error]-items/wand.json | bad\n\n");
      const { text, end } = await readContentSince(dir, undefined);
      expect(text).toContain("[Json][error]");
      expect(end?.file).toMatch(/ContentLog/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps continuation lines of a mirrored entry and drops those of engine lines", () => {
    const text = contentLogFromDebugLog(
      [
        "[2026-10-12 15:57:43:950 ERROR SCRIPTING 892 308] [Scripting] [Godzilla] Error: boom",
        "    at f (godzilla/main.js:5811)",
        "\r",
        "[2026-10-12 15:57:44:001 INFO UNKNOWN 400 324] Error: generic",
        "Call stack:[",
        "]",
        "",
      ].join("\n"),
    );
    expect(text).toBe("15:57:43[Scripting][error]-[Godzilla] Error: boom\n    at f (godzilla/main.js:5811)\n\n");
  });
});

describe("content log over the script debugger", () => {
  it("reports a console.warn line once, from the log with its area, not again from its print", () => {
    const logEntries = parseClientLog("20:49:20[Scripting][warning]-[frost] hit minecraft:cow slowness amp=1 dur=100\n\n");
    const prints = [
      { level: "warn" as const, message: "[frost] hit minecraft:cow slowness amp=1 dur=100" },
      { level: "warn" as const, message: "[frost] hit minecraft:cow slowness amp=1 dur=100" },
      { level: "error" as const, message: "only sent over the debugger" },
    ];
    const rest = unmirroredPrints(logEntries, prints);
    // One log line absorbs one print: the second identical warning is a separate event.
    expect(rest.map((p) => p.message)).toEqual(["[frost] hit minecraft:cow slowness amp=1 dur=100", "only sent over the debugger"]);
    const diagnostics = entryDiagnostics([...logEntries, ...printEntries(rest)], []);
    expect(diagnostics.map((d) => d.code).sort()).toEqual(["content-log.error", "content-log.scripting", "content-log.warning"]);
    const onlyLog = entryDiagnostics([...logEntries, ...printEntries(unmirroredPrints(logEntries, prints.slice(0, 1)))], []);
    expect(onlyLog.map((d) => d.code)).toEqual(["content-log.scripting"]);
  });
});
