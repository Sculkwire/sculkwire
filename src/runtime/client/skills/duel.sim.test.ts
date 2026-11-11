/**
 * The fight loop in the kinematic game of `src/testing/fightsim.ts` (measured Bedrock speeds, attack clocks, shield
 * raise time and arc, engine round trips), on fake time with a seeded hand jitter, so every run repeats exactly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drive, fakeClock, seededRandom } from "../../../testing/faketime.ts";
import { LIVE_MISS_RATE, sim, simMob, type Sim, type SimMob, type SimOptions } from "../../../testing/fightsim.ts";
import { PlayerController, type PlayerAction } from "../player.ts";
import { ENGINE_LATENCY_MS, SWING_OPENS_SHIELD_MS } from "./pack.ts";
import { play } from "./play.ts";
import { combatStats, traceFights, type TraceEvent, type TraceFrame } from "./stats.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const mob = simMob;
/** The bench's `zombies3`: three zombies 3 apart, 10 to 11 blocks ahead. */
const zombies3 = () => [mob("-1", "minecraft:zombie", -3, 10, 2.3), mob("-2", "minecraft:zombie", 0, 11, 2.3), mob("-3", "minecraft:zombie", 3, 10, 2.3)];
/** Half the swings miss, as live on retail: the mobs get to the player, and the footwork and shield must hold them. */
const live: SimOptions = { missRate: LIVE_MISS_RATE };
/** A weak weapon (3 a hit): the fight lasts many of the mobs' attack clocks, so the shield rhythm shows. */
const weak: SimOptions = { damage: 3 };
/** The bench's `husks3`: three husks 1 apart, 10 blocks ahead, summoned half a second after the fight started. */
const husks3 = () => [mob("-4", "minecraft:husk", -1, 10, 2.3, 10), mob("-5", "minecraft:husk", 0, 10, 2.3, 10), mob("-6", "minecraft:husk", 1, 10, 2.3, 10)];

let game: Sim | undefined;
afterEach(() => game?.stop());

async function start(mobs: SimMob[], o: SimOptions = {}): Promise<PlayerController> {
  game = sim(mobs, o);
  const pc = new PlayerController(game.world, { clock: fakeClock, random: seededRandom(7) });
  const route = o.keyboardLagTicks === undefined ? "engine" : "keyboard";
  expect(await drive(pc.selectInput(route))).toBe(route);
  traceFights(pc, true);
  return pc;
}

const fightIn = (pc: PlayerController, action: Omit<Extract<PlayerAction, { action: "fight" }>, "action">) => drive(pc.run({ action: "fight", ...action }));

async function playIn(pc: PlayerController, goal: string, extra: { stance?: "auto" | "kite" | "guard" } = {}) {
  const g = game as Sim;
  return drive(
    play({ action: "play", goal, durationMs: 40_000, ...extra }, { controller: pc, entities: async () => (await g.world.entities?.(24)) ?? [], loadout: async () => (await g.world.loadout?.()) ?? { hotbar: [] } }),
  );
}

const trace = (pc: PlayerController): TraceFrame[] => combatStats(pc).trace ?? [];
const has = (fr: TraceFrame, e: TraceEvent) => fr.ev?.includes(e) ?? false;

/**
 * Time (ms) the player stood (under 0.5 blocks a second) inside a mob's reach + 0.3 with the shield down while that
 * mob's attack was due within 400 ms. In the cooldown after an attack standing there is the counter, not exposure.
 */
function exposedMs(frames: readonly TraceFrame[]): number {
  let total = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1] as TraceFrame;
    const b = frames[i] as TraceFrame;
    const dt = b.t - a.t;
    const speed = (Math.hypot(b.x - a.x, b.z - a.z) / Math.max(1, dt)) * 1000;
    if (!a.shield && speed < 0.5 && a.mobs.some((m) => m.dist <= m.reach + 0.3 && m.coolMs <= 400)) total += dt;
  }
  return total;
}

/** The fight's frames show no dead time, a growing distance after hits, and little standing in reach unshielded. */
function honestTrace(frames: readonly TraceFrame[]) {
  const gaps = frames.slice(1).map((fr, i) => fr.t - (frames[i] as TraceFrame).t);
  expect(Math.max(...gaps)).toBeLessThanOrEqual(150);
  expect(exposedMs(frames)).toBeLessThanOrEqual(300);
}

/** A swing lowers the raised shield for 650 ms; the engine route adds 100 ms of input latency. */
const SWING_BOUND_MS = SWING_OPENS_SHIELD_MS + ENGINE_LATENCY_MS;

const creeperOf = (g: TraceFrame) => g.mobs.find((m) => m.type === "creeper");
/** A lost creeper is explained by a swing that missed it or a hit the player took while it was the target. */
const lossExplained = (frames: readonly TraceFrame[]) => frames.some((fr) => creeperOf(fr)?.target && (has(fr, "miss") || has(fr, "hurt")));

/**
 * Each escape from a struck creeper during which the player takes no hit gets past 7 blocks within 1.2 s of the hit
 * and with room behind never sneaks (the shield is for no room); one a zombie's hit interrupts (a known limit: a zombie
 * beside the creeper) must still end past 7 before the fuse, or behind the shield, which the callers check as no blast
 * damage; when the hit was the attempt's only swing it starts where the strike stood, 2.65 or more (the
 * close-in does not carry the player in). The swing goes out within 300 ms of the reading showing it lit (its closing
 * drops under 2: the reading is 100 ms old). Returns how many step frames the fight had.
 */
function creeperEscapes(frames: readonly TraceFrame[]): number {
  const creeper = creeperOf;
  for (const [i, fr] of frames.entries()) {
    const c = creeper(fr);
    const before = frames[i - 1];
    if (!c?.target || !before || (creeper(before)?.closing ?? 0) < 2 || c.closing >= 2) continue;
    const next = frames.findIndex((g, k) => k > i && (has(g, "swing") || g.foot === "run" || g.foot === "block"));
    // Known limit (the simulator's count): a melee mob within 3 (from 300 ms before it lit) can hold up the swing, or
    // leave the player backing off from it as the creeper lights, so the bound is for none near.
    const crowded = frames.filter((g, k) => g.t >= fr.t - 300 && k <= (next > 0 ? next : i)).some((g) => g.mobs.some((m) => m.type !== "creeper" && m.dist <= 3));
    if (next > 0 && !crowded && has(frames[next] as TraceFrame, "swing")) expect((frames[next] as TraceFrame).t - fr.t).toBeLessThanOrEqual(300);
  }
  for (const [i, fr] of frames.entries()) {
    if (!has(fr, "hit") || fr.mobs.find((m) => m.target)?.type !== "creeper") continue;
    // A hit on the creeper itself (not a zombie in the line): it is thrown back within 300 ms.
    if (!frames.some((g, k) => k > i && g.t - fr.t <= 300 && (creeper(g)?.closing ?? 0) <= -2)) continue;
    const runAt = frames.findIndex((g, k) => k > i && g.foot === "run");
    if (runAt < 0) continue;
    // A zombie passing through the line takes the first swing and the creeper the second, 0.5 s later, with the
    // player's step and its coast spent in between: only the attempt's single swing is held to 2.65.
    const single = !frames.some((g) => has(g, "swing") && g.t < fr.t && fr.t - g.t < 700);
    // 2.65: with the game applying one look a frame (the simulator since 2026-11-11), the swing goes out a frame later
    // and the coast of the close-in carries the player a few hundredths further in (lowest seen 2.66).
    if (single) expect(creeper(frames[runAt] as TraceFrame)?.dist).toBeGreaterThanOrEqual(2.65);
    const outAt = frames.findIndex((g, k) => k > runAt && (creeper(g)?.dist ?? 99) > 7);
    const end = outAt > 0 ? outAt : frames.findIndex((g, k) => k > runAt && !creeper(g));
    if (frames.slice(i + 1, end > 0 ? end : undefined).some((g) => has(g, "hurt"))) continue;
    expect(outAt).toBeGreaterThan(0);
    expect((frames[outAt] as TraceFrame).t - fr.t).toBeLessThanOrEqual(1200);
    for (const g of frames.slice(runAt, outAt)) {
      expect(g.shield).toBe(false);
      if (g.foot === "run") expect(g.sprint).toBe(false);
    }
  }
  return frames.filter((fr) => fr.foot === "step").length;
}

/**
 * Shield discipline as the trace shows it: no swing on a frame with the shield up unless every covered mob (within 75
 * degrees of the view) is further than the bound from attacking.
 */
function disciplined(frames: readonly TraceFrame[]) {
  for (const fr of frames) {
    if (!fr.shield || !has(fr, "swing")) continue;
    for (const m of fr.mobs) if (Math.abs(m.offViewDeg) <= 75) expect(m.coolMs).toBeGreaterThan(SWING_BOUND_MS);
  }
}

/**
 * The shield rhythm: the shield is up on the frame before every block, swings behind it keep the discipline, and the
 * mob that attacked is struck in its cooldown (between two of its blocked attacks there is a hit on it).
 */
function rhythm(pc: PlayerController, log: Sim["log"]) {
  const frames = trace(pc);
  disciplined(frames);
  for (const [i, fr] of frames.entries()) if (has(fr, "block")) expect(frames[i - 1]?.shield).toBe(true);
  const byMob = new Map<string, string[]>();
  for (const e of log.events) if (e.mob && (e.kind === "block" || e.kind === "hit")) byMob.set(e.mob, [...(byMob.get(e.mob) ?? []), e.kind]);
  for (const kinds of byMob.values()) for (let i = 1; i < kinds.length; i++) if (kinds[i] === "block") expect(kinds[i - 1]).toBe("hit");
}

describe("fight loop in the measured game, engine route", () => {
  it("kills a creeper without letting it blow up next to the player", async () => {
    const pc = await start([mob("-10", "minecraft:creeper", 0, 8, 2.5)]);
    const r = await fightIn(pc, { target: "-10", timeoutMs: 15_000 });
    expect(r.fight?.kills).toEqual({ creeper: 1 });
    expect(game?.log.blast).toBe(0);
  }, 20_000);

  // Along the z axis it lights at a centre distance of 3.1 and stands inside reach; from 45 and 37 degrees it lights at
  // about 3.35 and stands outside it, where only a close-in while it slows gets the swing out (live `mixed`, 2026-11-11).
  for (const [name, x, z] of [["along an axis", 0, 8], ["from 45 degrees", 5.66, 5.66], ["from 37 degrees", 4.8, 6.4]] as const) {
    it(`kills a lone creeper coming ${name} over 20 seeds: no blast without a missed swing, backing straight off`, async () => {
      let steps = 0;
      for (let seed = 1; seed <= 20; seed++) {
        for (const missRate of [0, 0.3]) {
          game?.stop();
          game = sim([mob("-9", "minecraft:creeper", x, z, 2.5)], { missRate, missSeed: seed, creeperSeed: seed });
          const pc = new PlayerController(game.world, { clock: fakeClock, random: seededRandom(seed) });
          await drive(pc.selectInput("engine"));
          traceFights(pc, true);
          const r = await fightIn(pc, { target: "-9", timeoutMs: 25_000 });
          const frames = trace(pc);
          expect(game.log.blast).toBe(0);
          expect(r.fight?.timeMs).toBeLessThan(25_000);
          // A swing that misses a lit creeper falls back on the shield: the blast is blocked and the creeper lost.
          if (game.log.exploded) expect(frames.some((fr) => has(fr, "miss") && creeperOf(fr)?.target)).toBe(true);
          else {
            expect(r.fight?.kills).toEqual({ creeper: 1 });
            expect(r.fight?.hits).toBeGreaterThanOrEqual(3);
            expect(r.fight?.hits).toBeLessThanOrEqual(4);
          }
          if (missRate === 0) expect(game.log.exploded).toBe(0);
          steps += creeperEscapes(frames);
        }
      }
      expect(steps).toBeGreaterThan(0);
    }, 120_000);
  }

  it("the bench's mixed layout (two zombies, a creeper leading them, a skeleton shooting) over 20 seeds: no blast damage, all gone; known limit: a zombie beside the creeper can cost the kill", async () => {
    let arrows = 0;
    let steps = 0;
    for (let seed = 1; seed <= 20; seed++) {
      for (const missRate of [0, 0.3]) {
        game?.stop();
        const mobs = [mob("-20", "minecraft:zombie", -4, 10, 2.3), mob("-21", "minecraft:zombie", 4, 10, 2.3), mob("-23", "minecraft:skeleton", 0, 12, 2.5), mob("-22", "minecraft:creeper", -8, 6, 2.5)];
        game = sim(mobs, { missRate, missSeed: seed, arrowSeed: seed, creeperSeed: seed });
        const pc = new PlayerController(game.world, { clock: fakeClock, random: seededRandom(seed) });
        await drive(pc.selectInput("engine"));
        traceFights(pc, true);
        await fightIn(pc, { crits: false, timeoutMs: 60_000 });
        steps += creeperEscapes(trace(pc));
        expect(game.log.blast).toBe(0);
        if (missRate === 0) expect(mobs).toEqual([]);
        // A creeper is lost (behind the shield) only after a swing that missed it or a hit taken during the attempt.
        if (game.log.exploded) expect(lossExplained(trace(pc))).toBe(true);
        // Melee hits: the arrows (a guessed 50 % of shots every 2.5 s, not measured) are counted apart.
        expect(game.log.hitsTaken - game.log.arrowHits).toBeLessThanOrEqual(4);
        arrows += game.log.arrowHits;
        // No target flip between kinds every tick: a switch to or from the creeper holds at least 600 ms (or the creeper burns).
        const frames = trace(pc);
        const creeperTarget = frames.map((fr) => fr.mobs.find((m) => m.target)?.type === "creeper");
        let flips = 0;
        for (let k = 2; k < creeperTarget.length; k++) if (creeperTarget[k] !== creeperTarget[k - 1] && creeperTarget[k - 1] !== creeperTarget[k - 2]) flips++;
        expect(flips).toBe(0);
      }
    }
    // About 3 arrows a fight at the guessed rate (the skeleton is fought last, after the creeper and the zombies).
    expect(arrows / 40).toBeLessThanOrEqual(3.5);
    expect(steps).toBeGreaterThan(0);
  }, 300_000);

  it("the creeper with two zombies at its side over ten seeds: no blast damage; known limit, the simulator's count: the zombie beside it can cost the kill (at most 5 of 10)", async () => {
    let lost = 0;
    for (let seed = 1; seed <= 10; seed++) {
      for (const missRate of [0, 0.3]) {
        game?.stop();
        const mobs = [mob("-17", "minecraft:creeper", -2, 7, 2.7), mob("-18", "minecraft:zombie", -1, 8, 2.3), mob("-19", "minecraft:zombie", 2, 8, 2.3)];
        game = sim(mobs, { missRate });
        const pc = new PlayerController(game.world, { clock: fakeClock, random: seededRandom(seed) });
        await drive(pc.selectInput("engine"));
        traceFights(pc, true);
        await fightIn(pc, { crits: false, timeoutMs: 30_000 });
        expect(game.log.blast).toBe(0);
        // Lost behind the shield: at 0 misses (a zombie beside the creeper) in at most 5 seeds of 10 (the simulator's
        // count since zombies walking in are struck as live, from 2.9: none is knocked back from 3.2 any more), at 0.3 only after
        // a missed swing or a hit taken during the attempt.
        if (missRate === 0) lost += game.log.exploded;
        else if (game.log.exploded) expect(lossExplained(trace(pc))).toBe(true);
        expect(mobs).toEqual([]);
        expect(game.log.hitsTaken).toBeLessThanOrEqual(4);
      }
    }
    expect(lost).toBeLessThanOrEqual(5);
  }, 120_000);

  it("gets away from or shields against a creeper that starts inside its fuse range", async () => {
    const pc = await start([mob("-11", "minecraft:creeper", 0, 2.2, 2.5)]);
    await fightIn(pc, { target: "-11", timeoutMs: 12_000 });
    expect(game?.log.blast).toBe(0);
  }, 20_000);

  it("kills a lone zombie taking at most one hit", async () => {
    const pc = await start([mob("-12", "minecraft:zombie", 0, 8, 2.3)]);
    const r = await fightIn(pc, { target: "-12", timeoutMs: 15_000 });
    expect(r.fight?.kills).toEqual({ zombie: 1 });
    expect(game?.log.hitsTaken).toBeLessThanOrEqual(1);
  }, 20_000);

  it("clears zombies3 with at most one hit taken", async () => {
    const zombies = zombies3();
    const pc = await start(zombies, live);
    const r = await fightIn(pc, { timeoutMs: 30_000 });
    expect(zombies).toEqual([]);
    expect(r.fight?.kills).toEqual({ zombie: 3 });
    expect(game?.log.hitsTaken).toBeLessThanOrEqual(1);
    expect(r.fight?.hitsTaken).toBe(game?.log.hitsTaken);
    honestTrace(trace(pc));
  }, 35_000);

  it("auto on open ground fights exactly as kite, frame for frame", async () => {
    // Half the swings missing lets the mobs get to the player, where a shield held while standing (the 2026-11-11
    // `auto`) cost hits live: lowering it holds the feet still and a hit struck sneaking knocks back less.
    for (const missRate of [0, LIVE_MISS_RATE]) {
      for (const layout of [zombies3, () => [mob("-8", "minecraft:husk", 0, 8, 2.3)]]) {
        const runs: { frames: string[]; hitsTaken: number }[] = [];
        for (const stance of ["kite", "auto"] as const) {
          game?.stop();
          const mobs = layout();
          const pc = await start(mobs, { missRate });
          await fightIn(pc, { stance, timeoutMs: 30_000 });
          expect(mobs).toEqual([]);
          const frames = trace(pc);
          expect(frames.some((fr) => fr.shield)).toBe(false);
          runs.push({ frames: frames.map((fr) => JSON.stringify(fr)), hitsTaken: (game as Sim).log.hitsTaken });
        }
        expect(runs[1]).toEqual(runs[0]);
      }
    }
  }, 120_000);

  it("auto takes no more hits than kite over ten seeds with half the swings missing", async () => {
    const hits = { kite: 0, auto: 0 };
    for (let seed = 1; seed <= 10; seed++) {
      for (const stance of ["kite", "auto"] as const) {
        game?.stop();
        const zombies = zombies3();
        game = sim(zombies, live);
        const pc = new PlayerController(game.world, { clock: fakeClock, random: seededRandom(seed) });
        await drive(pc.selectInput("engine"));
        await fightIn(pc, { stance, timeoutMs: 30_000 });
        expect(zombies).toEqual([]);
        hits[stance] += game.log.hitsTaken;
      }
    }
    expect(hits.auto).toBeLessThanOrEqual(hits.kite);
  }, 120_000);

  it("guard clears zombies3 in at most twice kite's time, taking at most one hit", async () => {
    const times: number[] = [];
    for (const stance of ["kite", "guard"] as const) {
      game?.stop();
      const zombies = zombies3();
      const pc = await start(zombies, live);
      const r = await fightIn(pc, { stance, timeoutMs: 30_000 });
      expect(zombies).toEqual([]);
      if (stance === "guard") {
        expect(game?.log.hitsTaken).toBeLessThanOrEqual(1);
        expect(game?.log.blocked).toBeGreaterThan(0);
        disciplined(trace(pc));
      }
      times.push(r.fight?.timeMs ?? 0);
    }
    expect(times[1]).toBeLessThanOrEqual(2 * (times[0] ?? 0));
  }, 70_000);

  it("clears husks3 arriving after the fight started, through play, in one fight step", async () => {
    const husks = husks3();
    const pc = await start(husks, live);
    const r = await playIn(pc, "kill 3 husks");
    expect(husks).toEqual([]);
    expect(r.stats.killed).toEqual({ husk: 3 });
    expect(game?.log.hitsTaken).toBeLessThanOrEqual(1);
    expect(r.trace.filter((s) => s.action === "fight")).toHaveLength(1);
    expect(r.stats.blocked).toBeLessThanOrEqual(game?.log.blocked ?? 0);
    honestTrace(trace(pc));
  }, 45_000);

  it("kills zombies3 through play in one fight step", async () => {
    const zombies = zombies3();
    const pc = await start(zombies, live);
    const r = await playIn(pc, "kill all the zombies");
    expect(zombies).toEqual([]);
    expect(r.stats.killed).toEqual({ zombie: 3 });
    expect(game?.log.hitsTaken).toBeLessThanOrEqual(1);
    expect(r.trace.filter((s) => s.action === "fight")).toHaveLength(1);
  }, 45_000);

  it("guard blocks a lone zombie with its back to a wall, striking between the blocks", async () => {
    // A lane 5 wide, the player against its end wall, the zombie a step away.
    const zombie = mob("-13", "minecraft:zombie", 0.5, 0.3, 2.3);
    const pc = await start([zombie], { ...weak, pen: { x0: -2, x1: 2, z0: -2, z1: 14 }, start: { x: 0.5, z: -1.6 } });
    const r = await fightIn(pc, { target: "-13", stance: "guard", timeoutMs: 20_000 });
    expect(r.fight?.kills).toEqual({ zombie: 1 });
    const log = game?.log as Sim["log"];
    expect(log.hitsTaken).toBeLessThanOrEqual(1);
    expect(log.blocked).toBeGreaterThanOrEqual(2);
    rhythm(pc, log);
  }, 25_000);

  it("in a 5 by 5 pen auto takes no more hits than kite on average over 10 seeds (the simulator's counts), and guard holds it behind the shield", async () => {
    const pen = { pen: { x0: -2, x1: 2, z0: -2, z1: 2 }, start: { x: 0.5, z: -1.6 } };
    const zombiesIn = () => [mob("-14", "minecraft:zombie", -1.5, 2.5, 2.3), mob("-15", "minecraft:zombie", 0.5, 2.7, 2.3), mob("-16", "minecraft:zombie", 2.5, 2.5, 2.3)];
    const hits: Record<string, number> = { kite: 0, auto: 0, guard: 0 };
    for (let seed = 1; seed <= 10; seed++) {
      for (const stance of ["kite", "auto", "guard"] as const) {
        game?.stop();
        const zombies = zombiesIn();
        game = sim(zombies, { ...live, ...pen, missSeed: seed });
        const pc = new PlayerController(game.world, { clock: fakeClock, random: seededRandom(seed) });
        await drive(pc.selectInput("engine"));
        traceFights(pc, true);
        const r = await fightIn(pc, { stance, timeoutMs: 30_000 });
        expect(zombies).toEqual([]);
        hits[stance] = (hits[stance] ?? 0) + game.log.hitsTaken;
        expect(r.fight?.blocked).toBeLessThanOrEqual(game.log.blocked);
        disciplined(trace(pc));
        if (stance === "guard") {
          expect(game.log.blocked).toBeGreaterThanOrEqual(2);
          expect(trace(pc).some((fr) => fr.shield)).toBe(true);
        }
      }
    }
    expect(hits.auto).toBeLessThanOrEqual(hits.kite ?? 0);
  }, 120_000);

  it("stance guard holds the shield up on open ground; stance kite never raises it", async () => {
    const guarded = zombies3();
    const pc = await start(guarded, live);
    await fightIn(pc, { stance: "guard", timeoutMs: 30_000 });
    expect(guarded).toEqual([]);
    expect(game?.log.hitsTaken).toBeLessThanOrEqual(1);
    expect(game?.log.blocked).toBeGreaterThan(0);
    disciplined(trace(pc));
    game?.stop();
    const kited = zombies3();
    const pc2 = await start(kited, live);
    await fightIn(pc2, { stance: "kite", timeoutMs: 30_000 });
    expect(kited).toEqual([]);
    expect(trace(pc2).some((fr) => fr.shield)).toBe(false);
    expect(game?.log.blocked).toBe(0);
  }, 70_000);

  it("kills a creeper that comes with two zombies without letting it blow up", async () => {
    const mobs = [mob("-17", "minecraft:creeper", -2, 7, 2.7), mob("-18", "minecraft:zombie", -1, 8, 2.3), mob("-19", "minecraft:zombie", 2, 8, 2.3)];
    const pc = await start(mobs);
    await fightIn(pc, { crits: false, timeoutMs: 25_000 });
    expect(game?.log.exploded).toBe(0);
    expect(mobs).toEqual([]);
  }, 30_000);

  it("handles the bench's mixed layout (creeper from the side, two zombies ahead) without a blast", async () => {
    const mobs = [mob("-20", "minecraft:zombie", -4, 10, 2.3), mob("-21", "minecraft:zombie", 4, 10, 2.3), mob("-22", "minecraft:creeper", -8, 6, 2.5)];
    const pc = await start(mobs);
    await fightIn(pc, { crits: false, timeoutMs: 30_000 });
    expect(game?.log.exploded).toBe(0);
    expect(mobs).toEqual([]);
  }, 35_000);

  it("with the fuse reported: the mixed layout and a creeper starting inside its fuse range, no blast", async () => {
    const mobs = [mob("-23", "minecraft:zombie", -4, 10, 2.3), mob("-24", "minecraft:zombie", 4, 10, 2.3), mob("-25", "minecraft:creeper", -8, 6, 2.5)];
    const pc = await start(mobs, { reportFuse: true });
    await fightIn(pc, { crits: false, timeoutMs: 30_000 });
    expect(game?.log.exploded).toBe(0);
    expect(mobs).toEqual([]);
    game?.stop();
    const pc2 = await start([mob("-26", "minecraft:creeper", 0, 2.2, 2.5)], { reportFuse: true });
    await fightIn(pc2, { target: "-26", timeoutMs: 12_000 });
    expect(game?.log.blast).toBe(0);
  }, 50_000);

  it("counts every husk it killed when it turns to the next one before the dying husk is gone", async () => {
    // The game keeps a killed mob in the entity lists for its death animation (about a second), thrown back by the
    // blow: the fight turns to a closer husk then, before the follow sees the dead one gone.
    const husks = [mob("-30", "minecraft:husk", -2, 6, 2.3), mob("-31", "minecraft:husk", 0, 7, 2.3), mob("-32", "minecraft:husk", 2, 6, 2.3)];
    const pc = await start(husks, { deathTicks: 20 });
    const r = await fightIn(pc, { crits: false, timeoutMs: 30_000 });
    expect(husks).toEqual([]);
    expect(r.fight?.kills).toEqual({ husk: 3 });
    expect(r.message).toMatch(/^killed 3 husk with iron_sword: /);
    const s = r.fight;
    const log = game?.log as Sim["log"];
    expect(s?.swings).toBe(log.swings);
    expect((s?.hits ?? 0) + (s?.misses ?? 0)).toBe(s?.swings);
    expect(s?.hits).toBe(log.hits);
    expect(s?.hitsTaken).toBe(log.hitsTaken);
    expect(s?.blocked).toBeLessThanOrEqual(log.blocked);
  }, 35_000);

  it("traces one frame per tick, the target flagged, a hit on the tick its swing lands", async () => {
    const pc = await start([mob("-33", "minecraft:zombie", 0, 8, 2.3)]);
    const r = await fightIn(pc, { target: "-33", crits: false, timeoutMs: 15_000 });
    const frames = trace(pc);
    expect(frames.length).toBeGreaterThan(20);
    for (const [i, fr] of frames.entries()) {
      expect(fr.mobs.filter((m) => m.target).map((m) => m.id)).toEqual(["-33"]);
      if (i > 0) expect(fr.t - (frames[i - 1]?.t ?? 0)).toBeGreaterThanOrEqual(25);
    }
    const events = (e: TraceEvent) => frames.filter((fr) => has(fr, e)).length;
    const log = game?.log as Sim["log"];
    expect(r.fight?.hits).toBe(log.hits);
    expect(events("hit")).toBe(log.hits);
    // The engine route says what a swing struck: the hit shows on the swing's own tick.
    expect(frames.filter((fr) => has(fr, "hit")).every((fr) => has(fr, "swing"))).toBe(true);
    expect(events("swing")).toBe(log.swings);
    expect(events("hurt")).toBe(r.fight?.hitsTaken);
    expect(events("block")).toBe(r.fight?.blocked);
    expect(frames[0]?.mobs[0]).toMatchObject({ type: "zombie", reach: expect.any(Number), coolMs: expect.any(Number) });
  }, 20_000);
});

describe("the melee tail over 100 seeds (mob readings two ticks old, as live)", () => {
  /** The bench's `cornered`: a dead end 3 wide, the wall right behind, three zombies coming from the front. */
  const alcove = () => [mob("-24", "minecraft:zombie", 0.5, 10, 2.3), mob("-25", "minecraft:zombie", -0.4, 11, 2.3), mob("-26", "minecraft:zombie", 1.4, 11.5, 2.3)];
  const husksNear = () => [mob("-4", "minecraft:husk", -1, 7, 2.3), mob("-5", "minecraft:husk", 0, 7, 2.3), mob("-6", "minecraft:husk", 1, 7, 2.3)];
  const layouts: [string, () => SimMob[], SimOptions, Record<number, number>][] = [
    // Name, mobs, options, and the average hits taken per miss rate before this change (the bound).
    ["zombies3", zombies3, {}, { 0.15: 0, 0.3: 0.05 }],
    ["husks3", husksNear, {}, { 0.15: 0.01, 0.3: 0.04 }],
    ["alcove", alcove, { pen: { x0: -1, x1: 1, z0: -2, z1: 20 }, start: { x: 0.5, z: -1.6 } }, { 0.15: 0.29, 0.3: 0.44 }],
  ];
  for (const [name, layout, options, before] of layouts) {
    it(`${name}: no run takes more than 3 hits, the average no worse, and the feet never stand where the hand cannot answer`, async () => {
      for (const missRate of [0.15, 0.3]) {
        let hits = 0;
        let swings = 0;
        let misses = 0;
        let ownMisses = 0;
        for (let seed = 1; seed <= 100; seed++) {
          game?.stop();
          const mobs = layout();
          game = sim(mobs, { ...options, missRate, missSeed: seed });
          const pc = new PlayerController(game.world, { clock: fakeClock, random: seededRandom(seed) });
          await drive(pc.selectInput("engine"));
          traceFights(pc, true);
          await fightIn(pc, { timeoutMs: 40_000 });
          expect(mobs).toEqual([]);
          expect(game.log.hitsTaken).toBeLessThanOrEqual(3);
          hits += game.log.hitsTaken;
          swings += game.log.swings;
          misses += game.log.swings - game.log.hits;
          ownMisses += game.log.swings - game.log.hits - game.log.drawnMisses;
          // No two frames in a row with a mob coming in inside the 3.0 strike range, the swing ready, the view off the
          // target by more than the tolerance, and the feet not stepping away (boxed in excepted).
          let still = 0;
          for (const fr of trace(pc)) {
            const close = fr.mobs.some((m) => m.dist <= 3.0 && m.closing > 0);
            const cannot = fr.readyMs <= 100 && fr.aimErr > fr.aimTol;
            const away = fr.foot === "retreat" || fr.fwd < -0.1;
            const boxed = (fr.room ?? Number.POSITIVE_INFINITY) < 1;
            still = close && cannot && !away && !boxed ? still + 1 : 0;
            expect(still).toBeLessThan(2);
          }
        }
        expect(hits / 100).toBeLessThanOrEqual(before[missRate] ?? 0);
        // The swing goes out where the reading says it lands (the simulator misses a mob walking in read from 3.05 on,
        // as live): under 16 swings a fight, and under 4 misses besides those the miss rate draws (at 0.15 under 4 in
        // all). The gate with a closing lead swung 21 to 39 times a fight here, as live.
        expect(swings / 100).toBeLessThan(16);
        expect(ownMisses / 100).toBeLessThan(4);
        if (missRate === 0.15) expect(misses / 100).toBeLessThan(4);
      }
    }, 300_000);
  }
});

describe("fight loop on the keyboard route", () => {
  // The helper's stream 3 ticks old, as the spec's keyboard route.
  const LAG_TICKS = 3;

  it("swings with the crosshair on a zombie and counts only the clicks its health shows", async () => {
    const pc = await start([mob("-40", "minecraft:zombie", 0, 8, 2.3)], { keyboardLagTicks: LAG_TICKS });
    const r = await fightIn(pc, { target: "-40", crits: false, timeoutMs: 15_000 });
    expect(r.fight?.kills).toEqual({ zombie: 1 });
    // Only the clicks the zombie's health showed are hits; every other click is a miss.
    const log = game?.log as Sim["log"];
    expect(r.fight?.hits).toBe(log.hits);
    expect(r.fight?.swings).toBe(log.swings);
    expect((r.fight?.hits ?? 0) + (r.fight?.misses ?? 0)).toBe(r.fight?.swings);
    expect(log.hitsTaken).toBeLessThanOrEqual(1);
  }, 20_000);

  it("clears zombies3 and husks3 taking at most two hits each", async () => {
    const zombies = zombies3();
    const pc = await start(zombies, { ...live, keyboardLagTicks: LAG_TICKS });
    await fightIn(pc, { timeoutMs: 30_000 });
    expect(zombies).toEqual([]);
    expect(game?.log.hitsTaken).toBeLessThanOrEqual(2);
    game?.stop();
    const husks = husks3();
    const pc2 = await start(husks, { ...live, keyboardLagTicks: LAG_TICKS });
    const r = await playIn(pc2, "kill 3 husks");
    expect(husks).toEqual([]);
    expect(r.stats.killed).toEqual({ husk: 3 });
    expect(game?.log.hitsTaken).toBeLessThanOrEqual(2);
  }, 80_000);

  it("kills a creeper without a blast", async () => {
    const pc = await start([mob("-41", "minecraft:creeper", 0, 8, 2.5)], { keyboardLagTicks: LAG_TICKS });
    const r = await fightIn(pc, { target: "-41", timeoutMs: 15_000 });
    expect(r.fight?.kills).toEqual({ creeper: 1 });
    expect(game?.log.blast).toBe(0);
  }, 20_000);
});
