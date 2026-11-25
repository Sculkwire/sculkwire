import { afterEach, describe, expect, it, vi } from "vitest";
import { queryEvent, replyIn, runHelperScript } from "../../testing/helperpack.ts";

type Handler = (ev: Record<string, unknown>) => void;

/** The helper with a fake world: world events fired by name, a scoreboard, and ticks run by hand. */
function loadHelper() {
  let tick = 100;
  let onQuery: Handler | undefined;
  const handlers = new Map<string, Handler>();
  const intervals = new Map<number, () => void>();
  let runs = 0;
  const scores = new Map<string, number>();
  const objective = {
    getScore: (p: unknown) => (typeof p === "string" ? scores.get(p) : undefined),
    getParticipants: () => [],
  };
  const player = { id: "-1", name: "Steve", location: { x: 0, y: 64, z: 0 }, dimension: { id: "minecraft:overworld" } };
  const world = {
    getAllPlayers: () => [player],
    getDimension: () => ({ id: "minecraft:overworld" }),
    scoreboard: { getObjective: (id: string) => (id === "goal" ? objective : undefined) },
    afterEvents: new Proxy({}, { get: (_t, name: string) => ({ subscribe: (h: Handler) => void handlers.set(name, h) }) }),
  };
  const system = {
    get currentTick() {
      return tick;
    },
    run: () => 0,
    runInterval: (fn: () => void) => {
      intervals.set(++runs, fn);
      return runs;
    },
    clearRun: (id: number) => void intervals.delete(id),
    afterEvents: { scriptEventReceive: { subscribe: (h: Handler) => void (onQuery = h) } },
  };
  const lines = runHelperScript({ system, world, BlockTypes: {}, BlockVolume: class {}, EntityTypes: {}, ItemTypes: {} });
  let id = 0;
  return {
    lines,
    scores,
    fire: (name: string, ev: Record<string, unknown>) => handlers.get(name)?.(ev),
    scriptevent: (eventId: string, message = "") => onQuery?.({ id: eventId, message }),
    /** Send a query; its id. */
    ask: (params: Record<string, unknown>) => {
      onQuery?.(queryEvent(params, ++id));
      return id;
    },
    /** Run one game tick (every interval), then let resolved replies print. */
    tick: async () => {
      tick++;
      for (const fn of [...intervals.values()]) fn();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("helper pack events", () => {
  it("reads events after a cursor, answers the cursor alone for now, and leaves its own queries out", () => {
    const h = loadHelper();
    h.scriptevent("test:start", "go");
    h.fire("entityDie", { deadEntity: { id: "7", typeId: "minecraft:zombie" }, damageSource: { cause: "entityAttack" } });
    h.ask({ kind: "ping" });

    const all = replyIn(h.lines, h.ask({ kind: "events" }))?.result as { events: Record<string, unknown>[]; next: number; dropped: number };
    expect(all.events).toMatchObject([
      { seq: 1, kind: "scriptevent", id: "test:start", message: "go" },
      { seq: 2, kind: "entityDie", id: "7", typeId: "minecraft:zombie", cause: "entityAttack" },
    ]);
    expect(all).toMatchObject({ next: 2, dropped: 0 });

    expect(replyIn(h.lines, h.ask({ kind: "events", since: "now" }))?.result).toMatchObject({ events: [], next: 2, dropped: 0 });

    h.fire("playerPlaceBlock", { player: { name: "Steve" }, block: { typeId: "minecraft:stone", location: { x: 1, y: 64, z: 2 } } });
    const after = replyIn(h.lines, h.ask({ kind: "events", since: 2 }))?.result as { events: unknown[]; next: number };
    expect(after.events).toEqual([{ seq: 3, tick: 100, kind: "playerPlaceBlock", player: "Steve", block: "minecraft:stone", location: { x: 1, y: 64, z: 2 } }]);
    expect(after.next).toBe(3);

    const dies = replyIn(h.lines, h.ask({ kind: "events", kinds: ["entityDie"] }))?.result as { events: { seq: number }[] };
    expect(dies.events.map((e) => e.seq)).toEqual([2]);
  });

  it("counts events the ring dropped and pages with limit", () => {
    const h = loadHelper();
    for (let i = 0; i < 2005; i++) h.scriptevent("test:n", String(i));

    const page = replyIn(h.lines, h.ask({ kind: "events", since: 0, limit: 3 }))?.result as { events: { seq: number }[]; next: number; dropped: number };
    expect(page.dropped).toBe(5);
    expect(page.events.map((e) => e.seq)).toEqual([6, 7, 8]);
    expect(page.next).toBe(8);

    const rest = replyIn(h.lines, h.ask({ kind: "events", since: 8, limit: 500 }))?.result as { dropped: number; next: number };
    expect(rest).toMatchObject({ dropped: 0, next: 508 });
  });

  it("starts over from the first event when the cursor is past the newest one (the helper restarted)", () => {
    const h = loadHelper();
    h.scriptevent("test:a");
    expect(replyIn(h.lines, h.ask({ kind: "events", since: 40 }))?.result).toMatchObject({ reset: true, next: 1, events: [{ seq: 1 }] });
  });
});

describe("helper pack wait", () => {
  it("answers when a score is met, with the ticks it took", async () => {
    const h = loadHelper();
    const id = h.ask({ kind: "wait", condition: { kind: "score", objective: "goal", participant: "#done", op: ">=", value: 3 }, timeoutMs: 10_000 });
    for (let n = 1; n <= 2; n++) {
      h.scores.set("#done", n);
      await h.tick();
    }
    expect(replyIn(h.lines, id)).toBeUndefined();
    h.scores.set("#done", 3);
    await h.tick();
    expect(replyIn(h.lines, id)).toMatchObject({ ok: true, result: { met: true, timedOut: false, ticks: 3, observed: { score: 3 } } });
  });

  it("times out on the wall clock with the last value seen", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = loadHelper();
    const id = h.ask({ kind: "wait", condition: { kind: "score", objective: "goal", participant: "#done", value: 1 }, timeoutMs: 1_000 });
    await h.tick();
    expect(replyIn(h.lines, id)).toBeUndefined();
    vi.setSystemTime(Date.now() + 1_000);
    await h.tick();
    expect(replyIn(h.lines, id)).toMatchObject({ ok: true, result: { met: false, timedOut: true, ticks: 2, observed: { score: null } } });
  });

  it("waits for a scriptevent after the moment it started, matching fields", async () => {
    const h = loadHelper();
    h.scriptevent("test:done", "early");
    const id = h.ask({ kind: "wait", condition: { kind: "event", event: "test:done", match: { message: "late" } } });
    h.scriptevent("test:done", "other");
    await h.tick();
    expect(replyIn(h.lines, id)).toBeUndefined();
    h.scriptevent("test:done", "late");
    await h.tick();
    expect(replyIn(h.lines, id)?.result).toMatchObject({ met: true, observed: { kind: "scriptevent", id: "test:done", message: "late", seq: 3 } });
  });

  it("answers at once when the condition already holds, and refuses a bad condition", () => {
    const h = loadHelper();
    expect(replyIn(h.lines, h.ask({ kind: "wait", condition: { kind: "ticks", ticks: 0 } }))?.result).toMatchObject({ met: true, ticks: 0 });
    expect(replyIn(h.lines, h.ask({ kind: "wait", condition: { kind: "score", objective: "goal", participant: "x", op: "~", value: 1 } }))).toMatchObject({
      ok: false,
      reason: "bad_condition",
    });
    expect(replyIn(h.lines, h.ask({ kind: "wait", condition: { kind: "weather" } }))).toMatchObject({ ok: false, reason: "bad_condition" });
  });
});
