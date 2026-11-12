/** Facts about a PC (GDK) install on disk that every reader of the game folder shares. */
import { join } from "node:path";
import { xdgDataHome } from "../core/paths.ts";

/** The game executable in every GDK game folder. */
export const GAME_EXE = "Minecraft.Windows.exe";

/** mcbe-gdk-installer's root on Linux: `SCULKWIRE_GDK_ROOT`, else `$XDG_DATA_HOME/mcbe-gdk-linux`. */
export function installerRoot(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  return env.SCULKWIRE_GDK_ROOT ?? join(xdgDataHome(env, home), "mcbe-gdk-linux");
}
