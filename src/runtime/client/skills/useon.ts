/**
 * `use_on`: hit each entity of a type once with the held item. A thrown or shot item (snowball, egg, bow, trident)
 * is launched at it with the ballistic aim of `shoot`; anything else is a melee hit. Entities already hit in this
 * play run are skipped, so "hit every cow once" visits each cow one time.
 */
import { projectileFor } from "../ballistics.ts";
import { horizontalDistance } from "../geometry.ts";
import type { PlayerController } from "../player.ts";
import type { EntityInfo } from "../types.ts";
import { isEntityId, typeIdOf } from "./target.ts";
import { shortType } from "./mobs.ts";
import { combatStats } from "./stats.ts";
import type { SkillResult, UseOnArgs } from "./types.ts";

export async function useOn(pc: PlayerController, args: UseOnArgs, signal?: AbortSignal): Promise<SkillResult> {
  const h = pc.hands;
  const stats = combatStats(pc);
  const started = h.now();
  const deadline = started + (args.timeoutMs ?? 60_000);
  const radius = args.radius ?? 24;
  const byId = isEntityId(args.target);
  const all = args.all ?? !byId;
  const typeId = byId ? undefined : typeIdOf(args.target);
  /** Tried in this run, hit or not, so one bad shot does not stall the rest. */
  const tried = new Set<string>();
  const next = async (): Promise<EntityInfo | undefined> => {
    if (byId) return tried.has(args.target) ? undefined : ((await pc.world.entity(args.target)) ?? undefined);
    const me = await pc.world.state(300);
    const list = pc.world.entities ? await pc.world.entities(radius) : [await pc.world.nearest(typeId, radius)].filter((e): e is EntityInfo => e !== null);
    return list
      .filter((e) => e.typeId === typeId && !stats.usedOn.has(e.id) && !tried.has(e.id))
      .sort((a, b) => horizontalDistance(a.location, me.location) - horizontalDistance(b.location, me.location))[0];
  };
  const hit: string[] = [];
  const missed: string[] = [];
  for (let e = await next(); e; e = all ? await next() : undefined) {
    if (h.now() > deadline || signal?.aborted) break;
    const s = await pc.world.state(300);
    const left = Math.max(1000, deadline - h.now());
    const r = projectileFor(s.holding?.typeId)
      ? await pc.shoot({ entity: e.id, shots: 3, timeoutMs: Math.min(left, 15_000) }, signal)
      : await pc.attack({ entity: e.id, hits: 1, timeoutMs: Math.min(left, 20_000) }, signal);
    tried.add(e.id);
    if (r.ok) stats.usedOn.set(e.id, e.typeId);
    (r.ok ? hit : missed).push(shortType(e.typeId));
    if (!r.ok && /hold a|needs .* in hand/.test(r.message)) return { ok: false, message: r.message };
  }
  const what = typeId ? shortType(typeId) : (hit[0] ?? missed[0] ?? args.target);
  if (hit.length + missed.length === 0) return { ok: false, message: `no ${what} left to hit within ${radius} blocks` };
  return { ok: missed.length === 0, message: `hit ${hit.length} ${what}(s)${missed.length ? `, missed ${missed.length}` : ""} in ${((h.now() - started) / 1000).toFixed(1)} s` };
}
