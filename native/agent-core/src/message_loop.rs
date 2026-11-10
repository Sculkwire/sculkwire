//! The message-loop drain.
//!
//! The engine's own per-frame function is the natural place to run main-thread requests, but a game
//! build may not call it at all (menu states, a build whose loop entry moves). The window-message
//! loop, however, always runs while the game lives, and it runs on the same thread that owns the
//! client's objects. So `user32!PeekMessageW` and `user32!GetMessageW` are replaced in the game
//! executable's import table, and each call runs [`Core::drain_message_loop`], which drains the queue
//! and runs the lock's per-frame work exactly as the frame hook does.
//!
//! Both replacements are transparent: every argument is forwarded untouched to the function the slot
//! held, and its return value is returned, so the game's message loop behaves exactly as before (a
//! `PeekMessageW` that would have returned 0 still returns 0).
//!
//! [`Core::drain_message_loop`]: crate::Core::drain_message_loop

use core::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, AtomicUsize, Ordering};

use crate::{hub, import, log, win};

/// The `PeekMessageW` replacement, 0 until installed.
static PEEK: AtomicUsize = AtomicUsize::new(0);
/// The `GetMessageW` replacement, 0 until installed.
static GET: AtomicUsize = AtomicUsize::new(0);

/// `engine.status.hooks` name of the `PeekMessageW` hook.
pub const PEEK_SITE: &str = "peek_message";
/// `engine.status.hooks` name of the `GetMessageW` hook.
pub const GET_SITE: &str = "get_message";

/// Installs both hooks in the game executable's import table and reports which ones landed.
///
/// The game imports these from `user32.dll`; a module that does not (a build that calls them through
/// a wrapper library instead) leaves the frame hook as the only drain point, which is reported by
/// `engine.status.hooks`.
pub fn install() -> (bool, bool) {
    let module = win::main_module();
    let peek = hook(module, "PeekMessageW", &PEEK, peek_message as *const () as usize, PEEK_SITE);
    let get = hook(module, "GetMessageW", &GET, get_message as *const () as usize, GET_SITE);
    (peek, get)
}

/// Patches one slot, remembering the original for the replacement to forward to.
fn hook(module: win::Hmodule, function: &str, original: &AtomicUsize, replacement: usize, site: &'static str) -> bool {
    let Some(core) = hub::started() else {
        return false;
    };
    if original.load(Ordering::Acquire) != 0 {
        return true; // already installed
    }
    let Some(found) = import::find(module, "user32.dll", function) else {
        core.site(site, false);
        log::fmt(format_args!("message loop: the executable does not import user32!{function}"));
        return false;
    };
    original.store(found.target, Ordering::Release);
    if !import::replace(found.slot, replacement) {
        original.store(0, Ordering::Release);
        core.site(site, false);
        log::fmt(format_args!("message loop: user32!{function} slot 0x{:x} is not writable", found.slot));
        return false;
    }
    core.site(site, true);
    log::fmt(format_args!(
        "message loop: user32!{function} hook at slot 0x{:x} (original 0x{:x})",
        found.slot, found.target
    ));
    true
}

/// Runs the drain for a hooked message-loop call, then counts the hook.
fn drain(site: &'static str) {
    if let Some(core) = hub::started() {
        core.site_fired(site);
        core.drain_message_loop(site);
    }
}

/// `BOOL PeekMessageW(LPMSG, HWND, UINT, UINT, UINT)`.
extern "system" fn peek_message(message: *mut u8, window: isize, min: u32, max: u32, remove: u32) -> i32 {
    drain(PEEK_SITE);
    let original = PEEK.load(Ordering::Acquire);
    if original == 0 {
        return 0;
    }
    // SAFETY: the slot held exactly this function before the patch, and the arguments are the ones
    // the caller passed through untouched.
    unsafe {
        core::mem::transmute::<usize, unsafe extern "system" fn(*mut u8, isize, u32, u32, u32) -> i32>(original)(
            message, window, min, max, remove,
        )
    }
}

/// `BOOL GetMessageW(LPMSG, HWND, UINT, UINT)`.
extern "system" fn get_message(message: *mut u8, window: isize, min: u32, max: u32) -> i32 {
    drain(GET_SITE);
    let original = GET.load(Ordering::Acquire);
    if original == 0 {
        return -1;
    }
    // SAFETY: as [`peek_message`]; `GetMessageW`'s -1/0/positive result is returned unchanged.
    unsafe { core::mem::transmute::<usize, unsafe extern "system" fn(*mut u8, isize, u32, u32) -> i32>(original)(message, window, min, max) }
}

/* ------------------------------------------------------------------------------------------------
 * The window's own thread
 *
 * The import-table hook above only fires where the game calls `PeekMessageW` through its *own*
 * import table. A live retail session showed that it does not: the exe's slot is patched, no call
 * arrives, and the process is a GDK app whose windowing lives in WinAppSDK, so the pump that
 * retrieves messages is not the one the image imports from. Two hooks do not depend on that:
 *
 * 1. `SetWindowsHookExW(WH_GETMESSAGE, …, thread)` for the game window's own thread — user32 calls the
 *    procedure for every message the thread retrieves, whatever module's loop does the retrieving;
 * 2. `SetTimer(window, …)`: the timer's `WM_TIMER` is dispatched to the window, so our window
 *    procedure (a subclass on top of whatever was there) sees it. It also covers a pump that
 *    dispatches without retrieving through `PeekMessage` in a way a hook can see.
 *
 * Both run the drain on the *window's* thread, which is the thread a main-thread request must use.
 * ---------------------------------------------------------------------------------------------- */

/// Our `WH_GETMESSAGE` hook, 0 until installed.
static HOOK: AtomicUsize = AtomicUsize::new(0);
/// The window the timer runs on.
static TIMER_WINDOW: AtomicUsize = AtomicUsize::new(0);
/// The window procedure that was there before our subclass.
static PREVIOUS_PROC: AtomicUsize = AtomicUsize::new(0);
/// The window's thread, once known.
static WINDOW_THREAD: AtomicU32 = AtomicU32::new(0);
/// At least one window-thread drain point is live: nothing left to install or retry.
static READY: AtomicUsize = AtomicUsize::new(0);
/// The last install attempt, and whether it failed already (so the log says it once).
static TRIED_AT: AtomicU64 = AtomicU64::new(0);
static FAILED_LOGGED: AtomicUsize = AtomicUsize::new(0);
/// `WM_TIMER`.
const WM_TIMER: u32 = 0x0113;
/// `WM_NULL`: a message with no meaning, posted to wake a thread's message loop.
const WM_NULL: u32 = 0x0000;
/// The `engine.status.hooks` name of the `WH_GETMESSAGE` hook.
pub const GETMESSAGE_SITE: &str = "get_message_hook";
/// The `engine.status.hooks` name of the window timer.
pub const TIMER_SITE: &str = "timer";

/// Makes sure the window's thread is hooked, at most once a second, and does nothing once it is.
///
/// Called from the simulation tick: the tick exists on every build this agent can attach to, and
/// installing a hook for another thread is a normal call from any thread.
pub fn ensure(core: &'static crate::Core) {
    if READY.load(Ordering::Acquire) != 0 || core.stopping() {
        return;
    }
    let now = win::tick_ms();
    let last = TRIED_AT.load(Ordering::Relaxed);
    if last != 0 && now.saturating_sub(last) < 1_000 {
        return;
    }
    TRIED_AT.store(now, Ordering::Relaxed);
    install_window(core);
}

/// Hooks the game window's thread: `WH_GETMESSAGE`, a drain timer, and the window's thread id.
pub fn install_window(core: &'static crate::Core) -> bool {
    let Some(window) = find_window() else {
        if FAILED_LOGGED.swap(1, Ordering::AcqRel) == 0 {
            log::line("message loop: no window of this process to hook yet");
        }
        core.site(GETMESSAGE_SITE, false);
        core.site(TIMER_SITE, false);
        return false;
    };
    let mut owner = 0u32;
    // SAFETY: `window` is a window handle of this process and the out pointer is a `DWORD`.
    let thread = unsafe { win::GetWindowThreadProcessId(window as win::Hwnd, &mut owner) };
    if thread == 0 || owner != win::current_process_id() {
        return false;
    }
    WINDOW_THREAD.store(thread, Ordering::Release);
    // The hook procedure runs in the target thread's context; the module it belongs to is this DLL,
    // which that thread already has (same process).
    let module = win::module_from_address(get_message_proc as *const () as usize);
    // SAFETY: a thread-scoped hook with this DLL's module handle; the procedure has the hook signature.
    let hook = unsafe {
        win::SetWindowsHookExW(win::WH_GETMESSAGE, get_message_proc as win::HookProc, module, thread)
    };
    if hook != 0 && hook != win::INVALID_HANDLE_VALUE {
        HOOK.store(hook, Ordering::Release);
        core.site(GETMESSAGE_SITE, true);
        log::fmt(format_args!(
            "message loop: WH_GETMESSAGE hooked on thread 0x{thread:x} (window 0x{:x})",
            window
        ));
    } else {
        core.site(GETMESSAGE_SITE, false);
        log::fmt(format_args!(
            "message loop: SetWindowsHookExW failed on thread 0x{thread:x} ({})",
            win::last_error()
        ));
    }
    // The timer: our window procedure receives WM_TIMER for it if the subclass went in.
    if subclass(window) {
        // SAFETY: a timer on a window of this process; the id is ours.
        unsafe {
            win::SetTimer(window as win::Hwnd, win::DRAIN_TIMER_ID, 2, core::ptr::null_mut());
        }
        TIMER_WINDOW.store(window, Ordering::Release);
        core.site(TIMER_SITE, true);
        log::fmt(format_args!("message loop: drain timer on window 0x{window:x}"));
    } else {
        core.site(TIMER_SITE, false);
    }
    let ready = HOOK.load(Ordering::Acquire) != 0 || TIMER_WINDOW.load(Ordering::Acquire) != 0;
    if ready {
        READY.store(1, Ordering::Release);
    }
    ready
}

/// Puts our window procedure on top of the window's, remembering the one it replaces.
fn subclass(window: usize) -> bool {
    if PREVIOUS_PROC.load(Ordering::Acquire) != 0 {
        return true;
    }
    let procedure = window_proc as *const () as isize;
    // SAFETY: the window belongs to this process; the previous procedure is kept for chaining.
    let previous = unsafe { win::SetWindowLongPtrW(window as win::Hwnd, win::GWLP_WNDPROC, procedure) };
    if previous == 0 {
        return false;
    }
    PREVIOUS_PROC.store(previous as usize, Ordering::Release);
    true
}

/// The window procedure: drains on our timer, and forwards everything else to the previous one.
unsafe extern "system" fn window_proc(window: win::Hwnd, message: u32, wparam: win::Wparam, lparam: win::Lparam) -> win::Lresult {
    if message == WM_TIMER && wparam == win::DRAIN_TIMER_ID {
        drain(TIMER_SITE);
        return 0;
    }
    let previous = PREVIOUS_PROC.load(Ordering::Acquire);
    if previous == 0 {
        return win::DefWindowProcW(window, message, wparam, lparam);
    }
    // SAFETY: the previous procedure was the window's own when we subclassed it.
    let previous: win::WndProc = core::mem::transmute(previous);
    previous(window, message, wparam, lparam)
}

/// The `WH_GETMESSAGE` procedure: drains before the message is handed to the game, then chains.
unsafe extern "system" fn get_message_proc(code: i32, wparam: win::Wparam, lparam: win::Lparam) -> win::Lresult {
    if code >= 0 {
        drain(GETMESSAGE_SITE);
    }
    win::CallNextHookEx(0, code, wparam, lparam)
}

/// Removes the window-thread drain: the hook, the timer, our subclass, and the two import slots.
/// Every step is logged; a step that has nothing to undo says nothing.
///
/// `UnhookWindowsHookEx` alone does not give back the reference user32 took on this DLL for a
/// `WH_GETMESSAGE` hook: user32 drops it when the hooked thread next retrieves a message and finds the
/// hook gone. So a neutral `WM_NULL` is posted to that thread right after the unhook — without it the
/// image can never unload and a hot reload injects a DLL that the loader reports as already loaded, so
/// `DllMain` never runs again.
///
/// Returns the window and the procedure the drain's subclass replaced (`(0, 0)` without one), for the
/// unload's chain repair.
pub fn remove() -> (usize, usize) {
    let hook = HOOK.swap(0, Ordering::AcqRel);
    if hook != 0 {
        // SAFETY: the handle came from SetWindowsHookExW and is unhooked once.
        unsafe {
            win::UnhookWindowsHookEx(hook);
        }
        // SAFETY: a thread id of this process's window thread, and a message that means nothing.
        let woke = unsafe { win::PostThreadMessageW(WINDOW_THREAD.load(Ordering::Acquire), WM_NULL, 0, 0) };
        log::fmt(format_args!(
            "unload: WH_GETMESSAGE unhooked (thread wake-up {})",
            if woke != 0 { "posted" } else { "refused" }
        ));
    }
    let window = TIMER_WINDOW.swap(0, Ordering::AcqRel);
    if window != 0 {
        // SAFETY: our timer id on that window.
        unsafe {
            win::KillTimer(window as win::Hwnd, win::DRAIN_TIMER_ID);
        }
        log::fmt(format_args!("unload: drain timer killed on 0x{window:x}"));
    }
    let previous = PREVIOUS_PROC.swap(0, Ordering::AcqRel);
    if previous != 0 && window != 0 {
        if win::restore_procedure(window, window_proc as *const () as usize, previous) {
            log::fmt(format_args!("unload: window 0x{window:x} procedure restored"));
        } else {
            log::fmt(format_args!("unload: the drain's procedure on 0x{window:x} is not on top; left to the chain repair"));
        }
    }
    READY.store(0, Ordering::Release);
    WINDOW_THREAD.store(0, Ordering::Release);
    (window, previous)
}

/// Puts the Windows import-table slots this module replaced back, by name.
pub fn restore_imports(module: win::Hmodule) {
    for (function, slot, replacement) in [
        ("PeekMessageW", &PEEK, peek_message as *const () as usize),
        ("GetMessageW", &GET, get_message as *const () as usize),
    ] {
        let original = slot.load(Ordering::Acquire);
        if original == 0 {
            continue;
        }
        if let Some(found) = import::find(module, "user32.dll", function) {
            if found.target == replacement {
                import::replace(found.slot, original);
                log::fmt(format_args!("unload: user32!{function} slot restored to 0x{original:x}"));
            }
        }
    }
}

/// The window's thread id, 0 until a window is found.
pub fn window_thread() -> u32 {
    WINDOW_THREAD.load(Ordering::Acquire)
}

/// Finds the game window: the foreground window when it is this process's, else the largest visible
/// top-level window of this process, else any window of any of its threads.
fn find_window() -> Option<usize> {
    // SAFETY: no arguments, no invariants.
    let foreground = unsafe { win::GetForegroundWindow() };
    if foreground != 0 && belongs(foreground as usize) {
        return Some(foreground as usize);
    }
    FIND_PID.store(win::current_process_id(), Ordering::Release);
    FIND_WINDOW.store(0, Ordering::Release);
    FIND_AREA.store(-1, Ordering::Release);
    // SAFETY: the callback has the expected signature and only reads process state.
    unsafe {
        win::EnumWindows(collect_window, 0);
    }
    let found = FIND_WINDOW.load(Ordering::Acquire);
    if found != 0 {
        return Some(found);
    }
    // No top-level window matched (a hidden or owned one, or a window of another desktop): ask each
    // thread of this process for its windows.
    for_each_thread(collect_thread_window);
    let found = FIND_WINDOW.load(Ordering::Acquire);
    (found != 0).then_some(found)
}

static FIND_PID: AtomicU32 = AtomicU32::new(0);
static FIND_WINDOW: AtomicUsize = AtomicUsize::new(0);
static FIND_AREA: AtomicI64 = AtomicI64::new(-1);

/// True when `window` belongs to this process.
fn belongs(window: usize) -> bool {
    let mut owner = 0u32;
    // SAFETY: the out pointer is a `DWORD`; a wrong handle just fails.
    unsafe {
        win::GetWindowThreadProcessId(window as win::Hwnd, &mut owner);
    }
    owner == win::current_process_id()
}

/// `EnumWindows` callback: keeps the largest visible top-level window of this process.
unsafe extern "system" fn collect_window(window: win::Hwnd, _arg: win::Lparam) -> win::Bool {
    if !belongs(window as usize) || win::IsWindowVisible(window) == 0 {
        return 1;
    }
    consider(window as usize);
    1
}

/// `EnumThreadWindows` callback: keeps the largest window of the thread.
unsafe extern "system" fn collect_thread_window(window: win::Hwnd, _arg: win::Lparam) -> win::Bool {
    if belongs(window as usize) {
        consider(window as usize);
    }
    1
}

/// Keeps `window` when it is larger than the best one so far.
fn consider(window: usize) {
    let mut rect = win::Rect { left: 0, top: 0, right: 0, bottom: 0 };
    // SAFETY: the out pointer is a `RECT`.
    let got = unsafe { win::GetClientRect(window as win::Hwnd, &mut rect) };
    let area = if got != 0 { (rect.right - rect.left) as i64 * (rect.bottom - rect.top) as i64 } else { 0 };
    if area > FIND_AREA.load(Ordering::Acquire) {
        FIND_AREA.store(area, Ordering::Release);
        FIND_WINDOW.store(window, Ordering::Release);
    }
}

/// Runs `visit` for every window of every thread of this process.
fn for_each_thread(visit: unsafe extern "system" fn(win::Hwnd, win::Lparam) -> win::Bool) {
    let process = win::current_process_id();
    // SAFETY: the snapshot handle is owned here and closed below.
    let snapshot = unsafe { win::CreateToolhelp32Snapshot(win::TH32CS_SNAPTHREAD, 0) };
    if snapshot == win::INVALID_HANDLE_VALUE || snapshot == 0 {
        return;
    }
    let mut entry = win::ThreadEntry32::default();
    entry.size = core::mem::size_of::<win::ThreadEntry32>() as u32;
    // SAFETY: the entry is valid for the call.
    if unsafe { win::Thread32First(snapshot, &mut entry) } != 0 {
        loop {
            if entry.owner_process_id == process {
                // SAFETY: the callback only reads window state.
                unsafe {
                    win::EnumThreadWindows(entry.thread_id, visit, 0);
                }
            }
            // SAFETY: the entry is valid for the call.
            if unsafe { win::Thread32Next(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }
    // SAFETY: the handle was created above.
    unsafe {
        win::CloseHandle(snapshot);
    }
}
