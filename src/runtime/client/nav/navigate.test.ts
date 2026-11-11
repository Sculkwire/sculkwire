/**
 * `navigate()` end to end in the kinematic game of `src/testing/fightsim.ts` on fake time, over a block world the
 * helper's `grid` query answers from a function: the recovery when the first window holds no way (wider windows, legs
 * to the closest spot) and the fast failure for a goal closed in by blocks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drive, fakeClock, seededRandom } from "../../../testing/faketime.ts";
import { sim, type Sim } from "../../../testing/fightsim.ts";
import { PlayerController, type PlayerWorld } from "../player.ts";
import { GridCache, SECTION, type BlockClass } from "./grid.ts";
import { navigate } from "./navigate.ts";
import { plan } from "./planner.ts";

type World = (x: number, y: number, z: number) => BlockClass;

/** Flat ground: solid below y 0, air above. */
const ground: World = (_x, y) => (y < 0 ? "#" : ".");

/** One 16-block section as the helper's `grid` reply encodes it: runs along x of one class each. */
function encode(bx: number, by: number, bz: number, cls: World): string {
  const d = (n: number) => n.toString(36);
  let out = "";
  for (let y = 0; y < SECTION; y++) {
    for (let z = 0; z < SECTION; z++) {
      let start = 0;
      let run = cls(bx, by + y, bz + z);
      for (let x = 1; x <= SECTION; x++) {
        const c = x < SECTION ? cls(bx + x, by + y, bz + z) : undefined;
        if (c === run) continue;
        if (run !== "u") out += `${run}${d(start)}${d(y)}${d(z)}${d(x - 1)}${d(y)}${d(z)}`;
        start = x;
        run = c as BlockClass;
      }
    }
  }
  return out;
}

let game: Sim | undefined;
afterEach(() => game?.stop());
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A player at the origin of a world whose blocks `cls` gives, seen from where the player stands at each query. */
async function start(cls: (player: { x: number; z: number }) => World) {
  game = sim([], { pen: { x0: -500, x1: 500, z0: -500, z1: 500 }, start: { x: 0.5, z: 0.5 } });
  const g = game;
  const queries: { x: number; z: number }[] = [];
  const world: PlayerWorld = {
    ...g.world,
    query: async (kind, params) => {
      if (kind !== "grid") throw new Error(`no ${kind} query here`);
      const me = g.player();
      queries.push({ x: me.x, z: me.z });
      const boxes = (params?.boxes ?? []) as number[][];
      return { boxes: boxes.map(([x, y, z]) => encode(x as number, y as number, z as number, cls(me))) };
    },
  };
  const pc = new PlayerController(world, { clock: fakeClock, random: seededRandom(3) });
  expect(await drive(pc.selectInput("engine"))).toBe("engine");
  return { pc, queries };
}

describe("navigate when the first window holds no way", () => {
  it("finds the gap 40 blocks to the side of a wall wider than the window, in a wider window", async () => {
    // A wall 4 high from x -80 to 80 across z 4, open at x 40 and 41; the goal is 12 blocks behind it.
    const wall: World = (x, y, z) => (z === 4 && y >= 0 && y <= 3 && x >= -80 && x <= 80 && x !== 40 && x !== 41 ? "#" : ground(x, y, z));
    const { pc } = await start(() => wall);
    const r = await drive(navigate(pc, { x: 0.5, y: 0, z: 16.5 }, { timeoutMs: 120_000 }), 10, 300_000);
    expect(r.message).toMatch(/^arrived/);
    expect(r.ok).toBe(true);
    const me = (game as Sim).player();
    expect(Math.hypot(me.x - 0.5, me.z - 16.5)).toBeLessThan(0.8);
  });

  it("fails at once for a goal closed in by blocks, without walking, and names the closest spot", async () => {
    // A glass box 2 high with a roof around the block at 0, 0, 10.
    const box: World = (x, y, z) => {
      const ring = (Math.abs(x) === 1 && z === 10) || (x === 0 && Math.abs(z - 10) === 1);
      if (y >= 0 && y <= 1 && ring) return "#";
      if (y === 2 && x === 0 && z === 10) return "#";
      return ground(x, y, z);
    };
    const { pc } = await start(() => box);
    const t0 = Date.now();
    const r = await drive(navigate(pc, { x: 0.5, y: 0, z: 10.5 }), 10, 60_000);
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.message).toMatch(/^no way to reach 0\.5, 0, 10\.5 from 0, 0, 0 within 3 block drops, jumps of one block and gaps of up to 3 \(searched \d+ blocks\)\. The closest reachable spot is -?\d+, 0, \d+, [\d.]+ blocks away\. /);
    expect(r.message).toMatch(/Tried a window of 48 x \d+ blocks around the player and walked 0 leg\(s\) to the closest spot, getting within 10\.0 blocks of the target: the target is closed in by blocks on every side$/);
    const me = (game as Sim).player();
    expect(Math.hypot(me.x - 0.5, me.z - 0.5)).toBeLessThan(0.1);
  });

  it("walks to the closest spot and plans again when the blocks beyond load as the player gets closer", async () => {
    // Blocks farther than 20 from the player at the time of a query are not loaded yet.
    const { pc, queries } = await start((me) => (x, y, z) => (Math.hypot(x + 0.5 - me.x, z + 0.5 - me.z) > 20 ? "u" : ground(x, y, z)));
    const r = await drive(navigate(pc, { x: 0.5, y: 0, z: 30.5 }, { timeoutMs: 60_000 }), 10, 300_000);
    expect(r.message).toMatch(/^arrived/);
    expect(r.ok).toBe(true);
    // Sections were asked for again once the player had walked on.
    expect(queries.some((q) => q.z > 10)).toBe(true);
  });

  it("walks one leg to the closest spot, then stops there and says what it tried", async () => {
    // A wall across z 4 that never ends (as far as the window goes) and unknown blocks past it.
    const wall: World = (x, y, z) => (z > 4 ? "u" : z === 4 && y >= 0 && y <= 3 ? "#" : ground(x, y, z));
    const { pc } = await start(() => wall);
    const r = await drive(navigate(pc, { x: 0.5, y: 0, z: 16.5 }, { timeoutMs: 120_000 }), 10, 300_000);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/The closest reachable spot is 0, 0, 3, 13\.0 blocks away\. Tried a window of 128 x 128 blocks around the player and walked 1 leg\(s\) to the closest spot, getting within [\d.]+ blocks of the target: the closest spot is where the player stands$/);
  });
});

describe("planning in the widest window", () => {
  it("exhausts a 128 x 128 window of open ground in under 2 seconds", async () => {
    vi.useRealTimers();
    const sealed: World = (x, y, z) => (y >= 0 && y <= 2 && Math.max(Math.abs(x - 50), Math.abs(z - 50)) === 1 ? "#" : y === 3 && x === 50 && z === 50 ? "#" : ground(x, y, z));
    const world = { query: async (_kind: string, params: Record<string, unknown>) => ({ boxes: (params.boxes as number[][]).map(([x, y, z]) => encode(x as number, y as number, z as number, sealed)) }) } as unknown as PlayerWorld;
    const grid = new GridCache(world);
    const bounds = { min: { x: -64, y: -6, z: -64 }, max: { x: 63, y: 6, z: 63 } };
    await grid.ensure(bounds.min, bounds.max);
    const t0 = process.hrtime.bigint();
    const r = plan(grid, { x: 0.5, y: 0, z: 0.5 }, { x: 50.5, y: 0, z: 50.5 }, { bounds, maxNodes: 120_000 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(r.status).toBe("unreachable");
    // Every standing block of the window but the 9 under the box: 16375 searched in about 0.3 s on a desktop.
    expect(r.expanded).toBe(16_375);
    expect(ms).toBeLessThan(2000);
  });
});
