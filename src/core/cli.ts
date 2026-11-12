import { ExitCode } from "./diagnostic.ts";
import { UsageError } from "./errors.ts";

/**
 * Contract for CLI command groups. Each feature exports `commands: CliCommand[]` from `src/<feature>/cli.ts`;
 * `src/cli.ts` dispatches `sculk <name> ...args` to the matching command.
 */
export interface CliCommand {
  /** Single word or `group sub` form, e.g. `validate`, `knowledge update`. */
  name: string;
  summary: string;
  /** Returns a process exit code from `ExitCode`. Writes machine output to stdout, progress to stderr. */
  run(args: string[]): Promise<number>;
}

/** One line of machine output on stdout. */
export function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** One line of progress or error text on stderr. */
export function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

/**
 * Runs an entry point's `main` and sets the exit code it returns. A thrown `UsageError` prints its message, anything
 * else its stack, on stderr; both exit with `ExitCode.usage`.
 */
export function runMain(main: () => Promise<number>): Promise<void> {
  return main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      err(error instanceof UsageError ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = ExitCode.usage;
    },
  );
}
