/** rockide 0.2 `x-format-version` routing on a hand-written tree in its layout (no real rockide file is used). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inRanges, parseRange } from "./formatrange.ts";
import { parseJson } from "./jsonc.ts";
import { checkSchemaFile, knownFormatVersions } from "./schema.ts";

const root = mkdtempSync(join(tmpdir(), "sculk-formatrange-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const B = "schema/bedrock/server/block";

/** A block family with three branches; `latest` is rockide's constant when `latest` is given, else unknown. */
function writeTree(dir: string, latest?: string): void {
  const put = (rel: string, content: object | string): void => {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  };
  put("scripts/compile.ts", `const BP_ENTRIES: JsonValidationEntry[] = [\n\t{\n\t\tfileMatch: ["blocks/**/*.json"],\n\t\turl: "./${B}/_index.json",\n\t},\n];\n`);
  if (latest) put("scripts/format_version_range.ts", `export class FormatVersionRange {\n\tprivate static readonly LATEST_GAME_VERSION = "${latest}";\n}\n`);
  const branch = (range: string | string[], folder: string) => ({ if: { properties: { format_version: { "x-format-version": range } } }, then: { $ref: `./${folder}/_index.json` } });
  put(`${B}/_index.json`, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    "x-format-version-enums": true,
    required: ["format_version"],
    properties: { format_version: { "x-format-version": "[1.12.0-latest]" } },
    allOf: [branch("[1.12.0-1.20.0)", "1.12.0"), branch(["[1.20.0-1.20.10)", "[1.20.10-1.21.0)"], "1.20.0"), branch("[1.21.0-latest]", "1.21.0")],
  });
  for (const v of ["1.12.0", "1.20.0", "1.21.0"]) {
    put(`${B}/${v}/_index.json`, {
      type: "object",
      properties: { format_version: { type: "string" }, "minecraft:block": { type: "object", additionalProperties: false, properties: { [`v${v}`]: true } } },
    });
  }
}

const tree = join(root, "rockide");
writeTree(tree, "1.30.0");
const noLatest = join(root, "rockide-no-latest");
writeTree(noLatest);

const block = (fv: string, prop: string) => ({ format_version: fv, "minecraft:block": { [prop]: {} } });

async function check(fv: string, prop: string, dir = tree) {
  const doc = parseJson(JSON.stringify(block(fv, prop)));
  const r = await checkSchemaFile({ packKind: "behavior", rel: "blocks/a.json", kind: "block", doc, opts: { rockideSchemasDir: dir } });
  return r.diagnostics.map((d) => [d.code, d.message]);
}

describe("x-format-version ranges", () => {
  it("parse rockide's range forms", () => {
    expect(parseRange(" [1.19.10 - 1.19.20) ", "1.30.0")).toEqual({ text: "[1.19.10-1.19.20)", min: [1, 19, 10], max: [1, 19, 20], maxExclusive: true });
    expect(parseRange("[1.8.0-latest]", "1.30.0")).toMatchObject({ max: [1, 30, 0], maxExclusive: false });
    expect(() => parseRange("[1.8-1.9]", "1.30.0")).toThrow(/invalid/);
  });
  it("match a.b and a.b.c versions without leading zeros, a.b meaning a.b.0", () => {
    const r = [parseRange("[1.19.10-1.21.0)", "1.30.0")];
    expect(["1.19.10", "1.20", "1.20.99"].map((v) => inRanges(v, r))).toEqual([true, true, true]);
    expect(["1.19", "1.21", "1.21.0", "1.019.10", "1.20.1.0", 1.2].map((v) => inRanges(v, r))).toEqual([false, false, false, false, false, false]);
  });
});

describe("rockide 0.2 format_version routing", () => {
  it("picks the branch whose range holds the version, upper bound exclusive", async () => {
    expect(await check("1.19.80", "v1.12.0")).toEqual([]);
    expect(await check("1.19.80", "v1.20.0")).toEqual([["schema.additional-properties", 'minecraft:block: unknown property "v1.20.0"']]);
    expect(await check("1.20.0", "v1.20.0")).toEqual([]);
    expect(await check("1.20.15", "v1.20.0")).toEqual([]);
    expect(await check("1.21.0", "v1.21.0")).toEqual([]);
    expect(await check("1.21.0", "v1.20.0")).toEqual([["schema.additional-properties", 'minecraft:block: unknown property "v1.20.0"']]);
  });
  it("routes two-part versions as a.b.0", async () => {
    expect(await check("1.20", "v1.20.0")).toEqual([]);
    expect(await check("1.21", "v1.21.0")).toEqual([]);
  });
  it("takes latest from rockide's constant", async () => {
    expect(await check("1.30.0", "v1.21.0")).toEqual([]);
  });
  it("falls back to the newest branch for a version newer than latest", async () => {
    expect(await check("1.30.1", "v1.21.0")).toEqual([
      ["schema.format-version-fallback", `rockide ${B}/_index.json has no schema for format_version 1.30.1; validated with 1.21.0`],
    ]);
    expect(await check("1.30.1", "v1.20.0")).toContainEqual(["schema.additional-properties", 'minecraft:block: unknown property "v1.20.0"']);
  });
  it("without the constant, latest is the newest lower bound of the document", async () => {
    expect(await check("1.21.0", "v1.21.0", noLatest)).toEqual([]);
    expect((await check("1.21.5", "v1.21.0", noLatest)).map(([code]) => code)).toEqual(["schema.format-version-fallback"]);
  });
  it("lists every branch's lower bound as the known versions", async () => {
    const known = await knownFormatVersions("behavior", "blocks/a.json", "block", block("1.21.0", "x"), { rockideSchemasDir: tree });
    expect(known).toEqual(["1.12.0", "1.20.0", "1.20.10", "1.21.0"]);
  });
});
