/**
 * `@minecraft/*` Script API typings (MIT) per channel, extracted into a `node_modules` tree usable by tsc.
 * Tarballs are cached under `cacheDir('knowledge','npm')` and verified against the registry shasum/integrity.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { x as untar } from "tar";
import { errorMessage } from "../core/errors.ts";
import { exists, readJsonOr, writeFileAtomic, writeJsonAtomic } from "../core/fs.ts";
import { cacheDir } from "../core/paths.ts";
import type { Channel } from "../core/version.ts";
import { httpBytes, installDir, OfflineMissingError, progress, single } from "./net.ts";
import {
  type ChannelPin,
  fetchPackument,
  getPins,
  type NpmPin,
  type Packument,
  npmPin,
  parseNpmVersion,
  TYPINGS_PACKAGES,
} from "./versions.ts";

export interface EnsureTypingsOptions {
  channel: Channel;
  /** Use the channel's beta builds (`-beta.<game>-stable` / `-beta.<game>-preview.N`). */
  beta?: boolean;
  /**
   * Manifest-style module versions (`{"@minecraft/server": "2.1.0", "@minecraft/server-ui": "2.4.0-beta"}`).
   * `x.y.z` selects that npm release; `x.y.z-beta` the newest `x.y.z-beta.<game>-<channel>` build.
   */
  modules?: Record<string, string>;
  offline?: boolean;
}

export interface TypingsInstall {
  /** `<root>/node_modules`; packages live at `<nodeModulesDir>/@minecraft/<pkg>`. */
  nodeModulesDir: string;
  /** Package name → installed npm version. */
  packages: Record<string, string>;
  channel: Channel;
  /** Game build the typings target. */
  version: string;
}

const packumentPath = (pkg: string): string => cacheDir("knowledge", "npm", "packuments", `${pkg.replace("/", "__")}.json`);
const tarballPath = (pkg: string, version: string): string =>
  cacheDir("knowledge", "npm", "tarballs", `${pkg.replace("/", "__")}-${version}.tgz`);

async function packument(pkg: string, offline?: boolean): Promise<Packument> {
  if (!offline) {
    const doc = await fetchPackument(pkg);
    await writeJsonAtomic(packumentPath(pkg), doc);
    return doc;
  }
  const doc = await readJsonOr<Packument>(packumentPath(pkg));
  if (!doc) throw new OfflineMissingError(`npm metadata for ${pkg}`);
  return doc;
}

/** Resolve a manifest module version to an npm version for the channel. */
export function resolveModuleVersion(versions: readonly string[], wanted: string, channel: Channel): string | undefined {
  if (versions.includes(wanted)) return wanted;
  const m = /^(\d+\.\d+\.\d+)-(beta|rc|preview)$/.exec(wanted);
  if (!m) return undefined;
  const cands = versions
    .map((v) => parseNpmVersion(v))
    .filter((v) => v && v.base.join(".") === m[1] && v.kind === m[2]);
  const ofChannel = cands.filter((v) => v?.channel === channel);
  const pool = ofChannel.length ? ofChannel : cands;
  // Registry order is publish order; the last one is the newest build.
  return pool.at(-1)?.version;
}

/** Check downloaded npm tarball bytes against the registry shasum and integrity. */
export function verifyTarball(bytes: Uint8Array, pin: NpmPin, pkg: string): void {
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  if (sha1 !== pin.shasum) throw new Error(`${pkg}@${pin.version}: shasum mismatch (${sha1} != ${pin.shasum})`);
  const integrity = pin.integrity?.match(/^sha512-(.+)$/)?.[1];
  if (integrity) {
    const got = createHash("sha512").update(bytes).digest("base64");
    if (got !== integrity) throw new Error(`${pkg}@${pin.version}: integrity mismatch`);
  }
}

async function tarball(pkg: string, pin: NpmPin, offline?: boolean): Promise<string> {
  const path = tarballPath(pkg, pin.version);
  try {
    verifyTarball(new Uint8Array(await readFile(path)), pin, pkg);
    return path;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") progress(`re-downloading ${pkg}@${pin.version}: ${String(err)}`);
  }
  if (offline) throw new OfflineMissingError(`${pkg}@${pin.version}`);
  progress(`downloading ${pkg}@${pin.version}`);
  const bytes = await httpBytes(pin.tarball);
  verifyTarball(bytes, pin, pkg);
  await writeFileAtomic(path, bytes);
  return path;
}

/** What an install holds (`typings.json`); it is complete once `.complete` exists beside it. */
export interface TypingsMeta {
  channel: Channel;
  beta: boolean;
  packages: Record<string, string>;
}

/** Write an install's `typings.json` and then its `.complete` mark. */
export async function writeTypingsMeta(root: string, meta: TypingsMeta): Promise<void> {
  await writeJsonAtomic(join(root, "typings.json"), meta);
  await writeFileAtomic(join(root, ".complete"), "");
}

/** Newest complete install of the channel (and beta flag) that has every explicitly requested module version. */
async function previousInstall(opts: EnsureTypingsOptions, wanted: Record<string, string>): Promise<{ root: string; packages: Record<string, string> } | undefined> {
  const base = cacheDir("knowledge", "typings");
  let best: { root: string; packages: Record<string, string>; mtime: number } | undefined;
  for (const name of await readdir(base).catch(() => [] as string[])) {
    const root = join(base, name);
    if (name.startsWith(".") || !(await exists(join(root, ".complete")))) continue;
    try {
      const meta = JSON.parse(await readFile(join(root, "typings.json"), "utf8")) as TypingsMeta;
      if (meta.channel !== opts.channel || meta.beta !== !!opts.beta) continue;
      if (Object.entries(wanted).some(([pkg, v]) => meta.packages[pkg] !== v && !meta.packages[pkg]?.startsWith(`${v}.`))) continue;
      const mtime = (await stat(join(root, ".complete"))).mtimeMs;
      if (!best || mtime > best.mtime) best = { root, packages: meta.packages, mtime };
    } catch {
      // unreadable install
    }
  }
  return best;
}

/** The install of `pinned` (`@minecraft/server` version) when cached, else the newest of the channel; no network. */
export async function typingsStatus(channel: Channel, beta: boolean, pinned?: string): Promise<Record<string, string> | undefined> {
  const exact = pinned ? await previousInstall({ channel, beta }, { "@minecraft/server": pinned }) : undefined;
  return (exact ?? (await previousInstall({ channel, beta }, {})))?.packages;
}

/**
 * Typings for the channel's pinned builds (pins re-resolve daily, so new builds are installed on the next use). A
 * failed or offline install falls back to the newest complete install of the channel that has the requested
 * module versions.
 */
export async function ensureTypings(opts: EnsureTypingsOptions): Promise<TypingsInstall> {
  const pins = await getPins({ offline: opts.offline });
  const channelPin = pins.channels[opts.channel];
  try {
    return await installTypings(opts, channelPin);
  } catch (err) {
    const wanted = Object.fromEntries(Object.entries(opts.modules ?? {}).filter(([pkg]) => pkg.startsWith("@minecraft/")));
    const prev = await previousInstall(opts, wanted);
    if (!prev) throw err;
    progress(`Script API typings update failed (${errorMessage(err)}); using the previous install`);
    const server = prev.packages["@minecraft/server"];
    return {
      nodeModulesDir: join(prev.root, "node_modules"),
      packages: prev.packages,
      channel: opts.channel,
      version: (server && parseNpmVersion(server)?.game) ?? channelPin.version,
    };
  }
}

async function installTypings(opts: EnsureTypingsOptions, channelPin: ChannelPin): Promise<TypingsInstall> {
  const selected: Record<string, NpmPin> = {};
  for (const pkg of TYPINGS_PACKAGES) {
    const entry = channelPin.npm[pkg];
    const pin = opts.beta ? (entry?.beta ?? entry?.default) : (entry?.default ?? entry?.beta);
    if (pin) selected[pkg] = pin;
  }
  for (const [pkg, wanted] of Object.entries(opts.modules ?? {})) {
    if (!pkg.startsWith("@minecraft/")) continue;
    if (selected[pkg]?.version === wanted) continue;
    const doc = await packument(pkg, opts.offline);
    const version = resolveModuleVersion(Object.keys(doc.versions), wanted, opts.channel);
    const pin = version ? npmPin(doc, parseNpmVersion(version)) : undefined;
    if (!pin) throw new Error(`${pkg}: no npm build matches module version ${wanted} on ${opts.channel}`);
    selected[pkg] = pin;
  }

  const packages = Object.fromEntries(Object.entries(selected).map(([p, pin]) => [p, pin.version]));
  const key = createHash("sha1")
    .update(JSON.stringify(Object.entries(packages).sort()))
    .digest("hex")
    .slice(0, 16);
  const root = cacheDir("knowledge", "typings", key);
  const nodeModulesDir = join(root, "node_modules");
  const server = selected["@minecraft/server"];
  const result: TypingsInstall = {
    nodeModulesDir,
    packages,
    channel: opts.channel,
    version: server?.game ?? channelPin.version,
  };

  return single(`typings:${key}`, async () => {
    if (await exists(join(root, ".complete"))) return result;
    const files = await Promise.all(
      Object.entries(selected).map(async ([pkg, pin]) => [pkg, await tarball(pkg, pin, opts.offline)] as const),
    );
    await mkdir(cacheDir("knowledge", "typings"), { recursive: true });
    const tmp = await mkdtemp(join(cacheDir("knowledge", "typings"), `.${key}-`));
    try {
      for (const [pkg, file] of files) {
        const dest = join(tmp, "node_modules", ...pkg.split("/"));
        await mkdir(dest, { recursive: true });
        await untar({ file, cwd: dest, strip: 1 });
      }
      await writeTypingsMeta(tmp, { channel: opts.channel, beta: !!opts.beta, packages });
      await installDir(tmp, root);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw err;
    }
    return result;
  });
}
