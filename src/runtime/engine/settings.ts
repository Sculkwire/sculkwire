/**
 * Game settings: the options the game owns, named by their `options.txt` save tag (`gfx_viewdistance`).
 *
 * With an attached agent every read and write goes through the game's own options object (`settings.list/get/set`), so
 * a change applies at once and the game saves it itself. Without one, `options.txt` is read and written directly and a
 * change takes effect at the next launch.
 *
 * Every value sculkwire changes is recorded with its previous value (`engine-settings-restore.json`, first change of a
 * key wins) and put back by `restoreGameSettings` on `game_stop`, live through the agent while the game still runs and
 * in `options.txt` as well. That is the live-game rule "restore any option changed". Keys the bridge needs for its own
 * channels (script debugger, websockets, content log) are owned by the bridge and refused here.
 */
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { readJsonOr, writeJsonAtomic } from "../../core/fs.ts";
import { dataDir } from "../../core/paths.ts";
import { findInstall, optionsFiles, type ClientInstall } from "../../gamefiles/install.ts";
import { applyOptions, bridgeOptions, parseOptions, removeOptions } from "../../gamefiles/options.ts";
import { engine, type EngineSession, type GameSetting, type SettingValue } from "./engine.ts";
import { invalid, type EngineResult } from "./failure.ts";
import { isObjectLike } from "./wire.ts";

/** Where a value came from: the running game, or the file the game reads at its next launch. */
export type SettingsSource = "engine" | "options.txt";

/** One change, as `game_settings set` reports it. */
export interface SettingChange {
  id: string;
  /** The value before the change, as the source had it (`null` when the file had no such key). */
  previous: SettingValue | null;
  value: SettingValue;
  source: SettingsSource;
  /** `now` through the agent, `next launch` for an `options.txt` write. */
  appliesAt: "now" | "next launch";
  /**
   * True when the value reached `options.txt` — always for the file route. Through the agent it is what the game
   * reports: false means the change is live only and is lost on restart unless the game saves later. Absent when the
   * agent does not report it.
   */
  saved?: boolean;
}

export interface SettingList {
  source: SettingsSource;
  settings: GameSetting[];
}

export interface SettingView {
  source: SettingsSource;
  setting: GameSetting;
}

/** What the tools and the tests hand in; everything defaults to the real thing. */
export interface SettingsDeps {
  session?: EngineSession;
  install?: ClientInstall;
  /** The pending-change record. Defaults to `dataDir("client", "engine-settings-restore.json")`. */
  record?: string;
}

interface PendingSetting {
  previous: SettingValue | null;
  source: SettingsSource;
}

interface PendingRecord {
  settings: Record<string, PendingSetting>;
}

/** Keys `game_launch` writes and `game_stop` restores: the bridge's own channels, not game settings. */
const BRIDGE_KEYS = new Set(Object.keys(bridgeOptions(0)));

const defaultRecord = () => dataDir("client", "engine-settings-restore.json");

/** The record of values changed and not yet restored. A missing or damaged file means "nothing pending". */
async function readPending(record: string): Promise<PendingRecord> {
  const settings: Record<string, PendingSetting> = {};
  const parsed = await readJsonOr<unknown>(record);
  if (!isObjectLike(parsed) || !isObjectLike(parsed.settings)) return { settings };
  for (const [id, entry] of Object.entries(parsed.settings)) {
    if (!isObjectLike(entry)) continue;
    const previous = entry.previous;
    if (previous !== null && typeof previous !== "boolean" && typeof previous !== "number" && typeof previous !== "string") continue;
    settings[id] = { previous: previous ?? null, source: entry.source === "options.txt" ? "options.txt" : "engine" };
  }
  return { settings };
}

async function writePending(record: string, pending: PendingRecord): Promise<void> {
  if (Object.keys(pending.settings).length === 0) {
    await rm(record, { force: true });
    return;
  }
  await writeJsonAtomic(record, pending);
}

/** The text `options.txt` holds for `value`: booleans are 1/0 there, numbers and strings as written. */
export function settingsText(value: SettingValue): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

/**
 * Options whose `options.txt` text counts a smaller unit than the game itself: the render distance is saved in blocks
 * (16 per chunk), while the game's options object, the agent and the settings screen count chunks. Both routes answer
 * in the game's unit, so the same id reads the same value whichever route serves it.
 */
const FILE_SCALE: Readonly<Record<string, number>> = { gfx_viewdistance: 16 };

/** The number in `text`, or undefined when it is not one. */
function numberIn(text: string): number | undefined {
  const n = Number(text);
  return text.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

/** `options.txt` text for `id`, in the game's unit (chunks for the render distance). Text that is no number stays as it is. */
function fromFileText(id: string, text: string): string {
  const scale = FILE_SCALE[id];
  const n = scale ? numberIn(text) : undefined;
  return scale && n !== undefined ? String(n / scale) : text;
}

/** The text `options.txt` holds for `value` of `id`, a value in the game's unit (blocks for the render distance). */
function fileText(id: string, value: SettingValue): string {
  const text = settingsText(value);
  const scale = FILE_SCALE[id];
  const n = scale ? numberIn(text) : undefined;
  return scale && n !== undefined ? String(Math.round(n * scale)) : text;
}

/** One line for a change, as the tools and the CLI report it: what it was, what it is, and whether the file has it. */
export function changeText(change: SettingChange): string {
  const was = change.previous === null ? "unset" : String(change.previous);
  // A change the game did not save is live only, so say so rather than let it look durable.
  const stored = change.saved === false ? ", live only, not saved" : "";
  return `${change.id}: ${was} -> ${String(change.value)} (${change.source}, applies ${change.appliesAt}${stored})`;
}

/** Read every options.txt of the install, the player's file first (the game reads that one), values in the game's unit. */
async function readOptionsFiles(install: ClientInstall): Promise<{ files: string[]; values: Map<string, string> }> {
  const files = optionsFiles(install);
  const values = new Map<string, string>();
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const [key, value] of parseOptions(text)) if (!values.has(key)) values.set(key, fromFileText(key, value));
  }
  return { files, values };
}

/**
 * Write `values` into every options.txt that exists (a `null` removes the key), keeping each file's order and line
 * endings. The first write leaves `<file>.sculkwire-backup` behind, as a plain restore of the user's own settings.
 */
async function writeOptionsValues(install: ClientInstall, values: Readonly<Record<string, string | null>>): Promise<string[]> {
  const set: Record<string, string> = {};
  const remove: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === null) remove.push(key);
    else set[key] = value;
  }
  const written: string[] = [];
  for (const file of optionsFiles(install)) {
    if (!existsSync(file)) continue;
    const text = await readFile(file, "utf8");
    const backup = `${file}.sculkwire-backup`;
    if (!existsSync(backup)) await writeFile(backup, text);
    await writeFile(file, removeOptions(applyOptions(text, set), remove));
    written.push(file);
  }
  return written;
}

/** The options.txt entry for a key: the file holds text, so that is its type and value. */
function fileSetting(id: string, value: string): GameSetting {
  return { id, type: "string", value };
}

function matches(id: string, filter: string | undefined): boolean {
  if (filter === undefined || filter === "") return true;
  return id.toLowerCase().includes(filter.toLowerCase());
}

/**
 * Every setting: the running game's when an agent is attached, else the keys of the install's options.txt.
 * `filter` is a case-insensitive substring of the id.
 */
export async function listSettings(filter?: string, deps: SettingsDeps = {}): Promise<EngineResult<SettingList>> {
  const session = deps.session ?? engine;
  if (await session.reachable()) {
    const result = await session.settingsList(filter);
    return result.ok ? { ok: true, value: { source: "engine", settings: result.value } } : result;
  }
  const install = deps.install ?? (await findInstall());
  const { files, values } = await readOptionsFiles(install);
  if (!files.some((file) => existsSync(file))) {
    return invalid(`no options.txt for ${install.label} (${files.join(", ")}); start the game once so it writes one`);
  }
  const settings = [...values.entries()]
    .filter(([id]) => matches(id, filter))
    .map(([id, value]) => fileSetting(id, value))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, value: { source: "options.txt", settings } };
}

/** One setting by id. */
export async function getSetting(id: string, deps: SettingsDeps = {}): Promise<EngineResult<SettingView>> {
  const key = id.trim();
  if (!key) return invalid("a setting id cannot be empty");
  const session = deps.session ?? engine;
  if (await session.reachable()) {
    const result = await session.settingsGet(key);
    return result.ok ? { ok: true, value: { source: "engine", setting: result.value } } : result;
  }
  const install = deps.install ?? (await findInstall());
  const { values } = await readOptionsFiles(install);
  const value = values.get(key);
  if (value === undefined) {
    return invalid(`options.txt has no ${key}${BRIDGE_KEYS.has(key) ? " (the bridge owns that key)" : ""}`);
  }
  return { ok: true, value: { source: "options.txt", setting: fileSetting(key, value) } };
}

/**
 * Change one setting and record the value it had. Through an agent the game applies it at once; otherwise the install's
 * options.txt is written and the change arrives with the next launch.
 */
export async function setSetting(id: string, value: SettingValue, deps: SettingsDeps = {}): Promise<EngineResult<SettingChange>> {
  const key = id.trim();
  if (!key) return invalid("a setting id cannot be empty");
  if (BRIDGE_KEYS.has(key)) {
    return invalid(
      `${key} belongs to the bridge's own channels (script debugger, websockets, content log); game_launch writes it and game_stop restores it`,
    );
  }
  const session = deps.session ?? engine;
  const change: SettingChange = { id: key, previous: null, value, source: "engine", appliesAt: "now" };
  if (await session.reachable()) {
    const result = await session.settingsSet(key, value);
    if (!result.ok) return result;
    change.previous = result.value.previous;
    change.value = result.value.value;
    if (result.value.saved !== undefined) change.saved = result.value.saved;
  } else {
    const install = deps.install ?? (await findInstall());
    const { files, values } = await readOptionsFiles(install);
    if (!files.some((file) => existsSync(file))) {
      return invalid(`no options.txt for ${install.label} (${files.join(", ")}); start the game once so it writes one`);
    }
    const existing = values.get(key);
    if (existing === undefined) {
      return invalid(`options.txt has no ${key}; without an attached agent only options the game already saved can be changed`);
    }
    if (FILE_SCALE[key] && numberIn(settingsText(value)) === undefined) {
      return invalid(`${key} takes a number, got ${JSON.stringify(value)}`);
    }
    change.previous = existing;
    change.value = settingsText(value);
    change.source = "options.txt";
    change.appliesAt = "next launch";
    // The write below is the file the game reads at its next launch, so this route always leaves it saved.
    change.saved = true;
    await writeOptionsValues(install, { [key]: fileText(key, value) });
  }
  const record = deps.record ?? defaultRecord();
  const pending = await readPending(record);
  // The first change of a key keeps the user's own original value, so a second change still restores the first one.
  if (!(key in pending.settings)) pending.settings[key] = { previous: change.previous, source: change.source };
  await writePending(record, pending);
  return { ok: true, value: change };
}

/**
 * Put back every value `setSetting` changed: live through the agent while the game still runs, and in options.txt, so
 * the file agrees whether or not the game gets to save its own copy. Returns the restored values by id. Call before the
 * game is stopped (`ClientBridge.stop` does).
 */
export async function restoreGameSettings(deps: SettingsDeps = {}): Promise<Record<string, SettingValue | null>> {
  const record = deps.record ?? defaultRecord();
  const pending = await readPending(record);
  const ids = Object.keys(pending.settings);
  if (ids.length === 0) return {};
  const session = deps.session ?? engine;
  const install = deps.install ?? (await findInstall().catch(() => undefined));
  const live = new Set<string>();
  const agent = await session.reachable();
  const file: Record<string, string | null> = {};
  for (const id of ids) {
    const previous = pending.settings[id]?.previous ?? null;
    if (agent && previous !== null) {
      const result = await session.settingsSet(id, previous);
      if (result.ok) live.add(id);
    }
    if (install) file[id] = previous === null ? null : fileText(id, previous);
  }
  let fileWritten = false;
  if (install && Object.keys(file).length > 0) fileWritten = (await writeOptionsValues(install, file).catch(() => [])).length > 0;
  const restored: Record<string, SettingValue | null> = {};
  const remaining: PendingRecord = { settings: {} };
  for (const id of ids) {
    const previous = pending.settings[id]?.previous ?? null;
    if (live.has(id) || fileWritten) restored[id] = previous;
    else remaining.settings[id] = pending.settings[id] as PendingSetting;
  }
  await writePending(record, remaining);
  return restored;
}
