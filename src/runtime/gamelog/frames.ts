export interface FrameLocation {
  /** Path as the game reported it (relative to the pack's `scripts/` folder, or with a `scripts/` prefix). */
  file: string;
  line: number;
  column?: number;
}

/** `(main.js:7)`, `at fn (lib/util.js:12:5)`, `at lib/util.js:3`: the frames Minecraft prints for script code. */
const FRAME_RE = /(?:\(|\bat\s+)([\w\-./\\ @]+?\.(?:js|mjs|cjs|ts)):(\d+)(?::(\d+))?\)?/g;

/** Every script location in a print or log message, in order of appearance (first = throw site). */
export function parseLocations(message: string): FrameLocation[] {
  const out: FrameLocation[] = [];
  for (const m of message.matchAll(FRAME_RE)) {
    const loc: FrameLocation = { file: m[1]!.trim().replaceAll("\\", "/"), line: Number(m[2]) };
    if (m[3] !== undefined) loc.column = Number(m[3]);
    out.push(loc);
  }
  return out;
}
