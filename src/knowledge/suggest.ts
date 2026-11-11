/** Near names for a lookup that matched nothing: substring matches first, then names within a small edit distance. */

/** Edit distance where insertion, deletion, substitution and swapping two adjacent letters each cost 1. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Three rows suffice: the transposition looks two rows back.
  let prev2 = new Array<number>(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2]! + 1);
      cur[j] = d;
    }
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[b.length]!;
}

/** Largest edit distance still offered as a near name: 1 for 2 to 3 letters, 2 for 4 to 7, 3 beyond. */
export function maxDistance(length: number): number {
  if (length <= 1) return 0;
  if (length <= 3) return 1;
  if (length <= 7) return 2;
  return 3;
}

/**
 * Rank `candidates` against `query` (case-insensitive). Names whose key contains the query come first (closest
 * length first), then names whose key is within `maxDistance(query.length)` edits (smallest distance first); ties
 * go to the shorter name, then sort by name, so the order is the same on every call. `key` picks the part of a name
 * to compare (default: all of it).
 */
export function suggestNames(
  query: string,
  candidates: Iterable<string>,
  opts: { limit?: number; key?: (name: string) => string } = {},
): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const key = opts.key ?? ((n: string) => n);
  const limit = opts.limit ?? 15;
  const threshold = maxDistance(q.length);
  const ranked: { name: string; tier: number; score: number }[] = [];
  const seen = new Set<string>();
  for (const name of candidates) {
    if (seen.has(name)) continue;
    seen.add(name);
    const k = key(name).toLowerCase();
    if (k.includes(q)) {
      ranked.push({ name, tier: 0, score: k.length - q.length });
      continue;
    }
    // Lengths further apart than the threshold cannot be within it.
    if (Math.abs(k.length - q.length) > threshold) continue;
    const d = editDistance(q, k);
    if (d <= threshold) ranked.push({ name, tier: 1, score: d });
  }
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.score - b.score ||
      a.name.length - b.name.length ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return ranked.slice(0, limit).map((r) => r.name);
}
