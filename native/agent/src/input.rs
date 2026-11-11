//! Input: held movement, the view, attack/use, and the local player's own state.
//!
//! # Wiring
//!
//! `lib.rs` lists these rows in `METHODS` (all `Thread::Main`: every call below runs a game function
//! or reads the client's component registry, and both belong to the game's own thread):
//!
//! ```text
//! Method::main("input.move",    input::h_input_move)
//! Method::main("input.release", input::h_input_release)
//! Method::main("input.look",    input::h_input_look)
//! Method::main("input.attack",  input::h_input_attack)
//! Method::main("input.use",     input::h_input_use)
//! Method::main("player.state",  input::h_player_state)
//! ```
//!
//! [`resolve`] finds the three input anchors and installs the two hooks below; [`report`] lists them
//! for `engine.status` (`input.move`, `input.attack`, `input.use`, `client.instance`).
//!
//! # Routes, per method
//!
//! **`input.move` — the game's own move-input state.** The client turns its devices into one
//! `MoveInputState` per tick (a flag word + an analog vector), and its input-update system copies that
//! state into the local player's `MoveInputComponent` after applying the `/inputpermission` locks
//! through one small function (`input.move`, below). That function is hooked: while a hold is fresh,
//! the detour replaces the movement half of the state it is handed — the direction bits, jump, sneak,
//! sprint and the analog vector — with the agent's, then lets the game apply its locks as it would
//! to a key press. Everything after it is the game's own pipeline: walking, jumping (the jump bit
//! becomes the component's *jumping* flag and the jump system's request), sneaking (the sneak bit is
//! what the sneak-intent system reads) and sprinting. No window message, no focus, no key state: the
//! input lock and the agent cannot starve each other, and a hold dies by itself [`HOLD_MS`] after
//! the last `input.move` because the detour stops applying it.
//!
//! The state word's bits are the game's own `MoveInputState` flags, proven by the lock function
//! itself: it clears bit 7 + 17 (+3/+5) for a jump lock, bit 0 + 18 (+2/+6) for a sneak lock, bits
//! 9..16 and the vector for a full movement lock, and turns `UpLeft` into `Up` when `Left` is locked —
//! so 13 = up, 14 = down, 15 = left, 16 = right, 0 = sneak, 7 = jump, 8 = sprint, and the analog
//! vector's `+x` is left (its clamp on a left lock is `x ≤ 0`). The resolver that turns that state
//! into a move uses the vector when it is non-zero and the direction bits otherwise, so the agent
//! writes both: the bits for every system that asks "is forward held", the vector for the exact
//! amount.
//!
//! **`input.attack` / `input.use` — the game's own button handlers.** A left or right click reaches
//! gameplay as the `button.destroy_or_attack` / `button.build_or_interact` handler the client
//! registers by name; each is a capture-less lambda `(FocusImpact, IClientInstance&)` that asks the
//! client for its level's hit results and hands them to the client's action handler (attack the
//! entity, start breaking the block, place or use, swing at air). The engine calls that lambda
//! itself, with the client instance the game passes to it — the same call a button press makes,
//! without a mouse. The client instance is the object the client's own `getLevel` method runs on:
//! that method (a ClientInstance vtable slot, found below) is hooked to remember its `this`.
//! `input.use {hold: true}` and `input.attack {hold: true}` are *held* buttons, which the game reads as
//! device state rather than an event (a held left button keeps breaking the block under the crosshair),
//! so a hold is the GameInput button (or the window message when GameInput is not hooked), checked
//! every [`TICK_MS`] and dropped [`HOLD_MS`] after the last renewal.
//!
//! The use path builds item stacks, and an item stack looks its item up through a thread-local
//! item-registry pointer the drain's thread does not hold (the game asserts when it is empty). Every
//! click therefore runs inside the client's own item-registry scope, opened exactly as the client's
//! methods open it ([`with_item_scope`]); `input.use` refuses (`-32001 input.item_scope`) without it.
//!
//! **`input.look` — the active camera.** The player's rotation follows the active camera every frame,
//! so the view is written where mouse look goes: in first person into the camera's
//! `CameraDirectLookComponent` (radians), into each camera whose pair is the player's current
//! rotation under the game's convention; in third person (back and front view) into the active
//! orbit camera's `CameraOrbitComponent` angles, by the camera's look mode (see [`crate::look`]).
//! The player's `ActorRotationComponent` is written too, for an immediate read-back. When the
//! registry cannot be resolved, the request falls back to [`crate::live::request_look`].
//!
//! **`player.state` — components, with `live`'s snapshot as the fallback.** Position, rotation, delta
//! and on ground come from `StateVectorComponent`, `ActorRotationComponent` and
//! `OnGroundFlagComponent`; health from the attribute container's own instance whose *definition*
//! names it `minecraft:health`; the dimension's raw state dword from `DimensionStateComponent`.
//! `selectedSlot` answers `null` here (the inventory module reads it from the player object).
//!
//! `input.attack` and `input.use` also report the crosshair target, read before the click (the click
//! is what changes it). `HitResultComponent`'s element (stride 8) is a `unique_ptr` to a holder whose
//! vtable `+0x18` getter answers `{count, begin}` of a vector at `+0x08`/`+0x10` of 0x110-byte entries:
//! each entry is a pair of `HitResult`s (the pick with entities, then the block-only ray), queued per
//! tick, newest last. The newest pick is read with the public `HitResult` layout, checked live on
//! 1.26.63.1: `+0x18` type (0 block, 1 entity, 3 none), `+0x1c` face byte, `+0x20` block `BlockPos`,
//! `+0x2c` hit position `Vec3`, `+0x48` the target's `EntityId`. An entity is reported only when that id
//! has an `ActorUniqueIDComponent` in the player's registry *and* stands within [`HIT_REACH`] blocks;
//! its type comes from `ActorDefinitionIdentifierComponent` only when the full name equals
//! `namespace:identifier`. Anything that does not check out answers `null`.
//!
//! # Live checks
//!
//! 1. **Movement**: `input.move {forward:1}` for a second in a `sculkwire-*` world; the player walks,
//!    and `engine.status.hooks["input.move"]` counts one call per client tick. It stops within a second
//!    of the last call. `{strafe:1}` walks right, `{jump:true}` jumps (and keeps jumping while held),
//!    `{sneak:true}` lowers the camera, `{sprint:true, forward:1}` widens the FOV.
//! 2. **Attack/use**: `input.attack` while aiming at a block breaks it in creative (starts breaking in
//!    survival) and at a mob hits it; `{hit}` must equal that mob's unique id. `input.use` with a block
//!    in hand places it (no fault line); on a chest it opens the chest screen. `client.instance` must
//!    be resolved (its hook fires every frame) before either is called.
//! 3. **Look**: `input.look {pitch:30, yaw:90}` answers `route: "camera"`, the view turns, and
//!    `player.state.rotation` still reads `[30, 90]` two seconds later.
//! 4. **Health**: take damage and watch `health` follow the HUD's hearts.
//!
//! Nothing here holds a lock while it calls the game, and every game address is checked readable
//! before it is read, so a build whose layouts moved answers `null` (or `-32001`) instead of a
//! number.

use alloc::boxed::Box;
use alloc::string::String;
use alloc::vec::Vec;
use core::ffi::c_void;
use core::mem::transmute;
use core::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};

use serde_json::{json, Value};

use agent_core::hub::Movement;
use agent_core::sync::SpinLock;
use agent_core::{gameinput, hook, log, message_loop, win, Anchor, Core, Image, RpcError};

use crate::{anchors, ecs, live, look, pe};

/* ------------------------------------------------------------------------------------------------
 * Params
 * ---------------------------------------------------------------------------------------------- */

fn axis(params: &Value, key: &str) -> Result<f32, RpcError> {
    match params.get(key) {
        None => Ok(0.0),
        Some(value) => match value.as_f64() {
            Some(number) if number.is_finite() && (-1.0..=1.0).contains(&number) => Ok(number as f32),
            _ => Err(RpcError::invalid_params(alloc::format!("{key} must be a number in -1..1"))),
        },
    }
}

fn flag(params: &Value, key: &str) -> Result<bool, RpcError> {
    match params.get(key) {
        None => Ok(false),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| RpcError::invalid_params(alloc::format!("{key} must be a boolean"))),
    }
}

fn number(params: &Value, key: &str) -> Result<f64, RpcError> {
    match params.get(key).and_then(Value::as_f64) {
        Some(value) if value.is_finite() => Ok(value),
        _ => Err(RpcError::invalid_params(alloc::format!("{key} must be a finite number"))),
    }
}

/// `-32002` unless a world this process hosts is loaded with a local player.
fn world() -> Result<(), RpcError> {
    if live::in_world() {
        Ok(())
    } else {
        Err(RpcError::not_in_world())
    }
}

fn set(object: &mut Value, key: &'static str, value: Value) {
    if let Value::Object(map) = object {
        map.insert(String::from(key), value);
    }
}

fn number_or_null(value: f32) -> Value {
    serde_json::Number::from_f64(value as f64).map(Value::Number).unwrap_or(Value::Null)
}

fn floats(values: &[f32]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|value| serde_json::Number::from_f64(*value as f64).map(Value::Number).unwrap_or(Value::Null))
            .collect(),
    )
}

/* ------------------------------------------------------------------------------------------------
 * The game window
 *
 * The drain runs on the game window's thread, which is also the thread that calls `Minecraft::update`
 * and the only thread that may run the window procedure. Everything below is called from a Main
 * method, so it is already on that thread; the window is looked up once and revalidated on every use
 * because a world load does not destroy it but a resolution change can.
 * ---------------------------------------------------------------------------------------------- */

#[link(name = "user32", kind = "raw-dylib")]
extern "system" {
    /// `GetClassLongPtrW`: `GCLP_WNDPROC` is the *class* procedure. Calling it is how a message
    /// reaches the game's own handler without passing the input lock's subclass. Declared here
    /// because `agent_core::win` does not import it.
    fn GetClassLongPtrW(window: win::Hwnd, index: i32) -> isize;
}

/// `GCLP_WNDPROC`: the class procedure's slot in `GetClassLongPtrW`'s index space.
const GCLP_WNDPROC: i32 = -24;

/// The window the synthesized messages go to, 0 until one is found.
static WINDOW: AtomicUsize = AtomicUsize::new(0);

/// The best candidate of the current enumeration: its handle and its client area.
static PICK: AtomicUsize = AtomicUsize::new(0);
static PICK_AREA: AtomicUsize = AtomicUsize::new(0);

/// The game window: the window the drain timer runs on, or the largest visible window of this
/// process. `None` while the game has no window at all.
pub(crate) fn window() -> Option<win::Hwnd> {
    let cached = WINDOW.load(Ordering::Acquire);
    if cached != 0 {
        let handle = cached as win::Hwnd;
        // SAFETY: `IsWindow` accepts any handle and answers about its validity.
        if unsafe { win::IsWindow(handle) } != 0 {
            return Some(handle);
        }
        WINDOW.store(0, Ordering::Release);
    }
    let found = find_window()?;
    WINDOW.store(found as usize, Ordering::Release);
    Some(found)
}

fn find_window() -> Option<win::Hwnd> {
    PICK.store(0, Ordering::Relaxed);
    PICK_AREA.store(0, Ordering::Relaxed);
    // The window the message loop already proved exists: the one its drain timer runs on.
    let thread = message_loop::window_thread();
    if thread != 0 {
        // SAFETY: `EnumThreadWindows` takes a thread id and a callback; both are valid.
        unsafe { win::EnumThreadWindows(thread, collect_window, 0) };
    }
    if PICK.load(Ordering::Acquire) == 0 {
        // SAFETY: `EnumWindows` takes a callback; it is valid.
        unsafe { win::EnumWindows(collect_window, 0) };
    }
    let pick = PICK.load(Ordering::Acquire);
    (pick != 0).then_some(pick as win::Hwnd)
}

/// `EnumWindows`/`EnumThreadWindows` callback: keeps the largest visible window of this process.
unsafe extern "system" fn collect_window(window: win::Hwnd, _arg: win::Lparam) -> win::Bool {
    if win::IsWindowVisible(window) == 0 {
        return 1;
    }
    let mut process = 0u32;
    win::GetWindowThreadProcessId(window, &mut process);
    if process == 0 || process != win::current_process_id() {
        return 1;
    }
    let mut rect = win::Rect { left: 0, top: 0, right: 0, bottom: 0 };
    if win::GetClientRect(window, &mut rect) == 0 {
        return 1;
    }
    let width = (rect.right - rect.left).max(0) as usize;
    let height = (rect.bottom - rect.top).max(0) as usize;
    let area = width * height;
    if area == 0 || area < PICK_AREA.load(Ordering::Relaxed) {
        return 1;
    }
    PICK_AREA.store(area, Ordering::Relaxed);
    PICK.store(window as usize, Ordering::Relaxed);
    1
}

/// The client area centre, which is where a synthesized mouse message points (the crosshair is what
/// the game acts on; the coordinate only matters to a screen that is looking at it).
fn centre(window: win::Hwnd) -> (isize, isize) {
    let mut rect = win::Rect { left: 0, top: 0, right: 0, bottom: 0 };
    // SAFETY: the out pointer is a valid `RECT`.
    if unsafe { win::GetClientRect(window, &mut rect) } == 0 {
        return (0, 0);
    }
    (((rect.right - rect.left) / 2).max(0) as isize, ((rect.bottom - rect.top) / 2).max(0) as isize)
}

/* ------------------------------------------------------------------------------------------------
 * The held buttons: GameInput's own reading, or the window message
 *
 * A *held* button is device state — the game asks "is it still down" every tick — so a hold cannot be
 * an event handler call. It is the button in GameInput's reading while that interface is hooked, else
 * the window message, and a timer drops it [`HOLD_MS`] after the last renewal.
 * ---------------------------------------------------------------------------------------------- */

const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_RBUTTONDOWN: u32 = 0x0204;
const WM_RBUTTONUP: u32 = 0x0205;
/// `wparam` of a left / right button down: the button that is down.
const MK_LBUTTON: usize = 0x0001;
const MK_RBUTTON: usize = 0x0002;

/// One mouse button a hold can keep down.
struct Held {
    /// The name `input.release` reports it under.
    name: &'static str,
    button: gameinput::Button,
    down: u32,
    up: u32,
    mk: usize,
    /// 1 while a hold is asked for.
    held: AtomicU32,
    /// `GetTickCount64` of the last renewal; the hold dies [`HOLD_MS`] later.
    stamp: AtomicU64,
    /// 1 while the button's down has been delivered, so a release sends exactly one up.
    applied: AtomicU32,
}

impl Held {
    const fn new(name: &'static str, button: gameinput::Button, down: u32, up: u32, mk: usize) -> Self {
        Self { name, button, down, up, mk, held: AtomicU32::new(0), stamp: AtomicU64::new(0), applied: AtomicU32::new(0) }
    }

    /// The button down or up: GameInput's reading once the game is seen reading the mouse through it
    /// ([`gameinput::mouse_read`] — a hooked interface the game never reads is not a route), else the
    /// window message.
    fn press(&self, window: win::Hwnd, down: bool) {
        if gameinput::mouse_read() && gameinput::hold(self.button, down) {
            return;
        }
        let (x, y) = centre(window);
        let lparam = (y << 16) | (x & 0xFFFF);
        if down {
            deliver(window, self.down, self.mk, lparam);
        } else {
            deliver(window, self.up, 0, lparam);
        }
    }

    /// Asks for the hold (or renews it): the down goes out once, the timer drops it after silence.
    fn hold(&self, window: win::Hwnd) {
        self.held.store(1, Ordering::Release);
        self.stamp.store(win::tick_ms(), Ordering::Release);
        if !ensure_timer(window) {
            agent_core::log::fmt(format_args!("input: no window timer; a held {} will not expire on its own", self.name));
        }
        if self.applied.swap(1, Ordering::AcqRel) == 0 {
            self.press(window, true);
        }
    }

    /// True when the hold ran out (no renewal for [`HOLD_MS`]) or is not asked for.
    fn stale(&self) -> bool {
        self.held.load(Ordering::Acquire) == 0 || win::tick_ms().saturating_sub(self.stamp.load(Ordering::Acquire)) > HOLD_MS
    }

    /// Ends the hold; true when a delivered down was released.
    fn release(&self, window: Option<win::Hwnd>) -> bool {
        self.held.store(0, Ordering::Release);
        let was = self.applied.swap(0, Ordering::AcqRel) != 0;
        if let (true, Some(window)) = (was, window) {
            self.press(window, false);
        }
        was
    }
}

/// The right button `input.use {hold: true}` keeps down.
static USE: Held = Held::new("use", gameinput::Button::Right, WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON);
/// The left button `input.attack {hold: true}` keeps down.
static ATTACK: Held = Held::new("attack", gameinput::Button::Left, WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON);
static HELD: [&Held; 2] = [&USE, &ATTACK];
/// The window timer's id, 0 while no timer is installed.
static TIMER: AtomicUsize = AtomicUsize::new(0);

/// The window timer's id. Any value not the drain timer's `0x0053_0043`; the callback form means the
/// window procedure never sees a `WM_TIMER` for it.
const TIMER_ID: usize = 0x0053_4B49;
/// How often a held button's expiry is checked.
const TICK_MS: u32 = 100;
/// A hold (movement or a button) with no renewal for this long is released.
const HOLD_MS: u64 = 1_000;

/// Delivers one message to the game's own window procedure.
///
/// The *class* procedure is preferred: it is the one the game installed, and it is reachable through
/// `GetClassLongPtrW`, which skips every instance subclass — the input lock's included — so the two
/// cannot fight over the same messages. `CallWindowProcW` is the documented way to call a procedure
/// obtained this way. The instance procedure and finally `PostMessageW` are the fallbacks, in that
/// order.
fn deliver(window: win::Hwnd, message: u32, wparam: win::Wparam, lparam: win::Lparam) {
    // SAFETY: `GetClassLongPtrW` with a valid window and index.
    let class = unsafe { GetClassLongPtrW(window, GCLP_WNDPROC) } as usize;
    if class != 0 {
        // SAFETY: the slot is the class's window procedure, whose signature is `WndProc`.
        let procedure = unsafe { core::mem::transmute::<usize, win::WndProc>(class) };
        unsafe { win::CallWindowProcW(procedure, window, message, wparam, lparam) };
        return;
    }
    // SAFETY: the instance slot has the same signature.
    let instance = unsafe { win::GetWindowLongPtrW(window, win::GWLP_WNDPROC) } as usize;
    if instance != 0 {
        let procedure = unsafe { core::mem::transmute::<usize, win::WndProc>(instance) };
        unsafe { win::CallWindowProcW(procedure, window, message, wparam, lparam) };
        return;
    }
    // SAFETY: a plain post; the game's own loop dispatches it.
    unsafe { win::PostMessageW(window, message, wparam, lparam) };
}

/// Which path a held button takes right now.
fn hold_route() -> &'static str {
    if gameinput::mouse_read() {
        "gameinput"
    } else {
        "window"
    }
}

/// Releases one held button, if it is held, and stops the timer once no button is held. True when a
/// down was released.
fn release_held(held: &Held) -> bool {
    let window = window();
    let was = held.release(window);
    if let Some(window) = window.filter(|_| HELD.iter().all(|held| held.held.load(Ordering::Acquire) == 0)) {
        stop_timer(window);
    }
    was
}

/// Releases the held use button (see [`release_held`]).
fn release_use() -> bool {
    release_held(&USE)
}

/// Installs the expiry timer, once. It only works from the window's own thread: a timer's callback
/// runs from that thread's message dispatch, and any other thread's would never be pumped.
fn ensure_timer(window: win::Hwnd) -> bool {
    if TIMER.load(Ordering::Acquire) != 0 {
        return true;
    }
    let window_thread = message_loop::window_thread();
    if window_thread != 0 && win::current_thread_id() != window_thread {
        return false;
    }
    // SAFETY: `SetTimer` with a valid window, an id nothing else uses and a `TimerProc`.
    let id = unsafe { win::SetTimer(window, TIMER_ID, TICK_MS, tick as *const () as *mut c_void) };
    if id == 0 {
        return false;
    }
    TIMER.store(id, Ordering::Release);
    true
}

fn stop_timer(window: win::Hwnd) {
    let id = TIMER.swap(0, Ordering::AcqRel);
    if id != 0 {
        // SAFETY: `KillTimer` on a window and an id this module installed.
        unsafe { win::KillTimer(window, id) };
    }
}

/// `agent.unload`: kills the hold timer and forgets every hold.
///
/// The timer's callback is this crate's code, so user32 calling it after the image is freed is a crash.
/// The buttons are *not* re-sent as released — that is a message to the game's window procedure, and
/// this runs on the unload thread where the game's input state is not ours to touch. The two hooks are
/// taken out by the core's unload with every other inline hook, and the movement hold stops applying as
/// soon as its stamp is cleared.
pub fn detach() {
    if let Some(window) = window() {
        stop_timer(window);
    }
    for held in HELD {
        held.held.store(0, Ordering::Release);
        held.applied.store(0, Ordering::Release);
    }
    MOVE_STAMP.store(0, Ordering::Release);
}

/// The hold timer: releases a held button nobody renewed, and stops once none is held.
unsafe extern "system" fn tick(window: win::Hwnd, _message: u32, id: usize, _time: u32) {
    let gone = win::IsWindow(window) == 0;
    for held in HELD {
        if gone || held.stale() {
            held.release(Some(window).filter(|_| !gone));
        }
    }
    if HELD.iter().all(|held| held.held.load(Ordering::Acquire) == 0) {
        TIMER.store(0, Ordering::Release);
        win::KillTimer(window, id);
    }
}

/// Releases a held button that ran out, before anything else looks at it. Every handler starts with
/// this, so a caller that stopped talking to the agent cannot leave a button down even if the timer
/// never ran.
fn expire() {
    for held in HELD {
        if held.held.load(Ordering::Acquire) != 0 && held.stale() {
            release_held(held);
            agent_core::log::fmt(format_args!("input: a held {} expired without an update", held.name));
        }
    }
}

/* ------------------------------------------------------------------------------------------------
 * Movement: the game's own move-input state
 * ---------------------------------------------------------------------------------------------- */

/// `MoveInputState` flag bits (the module documentation says how the lock function proves each).
const STATE_SNEAK: u32 = 1 << 0;
const STATE_JUMP: u32 = 1 << 7;
const STATE_SPRINT: u32 = 1 << 8;
const STATE_UP: u32 = 1 << 13;
const STATE_DOWN: u32 = 1 << 14;
const STATE_LEFT: u32 = 1 << 15;
const STATE_RIGHT: u32 = 1 << 16;
/// Bits 9..16: the four diagonals and the four directions — the set a full movement lock clears.
const STATE_DIRECTIONS: u32 = 0x0001_FE00;
/// What a hold owns in the state word: every direction plus jump, sneak and sprint.
const STATE_OWNED: u32 = STATE_DIRECTIONS | STATE_SNEAK | STATE_JUMP | STATE_SPRINT;
/// The analog vector inside the state (`+x` is left, `+y` is forward): two `f32` after the flag word.
const STATE_VECTOR: usize = 0x04;
/// The state's bits with the names `input.move` reports, in the wire's order.
const STATE_NAMES: [(u32, &str); 7] = [
    (STATE_UP, "forward"),
    (STATE_LEFT, "left"),
    (STATE_DOWN, "back"),
    (STATE_RIGHT, "right"),
    (STATE_JUMP, "jump"),
    (STATE_SNEAK, "sneak"),
    (STATE_SPRINT, "sprint"),
];

/// The held movement the detour applies: the state bits, the vector (as `f32` bits), and the stamp of
/// the `input.move` that set them (0 = nothing held). The stamp is written last and read first.
static MOVE_BITS: AtomicU32 = AtomicU32::new(0);
static MOVE_X: AtomicU32 = AtomicU32::new(0);
static MOVE_Y: AtomicU32 = AtomicU32::new(0);
static MOVE_STAMP: AtomicU64 = AtomicU64::new(0);
/// The game's lock function (`input.move`) and the trampoline that runs it. 0 = not hooked.
static MOVE_ENTRY: AtomicUsize = AtomicUsize::new(0);
static MOVE_TRAMPOLINE: AtomicUsize = AtomicUsize::new(0);
/// Client ticks a hold was applied to, for the log line of the first one.
static MOVE_APPLIED: AtomicU64 = AtomicU64::new(0);

/// `engine.status.hooks` name of the movement hook (also its anchor).
const SITE_MOVE: &str = "input.move";

/// `and dword ptr [rdx], imm32`: the three locks the function applies to the state word — every
/// direction (`0xfffe01ff`, which also zeroes the vector right after), sneak (`0xfffbffba`) and jump
/// (`0xfffdff57`). Each occurs once in the image, in this one function.
const LOCK_MOVE: [u8; 6] = [0x81, 0x22, 0xFF, 0x01, 0xFE, 0xFF];
const LOCK_SNEAK: [u8; 6] = [0x81, 0x22, 0xBA, 0xFF, 0xFB, 0xFF];
const LOCK_JUMP: [u8; 6] = [0x81, 0x22, 0x57, 0xFF, 0xFD, 0xFF];
/// The function's entry: `movzx eax, word ptr [rcx+2]; test al, al; js …` — it reads the lock word of
/// `ClientInputLockComponent` and branches on its first lock bit.
const LOCK_ENTRY: [u8; 8] = [0x0F, 0xB7, 0x41, 0x02, 0x84, 0xC0, 0x0F, 0x88];
/// The masks and the entry are one small leaf function: this far apart at most.
const LOCK_SPAN: usize = 0x400;
/// The lock function's direct callers: the input-update system and the component re-apply (two on
/// 1.26.63.1). More than this and the function is not the one small leaf the recipe names.
const MOVE_CALLERS: usize = 4;

/// The state a [`Movement`] holds: the flag bits, and the analog vector in the game's axes.
fn movement_state(movement: &Movement) -> (u32, f32, f32) {
    let threshold = agent_core::hub::MOVEMENT_THRESHOLD;
    let mut bits = 0u32;
    if movement.forward >= threshold {
        bits |= STATE_UP;
    }
    if movement.forward <= -threshold {
        bits |= STATE_DOWN;
    }
    if movement.strafe >= threshold {
        bits |= STATE_RIGHT;
    }
    if movement.strafe <= -threshold {
        bits |= STATE_LEFT;
    }
    if movement.jump {
        bits |= STATE_JUMP;
    }
    if movement.sneak {
        bits |= STATE_SNEAK;
    }
    if movement.sprint {
        bits |= STATE_SPRINT;
    }
    // The wire's strafe is `-1` left … `1` right; the game's `+x` is left.
    (bits, -movement.strafe, movement.forward)
}

fn state_names(bits: u32) -> Vec<Value> {
    STATE_NAMES
        .iter()
        .filter(|(bit, _)| bits & bit != 0)
        .map(|(_, name)| Value::String(String::from(*name)))
        .collect()
}

/// The movement bits held right now (0 when nothing is held or the hold ran out).
fn held_movement() -> u32 {
    let stamp = MOVE_STAMP.load(Ordering::Acquire);
    if stamp == 0 || win::tick_ms().saturating_sub(stamp) > HOLD_MS {
        return 0;
    }
    MOVE_BITS.load(Ordering::Acquire)
}

/// Forgets the movement hold; the bits it held, for the answer.
fn clear_movement() -> u32 {
    let held = held_movement();
    MOVE_STAMP.store(0, Ordering::Release);
    held
}

/// The hook on the game's input-lock function, `(ClientInputLockComponent const&, MoveInputState&)`.
///
/// The client's input-update system copies the device state onto its stack and hands it here before
/// writing it into the local player's `MoveInputComponent`, once per client tick. While a hold is fresh,
/// the movement half of that state is the agent's; then the game's own locks apply to it unchanged.
extern "C" fn apply_locks(lock: usize, state: usize) {
    if let Some(core) = agent_core::hub::started() {
        core.site_fired(SITE_MOVE);
    }
    let stamp = MOVE_STAMP.load(Ordering::Acquire);
    if state != 0 && stamp != 0 && win::tick_ms().saturating_sub(stamp) <= HOLD_MS {
        // SAFETY: `state` is the 16-byte `MoveInputState` the game's input system built on its own stack
        // (the recipe proves the single call site hands `lea rdx,[rsp+…]`); its flag word and vector are
        // exactly what the device layer writes.
        unsafe {
            let flags = core::ptr::read_unaligned(state as *const u32);
            core::ptr::write_unaligned(state as *mut u32, (flags & !STATE_OWNED) | MOVE_BITS.load(Ordering::Acquire));
            core::ptr::write_unaligned((state + STATE_VECTOR) as *mut u32, MOVE_X.load(Ordering::Acquire));
            core::ptr::write_unaligned((state + STATE_VECTOR + 4) as *mut u32, MOVE_Y.load(Ordering::Acquire));
        }
        if MOVE_APPLIED.fetch_add(1, Ordering::Relaxed) == 0 {
            agent_core::log::line("input: the first movement hold reached the game's move-input state");
        }
    }
    let original = MOVE_TRAMPOLINE.load(Ordering::Acquire);
    if original != 0 {
        // SAFETY: the trampoline runs the game's own lock function with the two arguments it was given.
        unsafe { transmute::<usize, extern "C" fn(usize, usize)>(original)(lock, state) }
    }
}

/// The lock function, from its three lock masks and its entry (see [`LOCK_ENTRY`]), with the call site
/// the client's input system uses checked to hand it a stack copy of the state.
fn resolve_movement(image: &Image) -> Option<usize> {
    let code = pe::code(image)?;
    let bytes = code.bytes;
    let mut found: [Option<usize>; 3] = [None; 3];
    let mut at = 0usize;
    while at + 6 <= bytes.len() {
        if bytes[at] == 0x81 && bytes[at + 1] == 0x22 {
            let window = &bytes[at..at + 6];
            for (index, mask) in [LOCK_MOVE, LOCK_SNEAK, LOCK_JUMP].iter().enumerate() {
                if window == mask {
                    if found[index].is_some() {
                        return None; // a second copy: not the one function this recipe names
                    }
                    found[index] = Some(at);
                }
            }
        }
        at += 1;
    }
    let [Some(movement), Some(sneak), Some(jump)] = found else {
        return None;
    };
    let low = movement.min(sneak).min(jump);
    let high = movement.max(sneak).max(jump);
    if high - low > 0x80 {
        return None;
    }
    let mut entry: Option<usize> = None;
    for start in low.saturating_sub(LOCK_SPAN)..low {
        if bytes[start..].starts_with(&LOCK_ENTRY) {
            if entry.is_some() {
                return None;
            }
            entry = Some(start);
        }
    }
    let entry = entry?;
    // A function entry: the byte before it is padding or the previous function's `ret`.
    if entry == 0 || !matches!(bytes[entry - 1], 0xCC | 0xC3 | 0x90) {
        return None;
    }
    let address = code.va + entry;
    // Its callers: the client's input-update system, which hands a stack copy of the device state
    // (`lea rdx,[rsp+disp8]`) — and on 1.26.63.1 one more, which applies the same locks to the
    // `MoveInputComponent` element itself (its first 16 bytes are the same flag word + vector, the
    // caller tests `[rsi+0x60]` right after). A detour that writes the hold into either is what a
    // held key would have put there. At most a handful of callers, and the stack-copy one must exist.
    let callers = pe::callers(image, address);
    if callers.is_empty() || callers.len() > MOVE_CALLERS {
        return None;
    }
    callers
        .iter()
        .any(|site| {
            site.checked_sub(16)
                .and_then(|from| pe::bytes(from, 16))
                .is_some_and(|before| before.windows(4).any(|window| window == [0x48, 0x8D, 0x54, 0x24]))
        })
        .then_some(address)
}

/* ------------------------------------------------------------------------------------------------
 * Attack and use: the game's own button handlers
 * ---------------------------------------------------------------------------------------------- */

/// The handler bodies (`std::function::_Do_call`) the client registers for the two buttons, and their
/// `std::function` tables (the functor object the handler is called with starts with its table).
static ATTACK_HANDLER: AtomicUsize = AtomicUsize::new(0);
static ATTACK_TABLE: AtomicUsize = AtomicUsize::new(0);
static USE_HANDLER: AtomicUsize = AtomicUsize::new(0);
static USE_TABLE: AtomicUsize = AtomicUsize::new(0);
/// The client instance's own vtable, its `getLevel` method (hooked), and that hook's trampoline.
static CLIENT_TABLE: AtomicUsize = AtomicUsize::new(0);
static CLIENT_GETTER: AtomicUsize = AtomicUsize::new(0);
static CLIENT_TRAMPOLINE: AtomicUsize = AtomicUsize::new(0);
/// The client instance `getLevel` last ran on (the object the button handlers take).
static CLIENT: AtomicUsize = AtomicUsize::new(0);

/// `engine.status.hooks` name of the client-instance capture (also its anchor).
const SITE_CLIENT: &str = "client.instance";

/// The button names the client registers its gameplay handlers under.
const ATTACK_BUTTON: &[u8] = b"button.destroy_or_attack";
const USE_BUTTON: &[u8] = b"button.build_or_interact";
/// A `ClientInstance` virtual's own `__FUNCSIG__`: the method that references it is in the client
/// instance's vtable, which is how the table is found without RTTI.
const CLIENT_SIGNATURE: &[u8] = b"virtual void __cdecl ClientInstance::requestLeaveGame(bool, bool)";
/// `ClientInstance::getLevel`: `mov rax,[rcx+minecraft]; mov rax,[rax+level holder]; test rax,rax; je;
/// cmp byte [rax+0x28],1; jne; mov rcx,[rax+0x30]; test rcx,rcx; je; cmp byte [rcx],1; jne;
/// mov rax,[rax+0x40]; ret` — a non-owning pointer's checked read. `None` is a wildcard.
const LEVEL_GETTER: [Option<u8>; 44] = {
    const W: Option<u8> = None;
    [
        Some(0x48), Some(0x8B), Some(0x81), W, W, W, W, Some(0x48), Some(0x8B), Some(0x80), W, W, W, W, Some(0x48),
        Some(0x85), Some(0xC0), Some(0x74), W, Some(0x80), Some(0x78), Some(0x28), Some(0x01), Some(0x75), W,
        Some(0x48), Some(0x8B), Some(0x48), Some(0x30), Some(0x48), Some(0x85), Some(0xC9), Some(0x74), W,
        Some(0x80), Some(0x39), Some(0x01), Some(0x75), W, Some(0x48), Some(0x8B), Some(0x40), Some(0x40),
        Some(0xC3),
    ]
};

/// True when the bytes at `address` match `pattern` (`None` matches any byte).
pub(crate) fn matches_at(address: usize, pattern: &[Option<u8>]) -> bool {
    let Some(bytes) = pe::bytes(address, pattern.len()) else {
        return false;
    };
    bytes.iter().zip(pattern).all(|(byte, want)| want.is_none_or(|want| want == *byte))
}

/// The hook on `ClientInstance::getLevel`: remembers the client it runs on, and forwards the call.
///
/// The method is called many times a frame (the HUD, the renderer, the button handlers themselves), so
/// the detour only compares and stores a pointer; whether the object really is the client instance is
/// checked when it is used ([`client`]).
extern "C" fn client_level(client: usize) -> usize {
    if client != 0 && CLIENT.load(Ordering::Relaxed) != client {
        CLIENT.store(client, Ordering::Release);
    }
    let original = CLIENT_TRAMPOLINE.load(Ordering::Acquire);
    if original == 0 {
        return 0;
    }
    // SAFETY: the trampoline runs the game's own one-argument getter with the `this` it was given.
    unsafe { transmute::<usize, extern "C" fn(usize) -> usize>(original)(client) }
}

/// The client instance the button handlers take: the object `getLevel` last ran on, while its first
/// qword is still the client instance's own table.
fn client() -> Option<usize> {
    let client = CLIENT.load(Ordering::Acquire);
    let table = CLIENT_TABLE.load(Ordering::Acquire);
    if client == 0 || table == 0 {
        return None;
    }
    (pe::read::<usize>(client)? == table).then_some(client)
}

/// Runs one button handler the way the game runs it on a press of that button.
fn press_button(handler: usize, table: usize, client: usize) {
    // The functor is a `std::function` implementation object whose first qword is its table; a
    // capture-less handler never reads it, but it is the object the game passes.
    let functor: [usize; 8] = [table, 0, 0, 0, 0, 0, 0, 0];
    // `FocusImpact::Neutral`, passed by reference as `std::function` passes its arguments.
    let focus: u8 = 0;
    // SAFETY: `handler` is the body the client registered for this button (validated at attach) and is
    // called with what `std::function::_Do_call` passes: the functor, `FocusImpact&&`,
    // `IClientInstance&` (validated by its vtable just before).
    unsafe { transmute::<usize, extern "C" fn(*const usize, *const u8, usize)>(handler)(functor.as_ptr(), &focus, client) }
}

/// One button's handler: the `std::function` table stored just before the button's name is copied in
/// the client's registration, and that table's `_Do_call` when it is a button handler ([`lambda_body`]).
/// `(handler, table, registrar)`; refused when two registrations disagree.
fn button_handler(image: &Image, name: &[u8]) -> Option<(usize, usize, usize)> {
    let string = image.find_string(name)?;
    let sites = pe::scan_refs(image, &[string]).into_iter().next()?;
    let mut found: Option<(usize, usize, usize)> = None;
    for site in sites {
        let Some(start) = image.function_start(site) else {
            continue;
        };
        let from = site.saturating_sub(0x100).max(start);
        let Some(window) = pe::bytes(from, site - from) else {
            continue;
        };
        // The last `lea rax,[rip+disp32]` before the name: the handler's `std::function` table.
        let mut table: Option<usize> = None;
        let mut at = 0usize;
        while at + 7 <= window.len() {
            if window[at] == 0x48 && window[at + 1] == 0x8D && window[at + 2] == 0x05 {
                let disp = i32::from_le_bytes([window[at + 3], window[at + 4], window[at + 5], window[at + 6]]) as isize;
                table = Some((from + at + 7).wrapping_add_signed(disp));
            }
            at += 1;
        }
        let Some(table) = table else {
            continue;
        };
        let Some(handler) = lambda_body(table) else {
            continue;
        };
        if found.is_some_and(|(known, _, _)| known != handler) {
            return None;
        }
        found = Some((handler, table, start));
    }
    found
}

/// The `_Do_call` of a capture-less lambda's `std::function` table, when it is a button handler: the
/// table's copy and move entries are one function (nothing is captured), and the body keeps its third
/// argument — the client — (`mov rsi, r8`) and calls through its table (`mov rax, [r8]`).
fn lambda_body(table: usize) -> Option<usize> {
    if !pe::in_image_data(table) {
        return None;
    }
    let copy = pe::read::<usize>(table)?;
    let moved = pe::read::<usize>(table + 8)?;
    let call = pe::read::<usize>(table + 16)?;
    if !pe::in_image_code(copy) || copy != moved || !pe::in_image_code(call) {
        return None;
    }
    let head = pe::bytes(call, 0x20)?;
    let keeps = head.windows(3).any(|window| window == [0x4C, 0x89, 0xC6]);
    let dispatches = head.windows(3).any(|window| window == [0x49, 0x8B, 0x00]);
    (keeps && dispatches).then_some(call)
}

/// The one function a button handler calls directly: the client's action handler, which both buttons
/// share (the handlers differ only in the action bits they pass).
fn action_core(image: &Image, handler: usize) -> Option<usize> {
    let end = image.function_end(handler)?;
    let mut targets = pe::callees(image, handler, end);
    targets.sort_unstable();
    targets.dedup();
    match targets.as_slice() {
        [single] => Some(*single),
        _ => None,
    }
}

/// The client instance's vtable: the `.rdata` table that holds the method referencing
/// [`CLIENT_SIGNATURE`], from the first entry of that run of code pointers the code takes the address of.
fn client_table(image: &Image) -> Option<usize> {
    let method = image.function_from_string(CLIENT_SIGNATURE)?;
    let rdata = image.section(".rdata")?;
    let words = pe::bytes(rdata.va, rdata.len & !7)?;
    let mut slot: Option<usize> = None;
    for (index, word) in words.chunks_exact(8).enumerate() {
        let value = usize::from_le_bytes([word[0], word[1], word[2], word[3], word[4], word[5], word[6], word[7]]);
        if value == method {
            if slot.is_some() {
                return None;
            }
            slot = Some(rdata.va + index * 8);
        }
    }
    let slot = slot?;
    let mut start = slot;
    while start >= rdata.va + 8 && slot - start < 0x2000 {
        if !pe::read::<usize>(start - 8).is_some_and(pe::in_image_code) {
            break;
        }
        start -= 8;
    }
    let candidates: Vec<usize> = (start..=slot).step_by(8).collect();
    let refs = pe::scan_refs(image, &candidates);
    candidates.iter().zip(refs.iter()).find(|(_, sites)| !sites.is_empty()).map(|(table, _)| *table)
}

/// `getLevel` among the client table's slots (it may fill more than one), when the attack handler
/// fetches the level through one of those slots — the cross-check that the table is the client's.
fn client_getter(table: usize, handler: usize) -> Option<usize> {
    let mut getter: Option<usize> = None;
    let mut slots: Vec<u32> = Vec::new();
    for index in 0..1024usize {
        let Some(entry) = pe::read::<usize>(table + index * 8) else {
            break;
        };
        if !pe::in_image_code(entry) {
            break;
        }
        if matches_at(entry, &LEVEL_GETTER) {
            if getter.is_some_and(|known| known != entry) {
                return None;
            }
            getter = Some(entry);
            slots.push((index * 8) as u32);
        }
    }
    let getter = getter?;
    let body = pe::bytes(handler, 0x100)?;
    let used = slots.iter().any(|slot| {
        let disp = slot.to_le_bytes();
        body.windows(7).any(|window| window[..3] == [0x48, 0x8B, 0x80] && window[3..] == disp)
    });
    used.then_some(getter)
}

/// Installs one hook of this module; the trampoline goes to `slot`. True when it installed.
fn install(core: &'static Core, name: &'static str, target: usize, replacement: usize, slot: &AtomicUsize) -> bool {
    match hook::install_published(target, replacement, slot) {
        Some(_) => {
            core.site(name, true);
            agent_core::log::fmt(format_args!("hook {name}: installed at 0x{target:x}"));
            true
        }
        None => {
            core.site(name, false);
            agent_core::log::fmt(format_args!("hook {name}: refused, game code untouched"));
            false
        }
    }
}

/// The client instance the handlers take, or `-32001 client.instance` saying why there is none.
fn require_client() -> Result<usize, RpcError> {
    client().ok_or_else(|| {
        RpcError::anchor(SITE_CLIENT).with_data(json!({
            "message": "the client instance is learnt from its own getLevel method, which has not run on a client yet",
            "hooked": CLIENT_TRAMPOLINE.load(Ordering::Acquire) != 0,
        }))
    })
}

/// One click of a button through its own handler, inside the client's item-registry scope, followed by
/// the release. `-32001` names what is missing. `scoped` = the handler builds item stacks and must not
/// run without the scope (use); otherwise the scope is opened when it resolved and skipped when it did
/// not.
fn click_button(handler: &AtomicUsize, table: &AtomicUsize, anchor: &'static str, scoped: bool) -> Result<(), RpcError> {
    let handler = handler.load(Ordering::Acquire);
    if handler == 0 {
        return Err(RpcError::anchor(anchor));
    }
    let client = require_client()?;
    let table = table.load(Ordering::Acquire);
    let pressed = if scoped || item_scope_resolved() {
        with_item_scope(|| press_button(handler, table, client))
    } else {
        press_button(handler, table, client);
        Ok(())
    };
    release_button(client);
    pressed
}

/* ------------------------------------------------------------------------------------------------
 * The release: the client's held-action state
 *
 * A gameplay handler leaves the client in a *held* state: after its action it stores the repeat code
 * (`0x11` for build/interact, `0xa` for attack) through `ClientInstance::setInteractionState`
 * (vtable `+0x9b0`, a heap `int` at the field its getter `+0x908` returns). A real button's release
 * clears it through the clearing method beside them (`+0x9b8`: free the `int`, store null). A click
 * the agent made never had a device release, so the client stayed "held": a screen that click opened
 * then ignored every key and click (live: a chest opened by `input.use` could not be closed, not even
 * by a real Escape). So each click is followed by that release.
 *
 * Recipe ([`resolve_release`]): the field offset is the one the getter returns
 * (`mov rax,[rcx+FIELD]; ret`) at a slot the attack handler calls (`mov rax,[rax+SLOT]`); the release
 * is the one client vtable entry that frees exactly that field:
 * `mov rax,rcx; mov rcx,[rcx+FIELD]; test rcx,rcx; je; mov qword [rax+FIELD],0; mov edx,4; jmp`.
 * ---------------------------------------------------------------------------------------------- */

/// The client's release method (the vtable entry itself). 0 = not resolved.
static RELEASE: AtomicUsize = AtomicUsize::new(0);
/// `engine.status` anchor name of the release.
const SITE_RELEASE: &str = "input.release_state";

/// Clears the client's held-action state, as a button release does. Nothing when unresolved.
fn release_button(client: usize) {
    let release = RELEASE.load(Ordering::Acquire);
    if release == 0 {
        return;
    }
    // SAFETY: the client's own one-argument release method (validated at attach by its exact body),
    // with `this` = the client instance whose vtable was checked by `client()`.
    unsafe { transmute::<usize, extern "C" fn(usize)>(release)(client) }
}

/// `mov rax, [rcx+FIELD]; ret`: the held-state getter; the field offset.
fn state_getter_field(entry: usize) -> Option<u32> {
    let bytes = pe::bytes(entry, 8)?;
    (bytes[..3] == [0x48, 0x8B, 0x81] && bytes[7] == 0xC3).then(|| u32::from_le_bytes([bytes[3], bytes[4], bytes[5], bytes[6]]))
}

/// True when `entry` is exactly the release of `field` (see the section comment).
fn is_release_of(entry: usize, field: u32) -> bool {
    let Some(bytes) = pe::bytes(entry, 0x20) else {
        return false;
    };
    let f = field.to_le_bytes();
    bytes[..3] == [0x48, 0x89, 0xC8]
        && bytes[3..6] == [0x48, 0x8B, 0x89]
        && bytes[6..10] == f
        && bytes[10..13] == [0x48, 0x85, 0xC9]
        && bytes[13] == 0x74
        && bytes[15..18] == [0x48, 0xC7, 0x80]
        && bytes[18..22] == f
        && bytes[22..26] == [0, 0, 0, 0]
        && bytes[26..31] == [0xBA, 0x04, 0x00, 0x00, 0x00]
        && bytes[31] == 0xE9
}

/// The release method, from the client vtable and the attack handler (see the section comment).
fn resolve_release(table: usize, handler: usize) -> Option<usize> {
    let body = pe::bytes(handler, 0x100)?;
    let entry_at = |slot: usize| pe::read::<usize>(table + slot).filter(|entry| pe::in_image_code(*entry));
    // Every `mov rax,[rax+SLOT]` in the handler whose slot holds the held-state getter.
    let mut field: Option<u32> = None;
    for window in body.windows(7) {
        if window[..3] != [0x48, 0x8B, 0x80] {
            continue;
        }
        let slot = u32::from_le_bytes([window[3], window[4], window[5], window[6]]) as usize;
        if slot % 8 != 0 || slot >= 0x2000 {
            continue;
        }
        let Some(found) = entry_at(slot).and_then(state_getter_field) else {
            continue;
        };
        if field.is_some_and(|known| known != found) {
            return None;
        }
        field = Some(found);
    }
    let field = field?;
    let mut release: Option<usize> = None;
    for index in 0..1024usize {
        let Some(entry) = pe::read::<usize>(table + index * 8) else {
            break;
        };
        if !pe::in_image_code(entry) {
            break;
        }
        if is_release_of(entry, field) {
            if release.is_some_and(|known| known != entry) {
                return None;
            }
            release = Some(entry);
        }
    }
    release
}

/// One use click (`button.build_or_interact`) through the client's own handler: what a right click
/// does to whatever the crosshair is on now. Used by `interact.*` once its aim has reached the game.
pub(crate) fn use_click() -> Result<(), RpcError> {
    release_use();
    click_button(&USE_HANDLER, &USE_TABLE, "input.use", true)
}

/* ------------------------------------------------------------------------------------------------
 * The client's item-registry scope
 *
 * Building an `ItemStack` (what the use path does for the item in hand, and what a screen's preview
 * does) looks the item up through a thread-local `weak_ptr` to the item registry, and asserts —
 * a `mov [0], 0xdeadc0de` — when that pointer is empty. The game's own client code
 * sets it around such work with a scope object: it asks the client instance for its registry
 * reference (a `ClientInstance` virtual), constructs the scope with it (which installs it in the
 * thread-local slot and remembers the previous one) and destroys the scope afterwards (which puts
 * the previous one back). The agent's drain runs outside every such scope, so it opens one the same
 * way around the handlers that need it.
 *
 * Recipe ([`resolve_item_scope`]): among the client vtable's methods, the ones that start with
 * `mov rax,[rcx]; mov rax,[rax+SLOT]` (the getter call), then call ENTER with `lea rcx,[rbp+X]`, and
 * later call LEAVE with the same `lea rcx,[rbp+X]`. ENTER is accepted only when it tests the scope's
 * active byte (`cmp byte [rcx],0`) and reads the thread-local block (`gs:[0x58]`), LEAVE when it tests
 * `cmp byte [rcx],1` and reads the same block. At least two methods must agree on all three.
 * ---------------------------------------------------------------------------------------------- */

/// The getter's vtable offset, and the scope's constructor and destructor. 0 = not resolved.
static SCOPE_SLOT: AtomicUsize = AtomicUsize::new(0);
static SCOPE_ENTER: AtomicUsize = AtomicUsize::new(0);
static SCOPE_LEAVE: AtomicUsize = AtomicUsize::new(0);
/// `engine.status` anchor name of the scope recipe.
const SITE_SCOPE: &str = "input.item_scope";
/// The scope object: an active byte, then the previous registry `weak_ptr` (object, control block).
const SCOPE_WORDS: usize = 4;
/// `mov r64, gs:[0x58]` (the TEB's thread-local storage pointer), any register.
const TLS_POINTER: [Option<u8>; 9] = [Some(0x65), Some(0x48), Some(0x8B), None, Some(0x25), Some(0x58), Some(0x00), Some(0x00), Some(0x00)];

fn item_scope_resolved() -> bool {
    SCOPE_SLOT.load(Ordering::Acquire) != 0 && SCOPE_ENTER.load(Ordering::Acquire) != 0 && SCOPE_LEAVE.load(Ordering::Acquire) != 0
}

/// True when `pattern` occurs in the first `len` bytes at `address`.
fn pattern_in(address: usize, len: usize, pattern: &[Option<u8>]) -> bool {
    let Some(bytes) = pe::bytes(address, len) else {
        return false;
    };
    bytes.windows(pattern.len()).any(|window| window.iter().zip(pattern).all(|(byte, want)| want.is_none_or(|want| want == *byte)))
}

/// The scope constructor's shape: it returns early when the scope is already active and reads the
/// thread-local block.
fn scope_enter_shape(function: usize) -> bool {
    pattern_in(function, 0x20, &[Some(0x80), Some(0x39), Some(0x00)]) && pattern_in(function, 0x40, &TLS_POINTER)
}

/// The scope destructor's shape: it only acts on an active scope and reads the thread-local block.
fn scope_leave_shape(function: usize) -> bool {
    pattern_in(function, 0x10, &[Some(0x80), Some(0x39), Some(0x01)]) && pattern_in(function, 0x40, &TLS_POINTER)
}

/// `lea rcx,[rbp+disp]` (disp8 or disp32) ending exactly at `end`: the displacement.
fn lea_rcx_rbp_before(bytes: &[u8], end: usize) -> Option<i32> {
    if end >= 4 && bytes[end - 4..end - 1] == [0x48, 0x8D, 0x4D] {
        return Some(bytes[end - 1] as i8 as i32);
    }
    if end >= 7 && bytes[end - 7..end - 4] == [0x48, 0x8D, 0x8D] {
        return Some(i32::from_le_bytes([bytes[end - 4], bytes[end - 3], bytes[end - 2], bytes[end - 1]]));
    }
    None
}

/// The last `lea rcx,[rbp+disp]` that ends within `window` bytes before `end`.
fn lea_rcx_rbp_near(bytes: &[u8], end: usize, window: usize) -> Option<i32> {
    (end.saturating_sub(window)..=end).rev().find_map(|at| lea_rcx_rbp_before(bytes, at))
}

/// `call rel32` at `at` in `bytes` (which starts at `base`): the target.
fn call_target(bytes: &[u8], base: usize, at: usize) -> Option<usize> {
    if at + 5 > bytes.len() || bytes[at] != 0xE8 {
        return None;
    }
    let relative = i32::from_le_bytes([bytes[at + 1], bytes[at + 2], bytes[at + 3], bytes[at + 4]]) as isize;
    let target = (base + at + 5).wrapping_add_signed(relative);
    pe::in_image_code(target).then_some(target)
}

/// One client method that opens the scope: `(slot, enter, leave)`.
fn scope_user(image: &Image, method: usize) -> Option<(usize, usize, usize)> {
    let end = image.function_end(method)?;
    let bytes = pe::bytes(method, end.checked_sub(method)?.min(0x2000))?;
    let getter = (0..bytes.len().min(0x60).saturating_sub(10)).find(|at| bytes[*at..*at + 6] == [0x48, 0x8B, 0x01, 0x48, 0x8B, 0x80])?;
    let slot = u32::from_le_bytes([bytes[getter + 6], bytes[getter + 7], bytes[getter + 8], bytes[getter + 9]]) as usize;
    if slot == 0 || slot % 8 != 0 || slot >= 0x2000 {
        return None;
    }
    let after = getter + 10;
    let (enter_at, enter) = (after..(after + 0x80).min(bytes.len()))
        .find_map(|at| call_target(bytes, method, at).filter(|target| scope_enter_shape(*target)).map(|target| (at, target)))?;
    let frame = lea_rcx_rbp_near(bytes, enter_at, 0x18)?;
    let leave = (enter_at + 5..bytes.len()).find_map(|at| {
        if lea_rcx_rbp_before(bytes, at) != Some(frame) {
            return None;
        }
        call_target(bytes, method, at).filter(|target| *target != enter && scope_leave_shape(*target))
    })?;
    Some((slot, enter, leave))
}

/// The scope recipe over the client vtable (see the section comment).
fn resolve_item_scope(image: &Image, table: usize) -> Option<(usize, usize, usize)> {
    let mut found: Option<(usize, usize, usize)> = None;
    let mut agreeing = 0usize;
    let mut seen: Vec<usize> = Vec::new();
    for index in 0..1024usize {
        let Some(entry) = pe::read::<usize>(table + index * 8) else {
            break;
        };
        if !pe::in_image_code(entry) {
            break;
        }
        if seen.contains(&entry) {
            continue;
        }
        seen.push(entry);
        let Some(user) = scope_user(image, entry) else {
            continue;
        };
        if found.is_some_and(|known| known != user) {
            return None;
        }
        found = Some(user);
        agreeing += 1;
    }
    (agreeing >= 2).then_some(found?)
}

/// One item-registry scope the agent opened and has not closed yet. The scope object lives on the heap,
/// not in the opener's frame, because the game may throw a C++ exception through a handler and catch it
/// in its own frame: the opener's frame is then gone without its `~Scope()` having run, and the object
/// must still be there for the agent to close it later.
struct OpenScope {
    object: Box<[usize; SCOPE_WORDS]>,
    thread: u32,
    /// The stack address of the opener's frame. A live opener sits above (at a higher address than)
    /// every frame that runs inside it.
    frame: usize,
}

/// Every scope opened and not closed yet, oldest first.
static OPEN_SCOPES: SpinLock<Vec<OpenScope>> = SpinLock::new(Vec::new());

/// Closes, newest first, every scope on this thread whose opener is no longer on the stack: opened at
/// `frame` or deeper. `usize::MAX` closes all of this thread's scopes, which is right wherever no
/// handler can be running (the engine's per-frame work, after the queue).
pub(crate) fn close_abandoned_scopes(frame: usize) {
    let thread = win::current_thread_id();
    loop {
        let abandoned = {
            let mut open = OPEN_SCOPES.lock();
            match open.iter().rposition(|scope| scope.thread == thread && scope.frame <= frame) {
                Some(index) => open.remove(index),
                None => break,
            }
        };
        let mut object = abandoned.object;
        log::fmt(format_args!(
            "input.item_scope: closing a scope its handler never closed (opened at stack 0x{:x}; the game unwound past it)",
            abandoned.frame
        ));
        // SAFETY: the matching destructor on the scope object the constructor filled, on the thread
        // that opened it; it restores the registry that was current before.
        unsafe { transmute::<usize, extern "C" fn(*mut usize)>(SCOPE_LEAVE.load(Ordering::Acquire))(object.as_mut_ptr()) };
    }
}

/// Runs `run` inside the client's own item-registry scope, on this thread, exactly as the client's
/// methods do: `client->getItemRegistry(&ref)`, `Scope scope(ref)`, work, `~Scope()`.
///
/// Refused (`-32001 input.item_scope`) when the recipe did not resolve, when the client has no live
/// registry, or when the thread-local slot does not read back as live after the scope opened. A scope
/// an earlier call left open because the game unwound past it is closed first.
pub(crate) fn with_item_scope<R>(run: impl FnOnce() -> R) -> Result<R, RpcError> {
    if !item_scope_resolved() {
        return Err(RpcError::anchor(SITE_SCOPE));
    }
    let marker = 0u8;
    let frame = core::hint::black_box(&marker) as *const u8 as usize;
    close_abandoned_scopes(frame);
    let client = require_client()?;
    let refuse = |message: &str| RpcError::anchor(SITE_SCOPE).with_data(json!({ "message": message }));
    let vtable = pe::read::<usize>(client).ok_or_else(|| refuse("the client instance is not readable"))?;
    let getter = pe::read::<usize>(vtable + SCOPE_SLOT.load(Ordering::Acquire)).filter(|getter| pe::in_image_code(*getter));
    let getter = getter.ok_or_else(|| refuse("the client's item-registry getter slot is not code"))?;
    let mut reference: [usize; 2] = [0, 0];
    // SAFETY: the client's own virtual, at the slot its own methods call, with `this` = the client
    // (validated by its vtable) and a 16-byte out slot, as those methods pass `lea rdx,[rbp+…]`.
    unsafe { transmute::<usize, extern "C" fn(usize, *mut usize) -> usize>(getter)(client, reference.as_mut_ptr()) };
    let alive = reference[0] != 0 && reference[1] != 0 && pe::read::<u32>(reference[1] + CONTROL_USES).is_some_and(|uses| uses != 0);
    if !alive {
        // The weak count the getter took stays with the control block; the block outlives it.
        return Err(refuse("the client has no live item registry right now"));
    }
    let mut object: Box<[usize; SCOPE_WORDS]> = Box::new([0; SCOPE_WORDS]);
    let pointer = object.as_mut_ptr();
    let enter = SCOPE_ENTER.load(Ordering::Acquire);
    let leave = SCOPE_LEAVE.load(Ordering::Acquire);
    // SAFETY: the game's own scope constructor with an inactive (zeroed) scope object and the reference
    // the getter produced, which it consumes — what the client's methods pass.
    unsafe { transmute::<usize, extern "C" fn(*mut usize, *mut usize)>(enter)(pointer, reference.as_mut_ptr()) };
    OPEN_SCOPES.lock().push(OpenScope { object, thread: win::current_thread_id(), frame });
    let result = if registry_slot_live() != Some(false) {
        Ok(run())
    } else {
        Err(refuse("the thread-local item registry is still empty after the scope opened"))
    };
    // `run` returned, so this scope is still listed (only an opener's own frame closes it early).
    let mine = {
        let mut open = OPEN_SCOPES.lock();
        open.iter().rposition(|scope| scope.object.as_ptr() == pointer as *const usize).map(|index| open.remove(index))
    };
    if let Some(mut scope) = mine {
        // SAFETY: the matching destructor on the same scope object: restores the previous registry.
        unsafe { transmute::<usize, extern "C" fn(*mut usize)>(leave)(scope.object.as_mut_ptr()) };
    }
    result
}

/// The static holding the game's thread-local block index, read by every function that reaches the
/// thread's item registry (`[[gs:0x58][index] + 0xce8/+0xcf0]`, a `weak_ptr`). 0 until resolved.
static REGISTRY_TLS_INDEX: AtomicUsize = AtomicUsize::new(0);
/// The `weak_ptr` (`+0xce8` object, `+0xcf0` control block) in the thread-local block, and the
/// control block's use count.
const REGISTRY_OBJECT: usize = 0xCE8;
const REGISTRY_CONTROL: usize = 0xCF0;
const CONTROL_USES: usize = 0x08;
/// `mov eax, [rip+INDEX]; mov rcx, gs:[0x58]; mov rax, [rcx+rax*8]; mov rcx, [rax+0xcf0]`.
const REGISTRY_READ: [Option<u8>; 23] = {
    const W: Option<u8> = None;
    [
        Some(0x8B), Some(0x05), W, W, W, W, Some(0x65), Some(0x48), Some(0x8B), Some(0x0C), Some(0x25), Some(0x58),
        Some(0x00), Some(0x00), Some(0x00), Some(0x48), Some(0x8B), Some(0x04), Some(0xC1), Some(0x48), Some(0x8B),
        Some(0x88), Some(0xF0),
    ]
};

/// The thread-local index static, from the code that reads the registry slot: every match must name
/// the same static (1.26.63.1: 76 sites, one static), or the recipe refuses.
fn resolve_registry_tls(image: &Image) -> Option<usize> {
    let code = pe::code(image)?;
    let bytes = code.bytes;
    let mut found: Option<usize> = None;
    let mut sites = 0usize;
    let mut offset = 0usize;
    while offset + REGISTRY_READ.len() + 2 <= bytes.len() {
        let window = &bytes[offset..offset + REGISTRY_READ.len()];
        if window.iter().zip(REGISTRY_READ.iter()).all(|(byte, want)| want.is_none_or(|want| want == *byte))
            && bytes[offset + REGISTRY_READ.len()..offset + REGISTRY_READ.len() + 2] == [0x0C, 0x00]
        {
            let relative = i32::from_le_bytes([window[2], window[3], window[4], window[5]]) as i64;
            let target = (code.va as i64 + offset as i64 + 6 + relative) as usize;
            if found.is_some_and(|other| other != target) || !pe::in_image_data(target) {
                return None;
            }
            found = Some(target);
            sites += 1;
        }
        offset += 1;
    }
    (sites >= 2).then_some(found?)
}

/// Whether this thread's item-registry slot holds a live registry: `None` when the index static did
/// not resolve (nothing to check), `Some(false)` when the slot is empty or expired.
fn registry_slot_live() -> Option<bool> {
    let index_static = REGISTRY_TLS_INDEX.load(Ordering::Acquire);
    if index_static == 0 {
        return None;
    }
    let tls: usize;
    // SAFETY: `gs:[0x58]` is this thread's TEB `ThreadLocalStoragePointer`.
    unsafe { core::arch::asm!("mov {}, gs:[0x58]", out(reg) tls, options(nostack, readonly, preserves_flags)) };
    let live = (|| {
        let index = pe::read::<u32>(index_static)? as usize;
        let block = pe::read::<usize>(tls.checked_add(index * 8)?)?;
        let object = pe::read::<usize>(block + REGISTRY_OBJECT)?;
        let control = pe::read::<usize>(block + REGISTRY_CONTROL)?;
        let uses = pe::read::<u32>(control.checked_add(CONTROL_USES)?)?;
        Some(object != 0 && control != 0 && uses != 0)
    })()
    .unwrap_or(false);
    Some(live)
}

/* ------------------------------------------------------------------------------------------------
 * The methods
 * ---------------------------------------------------------------------------------------------- */

/// `input.move {forward, strafe, jump, sneak, sprint}` → `{keys, held, route}`.
///
/// The parameters are the *whole* movement hold, not a delta: a field that is absent or false is not
/// held, so an empty call releases the movement (an `input.use {hold: true}` button is left to
/// `input.use`/`input.release`). The axes become the game's direction bits at the threshold the core
/// uses for [`Movement::bits`](agent_core::hub::Movement) and its analog vector at their exact value;
/// the hold is applied to the game's move-input state every client tick until [`HOLD_MS`] after this
/// call (see the module documentation).
pub fn h_input_move(_core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    world()?;
    expire();
    let movement = Movement {
        forward: axis(params, "forward")?,
        strafe: axis(params, "strafe")?,
        jump: flag(params, "jump")?,
        sneak: flag(params, "sneak")?,
        sprint: flag(params, "sprint")?,
    };
    if MOVE_TRAMPOLINE.load(Ordering::Acquire) == 0 {
        return Err(RpcError::anchor(SITE_MOVE).with_data(json!({
            "message": "the game's input-lock function (where the client's move-input state is applied) is not hooked on this build",
        })));
    }
    let (bits, x, y) = movement_state(&movement);
    if bits == 0 && x == 0.0 && y == 0.0 {
        let released = clear_movement();
        return Ok(json!({ "keys": [], "released": state_names(released) }));
    }
    MOVE_BITS.store(bits, Ordering::Release);
    MOVE_X.store(x.to_bits(), Ordering::Release);
    MOVE_Y.store(y.to_bits(), Ordering::Release);
    MOVE_STAMP.store(win::tick_ms().max(1), Ordering::Release);
    Ok(json!({
        "keys": state_names(bits),
        "held": {
            "forward": movement.forward,
            "strafe": movement.strafe,
            "jump": movement.jump,
            "sneak": movement.sneak,
            "sprint": movement.sprint,
        },
        "route": "move-input",
    }))
}

/// `input.release` → `{released: [key]}`.
///
/// Never gated on a world: this is the call that takes input *off* the game, and it has to work while
/// the world is unloading, which is exactly when a stuck hold would be worst.
pub fn h_input_release(_core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    let mut released = state_names(clear_movement());
    for held in HELD {
        if release_held(held) {
            released.push(Value::String(String::from(held.name)));
        }
    }
    Ok(json!({ "released": released }))
}

/// `input.look {pitch, yaw}` → `{pitch, yaw, route, cameras}` once the view is written.
///
/// The client's player rotation is not where the view lives: every frame the active camera's
/// orientation is built from its own components, and the player's `ActorRotationComponent` is set
/// from the camera — so a write to the rotation alone is undone on the next frame (live: `[30, 0]`
/// written, `[8.84, -0.03]` read 2 s later). The view is therefore written into the camera the player
/// follows ([`write_camera_look`]) and into the player's rotation for an immediate read-back. `pitch`
/// is the number `player.state.rotation` reports (+ looks down).
pub fn h_input_look(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let pitch = number(params, "pitch")?;
    let yaw = number(params, "yaw")?;
    if !(-90.0..=90.0).contains(&pitch) {
        return Err(RpcError::invalid_params("pitch must be -90..90"));
    }
    world()?;
    let pitch = pitch as f32;
    let yaw = look::wrap_degrees(yaw as f32);
    let Some(accessor) = registry() else {
        // No registry: the tick route is the only one left (it writes and confirms on the next tick).
        return live::request_look(core, pitch, yaw);
    };
    let reading = ecs::read(accessor).ok_or_else(RpcError::not_in_world)?;
    let current = reading.read_look().ok_or_else(|| RpcError::anchor("component.getter"))?;
    let cameras = write_camera_look(accessor, current, pitch, yaw)?;
    if !reading.write_look(pitch, yaw) {
        return Err(RpcError::anchor("component.getter"));
    }
    Ok(json!({ "pitch": pitch, "yaw": yaw, "route": "camera", "cameras": cameras }))
}

/// `MinecraftCamera::CameraDirectLookComponent`: element stride `0x14` (the direct-look system's own
/// `(index & 0x7f) * 0x14`), `+0x00` yaw and `+0x04` pitch in radians, `+0x08` the pending yaw turn
/// the system adds to `+0x00` and clears. The system builds the camera quaternion as
/// `Ry(+0x00) · Rx(+0x04)`.
const DIRECT_LOOK: &str = "MinecraftCamera::CameraDirectLookComponent";
const DIRECT_LOOK_STRIDE: usize = 0x14;
const DIRECT_LOOK_YAW: usize = 0x00;
const DIRECT_LOOK_PITCH: usize = 0x04;
const DIRECT_LOOK_TURN: usize = 0x08;
/// `MinecraftCamera::CameraOrbitComponent`, the third-person cameras' view: element stride `0x4c`
/// (`imul …, 0x4c` at its lookups). The game's own "point the camera along a view vector" writes the
/// spherical offset `(radius, azimuth, polar)` twice, at `+0x24` (current) and `+0x30` (target), and
/// its look input turns the target azimuth `+0x34`; with the presets' zero smoothing springs the
/// current follows the target at once. Both pairs of angles are written, the radius is left alone.
const ORBIT: &str = "MinecraftCamera::CameraOrbitComponent";
const ORBIT_STRIDE: usize = 0x4c;
const ORBIT_ANGLES: [usize; 2] = [0x28, 0x34];
const ORBIT_POLAR_AFTER_AZIMUTH: usize = 0x04;
/// `VanillaCamera::UpdatePlayerFromCameraComponent`: a camera the player's rotation follows. Element
/// stride 4, the look mode as a `u32` (see [`look::LookMode`]).
const UPDATE_PLAYER: &str = "VanillaCamera::UpdatePlayerFromCameraComponent";
const UPDATE_PLAYER_STRIDE: usize = 0x04;
/// `MinecraftCamera::ActiveCameraComponent`: the flag on the camera the client renders through (the
/// game's own active-orbit views join it with `CameraOrbitComponent`).
const ACTIVE_CAMERA: &str = "MinecraftCamera::ActiveCameraComponent";
/// Cameras a client holds: a handful (first person, third person, …).
const MAX_CAMERAS: usize = 64;

/// The storage's entity ids, when its vector is readable and holds a camera-sized count.
fn camera_entities(storage: usize) -> Option<Vec<u32>> {
    let begin = pe::read::<usize>(storage + ENTITY_BEGIN)?;
    let end = pe::read::<usize>(storage + ENTITY_END)?;
    if begin == 0 || end < begin || (end - begin) / 4 > MAX_CAMERAS {
        return None;
    }
    Some((begin..end).step_by(4).filter_map(pe::read::<u32>).collect())
}

/// Writes the view into every camera the player follows; the number of cameras written.
///
/// - **Direct look** (first person): each camera whose pair is the player's current rotation under
///   one of [`look::LOOK_MAPPINGS`], with its pending turn cleared.
/// - **Orbit** (third person, back and front view): each *active* orbit camera the player's rotation
///   follows (`UpdatePlayerFromCameraComponent` with a look mode the game's own code handles), by
///   [`look::orbit_angles`]. A direct-look pair cannot be matched in third person: the first-person
///   camera keeps the pair it had when the view switched while the player turns with the orbit.
///
/// Storages are looked up in the registry's own node array (never created), and every element is
/// read and range-checked before it is written. `-32001 camera.view` when the registry holds neither
/// storage, or when no camera the player follows was found (with what was seen).
pub(crate) fn write_camera_look(accessor: usize, player: [f32; 2], pitch: f32, yaw: f32) -> Result<usize, RpcError> {
    let missing = |data: Value| RpcError::anchor("camera.view").with_data(data);
    let tree = tree(accessor).ok_or_else(|| missing(json!({ "message": "the client registry's node array is not readable" })))?;
    let direct = storage_of(tree, hash(DIRECT_LOOK));
    let orbit = storage_of(tree, hash(ORBIT));
    if direct.is_none() && orbit.is_none() {
        return Err(missing(json!({ "message": "the client registry holds no camera direct-look or orbit storage" })));
    }
    let mut direct_seen: Vec<Value> = Vec::new();
    let mut orbit_seen: Vec<Value> = Vec::new();
    let mut written = 0usize;
    if let Some(storage) = direct {
        written += write_direct_looks(storage, player, pitch, yaw, &mut direct_seen);
    }
    if let Some(storage) = orbit {
        let update = storage_of(tree, hash(UPDATE_PLAYER));
        let active = storage_of(tree, hash(ACTIVE_CAMERA));
        written += write_orbits(storage, update, active, pitch, yaw, &mut orbit_seen);
    }
    if written == 0 {
        return Err(missing(json!({
            "message": "no camera the player follows: no direct-look pair matches the player's rotation and no active orbit camera updates the player",
            "player": [player[0], player[1]],
            "directLook": direct_seen,
            "orbit": orbit_seen,
        })));
    }
    Ok(written)
}

/// The direct-look half of [`write_camera_look`]: the cameras written; every pair read goes to `seen`.
fn write_direct_looks(storage: usize, player: [f32; 2], pitch: f32, yaw: f32, seen: &mut Vec<Value>) -> usize {
    let Some(entities) = camera_entities(storage) else {
        seen.push(Value::String(String::from("unreadable")));
        return 0;
    };
    let mut written = 0usize;
    for entity in entities {
        let Some(element) = ecs::element(storage, entity, DIRECT_LOOK_STRIDE) else {
            continue;
        };
        let (Some(camera_yaw), Some(camera_pitch)) =
            (pe::read::<f32>(element + DIRECT_LOOK_YAW), pe::read::<f32>(element + DIRECT_LOOK_PITCH))
        else {
            continue;
        };
        if !camera_yaw.is_finite() || !camera_pitch.is_finite() {
            continue;
        }
        seen.push(json!([camera_yaw, camera_pitch]));
        let Some(mapping) = look::look_mapping([camera_yaw, camera_pitch], player) else {
            continue;
        };
        if !pe::writable(element, DIRECT_LOOK_TURN + 4) {
            continue;
        }
        let [new_yaw, new_pitch] = look::direct_look_pair(mapping, pitch, yaw);
        // SAFETY: `element` is this camera's direct-look element (the storage's own entity walk, stride
        // checked by the finite pair just read) and its 12 bytes were checked writable.
        unsafe {
            core::ptr::write_unaligned((element + DIRECT_LOOK_TURN) as *mut f32, 0.0);
            core::ptr::write_unaligned((element + DIRECT_LOOK_PITCH) as *mut f32, new_pitch);
            core::ptr::write_unaligned((element + DIRECT_LOOK_YAW) as *mut f32, new_yaw);
        }
        written += 1;
    }
    written
}

/// The orbit half of [`write_camera_look`]: the cameras written; every orbit camera read goes to
/// `seen` as `{azimuth, polar, active, lookMode}` (angles in radians, `lookMode` `null` when the
/// player does not follow it).
fn write_orbits(
    storage: usize,
    update: Option<usize>,
    active: Option<usize>,
    pitch: f32,
    yaw: f32,
    seen: &mut Vec<Value>,
) -> usize {
    let (Some(update), Some(active)) = (update, active) else {
        seen.push(Value::String(String::from(if update.is_none() {
            "no update-player-from-camera storage"
        } else {
            "no active-camera storage"
        })));
        return 0;
    };
    let Some(entities) = camera_entities(storage) else {
        seen.push(Value::String(String::from("unreadable")));
        return 0;
    };
    let mut written = 0usize;
    for entity in entities {
        let Some(element) = ecs::element(storage, entity, ORBIT_STRIDE) else {
            continue;
        };
        let [current, target] = ORBIT_ANGLES;
        let read = |at: usize| Some([pe::read::<f32>(element + at)?, pe::read::<f32>(element + at + ORBIT_POLAR_AFTER_AZIMUTH)?]);
        let (Some([azimuth, polar]), Some([target_azimuth, target_polar])) = (read(current), read(target)) else {
            continue;
        };
        if !look::orbit_plausible(azimuth, polar) || !look::orbit_plausible(target_azimuth, target_polar) {
            continue;
        }
        let is_active = ecs::contains(active, entity);
        let mode = ecs::element(update, entity, UPDATE_PLAYER_STRIDE)
            .and_then(pe::read::<u32>)
            .and_then(look::LookMode::from_raw);
        seen.push(json!({
            "azimuth": azimuth,
            "polar": polar,
            "active": is_active,
            "lookMode": mode.map(look::LookMode::name),
        }));
        let Some(mode) = mode else {
            continue;
        };
        if !is_active || !pe::writable(element + current, target + 8 - current) {
            continue;
        }
        let [new_azimuth, new_polar] = look::orbit_angles(mode, pitch, yaw);
        // SAFETY: `element` is this camera's orbit element (the storage's own entity walk, its angle
        // pairs read and range-checked above), and the bytes from the current to the target pair were
        // checked writable.
        unsafe {
            for at in ORBIT_ANGLES {
                core::ptr::write_unaligned((element + at) as *mut f32, new_azimuth);
                core::ptr::write_unaligned((element + at + ORBIT_POLAR_AFTER_AZIMUTH) as *mut f32, new_polar);
            }
        }
        written += 1;
    }
    written
}

/// The block the crosshair is on now (the game's own pick against the block's real shape), or `None`
/// when it is on an entity, on nothing, or the pick cannot be read.
pub(crate) fn crosshair_block() -> Option<[i32; 3]> {
    match Player::open()?.crosshair()? {
        Crosshair::Block { block, .. } => Some(block),
        Crosshair::Entity { .. } => None,
    }
}

/// What the crosshair was on when a click ran.
enum Crosshair {
    Block { block: [i32; 3], face: u8, position: Option<[f32; 3]> },
    Entity { id: u64, kind: Option<String>, position: Option<[f32; 3]> },
}

impl Crosshair {
    /// `{kind: "block", block, face, position}` or `{kind: "entity", id, type, position}`. The id is the
    /// Script API's own form of an actor id: a signed decimal string (an int64 is not a JSON number a
    /// reader can keep exactly).
    fn json(&self) -> Value {
        let position = |p: &Option<[f32; 3]>| p.map_or(Value::Null, |p| json!([p[0], p[1], p[2]]));
        match self {
            Self::Block { block, face, position: at } => json!({
                "kind": "block",
                "block": [block[0], block[1], block[2]],
                "face": FACES.get(usize::from(*face)).copied(),
                "position": position(at),
            }),
            Self::Entity { id, kind, position: at } => json!({
                "kind": "entity",
                "id": alloc::format!("{}", *id as i64),
                "type": kind,
                "position": position(at),
            }),
        }
    }

    /// The struck entity's id, the `hit` field older clients read.
    fn entity_id(&self) -> Value {
        match self {
            Self::Entity { id, .. } => Value::from(alloc::format!("{}", *id as i64)),
            Self::Block { .. } => Value::Null,
        }
    }
}

/// The game's face order (`FacingID`).
const FACES: [&str; 6] = ["down", "up", "north", "south", "west", "east"];

/// The crosshair target now, before a click changes it.
fn crosshair_now() -> Option<Crosshair> {
    Player::open().and_then(|player| player.crosshair())
}

/// `input.attack {hold?}` → `{hit, target, route}` (`{held, target, route}` with `hold`): one left click
/// through the client's own `button.destroy_or_attack` handler, or the held left button (`hold: true`,
/// renewed by repeating it) that keeps breaking the block under the crosshair until an
/// `input.attack {hold: false}`, an `input.release`, or [`HOLD_MS`] of silence. `target` is what the
/// crosshair was on when it ran (a block with its face, or an entity with its id and type; `null` when
/// nothing in reach or nothing validated), and `hit` the struck entity's id alone.
pub fn h_input_attack(_core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    world()?;
    expire();
    let target = crosshair_now();
    let json_target = target.as_ref().map_or(Value::Null, Crosshair::json);
    match params.get("hold") {
        None => {
            // A click ends a hold first, so the held state cannot outlive it.
            release_held(&ATTACK);
            click_button(&ATTACK_HANDLER, &ATTACK_TABLE, "input.attack", false)?;
            Ok(json!({ "hit": target.as_ref().map_or(Value::Null, Crosshair::entity_id), "target": json_target, "route": "action" }))
        }
        Some(_) => held_button(&ATTACK, flag(params, "hold")?, json_target),
    }
}

/// `input.use {hold?}` → `{held, target, route}`: one right click through the client's own
/// `button.build_or_interact` handler, or the held right button (`hold: true`, renewed by repeating it)
/// that lasts until an `input.use {hold: false}`, an `input.release`, or [`HOLD_MS`] of silence. The
/// button is its own domain — `input.move` restates the movement and leaves it alone. `target` is the
/// crosshair's target when the click (or the hold) began, as `input.attack` reports it.
pub fn h_input_use(_core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    world()?;
    expire();
    let target = crosshair_now().as_ref().map_or(Value::Null, Crosshair::json);
    match params.get("hold") {
        None => {
            // A click ends a hold first, so the held state cannot outlive it.
            use_click()?;
            Ok(json!({ "held": false, "target": target, "route": "action" }))
        }
        Some(_) => held_button(&USE, flag(params, "hold")?, target),
    }
}

/// `hold: true` presses (or renews) the held button, `hold: false` lets it go.
fn held_button(held: &Held, down: bool, target: Value) -> Result<Value, RpcError> {
    if !down {
        let released = release_held(held);
        return Ok(json!({ "held": false, "released": released, "target": target, "route": hold_route() }));
    }
    let window = window().ok_or_else(|| RpcError::anchor("window.game"))?;
    held.hold(window);
    Ok(json!({ "held": true, "target": target, "route": hold_route() }))
}

/// `player.state` → `{position, rotation, delta, simTick, dimension, health, selectedSlot, onGround}`
/// plus the raw `dimensionState` dword.
///
/// The components are read first (they answer without the client tick), and [`crate::live`]'s
/// snapshot fills in whatever the registry could not: `simTick` is the local server's tick, which only
/// `live` counts. A field neither source can read is `null`, never a guess — `dimension` is one of
/// them: the raw `DimensionStateComponent` dword is reported as `dimensionState` and left unmapped,
/// because the id ↔ dimension table is not decoded in this build.
pub fn h_player_state(_core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    let mut out = live::player_state().ok_or_else(RpcError::not_in_world)?;
    set(&mut out, "health", Value::Null);
    set(&mut out, "selectedSlot", Value::Null);
    set(&mut out, "dimensionState", Value::Null);
    let Some(player) = Player::open() else {
        return Ok(out);
    };
    let sample = player.reading.sample;
    // The feet, as the tick stream publishes them; null when the collision box did not check out.
    set(&mut out, "position", sample.feet.map_or(Value::Null, |feet| floats(&feet)));
    set(&mut out, "delta", floats(&sample.velocity));
    if let Some(rotation) = sample.rotation {
        set(&mut out, "rotation", floats(&rotation));
    }
    set(&mut out, "onGround", sample.on_ground.map(Value::Bool).unwrap_or(Value::Null));
    set(&mut out, "health", player.health().map(|value| number_or_null(value)).unwrap_or(Value::Null));
    set(&mut out, "dimensionState", player.dimension_state().map(|value| Value::from(value)).unwrap_or(Value::Null));
    Ok(out)
}

/* ------------------------------------------------------------------------------------------------
 * The client's component registry
 *
 * Every read below needs the accessor the game's own systems pass to `getStorage` — the `EntityContext`
 * plus 0x30 (`area-player` §1.1). It comes only from the pointer chains the game itself walks: the
 * accessor the client's own tick reads through ([`crate::live::client_accessor`], captured from the
 * game's `getStorage` calls on the client thread) and the player system's own `EntityContext`
 * ([`note_context`]). The registry's node array (`registry + 0x68 .. + 0x70`, one 0x20-byte node per
 * component: `+0x08` hash, `+0x10` storage — `area-player` §1.3) is what proves a candidate: it must
 * hold every component this module reads. The result is cached and revalidated on every use, so a
 * world change that replaces the registry is noticed and a build whose layouts moved answers
 * "unreadable" instead of a wrong number.
 * ---------------------------------------------------------------------------------------------- */

/// `EntityContext + 0x30`: the accessor, 0 until [`registry`] finds it.
static REGISTRY: AtomicUsize = AtomicUsize::new(0);

/// The registry's node array: begin at `+0x68`, end at `+0x70`.
const REGISTRY_NODES: usize = 0x68;
/// The registry's bucket vector begin, used only as a shape check.
const REGISTRY_BUCKETS: usize = 0x48;
/// One node: `+0x08` component hash, `+0x10` its storage (`area-player` §1.3).
const NODE_STRIDE: usize = 0x20;
const NODE_HASH: usize = 0x08;
const NODE_STORAGE: usize = 0x10;
/// A registry holds one node per component storage the client has created; a few hundred in play.
const MAX_NODES: usize = 4096;
/// The component storages this module reads: a registry must hold all of them to be the client's.
const WANTED: [&str; 4] =
    ["LocalPlayerComponent", "StateVectorComponent", "ActorRotationComponent", "OnGroundFlagComponent"];

fn hash(name: &str) -> u32 {
    anchors::component_hash(name)
}

fn wanted_hashes() -> [u32; 4] {
    [hash(WANTED[0]), hash(WANTED[1]), hash(WANTED[2]), hash(WANTED[3])]
}

/// The client's component registry, discovering it if this world has not been seen yet.
pub(crate) fn registry() -> Option<usize> {
    let cached = REGISTRY.load(Ordering::Acquire);
    if cached != 0 && valid(cached) {
        return Some(cached);
    }
    // The accessor the client's own tick reads through is the one the game handed to `getStorage`
    // on this world, so it wins over anything captured earlier or found by a scan.
    if let Some(accessor) = live::client_accessor() {
        if valid(accessor) {
            REGISTRY.store(accessor, Ordering::Release);
            return Some(accessor);
        }
    }
    let found = discover()?;
    REGISTRY.store(found, Ordering::Release);
    Some(found)
}

/// The registry's node array, as bytes: one readability check, then plain indexing.
fn tree(accessor: usize) -> Option<&'static [u8]> {
    let begin = pe::read::<usize>(accessor + REGISTRY_NODES)?;
    let end = pe::read::<usize>(accessor + REGISTRY_NODES + 8)?;
    if begin == 0 || begin % 0x10 != 0 || end <= begin {
        return None;
    }
    let bytes = end - begin;
    if bytes % NODE_STRIDE != 0 || bytes > MAX_NODES * NODE_STRIDE {
        return None;
    }
    // The bucket vector beside it must be a vector: begin <= end <= capacity.
    if let (Some(begin), Some(end), Some(capacity)) = (
        pe::read::<usize>(accessor + REGISTRY_BUCKETS),
        pe::read::<usize>(accessor + REGISTRY_BUCKETS + 8),
        pe::read::<usize>(accessor + REGISTRY_BUCKETS + 16),
    ) {
        if begin != 0 && (end < begin || capacity < end || (end - begin) % 8 != 0) {
            return None;
        }
    }
    pe::bytes(begin, bytes)
}

fn node_hash(tree: &[u8], index: usize) -> Option<u32> {
    let at = index * NODE_STRIDE + NODE_HASH;
    let bytes = tree.get(at..at + 4)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn node_storage(tree: &[u8], index: usize) -> Option<usize> {
    let at = index * NODE_STRIDE + NODE_STORAGE;
    let bytes = tree.get(at..at + 8)?;
    Some(usize::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7]]))
}

/// The storage a hash maps to, from the node array.
fn storage_of(tree: &[u8], hash: u32) -> Option<usize> {
    let count = tree.len() / NODE_STRIDE;
    for index in 0..count {
        if node_hash(tree, index) == Some(hash) {
            return node_storage(tree, index);
        }
    }
    None
}

/// A cached registry is still the client's: its node array holds the components every client has.
fn valid(accessor: usize) -> bool {
    let Some(tree) = tree(accessor) else {
        return false;
    };
    wanted_hashes().iter().all(|hash| storage_of(tree, *hash).is_some())
}

/// The registry accessor the player system's own `EntityContext` handed over.
static NOTED: AtomicUsize = AtomicUsize::new(0);

/// Records the registry accessor from the `EntityContext` the player system runs with.
///
/// `context + 0x30` **is** the accessor the game itself passes to `getStorage(accessor, hash)` — the
/// registry is embedded in the context, not a pointer stored there (`area-player` §1.1: the system
/// body does `lea rbx,[rdx+0x30]` and passes `rbx` as the getter's `rcx`). The player-system hook
/// receives that context, so this costs one shape check; a value whose node array does not hold the
/// components every client has is refused rather than stored.
pub(crate) fn note_context(context: usize) {
    if NOTED.load(Ordering::Acquire) != 0 || context < 0x1_0000 {
        return;
    }
    let accessor = context + 0x30;
    if !valid(accessor) {
        return;
    }
    NOTED.store(accessor, Ordering::Release);
    agent_core::log::fmt(format_args!(
        "input: client component registry accessor 0x{accessor:x} from the player system's own EntityContext"
    ));
}

/// The client's registry accessor.
///
/// It comes **only** from the pointer chain the game itself walks — the player system's `EntityContext`
/// at `+0x30` — never from a scan: a scan of the process's writable memory took 2.8 GB and seconds per
/// attempt, and it races every free the game does while it reads. When no context has been seen yet the
/// answer is "not yet", and the caller tries again on the next tick.
fn discover() -> Option<usize> {
    let noted = NOTED.load(Ordering::Acquire);
    if noted != 0 {
        return Some(noted);
    }
    None
}

/// The storage's own entity vector, as `ecs` and `area-player` §1.3 describe it.
const ENTITY_BEGIN: usize = 0x20;
const ENTITY_END: usize = 0x28;

fn read_vec3(address: usize) -> Option<[f32; 3]> {
    let vector = [pe::read::<f32>(address)?, pe::read::<f32>(address + 4)?, pe::read::<f32>(address + 8)?];
    vector.iter().all(|value| value.is_finite()).then_some(vector)
}

/* ------------------------------------------------------------------------------------------------
 * The local player, read through the game's own components
 * ---------------------------------------------------------------------------------------------- */

/// The local player's entity, plus the registry the component lookups need.
struct Player {
    accessor: usize,
    reading: ecs::Reading,
}

impl Player {
    /// The local player, or `None` when no registry resolved or no local player exists in it.
    fn open() -> Option<Player> {
        let accessor = registry()?;
        let reading = ecs::read(accessor)?;
        Some(Player { accessor, reading })
    }

    fn entity(&self) -> u32 {
        self.reading.sample.entity
    }

    fn storage(&self, name: &str) -> Option<usize> {
        ecs::storage(self.accessor, anchors::component_hash(name))
    }

    fn element(&self, name: &str, stride: usize) -> Option<usize> {
        ecs::element(self.storage(name)?, self.entity(), stride)
    }

    /// `minecraft:health`'s current value, from the attribute container's own instances.
    ///
    /// The container is a sorted name-hash array at `+0x00` and a parallel array of
    /// `AttributeInstance` (stride 0x88) at `+0x18` (`area-player` §2.7): the instance's `+0x08` is its
    /// `Attribute` definition and its `+0x7c` the current value. The definition is identified by its
    /// *name*, not by the hash — the key the map uses is not the FNV-1a of the name (`area-inventory`
    /// §1.2) — so the name is read out of the definition as an MSVC `std::string` and compared with the
    /// two spellings the engine registers (`minecraft:health`, `generic.health`).
    fn health(&self) -> Option<f32> {
        let element = self.element("AttributesComponent", ATTRIBUTES_STRIDE)?;
        let ids = pe::read::<usize>(element + ATTRIBUTES_IDS)?;
        let ids_end = pe::read::<usize>(element + ATTRIBUTES_IDS_END)?;
        let instances = pe::read::<usize>(element + ATTRIBUTES_INSTANCES)?;
        let instances_end = pe::read::<usize>(element + ATTRIBUTES_INSTANCES_END)?;
        if ids_end <= ids || instances_end <= instances {
            return None;
        }
        let count = (ids_end - ids) / 4;
        // The two arrays are parallel: a mismatch means this is not the container it looks like.
        if count == 0 || count > 64 || (instances_end - instances) / ATTRIBUTE_STRIDE != count {
            return None;
        }
        for index in 0..count {
            let instance = instances + index * ATTRIBUTE_STRIDE;
            let Some(definition) = pe::read::<usize>(instance + ATTRIBUTE_DEFINITION) else {
                continue;
            };
            let Some(name) = definition_name(definition) else {
                continue;
            };
            if name == b"minecraft:health" || name == b"generic.health" {
                let current = pe::read::<f32>(instance + ATTRIBUTE_CURRENT)?;
                // A living attribute is a finite, sane number; anything else is a layout that moved.
                return (current.is_finite() && (0.0..=20_480.0).contains(&current)).then_some(current);
            }
        }
        None
    }

    /// The raw dimension state dword (`DimensionStateComponent`, stride 0x10, `+0x00`).
    fn dimension_state(&self) -> Option<i32> {
        self.element("DimensionStateComponent", DIMENSION_STRIDE).and_then(pe::read::<i32>)
    }

    /// The newest crosshair pick, decoded (see the module documentation), or `None` when the component,
    /// its holder or the entry does not check out.
    fn crosshair(&self) -> Option<Crosshair> {
        let element = self.element("HitResultComponent", HIT_STRIDE)?;
        let holder = pe::read::<usize>(element)?;
        if holder < 0x1_0000 || !pe::readable(holder, 0x18) {
            return None;
        }
        // A polymorphic holder: its first qword is a vtable in the game's image.
        if pe::read::<usize>(holder).is_none_or(|vtable| !pe::in_image_data(vtable)) {
            return None;
        }
        let begin = pe::read::<usize>(holder + HIT_BEGIN)?;
        let end = pe::read::<usize>(holder + HIT_END)?;
        if begin == 0 || end <= begin || (end - begin) % HIT_ENTRY != 0 || (end - begin) / HIT_ENTRY > HIT_MAX_ENTRIES {
            return None;
        }
        let pick = end - HIT_ENTRY;
        if !pe::readable(pick, HIT_ENTRY) {
            return None;
        }
        let position = read_vec3(pick + HIT_POSITION).filter(|p| p.iter().all(|v| v.is_finite()));
        match pe::read::<u32>(pick + HIT_TYPE)? {
            HIT_TYPE_BLOCK => {
                let block = [
                    pe::read::<i32>(pick + HIT_BLOCK)?,
                    pe::read::<i32>(pick + HIT_BLOCK + 4)?,
                    pe::read::<i32>(pick + HIT_BLOCK + 8)?,
                ];
                let face = pe::read::<u8>(pick + HIT_FACE)?;
                // A face is one of the six; and the block is within reach of the player's eye.
                let [x, y, z] = self.reading.sample.position;
                let near = (block[0] as f32 + 0.5 - x).abs() <= HIT_REACH
                    && (block[1] as f32 + 0.5 - y).abs() <= HIT_REACH
                    && (block[2] as f32 + 0.5 - z).abs() <= HIT_REACH;
                (face < 6 && near).then_some(Crosshair::Block { block, face, position })
            }
            HIT_TYPE_ENTITY => {
                let entity = pe::read::<u32>(pick + HIT_ENTITY)?;
                if entity == u32::MAX || entity == self.entity() {
                    return None;
                }
                let unique = self.storage("ActorUniqueIDComponent")?;
                let id = ecs::element(unique, entity, ecs::UNIQUE_STRIDE).and_then(pe::read::<u64>)?;
                // The id must be one of the live entities in reach: a stale or foreign id answers nothing.
                if !self.entities().iter().any(|(candidate, _)| *candidate == id) {
                    return None;
                }
                Some(Crosshair::Entity { id, kind: self.entity_type(entity), position })
            }
            _ => None,
        }
    }

    /// An entity's type (`minecraft:villager_v2`) from its `ActorDefinitionIdentifierComponent`: the
    /// `ActorDefinitionIdentifier` is four `std::string`s (namespace, identifier, init event, full name
    /// `ns:id<event>`) and the canonical `HashedString` (`+0x80` hash, `+0x88` text). Only a canonical
    /// name that equals `namespace:identifier` is believed (live: `minecraft` + `villager_v2`).
    fn entity_type(&self, entity: u32) -> Option<String> {
        let storage = self.storage("ActorDefinitionIdentifierComponent")?;
        let element = ecs::element(storage, entity, IDENTIFIER_STRIDE)?;
        let namespace = pe::std_string(element + IDENTIFIER_NAMESPACE)?;
        let identifier = pe::std_string(element + IDENTIFIER_NAME)?;
        let canonical = pe::std_string(element + IDENTIFIER_CANONICAL)?;
        let plain = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'));
        (plain(&namespace) && plain(&identifier) && canonical == alloc::format!("{namespace}:{identifier}")).then_some(canonical)
    }

    /// Every other entity's unique id and position: the values a `HitResult` may name.
    fn entities(&self) -> Vec<(u64, [f32; 3])> {
        let mut out = Vec::new();
        let Some(unique) = self.storage("ActorUniqueIDComponent") else {
            return out;
        };
        let Some(state) = self.storage("StateVectorComponent") else {
            return out;
        };
        let (Some(begin), Some(end)) = (pe::read::<usize>(unique + ENTITY_BEGIN), pe::read::<usize>(unique + ENTITY_END)) else {
            return out;
        };
        if end <= begin || (end - begin) % 4 != 0 || (end - begin) / 4 > 1024 {
            return out;
        }
        let local = self.entity();
        let [x, y, z] = self.reading.sample.position;
        let mut at = begin;
        while at < end {
            if let Some(entity) = pe::read::<u32>(at) {
                if entity != local {
                    let id = ecs::element(unique, entity, ecs::UNIQUE_STRIDE).and_then(pe::read::<u64>);
                    let position = ecs::element(state, entity, ecs::STATE_VECTOR_STRIDE)
                        .and_then(|element| read_vec3(element + ecs::STATE_POSITION));
                    if let (Some(id), Some(position)) = (id, position) {
                        // Only an entity a crosshair can be on: the rest cannot be what attack hit.
                        let near = (position[0] - x).abs() <= HIT_REACH
                            && (position[1] - y).abs() <= HIT_REACH
                            && (position[2] - z).abs() <= HIT_REACH;
                        if id != u64::MAX && near {
                            out.push((id, position));
                        }
                    }
                }
            }
            at += 4;
        }
        out
    }
}

/// `debug.hit` (debug-rpc only) → the entities in reach and, per candidate stride, the raw
/// `HitResultComponent` element and the first qwords of the object it points at.
#[cfg(feature = "debug-rpc")]
pub fn h_debug_hit(_core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    use alloc::format;
    world()?;
    let player = Player::open().ok_or_else(|| RpcError::anchor("ecs.registry"))?;
    let entities: Vec<Value> = player.entities().iter().map(|(id, at)| json!({ "id": format!("{}", *id as i64), "at": [at[0], at[1], at[2]] })).collect();
    let storage = player.storage("HitResultComponent");
    let mut strides = Vec::new();
    for stride in [HIT_STRIDE] {
        let element = player.element("HitResultComponent", stride);
        let raw: Vec<Value> = element
            .map(|element| (0..4).filter_map(|i| pe::read::<usize>(element + i * 8)).map(|q| Value::from(format!("{q:#x}"))).collect())
            .unwrap_or_default();
        let object = element.and_then(pe::read::<usize>).filter(|object| *object >= 0x1_0000 && pe::readable(*object, 0x20));
        let words: Vec<Value> = object
            .map(|object| (0..4).filter_map(|i| pe::read::<u64>(object + i * 8)).map(|q| Value::from(format!("{q:#x}"))).collect())
            .unwrap_or_default();
        strides.push(json!({ "stride": stride, "element": element.map(|e| format!("{e:#x}")), "raw": raw, "object": object.map(|o| format!("{o:#x}")), "words": words }));
    }
    let crosshair = player.crosshair().map(|hit| hit.json());
    let mut storages = Vec::new();
    for name in ["ActorUniqueIDComponent", "StateVectorComponent", "ActorDefinitionIdentifierComponent", "RuntimeIDComponent", "ActorOwnerComponent", "LocalPlayerComponent"] {
        let Some(storage) = player.storage(name) else {
            storages.push(json!({ "name": name, "storage": null }));
            continue;
        };
        let begin = pe::read::<usize>(storage + ENTITY_BEGIN).unwrap_or(0);
        let end = pe::read::<usize>(storage + ENTITY_END).unwrap_or(0);
        let count = if end > begin { (end - begin) / 4 } else { 0 };
        let ids: Vec<Value> = (0..count.min(64)).filter_map(|i| pe::read::<u32>(begin + i * 4)).map(Value::from).collect();
        // Each entity's packed page and its slot in it (element = page + slot × stride).
        let slots: Vec<Value> = (0..count.min(64))
            .filter_map(|i| pe::read::<u32>(begin + i * 4))
            .map(|entity| {
                let page = ecs::element(storage, entity, 0);
                let slot = ecs::element(storage, entity, 1).zip(page).map(|(one, page)| one - page);
                json!({ "entity": entity, "page": page.map(|p| format!("{p:#x}")), "slot": slot })
            })
            .collect();
        storages.push(json!({ "name": name, "storage": format!("{storage:#x}"), "count": count, "entities": ids, "slots": slots }));
    }
    let mut registries = Vec::new();
    for (accessor, thread) in live::accessors() {
        let mut counts = Vec::new();
        for name in ["ActorUniqueIDComponent", "StateVectorComponent", "LocalPlayerComponent"] {
            let storage = ecs::storage(accessor, anchors::component_hash(name));
            let count = storage.map(|storage| {
                let begin = pe::read::<usize>(storage + ENTITY_BEGIN).unwrap_or(0);
                let end = pe::read::<usize>(storage + ENTITY_END).unwrap_or(0);
                if end > begin { (end - begin) / 4 } else { 0 }
            });
            counts.push(json!({ "name": name, "count": count }));
        }
        registries.push(json!({ "accessor": format!("{accessor:#x}"), "thread": thread, "counts": counts }));
    }
    Ok(json!({ "crosshair": crosshair, "local": player.entity(), "accessor": format!("{:#x}", player.accessor), "registries": registries, "storage": storage.map(|s| format!("{s:#x}")), "entities": entities, "storages": storages, "strides": strides }))
}

/// `AttributesComponent` element stride and the container's fields (`area-player` §2.7).
const ATTRIBUTES_STRIDE: usize = 0x50;
const ATTRIBUTES_IDS: usize = 0x00;
const ATTRIBUTES_IDS_END: usize = 0x08;
const ATTRIBUTES_INSTANCES: usize = 0x18;
const ATTRIBUTES_INSTANCES_END: usize = 0x20;
/// One `AttributeInstance`: its definition, and the current value every gameplay reader uses.
const ATTRIBUTE_STRIDE: usize = 0x88;
const ATTRIBUTE_DEFINITION: usize = 0x08;
const ATTRIBUTE_CURRENT: usize = 0x7C;

/// `DimensionStateComponent` element stride (one state dword, padded to 0x10).
const DIMENSION_STRIDE: usize = 0x10;

/// `HitResultComponent`: its element is a `unique_ptr` (the storage's pages are 0x80 × 8 bytes), and
/// the holder keeps a vector of 0x110-byte entries (two `HitResult`s each) at `+0x08`/`+0x10`.
const HIT_STRIDE: usize = 0x08;
const HIT_BEGIN: usize = 0x08;
const HIT_END: usize = 0x10;
const HIT_ENTRY: usize = 0x110;
/// More queued entries than this is not the vector this reader knows.
const HIT_MAX_ENTRIES: usize = 256;
/// `HitResult` fields (the public layout, checked live): type, face byte, block, hit position, target.
const HIT_TYPE: usize = 0x18;
const HIT_FACE: usize = 0x1C;
const HIT_BLOCK: usize = 0x20;
const HIT_POSITION: usize = 0x2C;
const HIT_ENTITY: usize = 0x48;
const HIT_TYPE_BLOCK: u32 = 0;
const HIT_TYPE_ENTITY: u32 = 1;
/// `ActorDefinitionIdentifierComponent` element: four `std::string`s and a `HashedString`.
const IDENTIFIER_STRIDE: usize = 0xB0;
const IDENTIFIER_NAMESPACE: usize = 0x00;
const IDENTIFIER_NAME: usize = 0x20;
const IDENTIFIER_CANONICAL: usize = 0x88;
/// How far a crosshair target can be from the player.
const HIT_REACH: f32 = 8.0;

/// The `Attribute` definition's own name, as an MSVC `std::string` (`{buffer, size, capacity}`).
///
/// The definition's field order is not pinned (`area-inventory` §1.2), so the three layouts the
/// finding proposes are tried in turn; a name has to be printable ASCII of a plausible length, and the
/// caller only accepts it when it is exactly the health attribute, so a wrong probe answers nothing.
fn definition_name(definition: usize) -> Option<&'static [u8]> {
    for (buffer, size) in [(0x08usize, 0x18usize), (0x00, 0x10), (0x28, 0x38)] {
        let Some(buffer) = pe::read::<usize>(definition + buffer) else {
            continue;
        };
        let Some(size) = pe::read::<usize>(definition + size) else {
            continue;
        };
        if !(3..=64).contains(&size) || buffer < 0x1_0000 {
            continue;
        }
        let Some(bytes) = pe::bytes(buffer, size) else {
            continue;
        };
        if bytes.iter().all(|byte| (0x20..=0x7e).contains(byte)) {
            return Some(bytes);
        }
    }
    None
}

/* ------------------------------------------------------------------------------------------------
 * Anchors
 * ---------------------------------------------------------------------------------------------- */

/// Resolves the input anchors and installs this module's two hooks. Runs once at attach.
///
/// * `input.move` — the input-lock function the client's move-input state passes through
///   ([`resolve_movement`]), hooked to apply a hold;
/// * `input.attack` / `input.use` — the client's `button.destroy_or_attack` / `button.build_or_interact`
///   handlers ([`button_handler`]), accepted only when both call the same action handler;
/// * `client.instance` — the client instance's vtable ([`client_table`]) and its `getLevel` method
///   ([`client_getter`], cross-checked against the attack handler), hooked to learn the client.
pub(crate) fn resolve(core: &'static Core) -> Vec<Anchor> {
    let image = core.image();
    match resolve_movement(image) {
        Some(entry) => {
            MOVE_ENTRY.store(entry, Ordering::Release);
            install(core, SITE_MOVE, entry, apply_locks as *const () as usize, &MOVE_TRAMPOLINE);
        }
        None => core.site(SITE_MOVE, false),
    }
    let attack = button_handler(image, ATTACK_BUTTON);
    let usage = button_handler(image, USE_BUTTON);
    let shared = match (attack, usage) {
        (Some((attack, _, attack_registrar)), Some((usage, _, usage_registrar))) => {
            attack_registrar == usage_registrar
                && matches!((action_core(image, attack), action_core(image, usage)), (Some(a), Some(b)) if a == b)
        }
        _ => false,
    };
    if let (true, Some((handler, table, _)), Some((usage_handler, usage_table, _))) = (shared, attack, usage) {
        ATTACK_HANDLER.store(handler, Ordering::Release);
        ATTACK_TABLE.store(table, Ordering::Release);
        USE_HANDLER.store(usage_handler, Ordering::Release);
        USE_TABLE.store(usage_table, Ordering::Release);
        if let Some(table) = client_table(image) {
            if let Some(getter) = client_getter(table, handler) {
                CLIENT_TABLE.store(table, Ordering::Release);
                CLIENT_GETTER.store(getter, Ordering::Release);
                install(core, SITE_CLIENT, getter, client_level as *const () as usize, &CLIENT_TRAMPOLINE);
                if let Some((slot, enter, leave)) = resolve_item_scope(image, table) {
                    SCOPE_SLOT.store(slot, Ordering::Release);
                    SCOPE_ENTER.store(enter, Ordering::Release);
                    SCOPE_LEAVE.store(leave, Ordering::Release);
                }
                RELEASE.store(resolve_release(table, handler).unwrap_or(0), Ordering::Release);
            }
        }
    }
    REGISTRY_TLS_INDEX.store(resolve_registry_tls(image).unwrap_or(0), Ordering::Release);
    if CLIENT_TRAMPOLINE.load(Ordering::Acquire) == 0 {
        core.site(SITE_CLIENT, false);
    }
    let describe = |address: usize| if address == 0 { String::from("missing") } else { alloc::format!("0x{:x}", address - image.base()) };
    agent_core::log::fmt(format_args!(
        "resolve input: move {} (hooked {}), attack {}, use {}, client table {}, getLevel {} (hooked {})",
        describe(MOVE_ENTRY.load(Ordering::Acquire)),
        MOVE_TRAMPOLINE.load(Ordering::Acquire) != 0,
        describe(ATTACK_HANDLER.load(Ordering::Acquire)),
        describe(USE_HANDLER.load(Ordering::Acquire)),
        describe(CLIENT_TABLE.load(Ordering::Acquire)),
        describe(CLIENT_GETTER.load(Ordering::Acquire)),
        CLIENT_TRAMPOLINE.load(Ordering::Acquire) != 0,
    ));
    agent_core::log::fmt(format_args!(
        "resolve input.item_scope: getter slot 0x{:x}, enter {}, leave {}, thread-local index {}, release {}",
        SCOPE_SLOT.load(Ordering::Acquire),
        describe(SCOPE_ENTER.load(Ordering::Acquire)),
        describe(SCOPE_LEAVE.load(Ordering::Acquire)),
        describe(REGISTRY_TLS_INDEX.load(Ordering::Acquire)),
        describe(RELEASE.load(Ordering::Acquire)),
    ));
    report()
}

/// The input anchors as they are now, for `engine.status`: the movement hook's target once it is
/// installed, the button handlers, the item-registry scope, and the client instance once its
/// `getLevel` ran on it.
pub(crate) fn report() -> Vec<Anchor> {
    let hooked = |entry: &AtomicUsize, trampoline: &AtomicUsize| {
        if trampoline.load(Ordering::Acquire) != 0 {
            entry.load(Ordering::Acquire)
        } else {
            0
        }
    };
    alloc::vec![
        Anchor { name: SITE_MOVE, addr: hooked(&MOVE_ENTRY, &MOVE_TRAMPOLINE) },
        Anchor { name: "input.attack", addr: ATTACK_HANDLER.load(Ordering::Acquire) },
        Anchor { name: "input.use", addr: USE_HANDLER.load(Ordering::Acquire) },
        Anchor { name: SITE_SCOPE, addr: if item_scope_resolved() { SCOPE_ENTER.load(Ordering::Acquire) } else { 0 } },
        Anchor { name: "input.registry_tls", addr: REGISTRY_TLS_INDEX.load(Ordering::Acquire) },
        Anchor { name: SITE_RELEASE, addr: RELEASE.load(Ordering::Acquire) },
        Anchor { name: SITE_CLIENT, addr: client().unwrap_or(0) },
    ]
}
