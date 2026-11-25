import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatDiagnostic, summarize } from "../../core/diagnostic.ts";
import { diagnosticSchema, diagText, fail, ok, summarySchema } from "../../core/mcp.ts";
import { dataDir } from "../../core/paths.ts";
import { errorMessage } from "../../core/errors.ts";
import { onShutdown } from "../../core/shutdown.ts";
import { bridge, HelperQueryError, WORLD_WAIT_MAX_S, WORLD_WAIT_MS, type BridgeStatus, type CommandOutput } from "./bridge.ts";
import { EngineLogReader, engineQuery } from "./engineread.ts";
import { entityPropertyIdsFor } from "./entityproperties.ts";
import { inputProvider, withInputLock } from "./inputprovider.ts";
import { engine } from "../engine/engine.ts";
import type { EngineResult } from "../engine/failure.ts";
import type { EntityInfo, Loadout, PlayerAction } from "./types.ts";
import { play, PLAY_DEFAULT_DURATION_MS, PLAY_DEFAULT_MAX_DEATHS, PLAY_DEFAULT_STEP_MS, PLAY_MAX_DURATION_MS, type Death, type PlayAction, type PlayResult } from "./skills/play.ts";
import { TACTICS } from "./skills/tactics.ts";
import { STANCES } from "./skills/pack.ts";
import type { FightStats } from "./skills/types.ts";
import { liveTaskEnv } from "./tasks/live.ts";
import { pauseOnTakeover, playJobs, runActions, stepText, type PlayJobInfo } from "./jobs.ts";
import { DIFFICULTIES, type Difficulty } from "../../gamefiles/worlds.ts";
import { findInstall } from "../../gamefiles/install.ts";
import { deleteWorld, listAllWorlds, readMarker, STALE_WORLD_DAYS, worldLine } from "./worldstore.ts";
import { readDevWorld, useDevWorld } from "./devworld.ts";
import { FOREGROUND_MESSAGE } from "./windows.ts";
import { deleteScene, listScenes, resetScene, saveScene, SCENE_DEFAULT_RADIUS, SCENE_MAX_RADIUS, SCENE_NAME } from "./scenes.ts";
import type { InputRoute } from "./input.ts";
import { COMPARE_OPS, readEvents, WAIT_DEFAULT_MS, WAIT_MAX_MS, waitUntil } from "./waits.ts";

const statusSchema = {
  running: z.boolean(),
  mode: z.enum(["window", "headless", "desktop"]).optional(),
  version: z.string().optional(),
  install: z.string().optional(),
  world: z.string().optional(),
  project: z.string().optional(),
  packs: z.array(
    z.object({
      name: z.string().optional(),
      uuid: z.string(),
      kind: z.string(),
      folder: z.string().optional(),
      path: z.string().optional(),
      built: z.boolean(),
    }),
  ),
  debugger: z.object({ attached: z.boolean(), port: z.number().optional(), protocolVersion: z.number().optional(), plugins: z.array(z.string()).optional() }),
  connect: z.object({ clients: z.number(), port: z.number().optional(), method: z.enum(["automatic", "chat"]).optional() }),
  ready: z.boolean(),
  manualSteps: z.array(z.string()),
  gameExited: z.boolean().optional(),
  deployDiagnostics: z.array(diagnosticSchema).optional(),
  joinRecovery: z
    .object({
      attempts: z.number(),
      recovered: z.boolean(),
      via: z.string().optional(),
      log: z.string().optional(),
      screenshot: z.string().optional(),
    })
    .optional(),
  prunedWorlds: z.array(z.string()).optional(),
  worldNote: z.string().optional(),
  worldMode: z.enum(["fresh", "kept", "copied", "user", "attached"]).optional(),
  attached: z.boolean().optional().describe("game_launch found the game already running and attached to it instead of starting one; game_stop only detaches"),
  inWorld: z.boolean().optional().describe("Attached game: whether it shows a world (false: it sits in a menu; the channels connect once a world is open)"),
  levelId: z.string().optional().describe("Attached game: the level id (folder under minecraftWorlds) of the world it opened"),
  helperNote: z
    .string()
    .optional()
    .describe("Attached game: why game_query, wait_until, game_events, scene_* or game_log lack what they need in this world (no helper pack, no content-log file), and how that changes"),
  dead: z.boolean().optional().describe("game_status: the player is dead (the death screen is up, or the helper streamed health 0); player_act respawns it"),
  muted: z.boolean().optional().describe("The game is kept silent (mute applies and nothing lets its sound through); false: its sound plays, muteNote says why when mute applies"),
  muteNote: z.string().optional().describe("Why the game's sound may reach the speakers although mute applies (pactl missing, a stream that would not move to the silent sink)"),
  worldBackup: z.string().optional(),
  defaultWorld: z.object({ levelId: z.string(), name: z.string() }).optional(),
};
const commandSchema = {
  command: z.string(),
  via: z.enum(["connect", "debugger"]),
  ok: z.boolean(),
  output: z.array(z.string()),
  statusCode: z.number().optional(),
  body: z.record(z.string(), z.unknown()).optional(),
};

/** True when `A` and `B` accept the same values. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// The output schemas restate the bridge's result types field for field: these fail to compile when the two drift.
// `deployDiagnostics` is left out: the shared `diagnosticSchema` has no `related` field, which `Diagnostic` has.
true satisfies Same<Omit<z.infer<z.ZodObject<typeof statusSchema>>, "deployDiagnostics">, Omit<BridgeStatus, "deployDiagnostics">>;
true satisfies Same<z.infer<z.ZodObject<typeof commandSchema>>, CommandOutput>;

/**
 * Take a `game_input` action through the agent's own UI when it is attached: one `ui.key` per chord, `ui.text` into
 * the focused box, `ui.click` in screenshot pixels (left, or right for button 3). False when this action has no `ui.*`
 * call, so the caller keeps its own route: a mouse move, a middle click, or nothing to send.
 */
async function inputThroughUi(a: {
  action: "key" | "type" | "click" | "move";
  keys?: string;
  text?: string;
  x?: number;
  y?: number;
  button?: 1 | 2 | 3;
}): Promise<boolean> {
  if (!engine.attached) return false;
  const sent = (result: EngineResult<unknown>): true => {
    if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
    return true;
  };
  if (a.action === "key") {
    const chords = (a.keys ?? "").split(/\s+/).filter(Boolean);
    for (const chord of chords) sent(await engine.uiKey(chord));
    return chords.length > 0;
  }
  if (a.action === "type") return a.text ? sent(await engine.uiText(a.text)) : false;
  if (a.action === "click" && a.x !== undefined && a.y !== undefined && a.button !== 2) {
    return sent(await engine.uiClick(a.x, a.y, a.button === 3 ? "right" : "left"));
  }
  return false;
}

function statusText(s: BridgeStatus): string {
  if (s.gameExited) return `client not running: ${s.manualSteps.join("; ")}`;
  if (!s.running) return `client not running${s.defaultWorld ? `; default dev world ${s.defaultWorld.name} [${s.defaultWorld.levelId}]` : ""}`;
  const parts = [
    `${s.attached ? "attached" : s.mode} client ${s.version ?? ""} in world ${s.attached && s.inWorld === false ? "none (a menu)" : (s.world ?? "?")}${s.worldMode ? ` (${s.worldMode})` : ""}`,
    `debugger ${s.debugger.attached ? `attached (protocol ${s.debugger.protocolVersion ?? "?"})` : "not attached"}`,
    `/connect clients ${s.connect.clients}`,
  ];
  for (const step of s.manualSteps) parts.push(`manual: ${step}`);
  if (s.dead) parts.push("the player is dead: player_act respawns it (action respawn, or any action)");
  if (s.packs.length) {
    const packs = s.packs.map((p) => {
      const where = p.folder ? `${p.folder}${p.path ? ` at ${p.path}` : ""}` : "not deployed";
      return `${p.kind} ${where}${p.built ? " (built)" : ""}`;
    });
    parts.push(`packs ${packs.join(", ")}`);
  }
  for (const d of s.deployDiagnostics ?? []) parts.push(formatDiagnostic(d));
  if (s.joinRecovery) {
    const r = s.joinRecovery;
    parts.push(
      r.recovered
        ? `recovered the sign-in join race after ${r.attempts} press(es)${r.via ? ` (${r.via})` : ""}`
        : `sign-in join race not recovered after ${r.attempts} attempt(s)`,
    );
  }
  if (s.worldNote) parts.push(s.worldNote);
  if (s.helperNote) parts.push(s.helperNote);
  if (s.prunedWorlds?.length) parts.push(`removed ${s.prunedWorlds.length} old test world(s): ${s.prunedWorlds.join(", ")}`);
  if (s.defaultWorld) parts.push(`default dev world ${s.defaultWorld.name} [${s.defaultWorld.levelId}]`);
  return parts.join("; ");
}

type ActionResultOut = { action: string; ok: boolean; message: string; durationMs: number; input?: "engine" | "keyboard"; fight?: FightStats };
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Longest a `player_job wait` blocks, under the 30 s many MCP clients allow one call. */
const JOB_WAIT_MAX_MS = 25_000;

/** Send an MCP progress notification when the request asked for them (it carries a progressToken). */
function notifyProgress(extra: Extra, progress: number, total: number | undefined, message: string): void {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  void extra
    .sendNotification({ method: "notifications/progress", params: { progressToken, progress, ...(total !== undefined ? { total } : {}), message } })
    .catch(() => undefined);
}

/** Stop reason, the plan (one line per step), combat numbers and the last few tactics of a `play` run. */
function playText(p: PlayResult): string {
  const s = p.stats;
  const killed = Object.entries(s.killed).map(([t, n]) => `${n} ${t}`).join(", ");
  const others = Object.entries(s.otherDeaths).map(([t, n]) => `${n} ${t}`).join(", ");
  const lines = [
    `play stopped by ${p.stoppedBy} after ${p.steps} tactic(s) in ${(p.durationMs / 1000).toFixed(1)} s: ${p.message}`,
    `goal (${p.goalCheck.kind}): ${p.goalCheck.progress}`,
    ...p.plan.map((r, i) => `  ${i + 1}. ${r.kind} ${r.status}${r.retries ? `, ${r.retries} retries` : ""}: "${r.text}": ${r.message}`),
    ...(p.orders.stance ? [`stance ${p.orders.stance}`] : []),
    `kills ${s.kills}${killed ? ` (${killed})` : ""}${others ? `, other deaths ${others}` : ""}, hits ${s.hits} (${s.crits} critical) and ${s.misses} misses of ${s.swings} swings, took ${s.hitsTaken} hits for ${s.damageTaken} damage, blocked ${s.blocked}, deaths ${s.deaths}${s.health !== undefined ? `, health ${s.health}` : ""}`,
    `${s.decisions} decisions`,
  ];
  for (const t of p.trace.slice(-5)) lines.push(`  ${stepText(t)}`);
  return lines.join("\n");
}

function jobText(j: PlayJobInfo): string {
  const head = `${j.id} ${j.status}${j.stopReason ? ` (${j.stopReason})` : ""}: "${j.goal}"`;
  if (j.result) return `${head}\n${playText(j.result)}`;
  const p = j.progress;
  const lines = [
    `${head}, ${p.steps} step(s) in ${(p.elapsedMs / 1000).toFixed(1)} s`,
    ...(p.planStep ? [`  now: ${p.planStep}`] : []),
    ...p.lastActions.map((a) => `  ${a}`),
  ];
  if (j.error) lines.push(`error: ${j.error}`);
  return lines.join("\n");
}

let shutdownHooked = false;
/** `game_log`'s choice between the log files and the agent's content-log ring, kept across calls (one MCP process). */
const engineLog = new EngineLogReader();

export function register(server: McpServer): void {
  if (!shutdownHooked) {
    shutdownHooked = true;
    onShutdown(async () => {
      await playJobs.stopAll("the MCP server is shutting down");
      // An exited game still has a launch to clean up (listeners, options, deployed packs).
      if (bridge.launchState) await bridge.stop();
    });
  }
  server.registerTool(
    "game_launch",
    {
      title: "Launch the Bedrock client",
      description:
        "Start the real Minecraft Bedrock client (any install sculkwire finds such as Windows, mcbe-gdk-installer, a Wine " +
        "or Proton prefix like Flarial, or SCULKWIRE_MINECRAFT_DIR) in a world with the project's packs and the sculkwire " +
        "helper pack active. The world is the user's saved dev world (game_worlds action use) when one is saved and no " +
        "test world option (world, keep, copyFrom, fresh) is given, or userWorld; else a fresh `sculkwire-` test world: " +
        "flat and creative, cheats on, time and " +
        "weather frozen. In the user's dev world sculkwire backs up level.dat, the pack lists and the icon first (worldBackup), " +
        "merges the packs into its pack lists (other packs stay), turns cheats on when they are off (the world then awards " +
        "no achievements) and says so in worldNote; experiments only with betaApis, the difficulty only when given; the game " +
        "must be closed for that. Attaches the script debugger automatically. Display modes: on Linux `headless` (the " +
        "default) runs the game in the background, without a window and muted, so it never takes the user's screen; " +
        "`window` is a visible gamescope window, only when the user wants to watch. On Windows `window` (the default) is " +
        "the game's own window and `headless` runs the window too (the result says so). Screenshots, input and /connect " +
        "work in both. `desktop` uses the launcher's normal window (on Windows the same as `window`). On Linux the " +
        "agent's input stays inside gamescope; on Windows it uses the system keyboard and mouse while the game window is " +
        "in the foreground and stops when the user switches away. Only " +
        "the chosen install's game is managed, so a game the user plays from another launcher is left alone. sculkwire " +
        "never runs rgl: for a Regolith project whose profile runs filters, run `rgl run` (or keep `rgl watch` running) " +
        "first. The game then gets what rgl last built (.regolith/tmp): the folder rgl exported into development_*_packs " +
        "is used as it is, and a build exported elsewhere is copied in. When rgl has not built the project the launch " +
        "fails and says so. The result lists " +
        "each deployed pack folder and its absolute path. Returns once the world is loaded, in 1-2 minutes (the call " +
        "blocks for the whole wait). If the world " +
        "join races Microsoft sign-in and the game stops on \"You need to authenticate to Microsoft services\", it " +
        "walks the menus back into the test world without relaunching, and game_status reports joinRecovery. When sculkwire " +
        "cannot start the game itself it returns right away with manualSteps for the user, and game_status shows when " +
        "the game is ready. When the world does not load within worldWaitSeconds the game is stopped, unless " +
        "keepOnTimeout is set: then the result is not ready, manualSteps says how to enter the world, and game_status " +
        "turns ready once it is in. When the install's game is already running (the user opened it) it attaches instead " +
        "of starting one (attached: true, worldMode attached): the game is never restarted and no world is written, so " +
        "fresh, world, keep, copyFrom, userWorld, display, width, height, fps, difficulty and betaApis are not " +
        "applied (worldNote names the ones given); its sound stays on unless mute is true. The in-game agent turns /connect and the content log on live and " +
        "types /script debugger connect and /connect into the open world (needs cheats on); without the agent, or in a " +
        "menu (inWorld false), manualSteps names the commands to type. ready means the script debugger is attached; " +
        "helperNote says when the world lacks the helper pack (game_query, wait_until, game_events and scene_* need it) " +
        "and when game_log has no content-log file. The project's packs load only in a world that already lists them, " +
        "after a rejoin.",
      inputSchema: {
        project: z.string().optional().describe("Add-on project or pack directory to activate in the world. For a Regolith project whose profile runs filters, the packs are what rgl last built (.regolith/tmp); sculkwire does not run rgl, so run `rgl run` first"),
        deploy: z.boolean().optional().describe("Copy the project's packs into development_*_packs, also over the project's sculkwire_* folder an earlier launch left. Default true. A folder rgl exported to is used as it is. Off: only folders that already serve a pack's uuid are used (what rgl built is still deployed)"),
        display: z
          .enum(["window", "headless", "desktop"])
          .optional()
          .describe("headless (Linux default): no window and muted, the game runs in the background; Windows runs the window instead. window: a visible gamescope window on Linux, only when the user wants to watch; the game's own window on Windows (default there). desktop: the launcher's own window (on Windows the same as window)"),
        mute: z.boolean().optional().describe("Silence the game's audio until game_stop (Linux: its streams are kept on a silent sink, through the stop too, and an attached game's streams are moved back to their own output when game_stop detaches; Windows: the game's audio sessions, unmuted again by game_stop). Default: on in headless mode only; window, desktop, a game the user starts and an attached game keep their sound unless this is true. game_status reports muted and muteNote"),
        world: z
          .string()
          .optional()
          .describe("A sculkwire- test world by name (the prefix is added). Omit it unless a second test world is really needed: the default bridge world is reused and replaced on each launch, so no new entry appears in the user's world list"),
        keep: z.boolean().optional().describe("Continue in the existing test world as it is (blocks, inventory, settings) instead of replacing it; it is then never removed automatically. game_stop ends the game without Save & Quit, so blocks changed in the last minute before it may be lost"),
        userWorld: z
          .string()
          .optional()
          .describe("Enter this one of the user's own worlds (level name or level id; a name several worlds share is refused) instead of the saved dev world. ONLY a world the user named: never choose one yourself. Not with world, keep, copyFrom or fresh"),
        fresh: z.boolean().optional().describe("A fresh sculkwire-bridge test world even when the user saved a dev world"),
        copyFrom: z
          .string()
          .optional()
          .describe("Start from a copy of one of the user's worlds (level name or level id); the original is never changed. ONLY for a world the user named or picked: list them with game_worlds and ask the user which one, never choose one yourself"),
        difficulty: z
          .enum(Object.keys(DIFFICULTIES) as [Difficulty, ...Difficulty[]])
          .optional()
          .describe("World difficulty (test world default normal; the user's dev world keeps its own unless this is given). Peaceful removes hostile mobs such as zombies"),
        betaApis: z.boolean().optional().describe("Enable the Beta APIs experiment. In the user's dev world it stays on for good"),
        width: z.number().int().min(320).max(3840).optional(),
        height: z.number().int().min(240).max(2160).optional(),
        fps: z.number().int().min(10).max(240).optional().describe("Frame rate in window and headless modes (default 60)"),
        worldWaitSeconds: z
          .number()
          .int()
          .min(10)
          .max(WORLD_WAIT_MAX_S)
          .optional()
          .describe(`How long to wait for the game to start, and then for the world to load (seconds each; default ${WORLD_WAIT_MS / 1000}, at most ${WORLD_WAIT_MAX_S}). The call blocks that long at most`),
        keepOnTimeout: z
          .boolean()
          .optional()
          .describe("When the wait runs out, keep the game running and return a not-ready status with the step to enter the world (Play, then the test world) instead of stopping the game; sculkwire keeps waiting for 30 min and game_status turns ready once the world is in. Default false"),
      },
      outputSchema: statusSchema,
    },
    async (a) => {
      try {
        await playJobs.stopAll("game_launch restarts the game");
        const s = await bridge.start({
          ...(a.project ? { project: a.project } : {}),
          ...(a.deploy !== undefined ? { deploy: a.deploy } : {}),
          ...(a.display ? { mode: a.display } : {}),
          ...(a.mute !== undefined ? { mute: a.mute } : {}),
          ...(a.world ? { world: a.world } : {}),
          ...(a.keep ? { keep: true } : {}),
          ...(a.copyFrom ? { copyFrom: a.copyFrom } : {}),
          ...(a.userWorld ? { userWorld: a.userWorld } : {}),
          ...(a.fresh ? { fresh: true } : {}),
          ...(a.difficulty ? { difficulty: a.difficulty } : {}),
          ...(a.betaApis ? { betaApis: true } : {}),
          ...(a.width ? { width: a.width } : {}),
          ...(a.height ? { height: a.height } : {}),
          ...(a.fps ? { fps: a.fps } : {}),
          ...(a.worldWaitSeconds ? { timeoutMs: a.worldWaitSeconds * 1000 } : {}),
          ...(a.keepOnTimeout ? { keepOnTimeout: true } : {}),
        });
        return ok(statusText(s), s);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_status",
    {
      title: "Client bridge status",
      description:
        "Whether the client runs, which world and packs are active (worldMode: fresh, kept, copied, user or attached), " +
        "which channels (debugger, /connect) are attached, the user's saved default dev world (defaultWorld), and whether " +
        "the player is dead (dead: the death screen is up or the helper streamed health 0; player_act respawns it). For " +
        "a game game_launch attached to: inWorld, levelId, and helperNote when the helper pack or the content log is missing.",
      inputSchema: {},
      outputSchema: statusSchema,
    },
    async () => {
      const install = bridge.install ?? (await findInstall().catch(() => undefined));
      const defaultWorld = install ? await readDevWorld(install) : undefined;
      const s = { ...bridge.status(), ...(defaultWorld ? { defaultWorld } : {}), ...(bridge.running ? { dead: await bridge.dead() } : {}) };
      return ok(statusText(s), s);
    },
  );

  server.registerTool(
    "game_worlds",
    {
      title: "List, choose or delete worlds",
      description:
        "List every world of the active game user (sculkwire's test worlds and the user's own; `default` marks the saved " +
        "dev world), choose the user's default dev world (action use), or delete one sculkwire test world. Needs no " +
        "running game and never starts one. use saves one of the user's own worlds as the world game_launch enters by " +
        "default (per game user; world null or clear: true forgets it): ONLY the world the user names, so list the worlds, " +
        "ask the user which one, and never pick one yourself. sculkwire changes only sculkwire-* worlds and that one dev " +
        "world (its pack lists, cheats flags, icon, and experiments on request, after a backup); the user's other worlds " +
        "are only listed, or read for game_launch copyFrom, and never deleted. Test worlds not played for " +
        `${STALE_WORLD_DAYS} days are removed by the next game_launch unless kept.`,
      inputSchema: {
        action: z.enum(["list", "use", "delete"]).optional().describe("list (default), use or delete"),
        world: z
          .string()
          .nullable()
          .optional()
          .describe("use: the user's world to save as the default dev world, level name or level id (a name several worlds share is refused: pass the level id); null forgets the saved one. delete: the sculkwire world's name, with or without the sculkwire- prefix"),
        clear: z.boolean().optional().describe("use: forget the saved default dev world"),
      },
      outputSchema: {
        worlds: z
          .array(
            z.object({
              name: z.string(),
              levelId: z.string(),
              sculkwire: z.boolean(),
              kept: z.boolean(),
              copiedFrom: z.string().optional(),
              lastPlayed: z.string(),
              gameMode: z.string().optional(),
              sizeBytes: z.number(),
              loaded: z.boolean(),
              default: z.boolean(),
            }),
          )
          .optional(),
        deleted: z.object({ world: z.string(), existed: z.boolean(), levelIds: z.array(z.string()) }).optional(),
        defaultWorld: z.object({ levelId: z.string(), name: z.string() }).nullable().optional(),
      },
    },
    async ({ action, world, clear }) => {
      try {
        const install = bridge.install ?? (await findInstall());
        const loaded = bridge.running ? bridge.world?.levelId : undefined;
        if (action === "use") {
          if (!clear && world === undefined) throw new Error("use needs world (the user's world to save as the default dev world), or world null / clear: true to forget it");
          const saved = await useDevWorld(install, clear || world === null ? undefined : world);
          return ok(
            saved
              ? `default dev world: ${saved.name} [${saved.levelId}]; game_launch enters it unless world, keep, copyFrom or fresh is given`
              : "no default dev world: game_launch uses sculkwire- test worlds",
            { defaultWorld: saved ?? null },
          );
        }
        if (action === "delete") {
          if (!world) throw new Error("delete needs world: the sculkwire world's name");
          const deleted = await deleteWorld(install, world, loaded !== undefined ? { loaded } : {});
          return ok(deleted.existed ? `deleted ${deleted.world} (${deleted.levelIds.join(", ")})` : `no world ${deleted.world}`, { deleted });
        }
        const devWorld = (await readDevWorld(install))?.levelId;
        const all = await listAllWorlds(install);
        const worlds = all.map((w) => ({
          name: w.name,
          levelId: w.levelId,
          sculkwire: w.sculkwire,
          kept: w.kept,
          ...(w.copiedFrom ? { copiedFrom: w.copiedFrom } : {}),
          lastPlayed: w.lastPlayed.toISOString(),
          ...(w.gameMode ? { gameMode: w.gameMode } : {}),
          sizeBytes: w.sizeBytes ?? 0,
          loaded: w.levelId === loaded,
          default: w.levelId === devWorld,
        }));
        return ok(all.map((w) => worldLine(w, loaded, devWorld)).join("\n") || `no worlds in ${install.label}`, { worlds });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_command",
    {
      title: "Run a game command",
      description:
        "Run a slash command in the running client. Uses /connect when attached (structured status and body), else the " +
        "script debugger (server commands; output from the game's prints, `ok` false when a line is one of the game's " +
        "failure messages such as `No targets matched selector`).",
      inputSchema: {
        command: z.string().describe("Command line, with or without the leading slash"),
        via: z.enum(["auto", "connect", "debugger"]).optional(),
      },
      outputSchema: commandSchema,
    },
    async ({ command, via }) => {
      try {
        const r = await bridge.command(command, via ?? "auto");
        return ok(`${r.ok ? "ok" : "failed"} via ${r.via}: ${r.output.join("\n") || "(no output)"}`, r);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_reload",
    {
      title: "Reload scripts or packs",
      description:
        "Copy the project's current packs into the game again (sculkwire does not run rgl: for a Regolith project whose " +
        "profile runs filters, run `rgl run` or keep `rgl watch` running before reloading; the folder rgl exported to is " +
        "used as it is, a build exported elsewhere is copied again), then run " +
        "`/reload` (scripts and functions; it re-reads known .mcfunction files but does not register a new one) or " +
        "`/reload all`, which the game documents as rejoining the world to reload every pack (new .mcfunction files, new " +
        "or changed blocks, items, entities and other JSON). The retail client 1.26.63 answers " +
        "`/reload all` (over /connect and over the script debugger) like `/reload` and stays in the world, so a new " +
        ".mcfunction file or new JSON content needs a relaunch with game_launch there. When the helper pack does not print ready again (retail `/reload all` over the script " +
        "debugger), it re-establishes the debugger; if that fails the result has a client.helper-lost error and game_status " +
        "shows ready false with the step to take. Returns the redeployed folders and the content-log and script errors " +
        "logged by the reload.",
      inputSchema: { all: z.boolean().optional().describe("Run /reload all instead of /reload") },
      outputSchema: {
        command: z.object(commandSchema),
        diagnostics: z.array(diagnosticSchema),
        redeployed: z.array(z.string()),
        summary: summarySchema,
      },
    },
    async ({ all }) => {
      try {
        const r = await bridge.reload(all ?? false);
        const summary = summarize(r.diagnostics);
        const copied = r.redeployed.length ? `, redeployed ${r.redeployed.length} pack(s)` : "";
        const head = `reload${all ? " all" : ""}${copied}: ${summary.errors} error(s), ${summary.warnings} warning(s)`;
        return ok(r.diagnostics.length ? `${head}\n${diagText(r.diagnostics)}` : head, { ...r, summary });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_log",
    {
      title: "Client content log",
      description:
        "Content-log entries and script errors since the previous call, as diagnostics mapped to the project's files " +
        "(repeated per-frame errors collapsed). Pass `includeText` for the log text in content-log format. `source` says " +
        "where they came from: `file` (the game's log files) or `engine` (the in-game agent's copy of what the game " +
        "logged, used when no content-log file is written, e.g. in a game you opened yourself); `note` says why.",
      inputSchema: { includeText: z.boolean().optional() },
      outputSchema: {
        diagnostics: z.array(diagnosticSchema),
        summary: summarySchema,
        text: z.string().optional(),
        source: z.enum(["file", "engine"]),
        note: z.string().optional(),
      },
    },
    async ({ includeText }) => {
      try {
        const r = await engineLog.read(await bridge.logs(), bridge.indexedPacks);
        const summary = summarize(r.diagnostics);
        const head = `${summary.errors} error(s), ${summary.warnings} warning(s) since the last read${r.source === "engine" ? " (from the in-game agent)" : ""}`;
        const structured: Record<string, unknown> = { diagnostics: r.diagnostics, summary, source: r.source };
        if (r.note) structured.note = r.note;
        if (includeText) structured.text = r.text;
        return ok(r.diagnostics.length ? `${head}\n${diagText(r.diagnostics)}` : head, structured);
      } catch (err) {
        return fail(err);
      }
    },
  );

  const value = z.union([z.string(), z.number(), z.boolean()]);
  const at = { x: z.number(), y: z.number(), z: z.number() };
  const op = z.enum(COMPARE_OPS);
  const condition = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("entity"),
      type: z.string().describe("Entity type id (`zombie` means `minecraft:zombie`)"),
      op: z.enum(["present", "absent", ...COMPARE_OPS]).optional().describe("present (default), absent, or a comparison of the count with `value`"),
      value: z.number().optional(),
      radius: z.number().min(0).max(256).optional().describe("Default 32"),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      dimension: z.string().optional(),
    }),
    z.object({
      kind: z.literal("block"),
      ...at,
      type: z.string(),
      is: z.boolean().optional().describe("false waits until the block is no longer this type (and states); default true"),
      states: z.record(z.string(), value).optional().describe("Block states that must match too"),
      dimension: z.string().optional(),
    }),
    z.object({ kind: z.literal("score"), objective: z.string(), participant: z.string().describe("A player name, or a fake player / score holder name"), op: op.optional().describe("Default =="), value: z.number() }),
    z.object({
      kind: z.literal("event"),
      event: z.string().describe("An event kind (`entityDie`, `playerPlaceBlock`, …) or a /scriptevent id (`myns:done`)"),
      since: z.number().int().min(0).optional().describe("A game_events cursor; default the moment the wait starts"),
      match: z.record(z.string(), value).optional().describe("Event fields that must be equal (`{\"typeId\":\"minecraft:zombie\"}`)"),
    }),
    z.object({
      kind: z.literal("log"),
      pattern: z.string().optional().describe("Regex (case-insensitive) a new diagnostic or log line must match; default any new diagnostic"),
      errorsOnly: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("player"), ...at, radius: z.number().min(0) }),
    z.object({ kind: z.literal("ticks"), ticks: z.number().int().min(0).max(1_100) }),
  ]);

  server.registerTool(
    "wait_until",
    {
      title: "Wait for a condition",
      description:
        "Wait, in one call, until a world condition holds: `entity` (type present, absent or a count near the player or " +
        "x/y/z), `block` (block at x/y/z is or is not a type, with states), `score` (objective, participant, comparison), " +
        "`event` (an in-world event or /scriptevent id after a game_events cursor, fields matched), `log` (a new " +
        "content-log diagnostic or log line matching a regex), `player` (within radius of x/y/z) or `ticks` (n game " +
        "ticks). The helper pack checks every tick. Returns met, timedOut, elapsedMs, ticks and the last value observed.",
      inputSchema: {
        condition,
        timeoutMs: z.number().int().min(0).max(WAIT_MAX_MS).optional().describe(`Default ${WAIT_DEFAULT_MS}, at most ${WAIT_MAX_MS}`),
      },
      outputSchema: { met: z.boolean(), timedOut: z.boolean(), elapsedMs: z.number(), ticks: z.number().optional(), observed: z.unknown() },
    },
    async ({ condition, timeoutMs }) => {
      try {
        const r = await waitUntil(bridge, condition, timeoutMs);
        const ticks = r.ticks === undefined ? "" : `, ${r.ticks} ticks`;
        const head = r.met ? `met after ${r.elapsedMs} ms${ticks}` : `timed out after ${r.elapsedMs} ms${ticks}`;
        return ok(`${head}; observed ${JSON.stringify(r.observed)}`, r);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_events",
    {
      title: "In-world events",
      description:
        "In-world events the helper pack buffered (the newest 2000), after cursor `since`: scriptevent (other than " +
        "sculkwire's own), entitySpawn, entityDie, entityHurt, playerBreakBlock, playerPlaceBlock, itemUse, " +
        "itemCompleteUse, playerInteractWithBlock, playerInteractWithEntity, effectAdd. Pass `next` back as `since` to " +
        "read on; `since: \"now\"` returns only the current cursor. `dropped` counts events lost to the buffer.",
      inputSchema: {
        since: z.union([z.number().int().min(0), z.literal("now")]).optional().describe("Cursor (`next` of the last call); default 0, every event kept"),
        kinds: z.array(z.string()).optional().describe("Only these event kinds"),
        limit: z.number().int().min(1).max(500).optional().describe("Default 100"),
      },
      outputSchema: {
        tick: z.number(),
        events: z.array(z.object({ seq: z.number(), tick: z.number(), kind: z.string() }).passthrough()),
        next: z.number(),
        dropped: z.number(),
        reset: z.boolean(),
      },
    },
    async (args) => {
      try {
        const r = await readEvents(bridge, args);
        const lost = r.dropped ? `, ${r.dropped} dropped` : "";
        const reset = r.reset ? " (the helper restarted: cursor reset)" : "";
        const lines = r.events.slice(0, 20).map((e) => JSON.stringify(e));
        if (r.events.length > 20) lines.push(`… ${r.events.length - 20} more`);
        return ok([`${r.events.length} event(s), next ${r.next}${lost}${reset}`, ...lines].join("\n"), r);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_screenshot",
    {
      title: "Screenshot the client",
      description:
        "PNG of what the game shows right now (Linux window or headless mode, or Windows). On Windows the window is " +
        "captured while covered; when it delivers an empty frame it is copied from the screen, which needs the game " +
        "window in the foreground. Returned as an image plus the saved file path.",
      inputSchema: { path: z.string().optional().describe("Where to save the PNG (default under sculkwire's data dir)") },
      outputSchema: { path: z.string(), bytes: z.number() },
    },
    async ({ path }) => {
      try {
        const out = path ?? dataDir("client", "screenshots", `shot-${Date.now()}.png`);
        await mkdir(dirname(out), { recursive: true });
        const r = await bridge.screenshot(out);
        const data = (await readFile(r.path)).toString("base64");
        return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: r.path }], structuredContent: { ...r } };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_query",
    {
      title: "Query the world",
      description:
        "Ask the in-world helper pack: `player` (players with position, rotation, game mode), `entities` (near the player " +
        "or x/y/z: type, position, tags, health, active effects with 0-based amplifier and duration in ticks), " +
        "`blocks` (non-air blocks in a cube with states), `block` (one block), `components` (an entity's components " +
        "with their readable values), `dynamic_properties` (world, player or entity, with total bytes), `scores` " +
        "(scoreboard objectives and scores), `raycast` (first block and the entities along a ray), `entity_properties` " +
        "(values of the properties an entity file declares). `entity` picks an entity by id, else `type` the nearest one, " +
        "else the player. When the helper pack does not answer (a world without it), `player`, `entities`, `block` and " +
        "`blocks` are read from the game's memory through the in-game agent instead: `source` is `engine` and `note` says " +
        "why; that route has no tags, effects, name tags or game mode. The other kinds need the helper pack.",
      inputSchema: {
        kind: z.enum(["player", "entities", "blocks", "block", "ping", "components", "dynamic_properties", "scores", "raycast", "entity_properties"]),
        type: z.string().optional().describe("Filter by entity/block type id; components, dynamic_properties, entity_properties: the nearest entity of this type"),
        types: z.array(z.string()).optional().describe("blocks: keep any of these block type ids (one scan for several types)"),
        radius: z.number().min(0).max(256).optional(),
        limit: z.number().int().min(1).max(1000).optional().describe("entities: at most 200 (default 50); scores: rows (default 100); dynamic_properties: ids (default 500)"),
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
        dimension: z.string().optional(),
        entity: z.string().optional().describe("components, dynamic_properties, entity_properties: entity id from `entities`"),
        target: z.enum(["world", "player", "entity"]).optional().describe("dynamic_properties: whose (default world, or entity when `entity`/`type` is given); others: player or entity"),
        ids: z.array(z.string()).optional().describe("components: only these component ids; entity_properties: property ids (default those the project's entity file declares)"),
        prefix: z.string().optional().describe("dynamic_properties: only ids starting with this"),
        objective: z.string().optional().describe("scores: only this objective id"),
        participant: z.string().optional().describe("scores: only this player name, fake player name or entity id"),
        direction: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional().describe("raycast: ray direction (default the player's view)"),
        to: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional().describe("raycast: cast toward this point instead of `direction`"),
        maxDistance: z.number().min(0).max(64).optional().describe("raycast: ray length (default 16, or the distance to `to`)"),
        includeLiquidBlocks: z.boolean().optional().describe("raycast: water and lava stop the ray (default false)"),
        includePassableBlocks: z.boolean().optional().describe("raycast: passable blocks such as grass stop the ray (default false)"),
      },
      outputSchema: { result: z.unknown(), source: z.enum(["script", "engine"]), note: z.string().optional() },
    },
    async ({ kind, ...input }) => {
      const params: Record<string, unknown> = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      let helperError: unknown;
      try {
        if (kind === "entity_properties" && !input.ids?.length) {
          params.ids = await entityPropertyIdsFor(input, { query: (k, p) => bridge.query(k, p), declared: (t) => bridge.entityPropertyIds(t) });
        }
        const result = await bridge.query(kind, params);
        const text = JSON.stringify(result);
        return ok(text.length > 4000 ? `${text.slice(0, 4000)}…` : text, { result, source: "script" });
      } catch (err) {
        helperError = err;
      }
      // The helper's own refusal (bad input, nothing there) is the answer; only a helper that did not answer falls back.
      if (helperError instanceof HelperQueryError) return fail(helperError);
      const why = errorMessage(helperError);
      try {
        const answer = await engineQuery(kind, params);
        if (!answer) return fail(new Error(`${why}; ${kind} needs the helper pack (the in-game agent answers only player, entities, block and blocks)`));
        if (!answer.ok) return fail(new Error(`${why}; the in-game agent did not answer either: ${answer.message}`));
        const note = `the helper pack did not answer (${why}); read from the game's memory through the in-game agent`;
        const text = JSON.stringify(answer.value);
        return ok(`${text.length > 4000 ? `${text.slice(0, 4000)}…` : text}\n${note}`, { result: answer.value, source: "engine", note });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_registry",
    {
      title: "Game registries",
      description:
        "Every block, item or mob id the running game knows (including add-on content). Asks /connect's data request " +
        "first; when no /connect client is attached, or the game answers an empty list (the retail client does), the " +
        "helper pack lists the ids through the Script API (BlockTypes, ItemTypes, EntityTypes; mob then means every " +
        "entity type). `source` says which answered (`connect` or `script`), and `note` why the helper pack did.",
      inputSchema: { kind: z.enum(["block", "item", "mob"]) },
      outputSchema: { kind: z.string(), source: z.enum(["connect", "script"]), entries: z.array(z.unknown()), note: z.string().optional() },
    },
    async ({ kind }) => {
      try {
        const r = await bridge.registry(kind);
        return ok(`${r.entries.length} ${kind} entries via ${r.source}${r.note ? ` (${r.note})` : ""}`, r);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_input",
    {
      title: "Keyboard and mouse input",
      description:
        "Drive the client like a player: `key` (xdotool key names, e.g. `w`, `space`, `Escape`, `Shift_L`, `F3`, chords " +
        "like `ctrl+a`, several separated by spaces), `type` (text), `click` / `move` at x,y in screenshot pixels. With " +
        "the in-game agent attached, keys, text and left/right clicks go through the game's own UI instead (`game_ui`), " +
        "which works in the background and on Windows without the foreground; `move` and a middle click always take the " +
        "route below. Linux: into gamescope's own display, never the user's desktop. Windows: the system keyboard and " +
        "mouse after bringing the game window to the foreground; fails with \"the game window is not in the foreground\" " +
        "when the user switches away before the input is sent. `route` says which way the input went: `engine` (the " +
        "in-game agent's UI), `gamescope` (xdotool into gamescope's display) or `windows` (SendInput).",
      inputSchema: {
        action: z.enum(["key", "type", "click", "move"]),
        keys: z.string().optional(),
        text: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        button: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      },
      outputSchema: { done: z.boolean(), route: z.enum(["engine", "gamescope", "windows"]) },
    },
    async (a) => {
      try {
        if (await inputThroughUi(a)) return ok("done via engine", { done: true, route: "engine" });
        let route: InputRoute;
        if (a.action === "key") {
          if (!a.keys) throw new Error("key needs `keys`");
          route = await bridge.input({ action: "key", keys: a.keys });
        } else if (a.action === "type") {
          if (a.text === undefined) throw new Error("type needs `text`");
          route = await bridge.input({ action: "type", text: a.text });
        } else {
          if (a.x === undefined || a.y === undefined) throw new Error(`${a.action} needs x and y`);
          route = await bridge.input(a.action === "click" ? { action: "click", x: a.x, y: a.y, ...(a.button ? { button: a.button } : {}) } : { action: "move", x: a.x, y: a.y });
        }
        return ok(`done via ${route}`, { done: true, route });
      } catch (err) {
        return fail(err);
      }
    },
  );

  const vec = z.object({ x: z.number(), y: z.number(), z: z.number() });
  const playerStateSchema = z
    .object({
      location: vec,
      rotation: z.object({ x: z.number(), y: z.number() }),
      onGround: z.boolean(),
      selectedSlot: z.number(),
      health: z.number().optional(),
      holding: z.object({ typeId: z.string(), amount: z.number() }).optional(),
      lookingAtBlock: z.object({ typeId: z.string(), location: vec, face: z.string() }).optional(),
      lookingAtEntity: z.object({ id: z.string(), typeId: z.string(), distance: z.number() }).optional(),
    })
    .passthrough();
  const actionSchema = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("move_to"),
      x: z.number(),
      z: z.number(),
      y: z.number().optional(),
      radius: z.number().min(0.3).max(10).optional().describe("Stop within this many blocks (default 0.7)"),
      sprint: z.boolean().optional(),
      look: z.string().optional().describe("Entity id to keep looking at while walking (strafes and sprints relative to the view)"),
      timeoutMs: z.number().int().min(500).max(300_000).optional(),
    }),
    z.object({
      action: z.literal("goto"),
      x: z.number().optional(),
      y: z.number().optional().describe("Height to arrive at. Without it any height at x/z counts"),
      z: z.number().optional(),
      entity: z.string().optional().describe("Entity id to walk to (followed while it moves) instead of x/z"),
      radius: z.number().min(0.3).max(10).optional().describe("Stop within this many blocks (default 0.7, 2 for an entity)"),
      sprint: z.boolean().optional().describe("Sprint on straight stretches (default true)"),
      look: z.string().optional().describe("Entity id to keep looking at while walking"),
      timeoutMs: z.number().int().min(500).max(300_000).optional().describe("Default 60000"),
    }),
    z.object({
      action: z.literal("look_at"),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      entity: z.string().optional().describe("Entity id from game_query"),
      yaw: z.number().optional().describe("0 = south (+Z), 90 = west (-X)"),
      pitch: z.number().optional().describe("-90 up to 90 down"),
    }),
    z.object({
      action: z.literal("attack"),
      entity: z.string().optional().describe("Entity id; default the nearest entity (of `type`)"),
      type: z.string().optional().describe("e.g. minecraft:zombie"),
      hits: z.number().int().min(1).max(100).optional(),
      timeoutMs: z.number().int().min(500).max(300_000).optional(),
    }),
    z.object({
      action: z.literal("shoot"),
      entity: z.string().optional().describe("Entity id; default the nearest entity (of `type`) within 64 blocks"),
      type: z.string().optional().describe("e.g. minecraft:cow"),
      projectile: z
        .enum(["snowball", "egg", "ender_pearl", "arrow", "trident"])
        .optional()
        .describe("Default from the held item (bow = arrow). The matching item must be in hand"),
      holdMs: z.number().int().min(0).max(30_000).optional().describe("Draw time for bows and tridents (default 1100), click length for thrown items"),
      shots: z.number().int().min(1).max(20).optional().describe("Tries until one hits (default 1)"),
      timeoutMs: z.number().int().min(500).max(300_000).optional().describe("Aiming time per shot (default 15000)"),
    }),
    z.object({ action: z.literal("use_item"), holdMs: z.number().int().min(0).max(30_000).optional().describe("Hold right click (bows, food)") }),
    z.object({ action: z.literal("mine"), holdMs: z.number().int().min(0).max(30_000).optional().describe("Hold left click (default 1000)") }),
    z.object({ action: z.literal("select_slot"), slot: z.number().int().min(1).max(9) }),
    z.object({ action: z.literal("jump") }),
    z.object({ action: z.literal("sneak"), on: z.boolean() }),
    z.object({ action: z.literal("hold"), keys: z.array(z.string()).min(1).describe("xdotool key names, e.g. w, a, space, Shift_L (mapped to the same keys on Windows)"), ms: z.number().int().min(0).max(30_000) }),
    z.object({ action: z.literal("wait"), ms: z.number().int().min(0).max(60_000) }),
    z.object({
      action: z.literal("fight"),
      target: z.string().optional().describe("Entity id or type (zombie, minecraft:skeleton). Default the nearest hostile mob"),
      all: z.boolean().optional().describe("Go on to the next hostile (of the type) after a kill. Default true unless target is an id"),
      radius: z.number().min(1).max(64).optional().describe("Only targets within this many blocks (default 16)"),
      crits: z.boolean().optional().describe("Jump for critical hits (default true)"),
      stance: z
        .enum(STANCES)
        .optional()
        .describe("Shield against melee mobs: auto (default) is footwork, with the shield only when boxed in (under 1 block of free run behind); kite never raises it; guard keeps it up with a melee mob within about 3.6 blocks, strikes in the window after a block and steps out when no window opens"),
      timeoutMs: z.number().int().min(500).max(300_000).optional().describe("Default 60000"),
    }),
    z.object({
      action: z.literal("flee"),
      from: z.string().optional().describe("Entity id or type to get away from. Default every hostile mob within 24 blocks"),
      distance: z.number().min(2).max(64).optional().describe("Done once every threat is this far (default 12)"),
      timeoutMs: z.number().int().min(500).max(300_000).optional().describe("Default 8000"),
    }),
    z.object({
      action: z.literal("eat"),
      slot: z.number().int().min(1).max(9).optional().describe("Hotbar slot to eat from. Default the best food for the current food level"),
      timeoutMs: z.number().int().min(500).max(30_000).optional(),
    }),
    z.object({
      action: z.literal("use_on"),
      target: z.string().describe("Entity id or type to hit once with the held item (thrown or shot when it is a projectile)"),
      all: z.boolean().optional().describe("Every one of the type in range that was not hit yet (default true for a type)"),
      radius: z.number().min(1).max(64).optional().describe("Default 24"),
      timeoutMs: z.number().int().min(500).max(300_000).optional(),
    }),
    z.object({ action: z.literal("respawn") }),
    z.object({
      action: z.literal("play"),
      goal: z
        .string()
        .min(1)
        .describe(
          "What to achieve, in plain words, one or more steps: e.g. \"kill 3 zombies\", \"go to 10 64 -20\", \"hit every cow near you once with the held item\", " +
            "\"smelt the ore and craft an iron sword\", \"get the diamonds out of the chest\", \"trade for an emerald\", \"kill the zombie then go to the gold block\". " +
            "\"with the shield up\" or \"keep your distance\" set the fights' stance",
        ),
      durationMs: z.number().int().min(1000).max(PLAY_MAX_DURATION_MS).optional().describe(`Time limit (default ${PLAY_DEFAULT_DURATION_MS})`),
      stepMs: z.number().int().min(100).max(1000).optional().describe(`Time between tactic decisions (default ${PLAY_DEFAULT_STEP_MS})`),
      allow: z
        .array(z.enum(TACTICS))
        .optional()
        .describe(`Tactics play may use, from ${TACTICS.join(", ")}. Default all. idle is always allowed`),
      stance: z.enum(STANCES).optional().describe("The fights' shield stance, as fight's stance (default the goal's standing order, else auto)"),
      maxDeaths: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe(`Deaths play respawns from and goes on with the goal (default ${PLAY_DEFAULT_MAX_DEATHS}); the next death stops it with died. 0: stop at the first death`),
    }),
  ]);

  server.registerTool(
    "player_act",
    {
      title: "Play like a player",
      description:
        "Control the player like a person playing: walk to a spot (steering and jumping), find a way there over the " +
        "blocks (goto: around walls, up steps and stairs, down drops of up to 3 blocks, over gaps, through doors, " +
        "away from lava), look at a point or entity, " +
        "attack (walks into range first), shoot a projectile at a moving entity (leads it along the ballistic arc " +
        "and reports hit or miss from the game's impact log), use or " +
        "mine with the held item, change hotbar slot, jump, sneak, hold keys. Skills run whole behaviors: fight " +
        "(melee with the best weapon in one loop over a whole group: it waits for chasing mobs at the edge of reach " +
        "instead of walking into them, strikes whichever mob in reach can take a hit, gives ground whenever a mob would " +
        "get it in reach, and when boxed in (under 1 block of free run behind) raises the shield 400 ms " +
        "before the attack due by that mob's attack clock and strikes only in the window after a block (stance auto, kite or guard), " +
        "jumps in place for critical hits, backs off from a creeper about to blow, then takes the next hostile; its result " +
        "counts kills by type, swings, hits, misses, critical hits, hits taken, damage taken, hits blocked and the time), " +
        "flee (sprints away from threats), eat (best food in the hotbar) and use_on (hits each entity of a type once with " +
        "the held item), respawn (presses RESPAWN on the death screen: by its control name through the in-game agent, " +
        "else a click at its place; never Game menu). A call that starts while the player is dead respawns first and " +
        "says so in `respawned`; it fails when RESPAWN does not bring the player back. " +
        "Pass several actions to run them in order in one call; it " +
        "stops at the first failure unless continueOnError. Returns each action's result and the player's final state. " +
        "Input goes as keyboard and mouse: on Linux into gamescope's own display (xdotool), on Windows through the " +
        "system keyboard and mouse (SendInput) after bringing the game window to the foreground once when the call " +
        "starts. On Windows input only reaches the game while its window is in the foreground: when the user switches " +
        "away, every key and button is let go, the running action stops with \"the game window is not in the " +
        "foreground\" and a play job pauses until the game window is in the foreground again or player_job stop. " +
        "When the in-game agent is attached (engine_attach), input goes through it instead whenever it answers (the " +
        "engine route); an extension's own input provider takes its place while installed. `input` forces one route. When the engine " +
        "route fails mid-action, the action is redone with the keyboard and its message says so. " +
        "When the client cancels the call or it times out, the running action stops and every key and button is let go. " +
        "On the engine route the provider's input lock keeps the user's own keyboard and mouse out of the game while " +
        "actions or a play job run. When the user presses F9 to take control, the running action " +
        "stops with \"the user took control (F9)\" and a play job pauses until F9 gives control back or player_job stop. " +
        "The `play` action pursues a goal on its own. The goal is first compiled into a plan: steps run one after another " +
        "(kill N of a type or every hostile near, go to coordinates, hit every X once, craft, smelt, trade with a villager, " +
        "take an item out of the chests near (also out of a shulker box in one), hold or wear an item, go to a block or a " +
        "mob, survive N seconds) and standing orders (the shield stance), read by a deterministic grammar. For a combat or movement step every 250 ms it " +
        "reads a threat map (hostile mobs, their distance, speed and creeper fuses, plus health, food, armor, weapon and " +
        "food in the hotbar), checks the step and picks a tactic (fight, flee, eat, goto, use the held item on a mob, " +
        "idle) with built-in scores; a fight is one continuing step that moves from mob to mob by itself. A task step " +
        "runs as one procedure while the loop watches: a hit or a hostile within 6 blocks aborts it, the player fights or " +
        "flees until clear and tries it again (at most 2 retries). Every step is checked against the game; the run ends " +
        "when the last one is done. A part of the goal the grammar did not understand does not idle to the time limit: once the placed " +
        "steps are done and there has been nothing to do for 5 s (no hostile near), the run stops with goal_unknown, " +
        "quoting that part and listing the forms play understands with an example each; a goal that says to survive, defend or wait " +
        "(\"survive for 30 seconds\") runs to its time. `play` runs in the background and the call returns at once with a job id. " +
        "A kill step counts its targets that died by another mob's attack within its radius (spear husks run each " +
        "other through) next to the player's kills, and stops with targets_gone once none of its targets is left within " +
        "the radius before the count is reached. " +
        "Follow it with player_job (status, wait, stop), which returns the current plan step while it runs and, once it " +
        "ends, the stop reason, the plan (per step: kind, done or not, message, task actions and inventory change), " +
        "kills, hits, misses, critical hits, " +
        "hits taken, damage taken, hits blocked, deaths and a trace of every tactic. A death mid-goal respawns and the goal goes on " +
        "(the death is logged and counted), up to maxDeaths times (default 3); the next death, or a respawn that fails, " +
        "stops the run with died. `play` must be the last action. Only one play job runs at a time, a new one " +
        "stops the old one, and other actions are refused while one runs. The keyboard route needs game_launch with " +
        "display window or headless on Linux, or any display on Windows; with the in-game agent attached, the engine " +
        "route also drives a Linux desktop-mode game (input auto or engine; keyboard is refused there).",
      inputSchema: {
        actions: z.array(actionSchema).min(1).max(50),
        continueOnError: z.boolean().optional(),
        input: z
          .enum(["auto", "engine", "keyboard"])
          .optional()
          .describe("Input route. auto (default): the engine route (the attached in-game agent, or an extension's input provider) when it answers, else keyboard and mouse. engine fails when no provider can be used"),
      },
      outputSchema: {
        results: z.array(
          z.object({
            action: z.string(),
            ok: z.boolean(),
            message: z.string(),
            durationMs: z.number(),
            input: z.enum(["engine", "keyboard"]).optional(),
            fight: z
              .object({
                kills: z.record(z.string(), z.number()).describe("Short mob type -> kills by the player"),
                swings: z.number(),
                hits: z.number(),
                misses: z.number().describe("Swings that struck nothing"),
                crits: z.number(),
                hitsTaken: z.number().describe("Health drops the fight saw"),
                damageTaken: z.number(),
                blocked: z.number().describe("Hits the raised shield took (needs the helper's off-hand durability reading)"),
                timeMs: z.number(),
              })
              .optional()
              .describe("fight only: what this fight did"),
          }),
        ),
        state: playerStateSchema,
        job: z.string().optional().describe("Id of the play job this call started"),
        respawned: z.string().optional().describe("The player was dead when the call started: how RESPAWN was pressed before the actions"),
        status: z.literal("running").optional(),
      },
    },
    async ({ actions, continueOnError, input }, extra) => {
      try {
        const provider = inputProvider();
        const paused = provider?.pausedReason();
        if (paused) throw new Error(paused);
        const all = actions as (PlayerAction | PlayAction)[];
        const playIndex = all.findIndex((a) => a.action === "play");
        if (playIndex !== -1 && playIndex !== all.length - 1) throw new Error("`play` must be the last action, since it runs in the background after the others");
        const spec = playIndex === -1 ? undefined : (all[playIndex] as PlayAction);
        const steps = all.filter((a): a is PlayerAction => a.action !== "play");
        const running = playJobs.current;
        if (running && steps.length) {
          throw new Error(`play job ${running.id} is controlling the player. Stop it with player_job action stop (or wait for it) before sending other actions`);
        }
        const controller = bridge.playerController();
        const route = await controller.selectInput(input ?? "auto");
        const lines: string[] = [`input: ${route}`];
        // A player left on the death screen respawns before anything else runs (a running play job respawns by itself).
        let respawned: string | undefined;
        if (!running && (await bridge.dead())) {
          const revived = await bridge.respawn();
          if (!revived.respawned && revived.via !== "alive") throw new Error(`the player is dead and did not respawn: ${revived.detail}`);
          if (revived.respawned) {
            respawned = revived.detail;
            lines.push(`the player was dead: ${revived.detail}`);
          }
        }
        if (controller.inputNote) lines.push(controller.inputNote);
        if (route === "keyboard" && provider?.keyboardNote) lines.push(provider.keyboardNote);
        // The provider's input lock is held while these actions or the play job run, on the engine route only.
        const locking = route === "engine" ? provider : undefined;
        // Windows keyboard route: the game window comes forward once now; losing it stops the actions and pauses play.
        const gate = route === "keyboard" ? controller.world.input.foreground : undefined;
        await gate?.activate();
        const lost = new AbortController();
        const offLost = gate?.onTakeover(() => lost.abort());
        const unhold = await locking?.hold();
        let results: ActionResultOut[];
        let job: PlayJobInfo | undefined;
        try {
          results = await runActions(controller, steps, {
            continueOnError: continueOnError ?? false,
            signal: AbortSignal.any([extra.signal, lost.signal]),
            onResult: (r, i) => {
              if (lost.signal.aborted && !extra.signal.aborted && r.message === "cancelled") r.message = FOREGROUND_MESSAGE;
              lines.push(`${r.ok ? "ok" : "FAILED"} ${r.action}: ${r.message} (${r.durationMs} ms)`);
              notifyProgress(extra, i + 1, all.length, `${r.action} ${r.ok ? "ok" : "failed"}`);
            },
          });
          if (extra.signal.aborted) throw new Error("cancelled by the client, keys and buttons released");
          if (lost.signal.aborted && spec) lines.push(`play not started: ${FOREGROUND_MESSAGE}`);
          else if (spec && results.every((r) => r.ok || continueOnError)) {
            const env = {
              controller,
              entities: async (radius: number) => (await bridge.query("entities", { radius, limit: 50 })) as EntityInfo[],
              loadout: async () => (await bridge.query("loadout")) as Loadout,
              deaths: async (since: number) => (await bridge.query("deaths", { since })) as { tick: number; deaths: Death[] },
              paused: () => provider?.pausedReason() !== undefined,
              tasks: () => liveTaskEnv({ controller }),
              respawn: () => bridge.respawn(),
            };
            job = await playJobs.start(spec.goal, ({ signal, onStep, onPlan }) =>
              withInputLock(locking, () => play(spec, pauseOnTakeover(env, locking?.input.takeover ?? gate, signal), { signal, onStep, onPlan })),
            );
            results.push({ action: "play", ok: true, message: `started job ${job.id}`, durationMs: 0 });
            lines.push(`play job ${job.id} running: "${spec.goal}". Follow it with player_job (status, wait, stop)`);
          } else if (spec) lines.push("play not started because an earlier action failed");
        } finally {
          offLost?.();
          await unhold?.();
        }
        const state = await bridge.playerState(500);
        lines.push(`at ${state.location.x}, ${state.location.y}, ${state.location.z}, facing yaw ${state.rotation.y.toFixed(0)} pitch ${state.rotation.x.toFixed(0)}`);
        return ok(lines.join("\n"), { results, state, ...(job ? { job: job.id, status: "running" } : {}), ...(respawned ? { respawned } : {}) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  const jobSchema = {
    id: z.string(),
    goal: z.string(),
    status: z.enum(["running", "done", "stopped", "failed"]),
    startedAt: z.number(),
    progress: z.object({
      steps: z.number(),
      elapsedMs: z.number(),
      lastActions: z.array(z.string()),
      planStep: z.string().optional().describe("The plan step being worked on, e.g. \"step 2 of 3: craft iron sword\""),
    }),
    stopReason: z.string().optional(),
    result: z.object({}).passthrough().optional(),
    error: z.string().optional(),
  };

  server.registerTool(
    "player_job",
    {
      title: "Follow a play job",
      description:
        "Follow the background `play` job that player_act started. `status` returns its progress (steps, elapsed time, " +
        "the plan step being worked on, last actions). `wait` blocks until the job ends or 25 s pass, whichever is first, so " +
        "it stays under the client's call timeout, and can be called again. `stop` ends it and lets go of every key. " +
        "Once the job has ended, each action returns the full result with the trace of every step, the stop reason and " +
        "the final player state. Without `id` it uses the running job, else the latest one. A job paused by the user's " +
        "F9 takeover stays running and continues when the user presses F9 again; on Windows a job paused because the " +
        "game window left the foreground continues once it is in the foreground again. Jobs also stop on " +
        "game_stop, game_launch and when the server shuts down.",
      inputSchema: {
        action: z.enum(["status", "stop", "wait"]),
        id: z.string().optional().describe("Job id from player_act, e.g. play-1"),
        timeoutMs: z.number().int().min(0).max(JOB_WAIT_MAX_MS).optional().describe(`wait only. Longest to block (default and maximum ${JOB_WAIT_MAX_MS})`),
      },
      outputSchema: jobSchema,
    },
    async ({ action, id, timeoutMs }, extra) => {
      try {
        let j: PlayJobInfo;
        if (action === "stop") j = await playJobs.stop(id);
        else if (action === "wait") {
          j = await playJobs.wait(id, timeoutMs ?? JOB_WAIT_MAX_MS, {
            signal: extra.signal,
            onStep: (step) => notifyProgress(extra, step.step, undefined, stepText(step)),
          });
        } else j = playJobs.status(id);
        return ok(jobText(j), j);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "player_state",
    {
      title: "Player state",
      description:
        "The player's position, rotation, velocity, health, held item and selected slot (1-9), and the block and entity " +
        "under the crosshair. Streamed from the game, so this is fast.",
      inputSchema: {},
      outputSchema: { state: playerStateSchema },
    },
    async () => {
      try {
        const state = await bridge.playerState(300);
        return ok(JSON.stringify(state), { state });
      } catch (err) {
        return fail(err);
      }
    },
  );

  const sceneName = z.string().regex(SCENE_NAME).describe("Scene name: 1-32 of a-z, 0-9, _ and -");
  const vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });
  const sceneBox = z.object({ min: vec3, max: vec3 });
  const scenesLast =
    "Scenes live in the world (a structure plus a world dynamic property), so they last as long as the world: with the " +
    "default game_launch (the test world is replaced each launch) one session, with `keep: true` or `copyFrom` across launches.";

  server.registerTool(
    "scene_save",
    {
      title: "Save a scene",
      description:
        "Save a named test start in the running world: the blocks and entities in a box around x/y/z (default the " +
        "player) as a world structure, and the player's position, rotation, dimension, game mode, health, hunger, " +
        "saturation, selected slot and whole inventory with armour and off hand (amounts, name tags, lore, " +
        "enchantments, durability damage), plus the time of day and the weather. A scene of the same name is " +
        "overwritten. scene_reset puts it all back. " +
        scenesLast,
      inputSchema: {
        name: sceneName,
        radius: z
          .number()
          .int()
          .min(0)
          .max(SCENE_MAX_RADIUS)
          .optional()
          .describe(`Half the box's side in blocks (default ${SCENE_DEFAULT_RADIUS}); the box is cut to the world's height range`),
        x: z.number().optional().describe("Box center; give x, y and z together (default the player's position)"),
        y: z.number().optional(),
        z: z.number().optional(),
      },
      outputSchema: {
        name: z.string(),
        overwritten: z.boolean(),
        dimension: z.string(),
        box: sceneBox,
        entities: z.number(),
        items: z.number(),
        notes: z.array(z.string()),
      },
    },
    async (input) => {
      try {
        const r = await saveScene(input);
        const { min, max } = r.box;
        const box = `${min.x} ${min.y} ${min.z} to ${max.x} ${max.y} ${max.z}`;
        const notes = r.notes.length ? `; ${r.notes.join("; ")}` : "";
        return ok(`${r.overwritten ? "overwrote" : "saved"} scene ${r.name}: ${box} in ${r.dimension}, ${r.entities} entities, ${r.items} items${notes}`, r);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "scene_reset",
    {
      title: "Reset to a scene",
      description:
        "Put the world back to a scene saved with scene_save: removes the non-player entities in its box, places its " +
        "blocks and entities back, clears and refills the player's inventory, armour and off hand, teleports the " +
        "player with rotation and dimension, sets game mode, health, hunger, saturation and selected slot, clears " +
        "effects, and restores the time of day and the weather. `restored` lists what was put back; `notes` says what " +
        "could not be (an item or enchantment this game no longer accepts, weather that was unknown at save). Fails " +
        "with \"no scene named <name> in this world\" when there is none.",
      inputSchema: { name: sceneName },
      outputSchema: {
        name: z.string(),
        dimension: z.string(),
        box: sceneBox,
        removedEntities: z.number(),
        restored: z.array(z.string()),
        notes: z.array(z.string()),
      },
    },
    async ({ name }) => {
      try {
        const r = await resetScene(name);
        const notes = r.notes.length ? `; not restored: ${r.notes.join("; ")}` : "";
        return ok(`reset to scene ${r.name}: ${r.restored.join(", ")}; removed ${r.removedEntities} entities${notes}`, r);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "scene_list",
    {
      title: "List or delete scenes",
      description:
        "The scenes saved in the running world (name, save time, dimension, box, player position, whether its " +
        "structure is still there), or with `delete`, remove that scene's structure and stored state first. " +
        scenesLast,
      inputSchema: { delete: sceneName.optional().describe("Delete this scene, then list the rest") },
      outputSchema: {
        scenes: z.array(
          z.object({
            name: z.string(),
            savedAt: z.number().optional(),
            dimension: z.string().optional(),
            box: sceneBox.optional(),
            position: vec3.optional(),
            structure: z.boolean().optional(),
            error: z.string().optional(),
          }),
        ),
        deleted: z.string().optional(),
      },
    },
    async (input) => {
      try {
        if (input.delete !== undefined) await deleteScene(input.delete);
        const scenes = await listScenes();
        const names = scenes.length ? scenes.map((s) => s.name).join(", ") : "no scenes in this world";
        if (input.delete === undefined) return ok(names, { scenes });
        return ok(`deleted scene ${input.delete}; left: ${names}`, { scenes, deleted: input.delete });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "game_stop",
    {
      title: "Stop the client",
      description:
        "Quit the game, close the bridge and restore the options.txt keys and game settings sculkwire changed " +
        "(settings live while the game still runs, both in options.txt). In the user's dev world (worldMode user) it first " +
        "tries Save & Quit through the pause menu (up to 45 s; savedAndQuit says whether it worked, stopNote what was " +
        "lost otherwise), puts the world's own icon back, and keeps the helper pack and the project's packs in its pack " +
        "lists and their development pack folders (keptPackFolders). In test worlds the game is ended without Save & Quit. " +
        "A game game_launch attached to (one the user opened) is never closed: game_stop only detaches (detached: true), " +
        "putting back the settings it turned on live and the options.txt keys, closing the listeners and keeping the " +
        "pack folders the open world uses; the in-game agent stays loaded in the game.",
      inputSchema: {},
      outputSchema: {
        stopped: z.boolean(),
        message: z.string(),
        restoredOptions: z.record(z.string(), z.array(z.string())),
        restoredSettings: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()]).nullable()),
        savedAndQuit: z.boolean().optional(),
        keptPackFolders: z.array(z.string()).optional(),
        stopNote: z.string().optional(),
        detached: z.boolean().optional(),
      },
    },
    async () => {
      try {
        await playJobs.stopAll("game_stop");
        const world = bridge.world;
        const kept = world !== undefined && world.how !== "user" && (await readMarker(world.dir))?.keep === true;
        const r = await bridge.stop();
        // A test world is ended without Save & Quit, and the game writes chunks on its own schedule.
        const note = kept && r.stopped ? `; ${world.name} is a kept world: blocks changed in the last minute before this stop may be missing on the next launch` : "";
        const stopNote = r.stopNote ? `; ${r.stopNote}` : "";
        return ok(r.stopped ? `${r.message}${note}${stopNote}` : `not stopped: ${r.message}${stopNote}`, r);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
