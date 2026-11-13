import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { regolithExportFolders } from "../../core/regolith.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { applyPackDeploy, deployFolderName, deployProject, langValue, listDevPacks, packDisplayName, planPackDeploy, readManifestHeader, type DevPackFolder } from "./deploy.ts";

const project = "project";
const comMojang = join("games", "com.mojang");
const bp = join("project", "packs", "BP");
const rp = join("project", "packs", "RP");
const deployedPath = (kind: string, folder: string) => join(comMojang, `development_${kind}_packs`, folder);
const dev = (kind: "behavior" | "resource", folder: string, uuid: string): DevPackFolder => ({ kind, folder, uuid });

describe("pack deploy plan", () => {
  it("deploys a plain project's source packs under source-derived folders", () => {
    const plan = planPackDeploy({
      project,
      comMojang,
      deploy: true,
      deployed: [],
      packs: [
        { kind: "behavior", dir: bp, uuid: "UUID-BP", version: "1.0.0", name: "Demo BP" },
        { kind: "resource", dir: rp, uuid: "UUID-RP", version: "1.0.0" },
      ],
    });
    expect(plan).toEqual([
      {
        kind: "behavior",
        uuid: "UUID-BP",
        version: "1.0.0",
        name: "Demo BP",
        folder: "sculkwire_project_BP",
        path: deployedPath("behavior", "sculkwire_project_BP"),
        copyFrom: bp,
        built: false,
        owned: true,
        remove: [],
        foreign: [],
      },
      {
        kind: "resource",
        uuid: "UUID-RP",
        version: "1.0.0",
        folder: "sculkwire_project_RP",
        path: deployedPath("resource", "sculkwire_project_RP"),
        copyFrom: rp,
        built: false,
        owned: true,
        remove: [],
        foreign: [],
      },
    ]);
  });

  it("deploys its own folder next to a foreign folder with the uuid, matched case-insensitively, and lists it as foreign", () => {
    const plan = planPackDeploy({
      project,
      comMojang,
      deploy: true,
      deployed: [dev("behavior", "MyProject_BP", "uuid-bp")],
      packs: [{ kind: "behavior", dir: bp, uuid: "UUID-BP", version: "1.0.0" }],
    });
    expect(plan[0]).toEqual({
      kind: "behavior",
      uuid: "UUID-BP",
      version: "1.0.0",
      folder: "sculkwire_project_BP",
      path: deployedPath("behavior", "sculkwire_project_BP"),
      copyFrom: bp,
      built: false,
      owned: true,
      remove: [],
      foreign: [deployedPath("behavior", "MyProject_BP")],
    });
  });

  it("only reuses existing deployments when deploy is off", () => {
    const plan = planPackDeploy({
      project,
      comMojang,
      deploy: false,
      deployed: [dev("behavior", "MyProject_BP", "uuid-bp")],
      packs: [
        { kind: "behavior", dir: bp, uuid: "UUID-BP", version: "1.0.0" },
        { kind: "resource", dir: rp, uuid: "UUID-RP", version: "1.0.0" },
      ],
    });
    const [behavior, resource] = plan;
    expect(behavior?.folder).toBe("MyProject_BP");
    expect(resource).toEqual({ kind: "resource", uuid: "UUID-RP", version: "1.0.0", built: false, owned: false, remove: [], foreign: [] });
  });

  it("copies the project's sculkwire folder again even when an earlier session left it there, but leaves other folders", () => {
    const plan = planPackDeploy({
      project,
      comMojang,
      deploy: true,
      deployed: [dev("behavior", "sculkwire_project_BP", "uuid-bp"), dev("resource", "MyProject_RP", "uuid-rp")],
      packs: [
        { kind: "behavior", dir: bp, uuid: "UUID-BP", version: "1.0.0" },
        { kind: "resource", dir: rp, uuid: "UUID-RP", version: "1.0.0" },
      ],
    });
    const [behavior, resource] = plan;
    expect(behavior).toMatchObject({ folder: "sculkwire_project_BP", path: deployedPath("behavior", "sculkwire_project_BP"), copyFrom: bp, owned: true });
    expect(resource).toMatchObject({ folder: "sculkwire_project_RP", copyFrom: rp, owned: true, remove: [], foreign: [deployedPath("resource", "MyProject_RP")] });
  });

  it("copies the project again into its sculkwire folder on reload, even with deploy off, and never writes another folder", () => {
    const plan = planPackDeploy({
      project,
      comMojang,
      deploy: false,
      refresh: true,
      deployed: [dev("behavior", "sculkwire_project_BP", "uuid-bp"), dev("resource", "Echo Wand_rp", "uuid-rp"), dev("resource", "MyProject_RP", "uuid-rp")],
      rglExports: { behavior: [], resource: ["Echo Wand_rp"] },
      packs: [
        { kind: "behavior", dir: bp, uuid: "UUID-BP", version: "1.0.0" },
        { kind: "resource", dir: rp, uuid: "UUID-RP", version: "1.0.0" },
      ],
    });
    const [behavior, resource] = plan;
    expect(behavior).toMatchObject({ folder: "sculkwire_project_BP", copyFrom: bp, owned: true, remove: [], foreign: [] });
    // The folder rgl exported to is the user's: rgl keeps it current, so a reload uses it as it is.
    expect(resource).toMatchObject({ folder: "Echo Wand_rp", owned: false, remove: [], foreign: [deployedPath("resource", "MyProject_RP")] });
    expect(resource?.copyFrom).toBeUndefined();

    // Without a folder of the project, a refresh with deploy on copies into the project's sculkwire folder; with
    // deploy off it uses the foreign folder as it is.
    const foreignOnly = (deploy: boolean) =>
      planPackDeploy({
        project,
        comMojang,
        deploy,
        refresh: true,
        deployed: [dev("behavior", "MyProject_BP", "uuid-bp")],
        packs: [{ kind: "behavior", dir: bp, uuid: "UUID-BP", version: "1.0.0" }],
      })[0];
    expect(foreignOnly(true)).toMatchObject({ folder: "sculkwire_project_BP", copyFrom: bp, owned: true, foreign: [deployedPath("behavior", "MyProject_BP")] });
    expect(foreignOnly(false)).toMatchObject({ folder: "MyProject_BP", owned: false, foreign: [] });
    expect(foreignOnly(false)?.copyFrom).toBeUndefined();
  });

  it("uses the folder rgl exported the built pack to as it is, with deploy on, off and on a reload", () => {
    const exportDir = deployedPath("behavior", "Echo Wand_bp");
    for (const opts of [{ deploy: true }, { deploy: false }, { deploy: false, refresh: true }]) {
      const plan = planPackDeploy({
        project,
        comMojang,
        ...opts,
        deployed: [dev("behavior", "Echo Wand_bp", "uuid-bp"), dev("behavior", "sculkwire_project_BP", "uuid-bp"), dev("behavior", "Someone_BP", "uuid-bp")],
        rglExports: { behavior: ["Echo Wand_bp"], resource: ["Echo Wand_rp"] },
        packs: [{ kind: "behavior", dir: bp, uuid: "UUID-BP", version: "1.0.1", built: exportDir, exported: "Echo Wand_bp", name: "Echo BP" }],
      });
      expect(plan).toEqual([
        {
          kind: "behavior",
          uuid: "UUID-BP",
          version: "1.0.1",
          name: "Echo BP",
          folder: "Echo Wand_bp",
          path: exportDir,
          built: true,
          owned: false,
          remove: [deployedPath("behavior", "sculkwire_project_BP")],
          foreign: [deployedPath("behavior", "Someone_BP")],
        },
      ]);
    }
  });

  it("copies a pack rgl built outside the dev packs into the sculkwire folder, also with deploy off, and never the source dir", () => {
    const builtBP = join("project", "build", "Echo Wand_bp");
    for (const opts of [{ deploy: true }, { deploy: false }, { deploy: false, refresh: true }]) {
      const plan = planPackDeploy({
        project,
        comMojang,
        ...opts,
        deployed: [dev("behavior", "Echo Wand_bp", "uuid-bp"), dev("behavior", "Someone_BP", "uuid-bp")],
        rglExports: { behavior: ["Echo Wand_bp"], resource: [] },
        packs: [{ kind: "behavior", dir: bp, uuid: "UUID-BP", version: "1.0.1", built: builtBP }],
      });
      // An older development export of the project shares the uuid: it is the user's folder, so it is kept and reported.
      expect(plan).toEqual([
        {
          kind: "behavior",
          uuid: "UUID-BP",
          version: "1.0.1",
          folder: "sculkwire_project_BP",
          path: deployedPath("behavior", "sculkwire_project_BP"),
          copyFrom: builtBP,
          built: true,
          owned: true,
          remove: [],
          foreign: [deployedPath("behavior", "Echo Wand_bp"), deployedPath("behavior", "Someone_BP")],
        },
      ]);
    }
  });

  it("reuses the rgl export for an unfiltered pack and removes the project's sculkwire copy", () => {
    const plan = planPackDeploy({
      project,
      comMojang,
      deploy: true,
      deployed: [dev("resource", "sculkwire_project_RP", "uuid-rp"), dev("resource", "Echo Wand_rp", "uuid-rp")],
      rglExports: { behavior: [], resource: ["Echo Wand_rp"] },
      packs: [{ kind: "resource", dir: rp, uuid: "UUID-RP", version: "1.0.0" }],
    });
    expect(plan[0]).toMatchObject({ folder: "Echo Wand_rp", built: false, owned: false, remove: [deployedPath("resource", "sculkwire_project_RP")], foreign: [] });
    expect(plan[0]?.copyFrom).toBeUndefined();
  });

  it("never deletes a second folder rgl exported to: it is reported, like any folder sculkwire did not make", () => {
    const plan = planPackDeploy({
      project,
      comMojang,
      deploy: true,
      deployed: [dev("behavior", "Echo Wand_bp", "uuid-bp"), dev("behavior", "echo_dev_bp", "uuid-bp"), dev("behavior", "sculkwire_project_BP", "uuid-bp")],
      rglExports: { behavior: ["Echo Wand_bp", "echo_dev_bp"], resource: [] },
      packs: [{ kind: "behavior", dir: bp, uuid: "UUID-BP", version: "1.0.0" }],
    });
    expect(plan[0]).toMatchObject({
      folder: "Echo Wand_bp",
      owned: false,
      remove: [deployedPath("behavior", "sculkwire_project_BP")],
      foreign: [deployedPath("behavior", "echo_dev_bp")],
    });
    expect(plan[0]?.copyFrom).toBeUndefined();
  });

  it("names folders after the project and the pack, stable across launches and sanitized", () => {
    expect(deployFolderName(project, bp)).toBe("sculkwire_project_BP");
    expect(deployFolderName(join("addons", "frost wand"), join("addons", "frost wand", "my packs", "Cool Pack"))).toBe("sculkwire_frost_wand_Cool_Pack");
    // Two projects with the same packs/BP layout get different folders.
    expect(deployFolderName("ice-wand", join("ice-wand", "packs", "BP"))).not.toBe(deployFolderName("frost-wand", join("frost-wand", "packs", "BP")));
    // A relative project resolves against the working dir, so "." is named after it.
    expect(deployFolderName(".", join("packs", "BP"))).toBe(deployFolderName(process.cwd(), join(process.cwd(), "packs", "BP")));
  });
});

describe("one uuid, one folder after a deploy", () => {
  async function pack(dir: string, uuid: string, marker: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ format_version: 2, header: { uuid, version: [1, 0, 0] }, modules: [] }));
    await writeFile(join(dir, "marker.txt"), marker);
  }

  it("leaves the folder rgl exported to as rgl wrote it, deletes the stale sculkwire copy, and warns about a foreign pack", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sculk-deploy-"));
    try {
      const root = join(tmp, "echo-wand");
      const uuid = "AAAAAAAA-0000-4000-8000-000000000001";
      const mojang = join(tmp, "com.mojang");
      const bps = join(mojang, "development_behavior_packs");
      const sculkFolder = deployFolderName(root, join(root, "packs", "BP"));
      await pack(join(root, "packs", "BP"), uuid, "filter input");
      await pack(join(bps, "Echo Wand_bp"), uuid, "rgl export");
      await pack(join(bps, sculkFolder), uuid.toLowerCase(), "stale sculkwire copy");
      await pack(join(bps, "Copied By Hand"), uuid, "foreign");
      await pack(join(bps, "Unrelated"), "bbbbbbbb-0000-4000-8000-000000000002", "unrelated");

      // game_launch, then game_reload: the same result both times.
      for (const refresh of [false, true]) {
        const plan = planPackDeploy({
          project: root,
          comMojang: mojang,
          deploy: true,
          refresh,
          deployed: await listDevPacks(mojang),
          rglExports: { behavior: ["Echo Wand_bp"], resource: [] },
          packs: [{ kind: "behavior", dir: join(root, "packs", "BP"), uuid, version: "1.0.0", built: join(bps, "Echo Wand_bp"), exported: "Echo Wand_bp" }],
        });
        const r = await applyPackDeploy(plan);
        expect(await readFile(join(bps, "Echo Wand_bp", "marker.txt"), "utf8")).toBe("rgl export");
        expect((await readdir(bps)).sort()).toEqual(["Copied By Hand", "Echo Wand_bp", "Unrelated"]);
        expect(await readFile(join(bps, "Copied By Hand", "marker.txt"), "utf8")).toBe("foreign");
        expect(r.copied).toEqual([]);
        // The export is the user's folder: game_stop must not remove it.
        expect(r.owned).toEqual([]);
        expect(r.diagnostics).toHaveLength(1);
        expect(r.diagnostics[0]).toMatchObject({ severity: "warning", code: "client.duplicate-pack-uuid", file: join(bps, "Copied By Hand", "manifest.json") });
        expect(r.diagnostics[0]?.message).toContain("development_behavior_packs/Copied By Hand");
        expect(r.diagnostics[0]?.message).toContain("may load that folder instead");
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("deploys to the sculkwire folder when the project has no rgl export, and owns it", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sculk-deploy-"));
    try {
      const root = join(tmp, "plain");
      const src = join(root, "BP");
      const uuid = "cccccccc-0000-4000-8000-000000000003";
      await pack(src, uuid, "source");
      const mojang = join(tmp, "com.mojang");
      await pack(join(mojang, "development_behavior_packs", "Other Project_bp"), uuid, "foreign");
      const plan = planPackDeploy({
        project: root,
        comMojang: mojang,
        deploy: true,
        deployed: await listDevPacks(mojang),
        rglExports: { behavior: ["plain_bp"], resource: [] },
        packs: [{ kind: "behavior", dir: src, uuid, version: "1.0.0" }],
      });
      const r = await applyPackDeploy(plan);
      const target = join(mojang, "development_behavior_packs", deployFolderName(root, src));
      expect(r.owned).toEqual([target]);
      expect(await readFile(join(target, "marker.txt"), "utf8")).toBe("source");
      expect(await readFile(join(mojang, "development_behavior_packs", "Other Project_bp", "marker.txt"), "utf8")).toBe("foreign");
      expect(r.diagnostics.map((d) => d.code)).toEqual(["client.duplicate-pack-uuid"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("copies the project's current packs over a sculkwire folder an earlier session left behind on launch and reload", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sculk-deploy-"));
    try {
      const root = join(tmp, "frost-wand");
      const src = join(root, "packs", "BP");
      const uuid = "dddddddd-0000-4000-8000-000000000004";
      await pack(src, uuid, "edited source");
      const mojang = join(tmp, "com.mojang");
      const bps = join(mojang, "development_behavior_packs");
      const target = join(bps, deployFolderName(root, src));
      // An earlier launch (or a server that restarted) left the project's folder with old content.
      await pack(target, uuid, "old copy");
      await pack(join(bps, "Unrelated"), "eeeeeeee-0000-4000-8000-000000000005", "unrelated");

      const deploy = async (opts: { deploy: boolean; refresh: boolean }) =>
        applyPackDeploy(
          planPackDeploy({ project: root, comMojang: mojang, ...opts, deployed: await listDevPacks(mojang), packs: [{ kind: "behavior", dir: src, uuid, version: "1.0.0" }] }),
        );

      const launch = await deploy({ deploy: true, refresh: false });
      expect(launch.copied).toEqual([target]);
      expect(launch.owned).toEqual([target]);
      expect(await readFile(join(target, "marker.txt"), "utf8")).toBe("edited source");

      // The project changes, then game_reload runs (with deploy off, too): the folder gets the new files.
      await writeFile(join(src, "marker.txt"), "edited again");
      const reload = await deploy({ deploy: false, refresh: true });
      expect(reload.copied).toEqual([target]);
      expect(await readFile(join(target, "marker.txt"), "utf8")).toBe("edited again");
      expect((await readdir(bps)).sort()).toEqual([deployFolderName(root, src), "Unrelated"].sort());
      expect(await readFile(join(bps, "Unrelated", "marker.txt"), "utf8")).toBe("unrelated");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("deploys its own folder next to another project's sculkwire copy of the same uuids and warns about that copy", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sculk-deploy-"));
    try {
      // A copy of good_addon in another folder: same pack uuids, so the earlier session's folders share them.
      const root = join(tmp, "sw-reload-proj");
      const bpSrc = join(root, "BP");
      const rpSrc = join(root, "RP");
      const bpUuid = "11111111-0000-4000-8000-000000000001";
      const rpUuid = "22222222-0000-4000-8000-000000000002";
      await pack(bpSrc, bpUuid, "project v1");
      await pack(rpSrc, rpUuid, "project v1");
      const mojang = join(tmp, "com.mojang");
      const bps = join(mojang, "development_behavior_packs");
      const rps = join(mojang, "development_resource_packs");
      await pack(join(bps, "sculkwire_good_addon_BP"), bpUuid, "other project");
      await pack(join(rps, "sculkwire_good_addon_RP"), rpUuid, "other project");
      const ownBP = join(bps, deployFolderName(root, bpSrc));
      const ownRP = join(rps, deployFolderName(root, rpSrc));

      const deploy = async (refresh: boolean) =>
        applyPackDeploy(
          planPackDeploy({
            project: root,
            comMojang: mojang,
            deploy: true,
            refresh,
            deployed: await listDevPacks(mojang),
            packs: [
              { kind: "behavior", dir: bpSrc, uuid: bpUuid, version: "1.0.0" },
              { kind: "resource", dir: rpSrc, uuid: rpUuid, version: "1.0.0" },
            ],
          }),
        );

      const launch = await deploy(false);
      expect(launch.copied).toEqual([ownBP, ownRP]);
      expect(launch.owned).toEqual([ownBP, ownRP]);
      expect(await readFile(join(ownBP, "marker.txt"), "utf8")).toBe("project v1");
      expect(launch.diagnostics.map((d) => [d.code, d.file])).toEqual([
        ["client.duplicate-pack-uuid", join(bps, "sculkwire_good_addon_BP", "manifest.json")],
        ["client.duplicate-pack-uuid", join(rps, "sculkwire_good_addon_RP", "manifest.json")],
      ]);
      expect(launch.diagnostics[0]?.message).toContain("development_behavior_packs/sculkwire_good_addon_BP");
      expect(launch.diagnostics[0]?.message).toContain("another project");
      expect(launch.diagnostics[0]?.message).toContain("may load that folder instead");

      // game_reload: the edit reaches the project's folder, the other project's copy stays as it was.
      await writeFile(join(bpSrc, "marker.txt"), "project v2");
      const reload = await deploy(true);
      expect(reload.copied).toEqual([ownBP, ownRP]);
      expect(await readFile(join(ownBP, "marker.txt"), "utf8")).toBe("project v2");
      expect(await readFile(join(bps, "sculkwire_good_addon_BP", "marker.txt"), "utf8")).toBe("other project");
      expect(reload.diagnostics).toHaveLength(2);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("deploying a Regolith project whose profile runs filters", () => {
  const uuid = "ffffffff-0000-4000-8000-000000000006";
  const manifest = (version: number[]) => JSON.stringify({ format_version: 2, header: { name: "Echo Wand", uuid, version }, modules: [{ type: "data" }] });

  /** A project with a TypeScript source pack; `built` is where rgl's output goes, linked from `.regolith/tmp/BP` as rgl does. */
  async function project(tmp: string, built?: string): Promise<{ root: string; install: ClientInstall; bps: string }> {
    const root = join(tmp, "echo-wand");
    const src = join(root, "packs", "BP");
    await mkdir(src, { recursive: true });
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({ name: "Echo Wand", packs: { behaviorPack: "./packs/BP" }, regolith: { profiles: { default: { filters: [{ filter: "tsc" }], export: { target: "development" } } } } }),
    );
    await writeFile(join(src, "manifest.json"), manifest([1, 0, 0]));
    await writeFile(join(src, "main.ts"), "// filter input");
    const mojang = join(tmp, "com.mojang");
    const bps = join(mojang, "development_behavior_packs");
    await mkdir(bps, { recursive: true });
    if (built) {
      await mkdir(built, { recursive: true });
      // A filter bumped the version: the world must activate what the game finds in the folder.
      await writeFile(join(built, "manifest.json"), manifest([1, 0, 7]));
      await writeFile(join(built, "main.js"), "// rgl output");
      await mkdir(join(root, ".regolith", "tmp"), { recursive: true });
      await symlink(built, join(root, ".regolith", "tmp", "BP"), process.platform === "win32" ? "junction" : "dir");
    }
    return { root, install: { sharedComMojang: mojang } as ClientInstall, bps };
  }

  it("activates the pack rgl exported into the dev packs in place, by rgl's own manifest, and writes nothing", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sculk-deploy-"));
    try {
      const exported = join(tmp, "com.mojang", "development_behavior_packs", "Echo Wand_bp");
      const { root, install, bps } = await project(tmp, exported);
      for (const refresh of [false, true]) {
        const r = await deployProject(install, root, true, refresh);
        expect(r.packs).toEqual([{ name: "Echo Wand", uuid, kind: "behavior", folder: "Echo Wand_bp", path: join(bps, "Echo Wand_bp"), built: true }]);
        expect(r.refs).toEqual([{ uuid, version: [1, 0, 7], kind: "behavior" }]);
        expect(r.copied).toEqual([]);
        expect(r.owned).toEqual([]);
        expect((await readdir(exported)).sort()).toEqual(["main.js", "manifest.json"]);
        expect(await readdir(bps)).toEqual(["Echo Wand_bp"]);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("copies what rgl built elsewhere (a local export) into the sculkwire folder, again on a reload, and leaves rgl's folder alone", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sculk-deploy-"));
    try {
      const built = join(tmp, "echo-wand", "build", "Echo Wand_bp");
      const { root, install, bps } = await project(tmp, built);
      const target = join(bps, deployFolderName(root, join(root, "packs", "BP")));
      const launch = await deployProject(install, root, true, false);
      expect(launch.packs).toEqual([{ name: "Echo Wand", uuid, kind: "behavior", folder: basename(target), path: target, built: true }]);
      expect(launch.refs).toEqual([{ uuid, version: [1, 0, 7], kind: "behavior" }]);
      expect(launch.owned).toEqual([target]);
      expect((await readdir(target)).sort()).toEqual(["main.js", "manifest.json"]);
      // A pack config.json does not name is not rgl's to build, so it neither fails the deploy nor reaches the game.
      await mkdir(join(root, "examples", "BP"), { recursive: true });
      await writeFile(join(root, "examples", "BP", "manifest.json"), JSON.stringify({ format_version: 2, header: { uuid: "dddddddd-0000-4000-8000-000000000008", version: [1, 0, 0] }, modules: [{ type: "data" }] }));
      expect((await deployProject(install, root, true, false)).packs.map((p) => p.uuid)).toEqual([uuid]);

      // rgl builds again, then game_reload: the copy follows, with deploy off too.
      await writeFile(join(built, "main.js"), "// rgl output 2");
      const reload = await deployProject(install, root, false, true);
      expect(reload.copied).toEqual([target]);
      expect(await readFile(join(target, "main.js"), "utf8")).toBe("// rgl output 2");
      expect((await readdir(built)).sort()).toEqual(["main.js", "manifest.json"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("uses the folder rgl --compat copied its build to in place, and copies again once that folder is out of date", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sculk-deploy-"));
    try {
      // --compat: .regolith/tmp/BP is a real folder, and rgl copied it to the export folder.
      const { root, install, bps } = await project(tmp);
      const built = join(root, ".regolith", "tmp", "BP");
      const exported = join(bps, "Echo Wand_bp");
      for (const dir of [built, exported]) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "manifest.json"), manifest([1, 0, 7]));
        await writeFile(join(dir, "main.js"), "// rgl output");
      }
      const inPlace = await deployProject(install, root, true, false);
      expect(inPlace.packs).toEqual([{ name: "Echo Wand", uuid, kind: "behavior", folder: "Echo Wand_bp", path: exported, built: true }]);
      expect(inPlace.copied).toEqual([]);
      expect(inPlace.diagnostics).toEqual([]);
      expect(await readdir(bps)).toEqual(["Echo Wand_bp"]);

      // Another profile built since (a local export): the dev folder no longer is what rgl last built.
      await writeFile(join(built, "main.js"), "// rgl output of another profile");
      const copied = await deployProject(install, root, true, false);
      const target = join(bps, deployFolderName(root, join(root, "packs", "BP")));
      expect(copied.packs[0]).toMatchObject({ folder: basename(target), built: true });
      expect(await readFile(join(target, "main.js"), "utf8")).toBe("// rgl output of another profile");
      expect(await readFile(join(exported, "main.js"), "utf8")).toBe("// rgl output");
      expect(copied.diagnostics.map((d) => [d.code, d.file])).toEqual([["client.duplicate-pack-uuid", join(exported, "manifest.json")]]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("fails, and changes nothing, when rgl's output lacks a pack or its manifest has no uuid", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sculk-deploy-"));
    try {
      const built = join(tmp, "echo-wand", "build", "Echo Wand_bp");
      const { root, install, bps } = await project(tmp, built);
      // A resource pack config.json names that rgl's output has no pack for.
      const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
      await writeFile(join(root, "config.json"), JSON.stringify({ ...config, packs: { ...config.packs, resourcePack: "./packs/RP" } }));
      await mkdir(join(root, "packs", "RP"), { recursive: true });
      await writeFile(join(root, "packs", "RP", "manifest.json"), JSON.stringify({ format_version: 2, header: { uuid: "eeeeeeee-0000-4000-8000-000000000007", version: [1, 0, 0] }, modules: [{ type: "resources" }] }));
      await expect(deployProject(install, root, true, false)).rejects.toThrow(/no pack for packs\/RP.*rgl run/s);
      await rm(join(root, "packs", "RP"), { recursive: true });
      await writeFile(join(root, "config.json"), JSON.stringify(config));

      await writeFile(join(built, "manifest.json"), JSON.stringify({ format_version: 2, header: { name: "Echo Wand" }, modules: [{ type: "data" }] }));
      await expect(deployProject(install, root, true, false)).rejects.toThrow(/without a behavior or resource pack manifest/);
      expect(await readdir(bps)).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("fails with the step to take when rgl has not built the project, and deploys no source pack", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sculk-deploy-"));
    try {
      const { root, install, bps } = await project(tmp);
      await expect(deployProject(install, root, true, false)).rejects.toThrow(/runs filters.*rgl has not built this project.*rgl run.*sculkwire does not run rgl/s);
      expect(await readdir(bps)).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("deploying a Regolith project whose profile runs no filters", () => {
  it("uses the folder rgl exported to as rgl left it, and warns once the source pack differs from it", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sculk-deploy-"));
    try {
      const root = join(tmp, "echo-wand");
      const src = join(root, "packs", "BP");
      const mojang = join(tmp, "com.mojang");
      const exported = join(mojang, "development_behavior_packs", "Echo Wand_bp");
      const uuid = "99999999-0000-4000-8000-000000000009";
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "config.json"), JSON.stringify({ name: "Echo Wand", packs: { behaviorPack: "./packs/BP" }, regolith: { profiles: { default: { filters: [], export: { target: "development" } } } } }));
      for (const dir of [src, exported]) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "manifest.json"), JSON.stringify({ format_version: 2, header: { name: "Echo Wand", uuid, version: [1, 0, 0] }, modules: [{ type: "data" }] }));
        await writeFile(join(dir, "tick.json"), '{"values":[]}');
      }
      const install = { sharedComMojang: mojang } as ClientInstall;

      const fresh = await deployProject(install, root, true, true);
      expect(fresh.packs).toEqual([{ name: "Echo Wand", uuid, kind: "behavior", folder: "Echo Wand_bp", path: exported, built: false }]);
      expect(fresh.copied).toEqual([]);
      expect(fresh.diagnostics).toEqual([]);

      // The source is edited and rgl has not run since: the game still loads rgl's folder, and the result says so.
      await writeFile(join(src, "tick.json"), '{"values":["a"]}');
      const stale = await deployProject(install, root, true, true);
      expect(stale.copied).toEqual([]);
      expect(await readFile(join(exported, "tick.json"), "utf8")).toBe('{"values":[]}');
      expect(stale.diagnostics).toHaveLength(1);
      expect(stale.diagnostics[0]).toMatchObject({ severity: "warning", code: "client.rgl-export-differs", file: join(root, "config.json") });
      expect(stale.diagnostics[0]?.message).toContain("development_behavior_packs/Echo Wand_bp");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("rgl export folders", () => {
  it("names development exports <name>_bp/_rp, reads literal bpName and exact dev paths", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sculk-rglexp-"));
    try {
      await writeFile(
        join(tmp, "config.json"),
        JSON.stringify({
          name: "Echo Wand",
          regolith: {
            profiles: {
              default: { filters: [], export: { target: "development" } },
              named: { filters: [], export: { target: "development", bpName: "'echo_dev_bp'", rpName: "project.name + '_x'" } },
              exact: { filters: [], export: { target: "exact", bpPath: "/games/com.mojang/development_behavior_packs/EW", rpPath: "/elsewhere/RP" } },
            },
          },
        }),
      );
      expect(await regolithExportFolders(tmp)).toEqual({ behavior: ["Echo Wand_bp", "echo_dev_bp", "EW"], resource: ["Echo Wand_rp"] });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("manifest header", () => {
  it("reads uuid and version with JSON comments and an array version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sculk-deploy-"));
    try {
      const pack = join(dir, "BP");
      await mkdir(pack, { recursive: true });
      await writeFile(
        join(pack, "manifest.json"),
        '{\n  // header comes first\n  "format_version": 2,\n  "header": { "uuid": "abc-123", "version": [1, 2, 3], "name": "Built" }\n}\n',
      );
      await expect(readManifestHeader(pack)).resolves.toEqual({ uuid: "abc-123", version: "1.2.3", name: "Built" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when there is no manifest header", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sculk-deploy-"));
    try {
      await expect(readManifestHeader(dir)).resolves.toBeUndefined();
      await writeFile(join(dir, "manifest.json"), '{"header": {"uuid": "abc"}}');
      await expect(readManifestHeader(dir)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("pack display name", () => {
  it("reads a lang value, skipping comments and stripping trailing ones", () => {
    const text = "\uFEFF## header\npack.description=Ignored\npack.name=Frost Wand Behavior Pack\t#\n";
    expect(langValue(text, "pack.name")).toBe("Frost Wand Behavior Pack");
    expect(langValue(text, "pack.missing")).toBeUndefined();
  });

  it("resolves a lang-key manifest name from the built dir first, then the source dir, else keeps the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sculk-deploy-"));
    try {
      const source = join(dir, "packs", "BP");
      const built = join(dir, "build", "BP");
      await mkdir(join(source, "texts"), { recursive: true });
      await mkdir(join(built, "texts"), { recursive: true });
      await writeFile(join(source, "texts", "en_US.lang"), "pack.name=Source Name\n");
      await expect(packDisplayName("pack.name", [undefined, source])).resolves.toBe("Source Name");
      await writeFile(join(built, "texts", "en_US.lang"), "pack.name=Built Name\n");
      await expect(packDisplayName("pack.name", [built, source])).resolves.toBe("Built Name");
      await expect(packDisplayName("pack.title", [built, source])).resolves.toBe("pack.title");
      await expect(packDisplayName("pack.name", [join(dir, "nowhere")])).resolves.toBe("pack.name");
      // A plain name is shown as it is, even when a lang file happens to hold it as a key.
      await expect(packDisplayName("Frost Wand", [built])).resolves.toBe("Frost Wand");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
