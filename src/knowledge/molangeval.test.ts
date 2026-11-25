import { describe, expect, it } from "vitest";
import { evaluateMolang, type MolangEvalInput } from "./molangeval.ts";

const value = (expression: string, extra: Partial<MolangEvalInput> = {}) => evaluateMolang({ expression, ...extra }).value;

describe("evaluateMolang", () => {
  it("applies the game's precedence: && before ||, comparisons before equality, ?? lowest", () => {
    expect(value("1 + 2 * 3 - 4 / 2")).toBe(5);
    expect(value("1 || 0 && 0")).toBe(1);
    expect(value("2 > 1 == 1")).toBe(1);
    expect(value("v.b = 1; return v.b ?? 2 + 3;")).toBe(1);
    expect(value("v.b = 0; return v.b ?? 1 ? 7 : 8;")).toBe(0);
  });

  it("groups nested ternaries to the right and gives 0 for a false binary conditional", () => {
    expect(value("0 ? 2 : 0 ? 3 : 4")).toBe(4);
    expect(value("1 ? 2 : 0 ? 3 : 4")).toBe(2);
    expect(value("0 ? 2")).toBe(0);
  });

  it("falls back with ?? when the left side reads an unset variable", () => {
    expect(value("(v.a ?? 3) + 1")).toBe(4);
    expect(value("t.y ?? 4")).toBe(4);
  });

  it("takes degrees in trig functions and returns degrees from the inverse ones", () => {
    expect(value("math.sin(30)")).toBe(0.5);
    expect(value("math.cos(180)")).toBe(-1);
    expect(value("math.atan2(1, 1)")).toBe(45);
  });

  it("computes in 32-bit floats", () => {
    expect(value("0.1 + 0.2 == 0.3")).toBe(1);
    expect(value("0.1")).toBe(Math.fround(0.1));
    expect(value("math.pi")).toBe(Math.fround(Math.PI));
  });

  it("stops the whole expression at 0 on an unset variable read and says which", () => {
    const r = evaluateMolang({ expression: "v.speed * 2 + 1" });
    expect(r).toMatchObject({ value: 0, aborted: true });
    expect(r.notes.join("\n")).toContain("variable.speed");
    expect(evaluateMolang({ expression: "v.speed * 2 + 1", variables: { speed: 3 } }).value).toBe(7);
  });

  it("returns from multi-statement expressions, and gives 0 without return", () => {
    expect(value("t.a = 2; t.b = t.a * 3; return t.a + t.b;")).toBe(8);
    expect(value("1 + 2;")).toBe(0);
    expect(value("v.a = (v.b = 3); return v.a + v.b;")).toBe(6);
  });

  it("runs loops with a rounded-up count, break, continue and an early return", () => {
    expect(value("v.x = 0; loop(2.4, {v.x = v.x + 1;}); return v.x;")).toBe(3);
    expect(value("v.x = 0; loop(10, {loop(10, {v.x = v.x + 1; (v.x > 5) ? break;});}); return v.x;")).toBe(15);
    expect(value("v.x = 0; loop(10, { (v.x > 5) ? continue; v.x = v.x + 1; }); return v.x;")).toBe(6);
    expect(value("loop(3, {return 5;}); return 1;")).toBe(5);
  });

  it("evaluates easing curves like the game", () => {
    expect(value("math.ease_in_back(0, 1, 0.5)")).toBeCloseTo(-0.0876975, 6);
    expect(value("math.ease_out_bounce(0, 10, 0.3)")).toBeCloseTo(6.80625, 5);
    expect(value("math.lerprotate(350, 10, 0.5)")).toBe(360);
    expect(value("math.min_angle(190)")).toBe(-170);
  });

  it("reads queries from the caller under any alias and evaluates samples over one query", () => {
    expect(value("q.life_time * 2", { queries: { "query.life_time": 1.5 } })).toBe(3);
    const r = evaluateMolang({
      expression: "math.sin(q.anim_time * 90) * v.amp",
      variables: { "v.amp": 2 },
      samples: { query: "anim_time", from: 0, to: 1, step: 0.5 },
    });
    expect(r.value).toBeUndefined();
    expect(r.values?.map((s) => s.x)).toEqual([0, 0.5, 1]);
    expect(r.values?.[0]?.value).toBe(0);
    expect(r.values?.[1]?.value).toBeCloseTo(Math.SQRT2, 6);
    expect(r.values?.[2]?.value).toBe(2);
  });

  it("refuses more than 1000 samples", () => {
    expect(() => evaluateMolang({ expression: "1", samples: { query: "anim_time", from: 0, to: 10, step: 0.001 } })).toThrow(
      /at most 1000/,
    );
  });

  it("reports unknown queries with near names", () => {
    const r = evaluateMolang({ expression: "q.anim_tme * 2", knownQueries: ["query.anim_time", "query.life_time"] });
    expect(r.unknownQueries).toEqual([{ name: "query.anim_tme", suggestions: ["query.anim_time"] }]);
    expect(r.diagnostics[0]).toMatchObject({ code: "molang.unknown-query", range: { start: { line: 1, column: 1 } } });
  });

  it("reports what the game would not load as a diagnostic, without a value", () => {
    for (const [expression, code] of [
      ["'a' + 1", "molang.string-operand"],
      ["q.anim_time = 1", "molang.assign-target"],
      ["math.sin(1, 2)", "molang.arguments"],
      ["math.sine(1)", "molang.unknown-math"],
      ["v.x->q.y", "molang.unsupported"],
      ["1 +", "molang.syntax"],
    ] as const) {
      const r = evaluateMolang({ expression });
      expect(r.value, expression).toBeUndefined();
      expect(r.diagnostics[0]?.code, expression).toBe(code);
    }
  });

  it("names NaN and Infinity, which JSON cannot carry", () => {
    expect(value("math.sqrt(-1)")).toBe("NaN");
    expect(value("math.ln(0)")).toBe("-Infinity");
    expect(value("1 / 0")).toBe(0);
  });

  it("repeats random rolls for the same seed", () => {
    const roll = () => value("math.random(0, 100) + math.die_roll_integer(3, 1, 6)", { seed: 7 });
    expect(roll()).toBe(roll());
  });
});
