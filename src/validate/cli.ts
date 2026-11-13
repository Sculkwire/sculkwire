import { stat } from "node:fs/promises";
import { type CliCommand, err, out } from "../core/cli.ts";
import { ExitCode } from "../core/diagnostic.ts";
import { isChannel } from "../core/version.ts";
import { type OutputFormat, render } from "./format.ts";
import { CHECKS, toOptions, unknownChecks, type ValidateArgs, validateProject, validateText } from "./index.ts";

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
  --regolith <m>         Regolith projects: auto = rgl's last build output in .regolith/tmp when the profile
                         runs filters (default), build = always rgl's last build output, source = the source
                         packs. sculkwire does not run rgl: run \`rgl run\` first after editing the sources
  --profile <name>       Regolith profile whose filters decide auto (default: default)
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
  err(`${message}\n\n${USAGE}`);
  return ExitCode.usage;
}

async function run(args: string[]): Promise<number> {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-h" || a === "--help") {
      out(USAGE);
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
  const input: ValidateArgs = {
    samples_root: flags["--samples"],
    typings_dir: flags["--typings"],
    engine_schemas_dir: flags["--engine-schemas"],
    rockide_dir: flags["--rockide"],
    game_version: flags["--game-version"],
    profile: flags["--profile"],
    assets_optional: flags["--assets-optional"] === "true",
  };
  const channel = flags["--channel"];
  if (channel !== undefined) {
    if (!isChannel(channel)) return usage(`--channel must be stable or preview, got ${channel}`);
    input.channel = channel;
  }
  const format = (flags["--format"] ?? "text") as OutputFormat;
  if (format !== "text" && format !== "json" && format !== "sarif") return usage(`--format must be text, json or sarif`);
  const failOn = flags["--fail-on"] ?? "error";
  if (failOn !== "error" && failOn !== "warning") return usage("--fail-on must be error or warning");
  input.fail_on = failOn;
  if (flags["--checks"]) {
    const checks = flags["--checks"].split(",").map((c) => c.trim()).filter(Boolean);
    const bad = unknownChecks(checks);
    if (bad.length) return usage(`unknown check(s): ${bad.join(", ")}`);
    input.checks = checks;
  }
  const regolith = flags["--regolith"];
  if (regolith !== undefined) {
    if (regolith !== "auto" && regolith !== "build" && regolith !== "source") return usage("--regolith must be auto, build or source");
    input.regolith = regolith;
  }
  const opts = toOptions(input);
  let isFile: boolean;
  try {
    isFile = (await stat(path)).isFile();
  } catch {
    return usage(`path not found: ${path}`);
  }
  err(`validating ${path}...`);
  const result = isFile ? await validateText(path, undefined, opts) : await validateProject(path, opts);
  if ("regolith" in result && result.regolith?.built && result.regolith.message) err(result.regolith.message);
  process.stdout.write(render(result, format));
  return result.ok ? ExitCode.ok : ExitCode.findings;
}

export const commands: CliCommand[] = [
  { name: "validate", summary: "Validate add-on packs: diagnostics with file:line:col, stable codes, exit codes", run },
];
