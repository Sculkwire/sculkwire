/**
 * Identifier-aware tokenizer shared by indexing and querying. Compound identifiers are kept whole and also
 * split, so `minecraft:behavior.tempt` matches `behavior.tempt` and `tempt`, and `getComponent` matches
 * `getcomponent`, `get` and `component`.
 */

const STOP: Record<string, true> = Object.fromEntries(
  "a an and are as at be by can for from if in into is it its of on or that the this to was were will with"
    .split(" ")
    .map((w) => [w, true]),
);

/** A run of identifier characters; inner `: . / - @` join compound identifiers. */
const WORD_RE = /[\p{L}\p{N}_$@][\p{L}\p{N}_$@:.\/-]*[\p{L}\p{N}_$]|[\p{L}\p{N}_$]/gu;
const SEPARATORS_RE = /[:./@-]+/;
const CAMEL_RE = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g;

/** Light English stemming for plain words, so `properties` matches `property` and `entities` `entity`. */
export function stem(word: string): string {
  if (!/^[a-z]+$/.test(word) || word.length <= 4) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function splitWord(part: string, out: Set<string>): void {
  const subs = part.split("_").filter(Boolean);
  for (const sub of subs.length > 1 ? subs : [part]) {
    const camel = sub.match(CAMEL_RE) ?? [];
    if (camel.length > 1) {
      out.add(sub.toLowerCase());
      for (const c of camel) out.add(stem(c.toLowerCase()));
    } else {
      out.add(stem(sub.toLowerCase()));
    }
  }
}

/** Tokens for one compound word (deduplicated). */
export function expandWord(word: string): string[] {
  const out = new Set<string>();
  const lower = word.toLowerCase();
  const isCompound = SEPARATORS_RE.test(word);
  const parts = word.split(SEPARATORS_RE).filter(Boolean);
  if (isCompound) {
    out.add(lower);
    const colon = lower.indexOf(":");
    if (colon > 0 && colon < lower.length - 1) out.add(lower.slice(colon + 1));
  } else if (parts.length === 1 && STOP[lower]) {
    return [];
  }
  for (const part of parts) {
    if (part.includes("_") || /[a-z][A-Z]|[A-Z]{2}[a-z]/.test(part)) out.add(part.toLowerCase());
    splitWord(part, out);
  }
  return [...out];
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WORD_RE)) out.push(...expandWord(m[0]));
  return out;
}
