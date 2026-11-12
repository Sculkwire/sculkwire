/**
 * `sculk setup` (checks the machine, registers sculkwire with MCP clients, prints the registration for any other)
 * and `sculk doctor` (the same checks, one line per problem with its fix).
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { type CliCommand, err, out } from "../core/cli.ts";
import { ExitCode } from "../core/diagnostic.ts";
import { errorMessage } from "../core/errors.ts";
import { cacheDir } from "../core/paths.ts";
import { findRgl } from "../core/regolith.ts";
import { findInstalls } from "../gamefiles/install.ts";
import { listInstalled } from "../runtime/bds/install.ts";
import { describeVersion, versionInfo } from "../update/auto.ts";
import { CLIENTS, type McpClient, parseClients, serverEntry, snippet } from "./register.ts";

/** The install command for Node.js on this Linux distribution (from /etc/os-release), or undefined when unknown. */
function linuxNodeInstall(): string | undefined {
  let release = "";
  try {
    release = readFileSync("/etc/os-release", "utf8");
  } catch {
    return undefined;
  }
  const ids = (/^ID_LIKE=(.*)$/m.exec(release)?.[1] ?? "").concat(" ", /^ID=(.*)$/m.exec(release)?.[1] ?? "").replaceAll('"', "").split(/\s+/);
  if (ids.includes("arch")) return "sudo pacman -S nodejs npm";
  if (ids.includes("fedora") || ids.includes("rhel")) return "sudo dnf install nodejs npm";
  if (ids.includes("suse")) return "sudo zypper install nodejs22 npm22";
  if (ids.includes("debian") || ids.includes("ubuntu")) return "sudo apt install nodejs npm";
  return undefined;
}

/** Fix hints per OS: Windows (winget or the official installer), macOS (Homebrew), Linux (package manager or installer). */
const FIXES = {
  node: {
    win32: "winget install OpenJS.NodeJS.LTS (or the installer from https://nodejs.org)",
    darwin: "brew install node (or the installer from https://nodejs.org)",
    get linux() {
      return `${linuxNodeInstall() ?? "your distribution's package manager"} if it ships Node.js 22.18 or newer, otherwise https://nodejs.org/en/download`;
    },
  },
  rgl: {
    win32: "irm rgl.ink0rr.dev/install.ps1 | iex (installs %USERPROFILE%\\.rgl\\bin\\rgl.exe)",
    darwin: "curl -fsSL rgl.ink0rr.dev/install.sh | sh (installs ~/.rgl/bin/rgl)",
    linux: "curl -fsSL rgl.ink0rr.dev/install.sh | sh (installs ~/.rgl/bin/rgl, needs unzip)",
  },
  bds: {
    win32: "sculk bds install --accept-eula",
    darwin: "none: Bedrock Dedicated Server runs on Linux and Windows x64 only",
    linux: "sculk bds install --accept-eula",
  },
};

function fixFor(tool: keyof typeof FIXES): string {
  return FIXES[tool][process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"];
}

/** `required` failures make `doctor` exit 1. `feature` failures disable one feature. `optional` is informational. */
export interface Check {
  name: string;
  level: "required" | "feature" | "optional";
  ok: boolean;
  detail: string;
  fix?: string;
}

export async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const version = await versionInfo().catch(() => undefined);
  if (version) checks.push({ name: "version", level: "optional", ok: !version.lastError, detail: describeVersion(version), fix: "sculk update" });
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  checks.push({
    name: "node",
    level: "required",
    ok: major > 22 || (major === 22 && minor >= 18),
    detail: `Node.js ${process.versions.node}`,
    fix: `install Node.js 22.18 or newer: ${fixFor("node")}`,
  });

  const installs = await findInstalls().catch(() => []);
  checks.push({
    name: "game",
    level: "feature",
    ok: installs.length > 0,
    detail: installs.length ? `Minecraft Bedrock client: ${installs.map((i) => i.label).join(", ")}` : "no Minecraft Bedrock client found, game_* and player_* tools are unavailable",
    fix: "install the GDK build (see docs/client.md) or set SCULKWIRE_MINECRAFT_DIR to its 'Minecraft Bedrock' data folder",
  });

  const bds = await listInstalled().catch(() => []);
  checks.push({
    name: "bds",
    level: "feature",
    ok: bds.length > 0,
    detail: bds.length ? `BDS ${bds.map((b) => `${b.version} (${b.channel})`).join(", ")} in ${cacheDir("bds")}` : "no Bedrock Dedicated Server downloaded yet, the first bds_* call downloads one",
    fix: fixFor("bds"),
  });

  // The validator's own lookup, so doctor reports the rgl that validate_pack and bds_check will run.
  const rgl = findRgl();
  checks.push({
    name: "rgl",
    level: "feature",
    ok: rgl !== undefined,
    detail: rgl ? `rgl ${rgl}` : "rgl not found in ~/.local/bin, ~/.rgl/bin or PATH, Regolith projects with filters cannot be built",
    fix: fixFor("rgl"),
  });
  return checks;
}

export function formatCheck(c: Check): string {
  const tag = c.ok ? "ok" : c.level === "required" ? "missing" : c.level === "feature" ? "warning" : "info";
  return `${tag.padEnd(8)}${c.name.padEnd(10)}${c.detail}${!c.ok && c.fix ? `. Fix: ${c.fix}` : ""}`;
}

const doctor: CliCommand = {
  name: "doctor",
  summary: "Check the machine: Node, game client, BDS and rgl",
  async run(args) {
    if (args.length) {
      err("usage: sculk doctor");
      return ExitCode.usage;
    }
    const checks = await runChecks();
    for (const c of checks) out(formatCheck(c));
    return checks.some((c) => c.level === "required" && !c.ok) ? ExitCode.findings : ExitCode.ok;
  },
};

/** One question on stderr, so stdout keeps only the registration snippet. Throws when stdin ends before an answer. */
async function ask(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY === true });
  try {
    rl.setPrompt(`${question} [${fallback}] `);
    rl.prompt();
    const next = await rl[Symbol.asyncIterator]().next();
    if (next.done) throw new Error("setup needs answers on stdin, but input ended");
    return String(next.value).trim() || fallback;
  } finally {
    rl.close();
  }
}

const SETUP_USAGE = [
  `usage: sculk setup [--yes] [--register ${CLIENTS.map((c) => c.name).join(",")}]`,
  "",
  "  --yes       ask nothing (no client registration unless --register)",
  `  --register  register sculkwire with these MCP clients (${CLIENTS.map((c) => c.name).join(", ")}); the JSON for any other client is printed`,
].join("\n");

interface SetupArgs {
  yes: boolean;
  register?: McpClient[];
}

function parseSetup(args: string[]): SetupArgs | string {
  const parsed: SetupArgs = { yes: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes" || arg === "-y") parsed.yes = true;
    else if (arg === "--register") {
      const clients = parseClients(args[++i] ?? "");
      if (typeof clients === "string") return clients;
      parsed.register = clients;
    } else return `unknown argument ${arg}`;
  }
  return parsed;
}

async function register(clients: readonly McpClient[]): Promise<void> {
  const entry = serverEntry();
  for (const client of clients) {
    try {
      err(await client.register(entry));
    } catch (e) {
      err(`Registering with ${client.name} failed: ${errorMessage(e)}`);
    }
  }
}

const setup: CliCommand = {
  name: "setup",
  summary: "Set up: check the machine, register sculkwire with MCP clients",
  async run(args) {
    const opts = parseSetup(args);
    if (typeof opts === "string") {
      err(`${opts}\n${SETUP_USAGE}`);
      return ExitCode.usage;
    }
    err("Checking this machine...");
    for (const c of await runChecks()) err(formatCheck(c));
    let clients = opts.register;
    if (!opts.yes && !clients) {
      const names = CLIENTS.map((c) => c.name);
      const detected = CLIENTS.filter((c) => c.detect()).map((c) => c.name);
      const answer = await ask(`Register sculkwire with which MCP clients? (${names.join(", ")}, comma separated, or none)`, detected.join(",") || "none");
      const parsed = parseClients(answer);
      if (typeof parsed === "string") err(`${parsed}, skipping registration`);
      clients = typeof parsed === "string" ? [] : parsed;
    }
    await register(clients ?? []);
    err("\nMCP registration for any other client:\n");
    out(snippet(serverEntry()));
    return ExitCode.ok;
  },
};

export const commands: CliCommand[] = [setup, doctor];
