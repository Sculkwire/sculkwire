import { parseArgs } from "node:util";
import type { CliCommand } from "../../../core/cli.ts";
import { ExitCode } from "../../../core/diagnostic.ts";
import type { LaunchMode } from "../launcher.ts";
import type { InputMode } from "../player.ts";
import { loadScenarios, runBench } from "./run.ts";

const USAGE =
  "bench <suite|all> [--scenario name] [--runs N] [--input auto|engine|keyboard] [--display window|headless] [--keep] [--json] [--list]";

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
        keep: { type: "boolean" },
        json: { type: "boolean" },
        list: { type: "boolean" },
      },
    });
    if (values.list) {
      for (const s of await loadScenarios()) process.stdout.write(`${s.suite}/${s.name} (${s.runs} runs): ${s.summary}\n`);
      return ExitCode.ok;
    }
    const suite = positionals[0];
    const input = (values.input ?? "auto") as InputMode;
    const display = values.display as LaunchMode | undefined;
    const runs = values.runs !== undefined ? Number(values.runs) : undefined;
    if (!suite || !["auto", "engine", "keyboard"].includes(input) || (display && !["window", "headless"].includes(display)) || (runs !== undefined && !(Number.isInteger(runs) && runs > 0))) {
      process.stderr.write(`usage: sculk ${USAGE}\n`);
      return ExitCode.usage;
    }
    const report = await runBench({
      suite,
      input,
      ...(values.scenario ? { scenario: values.scenario } : {}),
      ...(runs !== undefined ? { runs } : {}),
      ...(display ? { display } : {}),
      ...(values.keep ? { keep: true } : {}),
    });
    process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${report.table}\n\nJSON: ${report.jsonPath}\n`);
    return report.reports.every((r) => r.summary.successes === r.summary.runs) ? ExitCode.ok : ExitCode.findings;
  },
};
