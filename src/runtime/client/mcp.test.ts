/** The client tools' results: `game_input` reports the route its input took, and the result fits its output schema. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { engine } from "../engine/engine.ts";
import type { EngineResult } from "../engine/failure.ts";
import { bridge } from "./bridge.ts";
import { register } from "./mcp.ts";
import { createWorld } from "./world.ts";
import type { ClientInstall } from "../../gamefiles/install.ts";

type Handler = (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;
interface Tool {
  config: { outputSchema?: z.ZodRawShape };
  handler: Handler;
}

function tools(): Map<string, Tool> {
  const out = new Map<string, Tool>();
  const server = { registerTool: (name: string, config: Tool["config"], handler: Handler) => void out.set(name, { config, handler }) };
  register(server as unknown as McpServer);
  return out;
}

/** Call a tool and check its structured result against the tool's own output schema. */
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = tools().get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  const result = await tool.handler(args);
  if (result.isError || !result.structuredContent) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  return z.object(tool.config.outputSchema ?? {}).strict().parse(result.structuredContent);
}

const attachedEngine = (attached: boolean) => Object.defineProperty(engine, "attached", { get: () => attached, configurable: true });

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(engine, "attached");
});

describe("game_input", () => {
  it("reports the engine route when the agent's UI takes the input", async () => {
    attachedEngine(true);
    const keys: string[] = [];
    vi.spyOn(engine, "uiKey").mockImplementation(async (chord: string) => {
      keys.push(chord);
      return { ok: true, value: {} } as EngineResult<never>;
    });
    const input = vi.spyOn(bridge, "input");
    expect(await call("game_input", { action: "key", keys: "t Escape" })).toEqual({ done: true, route: "engine" });
    expect(keys).toEqual(["t", "Escape"]);
    expect(input).not.toHaveBeenCalled();
  });

  it("reports the keyboard route the bridge took when the agent has no call for the action", async () => {
    attachedEngine(true);
    const input = vi.spyOn(bridge, "input").mockResolvedValue("gamescope");
    // A mouse move has no ui.* call, so it goes the keyboard and mouse route even with the agent attached.
    expect(await call("game_input", { action: "move", x: 10, y: 20 })).toEqual({ done: true, route: "gamescope" });
    expect(input).toHaveBeenCalledWith({ action: "move", x: 10, y: 20 });
    attachedEngine(false);
    input.mockResolvedValue("windows");
    expect(await call("game_input", { action: "click", x: 5, y: 6, button: 3 })).toEqual({ done: true, route: "windows" });
    expect(input).toHaveBeenLastCalledWith({ action: "click", x: 5, y: 6, button: 3 });
  });
});

describe("game_registry", () => {
  it("returns the source with the entries", async () => {
    vi.spyOn(bridge, "registry").mockResolvedValue({ kind: "mob", source: "script", entries: ["minecraft:pig"], note: "no /connect client attached" });
    expect(await call("game_registry", { kind: "mob" })).toEqual({ kind: "mob", source: "script", entries: ["minecraft:pig"], note: "no /connect client attached" });
  });
});

describe("game_worlds", () => {
  it("marks the world the bridge has loaded and refuses to delete it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sculkwire-mcp-worlds-"));
    const install = { label: "fake", userComMojang: dir, sharedComMojang: dir } as ClientInstall;
    try {
      const loaded = await createWorld(install, { name: "bridge", helper: false });
      await createWorld(install, { name: "other", helper: false });
      bridge.install = install;
      bridge.world = loaded;
      vi.spyOn(bridge, "running", "get").mockReturnValue(true);
      const listed = (await call("game_worlds", {})).worlds as { name: string; loaded: boolean; sculkwire: boolean }[];
      expect(listed.map((w) => [w.name, w.sculkwire, w.loaded]).sort()).toEqual([
        ["sculkwire-bridge", true, true],
        ["sculkwire-other", true, false],
      ]);
      const refused = await tools().get("game_worlds")?.handler({ action: "delete", world: "bridge" });
      expect(refused?.isError).toBe(true);
      expect(JSON.stringify(refused)).toContain("loaded by the running game");
      expect(await call("game_worlds", { action: "delete", world: "other" })).toEqual({
        deleted: { world: "sculkwire-other", existed: true, levelIds: ["sculkwire-other"] },
      });
      expect((await call("game_worlds", {})).worlds).toHaveLength(1);
    } finally {
      bridge.install = undefined;
      bridge.world = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
