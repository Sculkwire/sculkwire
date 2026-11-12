/**
 * MCP client registration for `sculk setup --register`. A managed install registers its stable launcher, so updates
 * never change a client config; a development checkout registers `node <checkout>/src/cli.ts mcp`.
 * Only the `sculkwire` entry is added or replaced; other servers are never touched.
 */
import { copyFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../core/fs.ts";
import { findOnPath } from "../core/which.ts";
import { detectRunning, platformLauncher, type Running } from "../update/layout.ts";
import { runUnattended } from "../update/process.ts";

export interface ServerEntry {
  type: "stdio";
  command: string;
  args: string[];
}

export function serverEntry(running: Running = detectRunning()): ServerEntry {
  if (!running.managed) return { type: "stdio", command: "node", args: [join(running.root, "src", "cli.ts"), "mcp"] };
  const launcher = platformLauncher(running.managed.layout);
  // Most MCP clients spawn without a shell, and a .cmd file only runs through cmd.exe.
  if (process.platform === "win32") return { type: "stdio", command: "cmd", args: ["/c", launcher, "mcp"] };
  return { type: "stdio", command: launcher, args: ["mcp"] };
}

export function snippet(entry: ServerEntry): string {
  return JSON.stringify({ mcpServers: { sculkwire: entry } }, null, 2);
}

function ompConfigPath(): string {
  return join(homedir(), ".omp", "agent", "mcp.json");
}

/**
 * Add or replace `mcpServers.sculkwire` in omp's config. An existing file is copied to `<file>.bak` first and must be
 * valid JSON (an invalid file is left alone).
 */
export async function registerOmp(entry: ServerEntry, path: string = ompConfigPath()): Promise<{ path: string; backup?: string }> {
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let config: Record<string, unknown> = {};
  if (text !== undefined && text.trim()) {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object, left unchanged`);
    config = parsed as Record<string, unknown>;
  }
  let backup: string | undefined;
  if (text !== undefined) {
    backup = `${path}.bak`;
    await copyFile(path, backup);
  }
  const servers = typeof config.mcpServers === "object" && config.mcpServers !== null ? (config.mcpServers as Record<string, unknown>) : {};
  await writeJsonAtomic(path, { ...config, mcpServers: { ...servers, sculkwire: entry } });
  return backup ? { path, backup } : { path };
}

/** `claude mcp add --scope user sculkwire -- <command> <args>`, replacing an earlier registration. */
async function registerClaude(entry: ServerEntry, claude: string): Promise<void> {
  await runUnattended(claude, ["mcp", "remove", "--scope", "user", "sculkwire"], { timeoutMs: 30_000 }).catch(() => undefined);
  const r = await runUnattended(claude, ["mcp", "add", "--scope", "user", "sculkwire", "--", entry.command, ...entry.args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`claude mcp add failed: ${(r.stderr || r.stdout).trim().split("\n").at(-1) ?? `exit ${r.code}`}`);
}

/** An MCP client sculkwire registers itself with. `register` returns the line `sculk setup` prints on stderr. */
export interface McpClient {
  name: string;
  /** Worth offering in the setup prompt. */
  detect(): boolean;
  register(entry: ServerEntry): Promise<string>;
}

export const CLIENTS: readonly McpClient[] = [
  {
    name: "omp",
    detect: () => existsSync(join(homedir(), ".omp")),
    async register(entry) {
      const r = await registerOmp(entry);
      return `Registered sculkwire in ${r.path}${r.backup ? ` (previous file kept as ${r.backup})` : ""}`;
    },
  },
  {
    name: "claude",
    detect: () => findOnPath("claude") !== undefined,
    async register(entry) {
      const claude = findOnPath("claude");
      if (!claude) return "The claude CLI is not on PATH, add the JSON below to Claude Code by hand";
      await registerClaude(entry, claude);
      return "Registered sculkwire with Claude Code (user scope)";
    },
  },
];

/** Parse `omp,claude`. Returns an error message for an unknown client. */
export function parseClients(value: string): McpClient[] | string {
  const out: McpClient[] = [];
  for (const raw of value.split(",").map((s) => s.trim().toLowerCase())) {
    if (!raw || raw === "none") continue;
    const client = CLIENTS.find((c) => c.name === raw);
    if (!client) return `unknown client ${raw} (choose from ${CLIENTS.map((c) => c.name).join(", ")})`;
    if (!out.includes(client)) out.push(client);
  }
  return out;
}
