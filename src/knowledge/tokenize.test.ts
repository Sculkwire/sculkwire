import { describe, expect, it } from "vitest";
import { parseDts } from "./dts.ts";
import { chunkMarkdown, SearchIndex } from "./search.ts";
import { stem, tokenize } from "./tokenize.ts";

describe("tokenize", () => {
  it("keeps namespaced ids whole and splits them", () => {
    const t = tokenize("Use minecraft:behavior.tempt here");
    expect(t).toEqual(expect.arrayContaining(["minecraft:behavior.tempt", "behavior.tempt", "minecraft", "behavior", "tempt", "use"]));
    expect(t).not.toContain("here.");
  });
  it("splits camelCase and snake_case but keeps the whole identifier", () => {
    expect(tokenize("getComponent")).toEqual(expect.arrayContaining(["getcomponent", "get", "component"]));
    expect(tokenize("EntityHealthComponent")).toEqual(
      expect.arrayContaining(["entityhealthcomponent", "entity", "health", "component"]),
    );
    expect(tokenize("query.is_baby")).toEqual(expect.arrayContaining(["query.is_baby", "is_baby", "baby"]));
  });
  it("drops stop words and trailing sentence punctuation", () => {
    expect(tokenize("The mob. Then it runs")).toEqual(["mob", "then", "runs"]);
  });
  it("stems plain plurals consistently", () => {
    expect(stem("properties")).toBe("property");
    expect(stem("entities")).toBe("entity");
    expect(stem("class")).toBe("class");
    expect(stem("status")).toBe("status");
    expect(tokenize("dynamic properties")).toEqual(tokenize("dynamic property"));
  });
});

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

describe("parseDts", () => {
  const dts = [
    "/**",
    " * Represents an entity.",
    " */",
    "export class Entity {",
    "    private constructor();",
    "    /**",
    "     * @remarks",
    "     * Applies damage.",
    "     *",
    "     * @param amount",
    "     * Amount of damage.",
    "     * @returns",
    "     * Whether damage was taken.",
    "     * @throws This function can throw errors.",
    "     */",
    "    applyDamage(amount: number): boolean;",
    "    /**",
    "     * @beta",
    "     */",
    "    readonly options: {",
    "        a: number;",
    "    };",
    "}",
    "export class Player extends Entity {",
    "    readonly name: string;",
    "}",
    "export enum Mode {",
    "    Angle = 'Angle',",
    "    Distance = 'Distance',",
    "}",
    "export const world: World;",
    "export type Map = {",
    "    a: string;",
    "};",
  ].join("\r\n");
  const syms = parseDts(dts, "@minecraft/server");
  const by = (name: string) => syms.find((s) => s.name === name);

  it("parses containers, members and docs (CRLF input)", () => {
    expect(by("Entity")).toMatchObject({ kind: "class", signature: "class Entity", doc: { summary: "Represents an entity." } });
    expect(by("Entity.constructor")?.kind).toBe("constructor");
    expect(by("Entity.applyDamage")).toMatchObject({
      kind: "method",
      signature: "applyDamage(amount: number): boolean",
      doc: {
        summary: "Applies damage.",
        params: [{ name: "amount", text: "Amount of damage." }],
        returns: "Whether damage was taken.",
        beta: false,
      },
    });
    expect(by("Entity.options")).toMatchObject({ kind: "property", doc: { beta: true } });
    expect(by("Entity.options")?.signature).toContain("a: number;");
  });
  it("records bases, enum members, variables and type aliases", () => {
    expect(by("Player")?.bases).toEqual(["Entity"]);
    expect(by("Mode.Distance")?.kind).toBe("enumMember");
    expect(by("world")).toMatchObject({ kind: "variable", signature: "const world: World" });
    expect(by("Map")?.kind).toBe("type");
  });
});
