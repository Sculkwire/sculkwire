import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Every module `file` loads at runtime (type-only imports are erased), and the bare specifiers among them. */
function closure(file: string, seen = new Set<string>(), bare = new Set<string>()): { files: Set<string>; bare: Set<string> } {
  if (seen.has(file)) return { files: seen, bare };
  seen.add(file);
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+"([^"]+)"/gm)) {
    const spec = m[1]!;
    if (spec.startsWith(".")) closure(resolve(dirname(file), spec), seen, bare);
    else bare.add(spec);
  }
  for (const m of text.matchAll(/createRequire\(import\.meta\.url\)\("([^"]+)"\)/g)) if (!m[1]!.endsWith(".json")) bare.add(m[1]!);
  return { files: seen, bare };
}

describe("bootstrap.ts", () => {
  // install.sh and install.ps1 run it from a fresh clone, before `npm ci`: only Node built-ins may load.
  it("loads no dependency from node_modules", () => {
    const { files, bare } = closure(fileURLToPath(new URL("./bootstrap.ts", import.meta.url)));
    expect(files.size).toBeGreaterThan(1);
    expect([...bare].filter((spec) => !spec.startsWith("node:"))).toEqual([]);
  });
});
