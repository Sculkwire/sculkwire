//! Thread spawning, for the two long-lived threads the agent runs (the socket server, the engine
//! attach) and the per-connection threads the server starts.

use core::ffi::c_void;

use crate::{log, win};

/// Threads this DLL started that have not returned yet.
static ALIVE: core::sync::atomic::AtomicUsize = core::sync::atomic::AtomicUsize::new(0);

/// How many of this DLL's threads are still running (the caller included when it is one of them).
pub fn alive() -> usize {
    ALIVE.load(core::sync::atomic::Ordering::Acquire)
}

/// The thread body: `entry(arg)`, with the alive counter kept around it so an unload can wait.
extern "system" fn counted(arg: usize) -> u32 {
    // `arg` packs the entry and its own argument: the entry in the high half is impossible (a pointer
    // needs all 64 bits), so the two are passed as a pair allocated by the caller.
    let pair = arg as *const (extern "system" fn(usize) -> u32, usize);
    // SAFETY: `spawn` allocated this pair and hands it over exactly once.
    let (entry, value) = unsafe { *pair };
    // SAFETY: the same allocation; it is freed here, after the copy.
    unsafe {
        drop(alloc::boxed::Box::from_raw(arg as *mut (extern "system" fn(usize) -> u32, usize)));
    }
    let code = entry(value);
    ALIVE.fetch_sub(1, core::sync::atomic::Ordering::AcqRel);
    code
}

/// Starts `entry(arg)` on a new OS thread. The handle is closed here: the agent never joins a thread.
pub fn spawn(name: &str, entry: extern "system" fn(usize) -> u32, arg: usize) -> bool {
    // The Win32 thread procedure takes a `void*`; the agent's threads take the small integer they
    // interpret as a slot or a pointer, so the two signatures are the same call frame.
    // The thread procedure takes one `void*`, so the entry and its argument travel as a pair.
    let pair = alloc::boxed::Box::into_raw(alloc::boxed::Box::new((entry, arg)));
    let entry_address: extern "system" fn(usize) -> u32 = counted;
    let start: extern "system" fn(*mut c_void) -> win::Dword = unsafe { core::mem::transmute(entry_address) };
    ALIVE.fetch_add(1, core::sync::atomic::Ordering::AcqRel);
    // SAFETY: `start` is a valid thread procedure and the pair is read back exactly once by it.
    let handle = unsafe { win::CreateThread(core::ptr::null_mut(), 0, start, pair as *mut c_void, 0, core::ptr::null_mut()) };
    if handle == 0 || handle == win::INVALID_HANDLE_VALUE {
        ALIVE.fetch_sub(1, core::sync::atomic::Ordering::AcqRel);
        // SAFETY: the thread never started, so the pair is still ours.
        unsafe {
            drop(alloc::boxed::Box::from_raw(pair));
        }
        log::fmt(format_args!("thread {name}: CreateThread failed ({})", win::last_error()));
        return false;
    }
    // SAFETY: a handle this call owns.
    unsafe {
        win::CloseHandle(handle);
    }
    log::fmt(format_args!("thread {name}: started"));
    true
}
