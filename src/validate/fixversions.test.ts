/** pack_fix_versions on fixture packs: no network, targets given, a hand-written rockide tree as the schema source. */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { E, writeRockideTree } from "../testing/rockidetree.ts";
import { type FixTargets, fixVersions } from "./fixversions.ts";

const FIXTURE = join(import.meta.dirname, "..", "..", "test", "fixtures", "fix_versions");
const tmp = mkdtempSync(join(tmpdir(), "sculk-fixversions-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Entity format_versions 1.21.0 and 1.26.0; under 1.26.0 minecraft:health needs a value.
const rockide = join(tmp, "rockide");
writeRockideTree(rockide);
writeFileSync(
  join(rockide, E, "1.26.0", "components", "health.json"),
  JSON.stringify({ type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "integer" }, max: { type: "integer" } } }),
);

const targets: FixTargets = {
  gameVersion: "1.26.60",
  modules: { "@minecraft/server": { stable: "2.3.0", beta: "2.4.0-beta" }, "@minecraft/server-ui": { stable: "2.0.0", beta: "2.1.0-beta" } },
};
const opts = { targets, rockideSchemasDir: rockide };

let n = 0;
function copy(): string {
  const dir = join(tmp, `project${n++}`);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out[relative(dir, join(e.parentPath, e.name))] = readFileSync(join(e.parentPath, e.name), "utf8");
  }
  return out;
}

const BP_MANIFEST = "BP/manifest.json";

describe("pack_fix_versions", () => {
  it("lists the changes of a dry run without writing", async () => {
    const dir = copy();
    const before = snapshot(dir);
    const r = await fixVersions(dir, opts);
    expect(r.applied).toBe(false);
    expect(r.changes).toEqual([
      { file: BP_MANIFEST, pointer: "/dependencies/0/version", from: "1.11.0", to: "2.3.0", applied: false },
      { file: BP_MANIFEST, pointer: "/dependencies/1/version", from: "1.2.0-beta", to: "2.1.0-beta", applied: false },
      { file: BP_MANIFEST, pointer: "/header/min_engine_version", from: "1.21.0", to: "1.26.60", applied: false },
    ]);
    expect(snapshot(dir)).toEqual(before);
  });

  it("applies a minimal diff that keeps comments and layout", async () => {
    const dir = copy();
    const original = readFileSync(join(dir, BP_MANIFEST), "utf8");
    const r = await fixVersions(dir, { ...opts, apply: true });
    expect(r.changes.every((c) => c.applied)).toBe(true);
    const expected = original
      .replace('"min_engine_version": [1, 21, 0] // raised', '"min_engine_version": [1, 26, 60] // raised')
      .replace('"version": "1.11.0"', '"version": "2.3.0"')
      .replace('"version": "1.2.0-beta"', '"version": "2.1.0-beta"');
    expect(expected).not.toBe(original);
    expect(readFileSync(join(dir, BP_MANIFEST), "utf8")).toBe(expected);
    // Already current: the RP manifest is not touched, and a second run finds nothing.
    expect((await fixVersions(dir, opts)).changes).toEqual([]);
  });

  it("never downgrades", async () => {
    const dir = copy();
    const file = join(dir, BP_MANIFEST);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("[1, 21, 0]", "[1, 30, 0]").replace('"1.11.0"', '"9.0.0"').replace('"1.2.0-beta"', '"9.0.0-beta"'),
    );
    expect((await fixVersions(dir, opts)).changes).toEqual([]);
  });

  it("keeps a beta dependency on beta and a stable one on stable", async () => {
    const r = await fixVersions(copy(), opts);
    const to = Object.fromEntries(r.changes.map((c) => [c.pointer, c.to]));
    expect(to["/dependencies/0/version"]).toBe("2.3.0");
    expect(to["/dependencies/1/version"]).toBe("2.1.0-beta");
  });

  it("moves to a version the game ships when the pin is not in the game yet", async () => {
    const shipped = new Map([
      ["@minecraft/server", new Map<string, string | undefined>([["1.11.0", undefined], ["2.2.0", undefined], ["2.3.0-beta", undefined]])],
      ["@minecraft/server-ui", new Map<string, string | undefined>([["1.2.0-beta", undefined]])],
    ]);
    const r = await fixVersions(copy(), { ...opts, targets: { ...targets, shipped } });
    expect(r.changes.find((c) => c.pointer === "/dependencies/0/version")?.to).toBe("2.2.0");
    expect(r.changes.some((c) => c.pointer === "/dependencies/1/version")).toBe(false);
  });

  it("only suggests format_versions unless asked", async () => {
    const r = await fixVersions(copy(), opts);
    expect(r.suggestions.map((s) => [s.file, s.from, s.to])).toEqual([
      ["BP/entities/mob_bad.json", "1.21.0", "1.26.0"],
      ["BP/entities/mob_ok.json", "1.21.0", "1.26.0"],
    ]);
    expect(r.changes.some((c) => c.pointer === "/format_version")).toBe(false);
  });

  it("moves a format_version the validator accepts and skips one it rejects", async () => {
    const dir = copy();
    const bad = readFileSync(join(dir, "BP/entities/mob_bad.json"), "utf8");
    const r = await fixVersions(dir, { ...opts, apply: true, formatVersions: true });
    expect(r.changes.filter((c) => c.pointer === "/format_version")).toEqual([
      { file: "BP/entities/mob_ok.json", pointer: "/format_version", from: "1.21.0", to: "1.26.0", applied: true },
    ]);
    expect(r.skipped).toMatchObject([{ file: "BP/entities/mob_bad.json", pointer: "/format_version", to: "1.26.0" }]);
    expect(r.skipped[0]?.reason).toMatch(/^invalid under 1\.26\.0: .*value/);
    expect(readFileSync(join(dir, "BP/entities/mob_ok.json"), "utf8")).toContain('"format_version": "1.26.0"');
    expect(readFileSync(join(dir, "BP/entities/mob_bad.json"), "utf8")).toBe(bad);
  });

  it("edits a Regolith project's source packs and leaves rgl's output alone", async () => {
    const dir = join(tmp, "regolith");
    cpSync(FIXTURE, join(dir, "packs"), { recursive: true });
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ name: "steve", packs: { behaviorPack: "./packs/BP", resourcePack: "./packs/RP" }, regolith: { dataPath: "./data", profiles: { default: { filters: [{ filter: "x" }] } } } }),
    );
    const out = join(dir, ".regolith", "tmp");
    mkdirSync(out, { recursive: true });
    cpSync(join(dir, "packs", "BP"), join(out, "BP"), { recursive: true });
    cpSync(join(dir, "packs", "RP"), join(out, "RP"), { recursive: true });
    const built = snapshot(out);
    const r = await fixVersions(dir, { ...opts, apply: true, formatVersions: true });
    expect(r.regolith).toMatch(/source packs/);
    expect(r.changes.map((c) => c.file)).toContain("packs/BP/manifest.json");
    expect(r.changes.every((c) => c.file.startsWith("packs/"))).toBe(true);
    expect(readFileSync(join(dir, "packs", BP_MANIFEST), "utf8")).toContain('"version": "2.3.0"');
    expect(snapshot(out)).toEqual(built);
  });
});
