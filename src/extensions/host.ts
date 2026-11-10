/**
 * The values sculkwire hands to an extension's `activate(host)`. An extension uses these at runtime instead of
 * importing sculkwire's modules by path, so the process holds one copy of every module (one zod, one input-provider
 * registry). Types may still be imported with `import type`.
 */
import { z } from "zod";
import { ExitCode } from "../core/diagnostic.ts";
import { cacheDir } from "../core/paths.ts";
import { findOnPath } from "../core/which.ts";
import { detectBuilds, gameDirCandidates, noBuildMessage, selectBuild } from "../gamefiles/detect.ts";
import { registerInputProvider } from "../runtime/client/inputprovider.ts";
import { findInstall, installerRoot } from "../runtime/client/install.ts";
import { winePrefix } from "../runtime/client/launcher.ts";

export type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ExtensionHost {
  /** zod, for tool input and output schemas. */
  z: typeof z;
  /** Process exit codes for CLI commands. */
  ExitCode: typeof ExitCode;
  /** sculkwire's cache directory (`cacheDir("my-feature", ...)`). */
  cacheDir: typeof cacheDir;
  /** The first executable called `name` on PATH (PATHEXT-aware on Windows). */
  findOnPath: typeof findOnPath;
  /** The game client install sculkwire uses, and the mcbe-gdk-installer root and Wine prefix helpers. */
  findInstall: typeof findInstall;
  installerRoot: typeof installerRoot;
  winePrefix: typeof winePrefix;
  /** Install the in-process input provider (`src/runtime/client/inputprovider.ts`). */
  registerInputProvider: typeof registerInputProvider;
  /** Installed PC (GDK) game builds (`src/gamefiles/detect.ts`). */
  gamefiles: {
    gameDirCandidates: typeof gameDirCandidates;
    detectBuilds: typeof detectBuilds;
    selectBuild: typeof selectBuild;
    noBuildMessage: typeof noBuildMessage;
  };
}

export function extensionHost(): ExtensionHost {
  return {
    z,
    ExitCode,
    cacheDir,
    findOnPath,
    findInstall,
    installerRoot,
    winePrefix,
    registerInputProvider,
    gamefiles: { gameDirCandidates, detectBuilds, selectBuild, noBuildMessage },
  };
}
