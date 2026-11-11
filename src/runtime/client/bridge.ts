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
 * screen; `#finishStart` sees that in the engine log and `returnToWorld` walks the menus back into the test world
 * (screens.ts), never relaunching the game.
 */
import { rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Diagnostic } from "../../core/diagnostic.ts";
import { compareDiagnostics } from "../../core/diagnostic.ts";
import { dataDir } from "../../core/paths.ts";
import { discoverProject } from "../../core/project.ts";
import { buildRegolith, regolithExportFolders, regolithPlan } from "../../validate/regolith.ts";
import type { IndexedPack } from "../bds/logparse.ts";
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
import { applyPackDeploy, listDevPacks, packDisplayName, planPackDeploy, readManifestHeader, type PackToDeploy } from "./deploy.ts";
import { findInstall, optionsFiles, type ClientInstall } from "./install.ts";
import {
  defaultMode,
  hasInput,
  isAlive,
  launch,
  muteWindowsGame,
  playerInput,
  type PlayerInput,
  readLaunchState,
  screenshot,
  sendInput,
  stop as stopGame,
  typeChatCommand,
  unavailableInput,
  waitForGame,
  type InputAction,
  type InputRoute,
  type LaunchMode,
  type LaunchState,
} from "./launcher.ts";
import { bridgeOptions, restoreOptions, setOptions } from "./options.ts";
import type { SettingValue } from "../engine/engine.ts";
import { restoreGameSettings } from "../engine/settings.ts";
import { Staleness, streamEntities, streamEntity, TickClock, type StreamedEntities } from "./entitystream.ts";
import { horizontalDistance, PlayerController, type EntityInfo, type Impact, type Loadout, type PlayerState, type PlayerWorld } from "./player.ts";
import { inputProvider } from "./inputprovider.ts";
import { createWorld, type CreatedWorld, type Difficulty, type PackRef } from "./world.ts";
import { currentScreen, NO_SCREENS, pngSize, readShot, recoverJoin, screensInLog, type RecoveryIO, type RecoveryResult, type ScreenState } from "./screens.ts";
import { loadDecisionModel } from "../../decision/config.ts";

export const DEFAULT_DEBUGGER_PORT = 19151;
const READY_MARK = "[sculkwire:ready]";
/** A provider motion sample older than this no longer overrides the helper's state (a missed tick is 50 ms). */
const MOTION_FRESH_MS = 250;
/** The helper's fields (crosshair target, held item, game tick) ride along with provider motion while this fresh. */
const HELPER_FOR_MOTION_MS = 1000;
/** Helper print on the player's first spawn: the loading screen is gone and keys reach the game. */
const SPAWN_MARK = "[sculkwire:spawned]";
const REPLY_MARK = "[sculkwire:reply] ";
const STATE_MARK = "[sculkwire:state] ";

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
      note = `/connect data:${kind} failed: ${err instanceof Error ? err.message : String(err)}`;
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
    throw new Error(`${note}, and the helper pack's registry query failed: ${err instanceof Error ? err.message : String(err)}`);
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
   * Copy packs that are not deployed yet into development_*_packs (default true). rgl-deployed packs are reused, except
   * that a fresh Regolith build is always deployed.
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
  timeoutMs?: number;
}

export interface DeployedPack {
  name?: string;
  uuid: string;
  kind: string;
  /** Folder under `development_<kind>_packs`; absent when the pack is not deployed. */
  folder?: string;
  /** Absolute deployed pack dir; absent when the pack is not deployed. */
  path?: string;
  /** True when the deployed copy is the Regolith build output. */
  built: boolean;
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

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  /** The screen stack as the engine log tells it, read along with the join state. */
  #screens: ScreenState = NO_SCREENS;
  /** The game frame's size from the newest screenshot: clicks are fractions of it. */
  #frame?: { width: number; height: number };

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
      ready: this.#ready && !exited,
      manualSteps: exited
        ? [`the game process (pid ${this.launchState?.gamePid}) exited: call game_stop to clean up, then game_launch`]
        : [...this.#manual, ...connect.steps],
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
    // A new game starts with no provider state: drop what the provider remembered of an earlier one.
    await inputProvider()?.stopped();
    const install = await findInstall();
    this.install = install;
    const mode = opts.mode ?? (await defaultMode(install));
    const timeoutMs = opts.timeoutMs ?? 180_000;
    this.#manual = [];
    this.#packs = [];
    this.#deployDiagnostics = [];
    this.#ready = false;
    this.#connectMethod = undefined;
    this.#connectStep = undefined;
    this.#screens = NO_SCREENS;
    this.#frame = undefined;
    this.#joinRecovery = undefined;
    this.#joinState = NO_JOIN_YET;

    let packRefs: PackRef[] = [];
    if (opts.project) {
      const project = resolve(opts.project);
      this.project = project;
      this.#deployOption = opts.deploy !== false;
      const deployment = await this.#deployProject(install, project, this.#deployOption, new Set());
      this.#packs = deployment.packs;
      this.#deployed.push(...deployment.owned);
      this.#deployDiagnostics = deployment.diagnostics;
      packRefs = deployment.refs;
      this.#indexed = await indexProjectPacks(project, install.sharedComMojang);
    }

    const debuggerPort = opts.debuggerPort ?? DEFAULT_DEBUGGER_PORT;
    this.#listener = await listen(debuggerPort);
    this.#acceptLoop(this.#listener);
    this.#connect = new ConnectServer({ port: opts.connectPort ?? DEFAULT_CONNECT_PORT });
    await this.#connect.start();
    await setOptions(optionsFiles(install), bridgeOptions(this.#listener.port));

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
    this.#manual.push(...this.launchState.notes);
    await inputProvider()?.launched({ mode: this.launchState.mode, pid: this.launchState.pid });
    if (!install.launch) {
      // The user starts the game: return now so the agent can relay the steps; game_status shows when it is ready.
      this.#finishStart(30 * 60_000).catch((e: unknown) => this.#manual.push(`client did not reach the world: ${errorMessage(e)}`));
      return this.status();
    }
    try {
      await this.#finishStart(timeoutMs);
    } catch (e) {
      await this.stop();
      throw new Error(`client did not reach the world: ${errorMessage(e)}`);
    }
    return this.status();
  }

  async #finishStart(timeoutMs: number): Promise<void> {
    const gamePid = await waitForGame(this.install as ClientInstall, timeoutMs);
    if (this.launchState) this.launchState.gamePid = gamePid;
    await this.#waitForWorld(timeoutMs);
    // Windows mutes the game's audio sessions, which exist once it plays sound: by now it surely opened its device.
    if (this.launchState?.muteRequested) {
      const note = await muteWindowsGame(this.launchState, gamePid);
      if (note) this.#manual.push(note);
    }
    this.#ready = true;
    this.#manual = this.#manual.filter((m) => !m.startsWith("start Minecraft yourself"));
    await this.#attachConnect();
  }

  /**
   * Wait until the helper printed ready and the player spawned, recovering the deeplink/sign-in race on the way. When
   * the world join beats Microsoft sign-in, either the client rejects its LoginPacket, disconnects and waits on its
   * connection-error screen ("An error has occurred. You need to authenticate to Microsoft services."), or sign-in
   * finishes while the world loads and the game closes the world and shows the start screen. `returnToWorld` then
   * walks the menus back into the test world. The game is never relaunched for this.
   */
  async #waitForWorld(timeoutMs: number): Promise<void> {
    const since = this.#printSeq;
    const printed = (mark: string) => this.#prints.some((p) => p.seq > since && p.message.includes(mark));
    let deadline = Date.now() + timeoutMs;
    for (;;) {
      if (printed(READY_MARK) && printed(SPAWN_MARK)) return;
      await this.#readJoinLog();
      if (this.#joinState.failed) {
        if (!(this.launchState && hasInput(this.launchState))) {
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
            await sleep(2000);
            continue;
          }
          throw new Error(this.#joinNoInputMessage());
        }
        const result = await this.returnToWorld();
        if (!result.recovered) throw new Error(this.#joinFailureMessage(result));
        // The world loads again from the start: give the rejoin its own window, then wait for ready and spawn.
        deadline = Date.now() + timeoutMs;
        continue;
      }
      if (Date.now() > deadline) {
        // Scripts loaded but the spawn print never came: commands that do not target the player still work.
        if (printed(READY_MARK)) return;
        throw new Error(`timed out after ${timeoutMs} ms waiting for the game`);
      }
      if (this.launchState && !(await readLaunchState())) throw new Error("the game stopped");
      await sleep(500);
    }
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
   * on the error screen, Escape out of the Marketplace or any other screen, Play on the start screen, the test world's
   * tile on the Play screen, waiting out loading screens, for up to `timeoutMs`. A configured decision model with
   * image support is asked only when the fixed presses for a screen did not move the game on.
   */
  async returnToWorld(timeoutMs = 180_000): Promise<RecoveryResult> {
    const state = this.launchState;
    const world = this.world;
    if (!state || !world) throw new Error("the game is not running");
    if (!hasInput(state)) throw new Error(this.#joinNoInputMessage());
    this.#joinRecovery = { attempts: 0, recovered: false, ...(this.#joinState.lines.length ? { log: this.#joinState.lines.join("\n") } : {}) };
    const advisor = await loadDecisionModel().catch(() => undefined);
    const shots = dataDir("client", "screenshots");
    const io: RecoveryIO = {
      readLog: () => this.#readJoinLog(),
      key: async (keys) => {
        await sendInput(state, { action: "key", keys });
      },
      click: async (x: number, y: number, count = 1) => {
        const frame = this.#frame ?? { width: state.width ?? 1280, height: state.height ?? 720 };
        for (let i = 0; i < count; i++) {
          await sendInput(state, { action: "click", x: Math.round(frame.width * x), y: Math.round(frame.height * y) });
          if (i + 1 < count) await sleep(120);
        }
      },
      screenshot: async (label) => {
        const shot = await readShot((await screenshot(state, `${shots}/${label}-${state.startedAt}-${Date.now()}.png`)).path);
        this.#frame = pngSize(shot.png) ?? this.#frame;
        return shot;
      },
      alive: async () => (await readLaunchState()) !== undefined,
      sleep: (ms) => sleep(ms),
      now: () => Date.now(),
    };
    const result = await recoverJoin(io, {
      levelId: world.levelId,
      worldName: world.name,
      timeoutMs,
      screens: this.#screens,
      join: this.#joinState,
      ...(advisor?.images ? { advisor } : {}),
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
    await this.waitForPrint((p) => p.message.includes(SPAWN_MARK), 60_000).catch(() => undefined);
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
        session.on("print", (p: PrintEvent) => {
          // Streamed player state arrives up to 20 times a second: keep only the latest, out of the print log.
          if (p.message.startsWith(STATE_MARK)) {
            try {
              const state = JSON.parse(p.message.slice(STATE_MARK.length)) as PlayerState & { entities?: Omit<StreamedEntities, "at" | "tick"> };
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
          if (p.message.includes(READY_MARK)) {
            this.#streamEvery = undefined;
            this.#latestState = undefined;
            this.#latestEntities = undefined;
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
        if (!(await readLaunchState())) throw new Error("the game stopped");
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
    const since = this.#printSeq;
    session.command(command);
    const echo = await this.waitForPrint((p) => p.message.includes(`Executing command [${command}]`), 10_000, since);
    // Output follows the echo; stop after a quiet gap.
    let last = echo.seq;
    let quietUntil = Date.now() + 600;
    const deadline = Date.now() + 5_000;
    while (Date.now() < quietUntil && Date.now() < deadline) {
      await sleep(100);
      if (this.#printSeq > last) {
        last = this.#printSeq;
        quietUntil = Date.now() + 400;
      }
    }
    // `[sculkwire:…]` lines are the helper pack's own messages, not command output.
    const output = this.#prints.filter((p) => p.seq > echo.seq && p.seq <= last && !p.message.startsWith("[sculkwire:")).map((p) => p.message.trim());
    return { command, via: "debugger", ok: !output.some((o) => /^Syntax error|^Unknown command/i.test(o)), output };
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
      input = unavailableInput(err instanceof Error ? err.message : String(err));
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
  async query(kind: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.#requireRunning();
    const session = this.#session;
    if (!session || session.closed) throw new Error("queries need the script debugger (helper replies are prints)");
    const id = (this.#queryId = (this.#queryId + 1) % 1_000_000_000);
    const since = this.#printSeq;
    session.command(`scriptevent sculkwire:query ${JSON.stringify({ ...params, kind, id })}`);
    const print = await this.waitForPrint((p) => p.message.startsWith(REPLY_MARK) && p.message.includes(`"id":${id},`), 10_000, since);
    const reply: unknown = JSON.parse(print.message.slice(REPLY_MARK.length));
    if (!reply || typeof reply !== "object" || !("ok" in reply)) throw new Error(`malformed helper reply: ${print.message}`);
    if (reply.ok !== true) {
      const text = `helper: ${"error" in reply ? String(reply.error) : "failed"}`;
      throw new HelperQueryError(text, "reason" in reply && typeof reply.reason === "string" ? reply.reason : undefined);
    }
    return "result" in reply ? reply.result : undefined;
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
   */
  async reload(all = false): Promise<{ command: CommandOutput; diagnostics: Diagnostic[]; redeployed: string[] }> {
    this.#requireRunning();
    const redeployed: string[] = [];
    let deployDiagnostics: Diagnostic[] = [];
    if (this.project && this.install) {
      const own = new Set(this.#deployed.map((dir) => basename(dir)));
      const deployment = await this.#deployProject(this.install, this.project, this.#deployOption, own);
      this.#packs = deployment.packs;
      for (const dir of deployment.owned) if (!this.#deployed.includes(dir)) this.#deployed.push(dir);
      redeployed.push(...deployment.copied);
      deployDiagnostics = deployment.diagnostics;
      this.#deployDiagnostics = deployment.diagnostics;
      this.#indexed = await indexProjectPacks(this.project, this.install.sharedComMojang);
    }
    const before = { printSeq: this.#printSeq, ...(this.#logCursor ? { log: this.#logCursor } : {}) };
    const command = await this.command(all ? "reload all" : "reload");
    // Scripts restart (and the debugger re-attaches after `reload all`) before the helper prints ready again.
    await this.waitForPrint((p) => p.message.includes(READY_MARK), all ? 120_000 : 30_000, before.printSeq).catch(() => undefined);
    await sleep(1000);
    const { diagnostics } = await this.logs(before);
    return { command, diagnostics: [...deployDiagnostics, ...diagnostics], redeployed };
  }

  /**
   * Put the project's packs into `development_*_packs`: build with rgl when the Regolith profile runs filters (the
   * built packs are what the game loads), then copy per `planPackDeploy` and `applyPackDeploy`, which leave one
   * folder of this project per uuid and warn about foreign folders sharing it. `own` holds folder names this
   * session copied before, so a redeploy refreshes them. Throws with the rgl message when the build fails.
   */
  async #deployProject(
    install: ClientInstall,
    project: string,
    deploy: boolean,
    own: ReadonlySet<string>,
  ): Promise<{ packs: DeployedPack[]; refs: PackRef[]; copied: string[]; owned: string[]; diagnostics: Diagnostic[] }> {
    const layout = await discoverProject(project);
    const comMojang = install.sharedComMojang;
    const deployed = await listDevPacks(comMojang);
    const rglExports = layout.regolith ? await regolithExportFolders(project) : undefined;
    const builtHeaders = new Map<string, { dir: string; uuid: string; version: string; name?: string }>();
    const result: { packs: DeployedPack[]; refs: PackRef[]; copied: string[]; owned: string[]; diagnostics: Diagnostic[] } = {
      packs: [],
      refs: [],
      copied: [],
      owned: [],
      diagnostics: [],
    };
    let regolithProfile: string | undefined;
    let workDir: string | undefined;
    try {
      if (layout.regolith) {
        const regolith = await regolithPlan(project);
        if (regolith?.hasFilters) {
          regolithProfile = regolith.profile;
          const build = await buildRegolith(project, regolith.profile);
          if (!("outputs" in build)) throw new Error(`the Regolith build failed, so nothing was deployed. ${build.message}`);
          workDir = build.workDir;
          if (!build.outputs.length) throw new Error(`rgl run ${regolith.profile} built no pack with a manifest, so nothing was deployed`);
          for (const o of build.outputs) {
            const header = await readManifestHeader(o.built);
            if (!header) throw new Error(`rgl built ${o.built} without a header uuid/version, so nothing was deployed`);
            builtHeaders.set(resolve(o.source), { dir: o.built, ...header });
          }
        }
      }
      const relDirs = new Map(layout.packs.map((p) => [resolve(p.dir), p.relDir || "."]));
      const packs: PackToDeploy[] = [];
      for (const pack of layout.packs) {
        if (pack.kind !== "behavior" && pack.kind !== "resource") continue;
        const fresh = builtHeaders.get(resolve(pack.dir));
        const uuid = fresh?.uuid ?? pack.uuid;
        const version = fresh?.version ?? pack.version;
        if (!uuid || !version) throw new Error(`${pack.relDir || "."}/manifest.json has no header uuid/version`);
        const manifestName = fresh?.name ?? pack.name;
        // The built dir goes away after this deploy, so the lang lookup happens now (built text first, then source).
        const name = manifestName ? await packDisplayName(manifestName, [fresh?.dir, pack.dir]) : undefined;
        packs.push({ kind: pack.kind, dir: resolve(pack.dir), uuid, version, ...(fresh ? { built: fresh.dir } : {}), ...(name ? { name } : {}) });
      }
      if (regolithProfile) {
        const unbuilt = packs.filter((p) => !p.built).map((p) => relDirs.get(p.dir) ?? p.dir);
        if (unbuilt.length) {
          throw new Error(`rgl run ${regolithProfile} did not build ${unbuilt.join(", ")}, so nothing was deployed (deploying the source packs would leave out the filter output)`);
        }
      }
      const plan = planPackDeploy({ project, packs, comMojang, deploy, deployed, own, ...(rglExports ? { rglExports } : {}) });
      const applied = await applyPackDeploy(plan);
      result.copied = applied.copied;
      result.owned = applied.owned;
      result.diagnostics = applied.diagnostics;
      for (const entry of plan) {
        result.packs.push({
          ...(entry.name ? { name: entry.name } : {}),
          uuid: entry.uuid,
          kind: entry.kind,
          ...(entry.folder ? { folder: entry.folder } : {}),
          ...(entry.path ? { path: entry.path } : {}),
          built: entry.built,
        });
        result.refs.push({ uuid: entry.uuid, version: entry.version.split(".").map(Number), kind: entry.kind });
      }
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
    return result;
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
    const install = this.install ?? (await findInstall());
    const restoredSettings = await restoreGameSettings({ install }).catch(() => ({}));
    const result = await stopGame(install);
    await inputProvider()?.stopped();
    const listener = this.#listener;
    this.#listener = undefined;
    listener?.close();
    this.#session?.close();
    this.#session = undefined;
    await this.#connect?.stop();
    this.#connect = undefined;
    const restoredOptions = await restoreOptions();
    this.launchState = undefined;
    this.#ready = false;
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
