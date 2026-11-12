import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exists, readJsonOr, writeJsonAtomic } from "./fs.ts";

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
