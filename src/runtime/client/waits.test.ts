import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../../core/diagnostic.ts";
import { readEvents, waitUntil, type WaitDeps } from "./waits.ts";

type Read = { diagnostics: Diagnostic[]; text: string };

/** Deps whose log grows by one read per poll, on a fake clock that each sleep advances. */
function fakeDeps(reads: Read[], opts: { ready?: boolean; running?: boolean } = {}): WaitDeps & { queries: string[] } {
  let clock = 0;
  let n = 0;
  const queries: string[] = [];
  return {
    queries,
    status: () => ({ running: opts.running ?? true, ready: opts.ready ?? true, manualSteps: [] }),
    query: async (kind) => {
      queries.push(kind);
      return { events: [], next: 0, dropped: 0, reset: false, tick: 0 };
    },
    logMark: async () => ({ log: { file: "Debug_Log.txt", offset: 10 }, printSeq: 4 }),
    logs: async (cursor) => {
      const read = reads[n++] ?? { diagnostics: [], text: "" };
      return { ...read, cursor: { log: { file: "Debug_Log.txt", offset: (cursor.log?.offset ?? 0) + 1 }, printSeq: cursor.printSeq } };
    },
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  };
}

const scriptError: Diagnostic = { severity: "error", code: "content-log.scripting", message: "TypeError: foo is not a function", source: "client", file: "BP/scripts/main.js" };
const warning: Diagnostic = { severity: "warning", code: "content-log.entity", message: "unknown component minecraft:bar", source: "client" };

describe("wait_until log", () => {
  it("is met by a new log line matching the pattern after a few reads", async () => {
    const deps = fakeDeps([{ diagnostics: [], text: "" }, { diagnostics: [], text: "[Scripting][inform]-boss spawned\n" }]);
    const r = await waitUntil(deps, { kind: "log", pattern: "boss SPAWNED" }, 5_000);
    expect(r).toEqual({ met: true, timedOut: false, elapsedMs: 250, observed: { line: "[Scripting][inform]-boss spawned" } });
  });

  it("matches diagnostics by their formatted text, and errorsOnly skips warnings and plain lines", async () => {
    const deps = fakeDeps([{ diagnostics: [warning], text: "foo is not a function (in a plain line)" }, { diagnostics: [scriptError], text: "" }]);
    const r = await waitUntil(deps, { kind: "log", pattern: "main\\.js|minecraft:bar|foo", errorsOnly: true }, 5_000);
    expect(r.observed).toEqual({ diagnostic: scriptError });
    expect(r.elapsedMs).toBe(250);
  });

  it("without a pattern any new diagnostic meets it; nothing new times out", async () => {
    expect((await waitUntil(fakeDeps([{ diagnostics: [warning], text: "" }]), { kind: "log" })).observed).toEqual({ diagnostic: warning });
    const r = await waitUntil(fakeDeps([]), { kind: "log", pattern: "never" }, 1_000);
    expect(r).toEqual({ met: false, timedOut: true, elapsedMs: 1_000, observed: null });
  });

  it("refuses a pattern that is not a regular expression", async () => {
    await expect(waitUntil(fakeDeps([]), { kind: "log", pattern: "(" })).rejects.toThrow(/not a valid regular expression/);
  });
});

describe("helper refusals", () => {
  it("refuses world conditions and events while the helper is not answering, without asking it", async () => {
    const deps = fakeDeps([], { ready: false });
    await expect(waitUntil(deps, { kind: "ticks", ticks: 5 })).rejects.toThrow(/helper pack is not answering/);
    await expect(readEvents(deps, { since: "now" })).rejects.toThrow(/helper pack is not answering/);
    await expect(readEvents(fakeDeps([], { running: false }), {})).rejects.toThrow(/game_launch/);
    expect(deps.queries).toEqual([]);
  });
});
