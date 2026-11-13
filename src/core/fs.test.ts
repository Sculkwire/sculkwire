import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exists, readJsonOr, sameFiles, writeJsonAtomic } from "./fs.ts";

let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "sculk-fs-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("file helpers", () => {
  it("writes JSON into a new folder and leaves no temp file behind", async () => {
    const path = join(base, "deep", "state.json");
    await writeJsonAtomic(path, { a: 1 });
    expect(await readFile(path, "utf8")).toBe('{\n  "a": 1\n}\n');
    expect(await readdir(join(base, "deep"))).toEqual(["state.json"]);
    expect(await readJsonOr<{ a: number }>(path)).toEqual({ a: 1 });
  });

  it("reads a missing or broken JSON file as undefined", async () => {
    expect(await readJsonOr(join(base, "missing.json"))).toBeUndefined();
    await writeFile(join(base, "broken.json"), "{");
    expect(await readJsonOr(join(base, "broken.json"))).toBeUndefined();
  });

  it("tells whether a path exists", async () => {
    expect(await exists(base)).toBe(true);
    expect(await exists(join(base, "nothing-here"))).toBe(false);
  });
});

describe("sameFiles", () => {
  async function tree(name: string, files: Record<string, string>): Promise<string> {
    const dir = join(base, name);
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(dir, rel, ".."), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
    return dir;
  }

  it("tells equal folders from ones that differ in a name, a nesting or a byte of the same size", async () => {
    const files = { "manifest.json": "{}", "scripts/main.js": "let a = 1;" };
    const a = await tree("same-a", files);
    expect(await sameFiles(a, await tree("same-b", files))).toBe(true);
    expect(await sameFiles(a, await tree("same-byte", { ...files, "scripts/main.js": "let a = 2;" }))).toBe(false);
    expect(await sameFiles(a, await tree("same-extra", { ...files, "scripts/more.js": "" }))).toBe(false);
    expect(await sameFiles(a, await tree("same-renamed", { "manifest.json": "{}", "scripts/other.js": "let a = 1;" }))).toBe(false);
    expect(await sameFiles(a, await tree("same-flat", { "manifest.json": "{}", scripts: "let a = 1;" }))).toBe(false);
    expect(await sameFiles(a, join(base, "same-missing"))).toBe(false);
  });
});
