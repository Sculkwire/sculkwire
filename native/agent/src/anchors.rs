//! Anchor resolution for the retail client: every address this engine uses is looked up in the
//! running image from a recipe that survives a game update.
//!
//! The recipes are, in order of preference: the assert-metadata triple (`{fnptr, source .cpp,
//! signature}`, which is real data in `.rdata`), a string the function references, an ECS component
//! type hash (FNV-1a 32 of the type name, cross-checked against the runtime descriptor table), and
//! the code shape at a site the previous recipe proved (the accessor call after a hash immediate, a
//! masked signature, a code pointer a body hands to a register). Nothing here knows an RVA.
//!
//! A recipe that does not resolve *uniquely* leaves its anchor at 0, and every feature that needs it
//! answers `-32001 anchor not resolved` with that name. Resolution is fail-closed by construction.
//!
//! Three anchors are not addresses in the image but objects the running game creates: the local
//! server (`server.instance`), the command manager (`command.commands`) and the loaded level's data
//! (`level.data`). Their recipes live in [`crate::live`] and [`crate::world`]; they are reported here
//! as soon as they resolve, and stay 0 while they have not.

use alloc::vec::Vec;
use core::sync::atomic::{AtomicUsize, Ordering};

use agent_core::{Anchor, Image};

use crate::pe;

/// The `CommandRequest` constructor's prologue: it copies the line and stores the moved origin and
/// the flag word (`Request{std::string, CommandOrigin*, u32}`).
const REQUEST_CTOR: &[u8] = &[
    0x55, 0x41, 0x57, 0x41, 0x56, 0x41, 0x55, 0x41, 0x54, 0x56, 0x57, 0x53, 0x48, 0x83, 0xEC, 0x38, 0x48, 0x8D, 0x6C,
    0x24, 0x30, 0x48, 0xC7, 0x45, 0x00, 0xFE, 0xFF, 0xFF, 0xFF, 0x44, 0x89, 0xCF, 0x48, 0x89, 0xD3, 0x48, 0x89, 0xCE,
    0x0F, 0x57, 0xC0, 0x0F, 0x11, 0x41, 0x10, 0x0F, 0x11, 0x01, 0x4C, 0x8B, 0x72, 0x10, 0x48, 0x83, 0x7A, 0x18, 0x10,
];

/// `CommandOrigin::fromData(out, CommandOriginData const&, src, flag)`'s prologue.
const ORIGIN_FROM_DATA: &[u8] = &[
    0x55, 0x41, 0x57, 0x41, 0x56, 0x41, 0x55, 0x41, 0x54, 0x56, 0x57, 0x53, 0x48, 0x83, 0xEC, 0x78, 0x48, 0x8D, 0x6C,
    0x24, 0x70, 0x48, 0xC7, 0x45, 0x00, 0xFE, 0xFF, 0xFF, 0xFF, 0x4C, 0x89, 0xCB, 0x4D, 0x89, 0xC6, 0x48, 0x89, 0xD7,
    0x48, 0x89, 0xCE, 0x48, 0xC7, 0x01, 0x00, 0x00, 0x00, 0x00, 0x0F, 0xB6, 0x02, 0x83, 0xF8, 0x05, 0x74, 0x08,
];

/// The GameInput control-filter mask the reading consumer tests (`test ebx, 0x40020`): the consumer's
/// own marker, and the one thing that tells it apart from the queue task the same service registers.
const PAD_FILTER: &[u8] = &[0x20, 0x00, 0x04, 0x00];

/// An address resolved at attach, 0 while missing.
fn set(slot: &AtomicUsize, value: Option<usize>) {
    slot.store(value.unwrap_or(0), Ordering::Release);
}

fn get(slot: &AtomicUsize) -> Option<usize> {
    match slot.load(Ordering::Acquire) {
        0 => None,
        address => Some(address),
    }
}

/// The hardware-thread function that calls `core.drain` once per frame (`MinecraftGame::update`).
static FRAME: AtomicUsize = AtomicUsize::new(0);
/// The local player's movement system: the per-simulation-tick event and the only place the player's
/// components are read.
static SYSTEM: AtomicUsize = AtomicUsize::new(0);
/// The generic EnTT storage getter: `accessor + 0x30`, component hash in, storage out.
static GETTER: AtomicUsize = AtomicUsize::new(0);
/// The function that runs when this process starts its own (local) server.
static LOCAL_SERVER: AtomicUsize = AtomicUsize::new(0);
/// One simulation step (`Minecraft::update`), called by the server thread's loop.
static SIM_UPDATE: AtomicUsize = AtomicUsize::new(0);
/// The engine's own pause switch (`_setPaused(Minecraft*, bool)`).
static SIM_PAUSE: AtomicUsize = AtomicUsize::new(0);
/// The server-side command dispatcher (`MinecraftCommands::_dispatch`).
static COMMAND_DISPATCHER: AtomicUsize = AtomicUsize::new(0);
/// The synchronous command entry (`executeCommand`), which builds and destroys its own request.
static COMMAND_EXECUTE: AtomicUsize = AtomicUsize::new(0);
/// The `CommandRequest` constructor (`executeCommand`'s callee).
static COMMAND_REQUEST: AtomicUsize = AtomicUsize::new(0);
/// `CommandOrigin::fromData`: builds a player origin with the game's own allocator.
static COMMAND_ORIGIN: AtomicUsize = AtomicUsize::new(0);
/// `CommandOutput::addMessage`: where every command body writes its feedback.
static COMMAND_ADD_MESSAGE: AtomicUsize = AtomicUsize::new(0);
/// `MinecraftCommands`' own run entry (`(commands, result, request, fromCommand)`), hooked to record
/// the manager the server's packet handler runs a player's chat line with.
static COMMAND_RUN: AtomicUsize = AtomicUsize::new(0);
/// The dispatcher's call into [`COMMAND_RUN`]: `mov rcx, rbx; mov rdx, rsi; mov r8, rdi; xor r9d, r9d;
/// call rel32`.
const COMMAND_RUN_CALL: &[u8] = &[0x48, 0x89, 0xD9, 0x48, 0x89, 0xF2, 0x49, 0x89, 0xF8, 0x45, 0x31, 0xC9, 0xE8];
/// The GameInput reading consumer: the per-reading callback that turns a pad reading into input.
static INPUT_PAD: AtomicUsize = AtomicUsize::new(0);
static OPTIONS_REGISTRY: AtomicUsize = AtomicUsize::new(0);
static OPTIONS_VTABLE: AtomicUsize = AtomicUsize::new(0);
static OPTIONS_OBJECT: AtomicUsize = AtomicUsize::new(0);
static OPTIONS_SEEN: core::sync::atomic::AtomicBool = core::sync::atomic::AtomicBool::new(false);
/// The level data's tag lookup and the static `HashedString` key `"GameType"` it is called with, both
/// decoded from the one call site in `LevelData::getTagData`.
static GAME_TYPE_LOOKUP: AtomicUsize = AtomicUsize::new(0);
static GAME_TYPE_KEY: AtomicUsize = AtomicUsize::new(0);

/// Objects the running game creates; their recipes are runtime, so they are 0 until one resolves.
static COMMAND_COMMANDS: AtomicUsize = AtomicUsize::new(0);
static SERVER_INSTANCE: AtomicUsize = AtomicUsize::new(0);
static LEVEL_DATA: AtomicUsize = AtomicUsize::new(0);

/// The anchor names, in the order `engine.status` reports them.
pub const NAMES: &[&str] = &[
    "frame",
    "system.player",
    "component.getter",
    "local.server",
    "sim.update",
    "sim.pause",
    "command.dispatcher",
    "command.execute",
    "command.request",
    "command.origin",
    "command.add_message",
    "command.run",
    "command.commands",
    "server.instance",
    "level.data",
    "options.registry",
    "options.vtable",
    "options.object",
    "input.pad",
    // The level data's tag lookup, called with the static `GameType` key on the server thread.
    "world.gameType",
];

pub fn frame() -> Option<usize> {
    get(&FRAME)
}

pub fn system() -> Option<usize> {
    get(&SYSTEM)
}

/// The generic storage getter.
///
/// # Safety
/// It may create a storage in the registry, so it must run on the thread that owns the entity
/// context — the game's own tick, which is where [`crate::hooks::player_system`] calls it.
pub fn getter() -> Option<usize> {
    get(&GETTER)
}

pub fn local_server() -> Option<usize> {
    get(&LOCAL_SERVER)
}

/// The simulation step: the per-tick boundary and the only source of `Minecraft*`.
pub fn sim_update() -> Option<usize> {
    get(&SIM_UPDATE)
}

/// `_setPaused(Minecraft*, bool)`: the engine's own pause/resume switch.
pub fn sim_pause() -> Option<usize> {
    get(&SIM_PAUSE)
}

pub fn command_execute() -> Option<usize> {
    get(&COMMAND_EXECUTE)
}

/// The dispatcher (`0x577ac10`): entered for every command the game runs, its own included.
pub fn command_dispatcher() -> Option<usize> {
    get(&COMMAND_DISPATCHER)
}

/// `CommandOrigin::fromData`, the game's own origin builder (it allocates with the game's allocator).
pub fn command_origin() -> Option<usize> {
    get(&COMMAND_ORIGIN)
}

/// `CommandOutput::addMessage`, hooked to capture a command's feedback.
pub fn command_add_message() -> Option<usize> {
    get(&COMMAND_ADD_MESSAGE)
}

/// `MinecraftCommands`' run entry, hooked to record the server's own manager.
pub fn command_run() -> Option<usize> {
    get(&COMMAND_RUN)
}

/// The GameInput reading consumer, hooked to neutralize a pad while the lock is on.
pub fn input_pad() -> Option<usize> {
    get(&INPUT_PAD)
}

pub fn options_registry() -> Option<usize> {
    get(&OPTIONS_REGISTRY)
}

/// The `Options` object, captured when the game registers its options (0 until it does).
pub fn options_object() -> Option<usize> {
    get(&OPTIONS_OBJECT)
}

/// Records the `Options` object the registration function was entered with.
pub fn set_options_object(object: usize) {
    if object != 0 && !OPTIONS_SEEN.swap(true, Ordering::AcqRel) {
        OPTIONS_OBJECT.store(object, Ordering::Release);
        agent_core::log::fmt(format_args!("options: registration entered with 0x{:x}", object));
    }
}

/// The server's command manager (`MinecraftCommands*`), 0 until the game itself runs a command with it
/// on the server thread (see [`crate::hooks`]).
pub fn command_commands() -> Option<usize> {
    get(&COMMAND_COMMANDS)
}

/// Forgets the command manager of a level that is no longer loaded.
pub fn clear_command_commands() {
    COMMAND_COMMANDS.store(0, Ordering::Release);
}

/// Records the manager the game ran a command with on the server thread; a different one replaces it
/// (the game's own call is the authority) and is logged.
pub fn set_command_commands(commands: usize) {
    if commands != 0 && COMMAND_COMMANDS.swap(commands, Ordering::AcqRel) != commands {
        agent_core::log::fmt(format_args!("command: MinecraftCommands at 0x{:x}", commands));
    }
}

/// The local server (`ServerInstance*`), 0 until [`crate::live`] resolves it.
pub fn server_instance() -> Option<usize> {
    get(&SERVER_INSTANCE)
}

pub fn set_server_instance(server: usize) {
    if server != 0 && SERVER_INSTANCE.load(Ordering::Acquire) == 0 {
        SERVER_INSTANCE.store(server, Ordering::Release);
        agent_core::log::fmt(format_args!("command: ServerInstance at 0x{:x}", server));
    }
}

/// The loaded level's own data (`LevelData*`), set by [`crate::world`] once it locates it; reported by
/// `engine.status`, and 0 until then.
pub fn set_level_data(level_data: usize) {
    if level_data != 0 && LEVEL_DATA.load(Ordering::Acquire) == 0 {
        LEVEL_DATA.store(level_data, Ordering::Release);
        agent_core::log::fmt(format_args!("world: LevelData at 0x{:x}", level_data));
    }
}

/// The loaded world's `LevelData*`, once [`crate::world`] has located it.
pub fn level_data() -> Option<usize> {
    get(&LEVEL_DATA)
}

/// Forgets the level data of a world that is no longer loaded.
pub fn clear_level_data() {
    LEVEL_DATA.store(0, Ordering::Release);
}

/// FNV-1a 32 of a plain type name: the ECS component hash the game itself computes for a component
/// (`StateVectorComponent` → the immediate its accessor is called with).
pub fn component_hash(name: &str) -> u32 {
    let mut hash: u32 = 0x811C_9DC5;
    for byte in name.as_bytes() {
        hash = (hash ^ *byte as u32).wrapping_mul(0x0100_0193);
    }
    hash
}

/// The image-wide resolution pass. Logs each recipe's outcome and leaves unresolved anchors at 0.
pub fn resolve(image: &Image) -> Vec<Anchor> {
    let log = |text: alloc::string::String| agent_core::log::line(&text);

    /* ---- the frame hook: the assert-metadata triple, body-checked by its size ---- */
    let frame = pe::named_function(image, b"MinecraftGame::update(void)").filter(|function| {
        // `void __cdecl update(void)`: a real frame body, not a stub or a thunk.
        pe::function_of(image, *function).is_some_and(|(start, end)| end - start >= 0x400)
    });
    set(&FRAME, frame);
    log(alloc::format!("resolve frame: {}", describe(image, FRAME.load(Ordering::Acquire))));

    /* ---- component hashes: one pass for every hash the engine uses ---- */
    let names = ["LocalPlayerComponent", "StateVectorComponent", "LocalMoveVelocityComponent", "ActorRotationComponent", "OnGroundFlagComponent"];
    let hashes = names.map(component_hash);
    let hits = pe::scan_u32(image, &hashes);
    let functions: Vec<Vec<usize>> = hits.iter().map(|sites| pe::functions_of(image, sites)).collect();

    /* ---- the local player system: the smallest function holding all three hashes ---- */
    let mut candidates: Vec<usize> = Vec::new();
    if let (Some(local), Some(state), Some(velocity)) = (functions.first(), functions.get(1), functions.get(2)) {
        for function in local {
            if state.contains(function) && velocity.contains(function) && !candidates.contains(function) {
                candidates.push(*function);
            }
        }
    }
    candidates.sort_by_key(|function| pe::function_of(image, *function).map(|(start, end)| end - start).unwrap_or(usize::MAX));
    let system = candidates
        .iter()
        .copied()
        .find(|function| pe::function_of(image, *function).is_some_and(|(start, end)| (0x100..=0x8000).contains(&(end - start))));
    set(&SYSTEM, system);
    log(alloc::format!("resolve system.player: {} candidates, chosen {}", candidates.len(), describe(image, SYSTEM.load(Ordering::Acquire))));

    /* ---- the generic storage getter: the call after the StateVectorComponent hash immediate
       inside that system, i.e. `mov edx, <hash>; call <getter>` with rcx = the accessor ---- */
    let getter = match (system, hits.get(1)) {
        (Some(system), Some(sites)) => {
            let (start, end) = pe::function_of(image, system).unwrap_or((system, system));
            sites.iter().filter(|site| **site >= start && **site < end).find_map(|site| accessor_call(image, *site))
        }
        _ => None,
    };
    set(&GETTER, getter);
    log(alloc::format!("resolve component.getter: {}", describe(image, GETTER.load(Ordering::Acquire))));

    /* ---- string anchors, all in one reference pass ---- */
    let strings = [
        b"Starting local server".as_slice(),
        b"onStartLocalServer".as_slice(),
        b"commands.generic.unknown".as_slice(),
        b"gfx_viewdistance".as_slice(),
        b"audio_sound".as_slice(),
        b"game_thirdperson".as_slice(),
        b"Minecraft update".as_slice(),
        b"Failed to Create TaskQueue for GameInput callbacks".as_slice(),
    ];
    let addresses: Vec<Option<usize>> = strings.iter().map(|text| image.find_string(text)).collect();
    let targets: Vec<usize> = addresses.iter().flatten().copied().collect();
    let refs = pe::scan_refs(image, &targets);
    let referenced = |index: usize| -> Option<Vec<usize>> {
        let address = addresses.get(index).copied().flatten()?;
        let position = targets.iter().position(|target| *target == address)?;
        let sites = refs.get(position)?;
        (!sites.is_empty()).then(|| pe::functions_of(image, sites))
    };

    /* ---- in-world: the function that starts this process's own server ---- */
    let local = referenced(0).filter(|functions| functions.len() == 1).map(|functions| functions[0]);
    let local = local.or_else(|| referenced(1).filter(|functions| functions.len() == 1).map(|functions| functions[0]));
    set(&LOCAL_SERVER, local);
    log(alloc::format!("resolve local.server: {}", describe(image, LOCAL_SERVER.load(Ordering::Acquire))));

    /* ---- commands: the smallest function that references the unknown-command key ---- */
    let dispatcher = referenced(2).and_then(|mut functions| {
        functions.sort_by_key(|function| pe::function_of(image, *function).map(|(start, end)| end - start).unwrap_or(usize::MAX));
        functions.first().copied()
    });
    set(&COMMAND_DISPATCHER, dispatcher);
    log(alloc::format!("resolve command.dispatcher: {}", describe(image, COMMAND_DISPATCHER.load(Ordering::Acquire))));

    /* ---- the manager's own run entry: the dispatcher hands a parsed request to it with
       `mov rcx, rbx; mov rdx, rsi; mov r8, rdi; xor r9d, r9d; call`, and the server's packet handler
       calls the same function with its own `MinecraftCommands*` ---- */
    let run = dispatcher.and_then(|dispatcher| {
        let (start, end) = pe::function_of(image, dispatcher)?;
        let body = pe::bytes(start, end - start)?;
        let mut found: Option<usize> = None;
        for (offset, window) in body.windows(COMMAND_RUN_CALL.len() + 4).enumerate() {
            if &window[..COMMAND_RUN_CALL.len()] != COMMAND_RUN_CALL {
                continue;
            }
            let relative = i32::from_le_bytes(window[COMMAND_RUN_CALL.len()..].try_into().ok()?) as i64;
            let target = (start as i64 + offset as i64 + window.len() as i64 + relative) as usize;
            if pe::function_of(image, target).map(|(entry, _)| entry) != Some(target) {
                return None;
            }
            if found.is_some_and(|other| other != target) {
                return None; // ambiguous: refuse rather than pick one
            }
            found = Some(target);
        }
        found
    });
    set(&COMMAND_RUN, run);
    log(alloc::format!("resolve command.run: {}", describe(image, COMMAND_RUN.load(Ordering::Acquire))));

    /* ---- the synchronous command entry: the dispatcher's caller that is not dispatched through a
       table (the queued path is a vtable slot; the synchronous path is a direct call) ---- */
    let execute = dispatcher.and_then(|dispatcher| {
        let mut found = None;
        for site in pe::callers(image, dispatcher) {
            let Some(start) = image.function_start(site) else {
                continue;
            };
            if start == dispatcher || pe::is_vtable_slot(image, start) {
                continue;
            }
            if found.is_some() {
                return None; // ambiguous: refuse rather than pick one
            }
            found = Some(start);
        }
        found
    });
    set(&COMMAND_EXECUTE, execute);
    log(alloc::format!("resolve command.execute: {}", describe(image, COMMAND_EXECUTE.load(Ordering::Acquire))));

    /* ---- the request constructor and the origin builder: masked signatures, each at a function
       entry exactly once ---- */
    let request = pe::signature_function(image, REQUEST_CTOR);
    set(&COMMAND_REQUEST, request);
    let origin = pe::signature_function(image, ORIGIN_FROM_DATA);
    set(&COMMAND_ORIGIN, origin);
    log(alloc::format!(
        "resolve command.request: {}, command.origin: {}",
        describe(image, COMMAND_REQUEST.load(Ordering::Acquire)),
        describe(image, COMMAND_ORIGIN.load(Ordering::Acquire))
    ));

    /* ---- the message sink: the dispatcher callee called more than once that clears a type-1 output
       first (`cmp dword ptr [rcx], 1`) ---- */
    let add_message = dispatcher.and_then(|dispatcher| {
        let Some((start, end)) = pe::function_of(image, dispatcher) else {
            return None;
        };
        let calls = pe::callees(image, start, end);
        let mut found: Option<usize> = None;
        for target in calls.iter().copied() {
            if calls.iter().filter(|other| **other == target).count() < 2 {
                continue;
            }
            if !pe::has_pattern(target, 0x100, &[0x83, 0x39, 0x01]) {
                continue;
            }
            if found.is_some() && found != Some(target) {
                return None;
            }
            found = Some(target);
        }
        found
    });
    set(&COMMAND_ADD_MESSAGE, add_message);
    log(alloc::format!("resolve command.add_message: {}", describe(image, COMMAND_ADD_MESSAGE.load(Ordering::Acquire))));

    /* ---- simulation step: the profiler label only that body references ("Minecraft update"),
       and the body writes floats (it is the tick loop, not a logger) ---- */
    let sim_update = referenced(6)
        .filter(|functions| functions.len() == 1)
        .map(|functions| functions[0])
        .filter(|function| {
            pe::function_of(image, *function)
                .is_some_and(|(start, end)| pe::has_pattern(start, end - start, &[0xF3, 0x0F, 0x11]))
        });
    set(&SIM_UPDATE, sim_update);
    log(alloc::format!("resolve sim.update: {}", describe(image, SIM_UPDATE.load(Ordering::Acquire))));

    /* ---- the pause switch: a small function that loads the simulation timer from [this+0xe8],
       stores a float to [timer+0x3c], touches [this+0xf0] and calls the Level through a vtable ---- */
    let sim_pause = pause_setter(image);
    set(&SIM_PAUSE, sim_pause);
    log(alloc::format!("resolve sim.pause: {}", describe(image, SIM_PAUSE.load(Ordering::Acquire))));

    /* ---- the GameInput reading consumer: the service that creates the callback queue hands code
       pointers to two register calls; the consumer is the one whose body tests the control filter ---- */
    let pad = referenced(7)
        .filter(|functions| functions.len() == 1)
        .map(|functions| functions[0])
        .and_then(|service| {
            let (start, end) = pe::function_of(image, service)?;
            let mut found: Option<usize> = None;
            for candidate in pe::lea_function_targets(image, start, end) {
                if candidate == service {
                    continue;
                }
                let Some((candidate_start, candidate_end)) = pe::function_of(image, candidate) else {
                    continue;
                };
                if !pe::has_pattern(candidate_start, candidate_end - candidate_start, PAD_FILTER) {
                    continue;
                }
                if found.is_some() && found != Some(candidate) {
                    return None;
                }
                found = Some(candidate);
            }
            found
        });
    set(&INPUT_PAD, pad);
    log(alloc::format!("resolve input.pad: {}", describe(image, INPUT_PAD.load(Ordering::Acquire))));

    /* ---- options: the registration function, agreed on by every save tag it references ---- */
    let mut votes: Vec<usize> = Vec::new();
    for index in 3..=5 {
        if let Some(functions) = referenced(index) {
            for function in functions {
                votes.push(function);
            }
        }
    }
    let registry = votes
        .iter()
        .copied()
        .find(|function| votes.iter().filter(|other| *other == function).count() >= 2);
    set(&OPTIONS_REGISTRY, registry);
    log(alloc::format!("resolve options.registry: {}", describe(image, OPTIONS_REGISTRY.load(Ordering::Acquire))));

    /* ---- the Options vtable: the registry append resolved from its own store instruction, then the
       .rdata table that holds it as slot 0x88 (see `crate::options`) ---- */
    let vtable = crate::options::resolve(image);
    set(&OPTIONS_VTABLE, vtable);
    log(alloc::format!("resolve options.vtable: {}", describe(image, OPTIONS_VTABLE.load(Ordering::Acquire))));

    /* ---- the level's game type: `LevelData::getTagData` writes the "GameType" tag from
       `lookup(levelData, &KEY)` right before its `movabs rbx, "GameType"` (see `game_type_site`) ---- */
    let (lookup, key) = game_type_site(image).unzip();
    set(&GAME_TYPE_LOOKUP, lookup);
    set(&GAME_TYPE_KEY, key);
    log(alloc::format!(
        "resolve world.gameType: lookup {}, key {}",
        describe(image, GAME_TYPE_LOOKUP.load(Ordering::Acquire)),
        describe(image, GAME_TYPE_KEY.load(Ordering::Acquire))
    ));

    /* ---- what is still missing: named, never guessed ---- */
    report()
}

/// The level data's tag lookup and the `"GameType"` key, when both resolve.
pub fn game_type() -> Option<(usize, usize)> {
    Some((get(&GAME_TYPE_LOOKUP)?, get(&GAME_TYPE_KEY)?))
}

/// The bytes `getTagData` runs to read the game type, ending right before `movabs rbx, "GameType"`:
/// `lea rdx, [rip+KEY]`, `mov rcx, rdi`, `call LOOKUP`, `mov r8d, 5` (the default), `test rax, rax`,
/// `je`, `cmp byte [rax+0x20], 5` (the value's type), `jne`, `mov r8d, [rax]`, then the three stores
/// that build the tag name's `std::string`. 0xFF bytes are the two rel32 fields, compared masked.
const GAME_TYPE_READ: &[u8] = &[
    0x48, 0x8D, 0x15, 0xFF, 0xFF, 0xFF, 0xFF, 0x48, 0x89, 0xF9, 0xE8, 0xFF, 0xFF, 0xFF, 0xFF, 0x41, 0xB8, 0x05, 0x00,
    0x00, 0x00, 0x48, 0x85, 0xC0, 0x74, 0x09, 0x80, 0x78, 0x20, 0x05, 0x75, 0x03, 0x44, 0x8B, 0x00,
];
/// `movabs rbx, "GameType"`: the tag name as one immediate, present once in the image.
const GAME_TYPE_NAME: &[u8] = &[0x48, 0xBB, b'G', b'a', b'm', b'e', b'T', b'y', b'p', b'e'];
/// The three `mov qword [rbp+…], imm32` (24 bytes) between the read and the name.
const GAME_TYPE_GAP: usize = 24;

/// The lookup function and the key from the one `getTagData` site: the name must occur exactly once in
/// code, the read must sit right before it, the lookup must be a function entry and the key must be in
/// the image's data.
fn game_type_site(image: &Image) -> Option<(usize, usize)> {
    let code = pe::code(image)?;
    let bytes = code.bytes;
    let mut found: Option<usize> = None;
    for (offset, window) in bytes.windows(GAME_TYPE_NAME.len()).enumerate() {
        if window == GAME_TYPE_NAME {
            if found.is_some() {
                return None; // ambiguous: refuse rather than pick one
            }
            found = Some(offset);
        }
    }
    let name = found?;
    let read = name.checked_sub(GAME_TYPE_GAP + GAME_TYPE_READ.len())?;
    let shape = &bytes[read..read + GAME_TYPE_READ.len()];
    let masked = |index: usize| (3..7).contains(&index) || (11..15).contains(&index);
    if !shape.iter().zip(GAME_TYPE_READ).enumerate().all(|(index, (byte, want))| masked(index) || byte == want) {
        return None;
    }
    let at = code.va + read;
    let key_relative = i32::from_le_bytes(shape[3..7].try_into().ok()?) as i64;
    let key = (at as i64 + 7 + key_relative) as usize;
    let call_relative = i32::from_le_bytes(shape[11..15].try_into().ok()?) as i64;
    let lookup = (at as i64 + 15 + call_relative) as usize;
    let (start, _) = pe::function_of(image, lookup)?;
    (start == lookup && pe::in_image_data(key)).then_some((lookup, key))
}

/// The call target after a `mov edx, <imm32>` at `site - 1`, when the next instruction is a direct
/// call to a function entry: the generic storage getter.
fn accessor_call(image: &Image, site: usize) -> Option<usize> {
    if pe::read::<u8>(site.checked_sub(1)?)? != 0xBA {
        return None;
    }
    if pe::read::<u8>(site + 4)? != 0xE8 {
        return None;
    }
    let relative = pe::read::<i32>(site + 5)? as i64;
    let target = (site as i64 + 9 + relative) as usize;
    let (start, _) = pe::function_of(image, target)?;
    (start == target).then_some(target)
}

fn describe(image: &Image, address: usize) -> alloc::string::String {
    if address == 0 {
        return alloc::string::String::from("missing");
    }
    match pe::function_of(image, address) {
        Some((start, end)) => alloc::format!("0x{:x} (fn 0x{:x}+0x{:x})", address - image.base(), start - image.base(), end - start),
        None => alloc::format!("0x{:x}", address - image.base()),
    }
}

/// The anchor table `engine.status` reports: every name with its address, 0 for missing.
pub fn report() -> Vec<Anchor> {
    let mut anchors = Vec::with_capacity(NAMES.len());
    for name in NAMES {
        let address = match *name {
            "frame" => FRAME.load(Ordering::Acquire),
            "system.player" => SYSTEM.load(Ordering::Acquire),
            "component.getter" => GETTER.load(Ordering::Acquire),
            "local.server" => LOCAL_SERVER.load(Ordering::Acquire),
            "sim.update" => SIM_UPDATE.load(Ordering::Acquire),
            "sim.pause" => SIM_PAUSE.load(Ordering::Acquire),
            "command.dispatcher" => COMMAND_DISPATCHER.load(Ordering::Acquire),
            "command.execute" => COMMAND_EXECUTE.load(Ordering::Acquire),
            "command.request" => COMMAND_REQUEST.load(Ordering::Acquire),
            "command.origin" => COMMAND_ORIGIN.load(Ordering::Acquire),
            "command.add_message" => COMMAND_ADD_MESSAGE.load(Ordering::Acquire),
            "command.run" => COMMAND_RUN.load(Ordering::Acquire),
            "command.commands" => COMMAND_COMMANDS.load(Ordering::Acquire),
            "server.instance" => SERVER_INSTANCE.load(Ordering::Acquire),
            "level.data" => LEVEL_DATA.load(Ordering::Acquire),
            "options.registry" => OPTIONS_REGISTRY.load(Ordering::Acquire),
            "options.vtable" => OPTIONS_VTABLE.load(Ordering::Acquire),
            "options.object" => OPTIONS_OBJECT.load(Ordering::Acquire),
            "input.pad" => INPUT_PAD.load(Ordering::Acquire),
            "world.gameType" => GAME_TYPE_LOOKUP.load(Ordering::Acquire),
            _ => 0,
        };
        anchors.push(Anchor { name, addr: address });
    }
    anchors
}

/// `component.getter` and `system.player` and `frame` must all be present for anything to work.
pub fn attached() -> bool {
    frame().is_some() && system().is_some() && getter().is_some()
}

/// The engine's pause switch, from its code shape: the only small function that reads the
/// simulation timer as `[this+0xe8]`, writes a float to `[timer+0x3c]`, touches `[this+0xf0]` (the
/// auxiliary timer) and makes an indirect call (the `Level::setPaused` vtable slot).
fn pause_setter(image: &Image) -> Option<usize> {
    let code = pe::code(image)?;
    let bytes = code.bytes;
    let mut candidates: Vec<usize> = Vec::new();
    let mut offset = 0usize;
    while offset + 7 <= bytes.len() {
        // `mov rdi|rax|rcx, [rcx + 0xe8]`
        if bytes[offset] == 0x48 && bytes[offset + 1] == 0x8B && matches!(bytes[offset + 2], 0xB9 | 0x81 | 0x89) && bytes[offset + 3..offset + 7] == [0xE8, 0x00, 0x00, 0x00] {
            if let Some(start) = image.function_start(code.va + offset) {
                if !candidates.contains(&start) {
                    candidates.push(start);
                }
            }
        }
        offset += 1;
    }
    let mut found = None;
    for candidate in candidates {
        let Some((start, end)) = pe::function_of(image, candidate) else {
            continue;
        };
        if end - start > 0x400 {
            continue;
        }
        let Some(body) = pe::bytes(start, end - start) else {
            continue;
        };
        // `movss [x + 0x3c], xmm`: mod = 01, rm = 0x3c.
        let stores_step = (0..body.len().saturating_sub(5)).any(|index| {
            body[index..index + 3] == [0xF3, 0x0F, 0x11] && (body[index + 3] >> 6) == 1 && body[index + 4] == 0x3C
        });
        let touches_aux = body.windows(4).any(|window| window == [0xF0, 0x00, 0x00, 0x00]);
        let indirect_call = body.windows(2).any(|window| window == [0xFF, 0x15]);
        if stores_step && touches_aux && indirect_call {
            if found.is_some() {
                // Ambiguous: refuse rather than guess which one pauses the simulation.
                return None;
            }
            found = Some(start);
        }
    }
    found
}
