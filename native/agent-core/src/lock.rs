//! The input lock: keeps the user's own keyboard, mouse and gamepad out of the game while the agent
//! plays, and gives them back with F9.
//!
//! Four gates, each independent and each failing open:
//!
//! 1. **The window procedure** of the game's main window (the largest visible unowned top-level
//!    window of this process) drops key, mouse and raw-input messages, and keeps focus-loss messages
//!    from the game so it does not open its pause menu. Releases always pass; a lone release cannot
//!    disturb anything. F9 is handled here and never reaches the game while the lock is wanted.
//! 2. **The polled key-state APIs** (`GetAsyncKeyState`, `GetKeyState`, `GetKeyboardState`) are
//!    replaced in the import tables of every input module that loads them, so keys that reach the
//!    engine without a window message answer "not pressed". `GetCursorPos` holds still too.
//! 3. **XInput** exports (`XInputGetState` and its ordinal-100 `Ex`) are hooked in place, reporting a
//!    centred pad with a packet number the game has never seen, so a controller is neutral while
//!    locked even though no window message carries it.
//! 4. **The camera permission** of the local player follows the lock through the engine's own
//!    `inputpermission` command, with an action-bar badge that says who has control.
//!
//! `auto` (the default) locks while any connection declares an action running; each connection owns
//! one bit of `active`, cleared when it disconnects. A hook that cannot be installed leaves the user's
//! input untouched: the lock degrades to fewer gates, never to a stuck keyboard.

use core::ffi::c_void;
use core::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicIsize, AtomicU32, AtomicU64, AtomicUsize, Ordering};

use serde_json::{json, Value};

use crate::engine::RpcError;
use crate::import;
use crate::{hook, log, win, Core};

/* ------------------------------------------------------------------------------------------------
 * State
 * ---------------------------------------------------------------------------------------------- */

/// The subclassed window, 0 until found.
static WINDOW: AtomicIsize = AtomicIsize::new(0);
/// The window's previous procedure.
static PREVIOUS: AtomicUsize = AtomicUsize::new(0);

const MODE_OFF: i32 = 0;
const MODE_ON: i32 = 1;
const MODE_AUTO: i32 = 2;

/// Lock mode; `auto` like agent.c.
static MODE: AtomicI32 = AtomicI32::new(MODE_AUTO);
/// One bit per connection that declared an action running.
static ACTIVE: AtomicU32 = AtomicU32::new(0);
/// The last change came from F9.
static BY_USER: AtomicBool = AtomicBool::new(false);
/// Bumped for every state change; the stream thread watches it.
static SEQUENCE: AtomicU32 = AtomicU32::new(0);
static F9_DOWN: AtomicBool = AtomicBool::new(false);
/// A focus loss was swallowed, so the game must still be told about it on unlock.
static FOCUS_DROPPED: AtomicBool = AtomicBool::new(false);
static FOCUS_LOST: AtomicU32 = AtomicU32::new(0);
static FOCUS_KEPT: AtomicU32 = AtomicU32::new(0);
static DROPPED: AtomicU32 = AtomicU32::new(0);

/// Shift presses seen per delivery path (`0` window message, `1` raw input) and whether the game
/// window was the foreground window at that moment (`1`).
static SHIFT_SEEN: [[AtomicU32; 2]; 2] =
    [[AtomicU32::new(0), AtomicU32::new(0)], [AtomicU32::new(0), AtomicU32::new(0)]];

/// Polled key-state answers the DLL turned into "not pressed".
static KEYS_HIDDEN: AtomicU32 = AtomicU32::new(0);
/// The game window has focus on the host desktop, as `input.focus` last reported.
static HOST_FOCUSED: AtomicBool = AtomicBool::new(true);
/// Focus as the game process sees it (diagnostic).
static APP_FOCUSED: AtomicBool = AtomicBool::new(true);
/// The game window was the process's foreground window at the last raw-input event (diagnostic).
static FOREGROUND: AtomicBool = AtomicBool::new(true);

/// Gamepad gate counters.
static PAD_READS: AtomicU32 = AtomicU32::new(0);
static PAD_ACTIVE: AtomicU32 = AtomicU32::new(0);
static PAD_HIDDEN: AtomicU32 = AtomicU32::new(0);

/// Modules whose key-state imports were already patched, and when the last attempt ran.
static IAT_DONE: AtomicU32 = AtomicU32::new(0);
static IAT_AT: AtomicU64 = AtomicU64::new(0);
/// Modules whose XInput exports were already hooked, and when.
static PAD_TRIED: AtomicU32 = AtomicU32::new(0);
static PAD_AT: AtomicU64 = AtomicU64::new(0);
/// Throttle for the window search.
static FIND_AT: AtomicU64 = AtomicU64::new(0);
static FIND_BEST: AtomicIsize = AtomicIsize::new(0);
static FIND_AREA: AtomicI64 = AtomicI64::new(0);

/// The camera permission this agent last set in the current world: -1 not yet, 0 enabled, 1 disabled.
static CAMERA_PERMISSION: AtomicI32 = AtomicI32::new(-1);
static CAMERA_AT: AtomicU64 = AtomicU64::new(0);
static CAMERA_WORLD: AtomicBool = AtomicBool::new(false);
/// The gate's failure is logged once per world; it is retried every second and an engine may refuse
/// it for the whole session.
static CAMERA_FAILURE_LOGGED: AtomicBool = AtomicBool::new(false);
/// Set by [`release_camera`]: the gate sets nothing more, so the unload's last word stands.
static CAMERA_RELEASED: AtomicBool = AtomicBool::new(false);
/// True while the gate's own command is in flight, which the release waits out.
static CAMERA_BUSY: AtomicBool = AtomicBool::new(false);

/// Action-bar badge bookkeeping.
static BADGE_AT: AtomicU64 = AtomicU64::new(0);
static BADGE_SEQUENCE: AtomicU32 = AtomicU32::new(u32::MAX);

/* ------------------------------------------------------------------------------------------------
 * State machine
 * ---------------------------------------------------------------------------------------------- */

fn wanted() -> bool {
    let mode = MODE.load(Ordering::Acquire);
    mode == MODE_ON || (mode == MODE_AUTO && ACTIVE.load(Ordering::Acquire) != 0)
}

/// True while the user's input is being kept out of the game.
pub fn on() -> bool {
    wanted() && !BY_USER.load(Ordering::Acquire)
}

/// True when the user took control with F9.
pub fn user_has_control() -> bool {
    BY_USER.load(Ordering::Acquire) && wanted()
}

/// The state generation, for the `lock` notification.
pub fn sequence() -> u32 {
    SEQUENCE.load(Ordering::Acquire)
}

fn changed(was_locked: bool, by_user: bool) {
    BY_USER.store(by_user, Ordering::Release);
    SEQUENCE.fetch_add(1, Ordering::AcqRel);
    if was_locked && !on() {
        replay_focus_loss();
    }
}

/// Lets the game see the focus loss the lock hid from it.
fn replay_focus_loss() {
    let window = WINDOW.load(Ordering::Acquire);
    if !FOCUS_DROPPED.load(Ordering::Acquire) || window == 0 {
        return;
    }
    FOCUS_DROPPED.store(false, Ordering::Release);
    // SAFETY: no invariants; reads the foreground window of this desktop.
    if unsafe { win::GetForegroundWindow() } == window {
        return;
    }
    // SAFETY: posting to a window this process owns; the messages carry no pointers.
    unsafe {
        win::PostMessageW(window, win::WM_ACTIVATE, 0, 0);
        win::PostMessageW(window, win::WM_ACTIVATEAPP, 0, 0);
        win::PostMessageW(window, win::WM_KILLFOCUS, 0, 0);
    }
}

/// F9 on the window thread: hand control to the user, or give it back.
///
/// Returns true when the key was consumed. Nothing is handed over while the lock is not wanted, so
/// then F9 belongs to the game.
fn f9(down: bool) -> bool {
    if !wanted() {
        F9_DOWN.store(down, Ordering::Release);
        return false;
    }
    if down && !F9_DOWN.load(Ordering::Acquire) {
        let was = on();
        BY_USER.store(!BY_USER.load(Ordering::Acquire), Ordering::Release);
        if BY_USER.load(Ordering::Acquire) {
            // The agent is not playing any more: drop what it held.
            if let Some(core) = crate::hub::started() {
                core.clear_movement();
            }
        }
        changed(was, true);
    }
    F9_DOWN.store(down, Ordering::Release);
    true
}

/* ------------------------------------------------------------------------------------------------
 * The window procedure
 * ---------------------------------------------------------------------------------------------- */

const WM_MOUSE_DROP: &[u32] = &[
    0x0100, 0x0102, 0x0103, 0x0104, 0x0106, 0x0107, 0x0109, 0x0200, 0x0201, 0x0203, 0x0204, 0x0206,
    0x0207, 0x0209, 0x020A, 0x020B, 0x020D, 0x020E, 0x0245, 0x0246, 0x024E, 0x024F,
];

fn note_shift(path: usize, window: win::Hwnd) {
    // SAFETY: no invariants; reads the foreground window of this desktop.
    let foreground = unsafe { win::GetForegroundWindow() } == window;
    SHIFT_SEEN[path][usize::from(foreground)].fetch_add(1, Ordering::Relaxed);
    FOREGROUND.store(foreground, Ordering::Relaxed);
}

/// `WM_INPUT`: true when the packet must not reach the game.
///
/// RAWINPUTHEADER is 24 bytes; RAWKEYBOARD has MakeCode/Flags/Reserved/VKey at +24, RAWMOUSE has
/// usFlags at +24 and usButtonFlags at +28.
fn raw_drop(window: win::Hwnd, raw: win::Lparam) -> bool {
    let mut buffer = [0u8; 256];
    let mut size = buffer.len() as u32;
    // SAFETY: `raw` is the message's RAWINPUT handle; the buffer and its length agree.
    let got = unsafe {
        win::GetRawInputData(
            raw as *mut c_void,
            win::RID_INPUT,
            buffer.as_mut_ptr().cast(),
            &mut size,
            24,
        )
    };
    if got == u32::MAX || got < 24 {
        return on();
    }
    let kind = u32::from_ne_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]);
    match kind {
        k if k == win::RIM_TYPEKEYBOARD && got >= 40 => {
            let flags = u16::from_ne_bytes([buffer[26], buffer[27]]);
            let vk = u16::from_ne_bytes([buffer[30], buffer[31]]);
            let released = flags & 1 != 0;
            if usize::from(vk) == win::VK_F9 {
                return f9(!released);
            }
            if !released && matches!(usize::from(vk), win::VK_SHIFT | win::VK_LSHIFT | win::VK_RSHIFT) {
                note_shift(1, window);
            }
            on() && !released
        }
        k if k == win::RIM_TYPEMOUSE && got >= 32 => {
            let buttons = u16::from_ne_bytes([buffer[28], buffer[29]]);
            if buttons & 0x0155 != 0 {
                return on(); // a press, possibly with motion
            }
            if buttons & 0x02AA != 0 {
                return false; // releases only
            }
            on()
        }
        _ => on(),
    }
}

unsafe extern "system" fn wndproc(window: win::Hwnd, message: u32, wparam: win::Wparam, lparam: win::Lparam) -> win::Lresult {
    let previous = PREVIOUS.load(Ordering::Acquire);
    let key = wparam as usize;

    if matches!(message, win::WM_KEYDOWN | win::WM_SYSKEYDOWN)
        && matches!(key, win::VK_SHIFT | win::VK_LSHIFT | win::VK_RSHIFT)
    {
        note_shift(0, window);
    }

    if matches!(message, win::WM_KEYDOWN | win::WM_SYSKEYDOWN | win::WM_KEYUP | win::WM_SYSKEYUP) && key == win::VK_F9 {
        let down = message == win::WM_KEYDOWN || message == win::WM_SYSKEYDOWN;
        if f9(down) {
            return 0;
        }
    } else if message == win::WM_INPUT {
        if raw_drop(window, lparam) {
            DROPPED.fetch_add(1, Ordering::Relaxed);
            // Free the raw-input buffer without letting the game's procedure see the packet.
            return win::DefWindowProcW(window, message, wparam, lparam);
        }
    } else if message == win::WM_SETFOCUS || (message == win::WM_ACTIVATE && (key & 0xFFFF) != 0) || (message == win::WM_ACTIVATEAPP && key != 0) {
        FOCUS_DROPPED.store(false, Ordering::Release);
        // Window focus messages are not a dependable signal under a compositor: a loss at launch is
        // never followed by a gain. The focus rule follows the engine's own handlers instead.
    } else {
        if message == win::WM_ACTIVATE || message == win::WM_KILLFOCUS || (message == win::WM_ACTIVATEAPP && key == 0) {
            FOCUS_LOST.fetch_add(1, Ordering::Relaxed);
        }
        if on() {
            let drop = if message == win::WM_ACTIVATE {
                2 // WA_INACTIVE: the active case was handled above
            } else if message == win::WM_ACTIVATEAPP {
                if key != 0 {
                    0
                } else {
                    2
                }
            } else if message == win::WM_KILLFOCUS {
                2
            } else if WM_MOUSE_DROP.contains(&message) {
                1
            } else {
                0
            };
            if drop == 2 {
                // A focus loss would open the pause menu and stop the agent's own input.
                FOCUS_DROPPED.store(true, Ordering::Release);
                FOCUS_KEPT.fetch_add(1, Ordering::Relaxed);
                return 0;
            }
            if drop == 1 {
                DROPPED.fetch_add(1, Ordering::Relaxed);
                return 0;
            }
        }
    }

    match core::mem::transmute::<usize, Option<win::WndProc>>(previous) {
        Some(previous) if previous as usize != wndproc as *const () as usize => previous(window, message, wparam, lparam),
        _ => win::DefWindowProcW(window, message, wparam, lparam),
    }
}

unsafe extern "system" fn find_window(window: win::Hwnd, process: win::Lparam) -> win::Bool {
    let mut owner = 0u32;
    win::GetWindowThreadProcessId(window, &mut owner);
    if owner as win::Lparam != process || win::IsWindowVisible(window) == 0 || win::GetWindow(window, win::GW_OWNER) != 0 {
        return 1;
    }
    let mut rect = win::Rect { left: 0, top: 0, right: 0, bottom: 0 };
    if win::GetClientRect(window, &mut rect) == 0 {
        return 1;
    }
    let area = i64::from(rect.right - rect.left) * i64::from(rect.bottom - rect.top);
    if area > FIND_AREA.load(Ordering::Relaxed) {
        FIND_AREA.store(area, Ordering::Relaxed);
        FIND_BEST.store(window, Ordering::Relaxed);
    }
    1
}

/// Finds the game's main window and subclasses it, once. Called every frame.
fn install() {
    if WINDOW.load(Ordering::Acquire) != 0 {
        // Keep the foreground diagnostic current, and stop when the window went away.
        // SAFETY: window queries take no ownership and cannot fault on a stale handle.
        if unsafe { win::IsWindow(WINDOW.load(Ordering::Acquire)) } != 0 {
            FOREGROUND.store(unsafe { win::GetForegroundWindow() } == WINDOW.load(Ordering::Acquire), Ordering::Relaxed);
            return;
        }
        WINDOW.store(0, Ordering::Release);
        PREVIOUS.store(0, Ordering::Release);
    }
    let now = win::tick_ms();
    if now.saturating_sub(FIND_AT.load(Ordering::Relaxed)) < 1000 {
        return;
    }
    FIND_AT.store(now, Ordering::Release);
    FIND_BEST.store(0, Ordering::Relaxed);
    FIND_AREA.store(0, Ordering::Relaxed);
    // SAFETY: the callback only reads window state.
    unsafe {
        win::EnumWindows(find_window, win::current_process_id() as win::Lparam);
    }
    let window = FIND_BEST.load(Ordering::Relaxed);
    if window == 0 {
        return;
    }
    // SAFETY: replacing the procedure of a window this process owns; the previous one is kept.
    let previous = unsafe { win::SetWindowLongPtrW(window, win::GWLP_WNDPROC, wndproc as *const () as usize as isize) };
    if previous == 0 {
        log::fmt(format_args!("input lock: SetWindowLongPtrW failed ({})", win::last_error()));
        return;
    }
    PREVIOUS.store(previous as usize, Ordering::Release);
    WINDOW.store(window, Ordering::Release);
    log::fmt(format_args!("input lock: window=0x{window:x} area={}", FIND_AREA.load(Ordering::Relaxed)));
}

/* ------------------------------------------------------------------------------------------------
 * Polled key state: IAT replacements
 * ---------------------------------------------------------------------------------------------- */

type GetAsyncKeyStateFn = unsafe extern "system" fn(i32) -> i16;
type GetKeyStateFn = unsafe extern "system" fn(i32) -> i16;
type GetKeyboardStateFn = unsafe extern "system" fn(*mut u8) -> win::Bool;
type GetCursorPosFn = unsafe extern "system" fn(*mut i32) -> win::Bool;

static ORIGINAL_ASYNC: AtomicUsize = AtomicUsize::new(0);
static ORIGINAL_KEY_STATE: AtomicUsize = AtomicUsize::new(0);
static ORIGINAL_KEYBOARD_STATE: AtomicUsize = AtomicUsize::new(0);
static ORIGINAL_CURSOR_POS: AtomicUsize = AtomicUsize::new(0);

static CURSOR_HELD: AtomicBool = AtomicBool::new(false);
static CURSOR_HOLD_X: AtomicI32 = AtomicI32::new(0);
static CURSOR_HOLD_Y: AtomicI32 = AtomicI32::new(0);

/// Polled input is blocked while locked, and while the host says the game window has no focus.
fn polled_blocked() -> bool {
    on() || !HOST_FOCUSED.load(Ordering::Acquire)
}

unsafe extern "system" fn hook_get_async_key_state(vk: i32) -> i16 {
    let original = ORIGINAL_ASYNC.load(Ordering::Acquire);
    let result = match core::mem::transmute::<usize, Option<GetAsyncKeyStateFn>>(original) {
        Some(original) => original(vk),
        None => 0,
    };
    if vk as usize == win::VK_F9 || !polled_blocked() || (result & 0x8001u16 as i16) == 0 {
        return result;
    }
    KEYS_HIDDEN.fetch_add(1, Ordering::Relaxed);
    0
}

unsafe extern "system" fn hook_get_key_state(vk: i32) -> i16 {
    let original = ORIGINAL_KEY_STATE.load(Ordering::Acquire);
    let result = match core::mem::transmute::<usize, Option<GetKeyStateFn>>(original) {
        Some(original) => original(vk),
        None => 0,
    };
    if vk as usize == win::VK_F9 || !polled_blocked() || (result & 0x8000u16 as i16) == 0 {
        return result;
    }
    KEYS_HIDDEN.fetch_add(1, Ordering::Relaxed);
    result & 1 // keep the toggle state (Caps Lock)
}

unsafe extern "system" fn hook_get_keyboard_state(keys: *mut u8) -> win::Bool {
    let original = ORIGINAL_KEYBOARD_STATE.load(Ordering::Acquire);
    let ok = match core::mem::transmute::<usize, Option<GetKeyboardStateFn>>(original) {
        Some(original) => original(keys),
        None => 0,
    };
    if ok != 0 && !keys.is_null() && polled_blocked() {
        for index in 0..256usize {
            if index == win::VK_F9 {
                continue;
            }
            let byte = core::ptr::read_volatile(keys.add(index));
            core::ptr::write_volatile(keys.add(index), byte & 1);
        }
    }
    ok
}

unsafe extern "system" fn hook_get_cursor_pos(point: *mut i32) -> win::Bool {
    let original = ORIGINAL_CURSOR_POS.load(Ordering::Acquire);
    let ok = match core::mem::transmute::<usize, Option<GetCursorPosFn>>(original) {
        Some(original) => original(point),
        None => 0,
    };
    if ok == 0 || point.is_null() {
        return ok;
    }
    if on() {
        if !CURSOR_HELD.load(Ordering::Acquire) {
            CURSOR_HOLD_X.store(core::ptr::read_volatile(point), Ordering::Relaxed);
            CURSOR_HOLD_Y.store(core::ptr::read_volatile(point.add(1)), Ordering::Relaxed);
            CURSOR_HELD.store(true, Ordering::Release);
        }
        core::ptr::write_volatile(point, CURSOR_HOLD_X.load(Ordering::Relaxed));
        core::ptr::write_volatile(point.add(1), CURSOR_HOLD_Y.load(Ordering::Relaxed));
    } else {
        CURSOR_HELD.store(false, Ordering::Release);
    }
    ok
}

/// Puts back everything the lock patched: the window procedure and the polled key-state slots.
///
/// The XInput hooks are inline hooks and are restored by [`crate::hook::remove_all`], which knows
/// every prologue this DLL patched.
///
/// Returns the window and the procedure the subclass replaced (`(0, 0)` when the lock never subclassed
/// it), so the unload can repair the chain when another subclass of this DLL sat above the lock's.
pub fn remove() -> (usize, usize) {
    let window = WINDOW.swap(0, Ordering::AcqRel) as usize;
    let previous = PREVIOUS.swap(0, Ordering::AcqRel);
    if window != 0 && previous != 0 {
        if win::restore_procedure(window, wndproc as *const () as usize, previous) {
            log::fmt(format_args!("unload: the lock's window procedure on 0x{window:x} restored"));
        } else {
            log::fmt(format_args!("unload: the lock's procedure on 0x{window:x} is not on top; left to the chain repair"));
        }
    }
    // The key-state slots: find each name again and put the original back.
    const NAMES: [&str; 4] = ["GetAsyncKeyState", "GetKeyState", "GetKeyboardState", "GetCursorPos"];
    let originals = [&ORIGINAL_ASYNC, &ORIGINAL_KEY_STATE, &ORIGINAL_KEYBOARD_STATE, &ORIGINAL_CURSOR_POS];
    let mut restored = 0usize;
    for (name, original) in NAMES.iter().zip(originals) {
        let address = original.swap(0, Ordering::AcqRel);
        if address == 0 {
            continue;
        }
        for module in [win::module("gameinput.dll"), win::module("Microsoft.InputStateManager.dll"), win::module("Microsoft.UI.Input.dll"), win::main_module()] {
            if module == 0 {
                continue;
            }
            if let Some(found) = crate::import::find(module, "user32.dll", name) {
                if crate::import::replace(found.slot, address) {
                    restored += 1;
                }
            }
        }
    }
    log::fmt(format_args!("unload: {restored} polled key-state slots restored"));
    IAT_DONE.store(0, Ordering::Release);
    PAD_TRIED.store(0, Ordering::Release);
    (window, previous)
}

/// Points the `user32` key-state import slots of `module` at the wrappers. Returns how many slots
/// were patched.
///
/// The walk itself is [`crate::import`]'s; this only says which names belong to the lock.
fn patch_key_state_imports(module: win::Hmodule, cursor: bool) -> u32 {
    let wanted: [(&str, usize, &AtomicUsize, bool); 4] = [
        ("GetAsyncKeyState", hook_get_async_key_state as *const () as usize, &ORIGINAL_ASYNC, true),
        ("GetKeyState", hook_get_key_state as *const () as usize, &ORIGINAL_KEY_STATE, true),
        ("GetKeyboardState", hook_get_keyboard_state as *const () as usize, &ORIGINAL_KEYBOARD_STATE, true),
        ("GetCursorPos", hook_get_cursor_pos as *const () as usize, &ORIGINAL_CURSOR_POS, cursor),
    ];
    let mut patched = 0u32;
    for (name, replacement, original, wanted) in wanted {
        if !wanted {
            continue;
        }
        let Some(slot) = import::find(module, "user32.dll", name) else {
            continue;
        };
        if slot.target == replacement {
            continue; // already replaced, by an earlier attempt
        }
        if original.load(Ordering::Acquire) == 0 {
            original.store(slot.target, Ordering::Release);
        }
        if import::replace(slot.slot, replacement) {
            patched += 1;
        }
    }
    patched
}

/// Modules that import the polled key-state APIs. A module that is not loaded is skipped and retried
/// a second later.
fn install_key_state_hooks() {
    const MODULES: [&str; 3] = ["gameinput.dll", "Microsoft.InputStateManager.dll", "Microsoft.UI.Input.dll"];
    let now = win::tick_ms();
    if IAT_DONE.load(Ordering::Acquire) == 0b1111 || now.saturating_sub(IAT_AT.load(Ordering::Relaxed)) < 1000 {
        return;
    }
    IAT_AT.store(now, Ordering::Release);
    let mut modules: [win::Hmodule; 4] = [0; 4];
    for (index, name) in MODULES.iter().enumerate() {
        modules[index] = win::module(name);
    }
    modules[3] = win::main_module();
    for (index, module) in modules.iter().enumerate() {
        let bit = 1u32 << index;
        if IAT_DONE.load(Ordering::Acquire) & bit != 0 || *module == 0 {
            continue;
        }
        let patched = patch_key_state_imports(*module, index == 0);
        IAT_DONE.fetch_or(bit, Ordering::AcqRel);
        log::fmt(format_args!("input lock: key-state imports module {index} slots={patched}"));
    }
}

/* ------------------------------------------------------------------------------------------------
 * Gamepad: XInput export hooks
 * ---------------------------------------------------------------------------------------------- */

const PAD_MODULES: usize = 3;
const XINPUT_NOT_CONNECTED: u32 = 1167;

/// Trampolines of the XInput hooks, `[module][0 = XInputGetState, 1 = Ex]`.
static PAD_TRAMPOLINES: [[AtomicUsize; 2]; PAD_MODULES] = [
    [AtomicUsize::new(0), AtomicUsize::new(0)],
    [AtomicUsize::new(0), AtomicUsize::new(0)],
    [AtomicUsize::new(0), AtomicUsize::new(0)],
];

/// Applies the gate to one successful read: reports a neutral pad while polled input is blocked, with
/// a packet number the game cannot have seen.
fn pad_after(result: u32, state: *mut u8) -> u32 {
    if result != 0 || state.is_null() {
        return result;
    }
    PAD_READS.fetch_add(1, Ordering::Relaxed);
    // SAFETY: XInputGetState wrote XINPUT_STATE { packet number (4), gamepad (12) }.
    let gamepad = unsafe { state.add(4) };
    let buttons = unsafe { core::ptr::read_unaligned(gamepad as *const u16) };
    let left_trigger = unsafe { core::ptr::read_volatile(gamepad.add(2)) };
    let right_trigger = unsafe { core::ptr::read_volatile(gamepad.add(3)) };
    let mut busy = buttons != 0 || left_trigger > 30 || right_trigger > 30;
    for axis in 0..4usize {
        // SAFETY: the four thumb axes follow the buttons and triggers.
        let value = unsafe { core::ptr::read_unaligned(gamepad.add(4 + axis * 2) as *const i16) };
        if !(-8000..=8000).contains(&value) {
            busy = true;
        }
    }
    if busy {
        PAD_ACTIVE.fetch_add(1, Ordering::Relaxed);
    }
    if !polled_blocked() {
        return result;
    }
    if busy {
        PAD_HIDDEN.fetch_add(1, Ordering::Relaxed);
    }
    // SAFETY: 12 bytes of XINPUT_GAMEPAD and the 4-byte packet number are writable by contract.
    unsafe {
        core::ptr::write_bytes(gamepad, 0, 12);
        let packet = core::ptr::read_unaligned(state as *const u32);
        core::ptr::write_unaligned(state as *mut u32, packet | 0x8000_0000);
    }
    result
}

macro_rules! pad_hook {
    ($name:ident, $module:expr, $slot:expr) => {
        unsafe extern "system" fn $name(user: u32, state: *mut u8) -> u32 {
            let trampoline = PAD_TRAMPOLINES[$module][$slot].load(Ordering::Acquire);
            let result = match core::mem::transmute::<usize, Option<unsafe extern "system" fn(u32, *mut u8) -> u32>>(trampoline) {
                Some(original) => original(user, state),
                None => XINPUT_NOT_CONNECTED,
            };
            pad_after(result, state)
        }
    };
}

pad_hook!(pad_0_0, 0, 0);
pad_hook!(pad_0_1, 0, 1);
pad_hook!(pad_1_0, 1, 0);
pad_hook!(pad_1_1, 1, 1);
pad_hook!(pad_2_0, 2, 0);
pad_hook!(pad_2_1, 2, 1);

/// The wrapper for one XInput export.
fn pad_replacement(module: usize, slot: usize) -> usize {
    match (module, slot) {
        (0, 0) => pad_0_0 as *const () as usize,
        (0, _) => pad_0_1 as *const () as usize,
        (1, 0) => pad_1_0 as *const () as usize,
        (1, _) => pad_1_1 as *const () as usize,
        (_, 0) => pad_2_0 as *const () as usize,
        (_, _) => pad_2_1 as *const () as usize,
    }
}

/// Hooks `XInputGetState` and its ordinal-100 `Ex` in every loaded XInput DLL, once a second until
/// all three are done.
fn install_pad_hooks() {
    const MODULES: [&str; PAD_MODULES] = ["xinput1_4.dll", "xinput1_3.dll", "xinput9_1_0.dll"];
    let now = win::tick_ms();
    let all = (1u32 << PAD_MODULES) - 1;
    if PAD_TRIED.load(Ordering::Acquire) == all || now.saturating_sub(PAD_AT.load(Ordering::Relaxed)) < 1000 {
        return;
    }
    PAD_AT.store(now, Ordering::Release);
    for (index, name) in MODULES.iter().enumerate() {
        let bit = 1u32 << index;
        if PAD_TRIED.load(Ordering::Acquire) & bit != 0 {
            continue;
        }
        let module = win::module(name);
        if module == 0 {
            continue;
        }
        PAD_TRIED.fetch_or(bit, Ordering::AcqRel);
        // SAFETY: resolving exports of a loaded module; ordinal 100 is XInputGetStateEx.
        let exports = unsafe {
            [
                win::GetProcAddress(module, b"XInputGetState\0".as_ptr()) as usize,
                win::GetProcAddress(module, 100usize as *const u8) as usize,
            ]
        };
        for slot in 0..2 {
            if exports[slot] == 0 || (slot == 1 && exports[1] == exports[0]) {
                continue;
            }
            if hook::install_published(exports[slot], pad_replacement(index, slot), &PAD_TRAMPOLINES[index][slot]).is_none() {
                log::fmt(format_args!("input lock: pad hook {index}/{slot} failed"));
            }
        }
    }
}

fn pad_hooked() -> u32 {
    let mut count = 0;
    for module in 0..PAD_MODULES {
        for slot in 0..2 {
            if PAD_TRAMPOLINES[module][slot].load(Ordering::Relaxed) != 0 {
                count += 1;
            }
        }
    }
    count
}

/* ------------------------------------------------------------------------------------------------
 * Per-frame work: install, camera gate, badge
 * ---------------------------------------------------------------------------------------------- */

/// The camera gate: the local player's camera input permission follows the lock, so the user's mouse
/// look cannot fight the agent's view. A world change resets the state, so its first frame sets it
/// again; a failed command is retried once a second.
fn camera_gate(core: &'static Core, locked: bool, now: u64) {
    let in_world = core.engine().in_world();
    if in_world != CAMERA_WORLD.load(Ordering::Acquire) {
        CAMERA_WORLD.store(in_world, Ordering::Release);
        CAMERA_PERMISSION.store(-1, Ordering::Release);
        CAMERA_FAILURE_LOGGED.store(false, Ordering::Release);
    }
    if !in_world {
        return;
    }
    if CAMERA_RELEASED.load(Ordering::Acquire) {
        return;
    }
    let want = i32::from(locked);
    if CAMERA_PERMISSION.load(Ordering::Acquire) == want || now.saturating_sub(CAMERA_AT.load(Ordering::Relaxed)) < 1000 {
        return;
    }
    CAMERA_AT.store(now, Ordering::Release);
    let command = if want == 1 { "/inputpermission set @s camera disabled" } else { "/inputpermission set @s camera enabled" };
    CAMERA_BUSY.store(true, Ordering::Release);
    let outcome = core.quiet_command(command);
    CAMERA_BUSY.store(false, Ordering::Release);
    match outcome {
        Ok(()) => {
            CAMERA_PERMISSION.store(want, Ordering::Release);
            log::fmt(format_args!("input lock: camera permission {want}"));
        }
        Err(error) => {
            if !CAMERA_FAILURE_LOGGED.swap(true, Ordering::AcqRel) {
                log::fmt(format_args!("input lock: camera permission failed: {} (retried every second, logged once per world)", error.message));
            }
        }
    }
}

/// The action-bar badge, refreshed after every state change and every two seconds.
fn badge(core: &'static Core, locked: bool, user: bool, now: u64) {
    if !locked && !user {
        return;
    }
    if BADGE_SEQUENCE.load(Ordering::Acquire) == sequence() && now.saturating_sub(BADGE_AT.load(Ordering::Relaxed)) < 2000 {
        return;
    }
    if !core.engine().in_world() {
        return;
    }
    // A failure is retried with the refresh; it is logged once per state change, not every two seconds.
    let fresh = BADGE_SEQUENCE.swap(sequence(), Ordering::AcqRel) != sequence();
    BADGE_AT.store(now, Ordering::Release);
    let text = if locked {
        "/title @s actionbar \u{a7}esculkwire is playing \u{b7} your input is locked \u{b7} F9 to take over"
    } else {
        "/title @s actionbar \u{a7}ayou have control \u{b7} F9 to give it back"
    };
    if let Err(error) = core.quiet_command(text) {
        if fresh {
            log::fmt(format_args!("input lock: badge failed: {} (retried every two seconds)", error.message));
        }
    }
}

/// Called by the unload before the engine stops: a camera this agent disabled is enabled again, so the
/// lock fails open — the user is never left without mouse look once the agent is gone.
pub fn release_camera(core: &'static Core) {
    CAMERA_RELEASED.store(true, Ordering::Release);
    // A gate command already in flight finishes first (the quiet command is bounded at about a second).
    let start = win::tick_ms();
    while CAMERA_BUSY.load(Ordering::Acquire) && win::tick_ms().saturating_sub(start) < 2000 {
        win::sleep_ms(5);
    }
    if CAMERA_PERMISSION.load(Ordering::Acquire) != 1 {
        return;
    }
    match core.quiet_command("/inputpermission set @s camera enabled") {
        Ok(()) => {
            CAMERA_PERMISSION.store(0, Ordering::Release);
            log::line("unload: camera permission given back");
        }
        Err(error) => log::fmt(format_args!("unload: camera permission not given back: {}", error.message)),
    }
}

/// Called from [`Core::drain`](crate::Core::drain) every frame, on the main thread.
pub fn frame(core: &'static Core) {
    // Never (re)install anything once the unload has started: its hooks and subclasses must go, not
    // come back.
    if core.stopping() {
        return;
    }
    install();
    install_key_state_hooks();
    install_pad_hooks();
    let locked = on();
    let user = BY_USER.load(Ordering::Acquire) && wanted();
    let now = win::tick_ms();
    camera_gate(core, locked, now);
    badge(core, locked, user, now);
}

/* ------------------------------------------------------------------------------------------------
 * Requests
 * ---------------------------------------------------------------------------------------------- */

/// `input.lock {mode?: "on"|"off"|"auto", active?: bool}`; no params reads the state. `active` belongs
/// to the calling connection (bit `conn`). `on` and `off` take control back from the user.
pub fn request(conn: usize, params: &Value) -> Result<Value, RpcError> {
    let mode = params.get("mode").and_then(Value::as_str);
    let active = params.get("active").and_then(Value::as_bool);
    let mut set_mode = -1i32;
    if let Some(mode) = mode {
        set_mode = match mode {
            "off" => MODE_OFF,
            "on" => MODE_ON,
            "auto" => MODE_AUTO,
            _ => return Err(RpcError::invalid_params("mode must be \"on\", \"off\" or \"auto\"")),
        };
    }
    if params.get("mode").is_some() && mode.is_none() {
        return Err(RpcError::invalid_params("mode must be a string"));
    }
    if params.get("active").is_some() && active.is_none() {
        return Err(RpcError::invalid_params("active must be a boolean"));
    }
    if set_mode >= 0 || active.is_some() {
        let was = on();
        if set_mode >= 0 {
            if set_mode != MODE_AUTO {
                BY_USER.store(false, Ordering::Release);
            }
            MODE.store(set_mode, Ordering::Release);
        }
        if let Some(active) = active {
            let bit = 1u32 << conn.min(31);
            if active {
                ACTIVE.fetch_or(bit, Ordering::AcqRel);
            } else {
                ACTIVE.fetch_and(!bit, Ordering::AcqRel);
            }
        }
        // Nothing runs any more in auto: there is no control left to give back.
        if MODE.load(Ordering::Acquire) == MODE_AUTO && ACTIVE.load(Ordering::Acquire) == 0 {
            BY_USER.store(false, Ordering::Release);
        }
        changed(was, false);
    }
    Ok(json())
}

/// `input.focus {focused: bool}`: the host's focus of the game window, watched outside the game.
pub fn focus(params: &Value) -> Result<Value, RpcError> {
    let focused = params.get("focused").and_then(Value::as_bool).ok_or_else(|| RpcError::invalid_params("focused must be a boolean"))?;
    if focused != HOST_FOCUSED.load(Ordering::Acquire) {
        HOST_FOCUSED.store(focused, Ordering::Release);
        SEQUENCE.fetch_add(1, Ordering::AcqRel);
    }
    Ok(json())
}

/// The connection closed: its `active` bit ends with it.
pub fn connection_closed(conn: usize) {
    let bit = 1u32 << conn.min(31);
    if ACTIVE.load(Ordering::Acquire) & bit == 0 {
        return;
    }
    let was = on();
    ACTIVE.fetch_and(!bit, Ordering::AcqRel);
    if MODE.load(Ordering::Acquire) == MODE_AUTO && ACTIVE.load(Ordering::Acquire) == 0 {
        BY_USER.store(false, Ordering::Release);
    }
    changed(was, false);
}

/// The lock state, as `input.lock`, `input.focus` and the `lock` notification carry it.
pub fn json() -> Value {
    let mode = match MODE.load(Ordering::Acquire) {
        MODE_OFF => "off",
        MODE_ON => "on",
        _ => "auto",
    };
    json!({
        "locked": on(),
        "mode": mode,
        "by": if BY_USER.load(Ordering::Acquire) { "user" } else { "agent" },
        "user": user_has_control(),
        "active": ACTIVE.load(Ordering::Acquire) != 0,
        "window": WINDOW.load(Ordering::Acquire) != 0,
        "dropped": DROPPED.load(Ordering::Relaxed),
        "focusLost": FOCUS_LOST.load(Ordering::Relaxed),
        "focusKept": FOCUS_KEPT.load(Ordering::Relaxed),
        // `focused` is the composed view agent.c reported; the two parts are reported as well.
        "focused": APP_FOCUSED.load(Ordering::Relaxed) && FOREGROUND.load(Ordering::Relaxed),
        "appFocused": APP_FOCUSED.load(Ordering::Relaxed),
        "foreground": FOREGROUND.load(Ordering::Relaxed),
        "shift": {
            "message": [SHIFT_SEEN[0][0].load(Ordering::Relaxed), SHIFT_SEEN[0][1].load(Ordering::Relaxed)],
            "raw": [SHIFT_SEEN[1][0].load(Ordering::Relaxed), SHIFT_SEEN[1][1].load(Ordering::Relaxed)],
        },
        "keysHidden": KEYS_HIDDEN.load(Ordering::Relaxed),
        "hostFocused": HOST_FOCUSED.load(Ordering::Acquire),
        // The camera gate as last set in this world: "disabled" (the lock owns the view), "enabled", or
        // null when no gate command has run yet (still loading, or no player command to replay).
        "camera": match CAMERA_PERMISSION.load(Ordering::Acquire) {
            1 => Value::from("disabled"),
            0 => Value::from("enabled"),
            _ => Value::Null,
        },
        "pad": {
            "hooked": pad_hooked(),
            "reads": PAD_READS.load(Ordering::Relaxed),
            "active": PAD_ACTIVE.load(Ordering::Relaxed),
            "hidden": PAD_HIDDEN.load(Ordering::Relaxed),
        },
    })
}

/// Records that the engine's focus-lost handler ran (diagnostic).
pub fn note_app_focus(focused: bool) {
    APP_FOCUSED.store(focused, Ordering::Relaxed);
}

/// Records that the engine's focus-lost handler was kept from the game.
pub fn note_focus_kept() {
    FOCUS_LOST.fetch_add(1, Ordering::Relaxed);
    FOCUS_KEPT.fetch_add(1, Ordering::Relaxed);
}

/// Spins the window procedure once, for tests and for the engine's `debug.focus` equivalent.
pub fn post_focus_loss() -> bool {
    let window = WINDOW.load(Ordering::Acquire);
    if window == 0 {
        return false;
    }
    // SAFETY: posting to a window this process owns.
    unsafe {
        win::PostMessageW(window, win::WM_ACTIVATE, 0, 0);
        win::PostMessageW(window, win::WM_ACTIVATEAPP, 0, 0);
        win::PostMessageW(window, win::WM_KILLFOCUS, 0, 0);
    }
    true
}
