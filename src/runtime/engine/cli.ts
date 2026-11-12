/**
 * `sculk engine ...`: the in-game agent from a shell. Machine output is JSON on stdout, human hints on stderr.
 * Exit codes are the shared ones: 0 success, 1 the agent reported a failure, 2 usage or a missing prerequisite.
 */
import { parseArgs } from "node:util";
import type { CliCommand } from "../../core/cli.ts";
import { ExitCode } from "../../core/diagnostic.ts";
import { DIFFICULTIES, type Difficulty } from "../../gamefiles/worlds.ts";
import {
  GAME_TYPES,
  defaultScreenshotPath,
  engine,
  isSetupFailure,
  type EngineFailure,
  type EngineResult,
  type EngineTickArgs,
  type GameType,
  type SettingValue,
  type WorldChange,
} from "./engine.ts";
import { KEYBOARD_LOCK_NOTE, LOCK_MODES, lockText, type LockMode } from "./lock.ts";
import { inventoryCommands } from "./inventory.ts";
import { workstationCommands } from "./workstation.ts";
import { changeText, getSetting, listSettings, setSetting } from "./settings.ts";
import { UI_BUTTONS, UI_KEY_ACTIONS, uiControlsText, uiScreenText, type UiButton, type UiKeyAction } from "./ui.ts";
import { getWorldSettings, setWorldSettings } from "./world.ts";

type Parsed = { values: Record<string, string | boolean | undefined>; positionals: string[] };

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

function parse(args: string[], options: Record<string, { type: "string" | "boolean" }> = {}): Parsed | undefined {
  try {
    return parseArgs({ args, options, allowPositionals: true }) as Parsed;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

/** Prints the failure as JSON and maps it to an exit code. */
function failed(failure: EngineFailure): number {
  out(failure);
  const anchor = failure.anchor ? ` (anchor ${failure.anchor})` : "";
  err(`${failure.reason}: ${failure.message}${anchor}`);
  return isSetupFailure(failure) ? ExitCode.usage : ExitCode.findings;
}

/** One CLI call is one process, so the agent socket must not keep it alive after the answer is printed. */
async function oneShot(body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } finally {
    engine.close();
  }
}

/** Runs one host call: its value, or the exit code the CLI answers instead (printed already). */
async function attempt<T>(body: () => Promise<EngineResult<T>>): Promise<{ value: T } | { code: number }> {
  let result: EngineResult<T>;
  try {
    result = await body();
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    out({ ok: false, reason: "prerequisite", message: text });
    err(text);
    return { code: ExitCode.usage };
  }
  return result.ok ? { value: result.value } : { code: failed(result) };
}

/** A command-line value: `true`/`false`, a number, or the text itself. */
function valueOf(text: string): SettingValue {
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  const n = Number(text);
  return text.trim() !== "" && Number.isFinite(n) ? n : text;
}

const attach: CliCommand = {
  name: "engine attach",
  summary: "Build the agent DLL, inject it into the running game and print engine status",
  async run(args) {
    return oneShot(async () => {
      const parsed = parse(args);
      if (!parsed) return ExitCode.usage;
      if (parsed.positionals.length) {
        err("engine attach takes no arguments");
        return ExitCode.usage;
      }
      try {
        out(await engine.attach());
        return ExitCode.ok;
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        out({ ok: false, reason: "prerequisite", message: text });
        err(text);
        return ExitCode.usage;
      }
    });
  },
};

const status: CliCommand = {
  name: "engine status",
  summary: "Engine status of the in-game agent (connects to an agent that is already listening)",
  async run(args) {
    return oneShot(async () => {
      const parsed = parse(args);
      if (!parsed) return ExitCode.usage;
      if (parsed.positionals.length) {
        err("engine status takes no arguments");
        return ExitCode.usage;
      }
      const result = await engine.status();
      if (!result.ok) return failed(result);
      out(result.value);
      return ExitCode.ok;
    });
  },
};

const command: CliCommand = {
  name: "engine command",
  summary: "Run a command in the game through the agent: engine command <command>",
  async run(args) {
    return oneShot(async () => {
      const parsed = parse(args);
      if (!parsed) return ExitCode.usage;
      const line = parsed.positionals.join(" ").trim();
      if (!line) {
        err("usage: sculk engine command <command>");
        return ExitCode.usage;
      }
      const result = await engine.command(line);
      if (!result.ok) return failed(result);
      out(result.value);
      return result.value.success === false ? ExitCode.findings : ExitCode.ok;
    });
  },
};

const tick: CliCommand = {
  name: "engine tick",
  summary: "Pause, resume, step or rescale game time: engine tick --pause | --resume | --step N | --scale X",
  async run(args) {
    return oneShot(async () => {
      const parsed = parse(args, { pause: { type: "boolean" }, resume: { type: "boolean" }, step: { type: "string" }, scale: { type: "string" } });
      if (!parsed) return ExitCode.usage;
      if (parsed.positionals.length) {
        err("engine tick takes flags only");
        return ExitCode.usage;
      }
      const { values } = parsed;
      const given = [
        values.pause === true,
        values.resume === true,
        typeof values.step === "string",
        typeof values.scale === "string",
      ].filter(Boolean).length;
      if (given !== 1) {
        err("give exactly one of --pause, --resume, --step N or --scale X");
        return ExitCode.usage;
      }
      let tickArgs: EngineTickArgs;
      if (values.pause === true) tickArgs = { pause: true };
      else if (values.resume === true) tickArgs = { pause: false };
      else if (typeof values.step === "string") tickArgs = { step: Number(values.step) };
      else tickArgs = { scale: Number(values.scale) };
      const result = await engine.tick(tickArgs);
      if (!result.ok) return failed(result);
      out(result.value);
      return ExitCode.ok;
    });
  },
};

const screenshot: CliCommand = {
  name: "engine screenshot",
  summary: "Ask the game for a screenshot through the agent: engine screenshot [path]",
  async run(args) {
    return oneShot(async () => {
      const parsed = parse(args);
      if (!parsed) return ExitCode.usage;
      if (parsed.positionals.length > 1) {
        err("usage: sculk engine screenshot [path]");
        return ExitCode.usage;
      }
      const result = await engine.screenshot(parsed.positionals[0] ?? defaultScreenshotPath());
      if (!result.ok) return failed(result);
      out(result.value);
      return ExitCode.ok;
    });
  },
};

const player: CliCommand = {
  name: "engine player",
  summary: "Local player position and rotation, read from the engine through the agent",
  async run(args) {
    return oneShot(async () => {
      const parsed = parse(args);
      if (!parsed) return ExitCode.usage;
      if (parsed.positionals.length) {
        err("engine player takes no arguments");
        return ExitCode.usage;
      }
      const result = await engine.playerState();
      if (!result.ok) return failed(result);
      out(result.value);
      return ExitCode.ok;
    });
  },
};

const lock: CliCommand = {
  name: "game lock",
  summary: "Input lock while the agent plays: game lock [on|off|auto] (no argument prints the state). F9 in the game toggles",
  async run(args) {
    return oneShot(async () => {
      const parsed = parse(args);
      if (!parsed) return ExitCode.usage;
      const [mode, ...rest] = parsed.positionals;
      if (rest.length || (mode !== undefined && !LOCK_MODES.includes(mode as LockMode))) {
        err("usage: sculk game lock [on|off|auto]");
        return ExitCode.usage;
      }
      const result = await engine.lock.request(mode as LockMode | undefined);
      if (!result.ok) {
        if (result.reason === "not_attached") err(KEYBOARD_LOCK_NOTE);
        return failed(result);
      }
      out(result.value);
      err(lockText(result.value));
      return ExitCode.ok;
    });
  },
};

const gameSettings: CliCommand = {
  name: "game settings",
  summary: "Read or change the game's options: game settings [list|get <id>|set <id> <value>] [--filter x]",
  async run(args) {
    return oneShot(async () => {
      const parsed = parse(args, { filter: { type: "string" } });
      if (!parsed) return ExitCode.usage;
      const [action, ...rest] = parsed.positionals;
      const filter = typeof parsed.values.filter === "string" ? parsed.values.filter : undefined;
      if (action === undefined || action === "list") {
        if (rest.length) {
          err("usage: sculk game settings [list] [--filter x]");
          return ExitCode.usage;
        }
        const result = await attempt(() => listSettings(filter));
        if ("code" in result) return result.code;
        out(result.value);
        return ExitCode.ok;
      }
      if (action === "get") {
        const [id, ...extra] = rest;
        if (!id || extra.length) {
          err("usage: sculk game settings get <id>");
          return ExitCode.usage;
        }
        const result = await attempt(() => getSetting(id));
        if ("code" in result) return result.code;
        out(result.value);
        return ExitCode.ok;
      }
      if (action === "set") {
        const [id, value, ...extra] = rest;
        if (!id || value === undefined || extra.length) {
          err("usage: sculk game settings set <id> <value>");
          return ExitCode.usage;
        }
        const result = await attempt(() => setSetting(id, valueOf(value)));
        if ("code" in result) return result.code;
        out(result.value);
        err(changeText(result.value));
        return ExitCode.ok;
      }
      err(`unknown action ${action}; usage: sculk game settings [list|get <id>|set <id> <value>] [--filter x]`);
      return ExitCode.usage;
    });
  },
};

const worldSettingsCommand: CliCommand = {
  name: "world settings",
  summary:
    "Read or change a test world: world settings [get] [--world name] | world settings set [--world name] [--difficulty d] " +
    "[--game-type t] [--time n] [--gamerule k=v]... [--weather clear|rain|thunder]",
  async run(args) {
    return oneShot(async () => {
      let parsed: { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] };
      try {
        parsed = parseArgs({
          args,
          allowPositionals: true,
          options: {
            world: { type: "string" },
            difficulty: { type: "string" },
            "game-type": { type: "string" },
            time: { type: "string" },
            gamerule: { type: "string", multiple: true },
            weather: { type: "string" },
          },
        }) as typeof parsed;
      } catch (e) {
        err(e instanceof Error ? e.message : String(e));
        return ExitCode.usage;
      }
      const [action = "get", ...rest] = parsed.positionals;
      const worldFlag = typeof parsed.values.world === "string" ? parsed.values.world : undefined;
      if (rest.length || (action !== "get" && action !== "set")) {
        err("usage: sculk world settings [get|set ...] [--world name]");
        return ExitCode.usage;
      }
      if (action === "get") {
        const result = await attempt(() => getWorldSettings(worldFlag));
        if ("code" in result) return result.code;
        out(result.value);
        return ExitCode.ok;
      }
      const change: WorldChange = {};
      const difficulty = typeof parsed.values.difficulty === "string" ? parsed.values.difficulty : undefined;
      if (difficulty !== undefined && !(difficulty in DIFFICULTIES)) {
        err(`--difficulty must be one of ${Object.keys(DIFFICULTIES).join(", ")}`);
        return ExitCode.usage;
      }
      if (difficulty !== undefined) change.difficulty = difficulty as Difficulty;
      const gameType = typeof parsed.values["game-type"] === "string" ? parsed.values["game-type"] : undefined;
      if (gameType !== undefined && !(GAME_TYPES as readonly string[]).includes(gameType)) {
        err(`--game-type must be one of ${GAME_TYPES.join(", ")}`);
        return ExitCode.usage;
      }
      if (gameType !== undefined) change.gameType = gameType as GameType;
      const time = typeof parsed.values.time === "string" ? Number(parsed.values.time) : undefined;
      if (time !== undefined) {
        if (!Number.isInteger(time) || time < 0 || time > 24000) {
          err("--time needs whole ticks from 0 to 24000");
          return ExitCode.usage;
        }
        change.time = time;
      }
      const raw = parsed.values.gamerule;
      const rules = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
      if (rules.length) {
        const gamerules: Record<string, boolean | number> = {};
        for (const entry of rules) {
          const at = entry.indexOf("=");
          const name = at > 0 ? entry.slice(0, at) : "";
          const value = at > 0 ? valueOf(entry.slice(at + 1)) : "";
          if (!name || typeof value === "string") {
            err(`--gamerule needs name=value with true, false or a number, got ${entry}`);
            return ExitCode.usage;
          }
          gamerules[name] = value;
        }
        change.gamerules = gamerules;
      }
      const weather = typeof parsed.values.weather === "string" ? parsed.values.weather : undefined;
      if (weather === "clear") change.weather = { rain: false, lightning: false };
      else if (weather === "rain") change.weather = { rain: true, lightning: false };
      else if (weather === "thunder") change.weather = { rain: true, lightning: true };
      else if (weather !== undefined) {
        err("--weather must be clear, rain or thunder");
        return ExitCode.usage;
      }
      if (Object.keys(change).length === 0) {
        err("give at least one of --difficulty, --game-type, --time, --gamerule or --weather");
        return ExitCode.usage;
      }
      const result = await attempt(() => setWorldSettings(change, worldFlag));
      if ("code" in result) return result.code;
      out(result.value);
      return ExitCode.ok;
    });
  },
};

/** The agent's own answer to a `ui.*` input (`route`, `sent`, `pending`, the screen it went to), kept in the output. */
function answer(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const gameUi: CliCommand = {
  name: "game ui",
  summary:
    "Menus and screens through the agent: game ui [screen|controls [filter]|press <name>|key <key> [--action down|up]|" +
    "text <text>|click <x> <y> [--button right]|scroll <x> <y> <delta>]",
  async run(args) {
    return oneShot(async () => {
      const usage =
        "usage: sculk game ui [screen|controls [filter]|press <name>|key <key> [--action down|up]|text <text>|" +
        "click <x> <y> [--button right]|scroll <x> <y> <delta>]";
      const parsed = parse(args, { action: { type: "string" }, button: { type: "string" }, filter: { type: "string" } });
      if (!parsed) return ExitCode.usage;
      const { values } = parsed;
      const [action = "screen", ...rest] = parsed.positionals;
      const flag = (name: "action" | "button" | "filter"): string | undefined => (typeof values[name] === "string" ? (values[name] as string) : undefined);
      if (action === "screen") {
        if (rest.length) {
          err(usage);
          return ExitCode.usage;
        }
        const result = await attempt(() => engine.uiScreen());
        if ("code" in result) return result.code;
        out(result.value);
        err(uiScreenText(result.value));
        return ExitCode.ok;
      }
      if (action === "controls") {
        const filter = flag("filter") ?? rest.join(" ").trim();
        const result = await attempt(() => engine.uiControls(filter || undefined));
        if ("code" in result) return result.code;
        out(result.value);
        err(uiControlsText(result.value, filter || undefined));
        return ExitCode.ok;
      }
      if (action === "press") {
        if (rest.length !== 1) {
          err(usage);
          return ExitCode.usage;
        }
        const name = rest[0] as string;
        const result = await attempt(() => engine.uiPress(name));
        if ("code" in result) return result.code;
        out({ ok: true, pressed: name });
        return ExitCode.ok;
      }
      if (action === "key") {
        const key = rest.join(" ").trim();
        const keyAction = flag("action");
        if (!key || (keyAction !== undefined && !(UI_KEY_ACTIONS as readonly string[]).includes(keyAction))) {
          err(usage);
          return ExitCode.usage;
        }
        const result = await attempt(() => engine.uiKey(key, keyAction as UiKeyAction | undefined));
        if ("code" in result) return result.code;
        out({ ok: true, key, ...(keyAction ? { action: keyAction } : {}), ...answer(result.value) });
        return ExitCode.ok;
      }
      if (action === "text") {
        const text = rest.join(" ");
        if (!text) {
          err(usage);
          return ExitCode.usage;
        }
        const result = await attempt(() => engine.uiText(text));
        if ("code" in result) return result.code;
        out({ ok: true, typed: text.length, ...answer(result.value) });
        return ExitCode.ok;
      }
      if (action === "click") {
        const [x, y, ...extra] = rest;
        const button = flag("button");
        if (x === undefined || y === undefined || extra.length || (button !== undefined && !(UI_BUTTONS as readonly string[]).includes(button))) {
          err(usage);
          return ExitCode.usage;
        }
        const result = await attempt(() => engine.uiClick(Number(x), Number(y), button as UiButton | undefined));
        if ("code" in result) return result.code;
        out({ ok: true, click: { x: Number(x), y: Number(y), button: button ?? "left" }, ...answer(result.value) });
        return ExitCode.ok;
      }
      if (action === "scroll") {
        const [x, y, delta, ...extra] = rest;
        if (x === undefined || y === undefined || delta === undefined || extra.length) {
          err(usage);
          return ExitCode.usage;
        }
        const result = await attempt(() => engine.uiScroll(Number(x), Number(y), Number(delta)));
        if ("code" in result) return result.code;
        out({ ok: true, scroll: { x: Number(x), y: Number(y), delta: Number(delta) }, ...answer(result.value) });
        return ExitCode.ok;
      }
      err(`unknown action ${action}; ${usage}`);
      return ExitCode.usage;
    });
  },
};

export const commands: CliCommand[] = [attach, status, command, tick, screenshot, player, lock, gameSettings, worldSettingsCommand, gameUi, ...inventoryCommands, ...workstationCommands];