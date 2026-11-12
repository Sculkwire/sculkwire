/**
 * The managed install on disk, under `dataDir()`:
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
 */
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonOr } from "../core/fs.ts";
import { REPO_URL } from "../core/meta.ts";
import { dataDir } from "../core/paths.ts";

export const DEFAULT_REPO = `${REPO_URL}.git`;

const VERSIONS_DIR = "versions";
const INSTALL_FILE = "install.json";
const POINTER_NAME = { symlink: "current", file: "current.txt" } as const;
/** Written last into a version directory: the checkout is complete and passed its smoke check. */
export const READY_MARKER = ".sculkwire-ready";
const IN_USE_DIR = ".in-use";

export interface Layout {
  root: string;
  versions: string;
  bin: string;
  /** The sh launcher. */
  launcher: string;
  /** The Windows launcher. */
  launcherCmd: string;
  installFile: string;
  stateFile: string;
  lockFile: string;
  pointer: "symlink" | "file";
  pointerPath: string;
}

export function layout(root: string = dataDir(), pointer: Layout["pointer"] = process.platform === "win32" ? "file" : "symlink"): Layout {
  return {
    root,
    versions: join(root, VERSIONS_DIR),
    bin: join(root, "bin"),
    launcher: join(root, "bin", "sculk"),
    launcherCmd: join(root, "bin", "sculk.cmd"),
    installFile: join(root, INSTALL_FILE),
    stateFile: join(root, "update.json"),
    lockFile: join(root, "update.lock"),
    pointer,
    pointerPath: join(root, POINTER_NAME[pointer]),
  };
}

/** The launcher an MCP client should run on this platform. */
export function platformLauncher(l: Layout): string {
  return process.platform === "win32" ? l.launcherCmd : l.launcher;
}

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
  if (l.pointer === "symlink") await symlink(join(VERSIONS_DIR, version), tmp);
  else await writeFile(tmp, `${version}\n`);
  await rename(tmp, l.pointerPath);
}

export interface InstallInfo {
  repo: string;
  createdAt: string;
}

export function readInstall(l: Layout): Promise<InstallInfo | undefined> {
  return readJsonOr<InstallInfo>(l.installFile);
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
  if (basename(parent) === VERSIONS_DIR && !version.startsWith(".") && existsSync(join(root, INSTALL_FILE))) {
    return { root: code, managed: { layout: layout(root, pointer), version } };
  }
  return { root: code };
}

const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** The sh launcher follows the `current` symlink, the Windows one reads `current.txt`. */
function launcherScripts(l: Layout): { sh: string; cmd: string } {
  const sh = [
    "#!/bin/sh",
    "# sculkwire launcher, written by `sculk update`. Runs the current managed version.",
    `exec "\${SCULKWIRE_NODE:-node}" ${shQuote(join(l.root, POINTER_NAME.symlink, "src", "cli.ts"))} "$@"`,
    "",
  ].join("\n");
  const cmd = [
    "@echo off",
    "rem sculkwire launcher, written by `sculk update`. Runs the current managed version.",
    "setlocal",
    'if not defined SCULKWIRE_NODE set "SCULKWIRE_NODE=node"',
    `set /p SCULKWIRE_VERSION=<"${l.root}\\${POINTER_NAME.file}"`,
    `"%SCULKWIRE_NODE%" "${l.root}\\${VERSIONS_DIR}\\%SCULKWIRE_VERSION%\\src\\cli.ts" %*`,
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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Mark the version directory a running MCP server uses, so another process's update does not prune it. The mark is
 * removed when this process exits. Returns the release function.
 */
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
