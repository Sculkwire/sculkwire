/**
 * The helper pack's `grid` query against a fake dimension: the script runs with stand-ins for `@minecraft/server`,
 * and its replies are decoded the way the navigation grid decodes them.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeRegions } from "../nav/grid.ts";

interface FakeBlock {
  typeId: string;
  states?: Record<string, unknown>;
  expect: string;
}

type Vec = { x: number; y: number; z: number };

/** Load main.js with fake game modules; returns a function that sends a query and resolves with its reply. */
function loadHelper(blockAt: (x: number, y: number, z: number) => FakeBlock | undefined) {
  let interval: (() => void) | undefined;
  let tick = 0;
  let onEvent: ((ev: { id: string; message: string }) => void) | undefined;
  const block = (x: number, y: number, z: number): unknown => {
    const b = blockAt(x, y, z);
    if (!b) return undefined;
    return {
      typeId: b.typeId,
      isAir: b.typeId === "minecraft:air",
      permutation: { getAllStates: () => b.states ?? {} },
      below: () => block(x, y - 1, z),
    };
  };
  const dim = {
    id: "overworld",
    heightRange: { min: -64, max: 320 },
    getBlock: (v: Vec) => block(v.x, v.y, v.z),
    containsBlock: (vol: { from: Vec; to: Vec }, filter: { excludeTypes: string[] }) => {
      for (let y = vol.from.y; y <= vol.to.y; y++)
        for (let z = vol.from.z; z <= vol.to.z; z++)
          for (let x = vol.from.x; x <= vol.to.x; x++) {
            const b = blockAt(x, y, z);
            if (b && !filter.excludeTypes.includes(b.typeId)) return true;
          }
      return false;
    },
  };
  const subscribe = { subscribe: () => undefined };
  const fakeWorld = {
    getAllPlayers: () => [],
    getDimension: () => dim,
    afterEvents: { projectileHitEntity: subscribe, projectileHitBlock: subscribe, entityDie: subscribe, entityHurt: subscribe, playerSpawn: subscribe, dataDrivenEntityTrigger: subscribe, entityRemove: subscribe },
  };
  const fakeSystem = {
    get currentTick() {
      return tick;
    },
    run: () => 0,
    runInterval: (fn: () => void) => {
      interval = fn;
      return 1;
    },
    clearRun: () => {
      interval = undefined;
    },
    afterEvents: {
      scriptEventReceive: {
        subscribe: (h: typeof onEvent) => {
          onEvent = h;
        },
      },
    },
  };
  class BlockVolume {
    from: Vec;
    to: Vec;
    constructor(from: Vec, to: Vec) {
      this.from = from;
      this.to = to;
    }
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "scripts", "main.js"), "utf8").replace(/^import .*$/m, "");
  new Function("BlockVolume", "system", "world", source)(BlockVolume, fakeSystem, fakeWorld);
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((l: string) => {
    lines.push(l);
  });
  let id = 0;
  return {
    async query(params: Record<string, unknown>): Promise<{ boxes: string[]; ticks: number; maxTickMs: number }> {
      const qid = ++id;
      onEvent?.({ id: "sculkwire:query", message: JSON.stringify({ ...params, id: qid }) });
      for (let n = 0; n < 1000; n++) {
        const line = lines.find((l) => l.includes(`"id":${qid},`));
        if (line) {
          const reply = JSON.parse(line.slice("[sculkwire:reply] ".length)) as { ok: boolean; result: never; error?: string };
          if (!reply.ok) throw new Error(reply.error);
          return reply.result;
        }
        await Promise.resolve();
        tick++;
        interval?.();
        await Promise.resolve();
      }
      throw new Error("no reply");
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("helper grid query", () => {
  it("returns every block's class over ticks, with unloaded columns unknown", async () => {
    const special = new Map<string, FakeBlock>([
      ["3,0,3", { typeId: "minecraft:water", expect: "w" }],
      ["4,0,3", { typeId: "minecraft:lava", expect: "L" }],
      ["5,0,3", { typeId: "minecraft:smooth_stone_slab", states: { "minecraft:vertical_half": "bottom" }, expect: "s" }],
      ["6,0,3", { typeId: "minecraft:smooth_stone_slab", states: { "minecraft:vertical_half": "top" }, expect: "#" }],
      ["7,0,3", { typeId: "minecraft:oak_stairs", states: { upside_down_bit: false }, expect: "t" }],
      ["8,0,3", { typeId: "minecraft:fence_gate", states: { open_bit: false }, expect: "G" }],
      ["9,0,3", { typeId: "minecraft:fence_gate", states: { open_bit: true }, expect: "d" }],
      ["10,0,3", { typeId: "minecraft:oak_fence", expect: "F" }],
      ["11,0,3", { typeId: "minecraft:ladder", expect: "H" }],
      ["12,0,3", { typeId: "minecraft:wooden_door", states: { upper_block_bit: false, open_bit: false }, expect: "D" }],
      ["12,1,3", { typeId: "minecraft:wooden_door", states: { upper_block_bit: true, open_bit: false }, expect: "D" }],
      ["13,0,3", { typeId: "minecraft:red_flower", expect: "." }],
      ["14,0,3", { typeId: "minecraft:cactus", expect: "X" }],
    ]);
    // Stone below y 0 with a bumpy top, air above, specials on the surface, nothing loaded at x 16 and beyond.
    const world = (x: number, y: number, z: number): FakeBlock | undefined => {
      if (x >= 16) return undefined;
      const s = special.get(`${x},${y},${z}`);
      if (s) return s;
      const top = (x * 7 + z * 3) % 5 === 0 ? 0 : -1;
      return y <= top ? { typeId: "minecraft:stone", expect: "#" } : { typeId: "minecraft:air", expect: "." };
    };
    const helper = loadHelper(world);
    const r = await helper.query({ kind: "grid", boxes: [[0, -8, 0, 16, 16, 16], [16, -8, 0, 16, 16, 16]] });
    expect(r.ticks).toBeGreaterThanOrEqual(1);
    const cells = decodeRegions(r.boxes[0] as string, 16, 16, 16);
    for (let y = 0; y < 16; y++)
      for (let z = 0; z < 16; z++)
        for (let x = 0; x < 16; x++) {
          const want = world(x, y - 8, z)?.expect;
          expect(`${x},${y - 8},${z} ${String.fromCharCode(cells[(y * 16 + z) * 16 + x] as number)}`).toBe(`${x},${y - 8},${z} ${want}`);
        }
    expect(r.boxes[1]).toBe("");
  });

  it("answers a uniform box with one region and refuses oversized boxes", async () => {
    const helper = loadHelper(() => ({ typeId: "minecraft:air", expect: "." }));
    const r = await helper.query({ kind: "grid", boxes: [[0, 0, 0, 16, 16, 16]] });
    expect(r.boxes).toEqual([".000fff"]);
    await expect(helper.query({ kind: "grid", boxes: [[0, 0, 0, 40, 1, 1]] })).rejects.toThrow(/1 to 36/);
  });
});
