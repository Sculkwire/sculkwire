// sculkwire helper (MIT): answers `/scriptevent sculkwire:query <json>` with one console line
// `[sculkwire:reply] {"id":..,"ok":true,"result":..}` that the bridge reads from the script debugger
// (PrintEvent) or the content log.
import { BlockTypes, BlockVolume, EnchantmentType, EntityTypes, ItemStack, ItemTypes, system, world } from "@minecraft/server";

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
  heldOf(e, out);
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
 * `types` (an array of ids) keeps the blocks of any of them, so one scan serves several types; `type` keeps one.
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
  const types = Array.isArray(q.types) ? new Set(q.types.map(String)) : undefined;
  const out = [];
  for (let y = ylo; y <= yhi && out.length < MAX_BLOCKS; y++) {
    for (let x = cx - r; x <= cx + r && out.length < MAX_BLOCKS; x++) {
      for (let z = cz - r; z <= cz + r && out.length < MAX_BLOCKS; z++) {
        const b = blockAt(dim, x, y, z);
        if (!b || b.isAir) continue;
        if (types ? !types.has(b.typeId) : q.type && b.typeId !== q.type) continue;
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
world.afterEvents.entityRemove.subscribe((ev) => {
  FUSES.delete(ev.removedEntityId);
  HELD.delete(ev.removedEntityId);
});

/** `ignited` for every creeper (true or false, so a reader can trust a false), and the ticks it has burned. */
function fuseOf(e, out) {
  if (e.typeId !== "minecraft:creeper") return;
  const lit = FUSES.get(e.id);
  out.ignited = lit !== undefined;
  if (lit !== undefined) out.fuseTicks = system.currentTick - lit;
}

/** The spears, cheapest first, and the mob types the vanilla files give one (behavior pack 1.26.60.5). */
const SPEARS = ["wooden", "stone", "copper", "iron", "golden", "diamond", "netherite"].map((m) => `minecraft:${m}_spear`);
const SPEAR_CARRIERS = new Set([
  "minecraft:zombie",
  "minecraft:husk",
  "minecraft:drowned",
  "minecraft:zombie_pigman",
  "minecraft:piglin",
  "minecraft:zombie_villager_v2",
  "minecraft:skeleton",
  "minecraft:stray",
  "minecraft:bogged",
  "minecraft:parched",
]);
/** Main-hand spear by entity id, from the `hasitem` selector: { held, tick read }. Re-read every `HELD_RECHECK_TICKS`. */
const HELD = new Map();
const HELD_RECHECK_TICKS = 100;
/** The tick the last `hasitem` check ran: at most one entity is checked a tick. */
let heldCheckTick = -1;

/**
 * `held`: the item id in a mob's main hand (a husk's spear changes how it fights). From its equippable component when
 * the entity has one; mobs have none in this Script API, so for a type that can carry a spear the game is asked with
 * the `hasitem` selector, one spear id after the other, for one entity a tick, cached per entity id and re-read every
 * 5 s. Absent when nothing is held, nothing is known yet, or the API refuses.
 */
function heldOf(e, out) {
  try {
    const item = e.getComponent("minecraft:equippable")?.getEquipment("Mainhand");
    if (item?.typeId) {
      out.held = item.typeId;
      return;
    }
  } catch {}
  if (!SPEAR_CARRIERS.has(e.typeId)) return;
  const known = HELD.get(e.id);
  const now = system.currentTick;
  if ((known && now - known.at < HELD_RECHECK_TICKS) || heldCheckTick === now) {
    if (known?.held) out.held = known.held;
    return;
  }
  heldCheckTick = now;
  let held;
  for (const id of SPEARS) {
    try {
      if (e.runCommand(`testfor @s[hasitem={item=${id},location=slot.weapon.mainhand}]`).successCount > 0) {
        held = id;
        break;
      }
    } catch {}
  }
  HELD.set(e.id, { held, at: now });
  if (held) out.held = held;
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
    heldOf(e, one);
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
  const { tick, ...fields } = out;
  pushEvent("entityDie", fields);
});

/** Deaths after game tick `since` (default all kept), oldest first. */
function deaths(q) {
  const since = Number(q.since ?? -1);
  return { tick: system.currentTick, deaths: DEATHS.filter((d) => d.tick > since) };
}

/** The last hurts of players, so a run can tell blast and fall damage from a mob's hit. Every entity's hurt is an event. */
const HURTS = [];
const MAX_HURTS = 64;
world.afterEvents.entityHurt.subscribe((ev) => {
  const out = { tick: system.currentTick, damage: ev.damage };
  try {
    out.cause = ev.damageSource.cause;
    const damager = ev.damageSource.damagingEntity;
    if (damager) {
      out.damager = damager.typeId;
      out.damagerId = damager.id;
    }
  } catch {}
  let hurt = {};
  try {
    hurt = { id: ev.hurtEntity.id, typeId: ev.hurtEntity.typeId };
  } catch {}
  const { tick, ...fields } = out;
  pushEvent("entityHurt", { ...hurt, ...fields });
  if (hurt.typeId !== "minecraft:player") return;
  HURTS.push(out);
  if (HURTS.length > MAX_HURTS) HURTS.shift();
});

/** Player hurts after game tick `since` (default all kept), oldest first. */
function hurts(q) {
  const since = Number(q.since ?? -1);
  return { tick: system.currentTick, hurts: HURTS.filter((h) => h.tick > since) };
}

/**
 * In-world events for `events` and `wait` `event` conditions: a ring of the newest MAX_EVENTS, each
 * `{ seq, tick, kind, ...fields }` with flat fields. `seq` grows by one per event from the helper's start (a `/reload`
 * restarts it at 1), so a caller's cursor is the last `seq` it saw.
 */
const EVENTS = [];
const MAX_EVENTS = 2000;
let eventSeq = 0;
function pushEvent(kind, fields) {
  EVENTS.push({ seq: ++eventSeq, tick: system.currentTick, kind, ...fields });
  if (EVENTS.length > MAX_EVENTS) EVENTS.shift();
}

/** Read fields off an event without letting one invalid handle drop the whole event. */
function safely(read) {
  try {
    return read();
  } catch {
    return undefined;
  }
}
function blockAtOf(b) {
  return safely(() => ({ block: b.typeId, location: { x: b.location.x, y: b.location.y, z: b.location.z } })) ?? {};
}
/** Subscribe when this game's API has the signal, so a missing one never stops the helper. */
function onWorld(name, record) {
  const signal = world.afterEvents[name];
  if (!signal) return;
  signal.subscribe((ev) => {
    const fields = safely(() => record(ev));
    if (fields) pushEvent(name, fields);
  });
}
onWorld("entitySpawn", (ev) => ({ id: ev.entity.id, typeId: ev.entity.typeId, cause: ev.cause, location: vec(ev.entity.location) }));
onWorld("playerBreakBlock", (ev) => ({ player: ev.player.name, ...blockAtOf(ev.block), block: ev.brokenBlockPermutation.type.id }));
onWorld("playerPlaceBlock", (ev) => ({ player: ev.player.name, ...blockAtOf(ev.block) }));
onWorld("itemUse", (ev) => ({ player: ev.source.name, item: ev.itemStack.typeId }));
onWorld("itemCompleteUse", (ev) => ({ player: ev.source.name, item: ev.itemStack.typeId, useDuration: ev.useDuration }));
onWorld("playerInteractWithBlock", (ev) => ({ player: ev.player.name, ...blockAtOf(ev.block), item: safely(() => ev.itemStack?.typeId) }));
onWorld("playerInteractWithEntity", (ev) => ({ player: ev.player.name, id: ev.target.id, typeId: ev.target.typeId, item: safely(() => ev.itemStack?.typeId) }));
onWorld("effectAdd", (ev) => ({ id: ev.entity.id, typeId: ev.entity.typeId, effect: ev.effect.typeId, amplifier: ev.effect.amplifier, duration: ev.effect.duration }));

/** A `/scriptevent` other than sculkwire's own queries: `id`, `message` and the sending entity's type. */
function recordScriptEvent(ev) {
  if (ev.id === "sculkwire:query") return;
  const source = safely(() => ev.sourceEntity?.typeId);
  pushEvent("scriptevent", { id: ev.id, message: ev.message, ...(source ? { source } : {}) });
}

const EVENTS_LIMIT = 100;
const EVENTS_MAX_LIMIT = 500;
/**
 * Events after cursor `since` (default 0: every event kept), oldest first, at most `limit`, of `kinds` when given.
 * `since: "now"` answers only the cursor. `next` is the cursor for the following call; `dropped` counts events after
 * `since` the ring no longer holds; `reset` says the cursor was past the helper's newest event (its scripts restarted),
 * so reading started over from its first event.
 */
function events(q) {
  if (q.since === "now") return { tick: system.currentTick, events: [], next: eventSeq, dropped: 0, reset: false };
  let since = Math.max(0, Math.floor(Number(q.since ?? 0)) || 0);
  const reset = since > eventSeq;
  if (reset) since = 0;
  const kinds = Array.isArray(q.kinds) && q.kinds.length ? new Set(q.kinds.map(String)) : undefined;
  const limit = Math.max(1, Math.min(EVENTS_MAX_LIMIT, Math.floor(Number(q.limit ?? EVENTS_LIMIT)) || EVENTS_LIMIT));
  const oldest = EVENTS.length ? EVENTS[0].seq : eventSeq + 1;
  const dropped = Math.max(0, oldest - since - 1);
  const out = [];
  let next = eventSeq;
  for (const e of EVENTS) {
    if (e.seq <= since || (kinds && !kinds.has(e.kind))) continue;
    if (out.length === limit) {
      next = out[out.length - 1].seq;
      break;
    }
    out.push(e);
  }
  return { tick: system.currentTick, events: out, next, dropped, reset };
}

/** `id` with the `minecraft:` namespace when it has none. */
function namespaced(id) {
  const s = String(id);
  return s.includes(":") ? s : `minecraft:${s}`;
}

const COMPARE = {
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
};
function compareOp(op) {
  const f = COMPARE[op];
  if (!f) throw queryError("bad_condition", `op must be one of ${Object.keys(COMPARE).join(", ")}`);
  return f;
}
function numberOf(q, key) {
  const n = Number(q[key]);
  if (!Number.isFinite(n)) throw queryError("bad_condition", `${key} must be a number`);
  return n;
}

/**
 * A participant's score: `@s` or `@p` (the local player), a player by name, else a scoreboard identity by display
 * name, else a fake player name.
 */
function scoreOf(objective, participant) {
  const p = SELF_SELECTORS.has(participant) ? thePlayer() : world.getAllPlayers().find((pl) => pl.name === participant);
  if (p) return safely(() => objective.getScore(p));
  const identity = safely(() => objective.getParticipants().find((i) => i.displayName === participant));
  return safely(() => objective.getScore(identity ?? participant));
}

/**
 * One `wait` condition as a check run every tick: `() => ({ met, observed })`. Bad input throws at once, so the
 * caller learns it on the first reply rather than after the timeout.
 */
const CONDITIONS = {
  entity(c) {
    if (c.type === undefined) throw queryError("bad_condition", "entity needs type");
    const type = namespaced(c.type);
    const op = c.op ?? "present";
    const radius = Math.max(0, Math.min(256, Number(c.radius ?? 32)));
    let test;
    if (op === "present") test = (n) => n > 0;
    else if (op === "absent") test = (n) => n === 0;
    else {
      const f = compareOp(op);
      const value = numberOf(c, "value");
      test = (n) => f(n, value);
    }
    return () => {
      const { dim, at } = anchor(c);
      const count = dim.getEntities({ location: at, maxDistance: radius, type }).length;
      return { met: test(count), observed: { count } };
    };
  },
  block(c) {
    const x = Math.floor(numberOf(c, "x"));
    const y = Math.floor(numberOf(c, "y"));
    const z = Math.floor(numberOf(c, "z"));
    if (c.type === undefined) throw queryError("bad_condition", "block needs type");
    const type = namespaced(c.type);
    const is = c.is !== false;
    const states = c.states && typeof c.states === "object" ? Object.entries(c.states) : [];
    return () => {
      const player = thePlayer();
      const dim = world.getDimension(c.dimension ?? player?.dimension.id ?? "overworld");
      const b = blockAt(dim, x, y, z);
      // An unloaded block meets neither `is` nor `is: false`: its type is unknown.
      if (!b) return { met: false, observed: null };
      const info = blockInfo(b);
      const matches = info.typeId === type && states.every(([k, v]) => info.states?.[k] === v);
      return { met: matches === is, observed: info };
    };
  },
  score(c) {
    if (!c.objective || c.participant === undefined) throw queryError("bad_condition", "score needs objective and participant");
    const f = compareOp(c.op ?? "==");
    const value = numberOf(c, "value");
    const participant = String(c.participant);
    return () => {
      const objective = world.scoreboard.getObjective(String(c.objective));
      if (!objective) return { met: false, observed: { objective: false } };
      const score = scoreOf(objective, participant);
      return { met: score !== undefined && f(score, value), observed: { score: score ?? null } };
    };
  },
  event(c) {
    if (!c.event) throw queryError("bad_condition", "event needs event (an event kind or a scriptevent id)");
    const name = String(c.event);
    const match = c.match && typeof c.match === "object" ? Object.entries(c.match) : [];
    let since = c.since === undefined ? eventSeq : Math.max(0, Math.floor(Number(c.since)) || 0);
    if (since > eventSeq) since = 0;
    return () => {
      for (const e of EVENTS) {
        if (e.seq <= since) continue;
        if (e.kind !== name && !(e.kind === "scriptevent" && e.id === name)) continue;
        if (match.every(([k, v]) => e[k] === v)) return { met: true, observed: e };
      }
      return { met: false, observed: { next: eventSeq } };
    };
  },
  player(c) {
    const at = { x: numberOf(c, "x"), y: numberOf(c, "y"), z: numberOf(c, "z") };
    const radius = numberOf(c, "radius");
    return () => {
      const p = thePlayer();
      if (!p) return { met: false, observed: null };
      const l = p.location;
      const distance = Math.hypot(l.x - at.x, l.y - at.y, l.z - at.z);
      return { met: distance <= radius, observed: { location: vec(l), distance: Math.round(distance * 100) / 100 } };
    };
  },
  ticks(c) {
    const n = Math.max(0, Math.floor(numberOf(c, "ticks")));
    const start = system.currentTick;
    return () => ({ met: system.currentTick - start >= n, observed: { ticks: system.currentTick - start } });
  },
};

const WAIT_MAX_MS = 60_000;
const waits = [];
let waitRunner;
function finishWait(w, check) {
  const ticks = system.currentTick - w.startTick;
  const elapsedMs = Date.now() - w.startMs;
  if (check.met) w.resolve({ met: true, timedOut: false, elapsedMs, ticks, observed: check.observed });
  else if (elapsedMs >= w.timeoutMs) w.resolve({ met: false, timedOut: true, elapsedMs, ticks, observed: check.observed });
  else return false;
  return true;
}
function pumpWaits() {
  for (let i = waits.length - 1; i >= 0; i--) {
    const w = waits[i];
    let check;
    try {
      check = w.check();
    } catch (e) {
      waits.splice(i, 1);
      w.reject(e);
      continue;
    }
    if (finishWait(w, check)) waits.splice(i, 1);
  }
  if (!waits.length && waitRunner !== undefined) {
    system.clearRun(waitRunner);
    waitRunner = undefined;
  }
}

/**
 * Wait until `condition` (`{ kind, ... }`, see CONDITIONS) holds, checking now and then every tick, or until
 * `timeoutMs` (wall clock, so a paused game still times out). Answers `{ met, timedOut, elapsedMs, ticks, observed }`.
 */
function wait(q) {
  const c = q.condition ?? {};
  const make = CONDITIONS[c.kind];
  if (!make) throw queryError("bad_condition", `condition kind must be one of ${Object.keys(CONDITIONS).join(", ")}`);
  const check = make(c);
  const w = { check, startTick: system.currentTick, startMs: Date.now(), timeoutMs: Math.max(0, Math.min(WAIT_MAX_MS, Number(q.timeoutMs ?? 10_000))) };
  if (finishWait({ ...w, resolve: (r) => (w.now = r) }, check())) return w.now;
  return new Promise((resolve, reject) => {
    waits.push({ ...w, resolve, reject });
    waitRunner ??= system.runInterval(pumpWaits, 1);
  });
}

/**
 * The entity a `components`, `dynamic_properties` or `entity_properties` query reads: `entity` (an id from
 * `entities`), else the nearest entity of `type` around the anchor (within `radius`, default 64), else the player.
 */
function targetEntity(q) {
  if (q.entity !== undefined) {
    const e = world.getEntity(String(q.entity));
    if (!e || e.isValid === false) throw queryError("no_entity", `no entity with id ${q.entity}`);
    return e;
  }
  if (q.type && q.target !== "player") {
    const { dim, at } = anchor(q);
    const radius = Math.min(Number(q.radius ?? 64), 256);
    const e = dim.getEntities({ location: at, maxDistance: radius, closest: 1, type: q.type })[0];
    if (!e) throw queryError("no_entity", `no ${q.type} within ${radius} blocks`);
    return e;
  }
  if (q.target === "entity") throw queryError("no_entity", "target entity needs `entity` (an id) or `type`");
  const p = thePlayer();
  if (!p) throw queryError("no_entity", "no player in the world");
  return p;
}

/** Per component read: keys kept, array items kept, nesting depth, and string length. */
const READ_KEYS = 40;
const READ_ITEMS = 20;
const READ_DEPTH = 2;
const READ_STRING = 1000;
/** Fields never read off a component: its owner (a whole entity) and the class plumbing. */
const SKIP_FIELDS = new Set(["constructor", "entity", "block", "typeId", "isValid", "__proto__"]);

/** Own and prototype property names of a game object, up to (not including) Object.prototype. */
function fieldNames(value) {
  const names = new Set();
  for (let o = value; o && o !== Object.prototype && names.size < READ_KEYS * 2; o = Object.getPrototypeOf(o)) {
    for (const name of Object.getOwnPropertyNames(o)) if (!SKIP_FIELDS.has(name)) names.add(name);
  }
  return [...names];
}

/**
 * A readable copy of a Script API value: primitives as they are, a Vector3 as {x,y,z}, arrays and objects by their
 * readable fields, depth- and size-capped. Functions are left out. A getter that throws is left out and its path
 * pushed to `unreadable`, so one broken field never loses the rest.
 */
function readable(value, depth, path, unreadable) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "number" || t === "boolean") return value;
  if (t === "string") return value.length > READ_STRING ? `${value.slice(0, READ_STRING)}…` : value;
  if (t !== "object") return undefined;
  try {
    if (typeof value.x === "number" && typeof value.y === "number" && typeof value.z === "number") return vec(value);
    // A nested game object (an item, an entity type) reads as its id.
    if (depth > 0 && typeof value.typeId === "string") return value.typeId;
  } catch {
    unreadable.push(path || "(value)");
    return undefined;
  }
  if (depth >= READ_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, READ_ITEMS).map((v, i) => readable(v, depth + 1, `${path}[${i}]`, unreadable)).filter((v) => v !== undefined);
  }
  const out = {};
  let kept = 0;
  for (const name of fieldNames(value)) {
    if (kept >= READ_KEYS) break;
    let v;
    try {
      v = value[name];
    } catch {
      unreadable.push(path ? `${path}.${name}` : name);
      continue;
    }
    if (typeof v === "function") continue;
    const r = readable(v, depth + 1, path ? `${path}.${name}` : name, unreadable);
    if (r === undefined) continue;
    out[name] = r;
    kept++;
  }
  return out;
}

/**
 * Components whose data sits behind a no-argument method rather than a property (the type families, a rideable's
 * seats): each method's result is read into `values` under the given key.
 */
const COMPONENT_GETTERS = [
  ["getTypeFamilies", "families"],
  ["getSeats", "seats"],
  ["getFamilyTypes", "familyTypes"],
];

/** An entity's components (or the `ids` asked for): typeId and its readable fields; `unreadable` names fields that threw. */
function components(q) {
  const e = targetEntity(q);
  const only = Array.isArray(q.ids) ? new Set(q.ids.map((id) => (String(id).includes(":") ? String(id) : `minecraft:${id}`))) : undefined;
  const list = [];
  for (const c of e.getComponents()) {
    let typeId;
    try {
      typeId = c.typeId;
    } catch {
      continue;
    }
    if (only && !only.has(typeId)) continue;
    const unreadable = [];
    const one = { typeId, values: readable(c, 0, "", unreadable) ?? {} };
    for (const [method, key] of COMPONENT_GETTERS) {
      if (typeof c[method] !== "function") continue;
      try {
        const v = readable(c[method](), 0, key, unreadable);
        if (v !== undefined) one.values[key] = v;
      } catch {
        unreadable.push(key);
      }
    }
    if (unreadable.length) one.unreadable = unreadable;
    list.push(one);
  }
  list.sort((a, b) => (a.typeId < b.typeId ? -1 : a.typeId > b.typeId ? 1 : 0));
  const out = { id: e.id, typeId: e.typeId, components: list };
  if (only) {
    const missing = [...only].filter((id) => !list.some((c) => c.typeId === id));
    if (missing.length) out.missing = missing;
  }
  return out;
}

/** Dynamic property values kept per reply, and the longest string kept whole. */
const MAX_DYNAMIC = 500;
const DYNAMIC_STRING = 4000;

/** Dynamic properties of the world (default), the player or an entity, with the holder's total byte count. */
function dynamicProperties(q) {
  const target = q.target ?? (q.entity !== undefined || q.type ? "entity" : "world");
  const holder = target === "world" ? world : targetEntity(target === "player" ? { ...q, target: "player" } : q);
  const prefix = q.prefix === undefined ? "" : String(q.prefix);
  const ids = holder.getDynamicPropertyIds().filter((id) => id.startsWith(prefix)).sort();
  const limit = Math.min(Number(q.limit ?? MAX_DYNAMIC), MAX_DYNAMIC);
  const properties = {};
  const cut = [];
  for (const id of ids.slice(0, limit)) {
    let v;
    try {
      v = holder.getDynamicProperty(id);
    } catch {
      continue;
    }
    if (v && typeof v === "object") v = { x: v.x, y: v.y, z: v.z };
    else if (typeof v === "string" && v.length > DYNAMIC_STRING) {
      cut.push(id);
      v = v.slice(0, DYNAMIC_STRING);
    }
    properties[id] = v;
  }
  const out = { target, totalBytes: holder.getDynamicPropertyTotalByteCount(), count: ids.length, properties };
  if (target !== "world") {
    out.id = holder.id;
    out.typeId = holder.typeId;
  }
  if (ids.length > limit) out.truncated = true;
  if (cut.length) out.cutStrings = cut;
  return out;
}

/** Score rows kept per reply by default and at most. */
const SCORE_ROWS = 100;
const MAX_SCORE_ROWS = 1000;

/** Selectors that name the local player as a scoreboard participant. */
const SELF_SELECTORS = new Set(["@s", "@p"]);

/** Whether a scoreboard participant is the one asked for: `@s`/`@p`, a player or fake player name, or an entity id. */
function isParticipant(identity, wanted) {
  try {
    if (SELF_SELECTORS.has(wanted)) return identity.type === "Player" && identity.getEntity()?.id === thePlayer()?.id;
    if (identity.displayName === wanted) return true;
    if (identity.type === "Entity" || identity.type === "Player") return identity.getEntity()?.id === wanted;
  } catch {}
  return false;
}

/**
 * Scoreboard objectives with their scores. `objective` keeps one, `participant` keeps one participant's rows,
 * `limit` caps the rows over all objectives. Bedrock has one criteria, `dummy` (the Script API does not expose it).
 */
function scores(q) {
  const board = world.scoreboard;
  let objectives = board.getObjectives();
  if (q.objective !== undefined) {
    const one = board.getObjective(String(q.objective));
    if (!one) throw queryError("no_objective", `no scoreboard objective ${q.objective}; objectives: ${objectives.map((o) => o.id).join(", ") || "none"}`);
    objectives = [one];
  }
  const limit = Math.min(Number(q.limit ?? SCORE_ROWS), MAX_SCORE_ROWS);
  const wanted = q.participant === undefined ? undefined : String(q.participant);
  let rows = 0;
  let truncated = false;
  const out = [];
  for (const o of objectives) {
    const list = [];
    for (const info of o.getScores()) {
      const identity = info.participant;
      if (wanted !== undefined && !isParticipant(identity, wanted)) continue;
      if (rows >= limit) {
        truncated = true;
        break;
      }
      const row = { participant: identity.displayName, type: identity.type, score: info.score };
      try {
        const e = identity.type === "FakePlayer" ? undefined : identity.getEntity();
        if (e) row.entityId = e.id;
      } catch {}
      list.push(row);
      rows++;
    }
    out.push({ id: o.id, displayName: o.displayName, criteria: "dummy", scores: list });
  }
  return truncated ? { objectives: out, truncated } : { objectives: out };
}

const RAY_DISTANCE = 16;
const MAX_RAY_DISTANCE = 64;

/**
 * The first block and the entities along a ray: from x/y/z (default the player's head) along `direction` or toward
 * `to` (default the player's view direction), up to `maxDistance` (default 16, at most 64). Entities behind the block
 * hit are not reported, nor the player the ray starts in.
 */
function raycast(q) {
  const player = thePlayer();
  const fromPlayer = q.x === undefined || q.y === undefined || q.z === undefined;
  if (fromPlayer && !player) throw new Error("no player in the world and no x/y/z given");
  const dim = fromPlayer ? player.dimension : world.getDimension(q.dimension ?? player?.dimension.id ?? "overworld");
  const from = fromPlayer ? player.getHeadLocation() : { x: q.x, y: q.y, z: q.z };
  let direction;
  if (q.to) direction = { x: q.to.x - from.x, y: q.to.y - from.y, z: q.to.z - from.z };
  else if (q.direction) direction = q.direction;
  else if (player) direction = player.getViewDirection();
  else throw new Error("raycast needs direction or to");
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0)) throw new Error("raycast direction has zero length");
  direction = { x: direction.x / length, y: direction.y / length, z: direction.z / length };
  // Toward `to`, the ray ends at that point unless maxDistance says otherwise.
  const maxDistance = Math.max(0, Math.min(Number(q.maxDistance ?? (q.to ? length : RAY_DISTANCE)), MAX_RAY_DISTANCE));
  const opts = { maxDistance, includeLiquidBlocks: q.includeLiquidBlocks === true, includePassableBlocks: q.includePassableBlocks === true };
  let block = null;
  const hit = dim.getBlockFromRay(from, direction, opts);
  if (hit) {
    const at = hit.faceLocation;
    block = { ...blockInfo(hit.block), face: hit.face, faceLocation: vec(at) };
    // faceLocation is relative to the block's corner.
    const point = { x: hit.block.location.x + at.x, y: hit.block.location.y + at.y, z: hit.block.location.z + at.z };
    block.distance = Math.round(Math.hypot(point.x - from.x, point.y - from.y, point.z - from.z) * 100) / 100;
  }
  const entities = [];
  for (const h of dim.getEntitiesFromRay(from, direction, opts)) {
    try {
      if (fromPlayer && h.entity.id === player.id) continue;
      entities.push({ id: h.entity.id, typeId: h.entity.typeId, distance: Math.round(h.distance * 100) / 100 });
    } catch {}
  }
  return { from: vec(from), direction: vec(direction), maxDistance, block, entities };
}

/**
 * Entity property values (`entity.getProperty`). The Script API cannot list an entity's property ids, so the host
 * passes `ids` (the caller's, or the ones declared in the project's entity file); an id with no value is in `missing`.
 */
function entityProperties(q) {
  if (!Array.isArray(q.ids) || q.ids.length === 0) throw queryError("no_ids", "entity_properties needs ids");
  const e = targetEntity(q);
  const properties = {};
  const missing = [];
  for (const id of q.ids.map(String)) {
    let v;
    try {
      v = e.getProperty(id);
    } catch {}
    if (v === undefined) missing.push(id);
    else properties[id] = v;
  }
  const out = { id: e.id, typeId: e.typeId, properties };
  if (missing.length) out.missing = missing;
  return out;
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

const HANDLERS = { ping: () => "pong", registry, entities, entity, blocks, block, grid, player, state, stream, impacts, deaths, hurts, loadout, inventory, container: containerAt, components, dynamic_properties: dynamicProperties, scores, raycast, entity_properties: entityProperties, events, wait };

function sendReply(reply) {
  console.log(`[sculkwire:reply] ${JSON.stringify(reply)}`);
}

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id !== "sculkwire:query") return recordScriptEvent(ev);
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

/**
 * Scenes: a named test start saved IN the world, so it lasts as long as the world does. The box's blocks and entities
 * are a world structure `sculkwire:scene_<name>`; the player's state, the time and the weather are JSON in the world
 * dynamic property `sculkwire:scene:<name>` (split over `sculkwire:scene:<name>:<i>` when longer than one property holds,
 * with the part count in the main property).
 */
const SCENE_NAME = /^[a-z0-9_-]{1,32}$/;
const SCENE_PROP = "sculkwire:scene:";
/** Structures may be at most 64 blocks wide and deep, so a box of `2 * radius + 1` fits up to radius 31. */
const SCENE_MAX_RADIUS = 31;
const SCENE_PART = 30000;
const EQUIPMENT_SLOTS = ["Head", "Chest", "Legs", "Feet", "Offhand"];
/** The newest weather per dimension id, from `weatherChange` (the Script API has no stable weather getter). */
const WEATHER = new Map();
world.afterEvents.weatherChange.subscribe((ev) => WEATHER.set(ev.dimension, ev.newWeather));

function sceneName(q) {
  if (typeof q.name !== "string" || !SCENE_NAME.test(q.name)) {
    throw queryError("bad_name", `scene name must match [a-z0-9_-]{1,32}, got ${JSON.stringify(q.name)}`);
  }
  return q.name;
}

const sceneStructure = (name) => `sculkwire:scene_${name}`;

function readScene(name) {
  const head = world.getDynamicProperty(SCENE_PROP + name);
  if (head === undefined) return undefined;
  let text = head;
  if (typeof head === "number") {
    text = "";
    for (let i = 0; i < head; i++) text += world.getDynamicProperty(`${SCENE_PROP}${name}:${i}`) ?? "";
  }
  return JSON.parse(String(text));
}

/** Remove the scene's properties (the main one and any parts). */
function dropSceneProps(name) {
  const head = world.getDynamicProperty(SCENE_PROP + name);
  if (typeof head === "number") for (let i = 0; i < head; i++) world.setDynamicProperty(`${SCENE_PROP}${name}:${i}`, undefined);
  world.setDynamicProperty(SCENE_PROP + name, undefined);
}

function writeScene(name, scene) {
  dropSceneProps(name);
  const text = JSON.stringify(scene);
  if (text.length <= SCENE_PART) return world.setDynamicProperty(SCENE_PROP + name, text);
  const parts = Math.ceil(text.length / SCENE_PART);
  for (let i = 0; i < parts; i++) world.setDynamicProperty(`${SCENE_PROP}${name}:${i}`, text.slice(i * SCENE_PART, (i + 1) * SCENE_PART));
  world.setDynamicProperty(SCENE_PROP + name, parts);
}

/** An item as a scene stores it: everything `restoreItem` can put back. */
function sceneItem(item) {
  if (!item) return null;
  const out = { id: item.typeId, amount: item.amount };
  if (item.nameTag) out.name = item.nameTag;
  const lore = item.getLore();
  if (lore.length) out.lore = lore.map((line) => String(line));
  const durability = componentOf(item, "minecraft:durability");
  if (durability && durability.damage > 0) out.damage = durability.damage;
  const enchantable = componentOf(item, "minecraft:enchantable");
  const enchantments = enchantable ? enchantable.getEnchantments() : [];
  if (enchantments.length) out.enchantments = enchantments.map((e) => ({ id: e.type.id, level: e.level }));
  return out;
}

/** An ItemStack from a stored item; what could not be reapplied goes into `notes` under `where`. */
function restoreItem(rec, where, notes) {
  if (!rec) return undefined;
  let item;
  try {
    item = new ItemStack(rec.id, rec.amount);
  } catch (e) {
    notes.push(`${where}: ${rec.id} x${rec.amount} not restored (${e})`);
    return undefined;
  }
  if (rec.name) item.nameTag = rec.name;
  if (rec.lore) item.setLore(rec.lore);
  if (rec.damage) {
    const durability = componentOf(item, "minecraft:durability");
    if (durability) durability.damage = rec.damage;
    else notes.push(`${where}: ${rec.id} has no durability now; damage ${rec.damage} not restored`);
  }
  for (const e of rec.enchantments ?? []) {
    try {
      const enchantable = componentOf(item, "minecraft:enchantable");
      if (!enchantable) throw new Error("not enchantable");
      enchantable.addEnchantment({ type: new EnchantmentType(e.id), level: e.level });
    } catch (err) {
      notes.push(`${where}: ${rec.id} enchantment ${e.id} ${e.level} not restored (${err})`);
    }
  }
  return item;
}

/** A box `radius` around the anchor (block corners, inclusive), its rows kept inside the dimension's height range. */
function sceneBox(dim, at, radius) {
  const range = dim.heightRange;
  const cx = Math.floor(at.x);
  const cy = Math.floor(at.y);
  const cz = Math.floor(at.z);
  return {
    min: { x: cx - radius, y: Math.max(range.min, cy - radius), z: cz - radius },
    max: { x: cx + radius, y: Math.min(range.max - 1, cy + radius), z: cz + radius },
  };
}

/** Non-player entities inside a box. */
function entitiesInBox(dim, box) {
  const volume = { x: box.max.x - box.min.x + 1, y: box.max.y - box.min.y + 1, z: box.max.z - box.min.z + 1 };
  return dim.getEntities({ location: box.min, volume }).filter((e) => e.typeId !== "minecraft:player");
}

const SCENE_ATTRIBUTES = [
  ["health", "minecraft:health"],
  ["hunger", "minecraft:player.hunger"],
  ["saturation", "minecraft:player.saturation"],
];

function sceneSave(q) {
  const name = sceneName(q);
  const radius = q.radius ?? 8;
  if (!Number.isInteger(radius) || radius < 0 || radius > SCENE_MAX_RADIUS) {
    throw queryError("bad_radius", `radius must be a whole number from 0 to ${SCENE_MAX_RADIUS}, got ${radius}`);
  }
  const p = thePlayer();
  if (!p) throw new Error("no player in the world");
  const { dim, at } = anchor(q);
  const box = sceneBox(dim, at, radius);
  const notes = [];
  const structureId = sceneStructure(name);
  const manager = world.structureManager;
  const hadStructure = manager.get(structureId) !== undefined;
  const overwritten = hadStructure || world.getDynamicProperty(SCENE_PROP + name) !== undefined;
  if (hadStructure) manager.delete(structureId);
  manager.createFromWorld(structureId, dim, box.min, box.max, { includeBlocks: true, includeEntities: true, saveMode: "World" });
  const container = componentOf(p, "minecraft:inventory")?.container;
  const equippable = componentOf(p, "minecraft:equippable");
  const slots = [];
  for (let i = 0; i < (container?.size ?? 0); i++) slots.push(sceneItem(container.getItem(i)));
  const equipment = {};
  for (const slot of EQUIPMENT_SLOTS) equipment[slot] = sceneItem(equippable?.getEquipment(slot));
  const saved = {
    location: p.location,
    rotation: p.getRotation(),
    dimension: p.dimension.id,
    gameMode: p.getGameMode(),
    selectedSlot: p.selectedSlotIndex,
    slots,
    equipment,
  };
  for (const [key, id] of SCENE_ATTRIBUTES) {
    const attribute = componentOf(p, id);
    if (attribute && typeof attribute.currentValue === "number") saved[key] = attribute.currentValue;
  }
  const weather = WEATHER.get(dim.id);
  if (weather === undefined) notes.push("weather unknown (no weather change seen since the helper started); scene_reset leaves it as it is");
  const scene = { v: 1, name, savedAt: Date.now(), structure: structureId, dimension: dim.id, box, player: saved, timeOfDay: world.getTimeOfDay() };
  if (weather !== undefined) scene.weather = weather;
  writeScene(name, scene);
  return {
    name,
    overwritten,
    dimension: dim.id,
    box,
    entities: entitiesInBox(dim, box).length,
    items: slots.filter(Boolean).length + Object.values(equipment).filter(Boolean).length,
    notes,
  };
}

/** Resolve after one game tick. */
const nextTick = () => new Promise((resolve) => system.run(resolve));
/** Ticks scene_reset waits for the box's chunks to load after the teleport. */
const SCENE_LOAD_TICKS = 100;

async function sceneReset(q) {
  const name = sceneName(q);
  const scene = readScene(name);
  if (!scene) throw queryError("no_scene", `no scene named ${name} in this world; scene_list lists the saved ones`);
  const p = thePlayer();
  if (!p) throw new Error("no player in the world");
  const notes = [];
  const restored = [];
  const s = scene.player;
  const boxDim = world.getDimension(scene.dimension);
  const playerDim = world.getDimension(s.dimension);
  const teleport = () => p.teleport(s.location, { dimension: playerDim, rotation: s.rotation, keepVelocity: false });
  // Teleport first so the box's chunks load, then wait for them before placing the structure.
  teleport();
  const { min, max } = scene.box;
  for (let t = 0; t < SCENE_LOAD_TICKS && !(blockAt(boxDim, min.x, min.y, min.z) && blockAt(boxDim, max.x, max.y, max.z)); t++) {
    await nextTick();
  }
  let removedEntities = 0;
  try {
    for (const e of entitiesInBox(boxDim, scene.box)) {
      e.remove();
      removedEntities++;
    }
  } catch (e) {
    notes.push(`entities in the box not all removed (${e})`);
  }
  try {
    if (!world.structureManager.get(scene.structure)) throw new Error(`structure ${scene.structure} is missing`);
    world.structureManager.place(scene.structure, boxDim, min, { includeBlocks: true, includeEntities: true });
    restored.push("blocks", "entities");
  } catch (e) {
    notes.push(`blocks and entities not restored (${e})`);
  }
  // Again after placing, so the player stands where the scene says and not where a placed block pushed it.
  teleport();
  restored.push("position", "rotation", "dimension");
  const container = componentOf(p, "minecraft:inventory")?.container;
  if (container) {
    container.clearAll();
    s.slots.forEach((rec, i) => {
      const item = restoreItem(rec, `slot ${i}`, notes);
      if (item && i < container.size) container.setItem(i, item);
    });
    restored.push("inventory");
  } else notes.push("the player has no inventory component; inventory not restored");
  const equippable = componentOf(p, "minecraft:equippable");
  if (equippable) {
    for (const slot of EQUIPMENT_SLOTS) equippable.setEquipment(slot, restoreItem(s.equipment?.[slot], slot, notes));
    restored.push("equipment");
  } else notes.push("the player has no equippable component; armor and off hand not restored");
  p.setGameMode(s.gameMode);
  p.selectedSlotIndex = s.selectedSlot;
  restored.push("gameMode", "selectedSlot");
  for (const [key, id] of SCENE_ATTRIBUTES) {
    if (s[key] === undefined) continue;
    const attribute = componentOf(p, id);
    if (attribute?.setCurrentValue) {
      attribute.setCurrentValue(s[key]);
      restored.push(key);
    } else notes.push(`${key} not restored (no ${id} component)`);
  }
  for (const effect of p.getEffects()) p.removeEffect(effect.typeId);
  restored.push("effects");
  world.setTimeOfDay(scene.timeOfDay);
  restored.push("timeOfDay");
  if (scene.weather !== undefined) {
    boxDim.setWeather(scene.weather);
    restored.push("weather");
  } else notes.push("weather was unknown when the scene was saved; left as it is");
  return { name, dimension: scene.dimension, box: scene.box, removedEntities, restored, notes };
}

function sceneList() {
  const scenes = [];
  for (const id of world.getDynamicPropertyIds()) {
    if (!id.startsWith(SCENE_PROP)) continue;
    const name = id.slice(SCENE_PROP.length);
    if (!SCENE_NAME.test(name)) continue;
    try {
      const scene = readScene(name);
      scenes.push({
        name,
        savedAt: scene.savedAt,
        dimension: scene.dimension,
        box: scene.box,
        position: scene.player.location,
        structure: world.structureManager.get(scene.structure) !== undefined,
      });
    } catch (e) {
      scenes.push({ name, error: String(e) });
    }
  }
  return scenes.sort((a, b) => (a.name < b.name ? -1 : 1));
}

function sceneDelete(q) {
  const name = sceneName(q);
  const structureId = sceneStructure(name);
  const hadScene = world.getDynamicProperty(SCENE_PROP + name) !== undefined;
  const hadStructure = world.structureManager.get(structureId) !== undefined;
  if (!hadScene && !hadStructure) throw queryError("no_scene", `no scene named ${name} in this world`);
  dropSceneProps(name);
  if (hadStructure) world.structureManager.delete(structureId);
  return { name, deleted: true };
}

Object.assign(HANDLERS, { scene_save: sceneSave, scene_reset: sceneReset, scene_list: sceneList, scene_delete: sceneDelete });
