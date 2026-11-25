/** The saved dev world: chosen by name or level id per game user, forgotten again, and never a test world. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { TAG, writeLevelDat } from "../../gamefiles/nbt.ts";
import { readDevWorld, useDevWorld } from "./devworld.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function install(): Promise<ClientInstall> {
  const dir = await mkdtemp(join(tmpdir(), "sculkwire-devworld-"));
  dirs.push(dir);
  return { label: "fake", userComMojang: join(dir, "user"), sharedComMojang: join(dir, "shared") } as ClientInstall;
}

async function world(target: ClientInstall, levelId: string, name: string): Promise<void> {
  const dir = join(target.userComMojang, "minecraftWorlds", levelId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "level.dat"), writeLevelDat({ storageVersion: 10, rootName: "", root: new Map([["LevelName", { type: TAG.String, value: name }]]) }));
  await writeFile(join(dir, "levelname.txt"), name);
}

describe("default dev world", () => {
  it("saves a world by name, reads it back by level id, keeps other config sections, and forgets it", async () => {
    const target = await install();
    const config = join(target.sharedComMojang, "..", "config.json");
    await writeFile(config, JSON.stringify({ update: { channel: "main" } }));
    await world(target, "AbCd=", "Steve's Base");
    expect(await useDevWorld(target, "Steve's Base", config)).toEqual({ levelId: "AbCd=", name: "Steve's Base" });
    expect(await readDevWorld(target, config)).toEqual({ levelId: "AbCd=", name: "Steve's Base" });
    const saved = JSON.parse(await readFile(config, "utf8"));
    expect(saved.update).toEqual({ channel: "main" });
    expect(saved.devWorlds).toEqual({ [target.userComMojang]: { levelId: "AbCd=", name: "Steve's Base" } });
    // Another game user has no dev world.
    expect(await readDevWorld({ userComMojang: "/elsewhere" }, config)).toBeUndefined();
    expect(await useDevWorld(target, undefined, config)).toBeUndefined();
    expect(await readDevWorld(target, config)).toBeUndefined();
    expect(JSON.parse(await readFile(config, "utf8")).update).toEqual({ channel: "main" });
  });

  it("refuses a name several worlds share and a missing world, and takes a sculkwire- world the user names", async () => {
    const target = await install();
    const config = join(target.sharedComMojang, "..", "config.json");
    await world(target, "one", "Twins");
    await world(target, "two", "Twins");
    await world(target, "sculkwire-bridge", "sculkwire-bridge");
    await expect(useDevWorld(target, "Twins", config)).rejects.toThrow('2 worlds are named "Twins"; pass the level id of one');
    expect(await useDevWorld(target, "two", config)).toEqual({ levelId: "two", name: "Twins" });
    await expect(useDevWorld(target, "Nowhere", config)).rejects.toThrow('no world named or with level id "Nowhere"');
    expect(await readDevWorld(target, config)).toEqual({ levelId: "two", name: "Twins" });
    expect(await useDevWorld(target, "sculkwire-bridge", config)).toEqual({ levelId: "sculkwire-bridge", name: "sculkwire-bridge" });
  });
});
