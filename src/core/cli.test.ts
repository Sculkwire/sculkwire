import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "node:util";
import { runMain } from "./cli.ts";
import { ExitCode } from "./diagnostic.ts";
import { UsageError } from "./errors.ts";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function stderrLines(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

describe("runMain", () => {
  it("sets the exit code main returns", async () => {
    await runMain(async () => ExitCode.findings);
    expect(process.exitCode).toBe(ExitCode.findings);
  });

  it("prints a usage error's message alone and exits with the usage code", async () => {
    const lines = stderrLines();
    await runMain(async () => {
      throw new UsageError("unknown flag --x\nusage: sculk thing");
    });
    expect(lines).toEqual(["unknown flag --x\nusage: sculk thing\n"]);
    expect(process.exitCode).toBe(ExitCode.usage);
  });

  it("prints a bad command line's message alone, as an option given without its value", async () => {
    const lines = stderrLines();
    await runMain(async () => {
      parseArgs({ args: ["--use"], options: { use: { type: "string" } } });
      return ExitCode.ok;
    });
    expect(lines).toEqual(["Option '--use <value>' argument missing\n"]);
    expect(process.exitCode).toBe(ExitCode.usage);
  });

  it("prints any other error with its stack", async () => {
    const lines = stderrLines();
    await runMain(async () => {
      throw new Error("boom");
    });
    expect(lines[0]).toMatch(/^Error: boom\n\s+at /);
    expect(process.exitCode).toBe(ExitCode.usage);
  });
});
