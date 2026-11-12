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

/**
 * Prints the failure as JSON and maps it to an exit code. An agent that does not know the method is older than this
 * client: that is setup to fix, so it says how and exits 2. `notAttached` is the hint printed when no agent listens.
 */
export function failed(failure: EngineFailure, notAttached?: string): number {
  printJson(failure);
  const anchor = failure.anchor ? ` (anchor ${failure.anchor})` : "";
  err(`${failure.reason}: ${failure.message}${anchor}`);
  if (failure.reason === "unknown_method") {
    err("this agent does not have this method: rebuild it with sculk engine attach");
    return ExitCode.usage;
  }
  if (failure.reason === "not_attached" && notAttached) err(notAttached);
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

type OptionSpec = Record<string, { type: "string" | "boolean"; multiple?: boolean }>;
export type CommandLine = { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] };

/**
 * `parseArgs` for an engine command. An argument that looks like an option this command does not take stays a
 * positional, so negative coordinates and entity ids (`-12`) and a grid starting with `-` pass through. A string
 * option without a value and a boolean option given one are usage errors (printed); undefined then.
 */
export function parseCommandLine(args: string[], options: OptionSpec = {}): CommandLine | undefined {
  const { values, tokens } = parseArgs({ args, options, allowPositionals: true, strict: false, tokens: true });
  const positionals: string[] = [];
  let last = -1;
  for (const token of tokens) {
    if (token.kind === "positional") positionals.push(token.value);
    if (token.kind !== "option") continue;
    const spec = options[token.name];
    if (!spec) {
      // `-12` is read as the short options `-1 -2`, both at the same index.
      if (token.index !== last) positionals.push(args[token.index] as string);
      last = token.index;
      continue;
    }
    if (spec.type === "string" && token.value === undefined) {
      err(`option ${token.rawName} needs a value`);
      return undefined;
    }
    if (spec.type === "boolean" && token.value !== undefined) {
      err(`option ${token.rawName} takes no value`);
      return undefined;
    }
  }
  const known: CommandLine["values"] = {};
  for (const name of Object.keys(options)) known[name] = values[name] as CommandLine["values"][string];
  return { values: known, positionals };
}

/** A string option's value: the last one given when it was repeated. */
export function stringOption(line: CommandLine, name: string): string | undefined {
  const value = line.values[name];
  return typeof value === "string" ? value : undefined;
}
