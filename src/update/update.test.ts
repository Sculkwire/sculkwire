import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runUnattended } from "../core/process.ts";
import { autoUpdate, versionInfo } from "./auto.ts";
import { runUpdate } from "./cli.ts";
import { readChannel, saveChannel } from "./config.ts";
import { rollback, update } from "./install.ts";
import { initLayout, layout, type Layout, readCurrent, type Running } from "./layout.ts";
import { dueForCheck, readState } from "./state.ts";
import { compareTags, isNewer, latestTarget, newestTag } from "./tags.ts";

/** Answers `--help` and a minimal MCP `initialize` + `tools/list`, like the real CLI. Plain JS is valid TS. */
const FAKE_CLI = `import { createInterface } from "node:readline";
const arg = process.argv[2];
if (arg === "--help") { process.stdout.write("Usage: sculk <command>\\n"); process.exit(0); }
if (arg === "mcp") {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) return;
    const result = msg.method === "tools/list" ? { tools: [{ name: "fake", inputSchema: { type: "object" } }] } : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "0" } };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  });
}
`;

let base: string;
let work: string;
let bare: string;
const GIT = ["-c", "user.name=Steve", "-c", "user.email=steve@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "init.defaultBranch=main"];
const savedEnv: Record<string, string | undefined> = {};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runUnattended("git", [...GIT, ...args], { cwd, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Commit a version bump in the work repo, tag it and push both to the bare repo. */
async function release(tag: string, push = true): Promise<void> {
  await writeFile(join(work, "package.json"), JSON.stringify({ name: "sculkwire", version: tag.slice(1), type: "module" }));
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", tag);
  await git(work, "tag", tag);
  if (push) await git(work, "push", "-q", "origin", "main", "--tags");
}

beforeAll(async () => {
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "SCULKWIRE_CONFIG"]) savedEnv[key] = process.env[key];
  base = await mkdtemp(join(tmpdir(), "sculk-update-"));
  await writeFile(join(base, "gitconfig"), "");
  process.env.GIT_CONFIG_GLOBAL = join(base, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(base, { recursive: true, force: true });
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(base, "install-"));
  process.env.SCULKWIRE_CONFIG = join(root, "config");
  // A fresh repo per test, with v0.1.0 released.
  work = join(root, "work");
  bare = join(root, "repo.git");
  await mkdir(join(work, "src"), { recursive: true });
  await git(root, "init", "-q", "--bare", bare);
  await git(work, "init", "-q");
  await git(work, "remote", "add", "origin", bare);
  await writeFile(join(work, "src", "cli.ts"), FAKE_CLI);
  await release("v0.1.0");
});
afterEach(() => {
  vi.restoreAllMocks();
});

const noDeps = { deps: async () => {}, log: () => {} };
const managed = (l: Layout, version: string): Running => ({ root: join(l.versions, version), managed: { layout: l, version } });

describe("tags and channels", () => {
  it("orders tags by semver precedence", () => {
    expect(compareTags("v0.10.0", "v0.9.9")).toBeGreaterThan(0);
    expect(compareTags("v1.0.0-rc.1", "v1.0.0")).toBeLessThan(0);
    expect(compareTags("v1.0.0-rc.2", "v1.0.0-rc.10")).toBeLessThan(0);
    expect(compareTags("v1.0.0-alpha", "v1.0.0-1")).toBeGreaterThan(0);
    expect(newestTag(["v0.2.0", "v0.10.0", "v0.9.0", "nightly", "v1.0.0-rc.1"])).toBe("v0.10.0");
    expect(newestTag(["v0.2.0", "v1.0.0-rc.1"], { prerelease: true })).toBe("v1.0.0-rc.1");
    expect(newestTag(["latest"])).toBeUndefined();
  });

  it("decides what replaces the current version", () => {
    expect(isNewer(undefined, { version: "v0.1.0", ref: "v0.1.0" }, "release")).toBe(true);
    expect(isNewer("v0.2.0", { version: "v0.1.0", ref: "v0.1.0" }, "release")).toBe(false);
    expect(isNewer("v0.1.0", { version: "v0.2.0", ref: "v0.2.0" }, "release")).toBe(true);
    expect(isNewer("main-abc", { version: "v0.1.0", ref: "v0.1.0" }, "release")).toBe(true);
    expect(isNewer("v0.2.0", { version: "main-abc", ref: "main" }, "main")).toBe(true);
    expect(isNewer("main-abc", { version: "main-abc", ref: "main" }, "main")).toBe(false);
  });

  it("finds the newest release tag or the head of main in a repo", async () => {
    await git(work, "tag", "v9.0.0-rc.1");
    await git(work, "push", "-q", "origin", "--tags");
    expect(await latestTarget(bare, "release")).toEqual({ version: "v0.1.0", ref: "v0.1.0" });
    expect(await latestTarget(bare, "off")).toEqual({ version: "v0.1.0", ref: "v0.1.0" });
    const head = await git(work, "rev-parse", "HEAD");
    expect(await latestTarget(bare, "main")).toEqual({ version: `main-${head.slice(0, 12)}`, ref: "main" });
    await expect(latestTarget(join(base, "missing.git"), "release")).rejects.toThrow(/git ls-remote failed/);
  });

  it("keeps the other sections of config.json when saving the channel", async () => {
    const path = join(root, "config", "config.json");
    expect(await readChannel(path)).toBe("release");
    await mkdir(join(root, "config"), { recursive: true });
    const other = { other: { key: "value" } };
    await writeFile(path, JSON.stringify(other));
    expect(await readChannel(path)).toBe("release");
    await saveChannel("off", path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...other, update: { channel: "off" } });
    expect(await readChannel(path)).toBe("off");
  });
});

describe("layout", () => {
  it("prints how to update a development checkout and exits 0", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    expect(await runUpdate([], { root: work })).toBe(0);
    expect(out.join("")).toMatch(/development checkout[\s\S]*git -C .* pull/);
  });

  it("defaults to the file pointer on Windows and the symlink elsewhere", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(layout(root)).toMatchObject({ pointer: "file", pointerPath: join(root, "current.txt") });
      Object.defineProperty(process, "platform", { value: "linux" });
      expect(layout(root)).toMatchObject({ pointer: "symlink", pointerPath: join(root, "current") });
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
  });
});

describe.each(["symlink", "file"] as const)("update with a %s pointer", (pointer) => {
  // Windows cannot rename a symlink over another (EPERM), so `layout()` uses the file pointer there; that variant runs on every OS.
  it.skipIf(pointer === "symlink" && process.platform === "win32")("installs, switches, rolls back and prunes", async () => {
    const l = layout(root, pointer);
    await initLayout(l, bare);
    expect(await update(l, { channel: "release", hooks: noDeps })).toMatchObject({ action: "updated", current: "v0.1.0" });
    expect(await readCurrent(l)).toBe("v0.1.0");
    expect(existsSync(join(l.versions, "v0.1.0", "src", "cli.ts"))).toBe(true);
    if (pointer === "symlink" && process.platform !== "win32") {
      const r = await runUnattended("sh", [l.launcher, "--help"], { timeoutMs: 30_000 });
      expect(r.stdout).toContain("Usage");
    }

    await release("v0.2.0");
    expect(await update(l, { channel: "release", check: true, hooks: noDeps })).toMatchObject({ action: "available", current: "v0.1.0", latest: "v0.2.0" });
    expect(await readCurrent(l)).toBe("v0.1.0");
    expect(await update(l, { channel: "release", hooks: noDeps })).toMatchObject({ action: "updated", current: "v0.2.0", previous: "v0.1.0" });
    expect(await readCurrent(l)).toBe("v0.2.0");
    expect(await update(l, { channel: "release", hooks: noDeps })).toMatchObject({ action: "up-to-date" });

    expect(await rollback(l)).toEqual({ current: "v0.1.0", previous: "v0.2.0" });
    expect(await readCurrent(l)).toBe("v0.1.0");
    expect(await rollback(l)).toEqual({ current: "v0.2.0", previous: "v0.1.0" });

    // v0.1.0 is in use by a running server (another live process), so the next update keeps it.
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await mkdir(join(l.versions, "v0.1.0", ".in-use"), { recursive: true });
    await writeFile(join(l.versions, "v0.1.0", ".in-use", String(sleeper.pid)), "");
    await release("v0.3.0");
    try {
      expect(await update(l, { channel: "release", hooks: noDeps })).toMatchObject({ action: "updated", current: "v0.3.0", removed: [] });
      expect(existsSync(join(l.versions, "v0.1.0"))).toBe(true);
    } finally {
      sleeper.kill();
    }
    await release("v0.4.0");
    expect(await update(l, { channel: "release", hooks: noDeps })).toMatchObject({ action: "updated", current: "v0.4.0", previous: "v0.3.0" });
    expect(existsSync(join(l.versions, "v0.1.0"))).toBe(false);
    expect(existsSync(join(l.versions, "v0.2.0"))).toBe(false);
    expect(existsSync(join(l.versions, "v0.3.0"))).toBe(true);
  });
});

describe("a broken release", () => {
  it("keeps the current version when the smoke check fails", async () => {
    const l = layout(root);
    await initLayout(l, bare);
    await update(l, { channel: "release", hooks: noDeps });
    const before = await readCurrent(l);
    const failing = { ...noDeps, smoke: async () => Promise.reject(new Error("smoke check: boom")) };
    await release("v0.9.0");
    await expect(update(l, { channel: "release", hooks: failing })).rejects.toThrow("boom");
    expect(await readCurrent(l)).toBe(before);
    expect((await readState(l)).lastError).toContain("boom");
    expect(existsSync(join(l.versions, "v0.9.0"))).toBe(false);
  });
});

describe("automatic updates", () => {
  it("checks at most once per 24 h", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(dueForCheck({}, 1000)).toBe(true);
    expect(dueForCheck({ lastCheck: 1000 }, 1000 + day - 1)).toBe(false);
    expect(dueForCheck({ lastCheck: 1000 }, 1000 + day)).toBe(true);
    expect(dueForCheck({ lastCheck: 5000 }, 1000)).toBe(true);
  });

  it("updates in the background without writing to stdout, and is throttled afterwards", async () => {
    const l = layout(root);
    await initLayout(l, bare);
    await update(l, { channel: "release", hooks: noDeps, now: 0 });
    const running = managed(l, (await readCurrent(l)) ?? "");
    await release("v1.0.0");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const lines: string[] = [];
    const notes: string[] = [];
    const log = (line: string) => lines.push(line);
    const now = Date.now();
    const result = await autoUpdate({ running, now, hooks: { deps: noDeps.deps }, log, notify: (m) => notes.push(m), env: {} });
    expect(result).toMatchObject({ action: "updated", current: "v1.0.0" });
    expect(notes).toEqual(["sculkwire v1.0.0 installed, restart the session to use it"]);
    expect(lines).toHaveLength(1);
    expect(await versionInfo(running)).toMatchObject({ managed: true, current: "v1.0.0", updateReady: true, channel: "release" });

    // Within 24 h nothing is checked, even with a newer tag waiting.
    await release("v1.1.0");
    expect(await autoUpdate({ running, now: now + 60_000, hooks: noDeps, log, env: {} })).toBeUndefined();
    expect(await readCurrent(l)).toBe("v1.0.0");

    // Offline or no credentials: one stderr line, no throw, current version kept.
    await writeFile(l.installFile, JSON.stringify({ repo: join(base, "missing.git"), createdAt: "x" }));
    expect(await autoUpdate({ running, now: now + 25 * 60 * 60 * 1000, hooks: noDeps, log, env: {} })).toBeUndefined();
    expect(lines.at(-1)).toMatch(/^sculkwire: automatic update check failed: git ls-remote failed/);
    expect(lines).toHaveLength(2);
    expect(await readCurrent(l)).toBe("v1.0.0");

    // Channel off and SCULKWIRE_AUTO_UPDATE=0 skip the check.
    await saveChannel("off");
    expect(await autoUpdate({ running, now: now + 50 * 60 * 60 * 1000, log, env: {} })).toBeUndefined();
    await saveChannel("release");
    expect(await autoUpdate({ running, now: now + 50 * 60 * 60 * 1000, log, env: { SCULKWIRE_AUTO_UPDATE: "0" } })).toBeUndefined();
    expect(lines).toHaveLength(2);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("does nothing in a development checkout", async () => {
    const log = vi.fn();
    expect(await autoUpdate({ running: { root: work }, log })).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });
});
