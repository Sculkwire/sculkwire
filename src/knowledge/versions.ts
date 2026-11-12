/**
 * Resolves the current stable and preview builds from upstream sources and pins them in
 * `cacheDir('knowledge','versions.json')`. Every other knowledge artifact is derived from these pins.
 * Pins older than a day are re-resolved in the background by `getPins` (the call returns the cached pins at once);
 * a failed refresh keeps them, so new samples tags, npm builds, BDS builds and changelogs are picked up within a day.
 */
import { readFile } from "node:fs/promises";
import { cacheDir } from "../core/paths.ts";
import {
  type Channel,
  CHANNELS,
  compareGameVersions,
  formatGameVersion,
  type GameVersion,
  parseGameVersion,
} from "../core/version.ts";
import { writeJsonAtomic } from "../core/fs.ts";
import { httpJson, OfflineMissingError, progress, runOk, single } from "./net.ts";
import { CHECK_INTERVAL_MS, RETRY_AFTER_FAILURE_MS } from "./tracked.ts";

export const SAMPLES_REPO = "https://github.com/Mojang/bedrock-samples";
export const BDS_LINKS_URL = "https://net-secondary.web.minecraft-services.net/api/v1.0/download/links";
export const ZENDESK_SECTIONS: Record<Channel, string> = { stable: "360001186971", preview: "360001185332" };
export const zendeskArticlesUrl = (channel: Channel): string =>
  `https://feedback.minecraft.net/api/v2/help_center/en-us/sections/${ZENDESK_SECTIONS[channel]}/articles.json`;

/** Script API typings fetched per channel. */
export const TYPINGS_PACKAGES = [
  "@minecraft/server",
  "@minecraft/server-ui",
  "@minecraft/server-gametest",
  "@minecraft/server-net",
  "@minecraft/server-admin",
  "@minecraft/common",
  "@minecraft/math",
  "@minecraft/vanilla-data",
  "@minecraft/debug-utilities",
  "@minecraft/diagnostics",
  "@minecraft/server-graphics",
] as const;

// ---------------------------------------------------------------------------------------------
// npm prerelease mapping

export type NpmKind = "release" | "beta" | "rc" | "preview" | "other";

export interface NpmVersionInfo {
  version: string;
  /** `x.y.z` before any prerelease. */
  base: [number, number, number];
  kind: NpmKind;
  /** Game build the version targets, when encoded (`1.26.63`, `1.26.70.23`). */
  game?: string;
  channel?: Channel;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;
/** `beta.1.26.63-stable`, `rc.1.26.70-preview.23`, `beta.1.26.70-preview.23`, `preview.1.19.60.22`. */
const PRERELEASE_GAME_RE = /^(beta|rc|preview)\.(\d+\.\d+\.\d+)(?:\.(\d+))?(?:-(stable|preview)(?:\.(\d+))?)?$/;
/** vanilla-data style: the package version is the game version (`1.26.60`, `1.26.70-preview.23`). */
const GAME_PREVIEW_RE = /^preview\.(\d+)$/;

/**
 * Classify an `@minecraft/*` npm version. `-beta.<game>-stable` targets a stable build, `-rc.<game>-preview.N`
 * and `-beta.<game>-preview.N` a preview build. Internal hash builds (`-beta.00001b37`) are `other`.
 * `versionIsGame` is for packages whose own version is the game version (`@minecraft/vanilla-data`).
 */
export function parseNpmVersion(version: string, versionIsGame = false): NpmVersionInfo | undefined {
  const m = SEMVER_RE.exec(version);
  if (!m) return undefined;
  const base: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre = m[4];
  const mmp = `${m[1]}.${m[2]}.${m[3]}`;
  if (pre === undefined) {
    return versionIsGame
      ? { version, base, kind: "release", game: mmp, channel: "stable" }
      : { version, base, kind: "release" };
  }
  if (versionIsGame) {
    const p = GAME_PREVIEW_RE.exec(pre);
    if (p) return { version, base, kind: "preview", game: `${mmp}.${p[1]}`, channel: "preview" };
    return { version, base, kind: "other" };
  }
  const g = PRERELEASE_GAME_RE.exec(pre);
  if (!g) return { version, base, kind: "other" };
  const kind = g[1] as "beta" | "rc" | "preview";
  const suffix = g[4];
  // Old builds (`preview.1.19.60.22`) carry a four-part game version and no channel suffix.
  if (suffix === undefined) {
    if (g[3] === undefined) return { version, base, kind: "other" };
    return { version, base, kind, game: `${g[2]}.${g[3]}`, channel: "preview" };
  }
  if (suffix === "stable") return { version, base, kind, game: g[2], channel: "stable" };
  const build = g[5] ?? g[3];
  return { version, base, kind, game: build === undefined ? g[2] : `${g[2]}.${build}`, channel: "preview" };
}

function compareBase(a: NpmVersionInfo, b: NpmVersionInfo): number {
  return a.base[0] - b.base[0] || a.base[1] - b.base[1] || a.base[2] - b.base[2];
}

function compareGame(a: NpmVersionInfo, b: NpmVersionInfo): number {
  const ga = a.game ? parseGameVersion(a.game) : undefined;
  const gb = b.game ? parseGameVersion(b.game) : undefined;
  if (!ga || !gb) return ga ? 1 : gb ? -1 : 0;
  return compareGameVersions(ga, gb);
}

/** Newest by targeted game build, then by package semver. */
function newest(list: NpmVersionInfo[]): NpmVersionInfo | undefined {
  return list.reduce<NpmVersionInfo | undefined>(
    (best, v) => (!best || (compareGame(v, best) || compareBase(v, best)) > 0 ? v : best),
    undefined,
  );
}

const sameMmp = (game: string | undefined, target: GameVersion | undefined): boolean => {
  const g = game ? parseGameVersion(game) : undefined;
  return !!g && !!target && g.major === target.major && g.minor === target.minor && g.patch === target.patch;
};

/**
 * Pick the npm version for a channel.
 * - stable: the `latest` dist-tag when it is a plain release (else the newest plain release when no tag is
 *   given); `beta` → newest `-beta.<game>-stable`.
 * - preview: `-rc.<game>-preview.N` for the preview cycle (`previewTarget`); `beta` → `-beta.<game>-preview.N`.
 *   An rc from an older cycle is stale, so fall back to the stable release.
 * Packages whose `latest` is not a plain release (server-net, server-gametest, …: their only plain releases are
 * abandoned 0.x builds) resolve to their beta.
 */
export function pickNpmVersion(
  versions: readonly string[],
  opts: { channel: Channel; beta: boolean; versionIsGame?: boolean; previewTarget?: string; latest?: string },
): NpmVersionInfo | undefined {
  const infos = versions
    .map((v) => parseNpmVersion(v, opts.versionIsGame))
    .filter((v): v is NpmVersionInfo => !!v);
  const release =
    opts.latest !== undefined
      ? infos.find((v) => v.version === opts.latest && v.kind === "release")
      : infos
          .filter((v) => v.kind === "release")
          .reduce<NpmVersionInfo | undefined>((best, v) => (!best || compareBase(v, best) > 0 ? v : best), undefined);
  const stableBeta = newest(infos.filter((v) => v.kind === "beta" && v.channel === "stable"));
  const target = opts.previewTarget ? parseGameVersion(opts.previewTarget) : undefined;
  const previewOf = (kinds: NpmKind[]): NpmVersionInfo | undefined => {
    const cands = infos.filter((v) => kinds.includes(v.kind) && v.channel === "preview");
    const best = newest(cands);
    if (!best) return undefined;
    return !target || sameMmp(best.game, target) ? best : undefined;
  };
  if (opts.channel === "stable") {
    if (opts.beta) return stableBeta ?? release;
    return release ?? stableBeta;
  }
  const previewRelease = opts.versionIsGame ? previewOf(["preview"]) : previewOf(["rc"]);
  const previewBeta = previewOf(["beta"]);
  if (opts.beta) return previewBeta ?? previewRelease ?? stableBeta ?? release;
  if (previewRelease) return previewRelease;
  return release ?? previewBeta ?? stableBeta;
}

// ---------------------------------------------------------------------------------------------
// Changelog titles

/**
 * Game version from a feedback.minecraft.net changelog title, or undefined for non-Bedrock (Java) articles.
 * Marketing numbers (`26.62`, `26.70.23`) map to internal `1.26.62`, `1.26.70.23`.
 */
export function changelogTitleVersion(title: string): string | undefined {
  if (/java/i.test(title)) return undefined;
  const m = /(?<![\d.])(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?(?![\d.]*\d)/.exec(title);
  if (!m) return undefined;
  const nums = [m[1], m[2], m[3], m[4]].filter((x): x is string => x !== undefined).map(Number);
  if (nums[0] !== 1) nums.unshift(1);
  while (nums.length < 3) nums.push(0);
  return nums.slice(0, 4).join(".");
}

// ---------------------------------------------------------------------------------------------
// Pins

export interface SamplesTag {
  tag: string;
  version: string;
  channel: Channel;
  commit: string;
}

export interface NpmPin {
  version: string;
  /** Game build encoded in the npm version, if any. */
  game?: string;
  tarball: string;
  shasum: string;
  integrity?: string;
}

export interface ChannelPin {
  channel: Channel;
  /** Newest game build observed for the channel across all sources. */
  version: string;
  samples: SamplesTag & { date?: string };
  bds?: { version: string; linux?: string; windows?: string };
  /** Per package: the plain (`stable`) and `beta` resolution for this channel. */
  npm: Record<string, { default?: NpmPin; beta?: NpmPin }>;
  changelog?: { title: string; version: string; date: string; url: string };
}

export interface VersionPins {
  schema: 1;
  updatedAt: string;
  channels: Record<Channel, ChannelPin>;
  /** Every bedrock-samples release tag, newest first. */
  samplesTags: SamplesTag[];
}

export const pinsPath = (): string => cacheDir("knowledge", "versions.json");

export async function readPins(): Promise<VersionPins | undefined> {
  try {
    const pins = JSON.parse(await readFile(pinsPath(), "utf8")) as VersionPins;
    return pins.schema === 1 ? pins : undefined;
  } catch {
    return undefined;
  }
}

/** Pins older than this are re-resolved in the background. */
export const PINS_REFRESH_MS = CHECK_INTERVAL_MS;
let pinsFailure = 0;
let pinsRefresh: Promise<unknown> | undefined;

export interface GetPinsOptions {
  offline?: boolean;
  /** Clock and network, for tests. */
  now?: number;
  upstream?: PinsUpstream;
}

/**
 * Pins from cache; resolves them from upstream first when missing (unless offline). Cached pins a day old are
 * returned at once and re-resolved in the background; the next call sees the new pins.
 */
export async function getPins(opts: GetPinsOptions = {}): Promise<VersionPins> {
  const pins = await readPins();
  if (pins) {
    const now = opts.now ?? Date.now();
    const due = !(now - Date.parse(pins.updatedAt) < PINS_REFRESH_MS) && now - pinsFailure >= RETRY_AFTER_FAILURE_MS;
    if (!opts.offline && due && !pinsRefresh) {
      pinsRefresh = updatePins(opts)
        .catch((err: unknown) => {
          pinsFailure = now;
          progress(`version pins refresh failed (${err instanceof Error ? err.message : String(err)}); keeping pins from ${pins.updatedAt}`);
        })
        .finally(() => {
          pinsRefresh = undefined;
        });
    }
    return pins;
  }
  if (opts.offline) throw new OfflineMissingError("version pins");
  return updatePins(opts);
}

/** Test hook: wait for a background refresh `getPins` started, and forget the failure back-off. */
export async function settlePinsRefresh(): Promise<void> {
  await pinsRefresh;
  pinsFailure = 0;
}

const TAG_RE = /^v(\d+\.\d+\.\d+\.\d+)(-preview)?$/;

export function parseSamplesRemote(stdout: string): { tags: SamplesTag[]; heads: Record<string, string> } {
  const tags: SamplesTag[] = [];
  const heads: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const [commit, ref] = line.trim().split(/\s+/);
    if (!commit || !ref) continue;
    if (ref.startsWith("refs/heads/")) heads[ref.slice(11)] = commit;
    if (!ref.startsWith("refs/tags/") || ref.endsWith("^{}")) continue;
    const name = ref.slice(10);
    const m = TAG_RE.exec(name);
    if (m?.[1]) tags.push({ tag: name, version: m[1], channel: m[2] ? "preview" : "stable", commit });
  }
  tags.sort((a, b) => compareGameVersions(parseGameVersion(b.version)!, parseGameVersion(a.version)!));
  return { tags, heads };
}

export interface Packument {
  "dist-tags": Record<string, string>;
  versions: Record<string, { dist: { tarball: string; shasum: string; integrity?: string } }>;
}

export async function fetchPackument(pkg: string): Promise<Packument> {
  return httpJson<Packument>(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}`, {
    accept: "application/vnd.npm.install-v1+json",
  });
}

export function npmPin(doc: Packument, info: NpmVersionInfo | undefined): NpmPin | undefined {
  if (!info) return undefined;
  const dist = doc.versions[info.version]?.dist;
  if (!dist) return undefined;
  const pin: NpmPin = { version: info.version, tarball: dist.tarball, shasum: dist.shasum };
  if (info.game) pin.game = info.game;
  if (dist.integrity) pin.integrity = dist.integrity;
  return pin;
}

export interface BdsLinks {
  result: { links: { downloadType: string; downloadUrl: string }[] };
}

export interface ZendeskList {
  articles: { id: number; title: string; created_at: string; html_url: string }[];
}

/** Network side of `updatePins`, injectable for tests. */
export interface PinsUpstream {
  /** `git ls-remote --tags --heads` of bedrock-samples, parsed. */
  samples(): Promise<{ tags: SamplesTag[]; heads: Record<string, string> }>;
  bdsLinks(): Promise<BdsLinks>;
  packument(pkg: string): Promise<Packument>;
  /** The newest changelog articles of a channel's section. */
  changelogs(channel: Channel): Promise<ZendeskList>;
  /** bedrock-samples `version.json` on the channel's branch. */
  branchVersion(channel: Channel): Promise<{ latest?: { version: string; date: string } }>;
}

const liveUpstream: PinsUpstream = {
  samples: async () => parseSamplesRemote((await runOk("git", ["ls-remote", "--tags", "--heads", SAMPLES_REPO])).stdout),
  bdsLinks: () => httpJson<BdsLinks>(BDS_LINKS_URL),
  packument: fetchPackument,
  changelogs: (c) => httpJson<ZendeskList>(`${zendeskArticlesUrl(c)}?per_page=10&sort_by=created_at&sort_order=desc`),
  branchVersion: (c) =>
    httpJson(`https://raw.githubusercontent.com/Mojang/bedrock-samples/${c === "stable" ? "main" : "preview"}/version.json`),
};

function maxVersion(versions: (string | undefined)[]): string {
  const parsed = versions.map((v) => (v ? parseGameVersion(v) : undefined)).filter((v): v is GameVersion => !!v);
  parsed.sort(compareGameVersions);
  const last = parsed.at(-1);
  if (!last) throw new Error("no version resolved");
  return formatGameVersion(last);
}

async function settle<T>(what: string, p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (err) {
    progress(`warning: ${what}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Query every upstream source and write the pin file. Samples tags are required; other sources degrade. */
export function updatePins(opts: { now?: number; upstream?: PinsUpstream } = {}): Promise<VersionPins> {
  const up = opts.upstream ?? liveUpstream;
  return single("pins", async () => {
    progress("resolving stable and preview versions (bedrock-samples tags, npm, BDS, changelogs)");
    const [remote, bds, packuments, ...changelogs] = await Promise.all([
      up.samples(),
      settle("BDS download links", up.bdsLinks()),
      Promise.all(TYPINGS_PACKAGES.map(async (p) => [p, await settle(`npm ${p}`, up.packument(p))] as const)),
      ...CHANNELS.map((c) => settle(`changelogs ${c}`, up.changelogs(c))),
    ]);
    const previous = await readPins();
    const channels = {} as Record<Channel, ChannelPin>;
    for (const [i, channel] of CHANNELS.entries()) {
      const head = remote.heads[channel === "stable" ? "main" : "preview"];
      const samples =
        remote.tags.find((t) => t.commit === head) ?? remote.tags.find((t) => t.channel === channel);
      if (!samples) throw new Error(`no bedrock-samples tag found for ${channel}`);
      let date: string | undefined;
      const branchVersion = await settle(`bedrock-samples ${channel} version.json`, up.branchVersion(channel));
      if (branchVersion?.latest?.version === samples.version) date = toIsoDate(branchVersion.latest.date);

      const links = bds?.result.links ?? [];
      const linkFor = (type: string): string | undefined => links.find((l) => l.downloadType === type)?.downloadUrl;
      const prefix = channel === "stable" ? "serverBedrock" : "serverBedrockPreview";
      const linux = linkFor(`${prefix}Linux`);
      const windows = linkFor(`${prefix}Windows`);
      const bdsVersion = /bedrock-server-([\d.]+)\.zip/.exec(linux ?? windows ?? "")?.[1];

      const article = changelogs[i]?.articles
        .map((a) => ({ a, version: changelogTitleVersion(a.title) }))
        .find((x) => x.version);
      const previewTarget = channel === "preview" ? samples.version : undefined;

      const npm: ChannelPin["npm"] = {};
      for (const [pkg, doc] of packuments) {
        if (!doc) {
          const old = previous?.channels[channel]?.npm[pkg];
          if (old) npm[pkg] = old;
          continue;
        }
        const versions = Object.keys(doc.versions);
        const versionIsGame = pkg === "@minecraft/vanilla-data";
        const latest = doc["dist-tags"].latest ?? "";
        npm[pkg] = {
          default: npmPin(doc, pickNpmVersion(versions, { channel, beta: false, versionIsGame, previewTarget, latest })),
          beta: npmPin(doc, pickNpmVersion(versions, { channel, beta: true, versionIsGame, previewTarget, latest })),
        };
      }

      const pin: ChannelPin = {
        channel,
        version: maxVersion([samples.version, bdsVersion, article?.version]),
        samples: date ? { ...samples, date } : samples,
        npm,
      };
      if (bdsVersion) pin.bds = { version: bdsVersion, linux, windows };
      else if (previous?.channels[channel]?.bds) pin.bds = previous.channels[channel].bds;
      if (article?.version) {
        pin.changelog = {
          title: article.a.title,
          version: article.version,
          date: article.a.created_at,
          url: article.a.html_url,
        };
      }
      channels[channel] = pin;
    }
    const pins: VersionPins = { schema: 1, updatedAt: new Date(opts.now ?? Date.now()).toISOString(), channels, samplesTags: remote.tags };
    await writeJsonAtomic(pinsPath(), pins);
    progress(`pinned stable ${channels.stable.version}, preview ${channels.preview.version}`);
    return pins;
  });
}

/** `15-09-2026` → `2026-09-15`. */
function toIsoDate(dmy: string): string {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(dmy);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : dmy;
}

/** Find the samples tag for a requested game version (exact, else newest with that version prefix). */
export function findSamplesTag(pins: VersionPins, channel: Channel, version?: string): SamplesTag | undefined {
  if (!version) return pins.channels[channel].samples;
  const want = version.replace(/^v/, "").replace(/-preview$/, "");
  const exact = pins.samplesTags.find((t) => t.version === want);
  if (exact) return exact;
  return pins.samplesTags.find((t) => t.version.startsWith(`${want}.`) && t.channel === channel);
}
