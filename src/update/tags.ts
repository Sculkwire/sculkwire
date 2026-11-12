/** Release tags and the main branch of the repository: what a channel installs, and whether it is newer. */
import type { UpdateChannel } from "./config.ts";
import { git } from "./process.ts";

/** Timeout of one `git ls-remote`. */
export const LS_REMOTE_TIMEOUT_MS = 20_000;

interface ParsedTag {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

function parseTag(tag: string): ParsedTag | undefined {
  const m = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

/** Semver precedence of two `vX.Y.Z[-pre]` tags. Unparseable tags sort first. */
export function compareTags(a: string, b: string): number {
  const pa = parseTag(a);
  const pb = parseTag(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (const k of ["major", "minor", "patch"] as const) if (pa[k] !== pb[k]) return pa[k] - pb[k];
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Newest release tag; prereleases (`v1.0.0-rc.1`) only when asked. */
export function newestTag(tags: readonly string[], options: { prerelease?: boolean } = {}): string | undefined {
  const usable = tags.filter((t) => {
    const p = parseTag(t);
    return p !== undefined && (options.prerelease || p.pre.length === 0);
  });
  return usable.sort(compareTags).at(-1);
}

/** What a channel installs: a tag, or the head of main. `version` is the version directory name. */
export interface Target {
  version: string;
  ref: string;
}

/** Whether `target` should replace the `current` version on `channel`. */
export function isNewer(current: string | undefined, target: Target, channel: UpdateChannel): boolean {
  if (!current) return true;
  if (current === target.version) return false;
  if (channel === "main") return true;
  // A release replaces a main checkout (channel switched back) or an older release, never a newer one.
  return !parseTag(current) || compareTags(target.version, current) > 0;
}

export function mainVersion(sha: string): string {
  return `main-${sha.slice(0, 12)}`;
}

async function remoteTags(repo: string, timeoutMs: number): Promise<string[]> {
  const out = await git(["ls-remote", "--tags", "--refs", repo], { timeoutMs });
  return out
    .split("\n")
    .map((line) => /\trefs\/tags\/(.+)$/.exec(line.trim())?.[1])
    .filter((t): t is string => t !== undefined);
}

async function remoteHead(repo: string, branch: string, timeoutMs: number): Promise<string> {
  const out = await git(["ls-remote", repo, `refs/heads/${branch}`], { timeoutMs });
  const sha = out.split("\t")[0]?.trim();
  if (!sha) throw new Error(`${repo} has no branch ${branch}`);
  return sha;
}

/** The newest version on a channel (`off` resolves like `release`), or undefined when there is no release yet. */
export async function latestTarget(repo: string, channel: UpdateChannel, timeoutMs = LS_REMOTE_TIMEOUT_MS): Promise<Target | undefined> {
  if (channel === "main") return { version: mainVersion(await remoteHead(repo, "main", timeoutMs)), ref: "main" };
  const tag = newestTag(await remoteTags(repo, timeoutMs));
  return tag ? { version: tag, ref: tag } : undefined;
}
