/** Error types every feature shares, and the one way an unknown thrown value becomes text. */
import { ExitCode } from "./diagnostic.ts";

/** The message of a thrown value: an `Error`'s message, anything else as a string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Bad arguments to a CLI command. `src/cli.ts` prints its message on stderr and exits with `ExitCode.usage`. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** A missing prerequisite (EULA, unsupported host, no install): maps to exit code 2. */
export class PrerequisiteError extends Error {
  readonly exitCode: number = ExitCode.usage;
  constructor(message: string) {
    super(message);
    this.name = "PrerequisiteError";
  }
}
