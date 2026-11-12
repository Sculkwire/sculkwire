/**
 * Extensions: packages that add MCP tools and CLI commands to sculkwire without being part of it.
 *
 * Discovery: every directory in `SCULKWIRE_EXTENSIONS` (`path.delimiter` separated) and every subdirectory (or link
 * to one) of `<config>/extensions`. A directory is an extension when its `package.json` has
 * `"sculkwire": { "extension": "<entry file, relative to the directory>" }`. The entry default-exports
 * `activate(host)`, which returns (or resolves to) an `Extension`. A `.ts` entry runs through Node's type stripping,
 * which Node refuses under a `node_modules` folder.
 *
 * Fail open: a missing directory, a bad manifest, an entry that does not load or an `activate` that throws writes
 * one line to stderr (never stdout, the MCP stream) and that extension is skipped. Loaded once per process.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CliCommand } from "../core/cli.ts";
import { errorMessage } from "../core/errors.ts";
import { configDir } from "../core/paths.ts";
import { extensionHost, type ExtensionHost } from "./host.ts";

export interface Extension {
  name: string;
  /** Registers the extension's MCP tools. */
  register?: (server: McpServer) => void;
  /** CLI commands, listed in `sculk --help` and resolved like the built-in ones. */
  commands?: CliCommand[];
}

export type ExtensionActivate = (host: ExtensionHost) => Extension | Promise<Extension>;

export interface LoadOptions {
  dirs?: readonly string[];
  host?: ExtensionHost;
  /** One line per skipped extension. Default: stderr. */
  warn?: (line: string) => void;
}

function stderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Candidate directories: `SCULKWIRE_EXTENSIONS` first, then the subdirectories of `root`. */
export function extensionDirs(env: NodeJS.ProcessEnv = process.env, root: string = configDir("extensions")): string[] {
  const dirs = (env.SCULKWIRE_EXTENSIONS ?? "")
    .split(delimiter)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => resolve(d));
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    // no extensions folder
  }
  for (const name of entries.sort()) {
    const dir = join(root, name);
    try {
      // statSync follows links and junctions, so a linked extension counts.
      if (statSync(dir).isDirectory()) dirs.push(dir);
    } catch {
      // a dangling link
    }
  }
  return dirs;
}

/** The entry file a directory's manifest names. Throws with the reason it is not an extension. */
function entryOf(dir: string): string {
  if (!existsSync(dir)) throw new Error("directory does not exist");
  const manifest = join(dir, "package.json");
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(manifest, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${manifest}: ${errorMessage(err)}`);
  }
  const entry = (pkg as { sculkwire?: { extension?: unknown } } | null)?.sculkwire?.extension;
  if (typeof entry !== "string" || !entry) throw new Error(`${manifest} has no "sculkwire": { "extension": "<entry file>" }`);
  const file = resolve(dir, entry);
  if (!existsSync(file)) throw new Error(`entry ${file} does not exist`);
  return file;
}

async function loadOne(dir: string, host: ExtensionHost): Promise<Extension> {
  const file = entryOf(dir);
  // Plugin loading: the entry is chosen at runtime by the extension's manifest.
  const module = (await import(pathToFileURL(file).href)) as { default?: unknown };
  if (typeof module.default !== "function") throw new Error(`${file} does not default-export activate(host)`);
  const ext = (await (module.default as ExtensionActivate)(host)) as Partial<Extension> | undefined;
  if (!ext || typeof ext.name !== "string" || !ext.name) throw new Error("activate(host) returned no { name }");
  if (ext.register !== undefined && typeof ext.register !== "function") throw new Error("register is not a function");
  if (ext.commands !== undefined && !Array.isArray(ext.commands)) throw new Error("commands is not an array");
  return ext as Extension;
}

/** Loads every extension in `dirs` (default: `extensionDirs()`), each directory once, skipping broken ones. */
export async function readExtensions(options: LoadOptions = {}): Promise<Extension[]> {
  const warn = options.warn ?? stderr;
  const host = options.host ?? extensionHost();
  const seen = new Set<string>();
  const out: Extension[] = [];
  for (const dir of options.dirs ?? extensionDirs()) {
    let real = dir;
    try {
      real = realpathSync(dir);
    } catch {
      // reported by loadOne
    }
    if (seen.has(real)) continue;
    seen.add(real);
    try {
      out.push(await loadOne(dir, host));
    } catch (err) {
      warn(`sculkwire: extension ${dir} skipped: ${errorMessage(err)}`);
    }
  }
  return out;
}

let loaded: Promise<Extension[]> | undefined;

/** The installed extensions, loaded once per process. */
export function loadExtensions(): Promise<Extension[]> {
  loaded ??= readExtensions();
  return loaded;
}

/** Registers an extension's tools. A `register` that throws is reported on stderr and leaves the others working. */
export function registerExtension(server: McpServer, ext: Extension, warn: (line: string) => void = stderr): void {
  try {
    ext.register?.(server);
  } catch (err) {
    warn(`sculkwire: extension ${ext.name} failed to register its tools: ${errorMessage(err)}`);
  }
}
