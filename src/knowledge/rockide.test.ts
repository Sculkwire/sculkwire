import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { E, writeRockideTree } from "../testing/rockidetree.ts";
import { OfflineMissingError } from "./net.ts";
import { CHECK_INTERVAL_MS, upstreamBackoff } from "./tracked.ts";
import {
  ensureRockideSchemas,
  formatRockide,
  lookupRockide,
  newestRelease,
  type RockideFetcher,
  rockideComponent,
  rockideStatus,
} from "./rockide.ts";

const work = mkdtempSync(join(tmpdir(), "sculk-rockide-test-"));
const tree = join(work, "tree");
const cache = join(work, "cache");
const prevCache = process.env.SCULKWIRE_CACHE;
process.env.SCULKWIRE_CACHE = cache;
afterAll(() => {
  if (prevCache === undefined) delete process.env.SCULKWIRE_CACHE;
  else process.env.SCULKWIRE_CACHE = prevCache;
  rmSync(work, { recursive: true, force: true });
});

writeRockideTree(tree);

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const SHA3 = "3".repeat(40);
const COMMITS: Record<string, string> = { "0.1.3": SHA1, "0.1.4": SHA2, "0.2.0": SHA3 };

/** A fake GitHub: `state.tag` is the newest release; `fail` breaks the check, `failDownload` the tarball. */
function fakeFetcher(state: { tag: string; fail?: boolean; failDownload?: boolean }) {
  const calls = { latest: 0, download: 0 };
  const fetcher: RockideFetcher = {
    async latest() {
      calls.latest++;
      if (state.fail) throw new Error("network down");
      return { version: state.tag, commit: COMMITS[state.tag] as string };
    },
    async download(_release, dest) {
      calls.download++;
      cpSync(tree, dest, { recursive: true });
      // A partial download: the tree without `scripts/compile.ts`.
      if (state.failDownload) rmSync(join(dest, "scripts"), { recursive: true, force: true });
    },
  };
  return { fetcher, calls };
}

const T0 = Date.parse("2026-11-01T00:00:00Z");
const DAY = CHECK_INTERVAL_MS;

describe("rockide release tracking", () => {
  beforeEach(() => {
    rmSync(cache, { recursive: true, force: true });
    upstreamBackoff.reset("rockide");
  });

  it("picks the newest x.y.z tag from git ls-remote, peeled commits first, pre-releases skipped", () => {
    const out = [
      `${SHA1}\trefs/tags/0.1.10`,
      `${SHA2}\trefs/tags/0.1.9`,
      `${"a".repeat(40)}\trefs/tags/v0.2.0`,
      `${SHA3}\trefs/tags/v0.2.0^{}`,
      `${"b".repeat(40)}\trefs/tags/0.3.0-beta.1`,
    ].join("\n");
    expect(newestRelease(out)).toEqual({ version: "v0.2.0", commit: SHA3 });
    expect(newestRelease(`${SHA1}\trefs/tags/nightly`)).toBeUndefined();
  });

  it("offline without a copy throws; the lookup fails open with a note", async () => {
    const { fetcher, calls } = fakeFetcher({ tag: "0.1.3" });
    await expect(ensureRockideSchemas({ offline: true, fetcher })).rejects.toBeInstanceOf(OfflineMissingError);
    const r = await lookupRockide("minecraft:health", "1.26.60", { offline: true, fetcher });
    expect(r.matches).toEqual([]);
    expect(r.note).toMatch(/unavailable/);
    expect(calls.latest).toBe(0);
  });

  it("downloads once, re-checks at most once a day, and switches when a new release appears", async () => {
    const state = { tag: "0.1.3" };
    const { fetcher, calls } = fakeFetcher(state);
    const first = await ensureRockideSchemas({ fetcher, now: T0 });
    expect(first).toMatchObject({ release: { version: "0.1.3", commit: SHA1 }, latest: "0.1.3" });
    expect(first.root).toBe(join(cache, "knowledge", "rockide", "0.1.3"));
    expect(existsSync(join(first.root, "schema", "bedrock"))).toBe(true);
    expect(calls).toEqual({ latest: 1, download: 1 });

    // A new release within the day is not seen yet.
    state.tag = "0.1.4";
    expect((await ensureRockideSchemas({ fetcher, now: T0 + DAY - 1 })).release.version).toBe("0.1.3");
    expect(calls).toEqual({ latest: 1, download: 1 });

    // The next due check switches to it; the previous release is kept for readers still using it.
    const next = await ensureRockideSchemas({ fetcher, now: T0 + DAY });
    expect(next).toMatchObject({ release: { version: "0.1.4", commit: SHA2 }, checkedAt: new Date(T0 + DAY).toISOString(), fetchedAt: new Date(T0 + DAY).toISOString() });
    expect(calls).toEqual({ latest: 2, download: 2 });

    // Due, unchanged release: only the check runs.
    const same = await ensureRockideSchemas({ fetcher, now: T0 + 2 * DAY });
    expect(calls).toEqual({ latest: 3, download: 2 });
    expect(same.fetchedAt).toBe(new Date(T0 + DAY).toISOString());

    // `refresh` checks now; older copies than the previous one are pruned.
    state.tag = "0.2.0";
    expect((await ensureRockideSchemas({ fetcher, now: T0 + 2 * DAY + 1, refresh: true })).release.version).toBe("0.2.0");
    const base = join(cache, "knowledge", "rockide");
    expect(["0.1.3", "0.1.4", "0.2.0"].map((t) => existsSync(join(base, t)))).toEqual([false, true, true]);
    expect(JSON.parse(readFileSync(join(base, "current.json"), "utf8")).release).toEqual({ version: "0.2.0", commit: SHA3 });
    expect(await rockideStatus()).toMatchObject({ release: { version: "0.2.0" }, latest: "0.2.0", checkedAt: new Date(T0 + 2 * DAY + 1).toISOString() });
  });

  it("offline or a failed check keeps the cached copy", async () => {
    const state = { tag: "0.1.3", fail: false };
    const { fetcher, calls } = fakeFetcher(state);
    await ensureRockideSchemas({ fetcher, now: T0 });
    state.fail = true;
    const offline = await ensureRockideSchemas({ fetcher, now: T0 + 2 * DAY, offline: true });
    expect(offline.release.version).toBe("0.1.3");
    expect(offline.stale).toBeUndefined();
    expect(calls.latest).toBe(1);

    const failed = await ensureRockideSchemas({ fetcher, now: T0 + 2 * DAY });
    expect(failed).toMatchObject({ release: { version: "0.1.3" }, stale: "network down" });
    expect(calls.latest).toBe(2);
    // Back-off: the next due call does not retry within the hour.
    expect((await ensureRockideSchemas({ fetcher, now: T0 + 2 * DAY + 1000 })).stale).toBeDefined();
    expect(calls.latest).toBe(2);
    const lookup = await lookupRockide("minecraft:health", "1.26.60", { fetcher, now: T0 + 2 * DAY + 2000 });
    expect(lookup).toMatchObject({ release: "0.1.3", note: expect.stringMatching(/update failed/) });
    expect(lookup.matches).toHaveLength(1);
  });

  it("a failed download keeps the old copy and records the newer release", async () => {
    const state = { tag: "0.1.3", failDownload: false };
    const { fetcher } = fakeFetcher(state);
    const old = await ensureRockideSchemas({ fetcher, now: T0 });
    state.tag = "0.1.4";
    state.failDownload = true;
    const r = await ensureRockideSchemas({ fetcher, now: T0 + DAY });
    expect(r).toMatchObject({ release: { version: "0.1.3" }, root: old.root, latest: "0.1.4", stale: expect.stringMatching(/incomplete/) });
    expect(existsSync(join(old.root, "scripts", "compile.ts"))).toBe(true);
    expect(existsSync(join(cache, "knowledge", "rockide", "0.1.4"))).toBe(false);
    expect(await rockideStatus()).toMatchObject({ release: { version: "0.1.3" }, latest: "0.1.4", error: expect.stringMatching(/incomplete/) });

    // The next process retries (the check time was not advanced) and switches once the download works.
    upstreamBackoff.reset("rockide");
    state.failDownload = false;
    expect(await ensureRockideSchemas({ fetcher, now: T0 + DAY + 1 })).toMatchObject({ release: { version: "0.1.4" }, latest: "0.1.4" });
    expect((await rockideStatus())?.error).toBeUndefined();
  });

  it("keeps using a copy cached before releases were tracked until a check succeeds", async () => {
    const legacy = join(cache, "knowledge", "rockide", SHA1);
    cpSync(tree, legacy, { recursive: true });
    writeFileSync(join(cache, "knowledge", "rockide", "current.json"), JSON.stringify({ commit: SHA1, fetchedAt: new Date(T0).toISOString(), checkedAt: new Date(T0).toISOString() }));
    const { fetcher } = fakeFetcher({ tag: "0.1.4" });
    expect(await ensureRockideSchemas({ fetcher, now: T0 + 1, offline: true })).toMatchObject({ release: { version: "main", commit: SHA1 }, root: legacy });
    expect(await ensureRockideSchemas({ fetcher, now: T0 + DAY })).toMatchObject({ release: { version: "0.1.4", commit: SHA2 } });
  });
});

describe("rockide component lookup", () => {
  it("summarizes the version matching the game, lists versions and changes", async () => {
    const [health] = await rockideComponent(tree, "minecraft:health", "1.21.50");
    expect(health).toMatchObject({
      scope: "server/entity/components",
      formatVersions: ["1.21.0", "1.26.0"],
      selectedVersion: "1.21.0",
      file: `${E}/1.21.0/components/health.json`,
      description: "Health v1",
      properties: [{ name: "value", type: "integer", default: 10, description: "Hit points" }],
      changes: [
        { formatVersion: "1.21.0", file: `${E}/1.21.0/components/health.json` },
        { formatVersion: "1.26.0", file: `${E}/1.26.0/components/health.json` },
      ],
    });
    const [h2] = await rockideComponent(tree, "minecraft:health", "1.26.70.23");
    expect(h2?.selectedVersion).toBe("1.26.0");
    expect(h2?.properties).toEqual([
      { name: "value", type: "integer | object", properties: [{ name: "range_min", type: "integer" }] },
      { name: "max", type: "integer", minimum: 1 },
    ]);
  });

  it("reports enums, defaults, required fields, nested properties and newer-than-game versions", async () => {
    const [tempt] = await rockideComponent(tree, "minecraft:behavior.tempt", "1.21.0");
    expect(tempt).toMatchObject({ scope: "server/entity/behaviors", selectedVersion: "1.26.0", newerThanGame: true, description: "Tempted by items" });
    const byName = Object.fromEntries((tempt?.properties ?? []).map((p) => [p.name, p]));
    expect(byName.priority).toEqual({ name: "priority", type: "integer", minimum: 0, required: true });
    expect(byName.speed_multiplier).toMatchObject({ type: "number", default: 1 });
    expect(byName.look_mode).toMatchObject({ type: "string", enum: ["near", "far"] });
    expect(byName.sound_interval?.properties?.map((p) => p.name)).toEqual(["min", "max"]);
    const text = formatRockide({ repo: "x", commit: SHA1, gameVersion: "1.21.0", matches: tempt ? [tempt] : [] }).join("\n");
    expect(text).toContain("server/entity/behaviors format_version 1.26.0 (newer than 1.21.0)");
    expect(text).toContain('- look_mode (string; one of "near", "far")');
  });

  it("resolves inline definitions (block components)", async () => {
    const [box] = await rockideComponent(tree, "minecraft:collision_box", "1.26.60");
    expect(box).toMatchObject({ scope: "server/block/components", description: "Collision box", type: "boolean | object" });
    expect(box?.properties.map((p) => p.name)).toEqual(["origin", "size"]);
    expect(await rockideComponent(tree, "minecraft:nope", "1.26.60")).toEqual([]);
  });
});
