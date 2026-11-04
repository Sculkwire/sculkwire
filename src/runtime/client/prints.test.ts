import { describe, expect, it } from "vitest";
import { entryDiagnostics, printEntries } from "./contentlog.ts";

describe("content log over the script debugger", () => {
  it("drops connection chatter, marks script frames as script errors, and gives area-less entries a content-log code", () => {
    const entries = printEntries([
      { level: "warn", message: "Debugger attached to [127.0.0.1] on port [19151]." },
      { level: "log", message: "mcbe fixture loaded" },
      { level: "error", message: "recipes/test_item.json | mcbe:test_item_recipe | 1.20+ Recipes require unlock data" },
      { level: "error", message: "[MCBE Fixture BP] Error: boom    at <anonymous> (main.js:7)" },
    ]);
    expect(entries).toHaveLength(2);
    const codes = entryDiagnostics(entries, []).map((d) => d.code).sort();
    expect(codes).toEqual(["content-log.error", "script.error"]);
  });
});
