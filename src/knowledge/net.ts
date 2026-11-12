/** Shared plumbing for the knowledge layer: HTTP, child processes, progress on stderr. */
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { USER_AGENT } from "../core/meta.ts";
import { run, type RunResult } from "../core/process.ts";

export function progress(message: string): void {
  process.stderr.write(`[knowledge] ${message}\n`);
}

async function request(url: string, headers: Record<string, string> = {}, timeoutMs = 60_000): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      // 4xx is final; 5xx gets one retry.
      lastError = new Error(`GET ${url}: HTTP ${res.status}`);
      if (res.status < 500) break;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function httpJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const res = await request(url, { accept: "application/json", ...headers });
  return (await res.json()) as T;
}

export async function httpBytes(url: string): Promise<Uint8Array> {
  const res = await request(url, {}, 300_000);
  return new Uint8Array(await res.arrayBuffer());
}

/** Runs a binary without a shell; git never prompts. Rejects with stderr in the message unless it exits 0. */
export async function runOk(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  const r = await run(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r;
}

/**
 * Move a fully prepared temp directory into place. If another process won the race, keep theirs.
 * Returns true when ours was installed.
 */
export async function installDir(tmp: string, target: string): Promise<boolean> {
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(tmp, target);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      await rm(tmp, { recursive: true, force: true });
      return false;
    }
    throw err;
  }
}

const inflight = new Map<string, Promise<unknown>>();

/** Collapse concurrent calls with the same key into one promise (cleared once settled). */
export function single<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Test hook: whether a `single` call with this key is running. */
export function isInFlight(key: string): boolean {
  return inflight.has(key);
}

/** Thrown when offline mode needs data that is not cached. */
export class OfflineMissingError extends Error {
  constructor(what: string) {
    super(`${what} is not cached and offline mode is on; run \`sculk knowledge update\` while online`);
    this.name = "OfflineMissingError";
  }
}
