/**
 * Offline Molang evaluation with the game's rules (pack `min_engine_version` 1.18.20 or newer): 32-bit float
 * results, degrees in the trig functions, `??` as the lowest binary operator, right-associative `? :`, `&&` before
 * `||`, and an unset variable, temp or context read stopping the whole expression at 0. Queries come from the
 * caller; anything that needs the game (entities, `->`, arrays, resources) is refused with a diagnostic.
 */
import type { Diagnostic, Position } from "../core/diagnostic.ts";
import { errorMessage, UsageError } from "../core/errors.ts";
import type { Channel } from "../core/version.ts";
import { molangQueryNames } from "./lookups.ts";
import { suggestNames } from "./suggest.ts";

export type MolangValue = number | string;

export interface MolangSamples {
  /** Query the samples vary, e.g. `anim_time` or `q.anim_time`. */
  query: string;
  from: number;
  to: number;
  step: number;
}

export interface MolangEvalInput {
  expression: string;
  /** Query values by name (`anim_time`, `q.anim_time`, `query.anim_time`); arguments of a query call are ignored. */
  queries?: Record<string, number>;
  /** Variable, temp and context values: `v.x`, `t.x`, `c.x` (long forms too); a bare name is a `variable.*`. */
  variables?: Record<string, MolangValue>;
  samples?: MolangSamples;
  /** Seed for `math.random*` and `math.die_roll*`; without one they differ on every call. */
  seed?: number;
  /** Every `query.*` name the game knows; when given, other query names are reported in `unknownQueries`. */
  knownQueries?: readonly string[];
}

export interface MolangSample {
  x: number;
  value: MolangValue;
  aborted: boolean;
}

export interface MolangEvalResult {
  /** The result, absent when the expression does not load (see `diagnostics`) or `samples` was given. */
  value?: MolangValue;
  values?: MolangSample[];
  /** An unset variable, temp or context was read, so the game stopped the expression at 0. */
  aborted: boolean;
  notes: string[];
  unknownQueries: { name: string; suggestions: string[] }[];
  diagnostics: Diagnostic[];
}

/** Most points one `samples` range may produce. */
export const MAX_SAMPLES = 1000;
/** Loop iterations one evaluation may run before it is stopped (the game itself has no measured cap). */
export const MAX_ITERATIONS = 1_000_000;

const f = Math.fround;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------------------------
// Names

const ALIASES: Record<string, string> = { q: "query", v: "variable", t: "temp", c: "context" };

/** `q.x` → `query.x`, lowercased (Molang is case-insensitive apart from strings). */
export function canonicalName(name: string): string {
  const lower = name.trim().toLowerCase();
  const dot = lower.indexOf(".");
  if (dot < 0) return lower;
  const head = lower.slice(0, dot);
  return (ALIASES[head] ?? head) + lower.slice(dot);
}

function queryKey(name: string): string {
  const c = canonicalName(name).replace(/\(.*$/, "");
  return c.startsWith("query.") ? c : `query.${c}`;
}

function variableKey(name: string): string {
  const c = canonicalName(name);
  return /^(variable|temp|context)\./.test(c) ? c : `variable.${c}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Math functions: [min args, max args, implementation on 32-bit inputs]

type Rng = () => number;
type MathFn = (a: number[], rng: Rng) => number;

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const c5 = (2 * Math.PI) / 4.5;

function bounceOut(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

/** easings.net curves on 0..1; `math.ease_*(start, end, t)` maps them onto start..end. */
const EASINGS: Record<string, (t: number) => number> = {
  in_quad: (t) => t * t,
  out_quad: (t) => 1 - (1 - t) * (1 - t),
  in_out_quad: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  in_cubic: (t) => t ** 3,
  out_cubic: (t) => 1 - (1 - t) ** 3,
  in_out_cubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  in_quart: (t) => t ** 4,
  out_quart: (t) => 1 - (1 - t) ** 4,
  in_out_quart: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2),
  in_quint: (t) => t ** 5,
  out_quint: (t) => 1 - (1 - t) ** 5,
  in_out_quint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2),
  in_sine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  out_sine: (t) => Math.sin((t * Math.PI) / 2),
  in_out_sine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  in_expo: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  out_expo: (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  in_out_expo: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2,
  in_circ: (t) => 1 - Math.sqrt(1 - t * t),
  out_circ: (t) => Math.sqrt(1 - (t - 1) ** 2),
  in_out_circ: (t) => (t < 0.5 ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2 : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2),
  in_back: (t) => c3 * t ** 3 - c1 * t * t,
  out_back: (t) => 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2,
  in_out_back: (t) =>
    t < 0.5 ? ((2 * t) ** 2 * ((c2 + 1) * 2 * t - c2)) / 2 : ((2 * t - 2) ** 2 * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2,
  in_elastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * c4)),
  out_elastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1),
  in_out_elastic: (t) =>
    t === 0
      ? 0
      : t === 1
        ? 1
        : t < 0.5
          ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
          : (2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1,
  in_bounce: (t) => 1 - bounceOut(1 - t),
  out_bounce: bounceOut,
  in_out_bounce: (t) => (t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2),
};

/** Wrap degrees into [-180, 180). */
const minAngle = (x: number) => x - 360 * Math.floor((x + 180) / 360);
const randomInt = (lo: number, hi: number, rng: Rng) => {
  const a = Math.round(Math.min(lo, hi));
  const b = Math.round(Math.max(lo, hi));
  return a + Math.floor(rng() * (b - a + 1));
};

const MATH: Record<string, [number, number, MathFn]> = {
  abs: [1, 1, ([x]) => Math.abs(x!)],
  acos: [1, 1, ([x]) => Math.acos(x!) / DEG],
  asin: [1, 1, ([x]) => Math.asin(x!) / DEG],
  atan: [1, 1, ([x]) => Math.atan(x!) / DEG],
  atan2: [2, 2, ([y, x]) => Math.atan2(y!, x!) / DEG],
  ceil: [1, 1, ([x]) => Math.ceil(x!)],
  clamp: [3, 3, ([x, lo, hi]) => Math.min(Math.max(x!, lo!), hi!)],
  copy_sign: [2, 2, ([a, b]) => Math.abs(a!) * (b! < 0 || Object.is(b, -0) ? -1 : 1)],
  cos: [1, 1, ([x]) => Math.cos(x! * DEG)],
  die_roll: [3, 3, ([n, lo, hi], rng) => {
    let sum = 0;
    for (let i = 0; i < n!; i++) sum += lo! + rng() * (hi! - lo!);
    return sum;
  }],
  die_roll_integer: [3, 3, ([n, lo, hi], rng) => {
    let sum = 0;
    for (let i = 0; i < n!; i++) sum += randomInt(lo!, hi!, rng);
    return sum;
  }],
  exp: [1, 1, ([x]) => Math.exp(x!)],
  floor: [1, 1, ([x]) => Math.floor(x!)],
  hermite_blend: [1, 1, ([t]) => 3 * t! * t! - 2 * t! * t! * t!],
  inverse_lerp: [3, 3, ([a, b, v]) => (a === b ? 0 : (v! - a!) / (b! - a!))],
  lerp: [3, 3, ([a, b, t]) => a! + (b! - a!) * t!],
  lerprotate: [3, 3, ([a, b, t]) => a! + minAngle(b! - a!) * t!],
  ln: [1, 1, ([x]) => Math.log(x!)],
  max: [2, 2, ([a, b]) => Math.max(a!, b!)],
  min: [2, 2, ([a, b]) => Math.min(a!, b!)],
  min_angle: [1, 1, ([x]) => minAngle(x!)],
  mod: [2, 2, ([a, b]) => a! % b!],
  pi: [0, 0, () => Math.PI],
  pow: [2, 2, ([a, b]) => a! ** b!],
  random: [2, 2, ([lo, hi], rng) => lo! + rng() * (hi! - lo!)],
  random_integer: [2, 2, ([lo, hi], rng) => randomInt(lo!, hi!, rng)],
  round: [1, 1, ([x]) => Math.sign(x!) * Math.round(Math.abs(x!))],
  sign: [1, 1, ([x]) => (x! >= 0 ? 1 : -1)],
  sin: [1, 1, ([x]) => Math.sin(x! * DEG)],
  sqrt: [1, 1, ([x]) => Math.sqrt(x!)],
  trunc: [1, 1, ([x]) => Math.trunc(x!)],
};
for (const [name, ease] of Object.entries(EASINGS)) {
  MATH[`ease_${name}`] = [3, 3, ([a, b, t]) => a! + (b! - a!) * ease(t!)];
}

const RANDOM_FUNCTIONS: Record<string, true> = { random: true, random_integer: true, die_roll: true, die_roll_integer: true };

// ---------------------------------------------------------------------------------------------------------------
// Lexer

type TokKind = "num" | "str" | "id" | "op" | "end";
interface Tok {
  kind: TokKind;
  text: string;
  pos: number;
  end: number;
}

class MolangError extends Error {
  readonly code: string;
  readonly pos: number;
  readonly end: number;
  constructor(code: string, message: string, pos: number, end = pos + 1) {
    super(message);
    this.code = code;
    this.pos = pos;
    this.end = end;
  }
}

const OPS = ["??", "==", "!=", "<=", ">=", "&&", "||", "->", "(", ")", "{", "}", "[", "]", ",", ";", "?", ":", "=", "<", ">", "!", "+", "-", "*", "/"];

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?f?/i.exec(src.slice(i))!;
      i += m[0].length;
      toks.push({ kind: "num", text: m[0].replace(/f$/i, ""), pos: start, end: i });
      continue;
    }
    if (ch === "'") {
      const close = src.indexOf("'", i + 1);
      if (close < 0) throw new MolangError("molang.syntax", "unterminated string", start, src.length);
      toks.push({ kind: "str", text: src.slice(i + 1, close), pos: start, end: close + 1 });
      i = close + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*/.exec(src.slice(i))!;
      i += m[0].length;
      toks.push({ kind: "id", text: m[0].toLowerCase(), pos: start, end: i });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new MolangError("molang.syntax", `unexpected character '${ch}'`, start);
    i += op.length;
    toks.push({ kind: "op", text: op, pos: start, end: i });
  }
  toks.push({ kind: "end", text: "", pos: src.length, end: src.length });
  return toks;
}

// ---------------------------------------------------------------------------------------------------------------
// Parser

type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "var"; name: string }
  | { k: "query"; name: string; args: Node[] | null }
  | { k: "math"; name: string; fn: MathFn; args: Node[]; pos: number }
  | { k: "this" }
  | { k: "unary"; op: string; a: Node; pos: number }
  | { k: "binary"; op: string; a: Node; b: Node; pos: number; end: number }
  | { k: "cond"; c: Node; t: Node; f: Node | null; pos: number }
  | { k: "coalesce"; a: Node; b: Node }
  | { k: "assign"; target: string; value: Node }
  | { k: "block"; body: Node[] }
  | { k: "loop"; count: Node; body: Node; pos: number }
  | { k: "return"; e: Node }
  | { k: "break"; pos: number }
  | { k: "continue"; pos: number };

interface Program {
  statements: Node[];
  /** Has a `;`: the value is what `return` gives, else 0. */
  complex: boolean;
  queries: { name: string; pos: number; end: number }[];
}

function parse(src: string): Program {
  const toks = lex(src);
  let p = 0;
  const queries: Program["queries"] = [];
  const peek = () => toks[p]!;
  const next = () => toks[p++]!;
  const isOp = (text: string) => peek().kind === "op" && peek().text === text;
  const expect = (text: string) => {
    const t = next();
    if (t.kind !== "op" || t.text !== text) {
      throw new MolangError("molang.syntax", `expected '${text}' but found ${t.kind === "end" ? "the end" : `'${t.text}'`}`, t.pos, t.end);
    }
    return t;
  };

  const statements = (closer: string | null): Node[] => {
    const out: Node[] = [];
    for (;;) {
      while (isOp(";")) next();
      if (closer ? isOp(closer) : peek().kind === "end") return out;
      out.push(assign());
      if (closer ? isOp(closer) : peek().kind === "end") return out;
      if (!isOp(";")) {
        const t = peek();
        throw new MolangError("molang.syntax", `expected ';' between statements but found '${t.text}'`, t.pos, t.end);
      }
    }
  };

  const assign = (): Node => {
    const left = coalesce();
    if (!isOp("=")) return left;
    const eq = next();
    if (left.k !== "var" || left.name.startsWith("context.")) {
      throw new MolangError("molang.assign-target", "only variable.* and temp.* can be assigned", eq.pos, eq.end);
    }
    return { k: "assign", target: left.name, value: assign() };
  };

  const coalesce = (): Node => {
    let a = ternary();
    while (isOp("??")) {
      next();
      a = { k: "coalesce", a, b: ternary() };
    }
    return a;
  };

  const ternary = (): Node => {
    const c = or();
    if (!isOp("?")) return c;
    const q = next();
    const t = assign();
    if (!isOp(":")) return { k: "cond", c, t, f: null, pos: q.pos };
    next();
    return { k: "cond", c, t, f: assign(), pos: q.pos };
  };

  const binary = (ops: string[], sub: () => Node) => (): Node => {
    let a = sub();
    while (peek().kind === "op" && ops.includes(peek().text)) {
      const t = next();
      a = { k: "binary", op: t.text, a, b: sub(), pos: t.pos, end: t.end };
    }
    return a;
  };

  const unary = (): Node => {
    if (isOp("!") || isOp("-") || isOp("+")) {
      const t = next();
      return { k: "unary", op: t.text, a: unary(), pos: t.pos };
    }
    const node = primary();
    if (isOp("->") || isOp("[")) {
      const t = peek();
      throw new MolangError(
        "molang.unsupported",
        `'${t.text}' needs entities or arrays from the game; molang_eval runs offline without them`,
        t.pos,
        t.end,
      );
    }
    return node;
  };
  const mul = binary(["*", "/"], unary);
  const add = binary(["+", "-"], mul);
  const cmp = binary(["<", "<=", ">", ">="], add);
  const eq = binary(["==", "!="], cmp);
  const and = binary(["&&"], eq);
  const or = binary(["||"], and);

  const args = (): Node[] => {
    expect("(");
    const out: Node[] = [];
    if (isOp(")")) {
      next();
      return out;
    }
    for (;;) {
      out.push(assign());
      if (isOp(",")) {
        next();
        continue;
      }
      expect(")");
      return out;
    }
  };

  const primary = (): Node => {
    const t = next();
    if (t.kind === "num") return { k: "num", v: f(Number(t.text)) };
    if (t.kind === "str") return { k: "str", v: t.text };
    if (t.kind === "op" && t.text === "(") {
      const e = assign();
      expect(")");
      return e;
    }
    if (t.kind === "op" && t.text === "{") {
      const body = statements("}");
      expect("}");
      return { k: "block", body };
    }
    if (t.kind !== "id") {
      throw new MolangError("molang.syntax", t.kind === "end" ? "expression ends too early" : `unexpected '${t.text}'`, t.pos, t.end);
    }
    switch (t.text) {
      case "return":
        return { k: "return", e: assign() };
      case "break":
        return { k: "break", pos: t.pos };
      case "continue":
        return { k: "continue", pos: t.pos };
      case "this":
        return { k: "this" };
      case "loop": {
        const a = args();
        if (a.length !== 2) throw new MolangError("molang.arguments", "loop takes (count, expression)", t.pos, t.end);
        return { k: "loop", count: a[0]!, body: a[1]!, pos: t.pos };
      }
      case "for_each":
        throw new MolangError("molang.unsupported", "for_each iterates over entities from the game; molang_eval runs offline without them", t.pos, t.end);
    }
    const name = canonicalName(t.text);
    const ns = name.slice(0, name.indexOf("."));
    if (name.startsWith("math.")) {
      const short = name.slice(5);
      const def = MATH[short];
      if (!def) {
        const near = suggestNames(short, Object.keys(MATH), { limit: 3 });
        throw new MolangError(
          "molang.unknown-math",
          `unknown math function ${name}${near.length ? `; near: ${near.map((n) => `math.${n}`).join(", ")}` : ""}`,
          t.pos,
          t.end,
        );
      }
      const a = isOp("(") ? args() : [];
      if (a.length < def[0] || a.length > def[1]) {
        const want = def[0] === def[1] ? `${def[0]}` : `${def[0]} to ${def[1]}`;
        throw new MolangError("molang.arguments", `${name} takes ${want} argument${def[1] === 1 ? "" : "s"}, got ${a.length}`, t.pos, t.end);
      }
      return { k: "math", name: short, fn: def[2], args: a, pos: t.pos };
    }
    if (ns === "query") {
      queries.push({ name, pos: t.pos, end: t.end });
      return { k: "query", name, args: isOp("(") ? args() : null };
    }
    if (ns === "variable" || ns === "temp" || ns === "context") return { k: "var", name };
    if (ns === "geometry" || ns === "material" || ns === "texture" || ns === "array") {
      throw new MolangError("molang.unsupported", `${name} is a resource of an entity; molang_eval runs offline without one`, t.pos, t.end);
    }
    throw new MolangError("molang.syntax", `unknown name '${t.text}' (Molang names start with math., query., variable., temp. or context.)`, t.pos, t.end);
  };

  const program = statements(null);
  return { statements: program, complex: toks.some((t) => t.kind === "op" && t.text === ";"), queries };
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluator

class Abort {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}
class ReturnSignal {
  readonly value: MolangValue;
  constructor(value: MolangValue) {
    this.value = value;
  }
}
class LoopSignal {
  readonly kind: "break" | "continue";
  readonly pos: number;
  constructor(kind: "break" | "continue", pos: number) {
    this.kind = kind;
    this.pos = pos;
  }
}

interface Env {
  vars: Map<string, MolangValue>;
  queries: Map<string, number>;
  rng: Rng;
  notes: Set<string>;
  iterations: number;
}

function num(v: MolangValue, pos: number): number {
  if (typeof v === "string") {
    throw new MolangError("molang.string-operand", `'${v}' is a string: strings only compare with == and !=`, pos);
  }
  return v;
}

const bool = (b: boolean) => (b ? 1 : 0);

function evaluate(node: Node, env: Env): MolangValue {
  switch (node.k) {
    case "num":
    case "str":
      return node.v;
    case "this":
      env.notes.add("`this` (the value the field writes to) reads 0 here");
      return 0;
    case "var": {
      const v = env.vars.get(node.name);
      if (v === undefined) throw new Abort(node.name);
      return v;
    }
    case "query": {
      for (const a of node.args ?? []) evaluate(a, env);
      if (node.args?.length) env.notes.add(`${node.name}(…): arguments are ignored; the value comes from \`queries\``);
      const v = env.queries.get(node.name);
      if (v !== undefined) return v;
      env.notes.add(`${node.name} has no value in \`queries\`, so it reads 0`);
      return 0;
    }
    case "math": {
      const args = node.args.map((a) => f(num(evaluate(a, env), node.pos)));
      if (RANDOM_FUNCTIONS[node.name] && env.rng === Math.random) {
        env.notes.add("math.random/die_roll give a new value on each call; pass `seed` for repeatable results");
      }
      return f(node.fn(args, env.rng));
    }
    case "unary": {
      const a = num(evaluate(node.a, env), node.pos);
      if (node.op === "!") return bool(a === 0);
      return node.op === "-" ? f(-a) : a;
    }
    case "binary":
      return binary(node, env);
    case "cond": {
      const c = evaluate(node.c, env);
      if (num(c, node.pos) !== 0) return evaluate(node.t, env);
      return node.f ? evaluate(node.f, env) : 0;
    }
    case "coalesce":
      try {
        return evaluate(node.a, env);
      } catch (e) {
        if (e instanceof Abort) return evaluate(node.b, env);
        throw e;
      }
    case "assign": {
      const v = evaluate(node.value, env);
      env.vars.set(node.target, v);
      return v;
    }
    case "block":
      for (const s of node.body) evaluate(s, env);
      return 0;
    case "loop": {
      const count = Math.ceil(num(evaluate(node.count, env), node.pos));
      for (let i = 0; i < count; i++) {
        if (++env.iterations > MAX_ITERATIONS) {
          throw new MolangError("molang.loop-limit", `loops ran over ${MAX_ITERATIONS.toLocaleString("en")} iterations; stopped`, node.pos);
        }
        try {
          evaluate(node.body, env);
        } catch (e) {
          if (!(e instanceof LoopSignal)) throw e;
          if (e.kind === "break") break;
        }
      }
      return 0;
    }
    case "return":
      throw new ReturnSignal(evaluate(node.e, env));
    case "break":
    case "continue":
      throw new LoopSignal(node.k, node.pos);
  }
}

function binary(node: Extract<Node, { k: "binary" }>, env: Env): MolangValue {
  const { op, pos } = node;
  if (op === "&&") return bool(num(evaluate(node.a, env), pos) !== 0 && num(evaluate(node.b, env), pos) !== 0);
  if (op === "||") return bool(num(evaluate(node.a, env), pos) !== 0 || num(evaluate(node.b, env), pos) !== 0);
  const a = evaluate(node.a, env);
  const b = evaluate(node.b, env);
  if (op === "==") return bool(a === b);
  if (op === "!=") return bool(a !== b);
  const x = num(a, pos);
  const y = num(b, pos);
  switch (op) {
    case "<":
      return bool(x < y);
    case "<=":
      return bool(x <= y);
    case ">":
      return bool(x > y);
    case ">=":
      return bool(x >= y);
    case "+":
      return f(x + y);
    case "-":
      return f(x - y);
    case "*":
      return f(x * y);
    default:
      if (y === 0) {
        env.notes.add("division by zero gives 0 (the game also reports a content error)");
        return 0;
      }
      return f(x / y);
  }
}

/** mulberry32: a small seeded generator, so a `seed` gives the same rolls on every call. */
function seeded(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(program: Program, env: Env): { value: MolangValue; aborted: boolean } {
  let value: MolangValue = 0;
  try {
    for (const s of program.statements) value = evaluate(s, env);
    if (program.complex) {
      env.notes.add("statements without `return` give 0, as in the game");
      value = 0;
    }
  } catch (e) {
    if (e instanceof Abort) {
      env.notes.add(`${e.name} is read before anything sets it, so the game stops the whole expression at 0 (write \`${e.name} ?? 0\` for a fallback)`);
      return { value: 0, aborted: true };
    }
    if (e instanceof LoopSignal) throw new MolangError("molang.syntax", `${e.kind} outside a loop`, e.pos);
    if (!(e instanceof ReturnSignal)) throw e;
    value = e.value;
  }
  // JSON has no NaN or Infinity: report them by name.
  return { value: typeof value === "number" && !Number.isFinite(value) ? String(value) : value, aborted: false };
}

function position(src: string, offset: number): Position {
  const before = src.slice(0, offset).split("\n");
  return { line: before.length, column: before[before.length - 1]!.length + 1 };
}

function toDiagnostic(src: string, e: MolangError): Diagnostic {
  return {
    severity: "error",
    code: e.code,
    message: e.message,
    source: "molang",
    range: { start: position(src, e.pos), end: position(src, Math.min(e.end, src.length)) },
    hint: "the game does not load this expression: the field falls back to its default",
  };
}

export function evaluateMolang(input: MolangEvalInput): MolangEvalResult {
  const src = input.expression;
  const notes = new Set<string>();
  const result: MolangEvalResult = { aborted: false, notes: [], unknownQueries: [], diagnostics: [] };

  let program: Program;
  try {
    program = parse(src);
  } catch (e) {
    if (!(e instanceof MolangError)) throw e;
    result.diagnostics.push(toDiagnostic(src, e));
    return result;
  }

  if (input.knownQueries) {
    const known = new Set(input.knownQueries.map((n) => n.toLowerCase()));
    const seen = new Set<string>();
    for (const q of program.queries) {
      if (known.has(q.name) || seen.has(q.name)) continue;
      seen.add(q.name);
      const suggestions = suggestNames(q.name.slice(6), input.knownQueries, { limit: 5, key: (n) => n.replace(/^query\./, "") });
      result.unknownQueries.push({ name: q.name, suggestions });
      result.diagnostics.push({
        severity: "error",
        code: "molang.unknown-query",
        message: `unknown query ${q.name}${suggestions.length ? `; near: ${suggestions.join(", ")}` : ""}`,
        source: "molang",
        range: { start: position(src, q.pos), end: position(src, q.end) },
        hint: "the game does not load an expression with an unknown query; it is read as 0 here",
      });
    }
  }

  const queries = new Map<string, number>();
  for (const [k, v] of Object.entries(input.queries ?? {})) queries.set(queryKey(k), f(v));
  const vars = new Map<string, MolangValue>();
  for (const [k, v] of Object.entries(input.variables ?? {})) vars.set(variableKey(k), typeof v === "number" ? f(v) : v);
  const rng = input.seed === undefined ? Math.random : seeded(input.seed);
  const envFor = (q: Map<string, number>): Env => ({ vars: new Map(vars), queries: q, rng, notes, iterations: 0 });

  try {
    if (input.samples) {
      const { from, to, step } = input.samples;
      const key = queryKey(input.samples.query);
      if (!(step > 0)) throw new UsageError("samples.step must be greater than 0");
      const count = Math.floor((to - from) / step + 1e-9) + 1;
      if (!(count >= 1)) throw new UsageError("samples.to must not be below samples.from");
      if (count > MAX_SAMPLES) throw new UsageError(`samples give ${count} points; at most ${MAX_SAMPLES}`);
      result.values = [];
      for (let i = 0; i < count; i++) {
        const x = f(from + i * step);
        const r = run(program, envFor(new Map([...queries, [key, x]])));
        result.values.push({ x, value: r.value, aborted: r.aborted });
        if (r.aborted) result.aborted = true;
      }
    } else {
      const r = run(program, envFor(queries));
      result.value = r.value;
      result.aborted = r.aborted;
    }
  } catch (e) {
    if (!(e instanceof MolangError)) throw e;
    delete result.value;
    delete result.values;
    result.diagnostics.push(toDiagnostic(src, e));
  }
  result.notes = [...notes];
  return result;
}

/**
 * `evaluateMolang` with the channel's query names from engine metadata. Without them (offline, nothing cached) the
 * expression is still evaluated and a note says the query names went unchecked.
 */
export async function molangEval(
  input: Omit<MolangEvalInput, "knownQueries"> & { channel: Channel; offline?: boolean },
): Promise<MolangEvalResult & { channel: Channel; version?: string; samplesTag?: string }> {
  const { channel, offline, ...rest } = input;
  const catalog = await molangQueryNames({ channel, offline }).catch((e: unknown) => errorMessage(e));
  if (typeof catalog === "string") {
    const r = evaluateMolang(rest);
    r.notes.push(`query names were not checked: ${catalog}`);
    return { channel, ...r };
  }
  const { queries, ...tag } = catalog;
  return { ...tag, ...evaluateMolang({ ...rest, knownQueries: queries }) };
}

/** Text summary shared by the MCP tool and `sculk molang`: value (or one line per sample), problems, notes. */
export function formatMolangResult(r: MolangEvalResult): string {
  const show = (v: MolangValue) => (typeof v === "number" ? String(Number(v.toPrecision(7))) : JSON.stringify(v));
  const lines: string[] = [];
  if (r.value !== undefined) lines.push(`= ${show(r.value)}${r.aborted ? " (aborted)" : ""}`);
  for (const s of r.values ?? []) lines.push(`${show(s.x)}\t${show(s.value)}${s.aborted ? " (aborted)" : ""}`);
  for (const d of r.diagnostics) {
    lines.push(`${d.severity} ${d.code}${d.range ? ` at ${d.range.start.line}:${d.range.start.column}` : ""}: ${d.message}`);
  }
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines.join("\n");
}
