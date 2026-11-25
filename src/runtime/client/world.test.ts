import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ICON_FILE, worldIcon } from "./icon.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { createWorld, enterUserWorld, HELPER_PACK_FOLDER, installHelperPack, restoreUserIcon, WORLD_BACKUPS_KEPT } from "./world.ts";
import { listAllWorlds, pruneWorlds, WORLD_MARKER, writeWorldIcon } from "./worldstore.ts";
import { readLevelDat, TAG, writeLevelDat, type NbtCompound } from "../../gamefiles/nbt.ts";

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

describe("the user's dev world", () => {
  const pack = (uuid: string, version: number[], kind: "behavior" | "resource" = "behavior") => ({ uuid, version, kind });

  /** One of the user's own worlds as the game leaves it: cheats off, a build, a foreign pack, its own icon. */
  async function userWorld(target: ClientInstall, opts: { icon?: boolean; lastPlayed?: number } = {}): Promise<string> {
    const dir = join(target.userComMojang, "minecraftWorlds", "Xy+z=");
    await mkdir(join(dir, "db"), { recursive: true });
    const root: NbtCompound = new Map();
    root.set("LevelName", { type: TAG.String, value: "Steve's Base" });
    root.set("cheatsEnabled", { type: TAG.Byte, value: 0 });
    root.set("commandsEnabled", { type: TAG.Byte, value: 0 });
    root.set("Difficulty", { type: TAG.Int, value: 3 });
    root.set("MultiplayerGame", { type: TAG.Byte, value: 1 });
    if (opts.lastPlayed !== undefined) root.set("LastPlayed", { type: TAG.Long, value: BigInt(opts.lastPlayed) });
    await writeFile(join(dir, "level.dat"), writeLevelDat({ storageVersion: 10, rootName: "", root }));
    await writeFile(join(dir, "levelname.txt"), "Steve's Base");
    await writeFile(join(dir, "db", "000001.ldb"), "the player's build");
    await writeFile(join(dir, "world_behavior_packs.json"), JSON.stringify([{ pack_id: "foreign", version: [2, 0, 0] }]));
    if (opts.icon !== false) await writeFile(join(dir, ICON_FILE), "the user's picture");
    return dir;
  }

  const level = async (file: string) => readLevelDat(new Uint8Array(await readFile(file))).root;

  it("backs up, merges the packs without dropping others, turns cheats on with a note, and never replaces the world", async () => {
    const target = await install();
    const dir = await userWorld(target);
    const backups = join(target.userComMojang, "backups");
    const { world, notes } = await enterUserWorld(target, {
      world: "Steve's Base",
      helper: false,
      packs: [pack("project-bp", [1, 0, 0]), pack("project-rp", [1, 0, 0], "resource")],
      backupRoot: backups,
      now: new Date("2026-11-25T10:00:00.000Z"),
    });
    const backup = join(backups, "Xy+z=", "2026-11-25T10-00-00.000Z");
    expect(world).toEqual({ levelId: "Xy+z=", name: "Steve's Base", dir, how: "user", backup });
    expect((await readdir(backup)).sort()).toEqual([ICON_FILE, "level.dat", "world_behavior_packs.json"].sort());
    expect(await readFile(join(backup, ICON_FILE), "utf8")).toBe("the user's picture");
    expect((await level(join(backup, "level.dat"))).get("cheatsEnabled")?.value).toBe(0);
    expect(notes).toEqual(["turned cheats on in Steve's Base (sculkwire's commands need them); the game awards no achievements in it from now on"]);
    const root = await level(join(dir, "level.dat"));
    expect([root.get("cheatsEnabled")?.value, root.get("commandsEnabled")?.value]).toEqual([1, 1]);
    // Only the cheats flags change: the difficulty and multiplayer stay as the user had them, no experiment is added.
    expect([root.get("Difficulty")?.value, root.get("MultiplayerGame")?.value, root.has("experiments")]).toEqual([3, 1, false]);
    expect(await readFile(join(dir, "db", "000001.ldb"), "utf8")).toBe("the player's build");
    expect(JSON.parse(await readFile(join(dir, "world_behavior_packs.json"), "utf8"))).toEqual([
      { pack_id: "project-bp", version: [1, 0, 0] },
      { pack_id: "foreign", version: [2, 0, 0] },
    ]);
    expect(JSON.parse(await readFile(join(dir, "world_resource_packs.json"), "utf8"))).toEqual([{ pack_id: "project-rp", version: [1, 0, 0] }]);
    expect(await readFile(join(dir, ICON_FILE))).toEqual(worldIcon("Xy+z="));
    // A user's world never gets the test world marker, and is not listed as sculkwire's.
    expect(await readdir(dir)).not.toContain(WORLD_MARKER);
    expect((await listAllWorlds(target)).find((w) => w.levelId === "Xy+z=")?.sculkwire).toBe(false);
    // The next launch finds cheats on already: no note, level.dat untouched.
    const before = await readFile(join(dir, "level.dat"));
    const again = await enterUserWorld(target, { world: "Xy+z=", helper: false, backupRoot: backups, now: new Date("2026-11-25T11:00:00.000Z") });
    expect(again.notes).toEqual([]);
    expect(await readFile(join(dir, "level.dat"))).toEqual(before);
  });

  it("turns Beta APIs on and sets the difficulty only when asked, saying both", async () => {
    const target = await install();
    const dir = await userWorld(target);
    const { notes } = await enterUserWorld(target, { world: "Steve's Base", helper: false, betaApis: true, difficulty: "peaceful", backupRoot: join(target.userComMojang, "b") });
    expect(notes.slice(1)).toEqual([
      "turned the Beta APIs experiment on in Steve's Base; an experiment stays on in a world for good",
      "set the difficulty of Steve's Base to peaceful",
    ]);
    const root = await level(join(dir, "level.dat"));
    expect(root.get("Difficulty")?.value).toBe(0);
    expect((root.get("experiments")?.value as NbtCompound).get("gametest")?.value).toBe(1);
  });

  it(`keeps the newest ${WORLD_BACKUPS_KEPT} backups of a world`, async () => {
    const target = await install();
    await userWorld(target);
    const backups = join(target.userComMojang, "backups");
    for (let i = 0; i < WORLD_BACKUPS_KEPT + 2; i++) {
      await enterUserWorld(target, { world: "Xy+z=", helper: false, backupRoot: backups, now: new Date(Date.UTC(2026, 10, 25, 10, i)) });
    }
    const kept = (await readdir(join(backups, "Xy+z="))).sort();
    expect(kept).toHaveLength(WORLD_BACKUPS_KEPT);
    expect(kept[0]).toBe("2026-11-25T10-02-00.000Z");
  });

  it("refuses a sculkwire test world and a name several worlds share", async () => {
    const target = await install();
    await userWorld(target);
    await createWorld(target, { name: "bridge", helper: false });
    const twin = join(target.userComMojang, "minecraftWorlds", "twin");
    await mkdir(twin, { recursive: true });
    await writeFile(join(twin, "level.dat"), await readFile(join(target.userComMojang, "minecraftWorlds", "Xy+z=", "level.dat")));
    await writeFile(join(twin, "levelname.txt"), "Steve's Base");
    const backupRoot = join(target.userComMojang, "b");
    await expect(enterUserWorld(target, { world: "sculkwire-bridge", helper: false, backupRoot })).rejects.toThrow("is a sculkwire test world");
    await expect(enterUserWorld(target, { world: "Steve's Base", helper: false, backupRoot })).rejects.toThrow('2 worlds are named "Steve\'s Base"');
  });

  it("gives the world its own icon back unless the game took a new picture, and removes sculkwire's when it had none", async () => {
    const target = await install();
    const dir = await userWorld(target);
    const backupRoot = join(target.userComMojang, "b");
    const first = await enterUserWorld(target, { world: "Xy+z=", helper: false, backupRoot, now: new Date("2026-11-25T10:00:00Z") });
    expect(await restoreUserIcon(first.world)).toBe("restored");
    expect(await readFile(join(dir, ICON_FILE), "utf8")).toBe("the user's picture");
    const second = await enterUserWorld(target, { world: "Xy+z=", helper: false, backupRoot, now: new Date("2026-11-25T11:00:00Z") });
    await writeFile(join(dir, ICON_FILE), "a picture the game took on Save & Quit");
    expect(await restoreUserIcon(second.world)).toBe("game's own");
    expect(await readFile(join(dir, ICON_FILE), "utf8")).toBe("a picture the game took on Save & Quit");
    await rm(join(dir, ICON_FILE));
    const third = await enterUserWorld(target, { world: "Xy+z=", helper: false, backupRoot, now: new Date("2026-11-25T12:00:00Z") });
    expect(await restoreUserIcon(third.world)).toBe("removed");
    expect(await readdir(dir)).not.toContain(ICON_FILE);
  });

  it("is never pruned, however long ago it was played", async () => {
    const target = await install();
    const dir = await userWorld(target, { lastPlayed: 1 });
    await enterUserWorld(target, { world: "Xy+z=", helper: false, backupRoot: join(target.userComMojang, "b") });
    expect(await pruneWorlds(target, { now: new Date("2030-01-01T00:00:00Z") })).toEqual([]);
    expect(await readFile(join(dir, "db", "000001.ldb"), "utf8")).toBe("the player's build");
  });
});
