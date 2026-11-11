/**
 * Plans for `play`: a goal in plain words becomes checkable steps and standing orders. The grammar comes first and is
 * deterministic: the goal is split into clauses (`then`, `and then`, `;`, `after that`, and commas or `and` when every
 * side parses), and each clause is placed by the patterns of `parseGoal` plus verbs for the task steps (craft, smelt,
 * trade, fetch, equip, go to a block or a mob) and `survive`. Standing orders (the fights' shield stance) are read from
 * keywords. A clause the grammar cannot place is `free`, which `play` reports as not understood (`goal_unknown`). Live
 * runs with a decision model placing those clauses showed no gain (bench `goal`/`task`, 2026-11-11), so there is none.
 * Item, block and mob names stay as written for the task steps' own name resolution (`tasks/names.ts`), except a mob,
 * which the kill and reach checks need as a type id.
 */
import { bareId } from "../tasks/recipes.ts";
import type { TaskStep } from "../tasks/types.ts";
import { findMob, GOAL_RADIUS, HOSTILE_WORDS, mobType, NUMBERS, parseGoal, type Goal } from "./goal.ts";
import type { Stance } from "./pack.ts";

/** A goal the built-in checks verify (kill, reach coordinates, hit every X once). */
export type CheckedGoal = Exclude<Goal, { kind: "free" }>;

export type PlanAction =
  | CheckedGoal
  /** A fetch with `all` ("get the diamonds") takes every one the containers near hold. */
  | TaskStep
  /** Stay alive this long. */
  | { kind: "survive"; seconds: number }
  /** Not understood: `play` stops with `goal_unknown` once there is nothing else to do. */
  | { kind: "free"; text: string };

export type PlanKind = PlanAction["kind"];

/** One step of a plan: what to do, and the clause it came from. */
export type PlanStep = PlanAction & { clause: string };

export interface StandingOrders {
  /** The fights' shield stance (`guard`: shield up, `kite`: keep away, no shield). */
  stance?: Stance;
}

export interface Plan {
  steps: PlanStep[];
  orders: StandingOrders;
}

export const TASK_KINDS: ReadonlySet<PlanKind> = new Set(["craft", "smelt", "trade", "fetch", "equip", "reach_block", "reach_entity"]);

export function isTaskStep(step: PlanAction): step is TaskStep {
  return TASK_KINDS.has(step.kind);
}

const DEFAULT_SURVIVE_S = 30;

/* -------------------------------------------------------------------------------------------------------------- */
/* Text                                                                                                           */
/* -------------------------------------------------------------------------------------------------------------- */

function normalize(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[’`]/g, "'")
      .replace(/\bdon't\b/g, "do not")
      .replace(/\bcan't\b/g, "cannot")
      // Coordinates written with commas stay one clause: `10, 64, -20` -> `10 64 -20`.
      .replace(/(-?\d+(?:\.\d+)?)\s*,\s*(?=-?\d)/g, "$1 ")
      // A sentence end is a step boundary.
      .replace(/[!?.]+(?=\s|$)/g, ";")
      .replace(/:/g, ",")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const FILLER =
  /^(?:please|pls|now|first(?: of all)?|then|and|also|finally|ok(?:ay)?|so|next|lastly|can you|could you|would you|will you|i want you to|i need you to|you should|you must|you need to|go ahead and|try to|make sure to|make sure you|be sure to|let's|lets|just|you)\b[\s,]*/;

function stripFillers(clause: string): string {
  let c = clause.trim().replace(/^[,;\s]+|[,;\s]+$/g, "");
  for (let prev = ""; prev !== c; ) {
    prev = c;
    c = c.replace(FILLER, "").replace(/\s+(?:please|for me|now)$/, "").replace(/^[,;\s]+|[,;\s]+$/g, "").trim();
  }
  return c;
}

const KITE = /,?\s*(?:while\s+|and\s+)?\b(?:keep(?:ing)? (?:your|a safe|some) distance|kite(?: them| it)?|kiting|do not use (?:the|your|a) shield|without (?:the|your|a) shield|no shield)\b/;
const GUARD = /,?\s*(?:while\s+|and\s+)?\b(?:with (?:the|your) shield (?:up|raised)|behind (?:the|your) shield|shield up|block(?:ing)? with (?:the|your) shield|tank(?:ing)?(?: (?:it|them|the hits))?)\b/;

/** Standing orders from keywords, and the text without them. A "no shield" phrase wins over a "shield up" one. */
export function readOrders(text: string): { text: string; orders: StandingOrders } {
  let t = text;
  const orders: StandingOrders = {};
  for (const [re, stance] of [
    [KITE, "kite"],
    [GUARD, "guard"],
  ] as const) {
    if (!re.test(t)) continue;
    orders.stance ??= stance;
    t = t.replace(new RegExp(re.source, "g"), " ");
  }
  return { text: t.replace(/\s+/g, " ").trim(), orders };
}

const HARD_SPLIT = /\s*(?:;|,?\s*\band then\b|,?\s*\bthen\b|,?\s*\bafter that\b|,?\s*\bafterwards\b|,?\s*\band finally\b|,?\s*\bonce (?:that is|that's|it is|it's|you are|you're) done\b)\s*,?\s*/;

/** The clauses of a goal, in the order they are to be done. */
export function splitClauses(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(HARD_SPLIT)) {
    const piece = stripFillers(raw);
    if (!piece) continue;
    out.push(...splitPiece(piece));
  }
  return out;
}

function placed(clause: string): boolean {
  return candidates(stripFillers(clause)).length > 0;
}

/** `X after Y` and `after Y, X` run Y first; `X and Y` / `X, Y` split only when every part parses. */
function splitPiece(piece: string): string[] {
  const before = piece.match(/^(?:after|once|when)\s+(.+?),\s*(.+)$/);
  if (before?.[1] && before[2] && placed(before[1]) && placed(before[2])) return [stripFillers(before[1]), stripFillers(before[2])];
  const after = piece.match(/^(.+?)\s+(?:after|once)\s+(.+)$/);
  if (after?.[1] && after[2] && placed(after[1]) && placed(after[2])) return [stripFillers(after[2]), stripFillers(after[1])];
  const parts = piece
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/)
    .map(stripFillers)
    .filter(Boolean);
  if (parts.length > 1 && parts.every(placed)) return parts;
  return [piece];
}

/* -------------------------------------------------------------------------------------------------------------- */
/* The grammar                                                                                                    */
/* -------------------------------------------------------------------------------------------------------------- */

const COUNT_WORDS: Record<string, number> = { ...NUMBERS, "a couple of": 2, "a pair of": 2, "a few": 3, "a dozen": 12, "a stack of": 64 };
const COUNT_RE = /^(\d+|a couple of|a pair of|a few|a dozen|a stack of|one|two|three|four|five|six|seven|eight|nine|ten)\s+/;
const LEAD = /^(?:me|us|yourself|the|a|an|some|that|this|those|these|my|your|our|its|their|all(?: of)?|every|each|any|of|out|nearest|closest)\s+/;
/** Where the object of an item step ends: a station, a source, a means. */
const ITEM_TAIL = /\s+(?:at|on|in|inside|into|from|out of|using|with|by|for|off|to|out|over there|please)\b.*$|\s+out$/;
const PRONOUNS = new Set(["it", "them", "there", "here", "this", "that", "these", "those", "me", "you", "him", "her", "one", "ones", "something", "anything", "stuff", "things", "everything"]);

/** The count written before a name and the name itself, articles dropped. `all` for "all/every/each". */
function countAndName(raw: string): { count?: number; name: string; all: boolean } {
  let s = raw.trim();
  let count: number | undefined;
  let all = false;
  for (let prev = ""; prev !== s; ) {
    prev = s;
    if (/^(?:all|every|each)\b/.test(s)) all = true;
    const n = s.match(COUNT_RE);
    if (n?.[1] && count === undefined) {
      count = /^\d+$/.test(n[1]) ? Number(n[1]) : COUNT_WORDS[n[1]];
      s = s.slice(n[0].length);
    }
    s = s.replace(LEAD, "");
  }
  return { ...(count !== undefined ? { count } : {}), name: s.trim(), all };
}

/** A name an item, block or entity step can work with: words, not a pronoun, not coordinates. */
function usableName(name: string): boolean {
  return /[a-z]/.test(name) && !/\d/.test(name) && !PRONOUNS.has(name) && name.split(" ").length <= 5;
}

function mobIn(name: string): string | undefined {
  return mobType(name) ?? (name.split(" ").length <= 2 ? findMob(name)?.type : undefined);
}

const KILL_RE =
  /\b(?:kill|slay|defeat|clear(?: out)?|eliminate|fight|take out|take down|get rid of|wipe out|finish off|deal with|destroy|murder|exterminate|attack|hunt(?: down)?|dispatch|neutralize)\b(.*)/;
const AREA_WORDS = /\b(?:arena|area|room|place|everything|everyone|them all|them|it)\b/;

function killClause(c: string): CheckedGoal | undefined {
  const m = c.match(KILL_RE);
  if (!m) return undefined;
  const rest = m[1] ?? "";
  const n = rest.match(/^\s*(?:all\s+)?(?:of\s+)?(?:the\s+|those\s+|these\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  const count = n?.[1] ? (/^\d+$/.test(n[1]) ? Number(n[1]) : NUMBERS[n[1]]) : undefined;
  const mob = findMob(rest);
  if (mob) {
    const every = /\b(all|every|each)\b/.test(rest) || mob.plural;
    return { kind: "kill", type: `minecraft:${mob.type}`, ...(count !== undefined ? { count } : every ? {} : { count: 1 }), radius: GOAL_RADIUS };
  }
  if (HOSTILE_WORDS.test(rest) || /\bundead\b/.test(rest) || AREA_WORDS.test(rest)) return { kind: "kill", ...(count !== undefined ? { count } : {}), radius: GOAL_RADIUS };
  return undefined;
}

const MOVE_RE =
  /\b(?:go|walk|run|move|head|travel|get|come|return|stand|step|sprint|make your way|get yourself)\b(?:\s+(?:over|back|up|right|straight|all the way))*\s+(?:to|next to|beside|by|near|towards?|up to|close to|on|onto|on top of|in front of)\s+(.+)/;
const APPROACH_RE = /^(?:approach|reach|find|visit|touch)\s+(.+)/;

function reachClause(c: string): PlanAction | undefined {
  const m = c.match(MOVE_RE) ?? c.match(APPROACH_RE);
  if (!m?.[1]) return undefined;
  const { name } = countAndName(m[1].replace(/\s+(?:please|and wait|and stay)\b.*$/, ""));
  if (!usableName(name)) return undefined;
  const mob = mobIn(name);
  if (mob) return { kind: "reach_entity", type: `minecraft:${mob}` };
  return { kind: "reach_block", block: name };
}

const TRADE_SOURCES = /\b(?:villagers?|farmers?|traders?|wandering trader|librarians?|clerics?|merchants?|shopkeepers?|fletchers?|butchers?|armou?rers?|cartographers?|fishermen|fisherman|leatherworkers?|masons?|shepherds?|toolsmiths?|weaponsmiths?)\b/;

type ItemStep = Extract<TaskStep, { kind: "craft" | "smelt" | "trade" | "fetch" }>;

function itemStep(kind: ItemStep["kind"], raw: string): ItemStep | undefined {
  const { count, name } = countAndName(raw.replace(ITEM_TAIL, ""));
  if (!usableName(name) || mobIn(name)) return undefined;
  return { kind, item: name, ...(count !== undefined ? { count } : {}) };
}

function tradeClause(c: string): TaskStep | undefined {
  const form =
    c.match(/\b(?:trade|barter|swap|exchange)\b.*?\bfor\s+(.+)$/) ??
    c.match(/\bbuy\s+(.+)$/) ??
    c.match(/\b(?:get|obtain|earn)\s+(?:me\s+)?(.+?)\s+by\s+trading\b/);
  if (form?.[1]) return itemStep("trade", form[1]);
  const from = c.match(/\b(?:get|fetch|grab|obtain|take)\s+(.+?)\s+(?:from|off)\s+(.+)$/);
  if (from?.[1] && from[2] && TRADE_SOURCES.test(from[2])) return itemStep("trade", from[1]);
  return undefined;
}

const FETCH_RE =
  /\b(?:get|fetch|take|grab|retrieve|collect|pick up|bring(?: me| us)?|pull|remove)\s+(?!rid\b|to\b|over\b|close\b|back\b|near\b|away\b|ready\b|going\b|up\b|down\b|yourself\b)(.+)$/;

function fetchClause(c: string): PlanAction | undefined {
  if (/\btrad(?:e|ing)\b|\bbuy\b/.test(c) || TRADE_SOURCES.test(c)) return undefined;
  const m = c.match(FETCH_RE);
  if (!m?.[1]) return undefined;
  const raw = m[1].replace(/^out\s+/, "");
  const step = itemStep("fetch", raw);
  if (!step || step.count !== undefined) return step;
  // A plural or "all" without a number means every one there is.
  const { name, all } = countAndName(raw.replace(ITEM_TAIL, ""));
  return all || /[^s]s$/.test(name) ? { ...step, kind: "fetch", all: true } : step;
}

function smeltClause(c: string): TaskStep | undefined {
  const m = c.match(/\b(?:smelt|cook|melt|roast|bake|refine)\s+(.+)$/);
  if (!m?.[1]) return undefined;
  const into = m[1].match(/\binto\s+(.+)$/);
  const wanted = into?.[1] ? itemStep("smelt", into[1]) : undefined;
  const input = itemStep("smelt", m[1]);
  // "smelt 3 raw iron into ingots": the count is written with the input, the name of the output is the clearer one.
  if (wanted && input?.count !== undefined && wanted.count === undefined) return { ...wanted, count: input.count };
  return wanted ?? input;
}

function craftClause(c: string): TaskStep | undefined {
  const m = c.match(/\b(?:craft|make|build|create|assemble|forge|construct)\s+(?!sure\b|your way\b|it\b|yourself\b|sense\b|money\b)(.+)$/);
  if (!m?.[1]) return undefined;
  return itemStep("craft", m[1].replace(/\s+out of\b.*$/, ""));
}

function equipClause(c: string): TaskStep | undefined {
  const m = c.match(/\b(?:equip|hold|wield|wear|put on|don|switch to)\s+(.+)$/) ?? c.match(/\bput\s+(.+?)\s+on\b/);
  if (!m?.[1]) return undefined;
  const { name } = countAndName(m[1].replace(/\s+(?:in|on|with)\b.*$/, ""));
  if (!usableName(name) || mobIn(name)) return undefined;
  return { kind: "equip", item: name };
}

const UNITS: Record<string, number> = { s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60 };

/**
 * Stay alive for a while: "survive", "defend yourself", "hold out", and any clause that names a duration ("for 30
 * seconds"), which is a goal with a check (the time), not one to drop.
 */
function surviveClause(c: string, durationMs?: number): PlanAction | undefined {
  const d = c.match(/\bfor\s+(?:(\d+)|(one|two|three|four|five|six|seven|eight|nine|ten))\s*(s|secs?|seconds?|m|mins?|minutes?)\b/);
  if (!d && !/\b(?:survive|stay alive|hold out|hold the line|stay safe|keep yourself alive|defend(?: yourself)?|protect yourself)\b/.test(c)) return undefined;
  const n = d ? (d[1] ? Number(d[1]) : NUMBERS[d[2] ?? ""]) : undefined;
  const seconds = n !== undefined ? n * (UNITS[d?.[3] ?? "s"] ?? 1) : durationMs !== undefined ? Math.round(durationMs / 1000) : DEFAULT_SURVIVE_S;
  return { kind: "survive", seconds };
}

/** Every step the patterns read from one clause, one per kind, in priority order. More than one is a tie. */
function candidates(c: string, durationMs?: number): PlanAction[] {
  const out: PlanAction[] = [];
  const add = (a: PlanAction | undefined) => {
    if (a && !out.some((o) => o.kind === a.kind)) out.push(a);
  };
  const old = parseGoal(c);
  if (old.kind !== "free") add(old);
  add(killClause(c));
  add(reachClause(c));
  add(tradeClause(c));
  add(fetchClause(c));
  add(smeltClause(c));
  add(craftClause(c));
  add(equipClause(c));
  add(surviveClause(c, durationMs));
  return out;
}

/**
 * Compile a goal into steps and standing orders, by the grammar alone. A clause it cannot place is `free`, which
 * `play` reports as not understood; a clause two patterns claim goes to the first in the grammar's order.
 */
export function compileGoal(text: string, durationMs?: number): Plan {
  const { text: rest, orders } = readOrders(normalize(text));
  const steps: PlanStep[] = [];
  for (const clause of splitClauses(rest)) {
    const first = candidates(clause, durationMs)[0];
    steps.push(first ? { ...first, clause } : { kind: "free", text: clause, clause });
  }
  return { steps: mergeFree(steps.length ? steps : [{ kind: "free", text: text.trim(), clause: text.trim() }]), orders };
}

/** Free steps next to each other are one: none of them ends before the time limit. */
function mergeFree(steps: PlanStep[]): PlanStep[] {
  const out: PlanStep[] = [];
  for (const s of steps) {
    const prev = out.at(-1);
    if (prev?.kind === "free" && s.kind === "free") {
      const clause = `${prev.clause}, ${s.clause}`;
      out[out.length - 1] = { kind: "free", text: clause, clause };
    } else out.push(s);
  }
  return out;
}

/** One line for a step: `kill 3 zombie`, `craft iron sword`, `go to gold block`. */
export function stepLabel(step: PlanAction): string {
  switch (step.kind) {
    case "kill":
      return `kill ${step.count ?? "every"} ${step.type ? bareId(step.type) : "hostile"}`;
    case "reach":
      return `go to ${step.x} ${step.y ?? ""} ${step.z}`.replace(/\s+/g, " ");
    case "use_on":
      return `hit every ${bareId(step.type)} once`;
    case "reach_block":
      return `go to the ${step.block}`;
    case "reach_entity":
      return `go to the ${bareId(step.type)}`;
    case "equip":
      return `equip ${step.item}`;
    case "survive":
      return `survive ${step.seconds} s`;
    case "free":
      return `free: ${step.text}`;
    default:
      return `${step.kind} ${step.count !== undefined ? `${step.count} ` : step.kind === "fetch" && step.all ? "all " : ""}${step.item}`;
  }
}

/** The forms the goal grammar understands, one example each, for a message that asks to say a goal again. */
export const UNDERSTOOD_FORMS =
  'kill ("kill 3 zombies"), reach ("go to 10 64 -20"), hit every ("hit every cow once with the held item"), craft ("craft an iron sword"), ' +
  'smelt ("smelt the raw iron"), trade ("trade for an emerald"), fetch ("get the diamonds out of the chest"), equip ("equip the shield"), ' +
  'go to ("go to the gold block"), survive ("survive for 30 seconds")';
