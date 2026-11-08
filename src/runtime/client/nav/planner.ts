/**
 * A* over blocks with Bedrock movement rules: walk and sprint (eight directions, no corner cutting), step up one block
 * by jumping, stairs and slabs without a jump, drops of up to 3 blocks (any height into water), swimming, ladders and
 * vines, doors and fence gates to open, and sprint jumps over gaps of 1 to 3 blocks. Lava, fire, cactus, magma and
 * the like are never entered and cost extra to pass close by.
 */
import type { Vec3 } from "../player.ts";
import type { BlockClass, BlockGrid } from "./grid.ts";

export type MoveKind = "start" | "walk" | "jump" | "drop" | "gap" | "climb" | "swim" | "door";

/** One block of a path: where the feet are, the floor height there, and the move that gets there from the step before. */
export interface PathStep {
  x: number;
  y: number;
  z: number;
  /** Height the player stands at (y, or y + 0.5 on a bottom slab). */
  floor: number;
  move: MoveKind;
  /** Gap jumps: blocks of gap crossed. */
  gap?: number;
  /** Drops: blocks fallen. */
  fall?: number;
}

export interface PlanGoal {
  x: number;
  /** Without y any height at x/z counts. */
  y?: number;
  z: number;
  /** Arrive within this many blocks (horizontally) of x/z. */
  radius?: number;
}

export interface PlanOptions {
  /** Highest drop onto ground (default 3, which costs no health). Drops into water have no limit. */
  maxDrop?: number;
  /** Search limit (default 60000 blocks). */
  maxNodes?: number;
  /** The area the grid knows: a goal outside it gives a partial path toward it. */
  bounds?: { min: Vec3; max: Vec3 };
}

export type PlanStatus = "found" | "partial" | "unreachable" | "no_start";

export interface PlanResult {
  status: PlanStatus;
  path: PathStep[];
  cost: number;
  expanded: number;
  message: string;
}

type StandKind = "ground" | "water" | "ladder";

interface Stand {
  floor: number;
  kind: StandKind;
}

/** A block the body can be in without opening anything. */
export function passable(c: BlockClass): boolean {
  return c === "." || c === "d" || c === "H" || c === "w";
}

function openable(c: BlockClass): boolean {
  return c === "D" || c === "G";
}

function hazard(c: BlockClass): boolean {
  return c === "L" || c === "X";
}

/** Where a player can stand with the feet in block x/y/z, or null. */
export function standAt(g: BlockGrid, x: number, y: number, z: number): Stand | null {
  const feet = g.at(x, y, z);
  if (feet === "s") return passable(g.at(x, y + 1, z)) && passable(g.at(x, y + 2, z)) ? { floor: y + 0.5, kind: "ground" } : null;
  const head = g.at(x, y + 1, z);
  const fits = (c: BlockClass) => passable(c) || openable(c);
  if (!fits(feet) || !fits(head)) return null;
  if (feet === "w") return { floor: y, kind: "water" };
  if (feet === "H") return { floor: y, kind: "ladder" };
  const below = g.at(x, y - 1, z);
  return below === "#" || below === "t" ? { floor: y, kind: "ground" } : null;
}

/** Extra cost for standing next to lava, fire, cactus and the like. */
function dangerCost(g: BlockGrid, x: number, y: number, z: number): number {
  let n = 0;
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    for (let dy = -1; dy <= 1; dy++) if (hazard(g.at(x + dx, y + dy, z + dz))) n++;
  }
  return n * 3;
}

const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

interface Edge {
  x: number;
  y: number;
  z: number;
  floor: number;
  kind: StandKind;
  move: MoveKind;
  cost: number;
  gap?: number;
  fall?: number;
}

/** Every move from one standing block. */
export function neighbors(g: BlockGrid, x: number, y: number, z: number, from: Stand, maxDrop = 3): Edge[] {
  const out: Edge[] = [];
  const add = (nx: number, ny: number, nz: number, s: Stand, move: MoveKind, base: number, extra: Partial<Edge> = {}) => {
    // Under water (head in water too) costs more, so the path swims at the surface where there is air.
    const kindCost = s.kind === "water" ? (g.at(nx, ny + 1, nz) === "w" ? 4 : 2.5) : 1;
    out.push({ x: nx, y: ny, z: nz, floor: s.floor, kind: s.kind, move: s.kind === "water" && move === "walk" ? "swim" : move, cost: base * kindCost + dangerCost(g, nx, ny, nz), ...extra });
  };
  const headroom = passable(g.at(x, y + 2, z));
  for (const [dx, dz] of DIRS) {
    const diag = dx !== 0 && dz !== 0;
    const nx = x + dx;
    const nz = z + dz;
    const step = diag ? Math.SQRT2 : 1;
    if (diag) {
      // No cutting corners: both blocks beside the diagonal must be free at body height.
      const clear = (cx: number, cz: number) => passable(g.at(cx, y, cz)) && passable(g.at(cx, y + 1, cz)) && !hazard(g.at(cx, y - 1, cz));
      if (!clear(x + dx, z) || !clear(x, z + dz)) continue;
    }
    const doorIn = (ny: number) => openable(g.at(nx, ny, nz)) || openable(g.at(nx, ny + 1, nz));
    const same = standAt(g, nx, y, nz);
    if (same) {
      const dh = same.floor - from.floor;
      if (doorIn(y)) {
        if (!diag) add(nx, y, nz, same, "door", step + 2.5);
      } else if (dh <= 0.6) add(nx, y, nz, same, "walk", step);
      continue;
    }
    const up = standAt(g, nx, y + 1, nz);
    if (up) {
      if (diag || doorIn(y + 1)) continue;
      const dh = up.floor - from.floor;
      if (dh <= 0.6 || g.at(nx, y, nz) === "t") add(nx, y + 1, nz, up, "walk", step + 0.2);
      else if (dh <= 1.25 && headroom) add(nx, y + 1, nz, up, "jump", step + 0.8);
      continue;
    }
    // Walk out over an edge and fall to the first place to stand.
    if (passable(g.at(nx, y, nz)) && passable(g.at(nx, y + 1, nz))) {
      for (let k = 1; k <= 32; k++) {
        const yy = y - k;
        const land = standAt(g, nx, yy, nz);
        if (land) {
          const fall = from.floor - land.floor;
          if (land.kind === "water" || fall <= maxDrop + 0.01) add(nx, yy, nz, land, "drop", step + 0.3 * fall + (land.kind === "water" ? 0.5 : fall > 2 ? 1.5 : 0), { fall });
          break;
        }
        if (!passable(g.at(nx, yy, nz))) break;
      }
      // A hole too deep (or deadly) to drop into: jump over it below.
      if (!diag && from.kind === "ground" && headroom) gapJumps(g, x, y, z, dx, dz, from, add);
    }
  }
  // Ladders and water: straight up and down.
  if (from.kind !== "ground" || g.at(x, y, z) === "H") {
    const upS = standAt(g, x, y + 1, z);
    if (upS) add(x, y + 1, z, upS, from.kind === "water" ? "swim" : "climb", 1.6);
  }
  const below = g.at(x, y - 1, z);
  if (below === "H" || below === "w") {
    const downS = standAt(g, x, y - 1, z);
    if (downS) add(x, y - 1, z, downS, below === "w" ? "swim" : "climb", 1.2);
  }
  return out;
}

/** Sprint jumps from the edge over 1 to 3 blocks of gap, landing level or one lower. */
function gapJumps(
  g: BlockGrid,
  x: number,
  y: number,
  z: number,
  dx: number,
  dz: number,
  from: Stand,
  add: (nx: number, ny: number, nz: number, s: Stand, move: MoveKind, base: number, extra?: Partial<Edge>) => void,
): void {
  if (from.floor !== y) return;
  let overHazard = false;
  for (let n = 2; n <= 4; n++) {
    const cx = x + dx * (n - 1);
    const cz = z + dz * (n - 1);
    // The gap block: room for the arc, and nowhere to stand in it.
    if (!passable(g.at(cx, y, cz)) || !passable(g.at(cx, y + 1, cz)) || !passable(g.at(cx, y + 2, cz))) return;
    if (standAt(g, cx, y, cz)) return;
    if (hazard(g.at(cx, y - 1, cz)) || hazard(g.at(cx, y - 2, cz))) overHazard = true;
    const lx = x + dx * n;
    const lz = z + dz * n;
    // A run-up for 3-block gaps (sprint). A 2-block gap needs none: a walking jump clears it, and a jump chained from
    // the landing of the last one carries its speed, so a line of 1-block pillars works.
    for (let r = 1; r <= n - 3; r++) {
      const ry = standAt(g, x - dx * r, y, z - dz * r);
      if (!ry || ry.kind !== "ground" || ry.floor !== y || !passable(g.at(x - dx * r, y + 2, z - dz * r))) return;
    }
    for (const ly of [y, y - 1]) {
      const land = standAt(g, lx, ly, lz);
      if (land && land.kind === "ground" && passable(g.at(lx, ly + 2, lz)) && !openable(g.at(lx, ly, lz)) && !openable(g.at(lx, ly + 1, lz))) {
        add(lx, ly, lz, land, "gap", n + 2 + 2 * (n - 1) + (overHazard ? 6 : 0), { gap: n - 1 });
        return;
      }
    }
  }
}

/** Blocks the player could be standing in at a (fractional) position: the feet block first, then below and around. */
export function startCandidates(p: Vec3): [number, number, number][] {
  const bx = Math.floor(p.x);
  const bz = Math.floor(p.z);
  const by = Math.floor(p.y + 0.01);
  const out: [number, number, number][] = [];
  const cols: [number, number][] = [[bx, bz]];
  // The player is 0.6 wide and can stand over an edge: the blocks under the rest of the body.
  for (const ox of [-0.3, 0.3]) for (const oz of [-0.3, 0.3]) cols.push([Math.floor(p.x + ox), Math.floor(p.z + oz)]);
  for (const dy of [0, -1, 1, -2, -3]) for (const [cx, cz] of cols) out.push([cx, by + dy, cz]);
  return out;
}

class Heap {
  #keys: number[] = [];
  #f: number[] = [];
  get size(): number {
    return this.#keys.length;
  }
  push(key: number, f: number): void {
    const k = this.#keys;
    const fs = this.#f;
    let i = k.length;
    k.push(key);
    fs.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((fs[p] as number) <= f) break;
      k[i] = k[p] as number;
      fs[i] = fs[p] as number;
      i = p;
    }
    k[i] = key;
    fs[i] = f;
  }
  pop(): number {
    const k = this.#keys;
    const fs = this.#f;
    const top = k[0] as number;
    const lastK = k.pop() as number;
    const lastF = fs.pop() as number;
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && (fs[r] as number) < (fs[l] as number) ? r : l;
        if ((fs[c] as number) >= lastF) break;
        k[i] = k[c] as number;
        fs[i] = fs[c] as number;
        i = c;
      }
      k[i] = lastK;
      fs[i] = lastF;
    }
    return top;
  }
}

interface Node {
  x: number;
  y: number;
  z: number;
  floor: number;
  kind: StandKind;
  g: number;
  h: number;
  parent: number;
  move: MoveKind;
  gap?: number;
  fall?: number;
  closed: boolean;
}

/** Plan from `start` (the player's feet) to `goal` over the blocks of `grid`. */
export function plan(grid: BlockGrid, start: Vec3, goal: PlanGoal, options: PlanOptions = {}): PlanResult {
  const maxDrop = options.maxDrop ?? 3;
  const maxNodes = options.maxNodes ?? 60_000;
  const radius = goal.radius ?? 0.7;
  let first: { x: number; y: number; z: number; s: Stand } | undefined;
  for (const [x, y, z] of startCandidates(start)) {
    const s = standAt(grid, x, y, z);
    if (s) {
      first = { x, y, z, s };
      break;
    }
  }
  if (!first) {
    const b = `${Math.floor(start.x)}, ${Math.floor(start.y)}, ${Math.floor(start.z)}`;
    return { status: "no_start", path: [], cost: 0, expanded: 0, message: `no place to stand at the player's position (${b}): the block grid shows ${grid.at(Math.floor(start.x), Math.floor(start.y), Math.floor(start.z))} there` };
  }
  const ox = first.x;
  const oz = first.z;
  const key = (x: number, y: number, z: number) => ((x - ox + 1024) * 2048 + (z - oz + 1024)) * 1024 + (y + 512);
  const tx = Math.floor(goal.x);
  const tz = Math.floor(goal.z);
  const isGoal = (n: { x: number; z: number; floor: number }) => {
    const flat = (n.x === tx && n.z === tz) || Math.hypot(n.x + 0.5 - goal.x, n.z + 0.5 - goal.z) <= radius;
    return flat && (goal.y === undefined || Math.abs(n.floor - goal.y) <= 1.2);
  };
  const heuristic = (x: number, y: number, z: number) => {
    const ax = Math.abs(x + 0.5 - goal.x);
    const az = Math.abs(z + 0.5 - goal.z);
    const oct = Math.max(ax, az) + (Math.SQRT2 - 1) * Math.min(ax, az);
    const vert = goal.y === undefined ? 0 : Math.max(0, Math.abs(y - goal.y) - 1.2);
    return Math.max(0, oct - radius, vert);
  };
  const nodes = new Map<number, Node>();
  const open = new Heap();
  const k0 = key(first.x, first.y, first.z);
  const n0: Node = { x: first.x, y: first.y, z: first.z, floor: first.s.floor, kind: first.s.kind, g: 0, h: heuristic(first.x, first.y, first.z), parent: -1, move: "start", closed: false };
  nodes.set(k0, n0);
  open.push(k0, n0.h);
  let best = k0;
  let expanded = 0;
  let reached: number | undefined;
  while (open.size > 0) {
    const k = open.pop();
    const n = nodes.get(k) as Node;
    if (n.closed) continue;
    n.closed = true;
    expanded++;
    const bn = nodes.get(best) as Node;
    if (n.h < bn.h || (n.h === bn.h && n.g < bn.g)) best = k;
    if (isGoal(n)) {
      reached = k;
      break;
    }
    if (expanded >= maxNodes) break;
    for (const e of neighbors(grid, n.x, n.y, n.z, { floor: n.floor, kind: n.kind }, maxDrop)) {
      if (Math.abs(e.x - ox) > 1000 || Math.abs(e.z - oz) > 1000) continue;
      const ek = key(e.x, e.y, e.z);
      const g = n.g + e.cost;
      const old = nodes.get(ek);
      if (old && (old.closed || old.g <= g)) continue;
      const h = old?.h ?? heuristic(e.x, e.y, e.z);
      const node: Node = { x: e.x, y: e.y, z: e.z, floor: e.floor, kind: e.kind, g, h, parent: k, move: e.move, closed: false };
      if (e.gap !== undefined) node.gap = e.gap;
      if (e.fall !== undefined) node.fall = e.fall;
      nodes.set(ek, node);
      open.push(ek, g + h * 1.001);
    }
  }
  const trace = (end: number): PathStep[] => {
    const path: PathStep[] = [];
    for (let k = end; k !== -1; ) {
      const n = nodes.get(k) as Node;
      const step: PathStep = { x: n.x, y: n.y, z: n.z, floor: n.floor, move: n.move };
      if (n.gap !== undefined) step.gap = n.gap;
      if (n.fall !== undefined) step.fall = n.fall;
      path.push(step);
      k = n.parent;
    }
    return path.reverse();
  };
  const where = (n: { x: number; y: number; z: number }) => `${n.x}, ${n.y}, ${n.z}`;
  if (reached !== undefined) {
    const n = nodes.get(reached) as Node;
    return { status: "found", path: trace(reached), cost: n.g, expanded, message: `path of ${trace(reached).length - 1} moves to ${where(n)}` };
  }
  const b = nodes.get(best) as Node;
  const bounds = options.bounds;
  const inside =
    bounds !== undefined &&
    goal.x >= bounds.min.x &&
    goal.x < bounds.max.x + 1 &&
    goal.z >= bounds.min.z &&
    goal.z < bounds.max.z + 1 &&
    (goal.y === undefined || (goal.y >= bounds.min.y && goal.y < bounds.max.y + 1));
  const away = Math.hypot(b.x + 0.5 - goal.x, b.z + 0.5 - goal.z);
  if (inside && expanded < maxNodes) {
    return {
      status: "unreachable",
      path: trace(best),
      cost: b.g,
      expanded,
      message:
        `no way to reach ${goal.x}, ${goal.y ?? "any height"}, ${goal.z} from ${where(first)} within ${maxDrop} block drops, ` +
        `jumps of one block and gaps of up to 3 (searched ${expanded} blocks). The closest reachable spot is ${where(b)}, ${away.toFixed(1)} blocks away`,
    };
  }
  return {
    status: "partial",
    path: trace(best),
    cost: b.g,
    expanded,
    message: `the target is outside the known blocks, so the path ends at ${where(b)}, ${away.toFixed(1)} blocks from it`,
  };
}
