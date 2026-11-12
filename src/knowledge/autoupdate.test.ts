/** Data sources follow their upstream on their own: fake upstreams and a temp cache, no network. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { backgroundDownloadsAllowed } from "../core/background.ts";
import { isInFlight } from "./net.ts";
import { ensureBedrockSamples, writeSamplesMarker } from "./samples.ts";
import { formatSources, sourceStatus } from "./store.ts";
import { CHECK_INTERVAL_MS } from "./tracked.ts";
import { ensureTypings, writeTypingsMeta } from "./typings.ts";
import { getPins, type PinsUpstream, readPins, settlePinsRefresh, updatePins } from "./versions.ts";

const work = mkdtempSync(join(tmpdir(), "sculk-autoupdate-test-"));
const cache = join(work, "cache");
const prevCache = process.env.SCULKWIRE_CACHE;
process.env.SCULKWIRE_CACHE = cache;
afterAll(() => {
  if (prevCache === undefined) delete process.env.SCULKWIRE_CACHE;
  else process.env.SCULKWIRE_CACHE = prevCache;
  rmSync(work, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-01T00:00:00Z");
const DAY = CHECK_INTERVAL_MS;

/** bedrock-samples, npm, BDS and changelogs as one fake upstream; `state` is what it publishes now. */
function fakeUpstream(state: { stable: string; fail?: boolean }) {
  const calls = { samples: 0 };
  const commit = (v: string) => v.replace(/\D/g, "").padEnd(40, "0").slice(0, 40);
  const upstream: PinsUpstream = {
    async samples() {
      calls.samples++;
      if (state.fail) throw new Error("network down");
      const tags = [
        { tag: `v${state.stable}`, version: state.stable, channel: "stable" as const, commit: commit(state.stable) },
        { tag: "v1.26.70.20-preview", version: "1.26.70.20", channel: "preview" as const, commit: commit("1.26.70.20p") },
      ];
      return { tags, heads: { main: commit(state.stable), preview: commit("1.26.70.20p") } };
    },
    bdsLinks: async () => ({
      result: { links: [{ downloadType: "serverBedrockLinux", downloadUrl: `https://example.invalid/bedrock-server-${state.stable}.zip` }] },
    }),
    packument: async () => ({
      "dist-tags": { latest: "2.0.0" },
      versions: { "2.0.0": { dist: { tarball: "https://example.invalid/server-2.0.0.tgz", shasum: "0".repeat(40) } } },
    }),
    changelogs: async () => ({ articles: [] }),
    branchVersion: async () => ({}),
  };
  return { upstream, calls };
}

beforeEach(() => {
  rmSync(cache, { recursive: true, force: true });
});

describe("version pins", () => {
  it("answer at once and re-resolve in the background once a day; a new release is used by the next call", async () => {
    const state = { stable: "1.26.60.5" };
    const { upstream, calls } = fakeUpstream(state);
    await updatePins({ now: T0, upstream });
    state.stable = "1.26.61.1";

    // Within the day: no check.
    expect((await getPins({ now: T0 + DAY - 1, upstream })).channels.stable.samples.tag).toBe("v1.26.60.5");
    await settlePinsRefresh();
    expect(calls.samples).toBe(1);

    // Due: the call still gets the cached pins; the refresh lands for the next one.
    expect((await getPins({ now: T0 + DAY, upstream })).channels.stable.samples.tag).toBe("v1.26.60.5");
    await settlePinsRefresh();
    expect(calls.samples).toBe(2);
    const next = await getPins({ now: T0 + DAY + 1, upstream });
    expect(next.channels.stable).toMatchObject({ version: "1.26.61.1", samples: { tag: "v1.26.61.1" }, bds: { version: "1.26.61.1" } });
    expect(next.updatedAt).toBe(new Date(T0 + DAY).toISOString());
  });

  it("keep the last pins when the refresh fails or the call is offline", async () => {
    const state = { stable: "1.26.60.5", fail: false };
    const { upstream, calls } = fakeUpstream(state);
    await updatePins({ now: T0, upstream });
    state.fail = true;
    await getPins({ now: T0 + 2 * DAY, upstream, offline: true });
    await settlePinsRefresh();
    expect(calls.samples).toBe(1);
    expect((await getPins({ now: T0 + 2 * DAY, upstream })).channels.stable.samples.tag).toBe("v1.26.60.5");
    await settlePinsRefresh();
    expect(calls.samples).toBe(2);
    expect((await readPins())?.updatedAt).toBe(new Date(T0).toISOString());
  });
});

describe("cached copies keep answering while a newer one is missing", () => {
  it("bedrock-samples: the previous checkout of the channel serves a newly pinned tag (offline)", async () => {
    const { upstream } = fakeUpstream({ stable: "1.26.61.1" });
    await updatePins({ now: Date.now(), upstream });
    const old = join(cache, "knowledge", "samples", "v1.26.60.5");
    mkdirSync(join(old, "metadata"), { recursive: true });
    await writeSamplesMarker(old, { tag: "v1.26.60.5", commit: "x", parts: ["metadata"], images: false });
    const r = await ensureBedrockSamples({ channel: "stable", offline: true, parts: ["metadata"] });
    expect(r).toMatchObject({ tag: "v1.26.60.5", version: "1.26.60.5", root: old });
    // An explicitly requested version is never substituted.
    await expect(ensureBedrockSamples({ channel: "stable", version: "1.26.61.1", offline: true, parts: ["metadata"] })).rejects.toThrow(/not cached/);
  });

  it("a CLI process answers from the previous checkout and leaves the new tag to the MCP server", async () => {
    expect(backgroundDownloadsAllowed()).toBe(false);
    const { upstream } = fakeUpstream({ stable: "1.26.61.1" });
    await updatePins({ now: Date.now(), upstream });
    const old = join(cache, "knowledge", "samples", "v1.26.60.5");
    mkdirSync(join(old, "metadata"), { recursive: true });
    await writeSamplesMarker(old, { tag: "v1.26.60.5", commit: "x", parts: ["metadata"], images: false });
    // Online: the previous checkout answers and no checkout of the new tag is started (`checkout` runs under `single`).
    expect(await ensureBedrockSamples({ channel: "stable", parts: ["metadata"] })).toMatchObject({ tag: "v1.26.60.5" });
    expect(isInFlight("samples:v1.26.61.1")).toBe(false);
  });

  it("typings: a failed install of newly pinned builds falls back to the previous install", async () => {
    const { upstream } = fakeUpstream({ stable: "1.26.61.1" });
    await updatePins({ now: Date.now(), upstream });
    const prev = join(cache, "knowledge", "typings", "previous0000000");
    mkdirSync(join(prev, "node_modules", "@minecraft", "server"), { recursive: true });
    await writeTypingsMeta(prev, { channel: "stable", beta: false, packages: { "@minecraft/server": "1.9.0" } });
    const t = await ensureTypings({ channel: "stable", offline: true });
    expect(t).toMatchObject({ nodeModulesDir: join(prev, "node_modules"), packages: { "@minecraft/server": "1.9.0" } });
    // Requested module versions the previous install lacks are not substituted.
    await expect(ensureTypings({ channel: "stable", offline: true, modules: { "@minecraft/server": "2.0.0" } })).rejects.toThrow();
  });
});

describe("knowledge status", () => {
  it("reports per source the version in use, the newest upstream and the last check", async () => {
    const { upstream } = fakeUpstream({ stable: "1.26.61.1" });
    const pins = await updatePins({ now: T0, upstream });
    const sources = await sourceStatus(pins);
    expect(sources.find((s) => s.source === "bedrock-samples" && s.channel === "stable")).toMatchObject({ latest: "v1.26.61.1", checkedAt: new Date(T0).toISOString() });
    expect(sources.find((s) => s.source === "rockide/schemas")?.inUse).toBeUndefined();
    const text = formatSources(sources).join("\n");
    expect(text).toContain("bedrock-samples stable: not cached, newest v1.26.61.1, checked 2026-11-01T00:00:00.000Z");
    expect(JSON.parse(readFileSync(join(cache, "knowledge", "versions.json"), "utf8")).updatedAt).toBe(new Date(T0).toISOString());
  });
});
