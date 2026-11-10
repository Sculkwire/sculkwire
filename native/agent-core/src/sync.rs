//! The synchronisation the agent needs, without a runtime: a spin lock for the short critical
//! sections (queue metadata, the tick ring) and a one-time initialiser for the process-lifetime
//! singletons (the [`crate::Core`], the game's [`crate::Image`]).
//!
//! Both are `no_std` and allocation-free. The spin lock asks the OS to yield after a while so a
//! contended lock on a single-core Wine setup cannot burn the game's frame time.

use core::cell::UnsafeCell;
use core::hint::spin_loop;
use core::ops::{Deref, DerefMut};
use core::sync::atomic::{AtomicBool, AtomicU8, Ordering};

pub struct SpinLock<T> {
    locked: AtomicBool,
    value: UnsafeCell<T>,
}

// SAFETY: access to `value` is serialised by `locked`.
unsafe impl<T: Send> Sync for SpinLock<T> {}
unsafe impl<T: Send> Send for SpinLock<T> {}

impl<T> SpinLock<T> {
    pub const fn new(value: T) -> Self {
        Self { locked: AtomicBool::new(false), value: UnsafeCell::new(value) }
    }

    /// Locks, spinning (and yielding) until it gets the lock.
    pub fn lock(&self) -> SpinGuard<'_, T> {
        let mut spins = 0u32;
        while self.locked.compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed).is_err() {
            spin_loop();
            spins += 1;
            if spins % 256 == 0 {
                // Another thread holds it for a moment: give it the CPU instead of spinning it away.
                crate::win::sleep_ms(0);
            }
        }
        SpinGuard { lock: self }
    }

    /// Locks only when it is free right now.
    pub fn try_lock(&self) -> Option<SpinGuard<'_, T>> {
        if self.locked.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed).is_ok() {
            Some(SpinGuard { lock: self })
        } else {
            None
        }
    }

    pub fn into_inner(self) -> T {
        self.value.into_inner()
    }
}

pub struct SpinGuard<'a, T> {
    lock: &'a SpinLock<T>,
}

impl<T> Deref for SpinGuard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        // SAFETY: the guard holds the lock for its lifetime.
        unsafe { &*self.lock.value.get() }
    }
}

impl<T> DerefMut for SpinGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        // SAFETY: the guard holds the lock for its lifetime.
        unsafe { &mut *self.lock.value.get() }
    }
}

impl<T> Drop for SpinGuard<'_, T> {
    fn drop(&mut self) {
        self.lock.locked.store(false, Ordering::Release);
    }
}

const EMPTY: u8 = 0;
const BUSY: u8 = 1;
const READY: u8 = 2;

/// A value initialised once, in place, at a `static`. The initialised reference is `'static` because
/// the `Once` itself lives in static storage, so no allocation is leaked to make one.
pub struct Once<T> {
    state: AtomicU8,
    value: UnsafeCell<Option<T>>,
}

// SAFETY: `value` is written once before `READY` is published (Release) and only read after it
// (Acquire); the initialising thread has exclusive access until then.
unsafe impl<T: Send + Sync> Sync for Once<T> {}
unsafe impl<T: Send> Send for Once<T> {}

impl<T> Once<T> {
    pub const fn new() -> Self {
        Self { state: AtomicU8::new(EMPTY), value: UnsafeCell::new(None) }
    }

    /// The value, once initialised.
    pub fn get(&self) -> Option<&T> {
        if self.state.load(Ordering::Acquire) == READY {
            // SAFETY: READY means the write below happened-before this load.
            unsafe { (*self.value.get()).as_ref() }
        } else {
            None
        }
    }

    /// Initialises with `init` the first time, and returns the same value afterwards. Concurrent
    /// callers block until the initialiser has finished.
    pub fn get_or_init(&'static self, init: impl FnOnce() -> T) -> &'static T {
        match self.state.compare_exchange(EMPTY, BUSY, Ordering::Acquire, Ordering::Acquire) {
            Ok(_) => {
                // SAFETY: this thread won the initialisation and nobody else can read yet.
                unsafe {
                    *self.value.get() = Some(init());
                }
                self.state.store(READY, Ordering::Release);
            }
            Err(_) => {
                let mut spins = 0u32;
                while self.state.load(Ordering::Acquire) != READY {
                    spin_loop();
                    spins += 1;
                    if spins % 256 == 0 {
                        crate::win::sleep_ms(0);
                    }
                }
            }
        }
        // SAFETY: READY, so the value is there and this `Once` is static.
        unsafe { (*self.value.get()).as_ref().expect("Once initialised") }
    }
}

impl<T> Default for Once<T> {
    fn default() -> Self {
        Self::new()
    }
}
