/** Projectile flight and the aim that hits a moving target. */
import { horizontalDistance, yawTo } from "./geometry.ts";
import type { Vec3 } from "./types.ts";

/**
 * Flight model of one projectile, per game tick (20 per second), with the vanilla update order: move by the
 * velocity, multiply it by `drag`, then subtract `gravity` from its vertical part. `spawnDrop` is how far below the
 * eye the projectile spawns (`offset` [0, -0.1, 0] from the eye anchor).
 */
export interface Ballistics {
  /** Launch speed in blocks per tick. */
  speed: number;
  gravity: number;
  drag: number;
  spawnDrop: number;
  /** Entity id of the flying projectile, as impacts report it. */
  entity: string;
  /** Held items that launch it. */
  items: string[];
  /** Launched by releasing a held right click (bow) instead of a click. */
  charged: boolean;
}

export type ProjectileKind = "snowball" | "egg" | "ender_pearl" | "arrow" | "trident";

/**
 * Bedrock values. Snowball, egg, ender pearl and trident come from the vanilla behavior pack's `minecraft:projectile`
 * (`power`, `gravity`, `inertia`, whose default is 0.99). The arrow speed is a full-charge bow (1 s draw), which
 * scales the launch speed to 3 blocks per tick as in Java Edition; its gravity is the vanilla arrow's 0.05.
 */
export const PROJECTILES: Record<ProjectileKind, Ballistics> = {
  snowball: { speed: 1.5, gravity: 0.03, drag: 0.99, spawnDrop: 0.1, entity: "minecraft:snowball", items: ["minecraft:snowball"], charged: false },
  egg: { speed: 1.5, gravity: 0.03, drag: 0.99, spawnDrop: 0, entity: "minecraft:egg", items: ["minecraft:egg", "minecraft:brown_egg", "minecraft:blue_egg"], charged: false },
  ender_pearl: { speed: 1.5, gravity: 0.025, drag: 1, spawnDrop: 0, entity: "minecraft:ender_pearl", items: ["minecraft:ender_pearl"], charged: false },
  arrow: { speed: 3, gravity: 0.05, drag: 0.99, spawnDrop: 0.1, entity: "minecraft:arrow", items: ["minecraft:bow"], charged: true },
  trident: { speed: 4, gravity: 0.1, drag: 0.99, spawnDrop: 0.1, entity: "minecraft:thrown_trident", items: ["minecraft:trident"], charged: true },
};

/** The projectile a held item launches, if any. */
export function projectileFor(itemId: string | undefined): ProjectileKind | undefined {
  if (!itemId) return undefined;
  return (Object.keys(PROJECTILES) as ProjectileKind[]).find((k) => PROJECTILES[k].items.includes(itemId));
}

/** Longest flight the solver considers (5 s). */
const MAX_FLIGHT_TICKS = 100;

/**
 * Where a projectile launched at `elevationDeg` (+ is up) is when it has covered `horizontal` blocks: its height
 * relative to the launch point and the flight time in (fractional) ticks. Null when it never gets that far.
 */
export function flightTo(b: Ballistics, elevationDeg: number, horizontal: number): { height: number; ticks: number } | null {
  const rad = (elevationDeg * Math.PI) / 180;
  let vh = b.speed * Math.cos(rad);
  let vy = b.speed * Math.sin(rad);
  let h = 0;
  let y = 0;
  for (let n = 1; n <= MAX_FLIGHT_TICKS; n++) {
    const nh = h + vh;
    const ny = y + vy;
    if (nh >= horizontal) {
      const f = vh > 0 ? (horizontal - h) / vh : 0;
      return { height: y + (ny - y) * f, ticks: n - 1 + f };
    }
    h = nh;
    y = ny;
    vh *= b.drag;
    vy = vy * b.drag - b.gravity;
  }
  return null;
}

/**
 * The lower (flatter) launch elevation that reaches a point `horizontal` blocks away and `height` blocks above the
 * launch point, or null when no elevation reaches it.
 */
function solveElevation(b: Ballistics, horizontal: number, height: number): { elevation: number; ticks: number } | null {
  const miss = (deg: number) => {
    const f = flightTo(b, deg, horizontal);
    return f ? f.height - height : Number.NEGATIVE_INFINITY;
  };
  // Scan upwards to the first elevation that passes at or above the point: the height there rises with elevation
  // until the angle of longest reach, so this is the lower solution.
  let lo = -89;
  if (miss(lo) >= 0) return { elevation: lo, ticks: flightTo(b, lo, horizontal)?.ticks ?? 0 };
  for (let deg = -88.5; deg <= 89; deg += 0.5) {
    const m = miss(deg);
    if (m >= 0) {
      let hi = deg;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (miss(mid) >= 0) hi = mid;
        else lo = mid;
      }
      const f = flightTo(b, hi, horizontal);
      return f ? { elevation: hi, ticks: f.ticks } : null;
    }
    lo = deg;
  }
  return null;
}

export type Intercept =
  | { ok: true; yaw: number; pitch: number; ticks: number; aim: Vec3 }
  | { ok: false; message: string };

/**
 * Aim that hits a target moving at constant `velocity` (blocks per tick) from `origin` (where the projectile spawns).
 * `leadTicks` is how long until the launch, during which the target keeps moving. Returns the view yaw and pitch
 * (Bedrock convention), the flight time and the point the projectile meets the target.
 */
export function solveIntercept(b: Ballistics, origin: Vec3, target: Vec3, velocity: Vec3, leadTicks = 0): Intercept {
  const at = (t: number): Vec3 => ({ x: target.x + velocity.x * t, y: target.y + velocity.y * t, z: target.z + velocity.z * t });
  let ticks = horizontalDistance(origin, target) / b.speed;
  let aim = at(leadTicks + ticks);
  for (let i = 0; i < 30; i++) {
    aim = at(leadTicks + ticks);
    const sol = solveElevation(b, horizontalDistance(origin, aim), aim.y - origin.y);
    if (!sol) {
      const d = horizontalDistance(origin, aim);
      return { ok: false, message: `the target is out of range: ${d.toFixed(1)} blocks away and ${(aim.y - origin.y).toFixed(1)} up, which no ${b.entity.replace("minecraft:", "")} launch angle reaches. Get closer` };
    }
    const converged = Math.abs(sol.ticks - ticks) < 0.01;
    ticks = sol.ticks;
    if (converged) {
      aim = at(leadTicks + ticks);
      return { ok: true, yaw: yawTo(origin, aim), pitch: -sol.elevation, ticks, aim };
    }
  }
  return { ok: false, message: "the target moves too fast to intercept" };
}

/** Horizontal velocity (blocks per tick) from timestamped positions, by a least-squares line over game ticks. */
export function estimateVelocity(samples: readonly { tick: number; location: Vec3 }[]): Vec3 {
  if (samples.length < 2) return { x: 0, y: 0, z: 0 };
  const n = samples.length;
  const mt = samples.reduce((a, s) => a + s.tick, 0) / n;
  const mx = samples.reduce((a, s) => a + s.location.x, 0) / n;
  const mz = samples.reduce((a, s) => a + s.location.z, 0) / n;
  let stt = 0;
  let stx = 0;
  let stz = 0;
  for (const s of samples) {
    const dt = s.tick - mt;
    stt += dt * dt;
    stx += dt * (s.location.x - mx);
    stz += dt * (s.location.z - mz);
  }
  if (stt === 0) return { x: 0, y: 0, z: 0 };
  return { x: stx / stt, y: 0, z: stz / stt };
}
