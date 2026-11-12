/** Regolith projects through the validator, with a stand-in rgl (a node script; no real rgl or filter runs). */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateProject } from "./index.ts";

const tmp = mkdtempSync(join(tmpdir(), "sculk-validate-rgl-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Exports packs/BP and packs/RP to the `exact` paths sculkwire sets and prepends a line to the entity (a changing filter). */
const rgl = join(tmp, "rgl");
writeFileSync(
  rgl,
  `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (fs.existsSync("data/FAIL")) {
  console.error("[ERROR] filter failed");
  process.exit(1);
}
const exp = JSON.parse(fs.readFileSync("config.json", "utf8")).regolith.profiles[process.argv[3]].export;
fs.cpSync("packs/BP", exp.bpPath, { recursive: true });
fs.cpSync("packs/RP", exp.rpPath, { recursive: true });
const entity = path.join(exp.bpPath, "entities", "mob.json");
fs.writeFileSync(entity, "// added by a filter\\n" + fs.readFileSync(entity, "utf8"));
`,
);
chmodSync(rgl, 0o755);

function project(name: string, fail = false): string {
  const root = join(tmp, name);
  const manifest = (kind: "data" | "resources", n: number) => ({
    format_version: 2,
    header: { name, description: "", uuid: `0000000${n}-0000-4000-8000-000000000001`, version: [1, 0, 0], min_engine_version: [1, 21, 0] },
    modules: [{ type: kind, uuid: `0000000${n}-0000-4000-8000-000000000002`, version: [1, 0, 0] }],
  });
  mkdirSync(join(root, "packs", "BP", "entities"), { recursive: true });
  mkdirSync(join(root, "packs", "RP"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "packs", "BP", "manifest.json"), JSON.stringify(manifest("data", 1)));
  writeFileSync(join(root, "packs", "RP", "manifest.json"), JSON.stringify(manifest("resources", 2)));
  // A trailing comma: a warning whose position the filter shifts by one line.
  writeFileSync(join(root, "packs", "BP", "entities", "mob.json"), '{\n  "format_version": "1.21.0",\n}\n');
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({ name, packs: { behaviorPack: "./packs/BP", resourcePack: "./packs/RP" }, regolith: { dataPath: "./data", profiles: { default: { filters: [{ filter: "x" }] } } } }),
  );
  if (fail) writeFileSync(join(root, "data", "FAIL"), "");
  return root;
}

describe("validate_pack on a Regolith project", () => {
  it("validates the build output under the source paths and says when a filter changed the file", async () => {
    const r = await validateProject(project("built"), { checks: ["json"], rglPath: rgl });
    expect(r.regolith).toEqual({ profile: "default", built: true });
    const comma = r.diagnostics.find((d) => d.code === "json.trailing-comma");
    expect(comma).toMatchObject({ file: "packs/BP/entities/mob.json", range: { start: { line: 3 } } });
    expect(comma?.message).toContain("[changed by Regolith filters; position refers to the build output]");
  });

  it("reports a failed rgl run as an error on config.json", async () => {
    const r = await validateProject(project("failed", true), { checks: ["json"], rglPath: rgl });
    expect(r.regolith).toMatchObject({ profile: "default", built: false, message: expect.stringMatching(/^rgl run default failed: .*filter failed/s) });
    expect(r.diagnostics.find((d) => d.code === "regolith.build-failed")).toMatchObject({ severity: "error", source: "manifest", file: "config.json" });
    expect(r.ok).toBe(false);
  });

  it("validates the source packs with an info when the build is skipped", async () => {
    const r = await validateProject(project("source"), { checks: ["json"], rglPath: rgl, regolith: "source" });
    expect(r.regolith).toEqual({ profile: "default", built: false, message: "build skipped (regolith: source)" });
    expect(r.diagnostics.find((x) => x.code === "regolith.not-built")).toMatchObject({ severity: "info", source: "manifest", file: "config.json" });
    expect(r.diagnostics.find((x) => x.code === "json.trailing-comma")).toMatchObject({ file: "packs/BP/entities/mob.json", range: { start: { line: 2 } } });
  });
});
