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
