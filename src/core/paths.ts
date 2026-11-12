import { homedir } from "node:os";
import { join } from "node:path";

/** An `XDG_*` base directory: the variable when set, else `<home>/<fallback>`. An empty value counts as unset (XDG spec). */
function xdg(name: string, fallback: readonly string[], env: NodeJS.ProcessEnv, home: string): string {
  return env[name] || join(home, ...fallback);
}

/** `$XDG_DATA_HOME`, default `~/.local/share`. */
export function xdgDataHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return xdg("XDG_DATA_HOME", [".local", "share"], env, home);
}

/** Windows `%APPDATA%` (default `~\AppData\Roaming`). */
export function roamingDir(): string {
  return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
}

/** Per-OS base directories: XDG on Linux, Library on macOS, %LOCALAPPDATA% on Windows. */
function baseDir(kind: "cache" | "data"): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  }
  if (process.platform === "darwin") {
    return kind === "cache" ? join(homedir(), "Library", "Caches") : join(homedir(), "Library", "Application Support");
  }
  return kind === "cache" ? xdg("XDG_CACHE_HOME", [".cache"], process.env, homedir()) : xdgDataHome();
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
    (process.platform === "win32" ? join(roamingDir(), "sculkwire") : join(xdg("XDG_CONFIG_HOME", [".config"], process.env, homedir()), "sculkwire"));
  return join(base, ...parts);
}
