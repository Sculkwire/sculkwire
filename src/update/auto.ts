/**
 * Version report (`sculkwire_version`, `sculk doctor`) and the automatic update a managed MCP server starts in the
 * background: at most once per 24 h, never awaited by startup or a tool call, silent apart from one stderr line.
 * The running server keeps its version; the next session starts the new one through the launcher.
 */
import { errorMessage } from "../core/errors.ts";
import { VERSION } from "../core/meta.ts";
import { autoUpdateDisabled, readChannel, type UpdateChannel } from "./config.ts";
import { type Hooks, update, type UpdateResult } from "./install.ts";
import { detectRunning, readCurrent, type Running } from "./layout.ts";
import { dueForCheck, readState } from "./state.ts";

export interface VersionInfo {
  /** package.json version of the running code. */
  version: string;
  channel: UpdateChannel;
  /** Runs from a managed install (`sculk update` applies), not a development checkout. */
  managed: boolean;
  /** Checkout the running code belongs to. */
  root: string;
  /** Managed only: the version directory this process runs. */
  running?: string;
  /** Managed only: the version new sessions start. */
  current?: string;
  /** Newest version seen at the last check. */
  latest?: string;
  /** A newer version is installed and starts with the next session. */
  updateReady?: boolean;
  lastCheck?: string;
  lastError?: string;
}

export async function versionInfo(running: Running = detectRunning()): Promise<VersionInfo> {
  const info: VersionInfo = { version: VERSION, channel: await readChannel(), managed: running.managed !== undefined, root: running.root };
  if (!running.managed) return info;
  const { layout: l, version } = running.managed;
  const state = await readState(l);
  const current = await readCurrent(l);
  return {
    ...info,
    running: version,
    current,
    latest: state.latest,
    updateReady: current !== undefined && current !== version,
    lastCheck: state.lastCheck ? new Date(state.lastCheck).toISOString() : undefined,
    lastError: state.lastError,
  };
}

/** One line for humans, used by `sculk doctor` and the tool's text. */
export function describeVersion(v: VersionInfo): string {
  if (!v.managed) return `sculkwire ${v.version}, development checkout ${v.root} (update with git pull)`;
  const parts = [`sculkwire ${v.version} (${v.running}), channel ${v.channel}`];
  if (v.updateReady) parts.push(`${v.current} is installed, restart the MCP session to use it`);
  else if (v.latest && v.latest !== v.current) parts.push(`${v.latest} is available, run \`sculk update\``);
  if (v.lastCheck) parts.push(`last checked ${v.lastCheck}`);
  if (v.lastError) parts.push(`last check failed: ${v.lastError}`);
  return parts.join(", ");
}

export interface AutoUpdateOptions {
  running?: Running;
  now?: number;
  hooks?: Hooks;
  /** Told about an applied update (the MCP server sends it as a logging message). */
  notify?: (message: string) => unknown;
  /** One line per failure or applied update. Default: stderr. */
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * Check and apply an update for a managed install when one is due. Never throws: a failure (offline, missing
 * credentials for a repository that needs them, a broken release) logs one line and leaves the current version in place.
 */
export async function autoUpdate(options: AutoUpdateOptions = {}): Promise<UpdateResult | undefined> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const running = options.running ?? detectRunning();
    if (!running.managed) return undefined;
    const l = running.managed.layout;
    if (autoUpdateDisabled(options.env ?? process.env)) return undefined;
    const channel = await readChannel();
    if (channel === "off") return undefined;
    const now = options.now ?? Date.now();
    if (!dueForCheck(await readState(l), now)) return undefined;
    const result = await update(l, { channel, now, hooks: { log: () => {}, ...options.hooks } });
    if (result.action === "updated") {
      const message = `sculkwire ${result.current} installed, restart the session to use it`;
      log(`sculkwire: ${message}`);
      try {
        await options.notify?.(message);
      } catch {
        // The client may not accept logging messages.
      }
    }
    return result;
  } catch (err) {
    log(`sculkwire: automatic update check failed: ${errorMessage(err)}`);
    return undefined;
  }
}
