import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cmdShimTargets, tscOnPath } from "./typescript.ts";

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "sculk-platform-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** An empty file, executable on POSIX. */
async function tool(file: string): Promise<string> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "");
  await chmod(file, 0o755);
  return file;
}

describe("tscOnPath", () => {
  it("runs a tsc executable as it is", async () => {
    const bin = join(base, "tsc-exe");
    const tsc = await tool(join(bin, process.platform === "win32" ? "tsc.exe" : "tsc"));
    expect(tscOnPath({ PATH: bin, PATHEXT: ".exe;.cmd" })).toEqual({ command: tsc, args: [] });
  });

  it("runs the JS launcher behind npm's tsc.cmd with node on Windows", async () => {
    const prefix = join(base, "npm-global");
    await tool(join(prefix, "tsc.cmd"));
    const js = await tool(join(prefix, "node_modules", "typescript", "bin", "tsc"));
    expect(tscOnPath({ Path: prefix, PATHEXT: ".exe;.cmd" }, "win32")).toEqual({ command: process.execPath, args: [js] });
    expect(tscOnPath({ Path: join(base, "empty"), PATHEXT: ".cmd" }, "win32")).toBeUndefined();
  });

  it("resolves global and project tsc.cmd shims to their JS launcher", () => {
    expect(cmdShimTargets(join("p", "node_modules", ".bin", "tsc.cmd"))).toEqual([
      join("p", "node_modules", ".bin", "node_modules", "typescript", "bin", "tsc"),
      join("p", "node_modules", "typescript", "bin", "tsc"),
    ]);
  });
});
