/**
 * The agent as the fallback for `game_query` and `game_log`: what the agent's answers become, and when `game_log` reads
 * the agent's content-log ring instead of the game's log files.
 */
import { describe, expect, it } from "vitest";
import { EngineSession, type EnginePlayerState } from "../engine/engine.ts";
import type { EngineResult } from "../engine/failure.ts";
import type { ContentLogPage } from "../engine/worldread.ts";
import { EngineLogReader, engineLogEntries, engineQuery, type FileLog } from "./engineread.ts";

/** A session whose `log.content` answers the pages in order (each call asks with the cursor it was given). */
function ringSession(pages: ContentLogPage[]): { session: EngineSession; cursors: unknown[] } {
  const cursors: unknown[] = [];
  const session = new EngineSession({ port: 9, timeoutMs: 100 });
  session.call = async <T>(method: string, params?: unknown): Promise<EngineResult<T>> => {
    if (method !== "log.content") return { ok: false, code: -32601, reason: "unknown_method", message: method };
    cursors.push(params && typeof params === "object" && "since" in params ? params.since : undefined);
    const page = pages.shift();
    return page ? { ok: true, value: page as T } : { ok: false, code: -32000, reason: "not_attached", message: "no agent" };
  };
  return { session, cursors };
}

const error = (seq: number, message: string) => ({ seq, time: Date.UTC(2026, 0, 1), area: "Scripting", level: "error", message });
const page = (entries: ContentLogPage["entries"], next: number): ContentLogPage => ({ entries, next, dropped: 0, emitting: true, forced: false });
const fileLog = (text: string, hasFile = true): FileLog => ({
  diagnostics: [],
  text,
  cursor: hasFile ? { log: { file: "ContentLog.txt", offset: 0 } } : {},
});

describe("game_log's source", () => {
  it("reads the agent's ring when no log file exists, and follows its cursor", async () => {
    const { session, cursors } = ringSession([page([error(1, "first")], 1), page([error(2, "second")], 2)]);
    const reader = new EngineLogReader(session);
    const first = await reader.read(fileLog("", false), []);
    expect(first.source).toBe("engine");
    expect(first.diagnostics.map((d) => d.message)).toEqual([expect.stringContaining("first")]);
    expect(first.note).toContain("no content-log file exists");
    await reader.read(fileLog("", false), []);
    expect(cursors).toEqual([0, 1]);
  });

  it("keeps the file when it is being written, and stays on the agent once it switched", async () => {
    const { session } = ringSession([page([error(1, "in both")], 1), page([error(2, "only in the ring")], 2), page([error(3, "later")], 3)]);
    const reader = new EngineLogReader(session);
    expect((await reader.read(fileLog("12:00:00[Scripting][error]-in both\n"), [])).source).toBe("file");
    // The file read nothing while the game logged an error: it is not being written.
    expect((await reader.read(fileLog(""), [])).source).toBe("engine");
    // The file flushing later is not reported a second time.
    expect((await reader.read(fileLog("12:00:00[Scripting][error]-only in the ring\n"), [])).source).toBe("engine");
  });

  it("answers from the file when no agent answers", async () => {
    const { session } = ringSession([]);
    const file = fileLog("12:00:00[Scripting][error]-x\n");
    expect(await new EngineLogReader(session).read(file, [])).toEqual({ diagnostics: [], text: file.text, source: "file" });
  });
});

describe("the agent's content-log entries", () => {
  it("map their game level names to severities and drop info and noise", () => {
    const entries = engineLogEntries([
      { seq: 1, time: 0, area: "Molang", level: "warning", message: "Error: unknown query" },
      { seq: 2, time: 0, area: "Scripting", level: "inform", message: "[sculkwire:ready]" },
      { seq: 3, time: 0, area: null, level: "error", message: "  spread\n  over lines " },
      { seq: 4, time: 0, area: "Scripting", level: "warning", message: "Debugger attached to [127.0.0.1] on port [19151]." },
    ]);
    expect(entries).toEqual([
      { severity: "warning", category: "Molang", message: "Error: unknown query", origin: "content-log" },
      { severity: "error", message: "spread over lines", origin: "content-log" },
    ]);
  });
});

describe("game_query through the agent", () => {
  it("answers player in the helper's shape, without what the agent does not read", async () => {
    const session = new EngineSession({ port: 9, timeoutMs: 100 });
    const state: EnginePlayerState = { position: [1.234, -60, 5], rotation: [10, -90], dimension: 1 };
    session.playerState = async () => ({ ok: true, value: state });
    expect(await engineQuery("player", {}, session)).toEqual({
      ok: true,
      value: [{ location: { x: 1.23, y: -60, z: 5 }, rotation: { x: 10, y: -90 }, dimension: "minecraft:nether" }],
    });
  });

  it("reads the block under the player's feet when no point is given", async () => {
    const session = new EngineSession({ port: 9, timeoutMs: 100 });
    session.playerState = async () => ({ ok: true, value: { position: [1.5, 64, -0.5], rotation: [0, 0], dimension: 0 } });
    const sent: unknown[] = [];
    session.call = async <T>(method: string, params?: unknown): Promise<EngineResult<T>> => {
      sent.push({ method, params });
      return { ok: true, value: null as T };
    };
    expect(await engineQuery("block", {}, session)).toEqual({ ok: true, value: null });
    expect(sent).toEqual([{ method: "world.block", params: { x: 1, y: 64, z: -1 } }]);
  });

  it("leaves the kinds only the helper pack answers to it", async () => {
    expect(await engineQuery("scores", {}, new EngineSession({ port: 9, timeoutMs: 100 }))).toBeUndefined();
  });
});
