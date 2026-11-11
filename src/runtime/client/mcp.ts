import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatDiagnostic, summarize, type Diagnostic } from "../../core/diagnostic.ts";
import { dataDir } from "../../core/paths.ts";
import { onShutdown } from "../../core/shutdown.ts";
import { bridge, type BridgeStatus } from "./bridge.ts";
import { inputProvider } from "./inputprovider.ts";
import { engine, type EngineResult } from "../engine/engine.ts";
import { type EntityInfo, type Loadout, type PlayerAction } from "./player.ts";
import { play, PLAY_DEFAULT_DURATION_MS, PLAY_DEFAULT_STEP_MS, PLAY_MAX_DURATION_MS, type Death, type PlayAction, type PlayResult } from "./skills/play.ts";
import { TACTICS } from "./skills/tactics.ts";
import { pauseOnTakeover, playJobs, runActions, stepText, type PlayJobInfo } from "./jobs.ts";
import { DIFFICULTIES, type Difficulty } from "./world.ts";
import { FOREGROUND_MESSAGE } from "./windows.ts";
import type { InputRoute } from "./launcher.ts";
import { loadDecisionModel } from "../../decision/config.ts";

const position = z.object({ line: z.number(), column: z.number() });
const diagnosticSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: z.string(),
  source: z.string(),
  file: z.string().optional(),
  range: z.object({ start: position, end: position }).optional(),
  hint: z.string().optional(),
});
const summarySchema = z.object({ errors: z.number(), warnings: z.number(), infos: z.number() });
const statusSchema = {
  running: z.boolean(),
  mode: z.enum(["window", "headless", "desktop"]).optional(),
  version: z.string().optional(),
  install: z.string().optional(),
  world: z.string().optional(),
  project: z.string().optional(),
  packs: z.array(
    z.object({
      name: z.string().optional(),
      uuid: z.string(),
      kind: z.string(),
      folder: z.string().optional(),
      path: z.string().optional(),
      built: z.boolean(),
    }),
  ),
  debugger: z.object({ attached: z.boolean(), port: z.number().optional(), protocolVersion: z.number().optional(), plugins: z.array(z.string()).optional() }),
  connect: z.object({ clients: z.number(), port: z.number().optional(), method: z.enum(["automatic", "chat"]).optional() }),
  ready: z.boolean(),
  manualSteps: z.array(z.string()),
  gameExited: z.boolean().optional(),
  deployDiagnostics: z.array(diagnosticSchema).optional(),
  joinRecovery: z
    .object({
      attempts: z.number(),
      recovered: z.boolean(),
      via: z.string().optional(),
      log: z.string().optional(),
      screenshot: z.string().optional(),
    })
    .optional(),
};
const commandSchema = {
  command: z.string(),
  via: z.enum(["connect", "debugger"]),
  ok: z.boolean(),
  output: z.array(z.string()),
  statusCode: z.number().optional(),
  body: z.record(z.string(), z.unknown()).optional(),
};

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(text: string, structured: object): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: { ...structured } };
}

function fail(err: unknown): ToolResult {
  return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
}

function diagText(diagnostics: readonly Diagnostic[], max = 20): string {
  const lines = diagnostics.slice(0, max).map(formatDiagnostic);
  if (diagnostics.length > max) lines.push(`… ${diagnostics.length - max} more`);
  return lines.join("\n");
}

/**
 * Take a `game_input` action through the agent's own UI when it is attached: one `ui.key` per chord, `ui.text` into
 * the focused box, `ui.click` in screenshot pixels (left, or right for button 3). False when this action has no `ui.*`
 * call, so the caller keeps its own route: a mouse move, a middle click, or nothing to send.
 */
async function inputThroughUi(a: {
  action: "key" | "type" | "click" | "move";
  keys?: string;
  text?: string;
  x?: number;
  y?: number;
  button?: 1 | 2 | 3;
}): Promise<boolean> {
  if (!engine.attached) return false;
  const sent = (result: EngineResult<unknown>): true => {
    if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
    return true;
  };
  if (a.action === "key") {
    const chords = (a.keys ?? "").split(/\s+/).filter(Boolean);
    for (const chord of chords) sent(await engine.uiKey(chord));
    return chords.length > 0;
  }
  if (a.action === "type") return a.text ? sent(await engine.uiText(a.text)) : false;
  if (a.action === "click" && a.x !== undefined && a.y !== undefined && a.button !== 2) {
    return sent(await engine.uiClick(a.x, a.y, a.button === 3 ? "right" : "left"));
  }
  return false;
}

function statusText(s: BridgeStatus): string {
  if (s.gameExited) return `client not running: ${s.manualSteps.join("; ")}`;
  if (!s.running) return "client not running";
  const parts = [
    `${s.mode} client ${s.version ?? ""} in world ${s.world ?? "?"}`,
    `debugger ${s.debugger.attached ? `attached (protocol ${s.debugger.protocolVersion ?? "?"})` : "not attached"}`,
    `/connect clients ${s.connect.clients}`,
  ];
  for (const step of s.manualSteps) parts.push(`manual: ${step}`);
  if (s.packs.length) {
    const packs = s.packs.map((p) => {
      const where = p.folder ? `${p.folder}${p.path ? ` at ${p.path}` : ""}` : "not deployed";
      return `${p.kind} ${where}${p.built ? " (built)" : ""}`;
    });
    parts.push(`packs ${packs.join(", ")}`);
  }
  for (const d of s.deployDiagnostics ?? []) parts.push(formatDiagnostic(d));
  if (s.joinRecovery) {
    const r = s.joinRecovery;
    parts.push(
      r.recovered
        ? `recovered the sign-in join race after ${r.attempts} press(es)${r.via ? ` (${r.via})` : ""}`
        : `sign-in join race not recovered after ${r.attempts} attempt(s)`,
    );
  }
  return parts.join("; ");
}

type ActionResultOut = { action: string; ok: boolean; message: string; durationMs: number; input?: "engine" | "keyboard" };
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Longest a `player_job wait` blocks, under the 30 s many MCP clients allow one call. */
const JOB_WAIT_MAX_MS = 25_000;

/** Send an MCP progress notification when the request asked for them (it carries a progressToken). */
function notifyProgress(extra: Extra, progress: number, total: number | undefined, message: string): void {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  void extra
    .sendNotification({ method: "notifications/progress", params: { progressToken, progress, ...(total !== undefined ? { total } : {}), message } })
    .catch(() => undefined);
}

/** Stop reason, combat numbers, latency and the last few tactics of a `play` run. */
function playText(p: PlayResult): string {
  const s = p.stats;
  const killed = Object.entries(s.killed).map(([t, n]) => `${n} ${t}`).join(", ");
  const lines = [
    `play stopped by ${p.stoppedBy} after ${p.steps} tactic(s) in ${(p.durationMs / 1000).toFixed(1)} s: ${p.message}`,
    `goal (${p.goalCheck.kind}): ${p.goalCheck.progress}`,
    `kills ${s.kills}${killed ? ` (${killed})` : ""}, hits ${s.hits} (${s.crits} critical) of ${s.swings} swings, damage taken ${s.damageTaken}, deaths ${s.deaths}${s.health !== undefined ? `, health ${s.health}` : ""}`,
    `advisor ${p.model}, ${s.decisions} decisions, advisor latency median ${p.latency.medianMs} ms, p90 ${p.latency.p90Ms} ms` +
      (p.advice.answered ? `, answered ${p.advice.answered}, used ${p.advice.used}, differed from the built-in choice ${p.advice.differed}` : ""),
  ];
  for (const t of p.trace.slice(-5)) lines.push(`  ${stepText(t)}`);
  return lines.join("\n");
}

function jobText(j: PlayJobInfo): string {
  const head = `${j.id} ${j.status}${j.stopReason ? ` (${j.stopReason})` : ""}: "${j.goal}"`;
  if (j.result) return `${head}\n${playText(j.result)}`;
  const p = j.progress;
  const lines = [
    `${head}, ${p.steps} step(s) in ${(p.elapsedMs / 1000).toFixed(1)} s, decision latency median ${p.latency.medianMs} ms, p90 ${p.latency.p90Ms} ms`,
    ...p.lastActions.map((a) => `  ${a}`),
  ];
  if (j.error) lines.push(`error: ${j.error}`);
  return lines.join("\n");
}

let shutdownHooked = false;

export function register(server: McpServer): void {
  if (!shutdownHooked) {
    shutdownHooked = true;
    onShutdown(async () => {
      await playJobs.stopAll("the MCP server is shutting down");
      // An exited game still has a launch to clean up (listeners, options, deployed packs).
      if (bridge.launchState) await bridge.stop();
    });
  }
  server.registerTool(
    "game_launch",
    {
      title: "Launch the Bedrock client",
      description:
        "Start the real Minecraft Bedrock client (any install sculkwire finds such as Windows, mcbe-gdk-installer, a Wine " +
        "or Proton prefix like Flarial, or SCULKWIRE_MINECRAFT_DIR) in a fresh `sculkwire-` test world with the project's " +
        "packs and the sculkwire helper pack active. The world is flat and creative, has cheats on, and keeps time and " +
        "weather frozen. Attaches the script debugger automatically. Display modes: `window` (the default) is a visible " +
        "gamescope window on Linux and the game's own window on Windows, where screenshots, input and /connect work; " +
        "`headless` runs without a window and muted on Linux (Windows has no gamescope, so it runs the window and the " +
        "result says so); `desktop` uses the launcher's normal window (on Windows the same as `window`). On Linux the " +
        "agent's input stays inside gamescope; on Windows it uses the system keyboard and mouse while the game window is " +
        "in the foreground and stops when the user switches away. Only " +
        "the chosen install's game is managed, so a game the user plays from another launcher is left alone. A Regolith " +
        "project whose profile runs filters is built with rgl first and the built packs are deployed. The result lists " +
        "each deployed pack folder and its absolute path. Returns once the world is loaded, in 1-2 minutes. If the world " +
        "join races Microsoft sign-in and the game stops on \"You need to authenticate to Microsoft services\", it " +
        "walks the menus back into the test world without relaunching, and game_status reports joinRecovery. When sculkwire " +
        "cannot start the game itself it returns right away with manualSteps for the user, and game_status shows when " +
        "the game is ready.",
      inputSchema: {
        project: z.string().optional().describe("Add-on project or pack directory to activate in the world. A Regolith project whose profile runs filters is built with rgl and its built packs are deployed"),
        deploy: z.boolean().optional().describe("Copy the project's packs into development_*_packs, also over the project's sculkwire_* folder an earlier launch left. Default true. Packs rgl already exported are reused, but a fresh rgl build is always deployed. Off: only folders that already serve a pack's uuid are used"),
        display: z
          .enum(["window", "headless", "desktop"])
          .optional()
          .describe("window: a visible gamescope window on Linux, the game's own window on Windows (default). headless: no window and muted on Linux; Windows runs the window instead. desktop: the launcher's own window (on Windows the same as window)"),
        mute: z.boolean().optional().describe("Silence the game's audio (Linux: a silent sink; Windows: the game's audio sessions, unmuted again by game_stop). Defaults to on in headless mode only"),
        world: z.string().optional().describe("World name, prefixed with sculkwire- (default bridge, replaced each launch)"),
        difficulty: z
          .enum(Object.keys(DIFFICULTIES) as [Difficulty, ...Difficulty[]])
          .optional()
          .describe("World difficulty (default normal). Peaceful removes hostile mobs such as zombies"),
        betaApis: z.boolean().optional().describe("Enable the Beta APIs experiment"),
        width: z.number().int().min(320).max(3840).optional(),
        height: z.number().int().min(240).max(2160).optional(),
        fps: z.number().int().min(10).max(240).optional().describe("Frame rate in window and headless modes (default 60)"),
      },
      outputSchema: statusSchema,
    },
    async (a) => {
      try {
        await playJobs.stopAll("game_launch restarts the game");
        const s = await bridge.start({
          ...(a.project ? { project: a.project } : {}),
          ...(a.deploy !== undefined ? { deploy: a.deploy } : {}),
          ...(a.display ? { mode: a.display } : {}),
          ...(a.mute !== undefined ? { mute: a.mute } : {}),
          ...(a.world ? { world: a.world } : {}),
          ...(a.difficulty ? { difficulty: a.difficulty } : {}),
          ...(a.betaApis ? { betaApis: true } : {}),
          ...(a.width ? { width: a.width } : {}),
          ...(a.height ? { height: a.height } : {}),
          ...(a.fps ? { fps: a.fps } : {}),
        });
        return ok(statusText(s), s);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_status",
    {
      title: "Client bridge status",
      description: "Whether the client runs, which world and packs are active, and which channels (debugger, /connect) are attached.",
      inputSchema: {},
      outputSchema: statusSchema,
    },
    async () => {
      const s = bridge.status();
      return ok(statusText(s), s);
    },
  );

  server.registerTool(
    "game_command",
    {
      title: "Run a game command",
      description:
        "Run a slash command in the running client. Uses /connect when attached (structured status and body), else the " +
        "script debugger (server commands; output from the game's prints, `ok` false when a line is one of the game's " +
        "failure messages such as `No targets matched selector`).",
      inputSchema: {
        command: z.string().describe("Command line, with or without the leading slash"),
        via: z.enum(["auto", "connect", "debugger"]).optional(),
      },
      outputSchema: commandSchema,
    },
    async ({ command, via }) => {
      try {
        const r = await bridge.command(command, via ?? "auto");
        return ok(`${r.ok ? "ok" : "failed"} via ${r.via}: ${r.output.join("\n") || "(no output)"}`, r);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_reload",
    {
      title: "Reload scripts or packs",
      description:
        "Copy the project's current packs into the game again (building Regolith projects with rgl first), then run " +
        "`/reload` (scripts and functions; it re-reads known .mcfunction files but does not register a new one) or " +
        "`/reload all`, which the game documents as rejoining the world to reload every pack (new .mcfunction files, new " +
        "or changed blocks, items, entities and other JSON). The retail client 1.26.63 answers " +
        "`/reload all` from /connect like `/reload` and stays in the world; relaunch with game_launch when new JSON " +
        "content does not show up. When the helper pack does not print ready again (retail `/reload all` over the script " +
        "debugger), it re-establishes the debugger; if that fails the result has a client.helper-lost error and game_status " +
        "shows ready false with the step to take. Returns the redeployed folders and the content-log and script errors " +
        "logged by the reload.",
      inputSchema: { all: z.boolean().optional().describe("Run /reload all instead of /reload") },
      outputSchema: {
        command: z.object(commandSchema),
        diagnostics: z.array(diagnosticSchema),
        redeployed: z.array(z.string()),
        summary: summarySchema,
      },
    },
    async ({ all }) => {
      try {
        const r = await bridge.reload(all ?? false);
        const summary = summarize(r.diagnostics);
        const copied = r.redeployed.length ? `, redeployed ${r.redeployed.length} pack(s)` : "";
        const head = `reload${all ? " all" : ""}${copied}: ${summary.errors} error(s), ${summary.warnings} warning(s)`;
        return ok(r.diagnostics.length ? `${head}\n${diagText(r.diagnostics)}` : head, { ...r, summary });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_log",
    {
      title: "Client content log",
      description:
        "Content-log entries and script errors since the previous call, as diagnostics mapped to the project's files " +
        "(repeated per-frame errors collapsed). Pass `includeText` for the log text in content-log format.",
      inputSchema: { includeText: z.boolean().optional() },
      outputSchema: { diagnostics: z.array(diagnosticSchema), summary: summarySchema, text: z.string().optional() },
    },
    async ({ includeText }) => {
      try {
        const r = await bridge.logs();
        const summary = summarize(r.diagnostics);
        const head = `${summary.errors} error(s), ${summary.warnings} warning(s) since the last read`;
        const structured: Record<string, unknown> = { diagnostics: r.diagnostics, summary };
        if (includeText) structured.text = r.text;
        return ok(r.diagnostics.length ? `${head}\n${diagText(r.diagnostics)}` : head, structured);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_screenshot",
    {
      title: "Screenshot the client",
      description:
        "PNG of what the game shows right now (Linux window or headless mode, or Windows). On Windows the window is " +
        "captured while covered; when it delivers an empty frame it is copied from the screen, which needs the game " +
        "window in the foreground. Returned as an image plus the saved file path.",
      inputSchema: { path: z.string().optional().describe("Where to save the PNG (default under sculkwire's data dir)") },
      outputSchema: { path: z.string(), bytes: z.number() },
    },
    async ({ path }) => {
      try {
        const out = path ?? dataDir("client", "screenshots", `shot-${Date.now()}.png`);
        await mkdir(dirname(out), { recursive: true });
        const r = await bridge.screenshot(out);
        const data = (await readFile(r.path)).toString("base64");
        return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: r.path }], structuredContent: { ...r } };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_query",
    {
      title: "Query the world",
      description:
        "Ask the in-world helper pack: `player` (players with position, rotation, game mode), `entities` (near the player " +
        "or x/y/z: type, position, tags, health, active effects with 0-based amplifier and duration in ticks), " +
        "`blocks` (non-air blocks in a cube with states), `block` (one block).",
      inputSchema: {
        kind: z.enum(["player", "entities", "blocks", "block", "ping"]),
        type: z.string().optional().describe("Filter by entity/block type id"),
        radius: z.number().min(0).max(256).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
        dimension: z.string().optional(),
      },
      outputSchema: { result: z.unknown() },
    },
    async ({ kind, ...params }) => {
      try {
        const result = await bridge.query(kind, Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)));
        const text = JSON.stringify(result);
        return ok(text.length > 4000 ? `${text.slice(0, 4000)}…` : text, { result });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_registry",
    {
      title: "Game registries",
      description:
        "Every block, item or mob id the running game knows (including add-on content). Asks /connect's data request " +
        "first; when no /connect client is attached, or the game answers an empty list (the retail client does), the " +
        "helper pack lists the ids through the Script API (BlockTypes, ItemTypes, EntityTypes; mob then means every " +
        "entity type). `source` says which answered (`connect` or `script`), and `note` why the helper pack did.",
      inputSchema: { kind: z.enum(["block", "item", "mob"]) },
      outputSchema: { kind: z.string(), source: z.enum(["connect", "script"]), entries: z.array(z.unknown()), note: z.string().optional() },
    },
    async ({ kind }) => {
      try {
        const r = await bridge.registry(kind);
        return ok(`${r.entries.length} ${kind} entries via ${r.source}${r.note ? ` (${r.note})` : ""}`, r);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_input",
    {
      title: "Keyboard and mouse input",
      description:
        "Drive the client like a player: `key` (xdotool key names, e.g. `w`, `space`, `Escape`, `Shift_L`, `F3`, chords " +
        "like `ctrl+a`, several separated by spaces), `type` (text), `click` / `move` at x,y in screenshot pixels. With " +
        "the in-game agent attached, keys, text and left/right clicks go through the game's own UI instead (`game_ui`), " +
        "which works in the background and on Windows without the foreground; `move` and a middle click always take the " +
        "route below. Linux: into gamescope's own display, never the user's desktop. Windows: the system keyboard and " +
        "mouse after bringing the game window to the foreground; fails with \"the game window is not in the foreground\" " +
        "when the user switches away before the input is sent. `route` says which way the input went: `engine` (the " +
        "in-game agent's UI), `gamescope` (xdotool into gamescope's display) or `windows` (SendInput).",
      inputSchema: {
        action: z.enum(["key", "type", "click", "move"]),
        keys: z.string().optional(),
        text: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        button: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      },
      outputSchema: { done: z.boolean(), route: z.enum(["engine", "gamescope", "windows"]) },
    },
    async (a) => {
      try {
        if (await inputThroughUi(a)) return ok("done via engine", { done: true, route: "engine" });
        let route: InputRoute;
        if (a.action === "key") {
          if (!a.keys) throw new Error("key needs `keys`");
          route = await bridge.input({ action: "key", keys: a.keys });
        } else if (a.action === "type") {
          if (a.text === undefined) throw new Error("type needs `text`");
          route = await bridge.input({ action: "type", text: a.text });
        } else {
          if (a.x === undefined || a.y === undefined) throw new Error(`${a.action} needs x and y`);
          route = await bridge.input(a.action === "click" ? { action: "click", x: a.x, y: a.y, ...(a.button ? { button: a.button } : {}) } : { action: "move", x: a.x, y: a.y });
        }
        return ok(`done via ${route}`, { done: true, route });
      } catch (err) {
        return fail(err);
      }
    },
  );

  const vec = z.object({ x: z.number(), y: z.number(), z: z.number() });
  const playerStateSchema = z
    .object({
      location: vec,
      rotation: z.object({ x: z.number(), y: z.number() }),
      onGround: z.boolean(),
      selectedSlot: z.number(),
      health: z.number().optional(),
      holding: z.object({ typeId: z.string(), amount: z.number() }).optional(),
      lookingAtBlock: z.object({ typeId: z.string(), location: vec, face: z.string() }).optional(),
      lookingAtEntity: z.object({ id: z.string(), typeId: z.string(), distance: z.number() }).optional(),
    })
    .passthrough();
  const actionSchema = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("move_to"),
      x: z.number(),
      z: z.number(),
      y: z.number().optional(),
      radius: z.number().min(0.3).max(10).optional().describe("Stop within this many blocks (default 0.7)"),
      sprint: z.boolean().optional(),
      look: z.string().optional().describe("Entity id to keep looking at while walking (strafes and sprints relative to the view)"),
      timeoutMs: z.number().int().min(500).max(300_000).optional(),
    }),
    z.object({
      action: z.literal("goto"),
      x: z.number().optional(),
      y: z.number().optional().describe("Height to arrive at. Without it any height at x/z counts"),
      z: z.number().optional(),
      entity: z.string().optional().describe("Entity id to walk to (followed while it moves) instead of x/z"),
      radius: z.number().min(0.3).max(10).optional().describe("Stop within this many blocks (default 0.7, 2 for an entity)"),
      sprint: z.boolean().optional().describe("Sprint on straight stretches (default true)"),
      look: z.string().optional().describe("Entity id to keep looking at while walking"),
      timeoutMs: z.number().int().min(500).max(300_000).optional().describe("Default 60000"),
    }),
    z.object({
      action: z.literal("look_at"),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      entity: z.string().optional().describe("Entity id from game_query"),
      yaw: z.number().optional().describe("0 = south (+Z), 90 = west (-X)"),
      pitch: z.number().optional().describe("-90 up to 90 down"),
    }),
    z.object({
      action: z.literal("attack"),
      entity: z.string().optional().describe("Entity id; default the nearest entity (of `type`)"),
      type: z.string().optional().describe("e.g. minecraft:zombie"),
      hits: z.number().int().min(1).max(100).optional(),
      timeoutMs: z.number().int().min(500).max(300_000).optional(),
    }),
    z.object({
      action: z.literal("shoot"),
      entity: z.string().optional().describe("Entity id; default the nearest entity (of `type`) within 64 blocks"),
      type: z.string().optional().describe("e.g. minecraft:cow"),
      projectile: z
        .enum(["snowball", "egg", "ender_pearl", "arrow", "trident"])
        .optional()
        .describe("Default from the held item (bow = arrow). The matching item must be in hand"),
      holdMs: z.number().int().min(0).max(30_000).optional().describe("Draw time for bows and tridents (default 1100), click length for thrown items"),
      shots: z.number().int().min(1).max(20).optional().describe("Tries until one hits (default 1)"),
      timeoutMs: z.number().int().min(500).max(300_000).optional().describe("Aiming time per shot (default 15000)"),
    }),
    z.object({ action: z.literal("use_item"), holdMs: z.number().int().min(0).max(30_000).optional().describe("Hold right click (bows, food)") }),
    z.object({ action: z.literal("mine"), holdMs: z.number().int().min(0).max(30_000).optional().describe("Hold left click (default 1000)") }),
    z.object({ action: z.literal("select_slot"), slot: z.number().int().min(1).max(9) }),
    z.object({ action: z.literal("jump") }),
    z.object({ action: z.literal("sneak"), on: z.boolean() }),
    z.object({ action: z.literal("hold"), keys: z.array(z.string()).min(1).describe("xdotool key names, e.g. w, a, space, Shift_L (mapped to the same keys on Windows)"), ms: z.number().int().min(0).max(30_000) }),
    z.object({ action: z.literal("wait"), ms: z.number().int().min(0).max(60_000) }),
    z.object({
      action: z.literal("fight"),
      target: z.string().optional().describe("Entity id or type (zombie, minecraft:skeleton). Default the nearest hostile mob"),
      all: z.boolean().optional().describe("Go on to the next hostile (of the type) after a kill. Default true unless target is an id"),
      radius: z.number().min(1).max(64).optional().describe("Only targets within this many blocks (default 16)"),
      crits: z.boolean().optional().describe("Jump for critical hits (default true)"),
      timeoutMs: z.number().int().min(500).max(300_000).optional().describe("Default 60000"),
    }),
    z.object({
      action: z.literal("flee"),
      from: z.string().optional().describe("Entity id or type to get away from. Default every hostile mob within 24 blocks"),
      distance: z.number().min(2).max(64).optional().describe("Done once every threat is this far (default 12)"),
      timeoutMs: z.number().int().min(500).max(300_000).optional().describe("Default 8000"),
    }),
    z.object({
      action: z.literal("eat"),
      slot: z.number().int().min(1).max(9).optional().describe("Hotbar slot to eat from. Default the best food for the current food level"),
      timeoutMs: z.number().int().min(500).max(30_000).optional(),
    }),
    z.object({
      action: z.literal("use_on"),
      target: z.string().describe("Entity id or type to hit once with the held item (thrown or shot when it is a projectile)"),
      all: z.boolean().optional().describe("Every one of the type in range that was not hit yet (default true for a type)"),
      radius: z.number().min(1).max(64).optional().describe("Default 24"),
      timeoutMs: z.number().int().min(500).max(300_000).optional(),
    }),
    z.object({
      action: z.literal("play"),
      goal: z.string().min(1).describe("What to achieve, e.g. \"kill the hostile mobs near you\", \"kill 3 zombies\", \"go to 10 64 -20\", \"hit every cow near you once with the held item\""),
      durationMs: z.number().int().min(1000).max(PLAY_MAX_DURATION_MS).optional().describe(`Time limit (default ${PLAY_DEFAULT_DURATION_MS})`),
      stepMs: z.number().int().min(100).max(1000).optional().describe(`Time between tactic decisions (default ${PLAY_DEFAULT_STEP_MS})`),
      allow: z
        .array(z.enum(TACTICS))
        .optional()
        .describe(`Tactics play may use, from ${TACTICS.join(", ")}. Default all. idle is always allowed`),
      advisor: z.boolean().optional().describe("Ask the configured decision model as an advisor (default true when one is set up). false: the built-in tactic scores alone"),
      vision: z.boolean().optional().describe("Send a screenshot with every decision when the model accepts images (Jev). Off by default because it is slower"),
    }),
  ]);

  server.registerTool(
    "player_act",
    {
      title: "Play like a player",
      description:
        "Control the player like a person playing: walk to a spot (steering and jumping), find a way there over the " +
        "blocks (goto: around walls, up steps and stairs, down drops of up to 3 blocks, over gaps, through doors, " +
        "away from lava), look at a point or entity, " +
        "attack (walks into range first), shoot a projectile at a moving entity (leads it along the ballistic arc " +
        "and reports hit or miss from the game's impact log), use or " +
        "mine with the held item, change hotbar slot, jump, sneak, hold keys. Skills run whole behaviors: fight " +
        "(melee with the best weapon, keeps reach, sprint-hits with a W-tap, jumps for critical hits, strafes, backs " +
        "off from a creeper about to blow, then takes the next hostile), flee (sprints away from threats), eat (best " +
        "food in the hotbar) and use_on (hits each entity of a type once with the held item). " +
        "Pass several actions to run them in order in one call; it " +
        "stops at the first failure unless continueOnError. Returns each action's result and the player's final state. " +
        "Input goes as keyboard and mouse: on Linux into gamescope's own display (xdotool), on Windows through the " +
        "system keyboard and mouse (SendInput) after bringing the game window to the foreground once when the call " +
        "starts. On Windows input only reaches the game while its window is in the foreground: when the user switches " +
        "away, every key and button is let go, the running action stops with \"the game window is not in the " +
        "foreground\" and a play job pauses until the game window is in the foreground again or player_job stop. " +
        "When the in-game agent is attached (engine_attach), input goes through it instead whenever it answers (the " +
        "engine route); an extension's own input provider takes its place while installed. `input` forces one route. When the engine " +
        "route fails mid-action, the action is redone with the keyboard and its message says so. " +
        "When the client cancels the call or it times out, the running action stops and every key and button is let go. " +
        "On the engine route the provider's input lock keeps the user's own keyboard and mouse out of the game while " +
        "actions or a play job run. When the user presses F9 to take control, the running action " +
        "stops with \"the user took control (F9)\" and a play job pauses until F9 gives control back or player_job stop. " +
        "The `play` action pursues a goal on its own: every 250 ms it reads a threat map (hostile mobs, their " +
        "distance, speed and creeper fuses, plus health, food, armor, weapon and food in the hotbar), checks the goal " +
        "and picks a tactic (fight a mob, flee, eat, goto, use the held item on a mob, idle) with built-in scores, so " +
        "it needs no decision model. When one is configured (Jev or Kev, `sculk setup`) it is asked as an advisor, " +
        "and emergencies and the built-in goal checks override it. Kill goals (kill N of a type, kill every hostile " +
        "near), reach goals and hit-every-X goals are checked against the game; other goals end on the model's " +
        "goal_done or the time limit. `play` runs in the background and the call returns at once with a job id. " +
        "Follow it with player_job (status, wait, stop), which returns the stop reason, kills, hits, critical hits, " +
        "damage taken and a trace of every tactic once it ends. `play` must be the last action. Only one play job runs at a time, a new one " +
        "stops the old one, and other actions are refused while one runs. The keyboard route needs game_launch with " +
        "display window or headless on Linux, or any display on Windows; with the in-game agent attached, the engine " +
        "route also drives a Linux desktop-mode game (input auto or engine; keyboard is refused there).",
      inputSchema: {
        actions: z.array(actionSchema).min(1).max(50),
        continueOnError: z.boolean().optional(),
        input: z
          .enum(["auto", "engine", "keyboard"])
          .optional()
          .describe("Input route. auto (default): the engine route (the attached in-game agent, or an extension's input provider) when it answers, else keyboard and mouse. engine fails when no provider can be used"),
      },
      outputSchema: {
        results: z.array(z.object({ action: z.string(), ok: z.boolean(), message: z.string(), durationMs: z.number(), input: z.enum(["engine", "keyboard"]).optional() })),
        state: playerStateSchema,
        job: z.string().optional().describe("Id of the play job this call started"),
        status: z.literal("running").optional(),
      },
    },
    async ({ actions, continueOnError, input }, extra) => {
      try {
        const provider = inputProvider();
        const paused = provider?.pausedReason();
        if (paused) throw new Error(paused);
        const all = actions as (PlayerAction | PlayAction)[];
        const playIndex = all.findIndex((a) => a.action === "play");
        if (playIndex !== -1 && playIndex !== all.length - 1) throw new Error("`play` must be the last action, since it runs in the background after the others");
        const spec = playIndex === -1 ? undefined : (all[playIndex] as PlayAction);
        const steps = all.filter((a): a is PlayerAction => a.action !== "play");
        const running = playJobs.current;
        if (running && steps.length) {
          throw new Error(`play job ${running.id} is controlling the player. Stop it with player_job action stop (or wait for it) before sending other actions`);
        }
        const controller = bridge.playerController();
        const route = await controller.selectInput(input ?? "auto");
        const lines: string[] = [`input: ${route}`];
        if (controller.inputNote) lines.push(controller.inputNote);
        if (route === "keyboard" && provider?.keyboardNote) lines.push(provider.keyboardNote);
        // The provider's input lock is held while these actions or the play job run, on the engine route only.
        const locking = route === "engine" ? provider : undefined;
        // Windows keyboard route: the game window comes forward once now; losing it stops the actions and pauses play.
        const gate = route === "keyboard" ? controller.world.input.foreground : undefined;
        await gate?.activate();
        const lost = new AbortController();
        const offLost = gate?.onTakeover(() => lost.abort());
        const unhold = await locking?.hold();
        let results: ActionResultOut[];
        let job: PlayJobInfo | undefined;
        try {
          results = await runActions(controller, steps, {
            continueOnError: continueOnError ?? false,
            signal: AbortSignal.any([extra.signal, lost.signal]),
            onResult: (r, i) => {
              if (lost.signal.aborted && !extra.signal.aborted && r.message === "cancelled") r.message = FOREGROUND_MESSAGE;
              lines.push(`${r.ok ? "ok" : "FAILED"} ${r.action}: ${r.message} (${r.durationMs} ms)`);
              notifyProgress(extra, i + 1, all.length, `${r.action} ${r.ok ? "ok" : "failed"}`);
            },
          });
          if (extra.signal.aborted) throw new Error("cancelled by the client, keys and buttons released");
          if (lost.signal.aborted && spec) lines.push(`play not started: ${FOREGROUND_MESSAGE}`);
          else if (spec && results.every((r) => r.ok || continueOnError)) {
            const env = {
              controller,
              ...(spec.advisor !== false ? await loadDecisionModel().then((model) => (model ? { model } : {})) : {}),
              entities: async (radius: number) => (await bridge.query("entities", { radius, limit: 50 })) as EntityInfo[],
              loadout: async () => (await bridge.query("loadout")) as Loadout,
              deaths: async (since: number) => (await bridge.query("deaths", { since })) as { tick: number; deaths: Death[] },
              screenshot: async () => {
                const path = dataDir("client", "screenshots", "play.png");
                await mkdir(dirname(path), { recursive: true });
                const shot = await bridge.screenshot(path);
                return `data:image/png;base64,${(await readFile(shot.path)).toString("base64")}`;
              },
              paused: () => provider?.pausedReason() !== undefined,
            };
            job = await playJobs.start(spec.goal, async ({ signal, onStep }) => {
              const unholdJob = await locking?.hold();
              try {
                return await play(spec, pauseOnTakeover(env, locking?.input.takeover ?? gate, signal), { signal, onStep });
              } finally {
                await unholdJob?.();
              }
            });
            results.push({ action: "play", ok: true, message: `started job ${job.id}`, durationMs: 0 });
            lines.push(`play job ${job.id} running: "${spec.goal}". Follow it with player_job (status, wait, stop)`);
          } else if (spec) lines.push("play not started because an earlier action failed");
        } finally {
          offLost?.();
          await unhold?.();
        }
        const state = await bridge.playerState(500);
        lines.push(`at ${state.location.x}, ${state.location.y}, ${state.location.z}, facing yaw ${state.rotation.y.toFixed(0)} pitch ${state.rotation.x.toFixed(0)}`);
        return ok(lines.join("\n"), { results, state, ...(job ? { job: job.id, status: "running" } : {}) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  const jobSchema = {
    id: z.string(),
    goal: z.string(),
    status: z.enum(["running", "done", "stopped", "failed"]),
    startedAt: z.number(),
    progress: z.object({
      steps: z.number(),
      elapsedMs: z.number(),
      lastActions: z.array(z.string()),
      latency: z.object({ medianMs: z.number(), p90Ms: z.number(), maxMs: z.number() }),
    }),
    stopReason: z.string().optional(),
    result: z.object({}).passthrough().optional(),
    error: z.string().optional(),
  };

  server.registerTool(
    "player_job",
    {
      title: "Follow a play job",
      description:
        "Follow the background `play` job that player_act started. `status` returns its progress (steps, elapsed time, " +
        "last actions, decision latency so far). `wait` blocks until the job ends or 25 s pass, whichever is first, so " +
        "it stays under the client's call timeout, and can be called again. `stop` ends it and lets go of every key. " +
        "Once the job has ended, each action returns the full result with the trace of every step, the stop reason and " +
        "the final player state. Without `id` it uses the running job, else the latest one. A job paused by the user's " +
        "F9 takeover stays running and continues when the user presses F9 again; on Windows a job paused because the " +
        "game window left the foreground continues once it is in the foreground again. Jobs also stop on " +
        "game_stop, game_launch and when the server shuts down.",
      inputSchema: {
        action: z.enum(["status", "stop", "wait"]),
        id: z.string().optional().describe("Job id from player_act, e.g. play-1"),
        timeoutMs: z.number().int().min(0).max(JOB_WAIT_MAX_MS).optional().describe(`wait only. Longest to block (default and maximum ${JOB_WAIT_MAX_MS})`),
      },
      outputSchema: jobSchema,
    },
    async ({ action, id, timeoutMs }, extra) => {
      try {
        let j: PlayJobInfo;
        if (action === "stop") j = await playJobs.stop(id);
        else if (action === "wait") {
          j = await playJobs.wait(id, timeoutMs ?? JOB_WAIT_MAX_MS, {
            signal: extra.signal,
            onStep: (step) => notifyProgress(extra, step.step, undefined, stepText(step)),
          });
        } else j = playJobs.status(id);
        return ok(jobText(j), j);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "player_state",
    {
      title: "Player state",
      description:
        "The player's position, rotation, velocity, health, held item and selected slot (1-9), and the block and entity " +
        "under the crosshair. Streamed from the game, so this is fast.",
      inputSchema: {},
      outputSchema: { state: playerStateSchema },
    },
    async () => {
      try {
        const state = await bridge.playerState(300);
        return ok(JSON.stringify(state), { state });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_stop",
    {
      title: "Stop the client",
      description:
        "Quit the game, close the bridge and restore the options.txt keys and game settings sculkwire changed " +
        "(settings live while the game still runs, both in options.txt).",
      inputSchema: {},
      outputSchema: {
        stopped: z.boolean(),
        message: z.string(),
        restoredOptions: z.record(z.string(), z.array(z.string())),
        restoredSettings: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()]).nullable()),
      },
    },
    async () => {
      try {
        await playJobs.stopAll("game_stop");
        const r = await bridge.stop();
        return ok(r.stopped ? r.message : `not stopped: ${r.message}`, r);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
