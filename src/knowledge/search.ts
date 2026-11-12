/** BM25 full-text index (MiniSearch) over knowledge chunks, persisted next to the data it was built from. */
import { readFile } from "node:fs/promises";
import MiniSearch from "minisearch";
import { writeFileAtomic, writeJsonAtomic } from "../core/fs.ts";
import { tokenize } from "./tokenize.ts";

export interface IndexedDoc {
  id: string;
  title: string;
  /** Heading trail inside the source document. */
  heading: string;
  text: string;
}

export interface SearchHit<D> {
  doc: D;
  score: number;
  terms: string[];
}

const FIELDS = ["title", "heading", "text"];
const BOOST = { title: 3, heading: 2, text: 1 };
const LOOSE = (term: string): boolean => term.length >= 5 && !/[:./@-]/.test(term);

function options(): ConstructorParameters<typeof MiniSearch>[0] {
  return {
    fields: FIELDS,
    storeFields: [],
    tokenize: (text: string) => tokenize(text),
    processTerm: (term: string) => term,
    searchOptions: { tokenize: (text: string) => tokenize(text), processTerm: (term: string) => term },
  };
}

export class SearchIndex<D extends IndexedDoc> {
  readonly key: string;
  readonly docs: Map<string, D>;
  readonly #mini: MiniSearch<D>;

  private constructor(key: string, docs: D[], mini: MiniSearch<D>) {
    this.key = key;
    this.docs = new Map(docs.map((d) => [d.id, d]));
    this.#mini = mini;
  }

  static build<D extends IndexedDoc>(key: string, docs: D[]): SearchIndex<D> {
    const mini = new MiniSearch<D>(options());
    mini.addAll(docs);
    return new SearchIndex(key, docs, mini);
  }

  /** Load a persisted index if its key matches; undefined when absent or stale. */
  static async load<D extends IndexedDoc>(path: string, key: string): Promise<SearchIndex<D> | undefined> {
    try {
      const meta = JSON.parse(await readFile(`${path}.docs.json`, "utf8")) as { key: string; docs: D[] };
      if (meta.key !== key) return undefined;
      const mini = await MiniSearch.loadJSONAsync<D>(await readFile(`${path}.index.json`, "utf8"), options());
      return new SearchIndex(key, meta.docs, mini);
    } catch {
      return undefined;
    }
  }

  async save(path: string): Promise<void> {
    await writeFileAtomic(`${path}.index.json`, JSON.stringify(this.#mini));
    await writeJsonAtomic(`${path}.docs.json`, { key: this.key, docs: [...this.docs.values()] });
  }

  /**
   * All query terms must match first (AND); if that yields fewer than `limit` hits, the rest are filled from
   * an OR search with prefix and fuzzy matching on plain words.
   */
  search(query: string, opts: { limit: number; filter?: (doc: D) => boolean; strict?: boolean }): SearchHit<D>[] {
    const filter = opts.filter
      ? (r: { id: unknown }) => {
          const doc = this.docs.get(String(r.id));
          return !!doc && opts.filter!(doc);
        }
      : undefined;
    const strict = this.#mini.search(query, { combineWith: "AND", boost: BOOST, filter });
    const hits = strict.slice(0, opts.limit);
    if (hits.length < opts.limit && !(opts.strict && hits.length > 0)) {
      const seen = new Set(hits.map((h) => h.id));
      const loose = this.#mini.search(query, {
        combineWith: "OR",
        boost: BOOST,
        filter,
        prefix: LOOSE,
        fuzzy: (term: string) => (LOOSE(term) ? 0.15 : false),
      });
      for (const h of loose) {
        if (hits.length >= opts.limit) break;
        if (!seen.has(h.id)) hits.push(h);
      }
    }
    return hits.flatMap((h) => {
      const doc = this.docs.get(String(h.id));
      return doc ? [{ doc, score: Math.round(h.score * 100) / 100, terms: h.terms }] : [];
    });
  }
}

/** Lines of `text` that mention any query token, else the opening; capped for agent-sized output. */
export function excerpt(text: string, query: string, maxLines = 6, maxChars = 900): string {
  const tokens = new Set(tokenize(query));
  const lines = text.split("\n").filter((l) => l.trim());
  const matching = lines.filter((l) => tokenize(l).some((t) => tokens.has(t)));
  const picked = (matching.length ? matching : lines).slice(0, maxLines).join("\n");
  return picked.length > maxChars ? `${picked.slice(0, maxChars)}…` : picked;
}

/** Split markdown into heading-scoped chunks no longer than `maxChars` (split at line boundaries). */
export function chunkMarkdown(markdown: string, maxChars = 2400): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = [];
  const trail: string[] = [];
  let buf: string[] = [];
  let size = 0;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) out.push({ heading: trail.filter(Boolean).join(" > "), text });
    buf = [];
    size = 0;
  };
  let fence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h?.[1] && h[2] !== undefined) {
      flush();
      const level = h[1].length;
      trail.length = level - 1;
      trail[level - 1] = h[2].replace(/[*_`]/g, "");
      continue;
    }
    if (size + line.length > maxChars && size > 0) flush();
    buf.push(line);
    size += line.length + 1;
  }
  flush();
  return out;
}
