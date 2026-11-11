/**
 * One attached in-game agent: build and inject the native DLL once, then speak typed JSON-RPC to the listener it
 * opens on `127.0.0.1`.
 *
 * `EngineSession` owns the socket and reopens it after the agent drops the connection. Attach is idempotent. A
 * connected session only refreshes `engine.status`. An idle one injects again, which is safe because `buildAgent`
 * caches by source hash and the injector is given the same DLL path.
 *
 * Method failures are values, not exceptions. RPC error codes become `{ ok: false, code, reason, anchor? }` so CLI
 * exit codes and MCP results stay mechanical. Attach failures throw `EngineAttachError`, because nothing is running
 * yet and the caller has a prerequisite to fix.
 *
 * Supported targets: any PC (GDK) install sculkwire finds, retail or otherwise. On Linux and macOS the injector runs
 * inside the install's own Wine or Proton prefix (Flarial, mcbe-gdk-installer, Bottles, Lutris…), on Windows natively.
 * The DLL reports its own build identity.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { cacheDir } from "../../core/paths.ts";
import { gameDirCandidates } from "../../gamefiles/detect.ts";
import { findInstall, type ClientInstall } from "../client/install.ts";
import { DIFFICULTIES, type Difficulty } from "../client/world.ts";
import { gamePath } from "./gamepath.ts";
import { buildAgent, type AgentBuild } from "./build.ts";
import { AgentClient, AgentClientError, AgentRpcError } from "./client.ts";
import { injectClient, type InjectionResult } from "./inject.ts";
import { InputLock, parseLockState } from "./lock.ts";
import {
  clickParams,
  keyParams,
  parseUiControls,
  parseUiScreen,
  scrollParams,
  textParams,
  uiScreenText,
  type UiButton,
  type UiControl,
  type UiKeyAction,
  type UiScreen,
} from "./ui.ts";

/** Default agent port. The DLL's own `SCULKWIRE_AGENT_PORT` override is forwarded from the launcher's environment. */
export const ENGINE_DEFAULT_PORT = 19160;

const DEFAULT_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 60_000;
const SCREENSHOT_TIMEOUT_MS = 60_000;
/** How long to look for the PNG after the game accepted the request. The engine writes it asynchronously. */
const SCREENSHOT_FILE_WAIT_MS = 20_000;
/** `input.*` answer before the next frame, so a slow answer means the drain is stuck rather than busy. */
const INPUT_TIMEOUT_MS = 2_000;
/** `ui.*` answer on the game's next UI frame, so a slow answer means the frame hook is not running. */
const UI_TIMEOUT_MS = 5_000;
/** How long `engine_attach` waits for a freshly injected agent to finish resolving its anchors (about 10 s live). */
const ATTACH_RESOLVE_MS = 60_000;
const ATTACH_RESOLVE_POLL_MS = 250;

const windowSize = z.object({ class: z.string(), width: z.number(), height: z.number() });

/**
 * The agent's diagnostic `engine.status` fields beyond the core five, as zod schemas: `normalizeStatus` keeps a field
 * only when it parses, and the `engine_status` output schema is built from the same shape. Nested objects are loose,
 * so a newer agent that adds a counter still fits; an older agent simply leaves a field out.
 */
export const ENGINE_STATUS_DIAGNOSTICS = {
  /** False while the agent is still resolving its anchors right after the injection. */
  attached: z.boolean(),
  /** Which thread main-thread methods run on and what proved it; null before any drain ran. */
  mainThread: z.string().nullable(),
  /** The port the agent's socket bound (a hot reload may have settled for the next free one). */
  port: z.number(),
  /** Drains released from outside: a fault inside a handler, or one that never returned. */
  drainReleases: z.number(),
  /** Every hook the engine installed, with its call count and first thread. */
  hooks: z.record(z.string(), z.looseObject({ installed: z.boolean(), calls: z.number(), thread: z.number().nullable() })),
  /** The GameInput interface the agent drives the mouse through, and what the game's readings have seen. */
  gameinput: z
    .looseObject({
      hooked: z.boolean().optional(),
      module: z.string().nullable().optional(),
      create: z.string().nullable().optional(),
      /** How many vtable slots are patched right now. */
      patched: z.number().optional(),
      samples: z.number().optional(),
      synthetic: z.number().optional(),
      hidden: z.number().optional(),
      keySamples: z.number().optional(),
      keys: z.number().optional(),
      /** The agent's cursor in client pixels, null before its first request. */
      cursor: z.tuple([z.number(), z.number()]).nullable().optional(),
      kinds: z.looseObject({ mouse: z.number(), keyboard: z.number(), other: z.number() }).optional(),
      readings: z.number().optional(),
      idleMs: z.number().nullable().optional(),
      /** The last queued click, followed to `released` (read down and up) or `dropped` (no reading took it). */
      lastClick: z
        .object({ number: z.number(), state: z.enum(["queued", "pressed", "released", "dropped"]) })
        .nullable()
        .optional(),
      callbacks: z.number().optional(),
      adopted: z.number().optional(),
      versions: z.array(z.looseObject({})).optional(),
      /** Why the last probe refused, empty once a version is hooked. */
      probe: z.string().optional(),
    })
    .nullable(),
  /** The game window, its children and the hosted view a UI click is aimed at; null without a window. */
  ui: z
    .looseObject({
      window: windowSize.optional(),
      children: z.array(windowSize).optional(),
      /** The hosted view (OreUI) a click goes to, null when there is none. */
      host: z.string().nullable().optional(),
    })
    .nullable(),
  /** The game objects the engine steps, with the role it proved for each. */
  minecraft: z.array(
    z.looseObject({
      ptr: z.string(),
      calls: z.number(),
      thread: z.number().nullable(),
      level: z.string().nullable(),
      role: z.string(),
    }),
  ),
};

type EngineStatusDiagnostics = { [K in keyof typeof ENGINE_STATUS_DIAGNOSTICS]?: z.infer<(typeof ENGINE_STATUS_DIAGNOSTICS)[K]> };

export interface EngineStatus extends EngineStatusDiagnostics {
  /** Build identity as the DLL reports it. */
  build: string;
  /** True when the main-thread drain is installed and runs requests. */
  hooked: boolean;
  /** Tick sequence number at the time of the call. */
  tick: number;
  /** Anchor name to resolved address. */
  resolved: Record<string, string>;
  /** Anchors whose recipe failed. Dependent methods then answer `-32001`. */
  missing: string[];
}

export interface EngineCommandResult {
  /** From the command's own output: false when it reported an error, null when it printed nothing (e.g. `say`). */
  success: boolean | null;
  /** The output text, rendered from the game's language file. */
  message: string;
}

export interface EngineTickResult {
  paused?: boolean;
  ticks?: number;
  scale?: number;
  /** True when the engine applied the change, null when it reported nothing. */
  success?: boolean | null;
  /** The engine's own words, when it said anything. */
  message?: string;
}

export interface EngineScreenshotResult {
  /** Host path of the picture. Its extension follows the format: the game's own gallery keeps JPEGs. */
  path: string;
  bytes?: number;
  format?: "png" | "jpeg";
}

export interface EnginePlayerState {
  /** The feet; an entry is null when the agent read a non-finite float. */
  position: [number | null, number | null, number | null];
  /** Pitch and yaw in degrees, null when the engine's rotation component could not be read. */
  rotation: [number | null, number | null];
  /** Movement since the previous tick. */
  delta?: [number | null, number | null, number | null];
  /** Simulation tick the state was read on. */
  simTick?: number;
  dimension: number | null;
  /** On the ground; null when the agent could not read it. */
  onGround?: boolean | null;
  /** Health points; null when the agent could not read it. */
  health?: number | null;
  /** Selected hotbar slot; null when the agent could not read it. */
  selectedSlot?: number | null;
  /** The raw `DimensionStateComponent` value the agent reads; `dimension` stays the decoded id. */
  dimensionState?: number | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numbers<N extends number>(value: unknown, length: N): (number | null)[] | undefined {
  return Array.isArray(value) && value.length === length ? value.map(numberOrNull) : undefined;
}

/**
 * `player.state` as the tools publish it: the fields `EnginePlayerState` names, each checked, and nothing else, so an
 * agent that answers more (a newer agent, an extension's engine) still fits engine_player's output schema.
 */
export function normalizePlayerState(raw: unknown): EnginePlayerState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: EnginePlayerState = {
    position: (numbers(r.position, 3) ?? [null, null, null]) as EnginePlayerState["position"],
    rotation: (numbers(r.rotation, 2) ?? [null, null]) as EnginePlayerState["rotation"],
    dimension: numberOrNull(r.dimension),
  };
  const delta = numbers(r.delta, 3);
  if (delta) out.delta = delta as NonNullable<EnginePlayerState["delta"]>;
  if (typeof r.simTick === "number") out.simTick = r.simTick;
  if ("onGround" in r) out.onGround = typeof r.onGround === "boolean" ? r.onGround : null;
  if ("health" in r) out.health = numberOrNull(r.health);
  if ("selectedSlot" in r) out.selectedSlot = numberOrNull(r.selectedSlot);
  if ("dimensionState" in r) out.dimensionState = numberOrNull(r.dimensionState);
  return out;
}

export interface EngineTickArgs {
  pause?: boolean;
  step?: number;
  scale?: number;
}

/** Held movement input for `input.move`. forward +1 is W, strafe +1 is D (right). */
export interface EngineMove {
  forward: number;
  strafe: number;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
}

/** One `tick` notification after `stream.subscribe`. Position is the feet, velocity in blocks per tick. */
export interface EngineTick {
  /** Client simulation tick (20 per second). */
  tick: number;
  position: [number, number, number];
  /** Pitch (+ looks down) and yaw (0 = +Z) in degrees. */
  rotation: [number, number];
  velocity: [number, number, number];
  /** Null while the engine's ground flag is not readable. */
  onGround: boolean | null;
  health: number | null;
  /** Hotbar slot 1-9, null while not readable. */
  selectedSlot: number | null;
}

export type EngineTickListener = (tick: EngineTick, arrivedAt: number) => void;

/** An option the game owns, named by its `options.txt` save tag (`gfx_viewdistance`, `game_thirdperson`). */
export const SETTING_TYPES = ["bool", "int", "float", "string", "enum"] as const;
export type SettingType = (typeof SETTING_TYPES)[number];
export type SettingValue = boolean | number | string;

export interface GameSetting {
  /** The save tag exactly as `options.txt` writes it. */
  id: string;
  type: SettingType;
  value: SettingValue;
  /** Bounds of an `int` or `float` option. */
  min?: number;
  max?: number;
  /** Allowed values of an `enum` option. */
  values?: string[];
}

/** `settings.set`: the value before and after. */
export interface SettingEdit {
  id: string;
  /** Null when the option had no value before. */
  previous: SettingValue | null;
  value: SettingValue;
  /**
   * True when the game wrote `options.txt` itself, false when the change is live only and is lost on restart unless
   * the game saves later. Absent when the agent does not report it.
   */
  saved?: boolean;
}

export const GAME_TYPES = ["survival", "creative", "adventure", "spectator"] as const;
export type GameType = (typeof GAME_TYPES)[number];

/**
 * What the loaded level itself says (`world.settings`). A field the engine cannot read is null, never guessed; game
 * rules are the level's own keys of the same name (`keepinventory`, `dodaylightcycle`, ...).
 */
export interface WorldState {
  name: string | null;
  /** Level seed as text: it is an int64, which a JSON number cannot hold exactly. */
  seed: string | null;
  gameType: GameType | null;
  difficulty: Difficulty | null;
  cheats: boolean | null;
  education: boolean | null;
  experiments: string[];
  gamerules: Record<string, boolean | number>;
  /** Game time in ticks (0 to 24000 is one day). */
  time: number | null;
  /** Whether the day/night cycle runs (`dodaylightcycle`). */
  dayCycle: boolean | null;
  weather: { rain: boolean; lightning: boolean } | null;
  spawn: [number, number, number] | null;
  /** Numeric dimension id, or its name when the engine reports one. */
  dimension: string | number | null;
}

/** What `world.set` may change. The game applies it the way it applies its own command, never as a memory write. */
export interface WorldChange {
  gamerules?: Record<string, boolean | number>;
  difficulty?: Difficulty;
  gameType?: GameType;
  time?: number;
  weather?: { rain: boolean; lightning: boolean };
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Plain object guard for the JSON the agent sends. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function vec(v: unknown, n: 2 | 3): number[] | undefined {
  return Array.isArray(v) && v.length >= n && v.slice(0, n).every(finite) ? (v.slice(0, n) as number[]) : undefined;
}

/** A `tick` notification's params, or undefined when it lacks the position or rotation. */
export function parseTick(raw: unknown): EngineTick | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const position = vec(r.position, 3);
  const rotation = vec(r.rotation, 2);
  if (!finite(r.tick) || !position || !rotation) return undefined;
  return {
    tick: r.tick,
    position: position as [number, number, number],
    rotation: rotation as [number, number],
    velocity: (vec(r.velocity, 3) ?? [0, 0, 0]) as [number, number, number],
    onGround: typeof r.onGround === "boolean" ? r.onGround : null,
    health: finite(r.health) ? r.health : null,
    selectedSlot: finite(r.selectedSlot) ? r.selectedSlot : null,
  };
}

/** A `settings.list` or `settings.get` entry, or undefined when the engine sent something else. */
export function parseSetting(raw: unknown): GameSetting | undefined {
  if (!isRecord(raw)) return undefined;
  const r = raw;
  const value = settingValue(r.value);
  if (typeof r.id !== "string" || !r.id || value === undefined) return undefined;
  const type = (SETTING_TYPES as readonly string[]).includes(r.type as string)
    ? (r.type as SettingType)
    : typeof value === "boolean"
      ? "bool"
      : typeof value === "number"
        ? "float"
        : "string";
  const setting: GameSetting = { id: r.id, type, value };
  if (finite(r.min)) setting.min = r.min;
  if (finite(r.max)) setting.max = r.max;
  if (Array.isArray(r.values) && r.values.every((v) => typeof v === "string")) setting.values = [...(r.values as string[])];
  return setting;
}

function settingValue(v: unknown): SettingValue | undefined {
  if (typeof v === "boolean" || typeof v === "string") return v;
  return finite(v) ? v : undefined;
}

/** A `world.settings` answer, with every field the engine could not read left null. */
export function normalizeWorld(raw: unknown): WorldState {
  const r = isRecord(raw) ? raw : {};
  const gamerules: Record<string, boolean | number> = {};
  if (isRecord(r.gamerules)) {
    for (const [name, value] of Object.entries(r.gamerules)) if (typeof value === "boolean" || finite(value)) gamerules[name] = value;
  }
  const weather = isRecord(r.weather) ? r.weather : undefined;
  const spawn =
    Array.isArray(r.spawn) && r.spawn.length >= 3 && r.spawn.slice(0, 3).every(finite) ? (r.spawn.slice(0, 3) as [number, number, number]) : null;
  return {
    name: typeof r.name === "string" ? r.name : null,
    seed: typeof r.seed === "string" || typeof r.seed === "bigint" ? String(r.seed) : finite(r.seed) ? String(r.seed) : null,
    gameType: gameTypeOf(r.gameType) ?? null,
    difficulty: difficultyOf(r.difficulty) ?? null,
    cheats: typeof r.cheats === "boolean" ? r.cheats : null,
    education: typeof r.education === "boolean" ? r.education : null,
    experiments: Array.isArray(r.experiments) ? r.experiments.filter((e): e is string => typeof e === "string") : [],
    gamerules,
    time: finite(r.time) ? r.time : null,
    dayCycle: typeof r.dayCycle === "boolean" ? r.dayCycle : null,
    weather: weather && typeof weather.rain === "boolean" && typeof weather.lightning === "boolean" ? { rain: weather.rain, lightning: weather.lightning } : null,
    spawn,
    dimension: typeof r.dimension === "string" || finite(r.dimension) ? (r.dimension as string | number) : null,
  };
}

/** A difficulty from its name or its level.dat number, or undefined. */
export function difficultyOf(raw: unknown): Difficulty | undefined {
  const names = Object.keys(DIFFICULTIES) as Difficulty[];
  if (typeof raw === "string") return names.find((name) => name === raw);
  return finite(raw) && Number.isInteger(raw) ? names[raw] : undefined;
}

/** A game type from its name or its level.dat number, or undefined. */
export function gameTypeOf(raw: unknown): GameType | undefined {
  if (typeof raw === "string" && (GAME_TYPES as readonly string[]).includes(raw)) return raw as GameType;
  return finite(raw) && Number.isInteger(raw) ? GAME_TYPES[raw] : undefined;
}

/** `world.set` parameters, or why the change cannot be expressed. */
function worldChangeParams(change: WorldChange): Record<string, unknown> | string {
  const params: Record<string, unknown> = {};
  if (change.gamerules) {
    const rules: Record<string, boolean | number> = {};
    for (const [name, value] of Object.entries(change.gamerules)) {
      if (!name.trim()) return "a game rule needs a name";
      if (typeof value !== "boolean" && !finite(value)) return `game rule ${name} must be true, false or a number`;
      rules[name] = value;
    }
    if (Object.keys(rules).length) params.gamerules = rules;
  }
  const difficulty = change.difficulty as string | undefined;
  if (difficulty !== undefined) {
    if (difficultyOf(difficulty) === undefined) return `difficulty must be one of ${Object.keys(DIFFICULTIES).join(", ")}`;
    params.difficulty = difficulty;
  }
  const gameType = change.gameType as string | undefined;
  if (gameType !== undefined) {
    if (gameTypeOf(gameType) === undefined) return `gameType must be one of ${GAME_TYPES.join(", ")}`;
    params.gameType = gameType;
  }
  if (change.time !== undefined) {
    if (!Number.isInteger(change.time) || change.time < 0 || change.time > 24000) return "time must be whole ticks from 0 to 24000";
    params.time = change.time;
  }
  if (change.weather !== undefined) params.weather = { rain: change.weather.rain === true, lightning: change.weather.lightning === true };
  return Object.keys(params).length ? params : "give at least one of gamerules, difficulty, gameType, time or weather";
}

export type EngineFailureReason =
  | "anchor_missing"
  | "not_in_world"
  | "wrong_thread"
  | "timeout"
  | "command_failed"
  | "path_not_writable"
  | "scripting_unavailable"
  | "unknown_method"
  | "invalid_params"
  | "not_attached"
  | "disconnected"
  | "protocol"
  | "rpc_error";

export interface EngineFailure {
  ok: false;
  /** JSON-RPC error code from the agent, -32602 for input this client rejected, -32000 for transport failures. */
  code: number;
  reason: EngineFailureReason;
  anchor?: string;
  message: string;
}

export type EngineResult<T> = { ok: true; value: T } | EngineFailure;

/** Reasons that mean the caller has to fix the setup, so the CLI exits 2 rather than 1. */
const SETUP_REASONS: Readonly<Partial<Record<EngineFailureReason, boolean>>> = {
  not_attached: true,
  disconnected: true,
  invalid_params: true,
};

export function isSetupFailure(failure: EngineFailure): boolean {
  return SETUP_REASONS[failure.reason] === true;
}

const RPC_REASONS: Readonly<Record<number, EngineFailureReason>> = {
  [-32601]: "unknown_method",
  [-32602]: "invalid_params",
  [-32001]: "anchor_missing",
  [-32002]: "not_in_world",
  [-32003]: "wrong_thread",
  [-32004]: "timeout",
  [-32006]: "command_failed",
  [-32007]: "path_not_writable",
  [-32014]: "scripting_unavailable",
};

function invalid(message: string): EngineFailure {
  return { ok: false, code: -32602, reason: "invalid_params", message };
}

/** The agent answered with a shape this client does not know, so the value cannot be trusted. */
function malformed(method: string, value: unknown): EngineFailure {
  return { ok: false, code: -32000, reason: "protocol", message: `${method} answered ${JSON.stringify(value)}` };
}

/** The chat line typed when the agent has no player command origin yet: no side effect, and its output is dropped. */
const PRIME_LINE = "testfor @s";
const CHAT_SCREEN = "chat_screen";
/** How long the chat line may take to reach the server and be captured. */
const PRIME_WAIT_MS = 5_000;
/** How long `t` may take to open the chat, and Return to close it. */
const PRIME_SCREEN_MS = 3_000;
const PRIME_POLL_MS = 150;

/** The agent cannot run commands until a player command was seen in this world. */
function needsOrigin(result: EngineResult<unknown>): result is EngineFailure {
  return !result.ok && result.reason === "anchor_missing" && (result.anchor === "command.origin" || result.anchor === "command.commands");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fills absent core fields so a partial or older status still satisfies the tool schema, and keeps each diagnostic
 * field of `ENGINE_STATUS_DIAGNOSTICS` the agent reports in its own shape; one that is absent or does not parse is
 * left out rather than failing the whole status.
 */
export function normalizeStatus(raw: Partial<EngineStatus> | undefined): EngineStatus {
  const resolved: Record<string, string> = {};
  if (raw?.resolved && typeof raw.resolved === "object") {
    for (const [anchor, address] of Object.entries(raw.resolved)) if (typeof address === "string") resolved[anchor] = address;
  }
  const missing = Array.isArray(raw?.missing) ? raw.missing.filter((entry): entry is string => typeof entry === "string") : [];
  const extra: EngineStatusDiagnostics = {};
  for (const [key, schema] of Object.entries(ENGINE_STATUS_DIAGNOSTICS)) {
    const field = schema.safeParse(raw?.[key as keyof EngineStatusDiagnostics]);
    if (field.success) Object.assign(extra, { [key]: field.data });
  }
  return {
    build: typeof raw?.build === "string" ? raw.build : "unknown",
    hooked: raw?.hooked === true,
    tick: typeof raw?.tick === "number" ? raw.tick : 0,
    resolved,
    missing,
    ...extra,
  };
}

/** Port from `SCULKWIRE_AGENT_PORT`, the same variable the DLL reads, or the default. */
export function enginePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SCULKWIRE_AGENT_PORT;
  if (!raw) return ENGINE_DEFAULT_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : ENGINE_DEFAULT_PORT;
}

/** Default screenshot target under `cacheDir("screenshots")`. */
export function defaultScreenshotPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return cacheDir("screenshots", `engine-${stamp}.png`);
}

/** Why we could not set the session up. Every stage is the caller's environment, so the CLI exits 2. */
export class EngineAttachError extends Error {
  readonly stage: "client" | "build" | "inject" | "connect";
  constructor(stage: EngineAttachError["stage"], detail: string, options?: { cause?: unknown }) {
    super(detail);
    this.stage = stage;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export interface EngineClientCheck {
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  /** Game folders to search when the install names none (`gameDirCandidates`, `SCULKWIRE_GAME_DIRS`). */
  candidates?: () => readonly string[];
}

/**
 * The game folder an install runs from, which the injector names on the command line. Any PC (GDK) install works: the
 * agent does not care which build it is injected into. It does care that the game is the native Windows process, so a
 * Wine or Proton install (what every Linux launcher uses) is only supported off Windows, and a native install only on
 * Windows. An install without a game folder (`SCULKWIRE_MINECRAFT_DIR` without `SCULKWIRE_GAME_DIR`) uses the first
 * candidate folder that holds `Minecraft.Windows.exe`.
 */
export function engineGameDir(install: ClientInstall, check: EngineClientCheck = {}): string {
  const exists = check.exists ?? existsSync;
  const platform = check.platform ?? process.platform;
  const supported = platform === "win32" ? !install.wine : install.wine;
  if (!supported) {
    throw new EngineAttachError(
      "client",
      `the in-game agent needs the game's Windows process: ${install.label} (${install.kind}) runs ` +
        `${install.wine ? "under Wine, which only works off Windows" : "natively, which only works on Windows"} (this is ${platform})`,
    );
  }
  const gameDir =
    install.gameDir ??
    (check.candidates ?? (() => gameDirCandidates()))().find((dir) => exists(join(dir, "Minecraft.Windows.exe")));
  if (!gameDir) {
    throw new EngineAttachError(
      "client",
      `cannot find Minecraft.Windows.exe for ${install.label}: set SCULKWIRE_GAME_DIR to the game folder`,
    );
  }
  if (!exists(join(gameDir, "Minecraft.Windows.exe"))) {
    throw new EngineAttachError("client", `${install.label} has no Minecraft.Windows.exe in ${gameDir}`);
  }
  return gameDir;
}

export interface EngineSessionOptions {
  /** Agent port. Defaults to `SCULKWIRE_AGENT_PORT` or 19160. */
  port?: number;
  /** Client-side backstop for every call. The agent's own drain timeout answers first. */
  timeoutMs?: number;
  /** Install whose `screenshots` gallery is searched before an attach has resolved one. */
  install?: ClientInstall;
}

export interface EngineAttachOptions {
  /** Skip install detection, for callers that already resolved one. */
  install?: ClientInstall;
  /** Recompile the DLL even when the cache entry exists. */
  force?: boolean;
}

/** Opens a socket, retrying while the DLL's listener thread starts. */
async function connectWithRetry(port: number, timeoutMs = 5000): Promise<AgentClient> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    const client = new AgentClient({ port });
    try {
      await client.connect(1000);
      return client;
    } catch (err) {
      last = err;
      client.close();
    }
    if (Date.now() - start >= timeoutMs) throw last;
    await sleep(100);
  }
}

export class EngineSession {
  readonly port: number;
  readonly timeoutMs: number;
  #client: AgentClient | undefined;
  #connecting: Promise<AgentClient> | undefined;
  #attaching: Promise<EngineStatus> | undefined;
  #everAttached = false;
  #install: ClientInstall | undefined;
  #build: AgentBuild | undefined;
  #injection: InjectionResult | undefined;
  #paused = false;
  #tickListeners = new Set<EngineTickListener>();
  /** The client `stream.subscribe` ran on, and at what interval. A new connection needs a new subscription. */
  #subscribed: { client: AgentClient; every: number; off: () => void } | undefined;
  #lastTick: { at: number; tick: EngineTick } | undefined;
  /** The input lock. Its state follows `input.lock` answers and the DLL's `lock` notifications. */
  readonly lock = new InputLock(
    (params) => this.#call("input.lock", params, { timeoutMs: INPUT_TIMEOUT_MS }),
    () => this.#ensureCommandOrigin(),
  );
  /** The host focus this process watches (`src/focus.ts`, driven by `src/provider.ts`), or undefined when it watches none. */
  #hostFocused: boolean | undefined;

  constructor(options: EngineSessionOptions = {}) {
    this.port = options.port ?? enginePort();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#install = options.install;
  }

  /** True while a connected agent socket exists. */
  get attached(): boolean {
    return this.#client?.connected === true;
  }

  get install(): ClientInstall | undefined {
    return this.#install;
  }

  get build(): AgentBuild | undefined {
    return this.#build;
  }

  get injection(): InjectionResult | undefined {
    return this.#injection;
  }

  /**
   * Build, inject, connect and verify `engine.status`. Concurrent calls share one attach. A session that is already
   * connected only refreshes its status, so the common MCP path never recompiles or re-injects.
   */
  async attach(options: EngineAttachOptions = {}): Promise<EngineStatus> {
    this.#attaching ??= this.#attach(options).finally(() => {
      this.#attaching = undefined;
    });
    return this.#attaching;
  }

  async #attach(options: EngineAttachOptions): Promise<EngineStatus> {
    if (this.#everAttached && this.#client?.connected) {
      const current = await this.status();
      if (current.ok) return current.value;
    }
    let install: ClientInstall;
    try {
      install = options.install ?? (await findInstall());
    } catch (err) {
      throw new EngineAttachError("client", message(err), { cause: err });
    }
    // Any PC (GDK) install works: what has to hold is that the game is the Windows process and its folder exists, so
    // the injector's route agrees with this OS before anything is built or injected. The folder also decides whether
    // an extension source supplies the agent, so the build waits for it.
    const gameDir = engineGameDir(install);
    let build: AgentBuild;
    try {
      build = await buildAgent({ gameDir, ...(options.force ? { force: true } : {}) });
    } catch (err) {
      throw new EngineAttachError("build", message(err), { cause: err });
    }
    let injection: InjectionResult;
    try {
      injection = await injectClient({ install, build });
    } catch (err) {
      throw new EngineAttachError(
        "inject",
        `${message(err)}. Start the game first, then attach, so the injector finds Minecraft.Windows.exe`,
        { cause: err },
      );
    }
    try {
      // A bare `status` can have connected without attaching. Replace that socket rather than leaking it.
      this.#client?.close();
      this.#client = undefined;
      this.#client = this.#adopt(await connectWithRetry(this.port));
    } catch (err) {
      throw new EngineAttachError(
        "connect",
        `injected into pid ${injection.pid}, but nothing accepted a connection on 127.0.0.1:${this.port}: ${message(err)}. ` +
          `The agent log is ${join(build.dir, "sculkwire-agent.log")}`,
        { cause: err },
      );
    }
    this.#install = install;
    this.#build = build;
    this.#injection = injection;
    const status = await this.#resolvedStatus();
    if (!status.ok) {
      throw new EngineAttachError(
        "connect",
        `connected to 127.0.0.1:${this.port}, but engine.status failed (${status.reason}): ${status.message}`,
      );
    }
    this.#everAttached = true;
    return status.value;
  }

  /**
   * `engine.status` once the agent's own attach has resolved every anchor. Right after the injection the agent already
   * answers but is still resolving (`attached: false`, every anchor listed missing); an agent that does not report the
   * field is taken as finished.
   */
  async #resolvedStatus(): Promise<EngineResult<EngineStatus>> {
    const deadline = Date.now() + ATTACH_RESOLVE_MS;
    for (;;) {
      const result = await this.#call<(Partial<EngineStatus> & { attached?: unknown }) | undefined>("engine.status", {});
      if (!result.ok) return result;
      if (result.value?.attached !== false || Date.now() >= deadline) return { ok: true, value: normalizeStatus(result.value) };
      await sleep(ATTACH_RESOLVE_POLL_MS);
    }
  }

  /** `engine.status`. Connects to an agent that is already loaded when this session has not attached yet. */
  async status(): Promise<EngineResult<EngineStatus>> {
    const result = await this.#call<Partial<EngineStatus> | undefined>("engine.status", {});
    return result.ok ? { ok: true, value: normalizeStatus(result.value) } : result;
  }

  /**
   * True when an agent answers on this session's port. A session that has not attached yet connects to an agent that
   * is already loaded (a `sculk` command in a new process, an MCP server started after the attach), so a route that
   * has a file fallback does not write a file the running game owns while the agent could have answered.
   */
  async reachable(): Promise<boolean> {
    if (this.attached) return true;
    try {
      await this.#ensureClient();
      return true;
    } catch {
      return false;
    }
  }

  /** `engine.resolve`: re-run every anchor recipe, then report the same shape as `engine.status`. */
  async resolve(): Promise<EngineResult<EngineStatus>> {
    const result = await this.#call<Partial<EngineStatus> | undefined>("engine.resolve", {});
    return result.ok ? { ok: true, value: normalizeStatus(result.value) } : result;
  }

  /**
   * `command`. The line runs on the game's main thread through the engine's command dispatcher, as if typed by the
   * local player. A leading slash is optional and a newline is rejected because the engine would split it into several
   * commands.
   *
   * The agent replays the origin of a real player command, so until the player has run one in this world it answers
   * -32001 `command.origin` (or `command.commands`). Then this types one line in chat itself (see #primeCommandOrigin)
   * and runs the requested command once the origin is captured.
   */
  async command(command: string): Promise<EngineResult<EngineCommandResult>> {
    if (/[\r\n]/.test(command)) return invalid("a command cannot contain a newline");
    const line = command.trim().replace(/^\//, "");
    if (!line) return invalid("a command cannot be empty");
    const run = () => this.#call<EngineCommandResult>("command", { command: line }, { timeoutMs: COMMAND_TIMEOUT_MS });
    const first = await run();
    if (!needsOrigin(first)) return first;
    const primed = await this.#primeCommandOrigin();
    if (!primed.ok) return { ...first, message: `${first.message} (sculkwire could not type it for you: ${primed.message})` };
    const deadline = Date.now() + PRIME_WAIT_MS;
    for (;;) {
      const result = await run();
      if (!needsOrigin(result) || Date.now() >= deadline) return result;
      await sleep(PRIME_POLL_MS);
    }
  }

  /**
   * Types one harmless line (`PRIME_LINE`) in chat so the game builds a player command origin the agent can replay:
   * only while the player is in a world with no screen open (the HUD alone), only into the chat screen this opened,
   * and with its output kept out of chat by the agent (`command.prime`). Never types into any other screen.
   */
  async #primeCommandOrigin(): Promise<EngineResult<true>> {
    const before = await this.uiScreen();
    if (!before.ok) return before;
    // In a world with no screen open: the HUD is the only scene.
    const hudOnly = before.value.name === "hud_screen" && !before.value.modal && before.value.stack.every((name) => name === "hud_screen");
    if (!hudOnly) return invalid(`a screen is open (${uiScreenText(before.value)}): run one line in chat yourself and retry`);
    // An older agent without `command.prime` still captures the origin; the line's output then shows in chat.
    const armed = await this.#call("command.prime", {});
    if (!armed.ok && armed.reason !== "unknown_method") return armed;
    const opened = await this.uiKey("t");
    if (!opened.ok) return opened;
    const chat = await this.#waitScreen((screen) => screen.name === CHAT_SCREEN && screen.stack.length <= 2);
    if (!chat.ok) {
      // `t` opened something else (or nothing): leave it untouched apart from closing it, and type nothing.
      const now = await this.uiScreen();
      if (now.ok && now.value.name !== "hud_screen") await this.uiKey("Escape");
      return chat;
    }
    const typed = await this.uiText(`/${PRIME_LINE}`);
    if (!typed.ok) {
      await this.uiKey("Escape");
      return typed;
    }
    // Return only while the chat screen is still the one in front.
    const still = await this.uiScreen();
    if (!still.ok || still.value.name !== CHAT_SCREEN) return still.ok ? invalid(`the chat closed before Return (now ${still.value.name})`) : still;
    const sent = await this.uiKey("Return");
    if (!sent.ok) return sent;
    // The chat lingers in the stack (under the HUD, modal) while it closes: Escape is only sent when it is still the
    // screen in front after the wait, since an Escape on the HUD would open the pause menu instead.
    const closed = await this.#waitScreen((screen) => !screen.stack.includes(CHAT_SCREEN));
    if (!closed.ok) {
      const now = await this.uiScreen();
      if (now.ok && now.value.name === CHAT_SCREEN) await this.uiKey("Escape");
    }
    return { ok: true, value: true };
  }

  /**
   * Makes sure the agent has a player command of this world to replay before the lock turns on: its camera gate and
   * badge are quiet commands, which the agent only attempts with that origin. A gate that already ran in this world
   * (`camera` reported) needs nothing; otherwise one quiet no-op command runs, and the origin is primed when it is
   * missing. Outside a world it does nothing.
   */
  async #ensureCommandOrigin(): Promise<void> {
    if (this.lock.state?.camera) return;
    const result = await this.#call("command", { command: PRIME_LINE, quiet: true }, { timeoutMs: INPUT_TIMEOUT_MS });
    if (needsOrigin(result)) await this.#primeCommandOrigin();
  }

  /** Polls `ui.screen` until `test` holds, for at most `PRIME_SCREEN_MS`. */
  async #waitScreen(test: (screen: UiScreen) => boolean): Promise<EngineResult<UiScreen>> {
    const deadline = Date.now() + PRIME_SCREEN_MS;
    for (;;) {
      const screen = await this.uiScreen();
      if (!screen.ok) return screen;
      if (test(screen.value)) return screen;
      if (Date.now() >= deadline) return { ok: false, code: -32004, reason: "timeout", message: `the screen stayed ${uiScreenText(screen.value)}` };
      await sleep(PRIME_POLL_MS);
    }
  }

  /**
   * True after this session paused the simulation (engine_tick pause or step) and did not resume. Only while the agent
   * connection is up: a game that stopped or restarted is no longer paused.
   */
  get paused(): boolean {
    return this.#paused && this.attached;
  }

  /**
   * `tick.pause`, `tick.step` or `tick.scale`. Exactly one argument is required. `step` is an integer from 1 to 600
   * so a single drain cannot run an unbounded simulation.
   */
  async tick(args: EngineTickArgs): Promise<EngineResult<EngineTickResult>> {
    const given = [args.pause !== undefined, args.step !== undefined, args.scale !== undefined].filter(Boolean).length;
    if (given !== 1) return invalid("give exactly one of pause, step or scale");
    if (args.pause !== undefined) {
      if (typeof args.pause !== "boolean") return invalid("pause must be a boolean");
      const result = await this.#call<EngineTickResult>("tick.pause", { paused: args.pause });
      if (result.ok) this.#paused = result.value.paused ?? args.pause;
      return result;
    }
    if (args.step !== undefined) {
      if (!Number.isInteger(args.step) || args.step < 1 || args.step > 600) return invalid("step must be an integer from 1 to 600");
      const result = await this.#call<EngineTickResult>("tick.step", { count: args.step }, { timeoutMs: STEP_TIMEOUT_MS });
      // A step leaves the simulation paused.
      if (result.ok) this.#paused = true;
      return result;
    }
    if (typeof args.scale !== "number" || !Number.isFinite(args.scale) || args.scale <= 0) {
      return invalid("scale must be a positive number");
    }
    return this.#call("tick.scale", { value: args.scale });
  }

  /**
   * `screenshot`. `path` is a host path. The game writes the PNG into its own gallery
   * (`<appData>/screenshots/<world>/photos/<id>/`). The call carries a unique name; an agent that takes the picture
   * through the game's own screenshot button answers `named: false` (the game picks the file name), and then the
   * newest complete PNG the gallery gained after the request is the picture. Either way it is copied to `path`, and
   * the game's gallery copy stays.
   */
  async screenshot(path: string): Promise<EngineResult<EngineScreenshotResult>> {
    if (!path.trim()) return invalid("screenshot path cannot be empty");
    const unix = resolve(path);
    try {
      await mkdir(dirname(unix), { recursive: true });
    } catch (err) {
      return { ok: false, code: -32007, reason: "path_not_writable", message: `cannot create ${dirname(unix)}: ${message(err)}` };
    }
    const name = `sculkwire-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const requested = join(dirname(unix), `${name}.png`);
    const install = this.#install ?? (await findInstall().catch(() => undefined));
    const searched = install ? galleries(install) : [];
    // Every gallery picture that exists before the request is an older shot, however recent its mtime.
    const before = await galleryPictures(searched);
    const result = await this.#call<{ named?: unknown } | undefined>("screenshot", { path: gamePath(requested) }, { timeoutMs: SCREENSHOT_TIMEOUT_MS });
    if (!result.ok) return result;
    const named = result.value?.named !== false;
    const written = await findScreenshot(requested, searched, named ? undefined : before);
    if (!written) {
      return {
        ok: false,
        code: -32004,
        reason: "timeout",
        message: `the game accepted the screenshot but ${named ? `${name}.png did not appear` : "no new gallery picture appeared"} within ${SCREENSHOT_FILE_WAIT_MS / 1000} s`,
      };
    }
    // A JPEG keeps its own extension, so the file says what it holds.
    const target = written.format === "jpeg" ? unix.replace(/\.png$/i, "") + (/\.jpe?g$/i.test(unix) ? "" : ".jpg") : unix;
    try {
      // The name is ours: a file in the target directory is a leftover to move, a gallery file is the game's to keep.
      if (written.file === requested) await rename(written.file, target);
      else await copyFile(written.file, target);
      return { ok: true, value: { path: target, bytes: (await stat(target)).size, format: written.format } };
    } catch (err) {
      return { ok: false, code: -32007, reason: "path_not_writable", message: `cannot copy ${written.file} to ${target}: ${message(err)}` };
    }
  }

  /** `player.state`, normalized. `dimension` is a numeric dimension id, or null when the agent does not decode it. */
  async playerState(): Promise<EngineResult<EnginePlayerState>> {
    const result = await this.#call<unknown>("player.state");
    return result.ok ? { ok: true, value: normalizePlayerState(result.value) } : result;
  }

  /**
   * `input.look`: the view rotation the game shows from the next frame. Pitch -90 to 90 (+ looks down), yaw as the
   * game reports it (0 = +Z); any finite yaw is wrapped by the engine.
   */
  async look(pitch: number, yaw: number): Promise<EngineResult<{ pitch: number; yaw: number }>> {
    if (!finite(pitch) || pitch < -90 || pitch > 90) return invalid("pitch must be a number from -90 to 90");
    if (!finite(yaw)) return invalid("yaw must be a finite number");
    return this.#call("input.look", { pitch, yaw }, { timeoutMs: INPUT_TIMEOUT_MS });
  }

  /**
   * `input.move`: held movement applied every tick until changed. The agent releases it by itself when no update
   * arrives for a second, so a holder has to repeat it more often than that.
   */
  async move(move: Partial<EngineMove>): Promise<EngineResult<Record<string, never>>> {
    const forward = move.forward ?? 0;
    const strafe = move.strafe ?? 0;
    if (!finite(forward) || forward < -1 || forward > 1) return invalid("forward must be a number from -1 to 1");
    if (!finite(strafe) || strafe < -1 || strafe > 1) return invalid("strafe must be a number from -1 to 1");
    const params: EngineMove = { forward, strafe, jump: move.jump === true, sneak: move.sneak === true, sprint: move.sprint === true };
    return this.#call("input.move", params, { timeoutMs: INPUT_TIMEOUT_MS });
  }

  /** `input.release`: drop every held movement input. */
  release(): Promise<EngineResult<unknown>> {
    return this.#call("input.release", {}, { timeoutMs: INPUT_TIMEOUT_MS });
  }

  /**
   * `input.attack`: swing at whatever is under the crosshair, as a click. `hit` is the struck entity's id; `target` is
   * the crosshair's target as the agent read it (`{kind: "block", block, face, position}` or `{kind: "entity", id,
   * type, position}`), null when nothing in reach or an older agent.
   */
  async attack(): Promise<EngineResult<{ hit: string | null; target: Record<string, unknown> | null }>> {
    const result = await this.#call<{ hit?: unknown; target?: unknown } | undefined>("input.attack", {}, { timeoutMs: INPUT_TIMEOUT_MS });
    if (!result.ok) return result;
    const hit = result.value?.hit;
    const target = result.value?.target;
    return {
      ok: true,
      value: {
        hit: typeof hit === "string" || typeof hit === "number" ? String(hit) : null,
        target: target && typeof target === "object" && !Array.isArray(target) ? (target as Record<string, unknown>) : null,
      },
    };
  }

  /**
   * `input.use`: no `hold` is one click, `hold: true` presses and keeps holding (a bow draw), `hold: false` lets go. The
   * agent lets a held button go a second after the last `hold: true`, so a hold is renewed by repeating it.
   */
  use(hold?: boolean): Promise<EngineResult<unknown>> {
    return this.#call("input.use", hold === undefined ? {} : { hold }, { timeoutMs: INPUT_TIMEOUT_MS });
  }

  /**
   * `input.attack {hold}`: `true` presses the attack button and keeps holding it (breaking the block under the
   * crosshair), `false` lets go. Renewed by repeating `true` within a second, like `use`.
   */
  attackHold(hold: boolean): Promise<EngineResult<unknown>> {
    return this.#call("input.attack", { hold }, { timeoutMs: INPUT_TIMEOUT_MS });
  }

  /** The newest `tick` notification and when it arrived (Date.now()), if any arrived on the current connection. */
  get lastTick(): { at: number; tick: EngineTick } | undefined {
    return this.#subscribed?.client.connected ? this.#lastTick : undefined;
  }

  /**
   * Receive the tick stream: `listener` gets every `tick` notification. The first listener (and a new connection)
   * sends `stream.subscribe`, a smaller `every` than the current one re-subscribes, and the returned function
   * removes the listener, unsubscribing after the last one. Listeners stay registered across a reconnect, but the
   * stream only resumes when something subscribes again.
   */
  async subscribeTicks(listener: EngineTickListener, every = 1): Promise<EngineResult<() => Promise<void>>> {
    if (!Number.isInteger(every) || every < 1 || every > 1200) return invalid("every must be an integer from 1 to 1200");
    this.#tickListeners.add(listener);
    const result = await this.#ensureTicks(every);
    if (!result.ok) {
      this.#tickListeners.delete(listener);
      return result;
    }
    return {
      ok: true,
      value: async () => {
        if (!this.#tickListeners.delete(listener) || this.#tickListeners.size > 0) return;
        const sub = this.#subscribed;
        this.#subscribed = undefined;
        this.#lastTick = undefined;
        if (!sub) return;
        sub.off();
        if (sub.client.connected) await sub.client.unsubscribe().catch(() => undefined);
      },
    };
  }

  async #ensureTicks(every: number): Promise<EngineResult<unknown>> {
    let client: AgentClient;
    try {
      client = await this.#ensureClient();
    } catch (err) {
      return this.#failure(err);
    }
    const current = this.#subscribed;
    if (current?.client === client && current.every <= every) return { ok: true, value: { ok: true } };
    const off = current?.client === client ? current.off : client.on("tick", (params) => this.#onTick(params));
    try {
      await client.subscribe(every);
    } catch (err) {
      if (current?.client !== client) off();
      return this.#failure(err);
    }
    if (current && current.client !== client) current.off();
    this.#subscribed = { client, every, off };
    return { ok: true, value: { ok: true } };
  }

  #onTick(params: unknown): void {
    const tick = parseTick(params);
    if (!tick) return;
    const at = Date.now();
    this.#lastTick = { at, tick };
    for (const listener of [...this.#tickListeners]) {
      try {
        listener(tick, at);
      } catch {
        // one consumer's bug does not stop the others
      }
    }
  }

  /** Closes the socket and forgets the attach, so the next call starts from the default port again. */
  close(): void {
    this.#client?.close();
    this.#client = undefined;
    this.#everAttached = false;
    this.#paused = false;
    this.#subscribed?.off();
    this.#subscribed = undefined;
    this.#lastTick = undefined;
    this.#tickListeners.clear();
    this.lock.reset();
    this.#install = undefined;
    this.#build = undefined;
    this.#injection = undefined;
  }

  async #ensureClient(): Promise<AgentClient> {
    if (this.#client?.connected) return this.#client;
    this.#connecting ??= (async () => {
      const client = new AgentClient({ port: this.port, timeoutMs: this.timeoutMs });
      try {
        await client.connect(1500);
      } catch (err) {
        client.close();
        throw err;
      }
      this.#client = this.#adopt(client);
      return client;
    })().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  /**
   * The game window's focus on the host desktop, for the agent's gate on polled input (`input.focus`). Sent now when
   * connected and again on every new connection. `undefined` stops reporting after telling the agent it is focused,
   * so a watcher that ends never leaves input blocked. Failures are ignored: the agent then keeps its last value,
   * which starts focused.
   */
  async setHostFocus(focused: boolean | undefined): Promise<void> {
    this.#hostFocused = focused;
    const client = this.#client;
    if (!client?.connected) return;
    const state = await client.call("input.focus", { focused: focused ?? true }, { timeoutMs: INPUT_TIMEOUT_MS }).then(parseLockState, () => undefined);
    if (state) this.lock.update(state);
  }

  /** Every connection receives `lock` notifications, and learns the watched host focus. */
  #adopt(client: AgentClient): AgentClient {
    client.on("lock", (params) => {
      const state = parseLockState(params);
      if (state) this.lock.update(state);
    });
    if (this.#hostFocused !== undefined) void client.call("input.focus", { focused: this.#hostFocused }, { timeoutMs: INPUT_TIMEOUT_MS }).catch(() => undefined);
    return client;
  }

  async #call<T>(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<EngineResult<T>> {
    try {
      const client = await this.#ensureClient();
      const value = await client.call<T>(method, params, options);
      return { ok: true, value };
    } catch (err) {
      return this.#failure(err);
    }
  }

  async #failure(err: unknown): Promise<EngineFailure> {
    if (err instanceof AgentRpcError) {
      // The agent says why in `error.data.message` ("no screen is open", "the chunk is not loaded"); the generic
      // JSON-RPC message alone ("invalid params") does not tell the caller what to change.
      const detail = (err.data as { message?: unknown } | undefined)?.message;
      const text = typeof detail === "string" && detail ? `${err.message}: ${detail}` : err.message;
      const failure: EngineFailure = { ok: false, code: err.code, reason: RPC_REASONS[err.code] ?? "rpc_error", message: text };
      if (failure.reason === "anchor_missing") {
        // The DLL puts the anchor in error.data. Older builds omit it, then take the only unresolved anchor from engine.status.
        const data = err.data as { anchor?: unknown } | undefined;
        const anchor = typeof data?.anchor === "string" ? data.anchor : await this.#missingAnchor();
        if (anchor) failure.anchor = anchor;
      }
      return failure;
    }
    if (err instanceof AgentClientError) {
      // A connected client that times out is not the same as no agent at all.
      const listening = this.#client?.connected === true;
      if (!listening && !this.#everAttached) {
        return {
          ok: false,
          code: -32000,
          reason: "not_attached",
          message: `no agent is listening on 127.0.0.1:${this.port} (${err.message}). Attach first with the game running`,
        };
      }
      return {
        ok: false,
        code: -32000,
        reason: err.kind === "closed" ? "disconnected" : err.kind,
        message: err.message,
      };
    }
    return { ok: false, code: -32000, reason: "protocol", message: message(err) };
  }

  /** One unresolved anchor is unambiguous. Several means the failing method's anchor cannot be named here. */
  async #missingAnchor(): Promise<string | undefined> {
    const client = this.#client;
    if (!client?.connected) return undefined;
    try {
      const raw = await client.call<Partial<EngineStatus> | undefined>("engine.status", {}, { timeoutMs: 1000 });
      const missing = normalizeStatus(raw).missing;
      return missing.length === 1 ? missing[0] : undefined;
    } catch {
      return undefined;
    }
  }

  /** `settings.list`: the game's own options, filtered by an id substring. */
  async settingsList(filter?: string): Promise<EngineResult<GameSetting[]>> {
    const trimmed = filter?.trim();
    const result = await this.#call<{ settings?: unknown }>("settings.list", trimmed ? { filter: trimmed } : {});
    if (!result.ok) return result;
    const raw = result.value?.settings;
    if (!Array.isArray(raw)) return malformed("settings.list", result.value);
    const settings = raw.map(parseSetting).filter((setting): setting is GameSetting => setting !== undefined);
    return { ok: true, value: settings.sort((a, b) => a.id.localeCompare(b.id)) };
  }

  /** `settings.get`: one option. An id the game does not know answers `invalid_params`. */
  async settingsGet(id: string): Promise<EngineResult<GameSetting>> {
    const key = id.trim();
    if (!key) return invalid("a setting id cannot be empty");
    const result = await this.#call<unknown>("settings.get", { id: key });
    if (!result.ok) return result;
    const setting = parseSetting(result.value);
    return setting ? { ok: true, value: setting } : malformed("settings.get", result.value);
  }

  /** `settings.set`: change an option now; the game applies it and saves it itself when it can. */
  async settingsSet(id: string, value: SettingValue): Promise<EngineResult<SettingEdit>> {
    const key = id.trim();
    if (!key) return invalid("a setting id cannot be empty");
    if (typeof value === "number" && !Number.isFinite(value)) return invalid("a setting value must be a finite number");
    const result = await this.#call<Record<string, unknown> | undefined>("settings.set", { id: key, value });
    if (!result.ok) return result;
    const raw = result.value;
    if (!raw || typeof raw.id !== "string" || raw.value === undefined) return malformed("settings.set", result.value);
    if (raw.saved !== undefined && typeof raw.saved !== "boolean") return malformed("settings.set", result.value);
    const before = raw.previous === undefined || raw.previous === null ? null : (settingValue(raw.previous) ?? null);
    const edit: SettingEdit = { id: raw.id, previous: before, value: settingValue(raw.value) ?? value };
    if (typeof raw.saved === "boolean") edit.saved = raw.saved;
    return { ok: true, value: edit };
  }

  /** `world.settings`: what the loaded level itself says. Needs a world, so `not_in_world` outside one. */
  async worldGet(): Promise<EngineResult<WorldState>> {
    const result = await this.#call<unknown>("world.settings", {});
    return result.ok ? { ok: true, value: normalizeWorld(result.value) } : result;
  }

  /** `world.set`: difficulty, game type, game time, weather or game rules, applied the way the game applies them. */
  async worldSet(change: WorldChange): Promise<EngineResult<WorldState>> {
    const params = worldChangeParams(change);
    if (typeof params === "string") return invalid(params);
    const result = await this.#call<unknown>("world.set", params);
    return result.ok ? { ok: true, value: normalizeWorld(result.value) } : result;
  }

  /**
   * `ui.screen`: the screen the game shows and the stack under it, in the game's own names (`start_screen`,
   * `play_screen`, `hud_screen`). Client main thread, no world needed, so it also answers in a menu.
   */
  async uiScreen(): Promise<EngineResult<UiScreen>> {
    const result = await this.#call<unknown>("ui.screen", {}, { timeoutMs: UI_TIMEOUT_MS });
    if (!result.ok) return result;
    const screen = parseUiScreen(result.value);
    return screen ? { ok: true, value: screen } : malformed("ui.screen", result.value);
  }

  /**
   * `ui.controls`: the visible controls of the current screen, by name (`ui.press` takes it), type, client-pixel rect
   * and the label the player reads. An empty list when the UI tree is readable but this screen has no control.
   */
  async uiControls(filter?: string): Promise<EngineResult<UiControl[]>> {
    const trimmed = filter?.trim();
    const result = await this.#call<unknown>("ui.controls", trimmed ? { filter: trimmed } : {}, { timeoutMs: UI_TIMEOUT_MS });
    if (!result.ok) return result;
    const controls = parseUiControls(result.value);
    return controls ? { ok: true, value: controls } : malformed("ui.controls", result.value);
  }

  /** `ui.press`: press a named control of the current screen through the game's own handler. */
  async uiPress(name: string): Promise<EngineResult<unknown>> {
    const control = name.trim();
    if (!control) return invalid("a control name cannot be empty");
    return this.#call("ui.press", { name: control }, { timeoutMs: UI_TIMEOUT_MS });
  }

  /**
   * `ui.key`: one key or chord (`ctrl+a`) through the game's own input path, so it lands without the game window being
   * in the foreground. `action` is a press (the default), a hold or a release.
   */
  async uiKey(key: string, action?: UiKeyAction): Promise<EngineResult<unknown>> {
    const params = keyParams(key, action);
    if (typeof params === "string") return invalid(params);
    return this.#call("ui.key", params, { timeoutMs: UI_TIMEOUT_MS });
  }

  /** `ui.text`: type into the focused text box of the current screen. */
  async uiText(text: string): Promise<EngineResult<unknown>> {
    const params = textParams(text);
    if (typeof params === "string") return invalid(params);
    return this.#call("ui.text", params, { timeoutMs: UI_TIMEOUT_MS });
  }

  /** `ui.click`: a click on the current screen at client pixels, the same frame a screenshot shows. */
  async uiClick(x: number, y: number, button?: UiButton): Promise<EngineResult<unknown>> {
    const params = clickParams(x, y, button);
    if (typeof params === "string") return invalid(params);
    return this.#call("ui.click", params, { timeoutMs: UI_TIMEOUT_MS });
  }

  /** `ui.scroll`: the wheel at a point of the current screen, `delta` whole notches (positive up). */
  async uiScroll(x: number, y: number, delta: number): Promise<EngineResult<unknown>> {
    const params = scrollParams(x, y, delta);
    if (typeof params === "string") return invalid(params);
    return this.#call("ui.scroll", params, { timeoutMs: UI_TIMEOUT_MS });
  }

  /** The generic RPC entry for feature modules that parse their own methods (inventory, containers, crafting). */
  call<T>(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<EngineResult<T>> {
    return this.#call<T>(method, params, options);
  }
}

/** Every PNG ends with this IEND chunk (zero length, type, CRC). The game writes the file in pieces. */
const PNG_END = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
/** Every JPEG ends with the EOI marker. */
const JPEG_END = Buffer.from([0xff, 0xd9]);

type PictureFormat = "png" | "jpeg";

function pictureFormat(file: string): PictureFormat | undefined {
  const lower = file.toLowerCase();
  if (lower.endsWith(".png")) return "png";
  if (lower.endsWith(".jpeg") || lower.endsWith(".jpg")) return "jpeg";
  return undefined;
}

/** True once `file` exists and ends with its format's end marker, i.e. the game finished writing it. */
async function pictureComplete(file: string, format: PictureFormat): Promise<boolean> {
  const end = format === "png" ? PNG_END : JPEG_END;
  let handle;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    if (size < end.length) return false;
    const tail = Buffer.alloc(end.length);
    await handle.read(tail, 0, tail.length, size - tail.length);
    return tail.equals(end);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/**
 * The galleries the game saves screenshots into: the account's `com.mojang/Screenshots` (the retail client keeps
 * `<id>/<uuid>.jpeg` there) and `screenshots` in the data folder (the world `photos` of other builds).
 */
function galleries(install: ClientInstall): string[] {
  const out = [join(install.appData, "screenshots")];
  if (install.userComMojang) out.unshift(join(install.userComMojang, "Screenshots"));
  return out;
}

/** Every PNG or JPEG under the galleries, as absolute paths. */
async function galleryPictures(galleries: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const gallery of galleries) {
    const entries = await readdir(gallery, { recursive: true }).catch(() => [] as string[]);
    for (const entry of entries) if (pictureFormat(entry)) out.add(join(gallery, entry));
  }
  return out;
}

/**
 * Polls for the screenshot: `direct` is the exact file, each gallery is searched recursively for the same file name.
 * With `before` (the game chose the name), the newest gallery PNG or JPEG not in that set is the picture instead.
 * Returns the first complete picture, or undefined when the wait runs out.
 */
async function findScreenshot(
  direct: string,
  galleries: string[],
  before?: Set<string>,
): Promise<{ file: string; format: PictureFormat } | undefined> {
  const fileName = basename(direct);
  const deadline = Date.now() + SCREENSHOT_FILE_WAIT_MS;
  for (;;) {
    const candidates = [direct];
    const fresh: { file: string; at: number }[] = [];
    for (const gallery of galleries) {
      const entries = await readdir(gallery, { recursive: true }).catch(() => [] as string[]);
      if (before === undefined) {
        for (const entry of entries) if (basename(entry) === fileName) candidates.push(join(gallery, entry));
        continue;
      }
      for (const entry of entries) {
        if (!pictureFormat(entry)) continue;
        const file = join(gallery, entry);
        if (before.has(file)) continue;
        const at = (await stat(file).catch(() => undefined))?.mtimeMs;
        if (at !== undefined) fresh.push({ file, at });
      }
    }
    fresh.sort((a, b) => b.at - a.at);
    candidates.push(...fresh.map((entry) => entry.file));
    for (const file of candidates) {
      const format = pictureFormat(file);
      if (format && (await pictureComplete(file, format))) return { file, format };
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(250);
  }
}

/** Process-wide session used by the MCP tools and the CLI. */
export const engine = new EngineSession();
