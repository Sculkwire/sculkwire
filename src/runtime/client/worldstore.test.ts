/** The world store on temporary folders: listing, worlds by pack, removal of stale sculkwire worlds and deletion. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { TAG, writeLevelDat, type NbtCompound } from "../../gamefiles/nbt.ts";
import { deleteWorld, listAllWorlds, pruneWorlds, WORLD_MARKER, WorldRefused, worldsWithPacks } from "./worldstore.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function install(): Promise<ClientInstall> {
  const dir = await mkdtemp(join(tmpdir(), "sculkwire-worldstore-"));
  dirs.push(dir);
  return { label: "fake", userComMojang: dir, sharedComMojang: dir } as ClientInstall;
}

const DAY_S = 86_400;
const NOW = new Date("2026-11-12T12:00:00Z");
const nowS = NOW.getTime() / 1000;

/** A world folder as the game leaves it: level.dat, levelname.txt and a db file. */
async function world(
  target: ClientInstall,
  levelId: string,
  name: string,
  opts: { lastPlayed?: number; root?: NbtCompound; marker?: object; storageVersion?: number; rootName?: string } = {},
): Promise<string> {
  const dir = join(target.userComMojang, "minecraftWorlds", levelId);
  await mkdir(join(dir, "db"), { recursive: true });
  const root: NbtCompound = opts.root ?? new Map();
  root.set("LevelName", { type: TAG.String, value: name });
  if (opts.lastPlayed !== undefined) root.set("LastPlayed", { type: TAG.Long, value: BigInt(opts.lastPlayed) });
  await writeFile(join(dir, "level.dat"), writeLevelDat({ storageVersion: opts.storageVersion ?? 10, rootName: opts.rootName ?? "", root }));
  await writeFile(join(dir, "levelname.txt"), name);
  await writeFile(join(dir, "db", "000001.ldb"), `chunks of ${name}`);
  if (opts.marker) await writeFile(join(dir, WORLD_MARKER), JSON.stringify(opts.marker));
  return dir;
}

async function folders(target: ClientInstall): Promise<string[]> {
  return (await readdir(join(target.userComMojang, "minecraftWorlds"))).sort();
}

/** Every file of a folder with its sha256, to prove a folder was not written. */
async function hashes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path.slice(dir.length)] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  return out;
}

describe("listAllWorlds", () => {
  it("lists test worlds and the user's own, with the kept marker, LastPlayed and size, and skips unreadable ones", async () => {
    const target = await install();
    const root: NbtCompound = new Map([["GameType", { type: TAG.Int, value: 0 }]]);
    await world(target, "AbCdEf==", "My Base", { lastPlayed: nowS - 10 * DAY_S, root });
    await world(target, "sculkwire-bridge", "sculkwire-bridge", { lastPlayed: nowS - DAY_S });
    await world(target, "sculkwire-kept", "sculkwire-kept", { lastPlayed: nowS - 2 * DAY_S, marker: { keep: true, copiedFrom: "My Base" } });
    await mkdir(join(target.userComMojang, "minecraftWorlds", "broken"), { recursive: true });
    await writeFile(join(target.userComMojang, "minecraftWorlds", "broken", "levelname.txt"), "Broken");
    const worlds = await listAllWorlds(target);
    expect(worlds.map((w) => [w.levelId, w.name, w.sculkwire, w.kept])).toEqual([
      ["sculkwire-bridge", "sculkwire-bridge", true, false],
      ["sculkwire-kept", "sculkwire-kept", true, true],
      ["AbCdEf==", "My Base", false, false],
    ]);
    const base = worlds.find((w) => w.name === "My Base");
    expect(base?.lastPlayed).toEqual(new Date((nowS - 10 * DAY_S) * 1000));
    expect(base?.gameMode).toBe("survival");
    expect(base?.sizeBytes).toBeGreaterThan("chunks of My Base".length);
    expect(worlds.find((w) => w.kept)?.copiedFrom).toBe("My Base");
  });
});

describe("pruneWorlds", () => {
  it("removes only stale, unkept sculkwire worlds and never an excepted one", async () => {
    const target = await install();
    await world(target, "sculkwire-old", "sculkwire-old", { lastPlayed: nowS - 4 * DAY_S });
    await world(target, "sculkwire-fresh", "sculkwire-fresh", { lastPlayed: nowS - 2 * DAY_S });
    await world(target, "sculkwire-kept", "sculkwire-kept", { lastPlayed: nowS - 30 * DAY_S, marker: { keep: true } });
    await world(target, "sculkwire-copied", "sculkwire-copied", { lastPlayed: nowS - 30 * DAY_S, marker: { keep: true, copiedFrom: "My Base" } });
    await world(target, "sculkwire-launching", "sculkwire-launching", { lastPlayed: nowS - 30 * DAY_S });
    await world(target, "sculkwire-chosen", "sculkwire-chosen", { lastPlayed: nowS - 30 * DAY_S });
    await world(target, "Zz9==", "Old Survival", { lastPlayed: nowS - 300 * DAY_S });
    // A level name with the prefix in a foreign folder, and a prefixed folder holding a renamed world.
    await world(target, "Yy8==", "sculkwire-impostor", { lastPlayed: nowS - 300 * DAY_S });
    await world(target, "sculkwire-renamed", "Renamed By The User", { lastPlayed: nowS - 300 * DAY_S });
    expect(await pruneWorlds(target, { except: ["sculkwire-launching", "sculkwire-chosen"], now: NOW })).toEqual(["sculkwire-old"]);
    expect(await folders(target)).toEqual(["Yy8==", "Zz9==", "sculkwire-chosen", "sculkwire-copied", "sculkwire-fresh", "sculkwire-kept", "sculkwire-launching", "sculkwire-renamed"]);
  });
});

describe("deleteWorld", () => {
  it("deletes a sculkwire world by name with or without the prefix and reports a missing one", async () => {
    const target = await install();
    await world(target, "sculkwire-a", "sculkwire-a");
    await world(target, "sculkwire-b", "sculkwire-b");
    expect(await deleteWorld(target, "a")).toEqual({ world: "sculkwire-a", existed: true, levelIds: ["sculkwire-a"] });
    expect(await deleteWorld(target, "sculkwire-b")).toEqual({ world: "sculkwire-b", existed: true, levelIds: ["sculkwire-b"] });
    expect(await deleteWorld(target, "a")).toEqual({ world: "sculkwire-a", existed: false, levelIds: [] });
    expect(await folders(target)).toEqual([]);
  });

  it("refuses the user's worlds, worlds that are only half sculkwire's, and the loaded world", async () => {
    const target = await install();
    await world(target, "AbC==", "My Base");
    await world(target, "Yy8==", "sculkwire-impostor");
    await world(target, "sculkwire-renamed", "Renamed");
    await world(target, "sculkwire-bridge", "sculkwire-bridge");
    await expect(deleteWorld(target, "My Base")).rejects.toThrow(/one of your own worlds/);
    await expect(deleteWorld(target, "impostor")).rejects.toThrow(WorldRefused);
    await expect(deleteWorld(target, "renamed")).rejects.toThrow(/is not a sculkwire-\* world/);
    await expect(deleteWorld(target, "bridge", { loaded: "sculkwire-bridge" })).rejects.toThrow(/loaded by the running game/);
    expect(await folders(target)).toEqual(["AbC==", "Yy8==", "sculkwire-bridge", "sculkwire-renamed"]);
  });
});

describe("worldsWithPacks", () => {
  const packs = async (dir: string, kind: "behavior" | "resource", ids: string[]) =>
    writeFile(join(dir, `world_${kind}_packs.json`), JSON.stringify(ids.map((pack_id) => ({ pack_id, version: [1, 0, 0] }))));

  it("finds the user's worlds whose pack lists name a project pack, played last first, and reads only", async () => {
    const target = await install();
    const base = await world(target, "AbC==", "My Base", { lastPlayed: nowS - 2 * DAY_S });
    const lab = await world(target, "DeF==", "Redstone Lab", { lastPlayed: nowS - DAY_S });
    const other = await world(target, "GhI==", "Survival", { lastPlayed: nowS });
    const test = await world(target, "sculkwire-bridge", "sculkwire-bridge", { lastPlayed: nowS });
    await packs(base, "behavior", ["foreign", "project-bp"]);
    await packs(lab, "resource", ["project-rp"]);
    await packs(other, "behavior", ["foreign"]);
    await packs(test, "behavior", ["project-bp"]);
    const before = await hashes(join(target.userComMojang, "minecraftWorlds"));
    expect((await worldsWithPacks(target, ["project-bp", "project-rp"])).map((w) => w.name)).toEqual(["Redstone Lab", "My Base"]);
    expect((await worldsWithPacks(target, ["project-bp"])).map((w) => w.name)).toEqual(["My Base"]);
    expect(await worldsWithPacks(target, ["nothing"])).toEqual([]);
    expect(await worldsWithPacks(target, [])).toEqual([]);
    expect(await hashes(join(target.userComMojang, "minecraftWorlds"))).toEqual(before);
  });
});
