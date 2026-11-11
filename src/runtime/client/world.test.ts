import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ICON_FILE, worldIcon } from "./icon.ts";
import type { ClientInstall } from "./install.ts";
import { createWorld, writeWorldIcon } from "./world.ts";

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
