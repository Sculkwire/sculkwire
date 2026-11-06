import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBrarchive } from "./brarchive.ts";
import { appxToGameVersion, inspectBuild } from "./detect.ts";
import { extractPack, findPack, listVanillaPacks } from "./extract.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(path: string, data: string | Buffer): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, data);
}

/** Fake game dir: exe placeholder, manifest, two versioned packs with loose files and archives. */
function fakeGame(): string {
  const root = mkdtempSync(join(tmpdir(), "sculk-gamefiles-"));
  dirs.push(root);
  writeFileSync(join(root, "Minecraft.Windows.exe"), "MZ");
  writeFileSync(
    join(root, "appxmanifest.xml"),
    '<Package><Identity Name="Microsoft.MinecraftUWP" Publisher="CN=x" Version="1.21.12001.0" /></Package>',
  );
  const bp = join(root, "data", "behavior_packs");
  write(join(bp, "vanilla_1.21.0", "manifest.json"), "{}");
  write(join(bp, "vanilla_1.21.0", "sounds", "loose.ogg"), "real audio");
  write(
    join(bp, "vanilla_1.21.0", "__brarchive", "entities.brarchive"),
    buildBrarchive([{ name: "breeze.json", data: Buffer.from('{"format_version":"1.21.0"}') }]),
  );
  write(
    join(bp, "vanilla_1.21.0", "__brarchive", "sounds.brarchive"),
    buildBrarchive([
      { name: "loose.ogg", data: new Uint8Array(0) },
      { name: "packed.ogg", data: Buffer.from("packed") },
    ]),
  );
  write(join(bp, "vanilla_1.21.0", "__brarchive", "textures", "entity.brarchive"), buildBrarchive([{ name: "a.png", data: Buffer.from("png") }]));
  write(join(bp, "vanilla_1.21.0", "__brarchive", "broken.brarchive"), Buffer.from("encrypted bytes, no magic"));
  write(join(bp, "vanilla_1.20.10", "manifest.json"), "{}");
  write(join(bp, "vanilla_1.20.2", "manifest.json"), "{}");
  write(join(bp, "vanilla", "manifest.json"), "{}");
  write(join(bp, "editor", "manifest.json"), "{}");
  return root;
}

describe("gamefiles detect + extract", () => {
  it("unpacks the appx patch*100+revision version", () => {
    expect(appxToGameVersion("1.21.12001.0")).toBe("1.21.120.1");
    expect(appxToGameVersion("1.20.8002.0")).toBe("1.20.80.2");
    expect(appxToGameVersion("garbage")).toBeUndefined();
  });

  it("lists versioned vanilla packs in version order", () => {
    const build = inspectBuild(fakeGame())!;
    expect(build.version).toBe("1.21.120.1");
    expect(build.key).toBe("1.21.120.1");
    expect(Object.keys(build).sort()).toEqual(["appxVersion", "key", "packRoots", "packageName", "root", "version"]);
    expect(listVanillaPacks(build).map((p) => p.name)).toEqual(["vanilla_1.20.2", "vanilla_1.20.10", "vanilla_1.21.0"]);
  });

  it("merges archives into their directories, keeps loose files over placeholders, reports undecodable archives", async () => {
    const root = fakeGame();
    const build = inspectBuild(root)!;
    const out = join(root, "out");
    const r = await extractPack(build, findPack(build, "vanilla_1.21.0", "behavior")!, { out });
    expect(readFileSync(join(out, "entities", "breeze.json"), "utf8")).toBe('{"format_version":"1.21.0"}');
    expect(readFileSync(join(out, "sounds", "loose.ogg"), "utf8")).toBe("real audio");
    expect(readFileSync(join(out, "sounds", "packed.ogg"), "utf8")).toBe("packed");
    expect(readFileSync(join(out, "textures", "entity", "a.png"), "utf8")).toBe("png");
    expect(existsSync(join(out, "__brarchive"))).toBe(false);
    expect(r).toMatchObject({ looseFiles: 2, archives: 4, archiveEntries: 4, placeholders: 1, emptyEntries: 0, cached: false });
    expect(r.failures).toEqual([expect.objectContaining({ archive: "__brarchive/broken.brarchive", reason: "not-brarchive" })]);

    const again = await extractPack(build, findPack(build, "vanilla_1.21.0")!, { out });
    expect(again.cached).toBe(true);
  });

  it("refuses to overwrite a non-empty directory it did not create", async () => {
    const root = fakeGame();
    const build = inspectBuild(root)!;
    const out = join(root, "mine");
    write(join(out, "keep.txt"), "user data");
    await expect(extractPack(build, findPack(build, "vanilla")!, { out })).rejects.toThrow(/refusing/);
    expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("user data");
  });
});
