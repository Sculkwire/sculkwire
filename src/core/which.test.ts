import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findOnPath } from "./which.ts";

let base: string;
let a: string;
let b: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "sculk-which-"));
  a = join(base, "a");
  b = join(base, "b");
  await mkdir(a);
  await mkdir(b);
  await writeFile(join(a, "tool.cmd"), "");
  await writeFile(join(b, "tool.exe"), "");
  await writeFile(join(b, "plain"), "");
  await writeFile(join(a, "script"), "#!/bin/sh\n");
  await chmod(join(a, "script"), 0o755);
  await writeFile(join(b, "script"), "");
  await chmod(join(b, "script"), 0o644);
  await writeFile(join(b, "noexec"), "");
  await chmod(join(b, "noexec"), 0o644);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("findOnPath on Windows rules", () => {
  // PATHEXT entries are lower case so the match also works on a case-sensitive file system.
  const env = () => ({ PATH: `${a};;${b}`, PATHEXT: ".exe;.cmd" });

  it("tries every PATHEXT extension in each PATH folder in order", () => {
    expect(findOnPath("tool", env(), "win32")).toBe(join(a, "tool.cmd"));
    expect(findOnPath("tool", { PATH: b, PATHEXT: ".exe;.cmd" }, "win32")).toBe(join(b, "tool.exe"));
    expect(findOnPath("missing", env(), "win32")).toBeUndefined();
  });

  it("uses a name with an extension as given", () => {
    expect(findOnPath("tool.exe", env(), "win32")).toBe(join(b, "tool.exe"));
    // A name without an extension only matches with a PATHEXT extension, never as a bare file.
    expect(findOnPath("plain", { PATH: b, PATHEXT: ".exe" }, "win32")).toBeUndefined();
  });

  it("reads Path and PathExt in any letter case from a plain env object", () => {
    expect(findOnPath("tool", { Path: b, PathExt: ".exe" }, "win32")).toBe(join(b, "tool.exe"));
    expect(findOnPath("tool", { path: a, pathext: ".cmd" }, "win32")).toBe(join(a, "tool.cmd"));
  });
});

// Windows has no execute bit (every file reports 0o666 or 0o444), so these need a POSIX file system.
describe.skipIf(process.platform === "win32")("findOnPath on POSIX rules", () => {
  it("requires the execute bit and adds no extension", () => {
    expect(findOnPath("script", { PATH: `${b}:${a}` }, "linux")).toBe(join(a, "script"));
    expect(findOnPath("noexec", { PATH: b }, "linux")).toBeUndefined();
    expect(findOnPath("tool", { PATH: `${a}:${b}` }, "linux")).toBeUndefined();
  });

  it("ignores Windows-style keys and separators", () => {
    expect(findOnPath("script", { Path: a }, "linux")).toBeUndefined();
    expect(findOnPath("script", { PATH: `${b};${a}` }, "linux")).toBeUndefined();
  });
});
