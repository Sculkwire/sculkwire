/**
 * Whole-cache operations: `update` refreshes every artifact now, `status` reports what is cached, for which build,
 * and per data source the version in use, the newest seen upstream and the last check. Without `update`, every
 * source follows its upstream on its own (checked at most daily; see `docs/tools.md`).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "../core/paths.ts";
import { type Channel, CHANNELS } from "../core/version.ts";
import { listInstalled, updateBds } from "../runtime/bds/install.ts";
import { changelogIndex, changelogStatus, fetchChangelogs } from "./changelog.ts";
import { docsIndex, docsStatus, ensureCreatorDocs } from "./docs.ts";
import { progress } from "./net.ts";
import { ensureRockideSchemas, rockideStatus } from "./rockide.ts";
import { ensureBedrockSamples, newestCachedSamples, samplesDir } from "./samples.ts";
import { ensureTypings, typingsStatus } from "./typings.ts";
import { type ChannelPin, readPins, updatePins, type VersionPins } from "./versions.ts";

export interface UpdateReport {
  pins: VersionPins;
  /** `all` for channel-independent artifacts (rockide/schemas). */
  steps: { channel: Channel | "all"; step: string; ok: boolean; detail: string }[];
}

/** Refresh pins and every artifact for the given channels. Failures are reported per step, not thrown. */
export async function updateKnowledge(channels: readonly Channel[] = CHANNELS): Promise<UpdateReport> {
  const pins = await updatePins();
  const steps: UpdateReport["steps"] = [];
  const step = async (channel: Channel | "all", name: string, fn: () => Promise<string>) => {
    try {
      steps.push({ channel, step: name, ok: true, detail: await fn() });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      progress(`${channel} ${name} failed: ${detail}`);
      steps.push({ channel, step: name, ok: false, detail });
    }
  };
  await Promise.all([
    step("all", "rockide", async () => {
      const r = await ensureRockideSchemas({ refresh: true });
      if (r.stale) throw new Error(`update failed (${r.stale}); kept ${r.release}`);
      return `${r.release} (${r.commit.slice(0, 10)})`;
    }),
    ...channels.map(async (channel) => {
      // The pinned tag itself: without `version` a cached older tag would answer and the new one would wait.
      await step(channel, "samples", async () => (await ensureBedrockSamples({ channel, version: pins.channels[channel].samples.version })).tag);
      await step(channel, "typings", async () => (await ensureTypings({ channel })).packages["@minecraft/server"] ?? "");
      await step(
        channel,
        "typings-beta",
        async () => (await ensureTypings({ channel, beta: true })).packages["@minecraft/server"] ?? "",
      );
      await step(channel, "docs", async () => {
        await ensureCreatorDocs({ channel, refresh: true });
        const { checkout, index } = await docsIndex(channel);
        return `${checkout.docsVersion} (${index.docs.size} chunks)`;
      });
      await step(channel, "changelogs", async () => {
        const articles = await fetchChangelogs(channel);
        const index = await changelogIndex(channel, articles);
        return `${articles.length} articles (${index.docs.size} chunks)`;
      });
      await step(channel, "bds", async () => (await updateBds(channel, progress))?.version ?? "not installed");
    }),
  ]);
  return { pins, steps };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** One external data source: what is used, what upstream has, when upstream was last asked. */
export interface SourceStatus {
  source: string;
  channel?: Channel;
  /** Version in use (cached copy); absent when nothing is cached. */
  inUse?: string;
  /** Newest version seen upstream at the last check. */
  latest?: string;
  /** Last check of the upstream (ISO time). */
  checkedAt?: string;
  note?: string;
}

/** Every external source, read from the cache only (no network). */
export async function sourceStatus(pins?: VersionPins): Promise<SourceStatus[]> {
  const out: SourceStatus[] = [
    {
      source: "version pins",
      inUse: pins ? `stable ${pins.channels.stable.version}, preview ${pins.channels.preview.version}` : undefined,
      checkedAt: pins?.updatedAt,
      note: "bedrock-samples tags, npm builds, BDS links and changelog titles; samples, typings, BDS and changelogs follow them",
    },
  ];
  const rockide = await rockideStatus();
  out.push({
    source: "rockide/schemas",
    inUse: rockide?.release,
    latest: rockide?.latest,
    checkedAt: rockide?.checkedAt,
    note: rockide?.error ? `update failed: ${rockide.error}` : undefined,
  });
  for (const channel of CHANNELS) {
    const pin = pins?.channels[channel];
    const checkedAt = pins?.updatedAt;
    out.push({ source: "bedrock-samples", channel, inUse: (await newestCachedSamples(channel))?.tag, latest: pin?.samples.tag, checkedAt });
    const npm = pin?.npm["@minecraft/server"];
    for (const beta of [false, true]) {
      const latest = (beta ? (npm?.beta ?? npm?.default) : (npm?.default ?? npm?.beta))?.version;
      out.push({
        source: beta ? "@minecraft/* typings (beta)" : "@minecraft/* typings",
        channel,
        inUse: (await typingsStatus(channel, beta, latest))?.["@minecraft/server"],
        latest,
        checkedAt,
      });
    }
    const docs = await docsStatus(channel);
    out.push({
      source: "minecraft-creator docs",
      channel,
      inUse: docs?.docsVersion,
      latest: docs?.head ? `main@${docs.head.slice(0, 10)}` : undefined,
      checkedAt: docs?.checkedAt,
      note: docs ? `checkout ${docs.commit.slice(0, 10)}` : undefined,
    });
    out.push({ source: "changelogs", channel, inUse: (await changelogStatus(channel))?.newest, latest: pin?.changelog?.version, checkedAt });
    const [bds] = await listInstalled(channel);
    out.push({ source: "BDS", channel, inUse: bds?.version, latest: pin?.bds?.version, checkedAt });
  }
  return out;
}

/** Text lines for `sourceStatus`, shared by the CLI and `knowledge_versions`. */
export function formatSources(sources: SourceStatus[]): string[] {
  return sources.map((s) => {
    const newest = s.latest && s.latest !== s.inUse ? `, newest ${s.latest}` : "";
    return `${s.source}${s.channel ? ` ${s.channel}` : ""}: ${s.inUse ?? "not cached"}${newest}${s.checkedAt ? `, checked ${s.checkedAt}` : ", never checked"}`;
  });
}

export interface ChannelStatus {
  channel: Channel;
  version?: string;
  pin?: ChannelPin;
  samples: { tag: string; cached: boolean; parts?: string[] }[];
  docs?: { docsVersion: string; commit: string };
  changelogs?: number;
}

export interface KnowledgeStatus {
  cacheDir: string;
  updatedAt?: string;
  channels: ChannelStatus[];
  rockide?: { release: string; commit: string; fetchedAt: string; checkedAt: string; latest: string };
  sources: SourceStatus[];
}

export async function knowledgeStatus(): Promise<KnowledgeStatus> {
  const pins = await readPins();
  const cachedTags = await readdir(cacheDir("knowledge", "samples")).catch(() => [] as string[]);
  const channels: ChannelStatus[] = [];
  for (const channel of CHANNELS) {
    const pin = pins?.channels[channel];
    const status: ChannelStatus = { channel, samples: [] };
    if (pin) {
      status.version = pin.version;
      status.pin = pin;
    }
    for (const tag of cachedTags.filter((t) => !t.startsWith("."))) {
      if (channel === "preview" ? !tag.endsWith("-preview") : tag.endsWith("-preview")) continue;
      const marker = join(samplesDir(tag), ".sculkwire-samples.json");
      const parts = (await exists(marker))
        ? (JSON.parse(await readFile(marker, "utf8")) as { parts: string[] }).parts
        : undefined;
      status.samples.push(parts ? { tag, cached: true, parts } : { tag, cached: false });
    }
    const docs = await docsStatus(channel);
    if (docs) status.docs = { docsVersion: docs.docsVersion, commit: docs.commit };
    const changelogs = await changelogStatus(channel);
    if (changelogs) status.changelogs = changelogs.count;
    channels.push(status);
  }
  const result: KnowledgeStatus = { cacheDir: cacheDir("knowledge"), channels, sources: await sourceStatus(pins) };
  if (pins) result.updatedAt = pins.updatedAt;
  const r = await rockideStatus();
  if (r) result.rockide = { release: r.release, commit: r.commit, fetchedAt: r.fetchedAt, checkedAt: r.checkedAt, latest: r.latest };
  return result;
}
