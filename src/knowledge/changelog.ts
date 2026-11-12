/**
 * Bedrock changelogs from feedback.minecraft.net (Zendesk Help Center API): release changelogs for stable,
 * Beta & Preview changelogs for preview. Articles are converted to markdown and indexed per section. The daily
 * version pins name each channel's newest article; when the cache lacks it, the MCP server fetches the articles
 * again in the background and later calls use them.
 */
import { readFile } from "node:fs/promises";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { backgroundDownloadsAllowed } from "../core/background.ts";
import { cacheDir } from "../core/paths.ts";
import { type Channel, compareGameVersions, type GameVersion, parseGameVersion } from "../core/version.ts";
import { writeJsonAtomic } from "../core/fs.ts";
import { httpJson, OfflineMissingError, progress, single } from "./net.ts";
import { chunkMarkdown, excerpt, type IndexedDoc, SearchIndex } from "./search.ts";
import { RETRY_AFTER_FAILURE_MS } from "./tracked.ts";
import { changelogTitleVersion, getPins, zendeskArticlesUrl } from "./versions.ts";

const INDEX_FORMAT = 1;

export interface ChangelogArticle {
  id: number;
  title: string;
  /** Internal game version parsed from the title (`1.26.62`, `1.26.70.23`). */
  version: string;
  /** ISO timestamp the article was published. */
  date: string;
  updated: string;
  url: string;
  markdown: string;
}

interface ZendeskPage {
  articles: { id: number; title: string; created_at: string; updated_at: string; html_url: string; body: string | null }[];
  next_page: string | null;
}

const articlesPath = (channel: Channel): string => cacheDir("knowledge", "changelogs", `${channel}.json`);

async function readArticles(channel: Channel): Promise<ChangelogArticle[] | undefined> {
  try {
    return JSON.parse(await readFile(articlesPath(channel), "utf8")) as ChangelogArticle[];
  } catch {
    return undefined;
  }
}

export async function fetchChangelogs(channel: Channel): Promise<ChangelogArticle[]> {
  return single(`changelogs:${channel}`, async () => {
    progress(`downloading ${channel} changelogs from feedback.minecraft.net`);
    const converter = new NodeHtmlMarkdown({ maxConsecutiveNewlines: 2 });
    const out: ChangelogArticle[] = [];
    let url: string | null = `${zendeskArticlesUrl(channel)}?per_page=100&sort_by=created_at&sort_order=desc`;
    while (url) {
      const page: ZendeskPage = await httpJson<ZendeskPage>(url);
      for (const a of page.articles) {
        const version = changelogTitleVersion(a.title);
        if (!version) continue;
        out.push({
          id: a.id,
          title: a.title,
          version,
          date: a.created_at,
          updated: a.updated_at,
          url: a.html_url,
          markdown: converter.translate(a.body ?? ""),
        });
      }
      url = page.next_page;
    }
    await writeJsonAtomic(articlesPath(channel), out);
    progress(`${out.length} ${channel} changelog articles cached`);
    return out;
  });
}

/** Per channel: when the background fetch last failed (per process), and fetches in flight. */
const refreshFailures = new Map<Channel, number>();
const refreshing = new Set<Channel>();

/** Fetch the articles again in the background when the pins name a newer article than the cache has. */
async function refreshWhenBehind(channel: Channel, cached: ChangelogArticle[]): Promise<void> {
  if (refreshing.has(channel) || Date.now() - (refreshFailures.get(channel) ?? 0) < RETRY_AFTER_FAILURE_MS) return;
  refreshing.add(channel);
  try {
    const newest = (await getPins()).channels[channel].changelog;
    if (newest && !cached.some((a) => a.url === newest.url)) {
      const fresh = await fetchChangelogs(channel);
      // Still missing (renamed or unlisted article): wait before fetching everything again.
      if (!fresh.some((a) => a.url === newest.url)) refreshFailures.set(channel, Date.now());
    }
  } catch (err) {
    refreshFailures.set(channel, Date.now());
    progress(`${channel} changelogs update failed (${err instanceof Error ? err.message : String(err)}); keeping the cached articles`);
  } finally {
    refreshing.delete(channel);
  }
}

export async function getChangelogs(channel: Channel, offline?: boolean): Promise<ChangelogArticle[]> {
  const cached = await readArticles(channel);
  if (cached) {
    if (!offline && backgroundDownloadsAllowed()) void refreshWhenBehind(channel, cached);
    return cached;
  }
  if (offline) throw new OfflineMissingError(`${channel} changelogs`);
  return fetchChangelogs(channel);
}

/** Cached articles without network, for status reports. */
export async function changelogStatus(channel: Channel): Promise<{ count: number; newest?: string } | undefined> {
  const articles = await readArticles(channel);
  if (!articles) return undefined;
  const newest = articles.reduce<ChangelogArticle | undefined>((m, a) => (!m || a.date > m.date ? a : m), undefined);
  return newest ? { count: articles.length, newest: newest.version } : { count: articles.length };
}

export interface ChangelogChunk extends IndexedDoc {
  articleId: number;
  version: string;
  date: string;
  url: string;
}

const indexCache = new Map<string, SearchIndex<ChangelogChunk>>();

export async function changelogIndex(
  channel: Channel,
  articles: ChangelogArticle[],
): Promise<SearchIndex<ChangelogChunk>> {
  const newest = articles.reduce((m, a) => (a.updated > m ? a.updated : m), "");
  const key = `${articles.length}:${newest}:${INDEX_FORMAT}`;
  const cached = indexCache.get(channel);
  if (cached?.key === key) return cached;
  return single(`changelog-index:${channel}:${key}`, async () => {
    const path = cacheDir("knowledge", "index", `changelog-${channel}`);
    let index = await SearchIndex.load<ChangelogChunk>(path, key);
    if (!index) {
      progress(`indexing ${channel} changelogs`);
      const chunks: ChangelogChunk[] = [];
      for (const a of articles) {
        for (const [n, c] of chunkMarkdown(a.markdown, 1600).entries()) {
          chunks.push({
            id: `${a.id}#${n}`,
            title: a.title,
            heading: c.heading,
            text: c.text,
            articleId: a.id,
            version: a.version,
            date: a.date,
            url: a.url,
          });
        }
      }
      index = SearchIndex.build(key, chunks);
      await index.save(path);
    }
    indexCache.set(channel, index);
    return index;
  });
}

/**
 * Inclusive comparison against a bound: a bound without a build (`1.26.60`) compares on major.minor.patch only,
 * so `1.26.60.25` (a 1.26.60 preview) sits inside `[1.26.60, …]`.
 */
export function compareToBound(version: GameVersion, bound: GameVersion): number {
  if (bound.build === undefined) {
    return version.major - bound.major || version.minor - bound.minor || version.patch - bound.patch;
  }
  return compareGameVersions(version, bound);
}

/** `from` is exclusive (what changed after it), `to` inclusive. */
export function inVersionRange(version: string, from?: string, to?: string): boolean {
  const v = parseGameVersion(version);
  if (!v) return false;
  const f = from ? parseGameVersion(from) : undefined;
  const t = to ? parseGameVersion(to) : undefined;
  if (f && compareToBound(v, f) <= 0) return false;
  if (t && compareToBound(v, t) > 0) return false;
  return true;
}

export interface ChangelogHit {
  title: string;
  version: string;
  date: string;
  url: string;
  heading: string;
  excerpt: string;
  score?: number;
}

export interface ChangelogSearchResult {
  channel: Channel;
  /** Newest changelog version in the cache. */
  version: string;
  query: string;
  from?: string;
  to?: string;
  hits: ChangelogHit[];
  /** Articles in the version range (when a range is given). */
  articles?: { title: string; version: string; date: string; url: string }[];
}

export async function searchChangelogs(opts: {
  channel: Channel;
  query: string;
  from?: string;
  to?: string;
  limit?: number;
  offline?: boolean;
}): Promise<ChangelogSearchResult> {
  const articles = await getChangelogs(opts.channel, opts.offline);
  const limit = opts.limit ?? 10;
  const ranged = opts.from !== undefined || opts.to !== undefined;
  const inRange = (version: string) => !ranged || inVersionRange(version, opts.from, opts.to);
  const byVersion = (a: { version: string }, b: { version: string }) =>
    compareGameVersions(parseGameVersion(a.version)!, parseGameVersion(b.version)!);
  const newest = [...articles].sort(byVersion).at(-1)?.version ?? "";
  const result: ChangelogSearchResult = { channel: opts.channel, version: newest, query: opts.query, hits: [] };
  if (opts.from) result.from = opts.from;
  if (opts.to) result.to = opts.to;
  if (ranged) {
    result.articles = articles
      .filter((a) => inRange(a.version))
      .sort(byVersion)
      .map((a) => ({ title: a.title, version: a.version, date: a.date, url: a.url }));
  }
  if (opts.query.trim()) {
    const index = await changelogIndex(opts.channel, articles);
    const hits = index.search(opts.query, {
      limit: ranged ? limit * 4 : limit,
      filter: (d) => inRange(d.version),
      strict: ranged,
    });
    const picked = (ranged ? [...hits].sort((a, b) => byVersion(a.doc, b.doc)) : hits).slice(0, limit);
    result.hits = picked.map((h) => ({
      title: h.doc.title,
      version: h.doc.version,
      date: h.doc.date,
      url: h.doc.url,
      heading: h.doc.heading,
      excerpt: excerpt(h.doc.text, opts.query),
      score: h.score,
    }));
  }
  return result;
}
