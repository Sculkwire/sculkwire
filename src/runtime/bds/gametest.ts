/**
 * Headless GameTest runs on BDS.
 * - `automation` (default): `test_config.json` in the server root (`automation_gametest_tags`, …). BDS runs the
 *   tagged tests after load, writes `logs/test-results-gametest.json` and exits by itself (observed on 1.26.63.1);
 *   if it keeps running we stop it once the results file exists or the timeout hits.
 * - `command` (fallback): start the server, send `gametest runset <tag>` on stdin and read the console's
 *   `onTestPassed:` / `onTestFailed:` lines.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Diagnostic } from "../../core/diagnostic.ts";
import { compareDiagnostics, ExitCode } from "../../core/diagnostic.ts";
import { disposeBuild, prepareInstance, projectPacks, writeRawLog, type BdsRunOptions, type ProjectPacks } from "./check.ts";
import { disposeInstance, exists } from "./instance.ts";
import { entriesToDiagnostics, locate, sourceLocation, type IndexedPack, type SourceLocation } from "./logparse.ts";
import { BdsServer } from "./server.ts";
import { collectLogs } from "./template.ts";

export type TestOutcome = "passed" | "failed" | "timed_out" | "skipped";

export interface TestResult {
  name: string;
  result: TestOutcome;
  /** Empty when the test passed. */
  error: string;
  durationMs: number;
  iteration: number;
}

export interface GameTestSummary {
  passed: number;
  failed: number;
  total: number;
  results: TestResult[];
  runTimedOut: boolean;
  /** Tags requested that matched no test. */
  missingTags: string[];
}

const ResultsFile = z.object({
  passed: z.number().optional(),
  failed: z.number().optional(),
  totalRun: z.number().optional(),
  total: z.number().optional(),
  runTimedOut: z.boolean().optional(),
  missingTags: z.array(z.string()).optional(),
  results: z
    .array(
      z.object({
        name: z.string(),
        iteration: z.number().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        result: z.string(),
        error: z.string().optional(),
      }),
    )
    .optional(),
});

/** BDS writes ISO timestamps (1.26.63) or `YYYY-MM-DD HH:MM:SS` (older builds). */
function parseTime(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const t = Date.parse(text.includes("T") ? text : `${text.replace(" ", "T")}Z`);
  return Number.isNaN(t) ? undefined : t;
}

function outcome(text: string): TestOutcome {
  const t = text.toLowerCase();
  if (t === "passed" || t === "success" || t === "succeeded") return "passed";
  if (t.includes("time")) return "timed_out";
  if (t === "skipped") return "skipped";
  return "failed";
}

/** Parse `logs/test-results-gametest.json`. */
export function parseTestResults(json: unknown): GameTestSummary {
  const data = ResultsFile.parse(json);
  const results: TestResult[] = (data.results ?? []).map((r) => {
    const start = parseTime(r.startTime);
    const end = parseTime(r.endTime);
    return {
      name: r.name,
      result: outcome(r.result),
      error: r.error ?? "",
      durationMs: start !== undefined && end !== undefined ? Math.max(0, end - start) : 0,
      iteration: r.iteration ?? 1,
    };
  });
  const passed = data.passed ?? results.filter((r) => r.result === "passed").length;
  const failed = data.failed ?? results.filter((r) => r.result !== "passed" && r.result !== "skipped").length;
  return {
    passed,
    failed,
    total: data.totalRun ?? data.total ?? results.length,
    results,
    runTimedOut: data.runTimedOut ?? false,
    missingTags: data.missingTags ?? [],
  };
}

/**
 * Console GameTest lines → results: `Running test batch ':0' (2 tests)...`, `onTestPassed: ns:name`,
 * `onTestFailed: ns:name - message`. `expected` is the sum of announced batch sizes.
 */
export function parseConsoleResults(lines: readonly string[]): { results: TestResult[]; expected: number } {
  const results: TestResult[] = [];
  let expected = 0;
  const started = new Map<string, number>();
  for (const line of lines) {
    const batch = /Running test batch .*\((\d+) tests?\)/.exec(line);
    if (batch) expected += Number(batch[1]);
    const loaded = /onTestStructureLoaded: (\S+)/.exec(line);
    if (loaded) started.set(loaded[1]!, Date.now());
    const pass = /onTestPassed: (\S+)/.exec(line);
    if (pass) results.push({ name: pass[1]!, result: "passed", error: "", durationMs: 0, iteration: 1 });
    const fail = /onTestFailed: (\S+?)(?: - (.*))?$/.exec(line);
    if (fail) {
      const error = fail[2] ?? "";
      results.push({ name: fail[1]!, result: /timed? ?out/i.test(error) ? "timed_out" : "failed", error, durationMs: 0, iteration: 1 });
    }
  }
  return { results, expected };
}

export interface GameTestOptions extends BdsRunOptions {
  /** GameTest tags; default `["suite:all"]`. */
  tags?: string[];
  mode?: "automation" | "command";
  /** Wall-clock limit for the whole run. Default 300000. */
  timeoutMs?: number;
  /** Per-run tick limit (`timeout_ticks`). */
  timeoutTicks?: number;
  repeatCount?: number;
}

export interface GameTestRunResult extends GameTestSummary {
  mode: "automation" | "command";
  /** Absent when no server ran (the Regolith build failed). */
  serverVersion?: string;
  durationMs: number;
  /** Load errors (console/content log), failed tests and a failed Regolith build as Diagnostics. */
  diagnostics: Diagnostic[];
  /** Absent when no server ran. */
  rawLogPath?: string;
  exitCode: number;
}

/** Where `register("ns", "name", …)` declares the test, to anchor a failure diagnostic. */
function testLocation(name: string, packs: readonly IndexedPack[]): SourceLocation | undefined {
  const [cls, test] = name.includes(":") ? name.split(":", 2) : ["", name];
  const re = new RegExp(`register(?:Async)?\\(\\s*["'\`]${escape(cls!)}["'\`]\\s*,\\s*["'\`]${escape(test!)}["'\`]`);
  for (const p of packs) {
    for (const [rel, text] of p.texts) {
      if (!/\.(js|mjs)$/.test(rel)) continue;
      const m = re.exec(text);
      if (!m) continue;
      return sourceLocation(p, rel, locate(text, m[0]));
    }
  }
  return undefined;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function testDiagnostics(summary: GameTestSummary, packs: readonly IndexedPack[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const r of summary.results) {
    if (r.result === "passed" || r.result === "skipped") continue;
    const d: Diagnostic = {
      severity: "error",
      code: r.result === "timed_out" ? "gametest.timed-out" : "gametest.failed",
      message: `GameTest ${r.name} ${r.result === "timed_out" ? "timed out" : "failed"}${r.error ? `: ${r.error}` : ""}`,
      source: "gametest",
    };
    const loc = testLocation(r.name, packs);
    if (loc) {
      d.file = loc.file;
      if (loc.range) d.range = loc.range;
      if (loc.note) d.message += ` (${loc.note})`;
    }
    out.push(d);
  }
  for (const tag of summary.missingTags) {
    out.push({ severity: "error", code: "gametest.no-tests", message: `no GameTest matches tag "${tag}"`, source: "gametest" });
  }
  if (summary.runTimedOut) out.push({ severity: "error", code: "gametest.run-timed-out", message: "the GameTest run timed out", source: "gametest" });
  return out;
}

async function automationFinished(dir: string): Promise<boolean> {
  if (await exists(join(dir, "logs", "TestCompletion"))) return true;
  try {
    const data: unknown = JSON.parse(await readFile(join(dir, "logs", "test-results-gametest.json"), "utf8"));
    return !!data && typeof data === "object" && "endTime" in data && typeof data.endTime === "string" && data.endTime !== "";
  } catch {
    return false;
  }
}

export async function runGameTests(path: string, opts: GameTestOptions = {}): Promise<GameTestRunResult> {
  const t0 = Date.now();
  const mode = opts.mode ?? "automation";
  const project = await projectPacks(path, opts);
  if (project.failure) {
    const diagnostics = [...project.skipped, project.failure].sort(compareDiagnostics);
    return { passed: 0, failed: 0, total: 0, results: [], runTimedOut: false, missingTags: [], mode, durationMs: Date.now() - t0, diagnostics, exitCode: ExitCode.findings };
  }
  try {
    return await runOnServer(project, opts, t0);
  } finally {
    await disposeBuild(project, opts.keep);
  }
}

async function runOnServer(project: ProjectPacks, opts: GameTestOptions, t0: number): Promise<GameTestRunResult> {
  const tags = opts.tags?.length ? opts.tags : ["suite:all"];
  const mode = opts.mode ?? "automation";
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const { skipped } = project;
  const { instance, baseline, indexed } = await prepareInstance(project, opts);
  try {
    const resultsPath = join(instance.dir, "logs", "test-results-gametest.json");
    if (mode === "automation") {
      const config: Record<string, unknown> = {
        automation_gametest_tags: tags,
        automation_repeat_count: opts.repeatCount ?? 1,
        automation_repeat_failures_only: false,
        automation_testbuild_id: 1,
      };
      if (opts.timeoutTicks) config.timeout_ticks = opts.timeoutTicks;
      await writeFile(join(instance.dir, "test_config.json"), JSON.stringify(config, null, 2));
    }
    opts.log?.(`BDS ${instance.install.version}: running GameTests [${tags.join(", ")}] (${mode}) in ${instance.dir}`);
    const server = new BdsServer(instance.dir);
    let summary: GameTestSummary | undefined;
    let timedOut = false;
    const deadline = t0 + timeoutMs;
    try {
      await server.started(Math.max(1000, deadline - Date.now()));
      if (mode === "automation") {
        // BDS exits on completion. The results file exists from the start (empty `results`, empty `endTime`);
        // completion is `logs/TestCompletion` or a filled `endTime`, in case a build keeps running afterwards.
        while (server.state !== "exited" && Date.now() < deadline && !(await automationFinished(instance.dir))) {
          await Promise.race([server.exited, new Promise((r) => setTimeout(r, 250))]);
        }
      } else {
        for (const tag of tags) server.write(`gametest runset ${tag}`);
        while (server.state !== "exited" && Date.now() < deadline) {
          const { results, expected } = parseConsoleResults(server.lines.map((l) => l.text));
          if (expected > 0 && results.length >= expected) break;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      timedOut = Date.now() >= deadline;
    } catch {
      timedOut = server.state !== "exited";
    }
    await server.stop();
    if (await exists(resultsPath)) {
      summary = parseTestResults(JSON.parse(await readFile(resultsPath, "utf8")));
    } else {
      const { results, expected } = parseConsoleResults(server.lines.map((l) => l.text));
      const passed = results.filter((r) => r.result === "passed").length;
      summary = { passed, failed: results.length - passed, total: Math.max(expected, results.length), results, runTimedOut: timedOut, missingTags: [] };
    }
    const { contentLog, entries } = await collectLogs(instance, server);
    const serverVersion = server.serverVersion ?? instance.install.version;
    const diagnostics = [
      ...skipped,
      ...entriesToDiagnostics(entries, indexed, { baseline, label: `BDS ${serverVersion}` }).filter((d) => !d.message.includes("onTest")),
      ...testDiagnostics(summary, indexed),
    ];
    if (summary.total === 0 && summary.missingTags.length === 0) {
      diagnostics.push({
        severity: "error",
        code: "gametest.no-tests",
        message: `no GameTest ran for tags [${tags.join(", ")}]${server.state === "exited" && !timedOut ? "" : " (server did not finish)"}`,
        source: "gametest",
      });
    }
    diagnostics.sort(compareDiagnostics);
    const rawLogPath = await writeRawLog(instance.id, server, contentLog);
    const exitCode = summary.failed > 0 || summary.runTimedOut || summary.total === 0 || timedOut ? ExitCode.findings : ExitCode.ok;
    return { ...summary, mode, serverVersion, durationMs: Date.now() - t0, diagnostics, rawLogPath, exitCode };
  } finally {
    if (!opts.keep) await disposeInstance(instance);
  }
}
