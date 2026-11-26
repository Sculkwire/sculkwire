/**
 * Which screen the game shows, followed from the engine log (`Debug_Log`), and the join recovery that walks the menus
 * back into the test world like a person would.
 *
 * The engine logs every JSON UI screen it creates and destroys (`Created 'start.start_screen' screen`, `Destroyed
 * 'store_data_driven_screen - MultiItemPage_StoreRoot' screen`). The Ore UI screens (the Play screen with the world
 * list, the connection-error screen) are never logged as created, only as `Destroyed 'ui://./hbui/index.html'`, so
 * they are recognised by what comes with them: `Pushing disconnect screen from GameConnectionUIUtils::_onDisconnect`
 * for the error screen and the world list's `world.cheatsEnabled:` lines for the Play screen.
 *
 * With the in-game agent attached the screen does not have to be inferred at all: `ui.screen` names the game's own
 * screens, `ui.controls` lists what is on them, and `ui.press`/`ui.key` land without the game window being in the
 * foreground. The log then still says which world the game opened, which press moved it on, and whether the client
 * joined.
 */
import { errorMessage } from "../../core/errors.ts";
import { isStoreScreen, type UiControl, type UiScreen } from "../engine/ui.ts";
import { CLIENT_JOINED, joinStateInLog, NO_JOIN_YET, type JoinState } from "./contentlog.ts";
import { findThumbnailTiles, thumbnailTemplate, type TileMatch } from "./thumbnail.ts";
import { DEFAULT_FRAME } from "./launcher.ts";
import { decodePng, pngSize, type Pixels } from "./png.ts";

export type ScreenKind =
  /** The title screen: Play, Settings, Marketplace. */
  | "start"
  /** The Play screen with the world list (Ore UI). */
  | "play"
  /** Marketplace and the other store screens (skins, character creator). */
  | "store"
  /** The connection-error screen ("An error has occurred", Back to menu / Show details / Learn more). */
  | "disconnect"
  /** World loading, saving and other progress screens. */
  | "loading"
  /** In a world (the HUD). */
  | "world"
  | "pause"
  | "chat"
  /**
   * The death screen ("You died!", the cause, RESPAWN over "Game menu"): vanilla `ui/death_screen.json`, namespace
   * `death`, screen `death_screen`, so the log creates `death.death_screen` and `ui.screen` names `death_screen`.
   */
  | "death"
  /** Any other screen. */
  | "other";

export interface Screen {
  kind: ScreenKind;
  /** The engine's screen name, e.g. `start_screen`, or `ore` for an Ore UI screen. */
  name: string;
}

export interface ScreenState {
  /** Bottom to top; the last entry is on screen. */
  stack: readonly Screen[];
  /** Bumped whenever the top of the stack changes. */
  changes: number;
  /** Level id of the world the game opened last (`Opening level '…/minecraftWorlds/<id>/db'`). */
  opened?: string;
  /** The client joined the world it opened last and has not left it since. */
  inWorld: boolean;
}

export const NO_SCREENS: ScreenState = { stack: [], changes: 0, inWorld: false };

const CREATED = /\] Created '([^'.]+)\.([^']+)' screen/;
const DESTROYED = /\] Destroyed '([^']+?)(?: - [^']*)?' screen/;
const DISCONNECT_PUSHED = /\] Pushing disconnect screen /;
/** The Play screen's world list reading each world's settings. */
const WORLD_LIST = /\] world\.cheatsEnabled: /;
const OPENING_LEVEL = /\] Opening level '.*[/\\]minecraftWorlds[/\\]([^/\\']+)[/\\]db'/;
const ORE_SCREEN = "ui://./hbui/index.html";
/** The Play screen asks Realms for its profiles when it opens and every 15 s while it is up. */
const PLAY_SCREEN_POLL = /\] fetching profiles \d+\s*$/;
const SCREEN_INPUT_PUSHED = /\] Controller \d+: Pushing input mapping: 'screen'/;
/** The first query every new Ore UI document registers. */
const ORE_DOCUMENT = /\] Registering query core\.commandState /;
/** Always-present overlays, never what the player looks at. */
const OVERLAYS = new Set(["debug_screen", "toast_screen", "hud_crosshair_screen"]);

/** A screen's kind from its name alone, as `ui.screen` reports it (`start_screen`, `play.play_screen`). */
export function kindOfScreenName(name: string): ScreenKind {
  // The namespace decides a store screen (`store_layout.…`, `csb.…`, `marketplace.…`), so match the whole name.
  if (isStoreScreen(name)) return "store";
  const bare = name.slice(name.lastIndexOf(".") + 1);
  if (bare.endsWith("_progress_screen") || bare === "loading_screen") return "loading";
  if (bare === "start_screen") return "start";
  if (bare === "play_screen") return "play";
  if (bare === "hud_screen") return "world";
  if (bare === "pause_screen") return "pause";
  if (bare === "chat_screen") return "chat";
  if (bare === "death_screen") return "death";
  if (bare.includes("disconnect")) return "disconnect";
  return "other";
}

function kindOf(namespace: string, name: string): ScreenKind {
  if (namespace === "progress") return "loading";
  // The log names a store screen's namespace; `ui.screen` names only the screen itself, which `kindOfScreenName` knows.
  if (namespace.startsWith("store")) return "store";
  return kindOfScreenName(name);
}

/** Follow the screen stack through `Debug_Log` text. Pass the state of earlier reads to follow a log read in chunks. */
export function screensInLog(text: string, state: ScreenState = NO_SCREENS): ScreenState {
  const stack = [...state.stack];
  let { opened, inWorld } = state;
  let changes = state.changes;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const before = stack.at(-1);
    let m: RegExpExecArray | null;
    if ((m = CREATED.exec(line))) {
      const [, namespace = "", name = ""] = m;
      if (OVERLAYS.has(name)) continue;
      const screen = { kind: kindOf(namespace, name), name };
      // The game tears the session down under its connection-error screen: what it builds then stays beneath it.
      if (before?.kind === "disconnect") stack.splice(stack.length - 1, 0, screen);
      else stack.push(screen);
    } else if ((m = DESTROYED.exec(line))) {
      const name = m[1] ?? "";
      if (name === ORE_SCREEN) {
        const at = stack.findLastIndex((s) => s.name === "ore");
        if (at >= 0) stack.splice(at, 1);
      } else {
        const at = stack.findLastIndex((s) => s.name === name);
        if (at >= 0) stack.splice(at, 1);
        if (name === "hud_screen") inWorld = false;
      }
    } else if (DISCONNECT_PUSHED.test(line)) {
      // Leaving the world resets the stack to the start screen, built under the error screen.
      stack.length = 0;
      stack.push({ kind: "disconnect", name: "ore" });
      inWorld = false;
    } else if (WORLD_LIST.test(line) || PLAY_SCREEN_POLL.test(line)) {
      if (before?.kind === "start") stack.push({ kind: "play", name: "ore" });
      else if (before?.name === "ore" && before.kind === "other") stack[stack.length - 1] = { kind: "play", name: "ore" };
    } else if (ORE_DOCUMENT.test(line)) {
      // A new Ore UI document over a menu (Settings from the pause or start screen): it is on top until it closes.
      if (before?.kind === "start" || before?.kind === "pause") stack.push({ kind: "other", name: "ore" });
    } else if (SCREEN_INPUT_PUSHED.test(line)) {
      // JSON UI screens log their creation before their input mapping, so a push on the start screen is an Ore UI
      // route over it (Play, Settings, Profile); the Play screen's own lines name it later.
      if (before?.kind === "start") stack.push({ kind: "other", name: "ore" });
    } else if ((m = OPENING_LEVEL.exec(line))) {
      opened = m[1];
      inWorld = false;
    } else if (CLIENT_JOINED.test(line)) {
      inWorld = true;
    }
    const after = stack.at(-1);
    if (after?.kind !== before?.kind || after?.name !== before?.name) changes++;
  }
  return { stack, changes, ...(opened !== undefined ? { opened } : {}), inWorld };
}

/** What the game shows, or `unknown` before the log said anything about screens. */
export function currentScreen(state: ScreenState): ScreenKind | "unknown" {
  return state.stack.at(-1)?.kind ?? "unknown";
}

/**
 * A screen's kind from the OreUI route `ui.screen` reports for an OreUI page (every one is named
 * `ui://./hbui/index.html`): a store route, the Play screen (`/play`, `/play/all`, `/play/worlds`), or undefined.
 */
export function kindOfRoute(route: string): ScreenKind | undefined {
  if (isStoreScreen(route)) return "store";
  if (/^\/play(?:[/?]|$)/.test(route)) return "play";
  return undefined;
}

/**
 * The Play screen's tab from its OreUI route (`/play/worlds`, `/play/all`, `/play?tab=realms`), lower case; `all` for
 * a bare `/play`; undefined when no route is known.
 */
export function playTab(route: string | null | undefined): string | undefined {
  if (!route) return undefined;
  const [path = "", query = ""] = route.split("?");
  return (new URLSearchParams(query).get("tab") ?? path.split("/").filter(Boolean)[1] ?? "all").toLowerCase();
}

/**
 * The stack the agent reports (`ui.screen`), which needs no inference from the log. `opened` stays what the log said,
 * because only the log says which world the game opened; a world screen anywhere in the stack means the client is in
 * a world, as it is under the pause menu. On an OreUI page the route names the screen.
 */
export function screensFromUi(screen: UiScreen, state: ScreenState): ScreenState {
  // The always-present overlays (the debug screen is created on every launch) are never what the player looks at.
  const names = screen.stack.filter((name) => !OVERLAYS.has(name.slice(name.lastIndexOf(".") + 1)));
  const stack: Screen[] = names.map((name) => ({ kind: kindOfScreenName(name), name }));
  if (!stack.length) stack.push({ kind: kindOfScreenName(screen.name), name: screen.name });
  const top = stack.at(-1) as Screen;
  if (screen.route && top.name === screen.name) top.kind = kindOfRoute(screen.route) ?? top.kind;
  const before = state.stack.at(-1);
  return {
    stack,
    changes: top.kind === before?.kind && top.name === before?.name ? state.changes : state.changes + 1,
    ...(state.opened !== undefined ? { opened: state.opened } : {}),
    inWorld: stack.some((entry) => entry.kind === "world"),
  };
}

/**
 * Where to press, as fractions of the game frame (the screenshot), measured on the 1280x668 frame of a 1280x720
 * gamescope window at GUI scale 2. The Ore UI screens keep these places at other 16:9 sizes.
 */
export const LAYOUT = {
  /** Connection-error screen: "Back to menu", the left one of three buttons under the message. */
  backToMenu: { x: 0.27, y: 0.72 },
  /** Start screen: "Play". */
  play: { x: 0.5, y: 0.499 },
  /**
   * Play screen, Worlds tab: 4 columns by 2 visible rows of tiles. Featured servers come first as "LAN world" tiles,
   * then the local worlds, most recently played first. `slot` is the tile's place in reading order. The recovery
   * opens a tile only by its thumbnail (thumbnail.ts), never by its slot.
   */
  worldTile: (slot: number) => ({ x: 0.137 + (slot % 4) * 0.2375, y: slot < 4 ? 0.374 : 0.74 }),
  /** Play screen: where the world list is scrolled, the middle of the tile grid (below the tab strip). */
  worldList: { x: 0.5, y: 0.6 },
  /** Pause screen: "Save & Quit". */
  saveAndQuit: { x: 0.293, y: 0.662 },
} as const;

/**
 * Which visible Play-screen tiles are local worlds, in reading order. A local world's name row ends in an edit
 * button, whose divider is a light line (about 90,91,92) on the darker row (72,73,74); a featured server's "LAN
 * world" tile has player counts there instead. Clicking a featured server would join a public server, so only tiles
 * with the divider are ever opened.
 */
export function localWorldTiles(image: Pixels): number[] {
  const out: number[] = [];
  const grey = (x: number, y: number) => {
    const at = (Math.round(y) * image.width + Math.round(x)) * image.channels;
    return ((image.data[at] ?? 0) + (image.data[at + 1] ?? 0) + (image.data[at + 2] ?? 0)) / 3;
  };
  for (let slot = 0; slot < 8; slot++) {
    const divider = (0.1992 + (slot % 4) * 0.2375) * image.width;
    const rowTop = (slot < 4 ? 0.509 : 0.874) * image.height;
    let hits = 0;
    for (let i = 0; i < 6; i++) {
      const y = rowTop + (i * 0.067 * image.height) / 6;
      if (y >= image.height) break;
      const line = grey(divider, y);
      if (line > grey(divider - 4, y) + 8 && line > grey(divider + 4, y) + 8) hits++;
    }
    if (hits >= 4) out.push(slot);
  }
  return out;
}

/**
 * Whether a matched tile may be opened: false only when its middle sits on a slot of `LAYOUT.worldTile` that
 * `localWorldTiles` does not list as a local world (a featured server). A tile the 4-column layout does not place
 * (another layout, a tile scrolled half out of view) is judged by its picture alone.
 */
function onLocalTile(image: Pixels, tile: TileMatch, locals: readonly number[]): boolean {
  const x = (tile.rect.x + tile.rect.width / 2) / image.width;
  const y = (tile.rect.y + tile.rect.height / 2) / image.height;
  for (let slot = 0; slot < 8; slot++) {
    const c = LAYOUT.worldTile(slot);
    if (Math.abs(c.x - x) < 0.03 && Math.abs(c.y - y) < 0.03) return locals.includes(slot);
  }
  return true;
}

/** The death screen's RESPAWN button green (about 42,100,28; lighter when hovered), never "Game menu"'s grey. */
function respawnGreen(image: Pixels, x: number, y: number): boolean {
  const at = (Math.round(y) * image.width + Math.round(x)) * image.channels;
  const r = image.data[at] ?? 0;
  const g = image.data[at + 1] ?? 0;
  const b = image.data[at + 2] ?? 0;
  return g >= 70 && g >= 1.8 * r && g >= 2.5 * b;
}

/**
 * Where RESPAWN is on a death screen screenshot, as fractions of the frame, or undefined when no such button shows.
 * Its place depends on the frame's size and the GUI scale (it sat at 66% of the height in one window and 72% in
 * another, where 73% was already "Game menu"), so it is found by its colour instead of clicked at a fixed spot: a
 * green band centred on the frame, below the death message, as wide as a button and as tall as one. Rows are sampled
 * left and right of the centre (in units of the height, which the GUI scales with) so the label's white letters do
 * not break the band.
 */
export function findRespawnButton(image: Pixels): { x: number; y: number } | undefined {
  const cx = image.width / 2;
  const h = image.height;
  const offsets = [0.1, 0.14, 0.18].flatMap((o) => [cx - o * h, cx + o * h]).filter((x) => x >= 0 && x < image.width);
  const isBand = (y: number) => offsets.filter((x) => respawnGreen(image, x, y)).length >= Math.min(4, offsets.length);
  let top = -1;
  for (let y = Math.floor(0.4 * h); y < Math.floor(0.97 * h); y++) {
    if (isBand(y)) {
      if (top < 0) top = y;
      continue;
    }
    if (top < 0) continue;
    const tall = y - top;
    const mid = top + Math.floor(tall / 2);
    top = -1;
    if (tall < 0.025 * h || tall > 0.12 * h) continue;
    let left = Math.round(cx - 0.1 * h);
    let right = Math.round(cx + 0.1 * h);
    while (left > 0 && respawnGreen(image, left - 1, mid + 2)) left--;
    while (right < image.width - 1 && respawnGreen(image, right + 1, mid + 2)) right++;
    if (right - left < 0.3 * h || Math.abs(left + right - 2 * cx) > 0.03 * image.width) continue;
    return { x: 0.5, y: mid / h };
  }
  return undefined;
}

/**
 * The agent's own UI driving (`ui.*`), which the recovery uses when the in-game agent is attached: the screen comes
 * from the game instead of the log, and presses and keys land without the game window being in the foreground.
 */
export interface UiRecovery {
  /** `ui.screen`: the screen the game shows, in the game's own names, and the stack under it. */
  screen(): Promise<UiScreen>;
  /** `ui.controls`: the visible controls of the current screen. */
  controls(): Promise<UiControl[]>;
  /** `ui.press`: press a control by the name `controls` gave it. */
  press(name: string): Promise<void>;
  /** `ui.key`: a key or chord through the game's own input path. */
  key(key: string): Promise<void>;
  /** `ui.click`: `count` clicks at client pixels, the same frame the screenshots show. */
  click(x: number, y: number, count?: number): Promise<void>;
  /** `ui.scroll`: `delta` wheel notches at client pixels, positive up. Without it the world list is never scrolled. */
  scroll?(x: number, y: number, delta: number): Promise<void>;
}

/** The game, as the recovery sees it. Tests replace it with a script. */
export interface RecoveryIO {
  /** Engine-log text written since the previous call. */
  readLog(): Promise<string>;
  /** Key presses (xdotool names), e.g. `Return`, `Escape`. */
  key(keys: string): Promise<void>;
  /** Click at a fraction of the frame; `count: 2` double-clicks. Absent when the caller has no mouse (keys only). */
  click?(x: number, y: number, count?: number): Promise<void>;
  /**
   * The agent's own UI while one is attached, asked before each step (an agent can attach during the recovery).
   * Without it the recovery reads the log and uses the keys. Its double clicks wait on `sleep`, the recovery's own.
   */
  ui?(sleep: (ms: number) => Promise<void>): UiRecovery | undefined;
  /** A screenshot of the game: its file and PNG bytes. */
  screenshot(label: string): Promise<{ path: string; png: Buffer } | undefined>;
  /** True once the caller knows the world is in (the helper pack answered in it): the recovery ends recovered. */
  inWorld?(): boolean;
  /** False once the game process is gone. */
  alive(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface RecoveryOptions {
  /** Level id (folder under minecraftWorlds) of the world to open. */
  levelId: string;
  /**
   * The world's own `world_icon.jpeg`, decoded: the picture its tile shows on the Play screen. Without it (no icon, a
   * picture sculkwire cannot read or too plain to tell apart) the recovery opens no tile and stops at the Play screen.
   */
  thumbnail?: Pixels;
  /** Give up after this long (default 3 minutes). */
  timeoutMs?: number;
  /** State of the reads before the recovery started. */
  screens?: ScreenState;
  join?: JoinState;
}

export interface RecoveryResult {
  recovered: boolean;
  /** What was pressed, in order, with the screen it was pressed on. */
  steps: string[];
  /** The first screenshot taken, kept as evidence. */
  screenshot?: string;
  screens: ScreenState;
  join: JoinState;
  /** Inputs sent: keys, presses, clicks and scrolls. */
  presses: number;
  /** Times the world list was scrolled looking for the tile. */
  scrolls: number;
  /** A tile was opened because its thumbnail showed the world's own picture. */
  foundByThumbnail: boolean;
  /** Level ids the game opened during the recovery, in order. */
  opened: string[];
  /** The screens seen during the recovery, in order: the game's name, and the OreUI route when the agent read one. */
  seen: string[];
  /** Why it stopped without the world. */
  reason?: string;
  /** It stopped on the Play screen because the world's tile cannot be told apart: only the user can open the world. */
  needsUser?: boolean;
  /**
   * It stopped after clicking the world's tile because nothing opened: `dialog` when the Play screen stayed up and the
   * tile was covered afterwards (a dialog over the screen, such as the World update that makes an old world higher and
   * deeper, which only the user may confirm), `ignored` when the tile stayed in view and the screen did not change.
   * Nothing more is clicked; `needsUser` is set.
   */
  stuck?: "dialog" | "ignored";
}

/** How long a screen must stay unchanged before acting on it: the game may still move on by itself. */
const SETTLE_MS: Record<ScreenKind, number> = {
  disconnect: 1500,
  // After "Back to menu" the game often re-opens the world by itself within ~3 s.
  start: 4000,
  play: 2500,
  store: 1000,
  other: 1000,
  // A click in the first ~3 s after the pause menu opens lands on Resume Game (measured live).
  pause: 4000,
  chat: 1000,
  // The death screen greys RESPAWN out for a moment after it opens.
  death: 1000,
  loading: 0,
  world: 2000,
};
/** After a press, how long to wait for the screen to change before the next way of pressing is tried. */
const PATIENCE_MS = 4000;
/** A world tile press starts a world-loading screen within this time. */
const OPEN_PATIENCE_MS = 8000;
/** Looks at a Play screen without the tile before scrolling: the thumbnails load after the list. */
const THUMBNAIL_LOOKS = 2;
/** Scrolls of one Play screen's list before giving up on it, the wheel notches of each, and the wait after one. */
const MAX_SCROLLS = 3;
const SCROLL_NOTCHES = 5;
const LOOK_PATIENCE_MS = 1500;
/**
 * After a tile click, how long the agent's UI may stay silent (the world loading) before it counts as down.
 */
const LOADING_PATIENCE_MS = 120_000;
/**
 * A tile matched only by its visible half (the rest cut off by the list's edge or under the tab strip) is scrolled into
 * view at most this many times by these notches; then its visible half is opened.
 */
const MAX_NUDGES = 2;
const NUDGE_NOTCHES = 2;
/** Worlds other than the wanted one that may open (through a tile that showed its picture) before the recovery stops. */
const MAX_WRONG_WORLDS = 2;
/**
 * Double-clicks on the world's tile with no change of the screen after them before the recovery stops: a world that
 * opens shows its loading screen within `OPEN_PATIENCE_MS` of the first one.
 */
const MAX_TILE_CLICKS = 2;
/**
 * Arrow keys sent to walk the Play screen's keyboard focus onto the world's tile when its clicks were ignored (a game in
 * the background reads its mouse too seldom to take a click, but takes keys), and activations of the tile once the focus
 * ring is seen on it. Space activates an OreUI button; nothing is activated unless the ring is on the tile's open button.
 */
const MAX_FOCUS_KEYS = 12;
const MAX_FOCUS_ACTIVATIONS = 2;
const FOCUS_PATIENCE_MS = 2000;

type Box = { x: number; y: number; width: number; height: number };

/**
 * The keyboard focus ring on an OreUI screen: a white frame two or three pixels wide around the focused control, found as
 * two long white rows (top and bottom edge) of the same horizontal extent joined by a white column. The top bar (light,
 * never focused here) is left out. Undefined when no ring shows.
 */
export function focusRing(image: Pixels): Box | undefined {
  const { width, height, channels, data } = image;
  const white = (x: number, y: number): boolean => {
    const i = (y * width + x) * channels;
    return (data[i] ?? 0) >= 240 && (data[i + 1] ?? 0) >= 240 && (data[i + 2] ?? 0) >= 240;
  };
  const minRun = Math.round(width * 0.12);
  const runs: { y: number; x0: number; x1: number }[] = [];
  for (let y = Math.round(height * 0.07); y < height; y++) {
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const on = x < width && white(x, y);
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        if (x - start >= minRun) runs.push({ y, x0: start, x1: x - 1 });
        start = -1;
      }
    }
  }
  for (const top of runs) {
    for (const bottom of runs) {
      const gap = bottom.y - top.y;
      if (gap < height * 0.04 || gap > height * 0.6 || Math.abs(top.x0 - bottom.x0) > 4 || Math.abs(top.x1 - bottom.x1) > 4) continue;
      // The ring's left side: white down the column between the two edges; a filled light control is not a ring.
      let side = 0;
      let inside = 0;
      for (let y = top.y; y <= bottom.y; y++) {
        if (white(top.x0, y)) side++;
        if (white(Math.round((top.x0 + top.x1) / 2), y)) inside++;
      }
      if (side < gap * 0.8 || inside > gap * 0.5) continue;
      return { x: top.x0, y: top.y, width: top.x1 - top.x0 + 1, height: gap + 1 };
    }
  }
  return undefined;
}

/** The Play screen tile's open button: its name bar under the picture, left of the edit pencil (measured on 1.26.63). */
export function tileOpenButton(picture: Box): Box {
  return { x: picture.x, y: picture.y + picture.height, width: picture.width * 0.8, height: picture.height * 0.37 };
}

/** Whether a focus ring sits on `button`: its centre inside the button and its size close to it. */
export function ringOn(ring: Box, button: Box): boolean {
  const cx = ring.x + ring.width / 2;
  const cy = ring.y + ring.height / 2;
  const inside = cx >= button.x && cx <= button.x + button.width && cy >= button.y && cy <= button.y + button.height;
  return inside && ring.width >= button.width * 0.8 && ring.width <= button.width * 1.25 && ring.height <= button.height * 1.6;
}

/** The arrow key that moves a focus ring towards `button`; vertical first, as the screen's rows are. */
export function arrowTowards(ring: Box, button: Box): string {
  const dy = button.y + button.height / 2 - (ring.y + ring.height / 2);
  const dx = button.x + button.width / 2 - (ring.x + ring.width / 2);
  if (Math.abs(dy) > Math.max(ring.height, button.height) / 2) return dy > 0 ? "Down" : "Up";
  return dx > 0 ? "Right" : "Left";
}

type Press = { label: string; run: () => Promise<void>; patienceMs?: number; /** False for a wait that sends nothing. */ input?: boolean };

/** How the recovery presses and clicks: the agent's own UI when it answers, the keyboard and mouse route otherwise. */
interface Touch {
  /** Whether a click can be sent at all: through the agent's UI, or with a background mouse. */
  canClick(): boolean;
  /** Whether a control can be pressed by name, which only the agent's UI can do. */
  canPress(): boolean;
  key(keys: string, labels?: readonly string[]): Press;
  click(label: string, at: { x: number; y: number }, count?: number, patienceMs?: number): Press;
  /** The control named by one of `labels` through the agent, else a click at its known place. */
  named(label: string, labels: readonly string[], at: { x: number; y: number }, patienceMs?: number): Press;
}

/**
 * The control of the current screen that answers to one of these labels, by the name the game gives it or the text the
 * player reads; with `exact` only a whole match counts. Undefined when the screen has none.
 */
async function findControl(ui: UiRecovery, labels: readonly string[], exact = false): Promise<string | undefined> {
  const controls = await ui.controls().catch(() => [] as UiControl[]);
  for (const label of labels) {
    const want = label.toLowerCase();
    const whole = controls.find((c) => c.enabled && (c.name.toLowerCase() === want || c.text?.toLowerCase() === want));
    const control = whole ?? (exact ? undefined : controls.find((c) => c.enabled && (c.name.toLowerCase().includes(want) || c.text?.toLowerCase().includes(want))));
    if (control) return control.name;
  }
  return undefined;
}

/** Press the control `findControl` finds. False when the screen has none, so the caller sends the key instead. */
async function pressControl(ui: UiRecovery, labels: readonly string[]): Promise<boolean> {
  const name = await findControl(ui, labels);
  if (name === undefined) return false;
  await ui.press(name);
  return true;
}

/**
 * The presses the recovery can make. With the agent attached a key goes through the game's own input path and a named
 * control is pressed through the game's handler, both without the game window being in the foreground; a click is
 * `ui.click` in the pixels of the last screenshot, which is why the frame is read here. Without the agent the keys and
 * the background mouse are what they always were.
 */
function touchRoute(io: RecoveryIO, route: () => UiRecovery | undefined, frame: () => { width: number; height: number } | undefined): Touch {
  const click = (label: string, at: { x: number; y: number }, count = 1, patienceMs?: number): Press => ({
    label: `${label} (click ${at.x.toFixed(3)},${at.y.toFixed(3)})`,
    run: async () => {
      const ui = route();
      const size = frame();
      if (ui && size) {
        await ui.click(Math.round(size.width * at.x), Math.round(size.height * at.y), count);
        return;
      }
      if (!io.click) throw new Error("no background mouse input and no agent UI to click through on this platform");
      await io.click(at.x, at.y, count);
    },
    ...(patienceMs ? { patienceMs } : {}),
  });
  return {
    canClick: () => route() !== undefined || io.click !== undefined,
    canPress: () => route() !== undefined,
    key: (keys, labels = []) => ({
      label: route() !== undefined && labels.length ? `${keys} (or press ${labels[0] ?? "the button"})` : keys,
      run: async () => {
        const ui = route();
        if (!ui) {
          await io.key(keys);
          return;
        }
        if (labels.length && (await pressControl(ui, labels))) return;
        await ui.key(keys);
      },
    }),
    click,
    named: (label, labels, at, patienceMs) => {
      const fallback = click(label, at, 1, patienceMs);
      return {
        ...fallback,
        label: route() !== undefined ? `press ${label}` : fallback.label,
        run: async () => {
          const ui = route();
          if (!ui) {
            await fallback.run();
            return;
          }
          // Through the agent only the named control: a pixel next to it may be a store entry ("Browse Add-ons!" sits
          // right above Save & Quit on the pause screen).
          if (!(await pressControl(ui, labels))) throw new Error(`the screen lists no ${label} control; not clicking near it`);
        },
      };
    },
  };
}

/**
 * Drive the game from wherever it is back into the world, never relaunching it: the connection-error screen gets
 * "Back to menu", the start screen "Play", the Play screen a double-click on the tile whose thumbnail shows the
 * world's own picture (`world_icon.jpeg`, found by thumbnail.ts), any other screen Escape until the start screen comes
 * back; loading screens are waited out. With the in-game agent attached the screen comes from `ui.screen` and every
 * press goes through the agent, so this works in the background; otherwise the engine log tells which screen is up and
 * the keys are pressed on the host. Either way the log says whether each press moved the game on.
 *
 * On the Play screen nothing is clicked but that one tile: never a tile by its place in the list, never the tab strip,
 * never a featured server's tile, and never a tile when two show the picture or the world has none. When the agent
 * reports the Play screen's route, the Worlds tab is pressed by its exact name first, and a tab that lists no local
 * worlds (Realms, Servers) is left with Escape. A list without the tile is looked at again, reopened once (it may
 * hold thumbnails it read earlier) and scrolled (through the agent); after that the recovery stops and says the tile
 * was not found. Through the agent, Save & Quit is pressed only by its name.
 */
export async function recoverJoin(io: RecoveryIO, opts: RecoveryOptions): Promise<RecoveryResult> {
  const deadline = io.now() + (opts.timeoutMs ?? 180_000);
  let screens = opts.screens ?? NO_SCREENS;
  let join = opts.join ?? NO_JOIN_YET;
  const steps: string[] = [];
  let evidence: string | undefined;
  let seenChanges = -1;
  let since = io.now();
  /** The frame the screenshots show, which `ui.click` needs in pixels. */
  let frame: { width: number; height: number } | undefined;
  /** Times `ui.screen` failed in a row. Two means the agent's UI is down and the log route takes over for this run. */
  let uiFailures = 0;
  let uiDown = false;
  /** Last press: on which screen state and when, so the next one waits for the game. */
  let pressed: { changes: number; at: number; patienceMs: number } | undefined;
  /** Presses per screen kind over the whole recovery, to cycle through the ways of pressing. */
  const tries: Partial<Record<ScreenKind, number>> = {};
  /** The OreUI route of the screen, when the agent read one this round. */
  let route: string | null | undefined;
  /** On the way out of a world that is not the test world, and how many of those opened. */
  let wrongWorld = false;
  let wrongWorlds = 0;
  const template = opts.thumbnail ? thumbnailTemplate(opts.thumbnail) : undefined;
  /** The Play screen that is up: looks without the tile, scrolls, presses of the Worlds tab. A new one starts over. */
  let list = { looks: 0, scrolls: 0, worldsTab: 0, nudges: 0 };
  /** The Play screen was left once to reload its thumbnails. */
  let reopened = false;
  let presses = 0;
  let scrolls = 0;
  let looks = 0;
  let foundByThumbnail = false;
  const opened: string[] = [];
  let lastOpened = screens.opened;
  const seen: string[] = [];
  const uiRoute = (): UiRecovery | undefined => (uiDown ? undefined : io.ui?.(io.sleep));
  const touches = touchRoute(io, uiRoute, () => frame);
  const shoot = async (label: string) => {
    const shot = await io.screenshot(label).catch(() => undefined);
    if (shot) frame = pngSize(shot.png) ?? frame;
    return shot;
  };
  const done = (recovered: boolean, reason?: string, needsUser = false, stuck?: RecoveryResult["stuck"]): RecoveryResult => ({
    recovered,
    steps,
    ...(evidence ? { screenshot: evidence } : {}),
    screens,
    join,
    presses,
    scrolls,
    foundByThumbnail,
    opened,
    seen,
    ...(reason ? { reason } : {}),
    ...(needsUser ? { needsUser } : {}),
    ...(stuck ? { stuck } : {}),
  });
  /** The tile clicks made on the screen state `changes` (the Play screen as it was when the tile was clicked). */
  let tileClick: { changes: number; count: number } | undefined;
  /** When the last tile click was sent: the agent's UI going quiet after it is the world loading. */
  let clickedAt: number | undefined;
  let loadingNoted = false;
  /** Arrow keys and activations sent to open the tile by its keyboard focus after its clicks were ignored. */
  let focusKeys = 0;
  let focusActivations = 0;
  /** The last press that clicked the world's tile. */
  let tilePress: Press | undefined;

  for (;;) {
    if (!(await io.alive())) return done(false, "the game stopped");
    // The caller knows the world is in (its scripts answered): nothing more to do, whatever the screens read.
    if (io.inWorld?.()) return done(true);
    const text = await io.readLog();
    if (text) {
      screens = screensInLog(text, screens);
      join = joinStateInLog(text, join);
    }
    const ui = uiRoute();
    route = undefined;
    if (ui) {
      const screen = await ui.screen().catch(() => undefined);
      if (screen) {
        screens = screensFromUi(screen, screens);
        route = screen.route;
        uiFailures = 0;
      } else if (clickedAt !== undefined && io.now() - clickedAt < LOADING_PATIENCE_MS) {
        // Right after the tile click the agent's UI does not answer while the world loads: that is progress. Nothing is
        // pressed meanwhile (an Escape in the loaded world would open its pause menu).
        if (!loadingNoted) {
          loadingNoted = true;
          steps.push("the agent's UI does not answer after the tile click: the world is loading, waiting for it");
        }
        if (io.now() > deadline) return done(false, `the world did not come back within ${Math.round((opts.timeoutMs ?? 180_000) / 1000)} s`);
        await io.sleep(500);
        continue;
      } else if (++uiFailures >= 2) {
        uiDown = true;
        steps.push("the agent's UI stopped answering: back to the log and the keyboard route");
      }
    }
    const top = screens.stack.at(-1);
    const shown = top ? `${top.name}${route ? ` ${route}` : ""}` : undefined;
    if (shown && seen.at(-1) !== shown) seen.push(shown);
    if (screens.opened !== undefined && screens.opened !== lastOpened) opened.push(screens.opened);
    lastOpened = screens.opened;
    if (screens.inWorld && screens.opened === opts.levelId) return done(true);
    if (screens.inWorld && screens.opened !== undefined && screens.opened !== opts.levelId && !wrongWorld) {
      // A safety net: the tile showed the world's picture but another world opened. Leave it through the pause menu.
      wrongWorld = true;
      wrongWorlds++;
      steps.push(`opened ${screens.opened} instead of ${opts.levelId}: leaving it`);
    }
    const showing = currentScreen(screens);
    if (!screens.inWorld && wrongWorld && showing !== "pause" && showing !== "world") {
      wrongWorld = false;
      if (wrongWorlds >= MAX_WRONG_WORLDS) return done(false, `${wrongWorlds} times a world other than ${opts.levelId} opened: stopped instead of opening more`);
    }
    if (showing !== "play") list = { looks: 0, scrolls: 0, worldsTab: 0, nudges: 0 };
    if (io.now() > deadline) return done(false, `the world did not come back within ${Math.round((opts.timeoutMs ?? 180_000) / 1000)} s`);
    if (evidence === undefined) evidence = (await shoot("join-error"))?.path ?? "";

    if (screens.changes !== seenChanges) {
      seenChanges = screens.changes;
      since = io.now();
      pressed = undefined;
    }
    const kind = currentScreen(screens);
    const waitFor = kind === "unknown" ? 1000 : SETTLE_MS[kind];
    const waiting =
      kind === "loading" ||
      (kind === "world" && !wrongWorld) ||
      io.now() - since < waitFor ||
      (pressed !== undefined && io.now() - pressed.at < pressed.patienceMs);
    if (waiting) {
      await io.sleep(300);
      continue;
    }
    let known: ScreenKind = kind === "unknown" ? "other" : kind;
    // An unnamed Ore UI screen may be the Play screen before its log lines come (up to ~9 s): its tiles tell.
    const unnamedOre = known === "other" && screens.stack.at(-1)?.name === "ore";
    let press: Press | undefined;
    if ((known === "play" || unnamedOre) && touches.canClick()) {
      const tab = known === "play" ? playTab(route) : undefined;
      if (tab !== undefined && tab !== "worlds" && ui && list.worldsTab < 2) {
        list.worldsTab++;
        // The Worlds tab by its exact name through the game's handler: never a click in the tab strip.
        const worlds = await findControl(ui, ["Worlds"], true);
        if (worlds !== undefined) press = { label: `press the Worlds tab (${worlds})`, run: () => ui.press(worlds) };
      }
      // A tab that lists no local worlds (Realms, Servers, ...): leave it, never click on it.
      if (!press && tab !== undefined && tab !== "worlds" && tab !== "all") press = touches.key("Escape");
      if (!press) {
        const shot = await shoot("play");
        const image = shot && decodePng(shot.png);
        const locals = image ? localWorldTiles(image) : [];
        const matches = image && template ? findThumbnailTiles(image, template) : [];
        looks++;
        if (unnamedOre && (matches.length || locals.length)) known = "play";
        if (known === "play") {
          if (!template) {
            return done(
              false,
              `${opts.levelId} has no world_icon.jpeg sculkwire can read (or its picture is too plain to tell apart), so its ` +
                "tile cannot be told from the others on the Play screen; nothing was opened by guess",
              true,
            );
          }
          if (matches.length > 1) {
            return done(
              false,
              `${matches.length} tiles on the Play screen show the picture of ${opts.levelId} (a copy of the world has the same ` +
                "picture), so the tile is not known for sure; nothing was opened by guess",
              true,
            );
          }
          const tile = matches[0] && image && onLocalTile(image, matches[0], locals) ? matches[0] : undefined;
          // The tile was clicked and the screen did not change since: no loading screen came within the patience.
          const clicked = tileClick !== undefined && tileClick.changes === screens.changes ? tileClick.count : 0;
          if (clicked > 0 && !tile) {
            return done(
              false,
              `after the tile of ${opts.levelId} was clicked the Play screen stayed up and the tile is covered now: the game ` +
                "shows a dialog over it (such as the World update that makes an old world higher and deeper), which sculkwire never confirms",
              true,
              "dialog",
            );
          }
          if (clicked >= MAX_TILE_CLICKS) {
            // The clicks were ignored (a game in the background reads its mouse too seldom), but it takes keys: walk its
            // keyboard focus onto the tile's open button, seen as the focus ring on it, and only then activate it.
            const button = tile && image ? tileOpenButton(tile.rect) : undefined;
            const ring = image ? focusRing(image) : undefined;
            if (button && ring && ringOn(ring, button) && focusActivations < MAX_FOCUS_ACTIVATIONS) {
              focusActivations++;
              press = { ...touches.key("space"), label: `space on the tile of ${opts.levelId} (the keyboard focus is on it)`, patienceMs: OPEN_PATIENCE_MS };
              clickedAt = io.now();
            } else if (button && !(ring && ringOn(ring, button)) && focusKeys < MAX_FOCUS_KEYS) {
              focusKeys++;
              const key = ring ? arrowTowards(ring, button) : "Down";
              press = { ...touches.key(key), label: `${key} (moves the keyboard focus towards the tile of ${opts.levelId})`, patienceMs: FOCUS_PATIENCE_MS };
            } else {
              return done(
                false,
                `the tile of ${opts.levelId} was double-clicked ${clicked} times and the world did not open` +
                  (focusActivations ? `, nor when its keyboard focus was activated ${focusActivations} times` : focusKeys ? `, and the keyboard focus did not reach it in ${focusKeys} keys` : "") +
                  ": the Play screen stayed up without a change (the game may show a dialog over it, or ignore input)",
                true,
                "ignored",
              );
            }
          }
          const scroll = ui?.scroll?.bind(ui);
          const wheel = (label: string, notches: number): Press => ({
            label,
            run: async () => {
              const size = frame ?? DEFAULT_FRAME;
              await scroll?.(Math.round(size.width * LAYOUT.worldList.x), Math.round(size.height * LAYOUT.worldList.y), notches);
            },
            patienceMs: LOOK_PATIENCE_MS,
          });
          if (press) {
            // The keyboard step above.
          } else if (tile && image && !tile.whole && scroll && list.nudges < MAX_NUDGES) {
            // Part of the tile is under the list's edge: bring it into view, never scroll it away.
            list.nudges++;
            scrolls++;
            press = wheel(`scroll the tile of ${opts.levelId} into view (its ${tile.hidden} is hidden)`, tile.hidden === "top" ? NUDGE_NOTCHES : -NUDGE_NOTCHES);
          } else if (tile && image) {
            foundByThumbnail = true;
            const at = { x: tile.at.x / image.width, y: tile.at.y / image.height };
            const what = tile.whole ? "the tile showing the world's picture" : `the visible half of the tile showing the world's picture (its ${tile.hidden} is hidden)`;
            press = touches.click(`${what} of ${opts.levelId}`, at, 2, OPEN_PATIENCE_MS);
            tilePress = press;
            tileClick = { changes: screens.changes, count: clicked + 1 };
            clickedAt = io.now();
          } else if (list.looks < THUMBNAIL_LOOKS) {
            list.looks++;
            press = { label: "no tile shows the world's picture yet: looking again", run: async () => undefined, patienceMs: LOOK_PATIENCE_MS, input: false };
          } else if (!reopened) {
            // The list may show thumbnails it read before: reopen it once first.
            reopened = true;
            press = { ...touches.key("Escape"), label: "Escape (leave the Play screen once, so it reloads the thumbnails)" };
          } else if (scroll && list.scrolls < MAX_SCROLLS) {
            list.scrolls++;
            scrolls++;
            press = wheel(`scroll the world list down (${list.scrolls} of ${MAX_SCROLLS})`, -SCROLL_NOTCHES);
          } else {
            return done(
              false,
              `the tile of ${opts.levelId} was not found on the Play screen: no local world's thumbnail showed its world_icon.jpeg in ${looks} looks ` +
                `(the list reopened once, ${scrolls} scrolls). The game may show a newer picture than the file holds; nothing was opened by guess`,
              true,
            );
          }
        }
      }
    }
    if (!press) {
      const n = tries[known] ?? 0;
      tries[known] = n + 1;
      press = fixedPress(touches, known, n, wrongWorld);
    }
    steps.push(`${known}: ${press.label}`);
    try {
      await press.run();
      if (press.input !== false) presses++;
    } catch (e) {
      steps.push(`${known}: ${press.label} failed: ${errorMessage(e)}`);
      // A game that reads its mouse too seldom refuses the tile click outright: no point waiting for another one, the
      // keyboard focus is walked to the tile next.
      if (tileClick && press === tilePress && /not reading the mouse/.test(errorMessage(e))) tileClick.count = MAX_TILE_CLICKS;
    }
    pressed = { changes: screens.changes, at: io.now(), patienceMs: press.patienceMs ?? PATIENCE_MS };
  }
}

/**
 * The fixed ways to get past each screen, tried in turn (`n` counts the presses on that kind of screen so far).
 * A named control first where the button is what matters (through the agent's UI it is the button itself, not a
 * coordinate), the key next, the button's known place last. The Play screen's tile is not here: `recoverJoin` opens
 * it only by its thumbnail.
 */
function fixedPress(t: Touch, kind: ScreenKind, n: number, wrongWorld: boolean): Press {
  switch (kind) {
    case "disconnect": {
      // "Back to menu" has the focus when the screen opens: Return presses it.
      const ways = t.canClick() ? [t.key("Return", ["Back to menu"]), t.click("Back to menu", LAYOUT.backToMenu)] : [t.key("Return", ["Back to menu"])];
      return ways[n % ways.length] as Press;
    }
    case "start": {
      if (!t.canClick()) return t.key("Return", ["Play"]);
      // Play has the focus when the start screen opens, but after other screens the focus may sit on Marketplace: the
      // button itself first when the agent can press it by name, its known place first when only a mouse is available.
      const ways = t.canPress()
        ? [t.key("Return", ["Play"]), t.click("Play", LAYOUT.play), t.key("Escape")]
        : [t.click("Play", LAYOUT.play), t.key("Return"), t.key("Escape")];
      return ways[n % ways.length] as Press;
    }
    case "pause":
      return wrongWorld && t.canClick() ? t.named("Save & Quit", ["Save & Quit"], LAYOUT.saveAndQuit, OPEN_PATIENCE_MS) : t.key("Escape");
    default:
      // The Play screen without a way to click, a wrong world (Escape opens its pause menu), a store or any other
      // screen: Escape.
      return t.key("Escape");
  }
}

/** How long `leaveWorld` tries by default. */
export const LEAVE_TIMEOUT_MS = 45_000;

export interface LeaveOptions {
  /** Give up after this long (default `LEAVE_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** State of the reads before the walk started. */
  screens?: ScreenState;
  join?: JoinState;
}

export interface LeaveResult {
  /** The game left the world and shows a menu (start, Play or the connection-error screen). */
  left: boolean;
  /** What was pressed, in order, with the screen it was pressed on. */
  steps: string[];
  presses: number;
  screens: ScreenState;
  join: JoinState;
  /** Why it stopped while the world was still open. */
  reason?: string;
}

/**
 * Save & Quit like a player: leave the world the game has open through its pause menu, so the game saves it, and wait
 * for the start or Play screen. In the world Escape opens the pause menu; on the pause menu Save & Quit is pressed by its
 * name through the in-game agent's UI, else clicked at its known place with a background mouse, never pressed near it by
 * guess (through the agent a pixel next to it may be a store entry). Chat and other screens over the world get Escape;
 * loading (saving) screens are waited out. Gives up after `timeoutMs`, and after Save & Quit failed to press twice.
 */
export async function leaveWorld(io: RecoveryIO, opts: LeaveOptions = {}): Promise<LeaveResult> {
  const timeoutMs = opts.timeoutMs ?? LEAVE_TIMEOUT_MS;
  const deadline = io.now() + timeoutMs;
  let screens = opts.screens ?? NO_SCREENS;
  let join = opts.join ?? NO_JOIN_YET;
  const steps: string[] = [];
  let presses = 0;
  let uiFailures = 0;
  let uiDown = false;
  let seenChanges = -1;
  let since = io.now();
  let pressed: { at: number; patienceMs: number } | undefined;
  let failedQuits = 0;
  const uiRoute = (): UiRecovery | undefined => (uiDown ? undefined : io.ui?.(io.sleep));
  // Save & Quit through the agent is pressed by name only, so no click needs the frame's size.
  const touches = touchRoute(io, uiRoute, () => undefined);
  const done = (left: boolean, reason?: string): LeaveResult => ({ left, steps, presses, screens, join, ...(reason ? { reason } : {}) });

  for (;;) {
    if (!(await io.alive())) return done(false, "the game stopped before it left the world");
    const text = await io.readLog();
    if (text) {
      screens = screensInLog(text, screens);
      join = joinStateInLog(text, join);
    }
    const ui = uiRoute();
    if (ui) {
      const screen = await ui.screen().catch(() => undefined);
      if (screen) {
        screens = screensFromUi(screen, screens);
        uiFailures = 0;
      } else if (++uiFailures >= 2) {
        uiDown = true;
        steps.push("the agent's UI stopped answering: back to the log and the keyboard route");
      }
    }
    const kind = currentScreen(screens);
    if (!screens.inWorld && (kind === "start" || kind === "play" || kind === "disconnect")) return done(true);
    // Escape does not reach the pause menu from the death screen, and its other button is "Game menu".
    if (kind === "death") return done(false, "the player is dead (the death screen is up): respawn first, then Save & Quit");
    if (io.now() > deadline) return done(false, `the game did not leave the world within ${Math.round(timeoutMs / 1000)} s (last screen: ${kind})`);
    if (screens.changes !== seenChanges) {
      seenChanges = screens.changes;
      since = io.now();
      pressed = undefined;
    }
    const waiting =
      kind === "loading" ||
      kind === "start" ||
      kind === "play" ||
      io.now() - since < (kind === "unknown" ? 1000 : SETTLE_MS[kind]) ||
      (pressed !== undefined && io.now() - pressed.at < pressed.patienceMs);
    if (waiting) {
      await io.sleep(300);
      continue;
    }
    let press: Press;
    if (kind === "pause") {
      if (!touches.canClick()) return done(false, "Save & Quit cannot be pressed: no in-game agent UI and no background mouse reach this game");
      press = touches.named("Save & Quit", ["Save & Quit"], LAYOUT.saveAndQuit, OPEN_PATIENCE_MS);
    } else {
      // In the world Escape opens the pause menu; over chat or any other screen it closes that screen first.
      press = touches.key("Escape");
    }
    steps.push(`${kind}: ${press.label}`);
    try {
      await press.run();
      presses++;
    } catch (e) {
      steps.push(`${kind}: ${press.label} failed: ${errorMessage(e)}`);
      if (kind === "pause" && ++failedQuits >= 2) return done(false, `Save & Quit could not be pressed: ${errorMessage(e)}`);
    }
    pressed = { at: io.now(), patienceMs: press.patienceMs ?? PATIENCE_MS };
  }
}

/** How long `respawn` tries by default. */
export const RESPAWN_TIMEOUT_MS = 15_000;
/** After pressing RESPAWN, how long to wait for the death screen to go before pressing again. */
const RESPAWN_PATIENCE_MS = 3000;
/** The RESPAWN control by its name (`respawn_button`, as `death_screen.json` names it) or its label. */
const RESPAWN_CONTROL = /respawn/i;
/** Never pressed: the death screen's other button, "Game menu" (`main_menu_button`), leads out to the menus. */
const NOT_RESPAWN = /menu|quit/i;

export interface RespawnOptions {
  /** The player's health as the helper last streamed it, undefined when no fresh reading is known. */
  health(): number | undefined;
  /** Give up after this long (default `RESPAWN_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** State of the reads before the walk started. */
  screens?: ScreenState;
  join?: JoinState;
}

export interface RespawnResult {
  /** The player was dead when the walk started: the death screen was up, or the helper streamed health 0. */
  wasDead: boolean;
  /** The death screen is gone and the player is alive again. */
  respawned: boolean;
  /** How RESPAWN was pressed last: by its control name through the agent, a click at its place, or never. */
  via: "press" | "click" | "none";
  /** What was pressed, in order. */
  steps: string[];
  presses: number;
  screens: ScreenState;
  join: JoinState;
  /** Why the player is still dead. */
  reason?: string;
}

/** The death screen's RESPAWN control, never "Game menu". */
function respawnControl(controls: readonly UiControl[]): UiControl | undefined {
  // Name and label together, so a control labelled RESPAWN but named like a menu button is still never pressed.
  return controls.find((c) => RESPAWN_CONTROL.test(`${c.name} ${c.text ?? ""}`) && !NOT_RESPAWN.test(`${c.name} ${c.text ?? ""}`));
}

/**
 * Press RESPAWN like a player when the player died: the death screen (`death.death_screen`, from `ui.screen` or the
 * engine log) is up, or the helper streamed health 0 while no screen name is known. Through the in-game agent RESPAWN is
 * pressed by its control name (`ui.controls`/`ui.press`); a RESPAWN still greyed out is waited for; when the screen lists
 * no RESPAWN control, or a press by name did not take, RESPAWN is clicked where a screenshot shows it (`findRespawnButton`, through
 * `ui.click` or the background mouse). "Game menu" is never pressed and no key is sent (Return may press the focused
 * button, which can be "Game menu"). Done once the death screen is gone and the helper streams health above 0 (or the
 * HUD is on top after a press); gives up after `timeoutMs`. A player that is not dead is left alone (`wasDead` false).
 */
export async function respawn(io: RecoveryIO, opts: RespawnOptions): Promise<RespawnResult> {
  const timeoutMs = opts.timeoutMs ?? RESPAWN_TIMEOUT_MS;
  const deadline = io.now() + timeoutMs;
  let screens = opts.screens ?? NO_SCREENS;
  let join = opts.join ?? NO_JOIN_YET;
  const steps: string[] = [];
  let presses = 0;
  let via: RespawnResult["via"] = "none";
  let wasDead = false;
  let uiFailures = 0;
  let uiDown = false;
  let seenChanges = -1;
  let since = io.now();
  let pressed: number | undefined;
  /** Presses by name that did not take: the next press is a click at RESPAWN's place. */
  let namedTries = 0;
  let waitingForEnabled = false;
  /** The last screenshot showed no RESPAWN (said once until it shows). */
  let notShown = false;
  let frame: { width: number; height: number } | undefined;
  const uiRoute = (): UiRecovery | undefined => (uiDown ? undefined : io.ui?.(io.sleep));
  const touches = touchRoute(io, uiRoute, () => frame);
  const done = (respawned: boolean, reason?: string): RespawnResult => ({ wasDead, respawned, via, steps, presses, screens, join, ...(reason ? { reason } : {}) });

  for (;;) {
    if (!(await io.alive())) return done(false, "the game stopped before the player respawned");
    const text = await io.readLog();
    if (text) {
      screens = screensInLog(text, screens);
      join = joinStateInLog(text, join);
    }
    const ui = uiRoute();
    if (ui) {
      const screen = await ui.screen().catch(() => undefined);
      if (screen) {
        screens = screensFromUi(screen, screens);
        uiFailures = 0;
      } else if (++uiFailures >= 2) {
        uiDown = true;
        steps.push("the agent's UI stopped answering: back to the log and the background mouse");
      }
    }
    const kind = currentScreen(screens);
    const health = opts.health();
    const deathShown = kind === "death";
    if (!wasDead) {
      if (!deathShown && !(health !== undefined && health <= 0)) return done(false);
      wasDead = true;
    } else if (!deathShown && (health !== undefined ? health > 0 : kind === "world" && presses > 0)) {
      return done(true);
    }
    if (io.now() > deadline) {
      return done(false, `the player did not respawn within ${Math.round(timeoutMs / 1000)} s (last screen: ${kind}, health ${health ?? "unknown"})`);
    }
    if (screens.changes !== seenChanges) {
      seenChanges = screens.changes;
      since = io.now();
      pressed = undefined;
    }
    // Health 0 alone is acted on only while no screen name says otherwise: a HUD still on top may be a moment ahead of
    // the death screen, and on a pause or chat screen RESPAWN's place is another button.
    // Without the agent's UI the screen comes from the engine log, which never names the death screen: there it still
    // reads `world`, so health 0 is the death screen.
    const deadInWorld = kind === "world" && !ui && health !== undefined && health <= 0;
    const actable = deathShown || kind === "unknown" || kind === "other" || deadInWorld;
    const waiting = !actable || io.now() - since < SETTLE_MS.death || (pressed !== undefined && io.now() - pressed < RESPAWN_PATIENCE_MS);
    if (waiting) {
      await io.sleep(300);
      continue;
    }
    let press: Press | undefined;
    let how: RespawnResult["via"] = "click";
    if (ui) {
      const control = respawnControl(await ui.controls().catch(() => [] as UiControl[]));
      if (control && !control.enabled) {
        if (!waitingForEnabled) steps.push(`${kind}: RESPAWN (${control.name}) is not enabled yet: waiting`);
        waitingForEnabled = true;
        await io.sleep(300);
        continue;
      }
      waitingForEnabled = false;
      if (control && namedTries < 2) {
        namedTries++;
        how = "press";
        press = { label: `press RESPAWN (${control.name})`, run: () => ui.press(control.name) };
      }
    }
    if (!press) {
      if (!touches.canClick()) return done(false, "RESPAWN cannot be pressed: no in-game agent UI and no background mouse reach this game");
      // RESPAWN's place depends on the frame's size and GUI scale: find it in a screenshot, and never click blind (a
      // fixed spot can be "Game menu", which leaves the world). The screenshot also gives `ui.click` its frame.
      const shot = await io.screenshot("death").catch(() => undefined);
      const image = shot ? decodePng(shot.png) : undefined;
      const at = image ? findRespawnButton(image) : undefined;
      if (!at) {
        if (!notShown) steps.push(`${kind}: RESPAWN is not on the screen${shot ? "" : " (no screenshot)"}: waiting`);
        notShown = true;
        await io.sleep(300);
        continue;
      }
      notShown = false;
      if (image) frame = { width: image.width, height: image.height };
      press = touches.click("RESPAWN", at);
    }
    steps.push(`${kind}: ${press.label}`);
    try {
      await press.run();
      presses++;
      via = how;
    } catch (e) {
      steps.push(`${kind}: ${press.label} failed: ${errorMessage(e)}`);
    }
    pressed = io.now();
  }
}
