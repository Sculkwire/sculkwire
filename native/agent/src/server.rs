//! The server thread's request queue.
//!
//! The integrated server runs on its own thread: the simulation step ([`crate::live::sim_tick`]) is
//! the only place where commands execute and the simulation timer may be written. A `Thread::Main`
//! handler runs on the client's frame thread, so anything the server owns is queued here and applied
//! from the step, which keeps every game call on the thread that owns the object.
//!
//! Two callers share the queue: an RPC handler keeps its request open with
//! [`agent_core::queue::Deferred`] and the caller waits for the real outcome (the queue's own
//! timeout); [`run`] is the blocking form the input lock uses for `quiet_command`, bounded by its own
//! timeout. Both are bounded: a request that never runs answers `-32004 timeout`, never hangs.

use alloc::string::String;
use alloc::vec::Vec;
use core::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use agent_core::sync::SpinLock;
use agent_core::{queue, RpcError};
use serde_json::{json, Value};

use crate::{anchors, command, live, pe, world};

/// Requests that may wait for the server thread at once.
const JOBS: usize = 8;

const FREE: u8 = 0;
const QUEUED: u8 = 1;
const RUNNING: u8 = 2;
const DONE: u8 = 3;

/// One request for the server thread.
pub enum Request {
    /// A pause/resume through the engine's own switch.
    Pause(bool),
    /// Exactly this many more ticks, then frozen (the engine's step budget).
    Step(u32),
    /// Simulation time scale, `0.0 ..= 10.0`.
    Scale(f32),
    /// A command line, run as the local player with its output captured.
    Command { line: String, quiet: bool },
    /// Several command lines, then the world's settings as the level now reports them.
    Commands { lines: Vec<String>, quiet: bool },
    /// The world's settings, read on the server thread (the game type lookup writes a cache there).
    Settings,
    /// A function of another module, run on the server thread with its parameters, so the module that
    /// reads the server's state keeps that logic.
    Call(fn(&Value) -> Result<Value, RpcError>, Value),
}

struct Slot {
    state: AtomicU8,
    cancelled: AtomicBool,
    request: SpinLock<Option<Request>>,
    deferred: SpinLock<Option<queue::Deferred>>,
    reply: SpinLock<Option<Result<Value, RpcError>>>,
}

impl Slot {
    const fn new() -> Self {
        Self {
            state: AtomicU8::new(FREE),
            cancelled: AtomicBool::new(false),
            request: SpinLock::new(None),
            deferred: SpinLock::new(None),
            reply: SpinLock::new(None),
        }
    }

    fn clear(&self) {
        self.state.store(FREE, Ordering::Release);
        *self.request.lock() = None;
        *self.deferred.lock() = None;
        *self.reply.lock() = None;
        self.cancelled.store(false, Ordering::Release);
    }
}

static SLOTS: [Slot; JOBS] = [const { Slot::new() }; JOBS];

/// True when the simulation step is resolved, so queued work will actually run.
pub fn available() -> bool {
    anchors::sim_update().is_some()
}

/// Queues `request` for the next simulation step and keeps the caller's request open.
pub fn submit(core: &'static agent_core::Core, request: Request) -> Result<Value, RpcError> {
    if !available() {
        return Err(RpcError::anchor("sim.update"));
    }
    if !live::in_world() {
        return Err(RpcError::not_in_world());
    }
    if let Request::Pause(_) = request {
        if anchors::sim_pause().is_none() {
            return Err(RpcError::anchor("sim.pause"));
        }
    }
    let Some(deferred) = core.defer() else {
        return Err(RpcError::wrong_thread());
    };
    if enqueue(request, Some(deferred)).is_none() {
        return Err(RpcError::timeout());
    }
    Err(RpcError::deferred())
}

/// Runs `request` on the server thread and waits for it, up to `timeout_ms`.
pub fn run(request: Request, timeout_ms: u32) -> Result<Value, RpcError> {
    if !available() {
        return Err(RpcError::anchor("sim.update"));
    }
    if !live::in_world() {
        return Err(RpcError::not_in_world());
    }
    let Some(index) = enqueue(request, None) else {
        return Err(RpcError::timeout());
    };
    let slot = &SLOTS[index];
    let start = agent_core::win::tick_ms();
    loop {
        match slot.state.load(Ordering::Acquire) {
            DONE => {
                let reply = slot.reply.lock().take();
                slot.clear();
                return reply.unwrap_or_else(|| Err(RpcError::standard(agent_core::engine::INTERNAL_ERROR)));
            }
            FREE => return Err(RpcError::timeout()),
            _ => {}
        }
        if agent_core::win::tick_ms().saturating_sub(start) >= timeout_ms as u64 {
            slot.cancelled.store(true, Ordering::Release);
            if slot.state.compare_exchange(QUEUED, FREE, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                slot.clear();
            }
            return Err(RpcError::timeout());
        }
        agent_core::win::sleep_ms(1);
    }
}

fn enqueue(request: Request, deferred: Option<queue::Deferred>) -> Option<usize> {
    for index in 0..JOBS {
        let slot = &SLOTS[index];
        if slot.state.compare_exchange(FREE, QUEUED, Ordering::AcqRel, Ordering::Acquire).is_err() {
            continue;
        }
        slot.cancelled.store(false, Ordering::Release);
        *slot.request.lock() = Some(request);
        *slot.deferred.lock() = deferred;
        *slot.reply.lock() = None;
        return Some(index);
    }
    None
}

/// Applies every queued request. Called from the simulation step, on the server thread.
pub fn drain(minecraft: usize) {
    for index in 0..JOBS {
        let slot = &SLOTS[index];
        if slot.state.compare_exchange(QUEUED, RUNNING, Ordering::AcqRel, Ordering::Acquire).is_err() {
            continue;
        }
        if slot.cancelled.load(Ordering::Acquire) {
            slot.clear();
            continue;
        }
        let request = slot.request.lock().take();
        let deferred = slot.deferred.lock().take();
        let result = match request {
            Some(request) => apply(minecraft, request),
            None => Err(RpcError::standard(agent_core::engine::INTERNAL_ERROR)),
        };
        match deferred {
            Some(deferred) => {
                // A deferred request is answered through its handle, so nothing waits on this slot:
                // it is freed here. Leaving it `RUNNING` leaked one of the eight slots per request, and
                // the ninth server request of a session answered -32004 at once (live, run 5).
                if !deferred.cancelled() {
                    match result {
                        Ok(value) => {
                            deferred.resolve(value);
                        }
                        Err(error) => {
                            deferred.fail(error);
                        }
                    }
                }
                slot.clear();
            }
            None => {
                *slot.reply.lock() = Some(result);
                slot.state.store(DONE, Ordering::Release);
            }
        }
    }
}

fn apply(minecraft: usize, request: Request) -> Result<Value, RpcError> {
    let timer = pe::read::<usize>(minecraft + live::MC_TIMER).ok_or_else(|| RpcError::anchor("sim.update"))?;
    if timer == 0 {
        return Err(RpcError::anchor("sim.update"));
    }
    match request {
        Request::Pause(paused) => {
            let set = anchors::sim_pause().ok_or_else(|| RpcError::anchor("sim.pause"))?;
            // SAFETY: the game's own `void _setPaused(Minecraft*, uint32)`, called on the thread that
            // owns the simulation, between two of its own steps. It freezes the timer, resets the
            // clock samples on resume and notifies the Level.
            unsafe {
                core::mem::transmute::<usize, unsafe extern "C" fn(usize, u32)>(set)(minecraft, u32::from(paused));
            }
            // The switch's own effect: `Timer+0x3c` is -1 in real time and 0 while frozen.
            let expected = if paused { 0.0 } else { -1.0 };
            let step = pe::read::<f32>(timer + live::TIMER_STEP).unwrap_or(f32::NAN);
            Ok(json!({ "paused": paused, "success": step == expected }))
        }
        Request::Step(count) => {
            let set = anchors::sim_pause().ok_or_else(|| RpcError::anchor("sim.pause"))?;
            // SAFETY: the same switch, first, so the step budget starts from a frozen timer and the
            // level is notified; then the budget itself (`N` = exactly N more ticks).
            unsafe {
                core::mem::transmute::<usize, unsafe extern "C" fn(usize, u32)>(set)(minecraft, 1);
            }
            write_float(timer + live::TIMER_STEP, count as f32)?;
            let step = pe::read::<f32>(timer + live::TIMER_STEP).unwrap_or(f32::NAN);
            Ok(json!({ "paused": true, "ticks": count, "success": step == count as f32 }))
        }
        Request::Scale(scale) => {
            let scale = scale.clamp(0.0, live::TIMER_MAX_SCALE);
            write_float(timer + live::TIMER_SCALE, scale)?;
            let stored = pe::read::<f32>(timer + live::TIMER_SCALE).unwrap_or(f32::NAN);
            Ok(json!({ "scale": stored, "success": stored == scale }))
        }
        Request::Command { line, quiet } => command::run(minecraft, &line, quiet),
        Request::Settings => world::settings(),
        Request::Commands { lines, quiet } => {
            for line in &lines {
                let result = command::run(minecraft, line, quiet)?;
                if result.get("success").and_then(Value::as_bool) == Some(false) {
                    let message = result.get("message").and_then(Value::as_str).unwrap_or_default();
                    return Err(RpcError::command_failed(alloc::format!("{line}: {message}")));
                }
            }
            world::settings()
        }
        Request::Call(run, params) => run(&params),
    }
}

pub(crate) fn write_float(address: usize, value: f32) -> Result<(), RpcError> {
    if !pe::writable(address, 4) {
        return Err(RpcError::anchor("sim.update"));
    }
    // SAFETY: the range was just verified writable, and the timer is a plain structure of floats and
    // integers the server thread reads field by field.
    unsafe {
        core::ptr::write_unaligned(address as *mut f32, value);
    }
    Ok(())
}
