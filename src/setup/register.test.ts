import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectRunning, initLayout, layout, type Layout, type Running, writeLaunchers } from "../update/layout.ts";
import { parseClients, registerOmp, serverEntry } from "./register.ts";

let root: string;
/** A development checkout and the repo an install was made from; only their paths matter here. */
let work: string;
let bare: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sculk-register-"));
  work = join(root, "work");
  bare = join(root, "repo.git");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const managed = (l: Layout, version: string): Running => ({ root: join(l.versions, version), managed: { layout: l, version } });

describe("client registration", () => {
  it("adds sculkwire to omp's config, keeps other servers and a backup", async () => {
    const path = join(root, "omp", "mcp.json");
    await mkdir(join(root, "omp"), { recursive: true });
    const original = { mcpServers: { other: { type: "stdio", command: "other" }, sculkwire: { command: "old" } }, extra: true };
    await writeFile(path, JSON.stringify(original));
    const entry = { type: "stdio" as const, command: "/x/bin/sculk", args: ["mcp"] };
    expect(await registerOmp(entry, path)).toEqual({ path, backup: `${path}.bak` });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: { other: { type: "stdio", command: "other" }, sculkwire: entry }, extra: true });
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8"))).toEqual(original);
  });

  it("creates omp's config when missing and leaves an invalid one alone", async () => {
    const path = join(root, "new", "mcp.json");
    const entry = { type: "stdio" as const, command: "sculk", args: ["mcp"] };
    expect(await registerOmp(entry, path)).toEqual({ path });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: { sculkwire: entry } });
    await writeFile(path, "{ broken");
    await expect(registerOmp(entry, path)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{ broken");
  });

  it("parses client lists", () => {
    const names = (value: string) => {
      const clients = parseClients(value);
      return typeof clients === "string" ? clients : clients.map((c) => c.name);
    };
    expect(names("omp, claude,omp")).toEqual(["omp", "claude"]);
    expect(names("none")).toEqual([]);
    expect(parseClients("cursor")).toMatch(/unknown client cursor/);
  });
});

describe("server entry", () => {
  it("writes launchers that run the current version, the way an MCP client starts them", async () => {
    const l = layout(join(root, "it's here"));
    await mkdir(join(l.versions, "v0.1.0", "src"), { recursive: true });
    await writeFile(join(l.versions, "v0.1.0", "src", "cli.ts"), 'process.stdout.write(`${process.argv[2]} 0.1.0${process.env.SCULK_VIA ? ` via ${process.env.SCULK_VIA}` : ""}\\n`);\n');
    if (l.pointer === "symlink") await symlink(join("versions", "v0.1.0"), l.pointerPath);
    else await writeFile(l.pointerPath, "v0.1.0\n");
    await writeLaunchers(l);
    // The registered entry with `--version` in place of `mcp`: `cmd /c <bin>\sculk.cmd` on Windows, `<bin>/sculk` elsewhere.
    const entry = serverEntry(managed(l, "v0.1.0"));
    expect(entry.args.at(-1)).toBe("mcp");
    const launch = (env: NodeJS.ProcessEnv) => {
      const r = spawnSync(entry.command, [...entry.args.slice(0, -1), "--version"], { env, encoding: "utf8", timeout: 30_000 });
      return `${r.stdout}${r.stderr}`.trim();
    };
    const { SCULKWIRE_NODE: _, ...env } = process.env;
    // Without SCULKWIRE_NODE the launcher runs `node` from PATH (`Path` in a copied Windows environment).
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    expect(launch({ ...env, [pathKey]: `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ""}` })).toBe("--version 0.1.0");
    // SCULKWIRE_NODE picks another node: a wrapper that marks the run.
    const wrapper = join(root, process.platform === "win32" ? "node-wrapper.cmd" : "node-wrapper");
    await writeFile(
      wrapper,
      process.platform === "win32"
        ? `@echo off\r\nset SCULK_VIA=wrapper\r\n"${process.execPath}" %*\r\n`
        : `#!/bin/sh\nSCULK_VIA=wrapper exec '${process.execPath}' "$@"\n`,
    );
    await chmod(wrapper, 0o755);
    expect(launch({ ...env, SCULKWIRE_NODE: wrapper })).toBe("--version 0.1.0 via wrapper");
  });

  it("tells a managed version from a development checkout", async () => {
    const l = layout(root);
    await mkdir(join(l.versions, "v0.1.0"), { recursive: true });
    expect(detectRunning(join(l.versions, "v0.1.0")).managed).toBeUndefined();
    await initLayout(l, bare);
    expect(detectRunning(join(l.versions, "v0.1.0")).managed).toMatchObject({ version: "v0.1.0", layout: { root } });
    expect(detectRunning(join(l.versions, ".staging-v0.2.0-1")).managed).toBeUndefined();
    expect(detectRunning(work)).toEqual({ root: work });
    expect(serverEntry({ root: work })).toEqual({ type: "stdio", command: "node", args: [join(work, "src", "cli.ts"), "mcp"] });
    const launcher = process.platform === "win32" ? { command: "cmd", args: ["/c", l.launcherCmd, "mcp"] } : { command: l.launcher, args: ["mcp"] };
    expect(serverEntry(managed(l, "v0.1.0"))).toEqual({ type: "stdio", ...launcher });
  });
});
