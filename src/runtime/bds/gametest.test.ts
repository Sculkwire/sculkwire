import { describe, expect, it } from "vitest";
import { parseConsoleResults, parseTestResults, testDiagnostics } from "./gametest.ts";
import { parseLinks } from "./install.ts";
import { setProperties } from "./instance.ts";
import type { IndexedPack } from "./logparse.ts";
import { enableExperiments, readLevelDat, TAG, writeLevelDat, type NbtCompound } from "./nbt.ts";

// logs/test-results-gametest.json as BDS 1.26.63.1 wrote it for the bundled fixture.
const RESULTS = {
  passed: 1,
  failed: 1,
  totalRun: 2,
  total: 2,
  unique: 2,
  rerun_failures: false,
  results: [
    { name: "sculkwire:passes", iteration: 1, startTime: "2026-11-07T10:06:56.317Z", endTime: "2026-11-07T10:06:56.367Z", result: "passed", error: "" },
    { name: "sculkwire:fails", iteration: 1, startTime: "2026-11-07T10:06:56.317Z", endTime: "2026-11-07T10:06:56.317Z", result: "failed", error: "sculkwire fixture: expected failure" },
  ],
  missingTags: [],
  current_iteration: 1,
  testBuildId: 1,
  startTime: "2026-11-07T10:06:56.012Z",
  endTime: "2026-11-07T10:06:56.363Z",
  runTimedOut: false,
};

describe("GameTest results", () => {
  it("parses the automation results file", () => {
    const s = parseTestResults(RESULTS);
    expect(s).toMatchObject({ passed: 1, failed: 1, total: 2, runTimedOut: false, missingTags: [] });
    expect(s.results).toEqual([
      { name: "sculkwire:passes", result: "passed", error: "", durationMs: 50, iteration: 1 },
      { name: "sculkwire:fails", result: "failed", error: "sculkwire fixture: expected failure", durationMs: 0, iteration: 1 },
    ]);
  });

  it("accepts the older `YYYY-MM-DD HH:MM:SS` timestamps and missing counters", () => {
    const s = parseTestResults({
      results: [{ name: "t:a", startTime: "2026-03-24 00:14:06", endTime: "2026-03-24 00:14:08", result: "failed", error: "I failed" }],
    });
    expect(s).toMatchObject({ passed: 0, failed: 1, total: 1 });
    expect(s.results[0]!.durationMs).toBe(2000);
  });

  it("rejects a results file of the wrong shape", () => {
    expect(() => parseTestResults({ results: "nope" })).toThrow();
  });

  it("parses console results of `gametest runset`", () => {
    const r = parseConsoleResults([
      "Running test batch ':0' (2 tests)...",
      "onTestStructureLoaded: sculkwire:passes",
      "onTestPassed: sculkwire:passes",
      "onTestFailed: sculkwire:fails - sculkwire fixture: expected failure",
    ]);
    expect(r.expected).toBe(2);
    expect(r.results.map((t) => [t.name, t.result, t.error])).toEqual([
      ["sculkwire:passes", "passed", ""],
      ["sculkwire:fails", "failed", "sculkwire fixture: expected failure"],
    ]);
  });

  it("anchors failures at the register() call", () => {
    const text = 'import { register } from "@minecraft/server-gametest";\n\nregister("sculkwire", "fails", (test) => {\n  test.fail("x");\n});\n';
    const packs: IndexedPack[] = [
      {
        pack: { kind: "behavior", dir: "/p", relDir: "BP", uuid: "u", version: "1.0.0" },
        files: ["scripts/main.js"],
        identifiers: new Map(),
        texts: new Map([["scripts/main.js", text]]),
      },
    ];
    const [d] = testDiagnostics(parseTestResults(RESULTS), packs);
    expect(d).toMatchObject({ code: "gametest.failed", source: "gametest", file: "BP/scripts/main.js", range: { start: { line: 3, column: 1 } } });
    expect(d!.message).toContain("expected failure");
  });
});

describe("install + instance helpers", () => {
  it("parses the download-links API", () => {
    const links = parseLinks({
      result: {
        links: [
          { downloadType: "serverBedrockLinux", downloadUrl: "https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.63.1.zip" },
          { downloadType: "serverBedrockPreviewWindows", downloadUrl: "https://www.minecraft.net/bedrockdedicatedserver/bin-win-preview/bedrock-server-1.26.70.23.zip" },
          { downloadType: "serverJar", downloadUrl: "https://piston-data.mojang.com/server.jar" },
        ],
      },
    });
    expect(links).toEqual([
      { channel: "stable", platform: "linux", version: "1.26.63.1", url: expect.stringContaining("bin-linux/") },
      { channel: "preview", platform: "windows", version: "1.26.70.23", url: expect.stringContaining("bin-win-preview/") },
    ]);
  });

  it("rewrites and appends server.properties keys", () => {
    expect(setProperties("a=1\n# c\nb=2", { b: "3", d: "4" })).toBe("a=1\n# c\nb=3\nd=4");
  });
});

describe("level.dat NBT", () => {
  it("round-trips every tag type and enables experiments", () => {
    const root: NbtCompound = new Map([
      ["LevelName", { type: TAG.String, value: "wörld" }],
      ["b", { type: TAG.Byte, value: -3 }],
      ["s", { type: TAG.Short, value: 1234 }],
      ["i", { type: TAG.Int, value: -70000 }],
      ["l", { type: TAG.Long, value: 1n << 40n }],
      ["f", { type: TAG.Float, value: 0.5 }],
      ["d", { type: TAG.Double, value: Math.PI }],
      ["ba", { type: TAG.ByteArray, value: new Uint8Array([1, 2, 3]) }],
      ["ia", { type: TAG.IntArray, value: [1, -1] }],
      ["la", { type: TAG.LongArray, value: [5n] }],
      ["list", { type: TAG.List, value: { elementType: TAG.Int, items: [{ type: TAG.Int, value: 7 }] } }],
    ]);
    const bytes = writeLevelDat({ storageVersion: 10, rootName: "", root });
    expect(new DataView(bytes.buffer).getInt32(4, true)).toBe(bytes.byteLength - 8);
    const back = readLevelDat(bytes);
    expect(back.storageVersion).toBe(10);
    expect(back.root).toEqual(root);

    enableExperiments(back.root, ["gametest"]);
    const exp = readLevelDat(writeLevelDat(back)).root.get("experiments")!.value as NbtCompound;
    expect([...exp.keys()].sort()).toEqual(["experiments_ever_used", "gametest", "saved_with_toggled_experiments"]);
  });
});
