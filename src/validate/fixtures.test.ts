import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../core/diagnostic.ts";
import { type ValidationResult, validateProject, validateText } from "./index.ts";
import { parseTscOutput } from "./typescript.ts";

const FIXTURES = join(import.meta.dirname, "..", "..", "test", "fixtures");
const fx = (name: string) => join(FIXTURES, name);
/** Offline mode: no samples, no typings (the checks degrade to what is decidable without game data). */
const offline = (name: string, extra: Parameters<typeof validateProject>[1] = {}) => validateProject(fx(name), { ...extra });

type Expect = [code: string, file: string, line: number, severity?: Diagnostic["severity"]];

function expectAll(r: ValidationResult, expected: Expect[]): void {
  for (const [code, file, line, severity] of expected) {
    const hit = r.diagnostics.find((d) => d.code === code && d.file === file && d.range?.start.line === line);
    expect(hit, `${code} at ${file}:${line}\n${r.diagnostics.map((d) => `${d.file}:${d.range?.start.line} ${d.code}`).join("\n")}`).toBeDefined();
    if (severity) expect(hit?.severity, `${code} severity`).toBe(severity);
  }
}

const errors = (r: ValidationResult) => r.diagnostics.filter((d) => d.severity === "error");

describe("fixtures (offline)", () => {
  it("good_addon has no errors", async () => {
    const r = await offline("good_addon");
    expect(errors(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("bad_json: missing comma is an error, trailing commas warn, the broken loot table is unresolvable", async () => {
    const r = await offline("bad_json");
    expectAll(r, [
      ["json.syntax", "BP/loot_tables/entities/test_mob.json", 6, "error"],
      ["json.trailing-comma", "BP/items/test_item.json", 6, "warning"],
      ["reference.loot-table-missing", "BP/entities/test_mob.json", 26, "error"],
    ]);
    expect(errors(r)).toHaveLength(2);
  });

  it("bad_manifest", async () => {
    const r = await offline("bad_manifest");
    expectAll(r, [
      ["manifest.min-engine-too-new", "BP/manifest.json", 12, "warning"],
      ["manifest.script-entry-missing", "BP/manifest.json", 37, "error"],
      ["manifest.dependency-version", "BP/manifest.json", 43, "error"],
      ["manifest.script-module-npm-only", "BP/manifest.json", 54, "error"],
      ["manifest.capability-unknown", "BP/manifest.json", 59, "warning"],
      ["manifest.uuid-duplicate", "RP/manifest.json", 21, "error"],
    ]);
  });

  it("bad_manifest with an exact game version makes min_engine_version an error", async () => {
    const r = await offline("bad_manifest", { gameVersion: "1.26.60" });
    expectAll(r, [["manifest.min-engine-too-new", "BP/manifest.json", 12, "error"]]);
  });

  it("bad_refs: namespaced references are errors even without vanilla data", async () => {
    const r = await offline("bad_refs");
    expectAll(r, [
      ["reference.terrain-texture-missing", "BP/blocks/test_block.json", 14, "error"],
      ["reference.function-missing", "BP/functions/tick.json", 4, "error"],
      ["reference.item-texture-missing", "BP/items/test_item.json", 11, "error"],
      ["reference.item-missing", "BP/recipes/test_item.json", 19, "error"],
      ["reference.entity-missing", "BP/spawn_rules/test_mob.json", 5, "error"],
      ["reference.geometry-missing", "RP/entity/test_mob.entity.json", 13, "error"],
      ["reference.texture-missing", "RP/entity/test_mob.entity.json", 10, "error"],
      ["reference.loot-table-missing", "BP/entities/test_mob.json", 26, "warning"],
      ["reference.render-controller-missing", "RP/entity/test_mob.entity.json", 24, "warning"],
    ]);
  });

  it("bad_schema: no schema source offline, so only an explicit engine dump reports the wrong component type", async () => {
    const none = await offline("bad_schema");
    expect(none.diagnostics.filter((d) => d.source === "schema")).toEqual([]);
    expect(none.schemaSources).toEqual({});
    // A one-file dump in the `<area>/<kind>/<format_version>/` layout.
    const engine = mkdtempSync(join(tmpdir(), "sculk-fixtures-engine-"));
    try {
      const doc = join(engine, "server", "entity", "1.21.0");
      mkdirSync(doc, { recursive: true });
      const health = { type: "object", properties: { value: { type: "number" } } };
      writeFileSync(join(doc, "ActorDocument.json"), JSON.stringify({ type: "object", properties: { components: { type: "object", properties: { "minecraft:health": health } } } }));
      const r = await offline("bad_schema", { engineSchemasDir: engine });
      expectAll(r, [["schema.type", "BP/entities/test_mob.json", 17, "error"]]);
      expect(r.schemaSources["BP/entities/test_mob.json"]).toBe("engine server/entity/1.21.0/ActorDocument.json");
    } finally {
      rmSync(engine, { recursive: true, force: true });
    }
  });

  it("bad_ts: an undeclared @minecraft module is TS2307", async () => {
    const r = await offline("bad_ts", { checks: ["typescript"] });
    expectAll(r, [["ts.2307", "BP/scripts/main.js", 2, "error"]]);
    expect(r.diagnostics.find((d) => d.code === "ts.2307")?.range?.start.column).toBe(32);
  });

  it("bad_lang", async () => {
    const r = await offline("bad_lang");
    expectAll(r, [
      ["lang.syntax", "RP/texts/en_US.lang", 4, "warning"],
      ["lang.duplicate-key", "RP/texts/en_US.lang", 5, "warning"],
      ["lang.file-missing", "RP/texts/languages.json", 3, "warning"],
      ["lang.key-missing", "BP/blocks/test_block.json", 5, "warning"],
    ]);
  });

  it("bad_mcfunction: unknown commands (given a command list), bad tick.json, missing functions", async () => {
    const r = await offline("bad_mcfunction", { commands: ["execute", "function", "effect", "say"] });
    expectAll(r, [
      ["mcfunction.unknown-command", "BP/functions/mcbe/tick.mcfunction", 3, "error"],
      ["mcfunction.unknown-command", "BP/functions/mcbe/tick.mcfunction", 4, "error"],
      ["reference.function-missing", "BP/functions/mcbe/tick.mcfunction", 5, "error"],
      ["mcfunction.tick-json", "BP/functions/tick.json", 4, "error"],
    ]);
    const bogus = r.diagnostics.find((d) => d.code === "mcfunction.unknown-command" && d.range?.start.line === 4);
    // "execute as @a run bogus hello": `bogus` spans columns 19..24.
    expect(bogus?.range).toEqual({ start: { line: 4, column: 19 }, end: { line: 4, column: 24 } });
  });

  it("regolith_project without filters validates its source packs", async () => {
    const r = await offline("regolith_project");
    expect(errors(r)).toEqual([]);
    expect(r.regolith).toMatchObject({ profile: "default", built: false });
    expect(r.packs.map((p) => p.relDir)).toEqual(["packs/BP", "packs/RP"]);
  });

  it("validateText checks unsaved content in its pack context", async () => {
    const path = join(fx("good_addon"), "BP", "items", "test_item.json");
    const r = await validateText(path, '{\n  "format_version": "1.21.0",\n  "minecraft:item": {\n    "description": {"identifier": "mcbe:test_item"},\n    "components": {"minecraft:icon": "mcbe_nope"}\n  }\n}');
    expect(r.diagnostics.map((d) => [d.code, d.file, d.range?.start.line])).toEqual([["reference.item-texture-missing", "BP/items/test_item.json", 5]]);
  });
});

const SAMPLES = process.env.SCULKWIRE_SAMPLES;
describe.skipIf(!SAMPLES || !existsSync(SAMPLES))("fixtures with bedrock-samples (SCULKWIRE_SAMPLES)", () => {
  it("bad_schema: engine/calibrated schemas make both type errors errors", async () => {
    const r = await validateProject(fx("bad_schema"), { samplesRoot: SAMPLES as string });
    expectAll(r, [
      ["schema.type", "BP/entities/test_mob.json", 17, "error"],
      ["schema.type", "BP/items/test_item.json", 12, "error"],
    ]);
  });
  it("bad_refs: every missing reference is an error", async () => {
    const r = await validateProject(fx("bad_refs"), { samplesRoot: SAMPLES as string });
    expect(errors(r).filter((d) => d.code.startsWith("reference.")).length).toBe(9);
  });
});

describe.skipIf(process.env.SCULKWIRE_NETWORK_TESTS !== "1")("bad_ts with real typings (network)", () => {
  it("reports TS2307 and TS2339", async () => {
    const { ensureTypings } = await import("../knowledge/typings.ts");
    const t = await ensureTypings({ channel: "stable", modules: { "@minecraft/server": "2.11.0" } });
    const r = await validateProject(fx("bad_ts"), { typingsDir: t.nodeModulesDir, checks: ["typescript"] });
    expectAll(r, [
      ["ts.2307", "BP/scripts/main.js", 2, "error"],
      ["ts.2339", "BP/scripts/main.js", 5, "error"],
    ]);
  }, 300_000);
});

describe("tsc output", () => {
  it("parses diagnostics and folds continuation lines", () => {
    const out = [
      "scripts/main.js(5,9): error TS2339: Property 'x' does not exist on type 'World'.",
      "scripts/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  Types of property 'a' are incompatible.",
      "Found 2 errors.",
    ].join("\n");
    expect(parseTscOutput(out)).toEqual([
      { file: "scripts/main.js", line: 5, column: 9, severity: "error", code: "TS2339", message: "Property 'x' does not exist on type 'World'." },
      {
        file: "scripts/a.ts",
        line: 1,
        column: 1,
        severity: "error",
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'. Types of property 'a' are incompatible.",
      },
    ]);
  });
});
