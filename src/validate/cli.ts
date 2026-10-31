import { stat } from "node:fs/promises";
import type { CliCommand } from "../core/cli.ts";
import { ExitCode, exitCodeFor, type Severity } from "../core/diagnostic.ts";
import { isChannel } from "../core/version.ts";
import { render, type OutputFormat } from "./format.ts";
import { CHECKS, type ValidateOptions, validateProject, validateText } from "./index.ts";

const USAGE = `Usage: sculk validate <path> [options]

  <path>                 project, add-on or pack directory; or one file (validated in its pack's context)
  --channel <c>          stable | preview (default stable)
  --format <f>           text | json | sarif (default text)
  --fail-on <s>          error | warning: exit 1 at or above this severity (default error)
  --samples <dir>        bedrock-samples checkout (vanilla names, script modules, commands, engine schemas)
  --typings <dir>        node_modules dir with @minecraft/* typings
  --engine-schemas <dir> engine schema dump (default: the samples' metadata/json_schemas)
  --rockide <dir>        rockide/schemas checkout (default: the cached newest release, checked on GitHub at most
                         daily; \`sculk knowledge update\` checks now)
  --game-version <v>     exact target game version, e.g. 1.26.60
  --checks <a,b>         subset of ${CHECKS.join(",")}
  --regolith <m>         auto | build | source (Regolith projects; default auto)
  --profile <name>       Regolith profile to build
  --assets-optional      missing texture/sound files are warnings

Exit codes: 0 ok, 1 findings at or above --fail-on, 2 usage or prerequisite error.`;

const VALUE_FLAGS: Record<string, true> = {
  "--channel": true,
  "--format": true,
  "--fail-on": true,
  "--samples": true,
  "--typings": true,
  "--engine-schemas": true,
  "--rockide": true,
  "--game-version": true,
  "--checks": true,
  "--regolith": true,
  "--profile": true,
};

function usage(message: string): number {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  return ExitCode.usage;
}

async function run(args: string[]): Promise<number> {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-h" || a === "--help") {
      process.stdout.write(`${USAGE}\n`);
      return ExitCode.ok;
    }
    if (a === "--assets-optional") flags[a] = "true";
    else if (VALUE_FLAGS[a]) {
      const v = args[++i];
      if (v === undefined) return usage(`${a} needs a value`);
      flags[a] = v;
    } else if (a.startsWith("--")) return usage(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) return usage("expected exactly one <path>");
  const path = positional[0] as string;
  const opts: ValidateOptions = {};
  const channel = flags["--channel"];
  if (channel !== undefined) {
    if (!isChannel(channel)) return usage(`--channel must be stable or preview, got ${channel}`);
    opts.channel = channel;
  }
  const format = (flags["--format"] ?? "text") as OutputFormat;
  if (format !== "text" && format !== "json" && format !== "sarif") return usage(`--format must be text, json or sarif`);
  const failOn = (flags["--fail-on"] ?? "error") as Severity;
  if (failOn !== "error" && failOn !== "warning") return usage("--fail-on must be error or warning");
  opts.failOn = failOn;
  if (flags["--samples"]) opts.samplesRoot = flags["--samples"];
  if (flags["--typings"]) opts.typingsDir = flags["--typings"];
  if (flags["--engine-schemas"]) opts.engineSchemasDir = flags["--engine-schemas"];
  if (flags["--rockide"]) opts.rockideSchemasDir = flags["--rockide"];
  if (flags["--game-version"]) opts.gameVersion = flags["--game-version"];
  if (flags["--profile"]) opts.regolithProfile = flags["--profile"];
  if (flags["--assets-optional"]) opts.assetsOptional = true;
  if (flags["--checks"]) {
    const checks = flags["--checks"].split(",").map((c) => c.trim()).filter(Boolean);
    const bad = checks.filter((c) => !(CHECKS as readonly string[]).includes(c));
    if (bad.length) return usage(`unknown check(s): ${bad.join(", ")}`);
    opts.checks = checks;
  }
  const regolith = flags["--regolith"];
  if (regolith !== undefined) {
    if (regolith !== "auto" && regolith !== "build" && regolith !== "source") return usage("--regolith must be auto, build or source");
    opts.regolith = regolith;
  }
  let isFile: boolean;
  try {
    isFile = (await stat(path)).isFile();
  } catch {
    return usage(`path not found: ${path}`);
  }
  process.stderr.write(`validating ${path}...\n`);
  const result = isFile ? await validateText(path, undefined, opts) : await validateProject(path, opts);
  process.stdout.write(render(result, format));
  return exitCodeFor(result.diagnostics, failOn);
}

export const commands: CliCommand[] = [
  { name: "validate", summary: "Validate add-on packs: diagnostics with file:line:col, stable codes, exit codes", run },
];
