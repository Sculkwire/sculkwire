/** A stand-in `rgl` for tests: a node script that runs on Linux and Windows. */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes `script` (a node script with a `#!/usr/bin/env node` line) into `dir` as an rgl that can be started, and
 * returns its path. Windows cannot exec a shebang script: there a `.cmd` shim runs it with node (rgl's runner
 * starts a `.cmd` through cmd.exe).
 */
export function writeFakeRgl(dir: string, script: string): string {
  if (process.platform === "win32") {
    writeFileSync(join(dir, "rgl.js"), script);
    const shim = join(dir, "rgl.cmd");
    writeFileSync(shim, `@"${process.execPath}" "%~dp0rgl.js" %*\r\n`);
    return shim;
  }
  const rgl = join(dir, "rgl");
  writeFileSync(rgl, script);
  chmodSync(rgl, 0o755);
  return rgl;
}
