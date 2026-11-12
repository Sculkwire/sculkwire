/** File helpers every feature shares: atomic writes and tolerant reads. */
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write via a sibling temp file and rename, so concurrent readers never see a partial file. `mode` sets the file's
 * POSIX permissions (independent of the umask).
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array, options: { mode?: number } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, options.mode === undefined ? {} : { mode: options.mode });
  if (options.mode !== undefined) await chmod(tmp, options.mode);
  await rename(tmp, path);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The parsed JSON in `path`, or undefined when the file is missing or not valid JSON. */
export async function readJsonOr<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Whether `path` exists (a file, a directory or anything else the process can see). */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
