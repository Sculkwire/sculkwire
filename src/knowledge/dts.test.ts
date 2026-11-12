import { describe, expect, it } from "vitest";
import { parseDts } from "./dts.ts";

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
