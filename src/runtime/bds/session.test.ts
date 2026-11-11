import { describe, expect, it } from "vitest";
import { info, type BdsSession } from "./session.ts";

function fakeSession(relDirs: string[]): BdsSession {
  return {
    id: "s1",
    projectRoot: "/projects/addon",
    server: { state: "running", serverVersion: "1.26.60.30" },
    instance: { dir: "/tmp/bds-s1", port: 19132, install: { version: "1.26.60.30" } },
    indexed: relDirs.map((relDir, i) => ({ pack: { kind: "behavior", dir: `/projects/addon/${relDir}`, relDir, name: `Pack ${i}` } })),
    debuggerPort: 19144,
    startedAt: 0,
  } as unknown as BdsSession;
}

describe("session info", () => {
  it("reports a pack that is the project folder itself as `.`", () => {
    expect(info(fakeSession([""])).packs).toEqual([{ name: "Pack 0", kind: "behavior", path: "." }]);
  });

  it("keeps a sub-folder pack's project-relative path", () => {
    expect(info(fakeSession(["BP", "packs/RP"])).packs.map((p) => p.path)).toEqual(["BP", "packs/RP"]);
  });
});
