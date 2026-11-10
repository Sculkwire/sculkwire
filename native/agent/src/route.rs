//! The OreUI router's current location: which page an OreUI screen shows.
//!
//! Every OreUI screen of this build names itself by its document URL (`ui://./hbui/index.html`), so a
//! scene name cannot tell the Play screen from the Marketplace or the Dressing Room. The page is decided
//! by the client's `OreUI::Router`, the object behind the `core:router:*` events the page script uses;
//! this module reads its current location's `pathname` (`/play`, `/marketplace/store`, …).
//!
//! # The `OreUI::Router` object (evidence)
//!
//! Retail strips class RTTI, but the router's own `std::function` members keep theirs: the type
//! descriptor of `std::_Binder<_Unforced, void (Router::*)(optional<RouterLocation> const&,
//! optional<RouterLocation> const&), Router*, _1, _2>` is referenced only by that function object's
//! `_Target_type` (`lea rax, [descriptor]; ret`), which sits in exactly one `_Func_impl` table. The
//! table is stamped by exactly one constructor, `Router::Router(unique_ptr<IRouteMatcher const>,
//! unique_ptr<IRoutePrerequisiteHandler>, unique_ptr<RouterEventing>, NonOwnerPointer<ISceneStack>)`
//! (named by the RTTI of its own lambdas `<lambda_14..17>@??0Router@OreUI@@`), decompiled:
//!
//! ```text
//! +0x00 vector<Entry> history       begin / end / capacity (+0x08 / +0x10)
//! +0x18 i32 last action             0 PUSH, 1 POP, 2 REPLACE (the action string getter switches on it)
//! +0x20 std::function on-change     impl table = the binder table, +0x28 the member, +0x38 `this`,
//!                                   +0x58 the impl pointer (= router + 0x20, the small buffer)
//! +0x88 NonOwnerPointer<ISceneStack> control: points at the "still alive" byte the game asserts
//! +0x98                              the router's `SceneStack`
//! ```
//!
//! The constructor's stores of the table into `+0x20`, of `this` into `+0x38` and of the buffer into
//! `+0x58` are checked at attach ([`resolve`]); that is the fingerprint a live router is recognised by.
//!
//! A history entry is `0x98` bytes (the walks step `0x98`, the "last" entry is `end - 0x98`):
//!
//! ```text
//! +0x00 weak_ptr<Scene>   the scene the location belongs to (pointer, control block)
//! +0x30 std::string pathname
//! +0x50 std::string search
//! +0x70 std::string hash
//! ```
//!
//! `Router`'s location getter copies the last entry and answers "none" unless the entry's scene is
//! still alive (it locks the `weak_ptr` at `+0x00`/`+0x08`). The offsets of `pathname`, `search` and
//! `hash` come from two bodies that agree: the `cohtml` type registration of `core.RouterLocation`
//! binds `pathname` at `0x00`, `search` at `0x20` and `hash` at `0x40`, and the `core:router:changed`
//! publisher (which also registers `core.RouterState` as `length`, `action`, `location`, `history`)
//! builds each `RouterLocation` of `history` from an entry's `+0x30`, `+0x50` and `+0x70`.
//!
//! The router's own stack listener reads the top scene through `[router + 0x98]`'s vtable slot
//! `0x198`; on `SceneStack` that slot is `mov rdx,[rcx+0x20]; cmp [rcx+0x18],rdx; … mov rcx,[rdx-0x10];
//! … mov rdx,[rdx-0x18]` — the last `0x20`-byte entry's scene and control block. The body is checked
//! before the stack is read the same way.
//!
//! # Reaching a router
//!
//! The client's setup keeps a router **beside the stack it routes**: the `initPrimaryClientComplete` step
//! stores the new router at `+0x1e08` of the object whose `SceneStack` sits at `+0x1df8` (`mov
//! [rsi+0x1e08], rax` right after the router's factory call; the stack's own init stores `+0x1df8`). A
//! second router (route flags `2` instead of `1`) routes the client instance's own stack. Live (1.26.63,
//! Play screen): the menus' always-active stack's owner holds that stack at `+0x1df8` and router `R2` at
//! `+0x1e08`, `[R2 + 0x98]` is that stack; `[R1 + 0x98]` is the client instance's stack.
//!
//! So routers are reached from the stacks [`crate::ui`] already validated, with their owners
//! ([`crate::ui::stack_holders`]): a router is a qword in `[owner + field + 8, owner + field + 0x40]`
//! that carries the fingerprint (the binder table at `+0x20`, itself at `+0x38`, `+0x20` at `+0x58`)
//! **and** points back at that stack from `+0x98`. A stack whose owner `ui` does not keep (the client
//! instance's) is looked for one hop from a known owner: a pointer field `p` of it with the stack at
//! `p + field` for one of the two stack fields. Nothing scans memory; a few thousand guarded reads at
//! most. Found routers are cached and every read re-checks the fingerprint, so a freed router is dropped.
//!
//! # What the answer means
//!
//! [`current_route`] answers a router's current `pathname` only when that location's scene **is the top
//! scene of the router's own stack** (the same control block): the page belongs to the screen the user
//! sees. A JSON-UI screen on top, an OreUI scene that is covered, an expired scene, or anything that does
//! not check out answers `None`.

use alloc::string::String;
use alloc::vec::Vec;
use core::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use agent_core::{win, Anchor, Core, Image};

use crate::pe;

/// The type descriptor name of the router's on-change `std::function` (a bound `Router` member).
const BINDER_TYPE: &[u8] = b".?AV?$_Binder@U_Unforced@std@@P8Router@OreUI@@EAAXAEBV?$optional@VRouterLocation@OreUI@@@2@0@ZPEAV34@AEBU?$_Ph@$00@2@AEBU?$_Ph@$01@2@@std@@";
/// `_Func_impl` slots: copy, move, call, target type, delete, get.
const IMPL_SLOTS: usize = 6;
/// The slot `_Target_type` sits in.
const TARGET_TYPE_SLOT: usize = 3 * 8;

/// The router's on-change function object and the fields of it the constructor writes.
const ROUTER_FUNCTION: usize = 0x20;
const ROUTER_MEMBER: usize = 0x28;
const ROUTER_BOUND_THIS: usize = 0x38;
const ROUTER_FUNCTION_IMPL: usize = 0x58;
/// The router's history vector.
const ROUTER_BEGIN: usize = 0x00;
const ROUTER_END: usize = 0x08;
const ROUTER_CAPACITY: usize = 0x10;
/// `NonOwnerPointer<ISceneStack>`: the alive byte's holder and the stack.
const ROUTER_STACK_ALIVE: usize = 0x88;
const ROUTER_STACK: usize = 0x98;
/// One history entry and the fields read from it.
const ENTRY_SIZE: usize = 0x98;
const ENTRY_SCENE: usize = 0x00;
const ENTRY_SCENE_CONTROL: usize = 0x08;
const ENTRY_PATHNAME: usize = 0x30;
/// A router keeps a short history; a longer vector is not a router.
const MAX_ENTRIES: usize = 64;

/// `SceneStack`: the entry vector and the entry layout its top-scene getter reads.
const STACK_BEGIN: usize = 0x18;
const STACK_END: usize = 0x20;
const STACK_CAPACITY: usize = 0x28;
const STACK_ENTRY: usize = 0x20;
const STACK_MAX_ENTRIES: usize = 64;
/// The top-scene getter's slot, as the router's stack listener calls it.
const STACK_TOP_SLOT: usize = 0x198;
/// The getter's head: `mov rax,rdx; mov rdx,[rcx+0x20]; cmp [rcx+0x18],rdx; je …; xorps xmm0,xmm0;
/// movups [rax],xmm0; mov rcx,[rdx-0x10]` (`0xFF` = the branch displacement, not compared).
const STACK_TOP_HEAD: &[u8] = &[
    0x48, 0x89, 0xD0, 0x48, 0x8B, 0x51, 0x20, 0x48, 0x39, 0x51, 0x18, 0x74, 0xFF, 0x0F, 0x57, 0xC0, 0x0F, 0x11, 0x00, 0x48, 0x8B,
    0x4A, 0xF0,
];
/// `mov rdx,[rdx-0x18]`: the scene pointer, later in the same body.
const STACK_TOP_SCENE: &[u8] = &[0x48, 0x8B, 0x52, 0xE8];

/// The longest pathname answered; the game's routes are short.
const MAX_PATH: usize = 512;
/// Routers remembered between reads.
const MAX_ROUTERS: usize = 8;
/// How far past the stack's field the owner keeps its router (`+0x1df8` → `+0x1e08` in 1.26.63).
const ROUTER_REACH: usize = 0x40;
/// How much of a known owner the one-hop search for another stack's owner reads.
const OWNER_WINDOW: usize = 0x2000;
/// No router cached (or none still a router): search again at most this often.
const RESCAN_EMPTY_MS: u64 = 1_000;
/// Routers cached but none owns the top scene: a stack `ui` found since (a world's) may hold another.
const RESCAN_STALE_MS: u64 = 3_000;

/// The binder's `_Func_impl` table: the value a live router holds at `+0x20` (0 while unresolved).
static BINDER: AtomicUsize = AtomicUsize::new(0);
/// `Router::Router`, for `engine.status`.
static CONSTRUCTOR: AtomicUsize = AtomicUsize::new(0);
/// Routers found by the last search, 0 for an empty slot.
static ROUTERS: [AtomicUsize; MAX_ROUTERS] = [const { AtomicUsize::new(0) }; MAX_ROUTERS];
/// `tick_ms` of the last search.
static SCANNED: AtomicU64 = AtomicU64::new(0);

/// The current OreUI route (`pathname`) of the screen on top of `stack` (the `SceneStack` the screen's
/// name was read from), or `None` when no router of that stack is known, the top screen is not its
/// page, or anything on the way does not check out. Another stack's router never answers: in a world
/// the menus' always-active stack keeps its own router (on `/__bedrock__/toast_screen`), which says
/// nothing about the page the player sees. Main thread only (the game's routers are changed there);
/// reads only.
pub(crate) fn current_route(stack: usize) -> Option<String> {
    let binder = BINDER.load(Ordering::Acquire);
    if binder == 0 {
        return None;
    }
    let mut cached = false;
    for slot in &ROUTERS {
        let router = slot.load(Ordering::Acquire);
        if router == 0 {
            continue;
        }
        if !is_router(router, binder) {
            slot.store(0, Ordering::Release);
            continue;
        }
        cached = true;
        if pe::read::<usize>(router + ROUTER_STACK) != Some(stack) {
            continue;
        }
        if let Some(route) = route_of(router) {
            return Some(route);
        }
    }
    let wait = if cached { RESCAN_STALE_MS } else { RESCAN_EMPTY_MS };
    let now = win::tick_ms();
    if now.saturating_sub(SCANNED.load(Ordering::Acquire)) < wait {
        return None;
    }
    SCANNED.store(now, Ordering::Release);
    let found = find_routers(binder);
    let changed = ROUTERS.iter().enumerate().any(|(index, slot)| slot.load(Ordering::Acquire) != found.get(index).copied().unwrap_or(0));
    for (index, slot) in ROUTERS.iter().enumerate() {
        slot.store(found.get(index).copied().unwrap_or(0), Ordering::Release);
    }
    if changed {
        agent_core::log::fmt(format_args!(
            "route: {} OreUI router(s) beside the validated stacks: {:?}",
            found.len(),
            found.iter().map(|router| alloc::format!("0x{router:x}")).collect::<Vec<_>>()
        ));
    }
    found.iter().filter(|router| pe::read::<usize>(*router + ROUTER_STACK) == Some(stack)).find_map(|router| route_of(*router))
}

/// The current location of `router` when it belongs to the top scene of the router's own stack.
fn route_of(router: usize) -> Option<String> {
    let (begin, end) = history(router)?;
    if end == begin {
        return None;
    }
    let (top_scene, top_control) = top_scene(router)?;
    let last = end - ENTRY_SIZE;
    let scene = pe::read::<usize>(last + ENTRY_SCENE)?;
    let control = pe::read::<usize>(last + ENTRY_SCENE_CONTROL)?;
    // The same object: the router's `weak_ptr` and the stack's `shared_ptr` share one control block, and
    // the scene is still alive (its use count, which the stack holds, is above zero).
    if scene < 0x1_0000 || top_scene < 0x1_0000 || control < 0x1_0000 || control != top_control {
        return None;
    }
    if pe::read::<i32>(control + 8).is_none_or(|uses| uses <= 0) {
        return None;
    }
    let path = pe::std_string(last + ENTRY_PATHNAME)?;
    (!path.is_empty() && path.len() <= MAX_PATH && path.bytes().all(|byte| byte.is_ascii_graphic())).then_some(path)
}

/// The top scene of the router's stack as `(scene, control block)`, read the way the stack's own
/// top-scene getter reads it (its body is checked first).
fn top_scene(router: usize) -> Option<(usize, usize)> {
    let alive = pe::read::<usize>(router + ROUTER_STACK_ALIVE)?;
    if alive < 0x1_0000 || pe::read::<u8>(alive)? == 0 {
        return None;
    }
    let stack = pe::read::<usize>(router + ROUTER_STACK)?;
    if stack < 0x1_0000 {
        return None;
    }
    let table = pe::read::<usize>(stack)?;
    if !pe::in_image_data(table) {
        return None;
    }
    let getter = pe::read::<usize>(table + STACK_TOP_SLOT)?;
    if !pe::in_image_code(getter) || !top_getter(getter) {
        return None;
    }
    let begin = pe::read::<usize>(stack + STACK_BEGIN)?;
    let end = pe::read::<usize>(stack + STACK_END)?;
    let capacity = pe::read::<usize>(stack + STACK_CAPACITY)?;
    if begin < 0x1_0000 || end <= begin || capacity < end || (end - begin) % STACK_ENTRY != 0 {
        return None;
    }
    if (end - begin) / STACK_ENTRY > STACK_MAX_ENTRIES {
        return None;
    }
    Some((pe::read::<usize>(end - 0x18)?, pe::read::<usize>(end - 0x10)?))
}

/// True for the `SceneStack` top-scene getter's body.
fn top_getter(function: usize) -> bool {
    let Some(code) = pe::bytes(function, 0x40) else {
        return false;
    };
    let head = STACK_TOP_HEAD.iter().zip(code).all(|(want, have)| *want == 0xFF || want == have);
    head && code.windows(STACK_TOP_SCENE.len()).any(|window| window == STACK_TOP_SCENE)
}

/// The router's history `(begin, end)` when it is a well-formed vector of entries.
fn history(router: usize) -> Option<(usize, usize)> {
    let begin = pe::read::<usize>(router + ROUTER_BEGIN)?;
    let end = pe::read::<usize>(router + ROUTER_END)?;
    let capacity = pe::read::<usize>(router + ROUTER_CAPACITY)?;
    if begin == 0 && end == 0 && capacity == 0 {
        return Some((0, 0));
    }
    if begin < 0x1_0000 || end < begin || capacity < end || (end - begin) % ENTRY_SIZE != 0 {
        return None;
    }
    ((end - begin) / ENTRY_SIZE <= MAX_ENTRIES).then_some((begin, end))
}

/// The fingerprint the constructor leaves: the binder table at `+0x20`, the member at `+0x28` (code),
/// `this` at `+0x38`, the impl pointer at `+0x58` — plus a history that is a vector of entries.
fn is_router(router: usize, binder: usize) -> bool {
    if router < 0x1_0000 || router & 7 != 0 || !pe::readable(router, ROUTER_STACK + 8) {
        return false;
    }
    pe::read::<usize>(router + ROUTER_FUNCTION) == Some(binder)
        && pe::read::<usize>(router + ROUTER_BOUND_THIS) == Some(router)
        && pe::read::<usize>(router + ROUTER_FUNCTION_IMPL) == Some(router + ROUTER_FUNCTION)
        && pe::read::<usize>(router + ROUTER_MEMBER).is_some_and(pe::in_image_code)
        && history(router).is_some()
}

/// Every router kept beside a stack [`crate::ui`] validated (see the module docs).
fn find_routers(binder: usize) -> Vec<usize> {
    let (stacks, fields) = crate::ui::stack_holders();
    let owners: Vec<usize> = stacks.iter().map(|(_, owner, _)| *owner).filter(|owner| *owner != 0).collect();
    let mut found: Vec<usize> = Vec::new();
    for (stack, owner, field) in &stacks {
        let holder = if *owner != 0 { Some((*owner, *field)) } else { owner_of(*stack, &owners, fields) };
        let Some((owner, field)) = holder else {
            continue;
        };
        let mut offset = field + 8;
        while offset <= field + ROUTER_REACH && found.len() < MAX_ROUTERS {
            if let Some(router) = pe::read::<usize>(owner + offset) {
                if !found.contains(&router) && is_router(router, binder) && pe::read::<usize>(router + ROUTER_STACK) == Some(*stack) {
                    found.push(router);
                }
            }
            offset += 8;
        }
    }
    found
}

/// The object holding `stack` at one of the stack `fields`, one pointer hop from a known owner.
fn owner_of(stack: usize, owners: &[usize], fields: [usize; 2]) -> Option<(usize, usize)> {
    for owner in owners {
        for field in fields.iter().copied().filter(|field| *field != 0) {
            if pe::read::<usize>(owner + field) == Some(stack) {
                return Some((*owner, field));
            }
        }
        let Some(window) = pe::bytes(*owner, OWNER_WINDOW) else {
            continue;
        };
        for word in window.chunks_exact(8) {
            let child = usize::from_le_bytes(word.try_into().ok()?);
            if child < 0x1_0000 || child & 7 != 0 || pe::in_image_data(child) || pe::in_image_code(child) {
                continue;
            }
            for field in fields.iter().copied().filter(|field| *field != 0) {
                if pe::read::<usize>(child + field) == Some(stack) {
                    return Some((child, field));
                }
            }
        }
    }
    None
}

/// Resolves the binder table and proves the router's fingerprint offsets from its constructor.
pub(crate) fn resolve(core: &'static Core) -> Vec<Anchor> {
    let image = core.image();
    match binder_table(image) {
        Some((table, constructor)) => {
            BINDER.store(table, Ordering::Release);
            CONSTRUCTOR.store(constructor, Ordering::Release);
            agent_core::log::fmt(format_args!(
                "route: Router binder table 0x{:x}, Router::Router 0x{:x}",
                table - image.base(),
                constructor - image.base()
            ));
        }
        None => agent_core::log::line("route: the OreUI Router binder table did not resolve (current_route answers None)"),
    }
    report()
}

/// The anchors `engine.status` reports.
pub(crate) fn report() -> Vec<Anchor> {
    alloc::vec![
        Anchor { name: "route.binder", addr: BINDER.load(Ordering::Acquire) },
        Anchor { name: "route.router_ctor", addr: CONSTRUCTOR.load(Ordering::Acquire) },
    ]
}

/// `(binder table, Router::Router)`: type descriptor → its one `_Target_type` (`lea rax,[td]; ret`) →
/// the one table slot holding it → the one constructor that stores that table at `+0x20`, `this` at
/// `+0x38` and the buffer at `+0x58`.
fn binder_table(image: &Image) -> Option<(usize, usize)> {
    let descriptor = image.type_descriptor(BINDER_TYPE)?;
    let mut references = [0usize; 8];
    let count = image.rip_refs(descriptor, &mut references);
    let mut target_type: Option<usize> = None;
    for reference in &references[..count] {
        let Some((start, register)) = lea_at(*reference) else {
            continue;
        };
        // `lea rax, [descriptor]; ret`.
        if register != 0 || pe::read::<u8>(start + 7) != Some(0xC3) {
            continue;
        }
        if target_type.is_some_and(|known| known != start) {
            return None;
        }
        target_type = Some(start);
    }
    let slot = unique_data_slot(image, target_type?)?;
    let table = slot - TARGET_TYPE_SLOT;
    if !(0..IMPL_SLOTS).all(|index| pe::read::<usize>(table + index * 8).is_some_and(pe::in_image_code)) {
        return None;
    }
    let mut sites = [0usize; 8];
    let count = image.rip_refs(table, &mut sites);
    let mut constructor: Option<usize> = None;
    for site in &sites[..count] {
        let Some((start, register)) = lea_at(*site) else {
            continue;
        };
        if !stores_fingerprint(start + 7, register) {
            continue;
        }
        let function = image.function_start(start)?;
        if constructor.is_some_and(|known| known != function) {
            return None;
        }
        constructor = Some(function);
    }
    Some((table, constructor?))
}

/// The start and destination register of a `lea r64, [rip + disp32]` whose displacement field is at
/// `reference + 3` or `reference + 2` (a reference can be reported at the REX byte or one past it).
fn lea_at(reference: usize) -> Option<(usize, u8)> {
    for start in [reference, reference.wrapping_sub(1)] {
        let Some(code) = pe::bytes(start, 3) else {
            continue;
        };
        let rex = code[0];
        let modrm = code[2];
        if rex & 0xF8 == 0x48 && code[1] == 0x8D && modrm & 0xC7 == 0x05 {
            return Some((start, ((modrm >> 3) & 7) | ((rex & 4) << 1)));
        }
    }
    None
}

/// True when, within the next 0x24 bytes, `register` is stored to `[base + 0x20]` and the same `base`
/// is stored to `[base + 0x38]` and something to `[base + 0x58]` — the router's function object.
fn stores_fingerprint(from: usize, register: u8) -> bool {
    let Some(code) = pe::bytes(from, 0x24) else {
        return false;
    };
    // `mov [base + disp8], source`: REX.W, `89`, mod `01`, no SIB (base not `rsp`/`r12`).
    let stores = || {
        code.windows(4).filter_map(|bytes| {
            let (rex, opcode, modrm, disp) = (bytes[0], bytes[1], bytes[2], bytes[3]);
            if rex & 0xF8 != 0x48 || opcode != 0x89 || modrm >> 6 != 1 || modrm & 7 == 4 {
                return None;
            }
            let source = ((modrm >> 3) & 7) | ((rex & 4) << 1);
            let base = (modrm & 7) | ((rex & 1) << 3);
            Some((base, source, disp))
        })
    };
    let Some(base) = stores().find(|(_, source, disp)| *source == register && *disp as usize == ROUTER_FUNCTION).map(|(base, _, _)| base)
    else {
        return false;
    };
    stores().any(|(b, source, disp)| b == base && source == base && disp as usize == ROUTER_BOUND_THIS)
        && stores().any(|(b, _, disp)| b == base && disp as usize == ROUTER_FUNCTION_IMPL)
}

/// The address of the one qword in the image's data equal to `value`, when exactly one is.
fn unique_data_slot(image: &Image, value: usize) -> Option<usize> {
    let mut found: Option<usize> = None;
    for section in image.sections() {
        let name = section.name();
        if name.starts_with(".text") || matches!(name, ".pdata" | ".rsrc" | ".reloc") {
            continue;
        }
        let Some(bytes) = pe::bytes(section.va, section.len) else {
            continue;
        };
        let mut offset = 0usize;
        while offset + 8 <= bytes.len() {
            // SAFETY: eight bytes inside a readable section; table slots are 8-byte aligned.
            let word = unsafe { core::ptr::read_unaligned(bytes.as_ptr().add(offset) as *const u64) } as usize;
            if word == value {
                if found.is_some() {
                    return None;
                }
                found = Some(section.va + offset);
            }
            offset += 8;
        }
    }
    found
}
