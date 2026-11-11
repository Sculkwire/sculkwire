// sculkwire helper (MIT): answers `/scriptevent sculkwire:query <json>` with one console line
// `[sculkwire:reply] {"id":..,"ok":true,"result":..}` that the bridge reads from the script debugger
// (PrintEvent) or the content log.
import { BlockTypes, BlockVolume, EntityTypes, ItemTypes, system, world } from "@minecraft/server";

const MAX_ENTITIES = 200;
const MAX_BLOCKS = 2000;

function vec(v) {
  return { x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100, z: Math.round(v.z * 100) / 100 };
}

/**
 * The player the helper reports on. A single-player world lists one, but after a rejoin or a sign-in race the list can
 * hold a second handle: the helper prefers the handle the newest `playerSpawn` event delivered (the same object, else
 * the one listed handle with its id), then the newest valid one in the list, never a handle the API marks invalid.
 */
function thePlayer() {
  const all = world.getAllPlayers().filter((p) => p.isValid !== false);
  if (all.length <= 1) return all[0];
  if (spawned && spawned.isValid !== false && all.includes(spawned)) return spawned;
  const same = spawned ? all.filter((p) => p.id === spawned.id) : [];
  return same.length === 1 ? same[0] : all[all.length - 1];
}
/** The player handle of the newest `playerSpawn` event (first spawn, respawn and rejoin all fire it). */
let spawned;

function anchor(q) {
  const player = thePlayer();
  if (q.x !== undefined && q.y !== undefined && q.z !== undefined) {
    const dim = world.getDimension(q.dimension ?? player?.dimension.id ?? "overworld");
    return { dim, at: { x: q.x, y: q.y, z: q.z }, player };
  }
  if (!player) throw new Error("no player in the world and no x/y/z given");
  return { dim: player.dimension, at: player.location, player };
}

/** What a query reports about one entity: identity, position, velocity, tags, health and active effects. */
function entityInfo(e) {
  const out = { id: e.id, typeId: e.typeId, location: vec(e.location), dimension: e.dimension.id };
  try {
    out.velocity = vec(e.getVelocity());
  } catch {
    // Some entities (items in some states, paintings) have no velocity.
  }
  if (e.nameTag) out.nameTag = e.nameTag;
  const tags = e.getTags();
  if (tags.length) out.tags = tags;
  const health = e.getComponent("minecraft:health");
  if (health) out.health = { current: health.currentValue, max: health.effectiveMax };
  // A creeper's fuse, from its own entity events (the `minecraft:is_ignited` component never shows on a lit creeper).
  fuseOf(e, out);
  // Amplifier is 0-based (Slowness II = 1); duration is in ticks.
  const effects = e.getEffects().map((fx) => ({ typeId: fx.typeId, amplifier: fx.amplifier, duration: fx.duration }));
  if (effects.length) out.effects = effects;
  return out;
}

function entities(q) {
  const { dim, at } = anchor(q);
  const radius = Math.min(Number(q.radius ?? 16), 256);
  const opts = { location: at, maxDistance: radius };
  if (q.type) opts.type = q.type;
  return dim.getEntities(opts).slice(0, Math.min(Number(q.limit ?? 50), MAX_ENTITIES)).map(entityInfo);
}

function blockInfo(b) {
  const out = { typeId: b.typeId, location: { x: b.location.x, y: b.location.y, z: b.location.z } };
  const states = b.permutation.getAllStates();
  if (Object.keys(states).length) out.states = states;
  return out;
}

/** Whether block row `y` is inside the dimension's height range (its `max` is exclusive: 320 in the overworld). */
function inHeight(dim, y) {
  const range = dim.heightRange;
  return y >= range.min && y < range.max;
}

/** The block at a position, or undefined when the position is outside the height range or its chunk is not loaded. */
function blockAt(dim, x, y, z) {
  if (!inHeight(dim, y)) return undefined;
  try {
    return dim.getBlock({ x, y, z });
  } catch {
    // A chunk that unloaded between the check and the read.
    return undefined;
  }
}

/**
 * Non-air blocks in the cube of `radius` around the anchor. Rows outside the dimension's height range (below the
 * world floor, above the build limit) are left out, so a cube touching or past them answers what is inside, or [].
 */
function blocks(q) {
  const { dim, at } = anchor(q);
  const r = Math.min(Number(q.radius ?? 4), 16);
  const cx = Math.floor(at.x);
  const cy = Math.floor(at.y);
  const cz = Math.floor(at.z);
  const range = dim.heightRange;
  const ylo = Math.max(cy - r, range.min);
  const yhi = Math.min(cy + r, range.max - 1);
  const out = [];
  for (let y = ylo; y <= yhi && out.length < MAX_BLOCKS; y++) {
    for (let x = cx - r; x <= cx + r && out.length < MAX_BLOCKS; x++) {
      for (let z = cz - r; z <= cz + r && out.length < MAX_BLOCKS; z++) {
        const b = blockAt(dim, x, y, z);
        if (!b || b.isAir) continue;
        if (q.type && b.typeId !== q.type) continue;
        out.push(blockInfo(b));
      }
    }
  }
  return out;
}

/** The block at the anchor; null outside the height range or in an unloaded chunk. */
function block(q) {
  const { dim, at } = anchor(q);
  const b = blockAt(dim, Math.floor(at.x), Math.floor(at.y), Math.floor(at.z));
  return b ? blockInfo(b) : null;
}

/**
 * Block classes for the navigation grid, one character per block:
 * `.` passable (air, plants, torches, carpets), `#` solid, `s` bottom slab or other half-height floor, `t` stairs,
 * `w` water, `L` lava, `X` dangerous (fire, cactus, magma, powder snow, berry bush, wither rose, campfire, cobweb,
 * dripstone), `H` climbable (ladder, vines, scaffolding), `D` closed door, `d` open door or gate, `G` closed fence
 * gate, `F` fence or wall (too tall to jump), `u` not loaded.
 */
const DANGER = /(^|_)(fire|cactus|magma|powder_snow|sweet_berry_bush|wither_rose|campfire|web|pointed_dripstone)$/;
const CLIMB = /^(ladder|vine|weeping_vines|twisting_vines|cave_vines.*|scaffolding)$/;
const PASSABLE =
  /(^|_)(air|grass|tallgrass|short_grass|tall_grass|fern|large_fern|deadbush|dead_bush|flower|sapling|propagule|torch|rail|redstone_wire|button|lever|pressure_plate|carpet|sign|banner|tripwire|tripwire_hook|wheat|carrots|potatoes|beetroot|reeds|sugar_cane|mushroom|seagrass|kelp|structure_void|snow_layer|sprouts|crimson_roots|warped_roots|hanging_roots|lichen|vein|petals|litter|dandelion|poppy|orchid|allium|bluet|tulip|daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|torchflower|pitcher_plant|pitcher_crop|torchflower_crop|eyeblossom|wildflowers|bush|frogspawn|spore_blossom|coral_fan|clump|melon_stem|pumpkin_stem|nether_wart|double_plant|red_flower|yellow_flower|tall_dry_grass|short_dry_grass)$/;
/** Classes that do not depend on block states, by type id. */
const CLASS_CACHE = new Map();

function classifyType(id) {
  const name = id.replace(/^minecraft:/, "");
  if (name === "water" || name === "flowing_water" || name === "bubble_column") return "w";
  if (name === "lava" || name === "flowing_lava") return "L";
  if (DANGER.test(name)) return "X";
  if (CLIMB.test(name)) return "H";
  if (/door$/.test(name) || /fence_gate$/.test(name) || /slab\d?$/.test(name) || /stairs$/.test(name)) return null;
  if (/fence$/.test(name) || /_wall$/.test(name)) return "F";
  if (name === "light_block" || (!name.endsWith("_block") && PASSABLE.test(name))) return ".";
  return "#";
}

function classify(b) {
  if (!b) return "u";
  if (b.isAir) return ".";
  const id = b.typeId;
  let c = CLASS_CACHE.get(id);
  if (c === undefined) {
    c = classifyType(id);
    CLASS_CACHE.set(id, c);
  }
  if (c !== null) return c;
  const name = id.replace(/^minecraft:/, "");
  const states = b.permutation.getAllStates();
  if (/trapdoor$/.test(name)) return states["open_bit"] ? "." : states["upside_down_bit"] ? "#" : "s";
  if (/door$/.test(name)) {
    // The open state lives on the lower half.
    const lower = states["upper_block_bit"] ? b.below()?.permutation.getAllStates() : states;
    return lower?.["open_bit"] ? "d" : name.startsWith("iron") || name.includes("copper") ? "#" : "D";
  }
  if (/fence_gate$/.test(name)) return states["open_bit"] ? "d" : "G";
  if (/stairs$/.test(name)) return states["upside_down_bit"] ? "#" : "t";
  if (name.includes("double")) return "#";
  return states["minecraft:vertical_half"] === "bottom" || states["top_slot_bit"] === false ? "s" : "#";
}

const MAX_GRID_CELLS = 60000;
/** Script time the grid scan may take per game tick, across every pending query. */
const GRID_TICK_MS = 4;
/** Native calls (block reads and region checks) between checks of the clock. */
const GRID_STEP = 24;

/** The class of a block type, or null when it depends on the block's states. */
function typeClass(id) {
  let c = CLASS_CACHE.get(id);
  if (c === undefined) {
    c = id === "minecraft:air" ? "." : classifyType(id);
    CLASS_CACHE.set(id, c);
  }
  return c;
}

/** Regions this small are read block by block instead of split further. */
const GRID_LEAF = 16;

/**
 * Scan one box into `cells` (x fastest, then z, then y) a slice at a time, yielding every few native calls so the
 * caller can stop for the tick. Reading every block costs microseconds each, so it reads one block of a region and
 * asks the game whether the region holds anything else (`containsBlock` excluding that type, answered natively):
 * a uniform region is filled at once, a mixed one is split in two along its longest side. Terrain is mostly layers
 * and columns of one block, so a section takes a few dozen calls instead of 4096 reads. Blocks whose class depends
 * on their states (doors, gates, slabs, stairs, trapdoors) are always read one by one.
 */
function* scanBox(dim, x0, y0, z0, sx, sy, sz, regions) {
  const range = dim.heightRange;
  const ylo = Math.max(y0, range.min);
  const yhi = Math.min(y0 + sy, range.max) - 1;
  if (ylo > yhi) return;
  // One region per loaded chunk column; unloaded columns stay unknown.
  const stack = [];
  for (let cx = Math.floor(x0 / 16); cx <= Math.floor((x0 + sx - 1) / 16); cx++) {
    for (let cz = Math.floor(z0 / 16); cz <= Math.floor((z0 + sz - 1) / 16); cz++) {
      const r = [Math.max(x0, cx * 16), ylo, Math.max(z0, cz * 16), Math.min(x0 + sx - 1, cx * 16 + 15), yhi, Math.min(z0 + sz - 1, cz * 16 + 15)];
      try {
        if (dim.getBlock({ x: r[0], y: r[1], z: r[2] })) stack.push(r);
      } catch {}
    }
  }
  // The class of one block: by type when that is enough (one cached lookup), else from its states.
  const classAt = (x, y, z) => {
    try {
      const b = dim.getBlock({ x, y, z });
      if (!b) return "u";
      return typeClass(b.typeId) ?? classify(b);
    } catch {
      return "u";
    }
  };
  // Read a small region block by block, one region per run of equal blocks along x.
  const readRows = (ax, ay, az, bx, by, bz) => {
    for (let y = ay; y <= by; y++) {
      for (let z = az; z <= bz; z++) {
        let run = classAt(ax, y, z);
        let from = ax;
        for (let x = ax + 1; x <= bx + 1; x++) {
          const k = x <= bx ? classAt(x, y, z) : "";
          if (k === run) continue;
          if (run !== "u") regions.push(run + B36[from - x0] + B36[y - y0] + B36[z - z0] + B36[x - 1 - x0] + B36[y - y0] + B36[z - z0]);
          run = k;
          from = x;
        }
      }
    }
  };
  let calls = 0;
  while (stack.length) {
    // The 7th entry, when set, is the type of the region's first corner, known from its parent (same corner).
    const [ax, ay, az, bx, by, bz, known] = stack.pop();
    const lx = bx - ax + 1;
    const ly = by - ay + 1;
    const lz = bz - az + 1;
    if (lx * ly * lz <= GRID_LEAF) {
      readRows(ax, ay, az, bx, by, bz);
      calls += lx * ly * lz;
    } else {
      let type = known;
      if (type === undefined) {
        try {
          type = dim.getBlock({ x: ax, y: ay, z: az })?.typeId;
        } catch {}
        calls++;
      }
      const c = type === undefined ? null : typeClass(type);
      calls++;
      const uniform = c !== null && !dim.containsBlock(new BlockVolume({ x: ax, y: ay, z: az }, { x: bx, y: by, z: bz }), { excludeTypes: [type] }, true);
      if (uniform) {
        regions.push(c + B36[ax - x0] + B36[ay - y0] + B36[az - z0] + B36[bx - x0] + B36[by - y0] + B36[bz - z0]);
      } else if (ly > 1) {
        // Split into layers first: terrain is layered, so the layers are often uniform.
        const m = ay + (ly >> 1);
        stack.push([ax, m, az, bx, by, bz], [ax, ay, az, bx, m - 1, bz, type]);
      } else if (lx >= lz) {
        const m = ax + (lx >> 1);
        stack.push([m, ay, az, bx, by, bz], [ax, ay, az, m - 1, by, bz, type]);
      } else {
        const m = az + (lz >> 1);
        stack.push([ax, ay, m, bx, by, bz], [ax, ay, az, bx, by, m - 1, type]);
      }
    }
    if (calls >= GRID_STEP) {
      calls = 0;
      yield;
    }
  }
}

const B36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Pending grid queries, oldest first: each a generator that ends with the reply. */
const gridJobs = [];
let gridRunner;
/** Script time the scan has used in the current tick. */
let gridTick = -1;
let gridTickMs = 0;

/** Advance the pending scans until this tick's budget is spent. */
function pumpGrid() {
  const tick = system.currentTick;
  if (tick !== gridTick) {
    gridTick = tick;
    gridTickMs = 0;
  }
  const started = Date.now();
  while (gridJobs.length && gridTickMs + (Date.now() - started) < GRID_TICK_MS) {
    const job = gridJobs[0];
    if (job.lastTick !== tick) {
      job.lastTick = tick;
      job.ticks++;
    }
    const t0 = Date.now();
    let step;
    try {
      step = job.gen.next();
    } catch (e) {
      gridJobs.shift();
      job.reject(e);
      continue;
    } finally {
      job.ms += Date.now() - t0;
    }
    if (step.done) {
      gridJobs.shift();
      const reply = step.value;
      reply.ms = job.ms;
      reply.ticks = job.ticks;
      reply.maxTickMs = Math.max(job.maxTickMs, gridTickMs + (Date.now() - started));
      job.resolve(reply);
    }
  }
  const spent = Date.now() - started;
  gridTickMs += spent;
  for (const job of gridJobs) if (job.lastTick === tick) job.maxTickMs = Math.max(job.maxTickMs, gridTickMs);
  if (!gridJobs.length && gridRunner !== undefined) {
    system.clearRun(gridRunner);
    gridRunner = undefined;
  }
}

/**
 * Block classes in boxes `[x, y, z, sx, sy, sz]` (minimum corner and size, each side at most 36), each as a list of
 * regions: 7 characters per region, the class then the region's first and last corner relative to the box
 * (x, y, z, x, y, z) as base-36 digits. Blocks no region covers are unknown (unloaded or outside the world).
 * The scan is spread over game ticks (at most GRID_TICK_MS of script time per tick), so the reply may come some
 * ticks later. `ms` is the script time it took in all, `ticks` how many ticks it spanned, `maxTickMs` the most
 * scan time any one of them had.
 */
function grid(q) {
  const player = thePlayer();
  const dim = world.getDimension(q.dimension ?? player?.dimension.id ?? "overworld");
  const boxes = (Array.isArray(q.boxes) ? q.boxes : []).map((box) => box.map((n) => Math.floor(Number(n))));
  let total = 0;
  for (const [, , , sx, sy, sz] of boxes) {
    if (!(sx >= 1 && sy >= 1 && sz >= 1 && sx <= 36 && sy <= 36 && sz <= 36)) throw new Error("grid box sides must be 1 to 36 blocks");
    total += sx * sy * sz;
  }
  if (total > MAX_GRID_CELLS) throw new Error(`grid boxes exceed ${MAX_GRID_CELLS} blocks`);
  const job = { ms: 0, ticks: 0, maxTickMs: 0, lastTick: -1 };
  job.gen = (function* () {
    const out = [];
    for (const [x0, y0, z0, sx, sy, sz] of boxes) {
      const regions = [];
      yield* scanBox(dim, x0, y0, z0, sx, sy, sz, regions);
      out.push(regions.join(""));
    }
    return { tick: system.currentTick, boxes: out };
  })();
  const done = new Promise((resolve, reject) => {
    job.resolve = resolve;
    job.reject = reject;
  });
  gridJobs.push(job);
  gridRunner ??= system.runInterval(pumpGrid, 1);
  pumpGrid();
  return done;
}

function player() {
  return world.getAllPlayers().map((p) => ({
    name: p.name,
    id: p.id,
    location: vec(p.location),
    rotation: p.getRotation(),
    dimension: p.dimension.id,
    gameMode: p.getGameMode(),
  }));
}

/** What the player sees and does right now: the input for closed-loop control. */
function playerState(p) {
  const out = {
    tick: system.currentTick,
    name: p.name,
    location: vec(p.location),
    velocity: vec(p.getVelocity()),
    rotation: p.getRotation(),
    dimension: p.dimension.id,
    onGround: p.isOnGround,
    sneaking: p.isSneaking,
    sprinting: p.isSprinting,
    gameMode: p.getGameMode(),
    selectedSlot: p.selectedSlotIndex + 1,
  };
  const health = p.getComponent("minecraft:health");
  if (health) out.health = health.currentValue;
  const hand = p.getComponent("minecraft:inventory")?.container?.getItem(p.selectedSlotIndex);
  if (hand) out.holding = { typeId: hand.typeId, amount: hand.amount };
  const offhandDamage = offhandDamageOf(p);
  if (offhandDamage !== undefined) out.offhandDamage = offhandDamage;
  const hit = p.getBlockFromViewDirection({ maxDistance: 6 });
  if (hit) out.lookingAtBlock = { typeId: hit.block.typeId, location: hit.block.location, face: hit.face };
  // Far enough to tell a shooter or a walking player what the crosshair is on. Melee checks the distance.
  const ent = p.getEntitiesFromViewDirection({ maxDistance: 24 }).find((h) => h.entity.id !== p.id);
  if (ent) out.lookingAtEntity = { id: ent.entity.id, typeId: ent.entity.typeId, distance: Math.round(ent.distance * 100) / 100 };
  return out;
}

/**
 * Durability damage of the off-hand item (a shield loses durability with each hit it blocks), or undefined when the
 * slot is empty or the item has no durability. Runs every streamed tick, so it never throws.
 */
function offhandDamageOf(p) {
  try {
    const item = componentOf(p, "minecraft:equippable")?.getEquipment("Offhand");
    const damage = item ? componentOf(item, "minecraft:durability")?.damage : undefined;
    return typeof damage === "number" ? damage : undefined;
  } catch {
    return undefined;
  }
}

function state() {
  const p = thePlayer();
  if (!p) throw new Error("no player in the world");
  return playerState(p);
}

/** Hotbar slots 1-9 (null when empty) and the food level, which the streamed state leaves out to stay small. */
function loadout() {
  const p = thePlayer();
  if (!p) throw new Error("no player in the world");
  const container = p.getComponent("minecraft:inventory")?.container;
  const hotbar = [];
  for (let i = 0; i < 9; i++) {
    const item = container?.getItem(i);
    hotbar.push(item ? { typeId: item.typeId, amount: item.amount } : null);
  }
  const out = { hotbar };
  const hunger = p.getComponent("minecraft:player.hunger");
  if (hunger) out.hunger = hunger.currentValue;
  const saturation = p.getComponent("minecraft:player.saturation");
  if (saturation) out.saturation = saturation.currentValue;
  const equippable = p.getComponent("minecraft:equippable");
  if (equippable) {
    const armor = [];
    for (const slot of ["Head", "Chest", "Legs", "Feet", "Offhand"]) {
      const item = equippable.getEquipment(slot);
      if (item) armor.push({ slot, typeId: item.typeId });
    }
    out.armor = armor;
  }
  return out;
}

/** A component, or undefined when this game's API level does not have it (a string id is not checked at compile time). */
function componentOf(holder, id) {
  try {
    return holder.getComponent(id);
  } catch {
    return undefined;
  }
}

/**
 * One item in the slot shape the host parses: id, count, and everything the Script API shows about it — custom name,
 * lore, durability and enchantments. `null` for an empty slot. No aux value: the API does not expose one.
 */
function itemInfo(item) {
  if (!item) return null;
  const out = { item: item.typeId, count: item.amount, enchantments: [] };
  if (item.nameTag) out.name = item.nameTag;
  const lore = item.getLore();
  if (lore.length) out.lore = lore.map((line) => String(line));
  const durability = componentOf(item, "minecraft:durability");
  if (durability) out.durability = { damage: durability.damage, max: durability.maxDurability };
  const enchantable = componentOf(item, "minecraft:enchantable");
  // `type` is the EnchantmentType, whose `id` is the namespaced enchantment id (minecraft:sharpness).
  if (enchantable) out.enchantments = enchantable.getEnchantments().map((e) => ({ id: e.type.id, level: e.level }));
  return out;
}

/** Slots `from` to `to` - 1 of a container, empties as null. */
function slotsOf(container, from, to) {
  const out = [];
  for (let i = from; i < to; i++) out.push(itemInfo(container?.getItem(i)));
  return out;
}

/** One attribute from its component, or undefined when the running game does not expose it as one. */
function attributeOf(entity, id) {
  const component = componentOf(entity, id);
  if (!component || typeof component.currentValue !== "number") return undefined;
  const out = { current: component.currentValue };
  if (typeof component.effectiveMin === "number") out.min = component.effectiveMin;
  if (typeof component.effectiveMax === "number") out.max = component.effectiveMax;
  if (typeof component.defaultValue === "number") out.default = component.defaultValue;
  return out;
}

/** Every attribute the Script API exposes, plus the armour points and toughness the game derives from what is worn. */
function attributesOf(p, equippable) {
  const out = {};
  for (const [name, id] of [
    ["health", "minecraft:health"],
    ["hunger", "minecraft:player.hunger"],
    ["saturation", "minecraft:player.saturation"],
    ["movement", "minecraft:movement"],
  ]) {
    const attribute = attributeOf(p, id);
    if (attribute) out[name] = attribute;
  }
  if (typeof p.level === "number") out.level = { current: p.level };
  if (typeof p.getTotalXp === "function") out.experience = { current: p.getTotalXp() };
  if (equippable) {
    if (typeof equippable.totalArmor === "number") out.armor = { current: equippable.totalArmor };
    if (typeof equippable.totalToughness === "number") out.armorToughness = { current: equippable.totalToughness };
  }
  return out;
}

/** The player's attributes and whole inventory. No cursor stack: the API does not expose one. */
function inventory() {
  const p = thePlayer();
  if (!p) throw new Error("no player in the world");
  const container = componentOf(p, "minecraft:inventory")?.container;
  const equippable = componentOf(p, "minecraft:equippable");
  const equipment = (slot) => {
    try {
      return itemInfo(equippable?.getEquipment(slot));
    } catch {
      return null;
    }
  };
  return {
    attributes: attributesOf(p, equippable),
    inventory: {
      selectedSlot: p.selectedSlotIndex,
      hotbar: slotsOf(container, 0, 9),
      inventory: slotsOf(container, 9, 36),
      armor: { head: equipment("Head"), chest: equipment("Chest"), legs: equipment("Legs"), feet: equipment("Feet") },
      offhand: equipment("Offhand"),
      cursor: null,
    },
  };
}

/** What a block's own container holds, by block position; a block without one says why, with a reason the host reads. */
function containerAt(q) {
  const { dim, at } = anchor(q);
  const x = Math.floor(at.x);
  const y = Math.floor(at.y);
  const z = Math.floor(at.z);
  if (!inHeight(dim, y)) {
    const range = dim.heightRange;
    throw queryError("no_block", `${x} ${y} ${z} is outside the world's height range (${range.min} to ${range.max - 1})`);
  }
  const block = blockAt(dim, x, y, z);
  if (!block) throw queryError("no_block", `no loaded block at ${x} ${y} ${z}`);
  const container = componentOf(block, "minecraft:inventory")?.container;
  if (!container) throw queryError("no_container", `${block.typeId} at ${x} ${y} ${z} has no container`);
  return { block: block.typeId, size: container.size, slots: slotsOf(container, 0, container.size) };
}

/** An error the host can act on: `reason` comes back on the reply beside the message. */
function queryError(reason, message) {
  const error = new Error(message);
  error.reason = reason;
  return error;
}

/** Creeper fuses: entity id -> game tick the fuse was lit, from the data-driven entity events. */
const FUSES = new Map();
const LIGHT = new Set(["minecraft:start_exploding", "minecraft:start_exploding_forced"]);
world.afterEvents.dataDrivenEntityTrigger.subscribe(
  (ev) => {
    let id;
    try {
      id = ev.entity.id;
    } catch {
      return;
    }
    // The sensor fires again while the creeper stays in range; the fuse burns from the first.
    if (LIGHT.has(ev.eventId)) {
      if (!FUSES.has(id)) FUSES.set(id, system.currentTick);
    } else FUSES.delete(id);
  },
  { eventTypes: ["minecraft:start_exploding", "minecraft:start_exploding_forced", "minecraft:stop_exploding"] },
);
world.afterEvents.entityRemove.subscribe((ev) => FUSES.delete(ev.removedEntityId));

/** `ignited` for every creeper (true or false, so a reader can trust a false), and the ticks it has burned. */
function fuseOf(e, out) {
  if (e.typeId !== "minecraft:creeper") return;
  const lit = FUSES.get(e.id);
  out.ignited = lit !== undefined;
  if (lit !== undefined) out.fuseTicks = system.currentTick - lit;
}

/** The closest living entities (players left out), in the short form the state stream carries. */
function nearby(p, radius, limit) {
  const out = [];
  for (const e of p.dimension.getEntities({ location: p.location, maxDistance: radius, closest: limit * 3, excludeTypes: ["minecraft:player"] })) {
    const health = e.getComponent("minecraft:health");
    if (!health) continue;
    const one = { id: e.id, typeId: e.typeId, location: vec(e.location), health: { current: health.currentValue, max: health.effectiveMax } };
    try {
      one.velocity = vec(e.getVelocity());
    } catch {}
    fuseOf(e, one);
    out.push(one);
    if (out.length >= limit) break;
  }
  return out;
}

let streamHandle;
/**
 * Print the player state every `every` ticks (default 2 = 10 per second) until `on: false`, with the closest
 * `limit` (default 8) living entities within `radius` (default 16, 0 for none) as `entities`.
 */
function stream(q) {
  if (streamHandle !== undefined) system.clearRun(streamHandle);
  streamHandle = undefined;
  if (q.on === false) return "stopped";
  const every = Math.max(1, Math.min(20, Number(q.every ?? 2)));
  const radius = Math.max(0, Math.min(32, Number(q.radius ?? 16)));
  const limit = Math.max(1, Math.min(16, Number(q.limit ?? 8)));
  streamHandle = system.runInterval(() => {
    const p = thePlayer();
    if (!p) return;
    const s = playerState(p);
    if (radius > 0) s.entities = { radius, limit, list: nearby(p, radius, limit) };
    console.log(`[sculkwire:state] ${JSON.stringify(s)}`);
  }, every);
  return `streaming every ${every} ticks`;
}

function entity(q) {
  const e = world.getEntity(String(q.entityId));
  // `tick` stamps the position, so a caller can estimate velocity from successive replies.
  return e && e.isValid ? { ...entityInfo(e), tick: system.currentTick } : null;
}

/** The last projectile impacts (on entities and blocks), so a shooter can tell a hit from a miss and where it landed. */
const IMPACTS = [];
const MAX_IMPACTS = 64;
function recordImpact(ev, hit) {
  let projectile = "unknown";
  let source;
  try {
    projectile = ev.projectile.typeId;
  } catch {}
  try {
    source = ev.source?.id;
  } catch {}
  IMPACTS.push({ tick: system.currentTick, projectile, source, location: vec(ev.location), ...hit });
  if (IMPACTS.length > MAX_IMPACTS) IMPACTS.shift();
}
world.afterEvents.projectileHitEntity.subscribe((ev) => {
  const e = ev.getEntityHit()?.entity;
  let entityHit;
  try {
    if (e) entityHit = { id: e.id, typeId: e.typeId };
  } catch {}
  recordImpact(ev, entityHit ? { entity: entityHit } : {});
});
world.afterEvents.projectileHitBlock.subscribe((ev) => {
  let block;
  try {
    block = ev.getBlockHit()?.block.typeId;
  } catch {}
  recordImpact(ev, block ? { block } : {});
});

/** Impacts after game tick `since` (default all kept), oldest first. */
function impacts(q) {
  const since = Number(q.since ?? -1);
  return { tick: system.currentTick, impacts: IMPACTS.filter((i) => i.tick > since) };
}

/** The last entity deaths, so a fighter can count kills and tell its kill from an explosion or a fall. */
const DEATHS = [];
const MAX_DEATHS = 64;
world.afterEvents.entityDie.subscribe((ev) => {
  const out = { tick: system.currentTick };
  try {
    out.id = ev.deadEntity.id;
    out.typeId = ev.deadEntity.typeId;
  } catch {}
  try {
    out.cause = ev.damageSource.cause;
    const killer = ev.damageSource.damagingEntity;
    if (killer) out.killer = killer.typeId;
  } catch {}
  DEATHS.push(out);
  if (DEATHS.length > MAX_DEATHS) DEATHS.shift();
});

/** Deaths after game tick `since` (default all kept), oldest first. */
function deaths(q) {
  const since = Number(q.since ?? -1);
  return { tick: system.currentTick, deaths: DEATHS.filter((d) => d.tick > since) };
}

/** The last hurts of players, so a run can tell blast and fall damage from a mob's hit. */
const HURTS = [];
const MAX_HURTS = 64;
world.afterEvents.entityHurt.subscribe(
  (ev) => {
    const out = { tick: system.currentTick, damage: ev.damage };
    try {
      out.cause = ev.damageSource.cause;
      const damager = ev.damageSource.damagingEntity;
      if (damager) out.damager = damager.typeId;
    } catch {}
    HURTS.push(out);
    if (HURTS.length > MAX_HURTS) HURTS.shift();
  },
  { entityTypes: ["minecraft:player"] },
);

/** Player hurts after game tick `since` (default all kept), oldest first. */
function hurts(q) {
  const since = Number(q.since ?? -1);
  return { tick: system.currentTick, hurts: HURTS.filter((h) => h.tick > since) };
}

/** The Script API's registries, by the `/connect` data kind they stand in for (`mob` lists every entity type). */
const REGISTRIES = { block: () => BlockTypes.getAll(), item: () => ItemTypes.getAll(), mob: () => EntityTypes.getAll() };
/** Ids per `registry` reply, so one print stays a few kilobytes; the bridge asks page after page. */
const REGISTRY_PAGE = 400;

/** One page of a registry's ids, sorted so the pages of one listing line up: `{ total, offset, ids }`. */
function registry(q) {
  const all = REGISTRIES[q.registry];
  if (!all) throw new Error(`registry must be one of ${Object.keys(REGISTRIES).join(", ")}`);
  const ids = Array.from(all(), (t) => t.id).sort();
  const offset = Math.max(0, Math.floor(Number(q.offset ?? 0)) || 0);
  return { total: ids.length, offset, ids: ids.slice(offset, offset + REGISTRY_PAGE) };
}

const HANDLERS = { ping: () => "pong", registry, entities, entity, blocks, block, grid, player, state, stream, impacts, deaths, hurts, loadout, inventory, container: containerAt };

function sendReply(reply) {
  console.log(`[sculkwire:reply] ${JSON.stringify(reply)}`);
}

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id !== "sculkwire:query") return;
  let q = {};
  try {
    q = JSON.parse(ev.message || "{}");
    const handler = HANDLERS[q.kind];
    if (!handler) throw new Error(`unknown kind ${q.kind}; one of ${Object.keys(HANDLERS).join(", ")}`);
    const result = handler(q);
    // Handlers that spread their work over ticks (grid) answer when they finish.
    if (result instanceof Promise) {
      result.then(
        (r) => sendReply({ id: q.id, ok: true, result: r }),
        (e) => sendReply({ id: q.id, ok: false, error: String(e), reason: e && e.reason }),
      );
    } else sendReply({ id: q.id, ok: true, result });
  } catch (e) {
    // `reason` is only there when a handler set one (a block without a container, an unloaded block).
    sendReply({ id: q.id, ok: false, error: String(e), reason: e && e.reason });
  }
});

system.run(() => console.log("[sculkwire:ready]"));

world.afterEvents.playerSpawn.subscribe((ev) => {
  spawned = ev.player;
  if (ev.initialSpawn) console.log(`[sculkwire:spawned] ${ev.player.name}`);
});
world.afterEvents.playerLeave.subscribe((ev) => {
  if (spawned?.id === ev.playerId) spawned = undefined;
});
