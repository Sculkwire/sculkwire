import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseJson } from "../validate/jsonc.ts";
import { checkSchemaFile, chooseSchema } from "../validate/schema.ts";
import { validateProject } from "../validate/index.ts";
import { OfflineMissingError } from "./net.ts";
import {
  ensureRockideSchemas,
  formatRockide,
  lookupRockide,
  newestRelease,
  ROCKIDE_REFRESH_MS,
  type RockideFetcher,
  resetRockideBackoff,
  rockideComponent,
  rockideStatus,
} from "./rockide.ts";

// A tiny hand-written tree in the rockide/schemas layout (no real rockide file is used).
const work = mkdtempSync(join(tmpdir(), "sculk-rockide-test-"));
const tree = join(work, "tree");
const cache = join(work, "cache");
const prevCache = process.env.SCULKWIRE_CACHE;
process.env.SCULKWIRE_CACHE = cache;
afterAll(() => {
  if (prevCache === undefined) delete process.env.SCULKWIRE_CACHE;
  else process.env.SCULKWIRE_CACHE = prevCache;
  rmSync(work, { recursive: true, force: true });
});

function put(rel: string, content: object | string): void {
  const file = join(tree, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

put(
  "scripts/compile.ts",
  `const BP_ENTRIES: JsonValidationEntry[] = [
\t{
\t\tfileMatch: ["entities/**/*.json"],
\t\turl: "./schema/bedrock/server/entity/_index.json",
\t},
\t{
\t\tfileMatch: ["loot_tables/**/*.json"],
\t\turl: "./schema/bedrock/server/loot_table/_index.json",
\t},
];
`,
);
// Loot conditions shaped like rockide's: match_tool fields nested under `match_tool`, ranges as {min, max}.
put("schema/bedrock/server/loot_table/_index.json", {
  type: "object",
  properties: { pools: { type: "array", items: { type: "object", properties: { conditions: { type: "array", items: { $ref: "./condition.json" } } } } } },
});
put("schema/bedrock/server/loot_table/condition.json", {
  type: "object",
  required: ["condition"],
  unevaluatedProperties: false,
  properties: { condition: { type: "string" } },
  allOf: [
    {
      if: { properties: { condition: { const: "match_tool" } }, required: ["condition"] },
      then: { properties: { condition: true, match_tool: { $ref: "#/$defs/match_tool" } }, additionalProperties: false, required: ["condition", "match_tool"] },
    },
  ],
  $defs: {
    match_tool: {
      type: "object",
      additionalProperties: false,
      properties: { count: { $ref: "#/$defs/range" }, enchantments: { type: "array", items: { $ref: "#/$defs/enchantment_spec" } } },
    },
    enchantment_spec: { type: "object", additionalProperties: false, properties: { enchantment: { type: "string" }, levels: { $ref: "#/$defs/range" } } },
    range: { type: "object", required: ["min", "max"], additionalProperties: false, properties: { min: { type: "integer" }, max: { type: "integer" } } },
  },
});
const E = "schema/bedrock/server/entity";
put(`${E}/_index.json`, {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["format_version"],
  properties: { format_version: { enum: ["1.21.0", "1.26.0"] } },
  allOf: [
    { if: { properties: { format_version: { const: "1.21.0" } } }, then: { $ref: "./1.21.0/_index.json" } },
    { if: { properties: { format_version: { const: "1.26.0" } } }, then: { $ref: "./1.26.0/_index.json" } },
  ],
});
for (const v of ["1.21.0", "1.26.0"]) {
  put(`${E}/${v}/_index.json`, {
    type: "object",
    properties: {
      format_version: { type: "string" },
      "minecraft:entity": {
        type: "object",
        properties: {
          components: { type: "object", unevaluatedProperties: false, allOf: [{ $ref: "./components/_index.json" }, { $ref: "./behaviors/_index.json" }] },
        },
      },
    },
  });
}
put(`${E}/1.21.0/components/_index.json`, { type: "object", properties: { "minecraft:health": { $ref: "./health.json" } } });
put(`${E}/1.21.0/behaviors/_index.json`, { type: "object", properties: {} });
put(`${E}/1.21.0/components/health.json`, {
  type: "object",
  description: "Health v1",
  additionalProperties: false,
  properties: { value: { type: "integer", default: 10, description: "Hit points" } },
});
put(`${E}/1.26.0/components/_index.json`, { type: "object", properties: { "minecraft:health": { $ref: "./health.json" } } });
put(`${E}/1.26.0/components/health.json`, {
  type: "object",
  description: "Health v2",
  additionalProperties: false,
  properties: { value: { anyOf: [{ type: "integer" }, { type: "object", properties: { range_min: { type: "integer" } } }] }, max: { type: "integer", minimum: 1 } },
});
put(`${E}/1.26.0/behaviors/_index.json`, { type: "object", properties: { "minecraft:behavior.tempt": { $ref: "./behavior.tempt.json" } } });
put(`${E}/1.26.0/behaviors/behavior.tempt.json`, {
  type: "object",
  description: "Tempted by items",
  required: ["priority"],
  properties: {
    priority: { type: "integer", minimum: 0 },
    speed_multiplier: { type: "number", default: 1, description: "Speed while tempted" },
    control_flags: { type: "array", items: { type: "string", anyOf: [{ enum: ["move", "look"] }, { pattern: "^(?:MOVE|LOOK)$" }] } },
    look_mode: { anyOf: [{ enum: ["near", "far"] }, { pattern: "^(?:NEAR|FAR)$" }] },
    sound_interval: { type: "object", properties: { min: { type: "number" }, max: { type: "number" } } },
  },
});
// Block components: an inline definition in the index.
put("schema/bedrock/server/block/1.26.0/components/_index.json", {
  type: "object",
  properties: {
    "minecraft:collision_box": { description: "Collision box", oneOf: [{ type: "boolean" }, { type: "object", properties: { origin: { type: "array" }, size: { type: "array" } } }] },
  },
});

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const SHA3 = "3".repeat(40);
const COMMITS: Record<string, string> = { "0.1.3": SHA1, "0.1.4": SHA2, "0.2.0": SHA3 };

/** A fake GitHub: `state.tag` is the newest release; `fail` breaks the check, `failDownload` the tarball. */
function fakeFetcher(state: { tag: string; fail?: boolean; failDownload?: boolean }) {
  const calls = { latest: 0, download: 0 };
  const fetcher: RockideFetcher = {
    async latest() {
      calls.latest++;
      if (state.fail) throw new Error("network down");
      return { version: state.tag, commit: COMMITS[state.tag] as string };
    },
    async download(_release, dest) {
      calls.download++;
      cpSync(tree, dest, { recursive: true });
      // A partial download: the tree without `scripts/compile.ts`.
      if (state.failDownload) rmSync(join(dest, "scripts"), { recursive: true, force: true });
    },
  };
  return { fetcher, calls };
}

const T0 = Date.parse("2026-11-01T00:00:00Z");
const DAY = ROCKIDE_REFRESH_MS;

describe("rockide release tracking", () => {
  beforeEach(() => {
    rmSync(cache, { recursive: true, force: true });
    resetRockideBackoff();
  });

  it("picks the newest x.y.z tag from git ls-remote, peeled commits first, pre-releases skipped", () => {
    const out = [
      `${SHA1}\trefs/tags/0.1.10`,
      `${SHA2}\trefs/tags/0.1.9`,
      `${"a".repeat(40)}\trefs/tags/v0.2.0`,
      `${SHA3}\trefs/tags/v0.2.0^{}`,
      `${"b".repeat(40)}\trefs/tags/0.3.0-beta.1`,
    ].join("\n");
    expect(newestRelease(out)).toEqual({ version: "v0.2.0", commit: SHA3 });
    expect(newestRelease(`${SHA1}\trefs/tags/nightly`)).toBeUndefined();
  });

  it("offline without a copy throws; the lookup fails open with a note", async () => {
    const { fetcher, calls } = fakeFetcher({ tag: "0.1.3" });
    await expect(ensureRockideSchemas({ offline: true, fetcher })).rejects.toBeInstanceOf(OfflineMissingError);
    const r = await lookupRockide("minecraft:health", "1.26.60", { offline: true, fetcher });
    expect(r.matches).toEqual([]);
    expect(r.note).toMatch(/unavailable/);
    expect(calls.latest).toBe(0);
  });

  it("downloads once, re-checks at most once a day, and switches when a new release appears", async () => {
    const state = { tag: "0.1.3" };
    const { fetcher, calls } = fakeFetcher(state);
    const first = await ensureRockideSchemas({ fetcher, now: T0 });
    expect(first).toMatchObject({ release: "0.1.3", commit: SHA1, latest: "0.1.3" });
    expect(first.root).toBe(join(cache, "knowledge", "rockide", "0.1.3"));
    expect(existsSync(join(first.root, "schema", "bedrock"))).toBe(true);
    expect(calls).toEqual({ latest: 1, download: 1 });

    // A new release within the day is not seen yet.
    state.tag = "0.1.4";
    expect((await ensureRockideSchemas({ fetcher, now: T0 + DAY - 1 })).release).toBe("0.1.3");
    expect(calls).toEqual({ latest: 1, download: 1 });

    // The next due check switches to it; the previous release is kept for readers still using it.
    const next = await ensureRockideSchemas({ fetcher, now: T0 + DAY });
    expect(next).toMatchObject({ release: "0.1.4", commit: SHA2, checkedAt: new Date(T0 + DAY).toISOString(), fetchedAt: new Date(T0 + DAY).toISOString() });
    expect(calls).toEqual({ latest: 2, download: 2 });

    // Due, unchanged release: only the check runs.
    const same = await ensureRockideSchemas({ fetcher, now: T0 + 2 * DAY });
    expect(calls).toEqual({ latest: 3, download: 2 });
    expect(same.fetchedAt).toBe(new Date(T0 + DAY).toISOString());

    // `refresh` checks now; older copies than the previous one are pruned.
    state.tag = "0.2.0";
    expect((await ensureRockideSchemas({ fetcher, now: T0 + 2 * DAY + 1, refresh: true })).release).toBe("0.2.0");
    const base = join(cache, "knowledge", "rockide");
    expect(["0.1.3", "0.1.4", "0.2.0"].map((t) => existsSync(join(base, t)))).toEqual([false, true, true]);
    expect(JSON.parse(readFileSync(join(base, "current.json"), "utf8")).release).toEqual({ version: "0.2.0", commit: SHA3 });
    expect(await rockideStatus()).toMatchObject({ release: "0.2.0", latest: "0.2.0", checkedAt: new Date(T0 + 2 * DAY + 1).toISOString() });
  });

  it("offline or a failed check keeps the cached copy", async () => {
    const state = { tag: "0.1.3", fail: false };
    const { fetcher, calls } = fakeFetcher(state);
    await ensureRockideSchemas({ fetcher, now: T0 });
    state.fail = true;
    const offline = await ensureRockideSchemas({ fetcher, now: T0 + 2 * DAY, offline: true });
    expect(offline.release).toBe("0.1.3");
    expect(offline.stale).toBeUndefined();
    expect(calls.latest).toBe(1);

    const failed = await ensureRockideSchemas({ fetcher, now: T0 + 2 * DAY });
    expect(failed).toMatchObject({ release: "0.1.3", stale: "network down" });
    expect(calls.latest).toBe(2);
    // Back-off: the next due call does not retry within the hour.
    expect((await ensureRockideSchemas({ fetcher, now: T0 + 2 * DAY + 1000 })).stale).toBeDefined();
    expect(calls.latest).toBe(2);
    const lookup = await lookupRockide("minecraft:health", "1.26.60", { fetcher, now: T0 + 2 * DAY + 2000 });
    expect(lookup).toMatchObject({ release: "0.1.3", note: expect.stringMatching(/update failed/) });
    expect(lookup.matches).toHaveLength(1);
  });

  it("a failed download keeps the old copy and records the newer release", async () => {
    const state = { tag: "0.1.3", failDownload: false };
    const { fetcher } = fakeFetcher(state);
    const old = await ensureRockideSchemas({ fetcher, now: T0 });
    state.tag = "0.1.4";
    state.failDownload = true;
    const r = await ensureRockideSchemas({ fetcher, now: T0 + DAY });
    expect(r).toMatchObject({ release: "0.1.3", root: old.root, latest: "0.1.4", stale: expect.stringMatching(/incomplete/) });
    expect(existsSync(join(old.root, "scripts", "compile.ts"))).toBe(true);
    expect(existsSync(join(cache, "knowledge", "rockide", "0.1.4"))).toBe(false);
    expect(await rockideStatus()).toMatchObject({ release: "0.1.3", latest: "0.1.4", error: expect.stringMatching(/incomplete/) });

    // The next process retries (the check time was not advanced) and switches once the download works.
    resetRockideBackoff();
    state.failDownload = false;
    expect(await ensureRockideSchemas({ fetcher, now: T0 + DAY + 1 })).toMatchObject({ release: "0.1.4", latest: "0.1.4" });
    expect((await rockideStatus())?.error).toBeUndefined();
  });

  it("keeps using a copy cached before releases were tracked until a check succeeds", async () => {
    const legacy = join(cache, "knowledge", "rockide", SHA1);
    cpSync(tree, legacy, { recursive: true });
    writeFileSync(join(cache, "knowledge", "rockide", "current.json"), JSON.stringify({ commit: SHA1, fetchedAt: new Date(T0).toISOString(), checkedAt: new Date(T0).toISOString() }));
    const { fetcher } = fakeFetcher({ tag: "0.1.4" });
    expect(await ensureRockideSchemas({ fetcher, now: T0 + 1, offline: true })).toMatchObject({ release: "main", commit: SHA1, root: legacy });
    expect(await ensureRockideSchemas({ fetcher, now: T0 + DAY })).toMatchObject({ release: "0.1.4", commit: SHA2 });
  });
});

describe("rockide component lookup", () => {
  it("summarizes the version matching the game, lists versions and changes", async () => {
    const [health] = await rockideComponent(tree, "minecraft:health", "1.21.50");
    expect(health).toMatchObject({
      scope: "server/entity/components",
      formatVersions: ["1.21.0", "1.26.0"],
      selectedVersion: "1.21.0",
      file: `${E}/1.21.0/components/health.json`,
      description: "Health v1",
      properties: [{ name: "value", type: "integer", default: 10, description: "Hit points" }],
      changes: [
        { formatVersion: "1.21.0", file: `${E}/1.21.0/components/health.json` },
        { formatVersion: "1.26.0", file: `${E}/1.26.0/components/health.json` },
      ],
    });
    const [h2] = await rockideComponent(tree, "minecraft:health", "1.26.70.23");
    expect(h2?.selectedVersion).toBe("1.26.0");
    expect(h2?.properties).toEqual([
      { name: "value", type: "integer | object", properties: [{ name: "range_min", type: "integer" }] },
      { name: "max", type: "integer", minimum: 1 },
    ]);
  });

  it("reports enums, defaults, required fields, nested properties and newer-than-game versions", async () => {
    const [tempt] = await rockideComponent(tree, "minecraft:behavior.tempt", "1.21.0");
    expect(tempt).toMatchObject({ scope: "server/entity/behaviors", selectedVersion: "1.26.0", newerThanGame: true, description: "Tempted by items" });
    const byName = Object.fromEntries((tempt?.properties ?? []).map((p) => [p.name, p]));
    expect(byName.priority).toEqual({ name: "priority", type: "integer", minimum: 0, required: true });
    expect(byName.speed_multiplier).toMatchObject({ type: "number", default: 1 });
    expect(byName.look_mode).toMatchObject({ type: "string", enum: ["near", "far"] });
    expect(byName.sound_interval?.properties?.map((p) => p.name)).toEqual(["min", "max"]);
    const text = formatRockide({ repo: "x", commit: SHA1, gameVersion: "1.21.0", matches: tempt ? [tempt] : [] }).join("\n");
    expect(text).toContain("server/entity/behaviors format_version 1.26.0 (newer than 1.21.0)");
    expect(text).toContain('- look_mode (string; one of "near", "far")');
  });

  it("resolves inline definitions (block components)", async () => {
    const [box] = await rockideComponent(tree, "minecraft:collision_box", "1.26.60");
    expect(box).toMatchObject({ scope: "server/block/components", description: "Collision box", type: "boolean | object" });
    expect(box?.properties.map((p) => p.name)).toEqual(["origin", "size"]);
    expect(await rockideComponent(tree, "minecraft:nope", "1.26.60")).toEqual([]);
  });
});

describe("validator routing with rockide", () => {
  // An engine dump that also covers entities: rockide still wins where its fileMatch routes the file.
  const engine = join(work, "engine");
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
    const project = join(work, "project");
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
    const used = await validateProject(project, { checks: ["schema"], resolveRockide: async () => ({ root: tree, commit: SHA1 }) });
    expect(used.rockide).toEqual({ root: tree, commit: SHA1 });
    expect(used.diagnostics.map((d) => d.code)).toContain("schema.unevaluated-properties");
  });
});
