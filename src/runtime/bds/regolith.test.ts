import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bdsCheck } from "./check.ts";
import { indexProject, projectPacks } from "./project.ts";
import { runGameTests } from "./gametest.ts";
import { entriesToDiagnostics, parseConsole } from "../gamelog/logparse.ts";
import { writeFakeRgl } from "../../testing/fakergl.ts";

/**
 * Stand-in for rgl: copies packs/BP and packs/RP to the `exact` export paths sculkwire writes into the config,
 * then plays the filters: compiles data/scripts/main.ts into scripts/main.js (one header line, then the source,
 * with a source map), writes scripts/extra.js without a map, and rewrites the entity file (a filter that changed
 * it). With data/FAIL present it exits 1 like a failing filter.
 */
const FAKE_RGL = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(process.env.FAKE_RGL_LOG), process.cwd() + "\\n");
if (fs.existsSync("data/FAIL")) {
  console.error("[ERROR] filter typescript failed: data/scripts/main.ts(2,7): error TS2322: Type 'string' is not assignable");
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
const exp = config.regolith.profiles[process.argv[3]].export;
fs.cpSync("packs/BP", exp.bpPath, { recursive: true });
fs.cpSync("packs/RP", exp.rpPath, { recursive: true });
const ts = fs.readFileSync("data/scripts/main.ts", "utf8").replace(/: string/g, "");
fs.mkdirSync(path.join(exp.bpPath, "scripts"), { recursive: true });
fs.writeFileSync(path.join(exp.bpPath, "scripts", "main.js"), "// generated\\n" + ts + "//# sourceMappingURL=main.js.map\\n");
fs.writeFileSync(
  path.join(exp.bpPath, "scripts", "main.js.map"),
  JSON.stringify({ version: 3, file: "main.js", sources: ["../../../../data/scripts/main.ts"], names: [], mappings: ";AAAA;AACA;AACA;AACA" }),
);
fs.writeFileSync(path.join(exp.bpPath, "scripts", "extra.js"), "export const x = 1;\\nthrow new Error('extra');\\n");
const entity = path.join(exp.bpPath, "entities", "wand_mob.json");
fs.writeFileSync(entity, "// added by a filter\\n" + fs.readFileSync(entity, "utf8"));
`;

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

let tmp: string;
let rgl: string;
let rglLog: string;

async function regolithProject(name: string, opts: { filters?: boolean; fail?: boolean } = {}): Promise<string> {
  const root = join(tmp, name);
  await mkdir(join(root, "packs", "BP", "entities"), { recursive: true });
  await mkdir(join(root, "packs", "RP"), { recursive: true });
  await mkdir(join(root, "data", "scripts"), { recursive: true });
  const filters = opts.filters === false ? [] : [{ filter: "typescript" }];
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      name: "Echo Wand",
      packs: { behaviorPack: "./packs/BP", resourcePack: "./packs/RP" },
      regolith: { dataPath: "./data", filterDefinitions: {}, profiles: { default: { filters, export: { target: "development" } } } },
    }),
  );
  await writeFile(join(root, "packs", "BP", "manifest.json"), JSON.stringify(BP_MANIFEST));
  await writeFile(join(root, "packs", "RP", "manifest.json"), JSON.stringify(RP_MANIFEST));
  await writeFile(join(root, "packs", "BP", "entities", "wand_mob.json"), ENTITY);
  await writeFile(join(root, "data", "scripts", "main.ts"), MAIN_TS);
  if (opts.fail) await writeFile(join(root, "data", "FAIL"), "");
  return root;
}

async function rglRuns(): Promise<number> {
  return existsSync(rglLog) ? (await readFile(rglLog, "utf8")).split("\n").filter(Boolean).length : 0;
}

describe("Regolith projects on BDS", () => {
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sculk-bds-rgl-"));
    rglLog = join(tmp, "rgl.log");
    rgl = writeFakeRgl(tmp, FAKE_RGL);
    process.env.FAKE_RGL_LOG = rglLog;
  });
  afterAll(async () => {
    delete process.env.FAKE_RGL_LOG;
    await rm(tmp, { recursive: true, force: true });
  });

  it("builds a filtered profile with rgl first and loads the built packs, not the source packs", async () => {
    const root = await regolithProject("built");
    const before = await rglRuns();
    const project = await projectPacks(root, { rglPath: rgl });
    try {
      expect(await rglRuns()).toBe(before + 1);
      expect(project.failure).toBeUndefined();
      expect(project.build?.profile).toBe("default");
      expect(project.loadable.map((p) => p.relDir).sort()).toEqual(["packs/BP", "packs/RP"]);
      for (const p of project.loadable) {
        expect(p.dir.startsWith(project.build!.workDir)).toBe(true);
        expect(project.build?.sources.get(p.dir)?.dir).toBe(resolve(root, p.relDir));
      }
      const bp = project.loadable.find((p) => p.kind === "behavior")!;
      // The filter output is what BDS gets; the source pack has no scripts at all.
      expect(existsSync(join(bp.dir, "scripts", "main.js"))).toBe(true);
      expect(existsSync(join(root, "packs", "BP", "scripts"))).toBe(false);
      expect(bp.uuid).toBe(BP_MANIFEST.header.uuid);
    } finally {
      await rm(project.build!.workDir, { recursive: true, force: true });
    }
  });

  it("maps server errors in built files back to the files the user edits", async () => {
    const root = await regolithProject("mapped");
    const project = await projectPacks(root, { rglPath: rgl });
    try {
      const indexed = await indexProject(project, project.loadable.map((pack, i) => ({ pack, folder: `${i}_${pack.kind}` })));
      const entries = parseConsole([
        "[2026-11-07 17:05:35:898 ERROR] [Scripting] [Echo Wand BP] Error: echo    at <anonymous> (main.js:5:9)",
        "",
        "[2026-11-07 17:05:35:900 ERROR] [Entity] entities/wand_mob.json | echo:wand_mob | is_spawnable is not valid here",
        "",
        "[2026-11-07 17:05:35:901 ERROR] [Scripting] [Echo Wand BP] Error: extra    at <anonymous> (extra.js:2)",
      ]);
      const ds = entriesToDiagnostics(entries, indexed);
      const script = ds.find((d) => d.message.includes("Error: echo"));
      // main.js line 5 is main.ts line 4 through the source map (the build added a header line).
      expect(script).toMatchObject({ file: "data/scripts/main.ts", range: { start: { line: 4, column: 9 } } });
      // The filter added a line to the entity: the source file and its own line, not the built one.
      const entity = ds.find((d) => d.message.includes("is_spawnable"));
      expect(entity?.file).toBe("packs/BP/entities/wand_mob.json");
      expect(entity?.range?.start.line).toBe(4);
      // A generated file without a source map points at the build output and says so.
      const extra = ds.find((d) => d.message.includes("Error: extra"));
      expect(extra?.file).toBe(join(project.loadable.find((p) => p.kind === "behavior")!.dir, "scripts", "extra.js"));
      expect(extra?.range?.start.line).toBe(2);
      expect(extra?.message).toContain("Regolith build output with no source map");
    } finally {
      await rm(project.build!.workDir, { recursive: true, force: true });
    }
  });

  it("turns a failed build into an error Diagnostic and starts no server", async () => {
    const root = await regolithProject("failing", { fail: true });
    const project = await projectPacks(root, { rglPath: rgl });
    expect(project.loadable).toEqual([]);
    expect(project.build).toBeUndefined();
    expect(project.failure).toMatchObject({ severity: "error", code: "regolith.build-failed", source: "bds", file: "config.json" });
    expect(project.failure?.message).toContain("error TS2322");

    // No BDS install is passed or resolved: a started server would fail here instead of returning.
    const check = await bdsCheck(root, { rglPath: rgl });
    expect(check.status).toBe("build-failed");
    expect(check.serverVersion).toBeUndefined();
    expect(check.diagnostics.map((d) => d.code)).toEqual(["regolith.build-failed"]);

    const tests = await runGameTests(root, { rglPath: rgl });
    expect(tests.exitCode).toBe(1);
    expect(tests.total).toBe(0);
    expect(tests.diagnostics.map((d) => d.code)).toEqual(["regolith.build-failed"]);
  });

  it("loads the source packs of a profile without filters and does not run rgl", async () => {
    const root = await regolithProject("plain", { filters: false });
    const before = await rglRuns();
    const project = await projectPacks(root, { rglPath: rgl });
    expect(await rglRuns()).toBe(before);
    expect(project.build).toBeUndefined();
    expect(project.loadable.map((p) => p.dir).sort()).toEqual([join(root, "packs", "BP"), join(root, "packs", "RP")]);
  });
});
