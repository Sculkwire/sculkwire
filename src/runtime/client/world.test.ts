import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLevelDat, TAG, writeLevelDat } from "../bds/nbt.ts";
import { ICON_FILE, worldIcon } from "./icon.ts";
import type { ClientInstall } from "./install.ts";
import { createWorld, markPlayedLast, writeWorldIcon } from "./world.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function install(): Promise<ClientInstall> {
  const dir = await mkdtemp(join(tmpdir(), "sculkwire-world-"));
  dirs.push(dir);
  return { userComMojang: dir, sharedComMojang: dir } as ClientInstall;
}

const lastPlayed = async (dir: string) => readLevelDat(new Uint8Array(await readFile(join(dir, "level.dat")))).root.get("LastPlayed")?.value;

describe("test world icon and play order", () => {
  it("writes the world's own icon, and writes it again after the game replaced it", async () => {
    const world = await createWorld(await install(), { name: "icon", helper: false });
    expect(await readFile(join(world.dir, ICON_FILE))).toEqual(worldIcon("sculkwire-icon"));
    await writeFile(join(world.dir, ICON_FILE), "a picture of the world");
    await writeWorldIcon(world);
    expect(await readFile(join(world.dir, ICON_FILE))).toEqual(worldIcon("sculkwire-icon"));
  });

  it("makes a sculkwire world the most recently played, never a loaded or foreign one", async () => {
    const world = await createWorld(await install(), { name: "decoy", helper: false });
    const file = join(world.dir, "level.dat");
    const level = readLevelDat(new Uint8Array(await readFile(file)));
    level.root.set("LastPlayed", { type: TAG.Long, value: 1n });
    await writeFile(file, writeLevelDat(level));
    const before = BigInt(Math.floor(Date.now() / 1000));
    await markPlayedLast(world, "sculkwire-bench");
    expect((await lastPlayed(world.dir)) as bigint).toBeGreaterThanOrEqual(before);
    await expect(markPlayedLast(world, world.levelId)).rejects.toThrow(/loaded/);
    await expect(markPlayedLast({ ...world, name: "My World", levelId: "abc" }, undefined)).rejects.toThrow(/non-sculkwire/);
  });
});
