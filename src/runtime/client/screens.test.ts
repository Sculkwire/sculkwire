import { describe, expect, it } from "vitest";
import { drawPicture, fill, frame, png, testPicture } from "../../testing/screenshots.ts";
import type { UiControl } from "../engine/ui.ts";
import { decodePng, type Pixels } from "./png.ts";
import {
  currentScreen,
  arrowTowards,
  focusedButton,
  focusRing,
  kindOfRoute,
  kindOfScreenName,
  LAYOUT,
  LEAVE_TIMEOUT_MS,
  leaveWorld,
  localWorldTiles,
  NO_SCREENS,
  playTab,
  recoverJoin,
  ringOn,
  tileOpenButton,
  respawn,
  RESPAWN_TIMEOUT_MS,
  screensFromUi,
  screensInLog,
  type RecoveryIO,
  type ScreenState,
  type UiRecovery,
} from "./screens.ts";

/**
 * A 1280x668 RGB PNG of the Play screen as the game draws it: each tile's thumbnail (a made-up picture per world name,
 * a flat blue one for a featured server), and its name row with, on local worlds, the light divider
 * before the edit button. Only the first 8 tiles are visible.
 */
function playScreen(tiles: readonly string[], shift = 0): Buffer {
  const width = 1280;
  const height = 668;
  const image = frame(width, height, 72);
  tiles.forEach((tile, slot) => {
    if (slot > 7) return;
    const centre = LAYOUT.worldTile(slot);
    const w = width * 0.2;
    const h = (w * 9) / 16;
    const thumb = { x: centre.x * width - w / 2, y: centre.y * height - h / 2 - shift, width: w, height: h };
    if (tile === "LAN") fill(image, thumb, [30, 90, 160]);
    else drawPicture(image, thumb, testPicture(tile));
    if (tile === "LAN") return;
    const x = Math.round((0.1992 + (slot % 4) * 0.2375) * width);
    fill(image, { x, y: Math.round((slot < 4 ? 0.4985 : 0.864) * height) - shift, width: 1, height: 59 }, [90, 90, 90]);
  });
  // The tab strip stays put over a list scrolled under it.
  if (shift) fill(image, { x: 0, y: 0, width, height: Math.round(height * 0.2) }, [49, 50, 51]);
  return png(image);
}

const at = (time: string, area: string, text: string) => `[2026-11-09 ${time} INFO ${area} 316 312] ${text}`;
const level = (id: string) => `Opening level 'C:/users/Steve/AppData/Roaming/Minecraft Bedrock/Users/1/games/com.mojang/minecraftWorlds/${id}/db'`;

/**
 * Debug_Log2026-11-09_11-49-48.txt (screen lines only): the deeplink join raced sign-in, Return dismissed the error
 * screen, the game landed on the Play screen, Escape went to the start screen, a click there opened an Ore UI screen
 * that Escape closed, and a double-click on the start screen opened the Marketplace.
 */
const RACE = [
  at("11:49:50:047", "GUI", "Created 'debug_screen.debug_screen' screen in 0.5ms"),
  at("11:49:50:047", "GUI", "Created 'start.start_screen' screen in 4.6ms"),
  at("11:49:50:053", "LEVEL", "Transfering to world with id of sculkwire-inputlock"),
  at("11:49:50:343", "DATABASE", level("sculkwire-inputlock")),
  at("11:49:51:221", "GUI", "world.cheatsEnabled: 0"),
  at("11:49:51:493", "GUI", "Created 'progress.world_loading_progress_screen' screen in 0.6ms"),
  "[2026-11-09 11:49:51:619 ERROR NETWORK 684 312] LoginPacket failed validation",
  at("11:49:51:620", "NETWORK", "DisconnectPacket"),
  at("11:49:51:637", "GUI", "Pushing disconnect screen from GameConnectionUIUtils::_onDisconnect"),
  at("11:49:51:664", "GUI", "Created 'start.start_screen' screen in 2.1ms"),
  at("11:49:51:667", "GUI", "Created 'start.start_screen' screen in 2.0ms"),
  at("11:49:51:674", "GUI", "Created 'progress.world_saving_progress_screen' screen in 0.5ms"),
  at("11:49:51:687", "GUI", "Destroyed 'world_loading_progress_screen - local_world_load' screen in 0.1ms"),
  at("11:49:51:687", "GUI", "Destroyed 'start_screen' screen in 0.2ms"),
];
const BACK_TO_MENU = [
  at("11:49:54:753", "GUI", "Destroyed 'ui://./hbui/index.html' screen in 0.3ms"),
  at("11:49:55:237", "GUI", "Destroyed 'world_saving_progress_screen - world_loading_progress_screen' screen in 0.2ms"),
  at("11:49:55:811", "GUI", "world.cheatsEnabled: 0"),
  at("11:49:56:921", "GUI", "world.cheatsEnabled: 1"),
];
const ESCAPE_TO_START = [at("11:49:59:804", "GUI", "Destroyed 'ui://./hbui/index.html' screen in 0.3ms")];
const MARKETPLACE = [
  at("11:50:15:087", "GUI", "Destroyed 'ui://./hbui/index.html' screen in 0.3ms"),
  at("11:50:15:988", "GUI", "Created 'store_layout.store_data_driven_screen' screen in 1.0ms"),
];

/** Debug_Log2026-11-08_18-02-29.txt: after "Back to menu" the game re-opened the world by itself. */
const REJOIN = [
  at("18:02:54:242", "GUI", "Destroyed 'ui://./hbui/index.html' screen in 0.3ms"),
  at("18:02:54:654", "GUI", "Destroyed 'world_saving_progress_screen - world_loading_progress_screen' screen in 0.2ms"),
  at("18:02:56:798", "GUI", "Created 'progress.world_loading_progress_screen' screen in 0.6ms"),
  at("18:02:57:000", "DATABASE", level("sculkwire-demo")),
  at("18:02:58:167", "LEVELTRANSITION", "[Client]Level-LevelInitialized"),
  at("18:02:59:332", "SERVER", "Player Spawned: Steve xuid: 2535400000000001"),
  at("18:03:01:134", "GUI", "Created 'hud_crosshair.hud_crosshair_screen' screen in 0.3ms"),
  at("18:03:01:134", "GUI", "Created 'hud.hud_screen' screen in 0.3ms"),
  at("18:03:01:228", "GUI", "Destroyed 'world_loading_progress_screen - local_world_load' screen in 0.1ms"),
  at("18:03:01:237", "GUI", "Destroyed 'start_screen' screen in 0.2ms"),
];

const read = (...chunks: string[][]): ScreenState => chunks.reduce((s, lines) => screensInLog(lines.join("\n"), s), NO_SCREENS);

describe("screen tracking from Debug_Log", () => {
  it("knows the start, Play, loading and error screens of a launch that raced sign-in", () => {
    expect(currentScreen(read(RACE.slice(0, 2)))).toBe("start");
    expect(currentScreen(read(RACE.slice(0, 5)))).toBe("play");
    expect(currentScreen(read(RACE.slice(0, 6)))).toBe("loading");
    // The game builds the start screen under the error screen: the error screen stays on top.
    expect(currentScreen(read(RACE))).toBe("disconnect");
  });

  it("follows Back to menu to the Play screen, Escape to the start screen and a stray click into the Marketplace", () => {
    expect(currentScreen(read(RACE, BACK_TO_MENU.slice(0, 2)))).toBe("start");
    expect(currentScreen(read(RACE, BACK_TO_MENU))).toBe("play");
    expect(currentScreen(read(RACE, BACK_TO_MENU, ESCAPE_TO_START))).toBe("start");
    const store = read(RACE, BACK_TO_MENU, ESCAPE_TO_START, MARKETPLACE);
    expect(currentScreen(store)).toBe("store");
    const back = screensInLog(at("11:51:24:622", "GUI", "Destroyed 'store_data_driven_screen - MultiItemPage_StoreRoot' screen in 0.4ms"), store);
    expect(currentScreen(back)).toBe("start");
    expect(back.changes).toBeGreaterThan(store.changes);
  });

  it("sees the game re-open the world by itself and which world it opened", () => {
    const state = read(RACE, REJOIN);
    expect(currentScreen(state)).toBe("world");
    expect(state.opened).toBe("sculkwire-demo");
    expect(state.inWorld).toBe(true);
    expect(read(RACE).inWorld).toBe(false);
  });

  it("reads a log split across reads like one read", () => {
    const whole = read([...RACE, ...BACK_TO_MENU]);
    const split = [...RACE, ...BACK_TO_MENU].reduce((s, line) => screensInLog(line, s), NO_SCREENS);
    expect(split).toEqual(whole);
  });

  it("ignores overlays and the pause menu returns to the world", () => {
    let s = read(RACE, REJOIN);
    s = screensInLog(at("18:04:00:000", "GUI", "Created 'pause.pause_screen' screen in 0.4ms"), s);
    expect(currentScreen(s)).toBe("pause");
    s = screensInLog(at("18:04:01:000", "GUI", "Created 'toast_screen.toast_screen' screen in 0.4ms"), s);
    expect(currentScreen(s)).toBe("pause");
    s = screensInLog(at("18:04:02:000", "GUI", "Destroyed 'pause_screen' screen in 0.4ms"), s);
    expect(currentScreen(s)).toBe("world");
  });

  it("finds the local world tiles on the Play screen and skips featured servers", () => {
    const image = decodePng(playScreen(["LAN", "LAN", "sculkwire-bridge", "a", "b"])) as Pixels;
    expect(image).toMatchObject({ width: 1280, height: 668, channels: 3 });
    expect(localWorldTiles(image)).toEqual([2, 3, 4]);
    expect(localWorldTiles(decodePng(playScreen([])) as Pixels)).toEqual([]);
  });

  it("sees Ore UI documents opened over the pause and start screens (Debug_Log2026-11-09_13-28-45.txt)", () => {
    let s = read(RACE, REJOIN);
    s = screensInLog(at("13:30:48:365", "GUI", "Created 'pause.pause_screen' screen in 0.5ms"), s);
    s = screensInLog(at("13:30:49:832", "GUI", "Registering query core.commandState with 1 arguments"), s);
    expect(currentScreen(s)).toBe("other");
    s = screensInLog(at("13:31:40:095", "GUI", "Destroyed 'ui://./hbui/index.html' screen in 13.4ms"), s);
    expect(currentScreen(s)).toBe("pause");
    // Save & Quit: the start screen, then the Play screen as a new Ore UI document listing the worlds.
    s = screensInLog(
      [
        at("13:31:42:684", "GUI", "Destroyed 'pause_screen' screen in 4.2ms"),
        at("13:31:42:684", "GUI", "Destroyed 'hud_screen' screen in 0.2ms"),
        at("13:31:42:686", "GUI", "Created 'start.start_screen' screen in 0.8ms"),
        at("13:31:42:687", "GUI", "Registering query core.commandState with 1 arguments"),
      ].join("\n"),
      s,
    );
    expect(currentScreen(s)).toBe("other");
    expect(s.inWorld).toBe(false);
    s = screensInLog(at("13:31:44:532", "GUI", "world.cheatsEnabled: 0"), s);
    expect(currentScreen(s)).toBe("play");
  });
});

type Kind = "disconnect" | "start" | "play" | "store" | "loading" | "world" | "pause" | "options";

interface FakeGameOptions {
  start: Kind;
  /** Where "Back to menu" leads: the game re-opens the world, shows the Play screen, or the start screen. */
  afterBackToMenu?: "rejoin" | "play" | "start";
  /** The Play screen's tiles in reading order: `LAN` for a featured server, else a level id (default 2 servers first). */
  tiles?: string[];
  /** Where the Play button really is (default the known layout). */
  playButton?: { x: number; y: number };
  /** The game never reacts. */
  frozen?: boolean;
  /** No background mouse (Windows). */
  noMouse?: boolean;
  /** The in-game agent is attached: the recovery reads `ui.screen` and presses controls through it. */
  ui?: boolean;
  /** The log names no screens at all, so only `ui.screen` can tell what is up. */
  quiet?: boolean;
  /** The OreUI route the agent reports when the Play screen opens (it then lists the Realms, Worlds and Servers tabs). */
  route?: string;
  /** The first double-click on the test world's tile opens this world instead. */
  opensInstead?: string;
  /** The pause screen's control tree lists Browse Add-ons! but no Save & Quit. */
  noQuitControl?: boolean;
  /** Pixels the list starts scrolled under the tab strip (the first row's tops hidden); each notch up moves it 60 px. */
  shift?: number;
  /**
   * What a double-click on the test world's tile does instead of opening it: `covers` puts a dialog over the Play
   * screen (the World update one: the route stays, the tiles are hidden), `ignores` does nothing at all.
   */
  dialog?: "covers" | "ignores";
  /**
   * Once a world opens, the agent's UI stops answering and the log says nothing (as live on retail while it loads);
   * the caller learns the world is in 5 s later (`inWorld`, the helper's ready print).
   */
  silentLoad?: boolean;
}

/**
 * A scripted game: it answers key presses and clicks with the engine-log lines the real game writes, on a virtual
 * clock, so the recovery runs in milliseconds.
 */
class FakeGame {
  clock = 0;
  pending = "";
  inputs: string[] = [];
  screen: Kind;
  world?: string;
  /** True once a featured-server ("LAN world") tile was opened: a public server join, which must never happen. */
  joinedServer = false;
  /** Rows of tiles the list is scrolled down, and the Play screen's route (when the agent reports one). */
  rows = 0;
  route?: string;
  /** Pixels the list is scrolled under the tab strip. */
  shift = 0;
  /** Every click on the Play screen, as fractions of the frame. */
  playClicks: { x: number; y: number }[] = [];
  /** Worlds opened, in order. */
  opened: string[] = [];
  /** A dialog covers the Play screen (`dialog: covers` after the tile was clicked). */
  dialogUp = false;
  readonly tiles: string[];
  readonly opts: FakeGameOptions;
  constructor(opts: FakeGameOptions) {
    this.opts = opts;
    this.screen = opts.start;
    this.tiles = opts.tiles ?? ["LAN", "LAN", "sculkwire-bridge", "sculkwire-other"];
    if (opts.start === "play") this.route = opts.route;
    this.shift = opts.shift ?? 0;
  }
  /** The tiles on screen: 2 rows of 4 from the scroll position. */
  visible(): string[] {
    return this.tiles.slice(this.rows * 4, this.rows * 4 + 8);
  }
  showPlay(logged = true): void {
    if (logged) this.log("world.cheatsEnabled: 0");
    this.screen = "play";
    this.rows = 0;
    this.route = this.opts.route;
    this.shift = this.opts.shift ?? 0;
  }
  log(text: string): void {
    if (this.opts.quiet && /Created '|Destroyed '|world\.cheatsEnabled: /.test(text)) return;
    if (this.opts.silentLoad && this.world !== undefined) return;
    const s = Math.floor(this.clock / 1000);
    const ms = String(this.clock % 1000).padStart(3, "0");
    this.pending += `${at(`12:00:${String(s % 60).padStart(2, "0")}:${ms}`, "GUI", text)}\n`;
  }
  /** The lines that bring the game to `kind` from a fresh launch (the recovery starts from them). */
  history(): string {
    const lines = [at("11:59:00:000", "GUI", "Created 'start.start_screen' screen in 4.6ms")];
    if (this.screen === "disconnect") return [...RACE].join("\n");
    if (this.screen === "store") lines.push(at("11:59:01:000", "GUI", "Created 'store_layout.store_data_driven_screen' screen in 1ms"));
    if (this.screen === "play") lines.push(at("11:59:01:000", "GUI", "world.cheatsEnabled: 0"));
    if (this.screen === "options") lines.push(at("11:59:01:000", "GUI", "Created 'settings.screen_world_controls_and_settings_fullscreen' screen in 1ms"));
    return lines.join("\n");
  }
  openWorld(id: string): void {
    if (this.opts.opensInstead && id === "sculkwire-bridge" && !this.opened.includes(this.opts.opensInstead)) id = this.opts.opensInstead;
    this.opened.push(id);
    this.log("Created 'progress.world_loading_progress_screen' screen in 0.6ms");
    this.log(level(id));
    this.log("[Client]Level-LevelInitialized");
    this.log("Created 'hud.hud_screen' screen in 0.3ms");
    this.log("Destroyed 'world_loading_progress_screen - local_world_load' screen in 0.1ms");
    this.log("Player Spawned: Steve xuid: 1");
    this.screen = "world";
    this.world = id;
    this.loadedAt = this.clock;
  }
  /** When the world opened, on the fake clock (`silentLoad`). */
  loadedAt = 0;
  near(x: number, y: number, target: { x: number; y: number }): boolean {
    return Math.abs(x - target.x) < 0.04 && Math.abs(y - target.y) < 0.04;
  }
  key(keys: string): void {
    this.inputs.push(keys);
    this.react(keys);
  }
  /** What each screen does with a key, without recording it: the key route and the agent's `ui.key` share it. */
  react(keys: string): void {
    if (this.opts.frozen) return;
    switch (this.screen) {
      case "disconnect":
        if (keys === "Return") this.backToMenu();
        break;
      case "store":
        if (keys === "Escape") {
          this.log("Destroyed 'store_data_driven_screen - MultiItemPage_StoreRoot' screen in 0.4ms");
          this.screen = "start";
        }
        break;
      case "options":
        if (keys === "Escape") {
          this.log("Destroyed 'screen_world_controls_and_settings_fullscreen' screen in 0.4ms");
          this.screen = "start";
        }
        break;
      case "play":
        if (keys === "Escape") {
          this.log("Destroyed 'ui://./hbui/index.html' screen in 0.3ms");
          this.screen = "start";
        }
        break;
      case "world":
        if (keys === "Escape") {
          this.log("Created 'pause.pause_screen' screen in 0.4ms");
          this.screen = "pause";
        }
        break;
      case "pause":
        if (keys === "Escape") {
          this.log("Destroyed 'pause_screen' screen in 0.4ms");
          this.screen = "world";
        }
        break;
    }
  }
  click(x: number, y: number, count: number): void {
    this.inputs.push(`click ${x.toFixed(3)},${y.toFixed(3)}${count > 1 ? ` x${count}` : ""}`);
    this.clickAt(x, y, count);
  }
  /** What each screen does with a click, without recording it: the mouse route and `ui.click` share it. */
  clickAt(x: number, y: number, count: number): void {
    if (this.screen === "play") this.playClicks.push({ x, y });
    if (this.opts.frozen) return;
    if (this.screen === "disconnect" && this.near(x, y, LAYOUT.backToMenu)) this.backToMenu();
    else if (this.screen === "start" && this.near(x, y, this.opts.playButton ?? LAYOUT.play)) this.showPlay();
    else if (this.screen === "play" && count === 2) {
      const tiles = this.visible();
      const slot = [...tiles.keys()].find((i) => this.near(x, y + this.shift / 668, LAYOUT.worldTile(i)));
      const id = slot === undefined ? undefined : tiles[slot];
      if (id === "LAN") this.joinedServer = true;
      else if (id === "sculkwire-bridge" && this.opts.dialog) this.dialogUp ||= this.opts.dialog === "covers";
      else if (id) this.openWorld(id);
    } else if (this.screen === "pause" && this.near(x, y, LAYOUT.saveAndQuit)) {
      this.log("Destroyed 'pause_screen' screen in 0.4ms");
      this.log("Destroyed 'hud_screen' screen in 0.4ms");
      this.showPlay();
      this.world = undefined;
    }
  }
  /** The screen name the agent reports for where the fake game is. */
  uiName(): string {
    switch (this.screen) {
      case "disconnect":
        return "disconnect_screen";
      case "play":
        return this.route ? "ui://./hbui/index.html" : "play_screen";
      case "store":
        return "store_data_driven_screen";
      case "loading":
        return "world_loading_progress_screen";
      case "world":
        return "hud_screen";
      case "pause":
        return "pause_screen";
      case "options":
        return "screen_world_controls_and_settings_fullscreen";
      default:
        return "start_screen";
    }
  }
  /** The controls `ui.controls` lists for the current screen; a store screen lists one that must never be pressed. */
  uiControls(): UiControl[] {
    const rect: [number, number, number, number] = [0, 0, 100, 30];
    switch (this.screen) {
      case "disconnect":
        return [{ name: "button.back", type: "button", rect, text: "Back to menu", enabled: true }];
      case "start":
        return [{ name: "button.play", type: "button", rect, text: "Play", enabled: true }];
      case "pause":
        return [
          { name: "button.store", type: "button", rect, text: "Browse Add-ons!", enabled: true },
          ...(this.opts.noQuitControl ? [] : [{ name: "button.save_and_quit", type: "button" as const, rect, text: "Save & Quit", enabled: true }]),
        ];
      case "store":
        return [{ name: "button.buy", type: "button", rect, text: "Buy Minecoins", enabled: true }];
      case "play":
        return this.route
          ? [
              { name: "tab.realms", type: "button", rect, text: "Realms", enabled: true },
              { name: "tab.worlds", type: "button", rect, text: "Worlds", enabled: true },
              { name: "tab.servers", type: "button", rect, text: "Servers", enabled: true },
            ]
          : [];
      default:
        return [];
    }
  }
  /** `ui.press`: the named control does what pressing it does. A store control is recorded but never acts. */
  uiPress(name: string): void {
    this.inputs.push(`ui:press ${name}`);
    if (this.opts.frozen || this.screen === "store") return;
    if (name === "button.back") this.backToMenu();
    else if (name === "button.play") this.showPlay();
    else if (name === "button.save_and_quit") {
      this.log("Destroyed 'pause_screen' screen in 0.4ms");
      this.log("Destroyed 'hud_screen' screen in 0.4ms");
      this.showPlay(false);
      this.world = undefined;
    } else if (name.startsWith("tab.") && this.screen === "play") this.route = `/play/${name.slice(4)}`;
  }
  uiRoute(): UiRecovery {
    return {
      screen: async () => {
        if (this.opts.silentLoad && this.world !== undefined) throw new Error("anchor_missing: ui.scene_name");
        return {
          name: this.uiName(),
          stack: [this.uiName()],
          modal: false,
          ...(this.screen === "play" && this.route ? { route: this.route } : {}),
        };
      },
      controls: async () => this.uiControls(),
      press: async (name) => this.uiPress(name),
      key: async (keys) => {
        this.inputs.push(`ui:key ${keys}`);
        this.react(keys);
      },
      click: async (x, y, count = 1) => {
        this.inputs.push(`ui:click ${x},${y}${count > 1 ? ` x${count}` : ""}`);
        this.clickAt(x / 1280, y / 668, count);
      },
      scroll: async (x, y, delta) => {
        this.inputs.push(`ui:scroll ${x},${y} ${delta}`);
        if (this.screen === "play" && delta > 0) this.shift = Math.max(0, this.shift - 60 * delta);
        if (this.screen === "play" && delta < 0 && (this.rows + 2) * 4 < this.tiles.length) this.rows++;
      },
    };
  }
  backToMenu(): void {
    this.log("Destroyed 'ui://./hbui/index.html' screen in 0.3ms");
    this.log("Destroyed 'world_saving_progress_screen - world_loading_progress_screen' screen in 0.2ms");
    const after = this.opts.afterBackToMenu ?? "play";
    if (after === "rejoin") this.openWorld("sculkwire-bridge");
    else if (after === "play") this.showPlay();
    else this.screen = "start";
  }
  io(): RecoveryIO {
    return {
      readLog: async () => {
        const text = this.pending;
        this.pending = "";
        return text;
      },
      key: async (keys) => this.key(keys),
      ...(this.opts.noMouse ? {} : { click: async (x: number, y: number, count = 1) => this.click(x, y, count) }),
      ...(this.opts.ui ? { ui: () => this.uiRoute() } : {}),
      screenshot: async (label) => ({
        path: `/tmp/${label}.png`,
        png: this.screen === "play" && !this.dialogUp ? playScreen(this.visible(), this.shift) : playScreen([]),
      }),
      alive: async () => true,
      ...(this.opts.silentLoad ? { inWorld: () => this.world !== undefined && this.clock - this.loadedAt >= 5_000 } : {}),
      sleep: async (ms) => {
        this.clock += ms;
      },
      now: () => this.clock,
    };
  }
}

async function recover(game: FakeGame, extra: { timeoutMs?: number } = {}) {
  const screens = screensInLog(game.history());
  return recoverJoin(game.io(), { levelId: "sculkwire-bridge", thumbnail: testPicture("sculkwire-bridge"), screens, ...extra });
}

/** The one double-click the recovery sent, as fractions of the frame, checked to be on the tile in `slot`. */
function expectTileClick(input: string | undefined, slot: number, ui = false): void {
  const m = ui ? /^ui:click (\d+),(\d+) x2$/.exec(input ?? "") : /^click ([\d.]+),([\d.]+) x2$/.exec(input ?? "");
  expect(m).not.toBeNull();
  const [x, y] = [Number(m?.[1]), Number(m?.[2])];
  const tile = LAYOUT.worldTile(slot);
  expect(Math.abs((ui ? x / 1280 : x) - tile.x)).toBeLessThan(0.01);
  expect(Math.abs((ui ? y / 668 : y) - tile.y)).toBeLessThan(0.01);
}

describe("join recovery state machine", () => {
  it("presses Back to menu with Return and opens the tile showing the world's own picture", async () => {
    const game = new FakeGame({ start: "disconnect", afterBackToMenu: "play" });
    const result = await recover(game);
    expect(result.recovered).toBe(true);
    expect(game.world).toBe("sculkwire-bridge");
    // Slots 1 and 2 are featured servers: the world's picture is on slot 3.
    expect(game.inputs).toHaveLength(2);
    expect(game.inputs[0]).toBe("Return");
    expectTileClick(game.inputs[1], 2);
    expect(game.joinedServer).toBe(false);
    expect(result).toMatchObject({ foundByThumbnail: true, presses: 2, scrolls: 0, opened: ["sculkwire-bridge"] });
    expect(result.steps[0]).toBe("disconnect: Return");
  });

  it("waits while the game re-opens the world by itself after Back to menu", async () => {
    const game = new FakeGame({ start: "disconnect", afterBackToMenu: "rejoin" });
    const result = await recover(game);
    expect(result.recovered).toBe(true);
    expect(game.inputs).toEqual(["Return"]);
  });

  it("goes Play then world tile when Back to menu leaves the start screen", async () => {
    const game = new FakeGame({ start: "disconnect", afterBackToMenu: "start" });
    const result = await recover(game);
    expect(result.recovered).toBe(true);
    expect(game.inputs[0]).toBe("Return");
    expect(game.inputs[1]).toMatch(/^click 0\.500,0\.499$/);
  });

  it("leaves the Marketplace with Escape, then Play and the test world", async () => {
    const game = new FakeGame({ start: "store" });
    const result = await recover(game);
    expect(result.recovered).toBe(true);
    expect(game.inputs[0]).toBe("Escape");
    expect(result.steps.map((s) => s.split(":")[0])).toEqual(["store", "start", "play"]);
  });

  it("starts from the start screen and from an unexpected screen", async () => {
    expect((await recover(new FakeGame({ start: "start" }))).recovered).toBe(true);
    expect((await recover(new FakeGame({ start: "options" }))).recovered).toBe(true);
  });

  it("opens the world's tile, not another world played after it", async () => {
    const game = new FakeGame({ start: "play", tiles: ["sculkwire-other", "LAN", "other-world", "sculkwire-bridge"] });
    const result = await recover(game);
    expect(result.recovered).toBe(true);
    expect(game.opened).toEqual(["sculkwire-bridge"]);
    expectTileClick(game.inputs[0], 3);
  });

  it("never clicks a tile it did not identify: looks, reopens the list once, then stops and says why", async () => {
    const game = new FakeGame({ start: "play", tiles: ["LAN", "sculkwire-other", "other-world", "LAN"] });
    const result = await recover(game);
    expect(result.recovered).toBe(false);
    expect(result.reason).toMatch(/tile of sculkwire-bridge was not found .* world_icon\.jpeg/);
    expect(game.playClicks).toEqual([]);
    expect(game.opened).toEqual([]);
    expect(game.joinedServer).toBe(false);
    expect(result.steps.some((s) => s.includes("leave the Play screen once"))).toBe(true);
  });

  it("never clicks when two tiles show the world's picture, or when the world has no picture", async () => {
    const twins = new FakeGame({ start: "play", tiles: ["sculkwire-bridge", "LAN", "sculkwire-bridge"] });
    const twin = await recover(twins);
    expect(twin.recovered).toBe(false);
    expect(twin.reason).toMatch(/2 tiles on the Play screen show the picture of sculkwire-bridge/);
    expect(twins.playClicks).toEqual([]);
    const plain = new FakeGame({ start: "play" });
    const none = await recoverJoin(plain.io(), { levelId: "sculkwire-bridge", screens: screensInLog(plain.history()) });
    expect(none.recovered).toBe(false);
    expect(none.reason).toMatch(/has no world_icon\.jpeg sculkwire can read/);
    expect(plain.playClicks).toEqual([]);
  });

  it("never opens a featured server's tile, even one showing the same picture", async () => {
    const game = new FakeGame({ start: "play", tiles: ["LAN", "other-world"] });
    const io = game.io();
    const screenshot = io.screenshot;
    // The featured server in slot 0 shows the world's picture; slot 0 has no edit-button divider, so it is not a local world.
    io.screenshot = async (label) => {
      const shot = await screenshot(label);
      if (!shot) return shot;
      const image = decodePng(shot.png) as Pixels;
      const c = LAYOUT.worldTile(0);
      drawPicture(image, { x: c.x * 1280 - 128, y: c.y * 668 - 72, width: 256, height: 144 }, testPicture("sculkwire-bridge"));
      return { path: shot.path, png: png(image) };
    };
    const result = await recoverJoin(io, { levelId: "sculkwire-bridge", thumbnail: testPicture("sculkwire-bridge"), screens: screensInLog(game.history()), timeoutMs: 60_000 });
    expect(result.recovered).toBe(false);
    expect(game.playClicks).toEqual([]);
    expect(game.joinedServer).toBe(false);
  });

  it("leaves a world that opened instead of the test world through Save & Quit, then opens the tile again", async () => {
    const game = new FakeGame({ start: "play", opensInstead: "sculkwire-other" });
    const result = await recover(game);
    expect(result.recovered).toBe(true);
    expect(game.opened).toEqual(["sculkwire-other", "sculkwire-bridge"]);
    expect(result.opened).toEqual(["sculkwire-other", "sculkwire-bridge"]);
    expect(result.steps.some((s) => s.startsWith("opened sculkwire-other"))).toBe(true);
    expect(result.steps.some((s) => s.startsWith("pause: Save & Quit"))).toBe(true);
  });

  it("clicks Back to menu when Return does nothing, and gives up after the time limit without relaunching", async () => {
    const frozen = new FakeGame({ start: "disconnect", frozen: true });
    const result = await recover(frozen, { timeoutMs: 30_000 });
    expect(result.recovered).toBe(false);
    expect(result.reason).toMatch(/within 30 s/);
    expect(frozen.inputs.slice(0, 2)).toEqual(["Return", "click 0.270,0.720"]);
  });

  it("uses the keyboard only when there is no background mouse", async () => {
    const game = new FakeGame({ start: "disconnect", afterBackToMenu: "rejoin", noMouse: true });
    expect((await recover(game)).recovered).toBe(true);
    expect(game.inputs).toEqual(["Return"]);
  });

  it("does not find a moved Play button, and stops at its time limit", async () => {
    const game = new FakeGame({ start: "start", playButton: { x: 0.3, y: 0.6 } });
    const result = await recover(game, { timeoutMs: 60_000 });
    expect(result.recovered).toBe(false);
  });

  it("never clicks on a store screen, only presses Escape", async () => {
    const game = new FakeGame({ start: "store", frozen: true });
    const result = await recover(game, { timeoutMs: 30_000 });
    expect(result.recovered).toBe(false);
    expect(new Set(game.inputs)).toEqual(new Set(["Escape"]));
  });
});

describe("screens from the agent's UI", () => {
  it("reads the stack the game names, with no inference from the log", () => {
    const start = screensFromUi({ name: "start_screen", stack: ["start_screen"], modal: false }, NO_SCREENS);
    expect(currentScreen(start)).toBe("start");
    expect(start.inWorld).toBe(false);
    const pause = screensFromUi({ name: "pause_screen", stack: ["start_screen", "hud_screen", "pause_screen"], modal: false }, start);
    expect(currentScreen(pause)).toBe("pause");
    // A menu over the world is still in the world.
    expect(pause.inWorld).toBe(true);
    expect(pause.changes).toBe(start.changes + 1);
    expect(screensFromUi({ name: "pause_screen", stack: ["hud_screen", "pause_screen"], modal: false }, pause).changes).toBe(pause.changes);
  });

  it("keeps the world the log opened and knows the store screens by their names", () => {
    const opened = { ...NO_SCREENS, opened: "sculkwire-bridge" };
    const loading = screensFromUi({ name: "world_loading_progress_screen", stack: ["world_loading_progress_screen"], modal: false }, opened);
    expect(loading.opened).toBe("sculkwire-bridge");
    expect(kindOfScreenName("store_data_driven_screen")).toBe("store");
    expect(kindOfScreenName("marketplace_screen")).toBe("store");
    expect(kindOfScreenName("hud_screen")).toBe("world");
    expect(kindOfScreenName("start.start_screen")).toBe("start");
    expect(kindOfScreenName("progress.world_loading_progress_screen")).toBe("loading");
    expect(kindOfScreenName("something_new_screen")).toBe("other");
  });

  it("reads the namespaced names the agent reports in a running world", () => {
    expect(kindOfScreenName("play.play_screen")).toBe("play");
    expect(kindOfScreenName("play_screen")).toBe("play");
    expect(kindOfScreenName("hud.hud_screen")).toBe("world");
    expect(kindOfScreenName("store_layout.store_data_driven_screen")).toBe("store");
    expect(kindOfScreenName("store_inventory.armor_screen")).toBe("store");
    expect(kindOfScreenName("marketplace.home_screen")).toBe("store");
    expect(kindOfScreenName("csb.welcome_screen")).toBe("store");
    expect(kindOfScreenName("csb_welcome_screen")).toBe("store");
    expect(screensFromUi({ name: "play.play_screen", stack: ["play.play_screen"], modal: false }, NO_SCREENS)).toMatchObject({
      inWorld: false,
      stack: [{ kind: "play", name: "play.play_screen" }],
    });
    // The overlays the game always keeps are not what the player looks at.
    expect(screensFromUi({ name: "start_screen", stack: ["debug_screen.debug_screen", "start.start_screen"], modal: false }, NO_SCREENS).stack).toEqual([
      { kind: "start", name: "start.start_screen" },
    ]);
  });
});

describe("join recovery through the agent's UI", () => {
  /** A game whose log names no screens at all: only `ui.screen` can tell where it is. */
  const uiOnly = (opts: FakeGameOptions) => new FakeGame({ ui: true, quiet: true, ...opts });
  const start = { levelId: "sculkwire-bridge", thumbnail: testPicture("sculkwire-bridge"), timeoutMs: 60_000 };

  it("reads the screen from ui.screen and presses the named control", async () => {
    const game = uiOnly({ start: "disconnect", afterBackToMenu: "rejoin" });
    const result = await recoverJoin(game.io(), start);
    expect(result.recovered).toBe(true);
    expect(game.world).toBe("sculkwire-bridge");
    expect(game.inputs).toEqual(["ui:press button.back"]);
    expect(result.steps[0]).toBe("disconnect: Return (or press Back to menu)");
  });

  it("presses Play by name wherever the button is drawn, then opens the tile showing the world's picture", async () => {
    const game = uiOnly({ start: "start", playButton: { x: 0.9, y: 0.9 } });
    const result = await recoverJoin(game.io(), start);
    expect(result.recovered).toBe(true);
    expect(game.inputs).toHaveLength(2);
    expect(game.inputs[0]).toBe("ui:press button.play");
    expectTileClick(game.inputs[1], 2, true);
    expect(game.joinedServer).toBe(false);
  });

  it("scrolls the world list when the tile is below it, then opens the tile it finds", async () => {
    const tiles = ["LAN", "LAN", "sculkwire-a", "sculkwire-b", "sculkwire-c", "sculkwire-d", "sculkwire-e", "sculkwire-f", "sculkwire-g", "sculkwire-bridge"];
    const game = uiOnly({ start: "play", tiles });
    const result = await recoverJoin(game.io(), start);
    expect(result.recovered).toBe(true);
    expect(game.opened).toEqual(["sculkwire-bridge"]);
    const scrolled = game.inputs.findIndex((entry) => entry.startsWith("ui:scroll "));
    expect(scrolled).toBeGreaterThanOrEqual(0);
    expect(game.inputs.slice(0, scrolled).some((entry) => entry.startsWith("ui:click"))).toBe(false);
    // One row down: the test world is the sixth visible tile.
    expectTileClick(game.inputs.at(-1), 5, true);
    expect(result).toMatchObject({ foundByThumbnail: true, scrolls: 1 });
  });

  it("never clicks when no tile shows the world's picture: it scrolls, reopens once, then stops", async () => {
    const tiles = ["LAN", "sculkwire-other", ...Array.from({ length: 10 }, (_, i) => `sculkwire-w${i}`)];
    const game = uiOnly({ start: "play", tiles });
    const result = await recoverJoin(game.io(), start);
    expect(result.recovered).toBe(false);
    expect(result.reason).toMatch(/not found on the Play screen/);
    expect(game.playClicks).toEqual([]);
    expect(game.opened).toEqual([]);
    expect(result.scrolls).toBeGreaterThan(0);
    expect(result.foundByThumbnail).toBe(false);
  });

  it("stops at once, pressing nothing more, when a dialog covers the Play screen after the tile click", async () => {
    const game = uiOnly({ start: "play", dialog: "covers" });
    const result = await recoverJoin(game.io(), start);
    expect(result).toMatchObject({ recovered: false, needsUser: true, stuck: "dialog" });
    expect(result.reason).toMatch(/shows a dialog over it .* which sculkwire never confirms/);
    // One double-click on the tile, and nothing after it: never Escape, Return or a press that could answer the dialog.
    expect(game.inputs).toHaveLength(1);
    expectTileClick(game.inputs[0], 2, true);
    expect(game.opened).toEqual([]);
    expect(game.clock).toBeLessThan(30_000);
  });

  it("waits out the agent's UI going quiet after the tile click as the world loading, presses nothing, and ends recovered", async () => {
    const game = uiOnly({ start: "play", silentLoad: true });
    const result = await recoverJoin(game.io(), start);
    expect(result.recovered).toBe(true);
    expect(game.opened).toEqual(["sculkwire-bridge"]);
    // The tile's double-click is the only input: never an Escape that would open the loaded world's pause menu.
    expect(game.inputs).toHaveLength(1);
    expectTileClick(game.inputs[0], 2, true);
    expect(result.steps.some((s) => s.includes("the world is loading"))).toBe(true);
    expect(result.steps.some((s) => s.includes("stopped answering"))).toBe(false);
  });

  it("after two ignored clicks walks the keyboard focus, never activates without the focus ring on the tile, then gives up", async () => {
    const game = uiOnly({ start: "play", dialog: "ignores" });
    const result = await recoverJoin(game.io(), start);
    expect(result).toMatchObject({ recovered: false, needsUser: true, stuck: "ignored" });
    expect(result.reason).toMatch(/double-clicked 2 times and the world did not open, and the keyboard focus did not reach it/);
    expect(game.inputs.filter((i) => i.startsWith("ui:click"))).toHaveLength(2);
    // The fake screen draws no focus ring: arrows only, and never the key that activates.
    const keys = game.inputs.filter((i) => i.startsWith("ui:key"));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => /Down|Up|Left|Right/.test(k))).toBe(true);
    expect(game.clock).toBeLessThan(60_000);
  });

  it("reads the keyboard focus ring, tells whether it sits on the tile's open button, and which arrow moves it there", () => {
    const width = 400;
    const height = 300;
    const data = new Uint8Array(width * height * 3).fill(40);
    const paint = (x: number, y: number) => data.fill(255, (y * width + x) * 3, (y * width + x) * 3 + 3);
    // A ring around 20..120 x 150..190, two pixels wide.
    for (let x = 20; x <= 120; x++) for (const y of [150, 151, 189, 190]) paint(x, y);
    for (let y = 150; y <= 190; y++) for (const x of [20, 21, 119, 120]) paint(x, y);
    const ring = focusRing({ width, height, channels: 3, data });
    expect(ring).toMatchObject({ x: 20, y: 150, width: 101 });
    const button = tileOpenButton({ x: 20, y: 40, width: 125, height: 110 });
    expect(ringOn(ring!, button)).toBe(true);
    expect(ringOn(ring!, tileOpenButton({ x: 200, y: 40, width: 125, height: 110 }))).toBe(false);
    expect(arrowTowards(ring!, tileOpenButton({ x: 200, y: 40, width: 125, height: 110 }))).toBe("Right");
    expect(arrowTowards({ x: 250, y: 20, width: 100, height: 30 }, button)).toBe("Down");
    // A filled light control is no ring.
    const filled = new Uint8Array(width * height * 3).fill(40);
    for (let y = 150; y <= 190; y++) filled.fill(255, (y * width + 20) * 3, (y * width + 121) * 3);
    expect(focusRing({ width, height, channels: 3, data: filled })).toBeUndefined();
  });

  it("selects the Worlds tab by its name, never presses or clicks another tab, and never clicks the tab strip", async () => {
    const game = uiOnly({ start: "play", route: "/play/realms" });
    const result = await recoverJoin(game.io(), start);
    expect(result.recovered).toBe(true);
    expect(game.inputs[0]).toBe("ui:press tab.worlds");
    expect(game.inputs.filter((entry) => entry.startsWith("ui:press tab."))).toEqual(["ui:press tab.worlds"]);
    // The tab strip is above the tiles: every click on the Play screen landed on a tile's thumbnail.
    expect(game.playClicks.length).toBe(1);
    expect(game.playClicks.every((c) => c.y > 0.25)).toBe(true);
    expect(result.seen).toContain("ui://./hbui/index.html /play/realms");
    expect(result.seen).toContain("ui://./hbui/index.html /play/worlds");
  });

  it("knows the Play screen and its tab from the OreUI route", () => {
    expect(kindOfRoute("/play/all")).toBe("play");
    expect(kindOfRoute("/play?tab=worlds")).toBe("play");
    expect(kindOfRoute("/marketplace/store")).toBe("store");
    expect(kindOfRoute("/player-permissions")).toBeUndefined();
    expect(playTab("/play")).toBe("all");
    expect(playTab("/play/worlds")).toBe("worlds");
    expect(playTab("/play?tab=Realms")).toBe("realms");
    expect(playTab(null)).toBeUndefined();
    expect(screensFromUi({ name: "ui://./hbui/index.html", stack: ["ui://./hbui/index.html"], modal: false, route: "/play/all" }, NO_SCREENS).stack).toEqual([
      { kind: "play", name: "ui://./hbui/index.html" },
    ]);
  });

  it("scrolls a tile cut off under the tab strip into view instead of away, then opens it", async () => {
    const game = uiOnly({ start: "play", tiles: ["sculkwire-bridge", "sculkwire-a"], shift: 110 });
    const result = await recoverJoin(game.io(), start);
    expect(result.recovered).toBe(true);
    expect(game.opened).toEqual(["sculkwire-bridge"]);
    const scrolls = game.inputs.filter((entry) => entry.startsWith("ui:scroll "));
    expect(scrolls.length).toBeGreaterThan(0);
    expect(scrolls.every((entry) => entry.endsWith(" 2"))).toBe(true);
    expect(result.steps.some((s) => s.includes("into view (its top is hidden)"))).toBe(true);
  });

  it("leaves a wrong world by pressing Save & Quit by name, and never clicks near it when it is not listed", async () => {
    const named = uiOnly({ start: "play", opensInstead: "sculkwire-other" });
    expect((await recoverJoin(named.io(), start)).recovered).toBe(true);
    expect(named.inputs).toContain("ui:press button.save_and_quit");
    expect(named.inputs).not.toContain("ui:press button.store");
    const unlisted = uiOnly({ start: "play", opensInstead: "sculkwire-other", noQuitControl: true });
    const result = await recoverJoin(unlisted.io(), { ...start, timeoutMs: 40_000 });
    expect(result.recovered).toBe(false);
    expect(unlisted.inputs.filter((entry) => entry.startsWith("ui:click"))).toHaveLength(1);
    expect(unlisted.inputs).not.toContain("ui:press button.store");
    expect(result.steps.some((s) => s.includes("lists no Save & Quit control"))).toBe(true);
  });

  it("clicks through the agent when the platform has no background mouse", async () => {
    const game = uiOnly({ start: "play", noMouse: true });
    const result = await recoverJoin(game.io(), start);
    expect(result.recovered).toBe(true);
    expect(game.inputs.every((entry) => /^ui:(press|key|click) /.test(entry))).toBe(true);
  });

  it("only ever presses Escape on a store screen", async () => {
    const game = uiOnly({ start: "store", frozen: true });
    const result = await recoverJoin(game.io(), { ...start, timeoutMs: 30_000 });
    expect(result.recovered).toBe(false);
    expect(game.inputs.length).toBeGreaterThan(0);
    expect(new Set(game.inputs)).toEqual(new Set(["ui:key Escape"]));
  });

  it("falls back to the log and the keys when the agent's UI stops answering", async () => {
    const game = new FakeGame({ start: "disconnect", afterBackToMenu: "rejoin", ui: true });
    const io = game.io();
    io.ui = () => ({
      screen: async () => {
        throw new Error("ui.screen timed out");
      },
      controls: async () => [],
      press: async () => undefined,
      key: async () => undefined,
      click: async () => undefined,
    });
    const result = await recoverJoin(io, { ...start, screens: screensInLog(game.history()) });
    expect(result.recovered).toBe(true);
    expect(result.steps.some((step) => step.startsWith("the agent's UI stopped answering"))).toBe(true);
    expect(game.inputs.length).toBeGreaterThan(0);
    expect(game.inputs.every((entry) => !entry.startsWith("ui:"))).toBe(true);
  });
});

describe("Save & Quit before a stop", () => {
  /**
   * A retail-like pause menu whose controls cannot be read: four full-width buttons (Resume Game, Settings, Browse
   * Add-ons!, Save & Quit) over an icon row, the focused one filled green. `blank` lists the frames (by screenshot
   * number) that show no focus at all, as a missed frame would. Down and Up move the focus; Return on Save & Quit
   * leaves the world, Return anywhere else is recorded.
   */
  function focusMenu(blank: number[] = []) {
    const buttons = [0, 1, 2, 3].map((i) => ({ x: 115, y: 150 + i * 62, width: 334, height: 50 }));
    const icons = { x: 200, y: 410, width: 44, height: 30 };
    let focus = 0;
    let shots = 0;
    let left = false;
    const keys: string[] = [];
    let clock = 0;
    const draw = (): Buffer => {
      const width = 960;
      const height = 540;
      const data = new Uint8Array(width * height * 3).fill(60);
      const shown = blank.includes(shots) ? -1 : focus;
      const boxes = [...buttons, icons];
      boxes.forEach((b, i) => {
        const colour = i === shown ? [31, 125, 15] : [200, 200, 200];
        for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) data.set(colour, (y * width + x) * 3);
      });
      shots++;
      return png({ width, height, channels: 3, data });
    };
    const ui: UiRecovery = {
      screen: async () => (left ? { name: "start_screen", stack: ["start_screen"], modal: false } : { name: "pause_screen", stack: ["pause_screen"], modal: false }),
      controls: async () => [],
      press: async () => {
        throw new Error("no such control");
      },
      key: async (k) => {
        keys.push(k);
        if (k === "Down") focus = Math.min(focus + 1, 4);
        if (k === "Up") focus = Math.max(focus - 1, 0);
        if (k === "Return" && focus === 3) left = true;
      },
      click: async () => {
        throw new Error("no clicks");
      },
    };
    const io: RecoveryIO = {
      readLog: async () => "",
      key: async () => undefined,
      ui: () => ui,
      screenshot: async () => ({ path: "pause.png", png: draw() }),
      alive: async () => true,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    return { io, keys, returnedOn: () => (keys.includes("Return") ? focus : undefined), left: () => left };
  }

  it("reaches Save & Quit by the keyboard focus on a pause menu whose controls cannot be read, and presses Return only there", async () => {
    const menu = focusMenu();
    const result = await leaveWorld(menu.io, { screens: screensFromUi({ name: "pause_screen", stack: ["pause_screen"], modal: false }, NO_SCREENS) });
    expect(result.left).toBe(true);
    expect(menu.keys).toEqual(["Down", "Down", "Down", "Down", "Up", "Return"]);
    expect(menu.returnedOn()).toBe(3);
  });

  it("never moves back up on a frame that shows no focus, so a missed frame cannot land Return on Browse Add-ons!", async () => {
    // Frames 0-2 show Resume, Settings, Browse Add-ons!; frame 3 (focus on Save & Quit) is missed, then all are.
    const menu = focusMenu([3, 4, 5, 6, 7, 8, 9]);
    const result = await leaveWorld(menu.io, { screens: screensFromUi({ name: "pause_screen", stack: ["pause_screen"], modal: false }, NO_SCREENS) });
    expect(result.left).toBe(false);
    expect(result.reason).toMatch(/could not be seen/);
    expect(menu.keys).not.toContain("Up");
    expect(menu.keys).not.toContain("Return");
  });

  /** A game in the user's world, and the screen state the bridge has read so far. */
  function inWorld(opts: Partial<FakeGameOptions> = {}): { game: FakeGame; screens: ScreenState } {
    const game = new FakeGame({ start: "start", ...opts });
    game.openWorld("Xy+z=");
    const screens = screensInLog(`${game.history()}\n${game.pending}`);
    game.pending = "";
    return { game, screens };
  }

  it("opens the pause menu with Escape and clicks Save & Quit with the background mouse", async () => {
    const { game, screens } = inWorld();
    const result = await leaveWorld(game.io(), { screens });
    expect(result).toMatchObject({ left: true, presses: 2 });
    expect(game.inputs).toEqual(["Escape", `click ${LAYOUT.saveAndQuit.x.toFixed(3)},${LAYOUT.saveAndQuit.y.toFixed(3)}`]);
    expect(game.world).toBeUndefined();
    // The pause menu is given its settle time first: a click in its first seconds lands on Resume Game.
    expect(game.clock).toBeGreaterThanOrEqual(4000);
  });

  it("presses Save & Quit by its name through the agent's UI, never the store entry next to it", async () => {
    const { game, screens } = inWorld({ ui: true, quiet: true });
    const result = await leaveWorld(game.io(), { screens });
    expect(result.left).toBe(true);
    expect(game.inputs).toEqual(["ui:key Escape", "ui:press button.save_and_quit"]);
  });

  it("gives up without pressing or clicking anything, and never sends Return, when the pause menu lists no Save & Quit control and shows no focus", async () => {
    const { game, screens } = inWorld({ ui: true, quiet: true, noQuitControl: true });
    const result = await leaveWorld(game.io(), { screens });
    expect(result.left).toBe(false);
    expect(result.reason).toMatch(/Save & Quit/);
    expect(game.inputs.filter((entry) => entry.startsWith("ui:press") || entry.startsWith("ui:click"))).toEqual([]);
    expect(game.inputs.filter((entry) => /Return/.test(entry))).toEqual([]);
    expect(game.world).toBe("Xy+z=");
  });

  it("finds the focused (green) button of a menu, wide or narrow, and not the grass behind it", () => {
    const width = 960;
    const height = 540;
    const data = new Uint8Array(width * height * 3);
    // Grass behind: greenish but not saturated.
    for (let i = 0; i < data.length; i += 3) data.set([90, 140, 60], i);
    const fill = (x0: number, y0: number, w: number, h: number) => {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set([31, 125, 15], (y * width + x) * 3);
    };
    fill(115, 340, 334, 50);
    // Label letters across the button break its fill.
    for (let x = 200; x < 360; x += 6) for (let y = 355; y < 375; y++) data.set([255, 255, 255], (y * width + x) * 3);
    expect(focusedButton({ width, height, channels: 3, data })).toMatchObject({ x: 115, y: 340, width: 334, height: 50 });
    const grass = new Uint8Array(width * height * 3);
    for (let i = 0; i < grass.length; i += 3) grass.set([90, 140, 60], i);
    expect(focusedButton({ width, height, channels: 3, data: grass })).toBeUndefined();
  });

  it("says it cannot press Save & Quit without the agent or a mouse", async () => {
    const { game, screens } = inWorld({ noMouse: true });
    const result = await leaveWorld(game.io(), { screens });
    expect(result).toMatchObject({ left: false, reason: "Save & Quit cannot be pressed: no in-game agent UI and no background mouse reach this game" });
  });

  it(`stops trying after ${LEAVE_TIMEOUT_MS / 1000} s when the game does not react`, async () => {
    const { game, screens } = inWorld({ frozen: true });
    const result = await leaveWorld(game.io(), { screens });
    expect(result.left).toBe(false);
    expect(result.reason).toContain(`within ${LEAVE_TIMEOUT_MS / 1000} s`);
    expect(game.clock).toBeLessThanOrEqual(LEAVE_TIMEOUT_MS + 1000);
  });

  it("returns at once when the game is already out of the world", async () => {
    const game = new FakeGame({ start: "start" });
    const result = await leaveWorld(game.io(), { screens: screensInLog(game.history()) });
    expect(result).toMatchObject({ left: true, presses: 0 });
  });
});

describe("respawn on the death screen", () => {
  const FRAME = { width: 1280, height: 668 };
  /** RESPAWN and "Game menu" as fractions of the height: where one window had them, and another a bit lower. */
  const HIGH = { respawn: [0.64, 0.68], menu: [0.71, 0.75] } as const;
  const LOW = { respawn: [0.69, 0.75], menu: [0.765, 0.83] } as const;
  type Layout = typeof HIGH | typeof LOW;

  /** A death screen: dark red-tinted world, the green RESPAWN with its white label, the grey "Game menu" under it. */
  function deathScreen(size: { width: number; height: number }, layout: Layout): Buffer {
    const image = frame(size.width, size.height, 0);
    fill(image, { x: 0, y: 0, width: size.width, height: size.height }, [70, 40, 45]);
    const button = (span: readonly [number, number], colour: readonly [number, number, number]) =>
      fill(image, { x: size.width / 2 - 0.22 * size.height, y: span[0] * size.height, width: 0.44 * size.height, height: (span[1] - span[0]) * size.height }, colour);
    button(layout.respawn, [42, 100, 28]);
    fill(image, { x: size.width / 2 - 0.06 * size.height, y: (layout.respawn[0] + 0.015) * size.height, width: 0.12 * size.height, height: 0.025 * size.height }, [255, 255, 255]);
    button(layout.menu, [208, 209, 212]);
    return png(image);
  }
  const RESPAWN_BUTTON: UiControl = { name: "button.respawn_button", type: "button", rect: [540, 425, 200, 40], text: "Respawn", enabled: true };
  const GAME_MENU: UiControl = { name: "button.main_menu_button", type: "button", rect: [540, 475, 200, 40], text: "Game menu", enabled: true };

  /**
   * A game showing the death screen over the HUD. RESPAWN (pressed by name, or clicked on its button) brings the HUD
   * back with full health, unless `ignores`; "Game menu" leaves for the start screen.
   */
  function deathGame(
    opts: { ui?: boolean; controls?: UiControl[]; enabledAtMs?: number; mouse?: boolean; ignores?: boolean; screen?: "death" | "hud"; health?: number; layout?: Layout; blank?: boolean } = {},
  ) {
    const layout = opts.layout ?? HIGH;
    let clock = 0;
    let screen = opts.screen === "hud" ? "hud_screen" : "death_screen";
    let health = opts.health ?? 0;
    const inputs: string[] = [];
    const onRespawn = (y: number) => y > layout.respawn[0] && y < layout.respawn[1];
    const onMenu = (y: number) => y > layout.menu[0] && y < layout.menu[1];
    const revive = () => {
      if (opts.ignores) return;
      screen = "hud_screen";
      health = 20;
    };
    const ui: UiRecovery = {
      screen: async () => ({ name: screen, stack: screen === "death_screen" ? ["hud_screen", "death_screen"] : [screen], modal: false }),
      controls: async () => (screen === "death_screen" ? (opts.controls ?? [{ ...RESPAWN_BUTTON, enabled: clock >= (opts.enabledAtMs ?? 0) }, GAME_MENU]) : []),
      press: async (name) => {
        inputs.push(`ui:press ${name}`);
        if (name === RESPAWN_BUTTON.name) revive();
        if (name === GAME_MENU.name) screen = "start_screen";
      },
      key: async (key) => void inputs.push(`ui:key ${key}`),
      click: async (x, y) => {
        inputs.push(`ui:click ${x},${y}`);
        if (screen === "death_screen" && onRespawn(y / FRAME.height)) revive();
        else if (screen === "death_screen" && onMenu(y / FRAME.height)) screen = "start_screen";
      },
    };
    const io: RecoveryIO = {
      readLog: async () => "",
      key: async (keys) => void inputs.push(`key ${keys}`),
      ...(opts.mouse
        ? {
            click: async (x: number, y: number) => {
              inputs.push(`click ${x.toFixed(3)},${y.toFixed(3)}`);
              if (onRespawn(y)) revive();
              else if (onMenu(y)) screen = "start_screen";
            },
          }
        : {}),
      ...(opts.ui ? { ui: () => ui } : {}),
      screenshot: async (label) => ({
        path: `${label}.png`,
        png: opts.blank || screen !== "death_screen" ? png(frame(FRAME.width, FRAME.height, 40)) : deathScreen(FRAME, layout),
      }),
      alive: async () => true,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    /** Whether every click so far landed on RESPAWN (as fractions of the frame), never on "Game menu". */
    const clickedRespawn = () =>
      inputs
        .filter((i) => i.includes("click"))
        .every((i) => {
          const y = Number(i.split(",")[1]);
          return onRespawn(i.startsWith("ui:") ? y / FRAME.height : y);
        });
    return { io, inputs, health: () => health, clock: () => clock, screen: () => screen, clickedRespawn };
  }

  it("knows the death screen from the agent's name and from the engine log", () => {
    expect(kindOfScreenName("death_screen")).toBe("death");
    const s = screensInLog([at("12:00:00:000", "GUI", "Created 'hud.hud_screen' screen in 1ms"), at("12:00:05:000", "GUI", "Created 'death.death_screen' screen in 1ms")].join("\n"));
    expect(currentScreen(s)).toBe("death");
    expect(currentScreen(screensInLog(at("12:00:09:000", "GUI", "Destroyed 'death_screen' screen"), s))).toBe("world");
  });

  it("presses RESPAWN by its control name, waiting while it is greyed out, never Game menu", async () => {
    const game = deathGame({ ui: true, enabledAtMs: 2000 });
    const r = await respawn(game.io, { health: game.health });
    expect(r).toMatchObject({ wasDead: true, respawned: true, via: "press", presses: 1 });
    expect(game.inputs).toEqual(["ui:press button.respawn_button"]);
    expect(game.clock()).toBeGreaterThanOrEqual(2000);
    expect(r.steps[0]).toMatch(/not enabled yet/);
  });

  it("clicks RESPAWN where the screenshot shows it, through the agent when the screen lists no RESPAWN control", async () => {
    const game = deathGame({ ui: true, controls: [GAME_MENU] });
    const r = await respawn(game.io, { health: game.health });
    expect(r).toMatchObject({ respawned: true, via: "click" });
    expect(game.inputs).toHaveLength(1);
    expect(game.inputs[0]).toMatch(/^ui:click 640,/);
    expect(game.clickedRespawn()).toBe(true);
  });

  it("finds RESPAWN wherever the frame puts it, never clicking Game menu at RESPAWN's place in another window", async () => {
    for (const layout of [HIGH, LOW]) {
      const game = deathGame({ mouse: true, layout });
      const r = await respawn(game.io, { health: game.health });
      expect(r).toMatchObject({ wasDead: true, respawned: true, via: "click" });
      expect(game.clickedRespawn()).toBe(true);
      expect(game.screen()).toBe("hud_screen");
    }
  });

  it("never clicks blind: no RESPAWN on the screen means no click, and the reason after the time limit", async () => {
    const game = deathGame({ mouse: true, blank: true });
    const r = await respawn(game.io, { health: game.health });
    expect(r).toMatchObject({ respawned: false, presses: 0 });
    expect(r.steps[0]).toMatch(/RESPAWN is not on the screen/);
    expect(game.inputs).toEqual([]);
  });

  it("clicks with the background mouse when the log still reads the world but health 0 says the player died", async () => {
    // The engine log does not always name the death screen: the HUD it last created is all it knows.
    const game = deathGame({ mouse: true });
    const screens = screensInLog(at("12:00:00:000", "GUI", "Created 'hud.hud_screen' screen in 1ms"));
    expect(currentScreen(screens)).toBe("world");
    const r = await respawn(game.io, { health: game.health, screens });
    expect(r).toMatchObject({ wasDead: true, respawned: true, via: "click" });
    expect(game.inputs).toHaveLength(1);
    expect(game.clickedRespawn()).toBe(true);
  });

  it("gives up after its time limit with a reason, never pressing Game menu or a key", async () => {
    const game = deathGame({ ui: true, ignores: true });
    const r = await respawn(game.io, { health: game.health });
    expect(r.respawned).toBe(false);
    expect(r.reason).toContain(`did not respawn within ${RESPAWN_TIMEOUT_MS / 1000} s`);
    expect(game.clock()).toBeLessThanOrEqual(RESPAWN_TIMEOUT_MS + 1000);
    // By name twice, then at RESPAWN's place.
    expect(game.inputs.slice(0, 3)).toEqual(["ui:press button.respawn_button", "ui:press button.respawn_button", expect.stringMatching(/^ui:click /)]);
    expect(game.inputs.filter((i) => i.includes("main_menu") || i.includes("key"))).toEqual([]);
    expect(game.screen()).toBe("death_screen");
  });

  it("says why when nothing can press RESPAWN, and leaves a living player alone", async () => {
    const stuck = deathGame();
    expect(await respawn(stuck.io, { health: stuck.health })).toMatchObject({ respawned: false, reason: expect.stringMatching(/no in-game agent UI and no background mouse/) });
    const alive = deathGame({ ui: true, screen: "hud", health: 20 });
    expect(await respawn(alive.io, { health: alive.health })).toMatchObject({ wasDead: false, respawned: false, presses: 0 });
    expect(alive.inputs).toEqual([]);
  });

  it("does not try Save & Quit over the death screen", async () => {
    const game = deathGame({ ui: true });
    const r = await leaveWorld(game.io);
    expect(r).toMatchObject({ left: false, reason: expect.stringMatching(/respawn first/) });
    expect(game.inputs).toEqual([]);
  });
});
