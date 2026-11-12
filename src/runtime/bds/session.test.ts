import { describe, expect, it } from "vitest";
import type { IndexedPack } from "../gamelog/logparse.ts";
import { sessionPacks } from "./session.ts";

function indexed(relDirs: string[]): IndexedPack[] {
  return relDirs.map((relDir, i) => ({
    pack: { kind: "behavior", dir: `/projects/addon/${relDir}`, relDir, name: `Pack ${i}` },
    files: [],
    identifiers: new Map(),
    texts: new Map(),
  }));
}

describe("session packs", () => {
  it("reports a pack that is the project folder itself as `.`", () => {
    expect(sessionPacks(indexed([""]))).toEqual([{ name: "Pack 0", kind: "behavior", path: "." }]);
  });

  it("keeps a sub-folder pack's project-relative path", () => {
    expect(sessionPacks(indexed(["BP", "packs/RP"])).map((p) => p.path)).toEqual(["BP", "packs/RP"]);
  });
});
