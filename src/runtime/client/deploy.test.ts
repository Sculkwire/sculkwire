import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { regolithExportFolders } from "../../validate/regolith.ts";
import { applyPackDeploy, deployFolderName, langValue, listDevPacks, packDisplayName, planPackDeploy, readManifestHeader, type DevPackFolder } from "./deploy.ts";

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

  it("reuses a pack already deployed under another folder, matching the uuid case-insensitively", () => {
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
      folder: "MyProject_BP",
      path: deployedPath("behavior", "MyProject_BP"),
      built: false,
      owned: false,
      remove: [],
      foreign: [],
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

  it("copies a pack again on redeploy when the existing folder is sculkwire's own copy, but leaves other folders", () => {
    const plan = planPackDeploy({
      project,
      comMojang,
      deploy: true,
      deployed: [dev("behavior", "sculkwire_project_BP", "uuid-bp"), dev("resource", "MyProject_RP", "uuid-rp")],
      own: new Set(["sculkwire_project_BP"]),
      packs: [
        { kind: "behavior", dir: bp, uuid: "UUID-BP", version: "1.0.0" },
        { kind: "resource", dir: rp, uuid: "UUID-RP", version: "1.0.0" },
      ],
    });
    const [behavior, resource] = plan;
    expect(behavior).toMatchObject({ folder: "sculkwire_project_BP", path: deployedPath("behavior", "sculkwire_project_BP"), copyFrom: bp, owned: true });
    expect(resource).toEqual({
      kind: "resource",
      uuid: "UUID-RP",
      version: "1.0.0",
      folder: "MyProject_RP",
      path: deployedPath("resource", "MyProject_RP"),
      built: false,
      owned: false,
      remove: [],
      foreign: [],
    });
  });

  it("deploys the Regolith build output under the source pack's folder and lists a foreign folder with the uuid", () => {
    const builtBP = join("tmp", "sculk-rgl-abc", "out", "BP");
    const builtRP = join("tmp", "sculk-rgl-abc", "out", "RP");
    const plan = planPackDeploy({
      project,
      comMojang,
      deploy: false,
      deployed: [dev("behavior", "Regolith_BP", "uuid-bp"), dev("resource", "Regolith_RP", "uuid-rp")],
      packs: [
        { kind: "behavior", dir: bp, uuid: "UUID-BP", version: "1.0.1", built: builtBP, name: "Built BP" },
        { kind: "resource", dir: rp, uuid: "UUID-RP", version: "1.0.1", built: builtRP },
      ],
    });
    expect(plan).toEqual([
      {
        kind: "behavior",
        uuid: "UUID-BP",
        version: "1.0.1",
        name: "Built BP",
        folder: "sculkwire_project_BP",
        path: deployedPath("behavior", "sculkwire_project_BP"),
        copyFrom: builtBP,
        built: true,
        owned: true,
        remove: [],
        foreign: [deployedPath("behavior", "Regolith_BP")],
      },
      {
        kind: "resource",
        uuid: "UUID-RP",
        version: "1.0.1",
        folder: "sculkwire_project_RP",
        path: deployedPath("resource", "sculkwire_project_RP"),
        copyFrom: builtRP,
        built: true,
        owned: true,
        remove: [],
        foreign: [deployedPath("resource", "Regolith_RP")],
      },
    ]);
  });

  it("copies a build into the project's rgl export folder instead of a second copy, and removes the stale sculkwire copy", () => {
    const builtBP = join("tmp", "out", "BP");
    const plan = planPackDeploy({
      project,
      comMojang,
      deploy: true,
      deployed: [dev("behavior", "Echo Wand_bp", "uuid-bp"), dev("behavior", "sculkwire_project_BP", "uuid-bp"), dev("behavior", "Someone_BP", "uuid-bp")],
      rglExports: { behavior: ["Echo Wand_bp"], resource: ["Echo Wand_rp"] },
      packs: [{ kind: "behavior", dir: bp, uuid: "UUID-BP", version: "1.0.0", built: builtBP }],
    });
    expect(plan[0]).toMatchObject({
      folder: "Echo Wand_bp",
      copyFrom: builtBP,
      built: true,
      owned: false,
      remove: [deployedPath("behavior", "sculkwire_project_BP")],
      foreign: [deployedPath("behavior", "Someone_BP")],
    });
  });

  it("reuses the rgl export for an unbuilt pack and removes the project's sculkwire copy", () => {
    const plan = planPackDeploy({
      project,
      comMojang,
      deploy: true,
      deployed: [dev("resource", "sculkwire_project_RP", "uuid-rp"), dev("resource", "Echo Wand_rp", "uuid-rp")],
      rglExports: { behavior: [], resource: ["Echo Wand_rp"] },
      packs: [{ kind: "resource", dir: rp, uuid: "UUID-RP", version: "1.0.0" }],
    });
    expect(plan[0]).toMatchObject({ folder: "Echo Wand_rp", owned: false, remove: [deployedPath("resource", "sculkwire_project_RP")], foreign: [] });
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

  it("refreshes the rgl export, deletes the stale sculkwire copy, and warns about a foreign pack without touching it", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sculk-deploy-"));
    try {
      const root = join(tmp, "echo-wand");
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, "config.json"),
        JSON.stringify({ name: "Echo Wand", packs: { behaviorPack: "./packs/BP" }, regolith: { profiles: { default: { filters: [{ filter: "x" }], export: { target: "development" } } } } }),
      );
      const uuid = "AAAAAAAA-0000-4000-8000-000000000001";
      const mojang = join(tmp, "com.mojang");
      const bps = join(mojang, "development_behavior_packs");
      const sculkFolder = deployFolderName(root, join(root, "packs", "BP"));
      await pack(join(bps, "Echo Wand_bp"), uuid, "old rgl export");
      await pack(join(bps, sculkFolder), uuid.toLowerCase(), "stale sculkwire copy");
      await pack(join(bps, "Copied By Hand"), uuid, "foreign");
      await pack(join(bps, "Unrelated"), "bbbbbbbb-0000-4000-8000-000000000002", "unrelated");
      const built = join(tmp, "out", "BP");
      await pack(built, uuid, "fresh build");

      const deploy = async () => {
        const plan = planPackDeploy({
          project: root,
          comMojang: mojang,
          deploy: true,
          deployed: await listDevPacks(mojang),
          rglExports: await regolithExportFolders(root),
          packs: [{ kind: "behavior", dir: join(root, "packs", "BP"), uuid, version: "1.0.0", built }],
        });
        return applyPackDeploy(plan);
      };
      const first = await deploy();
      expect(await readFile(join(bps, "Echo Wand_bp", "marker.txt"), "utf8")).toBe("fresh build");
      expect((await readdir(bps)).sort()).toEqual(["Copied By Hand", "Echo Wand_bp", "Unrelated"]);
      expect(await readFile(join(bps, "Copied By Hand", "marker.txt"), "utf8")).toBe("foreign");
      expect(first.copied).toEqual([join(bps, "Echo Wand_bp")]);
      // The export is the user's folder: game_stop must not remove it.
      expect(first.owned).toEqual([]);
      expect(first.diagnostics).toHaveLength(1);
      expect(first.diagnostics[0]).toMatchObject({ severity: "warning", code: "client.duplicate-pack-uuid", file: join(bps, "Copied By Hand", "manifest.json") });
      expect(first.diagnostics[0]?.message).toContain("development_behavior_packs/Copied By Hand");
      expect(first.diagnostics[0]?.message).toContain("may load it instead");

      // A reload follows the same rule: still one project folder for the uuid.
      await cp(join(bps, "Echo Wand_bp"), join(bps, sculkFolder), { recursive: true });
      const second = await deploy();
      expect((await readdir(bps)).sort()).toEqual(["Copied By Hand", "Echo Wand_bp", "Unrelated"]);
      expect(second.diagnostics.map((d) => d.file)).toEqual([join(bps, "Copied By Hand", "manifest.json")]);
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
        packs: [{ kind: "behavior", dir: src, uuid, version: "1.0.0", built: src }],
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
