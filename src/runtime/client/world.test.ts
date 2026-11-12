import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ICON_FILE, worldIcon } from "./icon.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { createWorld, HELPER_PACK_FOLDER, installHelperPack } from "./world.ts";
import { listAllWorlds, WORLD_MARKER, writeWorldIcon } from "./worldstore.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function install(): Promise<ClientInstall> {
  const dir = await mkdtemp(join(tmpdir(), "sculkwire-world-"));
  dirs.push(dir);
  return { userComMojang: dir, sharedComMojang: dir } as ClientInstall;
}

describe("test world icon", () => {
  it("writes the world's own icon, and writes it again after the game replaced it", async () => {
    const world = await createWorld(await install(), { name: "icon", helper: false });
    expect(await readFile(join(world.dir, ICON_FILE))).toEqual(worldIcon("sculkwire-icon"));
    await writeFile(join(world.dir, ICON_FILE), "a picture of the world");
    await writeWorldIcon(world);
    expect(await readFile(join(world.dir, ICON_FILE))).toEqual(worldIcon("sculkwire-icon"));
  });
});

describe("helper pack install", () => {
  it("copies only what the game loads into development_behavior_packs", async () => {
    const target = await install();
    const ref = await installHelperPack(target);
    expect(ref).toMatchObject({ kind: "behavior", uuid: expect.any(String) });
    const files = await readdir(join(target.sharedComMojang, "development_behavior_packs", HELPER_PACK_FOLDER), { recursive: true });
    expect(files.sort()).toEqual(["manifest.json", "scripts", join("scripts", "main.js")]);
  });
});

describe("kept and copied test worlds", () => {
  const pack = (uuid: string, version: number[]) => ({ uuid, version, kind: "behavior" as const });

  it("enters an existing world as it is and merges its pack lists", async () => {
    const target = await install();
    const first = await createWorld(target, { name: "keep", helper: false, difficulty: "hard", packs: [pack("project", [1, 0, 0])] });
    await writeFile(join(first.dir, "db", "000001.ldb"), "the player's build");
    await writeFile(
      join(first.dir, "world_behavior_packs.json"),
      JSON.stringify([{ pack_id: "foreign", version: [2, 0, 0] }, { pack_id: "project", version: [1, 0, 0] }]),
    );
    const level = await readFile(join(first.dir, "level.dat"));
    const again = await createWorld(target, { name: "keep", keep: true, helper: false, difficulty: "peaceful", packs: [pack("project", [1, 1, 0])] });
    expect(again).toMatchObject({ levelId: "sculkwire-keep", how: "kept" });
    expect(await readFile(join(again.dir, "level.dat"))).toEqual(level);
    expect(await readFile(join(again.dir, "db", "000001.ldb"), "utf8")).toBe("the player's build");
    expect(JSON.parse(await readFile(join(again.dir, "world_behavior_packs.json"), "utf8"))).toEqual([
      { pack_id: "project", version: [1, 1, 0] },
      { pack_id: "foreign", version: [2, 0, 0] },
    ]);
    expect(JSON.parse(await readFile(join(again.dir, WORLD_MARKER), "utf8"))).toEqual({ keep: true });
    // A launch without keep replaces the world again.
    expect((await createWorld(target, { name: "keep", helper: false })).how).toBe("created");
    await expect(readFile(join(again.dir, "db", "000001.ldb"))).rejects.toThrow();
  });

  it("creates a missing world when asked to keep it, and marks it kept", async () => {
    const target = await install();
    const world = await createWorld(target, { name: "new", keep: true, helper: false });
    expect(world.how).toBe("created");
    expect(JSON.parse(await readFile(join(world.dir, WORLD_MARKER), "utf8"))).toEqual({ keep: true });
    expect((await listAllWorlds(target))[0]).toMatchObject({ name: "sculkwire-new", kept: true });
  });

  it("starts from a copy, and with keep enters the existing copy without copying again", async () => {
    const target = await install();
    const source = await createWorld(target, { name: "source", helper: false });
    await writeFile(join(source.dir, "db", "000001.ldb"), "version 1");
    const copy = await createWorld(target, { name: "copy", copyFrom: "sculkwire-source", helper: false, packs: [pack("project", [1, 0, 0])] });
    expect(copy.how).toBe("copied");
    expect(await readFile(join(copy.dir, "db", "000001.ldb"), "utf8")).toBe("version 1");
    expect(JSON.parse(await readFile(join(copy.dir, WORLD_MARKER), "utf8"))).toEqual({ keep: true, copiedFrom: "sculkwire-source" });
    await writeFile(join(source.dir, "db", "000001.ldb"), "version 2");
    const entered = await createWorld(target, { name: "copy", copyFrom: "sculkwire-source", keep: true, helper: false });
    expect(entered.how).toBe("kept");
    expect(await readFile(join(entered.dir, "db", "000001.ldb"), "utf8")).toBe("version 1");
    expect(JSON.parse(await readFile(join(entered.dir, WORLD_MARKER), "utf8"))).toEqual({ keep: true, copiedFrom: "sculkwire-source" });
  });
});
