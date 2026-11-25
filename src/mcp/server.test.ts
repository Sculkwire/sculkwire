import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
      // Every documented tool is registered and every registered tool is documented, so a dropped feature fails here.
      const documented = [...readFileSync(fileURLToPath(new URL("../../docs/tools.md", import.meta.url)), "utf8").matchAll(/^### (\S+)\s*$/gm)].map((m) => m[1]);
      expect([...byName.keys()].sort()).toEqual(documented.sort());
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

/** A connected client of `createServer(env)`, closed by the returned `close`. */
async function connect(env: NodeJS.ProcessEnv): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = await createServer(env);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The tools `docs/tools.md` documents between two `## ` headings. */
function documentedBetween(from: string, to: string): string[] {
  const doc = readFileSync(fileURLToPath(new URL("../../docs/tools.md", import.meta.url)), "utf8");
  const section = doc.slice(doc.indexOf(`\n## ${from}\n`), doc.indexOf(`\n## ${to}\n`));
  return [...section.matchAll(/^### (\S+)\s*$/gm)].map((m) => m[1] ?? "");
}

describe("SCULKWIRE_TOOLSETS", () => {
  it("lists only the tools of the named toolsets, and still every prompt", async () => {
    const { client, close } = await connect({ ...process.env, SCULKWIRE_TOOLSETS: "knowledge, validate" });
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual(documentedBetween("Knowledge", "Bedrock Dedicated Server").sort());
      expect(names).toContain("docs_search");
      expect(names).toContain("validate_pack");
      expect((await client.listPrompts()).prompts).toHaveLength(4);
    } finally {
      await close();
    }
  });

  it("refuses an unknown toolset and names the valid ones", async () => {
    await expect(createServer({ ...process.env, SCULKWIRE_TOOLSETS: "knowledge,gaem" })).rejects.toThrow(
      'SCULKWIRE_TOOLSETS: unknown toolset "gaem"; valid: knowledge, validate, bds, game, engine, gamefiles, update',
    );
  });
});

describe("prompts", () => {
  it("lists the four flows and fills their arguments into exact tool calls", async () => {
    const { client, close } = await connect(process.env);
    try {
      expect(client.getServerCapabilities()?.prompts).toBeDefined();
      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name).sort()).toEqual(["debug_pack_errors", "new_content", "playtest_feature", "test_on_server"]);
      const playtest = prompts.find((prompt) => prompt.name === "playtest_feature");
      expect(playtest?.arguments?.map((arg) => [arg.name, arg.required ?? false])).toEqual([
        ["project", true],
        ["feature", true],
        ["scene", false],
      ]);

      const text = async (name: string, args: Record<string, string>) => {
        const { messages } = await client.getPrompt({ name, arguments: args });
        const content = messages[0]?.content;
        return content?.type === "text" ? content.text : "";
      };
      const played = await text("playtest_feature", { project: "/packs/My Addon", feature: "the zombie drops a gem", scene: "arena" });
      expect(played).toContain('game_launch {"project": "/packs/My Addon", "keep": true}');
      expect(played).toContain('scene_reset {"name": "arena"}');
      expect(played).toContain("the zombie drops a gem");
      // Without a scene the default name is used.
      expect(await text("playtest_feature", { project: "p", feature: "f" })).toContain('scene_save {"name": "playtest"}');
      expect(await text("debug_pack_errors", { project: "p" })).toContain('game_reload {"all": true}');
      expect(await text("test_on_server", { project: "p" })).toContain('gametest_run {"path": "p"}');
      expect(await text("new_content", { project: "p", what: "a ruby block" })).toContain('pack_fix_versions {"path": "p"}');
      // A required argument left out is refused.
      await expect(client.getPrompt({ name: "new_content", arguments: { project: "p" } })).rejects.toThrow();
    } finally {
      await close();
    }
  });
});

// A kernel pipe needs a shell: Node connects its own children through socket pairs, whose buffers hold the whole answer.
describe.skipIf(process.platform === "win32")("sculk mcp over stdio", () => {
  it("answers the requests a client wrote before closing stdin, even to a reader slower than the pipe buffer", async () => {
    // The ~100 KB tools/list answer does not fit the pipe buffer (64 KB), so most of it waits in the server's stdout
    // until the reader drains the pipe. The reader starts after 2 s: a server that exits before its stdout drained has
    // lost the rest by then. Real time on purpose: the backpressure is the kernel's, no fake clock reaches it.
    const reader = "setTimeout(() => process.stdin.pipe(process.stdout), 2000)";
    const pipeline = '{ "$0" "$1" mcp 2>/dev/null; echo "server exit $?" >&2; } | "$0" -e "$2"';
    const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
    const env = {
      ...process.env,
      SCULKWIRE_CACHE: join(config, "cache"),
      SCULKWIRE_DATA: join(config, "data"),
      SCULKWIRE_AUTO_UPDATE: "0",
    };
    const shell = spawn("/bin/sh", ["-c", pipeline, process.execPath, cli, reader], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    shell.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
    });
    shell.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      err += chunk;
    });
    const closed = once(shell, "close");
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    shell.stdin.end(requests.map((message) => `${JSON.stringify(message)}\n`).join(""));
    await closed;
    expect(err).toContain("server exit 0");
    const answers = out
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } });
    expect(answers.map((answer) => answer.id)).toEqual([1, 2]);
    expect(answers[1]?.result?.tools?.map((tool) => tool.name)).toContain("docs_search");
  }, 60_000);
});
