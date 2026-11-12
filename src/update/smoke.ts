/** The check a new checkout passes before `current` switches to it: the CLI answers `--help` and the MCP server lists tools. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { AUTO_UPDATE_ENV } from "./config.ts";
import { lastLine, runUnattended } from "./process.ts";

const SMOKE_TIMEOUT_MS = 60_000;

/** Environment for a checkout under test: it must not start its own update. */
const SMOKE_ENV = { [AUTO_UPDATE_ENV]: "0" };

/** `node src/cli.ts --help` exits 0, and `node src/cli.ts mcp` answers `tools/list` with at least one tool. */
export async function smokeCheck(dir: string): Promise<void> {
  const cli = join(dir, "src", "cli.ts");
  const help = await runUnattended(process.execPath, [cli, "--help"], { cwd: dir, timeoutMs: SMOKE_TIMEOUT_MS, env: SMOKE_ENV });
  if (help.code !== 0 || !help.stdout.includes("Usage")) throw new Error(`smoke check: \`sculk --help\` failed: ${lastLine(help.stderr) || `exit ${help.code}`}`);
  const count = await mcpToolCount(cli, dir);
  if (count < 1) throw new Error("smoke check: the MCP server listed no tools");
}

/**
 * Start `cli.ts mcp`, initialize, list tools and stop it. A hand-written JSON-RPC client: the check runs before the
 * new checkout's dependencies are trusted, so the SDK is not imported.
 */
function mcpToolCount(cli: string, cwd: string, timeoutMs = SMOKE_TIMEOUT_MS): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const child = spawn(process.execPath, [cli, "mcp"], { cwd, env: { ...process.env, ...SMOKE_ENV }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buffer = "";
  let stderr = "";
  let done = false;
  let exited = false;
  // Settle only after the child has exited: on Windows a live child keeps its cwd (the staging folder) locked,
  // so renaming or removing it right after the check fails with EBUSY.
  const finish = (err: Error | undefined, count?: number) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    const settle = () => (err ? reject(err) : resolve(count ?? 0));
    if (exited) return settle();
    const cap = setTimeout(settle, 5_000);
    child.once("close", () => {
      clearTimeout(cap);
      settle();
    });
    child.stdin.end();
    child.kill();
  };
  const timer = setTimeout(() => finish(new Error(`smoke check: MCP tools/list did not answer within ${timeoutMs / 1000} s`)), timeoutMs);
  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  child.stdin.on("error", () => {});
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  child.stdout.on("data", (c: Buffer) => {
    buffer += c.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: { tools?: unknown[] }; error?: { message?: string } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue;
      }
      if (msg.error) return finish(new Error(`smoke check: MCP error ${msg.error.message ?? ""}`));
      if (msg.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      } else if (msg.id === 2) return finish(undefined, msg.result?.tools?.length ?? 0);
    }
  });
  child.on("error", (err) => {
    exited = true;
    finish(err);
  });
  child.on("close", (code) => {
    exited = true;
    finish(new Error(`smoke check: MCP server exited (${code}) before tools/list: ${lastLine(stderr)}`));
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sculk-update", version: "0" } } });
  return promise;
}
