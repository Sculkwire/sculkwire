/**
 * MCP tools for the in-game agent: the game the user plays in, driven from sculkwire.
 *
 * `engine_attach` builds and injects the native DLL once, then every tool speaks to the agent over its local
 * JSON-RPC listener. All calls are asynchronous, so a running build or injection never blocks other tools.
 */
import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GAME_TYPES,
  SETTING_TYPES,
  defaultScreenshotPath,
  engine,
  type EngineFailure,
  type EnginePlayerState,
  type EngineStatus,
  type EngineTickResult,
  type WorldChange,
  type WorldState,
} from "./engine.ts";
import { DIFFICULTIES, type Difficulty } from "../client/world.ts";
import { KEYBOARD_LOCK_NOTE, LOCK_MODES, lockText } from "./lock.ts";
import { registerInventoryTools } from "./inventory.ts";
import { registerWorkstationTools } from "./workstation.ts";
import { agentProvider } from "./provider.ts";
import { changeText, getSetting, listSettings, setSetting } from "./settings.ts";
import { UI_BUTTONS, UI_CONTROL_TYPES, UI_KEY_ACTIONS, uiControlsText, uiScreenText } from "./ui.ts";
import { getWorldSettings, setWorldSettings } from "./world.ts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(text: string, structured: object): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: { ...structured } };
}

function failure(f: EngineFailure): ToolResult {
  const anchor = f.anchor ? ` anchor ${f.anchor}` : "";
  const text = `${f.reason} (${f.code})${anchor}: ${f.message}`;
  return { content: [{ type: "text", text }], structuredContent: { ...f }, isError: true };
}

/** Attach errors carry no RPC code. They are always a prerequisite the caller can fix. */
function failed(err: unknown): ToolResult {
  const text = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text }], structuredContent: { ok: false, reason: "prerequisite", message: text }, isError: true };
}

/** Arguments this tool can see are wrong before anything is sent, in the shape the engine's own -32602 answers use. */
function invalidParams(message: string): ToolResult {
  return failure({ ok: false, code: -32602, reason: "invalid_params", message });
}

/** Output schemas, built from the zod sculkwire depends on. */
function schemas() {
  const failureSchema = {
    ok: z.boolean(),
    code: z.number().optional(),
    reason: z.string().optional(),
    anchor: z.string().optional(),
    message: z.string().optional(),
  };

  const statusSchema = {
    ...failureSchema,
    build: z.string().optional(),
    hooked: z.boolean().optional(),
    tick: z.number().optional(),
    resolved: z.record(z.string(), z.string()).optional(),
    missing: z.array(z.string()).optional(),
  };

  const commandSchema = {
    ...failureSchema,
    command: z.string().optional(),
    success: z.boolean().nullable().optional(),
  };

  const tickSchema = {
    ...failureSchema,
    paused: z.boolean().optional(),
    ticks: z.number().optional(),
    scale: z.number().optional(),
    success: z.boolean().nullable().optional(),
  };

  const screenshotSchema = {
    ...failureSchema,
    path: z.string().optional(),
    bytes: z.number().optional(),
    format: z.enum(["png", "jpeg"]).optional(),
  };

  const vec3 = z.tuple([z.number(), z.number(), z.number()]);
  const playerSchema = {
    ...failureSchema,
    position: vec3.optional(),
    rotation: z.tuple([z.number().nullable(), z.number().nullable()]).optional(),
    delta: vec3.optional(),
    simTick: z.number().optional(),
    dimension: z.number().nullable().optional(),
  };

  const lockSchema = {
    ...failureSchema,
    locked: z.boolean().optional(),
    mode: z.enum(LOCK_MODES).optional(),
    by: z.enum(["agent", "user"]).optional(),
    user: z.boolean().optional(),
    active: z.boolean().optional(),
    window: z.boolean().optional(),
    dropped: z.number().optional(),
    focusLost: z.number().optional(),
    focusKept: z.number().optional(),
    wineFocused: z.boolean().optional(),
    wineForeground: z.boolean().optional(),
    shift: z.object({ message: z.tuple([z.number(), z.number()]), raw: z.tuple([z.number(), z.number()]) }).optional(),
    keysHidden: z.number().optional(),
    hostFocused: z.boolean().optional(),
    pad: z.object({ hooked: z.number(), reads: z.number(), active: z.number(), hidden: z.number() }).optional(),
    camera: z.enum(["disabled", "enabled"]).nullable().optional(),
    focusWatch: z
      .object({
        backend: z.enum(["kwin", "x11", "windows", "none"]),
        gamePid: z.number(),
        running: z.boolean(),
        reports: z.number(),
        activePid: z.number().optional(),
        focused: z.boolean(),
        error: z.string().optional(),
      })
      .optional(),
  };
  const settingValue = z.union([z.boolean(), z.number(), z.string()]);
  const settingSchema = z.object({
    id: z.string(),
    type: z.enum(SETTING_TYPES).optional(),
    value: settingValue,
    min: z.number().optional(),
    max: z.number().optional(),
    values: z.array(z.string()).optional(),
  });
  const settingsSchema = {
    ...failureSchema,
    source: z.enum(["engine", "options.txt"]).optional(),
    settings: z.array(settingSchema).optional(),
    setting: settingSchema.optional(),
    previous: settingValue.nullable().optional(),
    appliesAt: z.enum(["now", "next launch"]).optional(),
    saved: z.boolean().optional(),
  };

  const worldStateSchema = z.object({
    name: z.string().nullable(),
    seed: z.string().nullable(),
    gameType: z.enum(GAME_TYPES).nullable(),
    difficulty: z.enum(Object.keys(DIFFICULTIES) as [Difficulty, ...Difficulty[]]).nullable(),
    cheats: z.boolean().nullable(),
    education: z.boolean().nullable(),
    experiments: z.array(z.string()),
    gamerules: z.record(z.string(), z.union([z.boolean(), z.number()])),
    time: z.number().nullable(),
    dayCycle: z.boolean().nullable(),
    weather: z.object({ rain: z.boolean(), lightning: z.boolean() }).nullable(),
    spawn: z.tuple([z.number(), z.number(), z.number()]).nullable(),
    dimension: z.union([z.string(), z.number()]).nullable(),
  });
  const worldSchema = {
    ...failureSchema,
    source: z.enum(["engine", "level.dat"]).optional(),
    world: z.object({ name: z.string(), levelId: z.string().optional(), dir: z.string().optional() }).optional(),
    settings: worldStateSchema.optional(),
  };

  const uiSchema = {
    ...failureSchema,
    screen: z
      .object({ name: z.string(), stack: z.array(z.string()), modal: z.boolean(), route: z.string().nullable().optional() })
      .optional(),
    controls: z
      .array(
        z.object({
          name: z.string(),
          type: z.enum(UI_CONTROL_TYPES),
          rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
          text: z.string().optional(),
          enabled: z.boolean(),
        }),
      )
      .optional(),
    pressed: z.string().optional(),
    key: z.string().optional(),
    keyAction: z.enum(UI_KEY_ACTIONS).optional(),
    typed: z.number().optional(),
    click: z.object({ x: z.number(), y: z.number(), button: z.enum(UI_BUTTONS) }).optional(),
    scroll: z.object({ x: z.number(), y: z.number(), delta: z.number() }).optional(),
    done: z.boolean().optional(),
    route: z.enum(["window", "gameinput"]).optional(),
    via: z.enum(["child", "class"]).optional(),
    pending: z.boolean().optional(),
    previousClick: z.object({ number: z.number(), state: z.enum(["queued", "pressed", "released", "dropped"]) }).nullable().optional(),
    sent: z.number().optional(),
  };

  return { statusSchema, commandSchema, tickSchema, screenshotSchema, playerSchema, lockSchema, settingsSchema, worldSchema, uiSchema };
}

/**
 * How the agent delivered a `ui.*` input: `route` (window messages, or GameInput read by the game's next poll),
 * `via` (the hosted child window or the class procedure), `pending` (queued, not yet applied), `previousClick` (what
 * became of the click before) and `sent` (messages sent). Only these fields: the answer's `screen` is a bare name.
 */
function delivery(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const answer = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  if (answer.route === "window" || answer.route === "gameinput") picked.route = answer.route;
  if (answer.via === "child" || answer.via === "class") picked.via = answer.via;
  if (typeof answer.pending === "boolean") picked.pending = answer.pending;
  if ("previousClick" in answer) picked.previousClick = answer.previousClick ?? null;
  if (typeof answer.sent === "number") picked.sent = answer.sent;
  return picked;
}

function playerText(p: EnginePlayerState): string {
  const at = p.position.map((v) => v.toFixed(2)).join(" ");
  const [pitch, yaw] = p.rotation;
  return pitch === null || yaw === null ? `at ${at}` : `at ${at}, pitch ${pitch.toFixed(1)}, yaw ${yaw.toFixed(1)}`;
}

function statusText(s: EngineStatus): string {
  const anchors = Object.keys(s.resolved).length;
  const parts = [
    `build ${s.build || "unknown"}`,
    s.hooked ? "main thread hooked" : "main thread not hooked",
    `tick ${s.tick}`,
    `${anchors} anchor(s) resolved`,
  ];
  if (s.missing.length) parts.push(`missing ${s.missing.join(", ")}`);
  return parts.join(", ");
}

function tickText(t: EngineTickResult): string {
  if (t.paused !== undefined) return `paused: ${t.paused}`;
  if (t.ticks !== undefined) return `ran ${t.ticks} tick(s)`;
  if (t.scale !== undefined) return `scale: ${t.scale}`;
  return "done";
}

function settingText(id: string, value: unknown, source: string): string {
  return `${id} = ${String(value)} (${source})`;
}

function worldText(s: WorldState, source: string): string {
  const parts = [
    `${s.name ?? "unnamed world"} (${source})`,
    s.gameType ? `game type ${s.gameType}` : "game type unknown",
    s.difficulty ? `difficulty ${s.difficulty}` : "difficulty unknown",
    s.time === null ? "time unknown" : `time ${s.time}`,
    `${Object.keys(s.gamerules).length} game rule(s)`,
  ];
  if (s.weather) parts.push(`weather ${s.weather.lightning ? "thunder" : s.weather.rain ? "rain" : "clear"}`);
  return parts.join(", ");
}

export function register(server: McpServer): void {
  const { statusSchema, commandSchema, tickSchema, screenshotSchema, playerSchema, lockSchema, settingsSchema, worldSchema, uiSchema } = schemas();
  registerInventoryTools(server);
  registerWorkstationTools(server);

  server.registerTool(
    "engine_attach",
    {
      title: "Attach the in-game agent",
      description:
        "Build the agent DLL, inject it into the running Minecraft Bedrock game and return the engine status. Any PC " +
        "(GDK) install sculkwire finds works — a Wine or Proton prefix on Linux (Flarial, mcbe-gdk-installer…) or a " +
        "native install on Windows — and the game must already be running. The DLL comes from `native/` (cargo) or " +
        "the matching GitHub release, and is cached. Repeat calls reuse the loaded agent.",
      inputSchema: {},
      outputSchema: statusSchema,
    },
    async () => {
      try {
        const status = await engine.attach();
        return ok(statusText(status), { ok: true, ...status });
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "engine_status",
    {
      title: "Engine agent status",
      description:
        "Build identity, whether the main-thread hook runs requests, the current tick, every resolved engine anchor and " +
        "every missing one. Without engine_attach it connects to an agent that is already listening on the agent port.",
      inputSchema: {},
      outputSchema: statusSchema,
    },
    async () => {
      const result = await engine.status();
      return result.ok ? ok(statusText(result.value), { ok: true, ...result.value }) : failure(result);
    },
  );

  server.registerTool(
    "engine_command",
    {
      title: "Run a command through the agent",
      description:
        "Run a command in the game on the game's main thread as the local player, exactly as if it were typed: chat " +
        "commands, client-side commands and a pack reload all work. The leading slash is optional. Returns whether the " +
        "command succeeded (null when it printed nothing, like say) and its output text.",
      inputSchema: {
        command: z.string().describe("Command line, with or without the leading slash. Newlines are rejected"),
      },
      outputSchema: commandSchema,
    },
    async ({ command }) => {
      const result = await engine.command(command);
      if (!result.ok) return failure(result);
      const { success, message } = result.value;
      const text = `${success === false ? "failed" : success ? "ok" : "no output"}${message ? `: ${message}` : ""}`;
      return ok(text, { ok: true, command, success, message });
    },
  );

  server.registerTool(
    "engine_player",
    {
      title: "Local player state from the engine",
      description:
        "Position, rotation (pitch, yaw) and movement delta of the local player, read from the engine on the game's main " +
        "thread, plus the simulation tick it was read on. Needs engine_attach and a loaded world.",
      inputSchema: {},
      outputSchema: playerSchema,
    },
    async () => {
      const result = await engine.playerState();
      return result.ok ? ok(playerText(result.value), { ok: true, ...result.value }) : failure(result);
    },
  );

  server.registerTool(
    "engine_tick",
    {
      title: "Control game time",
      description:
        "Pause or resume the simulation, advance a paused game by a number of ticks, or set the tick rate multiplier. " +
        "Give exactly one of pause, step or scale. A step is an integer from 1 to 600 and runs inside one main-thread " +
        "request.",
      inputSchema: {
        pause: z.boolean().optional().describe("true freezes the simulation, false resumes it"),
        step: z.number().int().min(1).max(600).optional().describe("Ticks to advance while paused"),
        scale: z.number().optional().describe("Tick rate multiplier"),
      },
      outputSchema: tickSchema,
    },
    async ({ pause, step, scale }) => {
      const result = await engine.tick({
        ...(pause !== undefined ? { pause } : {}),
        ...(step !== undefined ? { step } : {}),
        ...(scale !== undefined ? { scale } : {}),
      });
      return result.ok ? ok(tickText(result.value), { ok: true, ...result.value }) : failure(result);
    },
  );

  server.registerTool(
    "engine_screenshot",
    {
      title: "Screenshot through the agent",
      description:
        "Ask the game's own screenshot code for a picture of the current frame. The game saves it in its screenshot " +
        "gallery (the retail client saves JPEGs, so a `.png` path becomes `.jpg`); sculkwire copies it to `path`. " +
        "Returns the host path and the image.",
      inputSchema: {
        path: z.string().optional().describe("Where to save the picture (host path, default under sculkwire's cache)"),
      },
      outputSchema: screenshotSchema,
    },
    async ({ path }) => {
      const result = await engine.screenshot(path ?? defaultScreenshotPath());
      if (!result.ok) return failure(result);
      const text = result.value.bytes === undefined ? result.value.path : `${result.value.path} (${result.value.bytes} bytes)`;
      const content: Content[] = [];
      try {
        const mimeType = result.value.format === "jpeg" ? "image/jpeg" : "image/png";
        content.push({ type: "image", data: (await readFile(result.value.path)).toString("base64"), mimeType });
      } catch {
        // The path is still the answer when the file cannot be read here.
      }
      content.push({ type: "text", text });
      return { content, structuredContent: { ok: true, ...result.value } };
    },
  );

  server.registerTool(
    "game_input_lock",
    {
      title: "Lock the user's input while the agent plays",
      description:
        "Keep the user's own keyboard and mouse out of the game while sculkwire plays through the injected agent, so a " +
        "click or key in the game window cannot disturb an action. While locked, the game also does not pause when " +
        "its window loses focus, and the action bar shows a badge. F9 in the game always works: it hands control to " +
        "the user (a running player_act action stops, a play job pauses) and gives it back. mode on locks now, off " +
        "never locks, auto (the default) locks while a player_act action or play job runs. Without mode it reports the " +
        "state. Needs engine_attach. The keyboard route cannot be locked, because its input arrives the same way as " +
        "the user's: use the engine route or launch with display: headless.",
      inputSchema: {
        mode: z.enum(LOCK_MODES).optional().describe("on, off or auto. Omit to read the state"),
      },
      outputSchema: lockSchema,
    },
    async ({ mode }) => {
      const result = await engine.lock.request(mode);
      if (!result.ok) {
        const keyboard = result.reason === "not_attached" ? { ...result, message: `${result.message}. ${KEYBOARD_LOCK_NOTE}` } : result;
        return failure(keyboard);
      }
      // Report the desktop focus watcher so a focus failure can be told apart.
      const focusWatch = agentProvider.focusWatch();
      return ok(lockText(result.value), { ok: true, ...result.value, ...(focusWatch ? { focusWatch } : {}) });
    },
  );
  server.registerTool(
    "game_settings",
    {
      title: "Game settings",
      description:
        "Read or change the game's own options, named by their options.txt tag (gfx_viewdistance, game_thirdperson, " +
        "showcoordinates). Through the running game when the agent is attached, so a change applies at once; in " +
        "options.txt when it is not, which applies at the next launch. set reports `saved`: true when the value " +
        "reached options.txt (always for the file route), false when it is live only and is lost on restart unless the " +
        "game saves later. Every value sculkwire changes is put back by game_stop. The script debugger, websocket and " +
        "content-log keys belong to the bridge: game_launch writes them and game_stop restores them.",
      inputSchema: {
        action: z.enum(["list", "get", "set"]).describe("list every option, read one, or change one"),
        id: z.string().optional().describe("get/set: the option's options.txt tag. list: id substring to match"),
        value: z.union([z.boolean(), z.number(), z.string()]).optional().describe("set: the new value"),
        filter: z.string().optional().describe("list: case-insensitive id substring"),
      },
      outputSchema: settingsSchema,
    },
    async ({ action, id, value, filter }) => {
      try {
        if (action === "list") {
          const result = await listSettings(filter ?? id);
          if (!result.ok) return failure(result);
          const { source, settings } = result.value;
          return ok(`${settings.length} setting(s) from ${source}`, { ok: true, source, settings });
        }
        const key = id?.trim();
        if (!key) return failure({ ok: false, code: -32602, reason: "invalid_params", message: `${action} needs id` });
        if (action === "get") {
          const result = await getSetting(key);
          if (!result.ok) return failure(result);
          return ok(settingText(key, result.value.setting.value, result.value.source), { ok: true, ...result.value });
        }
        if (value === undefined) return failure({ ok: false, code: -32602, reason: "invalid_params", message: "set needs value" });
        const result = await setSetting(key, value);
        if (!result.ok) return failure(result);
        const change = result.value;
        return ok(changeText(change), {
          ok: true,
          source: change.source,
          setting: { id: change.id, value: change.value },
          previous: change.previous,
          appliesAt: change.appliesAt,
          ...(change.saved !== undefined ? { saved: change.saved } : {}),
        });
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "world_settings",
    {
      title: "World settings",
      description:
        "Read or change a test world: game rules, difficulty, game type, time and weather. Through the running game " +
        "when the agent is attached, applied the way the game applies its own command; otherwise sculkwire reads and " +
        "rewrites level.dat, and only for a sculkwire-* world no game has loaded. Only sculkwire-* worlds are ever " +
        "changed. World changes need no restore: a test world is disposable and the next launch replaces it.",
      inputSchema: {
        action: z.enum(["get", "set"]).describe("read the world's settings, or change them"),
        world: z.string().optional().describe("get/set without an agent: world name, sculkwire- added when missing"),
        gamerules: z.record(z.string(), z.union([z.boolean(), z.number()])).optional().describe("set: game rule values, e.g. { keepinventory: true }"),
        difficulty: z.enum(Object.keys(DIFFICULTIES) as [Difficulty, ...Difficulty[]]).optional(),
        gameType: z.enum(GAME_TYPES).optional(),
        time: z.number().int().min(0).max(24000).optional().describe("set: game ticks, 0 to 24000 in a day"),
        weather: z
          .object({ rain: z.boolean(), lightning: z.boolean() })
          .optional()
          .describe("set: rain and thunder; in level.dat it is written as rain/lightning levels with a five-day timer"),
      },
      outputSchema: worldSchema,
    },
    async ({ action, world, gamerules, difficulty, gameType, time, weather }) => {
      try {
        if (action === "get") {
          const result = await getWorldSettings(world);
          if (!result.ok) return failure(result);
          return ok(worldText(result.value.settings, result.value.source), { ok: true, ...result.value });
        }
        const change: WorldChange = {
          ...(gamerules ? { gamerules } : {}),
          ...(difficulty !== undefined ? { difficulty } : {}),
          ...(gameType !== undefined ? { gameType } : {}),
          ...(time !== undefined ? { time } : {}),
          ...(weather !== undefined ? { weather } : {}),
        };
        const result = await setWorldSettings(change, world);
        if (!result.ok) return failure(result);
        return ok(worldText(result.value.settings, result.value.source), { ok: true, ...result.value });
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "game_ui",
    {
      title: "Menus and screens",
      description:
        "Drive the game's own UI from inside the process: read the screen (`screen`), list its controls (`controls`), " +
        "press a named control (`press`), or send a key, text, click or scroll (`key`, `text`, `click`, `scroll`). " +
        "This is how a menu is driven without the keyboard and mouse route, which only reaches the game while its " +
        "window is in the foreground: these calls work in the background, on Linux and Windows alike, and need no " +
        "loaded world. Every input is refused on a store, Marketplace, Minecoins or Dressing Room screen except " +
        "Escape, which leaves it. Without engine_attach it connects to an agent that is already listening on the agent " +
        "port.",
      inputSchema: {
        action: z.enum(["screen", "controls", "press", "key", "text", "click", "scroll"]).describe(
          "screen: the current screen and stack. controls: its visible controls. press: one of them by name. key, text, click, scroll: raw input",
        ),
        name: z.string().optional().describe("press: the control's name, as `controls` lists it"),
        filter: z.string().optional().describe("controls: only names or labels containing this"),
        key: z.string().optional().describe("key: one key or chord, e.g. Escape, Return, space, F3, ctrl+a"),
        keyAction: z.enum(UI_KEY_ACTIONS).optional().describe("key: press (default), down or up"),
        text: z.string().optional().describe("text: what to type into the focused text box"),
        x: z.number().optional().describe("click/scroll: client pixel x, the same frame a screenshot shows"),
        y: z.number().optional().describe("click/scroll: client pixel y"),
        button: z.enum(UI_BUTTONS).optional().describe("click: left (default) or right"),
        delta: z.number().int().optional().describe("scroll: whole notches, positive up"),
      },
      outputSchema: uiSchema,
    },
    async ({ action, name, filter, key: chord, keyAction, text, x, y, button, delta }) => {
      try {
        if (action === "screen") {
          const result = await engine.uiScreen();
          return result.ok ? ok(uiScreenText(result.value), { ok: true, screen: result.value }) : failure(result);
        }
        if (action === "controls") {
          const result = await engine.uiControls(filter);
          if (!result.ok) return failure(result);
          return ok(uiControlsText(result.value, filter), { ok: true, controls: result.value });
        }
        if (action === "press") {
          const control = name?.trim();
          if (!control) return invalidParams("press needs name: the control as `controls` lists it");
          const result = await engine.uiPress(control);
          return result.ok ? ok(`pressed ${control}`, { ok: true, pressed: control }) : failure(result);
        }
        if (action === "key") {
          const sent = chord?.trim();
          if (!sent) return invalidParams("key needs key, e.g. Escape or ctrl+a");
          const result = await engine.uiKey(sent, keyAction);
          return result.ok
            ? ok(`sent ${sent}${keyAction ? ` (${keyAction})` : ""}`, { ok: true, key: sent, ...(keyAction ? { keyAction } : {}), ...delivery(result.value) })
            : failure(result);
        }
        if (action === "text") {
          if (!text) return invalidParams("text needs the text to type");
          const result = await engine.uiText(text);
          return result.ok ? ok(`typed ${text.length} character(s)`, { ok: true, typed: text.length, ...delivery(result.value) }) : failure(result);
        }
        if (x === undefined || y === undefined) return invalidParams(`${action} needs x and y in client pixels`);
        if (action === "click") {
          const result = await engine.uiClick(x, y, button);
          const at = { x, y, button: button ?? "left" };
          return result.ok ? ok(`clicked ${at.button} at ${x},${y}`, { ok: true, click: at, ...delivery(result.value) }) : failure(result);
        }
        if (delta === undefined) return invalidParams("scroll needs delta: whole notches, positive up");
        const result = await engine.uiScroll(x, y, delta);
        return result.ok ? ok(`scrolled ${delta} at ${x},${y}`, { ok: true, scroll: { x, y, delta }, ...delivery(result.value) }) : failure(result);
      } catch (err) {
        return failed(err);
      }
    },
  );
}
