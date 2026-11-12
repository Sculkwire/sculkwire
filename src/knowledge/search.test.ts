import { describe, expect, it } from "vitest";
import { chunkMarkdown, SearchIndex } from "./search.ts";

describe("SearchIndex", () => {
  const index = SearchIndex.build("k", [
    { id: "1", title: "Tempt", heading: "AI Goals", text: '"minecraft:behavior.tempt": { "items": ["wheat"] }' },
    { id: "2", title: "Entity", heading: "Methods", text: "getComponent(componentId: string): EntityComponent" },
    { id: "3", title: "Misc", heading: "", text: "The minecraft namespace is used by vanilla behavior packs." },
  ]);
  it("finds identifiers by their whole form and parts", () => {
    expect(index.search("minecraft:behavior.tempt", { limit: 1 })[0]?.doc.id).toBe("1");
    expect(index.search("getComponent", { limit: 1 })[0]?.doc.id).toBe("2");
    expect(index.search("component", { limit: 3 }).map((h) => h.doc.id)).toContain("2");
  });
});

describe("chunkMarkdown", () => {
  it("tracks the heading trail and ignores headings inside code fences", () => {
    const chunks = chunkMarkdown("# A\nintro\n## B\n```\n# not a heading\n```\ntext\n### C\nmore");
    expect(chunks.map((c) => c.heading)).toEqual(["A", "A > B", "A > B > C"]);
    expect(chunks[1]?.text).toContain("# not a heading");
  });
});
