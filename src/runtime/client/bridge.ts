/**
 * One live client session for agents: the script debugger listener (the game auto-attaches through options.txt),
 * the `/connect` WebSocket server, a `sculkwire-` test world with the helper pack and the project's packs, the
 * content log, screenshots and input. Lives in the long-running MCP process; one bridge per process.
 *
 * Start sequence: options.txt keys (restored on stop) → listeners → world → launch with a deeplink into the world →
 * debugger attaches (the session sends `resume`, otherwise the world never finishes loading) → helper prints
 * `[sculkwire:ready]` → `/connect` is typed into chat where input reaches the game (gamescope's own display on Linux,
 * SendInput into the foreground game window on Windows).
 * When the deeplink join beats Microsoft sign-in the client rejects its LoginPacket and shows its connection-error
 * screen; `#finishStart` sees that in the engine log and `#returnToWorld` walks the menus back into the test world
 * (screens.ts), never relaunching the game.
 *
 * A game the user already started from the chosen install is attached instead (`#startAttached`): never restarted,
 * never written to; the in-game agent turns the channels on live and dials them with `/script debugger connect` and
 * `/connect`, or the user types those two commands. `stop` then only detaches.
 */
import { errorMessage } from "../../core/errors.ts";
import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Diagnostic } from "../../core/diagnostic.ts";
import { compareDiagnostics } from "../../core/diagnostic.ts";
import { readJsonOr } from "../../core/fs.ts";
import { dataDir } from "../../core/paths.ts";
import type { IndexedPack } from "../gamelog/logparse.ts";
import { printToDiagnostic, type PrintEvent } from "../debugger/print.ts";
import { listen, type DebuggerListener, type DebuggerSession } from "../debugger/session.ts";
import { ConnectServer, DEFAULT_CONNECT_PORT, type CommandResult } from "../connect/server.ts";
import type { DataKind } from "../connect/protocol.ts";
import {
  contentEnd,
  debugLogEnd,
  entryDiagnostics,
  indexProjectPacks,
  joinStateInLog,
  NO_JOIN_YET,
  parseClientLog,
  printEntries,
  readContentSince,
  readDebugLogSince,
  unmirroredPrints,
  type JoinState,
  type LogPosition,
} from "./contentlog.ts";
import { deployProject, type DeployedPack } from "./deploy.ts";
import { findInstall, optionsFiles, type ClientInstall } from "../../gamefiles/install.ts";
import { debuggerCommandOk, helperTraffic, loadFailureMatcher, type FailureMatcher } from "./commandfail.ts";
import {
  attachState,
  DEFAULT_FRAME,
  defaultMode,
  detachState,
  gamePids,
  gamescopeBlocker,
  hasInput,
  isAlive,
  launch,
  muteWindowsGame,
  playerInput,
  readLaunchState,
  screenshot,
  sendInput,
  stop as stopGame,
  systemPactl,
  typeChatCommand,
  waitForGame,
  writeLaunchState,
  type InputAction,
  type LaunchMode,
  type LaunchState,
} from "./launcher.ts";
import { bridgeOptions, parseOptions, restoreOptions, setOptions } from "../../gamefiles/options.ts";
import { COMMAND_TOO_LONG, commandTooLong, engine, type SettingValue } from "../engine/engine.ts";
import type { EngineResult } from "../engine/failure.ts";
import type { UiScreen } from "../engine/ui.ts";
import { restoreGameSettings, setBridgeSetting } from "../engine/settings.ts";
import { Staleness, streamEntities, streamEntity, TickClock, type StreamedEntities } from "./entitystream.ts";
import { horizontalDistance } from "./geometry.ts";
import { PlayerController } from "./player.ts";
import type { EntityInfo, Impact, Loadout, PlayerState, PlayerWorld, RespawnOutcome } from "./types.ts";
import { inputProvider, NO_INPUT_PROVIDER, withInputLock, type InputLockStatus } from "./inputprovider.ts";
import type { LockMode } from "../engine/lock.ts";
import { HELPER_MARK, isReplyTo, parseReply, queryCommand } from "./helperprotocol.ts";
import { pngSize, readShot } from "./png.ts";
import { declaredEntityProperties } from "./entityproperties.ts";
import { unavailableInput, type InputRoute, type PlayerInput } from "./input.ts";
import { createWorld, enterUserWorld, installHelperPack, type CreatedWorld, type PackRef } from "./world.ts";
import { ICON_FILE, listAllWorlds, pruneWorlds, worldsWithPacks } from "./worldstore.ts";
import { decodeJpeg } from "./jpeg.ts";
import { GameMute } from "./mute.ts";
import { windowsMute } from "./windows.ts";
import { readDevWorld, type DevWorld } from "./devworld.ts";
import type { Difficulty } from "../../gamefiles/worlds.ts";
import {
  currentScreen,
  LEAVE_TIMEOUT_MS,
  leaveWorld,
  NO_SCREENS,
  recoverJoin,
  respawn,
  RESPAWN_TIMEOUT_MS,
  screensFromUi,
  screensInLog,
  type RecoveryIO,
  type RecoveryResult,
  type ScreenState,
  type UiRecovery,
} from "./screens.ts";

/**
 * The port the bridge's debugger listener takes, apart from the debugger protocol's default (19144, which
 * `debugger/protocol.ts` exports and BDS sessions use).
 */
export const BRIDGE_DEBUGGER_PORT = 19151;
/** A provider motion sample older than this no longer overrides the helper's state (a missed tick is 50 ms). */
const MOTION_FRESH_MS = 250;
/** The helper's fields (crosshair target, held item, game tick) ride along with provider motion while this fresh. */
const HELPER_FOR_MOTION_MS = 1000;
/** A streamed health reading this fresh says whether the player is dead; an older one is not trusted for it. */
const DEATH_HEALTH_FRESH_MS = 2000;
/** How long `start` waits for the game process and then for the world (each), unless told otherwise. */
export const WORLD_WAIT_MS = 180_000;
/** The longest wait `game_launch` takes (seconds). */
export const WORLD_WAIT_MAX_S = 1800;
/** How long the bridge keeps waiting in the background when the user starts the game or enters the world by hand. */
const BACKGROUND_WAIT_MS = 30 * 60_000;
/** Start of the manual step a launch with `keepOnTimeout` leaves while the world has not loaded. */
const WORLD_NOT_LOADED = "the world has not loaded yet";
/** Start of the manual step on an install the user starts (launcher.ts writes it). */
const START_YOURSELF = "start Minecraft yourself";
/** Start of the manual steps the bridge leaves when it could not walk into the world by itself. */
const OPEN_YOURSELF = "open the world yourself";
/** The step when a tile click left the Play screen up: a dialog only the user may answer (`stuck` in screens.ts). */
const WORLD_DIALOG = "the game shows a dialog over the Play screen";
/** How long the game sits on the start or Play screen, no world opening, before the bridge walks into the world itself. */
const AUTO_ENTER_IDLE_MS = 6_000;
/** At most one walk into the world per this long, and this many in all: an input the user makes is not fought. */
const AUTO_ENTER_EVERY_MS = 20_000;
const AUTO_ENTER_ATTEMPTS = 3;
/** One walk's limit. */
const AUTO_ENTER_TIMEOUT_MS = 90_000;
/** On an install the user starts, attach the in-game agent once the start screen shows, or this long after the process came up. */
const AUTO_ATTACH_AFTER_MS = 30_000;
/** How often the bridge looks at a game it attached to while the channels are not all up. */
const ATTACH_POLL_MS = 2_000;
/** How long `start` waits for an attached game to dial the debugger after the agent sent the command. */
const ATTACH_DIAL_WAIT_MS = 15_000;
/**
 * game_launch options only a game sculkwire starts can apply, by option and parameter name: an attached game keeps
 * its world, window and settings (`mute: true` does silence it, until game_stop).
 */
const FRESH_START_OPTIONS = [
  ["userWorld", "userWorld"],
  ["mode", "display"],
  ["width", "width"],
  ["height", "height"],
  ["fps", "fps"],
  ["difficulty", "difficulty"],
  ["betaApis", "betaApis"],
] as const satisfies readonly (readonly [keyof BridgeStartOptions, string])[];
/**
 * The bridge's channel keys an attached game gets live through the agent: options.txt reaches only its next start.
 * `content_log_file` gives game_log a file to read. `websocket_encryption` is never set live: turning it off opens the
 * game's security confirmation, which is the user's to answer (`ENCRYPTED_STEP`).
 */
const LIVE_KEYS: readonly (readonly [string, SettingValue])[] = [
  ["websockets_enabled", true],
  ["content_log_file", true],
];
/** The step for a game that requires encrypted websockets: `/connect` cannot attach to the bridge's plain server. */
export const ENCRYPTED_STEP =
  "to let sculkwire use /connect, turn off Settings > General > Require Encrypted Websockets yourself (commands already work through the script debugger)";

/** Whether an option value reads as on (`true`, `1`, `"1"`, `"true"`). */
function isOn(value: SettingValue | string | undefined): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}
/** What needs the helper pack in the world. */
const HELPER_TOOLS = "game_query, wait_until, game_events, scene_* and the respawn health checks";

/** The chat commands that connect a running game to the bridge's script debugger and `/connect` server. */
export function dialCommands(debuggerPort: number, connectPort: number): { debugger: string; connect: string } {
  return { debugger: `script debugger connect localhost ${debuggerPort}`, connect: `connect localhost:${connectPort}` };
}

/** Why the helper pack's tools fail in an attached game whose world does not run it. */
export function helperMissing(world: string | undefined): string {
  const name = world ? `"${world}"` : "the open world";
  return (
    `the sculkwire helper pack does not run in ${name}, and ${HELPER_TOOLS} need it. sculkwire put it into ` +
    `development_behavior_packs; it takes effect the next time the world loads with it in its pack list (add ` +
    `"sculkwire helper" under the world's Behavior Packs, then leave and rejoin), or close the game and launch the ` +
    `world through sculkwire once (game_worlds use, then game_launch): the helper pack then stays in it`
  );
}

/** The pack ids a world's pack lists name (`world_behavior_packs.json`, `world_resource_packs.json`); read only. */
async function worldPackIds(dir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const file of ["world_behavior_packs.json", "world_resource_packs.json"]) {
    const list = await readJsonOr<unknown>(join(dir, file));
    if (!Array.isArray(list)) continue;
    for (const entry of list as unknown[]) {
      if (entry && typeof entry === "object" && "pack_id" in entry && typeof entry.pack_id === "string") ids.add(entry.pack_id);
    }
  }
  return ids;
}

/** One option of the install's options.txt (the player's file first), or undefined. */
async function optionValue(install: ClientInstall, key: string): Promise<string | undefined> {
  for (const file of optionsFiles(install)) {
    const value = await readFile(file, "utf8").then((text) => parseOptions(text).get(key), () => undefined);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** What the bridge knows of a game it attached to (`#startAttached`). */
interface AttachedGame {
  gamePid: number;
  /** The game shows a world (false: it sits in a menu). */
  inWorld: boolean;
  /** Level id and name of the world the game opened last. */
  levelId?: string;
  name?: string;
  /** The open world's cheats flag as the agent read it; null or undefined when unknown. */
  cheats?: boolean | null;
  /** Why the in-game agent could not be attached, when it could not. */
  agentError?: string;
  /** The dial commands the agent ran that failed, with the game's own message. */
  dialFailures: { line: string; message: string }[];
  /** The world, cheats flag and drop count the agent last dialled for: it dials again only when one of them changes. */
  dialledFor?: string;
  dialledAt?: number;
  /** Debugger sessions that closed (a rejoin, a world change): each one makes the agent dial again, once. */
  drops: number;
  /** The last debugger session the helper was asked on. */
  probed?: DebuggerSession;
  /** The last closed session counted in `drops`. */
  dropped?: DebuggerSession;
  helperInstalled: boolean;
  helperNote?: string;
  contentLogNote?: string;
  /**
   * The open game requires encrypted websockets (Settings > General), which the bridge's plain `/connect` server
   * cannot serve: the agent's live reading, else options.txt as the game read it at its start; undefined when unknown.
   */
  encrypted?: boolean;
}

/** The bridge's own walk into the world while it waits (`#autoEnter`). */
interface AutoEnter {
  /** When the game process was found. */
  since: number;
  attachTried: boolean;
  attempts: number;
  /** When the last walk ended. */
  lastAt: number;
  /** The menu screen the game sits on, and since when. */
  idle?: { since: number; kind: string };
}

/** A wait in `start` ran out: the game process or the world did not come up in time. */
export class WaitTimeout extends Error {}

/** The world wait handed a step to the user (`#handOver`): a foreground launch returns and keeps waiting in the background. */
class NeedsUser extends Error {}

/**
 * A helper pack query that answered `ok: false`. `reason` is the helper's own machine-readable label when it sent one
 * (`no_container` for a block that has none), so a caller can tell a bad request from a broken pack.
 */
export class HelperQueryError extends Error {
  reason: string | undefined;

  constructor(message: string, reason?: string) {
    super(message);
    this.name = "HelperQueryError";
    this.reason = reason;
  }
}

/** Where `game_registry` got its ids: the game's `/connect` data request, or the helper pack's Script API. */
export type RegistrySource = "connect" | "script";

export interface RegistryResult {
  kind: DataKind;
  source: RegistrySource;
  entries: unknown[];
  /** Why the ids came from the helper pack rather than /connect. */
  note?: string;
}

/** Where `readRegistry` reads: a `/connect` data request, and one page of the helper's `registry` query from `offset`. */
export interface RegistrySources {
  connect?: () => Promise<unknown>;
  script?: (offset: number) => Promise<unknown>;
}

/** One page of the helper's `registry` query: `ids` from `offset` of `total`, sorted. */
function registryPage(value: unknown): { total: number; ids: string[] } {
  if (value && typeof value === "object" && "total" in value && "ids" in value) {
    const { total, ids } = value;
    if (typeof total === "number" && Array.isArray(ids) && ids.every((id) => typeof id === "string")) return { total, ids };
  }
  throw new Error(`malformed helper registry page: ${JSON.stringify(value)}`);
}

/**
 * Every id of one registry. `/connect`'s `data:<kind>` first, when a client is attached. A missing, failed or empty
 * answer (the retail client answers `[]` to every data request) falls back to the helper pack's Script API
 * (`BlockTypes`, `ItemTypes`, `EntityTypes`), read page by page so no reply print grows past a page.
 */
export async function readRegistry(kind: DataKind, sources: RegistrySources): Promise<RegistryResult> {
  let note = "no /connect client attached";
  if (sources.connect) {
    try {
      const body = await sources.connect();
      if (Array.isArray(body) && body.length > 0) return { kind, source: "connect", entries: body };
      note = `/connect answered data:${kind} with ${Array.isArray(body) ? "an empty list" : "no list"}`;
    } catch (err) {
      note = `/connect data:${kind} failed: ${errorMessage(err)}`;
    }
  }
  if (!sources.script) throw new Error(`${note}, and the helper pack's registry query needs the script debugger`);
  const ids: string[] = [];
  try {
    for (;;) {
      const page = registryPage(await sources.script(ids.length));
      ids.push(...page.ids);
      if (page.ids.length === 0 || ids.length >= page.total) break;
    }
  } catch (err) {
    throw new Error(`${note}, and the helper pack's registry query failed: ${errorMessage(err)}`);
  }
  return { kind, source: "script", entries: ids, note };
}

export interface BridgeStartOptions {
  /**
   * Add-on project or pack directory whose packs are activated in the test world (and mapped in diagnostics). For a
   * Regolith project whose profile runs filters, the packs are what rgl last built (`.regolith/tmp`): sculkwire never
   * runs rgl.
   */
  project?: string;
  /**
   * Copy the project's packs into development_*_packs (default true), also over the project's `sculkwire_*` folder an
   * earlier launch left. Off: a pack is only used when a folder already serves its uuid. What rgl built is deployed
   * with either value: in place when rgl exported it into these dev packs, copied otherwise.
   */
  deploy?: boolean;
  /**
   * `window` (Linux: a visible gamescope window you can watch; Windows: the game's own window), `headless` (Linux: no
   * window, muted; Windows falls back to the window) or `desktop` (the launcher's normal window; the same as `window`
   * on Windows). Default: window on Windows; elsewhere window when gamescope and a desktop are available, else desktop.
   */
  mode?: LaunchMode;
  /**
   * Silence the game's audio (Linux: its streams go to a silent sink; Windows: its audio sessions). Default: on in
   * headless mode only. A game the user opened (attached) is muted only with `mute: true`, until game_stop.
   */
  mute?: boolean;
  /**
   * Enter this one of the user's worlds (level name or level id; see `enterUserWorld`). Without it the saved dev world
   * (devworld.ts) is entered, else the one of the user's worlds whose pack lists name the project's packs
   * (`userWorldFor`).
   */
  userWorld?: string;
  /**
   * `sculk bench` and sculkwire's own live tests only, never a user's session: create the scratch world
   * `sculkwire-<name>` for this launch (`createWorld`) instead of entering a user's world. The caller deletes it when
   * the run ends. Not with `userWorld`.
   */
  scratchWorld?: string;
  /** Turn on the Beta APIs experiment (in a user's dev world it stays on for good). */
  betaApis?: boolean;
  /** The world's difficulty (test world default normal; a user's dev world keeps its own unless this is given). */
  difficulty?: Difficulty;
  width?: number;
  height?: number;
  /** gamescope frame rate in window and headless modes (default 60). */
  fps?: number;
  connectPort?: number;
  debuggerPort?: number;
  /** How long to wait for the game process, and then for the world to load (ms each; default WORLD_WAIT_MS). */
  timeoutMs?: number;
  /**
   * When a wait runs out, keep the game running and return a not-ready status with the step to enter the world, and
   * keep waiting in the background (as when the user starts the game) instead of stopping the game.
   */
  keepOnTimeout?: boolean;
  /**
   * When the chosen install's game already runs, attach to it (default true) instead of refusing: see `#startAttached`.
   * False (the bench, which needs its own game) refuses as before.
   */
  attach?: boolean;
  /**
   * The input lock for this session. `auto` (game_launch's default): the lock holds only while sculkwire acts through
   * the agent (a tool call that sends input, the walk into the world, Save & Quit) and the user has full control
   * between those. `on`: a session lock from the moment sculkwire has the game until `stop`, released while a step is
   * the user's (`#handOver`). `off`: the agent's mode is set to off for the session, so nothing locks. `stop` puts the
   * earlier mode back. Fails open: `lockNote` says why it is not set. Omitted: nothing is set (the bench and the CLI).
   */
  inputLock?: LockMode;
  /**
   * A game the user opened: type `/connect` in its chat to attach the websocket channel (default false: commands go
   * through the script debugger, and nothing is typed in the user's chat).
   */
  connect?: boolean;
}

/** How the game reached the test world for this launch, for `entry()`. */
export interface WorldEntry {
  /**
   * `launch`: sculkwire started the game into the world; `auto-enter`: sculkwire walked the menus into it (an install
   * the user starts, or a world link that raced sign-in); `manual`: the user opened it; `already-open`: it was ready
   * the first time the bridge looked, once the game process was found.
   */
  by: "launch" | "auto-enter" | "manual" | "already-open";
  /** From `start` to the world being ready. */
  seconds: number;
  /** Inputs sculkwire sent walking the menus (`auto-enter` only). */
  clicks?: number;
}

export interface BridgeStatus {
  running: boolean;
  mode?: LaunchMode;
  version?: string;
  /** Which install: `mcbe-gdk-installer`, `Windows`, a Wine prefix path, `custom (…)`. */
  install?: string;
  world?: string;
  project?: string;
  packs: DeployedPack[];
  debugger: { attached: boolean; port?: number; protocolVersion?: number; plugins?: string[] };
  /** `automatic`: the game dialled in by itself (automation_server_* options); `chat`: typed /connect. */
  connect: { clients: number; port?: number; method?: "automatic" | "chat" };
  ready: boolean;
  /** What the agent or user must still do by hand. */
  manualSteps: string[];
  /** The game process this launch found (`gamePid`) is gone, e.g. it crashed: game_stop cleans up, then game_launch. */
  gameExited?: boolean;
  /** Problems the last deploy found, e.g. a pack not derived from the project that shares a deployed pack's uuid. */
  deployDiagnostics?: Diagnostic[];
  /** World joins that raced Microsoft sign-in and were recovered without the user (present once one happened). */
  joinRecovery?: { attempts: number; recovered: boolean; via?: string; log?: string; screenshot?: string };
  /** Launch result only: test worlds this launch removed because nobody played them for `STALE_WORLD_DAYS`. */
  prunedWorlds?: string[];
  /**
   * Launch result only: what the launch did or did not do to the world's settings (a kept or copied world keeps its
   * own; in a user's dev world: cheats turned on, experiments, the backup, the packs left in it).
   */
  worldNote?: string;
  /**
   * How this launch got its world: `user` (one of the user's own worlds, entered), `attached` (the world of a game the
   * user had already started, taken as it is). A scratch world (`scratchWorld`) has none.
   */
  worldMode?: "user" | "attached";
  /** game_launch found the game already running and attached to it instead of starting one; game_stop only detaches. */
  attached?: boolean;
  /** Attached game: whether it shows a world (false: it sits in a menu, and the channels connect once a world is open). */
  inWorld?: boolean;
  /** Attached game: the level id (folder under minecraftWorlds) of the world it opened. */
  levelId?: string;
  /** Attached game: what the helper pack's tools or game_log lack in this world, and how it gets there. */
  helperNote?: string;
  /** `user` mode: the backup of the world's level.dat and pack lists this launch made before writing them. */
  worldBackup?: string;
  /** The user's saved default dev world for this game user (game_status reads it; absent when none is saved). */
  defaultWorld?: DevWorld;
  /** game_status only: the player is dead (the death screen is up, or the helper streamed health 0). */
  dead?: boolean;
  /** sculkwire keeps the game silent (`mute`), and nothing it knows of lets the sound through. */
  muted?: boolean;
  /** Why the game's sound may reach the speakers although `mute` applies (pactl missing, a stream that would not move). */
  muteNote?: string;
  /** The input lock as the input provider last reported it, once one was read. */
  inputLock?: InputLockStatus;
  /** Why the input lock game_launch asked for (`inputLock`) is not set: the user's keyboard and mouse still reach the game. */
  lockNote?: string;
}

/** How long `reload` waits at each step (ms); tests shorten them. */
export interface ReloadTiming {
  /** For the helper's ready print after the reload command. */
  readyMs: number;
  /** For the game to dial the debugger again after each recovery step. */
  redialMs: number;
  /** For the helper to answer on a newly dialled session. */
  helperMs: number;
}

export interface CommandOutput {
  command: string;
  via: "connect" | "debugger";
  ok: boolean;
  /** /connect: statusMessage; debugger: the prints the command produced. */
  output: string[];
  statusCode?: number;
  body?: Record<string, unknown>;
}

export interface LogResult {
  diagnostics: Diagnostic[];
  /** Raw content-log text read (capped). */
  text: string;
  cursor: { log?: LogPosition; printSeq: number };
}

export interface StopResult {
  stopped: boolean;
  message: string;
  restoredOptions: Record<string, string[]>;
  restoredSettings: Record<string, SettingValue | null>;
  /** A user's dev world was open: whether Save & Quit got the game out of it before the stop. */
  savedAndQuit?: boolean;
  /** User's dev world: the project's development pack folders left in place because the world's pack lists name them. */
  keptPackFolders?: string[];
  /** What the stop did or could not do for a user's world (Save & Quit, the kept folders). */
  stopNote?: string;
  /** The game was one the user had started and sculkwire attached to: it was left running. */
  detached?: boolean;
}

/** `count` clicks one after another, 120 ms apart on `wait`: `count: 2` is a double click. */
async function clicks(count: number, click: () => Promise<void>, wait: (ms: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < count; i++) {
    await click();
    if (i + 1 < count) await wait(120);
  }
}

/** `wait`, rejecting with "the game stopped" instead of the abort error once `stop` aborted `signal`. */
async function untilStopped<T>(wait: Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await wait;
  } catch (e) {
    throw signal.aborted ? new Error("the game stopped") : e;
  }
}

/** The user's world a launch enters, how to name it in messages, and how it was chosen. */
export interface UserWorldChoice {
  /** Level name or level id for `enterUserWorld`. */
  world: string;
  label: string;
  /** `userWorld` named it, it is the saved dev world, or it is the user's world that uses the project's packs. */
  by: "userWorld" | "saved" | "packs";
  /** How it was chosen, for `worldNote`, when more than its label says. */
  note?: string;
}

/** Worlds a "no world" error lists by name. */
const WORLDS_LISTED = 10;

/**
 * The user's world a launch enters, in this order: `userWorld`; the saved dev world; the one of the user's own worlds
 * (never a `sculkwire-` one) whose pack lists name one of `packs` (several: the one played last, and `note` says so).
 * Throws when none is found, listing the user's worlds and the next step: ask the user which one, then save it with
 * game_worlds `use` or pass `userWorld`. sculkwire never creates a world for a user.
 */
export async function userWorldFor(install: ClientInstall, opts: BridgeStartOptions, packs: readonly PackRef[]): Promise<UserWorldChoice> {
  if (opts.userWorld !== undefined) return { world: opts.userWorld, label: `your world "${opts.userWorld}"`, by: "userWorld" };
  const saved = await readDevWorld(install);
  if (saved) return { world: saved.levelId, label: `your saved dev world ${saved.name} [${saved.levelId}]`, by: "saved" };
  const using = await worldsWithPacks(install, packs.map((p) => p.uuid));
  const [newest] = using;
  if (newest) {
    const label = `your world ${newest.name} [${newest.levelId}]`;
    return using.length === 1
      ? { world: newest.levelId, label, by: "packs", note: `${newest.name} is the one of your worlds whose pack lists name the project's packs` }
      : {
          world: newest.levelId,
          label,
          by: "packs",
          note:
            `${using.length} of your worlds use the project's packs (${using.map((w) => `${w.name} [${w.levelId}]`).join(", ")}); ${newest.name} was played last. ` +
            "To use another, pass userWorld or save it with game_worlds action use",
        };
  }
  const mine = (await listAllWorlds(install, false)).filter((w) => !w.sculkwire);
  const listed = mine.slice(0, WORLDS_LISTED).map((w) => `"${w.name}" [${w.levelId}] last played ${w.lastPlayed.toISOString().slice(0, 10)}`);
  const more = mine.length > WORLDS_LISTED ? `, and ${mine.length - WORLDS_LISTED} more (game_worlds lists them all)` : "";
  throw new Error(
    `no world to launch into: no userWorld was given, no default dev world is saved for ${install.label}, and ` +
      `${packs.length ? "none of your worlds lists the project's packs" : "no project was given to find a world by its packs"}. ` +
      (mine.length ? `Your worlds, played last first: ${listed.join("; ")}${more}. ` : `${install.label} has no worlds of yours yet: create one in the game first. `) +
      'Ask the user which world sculkwire may use, then save it with game_worlds {action: "use", world: "<name or level id>"} ' +
      "(or pass userWorld for this launch only). sculkwire never creates a world for you",
  );
}

/** Whether this process's launch state file still exists: `stop`, from here or another process, removes it. */
async function launchStateExists(): Promise<boolean> {
  return (await readLaunchState()) !== undefined;
}

/**
 * The in-game agent's UI calls (`engine.ui*`) as the recovery's `UiRecovery`, or undefined while no agent is attached
 * (then the recovery reads the log and uses the keys). A double click waits on `sleep`, the recovery's own.
 */
function agentUi(sleep: (ms: number) => Promise<void>): UiRecovery | undefined {
  if (!engine.attached) return undefined;
  const value = <T>(result: EngineResult<T>): T => {
    if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
    return result.value;
  };
  return {
    screen: async () => value(await engine.uiScreen()),
    controls: async () => value(await engine.uiControls()),
    press: async (name) => void value(await engine.uiPress(name)),
    key: async (key) => void value(await engine.uiKey(key)),
    click: (x, y, count = 1) => clicks(count, async () => void value(await engine.uiClick(x, y)), sleep),
    scroll: async (x, y, delta) => void value(await engine.uiScroll(x, y, delta)),
  };
}

/**
 * The `/connect` part of game_status. The step that asks the user to type `/connect` shows only while no client is
 * attached, so it goes once they typed it and comes back if the game drops the socket (a rejoin). A client that
 * attached after the step was handed out was typed into the chat, so its method is `chat`.
 */
export function connectView(
  step: string | undefined,
  method: "automatic" | "chat" | undefined,
  clients: number,
): { status: BridgeStatus["connect"]; steps: string[] } {
  const how = method ?? (clients > 0 && step ? "chat" : undefined);
  return { status: { clients, ...(how ? { method: how } : {}) }, steps: step && clients === 0 ? [step] : [] };
}

export class ClientBridge {
  install?: ClientInstall;
  launchState?: LaunchState;
  world?: CreatedWorld;
  project?: string;
  #packs: DeployedPack[] = [];
  #indexed: IndexedPack[] = [];
  #listener?: DebuggerListener;
  #session?: DebuggerSession;
  #connect?: ConnectServer;
  #prints: PrintEvent[] = [];
  #printSeq = 0;
  /** Last helper query id. Ids grow by one per query, so concurrent queries in the same millisecond never share one. */
  #queryId = Date.now() % 1_000_000_000;
  /** Last print seq `logs()` returned without an explicit cursor. */
  #printCursor = 0;
  #connectMethod?: "automatic" | "chat";
  #latestState?: { at: number; state: PlayerState };
  /** The nearby entities printed with the newest streamed state. */
  #latestEntities?: StreamedEntities;
  /** Arrival times of the streamed game ticks, to date helper replies. */
  readonly #ticks = new TickClock();
  /** How old the entity readings handed to the controller were. */
  readonly staleness = new Staleness();
  /** Woken by every print other than a streamed state. */
  #printSignal?: PromiseWithResolvers<void>;
  /** Ticks between streamed player states, or undefined while the helper is not streaming. */
  #streamEvery?: number;
  #controller?: PlayerController;
  #ready = false;
  /**
   * The helper pack answers on the attached debugger session: set by its ready print (or a pong), cleared when the
   * session closes and while a `/reload` restarts its scripts. `ready` in game_status needs it.
   */
  #helperUp = false;
  /** What to do by hand while the helper is gone after a reload the bridge could not recover from. */
  #helperStep?: string;
  #logCursor?: LogPosition;
  #manual: string[] = [];
  /**
   * The `/connect` step for the user, shown only while no `/connect` client is attached: it disappears once one dials in
   * (typed by the user, or the game reconnecting) and comes back when the last one drops (a rejoin closes the socket).
   */
  #connectStep?: string;
  /** Pack copies this bridge put into development_*_packs; removed on stop. */
  #deployed: string[] = [];
  /** Warnings from the last deploy (foreign packs sharing a deployed uuid). */
  #deployDiagnostics: Diagnostic[] = [];
  /** `deploy` from game_launch, reused when game_reload redeploys the project. */
  #deployOption = true;
  /** Engine-log (`Debug_Log`) position: a join rejection is new when it appears after this. */
  #joinCursor?: LogPosition;
  /** What the engine log said about the world join so far (incremental reads). */
  #joinState: JoinState = NO_JOIN_YET;
  #joinRecovery?: BridgeStatus["joinRecovery"];
  /** When this launch's `start` began, the menu walks of its wait for the world, and how the world was reached. */
  #startedAt = 0;
  #walks = { walked: false, clicks: 0 };
  #entry?: WorldEntry;
  /** The screen stack as the engine log tells it, read along with the join state. */
  #screens: ScreenState = NO_SCREENS;
  /** The game frame's size from the newest screenshot: clicks are fractions of it. */
  #frame?: { width: number; height: number };
  /** The game's own failure messages for the debugger route's `ok`, read once per install. */
  #failures?: { install: ClientInstall | undefined; matcher: Promise<FailureMatcher> };
  /** What the newest `start` did to the worlds, for its result. */
  #prunedWorlds: string[] = [];
  #worldNote?: string;
  /** Owned by the newest `start`, aborted by `stop`: ends that start's waits for the game and the world, background ones included. */
  #startAbort?: AbortController;
  /** Set while this bridge is attached to a game the user started (`#startAttached`); `stop` then only detaches. */
  #attached?: AttachedGame;
  /** Linux: keeps the game's streams on the silent sink while the game is muted; stopped by `stop` (see there). */
  #muteWatcher?: GameMute;
  /** Windows: why muting the game's audio sessions failed. */
  #muteNote?: string;
  /** game_launch `inputLock` of the newest `start`, applied once sculkwire has the game (`#lockInput`). */
  #inputLock?: LockMode;
  /** Why `#inputLock` could not be applied. */
  #lockNote?: string;
  /** `#lockInput` ran for the newest `start` (set or failed): it runs once, at the first point sculkwire has the agent. */
  #lockTried = false;
  /** The session lock `#lockInput` set is held now (released by `#handOver` and `stop`). */
  #lockHeld = false;
  /** The step in the game handed to the user (`#handOver`): no walk or click until sculkwire has the game back. */
  #userStep?: string;
  /** game_launch `connect`: an attached game gets `/connect` typed in its chat (`#dialThroughAgent`). */
  #connectWanted = false;

  /** A game was launched and has not exited. Before its process is found (a user still starting it) it counts as running. */
  get running(): boolean {
    return this.launchState !== undefined && !this.#gameExited();
  }

  /** The game process found for this launch is gone (crash, closed by hand): checked on every read, never cached. */
  #gameExited(): boolean {
    const pid = this.launchState?.gamePid;
    return pid !== undefined && !isAlive(pid);
  }

  status(): BridgeStatus {
    const exited = this.#gameExited();
    const connect = connectView(this.#connectStep, this.#connectMethod, this.#connect?.clients().length ?? 0);
    const sessionOpen = !!this.#session && !this.#session.closed;
    const game = this.#attached;
    const s: BridgeStatus = {
      running: this.running,
      packs: this.#packs.map((p) => ({ ...p })),
      debugger: { attached: sessionOpen },
      connect: connect.status,
      // An attached game is ready once the debugger is: its world may not run the helper pack (helperNote says so).
      ready: this.#ready && (game !== undefined || this.#helperUp) && sessionOpen && !exited,
      manualSteps: exited
        ? [`the game process (pid ${this.launchState?.gamePid}) exited: call game_stop to clean up, then game_launch`]
        : [...this.#manual, ...(this.#helperStep ? [this.#helperStep] : []), ...connect.steps],
      ...(this.#deployDiagnostics.length ? { deployDiagnostics: [...this.#deployDiagnostics] } : {}),
    };
    if (exited) s.gameExited = true;
    if (this.launchState) s.mode = this.launchState.mode;
    if (this.install?.version) s.version = this.install.version;
    if (this.install) s.install = this.install.label;
    if (this.world) {
      s.world = this.world.name;
      if (this.world.how === "user") s.worldMode = "user";
      if (this.world.backup) s.worldBackup = this.world.backup;
    }
    if (game) {
      s.attached = true;
      s.worldMode = "attached";
      s.inWorld = game.inWorld;
      if (game.name) s.world = game.name;
      if (game.levelId) s.levelId = game.levelId;
      const notes = [game.helperNote, game.contentLogNote].filter((n) => n !== undefined);
      if (notes.length) s.helperNote = notes.join("; ");
    }
    if (this.project) s.project = this.project;
    if (this.#listener) s.debugger.port = this.#listener.port;
    if (this.#session?.info) {
      s.debugger.protocolVersion = this.#session.info.version;
      s.debugger.plugins = this.#session.info.plugins.map((p) => p.name);
    }
    const port = this.#connect?.port;
    if (port) s.connect.port = port;
    if (this.#joinRecovery) s.joinRecovery = this.#joinRecovery;
    if (this.launchState) {
      const note = this.#muteWatcher ? this.#muteWatcher.note : this.#muteNote;
      s.muted = (this.#muteWatcher !== undefined || this.launchState.muteRequested === true) && note === undefined;
      if (note) s.muteNote = note;
    }
    const lock = this.launchState ? inputProvider()?.lockStatus?.() : undefined;
    if (lock) s.inputLock = lock;
    if (this.#lockNote) s.lockNote = this.#lockNote;
    return s;
  }

  async start(opts: BridgeStartOptions = {}): Promise<BridgeStatus> {
    this.#inputLock = opts.inputLock;
    this.#lockNote = undefined;
    this.#lockTried = false;
    this.#lockHeld = false;
    this.#userStep = undefined;
    this.#connectWanted = opts.connect === true;
    const status = await this.#start(opts);
    return { ...status, prunedWorlds: this.#prunedWorlds, ...(this.#worldNote ? { worldNote: this.#worldNote } : {}) };
  }

  async #start(opts: BridgeStartOptions): Promise<BridgeStatus> {
    if (this.launchState) {
      if (this.running) throw new Error("the client bridge is already running; game_stop first");
      // The game exited (crash) without game_stop: clean that launch up (listeners, options, deployed packs) first.
      await this.stop();
    }
    // Listeners a start that failed half-way left open: a new listener would otherwise replace them unclosed, and the
    // ports would stay taken for the life of the process (game_stop could no longer reach them).
    this.closeDebugger();
    await this.#connect?.stop();
    this.#connect = undefined;
    const abort = new AbortController();
    this.#startAbort = abort;
    const { signal } = abort;
    // A background wait that ends because `stop` aborted it leaves no step behind.
    const waitFailed = (e: unknown) => {
      if (!signal.aborted) this.#manual.push(`client did not reach the world: ${errorMessage(e)}`);
    };
    // A new game starts with no provider state: drop what the provider remembered of an earlier one.
    await inputProvider()?.stopped();
    const install = await findInstall();
    this.install = install;
    const [runningPid] = await gamePids(install);
    if (runningPid !== undefined && opts.attach === false) {
      throw new Error(`Minecraft from ${install.label} is already running and this needs a game of its own: close it first, then try again`);
    }
    if (opts.scratchWorld !== undefined && opts.userWorld !== undefined) throw new Error("scratchWorld and userWorld exclude each other");
    this.world = undefined;
    this.#attached = undefined;
    this.#worldNote = undefined;
    const mode = opts.mode ?? (await defaultMode(install));
    const timeoutMs = opts.timeoutMs ?? WORLD_WAIT_MS;
    this.#manual = [];
    this.#packs = [];
    this.#deployDiagnostics = [];
    this.#ready = false;
    this.#helperUp = false;
    this.#helperStep = undefined;
    this.#connectMethod = undefined;
    this.#connectStep = undefined;
    this.#screens = NO_SCREENS;
    this.#frame = undefined;
    this.#joinRecovery = undefined;
    this.#startedAt = Date.now();
    this.#walks = { walked: false, clicks: 0 };
    this.#entry = undefined;
    this.#joinState = NO_JOIN_YET;

    let packRefs: PackRef[] = [];
    if (opts.project) {
      const project = resolve(opts.project);
      this.project = project;
      this.#deployOption = opts.deploy !== false;
      const deployment = await deployProject(install, project, this.#deployOption, false);
      this.#packs = deployment.packs;
      this.#deployed.push(...deployment.owned);
      this.#deployDiagnostics = deployment.diagnostics;
      packRefs = deployment.refs;
      this.#indexed = await indexProjectPacks(project, install.sharedComMojang);
    }
    if (runningPid !== undefined) return this.#startAttached(install, runningPid, opts, signal, waitFailed);

    try {
      const debuggerPort = await this.listenDebugger(opts.debuggerPort ?? BRIDGE_DEBUGGER_PORT);
      this.#connect = new ConnectServer({ port: opts.connectPort ?? DEFAULT_CONNECT_PORT });
      await this.#connect.start();
      // Inside gamescope the game runs fullscreen in gamescope's own output, which never reaches the user's screen.
      const inGamescope = process.platform === "linux" && mode !== "desktop" && (await gamescopeBlocker(install)) === undefined;
      await setOptions(optionsFiles(install), bridgeOptions(debuggerPort, { fullscreen: inGamescope }));
      if (opts.scratchWorld === undefined) {
        // A game that already runs was attached above as it is, so a world is chosen only for a game sculkwire starts.
        const choice = await userWorldFor(install, opts, packRefs);
        const entered = await enterUserWorld(install, {
          world: choice.world,
          packs: packRefs,
          ...(opts.betaApis ? { betaApis: true } : {}),
          ...(opts.difficulty ? { difficulty: opts.difficulty } : {}),
        }).catch((e: unknown) => {
          throw choice.by === "saved" ? new Error(`${choice.label}: ${errorMessage(e)}. Ask the user which world to use instead, then game_worlds action use`) : e;
        });
        this.world = entered.world;
        this.#worldNote = [
          `entered ${choice.label}; its level.dat and pack lists were backed up to ${entered.world.backup}`,
          ...(choice.note ? [choice.note] : []),
          ...entered.notes,
          ...(opts.difficulty ? [] : ["its own difficulty stays (pass difficulty to change it)"]),
          "the helper pack and the project's packs stay in its pack lists after game_stop, and their development pack folders are kept",
        ].join("; ");
      } else {
        this.world = await createWorld(install, {
          name: opts.scratchWorld,
          packs: packRefs,
          ...(opts.betaApis ? { experiments: ["gametest"] } : {}),
          ...(opts.difficulty ? { difficulty: opts.difficulty } : {}),
          ...(install.version ? { gameVersion: install.version } : {}),
        });
      }
    } catch (e) {
      await this.stop();
      throw e;
    }
    try {
      const devWorld = await readDevWorld(install);
      this.#prunedWorlds = await pruneWorlds(install, { except: [this.world.levelId, ...(devWorld ? [devWorld.levelId] : [])] });
      this.#logCursor = await contentEnd(install.logsDir);
      this.#printCursor = this.#printSeq;
      this.#joinCursor = await debugLogEnd(install.logsDir);
    } catch (e) {
      await this.stop();
      throw e;
    }
    this.#joinState = NO_JOIN_YET;
    try {
      this.launchState = await launch(install, {
        mode,
        ...(opts.mute !== undefined ? { mute: opts.mute } : {}),
        levelId: this.world.levelId,
        ...(opts.width ? { width: opts.width } : {}),
        ...(opts.height ? { height: opts.height } : {}),
        ...(opts.fps ? { fps: opts.fps } : {}),
      });
    } catch (e) {
      await this.stop();
      throw new Error(`could not start the client: ${errorMessage(e)}`);
    }
    if (this.launchState.muteRequested && process.platform === "linux") await this.#startMuteWatcher(install);
    // With an input provider, the user only starts the game: the bridge attaches it and walks into the world itself.
    const walks = !install.launch && inputProvider() !== undefined;
    this.#manual.push(
      ...this.launchState.notes.map((note) =>
        walks && note.startsWith(START_YOURSELF)
          ? `${START_YOURSELF} (set SCULKWIRE_CLIENT_LAUNCH to let sculkwire start it); once the start screen is up sculkwire ` +
            `attaches its in-game agent and opens "${this.world?.name}" itself, nothing else to do`
          : note,
      ),
    );
    await inputProvider()?.launched({ mode: this.launchState.mode, pid: this.launchState.pid });
    const since = this.#printSeq;
    if (!install.launch) {
      // The user starts the game: return now so the agent can relay the steps; game_status shows when it is ready.
      this.#finishStart(BACKGROUND_WAIT_MS, since, signal).catch(waitFailed);
      return this.status();
    }
    try {
      await this.#finishStart(timeoutMs, since, signal, true);
    } catch (e) {
      if (e instanceof NeedsUser && this.running) {
        // The user has a step in the game (manualSteps): keep the game and wait for the world in the background.
        this.#finishStart(BACKGROUND_WAIT_MS, since, signal).catch(waitFailed);
        return this.status();
      }
      if (opts.keepOnTimeout && e instanceof WaitTimeout && this.running) {
        // Enter the world by hand (a launch command that cannot open it, a slow sign-in): keep the game and keep waiting.
        this.#manual.push(
          `${WORLD_NOT_LOADED} (${errorMessage(e)}): the game keeps running. In the game choose Play, then "${this.world.name}" on the Worlds tab ` +
            `(start Minecraft first if it is not up). game_status turns ready once the world is in; sculkwire keeps waiting up to ${BACKGROUND_WAIT_MS / 60_000} min`,
        );
        this.#finishStart(BACKGROUND_WAIT_MS, since, signal).catch(waitFailed);
        return this.status();
      }
      // `stop` aborted the wait: it is already cleaning up.
      if (!signal.aborted) await this.stop();
      throw new Error(`client did not reach the world: ${errorMessage(e)}`);
    }
    return this.status();
  }

  /**
   * Attach to the game the user already started (`gamePid`) instead of starting one. Nothing about it is restarted or
   * written: no world is created or entered, no pack list or level.dat is touched, and options that need a fresh start
   * are named in `worldNote`. The listeners open as usual and options.txt gets the bridge keys for the next start. With
   * an input provider the in-game agent is attached, turns the channel keys on live (recorded, restored on `stop`) and,
   * once a world is open, runs `/script debugger connect` and `/connect`; without one `manualSteps` names the two
   * commands to type. Returns at once; `#attachLoop` keeps looking until `stop`.
   */
  async #startAttached(
    install: ClientInstall,
    gamePid: number,
    opts: BridgeStartOptions,
    signal: AbortSignal,
    waitFailed: (e: unknown) => void,
  ): Promise<BridgeStatus> {
    // Set first: a `stop` from here on, the one after a failed start included, only detaches.
    const game: AttachedGame = { gamePid, inWorld: false, dialFailures: [], drops: 0, helperInstalled: false };
    this.#attached = game;
    this.#prunedWorlds = [];
    const ignored = FRESH_START_OPTIONS.filter(([key]) => opts[key] !== undefined && opts[key] !== false).map(([, name]) => name);
    let contentLogOn: boolean;
    try {
      const debuggerPort = await this.listenDebugger(opts.debuggerPort ?? BRIDGE_DEBUGGER_PORT);
      this.#connect = new ConnectServer({ port: opts.connectPort ?? DEFAULT_CONNECT_PORT });
      await this.#connect.start();
      contentLogOn = (await optionValue(install, "content_log_file")) === "1";
      // What the open game read when it started; the agent's live value replaces it below. Unknown when absent.
      const encryption = await optionValue(install, "websocket_encryption");
      if (encryption !== undefined) game.encrypted = isOn(encryption);
      // For the game's next start: the open game read its options.txt when it started, so the agent sets them live below.
      await setOptions(optionsFiles(install), bridgeOptions(debuggerPort));
      this.#logCursor = await contentEnd(install.logsDir);
      this.#printCursor = this.#printSeq;
      this.launchState = await attachState(gamePid);
      if (opts.mute === true) {
        this.launchState.muteRequested = true;
        await writeLaunchState(this.launchState);
        if (process.platform === "linux") await this.#startMuteWatcher(install);
        else if (process.platform === "win32") {
          const state = this.launchState;
          void muteWindowsGame(state, gamePid).then((note) => {
            if (note && this.launchState === state) this.#muteNote = note;
          });
        } else this.#muteNote = "muting needs Linux or Windows; the game's sound plays normally";
      }
    } catch (e) {
      await this.stop();
      throw e;
    }
    // The whole engine log of this run: it names the world the game opened before sculkwire came.
    this.#joinCursor = undefined;
    const notes: string[] = [];
    const provider = inputProvider();
    if (provider) {
      await provider.launched({ mode: this.launchState.mode, pid: this.launchState.pid });
      try {
        await provider.attach();
      } catch (e) {
        game.agentError = errorMessage(e);
      }
    }
    // As soon as the agent is attached, before anything is driven through it: the lock also tells a game in the
    // background that its window is active, so it takes the agent's clicks on its menus.
    await this.#lockInput(signal, game.agentError);
    if (engine.attached) {
      const set: string[] = [];
      for (const [id, value] of LIVE_KEYS) {
        const r = await this.#setLive(id, value, install);
        if (r.ok) {
          set.push(r.text);
          if (id === "content_log_file") contentLogOn = true;
          continue;
        }
        if (id === "content_log_file") {
          game.contentLogNote =
            `content_log_file could not be turned on in the running game (${r.message}), so game_log has no content-log ` +
            "file to read until the game starts again (options.txt has it on for that start)";
        } else notes.push(`could not set ${id} live (${r.message}): /connect may need the game restarted`);
      }
      if (set.length) notes.push(`set live through the in-game agent (put back by game_stop): ${set.join(", ")}`);
      await this.#readEncryption();
    }
    if (!contentLogOn && !game.contentLogNote) {
      game.contentLogNote =
        "content_log_file is off in the running game, so game_log has no content-log file to read until the game starts " +
        "again (options.txt has it on for that start)";
    }
    await this.#lookAtGame();
    if (engine.attached && game.inWorld) {
      await this.#dialThroughAgent();
      await this.#newSession(undefined, ATTACH_DIAL_WAIT_MS);
    }
    await this.#sessionUp();
    this.#attachSteps();
    await this.#lockForSteps();
    notes.unshift(`attached to the game you opened${game.name ? `, in "${game.name}"` : ""}; it keeps running and was not restarted`);
    if (ignored.length) notes.push(`${ignored.join(", ")} need${ignored.length === 1 ? "s" : ""} the game closed first: not applied`);
    if (this.#packs.length) notes.push(await this.#attachedPacksNote());
    this.#worldNote = notes.join("; ");
    this.#attachLoop(signal).catch(waitFailed);
    return this.status();
  }

  /**
   * Set one channel key live through the agent, and make sure the change opened no dialog: when the game answers a
   * set with a confirmation (a modal sculkwire caused), sculkwire never confirms it for the user. It presses the
   * dialog's Cancel control (Escape when it lists none), and the setting counts as not taken.
   */
  async #setLive(id: string, value: SettingValue, install: ClientInstall): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    const before = await engine.uiScreen().catch(() => undefined);
    const r = await setBridgeSetting(id, value, { install }).catch((e: unknown) => ({ ok: false as const, message: errorMessage(e) }));
    if (!r.ok) return r;
    const dialog = await this.#dialogSince(before?.ok ? before.value : undefined);
    if (!dialog) return { ok: true, text: `${id} ${String(r.value.previous)} -> ${String(r.value.value)}` };
    const controls = await engine.uiControls().catch(() => undefined);
    const cancel = controls?.ok ? controls.value.find((c) => c.enabled && /^cancel$/i.test((c.text ?? c.name).trim())) : undefined;
    const closed = cancel ? await engine.uiPress(cancel.name).catch(() => undefined) : undefined;
    if (!closed?.ok) await engine.uiKey("Escape").catch(() => undefined);
    return { ok: false, message: `the game asked to confirm the change (${dialog}); sculkwire cancelled it, since a confirmation is yours to answer` };
  }

  /**
   * A dialog that opened over `before` within about a second (the stack grew, or a modal appeared where none was):
   * its screen name, else undefined.
   */
  async #dialogSince(before: UiScreen | undefined): Promise<string | undefined> {
    for (let waited = 0; waited <= 1_000; waited += 250) {
      const now = await engine.uiScreen().catch(() => undefined);
      if (now?.ok && before && (now.value.stack.length > before.stack.length || (now.value.modal && !before.modal))) return now.value.name;
      await sleep(250);
    }
    return undefined;
  }

  /** Whether the open game requires encrypted websockets, as the agent reads it now (`game.encrypted`). */
  async #readEncryption(): Promise<void> {
    const game = this.#attached;
    if (!game || !engine.attached) return;
    const r = await engine.settingsGet("websocket_encryption").catch(() => undefined);
    if (r?.ok) game.encrypted = isOn(r.value.value);
  }

  /** What the project's packs do in an attached game: only packs its world already lists load, and only on a reload. */
  async #attachedPacksNote(): Promise<string> {
    const game = this.#attached;
    const install = this.install;
    if (!game?.levelId || !install) {
      return "the project's packs are in the development pack folders; a world uses them once its pack lists name them and it loads again";
    }
    const listed = await worldPackIds(join(install.userComMojang, "minecraftWorlds", game.levelId));
    const missing = this.#packs.filter((p) => !listed.has(p.uuid));
    if (missing.length === 0) return "the open world already uses the project's packs: game_reload reloads them";
    const names = missing.map((p) => p.name ?? p.uuid).join(", ");
    return (
      `${names} ${missing.length === 1 ? "is" : "are"} not in the open world's pack lists, and sculkwire never writes the pack ` +
      "lists of a world the game has open: add them in the world's settings, then leave and rejoin. game_reload reloads " +
      "the packs the world already uses"
    );
  }

  /**
   * What an attached game shows: its engine log (the world it opened, whether it is in it), the agent's `ui.screen`
   * when attached, and the open world's name and cheats flag (the agent's `world.settings`, else its levelname.txt).
   */
  async #lookAtGame(): Promise<void> {
    const game = this.#attached;
    const install = this.install;
    if (!game || !install) return;
    await this.#readJoinLog();
    if (engine.attached) {
      const screen = await engine.uiScreen().catch(() => undefined);
      if (screen?.ok) this.#screens = screensFromUi(screen.value, this.#screens);
    }
    const levelId = this.#screens.opened;
    if (levelId !== game.levelId) {
      game.levelId = levelId;
      game.name = undefined;
      game.cheats = undefined;
      if (this.launchState) {
        // Other processes (game_worlds delete) read which world the game has open from the launch state.
        if (levelId) this.launchState.world = levelId;
        else delete this.launchState.world;
        await writeLaunchState(this.launchState).catch(() => undefined);
      }
    }
    game.inWorld = this.#screens.inWorld;
    if (game.inWorld && engine.attached && (game.name === undefined || game.cheats !== true)) {
      const world = await engine.worldGet().catch(() => undefined);
      if (world?.ok) {
        if (world.value.name) game.name = world.value.name;
        game.cheats = world.value.cheats;
      }
    }
    if (game.name === undefined && levelId) {
      game.name = await readFile(join(install.userComMojang, "minecraftWorlds", levelId, "levelname.txt"), "utf8").then(
        (text) => text.trim() || undefined,
        () => undefined,
      );
    }
    // The user may turn Require Encrypted Websockets off meanwhile: then /connect is dialled.
    if (game.encrypted) await this.#readEncryption();
  }

  /** The world, cheats flag, websocket encryption and session drops an attached game's channels were dialled for. */
  #dialKey(game: AttachedGame): string {
    return `${game.levelId ?? ""}:${String(game.cheats)}:${String(game.encrypted)}:${game.drops}`;
  }

  /**
   * Have an attached game dial the channels that are not up: `/script debugger connect localhost <port>` through the
   * agent's command dispatcher (a server command, as if the player ran it), and `/connect localhost:<port>` typed in
   * chat through the agent's UI, because `/connect` is a client command the client runs itself, never the server's
   * dispatcher. Both need cheats on in the world; a failure is kept with the game's own words for `#attachSteps`.
   */
  async #dialThroughAgent(): Promise<void> {
    const game = this.#attached;
    const port = this.#listener?.port;
    const connect = this.#connect;
    if (!game || port === undefined || !connect) return;
    const lines = dialCommands(port, connect.port);
    game.dialFailures = [];
    const failed = (line: string, e: unknown) => game.dialFailures.push({ line, message: errorMessage(e) });
    if (!(this.#session && !this.#session.closed)) {
      // Quiet: the command's own feedback stays out of the user's chat.
      const r = await engine.command(lines.debugger, { quiet: true }).catch((e: unknown) => ({ ok: false as const, message: errorMessage(e) }));
      const failure = !r.ok ? r.message : r.value.success === false ? r.value.message : undefined;
      if (failure !== undefined) failed(lines.debugger, failure);
    }
    // `/connect` is typed in the user's chat only when asked for (`connect`); a game that requires encrypted websockets
    // cannot attach to this server: the user turns it off (ENCRYPTED_STEP).
    if (this.#connectWanted && connect.clients().length === 0 && !game.encrypted) {
      const r = await engine.chat(lines.connect).catch((e: unknown) => ({ ok: false as const, message: errorMessage(e) }));
      if (!r.ok) failed(lines.connect, r.message);
      // Typed once per dial: wait for the game to dial in rather than type it again on the next look.
      else await connect.waitForClient(ATTACH_DIAL_WAIT_MS).catch((e: unknown) => failed(lines.connect, e));
    }
    game.dialledFor = this.#dialKey(game);
    game.dialledAt = Date.now();
  }

  /**
   * The manual steps of an attached game: open a world when it sits in a menu, and type each channel's command where
   * the agent cannot (no agent, a failed command, or the game did not dial in after it). Cheats off is named.
   */
  #attachSteps(): void {
    const game = this.#attached;
    const port = this.#listener?.port;
    const connect = this.#connect;
    if (!game || port === undefined || !connect) return;
    const lines = dialCommands(port, connect.port);
    const agent = engine.attached;
    const steps: string[] = [];
    if (game.agentError) {
      steps.push(`sculkwire could not attach its in-game agent (${game.agentError}), so the commands below have to be typed in the game chat`);
    }
    if (!game.inWorld) {
      steps.push(`open a world in the game: it sits in its menus${agent ? ", and sculkwire connects to the world itself once it is open" : ""}`);
    }
    const cheats = game.cheats === false ? "turn cheats on in this world (pause menu, Settings, Game, Activate Cheats), then " : "";
    // The agent's commands ran but the game never dialled: after a while the user is told to type it.
    const late = game.dialledAt !== undefined && Date.now() - game.dialledAt > ATTACH_DIAL_WAIT_MS;
    const step = (line: string, what: string): string | undefined => {
      const failed = game.dialFailures.find((f) => f.line === line);
      if (failed) {
        const why = game.cheats === false || /cheat|permission|not allowed/i.test(failed.message) ? "turn cheats on in this world, then " : "";
        return `sculkwire's in-game agent could not run "/${line}" (${failed.message}): ${why}type "/${line}" in the game chat to ${what}`;
      }
      if (agent && game.inWorld && !late) return undefined;
      return `${cheats}type "/${line}" in the game chat to ${what}${cheats ? "" : " (it needs cheats on in the world)"}`;
    };
    if (!(this.#session && !this.#session.closed)) {
      const s = step(lines.debugger, "attach the script debugger");
      if (s) steps.push(s);
    }
    this.#manual = steps;
    // Without `connect` the websocket channel is not wanted: nothing is asked of the user for it.
    if (connect.clients().length > 0 || !this.#connectWanted) this.#connectStep = undefined;
    // Without the agent nobody notices the user turning it off: the step then also names the command to type.
    else if (game.encrypted) this.#connectStep = agent ? ENCRYPTED_STEP : `${ENCRYPTED_STEP}, then type "/${lines.connect}" in the game chat`;
    else {
      const s = step(lines.connect, "enable /connect (commands still work through the script debugger)");
      // Without the agent nobody knows whether the game requires encrypted websockets, which /connect here cannot serve.
      this.#connectStep = s && game.encrypted === undefined && !agent ? `${s}; if Settings > General > Require Encrypted Websockets is on, turn it off first` : s;
    }
  }

  /**
   * A debugger session of an attached game is up: the helper pack is asked once per session, then the game is ready
   * (so `helperNote` is settled when ready shows). When the world does not run the helper pack, it goes into
   * development_behavior_packs for the next time a world loads it, and `helperNote` says what needs it.
   */
  async #sessionUp(): Promise<void> {
    const game = this.#attached;
    const session = this.#session;
    if (!game || !session || session.closed || game.probed === session) return;
    game.probed = session;
    if (await this.#ping(3_000)) {
      game.helperNote = undefined;
    } else {
      if (!game.helperInstalled && this.install) {
        game.helperInstalled = true;
        await installHelperPack(this.install).catch(() => undefined);
      }
      game.helperNote = helperMissing(game.name);
    }
    this.#ready = true;
  }

  /**
   * Keep up with an attached game until `stop`: a world opened or changed, cheats turned on, a session dropped (the
   * agent dials again), the user typing the commands, the helper answering. Rejects with `WaitTimeout` when no
   * debugger session came within `BACKGROUND_WAIT_MS`.
   */
  async #attachLoop(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + BACKGROUND_WAIT_MS;
    for (;;) {
      await sleep(ATTACH_POLL_MS, undefined, { signal });
      const game = this.#attached;
      if (!game || !isAlive(game.gamePid)) return;
      const open = !!this.#session && !this.#session.closed;
      // A session that was up and closed: the game left the world or rejoined, so the channels are dialled again.
      if (!open && game.probed?.closed && game.dropped !== game.probed) {
        game.dropped = game.probed;
        game.drops++;
      }
      if (!open || (this.#connect?.clients().length ?? 0) === 0) {
        await this.#lookAtGame();
        if (engine.attached && game.inWorld && game.dialledFor !== this.#dialKey(game)) await this.#dialThroughAgent();
      }
      if (open) await this.#sessionUp();
      this.#attachSteps();
      await this.#lockForSteps();
      if (!this.#ready && Date.now() > deadline) throw new WaitTimeout(`no script debugger session within ${BACKGROUND_WAIT_MS / 60_000} min`);
    }
  }

  /** Linux: keep this install's game streams on the silent sink from now until `stop` (`GameMute`). */
  async #startMuteWatcher(install: ClientInstall): Promise<void> {
    this.#muteWatcher = new GameMute(systemPactl, () => gamePids(install));
    await this.#muteWatcher.start();
  }

  /**
   * Wait for the game process, then for the world (each up to `timeoutMs`), counting helper prints after `since`.
   * Rejects with "the game stopped" once `signal` aborts.
   */
  async #finishStart(timeoutMs: number, since: number, signal: AbortSignal, foreground = false): Promise<void> {
    let gamePid: number;
    try {
      gamePid = await untilStopped(waitForGame(this.install as ClientInstall, timeoutMs, signal), signal);
    } catch (e) {
      if (signal.aborted) throw e;
      throw new WaitTimeout(errorMessage(e));
    }
    if (this.launchState) {
      this.launchState.gamePid = gamePid;
      // A later process (sculk game stop, a restarted MCP server) stops the game only when its record names it.
      await writeLaunchState(this.launchState).catch(() => undefined);
    }
    const atFirstLook = await untilStopped(this.#waitForWorld(timeoutMs, since, signal, foreground), signal);
    // Windows mutes the game's audio sessions, which exist once it plays sound: by now it surely opened its device.
    if (this.launchState?.muteRequested && process.platform === "win32") {
      const note = await muteWindowsGame(this.launchState, gamePid);
      if (note) {
        this.#muteNote = note;
        this.#manual.push(note);
      }
    }
    this.#ready = true;
    // The world is in: a recovery that ran on the way counts as recovered, whatever it still read when it stopped.
    if (this.#joinRecovery && !this.#joinRecovery.recovered) this.#joinRecovery = { ...this.#joinRecovery, recovered: true };
    const by: WorldEntry["by"] = this.#walks.walked ? "auto-enter" : atFirstLook ? "already-open" : this.install?.launch ? "launch" : "manual";
    this.#entry = { by, seconds: Math.round((Date.now() - this.#startedAt) / 100) / 10, ...(this.#walks.walked ? { clicks: this.#walks.clicks } : {}) };
    this.#manual = this.#manual.filter(
      (m) => !m.startsWith(START_YOURSELF) && !m.startsWith(WORLD_NOT_LOADED) && !m.startsWith(OPEN_YOURSELF) && !m.startsWith(WORLD_DIALOG),
    );
    this.#userStep = undefined;
    await this.#attachConnect();
    // After /connect: on a game with host input it was typed into the chat, which the lock would keep out. A walk into
    // the world already set it as soon as the agent was attached, unless a step handed to the user released it.
    await this.#lockInput(signal);
  }

  /**
   * Hand a step in the game to the user (`manualSteps`) and release the session lock while they take it, as `stop`
   * does, so they are not locked out of the very menu they are asked to use; `lockNote` says so. The lock is taken
   * again once sculkwire has the game back (`#lockInput`: the world is in, or an attached game needs nothing more).
   */
  async #handOver(step: string): Promise<void> {
    if (!this.#manual.includes(step)) this.#manual.push(step);
    this.#userStep = step;
    if (!this.#lockHeld) return;
    this.#lockHeld = false;
    this.#lockTried = false;
    await inputProvider()?.releaseSessionLock?.();
    this.#lockNote = "input lock released so the user can take the step in manualSteps in the game; sculkwire takes it again once it has the game back";
  }

  /** An attached game: release the lock while a step is the user's (`manualSteps`, the /connect step), take it again after. */
  async #lockForSteps(): Promise<void> {
    const step = this.#manual[0] ?? this.#connectStep;
    if (step !== undefined) {
      if (this.#lockHeld) await this.#handOver(step);
      return;
    }
    this.#userStep = undefined;
    await this.#lockInput();
  }

  /**
   * Apply game_launch `inputLock` now that sculkwire has the game: as soon as the agent is attached (attach mode, or a
   * walk into the world from the start or Play screen), else once the world is loaded. Runs once per `start`. Fails
   * open: the reason goes to `lockNote`, and a `stop` that ran meanwhile gets no lock left behind. `agentError`: the
   * attach already failed (attach mode), so it is not tried twice.
   */
  async #lockInput(signal: AbortSignal | undefined = this.#startAbort?.signal, agentError?: string): Promise<void> {
    const mode = this.#inputLock;
    if (mode === undefined || !signal || signal.aborted || this.#lockTried) return;
    this.#lockTried = true;
    const provider = inputProvider();
    const why = !provider?.sessionLock
      ? NO_INPUT_PROVIDER
      : agentError !== undefined
        ? `the in-game agent could not be attached (${agentError})`
        : await provider.sessionLock(mode);
    if (signal.aborted) await provider?.releaseSessionLock?.();
    else if (why) this.#lockNote = `input lock ${mode} not set, so the user's keyboard and mouse still reach the game: ${why}`;
    else {
      // Only the opt-in session lock stands between calls; `auto` locks per action and `off` never.
      this.#lockHeld = mode === "on";
      this.#lockNote = undefined;
    }
  }

  /** Run `body` (menu input through the agent) under the input lock for its duration, when the agent is attached. */
  #acting<T>(body: () => Promise<T>): Promise<T> {
    return withInputLock(engine.attached ? inputProvider() : undefined, body);
  }

  /**
   * Wait until the helper printed ready and the player spawned, recovering the deeplink/sign-in race on the way. When
   * the world join beats Microsoft sign-in, either the client rejects its LoginPacket, disconnects and waits on its
   * connection-error screen ("An error has occurred. You need to authenticate to Microsoft services."), or sign-in
   * finishes while the world loads and the game closes the world and shows the start screen. `#returnToWorld` then
   * walks the menus back into the test world. The game is never relaunched for this.
   *
   * The bridge also walks in when the game just sits on the start or Play screen (`#autoEnter`): an install the user
   * starts opens no world by itself, so there the in-game agent is attached once the start screen is up.
   *
   * True when the world was already ready at the first look. Rejects once `signal` aborts (`stop`).
   */
  async #waitForWorld(timeoutMs: number, since: number, signal: AbortSignal, foreground = false): Promise<boolean> {
    const printed = (mark: string) => this.#prints.some((p) => p.seq > since && p.message.includes(mark));
    let deadline = Date.now() + timeoutMs;
    const auto: AutoEnter = { since: Date.now(), attachTried: false, attempts: 0, lastAt: 0 };
    for (let first = true; ; first = false) {
      signal.throwIfAborted();
      if (printed(HELPER_MARK.ready) && printed(HELPER_MARK.spawned)) return first;
      await this.#readJoinLog();
      if (this.#userStep !== undefined) {
        // The user has a step in the game: nothing is pressed or clicked until the world is in.
        if (foreground) throw new NeedsUser(this.#userStep);
        if (Date.now() > deadline) throw new WaitTimeout(`timed out after ${timeoutMs} ms waiting for the user's step: ${this.#userStep}`);
        if (this.launchState && !(await launchStateExists())) throw new Error("the game stopped");
        await sleep(500, undefined, { signal });
        continue;
      }
      if (this.#joinState.failed) {
        if (!this.#canWalkMenus()) await this.#attachForEntry(auto);
        if (!this.#canWalkMenus()) {
          if (!this.install?.launch) {
            // The user started the game and only they can press the button: say so once and wait for their fix.
            const note =
              'the world join raced Microsoft sign-in: in the game press "Back to menu" if the error screen is up, then Play and the test world';
            if (!this.#manual.includes(note)) {
              this.#manual.push(note);
              this.#joinRecovery = {
                attempts: 0,
                recovered: false,
                ...(this.#joinState.lines.length ? { log: this.#joinState.lines.join("\n") } : {}),
              };
            }
            await sleep(2000, undefined, { signal });
            continue;
          }
          throw new Error(this.#joinNoInputMessage());
        }
        // The walk goes through the agent: lock first, so a game in the background takes its clicks.
        if (engine.attached) await this.#lockInput(signal);
        const result = await this.#walkIn();
        if (!result.recovered) {
          // A step handed to the user (a dialog, a tile that cannot be told apart): wait for them, never press on.
          if (this.#userStep !== undefined) continue;
          throw new Error(this.#joinFailureMessage(result));
        }
        // The world loads again from the start: give the rejoin its own window, then wait for ready and spawn.
        deadline = Date.now() + timeoutMs;
        continue;
      }
      if (await this.#autoEnter(auto)) {
        deadline = Date.now() + timeoutMs;
        continue;
      }
      if (Date.now() > deadline) {
        // Scripts loaded but the spawn print never came: commands that do not target the player still work.
        if (printed(HELPER_MARK.ready)) return false;
        throw new WaitTimeout(`timed out after ${timeoutMs} ms waiting for the game`);
      }
      if (this.launchState && !(await launchStateExists())) throw new Error("the game stopped");
      await sleep(500, undefined, { signal });
    }
  }

  /** Whether the menus can be walked: host input reaches the game, or the in-game agent drives its UI. */
  #canWalkMenus(): boolean {
    return !!this.launchState && (hasInput(this.launchState) || engine.attached);
  }

  /**
   * On an install the user starts, attach the in-game agent (the input provider) once, so the bridge can walk into the
   * world. Fails open: the user is told to open the world themselves.
   */
  async #attachForEntry(auto: AutoEnter): Promise<void> {
    if (this.install?.launch || auto.attachTried || engine.attached) return;
    auto.attachTried = true;
    const provider = inputProvider();
    const name = this.world?.name ?? "the test world";
    if (!provider) return;
    try {
      await provider.attach();
    } catch (e) {
      await this.#handOver(`${OPEN_YOURSELF}: sculkwire could not attach its in-game agent (${errorMessage(e)}). In the game choose Play, then "${name}"`);
      return;
    }
    await this.#lockInput();
  }

  /**
   * Walk into the world when the game sits on the start or Play screen with no world opening for `AUTO_ENTER_IDLE_MS`,
   * through the in-game agent (attached here on an install the user starts; on one sculkwire starts only when it is
   * already attached). At most one walk per `AUTO_ENTER_EVERY_MS` and `AUTO_ENTER_ATTEMPTS` in all, so a user who
   * opens a menu meanwhile is not fought. True when a walk got into the world.
   */
  async #autoEnter(auto: AutoEnter): Promise<boolean> {
    const world = this.world;
    if (!world || !this.launchState || auto.attempts >= AUTO_ENTER_ATTEMPTS || this.#userStep !== undefined) return false;
    const menu = (kind: string) => kind === "start" || kind === "play";
    if (!engine.attached) {
      if (this.install?.launch || auto.attachTried) return false;
      if (!menu(currentScreen(this.#screens)) && Date.now() - auto.since < AUTO_ATTACH_AFTER_MS) return false;
      await this.#attachForEntry(auto);
      if (!engine.attached) return false;
    }
    await this.#lockInput();
    const screen = await agentUi((ms) => sleep(ms))?.screen().catch(() => undefined);
    if (screen) this.#screens = screensFromUi(screen, this.#screens);
    const kind = currentScreen(this.#screens);
    const now = Date.now();
    if (!menu(kind)) {
      auto.idle = undefined;
      return false;
    }
    if (!auto.idle || auto.idle.kind !== kind) {
      auto.idle = { since: now, kind };
      return false;
    }
    if (now - auto.idle.since < AUTO_ENTER_IDLE_MS || now - auto.lastAt < AUTO_ENTER_EVERY_MS) return false;
    auto.attempts++;
    let why: string;
    try {
      const result = await this.#walkIn(AUTO_ENTER_TIMEOUT_MS);
      if (result.recovered) return true;
      why = result.reason ?? "unknown";
    } catch (e) {
      why = errorMessage(e);
    } finally {
      auto.lastAt = Date.now();
      auto.idle = undefined;
    }
    if (auto.attempts >= AUTO_ENTER_ATTEMPTS) {
      await this.#handOver(`${OPEN_YOURSELF}: sculkwire tried ${auto.attempts} times and could not (${why}). In the game choose Play, then "${world.name}"`);
    }
    return false;
  }

  /** Read what the engine log (`Debug_Log`) said since the last look; keeps the join and screen states current. */
  async #readJoinLog(): Promise<string> {
    const install = this.install;
    if (!install) return "";
    try {
      const { text, end } = await readDebugLogSince(install.logsDir, this.#joinCursor);
      if (end) this.#joinCursor = end;
      if (text) {
        this.#joinState = joinStateInLog(text, this.#joinState);
        this.#screens = screensInLog(text, this.#screens);
      }
      return text;
    } catch {
      // A locked log (Windows) or a log that is being replaced: the helper's prints still tell when the world is up.
      return "";
    }
  }

  /** Why the game cannot be walked back into the world: desktop mode has no background input route. */
  #joinNoInputMessage(): string {
    const lines = this.#joinState.lines.map((l) => l.replace(/^\[[^\]]*\]\s*/, ""));
    return (
      `the world join failed while Microsoft sign-in was still finishing${lines.length ? ` (${lines.join("; ")})` : ""}: ` +
      "the game is out of the world, on its connection-error screen or the start screen, and desktop mode has no " +
      'background input. Launch with display: window, or press "Back to menu" if that screen is up, then Play and the ' +
      "test world yourself"
    );
  }

  /** The game as the menu walks (`recoverJoin`, `leaveWorld`) see it: host input and screenshots, or the agent's UI. */
  #recoveryIO(state: LaunchState): RecoveryIO {
    const shots = dataDir("client", "screenshots");
    const host = hasInput(state);
    return {
      readLog: () => this.#readJoinLog(),
      key: async (keys) => {
        if (!host) throw new Error("no host keyboard reaches this game; keys go through the in-game agent");
        await sendInput(state, { action: "key", keys });
      },
      ...(host
        ? {
            click: (x: number, y: number, count = 1) => {
              const frame = this.#frame ?? { width: state.width ?? DEFAULT_FRAME.width, height: state.height ?? DEFAULT_FRAME.height };
              return clicks(
                count,
                async () => void (await sendInput(state, { action: "click", x: Math.round(frame.width * x), y: Math.round(frame.height * y) })),
                (ms) => sleep(ms),
              );
            },
          }
        : {}),
      screenshot: async (label) => {
        const path = `${shots}/${label}-${state.startedAt}-${Date.now()}.png`;
        let file: string;
        if (host) file = (await screenshot(state, path)).path;
        else {
          const taken = await engine.screenshot(path);
          if (!taken.ok) throw new Error(taken.message);
          file = taken.value.path;
        }
        const shot = await readShot(file);
        this.#frame = pngSize(shot.png) ?? this.#frame;
        return shot;
      },
      alive: launchStateExists,
      ui: agentUi,
      sleep: (ms) => sleep(ms),
      now: () => Date.now(),
    };
  }

  /**
   * Save & Quit before a stop, so the game writes the world (`leaveWorld` in screens.ts): Escape, then Save & Quit by its
   * name through the in-game agent's UI (or at its place with a background mouse), then the wait for the start or Play
   * screen, for up to `LEAVE_TIMEOUT_MS`. Undefined when the game had no world open; else whether it left the world,
   * and how or why not.
   */
  async #saveAndQuit(state: LaunchState): Promise<{ saved: boolean; detail: string } | undefined> {
    await this.#readJoinLog();
    // The agent's UI says which screen is up; without it only the engine log does, and it must say the world is open.
    if (!this.#screens.inWorld && !(engine.attached && this.#ready)) {
      return this.#ready ? { saved: false, detail: "the engine log does not say which screen the game shows, and no in-game agent is attached" } : undefined;
    }
    if (!this.#canWalkMenus()) return { saved: false, detail: "no input route reaches the game's menus (no in-game agent attached, no background input)" };
    await this.#controller?.releaseAll().catch(() => undefined);
    // The pause menu does not open over the death screen: respawn first, as a player would.
    if (await this.dead()) {
      const revived = await this.respawn();
      if (!revived.respawned) return { saved: false, detail: `the player is dead and did not respawn: ${revived.detail}` };
    }
    try {
      const result = await this.#acting(() => leaveWorld(this.#recoveryIO(state), { screens: this.#screens, join: this.#joinState, timeoutMs: LEAVE_TIMEOUT_MS }));
      this.#screens = result.screens;
      this.#joinState = result.join;
      const via = result.steps.join(" → ");
      return result.left ? { saved: true, detail: via } : { saved: false, detail: `${result.reason ?? "unknown"}${via ? ` (pressed: ${via})` : ""}` };
    } catch (e) {
      return { saved: false, detail: errorMessage(e) };
    }
  }

  /**
   * Whether the player is dead: the death screen is up (`ui.screen` when the in-game agent is attached, else the engine
   * log), or the player's health is 0 or less: from the helper's streamed state of the last `DEATH_HEALTH_FRESH_MS`, else
   * asked from the helper once (on 1.26.60 the death screen is an OreUI page neither the agent nor the log names, so
   * without a running stream health is the only sign).
   */
  async dead(): Promise<boolean> {
    if (!this.running) return false;
    await this.#readJoinLog();
    const screen = await agentUi((ms) => sleep(ms))
      ?.screen()
      .catch(() => undefined);
    if (screen) this.#screens = screensFromUi(screen, this.#screens);
    if (currentScreen(this.#screens) === "death") return true;
    let health = this.#freshHealth();
    if (health === undefined) {
      const state = await this.query("state", {}, 3000).catch(() => undefined);
      if (state && typeof state === "object" && "health" in state && typeof state.health === "number") health = state.health;
    }
    return health !== undefined && health <= 0;
  }

  /** The player's health from a streamed state at most `DEATH_HEALTH_FRESH_MS` old, else undefined. */
  #freshHealth(): number | undefined {
    const s = this.#playerSample();
    return s && Date.now() - s.at <= DEATH_HEALTH_FRESH_MS ? s.state.health : undefined;
  }

  /**
   * Press RESPAWN when the player is dead (`respawn` in screens.ts): by its control name through the in-game agent's UI,
   * else a click at its place on the death screen, then the wait for the player to be alive again, for up to
   * `timeoutMs`. `via` `alive` when the player was not dead (nothing pressed); `respawned` false with the reason in
   * `detail` when RESPAWN could not bring the player back.
   */
  async respawn(timeoutMs = RESPAWN_TIMEOUT_MS): Promise<RespawnOutcome> {
    const state = this.launchState;
    if (!state || !this.running) throw new Error("the game is not running");
    // The helper's health is what tells the player is alive again: keep its state stream running.
    if (this.#streamEvery === undefined) await this.#streamState(2).catch(() => undefined);
    // A stream that just started has no sample yet: without one a death shown only by health would read as alive.
    for (let waited = 0; this.#freshHealth() === undefined && waited < DEATH_HEALTH_FRESH_MS; waited += 100) await sleep(100);
    if (!(await this.dead())) return { respawned: false, via: "alive", detail: "the player is alive: nothing to respawn" };
    if (!this.#canWalkMenus()) {
      return { respawned: false, via: "none", detail: "the player is dead, and no input route reaches the death screen (no in-game agent attached, no background input): press RESPAWN in the game" };
    }
    await this.#controller?.releaseAll().catch(() => undefined);
    const result = await this.#acting(() =>
      respawn(this.#recoveryIO(state), { health: () => this.#freshHealth(), screens: this.#screens, join: this.#joinState, timeoutMs }),
    );
    this.#screens = result.screens;
    this.#joinState = result.join;
    const how = result.steps.join(" → ");
    if (!result.wasDead) return { respawned: false, via: "alive", detail: "the player is alive: nothing to respawn" };
    if (result.respawned) return { respawned: true, via: result.via, detail: `respawned (${how})` };
    return { respawned: false, via: result.via, detail: `${result.reason ?? "unknown"}${how ? ` (pressed: ${how})` : ""}` };
  }

  /**
   * Walk the game from whatever screen it shows back into the world (`recoverJoin` in screens.ts): Back to menu on the
   * error screen, Escape out of the Marketplace or any other screen, Play on the start screen, the tile showing the
   * world's own picture (its `world_icon.jpeg`) on the Play screen, waiting out loading screens, for up to `timeoutMs`.
   * Host input and screenshots where they reach the game, the in-game agent's UI calls and screenshots otherwise. When
   * the tile cannot be told apart (no picture, or two tiles show it), nothing is clicked and the user is asked to open
   * the world (`manualSteps`).
   */
  async #returnToWorld(timeoutMs = 180_000): Promise<RecoveryResult> {
    const state = this.launchState;
    const world = this.world;
    if (!state || !world) throw new Error("the game is not running");
    if (!this.#canWalkMenus()) throw new Error(this.#joinNoInputMessage());
    this.#joinRecovery = { attempts: 0, recovered: false, ...(this.#joinState.lines.length ? { log: this.#joinState.lines.join("\n") } : {}) };
    const thumbnail = await readFile(join(world.dir, ICON_FILE)).then(
      (jpeg) => decodeJpeg(jpeg),
      () => undefined,
    );
    // The helper pack answering from a world since the walk began means the world is in, whatever the screens read.
    const since = this.#printSeq;
    const inWorld = () => this.#prints.some((p) => p.seq > since && (p.message.includes(HELPER_MARK.ready) || p.message.includes(HELPER_MARK.spawned)));
    const result = await this.#acting(() =>
      recoverJoin({ ...this.#recoveryIO(state), inWorld }, {
        levelId: world.levelId,
        ...(thumbnail ? { thumbnail } : {}),
        timeoutMs,
        screens: this.#screens,
        join: this.#joinState,
      }),
    );
    if (result.stuck) {
      await this.#handOver(
        `${WORLD_DIALOG} or ignored the click on "${world.name}" (${result.reason ?? "the world did not open"}). If it asks to update ` +
          `"${world.name}" (for example to the new world height), confirm it yourself (it can make a backup copy first); otherwise open ` +
          `"${world.name}" yourself. sculkwire never confirms it for you and continues once the world is loaded`,
      );
    } else if (result.needsUser && !this.#manual.some((m) => m.startsWith(OPEN_YOURSELF))) {
      await this.#handOver(`${OPEN_YOURSELF}: ${result.reason ?? "sculkwire cannot tell its tile apart"}. In the game choose Play, then "${world.name}"`);
    }
    this.#screens = result.screens;
    this.#joinState = result.join;
    this.#joinRecovery = {
      ...this.#joinRecovery,
      attempts: result.steps.length,
      recovered: result.recovered,
      ...(result.steps.length ? { via: result.steps.join(" → ") } : {}),
      ...(result.screenshot ? { screenshot: result.screenshot } : {}),
    };
    if (result.reason) this.#joinRecovery.log = `${this.#joinRecovery.log ? `${this.#joinRecovery.log}\n` : ""}${result.reason}`;
    return result;
  }

  /** `#returnToWorld` while the bridge waits for the world, counted for `entry()`. */
  async #walkIn(timeoutMs?: number): Promise<RecoveryResult> {
    const result = await this.#returnToWorld(timeoutMs);
    this.#walks.clicks += result.presses;
    if (result.recovered) this.#walks.walked = true;
    return result;
  }

  /** How this launch reached the test world; undefined until the world is ready. */
  entry(): WorldEntry | undefined {
    return this.#entry ? { ...this.#entry } : undefined;
  }

  /** What to tell the agent when the menus did not lead back into the world. */
  #joinFailureMessage(result: RecoveryResult): string {
    const lines = (this.#joinState.lines.length ? this.#joinState.lines : ["LoginPacket failed validation"]).map((l) =>
      l.replace(/^\[[^\]]*\]\s*/, ""),
    );
    const shot = result.screenshot ? ` The error screen is at ${result.screenshot}.` : "";
    const steps = result.steps.length ? ` Pressed: ${result.steps.join(" → ")}.` : "";
    return (
      `the world join failed while Microsoft sign-in was still finishing (${lines.join("; ")}), and the way back to the ` +
      `world did not work (${result.reason ?? "unknown"}; last screen: ${currentScreen(result.screens)}).${steps}${shot} ` +
      'Press "Back to menu" if the error screen is up, then Play and the test world in the game yourself'
    );
  }

  /**
   * Get a `/connect` client. First wait briefly in case the game dialled in by itself (the launch's automation options).
   * Otherwise only with game_launch `connect: true`: where input reaches the game, wait until the player has spawned
   * (keys sent during the loading screen land as debug keybinds) and type `/connect` (gamescope's display on Linux,
   * SendInput on Windows); elsewhere the user is asked to type it. Without `connect` nothing is typed and nothing is
   * asked: commands go through the script debugger.
   */
  async #attachConnect(): Promise<void> {
    const connect = this.#connect;
    const state = this.launchState;
    if (!connect || !state) return;
    try {
      await connect.waitForClient(5_000);
      this.#connectMethod = "automatic";
      return;
    } catch {
      // not dialled in by itself
    }
    if (!this.#connectWanted) return;
    const line = `connect localhost:${connect.port}`;
    if (!hasInput(state)) {
      this.#connectStep = `type "/${line}" in the game chat to enable /connect (commands still work through the script debugger)`;
      return;
    }
    await this.waitForPrint((p) => p.message.includes(HELPER_MARK.spawned), 60_000).catch(() => undefined);
    const errors: string[] = [];
    for (let attempt = 0; attempt < 2 && connect.clients().length === 0; attempt++) {
      await sleep(attempt === 0 ? 3000 : 5000);
      try {
        await typeChatCommand(state, line);
        await connect.waitForClient(10_000);
        this.#connectMethod = "chat";
      } catch (e) {
        errors.push(errorMessage(e));
      }
    }
    if (connect.clients().length === 0) {
      this.#connectStep = `/connect did not attach (${errors.join("; ")}): type "/${line}" in the game chat to enable it (commands use the script debugger until then)`;
    }
  }

  /** Open the debugger listener the game dials (game_launch does this) and take each session it accepts. Returns the port. */
  async listenDebugger(port = BRIDGE_DEBUGGER_PORT): Promise<number> {
    const listener = await listen(port);
    this.#listener = listener;
    this.#acceptLoop(listener);
    return listener.port;
  }

  #acceptLoop(listener: DebuggerListener): void {
    void (async () => {
      while (this.#listener === listener) {
        let session: DebuggerSession;
        try {
          session = await listener.accept(10 * 60_000);
        } catch {
          continue;
        }
        if (this.#listener !== listener) {
          session.close();
          return;
        }
        this.#session?.close();
        this.#session = session;
        // A dropped session takes the helper's replies with it until a session prints ready again.
        session.on("close", () => {
          if (this.#session === session) this.#helperUp = false;
        });
        session.on("print", (p: PrintEvent) => {
          // Streamed player state arrives up to 20 times a second: keep only the latest, out of the print log.
          if (p.message.startsWith(HELPER_MARK.state)) {
            try {
              const state = JSON.parse(p.message.slice(HELPER_MARK.state.length)) as PlayerState & { entities?: Omit<StreamedEntities, "at" | "tick"> };
              const at = Date.now();
              if (state.entities) this.#latestEntities = { ...state.entities, at, tick: state.tick };
              delete state.entities;
              this.#ticks.arrived(state.tick, at);
              this.#latestState = { at, state };
            } catch {
              // partial line
            }
            return;
          }
          // The helper printing ready again means its scripts restarted (`/reload`, a rejoin): the state stream it
          // ran is gone, so the next playerState() starts a new one.
          if (p.message.includes(HELPER_MARK.ready)) {
            this.#streamEvery = undefined;
            this.#latestState = undefined;
            this.#latestEntities = undefined;
            if (this.#session === session) {
              this.#helperUp = true;
              this.#helperStep = undefined;
            }
          }
          this.#prints.push({ ...p, seq: ++this.#printSeq });
          this.#printSignal?.resolve();
          this.#printSignal = undefined;
          if (this.#prints.length > 5000) this.#prints.splice(0, this.#prints.length - 5000);
        });
      }
    })();
  }

  async waitForPrint(match: (p: PrintEvent) => boolean, timeoutMs: number, since = 0): Promise<PrintEvent> {
    const deadline = Date.now() + timeoutMs;
    let checked = Date.now();
    for (;;) {
      // Only the prints after `since` (seq order), oldest first.
      let from = this.#prints.length;
      while (from > 0 && (this.#prints[from - 1]?.seq ?? 0) > since) from--;
      const hit = this.#prints.slice(from).find(match);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for the game`);
      if (this.launchState && Date.now() - checked >= 200) {
        checked = Date.now();
        if (!(await launchStateExists())) throw new Error("the game stopped");
      }
      // Woken by the next print, so a helper reply is read as it arrives (the 200 ms is only a fallback).
      this.#printSignal ??= Promise.withResolvers<void>();
      await Promise.race([sleep(200), this.#printSignal.promise]);
    }
  }

  #requireRunning(): void {
    if (this.launchState && this.#gameExited()) {
      throw new Error(`the game process (pid ${this.launchState.gamePid}) exited; call game_stop, then game_launch`);
    }
    if (!this.running) throw new Error("no client running; call game_launch first");
  }

  /** Run a command: through /connect when attached (structured status), else the script debugger (prints). */
  async command(commandLine: string, via: "auto" | "connect" | "debugger" = "auto"): Promise<CommandOutput> {
    this.#requireRunning();
    const command = commandLine.replace(/^\//, "");
    const connect = this.#connect;
    // A `/connect` command reaches the game's server as a command request, which kicks the player when it is over
    // MAX_COMMAND_CHARS: such a line goes through the script debugger, which has no such limit.
    const long = commandTooLong(command);
    if (via === "connect" && long) throw new Error(`${COMMAND_TOO_LONG}: send it through the script debugger (via: debugger)`);
    const useConnect = via === "connect" || (via === "auto" && !long && connect !== undefined && connect.clients().length > 0);
    if (useConnect) {
      if (!connect || connect.clients().length === 0) throw new Error("no /connect client attached");
      const r: CommandResult = await connect.command(command);
      return { command, via: "connect", ok: r.ok, output: r.statusMessage ? [r.statusMessage] : [], statusCode: r.statusCode, body: r.body };
    }
    const session = this.#session;
    if (!session || session.closed) throw new Error("script debugger not attached");
    const since = this.#printSeq;
    session.command(command);
    const echo = await this.waitForPrint((p) => p.message.includes(`Executing command [${command}]`), 10_000, since);
    // Output follows the echo; stop after a quiet gap. Only the command's own lines extend it: the helper's traffic
    // (a `play` run sends queries four times a second, each with an echo, a confirmation and a reply) never lets it go quiet.
    let last = echo.seq;
    let quietUntil = Date.now() + 600;
    const deadline = Date.now() + 5_000;
    while (Date.now() < quietUntil && Date.now() < deadline) {
      await sleep(100);
      if (this.#printSeq > last) {
        const seen = last;
        last = this.#printSeq;
        if (this.#prints.some((p) => p.seq > seen && !helperTraffic(p.message))) quietUntil = Date.now() + 400;
      }
    }
    const output = this.#prints.filter((p) => p.seq > echo.seq && p.seq <= last && !helperTraffic(p.message)).map((p) => p.message.trim());
    return { command, via: "debugger", ok: debuggerCommandOk(output, await this.#failureMatcher()), output };
  }

  #failureMatcher(): Promise<FailureMatcher> {
    const install = this.install;
    let failures = this.#failures;
    if (!failures || failures.install !== install) {
      failures = { install, matcher: loadFailureMatcher(install?.gameDir, install ? optionsFiles(install)[0] : undefined) };
      this.#failures = failures;
    }
    return failures.matcher;
  }

  /** Every block, item or mob id the running game knows: `/connect` data requests, else the helper pack (`readRegistry`). */
  async registry(kind: DataKind): Promise<RegistryResult> {
    this.#requireRunning();
    const connect = this.#connect;
    const session = this.#session;
    return readRegistry(kind, {
      ...(connect && connect.clients().length > 0 ? { connect: () => connect.data(kind) } : {}),
      ...(session && !session.closed ? { script: (offset: number) => this.query("registry", { registry: kind, offset }) } : {}),
    });
  }

  /**
   * The player's state, at most `maxAgeMs` old. Starts the helper's state stream on first use, so control loops read
   * fresh state without a round trip per step.
   */
  async playerState(maxAgeMs = 150): Promise<PlayerState> {
    this.#requireRunning();
    if (this.#streamEvery === undefined) await this.#streamState(2);
    const deadline = Date.now() + 5_000;
    for (;;) {
      const s = this.#playerSample();
      if (s && Date.now() - s.at <= maxAgeMs) return s.state;
      if (Date.now() > deadline) throw new Error("no player state from the game (is the player in a world?)");
      await sleep(15);
    }
  }

  /**
   * The newest player state: the helper's, with position, rotation, velocity, ground and health taken from the input
   * provider's motion stream while that is fresh (every tick, rotation included, against every 50 to 100 ms from the
   * helper). Entities, blocks under the crosshair, held item, slot and game tick stay the helper's.
   */
  #playerSample(): { at: number; state: PlayerState } | undefined {
    const helper = this.#latestState;
    const m = inputProvider()?.motion();
    const now = Date.now();
    if (!helper || !m || now - m.at > MOTION_FRESH_MS || now - helper.at > HELPER_FOR_MOTION_MS) return helper;
    const [x, y, z] = m.motion.position;
    const [vx, vy, vz] = m.motion.velocity;
    return {
      at: m.at,
      state: {
        ...helper.state,
        location: { x, y, z },
        rotation: { x: m.motion.rotation[0], y: m.motion.rotation[1] },
        velocity: { x: vx, y: vy, z: vz },
        ...(m.motion.onGround !== null ? { onGround: m.motion.onGround } : {}),
        ...(m.motion.health !== null ? { health: m.motion.health } : {}),
        source: "engine",
      },
    };
  }

  /** Ask the helper to stream the player state every `every` ticks (1 while an action runs, 2 when idle). */
  async #streamState(every: number): Promise<void> {
    if (this.#streamEvery === every) return;
    await this.query("stream", { every });
    this.#streamEvery = every;
  }

  /** The game as the player controller sees it: streamed state, entity lookups and player input. */
  playerWorld(): PlayerWorld {
    const provider = inputProvider();
    this.#requireRunning();
    let input: PlayerInput;
    try {
      input = playerInput(this.launchState as LaunchState);
    } catch (err) {
      // A Linux desktop window has no keyboard route, but an input provider's engine route still drives the player.
      if (!provider) throw err;
      input = unavailableInput(errorMessage(err));
    }
    return {
      state: (maxAgeMs) => this.playerState(maxAgeMs),
      sample: () => this.#playerSample(),
      stateRate: (every) => this.#streamState(every),
      input,
      ...(provider ? { engine: provider.input } : {}),
      entity: async (id) => {
        const streamed = streamEntity(this.#latestEntities, id, Date.now());
        if (streamed) {
          this.staleness.record("stream", streamed.ageMs ?? 0);
          return streamed;
        }
        const e = (await this.query("entity", { entityId: id })) as EntityInfo | null;
        const wall = e?.tick !== undefined ? this.#ticks.wallOf(e.tick) : undefined;
        if (wall !== undefined) this.staleness.record("query", Date.now() - wall);
        return e;
      },
      nearest: async (type, radius) => {
        const list = (await this.query("entities", { radius, limit: 50, ...(type ? { type } : {}) })) as EntityInfo[];
        const me = await this.playerState(1000);
        const others = list.filter((e) => e.typeId !== "minecraft:player");
        others.sort((a, b) => horizontalDistance(a.location, me.location) - horizontalDistance(b.location, me.location));
        return others[0] ?? null;
      },
      impacts: async (since) => (await this.query("impacts", { since })) as { tick: number; impacts: Impact[] },
      respawn: () => this.respawn(),
      query: (kind, params) => this.query(kind, params),
      entities: async (radius) => {
        const me = this.#latestState?.state.location;
        const streamed = me ? streamEntities(this.#latestEntities, me, radius, Date.now()) : undefined;
        return streamed ?? ((await this.query("entities", { radius, limit: 50 })) as EntityInfo[]);
      },
      loadout: async () => (await this.query("loadout")) as Loadout,
    };
  }

  /** One controller per launch, so mouse calibration carries over between calls. */
  playerController(): PlayerController {
    this.#requireRunning();
    this.#controller ??= new PlayerController(this.playerWorld());
    return this.#controller;
  }

  /** Entity property ids the launched project's behavior packs declare for `typeId` ([] when none does). */
  entityPropertyIds(typeId: string): string[] {
    return declaredEntityProperties(this.#indexed, typeId);
  }

  /** The launched project's packs as `game_log` maps messages to their files ([] before a launch with a project). */
  get indexedPacks(): readonly IndexedPack[] {
    return this.#indexed;
  }

  /**
   * Ask the helper pack (`/scriptevent sculkwire:query`) and wait for its reply print. In an attached game whose world
   * does not run the helper pack this fails at once with `helperMissing` instead of timing out.
   */
  async query(kind: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<unknown> {
    this.#requireRunning();
    const session = this.#session;
    if (!session || session.closed) throw new Error("queries need the script debugger (helper replies are prints)");
    const game = this.#attached;
    if (game && kind !== "ping" && !this.#helperUp && !(await this.#ping(2_000))) throw new Error(game.helperNote ?? helperMissing(game.name));
    return this.#ask(session, kind, params, timeoutMs);
  }

  /** Whether the helper answers a `ping` on the current session; a pong marks it up. */
  async #ping(timeoutMs: number): Promise<boolean> {
    const session = this.#session;
    if (!session || session.closed) return false;
    const pong = await this.#ask(session, "ping", {}, timeoutMs).then((r) => r === "pong", () => false);
    if (pong && this.#session === session && !session.closed) {
      this.#helperUp = true;
      this.#helperStep = undefined;
    }
    return pong;
  }

  async #ask(session: DebuggerSession, kind: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = (this.#queryId = (this.#queryId + 1) % 1_000_000_000);
    const since = this.#printSeq;
    session.command(queryCommand(kind, params, id));
    const print = await this.waitForPrint((p) => isReplyTo(p.message, id), timeoutMs, since);
    const reply = parseReply(print.message);
    if (reply.ok !== true) {
      const text = `helper: ${"error" in reply ? String(reply.error) : "failed"}`;
      throw new HelperQueryError(text, typeof reply.reason === "string" ? reply.reason : undefined);
    }
    return reply.result;
  }

  /**
   * Where the content log and the prints end now: a `logs` cursor that reads only what is written after this moment.
   */
  async logMark(): Promise<{ log?: LogPosition; printSeq: number }> {
    this.#requireRunning();
    const install = this.install ?? (await findInstall());
    const log = await contentEnd(install.logsDir);
    return { printSeq: this.#printSeq, ...(log ? { log } : {}) };
  }

  /**
   * Content-log diagnostics and script errors since the last call (or since `cursor`). `advance: false` leaves the
   * cursor game_log reads from where it is, so a reader of its own (wait_until) never takes game_log's entries.
   */
  async logs(cursor?: { log?: LogPosition; printSeq?: number }, advance = true): Promise<LogResult> {
    const install = this.install ?? (await findInstall());
    const from = cursor?.log ?? this.#logCursor;
    const { text, end } = await readContentSince(install.logsDir, from);
    const sincePrint = cursor?.printSeq ?? this.#printCursor;
    const logEntries = parseClientLog(text);
    // A content-log line also arrives as a print while the debugger is attached. It is reported once, from the log.
    const prints = unmirroredPrints(logEntries, this.#prints.filter((p) => p.seq > sincePrint));
    const diagnostics = entryDiagnostics([...logEntries, ...printEntries(prints)], this.#indexed);
    for (const p of prints) {
      // Uncaught errors the game prints at log level still carry a script frame.
      if (p.level !== "log" && p.level !== "verbose") continue;
      const d = printToDiagnostic(p, (gamePath) => this.#resolveScript(gamePath));
      if (d) diagnostics.push(d);
    }
    diagnostics.sort(compareDiagnostics);
    // Both cursors move together, so a later call never sees a print without the log line it mirrors.
    if (advance) {
      if (end) this.#logCursor = end;
      this.#printCursor = this.#printSeq;
    }
    const result: LogResult = { diagnostics, text: text.length > 20_000 ? text.slice(-20_000) : text, cursor: { printSeq: this.#printSeq } };
    if (end) result.cursor.log = end;
    return result;
  }

  /** Game script path (`mythicus/main.js`, `scripts/main.js`) → project-relative file, by suffix match. */
  #resolveScript(gamePath: string): string | undefined {
    const rel = gamePath.replace(/^scripts\//, "");
    for (const p of this.#indexed) {
      const hit = p.files.find((f) => f === `scripts/${rel}` || f.endsWith(`/${rel}`));
      if (hit) return p.pack.relDir ? `${p.pack.relDir}/${hit}` : hit;
    }
    return undefined;
  }

  /**
   * Redeploy the project (a fresh copy of each pack sculkwire deployed; a folder rgl exported to is used as it is),
   * then `/reload` (scripts + functions) or `/reload all` (documented as a rejoin with all packs; the retail
   * client answers it like `/reload` from /connect and stays in the world). Returns the copied folders
   * and the problems the reload logged.
   *
   * The helper pack restarts with the reload and prints ready again. Retail 1.26.63 run `/reload all` through the
   * script debugger (no /connect) and kept the debugger socket open but never printed again: command echoes came,
   * command output and helper replies did not. When ready does not come back, `#recoverHelper` re-establishes the
   * debugger; when that fails too the result carries a `client.helper-lost` error and game_status shows ready false
   * with the step to take.
   */
  async reload(all = false, timing: Partial<ReloadTiming> = {}): Promise<{ command: CommandOutput; diagnostics: Diagnostic[]; redeployed: string[] }> {
    this.#requireRunning();
    const t: ReloadTiming = { readyMs: all ? 60_000 : 30_000, redialMs: 10_000, helperMs: 15_000, ...timing };
    const redeployed: string[] = [];
    let deployDiagnostics: Diagnostic[] = [];
    if (this.project && this.install) {
      const deployment = await deployProject(this.install, this.project, this.#deployOption, true);
      this.#packs = deployment.packs;
      for (const dir of deployment.owned) if (!this.#deployed.includes(dir)) this.#deployed.push(dir);
      redeployed.push(...deployment.copied);
      deployDiagnostics = deployment.diagnostics;
      this.#deployDiagnostics = deployment.diagnostics;
      this.#indexed = await indexProjectPacks(this.project, this.install.sharedComMojang);
    }
    const before = { printSeq: this.#printSeq, ...(this.#logCursor ? { log: this.#logCursor } : {}) };
    const name = all ? "reload all" : "reload";
    // The helper's scripts restart: its replies are unknown until it prints ready again.
    this.#helperUp = false;
    let command: CommandOutput;
    try {
      command = await this.command(name);
    } catch (e) {
      // The channel the command went out on may have died with the reload: put the helper back before reporting.
      const lost = await this.#recoverHelper(before.printSeq, name, t);
      throw new Error(lost ? `${errorMessage(e)}; ${lost}` : errorMessage(e));
    }
    const back = await this.waitForPrint((p) => p.message.includes(HELPER_MARK.ready), t.readyMs, before.printSeq).then(
      () => true,
      () => false,
    );
    const lost = back ? undefined : await this.#recoverHelper(before.printSeq, name, t);
    await sleep(1000);
    const { diagnostics } = await this.logs(before);
    if (lost) {
      diagnostics.push({
        severity: "error",
        code: "client.helper-lost",
        message: lost,
        source: "client",
        hint: this.#helperStep ?? "call game_stop, then game_launch",
      });
    }
    return { command, diagnostics: [...deployDiagnostics, ...diagnostics], redeployed };
  }

  /**
   * The helper did not print ready after `/reload`: bring its channel back. In order, until the helper answers (a
   * ready print, or a `ping` query): ask it directly (only its ready print was missed); have the game dial the debugger
   * again with `/script debugger connect` sent over the channels still open (the old debugger session runs commands
   * after a `reload all`, /connect when attached); close the old session, which the game may follow by dialling in;
   * type the command into the game chat where input reaches the game. Returns undefined once the helper answers,
   * else what went wrong (and sets the manual step game_status shows).
   */
  async #recoverHelper(since: number, name: string, t: ReloadTiming): Promise<string | undefined> {
    const answers = async (ms: number): Promise<boolean> => {
      if (await this.waitForPrint((p) => p.message.includes(HELPER_MARK.ready), ms, since).then(() => true, () => false)) return true;
      const session = this.#session;
      if (!session || session.closed) return false;
      // A reply needs a round trip through the game: give it at least a second even when `ms` is 0.
      const pong = await this.query("ping", {}, Math.max(1_000, Math.min(ms, 3_000))).then((r) => r === "pong", () => false);
      if (pong && this.#session === session && !session.closed) {
        this.#helperUp = true;
        this.#helperStep = undefined;
      }
      return pong;
    };
    if (await answers(0)) return undefined;
    const port = this.#listener?.port;
    const old = this.#session;
    const redial = `script debugger connect localhost ${port}`;
    if (port !== undefined) {
      if (old && !old.closed) old.command(redial);
      const connect = this.#connect;
      if (connect && connect.clients().length > 0) await connect.command(redial).catch(() => undefined);
      if ((await this.#newSession(old, t.redialMs)) && (await answers(t.helperMs))) return undefined;
    }
    // Drop the dead socket: game_status stops showing it attached, and the game may dial in again by itself.
    if (this.#session === old && old && !old.closed) {
      old.close();
      if ((await this.#newSession(old, t.redialMs)) && (await answers(t.helperMs))) return undefined;
    }
    const state = this.launchState;
    if (port !== undefined && state && hasInput(state) && this.#session === old) {
      const typed = await typeChatCommand(state, redial).then(() => true, () => false);
      if (typed && (await this.#newSession(old, t.redialMs)) && (await answers(t.helperMs))) return undefined;
    }
    this.#helperUp = false;
    const how = port !== undefined ? `type "/${redial}" in the game chat, or call` : "call";
    this.#helperStep = `the helper pack stopped answering after /${name} (queries and debugger command output are gone): ${how} game_stop, then game_launch`;
    return `the helper pack did not come back after /${name}: the script debugger channel is gone`;
  }

  /** Wait until the game dialled a debugger session other than `old`. */
  async #newSession(old: DebuggerSession | undefined, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = this.#session;
      if (s && s !== old && !s.closed) return true;
      if (Date.now() >= deadline || !this.#listener) return false;
      await sleep(100);
    }
  }

  /**
   * PNG of the game: gamescope or Windows capture for a game sculkwire started; for a game it attached to (no host
   * route reaches the user's window), the in-game agent's screenshot.
   */
  async screenshot(path: string): Promise<{ path: string; bytes: number }> {
    this.#requireRunning();
    const state = this.launchState as LaunchState;
    if (!state.attached) return screenshot(state, path);
    const taken = await engine.screenshot(path);
    if (!taken.ok) throw new Error(`the in-game agent took no screenshot of the attached game (${taken.reason}): ${taken.message}`);
    return { path: taken.value.path, bytes: taken.value.bytes ?? (await stat(taken.value.path)).size };
  }

  /** Keyboard or mouse input into the game; returns the route it took. */
  async input(action: InputAction): Promise<InputRoute> {
    this.#requireRunning();
    return sendInput(this.launchState as LaunchState, action);
  }

  /** Close the debugger listener and the attached session (game_stop does this). */
  closeDebugger(): void {
    const listener = this.#listener;
    this.#listener = undefined;
    listener?.close();
    this.#session?.close();
    this.#session = undefined;
    this.#helperUp = false;
  }

  /**
   * Stop the game, close listeners, put back the options.txt keys and the game settings sculkwire changed. Safe to call
   * twice. Game settings are restored first, while the game still runs, so the agent can apply them live. In a user's
   * world the game is first told to Save & Quit (`#saveAndQuit`), and the project's development pack folders stay
   * because the world's pack lists name them.
   *
   * A game the bridge attached to (this process's `#startAttached`, or a launch state another process marked attached)
   * is never stopped and never Save & Quit: the settings set live are put back through the agent, the listeners close,
   * the deployed pack folders the open world's pack lists name stay, and the game keeps running.
   */
  async stop(): Promise<StopResult> {
    this.#startAbort?.abort();
    this.#startAbort = undefined;
    // First, while the agent still answers: a game the user keeps playing (a detach) must never be left locked, and
    // Save & Quit below may need the pause menu.
    await inputProvider()?.releaseSessionLock?.();
    this.#lockNote = undefined;
    this.#lockHeld = false;
    this.#userStep = undefined;
    const install = this.install ?? (await findInstall());
    const game = this.#attached;
    const attached = game !== undefined || (this.launchState === undefined && (await readLaunchState())?.attached === true);
    // The bridge's live channel keys are recorded with the user's settings: put back here, live while the agent answers.
    const restoredSettings = await restoreGameSettings({ install }).catch(() => ({}));
    const agentUsed = attached && engine.attached;
    const userWorld = !attached && this.world?.how === "user" ? this.world : undefined;
    const quit = userWorld && this.launchState && this.running ? await this.#saveAndQuit(this.launchState) : undefined;
    const muteWatcher = this.#muteWatcher;
    this.#muteWatcher = undefined;
    this.#muteNote = undefined;
    if (attached) {
      // The game the user opened keeps running and gets its sound back: its streams return to the sinks they came
      // from, so WirePlumber remembers the user's own target for Minecraft again.
      await muteWatcher?.stop({ restore: true });
      if (process.platform === "win32") {
        // Windows keeps an app's mute in its volume mixer: unmute the game the user opened before leaving it.
        const mutedPid = (this.launchState ?? (await readLaunchState()))?.mutedPid;
        if (mutedPid && isAlive(mutedPid)) await windowsMute([mutedPid], false, 0).catch(() => undefined);
      }
    }
    // Only a game sculkwire launched is stopped: this process's launch, or one a launch state file records whose game
    // (or spawned launcher) is still running. With neither (a process that never launched, an attach whose state is
    // gone, or a stale state left by a crash while the user started their own game since) the running game is the
    // user's: it is left alone and the stale state is dropped.
    const recorded = !attached && this.launchState === undefined ? await readLaunchState() : undefined;
    const running = recorded ? await gamePids(install) : [];
    const stillOurs = recorded !== undefined && ((recorded.gamePid !== undefined && running.includes(recorded.gamePid)) || (recorded.pid > 0 && isAlive(recorded.pid)));
    const launched = !attached && (this.launchState !== undefined || stillOurs);
    if (recorded && !stillOurs) await detachState();
    const result = attached
      ? { stopped: true, message: "detached from the game you opened; it keeps running" }
      : launched
        ? await stopGame(install)
        : { stopped: true, message: "sculkwire launched no game: a running game was left alone" };
    // A game sculkwire stopped stayed on the silent sink (the watcher kept sweeping) until it exited: no sound during
    // the stop. Its streams are not moved back, and the silent sink goes once the game is gone.
    if (!attached) await muteWatcher?.stop({ restore: false });
    await inputProvider()?.stopped();
    this.closeDebugger();
    await this.#connect?.stop();
    this.#connect = undefined;
    const restoredOptions = await restoreOptions();
    if (attached) await detachState();
    this.#attached = undefined;
    const packs = this.#packs;
    this.launchState = undefined;
    this.#ready = false;
    this.#helperUp = false;
    this.#helperStep = undefined;
    this.#packs = [];
    this.#indexed = [];
    this.#streamEvery = undefined;
    this.#joinCursor = undefined;
    this.#joinState = NO_JOIN_YET;
    this.#screens = NO_SCREENS;
    this.#frame = undefined;
    if (this.#controller) {
      await this.#controller.releaseAll().catch(() => undefined);
      this.#controller.world.input.close?.();
    }
    this.#controller = undefined;
    this.#latestState = undefined;
    const notes: string[] = [];
    if (quit?.saved) notes.push(`${userWorld?.name} was saved with Save & Quit before the stop`);
    else if (quit) notes.push(`Save & Quit did not work (${quit.detail}), so the game was stopped in ${userWorld?.name}: changes from about the last minute may be lost`);
    const deployed = this.#deployed.splice(0);
    let kept: string[] = [];
    if (userWorld) {
      kept = deployed;
      if (deployed.length) notes.push(`kept the development pack folders ${userWorld.name} names in its pack lists: ${deployed.join(", ")}`);
    } else if (attached) {
      // The open world may use them: keep the folders its pack lists name (all of them when the world is unknown).
      const listed = game?.levelId ? await worldPackIds(join(install.userComMojang, "minecraftWorlds", game.levelId)) : undefined;
      const ids = listed ? new Set([...listed].map((id) => id.toLowerCase())) : undefined;
      kept = ids ? deployed.filter((dir) => packs.some((p) => p.path === dir && ids.has(p.uuid.toLowerCase()))) : deployed;
      for (const dir of deployed) if (!kept.includes(dir)) await rm(dir, { recursive: true, force: true });
      if (kept.length) notes.push(`kept the development pack folders the open world uses: ${kept.join(", ")}`);
      if (agentUsed) notes.push("the in-game agent stays loaded in the game (engine_attach reconnects to it)");
    } else {
      for (const dir of deployed) await rm(dir, { recursive: true, force: true });
    }
    return {
      ...result,
      restoredOptions,
      restoredSettings,
      ...(quit ? { savedAndQuit: quit.saved } : {}),
      ...(kept.length ? { keptPackFolders: kept } : {}),
      ...(notes.length ? { stopNote: notes.join("; ") } : {}),
      ...(attached ? { detached: true } : {}),
    };
  }
}

/** The process-wide bridge used by the MCP tools. */
export const bridge = new ClientBridge();
