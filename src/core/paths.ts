import { homedir } from "node:os";
import { join } from "node:path";

/** Per-OS base directories: XDG on Linux, Library on macOS, %LOCALAPPDATA% on Windows. */
function baseDir(kind: "cache" | "data"): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  }
  if (process.platform === "darwin") {
    return kind === "cache" ? join(homedir(), "Library", "Caches") : join(homedir(), "Library", "Application Support");
  }
  return kind === "cache"
    ? (process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"))
    : (process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
}

/** Downloaded, re-creatable data (upstream checkouts, npm tarballs, BDS builds). Override: SCULKWIRE_CACHE. */
export function cacheDir(...parts: string[]): string {
  const base = process.env.SCULKWIRE_CACHE ?? (process.platform === "win32" ? join(baseDir("cache"), "sculkwire", "cache") : join(baseDir("cache"), "sculkwire"));
  return join(base, ...parts);
}

/** Durable local state (instances, worlds, run records). Override: SCULKWIRE_DATA. */
export function dataDir(...parts: string[]): string {
  const base = process.env.SCULKWIRE_DATA ?? (process.platform === "win32" ? join(baseDir("data"), "sculkwire", "data") : join(baseDir("data"), "sculkwire"));
  return join(base, ...parts);
}

/**
 * User settings (`config.json`). `$XDG_CONFIG_HOME/sculkwire` (default `~/.config/sculkwire`) on Linux and macOS,
 * `%APPDATA%\sculkwire` on Windows. Override: SCULKWIRE_CONFIG.
 */
export function configDir(...parts: string[]): string {
  const base =
    process.env.SCULKWIRE_CONFIG ??
    (process.platform === "win32"
      ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "sculkwire")
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sculkwire"));
  return join(base, ...parts);
}
