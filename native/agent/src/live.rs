//! What the engine knows about the running world, and how it changes.
//!
//! Two game threads feed this module, and neither is the RPC server's:
//!
//! * the **client's own tick**, from the local-player travel system
//!   ([`crate::hooks::player_system`]): the player's components are read there, because that is the
//!   only thread that owns them, and the view the agent asked for is written and confirmed there;
//! * the **server's simulation step**, from the local server's loop
//!   ([`crate::hooks::sim_update`]): that is the per-tick boundary. It carries `Minecraft*`, which
//!   reaches the simulation timer (pause, step, time scale) and the level the tick loop itself runs.
//!
//! Every request handler reads the snapshot below through atomics and never calls into the game.
//!
//! A world is "ours" only when this process's own server is stepping it: only a local server's loop
//! calls the simulation step, so a client connected to a remote server never satisfies
//! [`in_world`]. The step is cross-checked against the level holder the tick loop tests, and against
//! a local player that was read in the last two seconds.

use alloc::string::String;
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering};

use agent_core::sync::SpinLock;
use agent_core::{queue, RpcError, TickSample};
use serde_json::{json, Value};

use crate::ecs;
use crate::pe;
use crate::registries;

/// A player reading older than this means the player is gone (menus, world change): not in a world.
const FRESH_MS: u64 = 2_000;
/// A simulation step older than this means no local server is running.
const SIM_FRESH_MS: u64 = 2_000;
/// Ticks to keep re-asserting a requested view before it is refused.
const LOOK_ATTEMPTS: u32 = 6;
/// A rotation within this many degrees of the target is the requested view.
const LOOK_EPSILON: f32 = 0.05;

/* ------------------------------------------------------------------------------------------------
 * The `Minecraft` object, as the simulation step receives it, and its timer.
 *
 * `Minecraft+0xd0` is the level holder whose `+0x40` is the simulated `Level*` and whose `+0x30` is
 * the "active" pointer the tick loop dereferences and compares with 1; `Minecraft+0xe8` is the
 * simulation `Timer`. All three are the fields the tick loop and the pause setter read.
 * ---------------------------------------------------------------------------------------------- */
const MC_LEVEL_HOLDER: usize = 0xD0;
pub(crate) const MC_TIMER: usize = 0xE8;
const LEVEL_IN_HOLDER: usize = 0x40;
const HOLDER_ACTIVE: usize = 0x30;

/// `ServerInstance` fields the command path needs: the `Minecraft*` it steps, its lifecycle state and
/// the holder `CommandOrigin::fromData` resolves a player from (`[src]` is the "active" byte pointer,
/// `[src+0x10]` the level-side provider whose slots look players up).
const SI_MINECRAFT: usize = 0xB8;
/// The simulation and auxiliary `Timer*` pair (`Timer+0x3c` step budget, `+0x78` clock), read live as
/// `ticks=2 scale=1.00 step=-1.00` on a running server.
const SI_SIM_TIMER: usize = 0x0D8;
const SI_AUX_TIMER: usize = 0x0E0;
/// `MinecraftCommands` fields that prove a candidate is the command manager: the server/level
/// provider, the command registry, the output sender, and the queued-command vector.
const MC_COMMANDS_PROVIDER: usize = 0x08;
const MC_COMMANDS_REGISTRY: usize = 0x10;
const MC_COMMANDS_SENDER: usize = 0x18;
/// The provider's own vtable slots the dispatcher calls (`->vtable[0x9e8]() -> bool`,
/// `->vtable[0xa40]()`), which only a `Level`-shaped interface has.
const MC_PROVIDER_LEVEL_SLOT: usize = 0x9E8;
const MC_PROVIDER_RULES_SLOT: usize = 0xA40;
const MC_COMMANDS_QUEUE_BEGIN: usize = 0xA8;
const MC_COMMANDS_QUEUE_END: usize = 0xB0;
const MC_COMMANDS_QUEUE_CAP: usize = 0xB8;
/// The offsets a `Level` holds its `MinecraftCommands*` at, confirmed read-only on the live
/// 1.26.63.1 process: the server level's `+0x78` and the client level's `+0x60` are the two command
/// managers (provider with a `Level`-shaped vtable, registry, output sender, empty queue vector),
/// while `[ServerInstance+0xc8]` is a small reference-counted object with a string in it — the
/// `<server obj>` of the four `executeCommand` sites is the level, not the `ServerInstance`. Only the
/// server level's is read.
pub(crate) const LEVEL_COMMANDS: usize = 0x78;

/// `Timer` fields the tick controls touch: the whole-tick count `Timer::advanceTime` produces, the
/// time scale it multiplies with (engine range 0..10) and the step budget (`< 0` real time, `0`
/// frozen, `N` = N more ticks).
pub(crate) const TIMER_TICKS: usize = 0x04;
pub(crate) const TIMER_SCALE: usize = 0x0C;
pub(crate) const TIMER_STEP: usize = 0x3C;
pub(crate) const TIMER_MAX_SCALE: f32 = 10.0;
/// `advanceTime` never runs more than ten ticks for one step (its own catch-up clamp).
const TIMER_MAX_TICKS: i32 = 10;

/// The local player as the last client tick left it.
struct Snapshot {
    entity: AtomicU32,
    position: [AtomicU32; 3],
    /// `[pitch, yaw]` in degrees, bits (NaN while unreadable).
    rotation: [AtomicU32; 2],
    velocity: [AtomicU32; 3],
    /// 0 = unreadable, 1 = on ground, 2 = airborne.
    ground: AtomicU8,
    /// `GetTickCount64` of the last reading.
    stamp: AtomicU64,
    /// `GetTickCount64` of the last client tick let through the duplicate-call window.
    client_stamp: AtomicU64,
    /// `GetTickCount64` of the last simulation step.
    sim_stamp: AtomicU64,
    /// The `Minecraft` object the simulation step was called with.
    minecraft: AtomicUsize,
    /// Simulation ticks published so far.
    tick: AtomicU64,
    /// A local server start was seen in this process.
    local_server: AtomicBool,
}

static LIVE: Snapshot = Snapshot {
    entity: AtomicU32::new(0),
    position: [AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0)],
    rotation: [AtomicU32::new(0), AtomicU32::new(0)],
    velocity: [AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0)],
    ground: AtomicU8::new(0),
    stamp: AtomicU64::new(0),
    client_stamp: AtomicU64::new(0),
    sim_stamp: AtomicU64::new(0),
    minecraft: AtomicUsize::new(0),
    tick: AtomicU64::new(0),
    local_server: AtomicBool::new(false),
};

const LOOK_IDLE: u8 = 0;
const LOOK_WRITING: u8 = 1;
const LOOK_DONE: u8 = 2;

/// The registry accessors the game's own `getStorage` was called with, and the thread each came from.
///
/// This is the accessor the game itself passes to `getStorage(accessor, hash)` — the object inside the
/// `EntityContext` at `+0x30`. Capturing it from the getter is what makes the
/// client tick independent of any one system: every system that reads a component hands it over, many
/// times per tick, on the thread that owns that registry. Each slot also keeps when it was captured and
/// the client frame the game last used it in, so a world change cannot leave the tick reading a
/// registry the game dropped ([`crate::registries`]).
const ACCESSOR_SLOTS: usize = registries::SLOTS;
static ACCESSORS: [AtomicUsize; ACCESSOR_SLOTS] = [const { AtomicUsize::new(0) }; ACCESSOR_SLOTS];
static ACCESSOR_THREADS: [AtomicU32; ACCESSOR_SLOTS] = [const { AtomicU32::new(0) }; ACCESSOR_SLOTS];
/// The capture sequence number of each slot (newer is larger).
static ACCESSOR_CAPTURED: [AtomicU64; ACCESSOR_SLOTS] = [const { AtomicU64::new(0) }; ACCESSOR_SLOTS];
/// The client frame ([`CLIENT_FRAME`]) in which the game last passed each slot's accessor.
static ACCESSOR_SEEN: [AtomicU64; ACCESSOR_SLOTS] = [const { AtomicU64::new(0) }; ACCESSOR_SLOTS];
static ACCESSOR_NEXT: AtomicUsize = AtomicUsize::new(0);
/// Client ticks so far: the clock [`ACCESSOR_SEEN`] is kept in.
static CLIENT_FRAME: AtomicU64 = AtomicU64::new(0);
/// The accessor a tick read this client's local player through.
static CLIENT_ACCESSOR: AtomicUsize = AtomicUsize::new(0);

/// Records the registry accessor one `getStorage` call was made with.
///
/// Two reads and an atomic compare: this runs inside the game's own component lookup, so it must cost
/// nothing it does not need. An accessor already known only has its frame refreshed (a load and, once
/// per frame, a store), and a value that could not be an object (below the lowest committed address,
/// or unreadable) is never stored.
pub(crate) fn note_accessor(accessor: usize) {
    if accessor < 0x1_0000 {
        return;
    }
    let frame = CLIENT_FRAME.load(Ordering::Relaxed);
    for (index, slot) in ACCESSORS.iter().enumerate() {
        if slot.load(Ordering::Acquire) == accessor {
            if ACCESSOR_SEEN[index].load(Ordering::Relaxed) != frame {
                ACCESSOR_SEEN[index].store(frame, Ordering::Relaxed);
            }
            return;
        }
    }
    if !pe::readable(accessor, 8) {
        return;
    }
    let sequence = ACCESSOR_NEXT.fetch_add(1, Ordering::AcqRel);
    let index = sequence % ACCESSOR_SLOTS;
    // Empty the slot first, so a reader never pairs the new accessor with the old slot's facts.
    ACCESSORS[index].store(0, Ordering::Release);
    ACCESSOR_THREADS[index].store(agent_core::win::current_thread_id(), Ordering::Release);
    ACCESSOR_CAPTURED[index].store(sequence as u64 + 1, Ordering::Release);
    ACCESSOR_SEEN[index].store(frame, Ordering::Release);
    ACCESSORS[index].store(accessor, Ordering::Release);
}

/// The slots as the hook left them; a slot rewritten while it was read comes back empty.
fn captures() -> [registries::Capture; ACCESSOR_SLOTS] {
    let mut out = [registries::Capture::default(); ACCESSOR_SLOTS];
    for (index, capture) in out.iter_mut().enumerate() {
        let accessor = ACCESSORS[index].load(Ordering::Acquire);
        if accessor == 0 {
            continue;
        }
        let thread = ACCESSOR_THREADS[index].load(Ordering::Acquire);
        let captured = ACCESSOR_CAPTURED[index].load(Ordering::Acquire);
        let seen = ACCESSOR_SEEN[index].load(Ordering::Relaxed);
        if ACCESSORS[index].load(Ordering::Acquire) != accessor {
            continue;
        }
        *capture = registries::Capture { accessor, thread, captured, seen };
    }
    out
}

/// Every captured accessor and its thread (debug-rpc's `debug.hit`).
#[cfg(feature = "debug-rpc")]
pub(crate) fn accessors() -> alloc::vec::Vec<(usize, u32)> {
    ACCESSORS
        .iter()
        .zip(ACCESSOR_THREADS.iter())
        .map(|(slot, thread)| (slot.load(Ordering::Acquire), thread.load(Ordering::Acquire)))
        .filter(|(accessor, _)| *accessor != 0)
        .collect()
}

/// A rejected `ServerInstance` hint was logged.
static SERVER_SCAN_LOGGED: AtomicBool = AtomicBool::new(false);
/// The client-side `Minecraft` object was reported as not the tick boundary.
static CLIENT_TICK_LOGGED: AtomicBool = AtomicBool::new(false);
/// `in_world` fell back to the server's own proof (no client tick was ever observed).
static FALLBACK_LOGGED: AtomicBool = AtomicBool::new(false);
/// The local player entity the log last reported (0 = none yet).
static LOGGED_ENTITY: AtomicU32 = AtomicU32::new(0);
/// `GetTickCount64` of the last "no local player" log line.
static LOGGED_MISSING: AtomicU64 = AtomicU64::new(0);

/* ------------------------------------------------------------------------------------------------
 * Which `Minecraft` is which
 *
 * `sim.update` fires for every `Minecraft` object this process steps — live, two of them, both on the
 * window thread. They are not interchangeable: one carries the integrated server's world (its `Level`
 * holds a `MinecraftCommands` at `+0x78`), the other the client's (no commands there). The role is
 * decided by that validation, never by an offset or by a `.data` scan, and an object whose role is
 * not yet known is treated as "publish too" rather than silently dropped: a wrong guess must not
 * starve the tick stream.
 * ---------------------------------------------------------------------------------------------- */
const OBJECTS: usize = 4;
const ROLE_UNKNOWN: u8 = 0;
const ROLE_CLIENT: u8 = 1;
const ROLE_SERVER: u8 = 2;

struct Observed {
    ptr: AtomicUsize,
    calls: AtomicU64,
    thread: AtomicU32,
    level: AtomicUsize,
    role: AtomicU8,
    /// `GetTickCount64` of the last call: a silent object's slot is reused ([`registries::object_slot`]).
    last_ms: AtomicU64,
}

impl Observed {
    const fn new() -> Self {
        Self {
            ptr: AtomicUsize::new(0),
            calls: AtomicU64::new(0),
            thread: AtomicU32::new(0),
            level: AtomicUsize::new(0),
            role: AtomicU8::new(ROLE_UNKNOWN),
            last_ms: AtomicU64::new(0),
        }
    }

    /// Forgets everything learned about the object in this slot: a new one, or the same address after
    /// its world was left, whose role is proved again on its next call.
    fn forget(&self) {
        self.calls.store(0, Ordering::Relaxed);
        self.thread.store(0, Ordering::Release);
        self.level.store(0, Ordering::Release);
        self.role.store(ROLE_UNKNOWN, Ordering::Release);
    }
}

static OBSERVED: [Observed; OBJECTS] =
    [const { Observed::new() }, const { Observed::new() }, const { Observed::new() }, const { Observed::new() }];
/// The object whose `Level+0x78` is the command manager: the integrated server's.
static SERVER_OBJECT: AtomicUsize = AtomicUsize::new(0);
/// The last tick from that object.
static SERVER_TICK_MS: AtomicU64 = AtomicU64::new(0);
/// The roles were reported.
static ROLES_LOGGED: AtomicBool = AtomicBool::new(false);

/// Records one `sim.update` call and returns the object's role.
///
/// An object silent for [`registries::OBJECT_SILENT_MS`] belongs to a world that was left: called
/// again, its role is proved again, and a new object takes its slot when none is free, so a session
/// that changes worlds many times keeps classifying the current world's server and keeps its stream.
pub(crate) fn observe_tick(minecraft: usize, level: Option<usize>) -> u8 {
    let thread = agent_core::win::current_thread_id();
    let now = agent_core::win::tick_ms();
    let mut slot = None;
    for (index, observed) in OBSERVED.iter().enumerate() {
        if observed.ptr.load(Ordering::Acquire) == minecraft {
            slot = Some(index);
            break;
        }
    }
    let index = match slot {
        Some(index) => {
            if registries::object_silent(OBSERVED[index].last_ms.load(Ordering::Acquire), now) {
                OBSERVED[index].forget();
            }
            index
        }
        None => {
            let slots: [(usize, u64); OBJECTS] = core::array::from_fn(|index| {
                (OBSERVED[index].ptr.load(Ordering::Acquire), OBSERVED[index].last_ms.load(Ordering::Acquire))
            });
            let Some(index) = registries::object_slot(&slots, now) else {
                return ROLE_UNKNOWN;
            };
            let old = slots[index].0;
            if OBSERVED[index].ptr.compare_exchange(old, minecraft, Ordering::AcqRel, Ordering::Acquire).is_err() {
                return ROLE_UNKNOWN;
            }
            OBSERVED[index].forget();
            // The server object whose slot this was is gone: the new world's server proves itself.
            if old != 0 {
                let _ = SERVER_OBJECT.compare_exchange(old, 0, Ordering::AcqRel, Ordering::Acquire);
                agent_core::log::fmt(format_args!("minecraft: 0x{minecraft:x} takes the slot of silent 0x{old:x}"));
            }
            index
        }
    };
    let observed = &OBSERVED[index];
    observed.last_ms.store(now, Ordering::Release);
    observed.calls.fetch_add(1, Ordering::Relaxed);
    let _ = observed.thread.compare_exchange(0, thread, Ordering::AcqRel, Ordering::Acquire);
    if let Some(level) = level {
        observed.level.store(level, Ordering::Release);
        // The command manager is the discriminator: only the integrated server's level has one.
        if observed.role.load(Ordering::Acquire) == ROLE_UNKNOWN && commands_of(level).is_some() {
            observed.role.store(ROLE_SERVER, Ordering::Release);
            SERVER_OBJECT.store(minecraft, Ordering::Release);
            // Everything else that has a level is the client's.
            for other in &OBSERVED {
                if other.ptr.load(Ordering::Acquire) != minecraft && other.level.load(Ordering::Acquire) != 0 {
                    other.role.store(ROLE_CLIENT, Ordering::Release);
                }
            }
            // The first table may have been written before any role was known: write it again.
            log_roles();
        }
    }
    let role = observed.role.load(Ordering::Acquire);
    if role == ROLE_SERVER {
        SERVER_TICK_MS.store(agent_core::win::tick_ms(), Ordering::Release);
    }
    if !ROLES_LOGGED.swap(true, Ordering::AcqRel) {
        log_roles();
    }
    role
}

/// Writes one line per observed object, so a live log says which is which and on which thread.
fn log_roles() {
    for observed in &OBSERVED {
        let ptr = observed.ptr.load(Ordering::Acquire);
        if ptr == 0 {
            continue;
        }
        agent_core::log::fmt(format_args!(
            "minecraft: 0x{ptr:x} role {} level 0x{:x} thread 0x{:x}",
            match observed.role.load(Ordering::Acquire) {
                ROLE_SERVER => "server",
                ROLE_CLIENT => "client",
                _ => "unknown",
            },
            observed.level.load(Ordering::Acquire),
            observed.thread.load(Ordering::Acquire)
        ));
    }
}

/// The server's `Minecraft*`, once a tick proved which object that is.
pub(crate) fn server_object() -> Option<usize> {
    match SERVER_OBJECT.load(Ordering::Acquire) {
        0 => None,
        ptr => Some(ptr),
    }
}

/// The integrated server's level, once known.
pub(crate) fn server_level() -> Option<usize> {
    let server = server_object()?;
    OBSERVED
        .iter()
        .find(|observed| observed.ptr.load(Ordering::Acquire) == server)
        .map(|observed| observed.level.load(Ordering::Acquire))
        .filter(|level| *level != 0)
}

/// True on the integrated server's own simulation thread: the thread the server object was stepped on.
/// The client runs the same command entry for a line typed in chat (on its own thread, against its own
/// level's manager), so a hook that records the server's command manager asks this first.
pub(crate) fn on_server_thread() -> bool {
    let Some(server) = server_object() else {
        return false;
    };
    let here = agent_core::win::current_thread_id();
    OBSERVED
        .iter()
        .any(|observed| observed.ptr.load(Ordering::Acquire) == server && observed.thread.load(Ordering::Acquire) == here)
}

/// The game objects this process is known to hold, for a scan that should look near them first.
pub(crate) fn known_objects() -> alloc::vec::Vec<usize> {
    let mut out = alloc::vec::Vec::new();
    for observed in &OBSERVED {
        for address in [observed.ptr.load(Ordering::Acquire), observed.level.load(Ordering::Acquire)] {
            if address != 0 {
                out.push(address);
            }
        }
    }
    if let Some(level) = server_level() {
        if let Some(data) = pe::read::<usize>(level + 0x90) {
            out.push(data);
        }
    }
    out
}

/// The per-object table for `engine.status`.
pub(crate) fn objects_json() -> serde_json::Value {
    let mut out = alloc::vec::Vec::new();
    for observed in &OBSERVED {
        let ptr = observed.ptr.load(Ordering::Acquire);
        if ptr == 0 {
            continue;
        }
        let thread = observed.thread.load(Ordering::Acquire);
        let level = observed.level.load(Ordering::Acquire);
        out.push(json!({
            "ptr": alloc::format!("0x{ptr:x}"),
            "calls": observed.calls.load(Ordering::Relaxed),
            "thread": if thread == 0 { Value::Null } else { Value::from(thread) },
            "level": if level == 0 { Value::Null } else { Value::String(alloc::format!("0x{level:x}")) },
            "role": match observed.role.load(Ordering::Acquire) {
                ROLE_SERVER => "server",
                ROLE_CLIENT => "client",
                _ => "unknown",
            },
        }));
    }
    Value::Array(out)
}

/// True when `minecraft` is one of the objects `sim.update` has been entered with.
fn object_is_observed(minecraft: usize) -> bool {
    OBSERVED.iter().any(|observed| observed.ptr.load(Ordering::Acquire) == minecraft)
}

/// The command manager of `level`, if it has one (the server-side discriminator).
fn commands_of(level: usize) -> Option<usize> {
    let manager = pe::read::<usize>(level + crate::live::LEVEL_COMMANDS)?;
    if manager == 0 || !plausible_commands(manager) {
        return None;
    }
    Some(manager)
}

/// The `input.look` request waiting to be applied and confirmed by the next client tick.
static LOOK_PENDING: SpinLock<Option<queue::Deferred>> = SpinLock::new(None);
/// The `input.look` epoch already written to the component.
static LOOK_APPLIED: AtomicU64 = AtomicU64::new(0);
static LOOK_STATE: AtomicU8 = AtomicU8::new(LOOK_IDLE);

/// Consecutive simulation frames in which [`in_world`] held, capped at [`STEADY_MAX`].
///
/// Everything that acts on the game waits for a world that has been up for a moment: the load path
/// (level creation, the local server's first ticks, the client's first frame) is exactly when the
/// game's own objects are half-built, and a call into one of them then is a fault inside game code.
static STEADY: AtomicU32 = AtomicU32::new(0);
/// The frame count a caller waits for before it touches a freshly loaded world.
pub(crate) const STEADY_FRAMES: u32 = 10;
const STEADY_MAX: u32 = 1 << 20;
static LOOK_ATTEMPT: AtomicU32 = AtomicU32::new(0);

fn bits(value: f32) -> u32 {
    value.to_bits()
}

fn float(bits: u32) -> f32 {
    f32::from_bits(bits)
}

/// A float for the wire, never a non-finite number.
pub(crate) fn number(value: f32) -> Value {
    serde_json::Number::from_f64(value as f64).map(Value::Number).unwrap_or(Value::Null)
}

/* ------------------------------------------------------------------------------------------------
 * Where we are
 * ---------------------------------------------------------------------------------------------- */

/// `-32002` unless a world this process hosts is loaded with a local player.
pub(crate) fn require_world() -> Result<(), RpcError> {
    if in_world() {
        Ok(())
    } else {
        Err(RpcError::not_in_world())
    }
}

/// True while a world hosted by this process is loaded and its local player was just read.
pub(crate) fn in_world() -> bool {
    // The local player's own reading, when the client's tick has produced one: the strongest answer.
    let stamp = LIVE.stamp.load(Ordering::Acquire);
    if LIVE.entity.load(Ordering::Acquire) != 0 && stamp != 0 && agent_core::win::tick_ms().saturating_sub(stamp) < FRESH_MS {
        return local_proof();
    }
    // Otherwise the integrated server's own proof: its object was ticked a moment ago, its level is
    // readable, and that level carries the world's data. No client hook is involved — which matters on
    // a build where another mod owns the client's update functions.
    let Some(server) = server_object() else {
        return false;
    };
    let ticked = SERVER_TICK_MS.load(Ordering::Acquire);
    if ticked == 0 || agent_core::win::tick_ms().saturating_sub(ticked) >= FRESH_MS {
        return false;
    }
    let Some(level) = server_level() else {
        return false;
    };
    if level_of(server) != Some(level) {
        return false;
    }
    if crate::world::name().is_none() {
        return false;
    }
    if !FALLBACK_LOGGED.swap(true, Ordering::AcqRel) {
        agent_core::log::fmt(format_args!(
            "in_world: from the server's own step (Minecraft 0x{server:x}, Level 0x{level:x}); no client player reading yet"
        ));
    }
    true
}

/// The level this process is stepping, or `None` when this process is not running a local server.
///
/// The test is the tick loop's own: the holder is present, its active pointer is set and the byte it
/// points at is `1`. Only a local server's loop gets this far.
fn level_of(minecraft: usize) -> Option<usize> {
    if minecraft == 0 {
        return None;
    }
    let holder = pe::read::<usize>(minecraft + MC_LEVEL_HOLDER)?;
    if holder == 0 {
        return None;
    }
    let level = pe::read::<usize>(holder + LEVEL_IN_HOLDER)?;
    if level == 0 {
        return None;
    }
    let active = pe::read::<usize>(holder + HOLDER_ACTIVE)?;
    if active == 0 || pe::read::<u8>(active)? != 1 {
        return None;
    }
    Some(level)
}

/// This process hosts the world: the simulation step is running here (only the local server's loop
/// calls it, on a thread whose level holder the tick loop tests), or a local server start was seen
/// and the simulation step is not resolved in this build.
fn local_proof() -> bool {
    let minecraft = LIVE.minecraft.load(Ordering::Acquire);
    let sim = LIVE.sim_stamp.load(Ordering::Acquire);
    if minecraft != 0 && sim != 0 && agent_core::win::tick_ms().saturating_sub(sim) < SIM_FRESH_MS {
        return level_of(minecraft).is_some();
    }
    LIVE.local_server.load(Ordering::Acquire)
}

/// Records that this process started its own server: a second, independent local-world signal.
pub(crate) fn note_local_server() {
    if !LIVE.local_server.swap(true, Ordering::AcqRel) {
        agent_core::log::line("local server started");
    }
}

/// How recently the server's own step must have run for [`server_stepping`].
const STEPPING_MS: u64 = 250;

/// True when the server's object stepped within [`STEPPING_MS`]: a request queued now runs on its next
/// step instead of waiting out a paused world.
pub(crate) fn server_stepping() -> bool {
    let sim = LIVE.sim_stamp.load(Ordering::Acquire);
    sim != 0 && agent_core::win::tick_ms().saturating_sub(sim) < STEPPING_MS
}

/* ------------------------------------------------------------------------------------------------
 * The server thread's objects: the level being stepped, its command manager and the origin source
 * ---------------------------------------------------------------------------------------------- */

/// The command manager (`MinecraftCommands*`) of the running server: the one the game itself ran a
/// command with on the server thread (recorded by the `command.run` and `command.execute` hooks).
///
/// A manager read out of a level field is not used: with `[server Level + 0x78]` (which passes every
/// shape check below) the replay faulted inside the dispatcher's registry lookup (reading a map head
/// of 5 000 000 000), so only a pointer the game handed its own command path is
/// trusted. A player's chat line, which `engine_command` needs anyway for its origin, records it.
///
/// No scans, no reads beyond the cached pointer: `quiet_command` uses it to refuse at once instead of
/// queueing a request nobody can run.
pub(crate) fn commands() -> Option<usize> {
    crate::anchors::command_commands()
}

/// True when `candidate` has the shape of a `MinecraftCommands`, as the disassembly and the live
/// process both describe it:
///
/// * `+0x08` the server/level provider, whose own vtable is a *large* interface — the dispatcher
///   calls its slots `0x9e8` and `0xa40`, so both must be code;
/// * `+0x10` the command registry, and `+0x18` the output sender, both with vtables in image data;
/// * `+0xa8`/`+0xb0`/`+0xb8` a `std::vector` (begin ≤ end ≤ cap, one allocation at most).
///
/// The live server level answers all five at `+0x78` (in the 1.26.63.1 session), while
/// its neighbour at `+0x60` fails the provider test — which is what makes this check worth having.
fn plausible_commands(candidate: usize) -> bool {
    if candidate == 0 || !pe::readable(candidate, MC_COMMANDS_QUEUE_CAP + 8) {
        return false;
    }
    let provider = pe::read::<usize>(candidate + MC_COMMANDS_PROVIDER).unwrap_or(0);
    let registry = pe::read::<usize>(candidate + MC_COMMANDS_REGISTRY).unwrap_or(0);
    let sender = pe::read::<usize>(candidate + MC_COMMANDS_SENDER).unwrap_or(0);
    if provider == 0 || registry == 0 || sender == 0 {
        return false;
    }
    let Some(provider_vtable) = pe::read::<usize>(provider) else {
        return false;
    };
    if !pe::in_image_data(provider_vtable) {
        return false;
    }
    // The provider interface is `Level`-shaped: the two slots the dispatcher calls must be code.
    for slot in [MC_PROVIDER_LEVEL_SLOT, MC_PROVIDER_RULES_SLOT] {
        match pe::read::<usize>(provider_vtable + slot) {
            Some(entry) if pe::readable(entry, 1) && pe::in_image_code(entry) => {}
            _ => return false,
        }
    }
    // The registry is a polymorphic object (its vtable is in `.rdata`). The output sender is a static
    // singleton whose first word is *code* in this build (a pointer into `.text`, inside the
    // image), so it is only required to be a readable pointer inside the image — requiring a data
    // vtable there rejected the real manager and left every role "unknown" on the 1.26.63.1 session.
    let Some(registry_vtable) = pe::read::<usize>(registry) else {
        return false;
    };
    if !pe::in_image_data(registry_vtable) {
        return false;
    }
    if !pe::in_image_data(sender) && !pe::in_image_code(sender) {
        return false;
    }
    let begin = pe::read::<usize>(candidate + MC_COMMANDS_QUEUE_BEGIN).unwrap_or(0);
    let end = pe::read::<usize>(candidate + MC_COMMANDS_QUEUE_END).unwrap_or(0);
    let cap = pe::read::<usize>(candidate + MC_COMMANDS_QUEUE_CAP).unwrap_or(0);
    let empty = begin == 0 && end == 0 && cap == 0;
    empty || (end >= begin && cap >= end && end.saturating_sub(begin) <= 0x10_000)
}

/// The local server (`ServerInstance*`), derived without being told which `Minecraft` it steps.
///
/// The scan of the module's writable data looks for the object's own fingerprint — the `Minecraft*`
/// at `+0xb8`, and the simulation/auxiliary `Timer*` pair at `+0xd8`/`+0xe0` whose `+0x3c` step
/// budget and `+0x78` clock pointer are what `Timer::advanceTime` reads. Read live on 1.26.63.1 the
/// timers answer `ticks=2 scale=1.00 step=-1.00`, i.e. a running server in real time.
///
/// The point of finding it this way is that `[ServerInstance+0xb8]` then says **which** `Minecraft`
/// is the server's — the other one this process ticks is the client's.
pub(crate) fn server_instance() -> Option<usize> {
    if let Some(server) = crate::anchors::server_instance() {
        return Some(server);
    }
    if let Some(server) = scan_server_instance() {
        crate::anchors::set_server_instance(server);
        return Some(server);
    }
    None
}

/// True when `candidate` holds a `Minecraft*` at `+0xb8` and the two simulation timers at
/// `+0xd8`/`+0xe0`.
fn plausible_server_instance(candidate: usize) -> Option<usize> {
    let minecraft = pe::read::<usize>(candidate + SI_MINECRAFT)?;
    if minecraft == 0 || !pe::readable(minecraft + MC_TIMER, 8) {
        return None;
    }
    // The level holder the tick loop tests: `[[minecraft+0xd0]+0x40]`.
    let holder = pe::read::<usize>(minecraft + MC_LEVEL_HOLDER)?;
    if holder == 0 || !pe::readable(holder + LEVEL_IN_HOLDER, 8) {
        return None;
    }
    for offset in [SI_SIM_TIMER, SI_AUX_TIMER] {
        let timer = pe::read::<usize>(candidate + offset)?;
        if timer == 0 {
            return None;
        }
        let step = pe::read::<f32>(timer + TIMER_STEP)?;
        if !step.is_finite() || !(-1.0e6..=1.0e6).contains(&step) {
            return None;
        }
        if pe::read::<usize>(timer + 0x78)? == 0 {
            return None;
        }
    }
    Some(minecraft)
}

/// Walks the module's writable data for the `ServerInstance` and logs which global held it.
fn scan_server_instance() -> Option<usize> {
    let image = agent_core::image::game();
    let regions = pe::regions();
    for name in [".data", ".tls"] {
        let Some(section) = image.section(name) else {
            continue;
        };
        let Some(bytes) = pe::bytes(section.va, section.len) else {
            continue;
        };
        let mut offset = 0usize;
        while offset + 8 <= bytes.len() {
            // SAFETY: eight bytes are inside the readable section.
            let word = unsafe { core::ptr::read_unaligned(bytes.as_ptr().add(offset) as *const u64) } as usize;
            offset += 8;
            if word < 0x1_0000 || (word >= image.base() && word < image.base() + image.size()) {
                continue;
            }
            if !pe::in_regions(&regions, word, SI_SIM_TIMER + 8) {
                continue;
            }
            let Some(minecraft) = plausible_server_instance(word) else {
                continue;
            };
            // A hint, not an authority: the object is only believed when the `Minecraft` it names is
            // one this process actually steps. A live session showed why — a stale server from an
            // earlier world matched the shape and never ticked, and trusting it silenced the tick
            // stream. The role of each object comes from `sim.update`, not from here.
            if !object_is_observed(minecraft) {
                if !SERVER_SCAN_LOGGED.swap(true, Ordering::AcqRel) {
                    agent_core::log::fmt(format_args!(
                        "recover: ServerInstance hint 0x{:x} from 0x{:x} names Minecraft 0x{:x}, which never ticks; ignoring it",
                        word,
                        section.va + offset - 8,
                        minecraft
                    ));
                }
                continue;
            }
            agent_core::log::fmt(format_args!(
                "recover: ServerInstance 0x{:x} from the global at 0x{:x}: [+0xb8] = Minecraft 0x{:x} (ticking)",
                word,
                section.va + offset - 8,
                minecraft
            ));
            return Some(word);
        }
    }
    None
}

/// The `CommandSource` triple `CommandOrigin::fromData` resolves the local player from.
///
/// Live/static finding: the third argument is a **0x18-byte struct**
/// `{ [level+0x08], [level+0x10], level }`, not a field of the `ServerInstance` — the old
/// `ServerInstance+0x280` is a `std::string` in this build, and reading it as a source was the bug
/// that kept `command` at `-32001`. `fromData` reads `src->[0]` (it must be set) and `src->[0x10]`
/// (the level), then asks that level for the player actor.
pub(crate) fn command_source(minecraft: usize) -> Option<[usize; 3]> {
    let level = level_of(minecraft)?;
    let first = pe::read::<usize>(level + 0x08)?;
    let second = pe::read::<usize>(level + 0x10)?;
    if first == 0 || second == 0 {
        return None;
    }
    Some([first, second, level])
}

/* ------------------------------------------------------------------------------------------------
 * The client tick: the local player's components
 * ---------------------------------------------------------------------------------------------- */

/// One client tick, from inside the game's own player system.
///
/// `context` is the `EntityContext` the system was called with; its `+0x30` is the component
/// accessor the system itself uses.
pub(crate) fn observe(context: usize) {
    if context == 0 {
        return;
    }
    let accessor = context + ecs::ACCESSOR;
    if !pe::readable(accessor, 8) {
        return;
    }
    let Some(reading) = ecs::read(accessor) else {
        note_player_missing(accessor);
        return;
    };
    if publish_reading(accessor, reading) != 0 {
        CLIENT_ACCESSOR.store(accessor, Ordering::Release);
    }
}

/// One client tick of the local player, from the registry accessor itself.
///
/// The player system runs once per world on this build, so its own entry is not a tick: the client's
/// simulation step is, and the accessor it reads through is captured by the `component.getter` hook
/// ([`note_accessor`]). This is the same read [`observe`] makes, keyed on that accessor.
///
/// Only registries the game used in the last client frame are read, newest capture first, and the
/// first that holds a local player wins ([`registries::candidates`]): after a world change (a left
/// world, a failed join, a rejoin) the old world's registry ages out within two client frames instead
/// of being read for as long as it sits in a lower slot. When no current registry holds a local player
/// nothing is published, the reading ages, and the tick stream stops sending it
/// ([`registries::stream_fresh`]).
///
/// Returns the entity it published, or 0 when no local player could be read.
pub(crate) fn client_tick() -> u32 {
    // This frame's systems have not run yet: the frame that just ended is the newest one with uses.
    let frame = CLIENT_FRAME.fetch_add(1, Ordering::AcqRel);
    let thread = agent_core::win::current_thread_id();
    let (candidates, count) =
        registries::candidates(&captures(), thread, frame, CLIENT_ACCESSOR.load(Ordering::Acquire));
    for &accessor in &candidates[..count] {
        let Some(reading) = ecs::read(accessor) else {
            continue;
        };
        let entity = publish_reading(accessor, reading);
        if entity != 0 {
            CLIENT_ACCESSOR.store(accessor, Ordering::Release);
            return entity;
        }
    }
    // No registry the game is using holds a local player. The last good accessor stays recorded (it is
    // only read again while the game still uses it), and the reading ages out of the tick stream.
    if let Some(&first) = candidates[..count].first() {
        note_player_missing(first);
    }
    0
}

/// The client's registry accessor, once a tick has read the local player through it: the last one a
/// client tick read the local player through, which is always a registry the game was using then.
pub(crate) fn client_accessor() -> Option<usize> {
    let accessor = CLIENT_ACCESSOR.load(Ordering::Acquire);
    (accessor != 0).then_some(accessor)
}

/// Publishes one tick's local player read through `accessor`; returns its entity, 0 on failure.
fn publish_reading(accessor: usize, mut reading: ecs::Reading) -> u32 {
    let Some(core) = agent_core::hub::started() else {
        return 0;
    };
    note_player_found(&reading, accessor);

    let now = agent_core::win::tick_ms();
    let fresh = now.saturating_sub(LIVE.published_client()) >= ecs::CLIENT_TICK_WINDOW_MS;
    if fresh {
        LIVE.mark_client(now);
        // A view written on an earlier tick is checked here, before this tick writes again.
        verify_look(&reading);
    }
    write_look(core, &reading);
    if let Some(rotation) = reading.read_look() {
        reading.sample.rotation = Some(rotation);
    }
    publish(&reading.sample);
    reading.sample.entity
}

/// Logs the local player this tick found, once per entity.
///
/// This is the whole late-attach chain for the player, written down so a live run says which registry,
/// which storage and which entity id answered: the reading itself is published as before.
fn note_player_found(reading: &ecs::Reading, accessor: usize) {
    let entity = reading.sample.entity;
    if LOGGED_ENTITY.swap(entity, Ordering::AcqRel) == entity {
        return;
    }
    let [x, y, z] = reading.sample.position;
    agent_core::log::fmt(format_args!(
        "player: LocalPlayerComponent entity 0x{entity:x} in the registry at 0x{accessor:x}, eye {x:.2} {y:.2} {z:.2}, feet {:?}, rotation {:?}, on ground {:?}",
        reading.sample.feet, reading.sample.rotation, reading.sample.on_ground
    ));
}

/// Logs why no local player was read, at most once every five seconds.
///
/// The two answers are different failures: no `LocalPlayerComponent` storage at all (the registry is
/// not the client's, or it has not built the storage yet) versus a storage whose entities have no
/// readable position (a dead or replaced actor).
fn note_player_missing(accessor: usize) {
    let now = agent_core::win::tick_ms();
    if now.saturating_sub(LOGGED_MISSING.load(Ordering::Acquire)) < 5_000 {
        return;
    }
    LOGGED_MISSING.store(now, Ordering::Release);
    match ecs::local_players(accessor) {
        Some((storage, count, first)) => agent_core::log::fmt(format_args!(
            "player: LocalPlayerComponent storage 0x{storage:x} holds {count} entities (first 0x{first:x}) with no readable position yet",
        )),
        None => agent_core::log::fmt(format_args!(
            "player: no LocalPlayerComponent storage in the registry at 0x{accessor:x} yet"
        )),
    }
}

fn publish(sample: &ecs::Sample) {
    LIVE.entity.store(sample.entity, Ordering::Release);
    // The wire's position is the feet; a box that did not check out publishes no position (null)
    // rather than the eye under the feet's name.
    let feet = sample.feet.unwrap_or([f32::NAN; 3]);
    for (slot, value) in LIVE.position.iter().zip(feet.iter()) {
        slot.store(bits(*value), Ordering::Relaxed);
    }
    for (slot, value) in LIVE.velocity.iter().zip(sample.velocity.iter()) {
        slot.store(bits(*value), Ordering::Relaxed);
    }
    if let Some(rotation) = sample.rotation {
        LIVE.rotation[0].store(bits(rotation[0]), Ordering::Relaxed);
        LIVE.rotation[1].store(bits(rotation[1]), Ordering::Relaxed);
    } else {
        LIVE.rotation[0].store(f32::NAN.to_bits(), Ordering::Relaxed);
        LIVE.rotation[1].store(f32::NAN.to_bits(), Ordering::Relaxed);
    }
    LIVE.ground.store(
        match sample.on_ground {
            Some(true) => 1,
            Some(false) => 2,
            None => 0,
        },
        Ordering::Release,
    );
    LIVE.stamp.store(agent_core::win::tick_ms(), Ordering::Release);
}

/* ------------------------------------------------------------------------------------------------
 * The server step: the per-tick boundary and the simulation controls
 * ---------------------------------------------------------------------------------------------- */

/// One simulation step, from the local server's loop, before the game runs it.
///
/// `minecraft` is the object the step was called with. The number of ticks this step will run comes
/// from the simulation timer, so a paused step publishes nothing and a catch-up step publishes one
/// sample per tick.
pub(crate) fn sim_tick(minecraft: usize) {
    let Some(core) = agent_core::hub::started() else {
        return;
    };
    if core.stopping() {
        return;
    }
    let level = level_of(minecraft);
    // Which object this is decides what it may publish; an unclassified object may publish too.
    let role = observe_tick(minecraft, level);
    // Only the *client's* object proves which thread the game's own thread is: the server steps on its
    // own thread (0x448 on the last session), and taking that as the client thread made the window
    // drain refuse to run — every main-thread method then timed out.
    if role != ROLE_SERVER {
        core.note_client_thread("sim.update");
    }
    if let Some(level) = level {
        crate::recover::note(minecraft, Some(level));
        if role == ROLE_SERVER {
            crate::world::note_level(level);
        }
    }
    // How long this world has been up: `in_world` is what every acting method checks, so a method that
    // needs a *settled* world waits for this counter instead of `in_world` alone.
    if in_world() {
        if STEADY.load(Ordering::Relaxed) < STEADY_MAX {
            STEADY.fetch_add(1, Ordering::Relaxed);
        }
    } else {
        STEADY.store(0, Ordering::Release);
    }
    // The drain points that do not depend on the game's own code, and the hook watchdog.
    agent_core::message_loop::ensure(core);
    crate::hooks::watch();

    // Only the server's object is the per-tick boundary: its timer, its queue and its level. Until one
    // object is proved to be the server, both publish — a few double ticks are better than none.
    let publish = match server_object() {
        Some(server) => server == minecraft,
        None => true,
    };
    if !publish {
        if !CLIENT_TICK_LOGGED.swap(true, Ordering::AcqRel) {
            agent_core::log::fmt(format_args!(
                "sim.update: Minecraft 0x{minecraft:x} is the client's world; the server's is 0x{:x}",
                server_object().unwrap_or(0)
            ));
        }
        // The client's own step is the frame the local player's components belong to. Reading them
        // here is what makes `player.state`, `input.look` and the lock's camera gate work: the player
        // system's entry runs once per world on this build, so it cannot be the tick.
        client_tick();
        return;
    }
    LIVE.minecraft.store(minecraft, Ordering::Release);
    LIVE.sim_stamp.store(agent_core::win::tick_ms(), Ordering::Release);
    crate::server::drain(minecraft);

    // A reading the client tick has not renewed lately is no longer the player: a world change or a
    // registry with no local player left the slots at the old world's position. Those ticks still go
    // out (their `tick` numbers stay continuous) with the player fields null, which the client treats
    // as "no reading" rather than as a player standing still.
    let current = registries::stream_fresh(LIVE.stamp.load(Ordering::Acquire), agent_core::win::tick_ms());
    let slot = |value: &AtomicU32| if current { float(value.load(Ordering::Relaxed)) } else { f32::NAN };
    let ticks = timer_ticks(minecraft);
    for _ in 0..ticks {
        let tick = LIVE.tick.fetch_add(1, Ordering::AcqRel) + 1;
        core.tick(&TickSample {
            tick,
            position: [slot(&LIVE.position[0]), slot(&LIVE.position[1]), slot(&LIVE.position[2])],
            // A non-finite rotation renders as `null` on the wire: the client drops the sample
            // instead of believing a made-up view.
            rotation: [slot(&LIVE.rotation[0]), slot(&LIVE.rotation[1])],
            velocity: [slot(&LIVE.velocity[0]), slot(&LIVE.velocity[1]), slot(&LIVE.velocity[2])],
            on_ground: match (current, LIVE.ground.load(Ordering::Acquire)) {
                (true, 1) => Some(true),
                (true, 2) => Some(false),
                _ => None,
            },
            // Neither the attribute map walk nor the hotbar binding is decoded: null, never a guess.
            health: None,
            selected_slot: None,
        });
    }
}

/// How many whole ticks this step will run, from the simulation timer (`advanceTime`'s output).
fn timer_ticks(minecraft: usize) -> i32 {
    let Some(timer) = pe::read::<usize>(minecraft + MC_TIMER) else {
        return 1;
    };
    if timer == 0 {
        return 1;
    }
    match pe::read::<i32>(timer + TIMER_TICKS) {
        Some(ticks) => ticks.clamp(0, TIMER_MAX_TICKS),
        None => 1,
    }
}

/* ------------------------------------------------------------------------------------------------
 * The wire's player state
 * ---------------------------------------------------------------------------------------------- */

/// The newest reading as the wire's `player.state`, or `None` outside a world and until the first
/// client tick of this agent has published one (right after an attach the slots still hold zeros,
/// which a caller would take for a real position at the origin).
pub(crate) fn player_state() -> Option<Value> {
    if !in_world() || LIVE.published_client() == 0 {
        return None;
    }
    let position = Value::Array(LIVE.position.iter().map(|slot| number(float(slot.load(Ordering::Relaxed)))).collect());
    let velocity = Value::Array(LIVE.velocity.iter().map(|slot| number(float(slot.load(Ordering::Relaxed)))).collect());
    let rotation = Value::Array(LIVE.rotation.iter().map(|slot| number(float(slot.load(Ordering::Relaxed)))).collect());
    Some(json!({
        "position": position,
        // `[pitch, yaw]`, null while the rotation component could not be read.
        "rotation": rotation,
        // Movement since the previous tick, from the state vector's delta.
        "delta": velocity,
        "simTick": LIVE.tick.load(Ordering::Acquire),
        // The dimension id is not decoded.
        "dimension": Value::Null,
    }))
}

/* ------------------------------------------------------------------------------------------------
 * The view
 * ---------------------------------------------------------------------------------------------- */

/// `input.look`: store the requested view and keep the request open until the next client tick
/// confirms the game shows it.
pub(crate) fn request_look(core: &'static agent_core::Core, pitch: f32, yaw: f32) -> Result<Value, RpcError> {
    // The game keeps yaw in (-180, 180] and pitch in [-90, 90]; wrapping here means the value the
    // tick writes is the value the game would store, so the confirmation compares like with like.
    let yaw = wrap_degrees(yaw);
    if !in_world() {
        return Err(RpcError::not_in_world());
    }
    if !crate::anchors::attached() {
        return Err(RpcError::anchor("component.getter"));
    }
    // Without a client tick nothing can confirm a view, and deferring would hold the request (and the
    // drain that runs it) until the queue's timeout — a live `input.look` answered -32004 after six
    // seconds for exactly that reason.
    if LIVE.published_client() == 0 {
        return Err(RpcError::anchor("component.getter"));
    }
    let Some(deferred) = core.defer() else {
        // Not inside the drain: nothing can confirm it, so only store the view.
        core.set_look(pitch, yaw);
        return Ok(json!({ "pitch": pitch, "yaw": yaw }));
    };
    // Park the request before the tick can see the new epoch, so a confirmation cannot arrive before
    // there is a request to confirm.
    let previous = LOOK_PENDING.lock().take();
    if let Some(previous) = previous {
        previous.fail(RpcError::timeout());
    }
    *LOOK_PENDING.lock() = Some(deferred);
    core.set_look(pitch, yaw);
    Err(RpcError::deferred())
}

/// Confirms (or refuses) the view written on the previous client tick.
///
/// The game's own rotation pass accumulates into the component every tick, so a write that survives
/// a full tick is one the game honours; a write that is overwritten is not, and the request is
/// refused after [`LOOK_ATTEMPTS`] tries rather than reporting a view the game does not show.
fn verify_look(reading: &ecs::Reading) {
    if LOOK_STATE.load(Ordering::Acquire) != LOOK_WRITING {
        return;
    }
    let Some([pitch, yaw]) = look_target() else {
        LOOK_STATE.store(LOOK_IDLE, Ordering::Release);
        return;
    };
    let shown = reading.read_look();
    if shown.is_some_and(|[shown_pitch, shown_yaw]| close(shown_pitch, pitch) && close(shown_yaw, yaw)) {
        LOOK_STATE.store(LOOK_DONE, Ordering::Release);
        let pending = LOOK_PENDING.lock().take();
        if let Some(pending) = pending {
            pending.resolve(json!({ "pitch": pitch, "yaw": yaw }));
        }
    } else if LOOK_ATTEMPT.load(Ordering::Acquire) < LOOK_ATTEMPTS {
        // Overwritten between our write and this tick: try again from here.
        reading.write_look(pitch, yaw);
        LOOK_ATTEMPT.fetch_add(1, Ordering::AcqRel);
    } else {
        LOOK_STATE.store(LOOK_IDLE, Ordering::Release);
        // The read-back is the only evidence of what the game did with the write; log both so a live
        // run says whether the rotation pass, or the write itself, is the problem.
        fail(alloc::format!(
            "the game kept overriding the view: wrote {pitch:.2}/{yaw:.2}, the component still reads {shown:?}"
        ));
    }
}

/// Writes the view the socket thread asked for, and keeps it in place while the lock owns the camera.
fn write_look(core: &'static agent_core::Core, reading: &ecs::Reading) {
    let held = core.held_input();
    let Some([pitch, yaw]) = held.look else {
        return;
    };
    if held.look_epoch != LOOK_APPLIED.load(Ordering::Acquire) {
        if reading.write_look(pitch, yaw) {
            LOOK_APPLIED.store(held.look_epoch, Ordering::Release);
            LOOK_ATTEMPT.store(1, Ordering::Release);
            LOOK_STATE.store(LOOK_WRITING, Ordering::Release);
        } else {
            LOOK_STATE.store(LOOK_IDLE, Ordering::Release);
            fail(String::from("the local player's rotation component is not writable"));
        }
        return;
    }
    if core.lock_on() && !core.user_has_control() {
        // The lock owns the camera: put the agent's view back every tick.
        reading.write_look(pitch, yaw);
    }
}

/// The view the socket thread asked for, as `[pitch, yaw]`.
fn look_target() -> Option<[f32; 2]> {
    let core = agent_core::hub::started()?;
    core.held_input().look
}

fn fail(reason: String) {
    let pending = LOOK_PENDING.lock().take();
    if let Some(pending) = pending {
        pending.fail(RpcError::anchor("input.look"));
    }
    agent_core::log::fmt(format_args!("input.look: {reason}"));
}

/// `value` inside `(-180, 180]`: the range the game keeps yaw in.
///
/// Spelled with a truncating cast instead of `%` or `rem_euclid`, which compile to the CRT's
/// `fmodf` and are not linked here.
fn wrap_degrees(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    let turns = (value / 360.0) as i64 as f32;
    let mut wrapped = value - turns * 360.0;
    if wrapped > 180.0 {
        wrapped -= 360.0;
    }
    if wrapped <= -180.0 {
        wrapped += 360.0;
    }
    wrapped
}

fn close(a: f32, b: f32) -> bool {
    (a - b).abs() <= LOOK_EPSILON
}

/// Consecutive simulation frames this process's own world has been loaded, capped at [`STEADY_MAX`].
pub(crate) fn steady_frames() -> u32 {
    STEADY.load(Ordering::Acquire)
}

/// True once the loaded world has been up for [`STEADY_FRAMES`] simulation frames **and** the local
/// player has a readable position.
///
/// The frame count alone is not enough: this build reports a local world from the *server's* step
/// while the client's own player has no position yet (`player: … with no readable position yet`), and
/// acting on the world in that window is what took the game down. A world is settled when the player
/// can be seen in it.
pub(crate) fn settled() -> bool {
    steady_frames() >= STEADY_FRAMES && has_position()
}

/// True once a client tick has read the local player (its eye position was plausible); the published
/// feet may still be null when the collision box did not check out.
fn has_position() -> bool {
    LIVE.entity.load(Ordering::Acquire) != 0
}

impl Snapshot {
    /// The `GetTickCount64` of the last client tick that was let through the dedupe window.
    fn published_client(&self) -> u64 {
        self.client_stamp.load(Ordering::Relaxed)
    }

    fn mark_client(&self, now: u64) {
        self.client_stamp.store(now, Ordering::Release);
    }
}
