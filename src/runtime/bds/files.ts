/** File names BDS and sculkwire use inside an install or an instance directory. */
import type { BdsPlatform } from "./install.ts";

/** sculkwire's record of a finished install (channel, version, download URL). */
export const INSTALL_MARKER = ".sculkwire-bds.json";
/** Everything the server printed, written by `BdsServer`. */
export const CONSOLE_LOG = "console.log";
/** GameTest automation settings the server reads at start. */
export const TEST_CONFIG = "test_config.json";
/** Where the server writes content logs and GameTest results. */
export const LOGS_DIR = "logs";

/** Server executable inside an install for a BDS platform. */
export function serverExecutable(platform: BdsPlatform): string {
  return platform === "windows" ? "bedrock_server.exe" : "bedrock_server";
}
