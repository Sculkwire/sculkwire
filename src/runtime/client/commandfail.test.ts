import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { debuggerCommandOk, failureMatcher, helperTraffic, isFailureKey, loadFailureMatcher, parseLang } from "./commandfail.ts";

/** A made-up slice of a `.lang` file in the game's format. */
const LANG = [
  "## comment",
  "commands.generic.noTargetMatch=No targets matched selector",
  "commands.generic.async.initiated='%1$s' command started (async step %2$d)",
  "commands.function.functionNameNotFound=Function %1$s not found.",
  "commands.function.success=Successfully executed %1$d function entries.",
  "commands.fill.failed=No blocks filled\t#",
  "commands.fill.success=%1$d blocks filled",
  "commands.time.query.daytime=Daytime is %1$d",
  "commands.give.item.notFound=There is no such item with name %1$d",
  "commands.blockdata.outOfWorld=Cannot change block outside of the world",
  "commands.demo.failed=%1$s",
].join("\n");

describe("debugger command failures", () => {
  const failed = failureMatcher([parseLang(LANG)]);

  it("selects failure keys", () => {
    expect(isFailureKey("commands.generic.noTargetMatch")).toBe(true);
    expect(isFailureKey("commands.generic.async.initiated")).toBe(false);
    expect(isFailureKey("commands.function.functionNameNotFound")).toBe(true);
    expect(isFailureKey("commands.blockdata.placeFailed")).toBe(true);
    expect(isFailureKey("commands.fill.success")).toBe(false);
    expect(isFailureKey("item.stone.name")).toBe(false);
  });

  it("tells the helper pack's query traffic from command output", () => {
    // The three lines every helper query prints, as the debugger delivered them on 1.26.63.
    expect(helperTraffic('Executing command [scriptevent sculkwire:query {"kind":"deaths","since":12,"id":7}]')).toBe(true);
    expect(helperTraffic("Script event sculkwire:query has been sent")).toBe(true);
    expect(helperTraffic('[sculkwire:reply] {"id":7,"ok":true,"result":{"tick":40,"deaths":[]}}')).toBe(true);
    expect(helperTraffic("Executing command [testfor @a]")).toBe(false);
    expect(helperTraffic("Found Steve")).toBe(false);
  });

  it("parses lang lines and drops trailing comments", () => {
    expect(parseLang(LANG).get("commands.fill.failed")).toBe("No blocks filled");
    expect(parseLang(LANG).has("## comment")).toBe(false);
  });

  it("fails the outputs live retail answered with ok: true", () => {
    expect(debuggerCommandOk(["No targets matched selector"], failed)).toBe(false);
    expect(debuggerCommandOk(["Function missing_name not found."], failed)).toBe(false);
    expect(debuggerCommandOk(["There is no such item with name 0"], failed)).toBe(false);
    expect(debuggerCommandOk(["No blocks filled"], failed)).toBe(false);
  });

  it("keeps successful and empty output ok", () => {
    expect(debuggerCommandOk(["Daytime is 6000"], failed)).toBe(true);
    expect(debuggerCommandOk(["Successfully executed 3 function entries."], failed)).toBe(true);
    expect(debuggerCommandOk(["12 blocks filled"], failed)).toBe(true);
    expect(debuggerCommandOk(["'tick' command started (async step 1)"], failed)).toBe(true);
    expect(debuggerCommandOk([], failed)).toBe(true);
  });

  it("ignores templates that are only a placeholder", () => {
    expect(debuggerCommandOk(["anything at all"], failed)).toBe(true);
  });

  it("always fails parser errors, with or without a language file", () => {
    for (const m of [failed, failureMatcher([])]) {
      expect(debuggerCommandOk(['Syntax error: Unexpected "foo": at ">>foo<< bar"'], m)).toBe(false);
      expect(debuggerCommandOk(["Unknown command: foo. Please check that the command exists"], m)).toBe(false);
    }
    expect(debuggerCommandOk(["No targets matched selector"], failureMatcher([]))).toBe(true);
  });

  it("loads en_US and the options.txt language from the game folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sculkwire-commandfail-"));
    const texts = join(dir, "game", "data", "resource_packs", "vanilla", "texts");
    await mkdir(texts, { recursive: true });
    await writeFile(join(texts, "en_US.lang"), LANG);
    await writeFile(join(texts, "de_DE.lang"), "commands.generic.noTargetMatch=Keine Ziele entsprachen dem Selektor\n");
    const options = join(dir, "options.txt");
    await writeFile(options, "game_language:de_DE\n");
    const m = await loadFailureMatcher(join(dir, "game"), options);
    expect(debuggerCommandOk(["Keine Ziele entsprachen dem Selektor"], m)).toBe(false);
    expect(debuggerCommandOk(["No targets matched selector"], m)).toBe(false);
    const missing = await loadFailureMatcher(join(dir, "nowhere"), undefined);
    expect(debuggerCommandOk(["No targets matched selector"], missing)).toBe(true);
    expect(debuggerCommandOk(["Syntax error: x"], missing)).toBe(false);
  });
});
