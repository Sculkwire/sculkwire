import { describe, expect, it } from "vitest";
import { project, Staleness, STREAM_FRESH_MS, streamEntities, streamEntity, TickClock, type StreamedEntities } from "./entitystream.ts";
import type { EntityInfo } from "./types.ts";

const zombie = (id: string, x: number, vx = 0): EntityInfo => ({ id, typeId: "minecraft:zombie", location: { x, y: 0, z: 0 }, velocity: { x: vx, y: -0.08, z: 0 }, health: { current: 20, max: 20 } });

const stream = (list: EntityInfo[], at = 1000, limit = 8): StreamedEntities => ({ at, tick: 500, radius: 16, limit, list });

describe("entity stream", () => {
  it("carries a reading forward along its horizontal velocity by its age, and its tick with it", () => {
    const e = project(zombie("1", 2, 0.1), 500, 100);
    expect(e.location.x).toBeCloseTo(2.2);
    // Vertical velocity (gravity on the ground) is not carried.
    expect(e.location.y).toBe(0);
    expect(e.tick).toBe(502);
    expect(e.ageMs).toBe(100);
    // Never more than 6 ticks.
    expect(project(zombie("1", 2, 0.1), 500, 5000).location.x).toBeCloseTo(2.6);
  });

  it("answers an id from a fresh stream, not from a stale one or for an id it does not list", () => {
    const s = stream([zombie("1", 2, 0.1)]);
    expect(streamEntity(s, "1", 1050)?.location.x).toBeCloseTo(2.1);
    expect(streamEntity(s, "2", 1050)).toBeUndefined();
    expect(streamEntity(s, "1", 1000 + STREAM_FRESH_MS + 1)).toBeUndefined();
    expect(streamEntity(undefined, "1", 1000)).toBeUndefined();
  });

  it("lists the entities within a radius, unless the radius is past the helper's or a full list may miss some", () => {
    const me = { x: 0, y: 0, z: 0 };
    const s = stream([zombie("1", 2), zombie("2", 6), zombie("3", 12)]);
    expect(streamEntities(s, me, 8, 1000)?.map((e) => e.id)).toEqual(["1", "2"]);
    expect(streamEntities(s, me, 20, 1000)).toBeUndefined();
    const full = stream([zombie("1", 2), zombie("2", 3)], 1000, 2);
    // The helper stopped at 2 entities, all within 8: a third within 8 may be missing.
    expect(streamEntities(full, me, 8, 1000)).toBeUndefined();
    // Within 2.5 the list is complete (the second entry lies beyond).
    expect(streamEntities(full, me, 2.5, 1000)?.map((e) => e.id)).toEqual(["1"]);
  });

  it("summarises reading ages per source", () => {
    const st = new Staleness();
    for (const ms of [10, 20, 30, 40, 100]) st.record("stream", ms);
    st.record("query", 220);
    const s = st.summary();
    expect(s.stream).toEqual({ count: 5, meanMs: 40, p50Ms: 30, p90Ms: 100, maxMs: 100 });
    expect(s.query?.count).toBe(1);
    st.reset();
    expect(st.summary()).toEqual({});
  });

  it("dates a game tick by when the stream delivered it", () => {
    const c = new TickClock();
    c.arrived(100, 5000);
    c.arrived(102, 5110);
    expect(c.wallOf(102)).toBe(5110);
    expect(c.wallOf(101)).toBe(5050);
    expect(c.wallOf(99)).toBeUndefined();
  });
});
