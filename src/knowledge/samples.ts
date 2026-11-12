/**
 * Mojang/bedrock-samples at an exact release tag, fetched at runtime into the cache and never bundled.
 * One blobless, depth-1, sparse checkout per tag under `cacheDir('knowledge','samples',<tag>)`. The channel's tag
 * comes from the version pins (re-resolved daily); while a newly pinned tag is not checked out yet, the newest cached
 * checkout of the channel keeps answering and the MCP server checks out the new tag in the background.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { backgroundDownloadsAllowed } from "../core/background.ts";
import { cacheDir } from "../core/paths.ts";
import { type Channel, compareGameVersions, parseGameVersion } from "../core/version.ts";
import { readJsonOr, writeJsonAtomic } from "../core/fs.ts";
import { setSparse, sparseClone } from "./git.ts";
import { OfflineMissingError, progress, single } from "./net.ts";
import { upstreamBackoff } from "./tracked.ts";
import { findSamplesTag, getPins, SAMPLES_REPO, type SamplesTag, updatePins } from "./versions.ts";

export type SamplesPart = "metadata" | "behavior_pack" | "resource_pack";
const DEFAULT_PARTS: SamplesPart[] = ["metadata", "behavior_pack", "resource_pack"];
/** Binary assets skipped unless `images` is requested (they are ~70% of the resource pack). */
const BINARY_EXTS = ["png", "tga", "jpg", "jpeg", "hdr", "pdn", "psd", "fsb", "ogg", "wav", "mp3"];

export interface EnsureSamplesOptions {
  channel: Channel;
  /** Game version (`1.26.60.5`, `1.26.70.23`, or a prefix like `1.26.60`); default: the channel pin. */
  version?: string;
  offline?: boolean;
  parts?: SamplesPart[];
  /** Also check out textures and sounds. */
  images?: boolean;
}

export interface SamplesCheckout {
  root: string;
  channel: Channel;
  version: string;
  tag: string;
}

/** What a checkout holds: written into it once its sparse checkout is complete. */
export interface SamplesMarker {
  tag: string;
  commit: string;
  parts: SamplesPart[];
  images: boolean;
}

const MARKER = ".sculkwire-samples.json";

const samplesDir = (tag: string): string => cacheDir("knowledge", "samples", tag);

const readMarker = (root: string): Promise<SamplesMarker | undefined> => readJsonOr<SamplesMarker>(join(root, MARKER));

/** Record that the checkout at `root` holds `marker.parts`. */
export function writeSamplesMarker(root: string, marker: SamplesMarker): Promise<void> {
  return writeJsonAtomic(join(root, MARKER), marker);
}

/** Every cached checkout of the channel by tag, with the parts it holds (none while incomplete); no network. */
export async function samplesStatus(channel: Channel): Promise<{ tag: string; parts?: SamplesPart[] }[]> {
  const out: { tag: string; parts?: SamplesPart[] }[] = [];
  for (const tag of await readdir(cacheDir("knowledge", "samples")).catch(() => [] as string[])) {
    if (tag.startsWith(".") || (channel === "preview" ? !tag.endsWith("-preview") : tag.endsWith("-preview"))) continue;
    const marker = await readMarker(samplesDir(tag));
    out.push(marker ? { tag, parts: marker.parts } : { tag });
  }
  return out;
}

function patterns(parts: SamplesPart[], images: boolean): string[] {
  const out = ["/version.json", ...parts.map((p) => `/${p}/`)];
  if (!images) {
    for (const p of parts) {
      if (p === "metadata") continue;
      for (const ext of BINARY_EXTS) out.push(`!/${p}/**/*.${ext}`);
    }
  }
  return out;
}

const satisfies = (marker: SamplesMarker | undefined, parts: SamplesPart[], images: boolean): boolean =>
  !!marker && parts.every((p) => marker.parts.includes(p)) && (marker.images || !images);

/** The newest complete checkout of the channel (other than `except`) that has `parts`, without network. */
export async function newestCachedSamples(channel: Channel, parts: SamplesPart[] = [], images = false, except?: string): Promise<SamplesCheckout | undefined> {
  let best: SamplesCheckout | undefined;
  for (const tag of await readdir(cacheDir("knowledge", "samples")).catch(() => [] as string[])) {
    const m = /^v(\d+\.\d+\.\d+\.\d+)(-preview)?$/.exec(tag);
    if (!m?.[1] || tag === except || (m[2] ? "preview" : "stable") !== channel) continue;
    if (!satisfies(await readMarker(samplesDir(tag)), parts, images)) continue;
    const version = parseGameVersion(m[1]);
    const bestVersion = best && parseGameVersion(best.version);
    if (version && (!bestVersion || compareGameVersions(version, bestVersion) > 0)) best = { root: samplesDir(tag), channel, version: m[1], tag };
  }
  return best;
}

/** Check out (or extend) the tag so it has `parts`. */
function checkout(found: SamplesTag, parts: SamplesPart[], images: boolean): Promise<void> {
  const root = samplesDir(found.tag);
  return single(`samples:${found.tag}`, async () => {
    const marker = await readMarker(root);
    if (satisfies(marker, parts, images)) return;
    if (!marker) {
      progress(`checking out bedrock-samples ${found.tag} (${parts.join(", ")}${images ? ", images" : ""})`);
      const commit = await sparseClone(root, { url: SAMPLES_REPO, ref: found.tag, patterns: patterns(parts, images) });
      await writeSamplesMarker(root, { tag: found.tag, commit, parts, images });
      return;
    }
    const allParts = [...new Set([...marker.parts, ...parts])];
    const allImages = marker.images || images;
    progress(`extending bedrock-samples ${found.tag} to ${allParts.join(", ")}${allImages ? ", images" : ""}`);
    await setSparse(root, patterns(allParts, allImages));
    await writeSamplesMarker(root, { ...marker, parts: allParts, images: allImages });
  });
}

export async function ensureBedrockSamples(opts: EnsureSamplesOptions): Promise<SamplesCheckout> {
  const parts = opts.parts?.length ? opts.parts : DEFAULT_PARTS;
  const images = opts.images ?? false;
  let pins = await getPins({ offline: opts.offline });
  let tag = findSamplesTag(pins, opts.channel, opts.version);
  if (!tag && opts.version && !opts.offline) {
    pins = await updatePins();
    tag = findSamplesTag(pins, opts.channel, opts.version);
  }
  if (!tag) throw new Error(`no bedrock-samples release tag matches ${opts.version ?? opts.channel}`);
  const found = tag;
  const result: SamplesCheckout = { root: samplesDir(found.tag), channel: found.channel, version: found.version, tag: found.tag };
  if (satisfies(await readMarker(result.root), parts, images)) return result;

  // The channel's newest tag (no explicit version) is not checked out yet: answer from the previous one.
  const previous = opts.version ? undefined : await newestCachedSamples(opts.channel, parts, images, found.tag);
  if (previous) {
    if (!opts.offline && backgroundDownloadsAllowed()) {
      upstreamBackoff.background(
        `samples:${found.tag}`,
        () => checkout(found, parts, images),
        (reason) => `bedrock-samples ${found.tag} checkout failed (${reason}); using ${previous.tag}`,
      );
    }
    return previous;
  }
  if (opts.offline) throw new OfflineMissingError(`bedrock-samples ${found.tag} (${parts.join(", ")})`);
  await checkout(found, parts, images);
  return result;
}
