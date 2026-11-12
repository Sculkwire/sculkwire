/**
 * Child processes of the update steps. They never inherit stdout (the MCP server speaks JSON-RPC on it) and every step
 * has a timeout.
 */
import { run, type RunResult } from "../core/process.ts";

/**
 * `run` for the update steps: rejects when the command does not start or times out. Git never prompts: a repository
 * that needs credentials works through the user's credential helper, and missing credentials fail instead of hanging.
 */
export async function runUnattended(command: string, args: readonly string[], options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; input?: string }): Promise<RunResult> {
  const r = await run(command, args, {
    cwd: options.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...options.env },
    timeoutMs: options.timeoutMs,
    input: options.input ?? "",
  });
  if (r.startError) throw r.startError;
  if (r.timedOut) throw new Error(`${command} ${args.join(" ")} timed out after ${Math.round(options.timeoutMs / 1000)} s`);
  return r;
}

export async function git(args: readonly string[], options: { cwd?: string; timeoutMs: number }): Promise<string> {
  const r = await runUnattended("git", args, options);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${lastLine(r.stderr) || `exit ${r.code}`}`);
  return r.stdout;
}

export function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
}

/** `git remote get-url origin` of a checkout, if any. */
export function checkoutRemote(dir: string): Promise<string | undefined> {
  return runUnattended("git", ["remote", "get-url", "origin"], { cwd: dir, timeoutMs: 10_000 }).then(
    (r) => (r.code === 0 ? r.stdout.trim() || undefined : undefined),
    () => undefined,
  );
}
