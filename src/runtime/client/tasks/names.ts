/**
 * Item and block names as a caller writes them: an id with or without namespace, or plain words ("iron sword", "the
 * ore", "a pickaxe out of the planks"). Resolved against the game's registry, the inventory and the recipe index:
 *
 * 1. the exact id, then the id without namespace;
 * 2. the words of the name part. A material named after "from", "out of", "of", "made of" or "using" ("planks",
 *    "wood", "cobblestone", "iron") selects the variant made of it (`wooden_`, `stone_`, `iron_`), and a material word
 *    in the name itself means its variant too ("wood pickaxe", "gold sword"). Words after the name that are not part
 *    of it ("made", "built", "please", "for me", "at the table over there") end it;
 * 3. the ids that contain every word, else the longest run of the words that some id contains;
 * 4. several variants and no material ("a pickaxe"): with `makeable` (a craft), the variants that can be made or
 *    fetched from the inventory, else from the inventory and the containers near, the best material first (netherite,
 *    diamond, iron, copper, chainmail, stone, golden, wooden, leather); none: as below, and `considered` lists them;
 * 5. a tie is broken by what is at hand (the inventory, then the containers near; the one there is most of), else by
 *    the plainest id (fewest words). A tie that remains is reported (`tied`), never guessed.
 */
import { bareId, namespaced } from "./recipes.ts";
import type { InventoryCounts } from "./types.ts";

/** Words that name nothing. */
const STOP_WORDS: Record<string, true> = { the: true, a: true, an: true, some: true, my: true, any: true, me: true, one: true };

/** Words that end the name: what follows says where, how or for whom, not what. */
const END_WORDS: Record<string, true> = {
  made: true,
  crafted: true,
  built: true,
  ready: true,
  please: true,
  for: true,
  at: true,
  over: true,
  there: true,
  here: true,
  near: true,
  now: true,
  in: true,
  on: true,
  by: true,
};

/**
 * A few plain words that are not part of the ids they mean: "blade" is a sword, "ore" also means the raw ore items
 * the game drops (raw_iron), "pick" a pickaxe.
 */
const SYNONYMS: Record<string, string[]> = {
  blade: ["sword"],
  ore: ["ore", "raw"],
  pick: ["pickaxe"],
};

/** Material words -> the id token of the variant made of it (`wooden_pickaxe`, `golden_sword`, `stone_axe`). */
const MATERIALS: Record<string, string> = {
  wood: "wooden",
  wooden: "wooden",
  plank: "wooden",
  planks: "wooden",
  log: "wooden",
  logs: "wooden",
  gold: "golden",
  golden: "golden",
  stone: "stone",
  cobblestone: "stone",
  cobble: "stone",
  iron: "iron",
  diamond: "diamond",
  diamonds: "diamond",
  netherite: "netherite",
  copper: "copper",
  leather: "leather",
  chainmail: "chainmail",
  chain: "chainmail",
};

/** Better first: which variant "a sword" means when several can be made (durability and damage order). */
const MATERIAL_RANK = ["netherite", "diamond", "iron", "copper", "chainmail", "stone", "golden", "wooden", "leather"];

/** "<name> from|out of|of|made of|made from|using <material>": the name part and the material part. */
const MATERIAL_CLAUSE = /^(.*?)\s+(?:made\s+(?:of|from|out\s+of)|out\s+of|from|of|using|with)\s+(.+)$/;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .split(/[\s_:-]+/)
    .filter((word) => word && !STOP_WORDS[word]);
}

/** The words up to the first word that ends a name. */
function nameWords(text: string): string[] {
  const out: string[] = [];
  for (const word of tokens(text)) {
    if (END_WORDS[word]) break;
    out.push(word);
  }
  return out;
}

/** The spellings one word may take in an id token: itself, its singular, its synonyms, and its material's token. */
function spellings(word: string): string[] {
  const out = new Set([word, ...(SYNONYMS[word] ?? [])]);
  const material = MATERIALS[word];
  if (material) out.add(material);
  if (word.length > 3 && word.endsWith("s")) out.add(word.slice(0, -1));
  if (word.length > 4 && word.endsWith("es")) out.add(word.slice(0, -2));
  return [...out];
}

function idTokens(id: string): string[] {
  return bareId(id).toLowerCase().split("_");
}

function materialOf(id: string): string | undefined {
  return idTokens(id).find((token) => MATERIAL_RANK.includes(token));
}

/** The words of a phrase: the name part's words, and the material token a material clause names. */
export function parseItemPhrase(raw: string): { words: string[]; material?: string } {
  const clause = MATERIAL_CLAUSE.exec(raw.trim().toLowerCase());
  if (!clause) return { words: nameWords(raw) };
  const name = nameWords(clause[1] ?? "");
  const after = nameWords(clause[2] ?? "");
  const material = after.map((word) => MATERIALS[word]).find((token) => token !== undefined);
  // "bucket of water": not a material, so the words belong to the name.
  return material ? { words: name, material } : { words: [...name, ...after] };
}

export interface NameResolution {
  /** The resolved id, namespaced; undefined when nothing matches. */
  id?: string;
  /** Every id the words matched, for a message when none was picked. */
  candidates: string[];
  /** The ids still tied after every rule; the caller fails naming them. */
  tied?: string[];
  /** Why this variant was taken when the phrase named several (`the only one makeable from what is at hand`). */
  chosen?: string;
  /** The variants weighed when none could be made, for the step's failure. */
  considered?: string[];
}

export interface ResolveNameOptions {
  raw: string;
  /** Every id known (registry, recipe index, inventory, containers seen). */
  universe: Iterable<string>;
  /** Item counts in the inventory. */
  atHand: InventoryCounts;
  /** Item counts in the containers near, when they were read. */
  near?: InventoryCounts;
  /**
   * A craft: whether a variant can be made (or fetched) from the inventory alone (`inventory`) or with the containers
   * near (`near`). Given, a phrase naming several variants without a material takes a makeable one.
   */
  makeable?: (id: string, from: "inventory" | "near") => Promise<boolean>;
}

function matching(ids: Iterable<string>, words: readonly string[], material?: string): string[] {
  return [...ids]
    .filter((id) => {
      const have = idTokens(id);
      if (material && !have.includes(material)) return false;
      return words.every((word) => spellings(word).some((spelling) => have.includes(spelling)));
    })
    .sort();
}

export async function resolveName(options: ResolveNameOptions): Promise<NameResolution> {
  const raw = options.raw.trim();
  const ids = new Set<string>();
  for (const id of options.universe) ids.add(namespaced(id));
  for (const id of Object.keys(options.atHand)) ids.add(id);
  for (const id of Object.keys(options.near ?? {})) ids.add(id);
  const exact = raw.toLowerCase().replace(/\s+/g, "_");
  if (exact.includes(":") && ids.has(exact)) return { id: exact, candidates: [exact] };
  if (ids.has(namespaced(exact))) return { id: namespaced(exact), candidates: [namespaced(exact)] };
  const { words, material } = parseItemPhrase(raw);
  if (!words.length) return { candidates: [] };
  let candidates = matching(ids, words, material);
  // Words the name does not take: the longest run of them that some id contains, the earliest first.
  for (let length = words.length - 1; !candidates.length && length > 0; length--) {
    for (let start = 0; start + length <= words.length && !candidates.length; start++) candidates = matching(ids, words.slice(start, start + length), material);
  }
  if (candidates.length === 1) return { id: candidates[0], candidates };
  // A name written as an id (no spaces) that no known id matches is taken as the id it spells: the step then says
  // where it looked for it.
  if (!candidates.length) return /\s/.test(raw) ? { candidates } : { id: namespaced(exact), candidates };
  let considered: string[] | undefined;
  const variants = candidates.filter((id) => materialOf(id) !== undefined);
  if (options.makeable && !material && variants.length > 1) {
    for (const from of ["inventory", "near"] as const) {
      const can: string[] = [];
      for (const id of variants) if (await options.makeable(id, from)) can.push(id);
      if (!can.length) continue;
      const rank = (id: string) => MATERIAL_RANK.indexOf(materialOf(id) ?? "");
      const best = [...can].sort((a, b) => rank(a) - rank(b) || a.length - b.length)[0] as string;
      const where = from === "inventory" ? "the inventory" : "the inventory and the containers near";
      const others = can.filter((id) => id !== best).map(bareId);
      const chosen = others.length
        ? `the best material makeable from ${where}; also makeable: ${others.join(", ")}`
        : `the only one makeable from ${where}`;
      return { id: best, candidates, chosen };
    }
    considered = variants;
  }
  const noted = considered ? { considered } : {};
  // A tie: what is at hand first, then what is in the containers near.
  let tied = candidates.filter((id) => (options.atHand[id] ?? 0) > 0);
  if (!tied.length && options.near) tied = candidates.filter((id) => (options.near?.[id] ?? 0) > 0);
  if (!tied.length) {
    // Nothing of them is at hand: the plainest id (fewest words) is what the words name.
    const fewest = Math.min(...candidates.map((id) => idTokens(id).length));
    tied = candidates.filter((id) => idTokens(id).length === fewest);
  }
  // Of several at hand, the one there is most of; equal counts leave the tie for the caller to report.
  const have = (id: string) => (options.atHand[id] ?? 0) + (options.near?.[id] ?? 0);
  const most = Math.max(...tied.map(have));
  const top = tied.filter((id) => have(id) === most);
  if (top.length === 1) return { id: top[0], candidates, ...noted };
  return { candidates, tied: top, ...noted };
}
