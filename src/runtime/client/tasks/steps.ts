/**
 * `runTaskStep`: one non-combat task step run to its end inside sculkwire, with a typed result the caller can act on.
 * `gained` is measured from the inventory before and after, never assumed, and `ok` is whether the step's aim holds
 * afterwards (`taskStepDone`), not whether its procedure ran through. The screen it opened is closed and every input
 * released, whatever ends it (done, failed, cancelled).
 */
import type { PlayerInventory } from "../../engine/inventory.ts";
import { resolveName } from "./names.ts";
import { bareId, namespaced } from "./recipes.ts";
import { center, distance, nothingFound, Run, StepFail, STATION_RADIUS, xyz } from "./run.ts";
import { findEntities } from "./search.ts";
import { carriedStacks, countsOf, gainedBetween } from "./stock.ts";
import type { InventoryCounts, TaskEnv, TaskProbe, TaskStep, TaskStepResult } from "./types.ts";

/** Standing within this many blocks (horizontally) of a block's center or an entity counts as next to it. */
const NEXT_TO = STATION_RADIUS + 1;

/** The id a step's own text names when nothing resolved it: `iron sword` -> `minecraft:iron_sword`. */
function plainId(text: string): string {
  return namespaced(text.trim().toLowerCase().replace(/\s+/g, "_"));
}

function countOfStep(step: TaskStep): number {
  return "count" in step && step.count !== undefined ? step.count : 1;
}

/** Whether the step's aim holds now: enough more of the item, the item held or worn, or standing next to the target. */
export function taskStepDone(step: TaskStep, before: InventoryCounts, now: InventoryCounts, probe: TaskProbe = {}): boolean {
  switch (step.kind) {
    case "craft":
    case "smelt":
    case "trade":
    case "fetch": {
      const item = probe.item ?? plainId(step.item);
      return (now[item] ?? 0) - (before[item] ?? 0) >= (probe.count ?? countOfStep(step));
    }
    case "equip": {
      const item = probe.item ?? plainId(step.item);
      return probe.held === item || probe.offhand === item || (probe.armor ?? []).includes(item);
    }
    case "reach_block":
    case "reach_entity":
      return probe.distance !== undefined && probe.distance <= NEXT_TO;
  }
}

interface Outcome {
  message: string;
  probe: TaskProbe;
}

/** A name every rule left tied: the step fails naming the candidates, so the caller can name one. */
function ambiguous(raw: string, purpose: string, tied: readonly string[], unmakeable = false): StepFail {
  const why = unmakeable ? " (none of them can be made from what is at hand)" : "";
  return new StepFail("not_found", `"${raw}" as ${purpose} could mean ${tied.map(bareId).join(" or ")} equally${why}: name one`);
}

/**
 * Resolve an item name by the rules in `names.ts`; a name that matches nothing, or that stays tied between several
 * items, fails the step. With `craft`, a phrase naming several variants takes one that can be made from what is at
 * hand (`Run.makeable`).
 */
async function resolveItem(
  run: Run,
  raw: string,
  purpose: string,
  options: { near?: InventoryCounts; craft?: boolean } = {},
): Promise<{ id: string; chosen?: string; considered?: string[] }> {
  const resolution = await resolveName({
    raw,
    universe: await run.universe(),
    atHand: await run.counts(),
    ...(options.near ? { near: options.near } : {}),
    ...(options.craft ? { makeable: (id: string, from: "inventory" | "near") => run.makeable(id, from) } : {}),
  });
  if (resolution.chosen) run.actions.push(`"${raw}" names ${resolution.candidates.length} items; took ${bareId(resolution.id ?? "")}: ${resolution.chosen}`);
  if (resolution.tied) throw ambiguous(raw, purpose, resolution.tied, resolution.considered !== undefined);
  if (!resolution.id) throw new StepFail("not_found", `no item matches "${raw}"`);
  return {
    id: resolution.id,
    ...(resolution.chosen ? { chosen: resolution.chosen } : {}),
    ...(resolution.considered ? { considered: resolution.considered } : {}),
  };
}

function amount(n: number, item: string): string {
  return `${n} ${bareId(item)}`;
}

function notesText(run: Run): string {
  return run.notes.length ? ` (${run.notes.join(", ")} first)` : "";
}

async function craft(run: Run, step: Extract<TaskStep, { kind: "craft" }>): Promise<Outcome> {
  const { id: item, chosen, considered } = await resolveItem(run, step.item, "the item to craft", { craft: true });
  const count = countOfStep(step);
  try {
    if (run.env.recipes) await run.make(item, count, 0, "craft");
    else await craftWithoutIndex(run, item, count);
  } catch (err) {
    // "a pickaxe" and none of its variants makeable: say which were weighed.
    if (err instanceof StepFail && considered) {
      throw new StepFail(err.reason, `${err.message} (took ${bareId(item)} for "${step.item}"; none of ${considered.map(bareId).join(", ")} can be made from what is at hand)`);
    }
    throw err;
  }
  const why = chosen ? ` (chosen for "${step.item}": ${chosen})` : "";
  return { message: `made ${amount(count, item)}${notesText(run)}${why}`, probe: { item } };
}

/**
 * Without a recipe index nothing says which ingredients make the item, so the game's own lookup is asked about each
 * single item the inventory holds (planks from a log, a button from a plank, dye from a flower), and the first that
 * makes it is crafted in the inventory's grid.
 */
async function craftWithoutIndex(run: Run, item: string, count: number): Promise<void> {
  const note = `no recipe index (${run.env.recipesNote ?? "the recipes could not be read"}), so the game's own recipe lookup was asked about each item the inventory holds`;
  run.actions.push(note);
  for (const id of Object.keys(await run.counts())) {
    const match = await run.call("looking up a recipe", run.env.engine.craftMatch({ ingredients: [id], table: false }));
    if (!match.recipe || match.result?.item !== item) continue;
    const times = Math.ceil(count / match.result.count);
    if (!(await run.openInventory())) break;
    try {
      await run.act(`crafting ${bareId(item)} (${match.recipe.id})`, { action: "craft", recipe: match.recipe.id, times });
      run.actions.push(`crafted ${bareId(item)} ${times} time${times === 1 ? "" : "s"} from ${bareId(id)}`);
      return;
    } finally {
      await run.close();
    }
  }
  throw new StepFail("not_found", `${note}, and none of them makes ${bareId(item)}`);
}

async function smelt(run: Run, step: Extract<TaskStep, { kind: "smelt" }>): Promise<Outcome> {
  const index = run.env.recipes;
  if (!index) throw new StepFail("not_found", `no recipe index to tell what a furnace makes: ${run.env.recipesNote ?? "the recipes could not be read"}`);
  const { id: item } = await resolveItem(run, step.item, "the item to smelt or the item to get from smelting");
  const count = countOfStep(step);
  if (index.recipesFor(item).some((recipe) => recipe.kind === "furnace")) {
    await run.make(item, count, 0, "smelt");
    return { message: `smelted ${amount(count, item)}${notesText(run)}`, probe: { item } };
  }
  const from = index.smeltingFrom(item)[0];
  if (!from) throw new StepFail("not_found", `no furnace recipe in ${index.source} makes ${bareId(item)} or takes it`);
  const output = from.result.item;
  await run.make(output, count, 0, "smelt", item);
  return { message: `smelted ${amount(count, item)} into ${amount(count, output)}${notesText(run)}`, probe: { item: output } };
}

async function trade(run: Run, step: Extract<TaskStep, { kind: "trade" }>): Promise<Outcome> {
  const { id: item } = await resolveItem(run, step.item, "the item to buy from a villager");
  const count = countOfStep(step);
  await run.trade(item, count);
  return { message: `bought ${amount(count, item)}${notesText(run)}`, probe: { item } };
}

async function fetch(run: Run, step: Extract<TaskStep, { kind: "fetch" }>): Promise<Outcome> {
  const near = await run.nearCounts();
  const { id: item } = await resolveItem(run, step.item, "the item to take out of the containers near", { near });
  const containers = (await run.containers()).length;
  const where = `the ${containers} container${containers === 1 ? "" : "s"} within ${run.containersWithin}`;
  const there = near[item] ?? 0;
  if (there === 0) throw new StepFail("not_found", `no ${bareId(item)} in ${where}`);
  // `all`: every one the containers hold. The first read is what the step must end with at least; the fetch reads
  // the containers again after each round and takes what is still there.
  const count = step.all ? there : countOfStep(step);
  const taken = await run.fetch({ item }, count, step.all === true);
  const placed = run.placed.length ? `; ${run.placed.join(" and ")} stays placed (a step never breaks blocks)` : "";
  if (step.all) {
    const left = (await run.nearCounts())[item] ?? 0;
    if (taken < there || left > 0) {
      throw new StepFail("not_found", `took ${taken} of the ${amount(there, item)} ${where} held at first, and ${left} still read as there${placed}`);
    }
  } else if (taken < count) {
    throw new StepFail("not_found", `took ${taken} of ${amount(count, item)}: ${where} held ${there}${placed}`);
  }
  // The aim: at least what the first read showed (`all`), or what was asked.
  return { message: `took ${step.all ? `all ${amount(taken, item)}` : amount(taken, item)} out of ${where}${placed}`, probe: { item, count } };
}

/** The armor slot an item is worn in (0 head, 1 chest, 2 legs, 3 feet), "offhand" for a shield, else held. */
function wornAt(item: string): number | "offhand" | "hand" {
  const id = bareId(item);
  if (id === "shield") return "offhand";
  if (/_helmet$|^carved_pumpkin$|_skull$|_head$/.test(id)) return 0;
  if (/_chestplate$|^elytra$/.test(id)) return 1;
  if (/_leggings$/.test(id)) return 2;
  if (/_boots$/.test(id)) return 3;
  return "hand";
}

function probeOf(inventory: PlayerInventory, item: string): TaskProbe {
  const armor = Object.values(inventory.armor).flatMap((slot) => (slot ? [slot.item] : []));
  return { item, held: inventory.hotbar[inventory.selectedSlot - 1]?.item ?? null, armor, offhand: inventory.offhand?.item ?? null };
}

async function equip(run: Run, step: Extract<TaskStep, { kind: "equip" }>): Promise<Outcome> {
  const { id: item } = await resolveItem(run, step.item, "the item to hold or wear");
  const where = wornAt(item);
  const verb = where === "hand" ? "holding" : where === "offhand" ? "holding in the off hand" : "wearing";
  let inventory = await run.inventory();
  if (taskStepDone(step, {}, {}, probeOf(inventory, item))) return { message: `already ${verb} ${bareId(item)}`, probe: probeOf(inventory, item) };
  if (!(countsOf(inventory)[item] ?? 0)) {
    await run.ensure({ item }, 1, 0);
    inventory = await run.inventory();
  }
  if (where === "hand") {
    let slot = inventory.hotbar.findIndex((stack) => stack?.item === item) + 1;
    if (slot === 0) {
      const state = await run.openInventory();
      if (!state) throw new StepFail("refused", `${bareId(item)} is in the main inventory and the inventory screen did not open to move it to the hotbar`);
      try {
        const target = carriedStacks(state, inventory).find((stack) => stack.hotbar !== undefined && !stack.slot);
        if (!target?.hotbar) throw new StepFail("refused", `no empty hotbar slot to move ${bareId(item)} into`);
        if ((await run.moveIn((id) => id === item, bareId(item), target.ref, 1)) < 1) throw new StepFail("refused", `${bareId(item)} could not be moved to the hotbar`);
        slot = target.hotbar;
      } finally {
        await run.close();
      }
    }
    if (!(await run.env.controller.selectSlot(slot, run.signal))) throw new StepFail("refused", `selecting hotbar slot ${slot} failed`);
    run.actions.push(`selected hotbar slot ${slot} (${bareId(item)})`);
  } else {
    const state = await run.openInventory();
    if (!state) throw new StepFail("refused", `the inventory screen did not open to put on ${bareId(item)}`);
    try {
      const keys = Object.keys(state.containers);
      const to =
        where === "offhand"
          ? { container: keys.find((key) => /offhand/i.test(key)) ?? "OffhandContainer", slot: 0 }
          : { container: keys.find((key) => /armor/i.test(key)) ?? "ArmorContainer", slot: where };
      if ((await run.moveIn((id) => id === item, bareId(item), to, 1)) < 1) throw new StepFail("refused", `${bareId(item)} could not be moved to ${to.container}:${to.slot}`);
    } finally {
      await run.close();
    }
  }
  const after = probeOf(await run.inventory(), item);
  return { message: `${verb} ${bareId(item)}`, probe: after };
}

async function reachBlock(run: Run, step: Extract<TaskStep, { kind: "reach_block" }>): Promise<Outcome> {
  const registry = await run.env.registry?.("block").catch(() => [] as string[]);
  const resolution = await resolveName({ raw: step.block, universe: registry?.length ? registry : [plainId(step.block)], atHand: {} });
  if (resolution.tied) throw ambiguous(step.block, "the block to stand next to", resolution.tied);
  const block = resolution.id ?? plainId(step.block);
  const search = await run.blocksNear([block]);
  const found = search.found;
  if (!found.length) throw nothingFound("not_found", bareId(block), search, [block]);
  const tried: string[] = [];
  for (const target of found.slice(0, 3)) {
    const walked = await run.walkToBlock(target);
    if (walked) {
      tried.push(`${xyz(target.location)}: ${walked}`);
      continue;
    }
    const me = await run.env.controller.position();
    const goal = center(target.location);
    return { message: `standing next to the ${bareId(block)} at ${xyz(target.location)}`, probe: { distance: Math.hypot(me.x - goal.x, me.z - goal.z) } };
  }
  throw new StepFail("unreachable", `no way to the ${bareId(block)} within ${search.within} (${tried.join("; ")})`);
}

async function reachEntity(run: Run, step: Extract<TaskStep, { kind: "reach_entity" }>): Promise<Outcome> {
  const type = plainId(step.type);
  // The game's villagers are `villager_v2` (and zombie villagers `zombie_villager_v2`); the plain name means them too.
  const types = [type, `${type}_v2`];
  const search = await findEntities(run.env, types, { radius: run.radius });
  const target = search.found[0];
  if (!target) throw nothingFound("not_found", bareId(type), search, types);
  run.check();
  const walk = await run.env.controller.walkTo({ entity: target.id }, STATION_RADIUS, run.signal);
  run.check();
  if (!walk.ok) throw new StepFail("unreachable", `no way to the ${bareId(target.typeId)} at ${xyz(target.location)}: ${walk.message}`);
  run.actions.push(`walked to the ${bareId(target.typeId)} ${target.id}`);
  const now = (await run.env.query.entities(target.typeId, run.radius).catch(() => [])).find((entity) => entity.id === target.id);
  const at = await run.env.controller.position();
  const probe: TaskProbe = now ? { distance: Math.hypot(at.x - now.location.x, at.z - now.location.z) } : {};
  return { message: `standing next to the ${bareId(target.typeId)} at ${xyz(now?.location ?? target.location)}`, probe };
}

function perform(step: TaskStep, run: Run): Promise<Outcome> {
  switch (step.kind) {
    case "craft":
      return craft(run, step);
    case "smelt":
      return smelt(run, step);
    case "trade":
      return trade(run, step);
    case "fetch":
      return fetch(run, step);
    case "equip":
      return equip(run, step);
    case "reach_block":
      return reachBlock(run, step);
    case "reach_entity":
      return reachEntity(run, step);
  }
}

function gainedText(gained: Record<string, number>): string {
  const parts = Object.entries(gained).map(([id, n]) => `${n > 0 ? "+" : ""}${n} ${bareId(id)}`);
  return parts.length ? parts.join(", ") : "no change";
}

export async function runTaskStep(step: TaskStep, env: TaskEnv, signal?: AbortSignal): Promise<TaskStepResult> {
  const started = env.clock.now();
  const run = new Run(env, signal);
  let before: InventoryCounts | undefined;
  let outcome: Outcome | undefined;
  let failure: StepFail | undefined;
  try {
    before = await run.counts();
    outcome = await perform(step, run);
  } catch (err) {
    failure =
      err instanceof StepFail
        ? err
        : signal?.aborted
          ? new StepFail("cancelled", "the step was cancelled")
          : new StepFail("refused", err instanceof Error ? err.message : String(err));
  } finally {
    await run.close();
    await env.controller.release().catch(() => undefined);
  }
  if (signal?.aborted && !failure) failure = new StepFail("cancelled", "the step was cancelled");
  const read = await env.engine.readInventory().catch(() => undefined);
  const after = read?.ok ? countsOf(read.value.inventory) : undefined;
  const gained = before && after ? gainedBetween(before, after) : {};
  const base = { step, ms: env.clock.now() - started, actions: run.actions, gained };
  if (failure) return { ...base, ok: false, message: failure.message, reason: failure.reason };
  const done = !!outcome && !!before && !!after && taskStepDone(step, before, after, outcome.probe);
  if (done) return { ...base, ok: true, message: outcome?.message ?? "" };
  return {
    ...base,
    ok: false,
    reason: "refused",
    message: `${outcome?.message ?? "the step ran"}, but its aim does not hold afterwards (${after ? `the inventory shows ${gainedText(gained)}` : "the inventory could not be read"})`,
  };
}
