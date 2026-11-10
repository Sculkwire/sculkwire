import { describe, expect, it } from "vitest";
import {
  clickParams,
  isStoreScreen,
  keyParams,
  parseUiControl,
  parseUiControls,
  parseUiScreen,
  scrollParams,
  textParams,
  uiControlsText,
  uiScreenText,
} from "./ui.ts";

describe("ui.screen answers", () => {
  it("reads the name, the stack and the modal flag", () => {
    expect(parseUiScreen({ name: "pause_screen", stack: ["hud_screen", "pause_screen"], modal: false })).toEqual({
      name: "pause_screen",
      stack: ["hud_screen", "pause_screen"],
      modal: false,
    });
  });

  it("makes the top of the stack the name when the agent left the stack out, and refuses one without a name", () => {
    expect(parseUiScreen({ name: "start_screen" })).toEqual({ name: "start_screen", stack: ["start_screen"], modal: false });
    expect(parseUiScreen({ name: " pause_screen ", stack: ["start_screen"] })?.stack).toEqual(["start_screen", "pause_screen"]);
    expect(parseUiScreen({ name: "" })).toBeUndefined();
    expect(parseUiScreen({ stack: ["start_screen"] })).toBeUndefined();
    expect(parseUiScreen("start_screen")).toBeUndefined();
  });
});

describe("ui.controls answers", () => {
  it("reads a control's name, type, rectangle, label and enabled flag", () => {
    expect(parseUiControl({ name: "play", type: "button", rect: [10, 20, 200, 40], text: "Play", enabled: true })).toEqual({
      name: "play",
      type: "button",
      rect: [10, 20, 200, 40],
      text: "Play",
      enabled: true,
    });
    expect(parseUiControl({ name: "resume", rect: [0, 0, 10, 10] })).toEqual({ name: "resume", type: "other", rect: [0, 0, 10, 10], enabled: true });
  });

  it("refuses a control without a name or a rectangle, and reads both list shapes", () => {
    expect(parseUiControl({ name: "", rect: [0, 0, 1, 1] })).toBeUndefined();
    expect(parseUiControl({ name: "play", rect: [0, 0, 1] })).toBeUndefined();
    expect(parseUiControl({ name: "play", rect: ["0", 0, 1, 1] })).toBeUndefined();
    const control = { name: "play", rect: [0, 0, 1, 1] };
    expect(parseUiControls([control, { name: "" }])).toHaveLength(1);
    expect(parseUiControls({ controls: [control] })).toHaveLength(1);
    expect(parseUiControls({ controls: [] })).toEqual([]);
    expect(parseUiControls({})).toBeUndefined();
    expect(parseUiControls(undefined)).toBeUndefined();
  });
});

describe("ui input parameters", () => {
  it("takes the key names game_input documents", () => {
    expect(keyParams("Escape")).toEqual({ key: "Escape" });
    expect(keyParams(" Return ")).toEqual({ key: "Return" });
    expect(keyParams("ctrl+a")).toEqual({ key: "ctrl+a" });
    expect(keyParams("F3")).toEqual({ key: "F3" });
    expect(keyParams("Escape", "up")).toEqual({ key: "Escape", action: "up" });
  });

  it("refuses an empty key, a chord that is too long and an action the agent does not know", () => {
    expect(typeof keyParams("   ")).toBe("string");
    expect(typeof keyParams("ctrl+a+b+c+d")).toBe("string");
    expect(typeof keyParams("ctrl +a")).toBe("string");
    expect(typeof keyParams("ctrl+esc", "tap" as never)).toBe("string");
  });

  it("needs text to type, finite client pixels and whole scroll notches", () => {
    expect(textParams("hello")).toEqual({ text: "hello" });
    expect(typeof textParams("")).toBe("string");
    expect(clickParams(12, 34)).toEqual({ x: 12, y: 34 });
    expect(clickParams(12, 34, "right")).toEqual({ x: 12, y: 34, button: "right" });
    expect(typeof clickParams(Number.NaN, 34)).toBe("string");
    expect(typeof clickParams(12, -1)).toBe("string");
    expect(typeof clickParams(12, 34, "middle" as never)).toBe("string");
    expect(scrollParams(12, 34, -2)).toEqual({ x: 12, y: 34, delta: -2 });
    expect(typeof scrollParams(12, 34, 0)).toBe("string");
    expect(typeof scrollParams(12, 34, 1.5)).toBe("string");
  });
});

describe("store screens", () => {
  it("knows the screens sculkwire only ever leaves with Escape", () => {
    for (const name of [
      "store_layout.store_data_driven_screen",
      "store_data_driven_screen",
      "store_inventory.armor_screen",
      "store_progress.offers_screen",
      "marketplace_screen",
      "marketplace.home_screen",
      "minecoins",
      "dressing_room_screen",
      "skin_selector_screen",
      "character_creator_screen",
      "csb.welcome_screen",
      "csb_welcome_screen",
      "tabbed_upsell.offer_screen",
      "bundle_purchase_warning.screen",
      "portfolio.collection_screen",
      "token_faq.screen",
      "ugc_viewer.screen",
      "persona_emote.screen",
      "day_one_experience.screen",
      "win10_trial_conversion.screen",
    ]) {
      expect(isStoreScreen(name)).toBe(true);
    }
    for (const name of ["start_screen", "play.play_screen", "pause_screen", "hud.hud_screen", "progress.world_loading_progress_screen"]) {
      expect(isStoreScreen(name)).toBe(false);
    }
  });

  it("knows OreUI store routes and route-style names, case-insensitively", () => {
    for (const name of [
      "dressingRoomCoinScreen",
      "/marketplace/store",
      "/marketplace",
      "/marketplace/inventory",
      "/oreui-marketplace/home",
      "/marketplace-pass-pdp",
      "/marketplace?productId=1",
      "store_layout",
      "/persona-editor",
      "/profile_editor",
      "/purchase-confirmation",
      "MineCoins_Screen",
    ]) {
      expect(isStoreScreen(name)).toBe(true);
    }
    for (const name of ["/play", "/play/worlds", "/settings/video", "/create-new-world", "/idle-route", "ui://./hbui/index.html"]) {
      expect(isStoreScreen(name)).toBe(false);
    }
  });

  it("keeps the OreUI route ui.screen reports, null when the agent could not read it", () => {
    expect(parseUiScreen({ name: "ui://./hbui/index.html", stack: ["ui://./hbui/index.html"], route: "/play" })?.route).toBe("/play");
    expect(parseUiScreen({ name: "ui://./hbui/index.html", route: null })?.route).toBeNull();
    expect(parseUiScreen({ name: "hud_screen" })?.route).toBeUndefined();
    expect(uiScreenText({ name: "ui://./hbui/index.html", stack: ["ui://./hbui/index.html"], modal: false, route: null })).toBe(
      "ui://./hbui/index.html (route unread)",
    );
  });
});

describe("ui text for tool results", () => {
  it("describes the screen and what it lies over", () => {
    expect(uiScreenText({ name: "pause_screen", stack: ["hud_screen", "pause_screen"], modal: false })).toBe("pause_screen over hud_screen");
    expect(uiScreenText({ name: "start_screen", stack: ["start_screen"], modal: true })).toBe("start_screen, modal");
  });

  it("lists controls with their label, type and place, and says when there is none", () => {
    const text = uiControlsText([{ name: "play", type: "button", rect: [1, 2, 3, 4], text: "Play", enabled: false }]);
    expect(text).toBe('play "Play" button at 1,2,3,4 (disabled)');
    expect(uiControlsText([], "world")).toBe("no control matches world");
    expect(uiControlsText([])).toBe("this screen has no readable control");
  });
});
