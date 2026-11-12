import { parseArgs } from "node:util";
import { err, out, type CliCommand } from "../../../core/cli.ts";
import { ExitCode } from "../../../core/diagnostic.ts";
import type { LaunchMode } from "../launcher.ts";
import type { InputMode } from "../input.ts";
import { DEFAULT_WAIT_S, loadScenarios, runBench } from "./run.ts";
import { parseStances } from "./stance.ts";
import { parseViews } from "./view.ts";

const USAGE =
  "bench <suite|all> [--scenario name] [--runs N] [--input auto|engine|keyboard] [--display window|headless] [--view first|third|first,third] [--stance auto|kite|guard[,...]] [--wait seconds] [--keep] [--json] [--list]";

export const bench: CliCommand = {
  name: "bench",
  summary: `Measure the player skills in built arenas in the real client: ${USAGE}`,
  async run(args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        scenario: { type: "string" },
        runs: { type: "string" },
        input: { type: "string" },
        display: { type: "string" },
        view: { type: "string" },
        stance: { type: "string" },
        wait: { type: "string" },
        keep: { type: "boolean" },
        json: { type: "boolean" },
        list: { type: "boolean" },
      },
    });
    if (values.list) {
      for (const s of await loadScenarios()) out(`${s.suite}/${s.name} (${s.runs} runs): ${s.summary}`);
      return ExitCode.ok;
    }
    const suite = positionals[0];
    const input = (values.input ?? "auto") as InputMode;
    const display = values.display as LaunchMode | undefined;
    const runs = values.runs !== undefined ? Number(values.runs) : undefined;
    const views = values.view !== undefined ? parseViews(values.view) : undefined;
    const waitS = values.wait !== undefined ? Number(values.wait) : DEFAULT_WAIT_S;
    const stances = values.stance !== undefined ? parseStances(values.stance) : undefined;
    if (
      !suite ||
      !["auto", "engine", "keyboard"].includes(input) ||
      (display && !["window", "headless"].includes(display)) ||
      (runs !== undefined && !(Number.isInteger(runs) && runs > 0)) ||
      (values.view !== undefined && !views) ||
      (values.stance !== undefined && !stances) ||
      !(Number.isFinite(waitS) && waitS > 0)
    ) {
      err(`usage: sculk ${USAGE}`);
      return ExitCode.usage;
    }
    // A setup the options cannot work in throws `UsageError`: the dispatcher prints it and exits 2.
    const report = await runBench({
      suite,
      input,
      waitS,
      ...(values.scenario ? { scenario: values.scenario } : {}),
      ...(runs !== undefined ? { runs } : {}),
      ...(display ? { display } : {}),
      ...(views ? { views } : {}),
      ...(stances ? { stances } : {}),
      ...(values.keep ? { keep: true } : {}),
    });
    out(values.json ? JSON.stringify(report, null, 2) : `${report.table}\n\nJSON: ${report.jsonPath}${report.tracePath ? `\nTrace: ${report.tracePath}` : ""}`);
    return report.reports.every((r) => r.summary.successes === r.summary.runs) ? ExitCode.ok : ExitCode.findings;
  },
};
