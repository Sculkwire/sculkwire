/**
 * Where the in-game agent's DLL and injector come from. An extension source comes first when one is registered for
 * the game folder being attached. Otherwise three built-in routes apply, first one that wins:
 *
 * 1. Override: `SCULKWIRE_AGENT_DLL` (and `SCULKWIRE_AGENT_INJECTOR`) name files that already exist.
 * 2. Cargo: `cargo` is on PATH or in `~/.cargo/bin` and this checkout has `native/Cargo.toml`. The workspace builds
 *    for `x86_64-pc-windows-msvc` from any OS (`native/.cargo/config.toml` sets `rust-lld`, so no MSVC is needed):
 *    `cd native && cargo build --release --locked --target x86_64-pc-windows-msvc`. `cargo` reads `.cargo/config.toml`
 *    from its working directory, so the crate root is the working directory of every build.
 * 3. Prebuilt: `sculkwire-agent-<version>-x86_64-windows.zip` from the GitHub release `v<version>`, verified against
 *    the sha256 published next to it (`<zip>.sha256`). A mismatch is a hard error.
 *
 * The result goes into `cacheDir("agent", <key>)`. For a cargo build the key is a hash of `native/**` (without
 * `target/`) and of the cargo arguments, and the DLL is copied to a hash-named file: Windows does not run `DllMain`
 * again for a path that is already loaded, so a second injection must use a fresh name. A prebuilt is cached under
 * its version, which cannot change without a new directory either. An extension source decides its own cache: its
 * paths are used as returned, keyed by `<name>:<tag>`.
 *
 * `platform` is a parameter (never read from `process`) so the path rules and the binary names are testable.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, relative, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { unzip } from "fflate";
import { VERSION } from "../../core/meta.ts";
import { cacheDir } from "../../core/paths.ts";
import { findOnPath } from "../../core/which.ts";

export type AgentBuildStage = "prerequisite" | "source" | "compile" | "download";

export class AgentBuildError extends Error {
  readonly stage: AgentBuildStage;
  constructor(stage: AgentBuildStage, message: string) {
    super(message);
    this.stage = stage;
  }
}

export interface AgentBuild {
  /** Cache key: `override`, the source hash of a cargo build, `prebuilt-<version>`, or `<agent source>:<tag>`. */
  key: string;
  dir: string;
  /** The DLL to inject. */
  dll: string;
  /** The injector to run: `sculkwire-injector.exe <process.exe> <dll-path>`. */
  injector: string;
  cached: boolean;
  source: "override" | "cargo" | "prebuilt" | "extension";
}

/** What an agent source gets when it is asked to build: the attach's options, plus the built-in agent. */
export interface AgentSourceBuildOptions {
  /** Build again over an existing cache entry. */
  force?: boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /**
   * The agent the built-in routes would supply. A source that only replaces the DLL takes this agent's injector, which
   * is the one that knows how to load a DLL into this OS's game process.
   */
  builtIn(): Promise<AgentBuild>;
}

/**
 * A way to supply the agent DLL for game folders of one kind of install. An extension registers one through
 * `ExtensionHost.registerAgentSource`; the first registered source whose `matches(gameDir)` is true supplies the DLL.
 */
export interface AgentSource {
  /** Shown in the build's cache key and in its errors (`<name>: <detail>`). */
  name: string;
  /** Whether this source handles the game folder the agent is being injected into. */
  matches(gameDir: string): boolean;
  /** Build, or reuse, the DLL to inject, plus the injector that loads it. `tag` names the build and keys its cache. */
  build(options: AgentSourceBuildOptions): Promise<{ dll: string; injector: string; tag: string; cached?: boolean }>;
}

const sources: AgentSource[] = [];

/** Registers an agent source. The first registered source that matches a game folder supplies its DLL. */
export function registerAgentSource(source: AgentSource): void {
  if (!sources.includes(source)) sources.push(source);
}

/** The first source whose `matches(gameDir)` is true, if any. */
export function selectAgentSource(gameDir: string, list: readonly AgentSource[] = sources): AgentSource | undefined {
  return list.find((source) => source.matches(gameDir));
}

/** `native/Cargo.toml` sits above this module (`src/runtime/engine`). */
const NATIVE_DIRS = 6;

function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** The cargo invocation every build uses: one workspace, one target, locked dependencies. */
export function cargoBuildArgs(): string[] {
  return ["build", "--release", "--locked", "--target", "x86_64-pc-windows-msvc"];
}

/** Where the cargo workspace writes the agent DLL and the injector for the Windows target. */
export function cargoArtifacts(root: string, platform: NodeJS.Platform = process.platform): { dll: string; injector: string } {
  const p = pathFor(platform);
  const release = p.join(root, "target", "x86_64-pc-windows-msvc", "release");
  return { dll: p.join(release, "sculkwire_agent.dll"), injector: p.join(release, "sculkwire-injector.exe") };
}

/** `native/` above this module, or undefined when only the built package is installed. */
export function nativeRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < NATIVE_DIRS; i++) {
    if (existsSync(join(dir, "native", "Cargo.toml"))) return join(dir, "native");
    dir = dirname(dir);
  }
  return undefined;
}

/** Every file under `root`, `target/` excluded: the cargo build directory decides nothing about the source. */
function sourceFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (dir === root && entry.name === "target") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(root, path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** sha256 over the crate's files (relative paths included) and the cargo arguments, truncated to 16 hex characters. */
export function nativeSourceHash(root: string): string {
  const files = sourceFiles(root).sort();
  if (files.length === 0) throw new AgentBuildError("source", `no Rust sources under ${root}`);
  const hash = createHash("sha256");
  hash.update(cargoBuildArgs().join(" ")).update("\0");
  for (const file of files) {
    hash.update(relative(root, file).split(sep).join("/")).update("\0");
    hash.update(readFileSync(file));
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * `cargo` from PATH, else the rustup user install at `~/.cargo/bin` (rustup does not put it on PATH by default).
 * Undefined means no cargo here, so the prebuilt archive is used instead.
 */
export function findCargo(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  find: (name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | undefined = findOnPath,
): string | undefined {
  const onPath = find("cargo", env, platform);
  if (onPath) return onPath;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const cargo = join(home, ".cargo", "bin", platform === "win32" ? "cargo.exe" : "cargo");
  return existsSync(cargo) ? cargo : undefined;
}

/** The release asset name of the prebuilt agent for `version`. */
export function prebuiltName(version: string = VERSION): string {
  return `sculkwire-agent-${version}-x86_64-windows.zip`;
}

/** The download URL of the prebuilt agent: the `v<version>` release of the public repository. */
export function prebuiltUrl(version: string = VERSION, repo = "ve3dy/sculkwire"): string {
  return `https://github.com/${repo}/releases/download/v${version}/${prebuiltName(version)}`;
}

/** Members the archive must hold. */
export const AGENT_MEMBERS = ["sculkwire_agent.dll", "sculkwire-injector.exe"] as const;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The first sha256 in a `.sha256` file (`<hex>`, `<hex>  <name>`, or `SHA256 (<name>) = <hex>`), lowercased. */
export function parseSha256(text: string): string | undefined {
  const m = /(?:^|[^0-9a-f])([0-9a-fA-F]{64})(?![0-9a-fA-F])/.exec(text);
  return m?.[1]?.toLowerCase();
}

/** Throws a hard `download` error unless `bytes` hash to `expected`. */
export function verifySha256(bytes: Uint8Array, expected: string, label: string): void {
  const actual = sha256Hex(bytes);
  if (actual !== expected.toLowerCase()) {
    throw new AgentBuildError("download", `${label} is corrupt: sha256 ${actual}, the release published ${expected.toLowerCase()}`);
  }
}

export type FetchBytes = (url: string) => Promise<Uint8Array>;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { "user-agent": `sculkwire/${VERSION} (+https://github.com/ve3dy/sculkwire)` },
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function unzipEntries(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, Uint8Array>>();
  unzip(data, (err, out) => (err ? reject(err) : resolve(out)));
  return promise;
}

/** Writes the archive's two members into `dest`. Other members are ignored. */
export async function extractAgent(zip: Uint8Array, dest: string): Promise<{ dll: string; injector: string }> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = await unzipEntries(zip);
  } catch (err) {
    throw new AgentBuildError("download", `the prebuilt agent is not a zip archive: ${err instanceof Error ? err.message : String(err)}`);
  }
  await mkdir(dest, { recursive: true });
  for (const name of AGENT_MEMBERS) {
    const content = entries[name];
    if (!content) throw new AgentBuildError("download", `the prebuilt agent has no ${name}`);
    await writeFile(join(dest, name), content);
  }
  return { dll: join(dest, AGENT_MEMBERS[0]), injector: join(dest, AGENT_MEMBERS[1]) };
}

function tail(text: string, lines = 20): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-lines)
    .join("\n");
}

/** One child process run: what `cargo` did, and its output tail. */
export interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export type RunCommand = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<RunResult>;

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  const { promise, resolve } = Promise.withResolvers<RunResult>();
  const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  const keep = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-64_000);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  child.on("error", (err) => {
    clearTimeout(timer);
    resolve({ code: null, output: `${cmd} failed to start: ${err.message}`, timedOut: false });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code, output, timedOut });
  });
  return promise;
}

export interface BuildOptions {
  /** Build or download again over an existing cache entry. */
  force?: boolean;
  timeoutMs?: number;
  /** Path rules and the cargo binary's name. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Base directory every entry lives in. Defaults to `cacheDir("agent")`. */
  cacheRoot?: string;
  exists?: (path: string) => boolean;
  /** Replaces the release download, so a test never touches the network. */
  fetchBytes?: FetchBytes;
  /** Replaces the cargo invocation, so a test never compiles anything. */
  run?: RunCommand;
  /** The game folder the agent goes into, which decides whether a registered extension source supplies it. */
  gameDir?: string;
  /** Sources to consider instead of the registered ones. First match wins. */
  sources?: readonly AgentSource[];
}

/** The `SCULKWIRE_AGENT_DLL` route, or undefined when it is not set. */
function overrideBuild(env: NodeJS.ProcessEnv, options: BuildOptions): AgentBuild | undefined {
  const dll = env.SCULKWIRE_AGENT_DLL?.trim();
  if (!dll) return undefined;
  const exists = options.exists ?? existsSync;
  const check = (path: string, name: string): void => {
    if (!exists(path)) throw new AgentBuildError("prerequisite", `${name} does not exist: ${path}`);
  };
  check(dll, "SCULKWIRE_AGENT_DLL");
  const injector = env.SCULKWIRE_AGENT_INJECTOR?.trim() || join(dirname(dll), "sculkwire-injector.exe");
  check(injector, "SCULKWIRE_AGENT_INJECTOR");
  return { key: "override", dir: dirname(dll), dll, injector, cached: true, source: "override" };
}

const inFlight = new Map<string, Promise<AgentBuild>>();

/**
 * Build (or fetch, or reuse) the agent DLL and its injector. A registered extension source that matches `gameDir`
 * supplies it; otherwise the built-in routes apply. Concurrent callers share one cargo build. Never injects anything:
 * the result is a pair of file paths.
 */
export async function buildAgent(options: BuildOptions = {}): Promise<AgentBuild> {
  const source = options.gameDir ? selectAgentSource(options.gameDir, options.sources ?? sources) : undefined;
  return source ? buildFromSource(source, options) : builtinAgent(options);
}

/** The built-in routes: env override, then a cargo build, then the prebuilt archive. Sources are not consulted. */
export async function builtinAgent(options: BuildOptions = {}): Promise<AgentBuild> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const explicit = overrideBuild(env, options);
  if (explicit) return explicit;
  const root = nativeRoot();
  const cargo = root ? findCargo(env, platform) : undefined;
  if (root && cargo) return buildWithCargo(root, cargo, options);
  return fetchPrebuiltAgent(options);
}

/** One extension source's build: its two paths checked, keyed by `<source>:<tag>`. */
async function buildFromSource(source: AgentSource, options: BuildOptions): Promise<AgentBuild> {
  let built: { dll: string; injector: string; tag: string; cached?: boolean };
  try {
    built = await source.build({
      force: options.force,
      platform: options.platform ?? process.platform,
      env: options.env ?? process.env,
      builtIn: () => builtinAgent(options),
    });
  } catch (err) {
    if (err instanceof AgentBuildError) throw err;
    throw new AgentBuildError("compile", `${source.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const exists = options.exists ?? existsSync;
  for (const [kind, path] of [
    ["DLL", built.dll],
    ["injector", built.injector],
  ] as const) {
    if (!exists(path)) throw new AgentBuildError("prerequisite", `${source.name} returned a ${kind} that does not exist: ${path}`);
  }
  return {
    key: `${source.name}:${built.tag}`,
    dir: dirname(built.dll),
    dll: built.dll,
    injector: built.injector,
    cached: built.cached ?? false,
    source: "extension",
  };
}

/** The cargo route for one crate root: cached by source hash, then built and copied to a hash-named DLL. */
export async function buildWithCargo(root: string, cargo: string, options: BuildOptions = {}): Promise<AgentBuild> {
  const platform = options.platform ?? process.platform;
  const p = pathFor(platform);
  const hash = nativeSourceHash(root);
  const dir = p.join(options.cacheRoot ?? cacheDir("agent"), hash);
  const dll = p.join(dir, `sculkwire-agent-${hash}.dll`);
  const injector = p.join(dir, "sculkwire-injector.exe");
  const exists = options.exists ?? existsSync;
  if (!options.force && exists(dll) && exists(injector)) return { key: hash, dir, dll, injector, cached: true, source: "cargo" };

  const running = inFlight.get(hash);
  if (running) return running;
  const job = compile(root, cargo, { hash, dir, dll, injector }, platform, options).finally(() => inFlight.delete(hash));
  inFlight.set(hash, job);
  return job;
}

async function compile(
  root: string,
  cargo: string,
  target: { hash: string; dir: string; dll: string; injector: string },
  platform: NodeJS.Platform,
  options: BuildOptions,
): Promise<AgentBuild> {
  await mkdir(target.dir, { recursive: true });
  const result = await (options.run ?? run)(cargo, cargoBuildArgs(), root, options.timeoutMs ?? 600_000);
  if (result.code !== 0) {
    const why = result.timedOut ? "timed out" : `exit code ${result.code}`;
    throw new AgentBuildError("compile", `${cargo} build failed (${why}):\n${tail(result.output)}`);
  }
  const artifacts = cargoArtifacts(root, platform);
  for (const [from, to] of [
    [artifacts.dll, target.dll],
    [artifacts.injector, target.injector],
  ] as const) {
    if (!existsSync(from)) throw new AgentBuildError("compile", `cargo finished but ${from} is missing`);
    await copyFile(from, to);
  }
  return { key: target.hash, dir: target.dir, dll: target.dll, injector: target.injector, cached: false, source: "cargo" };
}

/**
 * The release archive: download it, check the published sha256, unpack the two members into the version's cache
 * directory. `fetchBytes` is the test seam; the default goes to the GitHub release of `VERSION`.
 */
export async function fetchPrebuiltAgent(options: BuildOptions = {}): Promise<AgentBuild> {
  const platform = options.platform ?? process.platform;
  const p = pathFor(platform);
  const key = `prebuilt-${VERSION}`;
  const dir = p.join(options.cacheRoot ?? cacheDir("agent"), key);
  const dll = p.join(dir, AGENT_MEMBERS[0]);
  const injector = p.join(dir, AGENT_MEMBERS[1]);
  const exists = options.exists ?? existsSync;
  if (!options.force && exists(dll) && exists(injector)) return { key, dir, dll, injector, cached: true, source: "prebuilt" };

  const get = options.fetchBytes ?? fetchBytes;
  const url = prebuiltUrl();
  const [zip, sums] = await Promise.all([get(url), get(`${url}.sha256`)]).catch((err: unknown) => {
    const why = err instanceof Error ? err.message : String(err);
    throw new AgentBuildError(
      "download",
      `cannot download the prebuilt agent from ${url}: ${why}. Build it with cargo in native/ (see native/Cargo.toml), ` +
        `or point SCULKWIRE_AGENT_DLL (and SCULKWIRE_AGENT_INJECTOR) at a built DLL and injector`,
    );
  });
  const checksum = parseSha256(new TextDecoder().decode(sums));
  if (!checksum) throw new AgentBuildError("download", `${url}.sha256 holds no sha256`);
  verifySha256(zip, checksum, url);

  const staging = `${dir}.tmp-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  try {
    await extractAgent(zip, staging);
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    if (err instanceof AgentBuildError) throw err;
    throw new AgentBuildError("download", `cannot unpack ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { key, dir, dll, injector, cached: false, source: "prebuilt" };
}
