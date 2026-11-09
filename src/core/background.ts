/**
 * Background work policy per process. The MCP server is long-lived: when the daily version pins name newer builds,
 * it downloads them in the background (BDS, bedrock-samples checkout, docs fetch and re-index, changelog articles)
 * while calls keep using the cached copies. A CLI command is short-lived: in the background it only refreshes cheap
 * metadata (the version pins), and it exits at most `CLI_EXIT_GRACE_MS` after its command returns, so an unfinished
 * refresh is retried by the next process. The next MCP session or `sculk knowledge update` fetches the new builds.
 */

/** How long a CLI process may stay alive after its command returned (pending metadata writes are atomic). */
export const CLI_EXIT_GRACE_MS = 3_000;

let downloads = false;

/** The MCP server sets this: the process lives long enough to download new builds in the background. */
export function setBackgroundDownloads(allowed: boolean): void {
  downloads = allowed;
}

/** Whether this process may start heavy downloads in the background. */
export function backgroundDownloadsAllowed(): boolean {
  return downloads;
}

/**
 * CLI: exit with `process.exitCode` once background work is done, or after `CLI_EXIT_GRACE_MS` at the latest.
 * The forced exit waits for stdout to drain, so a large `--format json` piped into a slow reader is never cut off.
 */
export function exitAfterGrace(): void {
  setTimeout(() => process.stdout.write("", () => process.exit()), CLI_EXIT_GRACE_MS).unref();
}
