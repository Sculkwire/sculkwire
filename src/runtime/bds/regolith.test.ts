import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RGL_NOT_BUILT } from "../../core/regolith.ts";
import { entriesToDiagnostics, parseConsole } from "../gamelog/logparse.ts";
import { bdsCheck } from "./check.ts";
import { runGameTests } from "./gametest.ts";
import type { BdsInstall } from "./install.ts";
import { createInstance, dirLinkType } from "./instance.ts";
import { disposeRun, indexProject, projectPacks } from "./project.ts";
import { followRegolithOutput } from "./session.ts";

const BP_MANIFEST = {
  format_version: 2,
  header: { name: "Echo Wand BP", uuid: "11111111-0000-4000-8000-000000000001", version: [1, 0, 0], min_engine_version: [1, 21, 0] },
  modules: [{ type: "script", language: "javascript", uuid: "11111111-0000-4000-8000-000000000002", version: [1, 0, 0], entry: "scripts/main.js" }],
};
const RP_MANIFEST = {
  format_version: 2,
  header: { name: "Echo Wand RP", uuid: "22222222-0000-4000-8000-000000000001", version: [1, 0, 0], min_engine_version: [1, 21, 0] },
  modules: [{ type: "resources", uuid: "22222222-0000-4000-8000-000000000002", version: [1, 0, 0] }],
};
const ENTITY = `{
  "format_version": "1.21.0",
  "minecraft:entity": {
    "description": { "identifier": "echo:wand_mob", "is_spawnable": true }
  }
}
`;
const MAIN_TS = `import { world } from "@minecraft/server";
const label: string = "echo";
world.afterEvents.itemUse.subscribe(() => {
  throw new Error(label);
});
`;
const LIB_TS = `export const y: number = 1;
throw new Error("lib");
`;

let tmp: string;

async function regolithProject(name: string, opts: { filters?: boolean; dataPath?: string } = {}): Promise<string> {
  const root = join(tmp, name);
  await mkdir(join(root, "packs", "BP", "entities"), { recursive: true });
  await mkdir(join(root, "packs", "RP"), { recursive: true });
  const data = opts.dataPath ?? "data";
  await mkdir(join(root, data, "scripts"), { recursive: true });
  const filters = opts.filters === false ? [] : [{ filter: "typescript" }];
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      name: "Echo Wand",
      packs: { behaviorPack: "./packs/BP", resourcePack: "./packs/RP" },
      regolith: { dataPath: `./${data}`, filterDefinitions: {}, profiles: { default: { filters, export: { target: "development" } } } },
    }),
  );
  await writeFile(join(root, "packs", "BP", "manifest.json"), JSON.stringify(BP_MANIFEST));
  await writeFile(join(root, "packs", "RP", "manifest.json"), JSON.stringify(RP_MANIFEST));
  await writeFile(join(root, "packs", "BP", "entities", "wand_mob.json"), ENTITY);
  await writeFile(join(root, data, "scripts", "main.ts"), MAIN_TS);
  await writeFile(join(root, data, "scripts", "lib.ts"), LIB_TS);
  return root;
}

/**
 * What `rgl run` leaves behind in normal mode: the packs exported into a development packs folder outside the
 * project, filters applied there (main.ts compiled into scripts/main.js with a source map relative to where the
 * filter saw it, lib.js mapped by absolute path, extra.js without a map, a line added to the entity), and
 * `.regolith/tmp/BP` / `RP` linking to them. Returns the export folders.
 */
async function rglBuilt(root: string, suffix = ""): Promise<{ bp: string; rp: string }> {
  const name = relative(tmp, root);
  const bp = join(tmp, "com.mojang", "development_behavior_packs", `${name}_bp${suffix}`);
  const rp = join(tmp, "com.mojang", "development_resource_packs", `${name}_rp${suffix}`);
  await mkdir(join(bp, "scripts"), { recursive: true });
  await mkdir(join(bp, "entities"), { recursive: true });
  await mkdir(rp, { recursive: true });
  await writeFile(join(bp, "manifest.json"), JSON.stringify(BP_MANIFEST));
  await writeFile(join(rp, "manifest.json"), JSON.stringify(RP_MANIFEST));
  await writeFile(join(bp, "entities", "wand_mob.json"), "// added by a filter\n" + ENTITY);
  await writeFile(join(bp, "scripts", "main.js"), "// generated\n" + MAIN_TS.replace(/: string/g, "") + "//# sourceMappingURL=main.js.map\n");
  await writeFile(
    join(bp, "scripts", "main.js.map"),
    JSON.stringify({ version: 3, file: "main.js", sources: ["../../data/scripts/main.ts"], names: [], mappings: ";AAAA;AACA;AACA;AACA" }),
  );
  const libMap = { version: 3, file: "lib.js", sources: [join(root, ".regolith", "tmp", "data", "scripts", "lib.ts")], names: [], mappings: "AAAA;AACA" };
  await writeFile(
    join(bp, "scripts", "lib.js"),
    `export const y = 1;\nthrow new Error("lib");\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(libMap)).toString("base64")}\n`,
  );
  await writeFile(join(bp, "scripts", "extra.js"), "export const x = 1;\nthrow new Error('extra');\n");
  await linkOutput(root, bp, rp);
  return { bp: await realpath(bp), rp: await realpath(rp) };
}

/** Point `.regolith/tmp/BP` and `RP` at `bp` and `rp`, as rgl does on every run. */
async function linkOutput(root: string, bp: string, rp: string): Promise<void> {
  const out = join(root, ".regolith", "tmp");
  await mkdir(out, { recursive: true });
  for (const [name, target] of [
    ["BP", bp],
    ["RP", rp],
  ] as const) {
    await rm(join(out, name), { force: true });
    await symlink(target, join(out, name), dirLinkType(process.platform));
  }
}

/** Every file below `dir` with its text, to prove a folder was left exactly as it was. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[relative(dir, path)] = await readFile(path, "utf8");
  }
  return out;
}

describe("Regolith projects on BDS", () => {
  beforeAll(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), "sculk-bds-rgl-")));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("loads what rgl last built for a filtered profile, not the source packs", async () => {
    const root = await regolithProject("built");
    const out = await rglBuilt(root);
    const project = await projectPacks(root);
    expect(project.failure).toBeUndefined();
    expect(project.build?.profile).toBe("default");
    const bp = project.loadable.find((p) => p.kind === "behavior")!;
    const rp = project.loadable.find((p) => p.kind === "resource")!;
    expect([bp.dir, rp.dir]).toEqual([out.bp, out.rp]);
    expect([bp.relDir, rp.relDir]).toEqual(["packs/BP", "packs/RP"]);
    expect(project.build?.sources.get(bp.dir)?.dir).toBe(join(root, "packs", "BP"));
    expect(project.build?.sources.get(rp.dir)?.dir).toBe(join(root, "packs", "RP"));
    expect(bp.uuid).toBe(BP_MANIFEST.header.uuid);
  });

  it("leaves out a pack config.json does not name instead of asking rgl for it", async () => {
    const root = await regolithProject("extra");
    await rglBuilt(root);
    await mkdir(join(root, "examples", "BP"), { recursive: true });
    await writeFile(join(root, "examples", "BP", "manifest.json"), JSON.stringify({ ...BP_MANIFEST, header: { ...BP_MANIFEST.header, uuid: "33333333-0000-4000-8000-000000000001" } }));
    const project = await projectPacks(root);
    expect(project.failure).toBeUndefined();
    expect(project.loadable.map((p) => p.relDir).sort()).toEqual(["packs/BP", "packs/RP"]);
    expect(project.skipped).toEqual([expect.objectContaining({ severity: "warning", code: "bds.pack-not-loaded", file: "examples/BP/manifest.json" })]);
  });

  it("maps server errors in rgl's output back to the files the user edits", async () => {
    const root = await regolithProject("mapped");
    const out = await rglBuilt(root);
    const project = await projectPacks(root);
    const indexed = await indexProject(project, project.loadable.map((pack, i) => ({ pack, folder: `${i}_${pack.kind}` })));
    const entries = parseConsole([
      "[2026-11-07 17:05:35:898 ERROR] [Scripting] [Echo Wand BP] Error: echo    at <anonymous> (main.js:5:9)",
      "",
      "[2026-11-07 17:05:35:899 ERROR] [Scripting] [Echo Wand BP] Error: lib    at <anonymous> (lib.js:2:1)",
      "",
      "[2026-11-07 17:05:35:900 ERROR] [Entity] entities/wand_mob.json | echo:wand_mob | is_spawnable is not valid here",
      "",
      "[2026-11-07 17:05:35:901 ERROR] [Scripting] [Echo Wand BP] Error: extra    at <anonymous> (extra.js:2)",
    ]);
    const ds = entriesToDiagnostics(entries, indexed);
    // main.js line 5 is main.ts line 4 through the source map, which is relative to .regolith/tmp/BP/scripts.
    expect(ds.find((d) => d.message.includes("Error: echo"))).toMatchObject({ file: "data/scripts/main.ts", range: { start: { line: 4, column: 9 } } });
    // An absolute source below .regolith/tmp/data is the project's data folder.
    expect(ds.find((d) => d.message.includes("Error: lib"))).toMatchObject({ file: "data/scripts/lib.ts", range: { start: { line: 2 } } });
    // The filter added a line to the entity: the source file and its own line, not the built one.
    const entity = ds.find((d) => d.message.includes("is_spawnable"));
    expect(entity?.file).toBe("packs/BP/entities/wand_mob.json");
    expect(entity?.range?.start.line).toBe(4);
    // A generated file without a source map points at rgl's output and says so.
    const extra = ds.find((d) => d.message.includes("Error: extra"));
    expect(extra?.file).toBe(join(out.bp, "scripts", "extra.js"));
    expect(extra?.range?.start.line).toBe(2);
    expect(extra?.message).toContain("rgl output with no source map");
  });

  it("maps a source the filter saw below .regolith/tmp/data to the project's data folder (regolith.dataPath)", async () => {
    const root = await regolithProject("datapath", { dataPath: "assets/data" });
    await rglBuilt(root);
    const project = await projectPacks(root);
    const indexed = await indexProject(project, project.loadable.map((pack, i) => ({ pack, folder: `${i}_${pack.kind}` })));
    const ds = entriesToDiagnostics(
      parseConsole([
        "[2026-11-07 17:05:35:898 ERROR] [Scripting] [Echo Wand BP] Error: echo    at <anonymous> (main.js:5:9)",
        "",
        "[2026-11-07 17:05:35:899 ERROR] [Scripting] [Echo Wand BP] Error: lib    at <anonymous> (lib.js:2:1)",
      ]),
      indexed,
    );
    expect(ds.find((d) => d.message.includes("Error: echo"))).toMatchObject({ file: "assets/data/scripts/main.ts", range: { start: { line: 4 } } });
    expect(ds.find((d) => d.message.includes("Error: lib"))).toMatchObject({ file: "assets/data/scripts/lib.ts", range: { start: { line: 2 } } });
  });

  it("reports a filtered profile rgl has not built as regolith.not-built and starts no server", async () => {
    const root = await regolithProject("unbuilt");
    const project = await projectPacks(root);
    expect(project.loadable).toEqual([]);
    expect(project.build).toBeUndefined();
    expect(project.failure).toEqual({ severity: "error", code: "regolith.not-built", message: RGL_NOT_BUILT, source: "bds", file: "config.json" });

    // No BDS install is passed or resolved: a started server would fail here instead of returning.
    const check = await bdsCheck(root);
    expect(check.status).toBe("not-built");
    expect(check.serverVersion).toBeUndefined();
    expect(check.rawLogPath).toBeUndefined();
    expect(check.exitCode).toBe(1);
    expect(check.diagnostics.map((d) => d.code)).toEqual(["regolith.not-built"]);

    const tests = await runGameTests(root);
    expect(tests.exitCode).toBe(1);
    expect(tests.total).toBe(0);
    expect(tests.serverVersion).toBeUndefined();
    expect(tests.diagnostics.map((d) => d.code)).toEqual(["regolith.not-built"]);
  });

  it("reports a source pack rgl's output has no pack for as regolith.not-built", async () => {
    const root = await regolithProject("half");
    const { bp } = await rglBuilt(root);
    await rm(join(root, ".regolith", "tmp", "RP"));
    const project = await projectPacks(root);
    expect(project.loadable).toEqual([]);
    expect(project.failure).toMatchObject({ severity: "error", code: "regolith.not-built", file: "config.json" });
    expect(project.failure?.message).toContain("packs/RP");
    expect(existsSync(join(bp, "manifest.json"))).toBe(true);
  });

  it("loads the source packs of a profile without filters, even when rgl left output behind", async () => {
    const root = await regolithProject("plain", { filters: false });
    await rglBuilt(root);
    const project = await projectPacks(root);
    expect(project.build).toBeUndefined();
    expect(project.failure).toBeUndefined();
    expect(project.loadable.map((p) => p.dir).sort()).toEqual([join(root, "packs", "BP"), join(root, "packs", "RP")]);
  });

  describe("instances", () => {
    let savedData: string | undefined;
    let install: BdsInstall;

    beforeEach(async () => {
      savedData = process.env.SCULKWIRE_DATA;
      const data = await mkdtemp(join(tmp, "data-"));
      process.env.SCULKWIRE_DATA = data;
      const server = join(data, "server");
      await mkdir(join(server, "behavior_packs"), { recursive: true });
      await writeFile(join(server, "server.properties"), "server-name=Dedicated Server\nserver-port=19132\n");
      await writeFile(join(server, "bedrock_server"), "");
      install = { channel: "stable", version: "1.0.0", dir: server };
    });
    afterEach(() => {
      if (savedData === undefined) delete process.env.SCULKWIRE_DATA;
      else process.env.SCULKWIRE_DATA = savedData;
    });

    for (const keep of [false, true]) {
      it(`leaves rgl's output as it was after a run${keep ? " with keep" : ""}`, async () => {
        const root = await regolithProject(`left-${keep}`);
        const out = await rglBuilt(root);
        const before = { bp: await snapshot(out.bp), rp: await snapshot(out.rp) };
        const project = await projectPacks(root);
        for (const packMode of ["symlink", "copy"] as const) {
          const instance = await createInstance({ install, noWorld: true, packs: project.loadable, packMode });
          await disposeRun(instance, keep);
        }
        expect({ bp: await snapshot(out.bp), rp: await snapshot(out.rp) }).toEqual(before);
        expect((await lstat(join(root, ".regolith", "tmp", "BP"))).isSymbolicLink()).toBe(true);
        expect(await realpath(join(root, ".regolith", "tmp", "BP"))).toBe(out.bp);
      });
    }

    it("points a session's world at rgl's new output before a reload, and keeps it when the output is gone", async () => {
      const root = await regolithProject("session");
      const first = await rglBuilt(root);
      const project = await projectPacks(root);
      const instance = await createInstance({ install, noWorld: true, packs: project.loadable, packMode: "symlink" });
      try {
        const session = { projectRoot: root, project, packMode: "symlink" as const, instance, indexed: await indexProject(project, instance.packs) };
        const worldBp = instance.packs.find((p) => p.pack.kind === "behavior")!.worldPath;
        const worldRp = instance.packs.find((p) => p.pack.kind === "resource")!.worldPath;

        // rgl watch rewrote the output in place: the links stay.
        await followRegolithOutput(session);
        expect(await realpath(worldBp)).toBe(first.bp);

        // Another profile exported elsewhere: the world follows, the old output is left alone.
        const second = await rglBuilt(root, "_other");
        await followRegolithOutput(session);
        expect(await realpath(worldBp)).toBe(second.bp);
        expect(await realpath(worldRp)).toBe(second.rp);
        expect(session.instance.packs.find((p) => p.pack.kind === "behavior")?.pack.dir).toBe(second.bp);
        expect(session.indexed.find((p) => p.pack.kind === "behavior")?.pack.dir).toBe(second.bp);
        expect(existsSync(join(first.bp, "scripts", "main.js"))).toBe(true);

        // rgl's output is gone: the reload fails and the session keeps what it loaded.
        await rm(join(root, ".regolith"), { recursive: true });
        await expect(followRegolithOutput(session)).rejects.toThrow(/regolith\.not-built/);
        expect(await realpath(worldBp)).toBe(second.bp);
        expect(session.project.build?.sources.get(second.bp)?.dir).toBe(join(root, "packs", "BP"));
      } finally {
        await disposeRun(instance, false);
      }
    });
  });
});
