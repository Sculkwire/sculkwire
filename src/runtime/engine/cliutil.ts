/**
 * The shared shape of every engine CLI command: machine output is JSON on stdout, human hints on stderr, and exit
 * codes are the shared ones (0 success, 1 the agent reported a failure, 2 usage or a missing prerequisite).
 */
import { parseArgs } from "node:util";
import { err, out } from "../../core/cli.ts";
import { ExitCode } from "../../core/diagnostic.ts";
import { errorMessage } from "../../core/errors.ts";
import { engine } from "./engine.ts";
import { isSetupFailure, type EngineFailure, type EngineResult } from "./failure.ts";

export function printJson(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

/** The hints of a command that has no route but the agent: a missing agent and one too old for it are both setup to fix. */
export interface AgentOnly {
  notAttached: string;
  tooOld: string;
}

/** Prints the failure as JSON and maps it to an exit code (2 for setup to fix, 1 for a failure the agent reported). */
export function failed(failure: EngineFailure, agentOnly?: AgentOnly): number {
  printJson(failure);
  const anchor = failure.anchor ? ` (anchor ${failure.anchor})` : "";
  err(`${failure.reason}: ${failure.message}${anchor}`);
  if (agentOnly && failure.reason === "unknown_method") {
    err(agentOnly.tooOld);
    return ExitCode.usage;
  }
  if (agentOnly && failure.reason === "not_attached") err(agentOnly.notAttached);
  return isSetupFailure(failure) ? ExitCode.usage : ExitCode.findings;
}

/** A thrown prerequisite (no install, a failed build or injection) as JSON, and exit 2. */
export function prerequisite(e: unknown): number {
  const text = errorMessage(e);
  printJson({ ok: false, reason: "prerequisite", message: text });
  err(text);
  return ExitCode.usage;
}

/** One CLI call is one process, so the agent socket must not keep it alive after the answer is printed. */
export async function oneShot(body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } finally {
    engine.close();
  }
}

/** Runs one call that may also throw (file routes): its value, or the exit code the CLI answers instead (printed already). */
export async function attempt<T>(body: () => Promise<EngineResult<T>>): Promise<{ value: T } | { code: number }> {
  let result: EngineResult<T>;
  try {
    result = await body();
  } catch (e) {
    return { code: prerequisite(e) };
  }
  return result.ok ? { value: result.value } : { code: failed(result) };
}

type OptionSpec = Record<string, { type: "string"; multiple?: boolean } | { type: "boolean" }>;
export type CommandLine = { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] };

/**
 * How a command reads its arguments.
 * - `strict`: node's `parseArgs` rules. An unknown option, a string option without a value and a boolean option given
 *   one are usage errors; a repeated option keeps its last value.
 * - `loose`: an argument that looks like an option this command does not take stays a positional, so negative
 *   coordinates and entity ids (`-12`) pass through, and so does `--`. A repeated option keeps its first value, and a
 *   string option without a value counts as not given.
 */
export type ArgMode = "strict" | "loose";

/** Parses one engine command's arguments; a usage error is printed and gives undefined. */
export function parseCommandLine(args: string[], options: OptionSpec = {}, mode: ArgMode = "strict"): CommandLine | undefined {
  if (mode === "strict") {
    try {
      const { values, positionals } = parseArgs({ args, options, allowPositionals: true });
      // Only a string option can be `multiple` (`OptionSpec`), so a repeated value is a string array.
      return { values: values as CommandLine["values"], positionals };
    } catch (e) {
      err(errorMessage(e));
      return undefined;
    }
  }
  const { tokens } = parseArgs({ args, options, allowPositionals: true, strict: false, tokens: true });
  const values: CommandLine["values"] = {};
  const positionals: string[] = [];
  let last = -1;
  for (const token of tokens) {
    if (token.kind === "positional") positionals.push(token.value);
    if (token.kind === "option-terminator") positionals.push("--");
    if (token.kind !== "option") continue;
    const spec = options[token.name];
    if (!spec) {
      // `-12` is read as the short options `-1 -2`, both at the same index.
      if (token.index !== last) positionals.push(args[token.index] as string);
      last = token.index;
      continue;
    }
    if (spec.type === "boolean") {
      if (token.value !== undefined) {
        err(`option ${token.rawName} takes no value`);
        return undefined;
      }
      values[token.name] = true;
      continue;
    }
    if (token.value === undefined) continue;
    const seen = values[token.name];
    if (spec.multiple) values[token.name] = [...(Array.isArray(seen) ? seen : []), token.value];
    else if (seen === undefined) values[token.name] = token.value;
  }
  return { values, positionals };
}

/** A string option's value (see `ArgMode` for which one a repeated option keeps). */
export function stringOption(line: CommandLine, name: string): string | undefined {
  const value = line.values[name];
  return typeof value === "string" ? value : undefined;
}
