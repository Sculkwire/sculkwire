import { describe, expect, it } from "vitest";
import { printToDiagnostic } from "./print.ts";

describe("print diagnostics", () => {
  it("maps error prints to debugger diagnostics with file and line", () => {
    const d = printToDiagnostic(
      { level: "error", message: "[MCBE Fixture BP] Error: boom    at <anonymous> (main.js:7)", location: { file: "main.js", line: 7 } },
      (f) => `BP/scripts/${f}`,
    );
    expect(d).toMatchObject({ severity: "error", code: "script.error", source: "debugger", file: "BP/scripts/main.js", range: { start: { line: 7, column: 1 } } });
    expect(printToDiagnostic({ level: "warn", message: "careful" })).toMatchObject({ severity: "warning", code: "script.warning" });
    expect(printToDiagnostic({ level: "log", message: "Executing command [list]" })).toBeUndefined();
  });
});
