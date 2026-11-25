/**
 * rockide/schemas 0.2 routes by `format_version` with two custom keywords that its own build expands (upstream
 * `scripts/format_version_range.ts` and `scripts/format_version_enum.ts`, MIT). sculkwire compiles the source schemas
 * itself, so it expands them the same way when it loads a rockide file:
 *   `"x-format-version": "[1.19.10-1.19.20)"` (or an array of ranges; `]` inclusive, `)` exclusive, `latest` = the newest
 *   game version rockide knows) -> `anyOf: [{enum: [<each lower bound>]}, {type: "string", formatVersionRange: [...]}]`;
 *   `"x-format-version-enums": true` on a document -> its `format_version` enum lists every `allOf` branch's lower bound.
 * The enum is what the nearest-older fallback and `knownFormatVersions` read. Rockide matches a range with a generated
 * regex; the `formatVersionRange` keyword compares the numbers instead (same versions: `a.b` or `a.b.c`, no leading
 * zeros, `a.b` meaning `a.b.0`). Schemas of rockide 0.1, which carry the enums already, pass through unchanged.
 */
import type { JsonObject } from "../core/json.ts";
import { compareTuples } from "../core/version.ts";

export const RANGE_KEYWORD = "formatVersionRange";
const X_RANGE = "x-format-version";
const X_ENUMS = "x-format-version-enums";

/** One range as the expanded schema keeps it (plain JSON: the keyword's value goes through Ajv's schema hashing). */
export interface VersionRange {
  text: string;
  min: number[];
  max: number[];
  maxExclusive: boolean;
}

const RANGE_RE = /^\[(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+|latest)([\])])$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
const DATA_KEYS: Record<string, true> = { enum: true, const: true, default: true, examples: true, defaultSnippets: true };

const parts = (v: string): number[] => v.split(".").map(Number);

/** Parse one `[min-max]` / `[min-max)` range; `latest` stands for `latest`. Throws on any other shape. */
export function parseRange(annotation: string, latest: string): VersionRange {
  const text = annotation.replace(/\s/g, "");
  const m = RANGE_RE.exec(text);
  if (!m) throw new Error(`invalid ${X_RANGE} "${annotation}"`);
  return { text, min: parts(m[1] as string), max: parts(m[2] === "latest" ? latest : (m[2] as string)), maxExclusive: m[3] === ")" };
}

/** Whether `value` is a format_version string inside one of `ranges`. */
export function inRanges(value: unknown, ranges: readonly VersionRange[]): boolean {
  if (typeof value !== "string" || !VERSION_RE.test(value)) return false;
  const v = parts(value);
  return ranges.some((r) => {
    const top = compareTuples(v, r.max);
    return compareTuples(v, r.min) >= 0 && (r.maxExclusive ? top < 0 : top <= 0);
  });
}

function annotations(node: unknown): string[] {
  return typeof node === "string" ? [node] : Array.isArray(node) && node.every((x) => typeof x === "string") ? node : [];
}

/** Every schema object of `node`, skipping data (enum values, defaults, examples). */
function* schemaObjects(node: unknown): Generator<JsonObject> {
  if (Array.isArray(node)) {
    for (const v of node) yield* schemaObjects(v);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as JsonObject;
  yield o;
  for (const [k, v] of Object.entries(o)) if (!DATA_KEYS[k]) yield* schemaObjects(v);
}

/**
 * Expand both keywords in one loaded schema document, in place. `latest` is rockide's newest game version; without it,
 * the newest lower bound any range of the document names.
 */
export function expandFormatVersions(schema: JsonObject, latest: string | undefined): void {
  const nodes = [...schemaObjects(schema)].filter((o) => X_RANGE in o);
  if (nodes.length) {
    const newest =
      latest ??
      nodes
        .flatMap((o) => annotations(o[X_RANGE]))
        .map((a) => RANGE_RE.exec(a.replace(/\s/g, ""))?.[1])
        .filter((v): v is string => v !== undefined)
        .sort((a, b) => compareTuples(parts(a), parts(b)))
        .at(-1) ??
      "0.0.0";
    for (const o of nodes) {
      const list = annotations(o[X_RANGE]);
      if (!list.length) throw new Error(`invalid ${X_RANGE} ${JSON.stringify(o[X_RANGE])}`);
      for (const k of ["anyOf", "enum", "const", "pattern"]) if (k in o) throw new Error(`${X_RANGE} cannot stand beside "${k}"`);
      const ranges = list.map((a) => parseRange(a, newest));
      delete o[X_RANGE];
      o.anyOf = [{ enum: ranges.map((r) => r.min.join(".")) }, { type: "string", [RANGE_KEYWORD]: ranges as unknown as JsonObject[] }];
    }
  }
  if (X_ENUMS in schema) {
    if (schema[X_ENUMS] !== true) throw new Error(`invalid ${X_ENUMS} ${JSON.stringify(schema[X_ENUMS])}`);
    const first = branchEnumNode(schema);
    if (!first) throw new Error(`${X_ENUMS} without a format_version range`);
    delete schema[X_ENUMS];
    const branches = Array.isArray(schema.allOf) ? schema.allOf : [];
    first.enum = branches.flatMap((b) => {
      const values = branchEnumNode((b as JsonObject | undefined)?.if)?.enum;
      return Array.isArray(values) ? values : [];
    });
  }
}

/** `properties.format_version.anyOf[0]` of a schema node: where an expanded range keeps its lower bounds. */
function branchEnumNode(node: unknown): JsonObject | undefined {
  const fv = ((node as JsonObject | undefined)?.properties as JsonObject | undefined)?.format_version as JsonObject | undefined;
  const first = Array.isArray(fv?.anyOf) ? fv.anyOf[0] : undefined;
  return first && typeof first === "object" && !Array.isArray(first) ? (first as JsonObject) : undefined;
}
