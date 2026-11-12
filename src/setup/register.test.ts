import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseClients, registerOmp } from "./register.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sculk-register-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("client registration", () => {
  it("adds sculkwire to omp's config, keeps other servers and a backup", async () => {
    const path = join(root, "omp", "mcp.json");
    await mkdir(join(root, "omp"), { recursive: true });
    const original = { mcpServers: { other: { type: "stdio", command: "other" }, sculkwire: { command: "old" } }, extra: true };
    await writeFile(path, JSON.stringify(original));
    const entry = { type: "stdio" as const, command: "/x/bin/sculk", args: ["mcp"] };
    expect(await registerOmp(entry, path)).toEqual({ path, backup: `${path}.bak` });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: { other: { type: "stdio", command: "other" }, sculkwire: entry }, extra: true });
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8"))).toEqual(original);
  });

  it("creates omp's config when missing and leaves an invalid one alone", async () => {
    const path = join(root, "new", "mcp.json");
    const entry = { type: "stdio" as const, command: "sculk", args: ["mcp"] };
    expect(await registerOmp(entry, path)).toEqual({ path });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: { sculkwire: entry } });
    await writeFile(path, "{ broken");
    await expect(registerOmp(entry, path)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{ broken");
  });

  it("parses client lists", () => {
    const names = (value: string) => {
      const clients = parseClients(value);
      return typeof clients === "string" ? clients : clients.map((c) => c.name);
    };
    expect(names("omp, claude,omp")).toEqual(["omp", "claude"]);
    expect(names("none")).toEqual([]);
    expect(parseClients("cursor")).toMatch(/unknown client cursor/);
  });
});
