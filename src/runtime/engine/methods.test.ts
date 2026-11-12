/**
 * The method names this client sends, checked against what the agent routes (`METHODS` in `native/agent/src/lib.rs`
 * and the `dispatch` match in `native/agent-core/src/rpc.rs`) and against the Protocol table of `docs/engine.md`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { METHODS } from "./methods.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** `Method::main("name", …)` / `Method::socket("name", …)` entries of `METHODS`, without the `debug-rpc` ones. */
function agentMethods(): Set<string> {
  const source = read("native/agent/src/lib.rs");
  const table = source.slice(source.indexOf("static METHODS"), source.indexOf("];", source.indexOf("static METHODS")));
  const names = new Set<string>();
  let debugOnly = false;
  for (const line of table.split("\n")) {
    if (line.includes('#[cfg(feature = "debug-rpc")]')) {
      debugOnly = true;
      continue;
    }
    const entry = /Method::(?:main|socket)\("([^"]+)"/.exec(line);
    if (!entry) continue;
    if (!debugOnly) names.add(entry[1] as string);
    debugOnly = false;
  }
  return names;
}

/** The names agent-core answers itself, before it looks in the engine's `METHODS`. */
function coreMethods(): Set<string> {
  const source = read("native/agent-core/src/rpc.rs");
  const start = source.indexOf("match method {", source.indexOf("fn dispatch("));
  const block = source.slice(start, source.indexOf("_ =>", start));
  return new Set([...block.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string));
}

/** Every method named in the first column of the Protocol table. */
function documentedMethods(): Set<string> {
  const doc = read("docs/engine.md");
  const section = doc.slice(doc.indexOf("## Protocol"), doc.indexOf("\n## ", doc.indexOf("## Protocol") + 1));
  const names = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cell = line.split(" | ")[0] as string;
    for (const code of cell.matchAll(/`([^`]+)`/g)) names.add((code[1] as string).split(/[\s{]/)[0] as string);
  }
  return names;
}

describe("agent method names", () => {
  const agent = agentMethods();
  const core = coreMethods();
  const routed = new Set([...agent, ...core]);

  it("reads both routing tables", () => {
    expect(agent.has("screen.act")).toBe(true);
    expect(core.has("engine.status")).toBe(true);
  });

  it("sends only methods the agent routes", () => {
    expect(Object.keys(METHODS).filter((name) => !routed.has(name))).toEqual([]);
  });

  it("documents every method of METHODS, and nothing the agent does not route", () => {
    const documented = documentedMethods();
    expect([...agent].filter((name) => !documented.has(name))).toEqual([]);
    expect([...documented].filter((name) => !routed.has(name))).toEqual([]);
  });
});
