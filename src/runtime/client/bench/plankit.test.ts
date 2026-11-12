import { describe, expect, it } from "vitest";
import type { PlayResult } from "../skills/play.ts";
import { offerText, planStepLines } from "./plankit.ts";

describe("plan extras", () => {
  it("reports what the last trader offered", () => {
    const line = "offers of the villager at 1 64 4: 1 emerald for 32 stick; 6 bread for 1 emerald";
    const play = { plan: [{ text: "trade for an emerald", kind: "trade", by: "builtin", status: "failed", ok: false, message: "", ms: 1, actions: ["walked to the villager at 1 64 4", line] }] } as unknown as PlayResult;
    expect(offerText(play)).toBe(line);
    expect(offerText(undefined)).toBe("");
  });
  it("writes each task step's header and actions into the run record, at most 60 lines", () => {
    const play = {
      plan: [
        { text: "fetch all diamonds", kind: "fetch", by: "builtin", status: "failed", ok: false, message: "took 1 of the 3 diamond", ms: 1, reason: "not_found", actions: ["walked to the chest at 3 64 4", "moved 1 diamond"] },
        { text: "go home", kind: "free", by: "builtin", status: "pending", ok: false, message: "", ms: 0 },
      ],
    } as unknown as PlayResult;
    expect(planStepLines(play)).toEqual(['fetch "fetch all diamonds": failed not_found: took 1 of the 3 diamond', "  walked to the chest at 3 64 4", "  moved 1 diamond"]);
    const long = { plan: [{ text: "t", kind: "fetch", by: "builtin", status: "done", ok: true, message: "ok", ms: 1, actions: Array.from({ length: 100 }, (_, i) => `a${i}`) }] } as unknown as PlayResult;
    const lines = planStepLines(long);
    expect(lines).toHaveLength(60);
    expect(lines.at(-1)).toBe("... 42 more lines");
  });
});
