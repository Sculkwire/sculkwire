//! Player attributes, the player's inventory and the game's `Container` interface.
//!
//! # Wiring note (for `lib.rs`, which this module does not edit)
//!
//! ```text
//! mod inventory;
//!
//! // Engine::attach, after `anchors::resolve`: `let mut anchors = anchors::resolve(image);`
//! anchors.extend(inventory::resolve(core));
//!
//! // the module's anchors after attach (`engine.status`): in `Retail::anchors`,
//! // `let mut list = anchors::report(); list.extend(inventory::report());`
//!
//! // Engine::methods — every one of these runs on the client's own thread (`Thread::Main`), because
//! // the component storage may be created by the first lookup and only that thread owns the
//! // registry:
//! Method::main("player.attributes", inventory::h_attributes),
//! Method::main("player.inventory",  inventory::h_inventory),
//! Method::main("container.get",     inventory::h_container_get),
//! Method::main("container.open",    inventory::h_container_open),
//! Method::main("craft.match",       inventory::h_craft_match),
//! Method::main("craft.run",         inventory::h_craft_run),
//! ```
//!
//! `resolve` must run **after** `anchors::resolve` (it takes the resolved player system as its
//! recipe's seed) and installs the one hook this module owns, [`capture`], on the entity-system group
//! runner that hands the client's `EntityContext` to that system. The runner takes the context and
//! nothing else (`mov rsi,rcx` before it touches anything), so the replacement's one argument and
//! passthrough are exact.
//!
//! The hook is the only way to name the client's component registry from outside the game: the
//! registry is heap state created at world load, so no address in the image points at it, and the
//! agent's own per-tick hook ([`crate::hooks::player_system`]) is handed the same pointer but does
//! not publish it. If `live` ever publishes it (an accessor and an entity id), drop the hook and read
//! it from there instead.
//!
//! # What is proven, and how it is used
//!
//! `area-player` and `area-inventory` of the retail 1.26.63 analysis:
//!
//! * `EntityContext + 0x30` is the component registry the game's own systems pass to the storage
//!   getter ([`crate::ecs::ACCESSOR`]);
//! * `LocalPlayerComponent` is a flag component, so its storage's packed entity vector holds the
//!   single local player of a single-player client;
//! * `PlayerComponent` membership is what the game's own HUD data source checks before it asks for
//!   the actor, and `ActorOwnerComponent`'s 8-byte element is the `Player*` (the same helper the HUD
//!   uses at `+0x5e0` → `+0x10` for the selected slot);
//! * `Player + 0x5e0` is the `PlayerInventory*`, `+0x10` its selected slot, and `+0xb8` the
//!   `Container*` holding the hotbar and the main inventory — read at five independent sites, each
//!   of the shape `inv = [player+0x5e0]; c = [inv+0xb8]; [c]->vtable[0xa0]() / [+0x38](slot)`;
//! * `AttributesComponent`'s element (`0x50`) is the attribute map: a sorted `u32` id array with a
//!   parallel `AttributeInstance` array (stride `0x88`), whose `+0x7c` is the current value every
//!   gameplay reader uses;
//! * `ItemStack` is `0x80` bytes: impl `+0x08`, user data `+0x10`, damage `+0x20`, count `+0x22`;
//!   the item's identifier is the `std::string` at `impl + 0xd8` (the string the NBT save path
//!   writes as `Name`), and its maximum durability is its durability component's (`query.max_durability`);
//! * `ItemStack + 0x10` is the user-data `CompoundTag*`: a `std::map<std::string, Tag>` whose nodes
//!   carry the key at `+0x20` and the `Tag` by value at `+0x40`; a tag's value is at `+0x08` (byte,
//!   short, int, or a 32-byte `std::string`), a list's elements are `Tag*` at `+0x08`/`+0x10`, and
//!   the type id the compound's own accessors compare is `+0x28` of the tag (`1` byte, `2` short,
//!   `8` string, `9` list, `10` compound). A list *element* answers its type through the virtual
//!   `getId()` slot the game calls on it;
//! * `Container::getItem` is vtable `+0x38` and `Container::getContainerSize` is vtable `+0xa0`
//!   (proven on the player's inventory, on equipment and on block containers alike).
//!
//! Everything this file cannot prove answers `null` (a single field) or `-32001` naming the missing
//! anchor (a whole method) — never a guess: see [`MISSING`].
//!
//! # Needs one live run to confirm
//!
//! * that the group runner's `rcx` really is the client's `EntityContext` (the capture validates it
//!   before any read: a context whose registry holds no local player is skipped);
//! * that the local player entity carries `ActorOwnerComponent` and that its element is the `Player*`
//!   (the game's own HUD helper reads it that way, but for the *HUD's* actor context);
//! * the armour order: `Equipment` slots `0..3` are mapped to head/chest/legs/feet, which is the
//!   order of the game's per-slot armour helper but not proven for the container itself; the offhand
//!   is not mapped at all (the game reads slots `4` and `5` of the same container, but which is which
//!   is not proven, so it stays null);
//! * the cursor stack: it is not on the inventory object — the item-stack net manager and the
//!   container model that hold it are not located, so it stays null;
//! * that `impl + 0xd8` holds the identifier the NBT `Name` gets (the save path reads exactly that
//!   string; a live `/give` shows whether it is `minecraft:…` or `tile.…`);
//! * the attribute bounds: `+0x74` is proven as the clamp floor (`maxss`) and `+0x6c` as the value the
//!   engine's reset helper clamps a current value to, but `+0x70` (the value that helper restores) is
//!   the default only by that evidence — one `/attribute … get` settles all three;
//! * the armour and toughness totals: the sum of each worn piece's own `getArmorValue()` /
//!   `getToughnessValue()` (the item table slots its tooltip calls), falling back to an attribute of
//!   that name; enchantments are not part of either number.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use core::mem::transmute;
use core::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use agent_core::{Anchor, Core, Image, RpcError};
use serde_json::{json, Map, Value};

use crate::{anchors, ecs, live, pe};

/* ------------------------------------------------------------------------------------------------
 * The client's entity context
 * ---------------------------------------------------------------------------------------------- */

/// `EntityContext + 0x30` is the component registry (`lea rbx,[rdx+0x30]` in the travel system).
const ACCESSOR: usize = ecs::ACCESSOR;

/// The entity-system group runner whose `rcx` is the client's `EntityContext`: it stores the
/// argument in `rsi` and takes the registry's address as `lea r13,[rsi+0x30]`, then hands the same
/// pointer to the local-player travel system as that system's second argument.
///
/// `mov rsi, rcx`, in either encoding the compiler may pick for it.
const RUNNER_MOV_RSI_RCX: [&[u8]; 2] = [&[0x48, 0x89, 0xCE], &[0x48, 0x8B, 0xF1]];
/// `lea r13,[rsi+0x30]`: the registry's address, which is the accessor every component lookup takes.
const RUNNER_LEA_R13_REGISTRY: &[u8] = &[0x4C, 0x8D, 0x6E, 0x30];
/// A group runner is a few hundred bytes; anything much larger is a caller that happens to reach the
/// travel system, and anything tiny is a thunk.
const RUNNER_SIZE: core::ops::Range<usize> = 0x100..0x2000;

/// The contexts the hook has seen, most recent first by rotation, and when the last one arrived
/// (`GetTickCount64`).
///
/// More than one is kept because a group runner of this shape can be reached from either side of an
/// integrated world; the reader takes the first context whose registry holds a local player, so one
/// side's context cannot hide the other's.
const CONTEXT_SLOTS: usize = 4;
static CONTEXTS: [AtomicUsize; CONTEXT_SLOTS] =
    [AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0)];
static CONTEXT_NEXT: AtomicUsize = AtomicUsize::new(0);
static CONTEXT_SEEN: AtomicU64 = AtomicU64::new(0);
/// The trampoline of [`capture`]: the relocated prologue of the runner.
static CONTEXT_TRAMPOLINE: AtomicUsize = AtomicUsize::new(0);
/// The address the hook was installed at (0 = not installed).
static CONTEXT_ENTRY: AtomicUsize = AtomicUsize::new(0);
/// A request without a live context is explained once, not on every call.
static CONTEXT_LOGGED: AtomicUsize = AtomicUsize::new(0);

/// How long a captured context is believed. A loaded world's systems run 20 times a second, so a
/// context that has not been seen for this long belongs to a world that is gone (or to a process
/// that has unloaded one), and the registry behind it may be freed.
const CONTEXT_FRESH_MS: u64 = 5_000;

/// The replacement for the group runner: record the context, then run the original unchanged.
///
/// The prologue is copied into the trampoline before the entry is patched, so between the patch and
/// the store of the trampoline no call can arrive here; the guard is the belt for that brace, and
/// skipping one group pass is the worst it can cost.
extern "C" fn capture(context: usize) -> usize {
    if context != 0 {
        let slot = CONTEXT_NEXT.fetch_add(1, Ordering::AcqRel) % CONTEXT_SLOTS;
        CONTEXTS[slot].store(context, Ordering::Release);
        CONTEXT_SEEN.store(agent_core::win::tick_ms(), Ordering::Release);
    }
    let original = CONTEXT_TRAMPOLINE.load(Ordering::Acquire);
    if original == 0 {
        return 0;
    }
    // SAFETY: the trampoline is the relocated prologue of the game's own
    // `void __cdecl tick(EntityContext*)`; the arguments are forwarded untouched.
    unsafe { transmute::<usize, extern "C" fn(usize) -> usize>(original)(context) }
}

/// Installs [`capture`] on `target`, at most once.
fn install(target: usize) {
    if target == 0 || CONTEXT_ENTRY.load(Ordering::Acquire) != 0 {
        return;
    }
    match agent_core::hook::install_published(target, capture as *const () as usize, &CONTEXT_TRAMPOLINE) {
        Some(_) => {
            CONTEXT_ENTRY.store(target, Ordering::Release);
            agent_core::log::fmt(format_args!("inventory: context hook installed at 0x{target:x}"));
        }
        None => agent_core::log::fmt(format_args!(
            "inventory: context hook refused at 0x{target:x}, game code untouched; player.attributes and player.inventory answer -32001"
        )),
    }
}

/// The group runner: a caller of the player system that reads the registry at `context + 0x30`.
///
/// The recipe is the player system's own body shape, so a title update that moves the runner still
/// resolves it; an ambiguous or empty answer resolves nothing (fail-closed).
fn context_runner(image: &Image) -> Option<usize> {
    let system = anchors::system()?;
    let mut found: Option<usize> = None;
    for site in pe::callers(image, system) {
        let Some(start) = image.function_start(site) else {
            continue;
        };
        if start == system {
            continue;
        }
        let Some(end) = image.function_end(start) else {
            continue;
        };
        if !RUNNER_SIZE.contains(&(end - start)) {
            continue;
        }
        if !RUNNER_MOV_RSI_RCX.iter().any(|bytes| pe::has_pattern(start, end - start, bytes))
            || !pe::has_pattern(start, end - start, RUNNER_LEA_R13_REGISTRY)
        {
            continue;
        }
        if found == Some(start) {
            continue; // the runner calls the player system twice: one audience, not two candidates
        }
        if found.is_some() {
            return None;
        }
        found = Some(start);
    }
    found
}

/// The group runner this module resolved, 0 while it has not.
static RUNNER: AtomicUsize = AtomicUsize::new(0);

/// Resolves this module's anchors and installs its hook. Called once from `Engine::attach`, after
/// `anchors::resolve` (the recipe is seeded with the resolved player system).
pub(crate) fn resolve(core: &'static Core) -> Vec<Anchor> {
    let runner = context_runner(core.image());
    if let Some(target) = runner {
        RUNNER.store(target, Ordering::Release);
        install(target);
    } else {
        agent_core::log::line("inventory: no entity-system group runner matched, the player's data stays unavailable");
    }
    resolve_armor(core.image());
    resolve_links(core.image());
    report()
}

/// The item tooltip's armour lines: `mov rcx,[rax]; mov rax,[rcx]; mov rax,[rax+SLOT]; call; nop;
/// mov r14d,eax; test eax,eax; jle` — once with `Item::getArmorValue()` (the "armor" line), then with
/// `Item::getToughnessValue()` (the "armorToughness" line), both `int (this)`. Exactly these two sites in
/// `.text`, in one function, the toughness slot right after the armour slot.
const ARMOR_PATTERN: &str = "48 8B 01 48 8B 80 ?? ?? ?? ?? FF 15 ?? ?? ?? ?? 90 41 89 C6 85 C0 0F 8E";
/// The item table's armour and toughness slots (byte offsets), 0 while unresolved, and the first site
/// (for `engine.status`).
static ARMOR_SLOT: AtomicUsize = AtomicUsize::new(0);
static TOUGHNESS_SLOT: AtomicUsize = AtomicUsize::new(0);
static ARMOR_SITE: AtomicUsize = AtomicUsize::new(0);

/// Finds the two sites of [`ARMOR_PATTERN`] and reads the two slots out of them.
fn resolve_armor(image: &Image) {
    let sites = all_sites(image, &[pattern(ARMOR_PATTERN)]).remove(0);
    let [armor_site, toughness_site] = sites[..] else {
        return;
    };
    if image.function_start(armor_site).is_none() || image.function_start(armor_site) != image.function_start(toughness_site) {
        return;
    }
    let (Some(armor), Some(toughness)) = (offset_at(armor_site, 6, true, true), offset_at(toughness_site, 6, true, true)) else {
        return;
    };
    if toughness != armor + 8 {
        return;
    }
    ARMOR_SLOT.store(armor, Ordering::Release);
    TOUGHNESS_SLOT.store(toughness, Ordering::Release);
    ARMOR_SITE.store(armor_site, Ordering::Release);
}

/// The anchors as they are now, for `engine.status` (everything resolves once, at attach). A link that
/// is a vtable slot or a field reports its offset, the block-actor link the function's address.
pub(crate) fn report() -> Vec<Anchor> {
    let mut anchors = Vec::with_capacity(LINK_COUNT + 2);
    anchors.push(Anchor { name: "inventory.context", addr: RUNNER.load(Ordering::Acquire) });
    anchors.push(Anchor { name: "inventory.armor_values", addr: ARMOR_SITE.load(Ordering::Acquire) });
    for (index, name) in LINK_NAMES.iter().enumerate() {
        anchors.push(Anchor { name, addr: LINKS[index].load(Ordering::Acquire) });
    }
    anchors
}

/// The player's armour points and toughness: over the four armour slots, the sum of each worn item's own
/// `getArmorValue()` and `getToughnessValue()` — the numbers the item's tooltip shows. `None` when the two
/// slots did not resolve or the armour container is unreadable.
fn armor_points(armor: usize) -> Option<(f32, f32)> {
    let (armor_slot, toughness_slot) = (ARMOR_SLOT.load(Ordering::Acquire), TOUGHNESS_SLOT.load(Ordering::Acquire));
    if armor_slot == 0 || toughness_slot == 0 {
        return None;
    }
    let (mut points, mut toughness) = (0i32, 0i32);
    for body_slot in 0..ARMOR_PARTS.len() {
        let stack = container_item(armor, body_slot)?;
        if pe::read::<u8>(stack + STACK_COUNT).is_none_or(|count| count == 0) {
            continue;
        }
        let Some(item) = pe::read::<usize>(stack + STACK_IMPL).filter(|pointer| *pointer != 0).and_then(|pointer| pe::read::<usize>(pointer)) else {
            continue;
        };
        if item == 0 {
            continue;
        }
        let value = |slot: usize| -> Option<i32> {
            let entry = interface_slot(item, slot)?;
            // SAFETY: the item's own `int getArmorValue()` / `int getToughnessValue()`, `this` only, as
            // the tooltip calls them.
            let value = unsafe { transmute::<usize, unsafe extern "C" fn(usize) -> i32>(entry)(item) };
            (0..=1_000).contains(&value).then_some(value)
        };
        points += value(armor_slot)?;
        toughness += value(toughness_slot)?;
    }
    Some((points as f32, toughness as f32))
}

/* ------------------------------------------------------------------------------------------------
 * The local player: registry, entity, actor
 * ---------------------------------------------------------------------------------------------- */

/// The client's component registry and the local player's entity, or `None`.
///
/// `None` covers every reason at once (no hook, no context seen recently, no local player, an entity
/// that is not a player) because the caller's answer is the same for all of them; the log names the
/// reason once.
pub(crate) fn context() -> Option<(usize, u32)> {
    // The accessor the client's own tick reads through is the world's live registry: prefer it over
    // the hook ring, which only fills when a system runner happens to be entered.
    if let Some(accessor) = crate::live::client_accessor() {
        if let Some(found) = local_player_in(accessor) {
            return Some(found);
        }
    }
    let seen = CONTEXT_SEEN.load(Ordering::Acquire);
    if seen == 0 {
        note_context("no entity context has been captured: the inventory.context hook is not running");
        return None;
    }
    if agent_core::win::tick_ms().saturating_sub(seen) >= CONTEXT_FRESH_MS {
        note_context("the captured entity context is stale: no client tick has run for 5 s");
        return None;
    }
    for slot in &CONTEXTS {
        let context = slot.load(Ordering::Acquire);
        if context == 0 {
            continue;
        }
        let accessor = context + ACCESSOR;
        if !pe::readable(accessor, 8) {
            continue;
        }
        if let Some(found) = local_player_in(accessor) {
            return Some(found);
        }
    }
    note_context("no captured context holds a local player: this registry is not the client's");
    None
}

/// The local player in one registry accessor: its entity, when that entity really is a player.
fn local_player_in(accessor: usize) -> Option<(usize, u32)> {
    let (_, count, entity) = ecs::local_players(accessor)?;
    if count == 0 || entity == 0 {
        return None;
    }
    // The game's own HUD data source checks that the entity carries `PlayerComponent` before it asks
    // for the actor; the same test here keeps a non-player entity from being read as one.
    let players = ecs::storage(accessor, anchors::component_hash("PlayerComponent"))?;
    ecs::contains(players, entity).then_some((accessor, entity))
}

/// Logs why the player's data is unavailable, once.
fn note_context(reason: &str) {
    if CONTEXT_LOGGED.swap(1, Ordering::AcqRel) == 0 {
        agent_core::log::fmt(format_args!("inventory: {reason}"));
    }
}

/// The local player's `Player*`, through the components the game's own HUD reads.
///
/// `ActorOwnerComponent`'s element is one pointer (stride 8) and the HUD's own helper returns it as
/// the player object; the pointer is only believed when it owns a readable `PlayerInventory` with a
/// hotbar slot in `0..9`.
fn player(accessor: usize, entity: u32) -> Option<usize> {
    let actors = ecs::storage(accessor, anchors::component_hash("ActorOwnerComponent"))?;
    let element = ecs::element(actors, entity, ACTOR_STRIDE)?;
    let actor = pe::read::<usize>(element)?;
    if actor == 0 {
        return None;
    }
    let inventory = pe::read::<usize>(actor + PLAYER_INVENTORY)?;
    if inventory == 0 || !pe::readable(inventory, PLAYER_INVENTORY_CONTAINER + 8) {
        return None;
    }
    let selected = pe::read::<u32>(inventory + PLAYER_INVENTORY_SELECTED)?;
    (selected < 9).then_some(actor)
}

/// `ActorOwnerComponent` element stride: one actor pointer.
const ACTOR_STRIDE: usize = 0x08;
/// `Player + 0x5e0` is the `PlayerInventory*`.
const PLAYER_INVENTORY: usize = 0x5E0;
/// `PlayerInventory + 0x10` is the selected hotbar slot (0..8).
const PLAYER_INVENTORY_SELECTED: usize = 0x10;
/// `PlayerInventory + 0xb8` is the `Container*` holding the hotbar and the main inventory.
const PLAYER_INVENTORY_CONTAINER: usize = 0xB8;

/* ------------------------------------------------------------------------------------------------
 * Attributes
 * ---------------------------------------------------------------------------------------------- */

/// `AttributesComponent` element: the attribute map (`BaseAttributeMap`).
const ATTRIBUTE_STRIDE: usize = 0x50;
/// The map's sorted id array (`begin`/`end`) and its parallel instance array (`begin`).
const ATTRIBUTE_IDS: usize = 0x00;
const ATTRIBUTE_IDS_END: usize = 0x08;
const ATTRIBUTE_INSTANCES: usize = 0x18;
/// `AttributeInstance` stride and the fields every gameplay reader uses.
const INSTANCE_STRIDE: usize = 0x88;
const INSTANCE_DEFINITION: usize = 0x08;
const INSTANCE_CURRENT: usize = 0x7c;
/// The minimum: the floor `getCurrentValue` clamps a candidate with (`maxss`), which the engine's own
/// reset helper reproduces.
const INSTANCE_MINIMUM: usize = 0x74;
/// The maximum: the value the engine's own reset helper clamps a current value to (`cmpltss` against a
/// constant, then stores that constant here).
const INSTANCE_MAXIMUM: usize = 0x6c;
/// The base value: the value of the instance's default triple (`+0x68` min, `+0x6c` max, `+0x70` value;
/// the current triple is `+0x74`/`+0x78`/`+0x7c`). The engine's reset helper restores the current value
/// to it, and a fresh instance starts from it.
const INSTANCE_DEFAULT: usize = 0x70;
/// The attribute definition's name: `std::string` at `+0x08` (`+0x18` size, `+0x20` capacity).
const DEFINITION_NAME: usize = 0x08;
/// A player has a dozen attributes; a walk that finds more is reading something else.
const ATTRIBUTE_LIMIT: usize = 64;

/// `player.attributes` → one entry per attribute on the player, plus the two derived totals.
pub(crate) fn h_attributes(_core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    world()?;
    let (accessor, entity) = context().ok_or_else(|| RpcError::anchor("inventory.context"))?;
    let storage = ecs::storage(accessor, anchors::component_hash("AttributesComponent"))
        .ok_or_else(|| RpcError::anchor("inventory.attributes"))?;
    let element = ecs::element(storage, entity, ATTRIBUTE_STRIDE).ok_or_else(|| RpcError::anchor("inventory.attributes"))?;
    let ids = pe::read::<usize>(element + ATTRIBUTE_IDS).ok_or_else(|| RpcError::anchor("inventory.attributes"))?;
    let ids_end = pe::read::<usize>(element + ATTRIBUTE_IDS_END).ok_or_else(|| RpcError::anchor("inventory.attributes"))?;
    let instances =
        pe::read::<usize>(element + ATTRIBUTE_INSTANCES).ok_or_else(|| RpcError::anchor("inventory.attributes"))?;
    if ids_end < ids || instances == 0 || (ids_end - ids) % 4 != 0 {
        return Err(RpcError::anchor("inventory.attributes"));
    }
    let count = (ids_end - ids) / 4;
    if count == 0 || count > ATTRIBUTE_LIMIT {
        return Err(RpcError::anchor("inventory.attributes"));
    }
    // The instance array is what the walk reads: it has to hold one entry per id, or the map is not
    // the one this element was taken for.
    if !pe::readable(instances, count * INSTANCE_STRIDE) {
        return Err(RpcError::anchor("inventory.attributes"));
    }
    let mut map = Map::new();
    for index in 0..count {
        let instance = instances + index * INSTANCE_STRIDE;
        let Some(definition) = pe::read::<usize>(instance + INSTANCE_DEFINITION) else {
            continue;
        };
        let Some(name) = attribute_name(definition) else {
            continue;
        };
        // `current` is what every gameplay reader reads. The two bounds are reported only when they agree
        // with the current value (`min <= current <= max`), so a wrong offset answers null instead of a
        // plausible-looking number. `base` is the default triple's value (`+0x70`), what modifiers apply
        // to (movement 0.1, health 20); `default` is the same value inside the bounds.
        let current = pe::read::<f32>(instance + INSTANCE_CURRENT).filter(|value| value.is_finite());
        let minimum = pe::read::<f32>(instance + INSTANCE_MINIMUM).filter(|value| value.is_finite());
        let maximum = pe::read::<f32>(instance + INSTANCE_MAXIMUM).filter(|value| value.is_finite());
        let default = pe::read::<f32>(instance + INSTANCE_DEFAULT).filter(|value| value.is_finite());
        let base = default;
        let (minimum, maximum, default) = match (current, minimum, maximum) {
            (Some(current), Some(minimum), Some(maximum)) if minimum <= current && current <= maximum => (
                Some(minimum),
                Some(maximum),
                default.filter(|value| *value >= minimum && *value <= maximum),
            ),
            _ => (None, None, None),
        };
        let entry = json!({
            "current": number(current),
            "base": number(base),
            "min": number(minimum),
            "max": number(maximum),
            "default": number(default),
        });
        map.entry(name).or_insert(entry);
    }
    // Armour points and toughness are not attributes on this build (the map holds neither): each total is
    // the worn pieces' own item values summed over the four armour slots, as their tooltips show them.
    let worn = equipment(accessor, entity).1.and_then(armor_points);
    let armor = match worn {
        Some((points, _)) => number(Some(points)),
        None => total(&map, &["minecraft:armor", "generic.armor"]),
    };
    let toughness = match worn {
        Some((_, toughness)) => number(Some(toughness)),
        None => total(&map, &["minecraft:armor_toughness", "minecraft:armorToughness", "generic.armor_toughness"]),
    };
    // An attribute literally named `armor` keeps its own entry: the derived key never overwrites an
    // attribute the map already holds.
    map.entry(String::from("armor")).or_insert(armor);
    map.entry(String::from("armorToughness")).or_insert(toughness);
    Ok(Value::Object(map))
}

/// The name an attribute definition carries, from the first candidate offset that holds one.
///
/// The definition is a static in `.data` whose bytes are written at startup, so the name is read live.
/// `Attribute` keeps its name as a `HashedString` (`u64` hash, then the `std::string`) after an 8-byte
/// header, so `+0x10` is tried first; `+0x08`, `+0x18`, `+0x00` and `+0x28` follow. Only a namespaced
/// printable token (`minecraft:health`) is believed, so a wrong offset skips the attribute.
fn attribute_name(definition: usize) -> Option<String> {
    for offset in [0x10, DEFINITION_NAME, 0x18, 0x00, 0x28] {
        let Some(name) = pe::std_string(definition + offset) else {
            continue;
        };
        if (3..=64).contains(&name.len()) && name.contains(':') && name.bytes().all(|byte| byte.is_ascii_graphic()) {
            return Some(name);
        }
    }
    None
}

/// The `current` value of the first of `names` the attribute map holds.
fn total(map: &Map<String, Value>, names: &[&str]) -> Value {
    for name in names {
        let Some(current) = map.get(*name).and_then(|entry| entry.get("current")) else {
            continue;
        };
        if !current.is_null() {
            return current.clone();
        }
    }
    Value::Null
}

/* ------------------------------------------------------------------------------------------------
 * The Container interface
 * ---------------------------------------------------------------------------------------------- */

/// `Container::getItem(int slot) -> ItemStack const&`.
const CONTAINER_GET_ITEM: usize = 0x38;
/// `Container::getContainerSize() -> int`.
const CONTAINER_SIZE: usize = 0xA0;
/// A container this agent reads holds at most the biggest block container (54) plus the player's
/// own slots; a size outside this range means the object is not the container it was taken for.
const CONTAINER_LIMIT: usize = 0x100;

type GetItem = unsafe extern "C" fn(usize, u32) -> usize;
type GetSize = unsafe extern "C" fn(usize) -> i32;

/// The code pointer of `slot` in `object`'s vtable, when it is a function of the game's own image.
///
/// The vtable load is what the game's own call sites use (`mov rax,[rcx]; mov rax,[rax+0x38]`), and
/// requiring the entry to be an image code pointer is what keeps a wrong object from being called.
fn interface_slot(object: usize, slot: usize) -> Option<usize> {
    if !pe::readable(object, 8) {
        return None;
    }
    let vtable = pe::read::<usize>(object)?;
    if vtable == 0 || !pe::readable(vtable, slot + 8) {
        return None;
    }
    let entry = pe::read::<usize>(vtable + slot)?;
    (entry != 0 && pe::in_image_code(entry)).then_some(entry)
}

/// `getContainerSize()` of a container the game itself exposes.
fn container_size(container: usize) -> Option<usize> {
    let entry = interface_slot(container, CONTAINER_SIZE)?;
    // SAFETY: the slot is the game's own `int getContainerSize()` and `container` is the object the
    // game would call it on; it takes `this` and nothing else.
    let size = unsafe { transmute::<usize, GetSize>(entry)(container) };
    (0..=CONTAINER_LIMIT as i32).contains(&size).then_some(size as usize)
}

/// The `ItemStack` at `slot` through `getItem`: a reference into the container, valid while the
/// container holds it.
fn item_at(entry: usize, container: usize, slot: usize) -> Option<usize> {
    // SAFETY: `entry` is the game's own `ItemStack const& getItem(int)` table entry, called on the
    // container it belongs to; the returned reference points into that container and is only read
    // here (`pe::read`).
    let stack = unsafe { transmute::<usize, GetItem>(entry)(container, slot as u32) };
    (stack != 0 && pe::readable(stack, ITEM_STACK_SIZE)).then_some(stack)
}

/// The `ItemStack` at `slot` of `container`, with the interface checked first.
fn container_item(container: usize, slot: usize) -> Option<usize> {
    item_at(interface_slot(container, CONTAINER_GET_ITEM)?, container, slot)
}

/* ------------------------------------------------------------------------------------------------
 * Item stacks
 * ---------------------------------------------------------------------------------------------- */

/// `sizeof(ItemStack)`; the copy constructor zero-fills exactly this many bytes.
const ITEM_STACK_SIZE: usize = 0x80;
/// Refcounted impl (`impl[0]` is the `Item*`); 0 with no count means the slot is empty.
const STACK_IMPL: usize = 0x08;
/// The u16 `Damage`/aux value.
const STACK_DAMAGE: usize = 0x20;
/// The u8 `Count`.
const STACK_COUNT: usize = 0x22;
/// The identifier string (`NBT "Name"`) on the impl.
const ITEM_IDENTIFIER: usize = 0xD8;
/// `ItemStack + 0x10`: the user data, a `CompoundTag*` (null when the stack has none).
const STACK_USER_DATA: usize = 0x10;

/* ---- the user-data tag: what the game's own `getCompound`/`getList`/`getString` walk ---- */
//
/// A `CompoundTag` is a `Tag` whose map head sits at `+0x08`; the tree's nodes are reached from the
/// header node's parent (`+0x08`).
const COMPOUND_HEAD: usize = 0x08;
/// A map node: left `+0x00`, parent `+0x08`, right `+0x10`, is-nil byte `+0x19`, the key as a
/// `std::string` at `+0x20` (buffer `+0x20`, size `+0x30`, capacity `+0x38`), the value — the `Tag`
/// itself, by value — at `+0x40`.
const NODE_LEFT: usize = 0x00;
const NODE_PARENT: usize = 0x08;
const NODE_RIGHT: usize = 0x10;
const NODE_NIL: usize = 0x19;
const NODE_KEY: usize = 0x20;
const NODE_VALUE: usize = 0x40;
/// The bytes of a node this module reads (through the cached type id at `value + 0x28`).
const NODE_SIZE: usize = 0x70;
/// A tree this shallow holds every `display`/`ench`/`Items` key; deeper means a loop.
const TREE_DEPTH: usize = 48;
/// `Tag + 0x00` vtable, `+0x08` value, `+0x28` the type id the compound's accessors compare.
const TAG_VALUE: usize = 0x08;
const TAG_TYPE: usize = 0x28;
/// `Tag::getId()`: the virtual slot the game calls on every list element.
const TAG_GET_ID: usize = 0x28;
/// A `ListTag`'s elements: `std::vector<Tag*>` begin `+0x08`, end `+0x10`.
const LIST_BEGIN: usize = 0x08;
const LIST_END: usize = 0x10;
/// One list holds at most the biggest container; anything larger is not a list.
const LIST_LIMIT: usize = 64;
/// Nested item contents (a shulker inside a shulker) are read to this depth only.
const CONTENTS_DEPTH: usize = 2;

/// The tag type ids the game's accessors check.
const TAG_BYTE: u8 = 1;
const TAG_SHORT: u8 = 2;
const TAG_INT: u8 = 3;
const TAG_STRING: u8 = 8;
const TAG_LIST: u8 = 9;
const TAG_COMPOUND: u8 = 10;
/// `ActorEquipmentComponent` element stride: two container pointers, the hand at `+0x00` and the armour at
/// `+0x08` (the game's own per-slot armour helper reads `[element + 8]` and calls `getItem(0..3)` on it;
/// live, `[element + 0]` slot 0 is the selected hotbar stack, i.e. the main hand).
const EQUIPMENT_STRIDE: usize = 0x10;
const EQUIPMENT_HAND: usize = 0x00;
const EQUIPMENT_ARMOR: usize = 0x08;
/// The hand container's off-hand slot (slot 0 is the main hand).
const HAND_OFFHAND: usize = 1;
/// The armour slots the armour container holds in its `0..4` range, in the order the game's own
/// per-slot armour helper switches on (it takes a slot in `0..3` and returns that piece's armour).
const ARMOR_PARTS: [&str; 4] = ["head", "chest", "legs", "feet"];

/// One `ItemStack` as the wire spells it, or `None` for an empty slot.
///
/// Only the fields this build can read are present: `item`, `count`, `data` and, for a damageable
/// item, `durability`. `enchantments`, `name`, `lore` and `contents` live in the stack's user data
/// compound, whose node layout is not decoded, so they are omitted rather than reported empty.
pub(crate) fn slot(stack: usize) -> Option<Value> {
    let impl_pointer = pe::read::<usize>(stack + STACK_IMPL)?;
    let count = pe::read::<u8>(stack + STACK_COUNT)?;
    if impl_pointer == 0 || count == 0 || count > 127 {
        return None;
    }
    let damage = pe::read::<u16>(stack + STACK_DAMAGE)?;
    let mut entry = Map::new();
    entry.insert(String::from("item"), identifier(impl_pointer).map(Value::String).unwrap_or(Value::Null));
    entry.insert(String::from("count"), Value::from(count));
    entry.insert(String::from("data"), Value::from(damage));
    // `impl[0]` is the `Item*`; only an item with a durability component carries a durability.
    let max = pe::read::<usize>(impl_pointer).filter(|item| *item != 0).and_then(max_durability);
    if let Some(max) = max {
        entry.insert(String::from("durability"), json!({ "damage": damage, "max": max }));
    }
    // The name, the lore, the enchantments and a bundle's or shulker's contents all live in the
    // stack's user data compound, which the game's own NBT save/load hands around at `+0x10`.
    if let Some(user_data) = pe::read::<usize>(stack + STACK_USER_DATA).filter(|data| *data != 0) {
        user_data_fields(&mut entry, user_data, 0);
    }
    Some(Value::Object(entry))
}

/// The item's maximum durability, as `query.max_durability` reads it: `Item::getComponent(key)` of the
/// durability component, then its `i32` maximum. `None` for an item without one, or while the component
/// key (a static the game initialises on first use) is still empty.
fn max_durability(item: usize) -> Option<i32> {
    let (slot, key, field) = (link(L_ITEM_COMPONENT)?, link(L_DURABILITY_KEY)?, link(L_DURABILITY_MAX)?);
    // A `HashedString` starts with its hash: zero means the static has not been built yet.
    if pe::read::<u64>(key)? == 0 {
        return None;
    }
    let entry = interface_slot(item, slot)?;
    // SAFETY: the item's own `getComponent(HashedString const&)` with the game's own static key.
    let component = unsafe { transmute::<usize, extern "C" fn(usize, usize) -> usize>(entry)(item, key) };
    if component == 0 {
        return None;
    }
    pe::read::<i32>(component + field).filter(|max| (1..=0x7fff).contains(max))
}

/// The answer for a block without a container (the block's id in `data.block`).
fn no_container(x: i32, y: i32, z: i32, block: Value) -> RpcError {
    RpcError::invalid_params("").with_data(json!({
        "message": format!("the block at {x} {y} {z} has no container"),
        "block": block,
    }))
}

/// The fields a stack's user-data compound carries, added to `entry` when they are there.
///
/// `display` holds `Name` (a string) and `Lore` (a list of strings); `ench` is a list of
/// `{id, lvl}` shorts; `Items` is a container-shaped list of `{Slot, Name, Count, Damage, tag}` and a
/// bundle's `storage_item_component_content` the same item compounds without a slot index. Each field
/// is added only when its key exists with the type the game's own reader expects, so a stack without
/// user data, or a build that stores a field differently, omits the key instead of reporting an empty
/// one.
fn user_data_fields(entry: &mut Map<String, Value>, compound: usize, depth: usize) {
    if depth > CONTENTS_DEPTH {
        return;
    }
    if let Some(display) = typed(compound, "display", TAG_COMPOUND) {
        if let Some(name) = typed(display, "Name", TAG_STRING).and_then(text_value) {
            entry.insert(String::from("name"), Value::String(name));
        }
        if let Some(lore) = lore(display) {
            entry.insert(String::from("lore"), lore);
        }
    }
    if let Some(enchants) = list(compound, "ench").and_then(enchantments) {
        entry.insert(String::from("enchantments"), enchants);
    }
    let content_list = list(compound, "Items").or_else(|| list(compound, "storage_item_component_content"));
    if let Some(items) = content_list.and_then(|list| contents(list, depth)) {
        entry.insert(String::from("contents"), items);
    }
}

/// The id of the dynamic container that holds a bundle's items: its user data's `bundle_id` (an int).
/// The client's copy of a bundle stack carries only this id; the items live in that container, which the
/// client keeps while a screen showing the bundle is open.
pub(crate) fn bundle_id(stack: usize) -> Option<u32> {
    let data = pe::read::<usize>(stack + STACK_USER_DATA).filter(|data| *data != 0)?;
    typed(data, "bundle_id", TAG_INT).and_then(|tag| pe::read::<i32>(tag + TAG_VALUE)).and_then(|id| u32::try_from(id).ok())
}

/// The value tag a compound holds under `key`, with the type id its own accessors compare.
fn tag(compound: usize, key: &str) -> Option<(usize, u8)> {
    let node = node(compound, key.as_bytes())?;
    let value = node + NODE_VALUE;
    let kind = pe::read::<u8>(value + TAG_TYPE)?;
    Some((value, kind))
}

/// The tag under `key` when it is of type `kind`.
fn typed(compound: usize, key: &str, kind: u8) -> Option<usize> {
    tag(compound, key).and_then(|(value, got)| (got == kind).then_some(value))
}

/// The list tag under `key`.
fn list(compound: usize, key: &str) -> Option<usize> {
    typed(compound, key, TAG_LIST)
}

/// The node holding `key`, walked the way the game's own accessors walk their tree.
fn node(compound: usize, key: &[u8]) -> Option<usize> {
    let head = pe::read::<usize>(compound + COMPOUND_HEAD)?;
    if head == 0 || !pe::readable(head, NODE_PARENT + 8) {
        return None;
    }
    let mut node = pe::read::<usize>(head + NODE_PARENT)?;
    for _ in 0..TREE_DEPTH {
        if node == 0 || !pe::readable(node, NODE_SIZE) {
            return None;
        }
        if pe::read::<u8>(node + NODE_NIL)? != 0 {
            return None;
        }
        match key_order(node, key)? {
            core::cmp::Ordering::Equal => return Some(node),
            core::cmp::Ordering::Less => node = pe::read::<usize>(node + NODE_RIGHT)?,
            core::cmp::Ordering::Greater => node = pe::read::<usize>(node + NODE_LEFT)?,
        }
    }
    None
}

/// The node's key against `key`, byte for byte.
fn key_order(node: usize, key: &[u8]) -> Option<core::cmp::Ordering> {
    let size = pe::read::<usize>(node + NODE_KEY + 0x10)?;
    let capacity = pe::read::<usize>(node + NODE_KEY + 0x18)?;
    if size > 0x400 {
        return None;
    }
    let buffer = if capacity < 16 { node + NODE_KEY } else { pe::read::<usize>(node + NODE_KEY)? };
    let bytes = pe::bytes(buffer, size)?;
    Some(bytes.cmp(key))
}

/// A list tag's elements: `Tag*` pointers the game walks as a vector.
fn elements(list: usize) -> Option<Vec<usize>> {
    let begin = pe::read::<usize>(list + LIST_BEGIN)?;
    let end = pe::read::<usize>(list + LIST_END)?;
    if begin == 0 || end < begin || (end - begin) % 8 != 0 {
        return None;
    }
    let count = (end - begin) / 8;
    if count > LIST_LIMIT {
        return None;
    }
    let mut out = Vec::with_capacity(count);
    for index in 0..count {
        let element = pe::read::<usize>(begin + index * 8)?;
        if element == 0 || !pe::readable(element, TAG_VALUE + 8) {
            return None;
        }
        out.push(element);
    }
    Some(out)
}

/// `Tag::getId()` of an element: the virtual slot the game calls on every list element (a list element
/// is a pointer to a tag of its own, so its type is asked for the way the game asks).
fn element_type(element: usize) -> Option<u8> {
    let entry = interface_slot(element, TAG_GET_ID)?;
    // SAFETY: the slot is the game's own `Tag::getId()`, called on the element with no other argument.
    let kind = unsafe { transmute::<usize, unsafe extern "C" fn(usize) -> u8>(entry)(element) };
    (1..=12).contains(&kind).then_some(kind)
}

/// A string tag's value: the `std::string` at `tag + 0x08`.
fn text_value(tag: usize) -> Option<String> {
    let text = pe::std_string(tag + TAG_VALUE)?;
    (!text.is_empty() && text.len() <= 1024).then_some(text)
}

/// The `ench` list as the wire spells it, or `None` when any element is not the compound the game's
/// own walker requires (a list that cannot be read in full is not reported as a shorter one).
fn enchantments(list: usize) -> Option<Value> {
    let elements = elements(list)?;
    let mut out = Vec::with_capacity(elements.len());
    for element in elements {
        if element_type(element)? != TAG_COMPOUND {
            return None;
        }
        let id = typed(element, "id", TAG_SHORT).and_then(|tag| pe::read::<i16>(tag + TAG_VALUE))?;
        let level = typed(element, "lvl", TAG_SHORT).and_then(|tag| pe::read::<i16>(tag + TAG_VALUE))?;
        out.push(json!({ "id": id, "level": level }));
    }
    Some(Value::Array(out))
}

/// The `display.Lore` list as the wire spells it, or `None` when a line is not the string the format
/// requires.
fn lore(display: usize) -> Option<Value> {
    let elements = elements(list(display, "Lore")?)?;
    let mut out = Vec::with_capacity(elements.len());
    for element in elements {
        if element_type(element)? != TAG_STRING {
            return None;
        }
        out.push(Value::String(text_value(element)?));
    }
    Some(Value::Array(out))
}

/// A container-shaped content list: the items at their `Slot`, null where a slot is empty.
fn contents(list: usize, depth: usize) -> Option<Value> {
    let elements = elements(list)?;
    let mut placed: Vec<(usize, Value)> = Vec::new();
    let mut unplaced: Vec<Value> = Vec::new();
    for element in &elements {
        let element = *element;
        if element_type(element) != Some(TAG_COMPOUND) {
            return None;
        }
        let item = compound_slot(element, depth + 1)?;
        match typed(element, "Slot", TAG_BYTE).and_then(|tag| pe::read::<u8>(tag + TAG_VALUE)) {
            Some(index) => placed.push((index as usize, item)),
            None => unplaced.push(item),
        }
    }
    // An empty list is a truthful "nothing inside"; a list whose entries do not parse is not, and is
    // omitted rather than reported as empty.
    if elements.is_empty() {
        return Some(Value::Array(Vec::new()));
    }
    if placed.is_empty() {
        return Some(Value::Array(unplaced));
    }
    let size = placed.iter().map(|(index, _)| index + 1).max().unwrap_or(0);
    if size > CONTAINER_LIMIT {
        return None;
    }
    let mut out = Vec::new();
    out.resize(size, Value::Null);
    for (index, item) in placed {
        out[index] = item;
    }
    Some(Value::Array(out))
}

/// One item compound (an item inside a shulker or a bundle) as a slot.
fn compound_slot(compound: usize, depth: usize) -> Option<Value> {
    let item = typed(compound, "Name", TAG_STRING).and_then(text_value)?;
    let count = typed(compound, "Count", TAG_BYTE)
        .and_then(|tag| pe::read::<u8>(tag + TAG_VALUE))
        .unwrap_or(1);
    if count == 0 || count > 127 {
        return None;
    }
    let damage = typed(compound, "Damage", TAG_SHORT)
        .and_then(|tag| pe::read::<i16>(tag + TAG_VALUE))
        .unwrap_or(0)
        .max(0) as u16;
    let mut entry = Map::new();
    entry.insert(String::from("item"), Value::String(item));
    entry.insert(String::from("count"), Value::from(count));
    entry.insert(String::from("data"), Value::from(damage));
    if let Some(nested) = typed(compound, "tag", TAG_COMPOUND) {
        user_data_fields(&mut entry, nested, depth);
    }
    Some(Value::Object(entry))
}

/// `Item + ITEM_IDENTIFIER` is the item's raw name id (`stone`): the string the game builds the
/// description id from (`tile.` + it). The namespaced identifier is the `std::string` field of the same
/// `Item` that reads `<namespace>:<raw name>`; its offset is found once by that content and kept.
static FULL_NAME_AT: AtomicUsize = AtomicUsize::new(0);
/// How far into an `Item` the namespaced identifier is looked for.
const ITEM_SCAN: usize = 0x200;

/// The item's identifier (`minecraft:stone`), read in place from the `Item` (`impl[0]`).
///
/// It is read rather than built by the game's own description-id function, which allocates through the
/// game's allocator. The namespaced field is believed only when it ends in `:` + the raw name id, so a
/// wrong offset answers null, never another string.
fn identifier(impl_pointer: usize) -> Option<String> {
    item_identifier(pe::read::<usize>(impl_pointer).filter(|item| *item != 0)?)
}

/// The identifier of an `Item*` (see [`identifier`]).
pub(crate) fn item_identifier(item: usize) -> Option<String> {
    if item == 0 {
        return None;
    }
    let raw = pe::std_string(item + ITEM_IDENTIFIER)
        .filter(|text| (1..=64).contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_graphic()))?;
    if raw.contains(':') {
        return Some(raw);
    }
    let full = |offset: usize| -> Option<String> {
        let text = pe::std_string(item + offset)?;
        let (namespace, name) = text.split_once(':')?;
        (!namespace.is_empty() && name == raw && text.len() <= 96 && text.bytes().all(|byte| byte.is_ascii_graphic())).then_some(text)
    };
    let known = FULL_NAME_AT.load(Ordering::Acquire);
    if known != 0 {
        if let Some(text) = full(known) {
            return Some(text);
        }
    }
    for offset in (0..ITEM_SCAN).step_by(8).filter(|offset| *offset != ITEM_IDENTIFIER) {
        if let Some(text) = full(offset) {
            FULL_NAME_AT.store(offset, Ordering::Release);
            return Some(text);
        }
    }
    None
}

/// A slot list of `count` entries, null where the stack could not be read.
///
/// The table entry is resolved once for the whole list: one container, one `getItem`.
fn slots(container: usize, first: usize, count: usize) -> Vec<Value> {
    let mut out = Vec::with_capacity(count);
    let Some(entry) = interface_slot(container, CONTAINER_GET_ITEM) else {
        out.resize(count, Value::Null);
        return out;
    };
    for slot_index in first..first + count {
        out.push(item_at(entry, container, slot_index).and_then(slot).unwrap_or(Value::Null));
    }
    out
}

/* ------------------------------------------------------------------------------------------------
 * player.inventory
 * ---------------------------------------------------------------------------------------------- */

/// `player.inventory` → `{selectedSlot, hotbar, inventory, armor, offhand, cursor}`.
///
/// The hotbar (`0..8`) and the main inventory (`9..35`) come from the player's own container through
/// the game's `getContainerSize`/`getItem`; the armour from the `Equipment` container the
/// `ActorEquipmentComponent` points at.
///
/// The offhand and the cursor stack stay null. The offhand is not a second pointer on the inventory
/// object — every read of it goes through the same container at `+0xb8` — and the game's equipment
/// reads use slots `4` and `5` of the `Equipment` container without a proven mapping to "offhand".
/// The cursor stack is not on the inventory object either: it is tracked by the item-stack net
/// manager next to the container model, neither of which is located on this build.
pub(crate) fn h_inventory(_core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    world()?;
    let (accessor, entity) = context().ok_or_else(|| RpcError::anchor("inventory.context"))?;
    let player = player(accessor, entity).ok_or_else(|| RpcError::anchor("inventory.actor"))?;
    inventory(player, accessor, entity)
}

fn inventory(player: usize, accessor: usize, entity: u32) -> Result<Value, RpcError> {
    let inventory = pe::read::<usize>(player + PLAYER_INVENTORY).ok_or_else(|| RpcError::anchor("inventory.slots"))?;
    let selected = pe::read::<u32>(inventory + PLAYER_INVENTORY_SELECTED)
        .filter(|value| *value < 9)
        .ok_or_else(|| RpcError::anchor("inventory.slots"))?;
    // The hotbar and the main inventory are one container: 0..8 is the hotbar, 9..35 the rest.
    let container = pe::read::<usize>(inventory + PLAYER_INVENTORY_CONTAINER);
    let sized = container.and_then(|container| container_size(container).map(|size| (container, size)));
    let (hotbar, main) = match sized {
        Some((container, size)) if size >= HOTBAR_SLOTS => {
            let rest = size.min(HOTBAR_SLOTS + MAIN_SLOTS) - HOTBAR_SLOTS;
            (Value::Array(carried(container, 0, HOTBAR_SLOTS)), Value::Array(carried(container, HOTBAR_SLOTS, rest)))
        }
        _ => {
            note_once(&SLOTS_LOGGED, "inventory: the player's item container is not readable as a Container");
            (Value::Null, Value::Null)
        }
    };

    let (hand, armor_container) = equipment(accessor, entity);
    let armor = match armor_container {
        Some(armor) => {
            let mut parts = Map::new();
            for (index, part) in ARMOR_PARTS.iter().enumerate() {
                parts.insert(String::from(*part), container_item(armor, index).and_then(slot).unwrap_or(Value::Null));
            }
            Value::Object(parts)
        }
        None => {
            note_once(&ARMOR_LOGGED, "inventory: the player's armour container is not readable");
            Value::Null
        }
    };
    // The off hand is slot 1 of the hand container, believed only when that container has exactly the
    // two hand slots.
    let offhand = hand
        .filter(|hand| container_size(*hand) == Some(2))
        .and_then(|hand| container_item(hand, HAND_OFFHAND))
        .and_then(slot)
        .unwrap_or(Value::Null);

    Ok(json!({
        "selectedSlot": selected,
        "hotbar": hotbar,
        "inventory": main,
        "armor": armor,
        "offhand": offhand,
        "cursor": Value::Null,
    }))
}

/// [`slots`] of the player's own container, with a bundle's `contents` added the way the screen tools add
/// them (from its dynamic container, while an open screen has it), so a slot has one shape everywhere.
fn carried(container: usize, first: usize, count: usize) -> Vec<Value> {
    let mut out = slots(container, first, count);
    let Some(entry) = interface_slot(container, CONTAINER_GET_ITEM) else {
        return out;
    };
    for (index, value) in out.iter_mut().enumerate() {
        let Value::Object(fields) = value else {
            continue;
        };
        if fields.contains_key("contents") {
            continue;
        }
        if let Some(contents) = item_at(entry, container, first + index).and_then(crate::workstation::bundle_contents) {
            fields.insert(String::from("contents"), contents);
        }
    }
    out
}

/// The hotbar's width: slots `0..8` of the player's container.
const HOTBAR_SLOTS: usize = 9;
/// The main inventory's width: slots `9..35`.
const MAIN_SLOTS: usize = 27;

/// The hand and the armour containers behind the player's `ActorEquipmentComponent` (two pointers in the
/// element), each believed only when it answers the `Container` interface and has the size its role needs.
fn equipment(accessor: usize, entity: u32) -> (Option<usize>, Option<usize>) {
    let Some(element) = ecs::storage(accessor, anchors::component_hash("ActorEquipmentComponent"))
        .and_then(|storage| ecs::element(storage, entity, EQUIPMENT_STRIDE))
    else {
        return (None, None);
    };
    let container = |at: usize, sizes: core::ops::RangeInclusive<usize>| {
        pe::read::<usize>(element + at)
            .filter(|object| *object != 0 && interface_slot(*object, CONTAINER_GET_ITEM).is_some())
            .filter(|object| container_size(*object).is_some_and(|size| sizes.contains(&size)))
    };
    (container(EQUIPMENT_HAND, 1..=2), container(EQUIPMENT_ARMOR, 4..=5))
}

static SLOTS_LOGGED: AtomicUsize = AtomicUsize::new(0);
static ARMOR_LOGGED: AtomicUsize = AtomicUsize::new(0);

fn note_once(flag: &AtomicUsize, reason: &str) {
    if flag.swap(1, Ordering::AcqRel) == 0 {
        agent_core::log::fmt(format_args!("{reason}"));
    }
}

/* ------------------------------------------------------------------------------------------------
 * Engine links: the virtual slots and fields the block-container and recipe readers use
 *
 * Each link is read out of one code shape of the game's own (`area-recipes-3` §4/§5), never written
 * down: a shape that is absent or ambiguous leaves its link at 0 and the method that needs it answers
 * `-32001` naming it.
 * ---------------------------------------------------------------------------------------------- */

/// `Level` vtable slot: the player by unique id (`PlayerCommandOrigin::getDimension`).
const L_GET_PLAYER: usize = 0;
/// `Actor` field: the `Dimension*` of the actor's dimension `weak_ptr` (the same function).
const L_ACTOR_DIMENSION: usize = 1;
/// `Level` vtable slot: `getDimension(&WeakRef<Dimension> out, DimensionType)` (three origin classes).
const L_GET_DIMENSION: usize = 2;
/// `BlockSource` vtable slot: the loaded `LevelChunk*` holding a `BlockPos`, or null.
const L_CHUNK_AT: usize = 3;
/// `BlockSource` field: its dimension's minimum height (`i16`).
const L_MIN_HEIGHT: usize = 4;
/// `LevelChunk::getBlockEntity(ChunkBlockPos const&)`, a function.
const L_BLOCK_ENTITY: usize = 5;
/// `BlockActor` vtable slot: its `Container*`, or null.
const L_GET_CONTAINER: usize = 6;
/// `BlockSource` vtable slot: the `Block const&` at a `BlockPos` (`/testforblock`).
const L_GET_BLOCK: usize = 7;
/// `Block` field: its `BlockLegacy*` (every block component getter).
const L_BLOCK_LEGACY: usize = 8;
/// `Actor` field: its `Level*` (the crafting controller's constructor).
const L_ACTOR_LEVEL: usize = 9;
/// `Level` vtable slot: `getRecipes()` (the same constructor).
const L_GET_RECIPES: usize = 10;
/// The container source's vtable slot that answers its `Container*` (`this + 0xe8` for a chest).
const L_SOURCE_CONTAINER: usize = 11;
/// `BlockActor` field and its `+N` pointer: the container of a block actor without a container source.
const L_ACTOR_HOLDER: usize = 12;
const L_HOLDER_CONTAINER: usize = 13;
/// `Item` vtable slot: `getComponent(HashedString const&)`; the static key of the durability component, and
/// the component's maximum (`i32`), as `query.max_durability` reads them.
const L_ITEM_COMPONENT: usize = 14;
const L_DURABILITY_KEY: usize = 15;
const L_DURABILITY_MAX: usize = 16;
const LINK_COUNT: usize = 17;

static LINKS: [AtomicUsize; LINK_COUNT] = [const { AtomicUsize::new(0) }; LINK_COUNT];

const LINK_NAMES: [&str; LINK_COUNT] = [
    "container.level_player",
    "container.actor_dimension",
    "container.level_dimension",
    "container.chunk_at",
    "container.min_height",
    "container.block_actor",
    "container.get_container",
    "container.get_block",
    "container.block_legacy",
    "craft.actor_level",
    "craft.recipe",
    "container.source_container",
    "container.actor_holder",
    "container.holder_container",
    "inventory.item_component",
    "inventory.durability_key",
    "inventory.durability_max",
];

fn link(index: usize) -> Option<usize> {
    match LINKS[index].load(Ordering::Acquire) {
        0 => None,
        value => Some(value),
    }
}

/// `PlayerCommandOrigin::getDimension`: `mov rdx,[rcx+0x18]; mov rcx,[rcx+0x20]; mov rax,[rcx];
/// mov rax,[rax+GET_PLAYER]; call; test; je; mov rcx,rax; mov rdx,[rax+DIM+8]; (lock the weak count);
/// mov rax,[rcx+DIM]`. Unique in `.text`.
const PLAYER_PATTERN: &str = "48 8B 51 18 48 8B 49 20 48 8B 01 48 8B 80 ?? ?? ?? ?? FF 15 ?? ?? ?? ?? 48 85 C0 74 ?? 48 89 C1 48 8B 90 ?? ?? ?? ?? 8B 42 08 44 8D 40 01 F0 44 0F B1 42 08 75 F4 48 8B 81 ?? ?? ?? ??";
/// The dimension-id origins' `getDimension`: `mov r9,[rcx+0x18]; mov r8d,[rcx+ID]; mov rax,[r9];
/// mov rax,[rax+GET_DIMENSION]; lea rdx,[rsp+0x28]; mov rcx,r9; call; mov rcx,[rsp+0x30]; test; je;
/// mov eax,[rcx+8]; xor esi,esi`. Three sites, which must agree.
const DIMENSION_PATTERN: &str =
    "4C 8B 49 18 44 8B 41 ?? 49 8B 01 48 8B 40 ?? 48 8D 54 24 28 4C 89 C9 FF 15 ?? ?? ?? ?? 48 8B 4C 24 30 48 85 C9 74 ?? 8B 41 08 31 F6";
/// A command's block-container lookup: `mov rax,[rax+CHUNK_AT]; call; test; jz; (ChunkBlockPos from the
/// BlockPos, y - [rdi+MIN_HEIGHT]); call BLOCK_ENTITY; test; je; mov rcx,[rax]; mov rdx,[rcx+CONTAINER];
/// …; call`. Unique in `.text`.
const BLOCK_ACTOR_PATTERN: &str = "48 8B 80 ?? ?? ?? ?? FF 15 ?? ?? ?? ?? 48 85 C0 0F 84 ?? ?? ?? ?? 0F B6 4E 08 80 E1 0F 0F B7 56 04 66 2B 57 ?? 44 0F B6 06 41 80 E0 0F 44 88 44 24 2C 88 4C 24 2D 66 89 54 24 2E 48 8D 54 24 2C 48 89 C1 E8 ?? ?? ?? ?? 48 85 C0 74 ?? 48 8B 08 48 8B 91 ?? ?? ?? ?? 48 89 C1 48 89 D0 FF 15";
/// `/testforblock`: the region from its chunk-checked handle, then `mov r8,[rcx+GET_BLOCK]` on it with
/// the position. Unique in `.text`.
const GET_BLOCK_PATTERN: &str =
    "48 8B 03 48 8B 48 28 48 8B 01 48 8B 40 68 FF 15 ?? ?? ?? ?? 90 48 8B 08 4C 8B 41 ?? 48 8D 95 ?? ?? ?? ?? 48 89 C1 4C 89 C0 FF 15";
/// Every block component getter's prologue, ending in `mov rcx,[rsi+LEGACY]; add rcx,0x30` (the
/// component map of the `BlockLegacy`). Two dozen sites, which must agree.
const LEGACY_PATTERN: &str = "56 57 48 83 EC 28 48 89 CE 48 83 C1 08 8B 05 ?? ?? ?? ?? 8B 15 ?? ?? ?? ?? 65 4C 8B 04 25 58 00 00 00 49 8B 14 D0 3B 82 04 00 00 00 7F 75 0F B7 05 ?? ?? ?? ?? 66 89 44 24 24 48 8D 54 24 24 E8 ?? ?? ?? ?? 48 85 C0 74 06 48 83 C0 08 EB 4D 48 8B 4E ?? 48 83 C1 30";
/// The crafting controller's constructor: `mov rax,[rax+0x30] (Player); mov rcx,[rax+LEVEL];
/// mov rax,[rcx]; mov rax,[rax+GET_RECIPES]; call; nop; mov rcx,[rbp+..]; mov [rcx+0xd0],rax; call`.
/// Unique in `.text`.
const RECIPES_PATTERN: &str = "48 8B 40 30 48 8B 88 ?? ?? ?? ?? 48 8B 01 48 8B 80 ?? ?? ?? ?? FF 15 ?? ?? ?? ?? 90 48 8B 8D ?? ?? ?? ?? 48 89 81 ?? ?? ?? ?? E8";
/// A command's container fetch: `mov rax,[rax+GET_CONTAINER]; mov rcx,rdi; call; test; je; mov rcx,[rax];
/// mov rdx,[rcx+SOURCE_CONTAINER]; …; call; test; jne; jmp; mov rax,[rdi+HOLDER]; test; je; mov rax,[rax+N]`:
/// the block actor's container source, its `Container*`, and the holder the game falls back to. Unique.
const CONTAINER_PATTERN: &str = "48 8B 80 ?? ?? ?? ?? 48 89 F9 FF 15 ?? ?? ?? ?? 48 85 C0 74 ?? 48 8B 08 48 8B 51 ?? 48 89 C1 48 89 D0 FF 15 ?? ?? ?? ?? 48 85 C0 75 ?? EB ?? 48 8B 47 ?? 48 85 C0 74 ?? 48 8B 40 ??";
/// `query.max_durability`: `mov rax,[rsi]; mov rax,[rax+GET_COMPONENT]; lea rdx,[rip+KEY]; mov rcx,rsi; call;
/// mov rcx,rax; test; mov rax,rbx; jz; cvtsi2ss xmm0,[rcx+MAX]`. Unique.
const DURABILITY_PATTERN: &str =
    "48 8B 06 48 8B 80 ?? ?? ?? ?? 48 8D 15 ?? ?? ?? ?? 48 89 F1 FF 15 ?? ?? ?? ?? 48 89 C1 48 85 C0 48 89 D8 0F 84 ?? ?? ?? ?? F3 0F 2A 41 ??";

/// `"41 C6 ?? 08"` → wildcard bytes.
fn pattern(text: &str) -> Vec<Option<u8>> {
    text.split_ascii_whitespace().map(|token| if token == "??" { None } else { u8::from_str_radix(token, 16).ok() }).collect()
}

/// Every place each pattern occurs in `.text` (at most 64), in one pass.
pub(crate) fn all_sites(image: &Image, patterns: &[Vec<Option<u8>>]) -> Vec<Vec<usize>> {
    let mut found: Vec<Vec<usize>> = patterns.iter().map(|_| Vec::new()).collect();
    let Some(code) = pe::code(image) else {
        return found;
    };
    let mut prefixes = alloc::vec![false; 0x1_0000];
    for pattern in patterns {
        if let (Some(Some(a)), Some(Some(b))) = (pattern.first(), pattern.get(1)) {
            prefixes[*a as usize | (*b as usize) << 8] = true;
        }
    }
    let bytes = code.bytes;
    for at in 0..bytes.len().saturating_sub(1) {
        if !prefixes[bytes[at] as usize | (bytes[at + 1] as usize) << 8] {
            continue;
        }
        for (index, pattern) in patterns.iter().enumerate() {
            if at + pattern.len() > bytes.len() || found[index].len() >= 64 {
                continue;
            }
            if bytes[at..at + pattern.len()].iter().zip(pattern).all(|(byte, want)| want.is_none_or(|want| want == *byte)) {
                found[index].push(code.va + at);
            }
        }
    }
    found
}

/// A vtable slot or field offset read at `site + at` (`u8` or `u32` wide), believed when it is a small,
/// 8-aligned offset (`aligned`) or any small offset.
fn offset_at(site: usize, at: usize, wide: bool, aligned: bool) -> Option<usize> {
    let value = if wide { pe::read::<u32>(site + at)? as usize } else { pe::read::<u8>(site + at)? as usize };
    (value != 0 && value < 0x4000 && (!aligned || value % 8 == 0)).then_some(value)
}

/// The one value every site agrees on.
fn agreed(sites: &[usize], read: impl Fn(usize) -> Option<usize>) -> Option<usize> {
    let mut value = None;
    for site in sites {
        let here = read(*site)?;
        if value.is_some_and(|known| known != here) {
            return None;
        }
        value = Some(here);
    }
    value
}

/// Resolves every link in one pass over `.text`.
fn resolve_links(image: &Image) {
    let texts = [
        PLAYER_PATTERN,
        DIMENSION_PATTERN,
        BLOCK_ACTOR_PATTERN,
        GET_BLOCK_PATTERN,
        LEGACY_PATTERN,
        RECIPES_PATTERN,
        CONTAINER_PATTERN,
        DURABILITY_PATTERN,
    ];
    let patterns: Vec<Vec<Option<u8>>> = texts.iter().map(|text| pattern(text)).collect();
    let sites = all_sites(image, &patterns);
    let unique = |index: usize| (sites[index].len() == 1).then(|| sites[index][0]);
    let store = |index: usize, value: Option<usize>| {
        if let Some(value) = value {
            LINKS[index].store(value, Ordering::Release);
        }
    };
    if let Some(site) = unique(0) {
        let dimension = offset_at(site, 57, true, true);
        let control = offset_at(site, 35, true, true);
        if dimension.is_some() && control == dimension.map(|value| value + 8) {
            store(L_GET_PLAYER, offset_at(site, 14, true, true));
            store(L_ACTOR_DIMENSION, dimension);
        }
    }
    if !sites[1].is_empty() {
        store(L_GET_DIMENSION, agreed(&sites[1], |site| offset_at(site, 14, false, true)));
    }
    if let Some(site) = unique(2) {
        let rel = pe::read::<i32>(site + 68).map(|rel| (site + 72).wrapping_add_signed(rel as isize));
        let function = rel.filter(|target| image.function_start(*target) == Some(*target));
        if function.is_some() {
            store(L_CHUNK_AT, offset_at(site, 3, true, true));
            store(L_MIN_HEIGHT, offset_at(site, 36, false, false));
            store(L_BLOCK_ENTITY, function);
            store(L_GET_CONTAINER, offset_at(site, 83, true, true));
        }
    }
    if let Some(site) = unique(3) {
        store(L_GET_BLOCK, offset_at(site, 27, false, true));
    }
    if !sites[4].is_empty() {
        let at = patterns[4].len() - 5;
        store(L_BLOCK_LEGACY, agreed(&sites[4], |site| offset_at(site, at, false, true)));
    }
    if let Some(site) = unique(5) {
        store(L_ACTOR_LEVEL, offset_at(site, 7, true, true));
        store(L_GET_RECIPES, offset_at(site, 17, true, true));
    }
    if let Some(site) = unique(6) {
        // The same block-actor slot as the block-actor shape, or neither is believed.
        if offset_at(site, 3, true, true) == link(L_GET_CONTAINER) {
            store(L_SOURCE_CONTAINER, offset_at(site, 27, false, true));
            store(L_ACTOR_HOLDER, offset_at(site, 50, false, true));
            store(L_HOLDER_CONTAINER, offset_at(site, 59, false, true));
        }
    }
    if let Some(site) = unique(7) {
        let key = pe::read::<i32>(site + 13).map(|rel| (site + 17).wrapping_add_signed(rel as isize)).filter(|key| pe::in_image_data(*key));
        if key.is_some() {
            store(L_ITEM_COMPONENT, offset_at(site, 6, true, true));
            store(L_DURABILITY_KEY, key);
            store(L_DURABILITY_MAX, offset_at(site, 45, false, false));
        }
    }
    let missing: Vec<&str> = (0..LINK_COUNT).filter(|index| link(*index).is_none()).map(|index| LINK_NAMES[index]).collect();
    agent_core::log::fmt(format_args!("inventory: container and recipe links resolved, missing {missing:?}"));
}

/// Calls a `this`-only virtual of `object` at vtable `slot`, after checking the entry is game code.
fn virtual0(object: usize, slot: usize) -> Option<usize> {
    let entry = interface_slot(object, slot)?;
    // SAFETY: the game's own virtual of this object, which takes `this` only.
    Some(unsafe { transmute::<usize, extern "C" fn(usize) -> usize>(entry)(object) })
}

/// True when `object` starts with a vtable of the game's image.
fn has_game_table(object: usize) -> bool {
    object != 0 && pe::readable(object, 8) && pe::read::<usize>(object).is_some_and(pe::in_image_data)
}

/* ------------------------------------------------------------------------------------------------
 * Containers
 * ---------------------------------------------------------------------------------------------- */

/// `ActorUniqueIDComponent` element: one `i64`.
const UNIQUE_STRIDE: usize = ecs::UNIQUE_STRIDE;
/// An actor's entity context: its registry at `+0x10` and its entity id at `+0x18` (every inlined component
/// read of an actor method, e.g. the region lookup that reads `BlockSourceComponent`).
const ACTOR_REGISTRY: usize = 0x10;
const ACTOR_ENTITY: usize = 0x18;
/// `BlockSourceComponent` element: a `WeakRef<BlockSource>` (`+0x00` the object, `+0x08` its control
/// block, `shl edx,4` at its readers).
const BLOCK_SOURCE_STRIDE: usize = 0x10;
/// A shared control block's use count (`lock cmpxchg [ctrl+8]` before every lock).
const CONTROL_USES: usize = 0x08;
/// A shared control block's weak count, and its "delete the block" slot.
const CONTROL_WEAKS: usize = 0x0C;
const CONTROL_DELETE_BLOCK: usize = 0x08;
/// How far a `BlockSource` is searched for its dimension, and a dimension for its main region.
const SOURCE_SCAN: usize = 0x60;
const DIMENSION_SCAN: usize = 0x800;
/// The dimension ids the game numbers (`VanillaDimensions`).
const DIMENSIONS: [(&str, i32); 3] = [("overworld", 0), ("nether", 1), ("the_end", 2)];

/// `container.get {x, y, z, dimension?}` → `{block, size, slots}`.
///
/// The read runs on the integrated server's thread (the client never holds a closed container's items):
/// the server player is the local player's unique id through the server `Level`, its region is its
/// `BlockSourceComponent` (another dimension's region is the one of the same class that dimension owns),
/// then the game's own chunk lookup, `LevelChunk::getBlockEntity` and `BlockActor::getContainer`. Each
/// object is checked (a game vtable, the actor's level is the server level) before it is called.
pub(crate) fn h_container_get(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let position = block_position(params)?;
    let dimension = match params.get("dimension").and_then(Value::as_str) {
        Some(name) => Value::from(DIMENSIONS.iter().find(|(known, _)| *known == name).map(|(_, id)| *id).unwrap_or(0)),
        None => Value::Null,
    };
    world()?;
    for index in [L_GET_PLAYER, L_ACTOR_DIMENSION, L_CHUNK_AT, L_MIN_HEIGHT, L_BLOCK_ENTITY, L_GET_CONTAINER, L_ACTOR_LEVEL] {
        if link(index).is_none() {
            return Err(RpcError::anchor(LINK_NAMES[index]));
        }
    }
    let (accessor, entity) = context().ok_or_else(|| RpcError::anchor("inventory.context"))?;
    let unique = ecs::storage(accessor, anchors::component_hash("ActorUniqueIDComponent"))
        .and_then(|storage| ecs::element(storage, entity, UNIQUE_STRIDE))
        .and_then(pe::read::<u64>)
        .filter(|id| *id != u64::MAX)
        .ok_or_else(|| RpcError::anchor("inventory.unique_id"))?;
    let request = json!({
        "x": position[0], "y": position[1], "z": position[2],
        "dimension": dimension,
        "unique": format!("{unique}"),
    });
    crate::server::submit(core, crate::server::Request::Call(container_on_server, request))
}

/// The server half of `container.get`, on the server thread.
pub(crate) fn container_on_server(params: &Value) -> Result<Value, RpcError> {
    let missing = |index: usize| RpcError::anchor(LINK_NAMES[index]);
    let coordinate = |key: &str| params.get(key).and_then(Value::as_i64).map(|value| value as i32);
    let (Some(x), Some(y), Some(z)) = (coordinate("x"), coordinate("y"), coordinate("z")) else {
        return Err(RpcError::invalid_params("x, y and z are required"));
    };
    let unique = params
        .get("unique")
        .and_then(Value::as_str)
        .and_then(|text| text.parse::<u64>().ok())
        .ok_or_else(|| RpcError::anchor("inventory.unique_id"))?;
    let level = live::server_level().ok_or_else(|| RpcError::anchor("server.level"))?;
    let get_player = link(L_GET_PLAYER).and_then(|slot| interface_slot(level, slot)).ok_or_else(|| missing(L_GET_PLAYER))?;
    // SAFETY: the server level's own player lookup by unique id (`rdx` = the id by value), as the player
    // command origin calls it.
    let player = unsafe { transmute::<usize, extern "C" fn(usize, u64) -> usize>(get_player)(level, unique) };
    let actor_level = link(L_ACTOR_LEVEL).ok_or_else(|| missing(L_ACTOR_LEVEL))?;
    if !has_game_table(player) || pe::read::<usize>(player + actor_level) != Some(level) {
        return Err(RpcError::anchor("container.player").with_data(json!({
            "message": "the server level has no player with the local player's unique id",
        })));
    }
    let player_dimension = link(L_ACTOR_DIMENSION)
        .and_then(|at| pe::read::<usize>(player + at))
        .filter(|dimension| has_game_table(*dimension))
        .ok_or_else(|| missing(L_ACTOR_DIMENSION))?;
    let source = player_source(player)?;
    let region = match params.get("dimension").and_then(Value::as_i64) {
        None => source,
        Some(id) => {
            let dimension = level_dimension(level, id as i32)?;
            if dimension == player_dimension {
                source
            } else {
                dimension_source(source, player_dimension, dimension)?
            }
        }
    };
    let chunk_at = link(L_CHUNK_AT).and_then(|slot| interface_slot(region, slot)).ok_or_else(|| missing(L_CHUNK_AT))?;
    let position = [x, y, z];
    // SAFETY: the region's own `getChunkAt(BlockPos const&)`; it answers null for a chunk not loaded.
    let chunk = unsafe { transmute::<usize, extern "C" fn(usize, *const [i32; 3]) -> usize>(chunk_at)(region, &position) };
    if chunk == 0 || !pe::readable(chunk, 8) {
        return Err(RpcError::invalid_params(format!("the chunk holding {x} {y} {z} is not loaded")));
    }
    let min = link(L_MIN_HEIGHT).and_then(|at| pe::read::<i16>(region + at)).ok_or_else(|| missing(L_MIN_HEIGHT))?;
    let local: [u8; 4] = {
        let height = (y - min as i32) as u16;
        [(x & 0xF) as u8, (z & 0xF) as u8, height as u8, (height >> 8) as u8]
    };
    let block_entity = link(L_BLOCK_ENTITY).ok_or_else(|| missing(L_BLOCK_ENTITY))?;
    // SAFETY: the game's own `LevelChunk::getBlockEntity(ChunkBlockPos const&)` on the chunk the region
    // just answered, with the chunk-local position the game itself builds (x & 15, z & 15, y - min).
    let actor = unsafe { transmute::<usize, extern "C" fn(usize, *const [u8; 4]) -> usize>(block_entity)(chunk, &local) };
    let block = block_name(region, &position);
    if actor == 0 {
        return Err(no_container(x, y, z, block));
    }
    if !has_game_table(actor) {
        return Err(missing(L_BLOCK_ENTITY));
    }
    // `getContainer` answers the actor's container source (`this + 0x38` on a chest); the source answers the
    // `Container*`. Without a source the game reads the actor's holder instead (`[[actor + 0x30] + 8]`).
    let source = link(L_GET_CONTAINER).and_then(|slot| virtual0(actor, slot)).ok_or_else(|| missing(L_GET_CONTAINER))?;
    let container = if source != 0 {
        if !has_game_table(source) {
            return Err(missing(L_GET_CONTAINER));
        }
        link(L_SOURCE_CONTAINER).and_then(|slot| virtual0(source, slot)).ok_or_else(|| missing(L_SOURCE_CONTAINER))?
    } else {
        let (Some(holder_at), Some(inner_at)) = (link(L_ACTOR_HOLDER), link(L_HOLDER_CONTAINER)) else {
            return Err(missing(L_ACTOR_HOLDER));
        };
        pe::read::<usize>(actor + holder_at)
            .filter(|holder| *holder != 0)
            .and_then(|holder| pe::read::<usize>(holder + inner_at))
            .unwrap_or(0)
    };
    if container == 0 {
        return Err(no_container(x, y, z, block));
    }
    if !has_game_table(container) {
        return Err(missing(L_SOURCE_CONTAINER));
    }
    let size = container_size(container).ok_or_else(|| missing(L_SOURCE_CONTAINER))?;
    Ok(json!({ "block": block, "size": size, "slots": slots(container, 0, size) }))
}

/// The player's region: its `BlockSourceComponent`, read without creating a storage.
fn player_source(player: usize) -> Result<usize, RpcError> {
    let registry = pe::read::<usize>(player + ACTOR_REGISTRY).filter(|registry| *registry != 0);
    let entity = pe::read::<u32>(player + ACTOR_ENTITY);
    let element = registry
        .zip(entity)
        .and_then(|(registry, entity)| {
            crate::workstation::storage_in(registry, anchors::component_hash("BlockSourceComponent"))
                .and_then(|storage| ecs::element(storage, entity, BLOCK_SOURCE_STRIDE))
        })
        .ok_or_else(|| RpcError::anchor("container.block_source"))?;
    let control = pe::read::<usize>(element + 8).unwrap_or(0);
    let alive = control != 0 && pe::read::<u32>(control + CONTROL_USES).is_some_and(|uses| uses > 0);
    let source = pe::read::<usize>(element).filter(|source| alive && has_game_table(*source));
    let callable = source.is_some_and(|source| link(L_CHUNK_AT).and_then(|slot| interface_slot(source, slot)).is_some());
    source.filter(|_| callable).ok_or_else(|| RpcError::anchor("container.block_source"))
}

/// `Level::getDimension(id)`: a `WeakRef<Dimension>` the game fills, released here the way the game
/// releases it (the dimension is owned by the level, so the pointer outlives the reference).
fn level_dimension(level: usize, id: i32) -> Result<usize, RpcError> {
    let entry = link(L_GET_DIMENSION).and_then(|slot| interface_slot(level, slot)).ok_or_else(|| RpcError::anchor(LINK_NAMES[L_GET_DIMENSION]))?;
    let mut out = [0usize; 2];
    // SAFETY: the level's own `getDimension(WeakRef<Dimension>* out, DimensionType)`, with a zeroed out slot.
    unsafe { transmute::<usize, extern "C" fn(usize, *mut usize, i32) -> usize>(entry)(level, out.as_mut_ptr(), id) };
    let [dimension, control] = out;
    let alive = control != 0 && pe::read::<u32>(control + CONTROL_USES).is_some_and(|uses| uses > 0);
    if control != 0 && pe::writable(control + CONTROL_WEAKS, 4) {
        // SAFETY: the reference's own weak count, decremented as the game's `~WeakRef` does; the block is
        // freed through its own slot only when that was the last reference.
        let weaks = unsafe { core::sync::atomic::AtomicU32::from_ptr((control + CONTROL_WEAKS) as *mut u32) };
        let left = weaks.fetch_sub(1, Ordering::AcqRel).wrapping_sub(1);
        if left == 0 {
            if let Some(entry) = interface_slot(control, CONTROL_DELETE_BLOCK) {
                // SAFETY: the control block's own `_Delete_this`, after its last reference went.
                unsafe { transmute::<usize, extern "C" fn(usize)>(entry)(control) };
            }
        }
    }
    if !alive || !has_game_table(dimension) {
        return Err(RpcError::invalid_params(format!("dimension {id} is not loaded")));
    }
    Ok(dimension)
}

/// The main region of `dimension`: the object of the same class as the player's region whose dimension
/// field (found on the player's region, which names the player's dimension) is `dimension`.
fn dimension_source(source: usize, player_dimension: usize, dimension: usize) -> Result<usize, RpcError> {
    let table = pe::read::<usize>(source).unwrap_or(0);
    let back = (0..SOURCE_SCAN)
        .step_by(8)
        .find(|at| pe::read::<usize>(source + at) == Some(player_dimension))
        .ok_or_else(|| RpcError::anchor("container.dimension_source"))?;
    (0..DIMENSION_SCAN)
        .step_by(8)
        .filter_map(|at| pe::read::<usize>(dimension + at))
        .find(|candidate| {
            *candidate != 0
                && pe::readable(*candidate, SOURCE_SCAN)
                && pe::read::<usize>(*candidate) == Some(table)
                && pe::read::<usize>(candidate + back) == Some(dimension)
        })
        .ok_or_else(|| RpcError::anchor("container.dimension_source"))
}

/// The block's identifier: `BlockSource::getBlock(pos)` → `Block + LEGACY` → the legacy's namespaced
/// name, found by content as for items (a `ns:name` string whose `name` is another string of the legacy).
fn block_name(region: usize, position: &[i32; 3]) -> Value {
    block_at(region, position).map(block_identifier).unwrap_or(Value::Null)
}

/// `BlockSource::getBlock(pos)`: the region's `Block` there, one object per block *state*.
fn block_at(region: usize, position: &[i32; 3]) -> Option<usize> {
    let entry = interface_slot(region, link(L_GET_BLOCK)?)?;
    // SAFETY: the region's own `Block const& getBlock(BlockPos const&)`.
    let block = unsafe { transmute::<usize, extern "C" fn(usize, *const [i32; 3]) -> usize>(entry)(region, position) };
    has_game_table(block).then_some(block)
}

/// A `Block`'s identifier, through its legacy.
fn block_identifier(block: usize) -> Value {
    let Some(legacy_at) = link(L_BLOCK_LEGACY) else {
        return Value::Null;
    };
    let legacy = pe::read::<usize>(block + legacy_at).filter(|legacy| has_game_table(*legacy));
    legacy.and_then(legacy_identifier).map(Value::String).unwrap_or(Value::Null)
}

/// The block at `position` in the local player's own region (the client's, on the game's thread): the
/// `Block` object, which is a different object for every block state (a lever's `open_bit`, a button's
/// `button_pressed_bit`), and its identifier. `None` while the region cannot be read.
pub(crate) fn client_block(position: [i32; 3]) -> Option<(usize, Value)> {
    let accessor = crate::input::registry()?;
    let entity = ecs::read(accessor)?.sample.entity;
    let element = ecs::storage(accessor, anchors::component_hash("BlockSourceComponent"))
        .and_then(|storage| ecs::element(storage, entity, BLOCK_SOURCE_STRIDE))?;
    let control = pe::read::<usize>(element + 8).unwrap_or(0);
    let alive = control != 0 && pe::read::<u32>(control + CONTROL_USES).is_some_and(|uses| uses > 0);
    let region = pe::read::<usize>(element).filter(|region| alive && has_game_table(*region))?;
    let block = block_at(region, &position)?;
    Some((block, block_identifier(block)))
}

/// The namespaced name field of a `BlockLegacy`, by offset once found.
static BLOCK_NAME_AT: AtomicUsize = AtomicUsize::new(0);
const BLOCK_SCAN: usize = 0x400;

fn legacy_identifier(legacy: usize) -> Option<String> {
    let token = |text: &str| (1..=96).contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_graphic());
    let full_at = |offset: usize| -> Option<String> {
        let text = pe::std_string(legacy + offset).filter(|text| token(text))?;
        let (namespace, name) = text.split_once(':')?;
        if namespace.is_empty() || name.is_empty() || name.contains(':') {
            return None;
        }
        let raw = (0..BLOCK_SCAN).step_by(8).filter(|at| *at != offset).any(|at| pe::std_string(legacy + at).is_some_and(|other| other == name));
        raw.then_some(text)
    };
    let known = BLOCK_NAME_AT.load(Ordering::Acquire);
    if known != 0 {
        if let Some(text) = full_at(known) {
            return Some(text);
        }
    }
    for offset in (0..BLOCK_SCAN).step_by(8) {
        if let Some(text) = full_at(offset) {
            BLOCK_NAME_AT.store(offset, Ordering::Release);
            return Some(text);
        }
    }
    None
}

/// The shape of a `{x, y, z, dimension?}` block position: three block coordinates (floored) and a known
/// dimension name, when one is given.
fn block_position(params: &Value) -> Result<[i64; 3], RpcError> {
    let mut out = [0i64; 3];
    for (index, key) in ["x", "y", "z"].into_iter().enumerate() {
        let value = params
            .get(key)
            .ok_or_else(|| RpcError::invalid_params(format!("{key} is required")))?
            .as_f64()
            .ok_or_else(|| RpcError::invalid_params(format!("{key} must be a number")))?;
        if !value.is_finite() || value.abs() >= 30_000_000.0 {
            return Err(RpcError::invalid_params(format!("{key} must be a finite block coordinate")));
        }
        let whole = value as i64;
        out[index] = if (whole as f64) > value { whole - 1 } else { whole };
    }
    if let Some(dimension) = params.get("dimension") {
        let name = dimension
            .as_str()
            .ok_or_else(|| RpcError::invalid_params("dimension must be a string"))?;
        if !DIMENSIONS.iter().any(|(known, _)| *known == name) {
            return Err(RpcError::invalid_params("dimension must be overworld, nether or the_end"));
        }
    }
    Ok(out)
}

/* ------------------------------------------------------------------------------------------------
 * Recipes: the client's own registry, read in place
 *
 * `Level::getRecipes()` (what the crafting controller keeps at `+0xd0`) holds every recipe the server
 * sent in an `unordered_map<RecipeNetId, Recipe*>`: list head `+0x40`, size `+0x48`, a node `{next, prev,
 * u32 net id +0x10, Recipe* +0x18}` (`Recipes::_addRecipe`, which checks the net id `Recipe+0x44` against
 * it). Every node is believed only when its key is its recipe's own net id.
 *
 * `Recipe`: `+0x08` id (`std::string`), `+0x38`/`+0x3c` width/height, `+0x44` net id, `+0x48` the
 * ingredient vector (`ItemDescriptorCount`, `0x18` each: `+0x08` the descriptor impl, `+0x10` u16 count),
 * `+0xd0` the tag (`HashedString`, string `+0xd8`); vtable `+0x20` is "shapeless" and `+0x40` the
 * result vector (`ItemInstance`, `0x80` each) — both read from the slot's own code (`mov al,1|xor eax,eax;
 * ret`, `lea rax,[rcx+N]; ret`), never called. A descriptor impl's type is its vtable `+0x60`
 * (`mov al,N; ret`): 1 an item (`+0x08` `Item*`, `+0x10` aux), 3 a tag (`std::string +0x10`), 4 deferred
 * (`std::string +0x08`, the item name).
 * ---------------------------------------------------------------------------------------------- */

const RECIPES_HEAD: usize = 0x40;
const RECIPES_SIZE: usize = 0x48;
const RECIPE_NODE_NET_ID: usize = 0x10;
const RECIPE_NODE_RECIPE: usize = 0x18;
const RECIPE_LIMIT: usize = 20_000;
const RECIPE_ID: usize = 0x08;
const RECIPE_WIDTH: usize = 0x38;
const RECIPE_HEIGHT: usize = 0x3C;
const RECIPE_NET_ID: usize = 0x44;
const RECIPE_INGREDIENTS: usize = 0x48;
const RECIPE_TAG: usize = 0xD8;
const RECIPE_SHAPELESS_SLOT: usize = 0x20;
const RECIPE_RESULTS_SLOT: usize = 0x40;
const INGREDIENT_STRIDE: usize = 0x18;
const INGREDIENT_IMPL: usize = 0x08;
const INGREDIENT_COUNT: usize = 0x10;
const DESCRIPTOR_TYPE_SLOT: usize = 0x60;
const DESCRIPTOR_ITEM: usize = 0x08;
const DESCRIPTOR_TAG: usize = 0x10;
const DESCRIPTOR_NAME: usize = 0x08;
const RESULT_STRIDE: usize = 0x80;
/// `Item + 0x1f8`: the item's tags, a vector of `HashedString` (`0x30` each, the string at `+0x08`), as
/// the crafting preview's tag test walks it.
const ITEM_TAGS: usize = 0x1F8;
const ITEM_TAG_STRIDE: usize = 0x30;
const ITEM_TAG_NAME: usize = 0x08;
/// The recipe tag of the crafting table and the inventory grid.
pub(crate) const CRAFTING_TAG: &str = "crafting_table";

/// What one ingredient slot accepts.
#[derive(Clone)]
pub(crate) enum Ingredient {
    Empty,
    /// One item (`Item*`).
    Item(usize),
    /// An item by name (a deferred descriptor).
    Name(String),
    /// Every item carrying a tag.
    Tag(String),
    /// A descriptor kind this reader does not decode (molang, alias): the recipe cannot be matched.
    Unknown,
}

/// One recipe as the client holds it.
pub(crate) struct Recipe {
    pub id: String,
    pub tag: String,
    pub net_id: u32,
    pub shapeless: bool,
    pub width: usize,
    pub height: usize,
    /// Each slot's ingredient and how many it takes per craft.
    pub ingredients: Vec<(Ingredient, u16)>,
    /// `ItemInstance` addresses of the results.
    pub results: Vec<usize>,
}

impl Recipe {
    /// The ingredients that take an item (shaped recipes keep empty cells).
    pub fn needed(&self) -> impl Iterator<Item = &(Ingredient, u16)> {
        self.ingredients.iter().filter(|(ingredient, _)| !matches!(ingredient, Ingredient::Empty))
    }

    /// True when the recipe fits the inventory's 2x2 grid.
    pub fn fits_small(&self) -> bool {
        if self.shapeless {
            self.needed().count() <= 4
        } else {
            self.width <= 2 && self.height <= 2
        }
    }

    /// The recipe's result as the wire spells a slot.
    pub fn result(&self) -> Value {
        self.results.first().copied().and_then(slot).unwrap_or(Value::Null)
    }

    /// The first result's identifier.
    pub fn result_id(&self) -> Option<String> {
        self.result().get("item").and_then(Value::as_str).map(String::from)
    }

    pub fn describe(&self) -> Value {
        json!({
            "id": self.id,
            "type": if self.shapeless { "shapeless" } else { "shaped" },
            "tag": self.tag,
            "netId": self.net_id,
        })
    }
}

/// `true`/`false` for a `this`-only bool function whose whole body is a constant, else `None`.
fn constant_bool(function: usize) -> Option<bool> {
    match pe::bytes(function, 3)? {
        [0xB0, 0x01, 0xC3] => Some(true),
        [0x32 | 0x31 | 0x33, 0xC0, 0xC3] => Some(false),
        _ => None,
    }
}

/// The `N` of a `mov al,N; ret` body.
fn constant_byte(function: usize) -> Option<u8> {
    match pe::bytes(function, 3)? {
        [0xB0, value, 0xC3] => Some(*value),
        _ => None,
    }
}

/// The `N` of a `lea rax,[rcx+N]; ret` body (disp8 or disp32).
fn member_getter(function: usize) -> Option<usize> {
    let bytes = pe::bytes(function, 8)?;
    match bytes {
        [0x48, 0x8D, 0x41, disp, 0xC3, ..] => Some(*disp as usize),
        [0x48, 0x8D, 0x81, a, b, c, d, 0xC3] => Some(u32::from_le_bytes([*a, *b, *c, *d]) as usize),
        _ => None,
    }
}

fn table_entry(object: usize, slot: usize) -> Option<usize> {
    interface_slot(object, slot)
}

fn ingredient(element: usize) -> (Ingredient, u16) {
    let count = pe::read::<u16>(element + INGREDIENT_COUNT).unwrap_or(1).max(1);
    let Some(descriptor) = pe::read::<usize>(element + INGREDIENT_IMPL) else {
        return (Ingredient::Unknown, count);
    };
    if descriptor == 0 {
        return (Ingredient::Empty, count);
    }
    let kind = table_entry(descriptor, DESCRIPTOR_TYPE_SLOT).and_then(constant_byte);
    let decoded = match kind {
        Some(0) => Ingredient::Empty,
        Some(1) => match pe::read::<usize>(descriptor + DESCRIPTOR_ITEM) {
            Some(0) => Ingredient::Empty,
            Some(item) if item_identifier(item).is_some() => Ingredient::Item(item),
            _ => Ingredient::Unknown,
        },
        Some(3) => pe::std_string(descriptor + DESCRIPTOR_TAG).filter(|tag| !tag.is_empty()).map(Ingredient::Tag).unwrap_or(Ingredient::Unknown),
        Some(4) => pe::std_string(descriptor + DESCRIPTOR_NAME).filter(|name| !name.is_empty()).map(|name| Ingredient::Name(namespaced(&name))).unwrap_or(Ingredient::Unknown),
        _ => Ingredient::Unknown,
    };
    (decoded, count)
}

/// One registry entry, or `None` when any part does not read as a recipe.
fn recipe(address: usize, net_id: u32) -> Option<Recipe> {
    if !has_game_table(address) || pe::read::<u32>(address + RECIPE_NET_ID) != Some(net_id) {
        return None;
    }
    let shapeless = table_entry(address, RECIPE_SHAPELESS_SLOT).and_then(constant_bool)?;
    let results_at = table_entry(address, RECIPE_RESULTS_SLOT).and_then(member_getter)?;
    let id = pe::std_string(address + RECIPE_ID).filter(|id| !id.is_empty() && id.len() <= 128)?;
    let tag = pe::std_string(address + RECIPE_TAG).unwrap_or_default();
    let width = pe::read::<i32>(address + RECIPE_WIDTH).filter(|value| (0..=3).contains(value))? as usize;
    let height = pe::read::<i32>(address + RECIPE_HEIGHT).filter(|value| (0..=3).contains(value))? as usize;
    let begin = pe::read::<usize>(address + RECIPE_INGREDIENTS)?;
    let end = pe::read::<usize>(address + RECIPE_INGREDIENTS + 8)?;
    if end < begin || (end - begin) % INGREDIENT_STRIDE != 0 || (end - begin) / INGREDIENT_STRIDE > 9 {
        return None;
    }
    let ingredients: Vec<(Ingredient, u16)> = (begin..end).step_by(INGREDIENT_STRIDE).map(ingredient).collect();
    if !shapeless && ingredients.len() != width * height {
        return None;
    }
    let first = pe::read::<usize>(address + results_at)?;
    let last = pe::read::<usize>(address + results_at + 8)?;
    if last < first || (last - first) % RESULT_STRIDE != 0 || (last - first) / RESULT_STRIDE > 16 {
        return None;
    }
    let results = (first..last).step_by(RESULT_STRIDE).collect();
    Some(Recipe { id, tag, net_id, shapeless, width, height, ingredients, results })
}

/// Every recipe of the client's registry with `tag` (all of them for `None`).
pub(crate) fn recipes(tag: Option<&str>) -> Result<Vec<Recipe>, RpcError> {
    let (accessor, entity) = context().ok_or_else(|| RpcError::anchor("inventory.context"))?;
    let player = player(accessor, entity).ok_or_else(|| RpcError::anchor("inventory.actor"))?;
    let level = link(L_ACTOR_LEVEL)
        .and_then(|at| pe::read::<usize>(player + at))
        .filter(|level| has_game_table(*level))
        .ok_or_else(|| RpcError::anchor(LINK_NAMES[L_ACTOR_LEVEL]))?;
    let registry = link(L_GET_RECIPES)
        .and_then(|slot| virtual0(level, slot))
        .filter(|registry| *registry != 0 && pe::readable(*registry, RECIPES_SIZE + 8))
        .ok_or_else(|| RpcError::anchor(LINK_NAMES[L_GET_RECIPES]))?;
    let shape = || RpcError::anchor("craft.recipes").with_data(json!({ "message": "the recipe registry does not have its net-id map's shape" }));
    let head = pe::read::<usize>(registry + RECIPES_HEAD).filter(|head| *head != 0).ok_or_else(shape)?;
    let size = pe::read::<usize>(registry + RECIPES_SIZE).filter(|size| *size <= RECIPE_LIMIT).ok_or_else(shape)?;
    let mut out = Vec::new();
    let mut node = pe::read::<usize>(head).ok_or_else(shape)?;
    let mut walked = 0usize;
    while node != head {
        walked += 1;
        if walked > size {
            return Err(shape());
        }
        let net_id = pe::read::<u32>(node + RECIPE_NODE_NET_ID).ok_or_else(shape)?;
        if let Some(found) = pe::read::<usize>(node + RECIPE_NODE_RECIPE).and_then(|address| recipe(address, net_id)) {
            if tag.is_none_or(|tag| found.tag == tag) {
                out.push(found);
            }
        }
        node = pe::read::<usize>(node).ok_or_else(shape)?;
    }
    if walked != size {
        return Err(shape());
    }
    Ok(out)
}

/// `minecraft:` + `id` unless it names a namespace.
pub(crate) fn namespaced(id: &str) -> String {
    let id = id.trim();
    if id.contains(':') {
        String::from(id)
    } else {
        format!("minecraft:{id}")
    }
}

/// The `Item*` of a stack (`impl[0]`), when it has one.
pub(crate) fn stack_item(stack: usize) -> Option<usize> {
    let impl_pointer = pe::read::<usize>(stack + STACK_IMPL).filter(|value| *value != 0)?;
    pe::read::<usize>(impl_pointer).filter(|item| *item != 0)
}

/// True when the item carries `tag` (the tag vector the game's own tag test walks).
fn has_tag(item: usize, tag: &str) -> bool {
    let (Some(begin), Some(end)) = (pe::read::<usize>(item + ITEM_TAGS), pe::read::<usize>(item + ITEM_TAGS + 8)) else {
        return false;
    };
    if end < begin || (end - begin) % ITEM_TAG_STRIDE != 0 || (end - begin) / ITEM_TAG_STRIDE > 256 {
        return false;
    }
    (begin..end).step_by(ITEM_TAG_STRIDE).any(|entry| pe::std_string(entry + ITEM_TAG_NAME).is_some_and(|name| name == tag))
}

/// True when `ingredient` takes the item named `name` (`item`: its `Item*`, when known).
pub(crate) fn accepts(ingredient: &Ingredient, name: &str, item: Option<usize>) -> bool {
    match ingredient {
        Ingredient::Empty | Ingredient::Unknown => false,
        Ingredient::Item(want) => item == Some(*want) || item_identifier(*want).is_some_and(|id| id == name),
        Ingredient::Name(want) => want == name,
        Ingredient::Tag(tag) => item.is_some_and(|item| has_tag(item, tag)),
    }
}

/* ------------------------------------------------------------------------------------------------
 * Crafting
 * ---------------------------------------------------------------------------------------------- */

/// The grid a `craft.match` asks about: 3x3 cells, each an item id (namespaced) or empty.
type Grid = [[Option<String>; 3]; 3];

/// `craft.match {grid | ingredients, table?}` → `{result, recipe: {id, type, tag}}`.
///
/// The client's own recipe registry (what the crafting screen matches its grid against), read in place:
/// a shaped recipe matches the grid's occupied box cell by cell (mirrored too, as the game's own grid
/// index pairs both orientations); a shapeless one, and every recipe for an `ingredients` list, matches
/// when each ingredient takes a distinct item. A tag ingredient is tested on the item's own tag list, so
/// the item has to be one the registry or the player's inventory holds. Without `table`, only recipes the
/// inventory's 2x2 grid can make. No match is `{result: null, recipe: null}`.
pub(crate) fn h_craft_match(_core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let request = grid_shape(params)?;
    world()?;
    let table = params.get("table").and_then(Value::as_bool).unwrap_or(false);
    let recipes = recipes(Some(CRAFTING_TAG))?;
    let items = item_index(&recipes);
    let item_of = |name: &str| items.iter().find(|(known, _)| known == name).map(|(_, item)| *item);
    let found = recipes.iter().filter(|recipe| table || recipe.fits_small()).find(|recipe| match &request {
        Asked::Grid(grid) => {
            if !table && occupied_box(grid).is_some_and(|(_, _, width, height)| width > 2 || height > 2) {
                return false;
            }
            if recipe.shapeless {
                let names: Vec<&str> = grid.iter().flatten().flatten().map(String::as_str).collect();
                multiset(recipe, &names, &item_of)
            } else {
                shaped(recipe, grid, &item_of)
            }
        }
        Asked::Ingredients(names) => {
            let names: Vec<&str> = names.iter().map(String::as_str).collect();
            multiset(recipe, &names, &item_of)
        }
    });
    Ok(match found {
        Some(recipe) => json!({ "result": recipe.result(), "recipe": recipe.describe() }),
        None => json!({ "result": null, "recipe": null }),
    })
}

/// `craft.run {recipe, times?}`: the craft is a screen action, made by [`crate::workstation::craft_run`].
pub(crate) fn h_craft_run(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    crate::workstation::craft_run(core, params)
}

/// The names a tag test can resolve: every item a crafting recipe names or makes, and the player's own.
fn item_index(recipes: &[Recipe]) -> Vec<(String, usize)> {
    let mut out: Vec<(String, usize)> = Vec::new();
    let mut add = |item: usize| {
        if out.iter().any(|(_, known)| *known == item) {
            return;
        }
        if let Some(name) = item_identifier(item) {
            out.push((name, item));
        }
    };
    for recipe in recipes {
        for (ingredient, _) in &recipe.ingredients {
            if let Ingredient::Item(item) = ingredient {
                add(*item);
            }
        }
        for result in &recipe.results {
            if let Some(item) = stack_item(*result) {
                add(item);
            }
        }
    }
    for stack in carried_stacks() {
        if let Some(item) = stack_item(stack) {
            add(item);
        }
    }
    out
}

/// The player's hotbar and inventory stacks (empty ones included), read on the client thread.
pub(crate) fn carried_stacks() -> Vec<usize> {
    let Some((accessor, entity)) = context() else {
        return Vec::new();
    };
    let Some(container) = player(accessor, entity)
        .and_then(|player| pe::read::<usize>(player + PLAYER_INVENTORY))
        .and_then(|inventory| pe::read::<usize>(inventory + PLAYER_INVENTORY_CONTAINER))
    else {
        return Vec::new();
    };
    let size = container_size(container).unwrap_or(0).min(HOTBAR_SLOTS + MAIN_SLOTS);
    (0..size).filter_map(|index| container_item(container, index)).collect()
}

/// The occupied cells' box: `(left, top, width, height)`, `None` for an empty grid.
fn occupied_box(grid: &Grid) -> Option<(usize, usize, usize, usize)> {
    let mut bounds: Option<(usize, usize, usize, usize)> = None;
    for (y, row) in grid.iter().enumerate() {
        for (x, cell) in row.iter().enumerate() {
            if cell.is_some() {
                bounds = Some(match bounds {
                    None => (x, y, x, y),
                    Some((left, top, right, bottom)) => (left.min(x), top.min(y), right.max(x), bottom.max(y)),
                });
            }
        }
    }
    bounds.map(|(left, top, right, bottom)| (left, top, right - left + 1, bottom - top + 1))
}

/// A shaped recipe against the grid's occupied box, as laid out or mirrored.
fn shaped(recipe: &Recipe, grid: &Grid, item_of: &dyn Fn(&str) -> Option<usize>) -> bool {
    let Some((left, top, width, height)) = occupied_box(grid) else {
        return false;
    };
    if width != recipe.width || height != recipe.height {
        return false;
    }
    let fits = |mirrored: bool| {
        (0..height).all(|y| {
            (0..width).all(|x| {
                let column = if mirrored { width - 1 - x } else { x };
                let (wanted, _) = &recipe.ingredients[y * width + column];
                match (&grid[top + y][left + x], wanted) {
                    (None, Ingredient::Empty) => true,
                    (Some(name), wanted) => accepts(wanted, name, item_of(name)),
                    _ => false,
                }
            })
        })
    };
    fits(false) || fits(true)
}

/// Every needed ingredient takes a distinct one of `names`, and no name is left over.
fn multiset(recipe: &Recipe, names: &[&str], item_of: &dyn Fn(&str) -> Option<usize>) -> bool {
    let needed: Vec<&Ingredient> = recipe.needed().map(|(ingredient, _)| ingredient).collect();
    if needed.len() != names.len() || needed.is_empty() {
        return false;
    }
    let items: Vec<Option<usize>> = names.iter().map(|name| item_of(name)).collect();
    let mut used = alloc::vec![false; names.len()];
    assign(&needed, 0, names, &items, &mut used)
}

fn assign(needed: &[&Ingredient], at: usize, names: &[&str], items: &[Option<usize>], used: &mut [bool]) -> bool {
    if at == needed.len() {
        return true;
    }
    for index in 0..names.len() {
        if !used[index] && accepts(needed[at], names[index], items[index]) {
            used[index] = true;
            if assign(needed, at + 1, names, items, used) {
                return true;
            }
            used[index] = false;
        }
    }
    false
}

/// What a `craft.match` asks about.
enum Asked {
    Grid(Grid),
    Ingredients(Vec<String>),
}

/// The shape of a `craft.match` request: a grid of up to 3x3 item ids (or nulls), padded to 3x3, or a flat
/// ingredient list, and an optional crafting-table flag.
fn grid_shape(params: &Value) -> Result<Asked, RpcError> {
    if let Some(table) = params.get("table") {
        if !table.is_boolean() {
            return Err(RpcError::invalid_params("table must be a boolean"));
        }
    }
    if let Some(grid) = params.get("grid") {
        let rows = grid.as_array().ok_or_else(|| RpcError::invalid_params("grid must be an array of rows"))?;
        if rows.is_empty() || rows.len() > 3 {
            return Err(RpcError::invalid_params("grid must have 1..3 rows"));
        }
        let mut out: Grid = Default::default();
        for (y, row) in rows.iter().enumerate() {
            let cells = row.as_array().ok_or_else(|| RpcError::invalid_params("each grid row must be an array"))?;
            if cells.is_empty() || cells.len() > 3 {
                return Err(RpcError::invalid_params("each grid row must hold 1..3 cells"));
            }
            for (x, cell) in cells.iter().enumerate() {
                out[y][x] = item_id(cell)?;
            }
        }
        if occupied_box(&out).is_none() {
            return Err(RpcError::invalid_params("grid holds no item"));
        }
        return Ok(Asked::Grid(out));
    }
    if let Some(ingredients) = params.get("ingredients") {
        let items = ingredients
            .as_array()
            .ok_or_else(|| RpcError::invalid_params("ingredients must be an array"))?;
        if items.is_empty() || items.len() > 9 {
            return Err(RpcError::invalid_params("ingredients must hold 1..9 items"));
        }
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            out.push(item_id(item)?.ok_or_else(|| RpcError::invalid_params("an ingredient must be an item id"))?);
        }
        return Ok(Asked::Ingredients(out));
    }
    Err(RpcError::invalid_params("grid or ingredients is required"))
}

/// One grid cell: an item id (namespaced) or null.
fn item_id(value: &Value) -> Result<Option<String>, RpcError> {
    match value {
        Value::Null => Ok(None),
        Value::String(id) if !id.trim().is_empty() => Ok(Some(namespaced(id))),
        _ => Err(RpcError::invalid_params("a grid cell must be an item id or null")),
    }
}

/* ------------------------------------------------------------------------------------------------
 * Shared
 * ---------------------------------------------------------------------------------------------- */

/// `-32002` unless a world this process hosts is loaded with a local player.
fn world() -> Result<(), RpcError> {
    if live::in_world() {
        Ok(())
    } else {
        Err(RpcError::not_in_world())
    }
}

/// A float for the wire, never a non-finite number.
fn number(value: Option<f32>) -> Value {
    value
        .and_then(|value| serde_json::Number::from_f64(value as f64))
        .map(Value::Number)
        .unwrap_or(Value::Null)
}
