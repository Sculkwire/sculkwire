/**
 * options.txt (`key:value` per line). The bridge sets only the keys it needs and remembers their previous
 * values in a restore record, so `restore` puts back exactly those keys even after the game rewrote the file.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { dataDir } from "../core/paths.ts";

export type Options = Map<string, string>;

export function parseOptions(text: string): Options {
  const out: Options = new Map();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    out.set(line.slice(0, i), line.slice(i + 1));
  }
  return out;
}

/**
 * The lines of `text` and how to join them back: its line ending (CRLF when the game wrote one, as on Windows) and
 * whether it ends with one, so a rewrite keeps the file's own format.
 */
function lines(text: string): { lines: string[]; join: (lines: string[]) => string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const final = text === "" || text.endsWith("\n");
  const out = text.split(/\r?\n/);
  if (out.at(-1) === "") out.pop();
  return { lines: out, join: (l) => (l.length ? `${l.join(eol)}${final ? eol : ""}` : "") };
}

/** Replace values in place (keeping line order, unknown lines and line endings); append keys that are missing. */
export function applyOptions(text: string, values: Readonly<Record<string, string>>): string {
  const pending = new Map(Object.entries(values));
  const file = lines(text);
  const out = file.lines.map((line) => {
    const i = line.indexOf(":");
    if (i <= 0) return line;
    const key = line.slice(0, i);
    const v = pending.get(key);
    if (v === undefined) return line;
    pending.delete(key);
    return `${key}:${v}`;
  });
  for (const [k, v] of pending) out.push(`${k}:${v}`);
  return file.join(out);
}

/** Remove keys entirely (used to undo keys we appended), keeping line endings. */
export function removeOptions(text: string, keys: readonly string[]): string {
  const drop = new Set(keys);
  const file = lines(text);
  return file.join(
    file.lines.filter((line) => {
      const i = line.indexOf(":");
      return i <= 0 || !drop.has(line.slice(0, i));
    }),
  );
}

/** Keys the bridge needs: debugger auto-attach to our listener, /connect allowed without encryption, content log file on. */
export function bridgeOptions(debuggerPort: number): Record<string, string> {
  return {
    script_debugger_auto_attach: "1",
    script_debugger_attach_mode: "1",
    script_debugger_host: "localhost",
    script_debugger_port: String(debuggerPort),
    script_debugger_auto_attach_timeout: "5",
    script_debugger_passcode_required: "0",
    websockets_enabled: "1",
    websocket_encryption: "0",
    content_log_file: "1",
  };
}

interface RestoreRecord {
  /** file → key → previous value (null: key was absent). */
  files: Record<string, Record<string, string | null>>;
}

const restorePath = () => dataDir("client", "options-restore.json");

async function readRecord(): Promise<RestoreRecord> {
  try {
    const parsed: unknown = JSON.parse(await readFile(restorePath(), "utf8"));
    if (parsed && typeof parsed === "object" && "files" in parsed && parsed.files && typeof parsed.files === "object") {
      const files: RestoreRecord["files"] = {};
      for (const [file, keys] of Object.entries(parsed.files)) {
        if (!keys || typeof keys !== "object") continue;
        const k: Record<string, string | null> = {};
        for (const [key, v] of Object.entries(keys)) if (typeof v === "string" || v === null) k[key] = v;
        files[file] = k;
      }
      return { files };
    }
  } catch {
    // no record
  }
  return { files: {} };
}

/**
 * Set `values` in each options file. The first change of a key records its original value; later changes keep that
 * original, so a crash between launches never loses the user's setting. Copies each file to `<file>.sculkwire-backup`
 * once as an extra safety net.
 */
export async function setOptions(files: readonly string[], values: Readonly<Record<string, string>>): Promise<void> {
  const record = await readRecord();
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = await readFile(file, "utf8");
    const backup = `${file}.sculkwire-backup`;
    if (!existsSync(backup)) await writeFile(backup, text);
    const current = parseOptions(text);
    const saved = (record.files[file] ??= {});
    for (const key of Object.keys(values)) if (!(key in saved)) saved[key] = current.get(key) ?? null;
    await writeFile(file, applyOptions(text, values));
  }
  await mkdir(dirname(restorePath()), { recursive: true });
  await writeFile(restorePath(), `${JSON.stringify(record, null, 2)}\n`);
}

/** Put back every key `setOptions` changed. Returns the restored keys per file. Call after the game has exited. */
export async function restoreOptions(): Promise<Record<string, string[]>> {
  const record = await readRecord();
  const restored: Record<string, string[]> = {};
  for (const [file, keys] of Object.entries(record.files)) {
    if (!existsSync(file)) continue;
    let text = await readFile(file, "utf8");
    const set: Record<string, string> = {};
    const absent: string[] = [];
    for (const [k, v] of Object.entries(keys)) {
      if (v === null) absent.push(k);
      else set[k] = v;
    }
    text = removeOptions(applyOptions(text, set), absent);
    await writeFile(file, text);
    restored[file] = Object.keys(keys);
  }
  await rm(restorePath(), { force: true });
  return restored;
}

export async function hasPendingRestore(): Promise<boolean> {
  return Object.keys((await readRecord()).files).length > 0;
}
