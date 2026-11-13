import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { summarize } from "../../core/diagnostic.ts";
import { channelSchema, diagnosticSchema, diagText, fail, ok, summarySchema } from "../../core/mcp.ts";
import { onShutdown } from "../../core/shutdown.ts";
import { bdsCheck, CHECK_SETTLE_MS, describeCheck } from "./check.ts";
import { describeGameTest, runGameTests } from "./gametest.ts";
import { COMMAND_MAX_MS } from "./server.ts";
import { sessionCommand, sessionLogs, sessionProfile, startSession, stopAllSessions, stopSession } from "./session.ts";

const channel = channelSchema.optional().describe("BDS release channel (default stable)");
const acceptEula = z
  .boolean()
  .optional()
  .describe("Record that the user accepted the Minecraft EULA (needed once before BDS is downloaded)");
const lineSchema = z.object({ seq: z.number(), text: z.string() });
const sessionInfoSchema = {
  id: z.string(),
  state: z.string(),
  serverVersion: z.string(),
  projectRoot: z.string(),
  instanceDir: z.string(),
  port: z.number(),
  debugger: z.object({ attached: z.boolean(), port: z.number(), protocolVersion: z.number().optional(), error: z.string().optional() }),
  packs: z.array(z.object({ name: z.string(), kind: z.string(), path: z.string() })),
  startedAt: z.string(),
};

const plain = (lines: { seq: number; text: string }[]): { seq: number; text: string }[] => lines.map(({ seq, text }) => ({ seq, text }));

let shutdownHooked = false;

export function register(server: McpServer): void {
  if (!shutdownHooked) {
    shutdownHooked = true;
    onShutdown(stopAllSessions);
  }
  server.registerTool(
    "bds_check",
    {
      title: "BDS load-check",
      description:
        "Load the project's behavior/resource packs into a disposable Bedrock Dedicated Server (Linux or Windows x64), wait for " +
        "`Server started`, let it settle, stop it, and return content-log/console errors (incl. script errors with " +
        "file:line) as diagnostics mapped to pack files. sculkwire does not run rgl: a Regolith project whose profile runs " +
        "filters is loaded from what rgl last built (.regolith/tmp), so run `rgl run` (or keep `rgl watch` running) first; " +
        "diagnostics point at the files you edit. Without rgl's output the status is not-built and no server starts. " +
        "Downloads BDS on first use.",
      inputSchema: {
        path: z.string().describe("Project or pack directory"),
        channel,
        settleMs: z.number().int().min(0).max(120_000).optional().describe(`Run time after \`Server started\` (default ${CHECK_SETTLE_MS})`),
        keep: z.boolean().optional().describe("Keep the server instance directory"),
        acceptEula,
      },
      outputSchema: {
        diagnostics: z.array(diagnosticSchema),
        summary: summarySchema,
        exitCode: z.number(),
        serverVersion: z.string().optional(),
        durationMs: z.number(),
        rawLogPath: z.string().optional(),
        status: z.string(),
        instanceDir: z.string().optional(),
      },
    },
    async ({ path, channel: ch, settleMs, keep, acceptEula: eula }) => {
      try {
        const r = await bdsCheck(path, { channel: ch, settleMs, keep, acceptEula: eula });
        const head = describeCheck(r);
        return ok(r.diagnostics.length ? `${head}\n${diagText(r.diagnostics)}` : head, { ...r, summary: summarize(r.diagnostics) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "gametest_run",
    {
      title: "Run GameTests on BDS",
      description:
        "Run the project's GameTests headlessly on a disposable BDS (test_config.json automation, or `gametest runset` " +
        "in command mode) and return per-test results, failure diagnostics anchored at the test's register() call, and " +
        "an exit code (1 when any test failed or none ran). sculkwire does not run rgl: a Regolith project whose profile " +
        "runs filters is loaded from what rgl last built (.regolith/tmp), so run `rgl run` (or keep `rgl watch` running) " +
        "first; without its output the result is a regolith.not-built diagnostic and no server starts.",
      inputSchema: {
        path: z.string().describe("Project or pack directory"),
        tags: z.array(z.string()).optional().describe('GameTest tags (default ["suite:all"])'),
        mode: z.enum(["automation", "command"]).optional(),
        timeoutMs: z.number().int().min(5000).max(3_600_000).optional(),
        channel,
        acceptEula,
      },
      outputSchema: {
        passed: z.number(),
        failed: z.number(),
        total: z.number(),
        results: z.array(z.object({ name: z.string(), result: z.string(), error: z.string(), durationMs: z.number(), iteration: z.number() })),
        runTimedOut: z.boolean(),
        missingTags: z.array(z.string()),
        mode: z.string(),
        serverVersion: z.string().optional(),
        durationMs: z.number(),
        diagnostics: z.array(diagnosticSchema),
        rawLogPath: z.string().optional(),
        exitCode: z.number(),
      },
    },
    async ({ path, tags, mode, timeoutMs, channel: ch, acceptEula: eula }) => {
      try {
        const r = await runGameTests(path, { tags, mode, timeoutMs, channel: ch, acceptEula: eula });
        const failures = r.results.filter((t) => t.result !== "passed").map((t) => `  ${t.name}: ${t.result} ${t.error}`);
        const head = describeGameTest(r) ?? `GameTest not run, rgl has not built the Regolith project:\n${diagText(r.diagnostics)}`;
        const text = [head, ...failures].join("\n");
        return ok(text, r);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "bds_session_start",
    {
      title: "Start a BDS session",
      description:
        "Start a long-lived BDS with the project's packs attached (symlinked, so edits + bds_session_command `reload` " +
        "apply) and the script debugger attached. sculkwire does not run rgl: a Regolith project whose profile runs " +
        "filters is loaded from what rgl last built (.regolith/tmp), so run `rgl run` (or keep `rgl watch` running, which " +
        "updates the loaded packs in place for `reload`) first; without its output no server starts. " +
        "Returns the session id used by the other bds_session_* tools.",
      inputSchema: {
        path: z.string().describe("Project or pack directory"),
        channel,
        packMode: z.enum(["symlink", "copy"]).optional(),
        debugger: z.boolean().optional().describe("Attach the script debugger (default true)"),
        acceptEula,
      },
      outputSchema: sessionInfoSchema,
    },
    async ({ path, channel: ch, packMode, debugger: dbg, acceptEula: eula }) => {
      try {
        const s = await startSession(path, { channel: ch, packMode, debugger: dbg, acceptEula: eula });
        return ok(`BDS ${s.serverVersion} session ${s.id} running on port ${s.port}; debugger ${s.debugger.attached ? "attached" : `not attached${s.debugger.error ? ` (${s.debugger.error})` : ""}`}`, s);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "bds_session_command",
    {
      title: "Run a command in a BDS session",
      description:
        "Run a server command (no leading slash needed) and return the console lines it printed. `reload` reloads " +
        "functions and scripts, `reload all` also packs. `via: debugger` sends it through the script debugger.",
      inputSchema: {
        id: z.string(),
        command: z.string(),
        via: z.enum(["console", "debugger"]).optional(),
        maxMs: z.number().int().min(100).max(60_000).optional().describe(`Max wait for output (default ${COMMAND_MAX_MS})`),
      },
      outputSchema: { lines: z.array(lineSchema), via: z.string() },
    },
    async ({ id, command, via, maxMs }) => {
      try {
        const r = await sessionCommand(id, command, { via, maxMs });
        return ok(r.lines.map((l) => l.text).join("\n") || "(no output)", { lines: plain(r.lines), via: r.via });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "bds_session_logs",
    {
      title: "Read BDS session logs",
      description: "Console lines after cursor `since` (pass the returned `next` to continue) plus the diagnostics found in them.",
      inputSchema: {
        id: z.string(),
        since: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      },
      outputSchema: { lines: z.array(lineSchema), next: z.number(), diagnostics: z.array(diagnosticSchema) },
    },
    async ({ id, since, limit }) => {
      try {
        const r = sessionLogs(id, since, limit);
        const text = `${r.lines.length} line(s), next=${r.next}${r.diagnostics.length ? `\n${diagText(r.diagnostics)}` : ""}`;
        return ok(text, { lines: plain(r.lines), next: r.next, diagnostics: r.diagnostics });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "bds_session_stop",
    {
      title: "Stop a BDS session",
      description: "Stop the server, return its exit code, the diagnostics of the whole run and the raw log path.",
      inputSchema: { id: z.string() },
      outputSchema: { exitCode: z.number().nullable(), rawLogPath: z.string(), diagnostics: z.array(diagnosticSchema) },
    },
    async ({ id }) => {
      try {
        const r = await stopSession(id);
        return ok(`stopped ${id} (exit ${r.exitCode}); ${r.diagnostics.length} diagnostic(s); log ${r.rawLogPath}`, r);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "script_profile",
    {
      title: "Profile scripts in a BDS session",
      description:
        "Script profiler over the session's debugger. `capture` = start, optionally run `command`, wait `durationMs`, " +
        "stop; or drive `start`/`stop` yourself. Returns the top functions by self time. A sample is charged at most one " +
        "sampling interval (`intervalMs`), so time between game ticks, when no script runs, is `idleMs` and not charged " +
        "to any function; `selfPercent` is percent of the capture duration.",
      inputSchema: {
        id: z.string(),
        action: z.enum(["capture", "start", "stop"]).optional(),
        durationMs: z.number().int().min(100).max(300_000).optional().describe("capture length (default 5000)"),
        command: z.string().optional().describe("Command to run right after the profiler starts (capture only)"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      outputSchema: {
        action: z.string(),
        durationMs: z.number().optional(),
        sampleCount: z.number().optional(),
        intervalMs: z.number().optional(),
        idleMs: z.number().optional(),
        functions: z
          .array(z.object({ functionName: z.string(), url: z.string(), line: z.number(), column: z.number(), native: z.boolean(), selfMs: z.number(), totalMs: z.number(), selfPercent: z.number() }))
          .optional(),
      },
    },
    async ({ id, action = "capture", durationMs = 5000, command, limit }) => {
      try {
        const summary = await sessionProfile(id, { action, durationMs, command, limit: limit ?? 20 });
        if (summary.action === "start") return ok("profiler started", summary);
        const top = summary.functions.slice(0, 10).map((f) => `  ${f.selfMs.toFixed(1)} ms self  ${f.functionName} ${f.url}:${f.line}`);
        return ok(
          [`profile ${summary.durationMs.toFixed(0)} ms, ${summary.sampleCount} samples, ${summary.idleMs.toFixed(0)} ms idle`, ...top].join("\n"),
          summary,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
