/** Summaries of V8 `.cpuprofile` documents returned by Minecraft's script profiler. */

interface CpuProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  hitCount?: number;
  children?: number[];
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

export interface ProfileFunction {
  functionName: string;
  url: string;
  /** 1-based, as editors show it. For a native function, the line of the script frame that called it. */
  line: number;
  column: number;
  /** A native Script API binding (`Test::succeed`, `System::currentTick`), not a function of the script. */
  native: boolean;
  selfMs: number;
  totalMs: number;
  selfPercent: number;
}

export interface ProfileSummary {
  durationMs: number;
  sampleCount: number;
  /** The sampling interval: the most time one sample is charged. */
  intervalMs: number;
  /** Capture time charged to no function: the script was not running (between game ticks, before the first sample). */
  idleMs: number;
  functions: ProfileFunction[];
}

/** V8's default sampling interval, which Minecraft's script profiler uses (pure script samples are 1000 µs apart). */
const DEFAULT_INTERVAL_US = 1000;

/** The capture carries no interval field: the median gap between samples, at least V8's default 1 ms. */
function samplingIntervalUs(deltas: number[]): number {
  const gaps = deltas
    .slice(1)
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  const median = gaps.length > 0 ? gaps[Math.floor((gaps.length - 1) / 2)]! : 0;
  return Math.max(DEFAULT_INTERVAL_US, median);
}

/**
 * Self/total time per function (aggregated across call sites), sorted by self time, top `limit`.
 *
 * Minecraft's profiler samples only while script code runs (every interval, plus one sample per native binding call)
 * and records no idle samples, so the gap after a tick's last sample is the time until the next tick's script work.
 * A sample is charged the gap to the next sample (the Chrome DevTools model) but at most one sampling interval: a
 * longer gap means the script had stopped, and the rest of it is idle. `selfPercent` is percent of the capture duration.
 */
export function summarizeProfile(profile: CpuProfile, limit = 20): ProfileSummary {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfUs = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const durationUs = Math.max(0, profile.endTime - profile.startTime);
  const intervalUs = samplingIntervalUs(deltas);
  if (samples.length > 0 && deltas.length === samples.length) {
    // timeDeltas[i] is the gap before sample i; the gap after the last sample runs to endTime.
    const lastAt = deltas.reduce((s, d) => s + d, profile.startTime);
    for (let i = 0; i < samples.length; i++) {
      const gap = i + 1 < deltas.length ? deltas[i + 1]! : profile.endTime - lastAt;
      selfUs.set(samples[i]!, (selfUs.get(samples[i]!) ?? 0) + Math.min(intervalUs, Math.max(0, gap)));
    }
  } else {
    // Hit counts only: one interval per hit, scaled down if the hits would not fit in the capture.
    const hits = profile.nodes.reduce((s, n) => s + (n.hitCount ?? 0), 0);
    const per = hits > 0 ? Math.min(intervalUs, durationUs / hits) : 0;
    for (const n of profile.nodes) selfUs.set(n.id, (n.hitCount ?? 0) * per);
  }
  let chargedUs = 0;
  for (const [id, us] of selfUs) if (byId.get(id)?.callFrame.functionName !== "(idle)") chargedUs += us;

  const totalUs = new Map<number, number>();
  const total = (id: number, seen: Set<number>): number => {
    const cached = totalUs.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    let t = selfUs.get(id) ?? 0;
    for (const c of byId.get(id)?.children ?? []) t += total(c, seen);
    totalUs.set(id, t);
    return t;
  };

  const agg = new Map<string, ProfileFunction>();
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const hottest = new Map<string, number>();
  // Minecraft names a native Script API binding `Class::member`. Its frame has no source, and the line the capture
  // gives it is not the call: it is the last line of the calling function (its final return, sometimes the line
  // after), so such a frame is placed at the position of the nearest script frame that called it.
  const isNative = (node: CpuProfileNode): boolean => node.callFrame.functionName.includes("::");
  const position = (node: CpuProfileNode): { lineNumber: number; columnNumber: number } => {
    if (!isNative(node)) return node.callFrame;
    for (let p = parent.get(node.id); p !== undefined; p = parent.get(p)) {
      const pn = byId.get(p);
      if (pn && !isNative(pn) && pn.callFrame.url === node.callFrame.url && pn.callFrame.lineNumber > 0) return pn.callFrame;
    }
    return node.callFrame;
  };
  for (const n of profile.nodes) {
    const name = n.callFrame.functionName || "(anonymous)";
    if (name === "(root)" || name === "(program)" || name === "(idle)") continue;
    // Minecraft's captures carry the 1-based line of the sampled position (not the V8 0-based function start), so
    // one function shows up at several lines: aggregate per function and report its hottest sampled line.
    const key = `${name}\0${n.callFrame.url}`;
    const at = position(n);
    let f = agg.get(key);
    if (!f) {
      f = {
        functionName: name,
        url: n.callFrame.url,
        line: Math.max(1, at.lineNumber),
        column: Math.max(1, at.columnNumber),
        native: isNative(n),
        selfMs: 0,
        totalMs: 0,
        selfPercent: 0,
      };
      agg.set(key, f);
    }
    const self = selfUs.get(n.id) ?? 0;
    const hot = hottest.get(key) ?? -1;
    if (self > hot) {
      hottest.set(key, self);
      f.line = Math.max(1, at.lineNumber);
      f.column = Math.max(1, at.columnNumber);
    }
    f.selfMs += self / 1000;
    // Count a subtree once per outermost frame of the function (recursion would double count).
    let outermost = true;
    for (let p = parent.get(n.id); p !== undefined; p = parent.get(p)) {
      const pn = byId.get(p);
      if (pn && (pn.callFrame.functionName || "(anonymous)") === name && pn.callFrame.url === n.callFrame.url) {
        outermost = false;
        break;
      }
    }
    if (outermost) f.totalMs += total(n.id, new Set()) / 1000;
  }
  const functions = [...agg.values()]
    .map((f) => ({
      ...f,
      selfMs: Math.round(f.selfMs * 1000) / 1000,
      totalMs: Math.round(f.totalMs * 1000) / 1000,
      selfPercent: durationUs > 0 ? Math.round((f.selfMs * 1000 * 10000) / durationUs) / 100 : 0,
    }))
    .sort((a, b) => b.selfMs - a.selfMs || b.totalMs - a.totalMs)
    .slice(0, limit);
  return {
    durationMs: durationUs / 1000,
    sampleCount: samples.length,
    intervalMs: intervalUs / 1000,
    idleMs: Math.round(Math.max(0, durationUs - chargedUs)) / 1000,
    functions,
  };
}

export function decodeCapture(base64: string): CpuProfile {
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as CpuProfile;
}
