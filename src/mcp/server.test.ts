import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "./server.ts";

let config: string;
beforeAll(() => {
  // No extension of this machine: only the built-in tools are listed.
  config = mkdtempSync(join(tmpdir(), "sculk-mcp-"));
  vi.stubEnv("SCULKWIRE_CONFIG", config);
  vi.stubEnv("SCULKWIRE_EXTENSIONS", "");
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(config, { recursive: true, force: true });
});

describe("tools/list", () => {
  it("answers with every built-in tool, a recursive output shape written as a JSON Schema reference", async () => {
    const server = await createServer();
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      expect(byName.size).toBe(tools.length);
      for (const name of ["docs_search", "validate_pack", "engine_status", "sculkwire_version"]) expect(byName.has(name), name).toBe(true);
      // An item slot holds item slots (a bundle, a shulker box): every tool that returns slots refers to one definition.
      for (const name of ["player_inventory", "container", "craft", "screen"]) {
        const schema = byName.get(name)?.outputSchema;
        expect(schema?.type, name).toBe("object");
        expect(JSON.stringify(schema), name).toContain('"$ref"');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
