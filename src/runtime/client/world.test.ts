import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ICON_FILE, worldIcon } from "./icon.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { createWorld, HELPER_PACK_FOLDER, installHelperPack, writeWorldIcon } from "./world.ts";

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
