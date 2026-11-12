/**
 * Following an upstream. Every source (version pins, bedrock-samples, typings, docs, changelogs, rockide/schemas)
 * checks its upstream at most once a day, keeps answering from its previous copy while a check or download fails,
 * retries a failed check after an hour (per process) and logs one line per failure: `Backoff` holds that rule.
 *
 * `ensureTracked` is the generic cache on top of it: one directory per release under `dir()` plus `current.json`
 * naming the copy in use. A new release is downloaded into a temp directory, checked, then switched to. Offline, a
 * failed check or a failed download keeps the previous copy. Used by rockide/schemas.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../core/errors.ts";
import { writeJsonAtomic } from "../core/fs.ts";
import { installDir, OfflineMissingError, progress, single } from "./net.ts";

/** How often an upstream is asked for its newest release. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After a failed check, the cached copy is used without retrying for this long (per process). */
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

export interface Release {
  /** Release name (tag or package version); also the directory name of its copy. */
  version: string;
}

/** Network side, injectable for tests. */
export interface ReleaseFetcher<R extends Release> {
  /** The newest upstream release (cheap metadata request). */
  latest(): Promise<R>;
  /** Unpack `release` into the empty directory `dest`. */
  download(release: R, dest: string): Promise<void>;
}

export interface TrackedCopy<R extends Release> {
  root: string;
  release: R;
  /** When this copy was downloaded. */
  fetchedAt: string;
  /** When the upstream was last asked for its newest release. */
  checkedAt: string;
  /** Newest release seen upstream (differs from `release.version` while a download keeps failing). */
  latest: string;
  /** Set when the check or download failed and the cached copy is used. */
  stale?: string;
}

export interface TrackedSpec<R extends Release> {
  /** Key for in-process de-duplication and the failure back-off. */
  key: string;
  /** Human name in progress lines and errors. */
  name: string;
  dir(): string;
  /** A downloaded copy has everything consumers need. */
  complete(root: string): boolean;
  /** Read a marker from an older cache layout; undefined when it is not one. */
  legacy?(raw: Record<string, unknown>): Marker<R> | undefined;
}

export interface TrackedOptions<R extends Release> {
  /** Cache only; never contact the upstream. */
  offline?: boolean;
  /** Check now, even when the last check is less than a day old. */
  refresh?: boolean;
  /** Clock and network, for tests. */
  now?: number;
  fetcher?: ReleaseFetcher<R>;
}

export interface Marker<R extends Release> {
  release: R;
  /** Directory name of the copy under `dir()`. */
  dir: string;
  fetchedAt: string;
  checkedAt: string;
  latest?: string;
  /** Last failed download of `latest`. */
  error?: string;
}

/**
 * Per-process failure back-off and in-flight checks, keyed per source (`pins`, `docs:stable`, `samples:<tag>`, ...).
 * A failed check is not retried for `RETRY_AFTER_FAILURE_MS`; at most one background check per key runs at a time.
 */
class Backoff {
  readonly #failures = new Map<string, number>();
  readonly #running = new Map<string, Promise<void>>();

  /** No check of `key` failed within the retry interval. */
  ready(key: string, now = Date.now()): boolean {
    return now - (this.#failures.get(key) ?? 0) >= RETRY_AFTER_FAILURE_MS;
  }

  failed(key: string, now = Date.now()): void {
    this.#failures.set(key, now);
  }

  /** Forget the failures (all keys without `key`). */
  reset(key?: string): void {
    if (key) this.#failures.delete(key);
    else this.#failures.clear();
  }

  /** The background check of `key` in flight, if any. */
  running(key: string): Promise<void> | undefined {
    return this.#running.get(key);
  }

  /**
   * Run `check` in the background unless one for `key` is running or failed recently. A rejection is remembered (at
   * `now`, default the time it failed) and logged as the one line `failure(reason)`.
   */
  background(key: string, check: () => Promise<unknown>, failure: (reason: string) => string, now?: number): void {
    if (this.#running.has(key) || !this.ready(key, now)) return;
    const run = check()
      .then(
        () => undefined,
        (err: unknown) => {
          this.failed(key, now);
          progress(failure(errorMessage(err)));
        },
      )
      .finally(() => this.#running.delete(key));
    this.#running.set(key, run);
  }
}

/** The back-off every knowledge source shares. */
export const upstreamBackoff = new Backoff();

/** Release names double as directory names. */
const SAFE_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

const markerPath = (spec: TrackedSpec<Release>): string => join(spec.dir(), "current.json");

/** The marker of the copy in use, when that copy is complete. */
export async function readTracked<R extends Release>(spec: TrackedSpec<R>): Promise<Marker<R> | undefined> {
  try {
    const raw = JSON.parse(await readFile(markerPath(spec), "utf8")) as Record<string, unknown>;
    const m = typeof raw.dir === "string" && raw.release ? (raw as unknown as Marker<R>) : spec.legacy?.(raw);
    return m && SAFE_NAME.test(m.dir) && spec.complete(join(spec.dir(), m.dir)) ? m : undefined;
  } catch {
    return undefined;
  }
}

function copyOf<R extends Release>(spec: TrackedSpec<R>, m: Marker<R>): TrackedCopy<R> {
  return { root: join(spec.dir(), m.dir), release: m.release, fetchedAt: m.fetchedAt, checkedAt: m.checkedAt, latest: m.latest ?? m.release.version };
}

/** Remove copies other than `keep` (the current and the previous one, which another process may still read). */
async function prune(spec: TrackedSpec<Release>, keep: string[]): Promise<void> {
  for (const e of await readdir(spec.dir(), { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && !e.name.startsWith(".") && !keep.includes(e.name)) await rm(join(spec.dir(), e.name), { recursive: true, force: true });
  }
}

/**
 * The cached copy, downloading or switching to the newest release when a check is due. Throws only when no copy
 * exists and one cannot be fetched; a failed update falls back to the cached copy (`stale`).
 */
export function ensureTracked<R extends Release>(spec: TrackedSpec<R>, defaultFetcher: ReleaseFetcher<R>, opts: TrackedOptions<R> = {}): Promise<TrackedCopy<R>> {
  return single(spec.key, async () => {
    const now = opts.now ?? Date.now();
    const have = await readTracked(spec);
    if (have) {
      const due = opts.refresh || !(now - Date.parse(have.checkedAt) < CHECK_INTERVAL_MS);
      if (opts.offline || !due) return copyOf(spec, have);
      if (!opts.refresh && !upstreamBackoff.ready(spec.key, now)) {
        return { ...copyOf(spec, have), stale: have.error ?? "last update check failed" };
      }
    } else if (opts.offline) {
      throw new OfflineMissingError(spec.name);
    }
    const fetcher = opts.fetcher ?? defaultFetcher;
    let latest: R | undefined;
    try {
      latest = await fetcher.latest();
      if (!SAFE_NAME.test(latest.version)) throw new Error(`${spec.name}: unexpected release name ${JSON.stringify(latest.version)}`);
      const name = latest.version;
      const target = join(spec.dir(), name);
      const stamp = new Date(now).toISOString();
      if (!spec.complete(target)) {
        progress(`downloading ${spec.name} ${name}`);
        await mkdir(spec.dir(), { recursive: true });
        const tmp = await mkdtemp(join(spec.dir(), `.${name}-`));
        try {
          await fetcher.download(latest, tmp);
          if (!spec.complete(tmp)) throw new Error(`${spec.name} ${name} is incomplete after download`);
          if (existsSync(target)) await rm(target, { recursive: true, force: true });
          await installDir(tmp, target);
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      }
      const marker: Marker<R> = {
        release: latest,
        dir: name,
        fetchedAt: have?.dir === name ? have.fetchedAt : stamp,
        checkedAt: stamp,
        latest: name,
      };
      await writeJsonAtomic(markerPath(spec), marker);
      await prune(spec, have && have.dir !== name ? [name, have.dir] : [name]);
      return copyOf(spec, marker);
    } catch (err) {
      upstreamBackoff.failed(spec.key, now);
      if (!have) throw err;
      const reason = errorMessage(err);
      progress(`${spec.name} update failed (${reason}); using ${have.release.version}`);
      // Remember the release seen upstream; `checkedAt` stays so the next process retries.
      if (latest && latest.version !== have.release.version) {
        await writeJsonAtomic(markerPath(spec), { ...have, latest: latest.version, error: reason } satisfies Marker<R>).catch(() => undefined);
        return { ...copyOf(spec, have), latest: latest.version, stale: reason };
      }
      return { ...copyOf(spec, have), stale: reason };
    }
  });
}
