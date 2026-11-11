/**
 * Deterministic goals. Common goals are read from the goal text (kill N of a type, kill every hostile near, reach a
 * place, hit every X near once), and checked against the game every decision, so `play` stops when they are met.
 * Other goals run until the time limit.
 */
import { MOBS, shortType } from "./mobs.ts";
import type { ThreatMap } from "./threat.ts";

export type Goal =
  | { kind: "kill"; /** Type id, or undefined for every hostile mob. */ type?: string; /** Kills to make; undefined: none left near. */ count?: number; radius: number }
  | { kind: "reach"; x: number; y?: number; z: number; radius: number }
  | { kind: "use_on"; type: string; radius: number }
  | { kind: "free" };

/** Goals about everything "near you" look this far. */
export const GOAL_RADIUS = 24;

const PASSIVE = ["cow", "pig", "sheep", "chicken", "rabbit", "horse", "donkey", "mule", "llama", "goat", "villager", "cat", "fox", "parrot", "panda", "turtle", "frog", "armadillo", "camel", "sniffer", "axolotl", "squid", "mooshroom", "ocelot", "bat", "strider", "allay", "dolphin", "cod", "salmon", "tropicalfish", "pufferfish", "trader_llama", "wandering_trader", "snow_golem"];
const KNOWN = new Set([...Object.keys(MOBS), ...PASSIVE]);
const IRREGULAR: Record<string, string> = { endermen: "enderman", wolves: "wolf", sheep: "sheep", fish: "cod", mice: "silverfish", "zombie pigmen": "zombified_piglin", "zombified piglins": "zombified_piglin" };
const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const HOSTILE_WORDS = /\b(hostile mobs?|hostiles|monsters?|enemies|enemy|mobs)\b/;

/** `zombies` -> `zombie`, `cave spiders` -> `cave_spider`, or undefined when it is not a mob. */
export function mobType(words: string): string | undefined {
  const w = words.trim().toLowerCase();
  if (IRREGULAR[w]) return IRREGULAR[w];
  const joined = w.replace(/\s+/g, "_");
  for (const c of [joined, joined.replace(/es$/, ""), joined.replace(/s$/, "")]) if (KNOWN.has(c)) return c;
  return undefined;
}

/** The first mob named in `text`, its words, and whether it was plural. */
function findMob(text: string): { type: string; plural: boolean; index: number } | undefined {
  const words = text.split(/[^a-z_]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (const n of [2, 1]) {
      const phrase = words.slice(i, i + n).join(" ");
      if (n === 2 && i + 1 >= words.length) continue;
      const type = mobType(phrase);
      if (type) return { type, plural: phrase !== type.replace(/_/g, " ") && (phrase.endsWith("s") || phrase === "sheep" || IRREGULAR[phrase] !== undefined), index: i };
    }
  }
  return undefined;
}

export function parseGoal(text: string): Goal {
  const t = text.toLowerCase();
  const reach = /\b(?:go|walk|run|move|get|travel|head|return|come)\b[^0-9-]*?\bto\b|\breach\b/.test(t) ? t.match(/(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)(?:[\s,]+(-?\d+(?:\.\d+)?))?/) : null;
  if (reach) {
    const [a, b, c] = [reach[1], reach[2], reach[3]].map((v) => (v === undefined ? undefined : Number(v)));
    return c === undefined ? { kind: "reach", x: a as number, z: b as number, radius: 2 } : { kind: "reach", x: a as number, y: b as number, z: c, radius: 2 };
  }
  const kill = t.match(/\b(?:kill|slay|defeat|clear|eliminate|fight)\b(.*)/);
  if (kill) {
    const rest = kill[1] ?? "";
    const n = rest.match(/^\s*(?:the\s+)?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
    const count = n?.[1] ? (Number.isFinite(Number(n[1])) ? Number(n[1]) : NUMBERS[n[1]]) : undefined;
    const mob = findMob(rest);
    const hostile = HOSTILE_WORDS.exec(rest);
    if (mob) {
      // A number counts kills; "all", "every" or a plural means none left near; a lone singular means one.
      const every = /\b(all|every|each)\b/.test(rest) || mob.plural;
      return { kind: "kill", type: `minecraft:${mob.type}`, ...(count !== undefined ? { count } : every ? {} : { count: 1 }), radius: GOAL_RADIUS };
    }
    if (hostile) return { kind: "kill", ...(count !== undefined ? { count } : {}), radius: GOAL_RADIUS };
  }
  if (/\b(hit|shoot|throw|use|tag|freeze|touch|smack|poke|snowball)\b/.test(t) && /\b(every|each|all)\b|\bonce\b/.test(t)) {
    const mob = findMob(t.replace(/\b(with|using)\b.*$/, ""));
    if (mob) return { kind: "use_on", type: `minecraft:${mob.type}`, radius: GOAL_RADIUS };
  }
  return { kind: "free" };
}

export interface GoalContext {
  map: ThreatMap;
  /** Entity id -> type of every kill so far. */
  kills: ReadonlyMap<string, string>;
  /** Entity id -> type of every entity `use_on` hit. */
  usedOn: ReadonlyMap<string, string>;
}

export interface GoalCheck {
  /** False when the goal text is not one of the checked kinds. */
  known: boolean;
  done: boolean;
  /** Progress for the state text and the trace, e.g. `2 of 3 zombie killed`. */
  progress: string;
}

function matches(goalType: string | undefined, typeId: string, hostile: boolean): boolean {
  return goalType ? typeId === goalType : hostile;
}

export function checkGoal(goal: Goal, ctx: GoalContext): GoalCheck {
  const me = ctx.map.me.location;
  switch (goal.kind) {
    case "kill": {
      const what = goal.type ? shortType(goal.type) : "hostile";
      const killed = [...ctx.kills.entries()].filter(([, typeId]) => matches(goal.type, typeId, MOBS[shortType(typeId)]?.hostile === true)).length;
      if (goal.count !== undefined) return { known: true, done: killed >= goal.count, progress: `${killed} of ${goal.count} ${what} killed` };
      const left = ctx.map.entities.filter((e) => matches(goal.type, e.typeId, e.hostile) && e.distance <= goal.radius).length;
      return { known: true, done: left === 0, progress: `${killed} ${what} killed, ${left} left within ${goal.radius} blocks` };
    }
    case "reach": {
      const d = Math.hypot(me.x - goal.x, me.z - goal.z);
      return { known: true, done: d <= goal.radius, progress: `${d.toFixed(1)} blocks from ${goal.x} ${goal.y ?? ""} ${goal.z}`.replace(/\s+/g, " ") };
    }
    case "use_on": {
      const all = ctx.map.entities.filter((e) => e.typeId === goal.type && e.distance <= goal.radius);
      const left = all.filter((e) => !ctx.usedOn.has(e.id)).length;
      const hit = [...ctx.usedOn.values()].filter((t) => t === goal.type).length;
      return { known: true, done: left === 0, progress: `${hit} ${shortType(goal.type)} hit, ${left} left within ${goal.radius} blocks` };
    }
    case "free":
      return { known: false, done: false, progress: "no built-in check for this goal" };
  }
}
