/** Game versions and release channels. Every knowledge artifact is tagged with both. */

export type Channel = "stable" | "preview";
export const CHANNELS = ["stable", "preview"] as const satisfies readonly Channel[];

export function isChannel(value: string): value is Channel {
  return value === "stable" || value === "preview";
}

/** Internal 1.x numbering (`1.26.60.30`), not the marketing name (`26.60`). */
export interface GameVersion {
  major: number;
  minor: number;
  patch: number;
  /** Build/revision; preview builds always have one. */
  build?: number;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/;

export function parseGameVersion(text: string): GameVersion | undefined {
  const m = VERSION_RE.exec(text.trim());
  if (!m) return undefined;
  const v: GameVersion = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  if (m[4] !== undefined) v.build = Number(m[4]);
  return v;
}

export function formatGameVersion(v: GameVersion): string {
  return v.build === undefined ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}.${v.patch}.${v.build}`;
}

/** Missing build sorts before any build of the same patch. */
export function compareGameVersions(a: GameVersion, b: GameVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || (a.build ?? -1) - (b.build ?? -1);
}

/** Numeric tuples compared element-wise; a missing element counts as 0 (`[1, 21]` equals `[1, 21, 0]`). */
export function compareTuples(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Dotted numeric versions (`1.21.60`, `0.1.4`) compared part by part. */
export function compareDotted(a: string, b: string): number {
  return compareTuples(a.split(".").map(Number), b.split(".").map(Number));
}
