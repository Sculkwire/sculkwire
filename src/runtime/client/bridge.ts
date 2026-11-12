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
 */
import { errorMessage } from "../../core/errors.ts";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Diagnostic } from "../../core/diagnostic.ts";
import { compareDiagnostics } from "../../core/diagnostic.ts";
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
  DEFAULT_FRAME,
  defaultMode,
  hasInput,
  isAlive,
  launch,
  muteWindowsGame,
  playerInput,
  readLaunchState,
  screenshot,
  sendInput,
  stop as stopGame,
  typeChatCommand,
  waitForGame,
  type InputAction,
  type LaunchMode,
  type LaunchState,
} from "./launcher.ts";
import { bridgeOptions, restoreOptions, setOptions } from "../../gamefiles/options.ts";
import { engine, type SettingValue } from "../engine/engine.ts";
import type { EngineResult } from "../engine/failure.ts";
import { restoreGameSettings } from "../engine/settings.ts";
import { Staleness, streamEntities, streamEntity, TickClock, type StreamedEntities } from "./entitystream.ts";
import { horizontalDistance } from "./geometry.ts";
import { PlayerController } from "./player.ts";
import type { EntityInfo, Impact, Loadout, PlayerState, PlayerWorld } from "./types.ts";
import { inputProvider } from "./inputprovider.ts";
import { HELPER_MARK, isReplyTo, parseReply, queryCommand } from "./helperprotocol.ts";
import { pngSize, readShot } from "./png.ts";
import { unavailableInput, type InputRoute, type PlayerInput } from "./input.ts";
import { createWorld, writeWorldIcon, type CreatedWorld, type PackRef } from "./world.ts";
import type { Difficulty } from "../../gamefiles/worlds.ts";
import {
  currentScreen,
  NO_SCREENS,
  recoverJoin,
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
/** How long the game sits on the start or Play screen, no world opening, before the bridge walks into the world itself. */
const AUTO_ENTER_IDLE_MS = 6_000;
/** At most one walk into the world per this long, and this many in all: an input the user makes is not fought. */
const AUTO_ENTER_EVERY_MS = 20_000;
const AUTO_ENTER_ATTEMPTS = 3;
/** One walk's limit. */
const AUTO_ENTER_TIMEOUT_MS = 90_000;
/** On an install the user starts, attach the in-game agent once the start screen shows, or this long after the process came up. */
const AUTO_ATTACH_AFTER_MS = 30_000;

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
   * Add-on project or pack directory whose packs are activated in the test world (and mapped in diagnostics). A
   * Regolith project whose profile runs filters is built with rgl and its built packs are deployed.
   */
  project?: string;
  /**
   * Copy the project's packs into development_*_packs (default true), also over the project's `sculkwire_*` folder an
   * earlier launch left. Off: a pack is only used when a folder already serves its uuid. An rgl export of an unbuilt
   * pack is reused; a fresh Regolith build is always deployed.
   */
  deploy?: boolean;
  /**
   * `window` (Linux: a visible gamescope window you can watch; Windows: the game's own window), `headless` (Linux: no
   * window, muted; Windows falls back to the window) or `desktop` (the launcher's normal window; the same as `window`
   * on Windows). Default: window on Windows; elsewhere window when gamescope and a desktop are available, else desktop.
   */
  mode?: LaunchMode;
  /** Silence the game's audio (Linux and Windows). Default: on in headless mode only. */
  mute?: boolean;
  world?: string;
  /** Turn on the Beta APIs experiment in the test world. */
  betaApis?: boolean;
  /** The test world's difficulty (default normal). */
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

/** `count` clicks one after another, 120 ms apart: `count: 2` is a double click. */
async function clicks(count: number, click: () => Promise<void>): Promise<void> {
  for (let i = 0; i < count; i++) {
    await click();
    if (i + 1 < count) await sleep(120);
  }
}

/** Whether this process's launch state file still exists: `stop`, from here or another process, removes it. */
async function launchStateExists(): Promise<boolean> {
  return (await readLaunchState()) !== undefined;
}

/**
 * The in-game agent's UI calls (`engine.ui*`) as the recovery's `UiRecovery`, or undefined while no agent is attached
 * (then the recovery reads the log and uses the keys).
 */
function agentUi(): UiRecovery | undefined {
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
    click: (x, y, count = 1) => clicks(count, async () => void value(await engine.uiClick(x, y))),
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
  /** Owned by the newest `start`, aborted by `stop`: ends that start's waits for the game and the world, background ones included. */
  #startAbort?: AbortController;

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
    const s: BridgeStatus = {
      running: this.running,
      packs: this.#packs.map((p) => ({ ...p })),
      debugger: { attached: !!this.#session && !this.#session.closed },
      connect: connect.status,
      ready: this.#ready && this.#helperUp && !!this.#session && !this.#session.closed && !exited,
      manualSteps: exited
        ? [`the game process (pid ${this.launchState?.gamePid}) exited: call game_stop to clean up, then game_launch`]
        : [...this.#manual, ...(this.#helperStep ? [this.#helperStep] : []), ...connect.steps],
      ...(this.#deployDiagnostics.length ? { deployDiagnostics: [...this.#deployDiagnostics] } : {}),
    };
    if (exited) s.gameExited = true;
    if (this.launchState) s.mode = this.launchState.mode;
    if (this.install?.version) s.version = this.install.version;
    if (this.install) s.install = this.install.label;
    if (this.world) s.world = this.world.name;
    if (this.project) s.project = this.project;
    if (this.#listener) s.debugger.port = this.#listener.port;
    if (this.#session?.info) {
      s.debugger.protocolVersion = this.#session.info.version;
      s.debugger.plugins = this.#session.info.plugins.map((p) => p.name);
    }
    const port = this.#connect?.port;
    if (port) s.connect.port = port;
    if (this.#joinRecovery) s.joinRecovery = this.#joinRecovery;
    return s;
  }

  async start(opts: BridgeStartOptions = {}): Promise<BridgeStatus> {
    if (this.launchState) {
      if (this.running) throw new Error("the client bridge is already running; game_stop first");
      // The game exited (crash) without game_stop: clean that launch up (listeners, options, deployed packs) first.
      await this.stop();
    }
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

    const debuggerPort = await this.listenDebugger(opts.debuggerPort ?? BRIDGE_DEBUGGER_PORT);
    this.#connect = new ConnectServer({ port: opts.connectPort ?? DEFAULT_CONNECT_PORT });
    await this.#connect.start();
    await setOptions(optionsFiles(install), bridgeOptions(debuggerPort));

    this.world = await createWorld(install, {
      name: opts.world ?? "bridge",
      packs: packRefs,
      ...(opts.betaApis ? { experiments: ["gametest"] } : {}),
      ...(opts.difficulty ? { difficulty: opts.difficulty } : {}),
      ...(install.version ? { gameVersion: install.version } : {}),
    });
    this.#logCursor = await contentEnd(install.logsDir);
    this.#printCursor = this.#printSeq;
    this.#joinCursor = await debugLogEnd(install.logsDir);
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
      await this.#finishStart(timeoutMs, since, signal);
    } catch (e) {
      if (opts.keepOnTimeout && e instanceof WaitTimeout && this.running) {
        // Enter the world by hand (a launch command that cannot open it, a slow sign-in): keep the game and keep waiting.
        this.#manual.push(
          `${WORLD_NOT_LOADED} (${errorMessage(e)}): the game keeps running. In the game choose Play, then "${this.world.name}" on the Worlds tab ` +
            `(start Minecraft first if it is not up). game_status turns ready once the world is in; sculkwire keeps waiting up to ${BACKGROUND_WAIT_MS / 60_000} min`,
        );
        this.#finishStart(BACKGROUND_WAIT_MS, since, signal).catch(waitFailed);
        return this.status();
      }
      await this.stop();
      throw new Error(`client did not reach the world: ${errorMessage(e)}`);
    }
    return this.status();
  }

  /**
   * Wait for the game process, then for the world (each up to `timeoutMs`), counting helper prints after `since`.
   * Rejects once `signal` aborts.
   */
  async #finishStart(timeoutMs: number, since: number, signal: AbortSignal): Promise<void> {
    let gamePid: number;
    try {
      gamePid = await waitForGame(this.install as ClientInstall, timeoutMs, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      throw new WaitTimeout(errorMessage(e));
    }
    if (this.launchState) this.launchState.gamePid = gamePid;
    const atFirstLook = await this.#waitForWorld(timeoutMs, since, signal);
    // Windows mutes the game's audio sessions, which exist once it plays sound: by now it surely opened its device.
    if (this.launchState?.muteRequested) {
      const note = await muteWindowsGame(this.launchState, gamePid);
      if (note) this.#manual.push(note);
    }
    this.#ready = true;
    const by: WorldEntry["by"] = this.#walks.walked ? "auto-enter" : atFirstLook ? "already-open" : this.install?.launch ? "launch" : "manual";
    this.#entry = { by, seconds: Math.round((Date.now() - this.#startedAt) / 100) / 10, ...(this.#walks.walked ? { clicks: this.#walks.clicks } : {}) };
    this.#manual = this.#manual.filter((m) => !m.startsWith(START_YOURSELF) && !m.startsWith(WORLD_NOT_LOADED) && !m.startsWith(OPEN_YOURSELF));
    await this.#attachConnect();
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
  async #waitForWorld(timeoutMs: number, since: number, signal: AbortSignal): Promise<boolean> {
    const printed = (mark: string) => this.#prints.some((p) => p.seq > since && p.message.includes(mark));
    let deadline = Date.now() + timeoutMs;
    const auto: AutoEnter = { since: Date.now(), attachTried: false, attempts: 0, lastAt: 0 };
    for (let first = true; ; first = false) {
      signal.throwIfAborted();
      if (printed(HELPER_MARK.ready) && printed(HELPER_MARK.spawned)) return first;
      await this.#readJoinLog();
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
        const result = await this.#walkIn();
        if (!result.recovered) throw new Error(this.#joinFailureMessage(result));
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
      this.#manual.push(`${OPEN_YOURSELF}: sculkwire could not attach its in-game agent (${errorMessage(e)}). In the game choose Play, then "${name}"`);
    }
  }

  /**
   * Walk into the world when the game sits on the start or Play screen with no world opening for `AUTO_ENTER_IDLE_MS`,
   * through the in-game agent (attached here on an install the user starts; on one sculkwire starts only when it is
   * already attached). At most one walk per `AUTO_ENTER_EVERY_MS` and `AUTO_ENTER_ATTEMPTS` in all, so a user who
   * opens a menu meanwhile is not fought. True when a walk got into the world.
   */
  async #autoEnter(auto: AutoEnter): Promise<boolean> {
    const world = this.world;
    if (!world || !this.launchState || auto.attempts >= AUTO_ENTER_ATTEMPTS) return false;
    const menu = (kind: string) => kind === "start" || kind === "play";
    if (!engine.attached) {
      if (this.install?.launch || auto.attachTried) return false;
      if (!menu(currentScreen(this.#screens)) && Date.now() - auto.since < AUTO_ATTACH_AFTER_MS) return false;
      await this.#attachForEntry(auto);
      if (!engine.attached) return false;
    }
    const screen = await agentUi()?.screen().catch(() => undefined);
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
      this.#manual.push(`${OPEN_YOURSELF}: sculkwire tried ${auto.attempts} times and could not (${why}). In the game choose Play, then "${world.name}"`);
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

  /**
   * Walk the game from whatever screen it shows back into the test world (`recoverJoin` in screens.ts): Back to menu
   * on the error screen, Escape out of the Marketplace or any other screen, Play on the start screen, the tile showing
   * the test world's icon on the Play screen, waiting out loading screens, for up to `timeoutMs`. Host input and
   * screenshots where they reach the game, the in-game agent's UI calls and screenshots otherwise. The world's icon is
   * written again first: the game replaces it with a picture of the world when it saves and quits it.
   */
  async #returnToWorld(timeoutMs = 180_000): Promise<RecoveryResult> {
    const state = this.launchState;
    const world = this.world;
    if (!state || !world) throw new Error("the game is not running");
    if (!this.#canWalkMenus()) throw new Error(this.#joinNoInputMessage());
    this.#joinRecovery = { attempts: 0, recovered: false, ...(this.#joinState.lines.length ? { log: this.#joinState.lines.join("\n") } : {}) };
    // The game replaces the icon with its own picture when it saves and quits the world: write it again, but only while
    // the game does not have the world open (it would write over it on the next Save & Quit anyway).
    if (!(this.#screens.inWorld && this.#screens.opened === world.levelId)) await writeWorldIcon(world);
    const shots = dataDir("client", "screenshots");
    const host = hasInput(state);
    const io: RecoveryIO = {
      readLog: () => this.#readJoinLog(),
      key: async (keys) => {
        if (!host) throw new Error("no host keyboard reaches this game; keys go through the in-game agent");
        await sendInput(state, { action: "key", keys });
      },
      ...(host
        ? {
            click: (x: number, y: number, count = 1) => {
              const frame = this.#frame ?? { width: state.width ?? DEFAULT_FRAME.width, height: state.height ?? DEFAULT_FRAME.height };
              return clicks(count, async () => void (await sendInput(state, { action: "click", x: Math.round(frame.width * x), y: Math.round(frame.height * y) })));
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
    const result = await recoverJoin(io, {
      levelId: world.levelId,
      timeoutMs,
      screens: this.#screens,
      join: this.#joinState,
    });
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
   * Get a `/connect` client. First wait briefly in case the game dialled in by itself; otherwise, where input reaches
   * the game, wait until the player has spawned (keys sent during the loading screen land as debug keybinds) and type
   * `/connect` (gamescope's display on Linux, SendInput on Windows). Elsewhere the user types it.
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
    const useConnect = via === "connect" || (via === "auto" && connect !== undefined && connect.clients().length > 0);
    if (useConnect) {
      if (!connect || connect.clients().length === 0) throw new Error("no /connect client attached");
      const r: CommandResult = await connect.command(command);
      return { command, via: "connect", ok: r.ok, output: r.statusMessage ? [r.statusMessage] : [], statusCode: r.statusCode, body: r.body };
    }
    const session = this.#session;
    if (!session || session.closed) throw new Error("script debugger not attached");
    // The helper's traffic (a `play` run sends queries four times a second, its state stream) is not the command's output.
    const prints = await session.runCommand(command, { ignore: helperTraffic });
    const output = prints.map((p) => p.message.trim());
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

  /**
   * Ask the helper pack (`/scriptevent sculkwire:query`) and wait for its reply print.
   */
  async query(kind: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<unknown> {
    this.#requireRunning();
    const session = this.#session;
    if (!session || session.closed) throw new Error("queries need the script debugger (helper replies are prints)");
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

  /** Content-log diagnostics and script errors since the last call (or since `cursor`). */
  async logs(cursor?: { log?: LogPosition; printSeq?: number }): Promise<LogResult> {
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
    if (end) this.#logCursor = end;
    this.#printCursor = this.#printSeq;
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
   * Redeploy the project (rgl build for Regolith projects with filters, else a fresh copy of each pack sculkwire
   * deployed), then `/reload` (scripts + functions) or `/reload all` (documented as a rejoin with all packs; the retail
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

  async screenshot(path: string): Promise<{ path: string; bytes: number }> {
    this.#requireRunning();
    return screenshot(this.launchState as LaunchState, path);
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
   * twice. Game settings are restored first, while the game still runs, so the agent can apply them live.
   */
  async stop(): Promise<{
    stopped: boolean;
    message: string;
    restoredOptions: Record<string, string[]>;
    restoredSettings: Record<string, SettingValue | null>;
  }> {
    this.#startAbort?.abort();
    this.#startAbort = undefined;
    const install = this.install ?? (await findInstall());
    const restoredSettings = await restoreGameSettings({ install }).catch(() => ({}));
    const result = await stopGame(install);
    await inputProvider()?.stopped();
    this.closeDebugger();
    await this.#connect?.stop();
    this.#connect = undefined;
    const restoredOptions = await restoreOptions();
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
    for (const dir of this.#deployed.splice(0)) await rm(dir, { recursive: true, force: true });
    return { ...result, restoredOptions, restoredSettings };
  }
}

/** The process-wide bridge used by the MCP tools. */
export const bridge = new ClientBridge();
