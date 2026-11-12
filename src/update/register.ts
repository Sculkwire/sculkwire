/**
 * MCP client registration for `sculk setup --register`. A managed install registers its stable launcher, so updates
 * never change a client config; a development checkout registers `node <checkout>/src/cli.ts mcp`.
 * Only the `sculkwire` entry is added or replaced; other servers are never touched.
 */
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { detectRunning, platformLauncher, runUnattended, type Running } from "./install.ts";

export const CLIENTS = ["omp", "claude"] as const;
export type Client = (typeof CLIENTS)[number];

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

export function ompConfigPath(): string {
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
  const next = { ...config, mcpServers: { ...servers, sculkwire: entry } };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, path);
  return backup ? { path, backup } : { path };
}

/** `claude mcp add --scope user sculkwire -- <command> <args>`, replacing an earlier registration. */
export async function registerClaude(entry: ServerEntry, claude: string): Promise<void> {
  await runUnattended(claude, ["mcp", "remove", "--scope", "user", "sculkwire"], { timeoutMs: 30_000 }).catch(() => undefined);
  const r = await runUnattended(claude, ["mcp", "add", "--scope", "user", "sculkwire", "--", entry.command, ...entry.args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`claude mcp add failed: ${(r.stderr || r.stdout).trim().split("\n").at(-1) ?? `exit ${r.code}`}`);
}

/** Parse `omp,claude`. Returns an error message for an unknown client. */
export function parseClients(value: string): Client[] | string {
  const out: Client[] = [];
  for (const raw of value.split(",").map((s) => s.trim().toLowerCase())) {
    if (!raw || raw === "none") continue;
    const client = CLIENTS.find((c) => c === raw);
    if (!client) return `unknown client ${raw} (choose from ${CLIENTS.join(", ")})`;
    if (!out.includes(client)) out.push(client);
  }
  return out;
}
