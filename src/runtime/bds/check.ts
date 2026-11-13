/**
 * BDS load-check: boot a disposable server with the project's packs, wait for `Server started.`, let it settle,
 * stop it, and turn console + content log output into Diagnostics mapped to pack files.
 *
 * For a Regolith project whose profile runs filters the server loads what rgl last built (`.regolith/tmp`, the same
 * `regolithPlan` + `regolithOutput` the validator and the client bridge use): the source packs hold filter inputs,
 * not what the game loads. sculkwire does not run rgl; without its output the result is an error Diagnostic
 * (`regolith.not-built`) and no server starts.
 */
import type { Diagnostic } from "../../core/diagnostic.ts";
import { compareDiagnostics, exitCodeFor, summarize } from "../../core/diagnostic.ts";
import { projectPath } from "../gamelog/logparse.ts";
import { projectPacks, withInstance, type BdsRunOptions } from "./project.ts";
import { finishRun, runOnce } from "./run.ts";

/** Time to keep running after `Server started.` so late script errors surface. */
export const CHECK_SETTLE_MS = 8000;

export interface CheckOptions extends BdsRunOptions {
  /** Default `CHECK_SETTLE_MS`. */
  settleMs?: number;
  startTimeoutMs?: number;
}

export interface CheckResult {
  diagnostics: Diagnostic[];
  /** Absent when no server ran (`not-built`). */
  serverVersion?: string;
  durationMs: number;
  /** Console + content log of the run, kept after the instance is removed; absent when no server ran. */
  rawLogPath?: string;
  /** `not-built`: rgl has not built the Regolith project, so BDS did not start. */
  status: "started" | "exited" | "timeout" | "not-built";
  /** Where the kept instance folder is, when `keep` was set. */
  instanceDir?: string;
  exitCode: number;
}

/** The one-line summary of a check, as both front ends print it. */
export function describeCheck(r: CheckResult): string {
  const summary = summarize(r.diagnostics);
  return r.status === "not-built"
    ? `rgl has not built the Regolith project, BDS not started: ${summary.errors} error(s)`
    : `BDS ${r.serverVersion} ${r.status}: ${summary.errors} error(s), ${summary.warnings} warning(s) in ${r.durationMs} ms`;
}

/** `[00] Name (id: uuid, version: 1.0.0) @ path` entries of the `Pack Stack -` console line. */
export function packStackIds(lines: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    if (!line.includes("Pack Stack")) continue;
    for (const m of line.matchAll(/\(id: ([0-9a-fA-F-]{36})/g)) ids.add(m[1]!.toLowerCase());
  }
  return ids;
}

export async function bdsCheck(path: string, opts: CheckOptions = {}): Promise<CheckResult> {
  const t0 = Date.now();
  const project = await projectPacks(path, opts);
  if (project.failure) {
    const diagnostics = [...project.skipped, project.failure].sort(compareDiagnostics);
    return { diagnostics, durationMs: Date.now() - t0, status: "not-built", exitCode: exitCodeFor(diagnostics) };
  }
  return withInstance(project, opts, async (prepared) => {
    const { instance, indexed } = prepared;
    opts.log?.(`BDS ${instance.install.version}: checking ${project.loadable.length} pack(s) in ${instance.dir}`);
    const run = await runOnce(instance, { settleMs: opts.settleMs ?? CHECK_SETTLE_MS, startTimeoutMs: opts.startTimeoutMs });
    const finished = await finishRun(prepared, run.server);
    const { label } = finished;
    const diagnostics = [...project.skipped, ...finished.diagnostics];
    if (run.status !== "started") {
      diagnostics.push({
        severity: "error",
        code: "bds.start-failed",
        message: `${label} did not start (${run.status}); console tail:\n${run.server.tail()}`,
        source: "bds",
      });
    } else {
      const stack = packStackIds(run.server.text());
      for (const p of indexed) {
        if (p.pack.kind !== "behavior" || stack.has(p.pack.uuid!.toLowerCase())) continue;
        diagnostics.push({
          severity: "error",
          code: "bds.pack-not-in-stack",
          message: `${label}: behavior pack "${p.pack.name ?? p.pack.uuid}" is attached to the world but missing from the pack stack (rejected at load)`,
          source: "bds",
          file: projectPath(p.pack, "manifest.json"),
        });
      }
    }
    diagnostics.sort(compareDiagnostics);
    const result: CheckResult = {
      diagnostics,
      serverVersion: finished.serverVersion,
      durationMs: Date.now() - t0,
      rawLogPath: finished.rawLogPath,
      status: run.status,
      exitCode: exitCodeFor(diagnostics),
    };
    return result;
  });
}
