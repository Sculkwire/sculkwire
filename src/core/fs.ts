/** File helpers every feature shares: atomic writes and tolerant reads. */
import { access, chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

/**
 * Whether two folders hold the same files with the same bytes (names and nesting equal, links followed). False when
 * either cannot be read. Sizes are compared before any content is read, so folders that differ are usually told
 * apart without reading a file.
 */
export async function sameFiles(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([readdir(a), readdir(b)]);
    if (left.length !== right.length) return false;
    left.sort();
    right.sort();
    const files: string[] = [];
    for (const [i, name] of left.entries()) {
      if (name !== right[i]) return false;
      const [x, y] = await Promise.all([stat(join(a, name)), stat(join(b, name))]);
      if (x.isDirectory() !== y.isDirectory()) return false;
      if (x.isDirectory()) {
        if (!(await sameFiles(join(a, name), join(b, name)))) return false;
      } else {
        if (x.size !== y.size) return false;
        files.push(name);
      }
    }
    for (const name of files) {
      const [x, y] = await Promise.all([readFile(join(a, name)), readFile(join(b, name))]);
      if (!x.equals(y)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
