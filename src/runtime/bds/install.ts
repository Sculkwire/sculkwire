/**
 * Bedrock Dedicated Server download + install, fetched at runtime from Mojang's download-links API into
 * `cacheDir('bds', <version>)` and never bundled. When the daily version pins name a newer build than the newest
 * install, `resolveBds` keeps returning the installed one; the MCP server downloads the new one in the background
 * and the next call uses it. `updateBds` (`sculk knowledge update`) downloads it now.
 */
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { unzip } from "fflate";
import { z } from "zod";
import type { Channel } from "../../core/version.ts";
import { compareGameVersions, parseGameVersion } from "../../core/version.ts";
import { backgroundDownloadsAllowed } from "../../core/background.ts";
import { cacheDir, dataDir } from "../../core/paths.ts";
import { PrerequisiteError } from "../../core/errors.ts";
import { getPins } from "../../knowledge/versions.ts";

export const LINKS_API = "https://net-secondary.web.minecraft-services.net/api/v1.0/download/links";

export type BdsPlatform = "linux" | "windows";

export interface BdsLink {
  channel: Channel;
  platform: BdsPlatform;
  version: string;
  url: string;
}

export interface BdsInstall {
  channel: Channel;
  version: string;
  /** Unpacked server directory (holds `bedrock_server` or `bedrock_server.exe`). */
  dir: string;
  url?: string;
}

const DOWNLOAD_TYPES: Record<string, { channel: Channel; platform: BdsPlatform }> = {
  serverBedrockLinux: { channel: "stable", platform: "linux" },
  serverBedrockWindows: { channel: "stable", platform: "windows" },
  serverBedrockPreviewLinux: { channel: "preview", platform: "linux" },
  serverBedrockPreviewWindows: { channel: "preview", platform: "windows" },
};

const MARKER = ".sculkwire-bds.json";

const LinksResponse = z.object({
  result: z.object({ links: z.array(z.object({ downloadType: z.string(), downloadUrl: z.string() })) }),
});

/** Parse the download-links API response body. */
export function parseLinks(body: unknown): BdsLink[] {
  const out: BdsLink[] = [];
  for (const l of LinksResponse.parse(body).result.links) {
    const kind = DOWNLOAD_TYPES[l.downloadType];
    const m = /bedrock-server-([\d.]+)\.zip/.exec(l.downloadUrl);
    if (kind && m?.[1]) out.push({ ...kind, version: m[1], url: l.downloadUrl });
  }
  return out;
}

export async function fetchLinks(): Promise<BdsLink[]> {
  const res = await fetch(LINKS_API, { headers: { "User-Agent": "sculkwire" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`download-links API: HTTP ${res.status}`);
  return parseLinks(await res.json());
}

/** BDS build for a host: Linux x64 and Windows x64 only (Mojang publishes no macOS or arm64 server). */
export function bdsPlatformFor(platform: NodeJS.Platform, arch: string): BdsPlatform | undefined {
  if (arch !== "x64") return undefined;
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return undefined;
}

/** Server executable inside an install for a BDS platform. */
export function serverExecutable(platform: BdsPlatform): string {
  return platform === "windows" ? "bedrock_server.exe" : "bedrock_server";
}

/** The download link for the channel and BDS platform. */
export function pickLink(links: readonly BdsLink[], channel: Channel, platform: BdsPlatform): BdsLink | undefined {
  return links.find((l) => l.channel === channel && l.platform === platform);
}

/** The BDS platform of this host; a prerequisite error on hosts BDS does not ship for. */
export function assertHostSupported(platform: NodeJS.Platform = process.platform, arch: string = process.arch): BdsPlatform {
  const bds = bdsPlatformFor(platform, arch);
  if (!bds) {
    throw new PrerequisiteError(
      `BDS runtime needs a Linux x64 or Windows x64 host (this host: ${platform}-${arch}). ` +
        "Run sculkwire on a Linux or Windows x64 machine, or in a linux/amd64 container.",
    );
  }
  return bds;
}

const EULA_FILE = (): string => dataDir("eula-accepted");

export async function eulaAccepted(): Promise<boolean> {
  try {
    await stat(EULA_FILE());
    return true;
  } catch {
    return false;
  }
}

/**
 * Require Minecraft EULA acceptance: once per data dir, via `SCULKWIRE_ACCEPT_EULA=1` or `--accept-eula`
 * (`accept = true`). Acceptance is recorded in `dataDir('eula-accepted')`.
 */
export async function requireEula(accept = false): Promise<void> {
  if (await eulaAccepted()) return;
  if (accept || process.env.SCULKWIRE_ACCEPT_EULA === "1") {
    await mkdir(dirname(EULA_FILE()), { recursive: true });
    await writeFile(
      EULA_FILE(),
      `Minecraft EULA (https://www.minecraft.net/eula) and Privacy Policy accepted ${new Date().toISOString()}\n`,
    );
    return;
  }
  throw new PrerequisiteError(
    "Bedrock Dedicated Server requires accepting the Minecraft EULA (https://www.minecraft.net/eula) and the " +
      "Microsoft Privacy Policy. Accept once with SCULKWIRE_ACCEPT_EULA=1 or `sculk bds install --accept-eula`.",
  );
}

interface Marker {
  channel: Channel;
  version: string;
  url: string;
  installedAt: string;
}

async function readMarker(dir: string): Promise<Marker | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, MARKER), "utf8")) as Marker;
  } catch {
    return undefined;
  }
}

/** Installed servers, newest first. */
export async function listInstalled(channel?: Channel): Promise<BdsInstall[]> {
  let names: string[];
  try {
    names = await readdir(cacheDir("bds"));
  } catch {
    return [];
  }
  const out: BdsInstall[] = [];
  for (const name of names) {
    const dir = cacheDir("bds", name);
    const m = await readMarker(dir);
    if (m && (!channel || m.channel === channel)) out.push({ channel: m.channel, version: m.version, dir, url: m.url });
  }
  out.sort((a, b) => compareGameVersions(parseGameVersion(b.version)!, parseGameVersion(a.version)!));
  return out;
}

async function unzipTo(data: Uint8Array, dest: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, Uint8Array>>();
  unzip(data, (err, out) => (err ? reject(err) : resolve(out)));
  const files = await promise;
  for (const [name, content] of Object.entries(files)) {
    const target = normalize(join(dest, name));
    if (!target.startsWith(dest + sep)) throw new Error(`zip entry escapes target: ${name}`);
    if (name.endsWith("/")) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export interface InstallOptions {
  channel?: Channel;
  acceptEula?: boolean;
  /** Re-download even when the version is installed. */
  force?: boolean;
  log?: (line: string) => void;
}

/** Download and unpack the latest BDS for the channel and this host (idempotent). */
export async function installBds(opts: InstallOptions = {}): Promise<BdsInstall & { downloaded: boolean }> {
  const channel = opts.channel ?? "stable";
  const log = opts.log ?? (() => {});
  const platform = assertHostSupported();
  await requireEula(opts.acceptEula);
  const link = pickLink(await fetchLinks(), channel, platform);
  if (!link) throw new PrerequisiteError(`no ${platform === "windows" ? "Windows" : "Linux"} BDS published for channel ${channel}`);
  const dir = cacheDir("bds", link.version);
  const existing = await readMarker(dir);
  if (existing && !opts.force) return { channel, version: link.version, dir, url: link.url, downloaded: false };

  log(`downloading BDS ${channel} ${link.version} from ${link.url}`);
  const res = await fetch(link.url, { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) sculkwire" } });
  if (!res.ok) throw new Error(`BDS download failed: HTTP ${res.status} ${link.url}`);
  const zip = new Uint8Array(await res.arrayBuffer());
  log(`unpacking ${(zip.byteLength / 1e6).toFixed(1)} MB`);
  const tmp = `${dir}.tmp-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await unzipTo(zip, tmp);
  if (platform === "linux") await chmod(join(tmp, serverExecutable(platform)), 0o755);
  const marker: Marker = { channel, version: link.version, url: link.url, installedAt: new Date().toISOString() };
  await writeFile(join(tmp, MARKER), JSON.stringify(marker, null, 2));
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  log(`installed BDS ${link.version} at ${dir}`);
  return { channel, version: link.version, dir, url: link.url, downloaded: true };
}

/** Installs kept per channel after an update: the new one and the previous one (a running server may use it). */
const KEEP_INSTALLS = 2;
const updating = new Set<Channel>();
const updateFailures = new Map<Channel, number>();
const RETRY_UPDATE_MS = 60 * 60 * 1000;

/**
 * Download the build the version pins name when it is newer than the newest install of the channel, and prune old
 * installs. Returns the install in use, undefined when none exists (nothing is installed by this). Throws when the
 * download fails.
 */
export async function updateBds(channel: Channel, log: (line: string) => void = () => {}): Promise<BdsInstall | undefined> {
  const [installed] = await listInstalled(channel);
  if (!installed) return undefined;
  const pinned = (await getPins()).channels[channel]?.bds?.version;
  const want = pinned ? parseGameVersion(pinned) : undefined;
  const have = parseGameVersion(installed.version);
  if (!want || !have || compareGameVersions(want, have) <= 0) return installed;
  const r = await installBds({ channel, log });
  for (const old of (await listInstalled(channel)).slice(KEEP_INSTALLS)) {
    if (old.dir !== r.dir) await rm(old.dir, { recursive: true, force: true });
  }
  return r;
}

/** `updateBds` in the background of a long-lived process; never throws. */
async function updateWhenBehind(channel: Channel, installed: BdsInstall): Promise<void> {
  if (!backgroundDownloadsAllowed() || updating.has(channel) || Date.now() - (updateFailures.get(channel) ?? 0) < RETRY_UPDATE_MS) return;
  updating.add(channel);
  try {
    await updateBds(channel, (line) => process.stderr.write(`sculkwire: ${line}\n`));
  } catch (err) {
    updateFailures.set(channel, Date.now());
    process.stderr.write(`sculkwire: BDS ${channel} update failed (${err instanceof Error ? err.message : String(err)}); using ${installed.version}\n`);
  } finally {
    updating.delete(channel);
  }
}

/**
 * Installed server for the channel: the newest local one (the MCP server downloads a newer published build in the
 * background for the next call; see `src/core/background.ts`), installing the current release when none exists
 * (`install` true) or failing with a prerequisite error.
 */
export async function resolveBds(channel: Channel = "stable", opts: InstallOptions & { install?: boolean } = {}): Promise<BdsInstall> {
  assertHostSupported();
  await requireEula(opts.acceptEula);
  const [installed] = await listInstalled(channel);
  if (installed) {
    void updateWhenBehind(channel, installed);
    return installed;
  }
  if (opts.install === false) throw new PrerequisiteError(`no ${channel} BDS installed; run \`sculk bds install --channel ${channel}\``);
  return installBds({ ...opts, channel });
}
