/** The world store on temporary folders: listing, removal of stale test worlds, deletion and copies of a user's world. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { readLevelDat, TAG, writeLevelDat, type NbtCompound, type NbtTag } from "../../gamefiles/nbt.ts";
import { ICON_FILE, worldIcon } from "./icon.ts";
import { copyWorld, deleteWorld, listAllWorlds, pruneWorlds, WORLD_MARKER, WorldRefused } from "./worldstore.ts";

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
  it("removes only stale, unkept sculkwire worlds and never the excepted one", async () => {
    const target = await install();
    await world(target, "sculkwire-old", "sculkwire-old", { lastPlayed: nowS - 4 * DAY_S });
    await world(target, "sculkwire-fresh", "sculkwire-fresh", { lastPlayed: nowS - 2 * DAY_S });
    await world(target, "sculkwire-kept", "sculkwire-kept", { lastPlayed: nowS - 30 * DAY_S, marker: { keep: true } });
    await world(target, "sculkwire-launching", "sculkwire-launching", { lastPlayed: nowS - 30 * DAY_S });
    await world(target, "Zz9==", "Old Survival", { lastPlayed: nowS - 300 * DAY_S });
    // A level name with the prefix in a foreign folder, and a prefixed folder holding a renamed world.
    await world(target, "Yy8==", "sculkwire-impostor", { lastPlayed: nowS - 300 * DAY_S });
    await world(target, "sculkwire-renamed", "Renamed By The User", { lastPlayed: nowS - 300 * DAY_S });
    expect(await pruneWorlds(target, { except: "sculkwire-launching", now: NOW })).toEqual(["sculkwire-old"]);
    expect(await folders(target)).toEqual(["Yy8==", "Zz9==", "sculkwire-fresh", "sculkwire-kept", "sculkwire-launching", "sculkwire-renamed"]);
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

describe("copyWorld", () => {
  function sourceRoot(): NbtCompound {
    const tags: [string, NbtTag][] = [
      ["GameType", { type: TAG.Int, value: 0 }],
      ["RandomSeed", { type: TAG.Long, value: 123456789n }],
      ["MultiplayerGame", { type: TAG.Byte, value: 1 }],
      ["MultiplayerGameIntent", { type: TAG.Byte, value: 1 }],
      ["LANBroadcast", { type: TAG.Byte, value: 1 }],
      ["LANBroadcastIntent", { type: TAG.Byte, value: 1 }],
      ["XBLBroadcastIntent", { type: TAG.Int, value: 3 }],
      ["PlatformBroadcastIntent", { type: TAG.Int, value: 3 }],
      ["commandsEnabled", { type: TAG.Byte, value: 0 }],
      ["cheatsEnabled", { type: TAG.Byte, value: 0 }],
      ["rainLevel", { type: TAG.Float, value: 0.5 }],
      ["experiments", { type: TAG.Compound, value: new Map([["gametest", { type: TAG.Byte, value: 1 }]]) }],
      ["lastOpenedWithVersion", { type: TAG.List, value: { elementType: TAG.Int, items: [1, 21, 0].map((v) => ({ type: TAG.Int, value: v })) } }],
    ];
    return new Map(tags);
  }

  it("copies a user's world without writing it and makes the copy a single-player test world with cheats", async () => {
    const target = await install();
    const source = await world(target, "AbC==", "My Base", { lastPlayed: nowS - DAY_S, root: sourceRoot(), storageVersion: 9, rootName: "root" });
    await writeFile(join(source, "level.dat_old"), await readFile(join(source, "level.dat")));
    const before = await hashes(source);
    const copy = await copyWorld(target, { from: "My Base", name: "base" });
    expect(copy).toEqual({ levelId: "sculkwire-base", name: "sculkwire-base", dir: join(target.userComMojang, "minecraftWorlds", "sculkwire-base") });
    expect(await hashes(source)).toEqual(before);
    expect(await readFile(join(copy.dir, "levelname.txt"), "utf8")).toBe("sculkwire-base");
    expect(await readFile(join(copy.dir, "db", "000001.ldb"), "utf8")).toBe("chunks of My Base");
    expect(await readFile(join(copy.dir, ICON_FILE))).toEqual(worldIcon("sculkwire-base"));
    expect(JSON.parse(await readFile(join(copy.dir, WORLD_MARKER), "utf8"))).toEqual({ keep: true, copiedFrom: "My Base" });
    const original = readLevelDat(new Uint8Array(await readFile(join(source, "level.dat"))));
    for (const file of ["level.dat", "level.dat_old"]) {
      const level = readLevelDat(new Uint8Array(await readFile(join(copy.dir, file))));
      expect([level.storageVersion, level.rootName]).toEqual([9, "root"]);
      const changed = {
        LevelName: "sculkwire-base",
        MultiplayerGame: 0,
        MultiplayerGameIntent: 0,
        LANBroadcast: 0,
        LANBroadcastIntent: 0,
        XBLBroadcastIntent: 0,
        PlatformBroadcastIntent: 0,
        commandsEnabled: 1,
        cheatsEnabled: 1,
      };
      for (const [key, value] of Object.entries(changed)) expect(level.root.get(key)?.value, key).toBe(value);
      const rest = (root: NbtCompound) => [...root].filter(([key]) => !(key in changed));
      expect(rest(level.root)).toEqual(rest(original.root));
    }
    expect((await listAllWorlds(target)).find((w) => w.levelId === "sculkwire-base")?.kept).toBe(true);
  });

  it("takes a level id, and lists the level ids of an ambiguous name", async () => {
    const target = await install();
    await world(target, "One==", "Survival", { lastPlayed: nowS - DAY_S });
    await world(target, "Two==", "Survival", { lastPlayed: nowS - 2 * DAY_S });
    await expect(copyWorld(target, { from: "Survival", name: "s" })).rejects.toThrow(/2 worlds are named "Survival".*One==.*Two==/);
    await copyWorld(target, { from: "Two==", name: "s" });
    expect(await readFile(join(target.userComMojang, "minecraftWorlds", "sculkwire-s", "db", "000001.ldb"), "utf8")).toBe("chunks of Survival");
    await expect(copyWorld(target, { from: "Nowhere", name: "s" })).rejects.toThrow(/no world named or with level id "Nowhere"/);
  });

  it("refuses a source over the size limit and says how large it is", async () => {
    const target = await install();
    await world(target, "Big==", "Big World");
    await expect(copyWorld(target, { from: "Big World", name: "big", limitBytes: 8 })).rejects.toThrow(/Big World is 0\.0 GiB; sculkwire copies worlds up to 0\.0 GiB/);
    expect(await folders(target)).toEqual(["Big=="]);
  });
});
