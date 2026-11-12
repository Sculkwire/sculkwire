/**
 * `eat`: pick the best food in the hotbar, hold use until it is eaten (1.6 s in Bedrock), and confirm from the food
 * level or the stack count.
 */
import type { PlayerController } from "../player.ts";
import { bestFoodSlot, FOOD } from "./items.ts";
import { shortType } from "./mobs.ts";
import type { EatArgs, SkillResult } from "./types.ts";

/** Eating takes 32 ticks; polls start a little before and give up well after. */
const EAT_MS = 1600;

export async function eat(pc: PlayerController, args: EatArgs, signal?: AbortSignal): Promise<SkillResult> {
  const h = pc.hands;
  if (!pc.world.loadout) return { ok: false, message: "eat needs the helper's loadout query" };
  const before = await pc.world.loadout();
  const hunger = before.hunger ?? 0;
  const pick = args.slot !== undefined ? before.hotbar[args.slot - 1] : undefined;
  const food =
    args.slot !== undefined
      ? pick && FOOD[shortType(pick.typeId)]
        ? { slot: args.slot, typeId: pick.typeId, nutrition: FOOD[shortType(pick.typeId)]?.nutrition ?? 0 }
        : undefined
      : bestFoodSlot(before.hotbar, hunger);
  if (!food) {
    if (args.slot !== undefined) return { ok: false, message: `slot ${args.slot} holds ${pick ? shortType(pick.typeId) : "nothing"}, not food` };
    return { ok: false, message: hunger >= 20 ? "not hungry (food level 20)" : "no food in the hotbar" };
  }
  if (hunger >= 20 && !FOOD[shortType(food.typeId)]?.always) return { ok: false, message: "not hungry (food level 20)" };
  if (!(await h.selectSlot(food.slot, signal))) return { ok: false, message: `could not select slot ${food.slot}` };
  const count = (l: typeof before) => l.hotbar[food.slot - 1]?.typeId === food.typeId ? (l.hotbar[food.slot - 1]?.amount ?? 0) : 0;
  const started = h.now();
  const deadline = started + (args.timeoutMs ?? EAT_MS + 1500);
  await h.walk(undefined);
  await h.use(true);
  try {
    await h.sleep(EAT_MS, signal);
    for (;;) {
      const after = await pc.world.loadout();
      if (count(after) < count(before) || (after.hunger ?? 0) > hunger) {
        return { ok: true, message: `ate ${shortType(food.typeId)} in ${((h.now() - started) / 1000).toFixed(1)} s, food level ${hunger} -> ${after.hunger ?? "?"}` };
      }
      if (h.now() > deadline) return { ok: false, message: `held ${shortType(food.typeId)} for ${((h.now() - started) / 1000).toFixed(1)} s but nothing was eaten` };
      await h.sleep(150, signal);
    }
  } finally {
    await h.use(false);
  }
}
