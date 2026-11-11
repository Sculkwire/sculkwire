/**
 * The `update` section of `config.json` (`{ "update": { "channel": "release" | "main" | "off" } }`, default `release`).
 * Plain JSON on purpose: the installer runs this before dependencies exist. Other sections are kept as they are.
 */
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configDir } from "../core/paths.ts";
import { CHANNELS, type Channel } from "./install.ts";

const configPath = (): string => configDir("config.json");

async function readFileJson(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const json: unknown = JSON.parse(text);
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`${path} is not a JSON object`);
  return json as Record<string, unknown>;
}

export function isChannel(value: unknown): value is Channel {
  return (CHANNELS as readonly unknown[]).includes(value);
}

/** The configured channel. A missing or unreadable file means `release`. */
export async function readChannel(path = configPath()): Promise<Channel> {
  try {
    const channel = ((await readFileJson(path)).update as { channel?: unknown } | undefined)?.channel;
    return isChannel(channel) ? channel : "release";
  } catch {
    return "release";
  }
}

/** Save the channel, keeping every other key and, on POSIX, the file's mode. */
export async function saveChannel(channel: Channel, path = configPath()): Promise<string> {
  const file = await readFileJson(path);
  const update = typeof file.update === "object" && file.update !== null ? (file.update as Record<string, unknown>) : {};
  const next = { ...file, update: { ...update, channel } };
  const mode = await stat(path).then(
    (s) => s.mode & 0o777,
    () => 0o644,
  );
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
  return path;
}
