import { describe, expect, it } from "vitest";
import { markdownTable, summarize, worldEntryOf, type RunRecord } from "./report.ts";

describe("report", () => {
  const rec = (run: number, success: boolean, health: number, extra: RunRecord["extra"] = {}): RunRecord => ({
    run,
    success,
    outcome: { ok: success, message: "", durationMs: 10_000, healthStart: 20, healthEnd: health, damageTaken: 20 - health, blastDamage: 0, fallDamage: 0, falls: 0, deaths: health === 0 ? 1 : 0, kills: success ? 3 : 1, lost: 0, exploded: 0, hurts: 2 },
    extra,
    note: "",
  });
  it("averages the runs and prints one row per scenario", () => {
    const r = summarize("zombies3", "combat", "engine", [rec(1, true, 14, { cleared: true, hits: 6 }), rec(2, false, 0, { cleared: false, hits: 4 })]);
    expect(r.summary).toMatchObject({ runs: 2, successes: 1, avgHealthLeft: 7, minHealthLeft: 0, deaths: 1, kills: 4, extra: { cleared: 1, hits: 5 } });
    expect(markdownTable([r])).toMatch(/\| zombies3 \| engine \| 1\/2 \| 10 \| 13 \| 7 \| 0 \| 1 \| 4 \|/);
  });
  it("adds a view column only when the reports carry a view", () => {
    const first = { ...summarize("husks3", "combat", "engine", [rec(1, true, 14)]), view: "first" as const };
    const third = { ...summarize("husks3", "combat", "engine", [rec(1, false, 0)]), view: "third" as const };
    const table = markdownTable([first, third]).split("\n");
    expect(table[0]).toMatch(/^\| scenario \| input \| view \| success \|/);
    expect(table[1]?.split("|").length).toBe(table[0]?.split("|").length);
    expect(table[2]).toMatch(/^\| husks3 \| engine \| first \| 1\/1 \|/);
    expect(table[3]).toMatch(/^\| husks3 \| engine \| third \| 0\/1 \|/);
    expect(markdownTable([summarize("husks3", "combat", "engine", [rec(1, true, 14)])])).not.toMatch(/view/);
  });
  it("adds a stance column after the view only when the reports carry a stance", () => {
    const kite = { ...summarize("cornered", "combat", "engine", [rec(1, true, 14)]), view: "first" as const, stance: "kite" as const };
    const guard = { ...summarize("cornered", "combat", "engine", [rec(1, false, 0)]), view: "first" as const, stance: "guard" as const };
    const table = markdownTable([kite, guard]).split("\n");
    expect(table[0]).toMatch(/^\| scenario \| input \| view \| stance \| success \|/);
    expect(table[1]?.split("|").length).toBe(table[0]?.split("|").length);
    expect(table[2]).toMatch(/^\| cornered \| engine \| first \| kite \| 1\/1 \|/);
    expect(table[3]).toMatch(/^\| cornered \| engine \| first \| guard \| 0\/1 \|/);
    expect(markdownTable([summarize("cornered", "combat", "engine", [rec(1, true, 14)])])).not.toMatch(/stance/);
  });
});

describe("world entry", () => {
  it("reports how the bridge reached the world, and says so when it never did", () => {
    const walked = worldEntryOf({ entry: () => ({ by: "auto-enter", seconds: 146.4, clicks: 3 }) });
    expect(walked.entry).toEqual({ by: "auto-enter", seconds: 146.4, clicks: 3 });
    expect(walked.footer).toBe("World entry: auto-enter in 146.4 s from the bridge's start, 3 inputs walking the menus");
    expect(worldEntryOf({ entry: () => ({ by: "launch", seconds: 41 }) }).footer).toBe("World entry: launch in 41 s from the bridge's start");
    const never = worldEntryOf({ entry: () => undefined });
    expect(never.entry).toBeUndefined();
    expect(never.footer).toMatch(/not recorded/);
  });
});
