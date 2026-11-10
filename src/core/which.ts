import { accessSync, constants } from "node:fs";
import { extname, join } from "node:path";

/**
 * The first executable called `name` on PATH. On Windows a name without an extension is tried with every PATHEXT
 * extension, the way cmd.exe resolves it. `platform` selects those rules (separator, PATHEXT, execute bit); the
 * candidates are files on this machine, so they are joined with this machine's path rules.
 */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const win = platform === "win32";
  // Windows variable names are case-insensitive in process.env but not in a plain object.
  const get = (key: string): string | undefined =>
    env[key] ?? (win ? env[Object.keys(env).find((k) => k.toUpperCase() === key) ?? ""] : undefined);
  const exts = win && !extname(name) ? (get("PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of (get("PATH") ?? "").split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        // Windows has no execute bit: a PATHEXT match that exists is runnable.
        accessSync(candidate, win ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}
