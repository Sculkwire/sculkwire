//! The main-thread request queue and its drain.
//!
//! A method marked [`Thread::Main`](crate::Thread::Main) must run on the game's own thread, so the
//! connection thread parks the request in a slot and waits; [`drain`] runs it from
//! [`Core::drain`](crate::Core::drain), which the engine calls at the top of its frame. The socket
//! thread never calls game code, so no engine assertion about threads can fire.
//!
//! A handler that needs several frames (a stepped tick) keeps its slot open with
//! [`Core::defer`](crate::Core::defer) and returns [`RpcError::deferred`]; it finishes the request
//! with [`Deferred::resolve`] from its own hook. If the caller's timeout expires first, the slot is
//! cancelled and a later resolution is dropped.

use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, AtomicUsize, Ordering};

use serde_json::Value;

use crate::engine::{Handler, RpcError, DEFERRED};
use crate::sync::SpinLock;
use crate::{log, win};

/// Slots, matching `agent.c`'s `QCAP`.
pub const CAPACITY: usize = 16;

/// No slot is running right now.
const NO_SLOT: usize = usize::MAX;

const FREE: u8 = 0;
const QUEUED: u8 = 1;
const RUNNING: u8 = 2;
const DONE: u8 = 3;

struct Slot {
    state: AtomicU8,
    cancelled: AtomicBool,
    timeout_ms: AtomicU32,
    /// The method this slot's request named, kept while it runs: a fault needs to name the handler.
    method: SpinLock<&'static str>,
    request: SpinLock<Option<(&'static str, Value)>>,
    result: SpinLock<Option<Result<Value, RpcError>>>,
}

impl Slot {
    const fn new() -> Self {
        Self {
            state: AtomicU8::new(FREE),
            cancelled: AtomicBool::new(false),
            timeout_ms: AtomicU32::new(0),
            method: SpinLock::new(""),
            request: SpinLock::new(None),
            result: SpinLock::new(None),
        }
    }

    /// Frees the slot, dropping whatever it held.
    ///
    /// The state goes to `FREE` last: `submit` takes a slot by that state alone, and clearing the payload
    /// after publishing `FREE` would wipe the request that call had just stored.
    fn clear(&self) {
        *self.request.lock() = None;
        *self.result.lock() = None;
        self.cancelled.store(false, Ordering::Release);
        self.state.store(FREE, Ordering::Release);
    }
}

static SLOTS: [Slot; CAPACITY] = [const { Slot::new() }; CAPACITY];

/// The slot whose handler is running, for [`defer`].
static CURRENT: AtomicUsize = AtomicUsize::new(NO_SLOT);

/// The request timeout `agent.c` uses per method.
pub fn timeout_for(method: &str) -> u32 {
    if method == "tick.step" {
        30_000
    } else {
        6_000
    }
}

/// A request waiting for the main thread.
pub struct Pending {
    slot: usize,
    method: &'static str,
}

impl Pending {
    /// Waits for the result, or for `timeout_ms`, whichever comes first.
    pub fn wait(self, timeout_ms: u32) -> Result<Value, RpcError> {
        let slot = &SLOTS[self.slot];
        let method = self.method;
        let start = win::tick_ms();
        loop {
            match slot.state.load(Ordering::Acquire) {
                DONE => {
                    let result = slot.result.lock().take();
                    // Clear the payload while the slot is still `DONE`, then hand it back: a `submit`
                    // that took it in between would otherwise find its own request already wiped.
                    *slot.request.lock() = None;
                    let _ = slot.state.compare_exchange(DONE, FREE, Ordering::AcqRel, Ordering::Acquire);
                    return result.unwrap_or_else(|| Err(RpcError::new(crate::engine::INTERNAL_ERROR, "empty result")));
                }
                FREE => return Err(RpcError::timeout()),
                _ => {}
            }
            if win::tick_ms().saturating_sub(start) >= timeout_ms as u64 {
                slot.cancelled.store(true, Ordering::Release);
                if slot.state.load(Ordering::Acquire) == QUEUED {
                    *slot.request.lock() = None;
                    *slot.result.lock() = None;
                    let _ = slot.state.compare_exchange(QUEUED, FREE, Ordering::AcqRel, Ordering::Acquire);
                }
                // A main-thread request that nobody ran says which drain points are alive: the frame
                // hook may not be called by this build, and the message loop may not be the client's
                // thread.
                if let Some(core) = crate::hub::started() {
                    log::fmt(format_args!(
                        "queue: {method} timed out after {timeout_ms} ms: {} drain(s), main thread {}",
                        core.frames(),
                        match core.main_thread() {
                            0 => alloc::string::String::from("not known yet"),
                            thread => alloc::format!("0x{thread:x}"),
                        }
                    ));
                }
                // A running handler keeps the slot until it finishes or resolves; its result is
                // dropped then, because `cancelled` is set.
                return Err(RpcError::timeout());
            }
            win::sleep_ms(1);
        }
    }

    pub fn method(&self) -> &'static str {
        self.method
    }
}

/// Queues a main-thread request, or returns `None` when every slot is busy or the agent is unloading.
pub fn submit(method: &'static str, params: Value) -> Option<Pending> {
    if crate::hub::started().is_some_and(|core| core.stopping()) {
        return None;
    }
    for index in 0..CAPACITY {
        let slot = &SLOTS[index];
        if !take_for(method, slot) {
            continue;
        }
        slot.cancelled.store(false, Ordering::Release);
        slot.timeout_ms.store(timeout_for(method), Ordering::Release);
        *slot.method.lock() = method;
        *slot.result.lock() = None;
        *slot.request.lock() = None;
        *slot.request.lock() = Some((method, params));
        return Some(Pending { slot: index, method });
    }
    None
}

/// Takes one slot for a new request: the free ones directly, and a slot a caller abandoned as `DONE`
/// — its request timed out before the handler answered, or an unload failed it — after clearing it. A
/// `DONE` slot nobody takes would be unusable for the life of the process, and sixteen of them would
/// end every later request with "queue full".
fn take_for(_method: &str, slot: &Slot) -> bool {
    if slot.state.compare_exchange(FREE, QUEUED, Ordering::AcqRel, Ordering::Acquire).is_ok() {
        return true;
    }
    if slot.state.compare_exchange(DONE, FREE, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return false;
    }
    *slot.request.lock() = None;
    *slot.result.lock() = None;
    slot.cancelled.store(false, Ordering::Release);
    slot.state.compare_exchange(FREE, QUEUED, Ordering::AcqRel, Ordering::Acquire).is_ok()
}

/// Runs every queued request on the calling (main) thread.
///
/// `resolve` maps a queued method name to its handler; it is called here, on the main thread, so the
/// engine's table is read where it is safe to read it.
pub fn drain(resolve: impl Fn(&'static str) -> Option<Handler>) {
    for index in 0..CAPACITY {
        let slot = &SLOTS[index];
        if slot.state.compare_exchange(QUEUED, RUNNING, Ordering::AcqRel, Ordering::Acquire).is_err() {
            continue;
        }
        if slot.cancelled.load(Ordering::Acquire) {
            slot.clear();
            continue;
        }
        let request = slot.request.lock().take();
        let Some((method, params)) = request else {
            slot.clear();
            continue;
        };
        let Some(handler) = resolve(method) else {
            *slot.result.lock() = Some(Err(RpcError::new(crate::engine::UNKNOWN_METHOD, crate::error_message(crate::engine::UNKNOWN_METHOD))));
            slot.state.store(DONE, Ordering::Release);
            continue;
        };

        CURRENT.store(index, Ordering::Release);
        let result = handler(crate::hub::instance(), &params);
        let _ = CURRENT.compare_exchange(index, NO_SLOT, Ordering::AcqRel, Ordering::Acquire);

        match result {
            Err(error) if error.code == DEFERRED => {
                // The handler kept the slot; `Deferred::resolve` finishes it.
                crate::log::fmt(format_args!("drain: slot {index} deferred ({method})"));
            }
            result => {
                if slot.cancelled.load(Ordering::Acquire) {
                    slot.clear();
                } else {
                    *slot.result.lock() = Some(result);
                    // Only this request's own slot may become `DONE`: a timeout, an unload or a fault
                    // release can have taken it away meanwhile, and answering a slot someone else now
                    // owns would hand them a value built for another request.
                    if slot.state.compare_exchange(RUNNING, DONE, Ordering::AcqRel, Ordering::Acquire).is_err() {
                        *slot.result.lock() = None;
                    }
                }
            }
        }
    }
}

/// Fails every queued request at once, for the unload: a caller waiting on the main thread learns its
/// request will not run instead of waiting for the timeout.
pub fn abort_all() -> usize {
    let mut failed = 0usize;
    for slot in &SLOTS {
        let state = slot.state.load(Ordering::Acquire);
        if state != QUEUED && state != RUNNING {
            continue;
        }
        slot.cancelled.store(true, Ordering::Release);
        *slot.result.lock() = Some(Err(RpcError::standard(crate::engine::TIMEOUT)));
        slot.state.store(DONE, Ordering::Release);
        failed += 1;
    }
    failed
}

/// A request the calling handler kept open. Copy it into the engine's state; resolving it from a
/// later frame (a tick hook) is what makes `tick.step` work.
#[derive(Clone, Copy)]
pub struct Deferred {
    slot: usize,
}

impl Deferred {
    /// Finishes the request with `value`. Returns false when it already timed out or was answered.
    pub fn resolve(self, value: Value) -> bool {
        self.finish(Ok(value))
    }

    /// Finishes the request with `error`.
    pub fn fail(self, error: RpcError) -> bool {
        self.finish(Err(error))
    }

    /// True when the caller gave up on this request; the engine should drop its step state.
    pub fn cancelled(&self) -> bool {
        SLOTS[self.slot].cancelled.load(Ordering::Acquire)
    }

    /// The timeout this request was given.
    pub fn timeout_ms(&self) -> u32 {
        SLOTS[self.slot].timeout_ms.load(Ordering::Acquire)
    }

    fn finish(self, result: Result<Value, RpcError>) -> bool {
        let slot = &SLOTS[self.slot];
        if slot.cancelled.load(Ordering::Acquire) {
            if slot.state.compare_exchange(RUNNING, FREE, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                *slot.request.lock() = None;
                *slot.result.lock() = None;
            }
            return false;
        }
        *slot.result.lock() = Some(result);
        // `RUNNING -> DONE` only for this request: if the slot was recycled (the caller timed out and a
        // new request took it), the value stored above is dropped instead of being handed to that one.
        if slot.state.compare_exchange(RUNNING, DONE, Ordering::AcqRel, Ordering::Acquire).is_err() {
            *slot.result.lock() = None;
            return false;
        }
        true
    }
}

/// The slot whose handler is running, or `None`.
pub fn current_slot() -> Option<usize> {
    let slot = CURRENT.load(Ordering::Acquire);
    (slot != NO_SLOT && slot < CAPACITY).then_some(slot)
}

/// The method of the request whose handler is running right now, for a fault's log line.
pub fn current_method() -> Option<&'static str> {
    let slot = current_slot()?;
    let method = *SLOTS[slot].method.lock();
    if method.is_empty() { None } else { Some(method) }
}

/// Fails the request whose handler is running and clears the running marker.
///
/// Used when a handler faults: its frame is gone for good (a foreign exception unwinds through SEH, not
/// through Rust), so the caller would otherwise wait out its whole timeout and the slot would stay
/// `RUNNING` until the process ended. Answers whether a request was failed.
pub fn abort_current(error: RpcError) -> bool {
    let slot = CURRENT.swap(NO_SLOT, Ordering::AcqRel);
    if slot == NO_SLOT || slot >= CAPACITY {
        return false;
    }
    let slot = &SLOTS[slot];
    if slot.state.load(Ordering::Acquire) != RUNNING {
        // Already answered or deferred: nothing to fail.
        return false;
    }
    *slot.result.lock() = Some(Err(error));
    slot.state.store(DONE, Ordering::Release);
    true
}

/// The deferred handle of the request running right now, for [`Core::defer`](crate::Core::defer).
pub fn current() -> Option<Deferred> {
    let slot = CURRENT.load(Ordering::Acquire);
    if slot == NO_SLOT || slot >= CAPACITY {
        return None;
    }
    if SLOTS[slot].state.load(Ordering::Acquire) != RUNNING {
        return None;
    }
    Some(Deferred { slot })
}
