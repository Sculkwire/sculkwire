/** Game versions and release channels. Every knowledge artifact is tagged with both. */

export type Channel = "stable" | "preview";
export const CHANNELS: readonly Channel[] = ["stable", "preview"];

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

/** A concrete, resolved target: which channel and exactly which build the data describes. */
export interface VersionTag {
  channel: Channel;
  version: string;
}
