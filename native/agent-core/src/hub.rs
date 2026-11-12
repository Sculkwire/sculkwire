//! The agent's centre: the engine handle, the main-thread drain and its points, the tick stream, the
//! held input the socket thread stores and the main thread applies, and the small bits of state the
//! RPC server reports.
//!
//! The drain has two kinds of entry: the engine's own per-frame hook ([`Core::drain`]), which also
//! proves the calling thread is the client's own, and the window-message hooks in
//! [`crate::message_loop`] ([`Core::drain_message_loop`]), which run while the game pumps messages —
//! the entry that still exists on a build whose per-frame function is never called. Both run the same
//! work under a re-entrancy guard, and the message-loop one is rate limited so the game's message loop
//! keeps its own timing.
//!
//! There is one `Core` per process. It lives in static storage ([`instance`]), so the references it
//! hands out — `&'static Core`, `&'static Image` — are as long-lived as the DLL without any
//! allocation being leaked for them.

use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};

use alloc::string::String;
use alloc::vec::Vec;
use serde_json::{json, Value};

use crate::engine::{Anchor, Engine, Handler, RpcError, TickSample};
use crate::queue;
use crate::sync::{Once, SpinLock};
use crate::{image, lock, log, stream, win};

/// Movement the socket thread asked for: the wire's `input.move` fields, exactly.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Movement {
    /// -1 (back) … 1 (forward)
    pub forward: f32,
    /// -1 (left) … 1 (right)
    pub strafe: f32,
    pub jump: bool,
    pub sneak: bool,
    pub sprint: bool,
}

/// Bit layout of [`Movement::bits`], for engines that write a digital key-state component.
pub const MOVEMENT_UP: u32 = 1 << 0;
pub const MOVEMENT_DOWN: u32 = 1 << 1;
pub const MOVEMENT_LEFT: u32 = 1 << 2;
pub const MOVEMENT_RIGHT: u32 = 1 << 3;
pub const MOVEMENT_JUMP: u32 = 1 << 4;
pub const MOVEMENT_SNEAK: u32 = 1 << 5;
pub const MOVEMENT_SPRINT: u32 = 1 << 6;

/// The threshold at which an analog axis holds a key, as the game's own digital input does.
pub const MOVEMENT_THRESHOLD: f32 = 0.3;

impl Movement {
    pub const fn empty() -> Self {
        Self { forward: 0.0, strafe: 0.0, jump: false, sneak: false, sprint: false }
    }

    /// The digital flags: which keys this movement holds.
    pub fn bits(&self) -> u32 {
        let mut bits = 0;
        if self.forward >= MOVEMENT_THRESHOLD {
            bits |= MOVEMENT_UP;
        }
        if self.forward <= -MOVEMENT_THRESHOLD {
            bits |= MOVEMENT_DOWN;
        }
        if self.strafe >= MOVEMENT_THRESHOLD {
            bits |= MOVEMENT_RIGHT;
        }
        if self.strafe <= -MOVEMENT_THRESHOLD {
            bits |= MOVEMENT_LEFT;
        }
        if self.jump {
            bits |= MOVEMENT_JUMP;
        }
        if self.sneak {
            bits |= MOVEMENT_SNEAK;
        }
        if self.sprint {
            bits |= MOVEMENT_SPRINT;
        }
        bits
    }

    /// The inverse of [`bits`](Self::bits): the analog fields become their full-scale values.
    pub fn from_bits(bits: u32) -> Self {
        let axis = |neg: u32, pos: u32| -> f32 {
            if bits & pos != 0 {
                1.0
            } else if bits & neg != 0 {
                -1.0
            } else {
                0.0
            }
        };
        Self {
            forward: axis(MOVEMENT_DOWN, MOVEMENT_UP),
            strafe: axis(MOVEMENT_LEFT, MOVEMENT_RIGHT),
            jump: bits & MOVEMENT_JUMP != 0,
            sneak: bits & MOVEMENT_SNEAK != 0,
            sprint: bits & MOVEMENT_SPRINT != 0,
        }
    }
}

/// A copy of the held input, for the main thread.
#[derive(Clone, Copy, Default)]
pub struct HeldInput {
    /// The desired view as `[pitch, yaw]`, when the agent set one.
    pub look: Option<[f32; 2]>,
    /// Bumped for every `input.look`.
    pub look_epoch: u64,
    pub movement: Movement,
    /// Bumped for every `input.move` that holds a key.
    pub movement_epoch: u64,
    /// `GetTickCount64` of that `input.move`; the engine drops a hold after a second of silence.
    pub movement_stamp_ms: u64,
    /// Bumped by `input.release`; the engine clears held keys when it changes.
    pub release_epoch: u64,
}

impl HeldInput {
    pub fn moving(&self) -> bool {
        self.movement.bits() != 0
    }
}

struct HeldStore {
    look_pitch: AtomicU32,
    look_yaw: AtomicU32,
    look_epoch: AtomicU64,
    move_bits: AtomicU32,
    move_epoch: AtomicU64,
    move_stamp: AtomicU64,
    release_epoch: AtomicU64,
}

impl HeldStore {
    const fn new() -> Self {
        Self {
            look_pitch: AtomicU32::new(0),
            look_yaw: AtomicU32::new(0),
            look_epoch: AtomicU64::new(0),
            move_bits: AtomicU32::new(0),
            move_epoch: AtomicU64::new(0),
            move_stamp: AtomicU64::new(0),
            release_epoch: AtomicU64::new(0),
        }
    }

    fn snapshot(&self) -> HeldInput {
        let look_epoch = self.look_epoch.load(Ordering::Acquire);
        HeldInput {
            look: (look_epoch != 0).then(|| {
                [
                    f32::from_bits(self.look_pitch.load(Ordering::Relaxed)),
                    f32::from_bits(self.look_yaw.load(Ordering::Relaxed)),
                ]
            }),
            look_epoch,
            movement: Movement::from_bits(self.move_bits.load(Ordering::Relaxed)),
            movement_epoch: self.move_epoch.load(Ordering::Acquire),
            movement_stamp_ms: self.move_stamp.load(Ordering::Relaxed),
            release_epoch: self.release_epoch.load(Ordering::Acquire),
        }
    }
}

/// The agent, once per process.
pub struct Core {
    engine: &'static dyn Engine,
    anchors: SpinLock<Vec<Anchor>>,
    /// Thread id a client-side engine hook proved to be the game's own thread; 0 until one fires.
    client_thread: AtomicU32,
    /// That hook's name, as the pointer and length of the `&'static str` the engine handed in.
    client_source: AtomicUsize,
    client_source_len: AtomicU32,
    /// True once a client-side hook was seen on a thread other than the one that proved it.
    client_conflict: AtomicBool,
    /// Thread id the message loop runs on, 0 until its drain runs.
    message_thread: AtomicU32,
    /// How many times the message-loop drain ran.
    message_drains: AtomicU64,
    /// The message loop ran on a thread that is not the client's; reported once.
    message_foreign: AtomicBool,
    /// `QueryPerformanceCounter` microseconds of the last message-loop drain (the rate limit).
    drain_stamp: AtomicU64,
    /// The agent is unloading: every thread of this DLL must leave, and no new work starts.
    stopping: AtomicBool,
    /// A drain is running right now: the re-entrancy guard.
    draining: AtomicBool,
    /// The thread running a drain, and when it started: a fault inside a handler skips the guard's
    /// `Drop`, and a drain that never returns must not wedge every later main-thread request.
    drain_thread: AtomicU32,
    drain_since: AtomicU64,
    /// Drains released from outside the drain (a fault, or a stale drain found by a later one).
    drain_releases: AtomicU64,
    /// The stack address of the running drain's frame. A later entry on the same thread at this depth
    /// or above proves that frame is gone (a C++ exception the game caught unwound past it).
    drain_frame: AtomicUsize,
    attached: AtomicBool,
    frames: AtomicU64,
    ticks: AtomicU64,
    held: HeldStore,
}

static INSTANCE: Once<Core> = Once::new();

/// How often a drain may run from the message loop: at most one per this many microseconds.
///
/// A window procedure can be entered thousands of times a second; the queue is drained on the first
/// call after this interval, so a request waits at most two milliseconds and the game keeps its
/// message loop to itself.
const DRAIN_INTERVAL_US: u64 = 2_000;

/// How long a drain may stay "running" before a later entry treats it as dead and takes it over. Every
/// handler is bounded far below this (`tick.step` runs at most 600 ticks), so this only ever fires for a
/// handler that faulted and left its frame without clearing the flag.
const DRAIN_STALE_MS: u64 = 120_000;

/// Hook sites reported by `engine.status.hooks`.
const SITES: usize = 24;

/// One hook site: its name, whether its hook installed, how often it ran and on which thread first.
struct Site {
    name: AtomicUsize,
    len: AtomicU32,
    installed: AtomicBool,
    calls: AtomicU64,
    thread: AtomicU32,
}

impl Site {
    const fn new() -> Self {
        Self {
            name: AtomicUsize::new(0),
            len: AtomicU32::new(0),
            installed: AtomicBool::new(false),
            calls: AtomicU64::new(0),
            thread: AtomicU32::new(0),
        }
    }

    /// The site's name, or `None` for a free slot.
    fn text(&self) -> Option<&'static str> {
        let pointer = self.name.load(Ordering::Acquire);
        if pointer == 0 {
            return None;
        }
        let len = self.len.load(Ordering::Acquire) as usize;
        // SAFETY: the pointer and length are a `&'static str` the engine registered; it lives as long
        // as the process, and it is only written before `name` is published.
        Some(unsafe { core::str::from_utf8_unchecked(core::slice::from_raw_parts(pointer as *const u8, len)) })
    }
}

static SITE_TABLE: [Site; SITES] = [const { Site::new() }; SITES];

/// The index of `name` in the site table, claiming a free slot when `claim` is set.
fn site_index(name: &str, claim: bool) -> Option<usize> {
    let pointer = name.as_ptr() as usize;
    let mut free = None;
    for (index, site) in SITE_TABLE.iter().enumerate() {
        let existing = site.name.load(Ordering::Acquire);
        if existing == 0 {
            free.get_or_insert(index);
            continue;
        }
        if existing == pointer && site.len.load(Ordering::Acquire) as usize == name.len() {
            return Some(index);
        }
    }
    if !claim {
        return None;
    }
    // Claiming is registration, which runs on the attach thread; the compare keeps a racing caller
    // from writing over another site's name.
    for index in free.into_iter() {
        if SITE_TABLE[index].name.compare_exchange(0, pointer, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            SITE_TABLE[index].len.store(name.len() as u32, Ordering::Release);
            return Some(index);
        }
    }
    None
}

/// Creates (first call) and returns the process's `Core`.
pub fn init(engine: &'static dyn Engine) -> &'static Core {
    INSTANCE.get_or_init(|| Core {
        engine,
        anchors: SpinLock::new(Vec::new()),
        client_thread: AtomicU32::new(0),
        client_source: AtomicUsize::new(0),
        client_source_len: AtomicU32::new(0),
        client_conflict: AtomicBool::new(false),
        message_thread: AtomicU32::new(0),
        message_drains: AtomicU64::new(0),
        message_foreign: AtomicBool::new(false),
        drain_stamp: AtomicU64::new(0),
        stopping: AtomicBool::new(false),
        draining: AtomicBool::new(false),
        drain_thread: AtomicU32::new(0),
        drain_since: AtomicU64::new(0),
        drain_releases: AtomicU64::new(0),
        drain_frame: AtomicUsize::new(0),
        attached: AtomicBool::new(false),
        frames: AtomicU64::new(0),
        ticks: AtomicU64::new(0),
        held: HeldStore::new(),
    })
}

/// The process's `Core`.
///
/// # Panics
/// When called before [`crate::start`]; every caller runs after it.
pub fn instance() -> &'static Core {
    INSTANCE.get().expect("agent-core started")
}

/// The process's `Core`, if [`crate::start`] has run.
pub fn started() -> Option<&'static Core> {
    INSTANCE.get()
}

impl Core {
    /* ---------- what the contract exposes ---------- */

    /// Runs every queued main-thread request. The engine's per-frame hook calls this.
    ///
    /// A call here is also the evidence that this thread is the client's own: the per-frame hook is
    /// entered from the game's client loop.
    pub fn drain(&'static self) {
        self.note_client_thread("frame");
        self.run_drain("frame", false);
    }

    /// Runs the same work from a window-message hook: the drain point that exists even when the
    /// engine's per-frame function is never called by this build.
    ///
    /// It refuses when a client-side engine hook has proved the client's thread is another one, and
    /// runs at most once per [`DRAIN_INTERVAL_US`].
    pub fn drain_message_loop(&'static self, point: &'static str) {
        self.run_drain(point, true);
    }

    /// Releases a drain that will never return, and fails the request it was running.
    ///
    /// Called from the fault path — a handler that faults leaves this DLL's frame for good — and from
    /// [`Core::stale_drain`]. Leaving the flag set would refuse every later main-thread request for the
    /// life of the process, which is what a fault inside `ui.screen` used to do.
    pub fn release_drain(&'static self, why: &str) -> bool {
        if !self.draining.swap(false, Ordering::AcqRel) {
            return false;
        }
        let thread = self.drain_thread.swap(0, Ordering::AcqRel);
        self.drain_since.store(0, Ordering::Release);
        self.drain_frame.store(0, Ordering::Release);
        self.drain_releases.fetch_add(1, Ordering::AcqRel);
        let slot = queue::current_slot();
        let method = match queue::current_method() {
            Some(name) => alloc::format!("{name}"),
            None => alloc::string::String::from("none"),
        };
        let failed = queue::abort_current(RpcError::new(
            crate::engine::INTERNAL_ERROR,
            "the handler faulted inside the game's frame",
        ));
        log::fmt(format_args!(
            "drain: released by {why} (thread 0x{thread:x}, method {method}, slot {}, request failed: {failed})",
            match slot {
                Some(index) => alloc::format!("{index}"),
                None => alloc::string::String::from("none"),
            }
        ));
        true
    }

    /// The thread running a drain right now, or 0 when none is. The fault path uses it to tell that the
    /// faulting thread is the one holding the drain flag.
    pub fn drain_owner(&self) -> u32 {
        self.drain_thread.load(Ordering::Acquire)
    }

    /// How many drains were released from outside (`0` in a healthy process).
    pub fn drain_releases(&self) -> u64 {
        self.drain_releases.load(Ordering::Acquire)
    }

    /// True when a drain has been running longer than any handler may, in which case it is released.
    fn stale_drain(&'static self, now: u64) -> bool {
        if !self.draining.load(Ordering::Acquire) {
            return false;
        }
        let since = self.drain_since.load(Ordering::Acquire);
        if since == 0 || now.saturating_sub(since) < DRAIN_STALE_MS {
            return false;
        }
        self.release_drain("a drain that never returned")
    }

    /// The drain itself: the queue, the lock's per-frame work and the engine's per-frame work.
    fn run_drain(&'static self, point: &'static str, message_loop: bool) {
        // An unload is in flight: nothing may run, and nothing may re-arm a hook through the lock's
        // per-frame work (a live unload showed the drain re-installing the window hook it had just
        // removed, because the game's tick was still calling us).
        if self.stopping.load(Ordering::Acquire) {
            return;
        }
        let thread = win::current_thread_id();
        // This frame's own depth: a stack grows down, so a live drain further up the same thread's
        // stack always sits at a higher address than any drain nested inside it.
        let marker = 0u8;
        let frame = core::hint::black_box(&marker) as *const u8 as usize;
        // A drain that has been "running" for two minutes is not running: its handler faulted, and the
        // exception skipped the guard's `Drop` (an SEH unwind does not run Rust destructors), so this
        // flag would refuse every main-thread request from then on. Release it and fail the request it
        // still holds; a handler that legitimately runs for two minutes (`tick.step` is capped well
        // under it) is the only thing this can cut short, and it says so in the log. The same thread entering
        // again at the held drain's depth or above is proof at once: the game threw a C++ exception
        // through the handler and caught it in its own frame, so the held drain no longer exists.
        let unwound = self.draining.load(Ordering::Acquire)
            && self.drain_thread.load(Ordering::Acquire) == thread
            && self.drain_frame.load(Ordering::Acquire) != 0
            && frame >= self.drain_frame.load(Ordering::Acquire)
            && self.release_drain("a drain whose frame the game unwound (an exception it caught above the handler)");
        if unwound || self.stale_drain(win::tick_ms()) {
            // Released: this drain takes the place of the one that never returned.
            self.draining.store(true, Ordering::Release);
        } else if self.draining.swap(true, Ordering::AcqRel) {
            // A handler may call game code that pumps the message loop again, which would run a drain
            // inside a drain: one at a time, every other entry is refused.
            return;
        }
        self.drain_thread.store(thread, Ordering::Release);
        self.drain_since.store(win::tick_ms(), Ordering::Release);
        self.drain_frame.store(frame, Ordering::Release);
        let _guard = DrainGuard(self);
        if message_loop {
            let client = self.client_thread.load(Ordering::Acquire);
            if client != 0 && client != thread {
                if !self.message_foreign.swap(true, Ordering::AcqRel) {
                    log::fmt(format_args!(
                        "drain: the message loop is thread 0x{thread:x}, but the client thread is 0x{client:x}: not draining there"
                    ));
                }
                return;
            }
            // While nothing has proved which thread is the client's, the first message loop that
            // drains owns the drain: a worker thread that pumps messages of its own must not run game
            // calls just because it created a window.
            let owner = self.message_thread.load(Ordering::Acquire);
            if owner != 0 && owner != thread {
                if !self.message_foreign.swap(true, Ordering::AcqRel) {
                    log::fmt(format_args!(
                        "drain: the message loop ran on thread 0x{owner:x} first, not 0x{thread:x}: not draining there"
                    ));
                }
                return;
            }
            let now = win::qpc_micros();
            let last = self.drain_stamp.load(Ordering::Relaxed);
            if last != 0 && now.saturating_sub(last) < DRAIN_INTERVAL_US {
                return;
            }
            self.drain_stamp.store(now, Ordering::Relaxed);
            self.message_thread.store(thread, Ordering::Release);
            self.message_drains.fetch_add(1, Ordering::Relaxed);
        }
        if self.frames.fetch_add(1, Ordering::AcqRel) == 0 {
            log::fmt(format_args!("drain: first drain from {point} on thread 0x{thread:x}"));
        }
        queue::drain(|name| self.method(name));
        lock::frame(self);
        // The API the game reads the mouse through: hooked here, on the client's own thread, once the
        // module it lives in is loaded — and its queued input expired when no reading took it.
        crate::gameinput::frame(self);
        self.engine.lock_frame(self);
    }

    /// Records that a client-side engine hook ran on the calling thread: that thread is the game's own
    /// and is where [`Thread::Main`](crate::Thread::Main) methods may run.
    pub fn note_client_thread(&'static self, hook: &'static str) {
        let thread = win::current_thread_id();
        match self.client_thread.compare_exchange(0, thread, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => {
                self.client_source.store(hook.as_ptr() as usize, Ordering::Release);
                self.client_source_len.store(hook.len() as u32, Ordering::Release);
                log::fmt(format_args!("drain: {hook} ran on thread 0x{thread:x}, the game's own thread"));
            }
            Err(existing) if existing != thread => {
                if !self.client_conflict.swap(true, Ordering::AcqRel) {
                    log::fmt(format_args!(
                        "drain: {hook} ran on thread 0x{thread:x} while the client thread is 0x{existing:x}"
                    ));
                }
            }
            Err(_) => {}
        }
    }

    /// The thread main-thread requests run on: the client's own when an engine hook proved it,
    /// otherwise the thread a message-loop drain ran on (unproven).
    pub fn main_thread(&self) -> u32 {
        let client = self.client_thread.load(Ordering::Acquire);
        if client != 0 {
            client
        } else {
            self.message_thread.load(Ordering::Acquire)
        }
    }

    /// The hook that proved the client's thread, or `""`.
    fn client_source_text(&self) -> &'static str {
        let pointer = self.client_source.load(Ordering::Acquire);
        if pointer == 0 {
            return "";
        }
        let len = self.client_source_len.load(Ordering::Acquire) as usize;
        // SAFETY: the pointer and length are a `&'static str` the engine registered.
        unsafe { core::str::from_utf8_unchecked(core::slice::from_raw_parts(pointer as *const u8, len)) }
    }

    /// Feeds one simulation tick to the stream. The engine's per-tick hook calls this.
    pub fn tick(&'static self, sample: &TickSample) {
        self.ticks.fetch_add(1, Ordering::Relaxed);
        if stream::subscribers() == 0 {
            return;
        }
        let notification = json!({
            "jsonrpc": "2.0",
            "method": "tick",
            "params": sample.to_params(),
        });
        if let Ok(text) = serde_json::to_string(&notification) {
            stream::push(sample.tick as u32, text.as_bytes());
        }
    }

    /// True on the thread [`Core::drain`] runs on.
    pub fn is_main_thread(&self) -> bool {
        let thread = self.main_thread();
        thread != 0 && thread == win::current_thread_id()
    }

    /// True while the user's own keyboard and mouse are kept out of the game.
    pub fn lock_on(&self) -> bool {
        lock::on()
    }

    /// True when the user took control with F9 and has not given it back.
    pub fn user_has_control(&self) -> bool {
        lock::user_has_control()
    }

    /// Appends a line to `sculkwire-agent.log`.
    pub fn log(&self, text: &str) {
        log::line(text);
    }

    /// The game module's PE image.
    pub fn image(&self) -> &'static image::Image {
        image::game()
    }

    /// What the socket thread stored for the main thread to apply.
    pub fn held_input(&self) -> HeldInput {
        self.held.snapshot()
    }

    /* ---------- engine plumbing ---------- */

    pub fn engine(&self) -> &'static dyn Engine {
        self.engine
    }

    /// The handler of a queued method, from the engine's table.
    pub fn method(&self, name: &str) -> Option<Handler> {
        self.engine.methods().iter().find(|method| method.name == name).map(|method| method.handler)
    }

    /// The anchor list for `engine.status`: the engine's current one when it has one (runtime
    /// pointers resolve after `attach`), else the list `attach` returned.
    pub fn anchors(&self) -> Vec<Anchor> {
        let current = self.engine.anchors();
        if !current.is_empty() {
            return current;
        }
        self.anchors.lock().clone()
    }

    /* ---------- hook sites ---------- */

    /// Declares one hook site for `engine.status.hooks`: its name and whether its hook installed.
    ///
    /// The engine calls this once per hook it tried, installed or not, so a hook that was refused
    /// shows up as `installed: false` instead of disappearing.
    pub fn site(&'static self, name: &'static str, installed: bool) {
        let Some(index) = site_index(name, true) else {
            return;
        };
        SITE_TABLE[index].installed.store(installed, Ordering::Release);
    }

    /// Records that a hook ran, on the calling thread.
    ///
    /// The first call stores the thread id and logs it: a hook that never fires leaves `thread` null,
    /// which is how a stalled engine path (a frame function this build does not call) is visible.
    pub fn site_fired(&'static self, name: &'static str) {
        let Some(index) = site_index(name, false) else {
            return;
        };
        let site = &SITE_TABLE[index];
        site.calls.fetch_add(1, Ordering::Relaxed);
        let thread = win::current_thread_id();
        if site.thread.compare_exchange(0, thread, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            log::fmt(format_args!("hook {name}: first call on thread 0x{thread:x}"));
        }
    }

    /// `engine.status.hooks`: one entry per declared site.
    fn hooks(&self) -> Value {
        let mut out = serde_json::Map::new();
        for site in &SITE_TABLE {
            let Some(name) = site.text() else {
                continue;
            };
            let thread = site.thread.load(Ordering::Acquire);
            out.insert(
                String::from(name),
                json!({
                    "installed": site.installed.load(Ordering::Acquire),
                    "calls": site.calls.load(Ordering::Acquire),
                    "thread": if thread == 0 { Value::Null } else { Value::from(thread) },
                }),
            );
        }
        Value::Object(out)
    }

    /// `engine.status.mainThread`: which thread main-thread methods run on, and what proved it.
    fn main_thread_label(&self) -> Value {
        let client = self.client_thread.load(Ordering::Acquire);
        if client != 0 {
            return Value::String(alloc::format!("{} (0x{:x})", self.client_source_text(), client));
        }
        if self.message_drains.load(Ordering::Acquire) != 0 {
            // A window-thread drain runs, but no client-side engine hook has confirmed its thread is
            // the game's own: the equality is unproven, and the status says exactly that.
            let thread = self.message_thread.load(Ordering::Acquire);
            if thread != 0 {
                return Value::String(alloc::format!("window-thread (unverified) 0x{thread:x}"));
            }
            return Value::String(String::from("window-thread (unverified)"));
        }
        Value::Null
    }

    pub(crate) fn set_anchors(&self, anchors: Vec<Anchor>) {
        *self.anchors.lock() = anchors;
        self.attached.store(true, Ordering::Release);
    }

    /// Starts the unload: every thread of this DLL checks this and returns.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
    }

    /// True once `agent.unload` has begun.
    pub fn stopping(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }

    /// True once `Engine::attach` has returned.
    pub fn attached(&self) -> bool {
        self.attached.load(Ordering::Acquire)
    }

    /// True once a drain has run from any of its points: the DLL is live in the game.
    pub fn hooked(&self) -> bool {
        self.frames.load(Ordering::Acquire) > 0
    }

    /// Drains that ran, from any point.
    pub fn frames(&self) -> u64 {
        self.frames.load(Ordering::Relaxed)
    }

    /// Ticks the stream has seen.
    pub fn ticks(&self) -> u64 {
        self.ticks.load(Ordering::Relaxed)
    }

    /// The deferred handle of the handler running right now, if any.
    pub fn defer(&self) -> Option<queue::Deferred> {
        queue::current()
    }

    /* ---------- the state the socket thread writes ---------- */

    /// Stores a desired view and returns its epoch. `input.look` calls this.
    pub fn set_look(&self, pitch: f32, yaw: f32) -> u64 {
        self.held.look_pitch.store(pitch.to_bits(), Ordering::Relaxed);
        self.held.look_yaw.store(yaw.to_bits(), Ordering::Relaxed);
        self.held.look_epoch.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// Stores the held movement and returns its epoch. `input.move` calls this.
    pub fn set_movement(&self, movement: Movement) -> u64 {
        self.held.move_bits.store(movement.bits(), Ordering::Relaxed);
        self.held.move_stamp.store(win::tick_ms(), Ordering::Relaxed);
        self.held.move_epoch.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// Clears the held movement: `input.release`, and the input lock taking over.
    pub fn clear_movement(&self) -> u64 {
        self.held.move_bits.store(0, Ordering::Relaxed);
        self.held.move_stamp.store(0, Ordering::Relaxed);
        self.held.move_epoch.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// Records an `input.release`, so an engine can drop keys it applied itself.
    pub fn note_release(&self) -> u64 {
        self.held.release_epoch.fetch_add(1, Ordering::AcqRel) + 1
    }

    /* ---------- reporting ---------- */

    /// The `engine.status` / `engine.resolve` result.
    pub fn status(&self) -> Value {
        let anchors = self.anchors();
        let mut resolved = serde_json::Map::new();
        let mut missing = Vec::new();
        for anchor in anchors {
            if anchor.addr == 0 {
                missing.push(Value::String(String::from(anchor.name)));
            } else {
                resolved.insert(String::from(anchor.name), Value::String(alloc::format!("0x{:x}", anchor.addr)));
            }
        }
        let mut status = json!({
            "build": self.engine.build(),
            // A drain has run: the DLL is live in the game.
            "hooked": self.hooked(),
            // `Engine::attach` has returned: every anchor below is final (until then it is still resolving).
            "attached": self.attached(),
            "tick": self.ticks(),
            // Which thread main-thread methods run on, and the hook that proved it.
            "mainThread": self.main_thread_label(),
            // Every hook the engine installed, with its first thread and its call count.
            "hooks": self.hooks(),
            // The GameInput vtables the agent drives menus through, and what their readings have seen.
            "gameinput": crate::gameinput::json(),
            // The port the socket server bound: a hot reload that could not take the expected one says so
            // here (the host only dials the first).
            "port": crate::rpc::bound_port(),
            // Drains released from outside: a fault inside a handler, or one that never returned. Non-zero
            // means a main-thread request was failed instead of wedging the queue.
            "drainReleases": self.drain_releases(),
            "resolved": Value::Object(resolved),
            "missing": Value::Array(missing),
        });
        // The engine's own view (the game objects it sees and their roles), when it has one.
        if let Some(extra) = self.engine.status() {
            if let (Value::Object(target), Value::Object(extra)) = (&mut status, extra) {
                for (key, value) in extra {
                    target.insert(key, value);
                }
            }
        }
        status
    }

    /// The lock state, for `input.lock`, `input.focus` and the `lock` notification.
    pub fn lock_state(&self) -> Value {
        lock::json()
    }

    /// Runs `engine.quiet_command`, mapped to the wire's errors.
    pub fn quiet_command(&'static self, line: &str) -> Result<(), RpcError> {
        self.engine.quiet_command(self, line)
    }
}

/// Clears the drain flags when the drain leaves normally. A fault inside a handler skips this `Drop`
/// (a foreign exception unwinds through SEH, not through Rust's drops), which is why the same flags are
/// also cleared from the fault path and by [`Core::stale_drain`].
struct DrainGuard<'a>(&'a Core);

impl Drop for DrainGuard<'_> {
    fn drop(&mut self) {
        // Only the drain that owns the flag clears it: a stale takeover in another thread may already
        // have handed the flag to a newer drain, and this one must not clear that one's.
        if self.0.drain_thread.load(Ordering::Acquire) == win::current_thread_id() {
            self.0.drain_since.store(0, Ordering::Release);
            self.0.drain_thread.store(0, Ordering::Release);
            self.0.draining.store(false, Ordering::Release);
        }
    }
}
