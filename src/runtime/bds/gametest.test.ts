import { describe, expect, it } from "vitest";
import { parseConsoleResults, parseTestResults, testDiagnostics } from "./gametest.ts";
import { parseLinks } from "./install.ts";
import { setProperties } from "./instance.ts";
import type { IndexedPack } from "../gamelog/logparse.ts";

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

