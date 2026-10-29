import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseJson } from "./jsonc.ts";
import { checkSchemaFile, chooseSchema, globToRegExp } from "./schema.ts";

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
