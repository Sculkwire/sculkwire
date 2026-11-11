/**
 * Managed installs and updates. Layout under `dataDir()`:
 * - `versions/<version>/`: one checkout per release tag (`v0.2.0`) or main commit (`main-<sha12>`), with its deps.
 * - `current`: symlink to `versions/<version>` (Unix), or `current.txt` holding the version name (Windows).
 * - `bin/sculk` and `bin/sculk.cmd`: stable launchers that run `node <current>/src/cli.ts`. MCP clients are registered
 *   with them, so an update never changes a client config.
 * - `install.json` (repo URL, marks the layout as managed), `update.json` (throttle, previous version, last result).
 *
 * A version directory is never changed in place: a new version is cloned to a staging directory, checked, then
 * renamed, and `current` switches atomically. A running MCP server keeps its version until it restarts.
 *
 * Only Node built-ins are imported here: the installer runs this from a fresh clone before `npm ci`.
 * Child processes never inherit stdout (the MCP server speaks JSON-RPC on it) and every step has a timeout.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, readlink, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_URL } from "../core/meta.ts";
import { dataDir } from "../core/paths.ts";

export const DEFAULT_REPO = `${REPO_URL}.git`;
export const CHANNELS = ["release", "main", "off"] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How many version directories `update` keeps (the current one and the one before it). */
export const KEEP_VERSIONS = 2;

const READY_MARKER = ".sculkwire-ready";
const IN_USE_DIR = ".in-use";

export const TIMEOUTS = {
  lsRemote: 20_000,
  clone: 180_000,
  deps: 600_000,
  smoke: 60_000,
};

export interface Layout {
  root: string;
  versions: string;
  bin: string;
  /** `bin/sculk` (sh). */
  launcher: string;
  /** `bin/sculk.cmd` (Windows). */
  launcherCmd: string;
  installFile: string;
  stateFile: string;
  lockFile: string;
  pointer: "symlink" | "file";
  /** `current` (symlink) or `current.txt` (file pointer). */
  pointerPath: string;
}

export function layout(root: string = dataDir(), pointer: Layout["pointer"] = process.platform === "win32" ? "file" : "symlink"): Layout {
  return {
    root,
    versions: join(root, "versions"),
    bin: join(root, "bin"),
    launcher: join(root, "bin", "sculk"),
    launcherCmd: join(root, "bin", "sculk.cmd"),
    installFile: join(root, "install.json"),
    stateFile: join(root, "update.json"),
    lockFile: join(root, "update.lock"),
    pointer,
    pointerPath: join(root, pointer === "symlink" ? "current" : "current.txt"),
  };
}

/** The launcher an MCP client should run on this platform. */
export function platformLauncher(l: Layout): string {
  return process.platform === "win32" ? l.launcherCmd : l.launcher;
}

// ---------------------------------------------------------------------------------------------------------------
// Versions

export interface ParsedTag {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

export function parseTag(tag: string): ParsedTag | undefined {
  const m = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

/** Semver precedence of two `vX.Y.Z[-pre]` tags. Unparseable tags sort first. */
export function compareTags(a: string, b: string): number {
  const pa = parseTag(a);
  const pb = parseTag(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (const k of ["major", "minor", "patch"] as const) if (pa[k] !== pb[k]) return pa[k] - pb[k];
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Newest release tag; prereleases (`v1.0.0-rc.1`) only when asked. */
export function newestTag(tags: readonly string[], options: { prerelease?: boolean } = {}): string | undefined {
  const usable = tags.filter((t) => {
    const p = parseTag(t);
    return p !== undefined && (options.prerelease || p.pre.length === 0);
  });
  return usable.sort(compareTags).at(-1);
}

/** What a channel installs: a tag, or the head of main. `version` is the version directory name. */
export interface Target {
  version: string;
  ref: string;
}

/** Whether `target` should replace the `current` version on `channel`. */
export function isNewer(current: string | undefined, target: Target, channel: Channel): boolean {
  if (!current) return true;
  if (current === target.version) return false;
  if (channel === "main") return true;
  // A release replaces a main checkout (channel switched back) or an older release, never a newer one.
  return !parseTag(current) || compareTags(target.version, current) > 0;
}

export function mainVersion(sha: string): string {
  return `main-${sha.slice(0, 12)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Processes

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command with stdout and stderr piped (never inherited) and a hard timeout. Git never prompts: a repository
 * that needs credentials works through the user's credential helper, and missing credentials fail instead of hanging.
 */
export function run(command: string, args: readonly string[], options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; input?: string }): Promise<RunResult> {
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  // npm and other .cmd shims only run through a shell on Windows, which then needs the quoting done here.
  const shell = process.platform === "win32" && (command === "npm" || /\.(cmd|bat)$/i.test(command));
  const quote = (s: string) => (shell && /[\s&()^|<>"]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  const child = spawn(quote(command), args.map(quote), {
    cwd: options.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    shell,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error(`${command} ${args.join(" ")} timed out after ${Math.round(options.timeoutMs / 1000)} s`));
  }, options.timeoutMs);
  child.on("error", (err) => {
    clearTimeout(timer);
    reject(err);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code: code ?? 1, stdout, stderr });
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input ?? "");
  return promise;
}

async function git(args: readonly string[], options: { cwd?: string; timeoutMs: number }): Promise<string> {
  const r = await run("git", args, options);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${lastLine(r.stderr) || `exit ${r.code}`}`);
  return r.stdout;
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
}

export async function remoteTags(repo: string, timeoutMs = TIMEOUTS.lsRemote): Promise<string[]> {
  const out = await git(["ls-remote", "--tags", "--refs", repo], { timeoutMs });
  return out
    .split("\n")
    .map((line) => /\trefs\/tags\/(.+)$/.exec(line.trim())?.[1])
    .filter((t): t is string => t !== undefined);
}

export async function remoteHead(repo: string, branch = "main", timeoutMs = TIMEOUTS.lsRemote): Promise<string> {
  const out = await git(["ls-remote", repo, `refs/heads/${branch}`], { timeoutMs });
  const sha = out.split("\t")[0]?.trim();
  if (!sha) throw new Error(`${repo} has no branch ${branch}`);
  return sha;
}

/** The newest version on a channel (`off` resolves like `release`), or undefined when there is no release yet. */
export async function latestTarget(repo: string, channel: Channel, timeoutMs = TIMEOUTS.lsRemote): Promise<Target | undefined> {
  if (channel === "main") return { version: mainVersion(await remoteHead(repo, "main", timeoutMs)), ref: "main" };
  const tag = newestTag(await remoteTags(repo, timeoutMs));
  return tag ? { version: tag, ref: tag } : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Pointer, state and install marker

export async function readCurrent(l: Layout): Promise<string | undefined> {
  try {
    if (l.pointer === "symlink") return basename(await readlink(l.pointerPath));
    return (await readFile(l.pointerPath, "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Point `current` at `versions/<version>` with one rename, so a reader sees either the old or the new version. */
export async function switchCurrent(l: Layout, version: string): Promise<void> {
  if (!existsSync(join(l.versions, version, READY_MARKER))) throw new Error(`version ${version} is not installed in ${l.versions}`);
  const tmp = `${l.pointerPath}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  if (l.pointer === "symlink") await symlink(join("versions", version), tmp);
  else await writeFile(tmp, `${version}\n`);
  await rename(tmp, l.pointerPath);
}

export interface UpdateState {
  /** Version that was current before the last switch (`update --rollback` target). */
  previous?: string;
  /** Last automatic or manual check (ms since epoch). */
  lastCheck?: number;
  /** Newest version seen at the last check. */
  latest?: string;
  /** Why the last check or install failed. */
  lastError?: string;
  /** Last version `update` switched to. */
  applied?: { version: string; at: number };
}

export async function readState(l: Layout): Promise<UpdateState> {
  try {
    return JSON.parse(await readFile(l.stateFile, "utf8")) as UpdateState;
  } catch {
    return {};
  }
}

export async function writeState(l: Layout, state: UpdateState): Promise<void> {
  await mkdir(l.root, { recursive: true });
  const tmp = `${l.stateFile}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, l.stateFile);
}

export async function patchState(l: Layout, patch: Partial<UpdateState>): Promise<UpdateState> {
  const next = { ...(await readState(l)), ...patch };
  await writeState(l, next);
  return next;
}

export interface InstallInfo {
  repo: string;
  createdAt: string;
}

export async function readInstall(l: Layout): Promise<InstallInfo | undefined> {
  try {
    return JSON.parse(await readFile(l.installFile, "utf8")) as InstallInfo;
  } catch {
    return undefined;
  }
}

/** Once a check is due: never checked, 24 h passed, or the clock went backwards. */
export function dueForCheck(state: UpdateState, now: number = Date.now(), intervalMs: number = CHECK_INTERVAL_MS): boolean {
  return state.lastCheck === undefined || now < state.lastCheck || now - state.lastCheck >= intervalMs;
}

// ---------------------------------------------------------------------------------------------------------------
// Which code is running

/** Root of the checkout this module runs from (symlinks resolved). */
export function codeRoot(): string {
  return realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
}

export interface Running {
  /** Checkout the running code belongs to. */
  root: string;
  /** Set when that checkout is a version directory of a managed install. */
  managed?: { layout: Layout; version: string };
}

/** A managed version lives in `<root>/versions/<version>` next to `<root>/install.json`; anything else is a dev checkout. */
export function detectRunning(code: string = codeRoot(), pointer?: Layout["pointer"]): Running {
  const parent = dirname(code);
  const version = basename(code);
  const root = dirname(parent);
  if (basename(parent) === "versions" && !version.startsWith(".") && existsSync(join(root, "install.json"))) {
    return { root: code, managed: { layout: layout(root, pointer), version } };
  }
  return { root: code };
}

// ---------------------------------------------------------------------------------------------------------------
// Launchers

const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export function launcherScripts(l: Layout): { sh: string; cmd: string } {
  const sh = [
    "#!/bin/sh",
    "# sculkwire launcher, written by `sculk update`. Runs the current managed version.",
    `exec "\${SCULKWIRE_NODE:-node}" ${shQuote(join(l.root, "current", "src", "cli.ts"))} "$@"`,
    "",
  ].join("\n");
  const cmd = [
    "@echo off",
    "rem sculkwire launcher, written by `sculk update`. Runs the current managed version.",
    "setlocal",
    'if not defined SCULKWIRE_NODE set "SCULKWIRE_NODE=node"',
    `set /p SCULKWIRE_VERSION=<"${l.root}\\current.txt"`,
    `"%SCULKWIRE_NODE%" "${l.root}\\versions\\%SCULKWIRE_VERSION%\\src\\cli.ts" %*`,
    "",
  ].join("\r\n");
  return { sh, cmd };
}

export async function writeLaunchers(l: Layout): Promise<void> {
  await mkdir(l.bin, { recursive: true });
  const { sh, cmd } = launcherScripts(l);
  await writeFile(l.launcher, sh);
  await chmod(l.launcher, 0o755);
  await writeFile(l.launcherCmd, cmd);
}

// ---------------------------------------------------------------------------------------------------------------
// In-use markers and pruning

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Mark a version directory as used by this process (an MCP server). Returns the release function. */
export function markInUse(versionDir: string): () => void {
  const file = join(versionDir, IN_USE_DIR, String(process.pid));
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  } catch {
    return () => {};
  }
  const release = () => rmSync(file, { force: true });
  process.once("exit", release);
  return release;
}

async function inUse(versionDir: string): Promise<boolean> {
  let pids: string[];
  try {
    pids = await readdir(join(versionDir, IN_USE_DIR));
  } catch {
    return false;
  }
  return pids.some((p) => Number(p) !== process.pid && alive(Number(p)));
}

/** Remove version directories outside `keep` that no live process uses, and stale staging directories. */
export async function prune(l: Layout, keep: readonly string[]): Promise<string[]> {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(l.versions);
  } catch {
    return removed;
  }
  for (const name of entries) {
    const dir = join(l.versions, name);
    if (name.startsWith(".staging-")) {
      const age = Date.now() - (await stat(dir)).mtimeMs;
      if (age > 60 * 60 * 1000) await rm(dir, { recursive: true, force: true });
      continue;
    }
    if (keep.includes(name) || (await inUse(dir))) continue;
    await rm(dir, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------------------------
// Installing a version

export interface Hooks {
  /** Install dependencies in a fresh checkout. Default: `npm ci`. */
  deps?: (dir: string) => Promise<void>;
  /** Fail when the checkout does not work. Default: `--help` plus an MCP `tools/list`. */
  smoke?: (dir: string) => Promise<void>;
  /** Progress lines. Default: stderr. */
  log?: (line: string) => void;
  /** Overrides `TIMEOUTS.lsRemote` and `TIMEOUTS.clone` (the network steps). */
  networkTimeoutMs?: number;
}

export async function npmCi(dir: string): Promise<void> {
  // Full install: the validator falls back to this checkout's TypeScript for the `typescript` check.
  const r = await run("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, timeoutMs: TIMEOUTS.deps });
  if (r.code !== 0) throw new Error(`npm ci failed in ${dir}: ${lastLine(r.stderr) || `exit ${r.code}`}`);
}

/** Environment for a checkout under test: it must not start its own update. */
const SMOKE_ENV = { SCULKWIRE_AUTO_UPDATE: "0" };

/** `node src/cli.ts --help` exits 0, and `node src/cli.ts mcp` answers `tools/list` with at least one tool. */
export async function smokeCheck(dir: string): Promise<void> {
  const cli = join(dir, "src", "cli.ts");
  const help = await run(process.execPath, [cli, "--help"], { cwd: dir, timeoutMs: TIMEOUTS.smoke, env: SMOKE_ENV });
  if (help.code !== 0 || !help.stdout.includes("Usage")) throw new Error(`smoke check: \`sculk --help\` failed: ${lastLine(help.stderr) || `exit ${help.code}`}`);
  const count = await mcpToolCount(cli, dir);
  if (count < 1) throw new Error("smoke check: the MCP server listed no tools");
}

/** Start `cli.ts mcp`, initialize, list tools and stop it. */
export function mcpToolCount(cli: string, cwd: string, timeoutMs = TIMEOUTS.smoke): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const child = spawn(process.execPath, [cli, "mcp"], { cwd, env: { ...process.env, ...SMOKE_ENV }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buffer = "";
  let stderr = "";
  let done = false;
  let exited = false;
  // Settle only after the child has exited: on Windows a live child keeps its cwd (the staging folder) locked,
  // so renaming or removing it right after the check fails with EBUSY.
  const finish = (err: Error | undefined, count?: number) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    const settle = () => (err ? reject(err) : resolve(count ?? 0));
    if (exited) return settle();
    const cap = setTimeout(settle, 5_000);
    child.once("close", () => {
      clearTimeout(cap);
      settle();
    });
    child.stdin.end();
    child.kill();
  };
  const timer = setTimeout(() => finish(new Error(`smoke check: MCP tools/list did not answer within ${timeoutMs / 1000} s`)), timeoutMs);
  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  child.stdin.on("error", () => {});
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  child.stdout.on("data", (c: Buffer) => {
    buffer += c.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: { tools?: unknown[] }; error?: { message?: string } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue;
      }
      if (msg.error) return finish(new Error(`smoke check: MCP error ${msg.error.message ?? ""}`));
      if (msg.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      } else if (msg.id === 2) return finish(undefined, msg.result?.tools?.length ?? 0);
    }
  });
  child.on("error", (err) => {
    exited = true;
    finish(err);
  });
  child.on("close", (code) => {
    exited = true;
    finish(new Error(`smoke check: MCP server exited (${code}) before tools/list: ${lastLine(stderr)}`));
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sculk-update", version: "0" } } });
  return promise;
}

/**
 * Clone `target` into a staging directory, install deps, smoke check it, then rename it to `versions/<version>`.
 * Returns the version name (for main, from the commit actually cloned). An existing ready directory is reused.
 */
export async function installVersion(l: Layout, repo: string, target: Target, hooks: Hooks = {}): Promise<string> {
  const log = hooks.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const ready = (version: string) => existsSync(join(l.versions, version, READY_MARKER));
  if (ready(target.version)) return target.version;
  await mkdir(l.versions, { recursive: true });
  const staging = join(l.versions, `.staging-${target.version}-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  try {
    log(`sculkwire: downloading ${target.ref} from ${repo}`);
    await git(["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", target.ref, repo, staging], {
      timeoutMs: hooks.networkTimeoutMs ?? TIMEOUTS.clone,
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

// ---------------------------------------------------------------------------------------------------------------
// Update, rollback

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
export async function update(l: Layout, options: { channel: Channel; check?: boolean; repo?: string; hooks?: Hooks; now?: number }): Promise<UpdateResult> {
  const hooks = options.hooks ?? {};
  return withLock(l, async () => {
    const repo = options.repo ?? (await readInstall(l))?.repo ?? DEFAULT_REPO;
    const current = await readCurrent(l);
    await patchState(l, { lastCheck: options.now ?? Date.now() });
    let target: Target | undefined;
    try {
      target = await latestTarget(repo, options.channel === "main" ? "main" : "release", hooks.networkTimeoutMs ?? TIMEOUTS.lsRemote);
    } catch (err) {
      await patchState(l, { lastError: err instanceof Error ? err.message : String(err) });
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
      await patchState(l, { lastError: err instanceof Error ? err.message : String(err) });
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

/** Write `install.json` (unless present) and the launchers. */
export async function initLayout(l: Layout, repo: string): Promise<void> {
  await mkdir(l.versions, { recursive: true });
  const existing = await readInstall(l);
  if (existing?.repo !== repo) {
    await writeFile(l.installFile, `${JSON.stringify({ repo, createdAt: existing?.createdAt ?? new Date().toISOString() }, null, 2)}\n`);
  }
  await writeLaunchers(l);
}

/** `git remote get-url origin` of a checkout, if any. */
export function checkoutRemote(dir: string): Promise<string | undefined> {
  return run("git", ["remote", "get-url", "origin"], { cwd: dir, timeoutMs: 10_000 }).then(
    (r) => (r.code === 0 ? r.stdout.trim() || undefined : undefined),
    () => undefined,
  );
}
