/**
 * `sculk setup` (interactive: checks the machine, asks for the optional decision model, prints the MCP registration)
 * and `sculk doctor` (the same checks, one line per problem with its fix).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { CliCommand } from "../core/cli.ts";
import { ExitCode } from "../core/diagnostic.ts";
import { cacheDir } from "../core/paths.ts";
import { findOnPath } from "../core/which.ts";
import { listInstalled } from "../runtime/bds/install.ts";
import { findInstalls } from "../runtime/client/install.ts";
import { describeVersion, versionInfo } from "../update/auto.ts";
import { CLIENTS, type Client, ompConfigPath, parseClients, registerClaude, registerOmp, serverEntry, snippet } from "../update/register.ts";
import { findRgl } from "../validate/regolith.ts";
import { KEV_DIR, kevInstallCommands, kevStartCommand } from "./client.ts";
import { decisionStatus, PROVIDER_IDS, PROVIDERS, readConfig, saveDecisionConfig, type DecisionConfig, type Provider } from "./config.ts";

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
  uv: {
    win32: "winget install astral-sh.uv",
    darwin: "brew install uv",
    linux: "curl -LsSf https://astral.sh/uv/install.sh | sh",
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

export async function runChecks(options: { probeDecision?: boolean } = {}): Promise<Check[]> {
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

  const uvExe = process.platform === "win32" ? "uv.exe" : "uv";
  // uv's own installer puts it in ~/.local/bin, which a fresh shell may not have on PATH yet.
  const uvLocal = join(homedir(), ".local", "bin", uvExe);
  const uv = findOnPath(uvExe) ?? (existsSync(uvLocal) ? uvLocal : undefined);
  checks.push({
    name: "uv",
    level: "optional",
    ok: uv !== undefined,
    detail: uv ? `uv ${uv} (serves a local Kev decision model)` : "uv not found, needed only to serve Kev locally",
    fix: fixFor("uv"),
  });

  const status = await decisionStatus({ probe: options.probeDecision ?? true });
  checks.push({
    name: "decision",
    level: "optional",
    ok: status.provider === "none" ? true : status.configured && (options.probeDecision === false || status.reachable),
    detail:
      status.provider === "none"
        ? "no decision model (optional, only player_act play uses one)"
        : status.reachable
          ? `${status.provider} ${status.model} answered in ${status.latencyMs} ms`
          : `${status.provider} ${status.model ?? ""}: ${status.error ?? "configured"}`,
    fix: "sculk setup",
  });
  return checks;
}

export function formatCheck(c: Check): string {
  const tag = c.ok ? "ok" : c.level === "required" ? "missing" : c.level === "feature" ? "warning" : "info";
  return `${tag.padEnd(8)}${c.name.padEnd(10)}${c.detail}${!c.ok && c.fix ? `. Fix: ${c.fix}` : ""}`;
}

const doctor: CliCommand = {
  name: "doctor",
  summary: "Check the machine: Node, game client, BDS, rgl, uv and the optional decision model",
  async run(args) {
    if (args.length) {
      process.stderr.write("usage: sculk doctor\n");
      return ExitCode.usage;
    }
    const checks = await runChecks();
    for (const c of checks) process.stdout.write(`${formatCheck(c)}\n`);
    return checks.some((c) => c.level === "required" && !c.ok) ? ExitCode.findings : ExitCode.ok;
  },
};

interface Prompter {
  ask(question: string, fallback?: string): Promise<string>;
  /** Hides what is typed when stdin is a terminal. */
  secret(question: string): Promise<string>;
  close(): void;
}

/** Prompts go to stderr, so stdout keeps only the registration snippet. Throws when stdin ends before an answer. */
function prompter(): Prompter {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (!muted) process.stderr.write(chunk);
      cb();
    },
  });
  const tty = process.stdin.isTTY === true;
  const rl = createInterface({ input: process.stdin, output, terminal: tty });
  // Reading through the iterator buffers piped lines that arrive before the question that consumes them.
  const lines = rl[Symbol.asyncIterator]();
  const read = async (prompt: string, hide: boolean): Promise<string> => {
    rl.setPrompt(prompt);
    rl.prompt();
    muted = hide && tty;
    try {
      const next = await lines.next();
      if (next.done) throw new Error("setup needs answers on stdin, but input ended");
      return String(next.value).trim();
    } finally {
      if (muted) process.stderr.write("\n");
      muted = false;
    }
  };
  return {
    async ask(question: string, fallback = ""): Promise<string> {
      return (await read(fallback ? `${question} [${fallback}] ` : `${question} `, false)) || fallback;
    },
    secret: (question: string) => read(`${question} `, true),
    close: () => rl.close(),
  };
}

async function askDecision(ask: Prompter): Promise<DecisionConfig> {
  const current = (await readConfig()).decision;
  process.stderr.write(
    [
      "",
      "Decision model (optional, only player_act play uses one):",
      `  none        no decision model`,
      `  openrouter  ${PROVIDERS.openrouter.title}, about 0.1 s, accepts screenshots, paid per input token`,
      `  zenmux      ${PROVIDERS.zenmux.title}, same model and API`,
      `  local       ${PROVIDERS.local.title}, text only, needs uv and a GPU`,
      "",
    ].join("\n"),
  );
  let provider: Provider | undefined;
  while (!provider) {
    const answer = await ask.ask("Provider?", current?.provider ?? "none");
    provider = PROVIDER_IDS.find((p) => p === answer);
    if (!provider) process.stderr.write(`choose one of ${PROVIDER_IDS.join(", ")}\n`);
  }
  if (provider === "none") return { provider };
  const info = PROVIDERS[provider];
  const same = current?.provider === provider ? current : undefined;
  const config: DecisionConfig = { provider };
  const model = await ask.ask("Model?", same?.model ?? info.model);
  if (model !== info.model) config.model = model;
  if (provider === "local") {
    const url = await ask.ask("Server URL?", same?.baseUrl ?? info.baseUrl);
    if (url !== info.baseUrl) config.baseUrl = url;
    const port = new URL(url).port || "8009";
    process.stderr.write(
      [
        "",
        ...(existsSync(KEV_DIR) ? [`Kev checkout: ${KEV_DIR}`] : ["Get Kev:", ...kevInstallCommands().map((c) => `  ${c}`)]),
        `Start it (keep it running while you play): ${kevStartCommand(Number(port))}`,
        "",
      ].join("\n"),
    );
    return config;
  }
  const envKey = info.keyEnv ? process.env[info.keyEnv]?.trim() : undefined;
  if (envKey && (await ask.ask(`Use ${info.keyEnv} from the environment instead of saving a key? (y/n)`, "y")).toLowerCase().startsWith("y")) {
    return config;
  }
  const key = await ask.secret(same?.apiKey ? `API key (${info.keyUrl}, Enter keeps the saved one):` : `API key (${info.keyUrl}):`);
  if (key) config.apiKey = key;
  else if (same?.apiKey) config.apiKey = same.apiKey;
  return config;
}

const SETUP_USAGE = [
  "usage: sculk setup [--yes] [--decision none|openrouter|zenmux|local] [--register omp,claude]",
  "",
  "  --yes       ask nothing: keep a saved decision model, otherwise save none",
  "  --decision  save this provider (never a key: set OPENROUTER_API_KEY / ZENMUX_API_KEY, or run setup interactively)",
  "  --register  register sculkwire with these MCP clients (omp, claude); the JSON for any other client is printed",
].join("\n");

interface SetupArgs {
  yes: boolean;
  decision?: Provider;
  register?: Client[];
}

function parseSetup(args: string[]): SetupArgs | string {
  const out: SetupArgs = { yes: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--decision") {
      const value = args[++i];
      const provider = PROVIDER_IDS.find((p) => p === value);
      if (!provider) return `--decision needs one of ${PROVIDER_IDS.join(", ")}`;
      out.decision = provider;
    } else if (arg === "--register") {
      const clients = parseClients(args[++i] ?? "");
      if (typeof clients === "string") return clients;
      out.register = clients;
    } else return `unknown argument ${arg}`;
  }
  return out;
}

/** The decision section to save for `--decision` / `--yes`: a saved section for the same provider (and its key) stays. */
async function decisionFromFlags(provider: Provider | undefined): Promise<DecisionConfig | undefined> {
  const current = (await readConfig()).decision;
  if (provider === undefined) return current ? undefined : { provider: "none" };
  return current?.provider === provider ? undefined : { provider };
}

/** Clients worth offering: omp when ~/.omp exists, claude when its CLI is on PATH. */
function detectedClients(): Client[] {
  return CLIENTS.filter((c) => (c === "omp" ? existsSync(join(homedir(), ".omp")) : findOnPath("claude") !== undefined));
}

async function register(clients: Client[]): Promise<void> {
  const entry = serverEntry();
  for (const client of clients) {
    try {
      if (client === "omp") {
        const r = await registerOmp(entry, ompConfigPath());
        process.stderr.write(`Registered sculkwire in ${r.path}${r.backup ? ` (previous file kept as ${r.backup})` : ""}\n`);
      } else {
        const claude = findOnPath("claude");
        if (!claude) {
          process.stderr.write("The claude CLI is not on PATH, add the JSON below to Claude Code by hand\n");
          continue;
        }
        await registerClaude(entry, claude);
        process.stderr.write("Registered sculkwire with Claude Code (user scope)\n");
      }
    } catch (err) {
      process.stderr.write(`Registering with ${client} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

const setup: CliCommand = {
  name: "setup",
  summary: "Set up: check the machine, choose the optional decision model, register sculkwire with MCP clients",
  async run(args) {
    const opts = parseSetup(args);
    if (typeof opts === "string") {
      process.stderr.write(`${opts}\n${SETUP_USAGE}\n`);
      return ExitCode.usage;
    }
    process.stderr.write("Checking this machine...\n");
    for (const c of await runChecks({ probeDecision: false })) process.stderr.write(`${formatCheck(c)}\n`);
    let clients = opts.register;
    if (opts.yes || opts.decision) {
      const decision = await decisionFromFlags(opts.decision);
      if (decision) process.stderr.write(`Saved decision model ${decision.provider} in ${await saveDecisionConfig(decision)}\n`);
    }
    if (!opts.yes && (!opts.decision || !clients)) {
      const ask = prompter();
      try {
        if (!opts.decision) {
          const decision = await askDecision(ask);
          process.stderr.write(`Saved ${await saveDecisionConfig(decision)}\n`);
        }
        if (!clients) {
          const answer = await ask.ask(`Register sculkwire with which MCP clients? (${CLIENTS.join(", ")}, comma separated, or none)`, detectedClients().join(",") || "none");
          const parsed = parseClients(answer);
          if (typeof parsed === "string") process.stderr.write(`${parsed}, skipping registration\n`);
          clients = typeof parsed === "string" ? [] : parsed;
        }
      } finally {
        ask.close();
      }
    }
    const status = await decisionStatus({ probe: !opts.yes });
    if (status.provider !== "none") {
      const info = PROVIDERS[status.provider];
      process.stderr.write(
        status.reachable
          ? `Decision model ${status.provider} ${status.model} answered in ${status.latencyMs} ms\n`
          : status.configured
            ? `Decision model ${status.provider} ${status.model ?? ""} is not reachable yet: ${status.error}\n`
            : info.keyEnv
              ? `Decision model ${status.provider} needs a key: set ${info.keyEnv} in your environment, or run \`sculk setup\` in a terminal to save one\n`
              : `Decision model ${status.provider}: ${status.error}\n`,
      );
      if (status.provider === "local" && !status.reachable) process.stderr.write(`Start Kev: ${kevStartCommand()} (see docs/decision.md)\n`);
    }
    await register(clients ?? []);
    process.stderr.write("\nMCP registration for any other client:\n\n");
    process.stdout.write(`${snippet(serverEntry())}\n`);
    return ExitCode.ok;
  },
};

export const commands: CliCommand[] = [setup, doctor];
