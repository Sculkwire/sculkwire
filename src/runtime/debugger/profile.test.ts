import { describe, expect, it } from "vitest";
import { summarizeProfile } from "./profile.ts";

describe("profile summary", () => {
  it("attributes sample time to self and subtree time to total", () => {
    const frame = (functionName: string, lineNumber: number) => ({ functionName, url: "main.js", lineNumber, columnNumber: 0 });
    const s = summarizeProfile({
      nodes: [
        { id: 1, callFrame: frame("(root)", -1), children: [2] },
        { id: 2, callFrame: frame("outer", 9), children: [3] },
        { id: 3, callFrame: frame("busyWork", 20) },
      ],
      startTime: 0,
      endTime: 4000,
      samples: [3, 3, 3, 2, 3],
      timeDeltas: [0, 1000, 1000, 1000, 1000],
    });
    expect(s.functions[0]).toMatchObject({ functionName: "busyWork", line: 20, selfMs: 3, totalMs: 3 });
    expect(s.functions[1]).toMatchObject({ functionName: "outer", selfMs: 1, totalMs: 4 });
  });

  // Shaped like a BDS 1.26.63 capture of a `system.runInterval` aura: per run one script sample, then one sample per
  // native binding call a few µs apart, then nothing until the next run (no idle samples).
  const auraCapture = (everyTicks: number, busyUs = 0) => {
    const frame = (functionName: string, lineNumber: number) => ({ functionName, url: "revenant.js", lineNumber, columnNumber: 0 });
    const samples: number[] = [];
    const timeDeltas: number[] = [];
    let at = 0;
    const push = (id: number, t: number) => {
      samples.push(id);
      timeDeltas.push(t - at);
      at = t;
    };
    const durationUs = 5_000_000;
    for (let tick = 0; tick < 100; tick += everyTicks) {
      let t = tick * 50_000 + 1_000;
      push(1, t);
      for (let i = 0; i < 3; i++) push(2, (t += 3));
      for (let i = 0; i < busyUs / 1000; i++) push(3, (t += 1000));
    }
    return summarizeProfile({
      nodes: [
        { id: 1, callFrame: frame("frostAura", 26), children: [2] },
        { id: 2, callFrame: frame("Dimension::getEntities", 40) },
        { id: 3, callFrame: frame("busyWork", 46) },
      ],
      startTime: 0,
      endTime: durationUs,
      samples,
      timeDeltas,
    });
  };

  it("charges no function for the idle time between game ticks", () => {
    const everyTick = auraCapture(1);
    const oncePerSecond = auraCapture(20);
    // Before, the 50 ms gap to the next tick went to the tick's last sample: getEntities had ~99% of either capture.
    expect(everyTick.intervalMs).toBe(1);
    const top = everyTick.functions[0]!;
    expect(top.functionName).toBe("Dimension::getEntities");
    expect(top.selfMs).toBeLessThanOrEqual(100 * (6 + 1000) / 1000);
    expect(top.selfPercent).toBeLessThan(3);
    const rare = oncePerSecond.functions[0]!;
    expect(rare.selfMs).toBeLessThanOrEqual(5 * (6 + 1000) / 1000);
    expect(rare.selfMs * 10).toBeLessThan(top.selfMs);
    for (const s of [everyTick, oncePerSecond]) {
      const charged = s.functions.reduce((sum, f) => sum + f.selfMs, 0);
      expect(charged + s.idleMs).toBeCloseTo(s.durationMs, 3);
    }
    expect(oncePerSecond.idleMs).toBeGreaterThan(4990);
  });

  it("charges script samples one interval each", () => {
    // 10 ms of pure script per tick: samples 1 ms apart, so busyWork is charged its 10 samples per tick.
    const s = auraCapture(1, 10_000);
    expect(s.functions[0]).toMatchObject({ functionName: "busyWork", selfMs: 1000, selfPercent: 20 });
    expect(s.intervalMs).toBe(1);
  });

  it("places a native binding at the line of the script frame that called it", () => {
    // Recorded from BDS on test/fixtures/gametest_pack: `test.succeed()` is on line 8 and `test.fail(...)` on
    // line 15 of scripts/main.js, but the capture gives the native frames the end of the calling function (10, 17).
    const frame = (functionName: string, lineNumber: number) => ({ functionName, url: "main.js", lineNumber, columnNumber: 0 });
    const s = summarizeProfile({
      nodes: [
        { id: 0, callFrame: frame("Test::succeed", 10), hitCount: 1 },
        { id: 1, callFrame: frame("<anonymous>", 8), hitCount: 1, children: [0] },
        { id: 2, callFrame: frame("Test::fail", 17), hitCount: 1 },
        { id: 3, callFrame: frame("<anonymous>", 15), hitCount: 1, children: [2] },
        { id: 4, callFrame: frame("busyWork", 24), hitCount: 299 },
        { id: 5, callFrame: frame("<anonymous>", 31), hitCount: 1, children: [4] },
      ],
      startTime: 0,
      endTime: 304_000,
    });
    const byName = new Map(s.functions.map((f) => [f.functionName, f]));
    expect(byName.get("Test::succeed")).toMatchObject({ line: 8, native: true });
    expect(byName.get("Test::fail")).toMatchObject({ line: 15, native: true });
    expect(byName.get("busyWork")).toMatchObject({ line: 24, native: false });
  });
});
