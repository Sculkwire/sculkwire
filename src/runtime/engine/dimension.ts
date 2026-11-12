/** The dimension a block position names, in every spelling a caller may use, sent to the agent as its bare name. */
import { z } from "zod";

/**
 * The dimensions the agent takes by name, in the game's own numbering (`VanillaDimensions`: 0, 1, 2). The agent and the
 * helper pack both take the bare name; callers may also give the `minecraft:` id or the number `engine_player` reports.
 */
export const DIMENSIONS = ["overworld", "nether", "the_end"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Every spelling a dimension input accepts: the bare name, the `minecraft:` id, or the numeric id 0, 1 or 2. */
export const dimensionSchema = z
  .union([z.enum([...DIMENSIONS, ...DIMENSIONS.map((name) => `minecraft:${name}` as const)]), z.number().int().min(0).max(2)])
  .describe("dimension: overworld, nether or the_end, as the bare name, the minecraft: id or the numeric id 0, 1 or 2");

/** The bare name the agent takes for a dimension input (also a numeric id in text, as the CLI passes it), or undefined. */
export function dimensionName(value: string | number): Dimension | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? DIMENSIONS[value] : undefined;
  const text = value.trim().toLowerCase();
  if (/^\d+$/.test(text)) return DIMENSIONS[Number(text)];
  const name = text.startsWith("minecraft:") ? text.slice("minecraft:".length) : text;
  return (DIMENSIONS as readonly string[]).includes(name) ? (name as Dimension) : undefined;
}

/** The `dimension` parameter for the agent, `{}` when none is given, or why the value is not a dimension. */
export function dimensionParam(value: string | number | undefined): { dimension?: Dimension } | string {
  if (value === undefined || (typeof value === "string" && !value.trim())) return {};
  const name = dimensionName(value);
  return name ? { dimension: name } : `dimension must be overworld, nether or the_end (bare, minecraft: or 0, 1, 2), not ${value}`;
}
