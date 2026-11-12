/** The one child-process runner: no shell, piped output, an optional hard timeout. */
import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  /** The child's whole environment. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Kill the child (SIGKILL) after this long; `timedOut` then says so. Default: no limit. */
  timeoutMs?: number;
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
  const child = spawn(quote(command), args.map(quote), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell,
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout = keep(stdout, chunk);
    output = keep(output, chunk);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = keep(stderr, chunk);
    output = keep(output, chunk);
  });
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs);
  const settle = (code: number | null) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr, output, timedOut, ...(startError ? { startError } : {}) });
  };
  child.on("error", (err) => {
    startError = err;
    const line = `${command} failed to start: ${err.message}`;
    stderr = keep(stderr, line);
    output = keep(output, line);
    settle(null);
  });
  child.on("close", (code) => {
    if (!startError) settle(code);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input ?? "");
  return promise;
}
