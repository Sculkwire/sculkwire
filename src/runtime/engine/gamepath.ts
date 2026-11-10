import { posix, win32 } from "node:path";

/**
 * The path a Windows process of the game (the agent, the injector) uses for a host path: the
 * native path on Windows, and Wine's `Z:` drive mapping (`/a/b` → `Z:\a\b`) on Linux. Every path handed to such a
 * process goes through here; the files it writes are read back through the host path.
 */
export function gamePath(hostPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return win32.resolve(hostPath);
  return `Z:${posix.resolve(hostPath).split("/").join("\\")}`;
}
