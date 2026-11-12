import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { E, writeRockideTree } from "../testing/rockidetree.ts";
import { validateProject } from "./index.ts";
import { parseJson } from "./jsonc.ts";
import { calibration, checkSchemaFile, chooseSchema, globToRegExp } from "./schema.ts";

// A tiny hand-written engine-schema tree in the bedrock-samples `metadata/json_schemas` layout.
const root = mkdtempSync(join(tmpdir(), "sculk-schema-test-"));
const base = join(root, "metadata", "json_schemas");
function put(rel: string, schema: object): void {
  const file = join(base, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(schema));
}
put("server/item/1.20.50/Component.json", {
  type: "object",
  properties: { "minecraft:max_stack_size": { oneOf: [{ type: "integer" }, { type: "object", properties: { value: { type: "integer" } } }] } },
});
put("server/item/1.26.30/ItemDocument.json", {
  type: "object",
  required: ["description"],
  properties: { description: { $ref: "./description.json" }, components: { type: "object" } },
});
put("server/item/1.26.30/description.json", { type: "object", required: ["identifier"], properties: { identifier: { type: "string" } } });
put("server/item/beta/ItemDocument.json", { type: "object" });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const item = (fv: string, components: object = {}) => ({ format_version: fv, "minecraft:item": { description: { identifier: "x:y" }, components } });

describe("schema selection by format_version", () => {
  it("picks the nearest engine version <= the file's, skipping beta", async () => {
    const opts = { samplesRoot: root };
    expect((await chooseSchema("behavior", "items/a.json", "item", item("1.21.0"), opts))?.label).toBe("engine server/item/1.20.50/Component.json");
    expect((await chooseSchema("behavior", "items/a.json", "item", item("1.26.40"), opts))?.label).toBe("engine server/item/1.26.30/ItemDocument.json");
    expect((await chooseSchema("behavior", "items/a.json", "item", item("1.26.30"), opts))?.version).toBe("1.26.30");
  });
  it("has no schema below the oldest engine version or without samples", async () => {
    expect(await chooseSchema("behavior", "items/a.json", "item", item("1.10"), { samplesRoot: root })).toBeUndefined();
    expect(await chooseSchema("behavior", "items/a.json", "item", item("1.26.40"), {})).toBeUndefined();
  });
  it("accepts a direct json_schemas-layout directory", async () => {
    expect((await chooseSchema("behavior", "items/a.json", "item", item("1.26.40"), { engineSchemasDir: base }))?.source).toBe("engine");
  });
  it("anchors directory globs at the pack root", () => {
    expect(globToRegExp("entities/**/*.json").test("loot_tables/entities/x.json")).toBe(false);
    expect(globToRegExp("entities/**/*.json").test("entities/sub/x.json")).toBe(true);
  });
});

describe("schema errors", () => {
  it("reduce anyOf branches to one located error under the engine subtree", async () => {
    const text = JSON.stringify(item("1.21.0", { "minecraft:max_stack_size": "sixty" }), null, 2);
    const doc = parseJson(text);
    const r = await checkSchemaFile({ packKind: "behavior", rel: "items/a.json", kind: "item", doc, opts: { samplesRoot: root } });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "schema.type",
      pointer: "/minecraft:item/components/minecraft:max_stack_size",
      range: { start: { line: 8, column: 35 } },
    });
  });
  it("follows relative $refs and reports required properties", async () => {
    const doc = parseJson(JSON.stringify({ format_version: "1.26.40", "minecraft:item": { description: {} } }));
    const r = await checkSchemaFile({ packKind: "behavior", rel: "items/a.json", kind: "item", doc, opts: { samplesRoot: root } });
    expect(r.diagnostics.map((d) => [d.code, d.pointer])).toEqual([["schema.required", "/minecraft:item/description"]]);
  });
  it("flags a format_version newer than the target game", async () => {
    const doc = parseJson(JSON.stringify(item("1.30.0")));
    const r = await checkSchemaFile({ packKind: "behavior", rel: "items/a.json", kind: "item", doc, opts: {}, gameVersion: [1, 26, 60] });
    expect(r.diagnostics.map((d) => d.code)).toContain("schema.format-version-too-new");
  });
  it("demotes complaints vanilla shares to schema.gap", async () => {
    const doc = parseJson(JSON.stringify(item("1.21.0", { "minecraft:max_stack_size": "sixty" })));
    const first = await checkSchemaFile({ packKind: "behavior", rel: "items/a.json", kind: "item", doc, opts: { samplesRoot: root } });
    const pointer = first.diagnostics[0]?.pointer;
    expect(pointer).toBeDefined();
    const sig = "engine:item|type|minecraft:max_stack_size|string|integer/object";
    const r = await checkSchemaFile({
      packKind: "behavior",
      rel: "items/a.json",
      kind: "item",
      doc,
      opts: { samplesRoot: root },
      calibration: { signatures: new Set([sig]) },
    });
    expect(r.diagnostics.map((d) => [d.code, d.severity])).toEqual([["schema.gap", "warning"]]);
  });
});

describe("vanilla calibration", () => {
  it("is keyed by the schema sources, so a new rockide release recalibrates", async () => {
    const prevCache = process.env.SCULKWIRE_CACHE;
    process.env.SCULKWIRE_CACHE = join(root, "cache");
    try {
      let runs = 0;
      const files = async () => {
        runs++;
        return [];
      };
      await calibration("vanilla-id", { rockideSchemasDir: join(root, "rockide-v1") }, files);
      await calibration("vanilla-id", { rockideSchemasDir: join(root, "rockide-v1") }, files);
      expect(runs).toBe(1);
      await calibration("vanilla-id", { rockideSchemasDir: join(root, "rockide-v2") }, files);
      expect(runs).toBe(2);
    } finally {
      if (prevCache === undefined) delete process.env.SCULKWIRE_CACHE;
      else process.env.SCULKWIRE_CACHE = prevCache;
    }
  });
});

const tree = join(root, "rockide");
writeRockideTree(tree);
const COMMIT = "1".repeat(40);

describe("validator routing with rockide", () => {
  // An engine dump that also covers entities: rockide still wins where its fileMatch routes the file.
  const engine = join(root, "engine");
  mkdirSync(join(engine, "server", "entity", "1.21.0"), { recursive: true });
  writeFileSync(join(engine, "server", "entity", "1.21.0", "ActorDocument.json"), JSON.stringify({ type: "object" }));
  const mob = (components: object) => ({ format_version: "1.26.0", "minecraft:entity": { components } });

  it("prefers rockide and falls back to engine; nothing covers a file neither routes", async () => {
    const opts = { rockideSchemasDir: tree, engineSchemasDir: engine };
    const c = await chooseSchema("behavior", "entities/a.json", "entity", mob({}), opts);
    expect(c?.label).toBe(`rockide ${E}/_index.json`);
    expect((await chooseSchema("behavior", "entities/a.json", "entity", mob({}), { engineSchemasDir: engine }))?.source).toBe("engine");
    expect(await chooseSchema("behavior", "spawn_rules/x.json", "spawn_rule", {}, opts)).toBeUndefined();
  });

  it("reports unknown components the engine dump admits", async () => {
    const doc = parseJson(JSON.stringify(mob({ "minecraft:health": { value: 5 }, "minecraft:not_real": {} }), null, 2));
    const r = await checkSchemaFile({ packKind: "behavior", rel: "entities/a.json", kind: "entity", doc, opts: { rockideSchemasDir: tree, engineSchemasDir: engine } });
    expect(r.choice?.source).toBe("rockide");
    expect(r.diagnostics.map((d) => [d.severity, d.pointer])).toEqual([["error", "/minecraft:entity/components/minecraft:not_real"]]);
  });

  it("accepts flat match_tool conditions with range_min/range_max (Mojang docs) and still rejects unknown fields", async () => {
    const check = (condition: object) =>
      checkSchemaFile({
        packKind: "behavior",
        rel: "loot_tables/blocks/x.json",
        kind: "loot_table",
        doc: parseJson(JSON.stringify({ pools: [{ conditions: [condition] }] })),
        opts: { rockideSchemasDir: tree },
      });
    const ok = await check({ condition: "match_tool", count: 1, enchantments: [{ enchantment: "silk_touch", levels: { range_min: 1 } }] });
    expect(ok.diagnostics).toEqual([]);
    const bad = await check({ condition: "match_tool", enchantments: [{ enchantment: "silk_touch", levels: { range_minimum: 1 } }] });
    expect(bad.diagnostics.length).toBeGreaterThan(0);
  });

  it("fails open when no rockide copy resolves", async () => {
    const project = join(root, "project");
    mkdirSync(join(project, "BP", "entities"), { recursive: true });
    writeFileSync(
      join(project, "BP", "manifest.json"),
      JSON.stringify({
        format_version: 2,
        header: { name: "t", description: "", uuid: "11111111-1111-4111-8111-111111111111", version: [1, 0, 0], min_engine_version: [1, 21, 0] },
        modules: [{ type: "data", uuid: "22222222-2222-4222-8222-222222222222", version: [1, 0, 0] }],
      }),
    );
    writeFileSync(join(project, "BP", "entities", "a.json"), JSON.stringify(mob({ "minecraft:not_real": {} })));
    const none = await validateProject(project, { checks: ["schema"], engineSchemasDir: engine, resolveRockide: async () => ({ note: "unavailable (offline)" }) });
    expect(none.rockide).toEqual({ note: "unavailable (offline)" });
    expect(none.schemaSources["BP/entities/a.json"]).toBe("engine server/entity/1.21.0/ActorDocument.json");
    const used = await validateProject(project, { checks: ["schema"], resolveRockide: async () => ({ root: tree, commit: COMMIT }) });
    expect(used.rockide).toEqual({ root: tree, commit: COMMIT });
    expect(used.diagnostics.map((d) => d.code)).toContain("schema.unevaluated-properties");
  });
});
