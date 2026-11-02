import { describe, expect, it } from "vitest";
import type { PackInfo } from "../../core/project.ts";
import { entriesToDiagnostics, entryKey, locate, parseConsole, parseContentLog, mergeEntries, type IndexedPack } from "./logparse.ts";
import { packStackIds } from "./check.ts";

function pack(kind: PackInfo["kind"], relDir: string, name: string, texts: Record<string, string>, identifiers: Record<string, string> = {}): IndexedPack {
  return {
    pack: { kind, dir: `/abs/${relDir}`, relDir, name, uuid: `${relDir}-uuid`, version: "1.0.0" },
    folder: `0_${relDir}`,
    files: Object.keys(texts),
    identifiers: new Map(Object.entries(identifiers)),
    texts: new Map(Object.entries(texts)),
  };
}

const RECIPE = `{
  "format_version": "1.20.10",
  "minecraft:recipe_shaped": {
    "description": {
      "identifier": "mcbe:test_item_recipe"
    }
  }
}`;

const BP = pack(
  "behavior",
  "BP",
  "MCBE Fixture BP",
  { "manifest.json": "{}", "recipes/test_item.json": RECIPE, "scripts/main.js": "x", "functions/mcbe/tick.mcfunction": "a\nb\nc", "entities/test_mob.json": '{"id": "mcbe:test_mob"}' },
  { "mcbe:test_item_recipe": "recipes/test_item.json", "mcbe:test_mob": "entities/test_mob.json" },
);
const RP = pack("resource", "RP", "MCBE Fixture RP", { "manifest.json": "{}", "textures/terrain_texture.json": "{}" });

// Console output as BDS 1.26.63.1 prints it with content-log-console-output-enabled.
const CONSOLE = [
  "[2026-11-07 17:05:35:800 INFO] Experiment(s) active: gtst",
  "[2026-11-07 17:05:35:825 WARN] [Scripting] Debugger auto-attach waiting for [10] seconds.",
  "",
  "[2026-11-07 17:05:35:898 ERROR] [Scripting] [MCBE Fixture BP] Error: mcbe fixture: deliberate script error    at <anonymous> (main.js:7)",
  "",
  "",
  "[2026-11-07 17:05:35:898 ERROR] [Scripting] Plugin [MCBE Fixture BP - 1.0.0] - [main.js] ran with error: [Error: mcbe fixture: deliberate script error    at <anonymous> (main.js:7)",
  "]",
  "",
  "[2026-11-07 17:05:36:180 ERROR] [Recipes] recipes/test_item.json | mcbe:test_item_recipe | 1.20+ Recipes require unlock data",
  "",
  "Running test batch ':0' (2 tests)...",
  "[2026-11-07 17:05:36:200 WARN] [Commands] Function mcbe/tick failed to load correctly with error(s):",
  "[2026-11-07 17:05:36:201 WARN] [Commands] Error on line 2: command failed to parse with error 'Syntax error'",
  "[2026-11-07 17:05:36:300 WARN] [Entity] mcbe:test_mob | components | minecraft:health | value must be a number",
];

describe("console parsing", () => {
  it("parses severity and category, folds continuation lines, drops info and debugger noise", () => {
    const entries = parseConsole(CONSOLE);
    expect(entries.map((e) => [e.severity, e.category])).toEqual([
      ["error", "Scripting"],
      ["error", "Scripting"],
      ["error", "Recipes"],
      ["warning", "Commands"],
      ["warning", "Commands"],
      ["warning", "Entity"],
    ]);
    expect(entries[1]!.message).toMatch(/ran with error: \[Error: .*\(main\.js:7\) \]$/);
  });

  it("does not fold unprefixed lines that follow a blank line into the previous entry", () => {
    const [e] = parseConsole(["[2026-11-07 17:06:56:017 WARN] [Scripting] hello", "", "Running test batch ':0' (2 tests)..."]);
    expect(e!.message).toBe("hello");
  });
});

describe("content log file parsing", () => {
  it("parses `time[Area][level]-message` lines and merges duplicates of the console", () => {
    const file = "17:05:36[Recipes][error]-recipes/test_item.json | mcbe:test_item_recipe | 1.20+ Recipes require unlock data\n\n17:05:37[Molang][warning]-bad query\n17:05:38[Json][inform]-ignored\n";
    const fromFile = parseContentLog(file);
    expect(fromFile).toEqual([
      { severity: "error", category: "Recipes", message: "recipes/test_item.json | mcbe:test_item_recipe | 1.20+ Recipes require unlock data", origin: "content-log" },
      { severity: "warning", category: "Molang", message: "bad query", origin: "content-log" },
    ]);
    const merged = mergeEntries(parseConsole(CONSOLE), fromFile);
    expect(merged.filter((e) => e.category === "Recipes")).toHaveLength(1);
    expect(merged.some((e) => e.category === "Molang")).toBe(true);
  });
});

describe("content log → diagnostics", () => {
  const diags = entriesToDiagnostics(parseConsole(CONSOLE), [BP, RP], { label: "BDS 1.26.63.1" });

  it("maps script errors to the script file and line, once", () => {
    const script = diags.filter((d) => d.code === "script.error");
    expect(script).toHaveLength(1);
    expect(script[0]).toMatchObject({ severity: "error", source: "bds", file: "BP/scripts/main.js", range: { start: { line: 7, column: 1 } } });
  });

  it("maps a pack-relative path to the file and locates the identifier in it", () => {
    expect(diags.find((d) => d.code === "content-log.recipes")).toMatchObject({
      file: "BP/recipes/test_item.json",
      range: { start: { line: 5, column: 21 } },
      message: expect.stringContaining("BDS 1.26.63.1: [Recipes]"),
    });
  });

  it("upgrades function-load warnings to errors and maps Function names and line numbers", () => {
    const fn = diags.filter((d) => d.code === "content-log.commands");
    expect(fn.map((d) => d.severity)).toEqual(["error", "error"]);
    expect(fn[0]).toMatchObject({ file: "BP/functions/mcbe/tick.mcfunction" });
    // Follow-up line of the same category inherits the file; "Error on line N" gives the line.
    expect(fn[1]).toMatchObject({ file: "BP/functions/mcbe/tick.mcfunction", range: { start: { line: 2, column: 1 } } });
  });

  it("maps identifiers to the defining file", () => {
    expect(diags.find((d) => d.code === "content-log.entity")).toMatchObject({ severity: "warning", file: "BP/entities/test_mob.json", range: { start: { line: 1 } } });
  });

  it("subtracts baseline entries (digits normalized)", () => {
    const entries = parseConsole(["[2026-11-07 17:00:00:000 WARN] [World] chunk 12 took 34 ms"]);
    const baseline = new Set([entryKey({ category: "World", message: "chunk 99 took 1 ms" })]);
    expect(entriesToDiagnostics(entries, [BP], { baseline })).toEqual([]);
    expect(entriesToDiagnostics(entries, [BP])).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("locate returns 1-based line/column ranges", () => {
    expect(locate("ab\ncd\nxyz", "yz")).toEqual({ start: { line: 3, column: 2 }, end: { line: 3, column: 4 } });
    expect(locate("abc", "q")).toBeUndefined();
  });

  it("reads pack ids from the Pack Stack line", () => {
    const ids = packStackIds([
      "[2026-11-07 17:05:35:816 INFO] Pack Stack - [00] MCBE Fixture BP (id: 5b1c7a0e-2f1d-4c55-9a39-1e7d3b6a0b01, version: 1.0.0) @ worlds/x/behavior_packs/0_BP",
    ]);
    expect([...ids]).toEqual(["5b1c7a0e-2f1d-4c55-9a39-1e7d3b6a0b01"]);
  });
});
