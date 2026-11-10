import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extensionDirs, readExtensions, registerExtension } from "./index.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "sculk-ext-"));
  roots.push(dir);
  return dir;
}

/** A fake extension package: `manifest` is its package.json (undefined writes none), `entry` its entry source. */
function fakeExtension(root: string, name: string, manifest: unknown, entry?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) writeFileSync(join(dir, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  if (entry !== undefined) writeFileSync(join(dir, "index.mjs"), entry);
  return dir;
}

const WORKING = `
export default function activate(host) {
  return {
    name: "fake",
    register(server) {
      server.registerTool("fake_tool", { description: "x", inputSchema: { n: host.z.number() } }, async () => ({ content: [] }));
    },
    commands: [{ name: "fake run", summary: "fake command", run: async () => host.ExitCode.ok }],
  };
}
`;

describe("extensionDirs", () => {
  it("lists SCULKWIRE_EXTENSIONS entries, then the subdirectories and directory links of the extensions folder", () => {
    const root = temp();
    const folder = join(root, "extensions");
    mkdirSync(join(folder, "b"), { recursive: true });
    writeFileSync(join(folder, "file.txt"), "not a directory");
    const target = join(root, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, join(folder, "a"), process.platform === "win32" ? "junction" : "dir");
    symlinkSync(join(root, "missing"), join(folder, "c"), process.platform === "win32" ? "junction" : "dir");
    const env = { SCULKWIRE_EXTENSIONS: [join(root, "x"), "", join(root, "y")].join(delimiter) };
    expect(extensionDirs(env, folder)).toEqual([join(root, "x"), join(root, "y"), join(folder, "a"), join(folder, "b")]);
    expect(extensionDirs({}, join(root, "none"))).toEqual([]);
  });
});

describe("readExtensions", () => {
  it("loads an extension's tools and commands with the host's values, skipping broken ones on stderr only", async () => {
    const root = temp();
    const good = fakeExtension(root, "good", { sculkwire: { extension: "./index.mjs" } }, WORKING);
    const noManifest = fakeExtension(root, "none", undefined);
    const badJson = fakeExtension(root, "badjson", "{ not json");
    const noEntry = fakeExtension(root, "noentry", { name: "x" });
    const throws = fakeExtension(
      root,
      "throws",
      { sculkwire: { extension: "index.mjs" } },
      `export default function activate() { throw new Error("boom"); }`,
    );
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exts = await readExtensions({ dirs: [noManifest, badJson, good, noEntry, throws, join(root, "missing"), good] });

    expect(exts.map((e) => e.name)).toEqual(["fake"]);
    const lines = stderr.mock.calls.map(([chunk]) => String(chunk));
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(line).toMatch(/^sculkwire: extension .+ skipped: .+\n$/);
    expect(lines.join("")).toContain("boom");
    expect(stdout).not.toHaveBeenCalled();

    const registerTool = vi.fn();
    registerExtension({ registerTool } as unknown as McpServer, exts[0]!);
    expect(registerTool).toHaveBeenCalledWith("fake_tool", expect.anything(), expect.any(Function));
    const [command] = exts[0]!.commands!;
    expect(command!.name).toBe("fake run");
    expect(await command!.run([])).toBe(0);
  });

  it("reports a register that throws without stopping the server", () => {
    const warn = vi.fn();
    const register = () => {
      throw new Error("duplicate tool");
    };
    expect(() => registerExtension({} as McpServer, { name: "x", register }, warn)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("duplicate tool"));
  });
});
