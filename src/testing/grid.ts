/** The helper's `grid` reply as tests build it. */
import { SECTION, type BlockClass } from "../runtime/client/nav/grid.ts";

/**
 * One 16-block section at `bx, by, bz` as the helper's `grid` reply encodes it (`decodeRegions` reads it back): runs
 * along x of one class each, unknown blocks (`u`) left out.
 */
export function encodeRegions(bx: number, by: number, bz: number, cls: (x: number, y: number, z: number) => BlockClass): string {
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
