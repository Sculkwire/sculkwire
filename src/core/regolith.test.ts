import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findRgl, rglCandidates } from "./regolith.ts";

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "sculk-regolith-"));
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

describe("rglCandidates", () => {
  it("looks in ~/.local/bin, then ~/.rgl/bin on Linux", () => {
    expect(rglCandidates("linux", {}, "/home/u")).toEqual(["/home/u/.local/bin/rgl", "/home/u/.rgl/bin/rgl"]);
  });

  it("looks for rgl.exe under %USERPROFILE% on Windows", () => {
    expect(rglCandidates("win32", { USERPROFILE: "C:\\Users\\me" }, "ignored")).toEqual([
      "C:\\Users\\me\\.local\\bin\\rgl.exe",
      "C:\\Users\\me\\.rgl\\bin\\rgl.exe",
    ]);
  });
});

describe("findRgl", () => {
  it("prefers the home folders, then PATH", async () => {
    const home = join(base, "rgl-home");
    const bin = join(base, "rgl-bin");
    const exe = process.platform === "win32" ? "rgl.exe" : "rgl";
    const onPath = await tool(join(bin, exe));
    const env = { PATH: bin, PATHEXT: ".exe", USERPROFILE: home };
    expect(findRgl(undefined, env, process.platform, home)).toBe(onPath);
    const local = await tool(join(home, ".rgl", "bin", exe));
    expect(findRgl(undefined, env, process.platform, home)).toBe(local);
    expect(findRgl("/custom/rgl", env, process.platform, home)).toBe("/custom/rgl");
  });

  it("resolves rgl on a Windows PATH with PATHEXT, a .cmd shim included", async () => {
    const bin = join(base, "rgl-shim");
    const env = { Path: bin, PathExt: ".exe;.cmd" };
    expect(findRgl(undefined, env, "win32", join(base, "nohome"))).toBeUndefined();
    const shim = await tool(join(bin, "rgl.cmd"));
    expect(findRgl(undefined, env, "win32", join(base, "nohome"))).toBe(shim);
    const exe = await tool(join(bin, "rgl.exe"));
    expect(findRgl(undefined, env, "win32", join(base, "nohome"))).toBe(exe);
  });
});
