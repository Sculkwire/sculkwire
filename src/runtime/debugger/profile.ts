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
  /** 1-based, as editors show it. */
  line: number;
  column: number;
  selfMs: number;
  totalMs: number;
  selfPercent: number;
}

export interface ProfileSummary {
  durationMs: number;
  sampleCount: number;
  functions: ProfileFunction[];
}

/** Self/total time per function (aggregated across call sites), sorted by self time, top `limit`. */
export function summarizeProfile(profile: CpuProfile, limit = 20): ProfileSummary {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfUs = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  if (samples.length > 0 && deltas.length === samples.length) {
    // timeDeltas[i] is the gap before sample i; attribute the gap after a sample to it (Chrome DevTools model).
    for (let i = 0; i < samples.length; i++) {
      const dt = deltas[i + 1] ?? 0;
      selfUs.set(samples[i]!, (selfUs.get(samples[i]!) ?? 0) + Math.max(0, dt));
    }
  } else {
    const hits = profile.nodes.reduce((s, n) => s + (n.hitCount ?? 0), 0);
    const per = hits > 0 ? (profile.endTime - profile.startTime) / hits : 0;
    for (const n of profile.nodes) selfUs.set(n.id, (n.hitCount ?? 0) * per);
  }

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
  const durationUs = Math.max(0, profile.endTime - profile.startTime);
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const hottest = new Map<string, number>();
  for (const n of profile.nodes) {
    const name = n.callFrame.functionName || "(anonymous)";
    if (name === "(root)" || name === "(program)" || name === "(idle)") continue;
    // Minecraft's captures carry the 1-based line of the sampled position (not the V8 0-based function start), so
    // one function shows up at several lines: aggregate per function and report its hottest sampled line.
    const key = `${name}\0${n.callFrame.url}`;
    let f = agg.get(key);
    if (!f) {
      f = {
        functionName: name,
        url: n.callFrame.url,
        line: Math.max(1, n.callFrame.lineNumber),
        column: Math.max(1, n.callFrame.columnNumber),
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
      f.line = Math.max(1, n.callFrame.lineNumber);
      f.column = Math.max(1, n.callFrame.columnNumber);
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
  return { durationMs: durationUs / 1000, sampleCount: samples.length, functions };
}

export function decodeCapture(base64: string): CpuProfile {
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as CpuProfile;
}
