/**
 * Installing a version into the managed layout (`layout.ts`), switching to it, and rolling back.
 * Only Node built-ins are imported here: the installer runs this from a fresh clone before `npm ci`.
 */
import { existsSync } from "node:fs";
import { mkdir, open, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../core/errors.ts";
import { runUnattended } from "../core/process.ts";
import type { UpdateChannel } from "./config.ts";
import { DEFAULT_REPO, type Layout, prune, readCurrent, readInstall, READY_MARKER, switchCurrent } from "./layout.ts";
import { git, lastLine } from "./process.ts";
import { smokeCheck } from "./smoke.ts";
import { patchState, readState } from "./state.ts";
import { isNewer, latestTarget, LS_REMOTE_TIMEOUT_MS, mainVersion, type Target } from "./tags.ts";

const CLONE_TIMEOUT_MS = 180_000;
const DEPS_TIMEOUT_MS = 600_000;
/** How many version directories `update` keeps (the current one and the one before it). */
const KEEP_VERSIONS = 2;

export interface Hooks {
  /** Install dependencies in a fresh checkout. Default: `npm ci`. */
  deps?: (dir: string) => Promise<void>;
  /** Fail when the checkout does not work. Default: `--help` plus an MCP `tools/list`. */
  smoke?: (dir: string) => Promise<void>;
  /** Progress lines. Default: stderr. */
  log?: (line: string) => void;
  /** Overrides the `git ls-remote` and clone timeouts (the network steps). */
  networkTimeoutMs?: number;
}

async function npmCi(dir: string): Promise<void> {
  // Full install: the validator falls back to this checkout's TypeScript for the `typescript` check.
  const r = await runUnattended("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, timeoutMs: DEPS_TIMEOUT_MS });
  if (r.code !== 0) throw new Error(`npm ci failed in ${dir}: ${lastLine(r.stderr) || `exit ${r.code}`}`);
}

/**
 * Clone `target` into a staging directory, install deps, smoke check it, then rename it to `versions/<version>`.
 * Returns the version name (for main, from the commit actually cloned). An existing ready directory is reused.
 */
async function installVersion(l: Layout, repo: string, target: Target, hooks: Hooks): Promise<string> {
  const log = hooks.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const ready = (version: string) => existsSync(join(l.versions, version, READY_MARKER));
  if (ready(target.version)) return target.version;
  await mkdir(l.versions, { recursive: true });
  const staging = join(l.versions, `.staging-${target.version}-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  try {
    log(`sculkwire: downloading ${target.ref} from ${repo}`);
    await git(["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", target.ref, repo, staging], {
      timeoutMs: hooks.networkTimeoutMs ?? CLONE_TIMEOUT_MS,
    });
    const version = target.ref === "main" ? mainVersion((await git(["rev-parse", "HEAD"], { cwd: staging, timeoutMs: 10_000 })).trim()) : target.version;
    if (ready(version)) {
      await rm(staging, { recursive: true, force: true });
      return version;
    }
    log(`sculkwire: installing dependencies for ${version}`);
    await (hooks.deps ?? npmCi)(staging);
    log(`sculkwire: checking ${version}`);
    await (hooks.smoke ?? smokeCheck)(staging);
    await writeFile(join(staging, READY_MARKER), `${new Date().toISOString()}\n`);
    const dest = join(l.versions, version);
    // A half-written directory from an interrupted run has no marker: replace it.
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
    return version;
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}

/** Hold `update.lock` while `fn` runs. A lock older than 15 minutes belongs to a dead run. */
async function withLock<T>(l: Layout, fn: () => Promise<T>): Promise<T> {
  await mkdir(l.root, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(l.lockFile, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw new Error("another sculkwire update is running");
      const age = Date.now() - (await stat(l.lockFile)).mtimeMs;
      if (age < 15 * 60 * 1000) throw new Error("another sculkwire update is running");
      await unlink(l.lockFile).catch(() => {});
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(l.lockFile).catch(() => {});
  }
}

export interface UpdateResult {
  action: "up-to-date" | "available" | "updated" | "no-release";
  current?: string;
  latest?: string;
  previous?: string;
  removed?: string[];
}

/**
 * Check the channel and, unless `check`, install the newest version and switch `current` to it. `off` still installs
 * the newest release when asked explicitly (only automatic checks honour `off`).
 */
export async function update(l: Layout, options: { channel: UpdateChannel; check?: boolean; repo?: string; hooks?: Hooks; now?: number }): Promise<UpdateResult> {
  const hooks = options.hooks ?? {};
  return withLock(l, async () => {
    const repo = options.repo ?? (await readInstall(l))?.repo ?? DEFAULT_REPO;
    const current = await readCurrent(l);
    await patchState(l, { lastCheck: options.now ?? Date.now() });
    let target: Target | undefined;
    try {
      target = await latestTarget(repo, options.channel === "main" ? "main" : "release", hooks.networkTimeoutMs ?? LS_REMOTE_TIMEOUT_MS);
    } catch (err) {
      await patchState(l, { lastError: errorMessage(err) });
      throw err;
    }
    if (!target) {
      await patchState(l, { latest: undefined, lastError: undefined });
      return { action: "no-release", current };
    }
    await patchState(l, { latest: target.version, lastError: undefined });
    if (!isNewer(current, target, options.channel)) return { action: "up-to-date", current, latest: target.version };
    if (options.check) return { action: "available", current, latest: target.version };
    let version: string;
    try {
      version = await installVersion(l, repo, target, hooks);
    } catch (err) {
      await patchState(l, { lastError: errorMessage(err) });
      throw err;
    }
    if (version === current) return { action: "up-to-date", current, latest: version };
    await switchCurrent(l, version);
    await patchState(l, { previous: current, latest: version, applied: { version, at: Date.now() } });
    const removed = await prune(l, [version, ...(current ? [current] : [])].slice(0, KEEP_VERSIONS));
    return { action: "updated", current: version, latest: version, previous: current, removed };
  });
}

/** Switch back to the version before the last update. The two versions trade places, so a second rollback undoes it. */
export async function rollback(l: Layout): Promise<{ current: string; previous?: string }> {
  return withLock(l, async () => {
    const state = await readState(l);
    const current = await readCurrent(l);
    if (!state.previous) throw new Error("no previous version to roll back to");
    await switchCurrent(l, state.previous);
    await patchState(l, { previous: current, applied: { version: state.previous, at: Date.now() } });
    return { current: state.previous, previous: current };
  });
}
