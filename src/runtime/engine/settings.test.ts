import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientInstall } from "../../gamefiles/install.ts";
import { EngineSession, type EngineResult, type SettingEdit, type SettingValue } from "./engine.ts";
import { changeText, getSetting, listSettings, restoreGameSettings, setSetting, settingsText } from "./settings.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  install: ClientInstall;
  record: string;
  options: string;
}

/** An install whose player options.txt holds `text` (and whose shared file is empty). 384 blocks are 24 chunks. */
async function fixture(text = "gfx_viewdistance:384\ngame_thirdperson:0\n"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sculkwire-settings-"));
  dirs.push(root);
  const user = join(root, "Users", "1", "games", "com.mojang");
  const shared = join(root, "Users", "Shared", "games", "com.mojang");
  mkdirSync(join(user, "minecraftpe"), { recursive: true });
  mkdirSync(join(shared, "minecraftpe"), { recursive: true });
  const options = join(user, "minecraftpe", "options.txt");
  writeFileSync(options, text);
  writeFileSync(join(shared, "minecraftpe", "options.txt"), "showcoordinates:1\n");
  const install: ClientInstall = {
    kind: "wine-prefix",
    label: "test install",
    appData: root,
    sharedComMojang: shared,
    userComMojang: user,
    logsDir: root,
    passesArgs: false,
    wine: true,
    preview: false,
  };
  return { root, install, record: join(root, "settings-record.json"), options };
}

/** A session with no agent: port 9 answers nothing, so only the file path is exercised. */
function detached(): EngineSession {
  return new EngineSession({ port: 9, timeoutMs: 200 });
}

/** A session that behaves as if an agent were attached, with the game's answers. */
function attached(options: { previous?: SettingValue | null; edits?: [string, SettingValue][]; saved?: boolean } = {}): EngineSession {
  const session = new EngineSession({ port: 9, timeoutMs: 200 });
  Object.defineProperty(session, "attached", { get: () => true, configurable: true });
  session.settingsSet = async (id: string, value: SettingValue): Promise<EngineResult<SettingEdit>> => {
    options.edits?.push([id, value]);
    return {
      ok: true,
      value: {
        id,
        previous: options.previous === undefined ? 24 : options.previous,
        value,
        ...(options.saved === undefined ? {} : { saved: options.saved }),
      },
    };
  };
  return session;
}

describe("settings from options.txt", () => {
  it("lists and reads the file's keys, typed as the text they are", async () => {
    const { install } = await fixture();
    const deps = { install, session: detached() };
    const list = await listSettings(undefined, deps);
    if (!list.ok) throw new Error(list.message);
    expect(list.value.source).toBe("options.txt");
    expect(list.value.settings.map((s) => s.id)).toEqual(["game_thirdperson", "gfx_viewdistance", "showcoordinates"]);
    expect(list.value.settings[1]).toEqual({ id: "gfx_viewdistance", type: "string", value: "24" });
    const filtered = await listSettings("THIRD", deps);
    if (!filtered.ok) throw new Error(filtered.message);
    expect(filtered.value.settings.map((s) => s.id)).toEqual(["game_thirdperson"]);
    const one = await getSetting("game_thirdperson", deps);
    if (!one.ok) throw new Error(one.message);
    expect(one.value).toEqual({ source: "options.txt", setting: { id: "game_thirdperson", type: "string", value: "0" } });
    const missing = await getSetting("nope", deps);
    expect(missing).toMatchObject({ ok: false, reason: "invalid_params" });
  });

  it("writes a value, keeps the first previous one, and restores it", async () => {
    const { install, record, options } = await fixture();
    const deps = { install, session: detached(), record };
    const first = await setSetting("gfx_viewdistance", "32", deps);
    if (!first.ok) throw new Error(first.message);
    expect(first.value).toEqual({
      id: "gfx_viewdistance",
      previous: "24",
      value: "32",
      source: "options.txt",
      appliesAt: "next launch",
      saved: true,
    });
    // options.txt saves the render distance in blocks; the tool speaks chunks, as the game does.
    expect(readFileSync(options, "utf8")).toContain("gfx_viewdistance:512");
    expect(existsSync(`${options}.sculkwire-backup`)).toBe(true);

    const second = await setSetting("gfx_viewdistance", "48", deps);
    if (!second.ok) throw new Error(second.message);
    expect(second.value.previous).toBe("32");
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ settings: { gfx_viewdistance: { previous: "24", source: "options.txt" } } });

    const restored = await restoreGameSettings({ ...deps, install });
    expect(restored).toEqual({ gfx_viewdistance: "24" });
    expect(readFileSync(options, "utf8")).toContain("gfx_viewdistance:384");
    expect(existsSync(record)).toBe(false);
  });

  it("refuses the bridge's own keys and keys the file does not have", async () => {
    const { install, record } = await fixture();
    const deps = { install, session: detached(), record };
    expect(await setSetting("websockets_enabled", "0", deps)).toMatchObject({ ok: false, reason: "invalid_params", message: expect.stringContaining("bridge") });
    expect(await setSetting("not_an_option", "1", deps)).toMatchObject({ ok: false, message: expect.stringContaining("only options the game already saved") });
    expect(existsSync(record)).toBe(false);
  });

  it("answers the render distance in chunks, as the engine route does, though the file saves blocks", async () => {
    const { install, record, options } = await fixture("gfx_viewdistance:800\ngame_thirdperson:0\n");
    const deps = { install, session: detached(), record };
    const one = await getSetting("gfx_viewdistance", deps);
    if (!one.ok) throw new Error(one.message);
    expect(one.value.setting).toEqual({ id: "gfx_viewdistance", type: "string", value: "50" });
    const change = await setSetting("gfx_viewdistance", 12, deps);
    if (!change.ok) throw new Error(change.message);
    expect(change.value).toMatchObject({ previous: "50", value: "12" });
    expect(readFileSync(options, "utf8")).toContain("gfx_viewdistance:192");
    expect(await setSetting("gfx_viewdistance", "far", deps)).toMatchObject({ ok: false, reason: "invalid_params" });
    // Other options are the file's text as it is.
    const third = await getSetting("game_thirdperson", deps);
    expect(third).toMatchObject({ ok: true, value: { setting: { value: "0" } } });
  });
});

describe("settings through an agent", () => {
  it("changes the running game without touching the file, then restores live", async () => {
    const { install, record, options } = await fixture("gfx_viewdistance:384\n");
    const edits: [string, SettingValue][] = [];
    const session = attached({ edits });
    const change = await setSetting("gfx_viewdistance", 48, { install, session, record });
    if (!change.ok) throw new Error(change.message);
    expect(change.value).toEqual({ id: "gfx_viewdistance", previous: 24, value: 48, source: "engine", appliesAt: "now" });
    expect(readFileSync(options, "utf8")).toContain("gfx_viewdistance:384\n");
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ settings: { gfx_viewdistance: { previous: 24, source: "engine" } } });

    const restored = await restoreGameSettings({ install, session, record });
    expect(restored).toEqual({ gfx_viewdistance: 24 });
    expect(edits).toEqual([
      ["gfx_viewdistance", 48],
      ["gfx_viewdistance", 24],
    ]);
    // The file is written too (in blocks), so a game that never saves its own copy still comes back unchanged.
    expect(readFileSync(options, "utf8")).toContain("gfx_viewdistance:384");
    expect(existsSync(record)).toBe(false);
  });

  it("reports whether the game saved the change to options.txt", async () => {
    const { install, record } = await fixture("gfx_viewdistance:24\n");
    const unsaved = await setSetting("gfx_viewdistance", 48, { install, session: attached({ saved: false }), record });
    if (!unsaved.ok) throw new Error(unsaved.message);
    expect(unsaved.value.saved).toBe(false);
    const saved = await setSetting("gfx_viewdistance", 40, { install, session: attached({ saved: true }), record });
    if (!saved.ok) throw new Error(saved.message);
    expect(saved.value.saved).toBe(true);
    // An agent that does not report it leaves the field out rather than claiming either way.
    const silent = await setSetting("gfx_viewdistance", 36, { install, session: attached(), record });
    if (!silent.ok) throw new Error(silent.message);
    expect(silent.value).not.toHaveProperty("saved");
    expect(changeText(silent.value)).toBe("gfx_viewdistance: 24 -> 36 (engine, applies now)");
    expect(changeText(unsaved.value)).toBe("gfx_viewdistance: 24 -> 48 (engine, applies now, live only, not saved)");
  });

  it("keeps a pending entry when nothing could put the value back", async () => {
    const { install, record } = await fixture("gfx_viewdistance:24\n");
    await setSetting("gfx_viewdistance", 48, { install, session: attached(), record });
    const gone: ClientInstall = {
      ...install,
      label: "gone",
      userComMojang: join(install.userComMojang, "absent"),
      sharedComMojang: join(install.sharedComMojang, "absent"),
    };
    // No agent attached and no options.txt left: neither route can restore anything.
    expect(await restoreGameSettings({ install: gone, session: detached(), record })).toEqual({});
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ settings: { gfx_viewdistance: { previous: 24, source: "engine" } } });
  });
});

describe("options.txt text", () => {
  it("writes switches as 1 and 0", () => {
    expect(settingsText(true)).toBe("1");
    expect(settingsText(false)).toBe("0");
    expect(settingsText(24)).toBe("24");
    expect(settingsText("hello")).toBe("hello");
  });
});
