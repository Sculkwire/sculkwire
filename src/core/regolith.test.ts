import { mkdir, mkdtemp, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { regolithOutput } from "./regolith.ts";

let base: string;
beforeAll(async () => {
  // The real path: `regolithOutput` resolves links, and a temp dir may itself sit behind one.
  base = await realpath(await mkdtemp(join(tmpdir(), "sculk-regolith-")));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A Regolith project folder with a config.json and nothing built. */
async function project(name: string, packs: Record<string, string> = { behaviorPack: "./packs/BP", resourcePack: "./packs/RP" }): Promise<string> {
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "config.json"), JSON.stringify({ name, packs, regolith: { dataPath: "./src/data", profiles: { default: { filters: [{ filter: "tsc" }] } } } }));
  return root;
}

async function pack(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "manifest.json"), "{}");
  return dir;
}

const link = (target: string, path: string) => symlink(target, path, process.platform === "win32" ? "junction" : "dir");

describe("regolithOutput", () => {
  it("is undefined until rgl has built a pack with a manifest", async () => {
    const root = await project("unbuilt");
    expect(await regolithOutput(root)).toBeUndefined();
    // rgl creates the folder before the filters write the manifest.
    await mkdir(join(root, ".regolith", "tmp", "BP"), { recursive: true });
    expect(await regolithOutput(root)).toBeUndefined();
  });

  it("follows rgl's links to the export folders and takes the time of the last run from them", async () => {
    const root = await project("linked", { behaviorPack: "./src/BP", resourcePack: "./src/RP" });
    const bp = await pack(join(base, "com.mojang", "development_behavior_packs", "linked_bp"));
    const rp = await pack(join(root, "build", "linked_rp"));
    await mkdir(join(root, ".regolith", "tmp"), { recursive: true });
    await link(bp, join(root, ".regolith", "tmp", "BP"));
    await link(rp, join(root, ".regolith", "tmp", "RP"));
    // The export folder is older than the run that linked it: the link's time counts, not the folder's.
    await utimes(bp, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    const before = Date.now() - 60_000;

    const out = await regolithOutput(root);
    expect(out?.outputs).toEqual([
      { source: join(root, "src", "BP"), built: bp },
      { source: join(root, "src", "RP"), built: rp },
    ]);
    expect(out?.builtAt?.getTime()).toBeGreaterThan(before);
    expect(out?.dataDir).toBe(join(root, "src", "data"));
    // Reading changes nothing.
    expect(await readdir(bp)).toEqual(["manifest.json"]);
  });

  it("reads real folders (rgl --compat, a none export) without a time, and only the packs rgl built", async () => {
    const root = await project("compat");
    const bp = await pack(join(root, ".regolith", "tmp", "BP"));
    expect(await regolithOutput(root)).toEqual({ outputs: [{ source: join(root, "packs", "BP"), built: bp }], dataDir: join(root, "src", "data") });
  });
});
