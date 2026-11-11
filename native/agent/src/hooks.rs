//! The engine's hooks: one per function the agent has to observe.
//!
//! Every hook either installs completely or not at all ([`agent_core::hook`] refuses a prologue it
//! cannot relocate, or a target its relay cannot reach), so a failed install leaves the game's code
//! untouched and its anchor still reported as resolved — the feature it feeds then answers `-32001`
//! on its own missing anchor. A replacement forwards the call it hooked: the arguments it does not
//! need are passed through unchanged, and the value the original returns is returned to the caller,
//! so a hooked function behaves exactly as before.
//!
//! Each site is declared for `engine.status.hooks` (installed or not) and counts its calls and the
//! first thread it ran on, so a build where one game path never runs is visible in the status instead
//! of only in a timeout.

use core::mem::transmute;
use core::sync::atomic::{AtomicUsize, Ordering};

use agent_core::{hook, lock, log, message_loop};

use crate::{anchors, command, live, pe};

/// `engine.status.hooks` names. Registration and firing use the same constant, so a site cannot be
/// counted under one name and reported under another.
const SITE_FRAME: &str = "frame";
const SITE_PLAYER: &str = "system.player";
const SITE_SERVER: &str = "local.server";
const SITE_SIM: &str = "sim.update";
const SITE_OPTIONS: &str = "options.registry";
const SITE_EXECUTE: &str = "command.execute";
const SITE_MESSAGE: &str = "command.add_message";
const SITE_PAD: &str = "input.pad";
/// The dispatcher: the one place a real `CommandOriginData` can be captured (its `r8`).
const SITE_DISPATCH: &str = "command.dispatcher";
/// The generic `getStorage(accessor, hash)`: where the registry accessor is captured, every tick.
const SITE_GETTER: &str = "component.getter";
/// `CommandOrigin::fromData`: the only builder of a player origin, and where a real call is recorded.
const SITE_ORIGIN: &str = "command.origin";
/// `MinecraftCommands`' run entry: where the server's own manager is recorded.
const SITE_RUN: &str = "command.run";

/// Where each hook's trampoline (the relocated original) lives. 0 = not installed.
static FRAME: AtomicUsize = AtomicUsize::new(0);
static PLAYER_SYSTEM: AtomicUsize = AtomicUsize::new(0);
static LOCAL_SERVER: AtomicUsize = AtomicUsize::new(0);
static SIM_UPDATE: AtomicUsize = AtomicUsize::new(0);
static OPTIONS: AtomicUsize = AtomicUsize::new(0);
static COMMAND_EXECUTE: AtomicUsize = AtomicUsize::new(0);
static ADD_MESSAGE: AtomicUsize = AtomicUsize::new(0);
static INPUT_PAD: AtomicUsize = AtomicUsize::new(0);
static DISPATCHER: AtomicUsize = AtomicUsize::new(0);
static GETTER: AtomicUsize = AtomicUsize::new(0);
static ORIGIN_BUILD: AtomicUsize = AtomicUsize::new(0);
static COMMAND_RUN: AtomicUsize = AtomicUsize::new(0);

/// Installs every hook whose anchor resolved. Called once, from `Engine::attach`.
pub fn install() {
    hook_one(SITE_FRAME, anchors::frame(), frame as *const () as usize, &FRAME);
    hook_one(SITE_PLAYER, anchors::system(), player_system as *const () as usize, &PLAYER_SYSTEM);
    hook_one(SITE_SERVER, anchors::local_server(), local_server as *const () as usize, &LOCAL_SERVER);
    hook_one(SITE_SIM, anchors::sim_update(), sim_update as *const () as usize, &SIM_UPDATE);
    hook_one(SITE_OPTIONS, anchors::options_registry(), options_register as *const () as usize, &OPTIONS);
    hook_one(SITE_EXECUTE, anchors::command_execute(), execute_command as *const () as usize, &COMMAND_EXECUTE);
    hook_one(SITE_MESSAGE, anchors::command_add_message(), add_message as *const () as usize, &ADD_MESSAGE);
    hook_one(SITE_PAD, anchors::input_pad(), pad_reading as *const () as usize, &INPUT_PAD);
    hook_one(SITE_DISPATCH, anchors::command_dispatcher(), dispatcher as *const () as usize, &DISPATCHER);
    hook_one(SITE_GETTER, anchors::getter(), component_getter as *const () as usize, &GETTER);
    hook_one(SITE_ORIGIN, anchors::command_origin(), origin_from_data as *const () as usize, &ORIGIN_BUILD);
    hook_one(SITE_RUN, anchors::command_run(), command_run as *const () as usize, &COMMAND_RUN);
    // The window-message loop: the drain point that exists even when the per-frame function above is
    // never called by this build. It declares its own sites.
    message_loop::install();
}

fn hook_one(name: &'static str, target: Option<usize>, replacement: usize, trampoline: &AtomicUsize) {
    let core = agent_core::hub::started();
    let Some(target) = target else {
        if let Some(core) = core {
            core.site(name, false);
        }
        return;
    };
    match hook::install_published(target, replacement, trampoline) {
        Some(installed) => {
            record(name, target, installed.trampoline);
            if let Some(core) = core {
                core.site(name, true);
            }
            log::fmt(format_args!("hook {name}: installed at 0x{:x}", target));
        }
        None => {
            if let Some(core) = core {
                core.site(name, false);
            }
            log::fmt(format_args!("hook {name}: refused, game code untouched"));
        }
    }
}

/// The inline hooks as installed, for the watchdog: name, entry and the trampoline the entry must
/// still jump to (through a relay, so the check is "the entry is a `jmp` into our relay"). 0 = empty.
const WATCHED: usize = 12;
static WATCH: [(AtomicUsize, AtomicUsize); WATCHED] = [
    (AtomicUsize::new(0), AtomicUsize::new(0)),
    (AtomicUsize::new(0), AtomicUsize::new(0)),
    (AtomicUsize::new(0), AtomicUsize::new(0)),
    (AtomicUsize::new(0), AtomicUsize::new(0)),
    (AtomicUsize::new(0), AtomicUsize::new(0)),
    (AtomicUsize::new(0), AtomicUsize::new(0)),
    (AtomicUsize::new(0), AtomicUsize::new(0)),
    (AtomicUsize::new(0), AtomicUsize::new(0)),
    (AtomicUsize::new(0), AtomicUsize::new(0)),
    (AtomicUsize::new(0), AtomicUsize::new(0)),
    (AtomicUsize::new(0), AtomicUsize::new(0)),
    (AtomicUsize::new(0), AtomicUsize::new(0)),
];
/// Hook names, parallel to `WATCH`.
static WATCH_NAMES: [&str; WATCHED] =
    [SITE_FRAME, SITE_PLAYER, SITE_SERVER, SITE_SIM, "", SITE_OPTIONS, SITE_EXECUTE, SITE_MESSAGE, SITE_PAD, "", "", ""];
/// Entries already reported as taken over, so the check logs once per hook.
static WATCH_REPORTED: AtomicUsize = AtomicUsize::new(0);
/// The last watchdog run (`GetTickCount64`).
static WATCH_AT: core::sync::atomic::AtomicU64 = core::sync::atomic::AtomicU64::new(0);

/// Remembers one installed hook for [`watch`].
fn record(name: &'static str, target: usize, trampoline: usize) {
    for (index, (entry, at)) in WATCH.iter().enumerate() {
        if WATCH_NAMES[index] != name {
            continue;
        }
        entry.store(target, Ordering::Release);
        at.store(trampoline, Ordering::Release);
        return;
    }
}

/// Checks, at most once a second, that every installed entry still starts with our `jmp`.
///
/// Another mod that hooks the same function *after* us rewrites the entry, and the hook silently
/// stops firing. This tells that apart from the other failure a live session showed — our `jmp` still
/// in place, and the game reaching the code by a route that never passes the entry (a detour whose
/// trampoline jumps back into the body):
///
/// * the entry is `E9` to a relay of *this* DLL: intact, nothing to say;
/// * the entry is anything else (a foreign `E9`, a `FF 25`, or the original bytes): reported once with
///   what is there now, and the site is marked not installed. Re-patching over another mod's detour
///   would fight it and could break the mod, and the entry is no longer what the game calls, so the
///   honest answer is "this hook is not ours any more" — which is exactly what `engine.status` shows.
pub fn watch() {
    let now = agent_core::win::tick_ms();
    if now.saturating_sub(WATCH_AT.load(Ordering::Relaxed)) < 1_000 {
        return;
    }
    WATCH_AT.store(now, Ordering::Relaxed);
    for (index, (entry, _)) in WATCH.iter().enumerate() {
        let target = entry.load(Ordering::Acquire);
        if target == 0 || WATCH_REPORTED.load(Ordering::Acquire) & (1 << index) != 0 {
            continue;
        }
        if jumps_into_this_dll(target) {
            continue;
        }
        WATCH_REPORTED.fetch_or(1 << index, Ordering::AcqRel);
        log::fmt(format_args!(
            "hook {}: entry 0x{:x} no longer holds our jmp ({}); the hook is not firing",
            WATCH_NAMES[index],
            target,
            describe_entry(target)
        ));
        if let Some(core) = agent_core::hub::started() {
            core.site(WATCH_NAMES[index], false);
        }
    }
}

/// True when the entry at `target` is a `jmp` whose relay points into this DLL.
fn jumps_into_this_dll(target: usize) -> bool {
    let Some(bytes) = pe::bytes(target, 8) else {
        return false;
    };
    if bytes[0] != 0xE9 {
        return false;
    }
    let delta = i32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as i64;
    let relay = (target as i64 + 5 + delta) as usize;
    let Some(stub) = pe::bytes(relay, 16) else {
        return false;
    };
    // The relay is `FF 25 00 00 00 00 <address>`; the address is what our entry jumps to.
    if stub[0] != 0xFF || stub[1] != 0x25 {
        return false;
    }
    let replacement = usize::from_le_bytes([stub[6], stub[7], stub[8], stub[9], stub[10], stub[11], stub[12], stub[13]]);
    let ours = agent_core::win::module_from_address(watch as *const () as usize);
    replacement != 0 && agent_core::win::module_from_address(replacement) == ours
}

/// The first bytes of a hook entry, for the watchdog's log line.
fn describe_entry(target: usize) -> alloc::string::String {
    let Some(bytes) = pe::bytes(target, 8) else {
        return alloc::string::String::from("unreadable");
    };
    if bytes[0] == 0xE9 {
        let delta = i32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as i64;
        return alloc::format!("jmp to 0x{:x}", (target as i64 + 5 + delta) as usize);
    }
    if bytes[0] == 0xFF && bytes[1] == 0x25 {
        let offset = i32::from_le_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]) as i64;
        return alloc::format!("jmp through 0x{:x}", (target as i64 + 6 + offset) as usize);
    }
    let mut text = alloc::string::String::from("bytes ");
    for byte in &bytes[..5.min(bytes.len())] {
        text.push_str(&alloc::format!("{byte:02x}"));
    }
    text
}

/// The game's own command dispatcher: `(context, std::string* line, CommandOriginData* origin, u8)`.
///
/// It is entered for every command the game runs, its own chat commands included, so it is where a
/// **real** player origin is read from (`r8`) and kept for [`crate::command`] — see the command path
/// for why a synthetic one is not usable on this build. Nothing else is touched: every argument is
/// forwarded unchanged and the original's return value is passed through.
extern "C" fn dispatcher(context: usize, line: usize, origin: usize, flag: usize) -> usize {
    fired(SITE_DISPATCH);
    // `r8` is the `Request*` the dispatcher parses, not the `CommandOriginData`; the real origin data
    // is captured by [`origin_from_data`] instead. The hook stays for its call count and thread.
    let original = trampoline(&DISPATCHER);
    if original == 0 {
        return 0;
    }
    // SAFETY: the trampoline is the relocated prologue of the dispatcher; the four argument registers
    // are forwarded exactly as they arrived.
    unsafe { transmute::<usize, extern "C" fn(usize, usize, usize, usize) -> usize>(original)(context, line, origin, flag) }
}

/// The trampoline of one installed hook: the address that runs the stolen prologue.
fn trampoline(slot: &AtomicUsize) -> usize {
    slot.load(Ordering::Acquire)
}

/// Records that `site` ran on this thread, for `engine.status.hooks`.
fn fired(site: &'static str) {
    if let Some(core) = agent_core::hub::started() {
        core.site_fired(site);
    }
}

/// Per frame, on the game's main thread: run the queued requests.
///
/// `rcx` is the game object; it is passed through to the original unchanged.
extern "C" fn frame(game: usize, second: usize, third: usize, fourth: usize) -> usize {
    if let Some(core) = agent_core::hub::started() {
        core.site_fired(SITE_FRAME);
        // Entering this function is the proof that the calling thread is the client's own.
        core.drain();
    }
    let original = trampoline(&FRAME);
    if original == 0 {
        return 0;
    }
    // SAFETY: the trampoline is the relocated prologue of the game's own frame function. It reads
    // `rcx` (the game object), `rdx` and `r8` — `0x89ad1a` dereferences `[r8+8]` on the first frame
    // this build spends in a world — so every argument register the caller set is forwarded
    // unchanged; the detour's own Rust code would otherwise leave its leftovers in `rdx`/`r8`.
    unsafe {
        transmute::<usize, extern "C" fn(usize, usize, usize, usize) -> usize>(original)(game, second, third, fourth)
    }
}

/// Per simulation tick, from inside the game's own player system: read the local player.
///
/// `rcx` = the system, `rdx` = the `EntityContext`. Both are passed through untouched.
extern "C" fn player_system(system: usize, context: usize, third: usize, fourth: usize) -> usize {
    fired(SITE_PLAYER);
    let original = trampoline(&PLAYER_SYSTEM);
    let result = if original == 0 {
        0
    } else {
        // SAFETY: the trampoline is the relocated prologue of `(System*, EntityContext*, …)`; every
        // argument register the caller set is forwarded, not just the two this detour reads.
        unsafe {
            transmute::<usize, extern "C" fn(usize, usize, usize, usize) -> usize>(original)(system, context, third, fourth)
        }
    };
    // The registry accessor comes from this context, not from a scan of the process's memory.
    crate::input::note_context(context);
    live::observe(context);
    result
}

/// The generic component storage getter, `getStorage(accessor, hash)`.
///
/// Every system that reads an ECS component hands over the registry accessor here, on the thread that
/// owns that registry, many times per tick; that is the capture [`live::note_accessor`] keeps, and it
/// is what lets the client tick read the local player without a per-system hook. The call itself is
/// forwarded untouched: `rcx` = accessor, `edx` = component hash, and the storage comes back in `rax`.
extern "C" fn component_getter(accessor: usize, hash: usize, third: usize, fourth: usize) -> usize {
    fired(SITE_GETTER);
    live::note_accessor(accessor);
    let original = trampoline(&GETTER);
    if original == 0 {
        return 0;
    }
    // SAFETY: the trampoline is the relocated prologue of the game's own `getStorage`. All four
    // argument registers are forwarded, because the body reads more than the two this detour uses.
    unsafe {
        transmute::<usize, extern "C" fn(usize, usize, usize, usize) -> usize>(original)(accessor, hash, third, fourth)
    }
}

/// `CommandOrigin::fromData(out, data, src, reference, filter)`.
///
/// The game's own player-command path builds a player origin here; this detour copies the four
/// arguments of a real call so [`crate::command::run`] can replay them instead of inventing a
/// `reference` and a filter byte, which the level's player lookup dereferences. The fifth argument is
/// a stack argument, so the detour takes it by signature and hands it back to the trampoline unchanged.
extern "C" fn origin_from_data(out: usize, data: usize, src: usize, reference: usize, filter: u8) -> usize {
    fired(SITE_ORIGIN);
    crate::command::capture_call(data, src, reference, filter);
    let original = trampoline(&ORIGIN_BUILD);
    if original == 0 {
        return 0;
    }
    // SAFETY: the trampoline is the relocated prologue of the game's own `fromData`. Every argument —
    // including the stack-passed fifth — is forwarded exactly as it arrived.
    unsafe {
        transmute::<usize, unsafe extern "C" fn(usize, usize, usize, usize, u8) -> usize>(original)(
            out, data, src, reference, filter,
        )
    }
}

/// `MinecraftCommands`' run entry: `(commands, int* result, request, bool fromCommand)`.
///
/// The server's `CommandRequestPacket` handler runs a player's chat line through here with its own
/// manager, on the server thread — the one object `engine_command` must hand the dispatcher. With a
/// pointer read out of a level field instead (`[Level+0x78]`) the replay faulted inside the registry
/// lookup (reading a map head of 5 000 000 000), so the manager is only taken from this call.
/// All four arguments are forwarded unchanged.
extern "C" fn command_run(commands: usize, result: usize, request: usize, from: usize) -> usize {
    fired(SITE_RUN);
    if live::on_server_thread() {
        if anchors::command_commands() != Some(commands) {
            let field = live::server_level().and_then(|level| pe::read::<usize>(level + live::LEVEL_COMMANDS[0])).unwrap_or(0);
            log::fmt(format_args!(
                "command.run: the server runs commands with 0x{commands:x} ([server Level+0x{:x}] is 0x{field:x})",
                live::LEVEL_COMMANDS[0]
            ));
        }
        anchors::set_command_commands(commands);
    }
    let original = trampoline(&COMMAND_RUN);
    if original == 0 {
        return result;
    }
    // SAFETY: the trampoline is the relocated prologue of the same function; the four argument
    // registers are forwarded exactly as they arrived.
    unsafe { transmute::<usize, extern "C" fn(usize, usize, usize, usize) -> usize>(original)(commands, result, request, from) }
}

/// The moment this process starts its own server: the local-world signal.
///
/// The arguments of the launcher are integers in `rcx`/`rdx`/`r8`/`r9` and are forwarded as they
/// arrive; nothing else in the call is touched.
extern "C" fn local_server(a: usize, b: usize, c: usize, d: usize) -> usize {
    fired(SITE_SERVER);
    let original = trampoline(&LOCAL_SERVER);
    let result = if original == 0 {
        0
    } else {
        // SAFETY: the trampoline is the relocated prologue of the same function.
        unsafe { transmute::<usize, extern "C" fn(usize, usize, usize, usize) -> usize>(original)(a, b, c, d) }
    };
    live::note_local_server();
    result
}

/// Observes the `Options` object the game registers its options on, so `settings.*` can reach it.
///
/// The registration is a member function (`rcx` = `Options*`) whose other arguments, if any, are
/// integers; they are forwarded as they arrive.
extern "C" fn options_register(options: usize, a: usize, b: usize, c: usize) -> usize {
    fired(SITE_OPTIONS);
    anchors::set_options_object(options);
    let original = trampoline(&OPTIONS);
    if original == 0 {
        return 0;
    }
    // SAFETY: the trampoline is the relocated prologue of the same function.
    unsafe { transmute::<usize, extern "C" fn(usize, usize, usize, usize) -> usize>(original)(options, a, b, c) }
}

/// One simulation step of the local server's loop: the per-tick boundary.
///
/// `rcx` is the `Minecraft` object the step runs on. The tick counter advances here, the server
/// thread's request queue (commands, pause/step/scale) is drained here, and this is the object the
/// late-attach recovery derives the level, the command manager and the options from.
extern "C" fn sim_update(minecraft: usize, second: usize, third: usize, fourth: usize) -> usize {
    fired(SITE_SIM);
    live::sim_tick(minecraft);
    let original = trampoline(&SIM_UPDATE);
    if original == 0 {
        return 0;
    }
    // SAFETY: the trampoline is the relocated prologue of the game's own simulation step. Its first
    // argument is the `Minecraft` object; the rest are forwarded as they arrived, because this detour
    // cannot know which of them the body reads.
    unsafe {
        transmute::<usize, extern "C" fn(usize, usize, usize, usize) -> usize>(original)(minecraft, second, third, fourth)
    }
}

/// The synchronous command entry: records the server's command manager it was called with.
///
/// `rcx` = `MinecraftCommands*`, `rdx` = the int result slot, `r8` = the origin owner pointer (the
/// callee moves it out), `r9` = the command line, then the flag word and the from-command byte on
/// the stack. Every argument is forwarded untouched. A line typed in chat enters here first on the
/// *client's* thread with the client level's manager, which is not the one commands run against, so
/// only a call on the server's own thread is recorded.
extern "C" fn execute_command(commands: usize, result: usize, owner: usize, line: usize, flags: u32, from: u8) -> usize {
    fired(SITE_EXECUTE);
    if live::on_server_thread() {
        anchors::set_command_commands(commands);
    }
    let original = trampoline(&COMMAND_EXECUTE);
    if original == 0 {
        return result;
    }
    // SAFETY: the trampoline is the relocated prologue of the game's own
    // `int* executeCommand(MinecraftCommands*, int*, CommandOrigin**, std::string*, u32, bool)`.
    unsafe { transmute::<usize, extern "C" fn(usize, usize, usize, usize, u32, u8) -> usize>(original)(commands, result, owner, line, flags, from) }
}

/// `CommandOutput::addMessage`: copies the message while one of our commands runs, and can drop the
/// original call so the line never reaches chat.
///
/// `rcx` = the output, `rdx` = the message key (`std::string`), `r8` = the parameter vector, `r9d` =
/// the message type (0 success, 1 error). The objects are alive only for the duration of the call,
/// so [`command`] copies them.
extern "C" fn add_message(output: usize, key: usize, params: usize, kind: u32) -> usize {
    fired(SITE_MESSAGE);
    let ours = command::capture(output, key, params, kind);
    if ours == command::Capture::Drop {
        return 0;
    }
    let original = trampoline(&ADD_MESSAGE);
    if original == 0 {
        return 0;
    }
    // SAFETY: the trampoline is the relocated prologue of the game's own
    // `void addMessage(CommandOutput*, std::string const*, std::vector<Param> const*, u32)`.
    unsafe { transmute::<usize, extern "C" fn(usize, usize, usize, u32) -> usize>(original)(output, key, params, kind) }
}

/// The GameInput per-reading consumer: neutralizes a pad reading while the input lock is on.
///
/// `r8` is the reading context the callback was handed; the reading object is what its own
/// `vtable[0x18](ctx, &out)` produces, and the two control masks at `+0x5c`/`+0x60` are zeroed
/// before the original runs — "every control up, no axis moved" for that frame, with the game's own
/// state machine still running its normal path.
extern "C" fn pad_reading(a: usize, b: usize, context: usize, fourth: usize) -> usize {
    fired(SITE_PAD);
    if lock::on() && context != 0 && pe::readable(context, 8) {
        if let Some(vtable) = pe::read::<usize>(context) {
            if let Some(slot) = pe::read::<usize>(vtable + 0x18) {
                let mut reading: usize = 0;
                // SAFETY: the slot is the game's own reading accessor, called with the same context
                // and an out slot, exactly as its own callback does two instructions later.
                unsafe {
                    transmute::<usize, unsafe extern "C" fn(usize, *mut usize) -> usize>(slot)(context, &mut reading);
                }
                if reading != 0 && pe::writable(reading + 0x5c, 8) {
                    // SAFETY: the two masks were just verified writable on the reading object.
                    unsafe {
                        core::ptr::write_unaligned((reading + 0x5c) as *mut u32, 0);
                        core::ptr::write_unaligned((reading + 0x60) as *mut u32, 0);
                    }
                }
            }
        }
    }
    let original = trampoline(&INPUT_PAD);
    if original == 0 {
        return 0;
    }
    // SAFETY: the trampoline is the relocated prologue of the same callback.
    unsafe { transmute::<usize, extern "C" fn(usize, usize, usize, usize) -> usize>(original)(a, b, context, fourth) }
}
