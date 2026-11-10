//! `agent.unload`: take everything this DLL put into the game back out, then free the DLL.
//!
//! The point is hot reload. A new agent is injected as a new file name (the hash-named copy the
//! injector writes), but the host may also inject the *same* file again — and then the loader finds the
//! module already mapped, returns its handle, and **never calls `DllMain` again**: no server, no attach,
//! no port. So the unload has to be *provably* complete: the image must really leave the process, and
//! every step is logged with the loader's reference count so a reload that does not happen says why.
//!
//! What holds a DLL in a process, and what this file does about it:
//!
//! | holder | released by |
//! |---|---|
//! | the injector's `LoadLibraryW` (one reference) | `FreeLibraryAndExitThread`, the last step |
//! | Wine's user32 hook dispatcher: `get_hook_proc` loads the hook's module by name with `LoadLibraryExW` when its lookup misses, and never frees it (Wine's own `FIXME: the library will never be freed`) | dropped with `FreeLibrary` right before the last step, once the hook is gone and nothing of this DLL is left to use it |
//! | `SetWindowsHookExW(WH_GETMESSAGE, …, this DLL, thread)` (user32's own reference) | `UnhookWindowsHookEx` **and** a message the hooked thread retrieves — [`message_loop::remove`] posts `WM_NULL` for that |
//! | the vectored exception handler (`fault::install`) | [`fault::remove`] |
//! | inline hooks, import slots, vtable slots, the window subclass, timers | the engine's own removers |
//! | this DLL's threads | `core.stop()` + closed sockets, waited out by `thread::alive` |
//! | `GetModuleHandleExW` without `UNCHANGED_REFCOUNT`, or `…_FLAG_PIN` | not used any more ([`crate::win::module_from_address`] asks without either) |
//!
//! The order is:
//!
//! 1. **Stop taking work.** `Core::stop`, the socket server (its listener and every connection) and the
//!    queued requests go first, so nothing new starts.
//! 2. **Quiescence.** A drain already inside a relay finishes before its prologue is restored.
//! 3. **Code that calls into this DLL goes away**: inline hooks, GameInput vtable slots, the
//!    `WH_GETMESSAGE` hook (with its thread wake-up), the imports, the input lock's subclass, the
//!    exception handler.
//! 4. **Wait for the loader's count to fall to 1** (the loader's own reference), logging it.
//! 5. **Wait for this DLL's threads**, logging the count; if any is still running the image is *not*
//!    freed — a thread executing freed code is a crash, and a mapped image that fails the reload is
//!    better than a game that dies.
//! 6. **Free**: `FreeLibraryAndExitThread`.

use alloc::string::String;
use core::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};

use crate::engine::RpcError;
use crate::{fault, hook, lock, log, message_loop, queue, rpc, thread, win};

/// Set once, so a second `agent.unload` while one is running is a no-op.
static STARTED: AtomicBool = AtomicBool::new(false);
/// How long the drain may take to leave a relay before the prologues are restored anyway.
const QUIESCENCE_MS: u32 = 150;
/// How long to wait for the loader's reference count to reach one (user32's hook reference is the one
/// that takes the longest: it goes when the hooked thread next retrieves a message).
const REFERENCES_MS: u32 = 2_000;
/// How long to wait for this DLL's threads to return.
const THREADS_MS: u32 = 3_000;
/// How long a new agent waits for a predecessor to leave before it carries on.
const PREDECESSOR_MS: u32 = 3_000;
/// How long a thread that is still inside this image (or able to return into it) is waited for before the
/// unload refuses to free. Detours fire tens of thousands of times a minute, so one is normally inside for
/// microseconds; a thread that is still there after this is stuck.
const IMAGE_QUIET_MS: u32 = 2_000;
/// The most words a stack that could not be unwound to its first frame is searched for a return address
/// into this image: the whole rest of that stack, up to an 8 MiB stack.
const STACK_WORDS: usize = 1 << 20;

/// `agent.unload` → `{unloading: true}`; the work continues on its own thread.
pub fn request() -> Result<Value, RpcError> {
    if STARTED.swap(true, Ordering::AcqRel) {
        return Err(RpcError::invalid_params("an unload is already running"));
    }
    if !thread::spawn("unload", run, 0) {
        // No thread: do it here, after the response would have been written — the caller sees a
        // closed socket either way.
        run(0);
    }
    Ok(json!({ "unloading": true }))
}

extern "system" fn run(_arg: usize) -> u32 {
    unload();
    0
}

/// The ordered teardown. Returns only when the image could not be freed safely (a thread of this DLL
/// is still running); otherwise it frees the image and never returns.
fn unload() {
    // The response to `agent.unload` is written by the connection thread that answered it: give it a
    // moment before its socket is closed under it.
    win::sleep_ms(80);
    log::line("unload: begin");
    let own = win::module_from_address(unload as *const () as usize);
    log::fmt(format_args!(
        "unload: module 0x{own:x} {} ({} reference(s) before teardown)",
        module_name(own),
        win::module_references(own)
    ));
    if let Some(core) = crate::hub::started() {
        // Before the stop: the server step still drains requests until then.
        lock::release_camera(core);
        core.stop();
        // The engine takes back what it installed itself (timers whose callback is this crate's code)
        // while the image is still whole and its hooks are still in place to be removed by the engine.
        core.engine().detach(core);
        log::line("unload: engine detached");
    }
    log::line("unload: stopping the socket server");
    rpc::stop();
    let aborted = queue::abort_all();
    log::fmt(format_args!("unload: {aborted} queued request(s) aborted"));
    // Let a drain that is already inside a relay finish before its code goes away.
    win::sleep_ms(QUIESCENCE_MS);

    // The inline hooks go first: they are what calls *into* this DLL from the game's threads, and a
    // live unload showed the tick re-installing the window drain after it had been removed.
    let restored = hook::remove_all();
    log::fmt(format_args!("unload: {restored} inline hook(s) restored"));
    // The GameInput vtable slots this DLL wrote are the other way its code gets called: put them back
    // before the image goes away, or the game's next reading jumps into freed memory.
    let slots = crate::gameinput::restore();
    log::fmt(format_args!("unload: {slots} GameInput vtable slot(s) restored"));
    // A thread that was inside a replacement when its entry was restored finishes it: give that a
    // moment, so nothing is left executing this image before it is freed.
    win::sleep_ms(QUIESCENCE_MS);

    // The window's own thread, remembered before the drain forgets it: it is the thread every procedure
    // this DLL put on the window runs on.
    let window_thread = message_loop::window_thread();
    // The lock's subclass usually goes on after the drain's (the drain subclasses at attach, the lock
    // when it is first turned on), so it comes off first. A live in-world reload with the old order
    // restored the lock's saved "previous" — the drain's procedure of the image being freed — and the
    // game's next `WM_CAPTURECHANGED` ran into the new agent mapped at the same base (`agent+0x6e870`).
    log::line("unload: removing the input lock");
    let (lock_window, lock_previous) = lock::remove();
    log::line("unload: removing the window-thread drain");
    let (drain_window, drain_previous) = message_loop::remove();
    let module = win::main_module();
    message_loop::restore_imports(module);
    repair_procedures(own, &[(lock_window, lock_previous), (drain_window, drain_previous)]);

    // Both removals put the window's own procedure back, but the window thread may still be *inside* a
    // procedure of this DLL that chained to the game's. A message it retrieves and dispatches now is a
    // round trip through the restored procedure: after it, the thread is out of this image's frames.
    if window_thread != 0 {
        // SAFETY: a thread id of this process, and a message that means nothing.
        let woke = unsafe { win::PostThreadMessageW(window_thread, 0, 0, 0) };
        win::sleep_ms(60);
        log::fmt(format_args!(
            "unload: window thread 0x{window_thread:x} woken ({}) and given a message round trip",
            if woke != 0 { "posted" } else { "refused" }
        ));
    }

    // The exception handler is a live pointer into this image: it goes before the reference count is
    // read, because until it is gone the loader still counts us as in use on some systems.
    let handler = fault::remove();
    log::fmt(format_args!("unload: exception handler {}", if handler { "removed" } else { "was not installed" }));

    // Wait for everything else that holds this DLL to let go: the hook's reference (user32 drops it
    // when the hooked thread retrieves the message `message_loop::remove` posted), the exception
    // handler, and the loader's own reference, which is the one left.
    let left = wait_for_references(own, 1, REFERENCES_MS);
    log::fmt(format_args!("unload: {left} reference(s) left after teardown (1 is the loader's own)"));

    // The threads of this DLL (the connection threads, the stream thread, the engine's own) check
    // `stopping` and leave; this thread counts itself, so one alive is where it stops.
    let alive = wait_for_threads();
    if alive > 1 {
        // A thread of this DLL is still executing its code: freeing the image would crash the game the
        // moment it wakes up. Leave the image mapped and say so — the host sees a closed port and a
        // clear line, which is better than a dead game.
        log::fmt(format_args!(
            "unload: {} thread(s) of this DLL are still running after {THREADS_MS} ms: NOT freeing the image \
             (a hot reload of this agent needs the game restarted)",
            alive - 1
        ));
        return;
    }
    // Restoring a hook's prologue stops *new* calls, but a thread may already be inside the replacement
    // it led to — or inside a game function that replacement called, with the way back through this
    // image still on its stack. Freeing now is a crash a frame later, so wait until no other thread is
    // in our code and none can return into it. Our own thread is excluded: it is inside the image by
    // definition, and it ends in the loader rather than returning here.
    let size = crate::Image::size_of_module(own);
    let mut waited = 0;
    let (mut busy, mut tally) = hook::image_threads(own, size, STACK_WORDS);
    while busy.is_some() && waited < IMAGE_QUIET_MS {
        win::sleep_ms(10);
        waited += 10;
        (busy, tally) = hook::image_threads(own, size, STACK_WORDS);
    }
    if let Some(busy) = busy {
        let where_at = |address: usize| {
            if address >= own && address < own.saturating_add(size) {
                alloc::format!("agent+0x{:x}", address - own)
            } else {
                alloc::format!("0x{address:x}")
            }
        };
        let what = if busy.code != 0 {
            alloc::format!("is running {}", where_at(busy.code))
        } else {
            alloc::format!("has a frame returning to {} (stack slot {})", where_at(busy.return_to), where_at(busy.stack_at))
        };
        log::fmt(format_args!(
            "unload: thread 0x{:x} {what} after {waited} ms: NOT freeing (a call through this agent is still in \
             progress; the image stays mapped and inert until the game restarts)",
            busy.thread
        ));
        return;
    }
    log::fmt(format_args!(
        "unload: no other thread is in this image ({waited} ms of checks; {} stack(s) unwound to their first frame, \
         {} searched word by word, {} unreadable)",
        tally.outermost, tally.searched, tally.unread
    ));

    let mut references = win::module_references(own);
    log::fmt(format_args!("unload: freeing 0x{own:x} with {references} reference(s)"));
    if references > 1 {
        // Every holder this DLL created is gone (hooks, the message hook, the exception handler, threads),
        // so a count above one is a `LoadLibrary` of the mapped file that nobody frees. Live (run 9), each
        // copy left behind had `2 reference(s) before teardown` against `1 at load`, and the count stayed 2
        // after the hook's wake-up: the `WH_GETMESSAGE` hook makes Wine's user32 resolve the hook procedure
        // through `get_hook_proc`, which loads the module by name when its lookup misses and never frees it
        // (the injector refuses a path that is already loaded, so it is not a second injection). With the
        // hook removed no caller of that reference is left, so it is dropped here, down to the loader's
        // own one that `FreeLibraryAndExitThread` releases below; the image then really leaves the process.
        let surplus = references - 1;
        for _ in 0..surplus {
            if !win::free_library(own) {
                break;
            }
        }
        references = win::module_references(own);
        log::fmt(format_args!("unload: dropped {surplus} reference(s) that outlived the teardown; {references} left"));
    }
    if references > 1 {
        // The count did not fall (a loader that refused the free): the image stays mapped, inert.
        log::fmt(format_args!(
            "unload: this image will stay mapped because {references} reference(s) outlive it; injecting the same \
             file again will NOT start a second agent — use a new copy of the DLL or restart the game"
        ));
    }
    log::line("unload: FreeLibraryAndExitThread");
    win::free_library_and_exit_thread(own, 0)
}

/// Polls the loader's reference count for `base` until it is `target` or the deadline passes, logging
/// every change. Answers the last count seen.
fn wait_for_references(base: win::Hmodule, target: u16, timeout_ms: u32) -> u16 {
    let mut last = win::module_references(base);
    let mut waited = 0;
    while last > target && waited < timeout_ms {
        win::sleep_ms(20);
        waited += 20;
        let now = win::module_references(base);
        if now != last {
            log::fmt(format_args!("unload: reference count {last} -> {now} after {waited} ms"));
            last = now;
        }
    }
    last
}

/// Waits for this DLL's threads to return and answers how many are still running (the caller counts).
fn wait_for_threads() -> usize {
    let mut waited = 0u32;
    while waited < THREADS_MS {
        if thread::alive() <= 1 {
            break;
        }
        win::sleep_ms(20);
        waited += 20;
    }
    let alive = thread::alive();
    log::fmt(format_args!("unload: {} thread(s) of this DLL left after {waited} ms", alive.saturating_sub(1)));
    alive
}

/* ------------------------------------------------------------------------------------------------
 * Hot reload: a second agent DLL in the same process
 * ---------------------------------------------------------------------------------------------- */

/// The module's file name, for log lines.
fn module_name(module: win::Hmodule) -> String {
    let path = win::module_path(module);
    if path.is_empty() {
        return String::from("(unknown)");
    }
    let text = win::narrow(&path);
    match text.rsplit(['\\', '/']).next() {
        Some(name) => String::from(name),
        None => text,
    }
}

/// True for a file name that is one of this project's agent DLLs (any `.dll` whose name holds both
/// `sculkwire` and `agent`, e.g. `sculkwire_agent-<hash>.dll` or `sculkwire-agent-<hash>.dll`).
fn agent_module_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".dll") && lower.contains("sculkwire") && lower.contains("agent")
}

/// Every *other* agent DLL mapped in this process: its base, file name and the loader's reference count.
///
/// Two copies of the agent in one process are two `Core`s, two socket servers and two sets of hooks;
/// they cannot work, and the loader will not even call `DllMain` for a second `LoadLibraryW` of a file
/// that is already mapped. A new agent looks for its predecessor instead of failing silently.
pub fn other_agents(ours: win::Hmodule) -> alloc::vec::Vec<(win::Hmodule, String, u16)> {
    let mut out = alloc::vec::Vec::new();
    for (base, name) in win::loaded_modules() {
        if base == 0 || base == ours || !agent_module_name(&name) {
            continue;
        }
        out.push((base, name, win::module_references(base)));
    }
    out
}

/// Waits for a previous agent DLL in this process to leave before this one attaches.
///
/// Runs on the attach thread, never in `DllMain`: the predecessor's unload needs the loader lock to free
/// itself, and blocking in `DllMain` while holding that lock would wait on each other. Never fails the
/// attach: a predecessor that outlives the wait is reported, and the socket server keeps retrying its
/// port on its own.
pub fn wait_for_predecessor(ours: win::Hmodule) {
    let others = other_agents(ours);
    if others.is_empty() {
        log::fmt(format_args!("hot reload: this is the only agent DLL (0x{ours:x})"));
        return;
    }
    for (base, name, references) in &others {
        log::fmt(format_args!(
            "hot reload: a previous agent DLL is still mapped: {name} at 0x{base:x} ({references} reference(s))"
        ));
    }
    let mut waited = 0u32;
    while waited < PREDECESSOR_MS {
        win::sleep_ms(50);
        waited += 50;
        if other_agents(ours).is_empty() {
            log::fmt(format_args!("hot reload: the previous agent DLL left after {waited} ms"));
            return;
        }
    }
    for (base, name, references) in other_agents(ours) {
        log::fmt(format_args!(
            "hot reload: {name} at 0x{base:x} is STILL mapped after {PREDECESSOR_MS} ms ({references} reference(s)): \
             it never unloaded, so it may still hold the port; this agent takes the next free port and this \
             process now carries two agents until it restarts"
        ));
    }
}

/// After both subclasses came off, no window may be left with a procedure inside this image: one
/// installed in the other order leaves the inner one's procedure on top. Such a window gets the one
/// saved procedure that is outside this image back (the game's own), which is what the chain below ours
/// was.
fn repair_procedures(own: usize, links: &[(usize, usize)]) {
    let size = crate::Image::size_of_module(own);
    let inside = |address: usize| own != 0 && address >= own && address < own + size;
    let Some(root) = links.iter().map(|link| link.1).find(|previous| *previous != 0 && !inside(*previous)) else {
        return;
    };
    for (window, _) in links {
        if *window == 0 {
            continue;
        }
        // SAFETY: a window of this process; reading its procedure has no side effect.
        let current = unsafe { win::GetWindowLongPtrW(*window as win::Hwnd, win::GWLP_WNDPROC) } as usize;
        if inside(current) {
            // SAFETY: `root` was the window's procedure before this DLL subclassed it.
            unsafe {
                win::SetWindowLongPtrW(*window as win::Hwnd, win::GWLP_WNDPROC, root as isize);
            }
            log::fmt(format_args!(
                "unload: window 0x{window:x} still had this image's procedure 0x{current:x}; set to 0x{root:x}"
            ));
        }
    }
}
