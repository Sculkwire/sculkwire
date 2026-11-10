import { describe, expect, it } from "vitest";
import type { Decision, DecisionModel, DecisionState, Question } from "../../decision/types.ts";
import { crc32, deflateSync } from "node:zlib";
import type { UiControl } from "../engine/ui.ts";
import {
  currentScreen,
  decodePng,
  kindOfScreenName,
  LAYOUT,
  localWorldTiles,
  NO_SCREENS,
  pngSize,
  recoverJoin,
  screensFromUi,
  screensInLog,
  type Pixels,
  type RecoveryIO,
  type ScreenState,
  type UiRecovery,
} from "./screens.ts";

/**
 * A 1280x668 RGB PNG of the Play screen's name rows as the game draws them: dark rows, and on local worlds the light
 * divider before the edit button. Rows use PNG filter 1 (Sub) so the decoder's filters are exercised.
 */
function playScreen(tiles: readonly string[]): Buffer {
  const width = 1280;
  const height = 668;
  const pixels = new Uint8Array(width * height * 3).fill(72);
  tiles.forEach((tile, slot) => {
    if (tile === "LAN" || slot > 7) return;
    const x = Math.round((0.1992 + (slot % 4) * 0.2375) * width);
    const top = Math.round((slot < 4 ? 0.4985 : 0.864) * height);
    for (let y = top; y < top + 59; y++) for (let c = 0; c < 3; c++) pixels[(y * width + x) * 3 + c] = 90;
  });
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 1;
    for (let i = 0; i < width * 3; i++) {
      const left = i >= 3 ? (pixels[y * width * 3 + i - 3] ?? 0) : 0;
      raw[y * (width * 3 + 1) + 1 + i] = ((pixels[y * width * 3 + i] ?? 0) - left) & 0xff;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
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

  it("reads PNG sizes", () => {
    const png = Buffer.alloc(24);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1280, 16);
    png.writeUInt32BE(668, 20);
    expect(pngSize(png)).toEqual({ width: 1280, height: 668 });
    expect(pngSize(Buffer.alloc(8))).toBeUndefined();
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
  readonly tiles: string[];
  readonly opts: FakeGameOptions;
  constructor(opts: FakeGameOptions) {
    this.opts = opts;
    this.screen = opts.start;
    this.tiles = opts.tiles ?? ["LAN", "LAN", "sculkwire-bridge", "sculkwire-other"];
  }
  log(text: string): void {
    if (this.opts.quiet && /Created '|Destroyed '|world\.cheatsEnabled: /.test(text)) return;
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
    this.log("Created 'progress.world_loading_progress_screen' screen in 0.6ms");
    this.log(level(id));
    this.log("[Client]Level-LevelInitialized");
    this.log("Created 'hud.hud_screen' screen in 0.3ms");
    this.log("Destroyed 'world_loading_progress_screen - local_world_load' screen in 0.1ms");
    this.log("Player Spawned: Steve xuid: 1");
    this.screen = "world";
    this.world = id;
  }
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
    if (this.opts.frozen) return;
    if (this.screen === "disconnect" && this.near(x, y, LAYOUT.backToMenu)) this.backToMenu();
    else if (this.screen === "start" && this.near(x, y, this.opts.playButton ?? LAYOUT.play)) {
      this.log("world.cheatsEnabled: 0");
      this.screen = "play";
    } else if (this.screen === "play" && count === 2) {
      const slot = [...this.tiles.keys()].find((i) => this.near(x, y, LAYOUT.worldTile(i)));
      const id = slot === undefined ? undefined : this.tiles[slot];
      if (id === "LAN") this.joinedServer = true;
      else if (id) this.openWorld(id);
    } else if (this.screen === "pause" && this.near(x, y, LAYOUT.saveAndQuit)) {
      this.log("Destroyed 'pause_screen' screen in 0.4ms");
      this.log("Destroyed 'hud_screen' screen in 0.4ms");
      this.log("world.cheatsEnabled: 0");
      this.screen = "play";
      this.world = undefined;
    }
  }
  /** The screen name the agent reports for where the fake game is. */
  uiName(): string {
    switch (this.screen) {
      case "disconnect":
        return "disconnect_screen";
      case "play":
        return "play_screen";
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
        return [{ name: "button.save_and_quit", type: "button", rect, text: "Save & Quit", enabled: true }];
      case "store":
        return [{ name: "button.buy", type: "button", rect, text: "Buy Minecoins", enabled: true }];
      default:
        return [];
    }
  }
  /** `ui.press`: the named control does what pressing it does. A store control is recorded but never acts. */
  uiPress(name: string): void {
    this.inputs.push(`ui:press ${name}`);
    if (this.opts.frozen || this.screen === "store") return;
    if (name === "button.back") this.backToMenu();
    else if (name === "button.play") {
      this.log("world.cheatsEnabled: 0");
      this.screen = "play";
    } else if (name === "button.save_and_quit") {
      this.log("Destroyed 'pause_screen' screen in 0.4ms");
      this.log("Destroyed 'hud_screen' screen in 0.4ms");
      this.screen = "play";
      this.world = undefined;
    }
  }
  uiRoute(): UiRecovery {
    return {
      screen: async () => ({ name: this.uiName(), stack: [this.uiName()], modal: false }),
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
    };
  }
  backToMenu(): void {
    this.log("Destroyed 'ui://./hbui/index.html' screen in 0.3ms");
    this.log("Destroyed 'world_saving_progress_screen - world_loading_progress_screen' screen in 0.2ms");
    const after = this.opts.afterBackToMenu ?? "play";
    if (after === "rejoin") this.openWorld("sculkwire-bridge");
    else if (after === "play") {
      this.log("world.cheatsEnabled: 0");
      this.screen = "play";
    } else this.screen = "start";
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
      ...(this.opts.ui ? { ui: this.uiRoute() } : {}),
      screenshot: async (label) => ({ path: `/tmp/${label}.png`, png: this.screen === "play" ? playScreen(this.tiles) : playScreen([]) }),
      alive: async () => true,
      sleep: async (ms) => {
        this.clock += ms;
      },
      now: () => this.clock,
    };
  }
}

async function recover(game: FakeGame, extra: { advisor?: DecisionModel; timeoutMs?: number } = {}) {
  const screens = screensInLog(game.history());
  return recoverJoin(game.io(), { levelId: "sculkwire-bridge", worldName: "sculkwire-bridge", screens, ...extra });
}

describe("join recovery state machine (no decision model)", () => {
  it("presses Back to menu with Return and opens the test world from the Play screen", async () => {
    const game = new FakeGame({ start: "disconnect", afterBackToMenu: "play" });
    const result = await recover(game);
    expect(result.recovered).toBe(true);
    expect(game.world).toBe("sculkwire-bridge");
    // Slots 1 and 2 are featured servers: the first local world is slot 3.
    expect(game.inputs).toEqual(["Return", `click ${LAYOUT.worldTile(2).x.toFixed(3)},${LAYOUT.worldTile(2).y.toFixed(3)} x2`]);
    expect(game.joinedServer).toBe(false);
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

  it("leaves a wrong world through the pause menu and tries the next tile", async () => {
    const game = new FakeGame({ start: "play", tiles: ["LAN", "other-world", "sculkwire-bridge"] });
    const result = await recover(game);
    expect(result.recovered).toBe(true);
    expect(game.world).toBe("sculkwire-bridge");
    expect(result.steps.some((s) => s.startsWith("opened other-world"))).toBe(true);
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
});

/** A fake decision model that answers the screen Choice and finds buttons with a Box at fixed places. */
function fakeAdvisor(places: Record<string, { x: number; y: number }>, screen?: string) {
  const calls: Record<string, Question>[] = [];
  const model: DecisionModel = {
    label: "fake",
    images: true,
    async decide(state: DecisionState, questions: Record<string, Question>): Promise<Decision> {
      calls.push(questions);
      expect(Array.isArray(state) && state.some((p) => typeof p !== "string")).toBe(true);
      const answers: Decision["answers"] = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === "choice") answers[id] = { type: "choice", choice: screen ?? "start", probabilities: {} };
        else if (q.type === "noul") answers[id] = { type: "noul", noul: Object.keys(places).some((k) => q.instructions.includes(k)) ? 0.9 : 0.1 };
        else if (q.type === "box") {
          const p = Object.entries(places).find(([k]) => q.instructions.includes(k))?.[1] ?? { x: 0.01, y: 0.01 };
          answers[id] = { type: "box", box: { left: p.x - 0.05, right: p.x + 0.05, top: p.y - 0.02, bottom: p.y + 0.02 }, confidence: 0.9 };
        }
      }
      return { answers, latencyMs: 1 };
    },
  };
  return { model, calls };
}

describe("join recovery with a decision model as advisor", () => {
  it("is not asked while the fixed presses work", async () => {
    const { model, calls } = fakeAdvisor({ "Play button": LAYOUT.play });
    const result = await recover(new FakeGame({ start: "store" }), { advisor: model });
    expect(result.recovered).toBe(true);
    expect(calls).toEqual([]);
  });

  it("finds a moved Play button with a Box after the fixed presses failed", async () => {
    const moved = { x: 0.3, y: 0.6 };
    const { model, calls } = fakeAdvisor({ "Play button": moved }, "start");
    const game = new FakeGame({ start: "start", playButton: moved });
    const result = await recover(game, { advisor: model });
    expect(result.recovered).toBe(true);
    expect(calls.some((q) => q.screen?.type === "choice")).toBe(true);
    expect(calls.some((q) => q.target?.type === "box")).toBe(true);
    expect(game.inputs).toContain("click 0.300,0.600");
  });

  it("without a model the same moved button is not found, and the recovery stops at its time limit", async () => {
    const game = new FakeGame({ start: "start", playButton: { x: 0.3, y: 0.6 } });
    const result = await recover(game, { timeoutMs: 60_000 });
    expect(result.recovered).toBe(false);
  });

  it("never asks the advisor or clicks on a store screen, only presses Escape", async () => {
    const { model, calls } = fakeAdvisor({ "Play button": LAYOUT.play }, "start");
    const game = new FakeGame({ start: "store", frozen: true });
    const result = await recover(game, { advisor: model, timeoutMs: 30_000 });
    expect(result.recovered).toBe(false);
    expect(calls).toEqual([]);
    expect(new Set(game.inputs)).toEqual(new Set(["Escape"]));
  });

  it("acts on the advisor's screen when it disagrees with the log", async () => {
    // The log says start, the screenshot shows a store screen: Escape instead of Play.
    const { model } = fakeAdvisor({}, "store");
    const game = new FakeGame({ start: "start", playButton: { x: 0.9, y: 0.9 }, frozen: true });
    const result = await recover(game, { advisor: model, timeoutMs: 40_000 });
    expect(result.steps.some((s) => s.includes("the screen is store, not start"))).toBe(true);
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
  const start = { levelId: "sculkwire-bridge", worldName: "sculkwire-bridge", timeoutMs: 60_000 };

  it("reads the screen from ui.screen and presses the named control", async () => {
    const game = uiOnly({ start: "disconnect", afterBackToMenu: "rejoin" });
    const result = await recoverJoin(game.io(), start);
    expect(result.recovered).toBe(true);
    expect(game.world).toBe("sculkwire-bridge");
    expect(game.inputs).toEqual(["ui:press button.back"]);
    expect(result.steps[0]).toBe("disconnect: Return (or press Back to menu)");
  });

  it("presses Play by name wherever the button is drawn, then opens the local world tile", async () => {
    const game = uiOnly({ start: "start", playButton: { x: 0.9, y: 0.9 } });
    const result = await recoverJoin(game.io(), start);
    expect(result.recovered).toBe(true);
    const tile = LAYOUT.worldTile(2);
    expect(game.inputs).toEqual(["ui:press button.play", `ui:click ${Math.round(1280 * tile.x)},${Math.round(668 * tile.y)} x2`]);
    expect(game.joinedServer).toBe(false);
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
    io.ui = {
      screen: async () => {
        throw new Error("ui.screen timed out");
      },
      controls: async () => [],
      press: async () => undefined,
      key: async () => undefined,
      click: async () => undefined,
    };
    const result = await recoverJoin(io, { ...start, screens: screensInLog(game.history()) });
    expect(result.recovered).toBe(true);
    expect(result.steps.some((step) => step.startsWith("the agent's UI stopped answering"))).toBe(true);
    expect(game.inputs.length).toBeGreaterThan(0);
    expect(game.inputs.every((entry) => !entry.startsWith("ui:"))).toBe(true);
  });
});
