/**
 * The `update` section of `config.json` (`{ "update": { "channel": "release" | "main" | "off" } }`, default `release`).
 * Plain JSON on purpose: the installer runs this before dependencies exist. Other sections are kept as they are.
 */
import { readFile, stat } from "node:fs/promises";
import { writeFileAtomic } from "../core/fs.ts";
import { configDir } from "../core/paths.ts";

/** Where updates come from: release tags, the main branch, or release tags without automatic updates. */
export const UPDATE_CHANNELS = ["release", "main", "off"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return (UPDATE_CHANNELS as readonly unknown[]).includes(value);
}

/** `SCULKWIRE_AUTO_UPDATE=0` turns the automatic check off for one process (a checkout under test, CI). */
export const AUTO_UPDATE_ENV = "SCULKWIRE_AUTO_UPDATE";

export function autoUpdateDisabled(env: NodeJS.ProcessEnv): boolean {
  return env[AUTO_UPDATE_ENV] === "0";
}

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

/** The configured channel. A missing or unreadable file means `release`. */
export async function readChannel(path = configPath()): Promise<UpdateChannel> {
  try {
    const channel = ((await readFileJson(path)).update as { channel?: unknown } | undefined)?.channel;
    return isUpdateChannel(channel) ? channel : "release";
  } catch {
    return "release";
  }
}

/** Save the channel, keeping every other key and, on POSIX, the file's mode. */
export async function saveChannel(channel: UpdateChannel, path = configPath()): Promise<string> {
  const file = await readFileJson(path);
  const update = typeof file.update === "object" && file.update !== null ? (file.update as Record<string, unknown>) : {};
  const next = { ...file, update: { ...update, channel } };
  const mode = await stat(path).then(
    (s) => s.mode & 0o777,
    () => 0o644,
  );
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode });
  return path;
}
