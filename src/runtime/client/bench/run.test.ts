import { describe, expect, it } from "vitest";
import type { PlayAction } from "../skills/play.ts";
import { UsageError } from "../../../core/errors.ts";
import { CommandWrong, runBench, tracePathFor, withPhrasing, wrongCommand } from "./run.ts";

describe("build commands", () => {
  const LINE = "summon minecraft:villager_v2 5480.5 -60 1004.5 0 0 minecraft:spawn_farmer";
  const SYNTAX = 'Syntax error: Unexpected "minecraft:villager_v2": at "summon >>minecraft:villager_v2<< 5480.5 -6"';
  it("turns a syntax error into the run's failure with the game's text, whatever the success flag said", () => {
    const wrong = wrongCommand(LINE, [SYNTAX]);
    expect(wrong).toBeInstanceOf(CommandWrong);
    expect(wrong?.message).toBe(`/${LINE} failed: ${SYNTAX}`);
    expect(wrongCommand("summon x", ["", SYNTAX])).toBeInstanceOf(CommandWrong);
    expect(wrongCommand("frobnicate", ["Unknown command: frobnicate. Please check that the command exists"])).toBeInstanceOf(CommandWrong);
  });
  it("lets a command that found nothing to change pass", () => {
    expect(wrongCommand("kill @e[type=!player]", ["No targets matched selector"])).toBeUndefined();
    expect(wrongCommand("fill 0 0 0 1 1 1 air", ["0 blocks filled"])).toBeUndefined();
  });
});

describe("picking scenarios", () => {
  it("refuses an unknown suite or scenario as a usage error naming the known ones, before the game starts", async () => {
    const unknown = runBench({ suite: "nosuch", input: "keyboard", log: () => undefined });
    await expect(unknown).rejects.toBeInstanceOf(UsageError);
    await expect(unknown).rejects.toThrow(/no scenario matches suite nosuch; known: .*combat\/zombies3/);
    await expect(runBench({ suite: "combat", scenario: "nosuch", input: "keyboard", log: () => undefined })).rejects.toThrow(/and name nosuch/);
  });
});

describe("phrasings", () => {
  it("plays phrasing i on run i, and leaves other actions alone", () => {
    const goals = ["a", "b", "c"];
    expect([1, 2, 3, 4].map((run) => (withPhrasing({ action: "play", goal: "x" }, goals, run) as PlayAction).goal)).toEqual(["a", "b", "c", "a"]);
    expect(withPhrasing({ action: "goto", x: 1, z: 2 }, goals, 1)).toEqual({ action: "goto", x: 1, z: 2 });
  });
});

describe("report files", () => {
  it("puts the trace file next to the report", () => {
    expect(tracePathFor("/c/bench/combat-husks3-2026.json")).toBe("/c/bench/combat-husks3-2026.trace.json");
  });
});
