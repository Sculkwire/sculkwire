/** Blobless sparse git checkouts: only the requested paths' blobs are downloaded. */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { installDir, run } from "./net.ts";

export interface SparseCloneOptions {
  url: string;
  /** Branch or tag to clone. */
  ref: string;
  /** Non-cone sparse-checkout patterns (gitignore syntax). */
  patterns: string[];
  /** Full history (needed for `git log`); default is depth 1. */
  history?: boolean;
}

/** Clone into a temp sibling and move it into `target` atomically. Returns the checked-out commit. */
export async function sparseClone(target: string, opts: SparseCloneOptions): Promise<string> {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const tmp = await mkdtemp(join(parent, `.${basename(target)}-`));
  try {
    // core.autocrlf=false: the checkout has the upstream bytes on every OS (Git for Windows defaults to CRLF).
    const args = ["clone", "--quiet", "--filter=blob:none", "--no-checkout", "--config", "core.autocrlf=false", "--branch", opts.ref];
    if (!opts.history) args.push("--depth", "1");
    await run("git", [...args, opts.url, tmp]);
    await setSparse(tmp, opts.patterns);
    await run("git", ["checkout", "--quiet"], tmp);
    const commit = (await run("git", ["rev-parse", "HEAD"], tmp)).stdout.trim();
    await installDir(tmp, target);
    return commit;
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

export async function setSparse(dir: string, patterns: string[]): Promise<void> {
  await run("git", ["sparse-checkout", "set", "--no-cone", ...patterns], dir);
}

/** Fetch `ref` (and history) and check out `commit` (default: the fetched tip). Returns the commit. */
export async function fetchAndCheckout(dir: string, ref: string, commit?: string): Promise<string> {
  await run("git", ["fetch", "--quiet", "--filter=blob:none", "origin", ref], dir);
  const target = commit ?? (await run("git", ["rev-parse", "FETCH_HEAD"], dir)).stdout.trim();
  await run("git", ["checkout", "--quiet", "--detach", target], dir);
  return target;
}

export async function headCommit(dir: string): Promise<string | undefined> {
  try {
    return (await run("git", ["rev-parse", "HEAD"], dir)).stdout.trim();
  } catch {
    return undefined;
  }
}
