import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOptions, removeOptions, restoreOptions, setOptions } from "./options.ts";

let dir: string;
let savedData: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sculk-options-"));
  savedData = process.env.SCULKWIRE_DATA;
  process.env.SCULKWIRE_DATA = join(dir, "data");
});
afterEach(async () => {
  if (savedData === undefined) delete process.env.SCULKWIRE_DATA;
  else process.env.SCULKWIRE_DATA = savedData;
  await rm(dir, { recursive: true, force: true });
});

describe("options.txt line endings", () => {
  it("keeps CRLF, LF and a missing final newline", () => {
    expect(applyOptions("a:0\r\nb:1\r\n", { a: "1", c: "2" })).toBe("a:1\r\nb:1\r\nc:2\r\n");
    expect(applyOptions("a:0\nb:1", { a: "1" })).toBe("a:1\nb:1");
    expect(removeOptions("a:1\r\nc:2\r\n", ["c"])).toBe("a:1\r\n");
    expect(removeOptions("c:2\n", ["c"])).toBe("");
  });

  it.each([
    ["CRLF", "gfx_vsync:1\r\nwebsockets_enabled:0\r\nmp_username:Steve\r\n"],
    ["LF", "gfx_vsync:1\nwebsockets_enabled:0\nmp_username:Steve\n"],
    ["LF without a final newline", "gfx_vsync:1\nwebsockets_enabled:0"],
  ])("restores a %s file byte for byte", async (_, original) => {
    const file = join(dir, "options.txt");
    await writeFile(file, original);
    await setOptions([file], { websockets_enabled: "1", script_debugger_port: "19151" });
    const changed = await readFile(file, "utf8");
    expect(changed).toContain("websockets_enabled:1");
    expect(changed.includes("\r\n")).toBe(original.includes("\r\n"));
    await restoreOptions();
    expect(await readFile(file, "utf8")).toBe(original);
  });
});
