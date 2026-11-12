/** One running `bedrock_server` process: line-split console, stdin commands, start/stop lifecycle. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { join, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import { findOnPath } from "../../core/which.ts";
import { CONSOLE_LOG, serverExecutable } from "./files.ts";

/** How long a server may take to print `Server started.`. */
export const START_TIMEOUT_MS = 180_000;
/** The most a console command waits for its output. */
export const COMMAND_MAX_MS = 5000;
const STARTED_RE = /Server started\./;

export interface ConsoleLine {
  /** Monotonic, 1-based. */
  seq: number;
  time: number;
  text: string;
}

export type ServerState = "starting" | "running" | "stopping" | "exited";

export interface ServerCommand {
  command: string;
  args: string[];
  /** Extra environment on top of `process.env`. */
  env: Record<string, string>;
}

/**
 * How to launch the server in `dir`. Linux: `./bedrock_server` with its bundled libraries on `LD_LIBRARY_PATH`;
 * BDS block-buffers stdout into a pipe, so line buffering through `stdbuf` (coreutils, when present) makes console
 * output arrive with the event that caused it, which `command()` and `waitFor()` rely on. Windows: the absolute
 * `bedrock_server.exe` (DLLs load from its own directory).
 */
export function serverCommand(dir: string, platform: NodeJS.Platform, stdbuf?: string): ServerCommand {
  if (platform === "win32") return { command: win32.join(dir, serverExecutable("windows")), args: [], env: {} };
  const env = { LD_LIBRARY_PATH: "." };
  const exe = `./${serverExecutable("linux")}`;
  return stdbuf ? { command: stdbuf, args: ["-oL", "-eL", exe], env } : { command: exe, args: [], env };
}

/** `stdbuf` on `PATH`, else coreutils' `/usr/bin/stdbuf` (a service or GUI-launched client may lack `/usr/bin` on `PATH`). */
export function findStdbuf(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return findOnPath("stdbuf", env, "linux") ?? (exists("/usr/bin/stdbuf") ? "/usr/bin/stdbuf" : undefined);
}

/**
 * Splits one output stream into lines. Chunks arrive at arbitrary boundaries (on Windows BDS runs without `stdbuf`, so
 * a chunk may end inside a line, between `\r` and `\n`, or inside a UTF-8 character); LF and CRLF both end a line.
 */
export class LineSplitter {
  #decoder = new StringDecoder("utf8");
  #partial = "";

  /** The lines completed by `chunk`. */
  push(chunk: Buffer): string[] {
    const parts = (this.#partial + this.#decoder.write(chunk)).split(/\r?\n/);
    this.#partial = parts.pop() ?? "";
    return parts;
  }

  /** The last line when the stream ended without a line ending. */
  end(): string[] {
    const rest = (this.#partial + this.#decoder.end()).replace(/\r$/, "");
    this.#partial = "";
    return rest ? [rest] : [];
  }
}

/**
 * Servers still running, killed when this process exits so none outlives sculkwire. The kill goes to the server
 * process itself on both OSes (`stdbuf` execs into it on Linux, Windows spawns `bedrock_server.exe` directly), and
 * BDS starts no children of its own.
 */
const live = new Set<ChildProcessWithoutNullStreams>();
process.on("exit", () => {
  for (const proc of live) proc.kill("SIGKILL");
});

export class BdsServer extends EventEmitter {
  readonly dir: string;
  readonly lines: ConsoleLine[] = [];
  state: ServerState = "starting";
  exitCode: number | null = null;
  /** Version printed in `Version: 1.26.63.1`. */
  serverVersion?: string;
  #proc: ChildProcessWithoutNullStreams;
  #log: WriteStream;
  #exited: Promise<number | null>;

  constructor(dir: string) {
    super();
    this.dir = dir;
    this.#log = createWriteStream(join(dir, CONSOLE_LOG));
    const stdbuf = process.platform !== "win32" ? findStdbuf() : undefined;
    const { command, args, env } = serverCommand(dir, process.platform, stdbuf);
    this.#proc = spawn(command, args, {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    live.add(this.#proc);
    const { promise, resolve } = Promise.withResolvers<number | null>();
    this.#exited = promise;
    const streams = [this.#proc.stdout, this.#proc.stderr].map((stream) => {
      const splitter = new LineSplitter();
      stream.on("data", (chunk: Buffer) => {
        this.#log.write(chunk);
        for (const text of splitter.push(chunk)) this.#line(text);
      });
      return splitter;
    });
    this.#proc.stdin.on("error", () => {});
    this.#proc.on("error", (err) => {
      live.delete(this.#proc);
      this.#line(`[sculkwire] failed to spawn bedrock_server: ${err.message}`);
      this.state = "exited";
      resolve(null);
    });
    this.#proc.on("exit", (code) => {
      live.delete(this.#proc);
      for (const splitter of streams) for (const text of splitter.end()) this.#line(text);
      this.exitCode = code;
      this.state = "exited";
      this.#log.end();
      this.emit("exit", code);
      resolve(code);
    });
  }

  #line(text: string): void {
    const line: ConsoleLine = { seq: this.lines.length + 1, time: Date.now(), text };
    this.lines.push(line);
    const version = /\bVersion:? (\d+\.\d+\.\d+(?:\.\d+)?)/.exec(text);
    if (version && !this.serverVersion) this.serverVersion = version[1];
    if (this.state === "starting" && STARTED_RE.test(text)) {
      this.state = "running";
      this.emit("started");
    }
    this.emit("line", line);
  }

  get pid(): number | undefined {
    return this.#proc.pid;
  }

  get exited(): Promise<number | null> {
    return this.#exited;
  }

  /** The text of every console line so far. */
  text(): string[] {
    return this.lines.map((l) => l.text);
  }

  /** The last `n` console lines as one string, for error messages. */
  tail(n = 30): string {
    return this.lines
      .slice(-n)
      .map((l) => l.text)
      .join("\n");
  }

  /**
   * Wait for the first console line after `afterSeq` matching `re`. Rejects on timeout or exit.
   */
  waitFor(re: RegExp, timeoutMs: number, afterSeq = 0): Promise<ConsoleLine> {
    const hit = this.lines.find((l) => l.seq > afterSeq && re.test(l.text));
    if (hit) return Promise.resolve(hit);
    const { promise, resolve, reject } = Promise.withResolvers<ConsoleLine>();
    const cleanup = (): void => {
      clearTimeout(timer);
      this.off("line", onLine);
      this.off("exit", onExit);
    };
    const onLine = (l: ConsoleLine): void => {
      if (re.test(l.text)) {
        cleanup();
        resolve(l);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`bedrock_server exited (code ${code}) while waiting for ${re}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs} ms waiting for ${re}`));
    }, timeoutMs);
    if (this.state === "exited") onExit(this.exitCode);
    else {
      this.on("line", onLine);
      this.on("exit", onExit);
    }
    return promise;
  }

  /** Resolves when the server printed `Server started.`. */
  async started(timeoutMs = START_TIMEOUT_MS): Promise<void> {
    if (this.state === "running") return;
    await this.waitFor(STARTED_RE, timeoutMs);
  }

  write(command: string): void {
    if (this.state === "exited") throw new Error("bedrock_server is not running");
    this.#proc.stdin.write(`${command.replace(/^\//, "")}\n`);
  }

  /**
   * Wait until no console line arrived for `quietMs` (after at least one new line past `from` when
   * `needOutput`), capped at `maxMs`. Returns the lines after `from`.
   */
  async quiet(from: number, opts: { quietMs?: number; maxMs?: number; needOutput?: boolean } = {}): Promise<ConsoleLine[]> {
    const quietMs = opts.quietMs ?? 400;
    const maxMs = opts.maxMs ?? COMMAND_MAX_MS;
    const start = Date.now();
    let seen = this.lines.length;
    let quietSince = Date.now();
    while (Date.now() - start < maxMs && this.state !== "exited") {
      await sleep(50);
      if (this.lines.length !== seen) {
        seen = this.lines.length;
        quietSince = Date.now();
      } else if ((!opts.needOutput || seen > from) && Date.now() - quietSince >= quietMs) break;
    }
    return this.lines.slice(from);
  }

  /**
   * Send a console command and collect the lines it prints: everything until the console is quiet for
   * `quietMs` (BDS does not correlate output with commands), capped at `maxMs`.
   */
  async command(command: string, opts: { quietMs?: number; maxMs?: number } = {}): Promise<ConsoleLine[]> {
    const from = this.lines.length;
    this.write(command);
    return this.quiet(from, { ...opts, needOutput: true });
  }

  /** `stop` on the console, wait up to `graceMs`, then kill (SIGKILL; TerminateProcess on Windows). Returns the exit code. */
  async stop(graceMs = 30_000): Promise<number | null> {
    if (this.state === "exited") return this.exitCode;
    this.state = "stopping";
    try {
      this.write("stop");
    } catch {
      // already gone
    }
    const timer = setTimeout(() => this.#proc.kill("SIGKILL"), graceMs);
    const code = await this.#exited;
    clearTimeout(timer);
    return code;
  }

  kill(): void {
    this.#proc.kill("SIGKILL");
  }
}
