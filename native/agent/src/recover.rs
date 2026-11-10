//! Late-attach recovery: deriving, from the objects a running world hands us, everything the game
//! only ever captures at startup.
//!
//! An agent injected into a game that is already in a world cannot see the one-shot moments its hooks
//! were written for: `Options` is registered during boot and `LevelData` is loaded with the world.
//! Those hooks are still installed (an early attach gets the objects for free), but after a late
//! attach the same objects have to be *derived* from what the simulation step hands us.
//!
//! The chain, each step validated before it is believed (all of it confirmed on a live 1.26.63.1
//! process, see [`crate::live::commands`] and [`crate::world`]):
//!
//! ```text
//! ServerInstance                          .data: [+0xd8]/[+0xe0] two simulation `Timer`s
//!   +0xb8 -> Minecraft*                   the *server's* object, not the client's
//!     +0xd0 -> holder; holder+0x40 -> Level
//!       +0x90 -> LevelData*               five field checks (name, storage, difficulty, game, flags)
//!       +0x78 -> MinecraftCommands*       provider/registry/sender/queue validated
//! .data -> Options                         the object whose vtable is the registry vtable
//! ```
//!
//! **Every scan runs on this module's own thread, never on the game's tick.** The first version did
//! the work inline in `sim.update`, and the live session showed why that is wrong: two `Minecraft`
//! objects step, the level alternated between them, the attempt counter reset every tick, and the
//! whole chain (including a 0x8000-byte field scan and megabytes of `.data`) ran twenty times a
//! second inside the simulation — the FPS drop. Here the tick only stores two words; the scans are
//! paced, capped per level, and stop as soon as the chain is complete.

use core::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};

use crate::{live, world};

/// The delay before the first attempt: the tick has to run once for the world to be identified.
const FIRST_DELAY_MS: u64 = 200;
/// Back-off between attempts, doubled after each failure up to the cap.
const START_BACKOFF_MS: u64 = 400;
const MAX_BACKOFF_MS: u64 = 8_000;
/// Attempts per level before that level is left alone for good.
const ATTEMPTS_PER_LEVEL: u32 = 6;
/// How many levels are tracked at once (a world change starts a new one).
const LEVELS: usize = 4;

/// What one attempt is trying to complete.
#[derive(Default)]
struct LevelState {
    level: AtomicUsize,
    attempts: AtomicU32,
    given_up: AtomicUsize,
}

static LEVEL_STATE: [LevelState; LEVELS] =
    [const { LevelState::new() }, const { LevelState::new() }, const { LevelState::new() }, const { LevelState::new() }];

impl LevelState {
    const fn new() -> Self {
        Self { level: AtomicUsize::new(0), attempts: AtomicU32::new(0), given_up: AtomicUsize::new(0) }
    }
}

/// The newest `(minecraft, level)` the tick handed over; 0 = nothing new.
static PENDING_MINECRAFT: AtomicUsize = AtomicUsize::new(0);
static PENDING_LEVEL: AtomicUsize = AtomicUsize::new(0);
/// The recovery thread is running.
static RUNNING: AtomicUsize = AtomicUsize::new(0);
/// Scans have been run.
static ATTEMPTS: AtomicU64 = AtomicU64::new(0);

/// Called from the simulation tick: stores the object pair and returns at once.
///
/// Two atomic stores and a compare, so the tick never waits for a scan.
pub fn note(minecraft: usize, level: Option<usize>) {
    let Some(level) = level else {
        return;
    };
    PENDING_MINECRAFT.store(minecraft, Ordering::Release);
    PENDING_LEVEL.store(level, Ordering::Release);
    // Never start while the world is still loading: the load path is where the level, the local server
    // and the client's first frame are half-built, and a scan that lands there races all of them.
    if !live::settled() {
        return;
    }
    if RUNNING.load(Ordering::Acquire) == 0 {
        start();
    }
}

/// Starts the recovery thread once.
fn start() {
    if RUNNING.swap(1, Ordering::AcqRel) == 1 {
        return;
    }
    if !agent_core::thread::spawn("recover", thread_main, 0) {
        RUNNING.store(0, Ordering::Release);
    }
}

/// The recovery thread: one bounded step per wake-up, paced, and quiet once the chain is complete.
extern "system" fn thread_main(_arg: usize) -> u32 {
    let mut backoff = START_BACKOFF_MS;
    let mut last_minecraft = 0usize;
    let mut last_level = 0usize;
    loop {
        agent_core::win::sleep_ms(FIRST_DELAY_MS as u32);
        // An unload waits for this thread to return before it frees the image: this loop is the only one
        // of the agent's threads that has no socket to wake it, so the stop flag is its exit.
        if agent_core::hub::started().is_some_and(|core| core.stopping()) {
            agent_core::log::line("recover: stopping");
            return 0;
        }
        let minecraft = PENDING_MINECRAFT.load(Ordering::Acquire);
        let level = PENDING_LEVEL.load(Ordering::Acquire);
        if level == 0 {
            continue;
        }
        if !live::settled() {
            // The world is loading (or has just been replaced): wait, without spending an attempt.
            let _ = pause(START_BACKOFF_MS);
            continue;
        }
        // A new object pair is a new world: reset the pace so the first attempt is prompt.
        if level != last_level || minecraft != last_minecraft {
            last_level = level;
            last_minecraft = minecraft;
            backoff = START_BACKOFF_MS;
        }
        let state = match level_slot(level) {
            Some(state) => state,
            None => continue,
        };
        if state.given_up.load(Ordering::Acquire) == level {
            continue;
        }
        // The whole chain already in hand: nothing left to scan for this level. A new level clears
        // `level.data` and the command manager (`world::note_level`), so this cannot mistake one world
        // for another. `server.instance` is only a hint and is not part of "complete".
        if crate::anchors::level_data().is_some() && crate::anchors::command_commands().is_some() {
            state.given_up.store(level, Ordering::Release);
            agent_core::log::fmt(format_args!("recover: Level 0x{level:x} is fully described"));
            continue;
        }
        let attempt = state.attempts.fetch_add(1, Ordering::AcqRel) + 1;
        if attempt > ATTEMPTS_PER_LEVEL {
            state.given_up.store(level, Ordering::Release);
            agent_core::log::fmt(format_args!(
                "recover: leaving Level 0x{level:x} alone after {ATTEMPTS_PER_LEVEL} attempts (level.data {}, command.commands {})",
                present(crate::anchors::level_data().is_some()),
                present(crate::anchors::command_commands().is_some())
            ));
            continue;
        }
        ATTEMPTS.fetch_add(1, Ordering::Relaxed);
        // The role of each object comes from `sim.update` (validated there by the level's command
        // manager); the pair the tick handed over is only used while no role is known yet.
        let (minecraft, level) = match (live::server_object(), live::server_level()) {
            (Some(server), Some(server_level)) => (server, server_level),
            _ => (minecraft, level),
        };
        agent_core::log::fmt(format_args!(
            "recover: attempt {attempt}/{ATTEMPTS_PER_LEVEL} on Minecraft 0x{minecraft:x} -> Level 0x{level:x}"
        ));
        // Every step below is a **guarded read**: this thread never calls a game function (a call here
        // would run game code off the main thread, in the middle of the load, which is what took the
        // game down). A step that would need a game call belongs on the client's main thread instead.
        //
        // 1. The loaded world's own data, inside the level.
        agent_core::log::fmt(format_args!("recover: step 1 world::recover(level 0x{level:x})"));
        world::recover(level);
        // 2. The command manager, a field of the same level.
        agent_core::log::fmt(format_args!("recover: step 2 live::commands(minecraft 0x{minecraft:x})"));
        live::commands(minecraft);
        // 3. The local server, as a hint only: its `+0xb8` must be an object we actually tick.
        agent_core::log::fmt(format_args!("recover: step 3 live::server_instance(minecraft 0x{minecraft:x})"));
        live::server_instance(minecraft);
        // The `Options` object is deliberately **not** looked for here. Its discovery walks the
        // module's `.data` and then the heap, and this thread runs on the world-load path where the
        // renderer and the server are both allocating: a scan of a snapshot region list is one
        // unmapped page away from taking the game down, and it is not worth it for a lookup nobody
        // asked for yet. `settings.*` discovers it lazily, on the client's own thread, from the
        // request that needs it ([`crate::methods::settings_list`] and friends).
        // Pace the next attempt: a failure waits longer each time instead of retrying every tick. The
        // wait is sliced so an unload (which waits for this thread before it frees the image) is not
        // left behind by a backoff of seconds.
        if !pause(backoff) {
            agent_core::log::line("recover: stopping");
            return 0;
        }
        backoff = (backoff * 2).min(MAX_BACKOFF_MS);
    }
}

/// Sleeps for `ms` in 100 ms slices. Answers `false` as soon as the agent is stopping, so the caller can
/// leave: this thread has no socket to wake it, and `agent.unload` waits for it before freeing the image.
fn pause(ms: u64) -> bool {
    let mut left = ms;
    while left > 0 {
        if agent_core::hub::started().is_some_and(|core| core.stopping()) {
            return false;
        }
        let slice = left.min(100);
        agent_core::win::sleep_ms(slice as u32);
        left -= slice;
    }
    true
}

/// The state slot that owns `level`, claiming a free (or the oldest given-up) slot.
fn level_slot(level: usize) -> Option<&'static LevelState> {
    for state in &LEVEL_STATE {
        if state.level.load(Ordering::Acquire) == level {
            return Some(state);
        }
    }
    for state in &LEVEL_STATE {
        if state.level.compare_exchange(0, level, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            return Some(state);
        }
    }
    // Every slot is taken by a level we have left alone: reuse the first one.
    for state in &LEVEL_STATE {
        if state.given_up.load(Ordering::Acquire) != 0 {
            state.level.store(level, Ordering::Release);
            state.attempts.store(0, Ordering::Release);
            state.given_up.store(0, Ordering::Release);
            return Some(state);
        }
    }
    None
}

/// `found` / `missing` for a recovery log line.
fn present(found: bool) -> &'static str {
    if found {
        "found"
    } else {
        "missing"
    }
}
