/**
 * Which screen the game shows, followed from the engine log (`Debug_Log`), and the join recovery that walks the menus
 * back into the test world like a person would.
 *
 * The engine logs every JSON UI screen it creates and destroys (`Created 'start.start_screen' screen`, `Destroyed
 * 'store_data_driven_screen - MultiItemPage_StoreRoot' screen`). The Ore UI screens (the Play screen with the world
 * list, the connection-error screen) are never logged as created, only as `Destroyed 'ui://./hbui/index.html'`, so
 * they are recognised by what comes with them: `Pushing disconnect screen from GameConnectionUIUtils::_onDisconnect`
 * for the error screen and the world list's `world.cheatsEnabled:` lines for the Play screen.
 */
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import type { DecisionModel, Question } from "../../decision/types.ts";
import { CLIENT_JOINED, joinStateInLog, NO_JOIN_YET, type JoinState } from "./contentlog.ts";

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

function kindOf(namespace: string, name: string): ScreenKind {
  if (name === "start_screen") return "start";
  if (namespace === "progress") return "loading";
  if (namespace.startsWith("store") || name === "skin_selector_screen" || name === "character_creator_screen") return "store";
  if (name === "hud_screen") return "world";
  if (name === "pause_screen") return "pause";
  if (name === "chat_screen") return "chat";
  return "other";
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
   * then the local worlds, most recently played first. `slot` is the tile's place in reading order.
   */
  worldTile: (slot: number) => ({ x: 0.137 + (slot % 4) * 0.2375, y: slot < 4 ? 0.374 : 0.74 }),
  /** Pause screen: "Save & Quit". */
  saveAndQuit: { x: 0.293, y: 0.662 },
} as const;

/** A decoded 8-bit RGB or RGBA PNG. */
export interface Pixels {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

/** Decode a non-interlaced 8-bit RGB/RGBA PNG (what gamescope and PrintWindow write), or undefined for anything else. */
export function decodePng(png: Buffer): Pixels | undefined {
  const size = pngSize(png);
  if (!size) return undefined;
  const depth = png[24];
  const color = png[25];
  const interlace = png[28];
  const channels = color === 2 ? 3 : color === 6 ? 4 : 0;
  if (depth !== 8 || !channels || interlace !== 0) return undefined;
  const parts: Buffer[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") parts.push(png.subarray(at + 8, at + 8 + length));
    if (type === "IEND") break;
    at += 12 + length;
  }
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(parts));
  } catch {
    return undefined;
  }
  const stride = size.width * channels;
  if (raw.length < (stride + 1) * size.height) return undefined;
  const data = new Uint8Array(stride * size.height);
  for (let y = 0; y < size.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= channels ? (data[line + i - channels] ?? 0) : 0;
      const b = y > 0 ? (data[line - stride + i] ?? 0) : 0;
      const c = i >= channels && y > 0 ? (data[line - stride + i - channels] ?? 0) : 0;
      let v = x;
      if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      data[line + i] = v & 0xff;
    }
  }
  return { ...size, channels, data };
}

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

/** The game, as the recovery sees it. Tests replace it with a script. */
export interface RecoveryIO {
  /** Engine-log text written since the previous call. */
  readLog(): Promise<string>;
  /** Key presses (xdotool names), e.g. `Return`, `Escape`. */
  key(keys: string): Promise<void>;
  /** Click at a fraction of the frame; `count: 2` double-clicks. Absent when the caller has no mouse (keys only). */
  click?(x: number, y: number, count?: number): Promise<void>;
  /** A screenshot of the game: its file and PNG bytes. */
  screenshot(label: string): Promise<{ path: string; png: Buffer } | undefined>;
  /** False once the game process is gone. */
  alive(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface RecoveryOptions {
  /** Level id (folder under minecraftWorlds) of the test world. */
  levelId: string;
  /** The world's display name, for the advisor. */
  worldName?: string;
  /** Give up after this long (default 3 minutes). */
  timeoutMs?: number;
  /** Optional decision model with image support, asked only when the fixed steps did not move the game on. */
  advisor?: DecisionModel;
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
  /** Why it stopped without the world. */
  reason?: string;
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
  loading: 0,
  world: 2000,
};
/** After a press, how long to wait for the screen to change before the next way of pressing is tried. */
const PATIENCE_MS = 4000;
/** A world tile press starts a world-loading screen within this time. */
const OPEN_PATIENCE_MS = 8000;

const ADVISOR_SCREENS: Record<string, string> = {
  start: "the Minecraft title screen with Play, Settings and Marketplace buttons",
  play: "the Play screen listing worlds (Worlds tab) with world tiles",
  store: "the Marketplace or another store screen",
  disconnect: "an error screen saying an error has occurred, with Back to menu",
  loading: "a loading or saving progress screen",
  world: "the game world itself (blocks, HUD) with no menu over it",
  pause: "the pause menu over the world (Resume, Settings, Save & Quit)",
  other: "any other screen or dialog",
};

type Press = { label: string; run: (io: RecoveryIO) => Promise<void>; patienceMs?: number };

/**
 * Drive the game from wherever it is back into the test world, never relaunching it: the connection-error screen
 * gets "Back to menu", the start screen "Play", the Play screen a double-click on the test world (the most recently
 * played, so the first tile), any other screen Escape until the start screen comes back; loading screens are waited
 * out. The engine log tells which screen is up and whether each press moved the game on; when the fixed presses for a
 * screen did not, the optional advisor is shown a screenshot and asked which screen it is and where the button is.
 */
export async function recoverJoin(io: RecoveryIO, opts: RecoveryOptions): Promise<RecoveryResult> {
  const deadline = io.now() + (opts.timeoutMs ?? 180_000);
  let screens = opts.screens ?? NO_SCREENS;
  let join = opts.join ?? NO_JOIN_YET;
  const steps: string[] = [];
  let evidence: string | undefined;
  let seenChanges = -1;
  let since = io.now();
  /** Last press: on which screen state and when, so the next one waits for the game. */
  let pressed: { changes: number; at: number; patienceMs: number } | undefined;
  /** Presses per screen kind over the whole recovery, to cycle through the ways of pressing. */
  const tries: Partial<Record<ScreenKind, number>> = {};
  /** World tiles that opened the wrong world. */
  let tile = 0;
  let wrongWorld = false;
  const done = (recovered: boolean, reason?: string): RecoveryResult => ({
    recovered,
    steps,
    ...(evidence ? { screenshot: evidence } : {}),
    screens,
    join,
    ...(reason ? { reason } : {}),
  });

  for (;;) {
    if (!(await io.alive())) return done(false, "the game stopped");
    const text = await io.readLog();
    if (text) {
      screens = screensInLog(text, screens);
      join = joinStateInLog(text, join);
    }
    if (screens.inWorld && screens.opened === opts.levelId) return done(true);
    if (screens.inWorld && screens.opened !== undefined && screens.opened !== opts.levelId && !wrongWorld) {
      // The tile was another world: leave it through the pause menu and try the next tile.
      wrongWorld = true;
      tile++;
      steps.push(`opened ${screens.opened} instead of ${opts.levelId}: leaving it`);
    }
    if (!screens.inWorld && wrongWorld && currentScreen(screens) !== "pause" && currentScreen(screens) !== "world") wrongWorld = false;
    if (io.now() > deadline) return done(false, `the world did not come back within ${Math.round((opts.timeoutMs ?? 180_000) / 1000)} s`);
    if (evidence === undefined) evidence = (await io.screenshot("join-error").catch(() => undefined))?.path ?? "";

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
    let localTiles: number[] = [];
    if ((known === "play" || unnamedOre) && io.click) {
      const shot = await io.screenshot("play").catch(() => undefined);
      const image = shot && decodePng(shot.png);
      localTiles = image ? localWorldTiles(image) : [];
      if (unnamedOre && localTiles.length) known = "play";
      else if (known === "play" && !localTiles.length) steps.push("play: no local world tile found in the screenshot");
    }
    const n = tries[known] ?? 0;
    tries[known] = n + 1;
    const press = (await advisedPress(io, opts, known, n, wrongWorld, steps)) ?? fixedPress(io, known, n, tile, wrongWorld, localTiles);
    steps.push(`${known}: ${press.label}`);
    try {
      await press.run(io);
    } catch (e) {
      steps.push(`${known}: ${press.label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    pressed = { changes: screens.changes, at: io.now(), patienceMs: press.patienceMs ?? PATIENCE_MS };
  }
}

const key = (keys: string): Press => ({ label: keys, run: (io) => io.key(keys) });
const click = (label: string, at: { x: number; y: number }, count = 1, patienceMs?: number): Press => ({
  label: `${label} (click ${at.x.toFixed(3)},${at.y.toFixed(3)})`,
  run: async (io) => {
    if (!io.click) throw new Error("no background mouse input on this platform");
    await io.click(at.x, at.y, count);
  },
  ...(patienceMs ? { patienceMs } : {}),
});

/**
 * The fixed ways to get past each screen, tried in turn (`n` counts the presses on that kind of screen so far).
 * Keyboard first where the focused button is the right one, the button's known place otherwise.
 */
function fixedPress(io: RecoveryIO, kind: ScreenKind, n: number, tile: number, wrongWorld: boolean, localTiles: number[]): Press {
  switch (kind) {
    case "disconnect": {
      // "Back to menu" has the focus when the screen opens: Return presses it.
      const ways = io.click ? [key("Return"), click("Back to menu", LAYOUT.backToMenu)] : [key("Return")];
      return ways[n % ways.length] as Press;
    }
    case "start": {
      if (!io.click) return key("Return");
      // Play has the focus when the start screen opens, but after other screens the focus may sit on Marketplace.
      return [click("Play", LAYOUT.play), key("Return"), key("Escape")][n % 3] as Press;
    }
    case "play": {
      // Only a tile the screenshot shows as a local world is opened; without one, leave and come back to the list.
      const slot = localTiles[tile];
      if (!io.click || slot === undefined) return key("Escape");
      return click(`world tile ${slot + 1} (local world ${tile + 1})`, LAYOUT.worldTile(slot), 2, OPEN_PATIENCE_MS);
    }
    case "pause":
      return wrongWorld && io.click ? click("Save & Quit", LAYOUT.saveAndQuit, 1, OPEN_PATIENCE_MS) : key("Escape");
    case "world":
      // Only reached in a wrong world: Escape opens the pause menu.
      return key("Escape");
    default:
      return key("Escape");
  }
}

/** What the advisor is asked to find on each screen. */
function advisorTarget(kind: ScreenKind, worldName: string | undefined, wrongWorld: boolean): string | undefined {
  switch (kind) {
    case "disconnect":
      return "the Back to menu button in `screen`";
    case "start":
      return "the Play button in `screen`";
    case "play":
      return worldName ? `the world tile named "${worldName}" in \`screen\`` : "the first world tile in `screen`";
    case "pause":
      return wrongWorld ? "the Save & Quit button in `screen`" : undefined;
    default:
      return undefined;
  }
}

/**
 * Ask the advisor, only after the fixed presses for this screen went round once without moving the game on, and only
 * when it is configured and takes images. Its screen answer overrides the log's when they disagree; its box is
 * clicked when it also says the button is there. Any failure falls back to the fixed presses.
 */
async function advisedPress(
  io: RecoveryIO,
  opts: RecoveryOptions,
  kind: ScreenKind,
  n: number,
  wrongWorld: boolean,
  steps: string[],
): Promise<Press | undefined> {
  const model = opts.advisor;
  // Store screens (Marketplace, Minecoins, Dressing Room) are only ever left with Escape, never clicked.
  if (!model?.images || !io.click || kind === "store" || n < 2 || n % 2 !== 0) return undefined;
  const shot = await io.screenshot(`advisor-${kind}`).catch(() => undefined);
  if (!shot) return undefined;
  const image = { type: "image_url" as const, image_url: { url: `data:image/png;base64,${shot.png.toString("base64")}` } };
  try {
    const screenDecision = await model.decide(["`screen` is this Minecraft screenshot:", image], {
      screen: { type: "choice", instructions: "Which Minecraft screen is `screen`?", criteria: ADVISOR_SCREENS },
    });
    const screenAnswer = screenDecision.answers.screen;
    const seen = screenAnswer?.type === "choice" && screenAnswer.choice in ADVISOR_SCREENS ? (screenAnswer.choice as ScreenKind) : kind;
    if (seen !== kind) steps.push(`advisor (${model.label}): the screen is ${seen}, not ${kind}`);
    const target = advisorTarget(seen, opts.worldName, wrongWorld);
    if (!target) return seen === "loading" || seen === "world" ? { label: "wait (advisor)", run: async () => undefined } : key("Escape");
    const questions: Record<string, Question> = {
      visible: { type: "noul", instructions: `Is ${target} visible?` },
      target: { type: "box", instructions: target },
    };
    const decision = await model.decide(["`screen` is this Minecraft screenshot:", image], questions);
    const visible = decision.answers.visible;
    const box = decision.answers.target;
    if (visible?.type !== "noul" || visible.noul < 0.5 || box?.type !== "box") {
      steps.push(`advisor (${model.label}): ${target} not found`);
      return undefined;
    }
    const at = { x: (box.box.left + box.box.right) / 2, y: (box.box.top + box.box.bottom) / 2 };
    return click(`${target.replace(/ in `screen`$/, "")} (advisor ${model.label})`, at, seen === "play" ? 2 : 1, seen === "play" ? OPEN_PATIENCE_MS : PATIENCE_MS);
  } catch (e) {
    steps.push(`advisor (${model.label}) failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** Width and height of a PNG from its header. */
export function pngSize(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < 24 || png.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Read a screenshot file for `RecoveryIO.screenshot`. */
export async function readShot(path: string): Promise<{ path: string; png: Buffer }> {
  return { path, png: await readFile(path) };
}
