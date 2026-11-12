/**
 * Git for the update steps. Like every update step it runs through `runUnattended`: it never inherits stdout (the MCP
 * server speaks JSON-RPC on it) and has a timeout.
 */
import { runUnattended } from "../core/process.ts";

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
