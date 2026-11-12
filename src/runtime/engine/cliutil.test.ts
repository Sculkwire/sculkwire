import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failed, parseCommandLine } from "./cliutil.ts";

type Options = NonNullable<Parameters<typeof parseCommandLine>[1]>;

const TICK: Options = { pause: { type: "boolean" }, resume: { type: "boolean" }, step: { type: "string" }, scale: { type: "string" } };
const WORLD: Options = { world: { type: "string" }, gamerule: { type: "string", multiple: true } };
const INTERACT: Options = { dimension: { type: "string" }, face: { type: "string" } };
const MOVE: Options = { count: { type: "string" }, times: { type: "string" } };

/** What a command sees: the given values and the positionals, or `usage` when the arguments are a usage error. */
function parsed(args: string[], options: Options, mode: "strict" | "loose"): unknown {
  const line = parseCommandLine(args, options, mode);
  if (!line) return "usage";
  const values = Object.fromEntries(Object.entries(line.values).filter(([, v]) => v !== undefined));
  return { values, positionals: line.positionals };
}

describe("parseCommandLine", () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // `engine *`, `game lock|settings|ui` and `world settings`: node's strict `parseArgs`, as on main.
  it.each<[string[], Options, unknown]>([
    [[], {}, { values: {}, positionals: [] }],
    [["say", "hi"], {}, { values: {}, positionals: ["say", "hi"] }],
    [["--help"], {}, "usage"],
    [["shot.png", "--help"], {}, "usage"],
    [["-12"], {}, "usage"],
    [["--", "--help"], {}, { values: {}, positionals: ["--help"] }],
    [["--step", "3", "--step", "4"], TICK, { values: { step: "4" }, positionals: [] }],
    [["--step"], TICK, "usage"],
    [["--pause=yes"], TICK, "usage"],
    [["--pause", "extra"], TICK, { values: { pause: true }, positionals: ["extra"] }],
    [["set", "--gamerule", "a=1", "--gamerule=b=2", "--world", "w"], WORLD, { values: { gamerule: ["a=1", "b=2"], world: "w" }, positionals: ["set"] }],
  ])("strict %j", (args, options, expected) => {
    expect(parsed(args, options, "strict")).toEqual(expected);
  });

  // `interact`, `screen`: main's `flagOf`/`positionalsOf`.
  it.each<[string[], Options, unknown]>([
    [["-12", "64", "-3", "--face", "up"], INTERACT, { values: { face: "up" }, positionals: ["-12", "64", "-3"] }],
    [["1", "2", "3", "--face=down", "--dimension", "nether"], INTERACT, { values: { face: "down", dimension: "nether" }, positionals: ["1", "2", "3"] }],
    [["1", "2", "3", "--face", "up", "--face", "down"], INTERACT, { values: { face: "up" }, positionals: ["1", "2", "3"] }],
    [["1", "2", "3", "--face"], INTERACT, { values: {}, positionals: ["1", "2", "3"] }],
    [["1", "2", "3", "--help"], INTERACT, { values: {}, positionals: ["1", "2", "3", "--help"] }],
    [["-123456789"], {}, { values: {}, positionals: ["-123456789"] }],
    [["--x=5"], {}, { values: {}, positionals: ["--x=5"] }],
    [["--", "-5"], {}, { values: {}, positionals: ["--", "-5"] }],
    [["a:1", "b:2", "--count", "--times", "3"], MOVE, { values: { count: "--times" }, positionals: ["a:1", "b:2", "3"] }],
    [["a:1", "b:2", "--count", "-1"], MOVE, { values: { count: "-1" }, positionals: ["a:1", "b:2"] }],
  ])("loose %j", (args, options, expected) => {
    expect(parsed(args, options, "loose")).toEqual(expected);
  });
});

describe("failed", () => {
  const older = { ok: false as const, code: -32601, reason: "unknown_method" as const, message: "no screen.state" };
  const hints = { notAttached: "attach first", tooOld: "rebuild the agent" };
  let stderr = "";

  beforeEach(() => {
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("counts an agent too old for the method as a failure it reported, unless the command has no other route", () => {
    expect(failed(older)).toBe(1);
    expect(stderr).not.toContain("rebuild");
    expect(failed(older, hints)).toBe(2);
    expect(stderr).toContain("rebuild the agent");
  });
});
