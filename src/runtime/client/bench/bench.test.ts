import { describe, expect, it } from "vitest";
import { arenaCommands, arenaOrigin, FILL_LIMIT, fillBox, playerCommands, summonCommand } from "./arena.ts";
import { markdownTable, summarize, type RunRecord } from "./report.ts";
import { loadScenarios } from "./run.ts";
import mixed from "./scenarios/combat-mixed.ts";
import type { RunOutcome } from "./types.ts";

describe("arena commands", () => {
  it("splits a big fill into slabs under the block limit", () => {
    const cmds = fillBox({ x: 0, y: 0, z: 0 }, { x: 99, y: 9, z: 99 }, "air");
    expect(cmds.length).toBe(4);
    for (const c of cmds) {
      const [x0, y0, z0, x1, y1, z1] = c.split(" ").slice(1, 7).map(Number) as number[];
      expect(((x1 as number) - (x0 as number) + 1) * ((y1 as number) - (y0 as number) + 1) * ((z1 as number) - (z0 as number) + 1)).toBeLessThanOrEqual(FILL_LIMIT);
    }
    expect(cmds.at(-1)).toMatch(/ 99 9 99 air$/);
  });
  it("clears the box, lays the floor, and sets the player up", () => {
    const o = arenaOrigin(1);
    const cmds = arenaCommands({ area: { radius: 2, height: 3 } }, o);
    expect(cmds).toEqual([`fill ${o.x - 2} ${o.y} ${o.z - 2} ${o.x + 2} ${o.y + 3} ${o.z + 2} air`, `fill ${o.x - 2} ${o.y - 1} ${o.z - 2} ${o.x + 2} ${o.y - 1} ${o.z + 2} minecraft:grass_block`]);
    const p = playerCommands({ time: "night", hotbar: [{ item: "iron_sword" }, { item: "cooked_beef", amount: 16 }], armor: "iron", offhand: "shield" }, o);
    expect(p).toContain("gamemode survival @a");
    expect(p).toContain("time set 18000");
    expect(p).toContain("replaceitem entity @a slot.hotbar 1 minecraft:cooked_beef 16");
    expect(p).toContain("replaceitem entity @a slot.armor.chest 0 minecraft:iron_chestplate 1");
    expect(p).toContain("replaceitem entity @a slot.weapon.offhand 0 minecraft:shield 1");
    expect(p.at(-1)).toBe(`tp @a ${o.x + 0.5} ${o.y} ${o.z + 0.5} 0 0`);
    expect(summonCommand({ type: "zombie", at: { dx: 0, dy: 0, dz: 10 } }, o)).toBe(`summon minecraft:zombie ${o.x + 0.5} ${o.y} ${o.z + 10.5} 0 0 minecraft:as_adult`);
  });
});

describe("report", () => {
  const rec = (run: number, success: boolean, health: number, extra: RunRecord["extra"] = {}): RunRecord => ({
    run,
    success,
    outcome: { ok: success, message: "", durationMs: 10_000, healthStart: 20, healthEnd: health, damageTaken: 20 - health, blastDamage: 0, fallDamage: 0, falls: 0, deaths: health === 0 ? 1 : 0, kills: success ? 3 : 1, lost: 0, exploded: 0, hurts: 2 },
    extra,
    note: "",
  });
  it("averages the runs and prints one row per scenario", () => {
    const r = summarize("zombies3", "combat", "engine", [rec(1, true, 14, { cleared: true, hits: 6 }), rec(2, false, 0, { cleared: false, hits: 4 })]);
    expect(r.summary).toMatchObject({ runs: 2, successes: 1, avgHealthLeft: 7, minHealthLeft: 0, deaths: 1, kills: 4, extra: { cleared: 1, hits: 5 } });
    expect(markdownTable([r])).toMatch(/\| zombies3 \| engine \| 1\/2 \| 10 \| 13 \| 7 \| 0 \| 1 \| 4 \|/);
  });
  it("judges mixed on the creeper and the player, not on mobs the skeleton killed", () => {
    const o = (over: Partial<RunOutcome>): RunOutcome => ({ ...rec(1, true, 14).outcome, hurts: [], ...over });
    const judge = (x: RunOutcome) => mixed.success?.(x, {});
    expect(judge(o({ kills: 3, lost: 1 }))).toBe(true);
    expect(judge(o({ kills: 3, lost: 1, exploded: 1 }))).toBe(false);
    expect(judge(o({ blastDamage: 2 }))).toBe(false);
    expect(judge(o({ deaths: 1 }))).toBe(false);
  });
});

describe("scenarios", () => {
  it("loads every combat scenario with the standard loadout", async () => {
    const all = await loadScenarios();
    const combat = all.filter((s) => s.suite === "combat").map((s) => s.name);
    expect(combat).toEqual(expect.arrayContaining(["zombies3", "creeper", "creeper-bow", "skeleton2", "spider2", "mixed"]));
    expect(new Set(all.map((s) => s.name)).size).toBe(all.length);
  });
});
