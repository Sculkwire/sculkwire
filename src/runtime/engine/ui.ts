/**
 * Menus and screens, host side: the typed `ui.*` calls of the in-game agent, and the pieces the rest of sculkwire
 * needs from them.
 *
 * The agent drives the game's own UI from inside the process, so a menu works in the background and on Windows
 * without the foreground: `ui.screen` names the screen and the stack under it, `ui.controls` lists what is on it,
 * `ui.press` presses a control through the game's handler, and `ui.key`, `ui.text`, `ui.click` and `ui.scroll` send
 * input the way the game reads it. None of them needs a world, so the title screen, the Play screen and Settings are
 * reachable while the game sits in a menu.
 *
 * Every one of those inputs is refused on a store screen (Marketplace, Minecoins, the Dressing Room) except Escape to
 * leave it. The agent refuses them; `isStoreScreen` lets the host keep the same rule before it sends anything.
 *
 * Nothing here talks to the agent: the parsers and the parameter checks are pure, so `engine.ts` can use them without
 * this module importing it back.
 */

/** A screen the game shows, as the game names it (`start_screen`, `play_screen`, `pause_screen`, `hud_screen`). */
export interface UiScreen {
  /** The screen on top. */
  name: string;
  /** Bottom to top: the last entry is the screen on top. */
  stack: string[];
  /** True while a dialog blocks the screens under it. */
  modal: boolean;
  /**
   * On an OreUI page (every one is named `ui://./hbui/index.html`), the page's current route (`/play`,
   * `/marketplace/store`); null when the agent could not read it. Absent on other screens.
   */
  route?: string | null;
}

export const UI_CONTROL_TYPES = ["button", "toggle", "slider", "text", "label", "list", "other"] as const;
export type UiControlType = (typeof UI_CONTROL_TYPES)[number];

/** One control of the current screen, as `ui.controls` lists it. */
export interface UiControl {
  /** The game's name for the control, which `ui.press` takes. */
  name: string;
  type: UiControlType;
  /** Client pixels, the same frame a screenshot shows: x, y, width, height. */
  rect: [number, number, number, number];
  /** The label the player reads, when the control has text of its own. */
  text?: string;
  enabled: boolean;
}

export const UI_KEY_ACTIONS = ["press", "down", "up"] as const;
export type UiKeyAction = (typeof UI_KEY_ACTIONS)[number];

export const UI_BUTTONS = ["left", "right"] as const;
export type UiButton = (typeof UI_BUTTONS)[number];

/** Longest chord `ui.key` takes: modifiers plus the key itself. */
const CHORD_LIMIT = 4;
/** One part of a key name: the xdotool-style names `game_input` documents (`Escape`, `Shift_L`, `F3`, `space`). */
const KEY_PART = /^[A-Za-z0-9_]+$/;
/**
 * Screens and OreUI routes whose controls sculkwire never touches; only Escape leaves them. A store word anywhere in a
 * scene name or route (`store_layout.…`, `/marketplace/store`, `dressingRoomCoinScreen`, a purchase dialog, the persona
 * or profile editor) decides it; the store's auxiliaries are matched by their namespace (`csb.…`, `portfolio.…`).
 */
const STORE_SCREEN =
  /marketplace|minecoins|coin|store|purchase|dressing|persona|profile_?editor|skin_selector|character_creator|upsell|(?:^|[._/])(?:csb|portfolio|token_faq|ugc_viewer|day_one_experience|win10_trial_conversion)(?![a-z])/i;

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A `ui.screen` answer. The top of the stack is always `name`, whatever the agent left out. */
export function parseUiScreen(raw: unknown): UiScreen | undefined {
  if (!record(raw)) return undefined;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return undefined;
  const stack = Array.isArray(raw.stack) ? raw.stack.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
  if (stack.at(-1) !== name) stack.push(name);
  const screen: UiScreen = { name, stack, modal: raw.modal === true };
  if ("route" in raw) screen.route = typeof raw.route === "string" && raw.route.trim() ? raw.route : null;
  return screen;
}

/** One `ui.controls` entry, or undefined when it has no name or no rectangle. */
export function parseUiControl(raw: unknown): UiControl | undefined {
  if (!record(raw)) return undefined;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const rect = Array.isArray(raw.rect) && raw.rect.length >= 4 && raw.rect.slice(0, 4).every(finite) ? (raw.rect.slice(0, 4) as [number, number, number, number]) : undefined;
  if (!name || !rect) return undefined;
  const type = (UI_CONTROL_TYPES as readonly string[]).includes(raw.type as string) ? (raw.type as UiControlType) : "other";
  const control: UiControl = { name, type, rect, enabled: raw.enabled !== false };
  if (typeof raw.text === "string" && raw.text.trim()) control.text = raw.text;
  return control;
}

/** Every readable `ui.controls` entry, or undefined when the answer is neither a list nor `{controls: [...]}`. */
export function parseUiControls(raw: unknown): UiControl[] | undefined {
  const list = Array.isArray(raw) ? raw : record(raw) && Array.isArray(raw.controls) ? raw.controls : undefined;
  if (!list) return undefined;
  return list.map(parseUiControl).filter((control): control is UiControl => control !== undefined);
}

/** `ui.key` parameters, or why the key cannot be sent. */
export function keyParams(key: string, action?: UiKeyAction): Record<string, unknown> | string {
  const text = key.trim();
  if (!text) return "a key cannot be empty";
  const parts = text.split("+");
  if (parts.length > CHORD_LIMIT || !parts.every((part) => KEY_PART.test(part))) {
    return `'${text}' is not a key: use the names game_input takes (Escape, Return, space, F3, w, ctrl+a)`;
  }
  if (action !== undefined && !(UI_KEY_ACTIONS as readonly string[]).includes(action)) return `action must be one of ${UI_KEY_ACTIONS.join(", ")}`;
  return { key: text, ...(action !== undefined ? { action } : {}) };
}

/** `ui.text` parameters, or why the text cannot be typed. */
export function textParams(text: string): Record<string, unknown> | string {
  if (typeof text !== "string" || !text.length) return "give the text to type";
  return { text };
}

/** `ui.click` parameters: client pixels, the frame a screenshot shows. */
export function clickParams(x: number, y: number, button?: UiButton): Record<string, unknown> | string {
  if (!finite(x) || !finite(y)) return "a click needs finite x and y in client pixels";
  if (x < 0 || y < 0) return "a click needs client pixels from 0,0";
  if (button !== undefined && !(UI_BUTTONS as readonly string[]).includes(button)) return `button must be one of ${UI_BUTTONS.join(", ")}`;
  return { x, y, ...(button !== undefined ? { button } : {}) };
}

/** `ui.scroll` parameters: client pixels and whole notches, positive up (away from the player). */
export function scrollParams(x: number, y: number, delta: number): Record<string, unknown> | string {
  if (!finite(x) || !finite(y) || x < 0 || y < 0) return "a scroll needs finite x and y in client pixels";
  if (!Number.isInteger(delta) || delta === 0) return "a scroll needs a whole delta, positive up and negative down";
  return { x, y, delta };
}

/**
 * True when this screen name or OreUI route is a store, the Marketplace, Minecoins, the Dressing Room or the persona
 * editor: only Escape is allowed.
 */
export function isStoreScreen(name: string): boolean {
  return STORE_SCREEN.test(name);
}

/** One line for a tool result: the screen and what it lies over. */
export function uiScreenText(screen: UiScreen): string {
  const under = screen.stack.slice(0, -1);
  const over = under.length ? ` over ${under.join(" < ")}` : "";
  const route = screen.route === undefined ? "" : ` (route ${screen.route ?? "unread"})`;
  return `${screen.name}${route}${over}${screen.modal ? ", modal" : ""}`;
}

/** One line per control for a tool result, capped so a long menu stays readable. */
export function uiControlsText(controls: readonly UiControl[], filter?: string, max = 20): string {
  if (!controls.length) return filter ? `no control matches ${filter}` : "this screen has no readable control";
  const lines = controls.slice(0, max).map((control) => {
    const rect = control.rect.join(",");
    const text = control.text ? ` "${control.text}"` : "";
    return `${control.name}${text} ${control.type} at ${rect}${control.enabled ? "" : " (disabled)"}`;
  });
  if (controls.length > max) lines.push(`… ${controls.length - max} more`);
  return lines.join("\n");
}
