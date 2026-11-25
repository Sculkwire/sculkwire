/**
 * Reads of the local world straight from the game's memory through the agent: entities and blocks from the integrated
 * server (`world.entities`, `world.block`, `world.blocks`) and the content log as the game emits it (`log.content`).
 * They answer in a game that has no helper pack and writes no content-log file, in the shapes the helper pack's
 * `game_query` and the content-log reader use, so a caller can take either.
 *
 * A field the agent cannot read is `null` or absent, never filled in here.
 */
import { dimensionParam } from "./dimension.ts";
import { engine, type EngineSession } from "./engine.ts";
import { invalid, malformed, type EngineResult } from "./failure.ts";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** One entity, in the fields the helper pack's `entities` query uses. */
export interface EngineEntity {
  /** The unique id as the Script API's `Entity.id` spells it (a signed whole number in text). */
  id: string;
  typeId: string | null;
  location: Vec3;
  dimension: string | null;
  velocity?: Vec3;
  health?: { current: number; max: number };
}

/** One block, in the fields the helper pack's `block` and `blocks` queries use. */
export interface EngineBlock {
  typeId: string | null;
  location: Vec3;
  states?: Record<string, string | number | boolean>;
}

export interface EntityQuery {
  x?: number;
  y?: number;
  z?: number;
  radius?: number;
  type?: string;
  limit?: number;
  dimension?: string | number;
}

export interface BlocksQuery {
  x?: number;
  y?: number;
  z?: number;
  radius?: number;
  type?: string;
  types?: string[];
  limit?: number;
  dimension?: string | number;
}

/** One content-log message as the game emitted it. `level` is the game's own name: verbose, inform, warning, error. */
export interface ContentLogEntry {
  seq: number;
  /** Milliseconds since the Unix epoch. */
  time: number;
  area: string | null;
  level: string | null;
  message: string;
}

export interface ContentLogPage {
  entries: ContentLogEntry[];
  /** The cursor for the next read (`since`). */
  next: number;
  /** Messages after `since` the agent's ring no longer held. */
  dropped: number;
  /** Whether the game hands messages to its content log now; null when the agent cannot tell yet. */
  emitting: boolean | null;
  /** The agent keeps the log emitting because no end point (file, GUI) is enabled. */
  forced: boolean;
}

function vec(raw: unknown, rounded: boolean): Vec3 | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const parts = [r.x, r.y, r.z];
  if (!parts.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  // Two decimals, as the helper pack rounds entity positions.
  const [x, y, z] = (parts as number[]).map((n) => (rounded ? Math.round(n * 100) / 100 : n)) as [number, number, number];
  return { x, y, z };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** `world.entities` answer → entities; undefined when it is not a list of entities. */
export function parseEntities(raw: unknown): EngineEntity[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: EngineEntity[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return undefined;
    const r = item as Record<string, unknown>;
    const location = vec(r.location, true);
    if (typeof r.id !== "string" || !/^-?\d+$/.test(r.id) || !location) return undefined;
    const entity: EngineEntity = { id: r.id, typeId: stringOrNull(r.typeId), location, dimension: stringOrNull(r.dimension) };
    const velocity = vec(r.velocity, true);
    if (velocity) entity.velocity = velocity;
    const health = r.health as Record<string, unknown> | undefined;
    if (health && typeof health.current === "number" && typeof health.max === "number") entity.health = { current: health.current, max: health.max };
    out.push(entity);
  }
  return out;
}

function parseStates(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** One block of a `world.block`/`world.blocks` answer. */
export function parseBlock(raw: unknown): EngineBlock | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const location = vec(r.location, false);
  if (!location) return undefined;
  const block: EngineBlock = { typeId: stringOrNull(r.typeId), location };
  const states = parseStates(r.states);
  if (states) block.states = states;
  return block;
}

export function parseBlocks(raw: unknown): EngineBlock[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: EngineBlock[] = [];
  for (const item of raw) {
    const block = parseBlock(item);
    if (!block) return undefined;
    out.push(block);
  }
  return out;
}

/** `log.content` answer → a page; undefined when it is not one. */
export function parseContentLog(raw: unknown): ContentLogPage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.entries) || typeof r.next !== "number" || typeof r.dropped !== "number") return undefined;
  const entries: ContentLogEntry[] = [];
  for (const item of r.entries) {
    if (!item || typeof item !== "object") return undefined;
    const e = item as Record<string, unknown>;
    if (typeof e.seq !== "number" || typeof e.time !== "number" || typeof e.message !== "string") return undefined;
    entries.push({ seq: e.seq, time: e.time, area: stringOrNull(e.area), level: stringOrNull(e.level), message: e.message });
  }
  return {
    entries,
    next: r.next,
    dropped: r.dropped,
    emitting: typeof r.emitting === "boolean" ? r.emitting : null,
    forced: r.forced === true,
  };
}

/** The point, radius, filters and dimension of a query, in the agent's parameter shape, or why they are not valid. */
function queryParams(query: EntityQuery | BlocksQuery): Record<string, unknown> | string {
  const params: Record<string, unknown> = {};
  const given = [query.x, query.y, query.z].filter((n) => n !== undefined).length;
  if (given !== 0 && given !== 3) return "give x, y and z together, or none of them";
  if (given === 3) Object.assign(params, { x: query.x, y: query.y, z: query.z });
  if (query.radius !== undefined) params.radius = query.radius;
  if (query.type !== undefined) params.type = query.type;
  if ("types" in query && query.types !== undefined) params.types = query.types;
  if (query.limit !== undefined) params.limit = query.limit;
  const dimension = dimensionParam(query.dimension);
  if (typeof dimension === "string") return dimension;
  return { ...params, ...dimension };
}

/** `world.entities`: the entities within `radius` of the point (the player's feet without one), nearest first. */
export async function worldEntities(query: EntityQuery, session: EngineSession = engine): Promise<EngineResult<EngineEntity[]>> {
  const params = queryParams(query);
  if (typeof params === "string") return invalid(params);
  const result = await session.call<unknown>("world.entities", params);
  if (!result.ok) return result;
  const entities = parseEntities(result.value);
  return entities ? { ok: true, value: entities } : malformed("world.entities", result.value);
}

/** `world.block`: one block, or null in an unloaded chunk or below the dimension's floor. */
export async function worldBlock(
  at: { x: number; y: number; z: number; dimension?: string | number },
  session: EngineSession = engine,
): Promise<EngineResult<EngineBlock | null>> {
  const dimension = dimensionParam(at.dimension);
  if (typeof dimension === "string") return invalid(dimension);
  const result = await session.call<unknown>("world.block", { x: at.x, y: at.y, z: at.z, ...dimension });
  if (!result.ok) return result;
  if (result.value === null) return { ok: true, value: null };
  const block = parseBlock(result.value);
  return block ? { ok: true, value: block } : malformed("world.block", result.value);
}

/** `world.blocks`: the non-air blocks in the cube of `radius` around the point (the player's feet without one). */
export async function worldBlocks(query: BlocksQuery, session: EngineSession = engine): Promise<EngineResult<EngineBlock[]>> {
  const params = queryParams(query);
  if (typeof params === "string") return invalid(params);
  const result = await session.call<unknown>("world.blocks", params);
  if (!result.ok) return result;
  const blocks = parseBlocks(result.value);
  return blocks ? { ok: true, value: blocks } : malformed("world.blocks", result.value);
}

/** `log.content`: the messages after `since` (0 for everything the agent holds), oldest first. */
export async function contentLog(since = 0, limit?: number, session: EngineSession = engine): Promise<EngineResult<ContentLogPage>> {
  const params: Record<string, unknown> = { since };
  if (limit !== undefined) params.limit = limit;
  const result = await session.call<unknown>("log.content", params);
  if (!result.ok) return result;
  const page = parseContentLog(result.value);
  return page ? { ok: true, value: page } : malformed("log.content", result.value);
}

/**
 * Content-log entries as the text of a content-log file (`HH:MM:SS[area][level]-message`, UTC, entries separated by a
 * blank line). An area or level the agent could not name is `unknown`, the word the game's own file writer prints then.
 */
export function contentLogText(entries: readonly ContentLogEntry[]): string {
  return entries
    .map((e) => `${new Date(e.time).toISOString().slice(11, 19)}[${e.area ?? "unknown"}][${e.level ?? "unknown"}]-${e.message}\n`)
    .join("\n");
}
