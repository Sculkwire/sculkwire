/** The one child-process runner: no shell, piped output, an optional hard timeout. */
import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  /** The child's whole environment. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Kill the child after this long and resolve right away with `timedOut`, without waiting for its pipes to close (a
   * grandchild may hold them open). Default: no limit.
   */
  timeoutMs?: number;
  /** The signal a timeout sends. Default: SIGKILL. */
  killSignal?: NodeJS.Signals;
  /** Written to the child's stdin, which is then closed. Default: stdin closed right away. */
  input?: string;
  /** Keep only the last this many characters of each output (`stdout`, `stderr`, `output`). Default: everything. */
  maxOutput?: number;
}

export interface RunResult {
  /** Exit code; null when the child did not start or was ended by a signal (a timeout among them). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved in the order they arrived. */
  output: string;
  timedOut: boolean;
  /** Why the child did not start (a missing binary). Its text is also in `stderr` and `output`. */
  startError?: Error;
}

/** Runs `command` and resolves once it exits, timed out or failed to start. Never rejects. */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const { promise, resolve } = Promise.withResolvers<RunResult>();
  // npm and other `.cmd`/`.bat` shims only run through a shell on Windows, which then needs the quoting done here.
  const shell = process.platform === "win32" && (command === "npm" || /\.(cmd|bat)$/i.test(command));
  const quote = (s: string) => (shell && /[\s&()^|<>"]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  const max = options.maxOutput ?? Number.POSITIVE_INFINITY;
  const keep = (text: string, chunk: string) => {
    const next = text + chunk;
    return next.length > max ? next.slice(-max) : next;
  };
  let stdout = "";
  let stderr = "";
  let output = "";
  let timedOut = false;
  let startError: Error | undefined;
  let settled = false;
  const child = spawn(quote(command), args.map(quote), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell,
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    if (settled) return;
    stdout = keep(stdout, chunk);
    output = keep(output, chunk);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    if (settled) return;
    stderr = keep(stderr, chunk);
    output = keep(output, chunk);
  });
  const settle = (code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ code, stdout, stderr, output, timedOut, ...(startError ? { startError } : {}) });
  };
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill(options.killSignal ?? "SIGKILL");
          // Release the pipes: a grandchild that inherited them would otherwise keep this process waiting.
          child.stdout.destroy();
          child.stderr.destroy();
          settle(null);
        }, options.timeoutMs);
  child.on("error", (err) => {
    startError = err;
    const line = `${command} failed to start: ${err.message}`;
    stderr = keep(stderr, line);
    output = keep(output, line);
    settle(null);
  });
  child.on("close", (code) => settle(code));
  child.stdin.on("error", () => {});
  child.stdin.end(options.input ?? "");
  return promise;
}

/**
 * `run` for steps nobody watches (updates, client registration): rejects when the command does not start or times
 * out, and reports a signal-ended child as exit 1. Git never prompts: a repository that needs credentials works through
 * the user's credential helper, and missing credentials fail instead of hanging.
 */
export async function runUnattended(command: string, args: readonly string[], options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; input?: string }): Promise<RunResult & { code: number }> {
  const r = await run(command, args, {
    cwd: options.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...options.env },
    timeoutMs: options.timeoutMs,
    input: options.input ?? "",
  });
  if (r.startError) throw r.startError;
  if (r.timedOut) throw new Error(`${command} ${args.join(" ")} timed out after ${Math.round(options.timeoutMs / 1000)} s`);
  return { ...r, code: r.code ?? 1 };
}
