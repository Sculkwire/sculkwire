/**
 * MicrosoftDocs/minecraft-creator (`creator/` markdown). The repo has one head that tracks preview
 * (`reference-docs-metadata.json`); the stable channel uses the last commit documenting the stable cycle.
 * The MCP server re-checks a checkout at most once a day in the background (`git ls-remote` of `main`, plus the
 * stable pin); when either moved, the checkout is fetched and re-indexed in the background and later calls use it.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { backgroundDownloadsAllowed } from "../core/background.ts";
import { cacheDir } from "../core/paths.ts";
import { type Channel, parseGameVersion } from "../core/version.ts";
import { fetchAndCheckout, headCommit, sparseClone } from "./git.ts";
import { writeJsonAtomic } from "../core/fs.ts";
import { OfflineMissingError, progress, runOk, single } from "./net.ts";
import { chunkMarkdown, excerpt, type IndexedDoc, SearchIndex } from "./search.ts";
import { CHECK_INTERVAL_MS, RETRY_AFTER_FAILURE_MS } from "./tracked.ts";
import { getPins, readPins } from "./versions.ts";

export const DOCS_REPO = "https://github.com/MicrosoftDocs/minecraft-creator";
export const DOCS_ATTRIBUTION =
  "Microsoft Learn Minecraft Creator docs (MicrosoftDocs/minecraft-creator), CC-BY-4.0, https://creativecommons.org/licenses/by/4.0/";
const DOCS_PATTERNS = ["/creator/**/*.md", "/reference-docs-metadata.json"];
/** Superseded Script API versions; indexing them buries current results. */
const SKIP_DIRS = ["creator/PriorScriptAPI/"];
/** Bump when chunking or tokenization changes so persisted indexes rebuild. */
const INDEX_FORMAT = 1;

export interface DocsCheckout {
  root: string;
  channel: Channel;
  /** Game version the snapshot documents (`1.26.70.23`, or the stable `1.26.60`). */
  version: string;
  /** Raw `minecraft_version` from the docs metadata (`1.26.70-preview.23`). */
  docsVersion: string;
  commit: string;
}

interface Marker {
  commit: string;
  docsVersion: string;
  /** Tip of `main` when the checkout was last fetched. */
  head?: string;
  /** Stable samples version the stable commit was chosen for. */
  stable?: string;
  /** Last time `main` was compared with `head`. */
  checkedAt?: string;
}

const MARKER = ".sculkwire-docs.json";
const docsDir = (channel: Channel): string => cacheDir("knowledge", "docs", channel);

/** `1.26.70-preview.23` → `1.26.70.23`. */
export function docsGameVersion(minecraftVersion: string): string {
  return minecraftVersion.replace(/-preview\./, ".");
}

async function docsVersionAt(dir: string, commit: string): Promise<string> {
  const { stdout } = await runOk("git", ["show", `${commit}:reference-docs-metadata.json`], dir);
  const meta: unknown = JSON.parse(stdout);
  if (meta && typeof meta === "object" && "minecraft_version" in meta && typeof meta.minecraft_version === "string") {
    return meta.minecraft_version;
  }
  throw new Error(`reference-docs-metadata.json at ${commit} has no minecraft_version`);
}

/** Newest commit whose documented cycle is not newer than `stableVersion` (major.minor.patch). */
async function stableCommit(dir: string, stableVersion: string): Promise<{ commit: string; docsVersion: string }> {
  const target = parseGameVersion(stableVersion);
  const { stdout } = await runOk("git", ["log", "--format=%H", "origin/main", "--", "reference-docs-metadata.json"], dir);
  for (const commit of stdout.split("\n").filter(Boolean)) {
    const docsVersion = await docsVersionAt(dir, commit);
    const v = parseGameVersion(docsVersion);
    if (!v || !target) continue;
    const cmp = v.major - target.major || v.minor - target.minor || v.patch - target.patch;
    if (cmp <= 0) return { commit, docsVersion };
  }
  throw new Error(`no minecraft-creator commit documents ${stableVersion} or older`);
}

async function readMarker(dir: string): Promise<Marker | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, MARKER), "utf8")) as Marker;
  } catch {
    return undefined;
  }
}

/** Per channel: when the background check last failed (per process), and checks in flight. */
const checkFailures = new Map<Channel, number>();
const checking = new Set<Channel>();

/** Compare `main` and the stable pin with the checkout; fetch and re-index when either moved. */
async function checkForUpdate(channel: Channel, marker: Marker): Promise<void> {
  const { stdout } = await runOk("git", ["ls-remote", DOCS_REPO, "refs/heads/main"]);
  const head = /^([0-9a-f]{40})\s/.exec(stdout)?.[1];
  if (!head) throw new Error(`git ls-remote ${DOCS_REPO}: no refs/heads/main`);
  const stable = (await readPins())?.channels.stable.samples.version;
  const moved = head !== marker.head || (channel === "stable" && !!stable && stable !== marker.stable);
  if (!moved) {
    await writeJsonAtomic(join(docsDir(channel), MARKER), { ...marker, checkedAt: new Date().toISOString() } satisfies Marker);
    return;
  }
  await ensureCreatorDocs({ channel, refresh: true });
  await docsIndex(channel);
}

export async function ensureCreatorDocs(opts: {
  channel: Channel;
  offline?: boolean;
  /** Fetch the newest docs even when a checkout exists. */
  refresh?: boolean;
}): Promise<DocsCheckout> {
  const dir = docsDir(opts.channel);
  // A cached checkout answers at once; only a first checkout or a refresh takes the per-channel lock.
  const cached = opts.refresh ? undefined : await readMarker(dir);
  const marker = cached ?? await single(`docs:${opts.channel}`, async () => {
    let marker = await readMarker(dir);
    if (!marker || opts.refresh) {
      if (opts.offline) {
        if (!marker) throw new OfflineMissingError(`minecraft-creator docs (${opts.channel})`);
      } else {
        const pins = await getPins();
        if (!(await headCommit(dir))) {
          progress(`checking out minecraft-creator docs (${opts.channel})`);
          await sparseClone(dir, { url: DOCS_REPO, ref: "main", patterns: DOCS_PATTERNS, history: true });
        } else {
          progress(`updating minecraft-creator docs (${opts.channel})`);
          await runOk("git", ["fetch", "--quiet", "--filter=blob:none", "origin", "main:refs/remotes/origin/main"], dir);
        }
        const head = (await runOk("git", ["rev-parse", "refs/remotes/origin/main"], dir)).stdout.trim();
        const stable = pins.channels.stable.samples.version;
        let commit: string;
        let docsVersion: string;
        if (opts.channel === "preview") {
          commit = await fetchAndCheckout(dir, "main");
          docsVersion = await docsVersionAt(dir, commit);
        } else {
          ({ commit, docsVersion } = await stableCommit(dir, stable));
          await runOk("git", ["checkout", "--quiet", "--detach", commit], dir);
        }
        marker = { commit, docsVersion, head, stable, checkedAt: new Date().toISOString() };
        await writeJsonAtomic(join(dir, MARKER), marker);
      }
    }
    if (!marker) throw new OfflineMissingError(`minecraft-creator docs (${opts.channel})`);
    return marker;
  });
  const due = !marker.checkedAt || !(Date.now() - Date.parse(marker.checkedAt) < CHECK_INTERVAL_MS);
  const failed = checkFailures.get(opts.channel) ?? 0;
  if (!opts.offline && due && backgroundDownloadsAllowed() && !checking.has(opts.channel) && Date.now() - failed >= RETRY_AFTER_FAILURE_MS) {
    checking.add(opts.channel);
    checkForUpdate(opts.channel, marker)
      .catch((err: unknown) => {
        checkFailures.set(opts.channel, Date.now());
        progress(`minecraft-creator docs (${opts.channel}) update failed (${err instanceof Error ? err.message : String(err)}); keeping ${marker.docsVersion}`);
      })
      .finally(() => checking.delete(opts.channel));
  }
  const v = parseGameVersion(marker.docsVersion);
  const version =
    opts.channel === "preview" ? docsGameVersion(marker.docsVersion) : v ? `${v.major}.${v.minor}.${v.patch}` : "";
  return { root: dir, channel: opts.channel, version, docsVersion: marker.docsVersion, commit: marker.commit };
}

/** The docs checkout's marker without network, for status reports. */
export async function docsStatus(channel: Channel): Promise<{ commit: string; docsVersion: string; head?: string; checkedAt?: string } | undefined> {
  return readMarker(docsDir(channel));
}

// ---------------------------------------------------------------------------------------------
// Index

export interface DocChunk extends IndexedDoc {
  path: string;
  url: string;
}

async function listMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) out.push(join(entry.parentPath, entry.name));
  }
  return out.sort();
}

/** Strips YAML front matter (LF or CRLF line endings) and returns its `title`. */
export function frontMatter(md: string): { title?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/.exec(md);
  if (!m) return { body: md };
  const title = /^title:\s*["']?(.*?)["']?\s*$/m.exec(m[1] ?? "")?.[1];
  return { title, body: md.slice(m[0].length) };
}

export function learnUrl(path: string): string {
  return `https://learn.microsoft.com/en-us/minecraft/${path.replace(/\.md$/, "").replace(/\/index$/, "/").toLowerCase()}`;
}

async function buildDocsIndex(checkout: DocsCheckout): Promise<SearchIndex<DocChunk>> {
  const chunks: DocChunk[] = [];
  for (const file of await listMarkdown(join(checkout.root, "creator"))) {
    const path = relative(checkout.root, file).split("\\").join("/");
    if (SKIP_DIRS.some((d) => path.startsWith(d))) continue;
    const { title, body } = frontMatter(await readFile(file, "utf8"));
    const pageTitle = title ?? /^#\s+(.+)$/m.exec(body)?.[1] ?? path;
    for (const [n, c] of chunkMarkdown(body).entries()) {
      chunks.push({ id: `${path}#${n}`, title: pageTitle, heading: c.heading, text: c.text, path, url: learnUrl(path) });
    }
  }
  return SearchIndex.build(`${checkout.commit}:${INDEX_FORMAT}`, chunks);
}

const indexCache = new Map<string, Promise<SearchIndex<DocChunk>>>();

export async function docsIndex(
  channel: Channel,
  offline?: boolean,
): Promise<{ checkout: DocsCheckout; index: SearchIndex<DocChunk> }> {
  const checkout = await ensureCreatorDocs({ channel, offline });
  const key = `${checkout.commit}:${INDEX_FORMAT}`;
  let p = indexCache.get(channel);
  if (p) {
    const idx = await p;
    if (idx.key === key) return { checkout, index: idx };
  }
  p = single(`docs-index:${key}`, async () => {
    const path = cacheDir("knowledge", "index", `docs-${channel}`);
    const loaded = await SearchIndex.load<DocChunk>(path, key);
    if (loaded) return loaded;
    progress(`indexing minecraft-creator docs (${channel})`);
    const built = await buildDocsIndex(checkout);
    await built.save(path);
    return built;
  });
  indexCache.set(channel, p);
  p.catch(() => indexCache.delete(channel));
  return { checkout, index: await p };
}

export interface DocsHit {
  title: string;
  heading: string;
  path: string;
  url: string;
  score: number;
  excerpt: string;
}

export interface DocsSearchResult {
  channel: Channel;
  version: string;
  docsVersion: string;
  attribution: string;
  query: string;
  hits: DocsHit[];
}

export async function searchDocs(opts: {
  query: string;
  channel: Channel;
  limit?: number;
  /** Restrict to paths under this prefix, e.g. `creator/ScriptAPI`. */
  pathPrefix?: string;
  offline?: boolean;
}): Promise<DocsSearchResult> {
  const { checkout, index } = await docsIndex(opts.channel, opts.offline);
  const prefix = opts.pathPrefix?.toLowerCase();
  const limit = opts.limit ?? 8;
  const raw = index.search(opts.query, {
    limit: limit * 4,
    filter: prefix ? (d) => d.path.toLowerCase().startsWith(prefix) : undefined,
  });
  // At most two chunks per page so one long page cannot crowd out the rest.
  const perPage = new Map<string, number>();
  const hits = raw
    .filter((h) => {
      const n = perPage.get(h.doc.path) ?? 0;
      perPage.set(h.doc.path, n + 1);
      return n < 2;
    })
    .slice(0, limit);
  return {
    channel: opts.channel,
    version: checkout.version,
    docsVersion: checkout.docsVersion,
    attribution: DOCS_ATTRIBUTION,
    query: opts.query,
    hits: hits.map((h) => ({
      title: h.doc.title,
      heading: h.doc.heading,
      path: h.doc.path,
      url: h.doc.url,
      score: h.score,
      excerpt: excerpt(h.doc.text, opts.query),
    })),
  };
}
