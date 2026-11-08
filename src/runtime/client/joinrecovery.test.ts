import { describe, expect, it } from "vitest";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debugLogEnd, joinStateInLog, NO_JOIN_YET, readDebugLogSince } from "./contentlog.ts";

/** Real lines from Debug_Log2026-11-08_17-12-03.txt, where the deeplink join beat Microsoft sign-in. */
const FAILED = [
  "[2026-11-08 17:12:05:405 INFO LEVELTRANSITION 380 320] [Server]Level-LevelInitialized",
  "[2026-11-08 17:12:05:525 INFO SYSTEM 424 320] Current Flighting Configurations: { add-friends-treatment:true }",
  "[2026-11-08 17:12:05:619 INFO GUI 324 320] NetworkWorldJoinerFacet destroyed",
  "[2026-11-08 17:12:05:620 INFO GUI 324 320] Created 'progress.world_loading_progress_screen' screen in 0.573900ms",
  "[2026-11-08 17:12:05:743 ERROR NETWORK 684 320] LoginPacket failed validation",
  "[2026-11-08 17:12:05:752 INFO NETWORK 324 320] DisconnectPacket",
  "[2026-11-08 17:12:05:752 INFO NETWORK 324 320] onDisconnect",
  "[2026-11-08 17:12:05:768 INFO GUI 324 320] Pushing disconnect screen from GameConnectionUIUtils::_onDisconnect",
  "[2026-11-08 17:12:05:785 INFO NETWORK 324 320] onUnableToConnect",
].join("\n");

/** The same launch after "Back to menu": the game re-opened the world once sign-in finished. */
const REJOINED = [
  "[2026-11-08 18:02:56:798 INFO GUI 324 320] Created 'progress.world_loading_progress_screen' screen in 0.671300ms",
  "[2026-11-08 18:02:57:582 INFO LEVELTRANSITION 372 320] [Server]Level-LevelInitialized",
  "[2026-11-08 18:02:58:167 INFO LEVELTRANSITION 324 320] [Client]Level-LevelInitialized",
  "[2026-11-08 18:02:59:332 INFO SERVER 836 320] Player Spawned: Steve xuid: 2535400000000001, pfid: 0000000000000001",
].join("\n");

/** A launch that joined on the first attempt (Debug_Log2026-11-08_18-09-30.txt). */
const SUCCESS = [
  "[2026-11-08 18:09:31:373 INFO LEVEL 324 320] Transfering to world with id of sculkwire-demo",
  "[2026-11-08 18:09:32:475 INFO GUI 324 320] Created 'progress.world_loading_progress_screen' screen in 0.598600ms",
  "[2026-11-08 18:09:32:712 INFO LEVELTRANSITION 324 320] [Client]Level-LevelInitialized",
  "[2026-11-08 18:09:32:987 INFO SERVER 712 320] Player Spawned: Steve xuid: 2535400000000001",
].join("\n");

/** Real lines from Debug_Log2026-11-10_08-13-29.txt: sign-in finished while the world loaded and the game closed it. */
const CLOSED_BEFORE_JOIN = [
  "[2026-11-10 08:13:32:672 INFO LEVELTRANSITION 372 316] [Server]Level-LevelInitialized",
  "[2026-11-10 08:13:32:887 INFO GUI 320 316] Created 'progress.world_loading_progress_screen' screen in 0.640200ms",
  "[2026-11-10 08:13:37:407 INFO GUI 320 316] Created 'start.start_screen' screen in 0.855900ms",
  "[2026-11-10 08:13:37:408 INFO GUI 320 316] Created 'progress.world_saving_progress_screen' screen in 0.634200ms",
  "[2026-11-10 08:13:37:417 INFO LEVELTRANSITION 628 316] [Server]Level-LevelStartLeaveGame",
  "[2026-11-10 08:13:37:720 INFO LEVELTRANSITION 628 316] [Server]Level-LevelDestructed",
].join("\n");

describe("deeplink/sign-in join race", () => {
  it("detects a rejected LoginPacket followed by DisconnectPacket", () => {
    const state = joinStateInLog(FAILED);
    expect(state.failed).toBe(true);
    expect(state.joined).toBe(false);
    expect(state.lines.map((l) => l.replace(/^\[[^\]]*\]\s*/, ""))).toEqual(["LoginPacket failed validation", "DisconnectPacket"]);
    expect(state.attempts).toBe(1);
  });

  it("is over once a client joined, even if it failed before", () => {
    const state = joinStateInLog(`${FAILED}\n${REJOINED}`);
    expect(state.failed).toBe(false);
    expect(state.joined).toBe(true);
  });

  it("follows a rejection split across reads (LoginPacket and DisconnectPacket are separate lines)", () => {
    const first = joinStateInLog("[2026-11-08 17:12:05:743 ERROR NETWORK 684 320] LoginPacket failed validation\n");
    expect(first.failed).toBe(false);
    expect(first.rejected).toBeDefined();
    const second = joinStateInLog("[2026-11-08 17:12:05:752 INFO NETWORK 324 320] DisconnectPacket\n", first);
    expect(second.failed).toBe(true);
    expect(second.joined).toBe(false);
  });

  it("does not act on a rejection line alone: the DisconnectPacket after it identifies the error screen", () => {
    const state = joinStateInLog("[2026-11-08 17:12:05:743 ERROR NETWORK 684 320] LoginPacket failed validation\n");
    expect(state.failed).toBe(false);
    expect(state.lines).toEqual([]);
  });

  it("leaves a clean launch alone", () => {
    expect(joinStateInLog(SUCCESS)).toEqual({ ...NO_JOIN_YET, joined: true, attempts: 1 });
  });

  it("counts join attempts and reports a later rejection after an earlier join", () => {
    const state = joinStateInLog(`${SUCCESS}\n${FAILED}`, NO_JOIN_YET);
    expect(state.attempts).toBe(2);
    expect(state.joined).toBe(false);
    expect(state.failed).toBe(true);
  });

  it("clears the failure when a new attempt starts and flags it again if that attempt is refused too", () => {
    const failed = joinStateInLog(FAILED);
    const retrying = joinStateInLog(
      "[2026-11-08 17:12:20:100 INFO GUI 324 320] Created 'progress.world_loading_progress_screen' screen in 0.6ms\n",
      failed,
    );
    expect(retrying).toMatchObject({ failed: false, joined: false, attempts: failed.attempts + 1 });
    expect(joinStateInLog(FAILED, retrying)).toMatchObject({ failed: true, attempts: failed.attempts + 2 });
  });

  it("detects a world that closed before the client was in", () => {
    const state = joinStateInLog(CLOSED_BEFORE_JOIN);
    expect(state).toMatchObject({ failed: true, joined: false, attempts: 1 });
    expect(state.lines.map((l) => l.replace(/^\[[^\]]*\]\s*/, ""))).toEqual(["[Server]Level-LevelStartLeaveGame"]);
    expect(joinStateInLog(REJOINED, state)).toMatchObject({ failed: false, joined: true, attempts: 2 });
  });

  it("does not mistake leaving a joined world for a failed join, and keeps a rejection's own lines", () => {
    const left = "[2026-11-08 18:20:00:000 INFO LEVELTRANSITION 628 320] [Server]Level-LevelStartLeaveGame";
    expect(joinStateInLog(`${SUCCESS}\n${left}`)).toMatchObject({ failed: false, joined: true });
    expect(joinStateInLog(`${FAILED}\n${left}`).lines).toHaveLength(2);
  });

  it("reads only what a launch appended, and starts over when the next launch writes a new log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sculkwire-logs-"));
    const first = join(dir, "Debug_Log2026-11-08_17-12-03.txt");
    await writeFile(first, `${FAILED}\n`);
    const start = await debugLogEnd(dir);
    expect(start).toEqual({ file: first, offset: Buffer.byteLength(`${FAILED}\n`) });
    expect((await readDebugLogSince(dir, start)).text).toBe("");

    const appended = "[2026-11-08 17:12:05:900 INFO GUI 324 320] Created 'start.start_screen' screen in 0.5ms\n";
    await writeFile(first, `${FAILED}\n${appended}`);
    const second = await readDebugLogSince(dir, start);
    expect(second.text).toBe(appended);

    // The next launch writes its own Debug_Log; a position in the old file reads the new one from its start.
    const next = join(dir, "Debug_Log2026-11-08_18-09-30.txt");
    await writeFile(next, `${SUCCESS}\n`);
    // Newest wins by modification time: set it instead of waiting for the clock.
    await utimes(next, new Date(), new Date(Date.now() + 1_000));
    const third = await readDebugLogSince(dir, second.end);
    expect(third.text).toBe(`${SUCCESS}\n`);
    expect(third.end?.file).toBe(next);
  });
});
