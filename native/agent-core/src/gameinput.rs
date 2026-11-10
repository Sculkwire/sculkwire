//! GameInput: the Microsoft input API the game reads the mouse through, with the agent's own mouse
//! and keyboard state merged into the readings it hands out.
//!
//! # Why this exists
//!
//! A window message reaches the game's UI for a key (`WM_KEYDOWN` through the class procedure opens
//! the pause menu), but not for the mouse: the client's mouse comes from `GameInput`, the GDK's input
//! API, which the game resolves with `GetProcAddress` on the module it loads (`GameInputRedist.dll`,
//! the redistributable in the game's `Installers/GameInputRedist.msi`, or the system's `GameInput.dll`,
//! whichever file is newer) and then calls through COM vtables. There is no import slot to hook and no
//! message to post, so the only entry that sees the user's mouse is the API itself: this module hooks
//! the two vtables the game calls.
//!
//! Every instance of an interface shares one vtable, so patching a slot also affects the game's own
//! instance, even when the agent attaches long after the game created it.
//!
//! # Which interface
//!
//! The runtime serves several versions of the API from one object, one vtable per version, and each
//! version has its own slot layout. The game (1.26.63.1) creates the *oldest* one — `GameInputInitialize`
//! with v0's IID when the runtime exports it, else `GameInputCreate` — then asks that object's
//! `QueryInterface` for v2 and calls only v2's vtable: `GetCurrentReading(Mouse, device)` every frame,
//! then `GetMouseState` on the reading. A hook on the vtable the entry point answers (v0) therefore
//! never sees a call. This module creates the interface through the same entry with the same IID, asks
//! it for every version it knows by IID, and patches each version the object answers with that
//! version's own slot table, after validating it (see [`probe`]): whichever version a build calls is
//! hooked. A runtime that answers several IIDs with one vtable is patched once, with the newest layout.
//!
//! # What is hooked
//!
//! The layouts are the public headers: the GDK's `GameInput.h` for v0 and `Microsoft.GameInput`'s
//! `native/include/GameInput.h` for v1 and v2 (the redistributable in the game's `Installers/` folder
//! is `2.2.26100.6106` and serves all three). A slot index is the vtable byte offset divided by 8;
//! slots 0..2 are `IUnknown`. Off Windows the module may be the Wine-side runtime, a different
//! implementation of the same documents — which is why every slot below is *validated by calling it*
//! at attach instead of trusted: a runtime of another ABI answers a different shape and this module
//! leaves it alone.
//!
//! | interface | method | v0 slot | v1/v2 slot |
//! |---|---|---|---|
//! | `IGameInput` | `GetCurrentReading` | 4 | 4 |
//! | | `GetNextReading` | 5 | 5 |
//! | | `GetPreviousReading` | 6 | 6 |
//! | | `RegisterReadingCallback` | 8 (takes `float analogThreshold`) | 7 |
//! | `IGameInputReading` | `GetKeyCount` | 14 | 12 |
//! | | `GetKeyState` | 15 | 13 |
//! | | `GetMouseState` | 16 (40-byte state, no absolute position) | 14 (56 bytes) |
//!
//! The three `IGameInput` reading methods are hooked only to *see* the readings the game obtains, so a
//! reading class this module has not met yet can be patched as well: each forwards to the original
//! first and changes nothing about the result. `RegisterReadingCallback` is wrapped so a reading the
//! runtime delivers to the game's own callback is seen the same way (a callback the game registered
//! before the agent attached is not wrapped; its readings still end in the patched reading class). The
//! two `IGameInputReading` state methods are where the merge happens: every delivery path (polling or
//! callback) ends in `GetMouseState`/`GetKeyState` on a reading object. Every count is kept per version
//! (`engine.status.gameinput.versions`), so the version the game reads through is visible.
//!
//! # What it does to a state
//!
//! * **Synthetic input.** The agent's own mouse and keys are offsets on the reading's cumulative
//!   counters, so the game's own delta arithmetic sees exactly one delta per injected step:
//!   `positionX = real.positionX + offset`, `wheelY = real.wheelY + offset`. The absolute position is
//!   the requested client pixel plus the client area's screen origin, which is the space the runtime
//!   fills `absolutePositionX/Y` from (the redistributable calls `GetCursorPos` for it).
//!   `positions` gains `GameInputMouseAbsolutePosition` while a synthetic position is live, because
//!   that flag is what tells a consumer the absolute pair may be read.
//! * **The input lock.** While [`crate::lock::on`] the user's own state is hidden: their movement
//!   stops moving the counters (the last value is kept, so nothing drifts), their buttons read as up
//!   and their wheel stays where it was; their keys are not listed. The agent's synthetic state is
//!   merged on top of that, so the lock never blocks the agent's own input.
//! * **Fail open.** Every step is optional: an interface that fails validation, a vtable that does not
//!   match the one probed, a slot that could not be made writable — all leave the real state exactly
//!   as the runtime produced it. Nothing here is guessed from a game address.
//!
//! # Timing
//!
//! A click is not one reading either way: the game handles a button edge at the cursor it already has
//! and only then applies the reading's position, so a click's first [`ARM_SAMPLES`] readings carry the
//! new position with the button up, and the press goes down after that (live, a press in the same
//! reading as the move lit the target up and pressed nothing).
//!
//! A click cannot be one reading: a consumer compares the reading it holds with the previous one, so a
//! button that is down and up in the same sample is no press at all. A queued press is therefore held
//! for [`BUTTON_HOLD_MS`] *and* until at least [`BUTTON_SAMPLES`] readings have reported it down, and
//! released by a later reading — or by [`frame`], so a game that stops polling cannot leave a button
//! stuck down. A synthetic position lives for [`POSITION_HOLD_MS`] after the request, long enough for
//! the game to draw and act on the frame the press lands in.
//!
//! The request methods only *queue*; the game applies them when it next reads. That is the honest
//! answer the engines report: `route: "gameinput"`, applied by the game's next readings.
//!
//! A consumer that walks readings with `GetNextReading` only sees the state when the runtime
//! *publishes* a reading, and the runtime publishes mouse readings when the device reports something.
//! So while the lock is on, a requested position also moves the OS pointer ([`warp`]): that is an event
//! for the runtime to report, and it leaves the runtime's own absolute position equal to the one this
//! module merges, so a consumer reading either agrees. With the lock off the pointer is the user's and
//! is never moved.

use core::ffi::c_void;
use core::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, AtomicUsize, Ordering};

use crate::sync::SpinLock;
use crate::{lock, log, win};

/* ------------------------------------------------------------------------------------------------
 * The API: slots, kinds, structures
 * ---------------------------------------------------------------------------------------------- */

/// `IUnknown::QueryInterface(REFIID, void**)`.
const SLOT_QUERY_INTERFACE: usize = 0;
/// `IUnknown::Release`.
const SLOT_RELEASE: usize = 2;
/// `IGameInput::GetCurrentReading(GameInputKind, IGameInputDevice*, IGameInputReading**)`, in every
/// version.
const SLOT_CURRENT_READING: usize = 4;
/// `IGameInput::GetNextReading(reference, kind, device, reading**)`, in every version.
const SLOT_NEXT_READING: usize = 5;
/// `IGameInput::GetPreviousReading(reference, kind, device, reading**)`, in every version.
const SLOT_PREVIOUS_READING: usize = 6;
/// `IGameInputReading::GetInputKind()`, in every version. Read, never patched: the probe uses it to
/// prove the layout.
const SLOT_INPUT_KIND: usize = 3;

/// A GUID as it lies in memory.
type Guid = [u8; 16];

const fn guid(d1: u32, d2: u16, d3: u16, d4: [u8; 8]) -> Guid {
    let a = d1.to_le_bytes();
    let b = d2.to_le_bytes();
    let c = d3.to_le_bytes();
    [a[0], a[1], a[2], a[3], b[0], b[1], c[0], c[1], d4[0], d4[1], d4[2], d4[3], d4[4], d4[5], d4[6], d4[7]]
}

/// `IGameInput` of the GDK's original API: what `GameInputCreate` answers, and the IID the game passes
/// to `GameInputInitialize`.
const IID_V0: Guid = guid(0x11BE2A7E, 0x4254, 0x445A, [0x9C, 0x09, 0xFF, 0xC4, 0x0F, 0x00, 0x69, 0x18]);
/// `IGameInput` of API version 1.
const IID_V1: Guid = guid(0x40FFB7E4, 0x6150, 0x407A, [0xB4, 0x39, 0x13, 0x2B, 0xAD, 0xC0, 0x8D, 0x2D]);
/// `IGameInput` of API version 2: the one the game asks the created interface for and calls.
const IID_V2: Guid = guid(0xBBAA66D2, 0x837A, 0x40F7, [0xA3, 0x03, 0x91, 0x7D, 0x50, 0x09, 0x55, 0xF4]);

/// One interface version's slot table: the slots that differ between versions, and its shapes.
struct Layout {
    name: &'static str,
    text: &'static str,
    iid: Guid,
    /// `IGameInput::RegisterReadingCallback`.
    register: usize,
    /// `RegisterReadingCallback` takes `float analogThreshold` between the kind and the context (v0).
    threshold: bool,
    /// `IGameInputReading::GetKeyCount()`.
    key_count: usize,
    /// `IGameInputReading::GetKeyState(count, GameInputKeyState*)`.
    key_state: usize,
    /// `IGameInputReading::GetMouseState(GameInputMouseState*)`.
    mouse_state: usize,
    /// The mouse state is v0's [`MouseStateV0`] rather than [`MouseState`].
    v0_mouse: bool,
}

impl Layout {
    fn mouse_size(&self) -> usize {
        if self.v0_mouse { core::mem::size_of::<MouseStateV0>() } else { core::mem::size_of::<MouseState>() }
    }
}

/// The versions, oldest first; the index is the version. v0 inserts `GetSequenceNumber` and
/// `GetRawReport` into `IGameInputReading` and `GetTemporalReading` into `IGameInput`, which is why its
/// slots sit further down.
const LAYOUTS: [Layout; 3] = [
    Layout {
        name: "v0",
        text: "11BE2A7E-4254-445A-9C09-FFC40F006918",
        iid: IID_V0,
        register: 8,
        threshold: true,
        key_count: 14,
        key_state: 15,
        mouse_state: 16,
        v0_mouse: true,
    },
    Layout {
        name: "v1",
        text: "40FFB7E4-6150-407A-B439-132BADC08D2D",
        iid: IID_V1,
        register: 7,
        threshold: false,
        key_count: 12,
        key_state: 13,
        mouse_state: 14,
        v0_mouse: false,
    },
    Layout {
        name: "v2",
        text: "BBAA66D2-837A-40F7-A303-917D500955F4",
        iid: IID_V2,
        register: 7,
        threshold: false,
        key_count: 12,
        key_state: 13,
        mouse_state: 14,
        v0_mouse: false,
    },
];

/// `GameInputKindMouse`.
const KIND_MOUSE: u32 = 0x0000_0020;
/// `GameInputKindKeyboard`.
const KIND_KEYBOARD: u32 = 0x0000_0010;

/// `GameInputMouseLeftButton`.
const MOUSE_LEFT: u32 = 0x0000_0001;
/// `GameInputMouseRightButton`.
const MOUSE_RIGHT: u32 = 0x0000_0002;
/// `GameInputMouseMiddleButton`.
const MOUSE_MIDDLE: u32 = 0x0000_0004;

/// `GameInputMouseAbsolutePosition`.
const POSITION_ABSOLUTE: u32 = 0x0000_0001;
/// `GameInputMouseRelativePosition`.
const POSITION_RELATIVE: u32 = 0x0000_0002;

/// One wheel notch in the units `wheelX`/`wheelY` accumulate, which are the units a `WM_MOUSEWHEEL`
/// carries in `wParam` (`WHEEL_DELTA`, 120): the runtime accumulates the same deltas the window
/// message would have carried. A build whose wheel unit turns out to be one per notch would scroll
/// 120 times too far, which is why `ui.scroll` reports the route it took.
const WHEEL_UNITS_PER_NOTCH: i64 = 120;

/// `GameInputMouseState` of v1 and v2, 56 bytes.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct MouseState {
    pub buttons: u32,
    pub positions: u32,
    pub position_x: i64,
    pub position_y: i64,
    pub absolute_x: i64,
    pub absolute_y: i64,
    pub wheel_x: i64,
    pub wheel_y: i64,
}

/// `GameInputMouseState` of v0, 40 bytes: no `positions` set and no absolute position.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct MouseStateV0 {
    pub buttons: u32,
    pub _pad: u32,
    pub position_x: i64,
    pub position_y: i64,
    pub wheel_x: i64,
    pub wheel_y: i64,
}

/// `GameInputKeyState`, 12 bytes.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct KeyState {
    pub scan_code: u32,
    pub code_point: u32,
    pub virtual_key: u8,
    pub is_dead_key: u8,
    pub _pad: [u8; 2],
}

impl KeyState {
    const EMPTY: KeyState = KeyState { scan_code: 0, code_point: 0, virtual_key: 0, is_dead_key: 0, _pad: [0; 2] };
}

type GetReading = unsafe extern "system" fn(usize, u32, usize, *mut usize) -> i32;
type GetRelativeReading = unsafe extern "system" fn(usize, usize, u32, usize, *mut usize) -> i32;
/// v1 and later: `(this, device, kind, context, callback, token*)`.
type RegisterReading = unsafe extern "system" fn(usize, usize, u32, usize, usize, *mut u64) -> i32;
/// v0: `(this, device, kind, analogThreshold, context, callback, token*)`.
type RegisterReadingThreshold = unsafe extern "system" fn(usize, usize, u32, f32, usize, usize, *mut u64) -> i32;
type QueryInterface = unsafe extern "system" fn(usize, *const Guid, *mut usize) -> i32;
/// Takes the version's own mouse state, [`MouseState`] or [`MouseStateV0`].
type GetMouseState = unsafe extern "system" fn(usize, *mut u8) -> u8;
type GetKeyCount = unsafe extern "system" fn(usize) -> u32;
type GetKeyState = unsafe extern "system" fn(usize, u32, *mut KeyState) -> u32;
type ReleaseFn = unsafe extern "system" fn(usize) -> u32;
/// `GameInputReadingCallback(GameInputCallbackToken, void* context, IGameInputReading*)`, plus v0's
/// `bool hasOverrunOccurred` in the fourth register (passed through as it came).
type ReadingCallback = unsafe extern "system" fn(u64, usize, usize, usize);

#[link(name = "user32", kind = "raw-dylib")]
extern "system" {
    /// The OS pointer, in screen pixels: where the game's own cursor is before the agent moves it, and
    /// the space the runtime reports the absolute mouse position in.
    fn GetCursorPos(point: *mut i32) -> win::Bool;
    /// Moves the OS pointer, so the runtime publishes a mouse reading for the position the agent asked
    /// for (see [`warp`]).
    fn SetCursorPos(x: i32, y: i32) -> win::Bool;
}

/* ------------------------------------------------------------------------------------------------
 * State
 * ---------------------------------------------------------------------------------------------- */

/// A patched vtable slot: what to put back on unload, and the hook set that patched it.
#[derive(Clone, Copy)]
struct Patch {
    slot: usize,
    original: usize,
    set: usize,
}

impl Patch {
    const EMPTY: Patch = Patch { slot: 0, original: 0, set: 0 };
}

/// Seven slots per hook set, plus three per reading class adopted later.
const MAX_PATCHES: usize = 64;

static PATCHES: SpinLock<[Patch; MAX_PATCHES]> = SpinLock::new([Patch::EMPTY; MAX_PATCHES]);

/// One hook set per runtime module and interface version: `module_index * LAYOUTS.len() + version`.
const SETS: usize = MODULE_NAMES.len() * LAYOUTS.len();

/// [`Hooks::status`]: not validated yet (retried), patched, or not offered by the runtime.
const UNTRIED: u32 = 0;
const PATCHED: u32 = 1;
const ABSENT: u32 = 2;

/// What one interface version of one runtime has patched, and what the game did through it.
struct Hooks {
    status: AtomicU32,
    /// The validated vtables: the `IGameInput` of this version, and the reading class it produced.
    instance: AtomicUsize,
    reading: AtomicUsize,
    /// A reading class seen at run time that has not been adopted yet (taken by [`frame`]).
    pending: AtomicUsize,
    /* The original functions of the patched slots. A slot is only patched when its function is the one
     * recorded here: a class with a different implementation would be called with the wrong original. */
    current: AtomicUsize,
    next: AtomicUsize,
    previous: AtomicUsize,
    register: AtomicUsize,
    key_count: AtomicUsize,
    key_state: AtomicUsize,
    mouse: AtomicUsize,
    /// What the game asked this version for, counted by kind (`GetCurrentReading`/`GetNextReading`/
    /// `GetPreviousReading` calls naming mouse, keyboard or other input), the readings those calls
    /// produced, the readings delivered to the game's own callback, the mouse states merged and how
    /// many of them carried the agent's state, and reading classes patched after the probed one.
    asked_mouse: AtomicU64,
    asked_keyboard: AtomicU64,
    asked_other: AtomicU64,
    readings: AtomicU64,
    callbacks: AtomicU64,
    samples: AtomicU64,
    synthetic: AtomicU64,
    adopted: AtomicU64,
    /// Why the last probe of this version refused, empty once it did not.
    note: SpinLock<&'static str>,
}

impl Hooks {
    const NEW: Hooks = Hooks {
        status: AtomicU32::new(UNTRIED),
        instance: AtomicUsize::new(0),
        reading: AtomicUsize::new(0),
        pending: AtomicUsize::new(0),
        current: AtomicUsize::new(0),
        next: AtomicUsize::new(0),
        previous: AtomicUsize::new(0),
        register: AtomicUsize::new(0),
        key_count: AtomicUsize::new(0),
        key_state: AtomicUsize::new(0),
        mouse: AtomicUsize::new(0),
        asked_mouse: AtomicU64::new(0),
        asked_keyboard: AtomicU64::new(0),
        asked_other: AtomicU64::new(0),
        readings: AtomicU64::new(0),
        callbacks: AtomicU64::new(0),
        samples: AtomicU64::new(0),
        synthetic: AtomicU64::new(0),
        adopted: AtomicU64::new(0),
        note: SpinLock::new(""),
    };

    /// Forgets the patch: the originals go (every replacement then answers a failure without calling
    /// anything), and the set may be probed again.
    fn clear(&self) {
        for original in [
            &self.current,
            &self.next,
            &self.previous,
            &self.register,
            &self.key_count,
            &self.key_state,
            &self.mouse,
            &self.pending,
            &self.instance,
            &self.reading,
        ] {
            original.store(0, Ordering::Release);
        }
        self.status.store(UNTRIED, Ordering::Release);
    }

    /// Counts what the game asked for, by kind: the evidence of whether this build reads the mouse
    /// through this version at all.
    fn note_kind(&self, kind: u32) {
        self.readings.fetch_add(1, Ordering::Relaxed);
        if kind & KIND_MOUSE != 0 {
            self.asked_mouse.fetch_add(1, Ordering::Relaxed);
        } else if kind & KIND_KEYBOARD != 0 {
            self.asked_keyboard.fetch_add(1, Ordering::Relaxed);
        } else {
            self.asked_other.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Remembers a reading's class for [`frame`] to adopt, unless it is already the patched one.
    fn note_reading(&self, reading: usize) {
        if reading == 0 || !win::readable(reading, 8) {
            return;
        }
        let table = unsafe { core::ptr::read_volatile(reading as *const usize) };
        if table != 0 && table != self.reading.load(Ordering::Acquire) {
            self.pending.store(table, Ordering::Release);
        }
    }

    fn sum(field: impl Fn(&Hooks) -> &AtomicU64) -> u64 {
        HOOKS.iter().map(|hooks| field(hooks).load(Ordering::Acquire)).sum()
    }
}

static HOOKS: [Hooks; SETS] = [Hooks::NEW; SETS];

/// The first GameInput module the probe used and the entry it called, 0 while not found.
static MODULE: AtomicUsize = AtomicUsize::new(0);
static CREATE: AtomicUsize = AtomicUsize::new(0);

/// When a new `IGameInput` instance may be asked for, and how many times that has been tried.
static NEXT_TRY_MS: AtomicU64 = AtomicU64::new(0);
static TRIES: AtomicU32 = AtomicU32::new(0);
/// True once every version of every loaded runtime is patched or absent: [`frame`] stops probing.
static SETTLED: AtomicBool = AtomicBool::new(false);

/// Merged mouse states the user's input was hidden in, and key states answered, over every version.
static HIDDEN_SAMPLES: AtomicU64 = AtomicU64::new(0);
static KEY_SAMPLES: AtomicU64 = AtomicU64::new(0);

/// Why the last probe refused, for `engine.status` and the log: empty once a version is hooked.
static PROBE_NOTE: SpinLock<&'static str> = SpinLock::new("");

/// The client area's top-left in screen pixels: the engines pass it, every coordinate here is a client
/// pixel and the runtime reports the absolute position in screen pixels.
/// `tick_ms` of the game's last mouse reading through a hooked interface (0: none yet).
static LAST_SAMPLE_MS: AtomicU64 = AtomicU64::new(0);
/// The last queued click: its number and what became of it ([`CLICK_QUEUED`] … [`CLICK_DROPPED`]).
static CLICK_SEQ: AtomicU32 = AtomicU32::new(0);
static CLICK_STATE: AtomicU32 = AtomicU32::new(0);
const CLICK_QUEUED: u32 = 1;
const CLICK_PRESSED: u32 = 2;
const CLICK_RELEASED: u32 = 3;
const CLICK_DROPPED: u32 = 4;
static ORIGIN_X: AtomicI32 = AtomicI32::new(0);
static ORIGIN_Y: AtomicI32 = AtomicI32::new(0);

/* ------------------------------------------------------------------------------------------------
 * The synthetic state
 * ---------------------------------------------------------------------------------------------- */

/// How long a requested position stays live: a few frames at 60 Hz, long enough for the game to draw
/// the frame the press lands in and act on it.
const POSITION_HOLD_MS: u64 = 400;
/// How long a queued press stays down, so the game sees a frame with the button in it.
const BUTTON_HOLD_MS: u64 = 80;
/// How long a queued key press stays down.
const KEY_HOLD_MS: u64 = 80;
/// The fewest readings that must report a queued press down before it may be released.
const BUTTON_SAMPLES: u32 = 2;
/// Readings that report a click's new position with the button still up before the press goes down:
/// the game handles a button edge at the cursor it has before it applies the reading's position, so a
/// press in the same reading as the move lands where the cursor was.
const ARM_SAMPLES: u32 = 2;
/// A press no reading ever released is dropped after this, so a stuck button cannot outlive a click by
/// more than a second even when the game stops polling.
const BUTTON_MAX_MS: u64 = 1_000;
/// The most synthetic keys held at once.
const KEY_SLOTS: usize = 8;
/// The most real keys a merge lists.
const REAL_KEYS: usize = 16;

/// What the agent has asked for and what the readings have seen of it.
#[derive(Clone, Copy)]
struct Syn {
    /// A synthetic position is live, at the client pixel [`Syn::x`], [`Syn::y`].
    cursor: bool,
    x: i32,
    y: i32,
    /// When the synthetic position stops being reported.
    until: u64,
    /// When the last synthetic wheel step stops being reported (the offsets themselves stay, because
    /// they are cumulative, but they only make the state "the agent's" while a step is fresh).
    wheel_until: u64,
    /// Queued press bits: down until the hold expires, then released.
    pressed: u32,
    /// Bits the agent holds down explicitly (`hold`).
    held: u32,
    /// When the press was queued.
    queued_at: u64,
    /// When the queued press was first reported down, and how many readings have reported it.
    press_at: u64,
    press_samples: u32,
    /// Readings that must still report the new position, button up, before the queued press goes down
    /// (see [`ARM_SAMPLES`]).
    arm: u32,
    /// Offsets added to the reading's cumulative counters (mouse pixels and wheel units).
    move_x: i64,
    move_y: i64,
    wheel_x: i64,
    wheel_y: i64,
    /// The user's own counters as of the last readable reading (`GetMouseState` answered `true`).
    user_x: i64,
    user_y: i64,
    user_wheel_x: i64,
    user_wheel_y: i64,
    /// A per-axis shift added to the user's counters on every reading: while their input is hidden it is
    /// what holds the reported counters at [`Syn::frozen`], and it is kept after the lock lets go, so the
    /// counters stay continuous across both transitions (the game sees no delta for movement it was not
    /// shown, and the user's movement from the release on).
    shift: [i64; 4],
    /// The counters reported while the user's input is hidden: the last reported ones when hiding began.
    frozen: [i64; 4],
    /// The previous readable reading was hidden, and a readable reading has been seen at all.
    was_hidden: bool,
    seen: bool,
    /// Synthetic keys, in the order they were pressed, and when each was pressed (0 = held until it is
    /// released by [`key`], a stamp = released after [`KEY_HOLD_MS`]).
    keys: [u8; KEY_SLOTS],
    key_since: [u64; KEY_SLOTS],
    key_len: usize,
}

impl Syn {
    const EMPTY: Syn = Syn {
        cursor: false,
        x: 0,
        y: 0,
        until: 0,
        wheel_until: 0,
        pressed: 0,
        held: 0,
        queued_at: 0,
        press_at: 0,
        press_samples: 0,
        arm: 0,
        move_x: 0,
        move_y: 0,
        wheel_x: 0,
        wheel_y: 0,
        user_x: 0,
        user_y: 0,
        user_wheel_x: 0,
        user_wheel_y: 0,
        shift: [0; 4],
        frozen: [0; 4],
        was_hidden: false,
        seen: false,
        keys: [0; KEY_SLOTS],
        key_since: [0; KEY_SLOTS],
        key_len: 0,
    };

    /// The buttons a reading reports now: a queued press only once it is armed.
    fn buttons(&self) -> u32 {
        (if self.arm == 0 { self.pressed } else { 0 }) | self.held
    }

    /// Moves the synthetic position to `x`, `y`, keeping the counters' offset consistent with the
    /// movement so a consumer that subtracts two readings sees one delta.
    fn move_to(&mut self, x: i32, y: i32) {
        if self.cursor {
            self.move_x = self.move_x.saturating_add((x - self.x) as i64);
            self.move_y = self.move_y.saturating_add((y - self.y) as i64);
        }
        self.x = x;
        self.y = y;
        self.cursor = true;
    }

    fn key_down(&mut self, vk: u8, since: u64) {
        for index in 0..self.key_len {
            if self.keys[index] == vk {
                self.key_since[index] = since;
                return;
            }
        }
        if self.key_len < KEY_SLOTS {
            self.keys[self.key_len] = vk;
            self.key_since[self.key_len] = since;
            self.key_len += 1;
        }
    }

    fn key_up(&mut self, vk: u8) {
        let mut write = 0;
        for read in 0..self.key_len {
            if self.keys[read] != vk {
                self.keys[write] = self.keys[read];
                self.key_since[write] = self.key_since[read];
                write += 1;
            }
        }
        self.key_len = write;
    }

    fn keys(&self) -> ([u8; KEY_SLOTS], usize) {
        (self.keys, self.key_len)
    }

    /// Releases the queued presses and keys whose hold is over, and drops a position whose hold is
    /// over.
    fn expire(&mut self, now: u64) {
        if self.pressed != 0 {
            let started = self.press_at != 0;
            let held = started && now >= self.press_at.saturating_add(BUTTON_HOLD_MS) && self.press_samples >= BUTTON_SAMPLES;
            // A press no reading ever took (the game stopped polling) is dropped after the same
            // bound, counted from the request.
            let too_long = if started {
                now >= self.press_at.saturating_add(BUTTON_MAX_MS)
            } else {
                self.queued_at != 0 && now >= self.queued_at.saturating_add(BUTTON_MAX_MS)
            };
            if held || too_long {
                // A reading that saw it down delivered it; one that never came dropped it.
                note_click(if started { CLICK_RELEASED } else { CLICK_DROPPED });
                self.pressed = 0;
                self.press_at = 0;
                self.press_samples = 0;
            }
        }
        let mut index = 0;
        while index < self.key_len {
            let since = self.key_since[index];
            if since != 0 && now >= since.saturating_add(KEY_HOLD_MS) {
                let vk = self.keys[index];
                self.key_up(vk);
                continue;
            }
            index += 1;
        }
        if self.cursor && now >= self.until {
            self.cursor = false;
        }
    }
}

static STATE: SpinLock<Syn> = SpinLock::new(Syn::EMPTY);

/// A mouse button: the wire's `left`/`right` plus the middle one the API also has.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

impl Button {
    fn mask(self) -> u32 {
        match self {
            Button::Left => MOUSE_LEFT,
            Button::Right => MOUSE_RIGHT,
            Button::Middle => MOUSE_MIDDLE,
        }
    }
}

/* ------------------------------------------------------------------------------------------------
 * The engine-facing API
 * ---------------------------------------------------------------------------------------------- */

/// True once at least one interface version validated and its slots are patched: every request below
/// is then applied by the game's own readings, if the game reads through that version.
pub fn ready() -> bool {
    HOOKS.iter().any(|hooks| hooks.status.load(Ordering::Acquire) == PATCHED && hooks.mouse.load(Ordering::Acquire) != 0)
}

/// True once the game has read a mouse state through a hooked interface: only then is a request
/// queued here applied by anything. A runtime can be hooked and still never be asked for the mouse
/// through the version that was patched — 1.26.63.1 creates v0 and calls only v2's vtable, so a hook
/// on v0 alone leaves `readings`, `samples` and every `kinds` count at 0 — and a click queued there
/// stays `pending` forever, so the engines take the message route until this is true.
pub fn mouse_read() -> bool {
    ready() && Hooks::sum(|hooks| &hooks.samples) > 0
}

/// Milliseconds since the game last read the mouse through a hooked interface, `None` before the first
/// reading. A game that stopped polling (its window is not the one with focus, or a fresh launch before
/// the first real input) applies no queued click: the press is dropped after [`BUTTON_MAX_MS`].
pub fn idle_ms() -> Option<u64> {
    let last = LAST_SAMPLE_MS.load(Ordering::Acquire);
    (last != 0).then(|| win::tick_ms().saturating_sub(last))
}

/// Only a queued click moves on: a pressed one is not queued again, a finished one stays finished.
fn note_click(state: u32) {
    let _ = CLICK_STATE.try_update(Ordering::AcqRel, Ordering::Acquire, |current| match (current, state) {
        (CLICK_QUEUED, CLICK_PRESSED | CLICK_DROPPED) | (CLICK_QUEUED | CLICK_PRESSED, CLICK_RELEASED) => Some(state),
        _ => None,
    });
}

/// The last click as `{number, state}`: `queued` (no reading took it yet), `pressed` (a reading saw the
/// button down), `released` (delivered: down, then up), `dropped` (no reading took it within
/// [`BUTTON_MAX_MS`]); `null` before the first click.
pub fn last_click() -> serde_json::Value {
    let state = match CLICK_STATE.load(Ordering::Acquire) {
        CLICK_QUEUED => "queued",
        CLICK_PRESSED => "pressed",
        CLICK_RELEASED => "released",
        CLICK_DROPPED => "dropped",
        _ => return serde_json::Value::Null,
    };
    serde_json::json!({ "number": CLICK_SEQ.load(Ordering::Acquire), "state": state })
}

/// The client area's top-left corner in screen pixels. The engines pass it from the window they send
/// messages to; every coordinate this module takes is a client pixel.
pub fn client_origin(x: i32, y: i32) {
    ORIGIN_X.store(x, Ordering::Release);
    ORIGIN_Y.store(y, Ordering::Release);
}

/// A click at a client pixel: the position is reported for [`POSITION_HOLD_MS`] and the button is held
/// down for at least [`BUTTON_HOLD_MS`], so the consumer's own edge detection sees a press and a
/// release in different readings. Answers whether the request was queued.
pub fn click(x: i32, y: i32, button: Button) -> bool {
    if !ready() {
        return false;
    }
    let pointer = pointer_client();
    let now = win::tick_ms();
    let mut state = STATE.lock();
    // The first request of a session starts where the user's own pointer is: the game's cursor is there
    // too, so the movement the consumer computes is the movement to the requested pixel. With no
    // pointer to read, the request starts at the target itself and moves nothing.
    if !state.cursor {
        if let Some((pointer_x, pointer_y)) = pointer {
            state.x = pointer_x;
            state.y = pointer_y;
            state.cursor = true;
        }
    }
    state.move_to(x, y);
    state.until = now.saturating_add(POSITION_HOLD_MS);
    state.pressed |= button.mask();
    state.queued_at = now;
    state.press_at = 0;
    state.press_samples = 0;
    // The press goes down only after the game has seen the pointer at the target: it handles a button
    // edge at the cursor it already has, before it moves the cursor to the reading's new position, so a
    // move and a press in one reading press wherever the cursor *was* (the target lights up, nothing is
    // pressed).
    state.arm = ARM_SAMPLES;
    drop(state);
    CLICK_SEQ.fetch_add(1, Ordering::AcqRel);
    CLICK_STATE.store(CLICK_QUEUED, Ordering::Release);
    // After the state is queued: the move is what makes the runtime publish a reading for it.
    warp(x, y);
    true
}

/// Moves the synthetic position without pressing anything (hover).
pub fn move_to(x: i32, y: i32) -> bool {
    if !ready() {
        return false;
    }
    let pointer = pointer_client();
    let now = win::tick_ms();
    let mut state = STATE.lock();
    if !state.cursor {
        if let Some((pointer_x, pointer_y)) = pointer {
            state.x = pointer_x;
            state.y = pointer_y;
            state.cursor = true;
        }
    }
    state.move_to(x, y);
    state.until = now.saturating_add(POSITION_HOLD_MS);
    drop(state);
    warp(x, y);
    true
}

/// Wheel notches at a client pixel, positive up. The position is moved there first so the wheel
/// targets the control under the point, exactly as a real wheel does.
pub fn scroll(x: i32, y: i32, notches: i32) -> bool {
    if !ready() || notches == 0 {
        return false;
    }
    if !move_to(x, y) {
        return false;
    }
    let mut state = STATE.lock();
    state.wheel_y = state.wheel_y.saturating_add(notches as i64 * WHEEL_UNITS_PER_NOTCH);
    state.wheel_until = win::tick_ms().saturating_add(POSITION_HOLD_MS);
    true
}

/// One button down or up, with no timer: the in-game click (`input.attack`, `input.use`) uses this,
/// holding the button for as long as its own call asks, and releasing it explicitly.
pub fn hold(button: Button, down: bool) -> bool {
    if !ready() {
        return false;
    }
    let mut state = STATE.lock();
    if down {
        state.held |= button.mask();
    } else {
        state.held &= !button.mask();
    }
    true
}

/// A queued press with no position change: down now, up after the hold.
pub fn press(button: Button) -> bool {
    if !ready() {
        return false;
    }
    let mut state = STATE.lock();
    state.pressed |= button.mask();
    state.queued_at = win::tick_ms();
    state.press_at = 0;
    state.press_samples = 0;
    state.arm = 0;
    true
}

/// A key down or up in the readings, held until it is released with `down = false`. Text is *not*
/// this path: a character reaches a text box as `WM_CHAR`, a message, so `ui.text` stays on the
/// window route.
pub fn key(vk: u8, down: bool) -> bool {
    if !ready() {
        return false;
    }
    let mut state = STATE.lock();
    if down {
        state.key_down(vk, 0);
    } else {
        state.key_up(vk);
    }
    true
}

/// One key press: down now, up after [`KEY_HOLD_MS`].
pub fn press_key(vk: u8) -> bool {
    if !ready() {
        return false;
    }
    let now = win::tick_ms();
    let mut state = STATE.lock();
    state.key_down(vk, now);
    true
}

/// The keys the agent holds, for a caller that reports them.
pub fn held_keys() -> usize {
    STATE.lock().key_len
}

/// The state a caller can report: what is hooked, and what the readings have seen.
pub fn json() -> serde_json::Value {
    let (cursor, keys) = {
        let state = STATE.lock();
        (
            if state.cursor { serde_json::json!([state.x, state.y]) } else { serde_json::Value::Null },
            state.key_len,
        )
    };
    // One entry per interface version a loaded runtime answered or refused, with what the game did
    // through it: the version the game calls is the one whose `readings` and `samples` move.
    let mut versions = alloc::vec::Vec::new();
    for (set, hooks) in HOOKS.iter().enumerate() {
        let status = hooks.status.load(Ordering::Acquire);
        let note = *hooks.note.lock();
        if status == UNTRIED && note.is_empty() {
            continue;
        }
        let layout = &LAYOUTS[set % LAYOUTS.len()];
        versions.push(serde_json::json!({
            "module": MODULE_NAMES[set / LAYOUTS.len()],
            "version": layout.name,
            "iid": layout.text,
            "status": match status { PATCHED => "patched", ABSENT => "absent", _ => "probing" },
            "instance": pointer(hooks.instance.load(Ordering::Acquire)),
            "reading": pointer(hooks.reading.load(Ordering::Acquire)),
            "kinds": {
                "mouse": hooks.asked_mouse.load(Ordering::Acquire),
                "keyboard": hooks.asked_keyboard.load(Ordering::Acquire),
                "other": hooks.asked_other.load(Ordering::Acquire),
            },
            "readings": hooks.readings.load(Ordering::Acquire),
            "callbacks": hooks.callbacks.load(Ordering::Acquire),
            "samples": hooks.samples.load(Ordering::Acquire),
            "synthetic": hooks.synthetic.load(Ordering::Acquire),
            "adopted": hooks.adopted.load(Ordering::Acquire),
            "probe": note,
        }));
    }
    serde_json::json!({
        "hooked": ready(),
        "module": pointer(MODULE.load(Ordering::Acquire)),
        "create": pointer(CREATE.load(Ordering::Acquire)),
        "patched": patched(),
        // The totals over every version; `versions` splits them.
        "samples": Hooks::sum(|hooks| &hooks.samples),
        "synthetic": Hooks::sum(|hooks| &hooks.synthetic),
        "hidden": HIDDEN_SAMPLES.load(Ordering::Acquire),
        "keySamples": KEY_SAMPLES.load(Ordering::Acquire),
        "keys": keys,
        "cursor": cursor,
        // What the game itself asked the API for, and what it read back. `kinds.mouse` above zero with
        // `samples` at zero means the game takes mouse readings but never interprets one as a mouse.
        "kinds": {
            "mouse": Hooks::sum(|hooks| &hooks.asked_mouse),
            "keyboard": Hooks::sum(|hooks| &hooks.asked_keyboard),
            "other": Hooks::sum(|hooks| &hooks.asked_other),
        },
        "readings": Hooks::sum(|hooks| &hooks.readings),
        "idleMs": idle_ms(),
        "lastClick": last_click(),
        "callbacks": Hooks::sum(|hooks| &hooks.callbacks),
        "adopted": Hooks::sum(|hooks| &hooks.adopted),
        "versions": versions,
        // Why the last probe refused, empty once a version is hooked.
        "probe": *PROBE_NOTE.lock(),
    })
}

/// Records why a probe of `set` refused, for the log line and `engine.status.gameinput`. The log line
/// is written on the first refusal and then rarely, as the probe repeats every 500 ms.
fn refused(set: usize, note: &'static str, quiet: bool) {
    *HOOKS[set].note.lock() = note;
    if !ready() {
        *PROBE_NOTE.lock() = note;
    }
    if !quiet {
        log::fmt(format_args!("gameinput: IGameInput {}: {note}", LAYOUTS[set % LAYOUTS.len()].name));
    }
}

fn pointer(value: usize) -> serde_json::Value {
    if value == 0 {
        serde_json::Value::Null
    } else {
        serde_json::Value::String(alloc::format!("0x{value:x}"))
    }
}

/// How many vtable slots are patched right now.
fn patched() -> usize {
    PATCHES.lock().iter().filter(|patch| patch.slot != 0).count()
}

/* ------------------------------------------------------------------------------------------------
 * Per-frame work, from the drain on the client's own thread
 * ---------------------------------------------------------------------------------------------- */

/// Called from the drain every frame: installs the hooks once the game has loaded the module (and keeps
/// trying the interface versions that have not validated yet), adopts reading classes met at run time,
/// and expires the synthetic state.
pub fn frame(core: &'static crate::Core) {
    // Never patch after an unload started: the restore has run or is about to.
    if core.stopping() {
        return;
    }
    let now = win::tick_ms();
    if !SETTLED.load(Ordering::Acquire) && now >= NEXT_TRY_MS.load(Ordering::Acquire) {
        NEXT_TRY_MS.store(now.saturating_add(500), Ordering::Release);
        install();
    }
    if !ready() {
        return;
    }
    for (set, hooks) in HOOKS.iter().enumerate() {
        if hooks.status.load(Ordering::Acquire) != PATCHED {
            continue;
        }
        let pending = hooks.pending.swap(0, Ordering::AcqRel);
        if pending != 0 {
            adopt(set, pending);
        }
    }
    STATE.lock().expire(now);
}

/* ------------------------------------------------------------------------------------------------
 * Installation: find the module, reach every interface version, validate it, patch its slots
 * ---------------------------------------------------------------------------------------------- */

/// Tries every loaded runtime and every interface version not settled yet, at most once per throttle
/// window. Answers whether any version is patched now.
fn install() -> bool {
    let tries = TRIES.fetch_add(1, Ordering::AcqRel) + 1;
    let quiet = !(tries == 1 || tries % 60 == 0);
    let mut loaded = false;
    let mut open = false;
    for (module_index, name) in MODULE_NAMES.iter().enumerate() {
        let Some(module) = module_handle(name) else {
            continue;
        };
        loaded = true;
        if module_settled(module_index) {
            continue;
        }
        let Some((entry, initialize)) = entry_point(module) else {
            if !quiet {
                log::fmt(format_args!("gameinput: {name} at 0x{module:x} exports neither GameInputInitialize nor GameInputCreate"));
            }
            continue;
        };
        if MODULE.load(Ordering::Acquire) == 0 {
            MODULE.store(module, Ordering::Release);
            CREATE.store(entry, Ordering::Release);
        }
        if !install_module(module_index, entry, initialize, quiet) {
            open = true;
        }
    }
    if !loaded && !quiet {
        log::fmt(format_args!("gameinput: the module is not loaded yet (attempt {tries})"));
    }
    if loaded && !open {
        SETTLED.store(true, Ordering::Release);
    }
    if !ready() && loaded && !quiet {
        log::fmt(format_args!(
            "gameinput: not hooked yet, attempt {tries} ({}); retrying every 500 ms",
            *PROBE_NOTE.lock()
        ));
    }
    ready()
}

/// True when every interface version of the runtime at `module_index` is patched or known absent.
fn module_settled(module_index: usize) -> bool {
    (0..LAYOUTS.len()).all(|version| HOOKS[module_index * LAYOUTS.len() + version].status.load(Ordering::Acquire) != UNTRIED)
}

/// The runtimes the game loads, in the order they are tried. The game picks the newer file of
/// `GameInput.dll` (the system copy) and `GameInputRedist.dll` (the redistributable its `Installers/`
/// folder ships) and loads it by full path; both names are looked up, and each loaded one is hooked, so
/// whichever the game picked is covered. `GetModuleHandleW` ignores case, so `gameinput.dll` is the
/// second name too.
const MODULE_NAMES: [&str; 2] = ["GameInputRedist.dll", "GameInput.dll"];

fn module_handle(name: &str) -> Option<usize> {
    let mut wide = [0u16; 32];
    for (index, byte) in name.bytes().enumerate() {
        if index + 1 >= wide.len() {
            break;
        }
        wide[index] = byte as u16;
    }
    // SAFETY: the name is NUL-terminated: the array starts zeroed and the loop stops one short of its end.
    let module = unsafe { win::GetModuleHandleW(wide.as_ptr()) } as usize;
    (module != 0).then_some(module)
}

/// The entry the game itself calls on `module`: `GameInputInitialize` when the runtime exports it (the
/// game asks it for [`IID_V0`]), else `GameInputCreate`. The flag says which one it is.
fn entry_point(module: usize) -> Option<(usize, bool)> {
    // SAFETY: `module` is a loaded image and both names are NUL-terminated.
    let initialize = unsafe { win::GetProcAddress(module as _, c"GameInputInitialize".as_ptr() as *const u8) } as usize;
    if initialize != 0 {
        return Some((initialize, true));
    }
    let create = unsafe { win::GetProcAddress(module as _, c"GameInputCreate".as_ptr() as *const u8) } as usize;
    (create != 0).then_some((create, false))
}

/// Creates an `IGameInput` exactly as the game does, then reaches every interface version through its
/// own `QueryInterface` and patches each one that validates. Answers whether every version of this
/// runtime is settled (patched or absent).
///
/// The runtime keeps one object behind every version, with one vtable per version: the game creates
/// the oldest interface and asks it for the one it uses, so only the vtable of *that* version sees the
/// game's calls. Patching all of them covers whichever the game asks for, each with its own slot table.
fn install_module(module_index: usize, entry: usize, initialize: bool, quiet: bool) -> bool {
    if !executable(entry) {
        refused(module_index * LAYOUTS.len(), "the GameInput entry point is not executable code", quiet);
        return false;
    }
    let mut base = 0usize;
    let hr = if initialize {
        let initialize: unsafe extern "system" fn(*const Guid, *mut usize) -> i32 = unsafe { core::mem::transmute(entry) };
        // SAFETY: the documented entry point, with the IID the game passes and its own out parameter.
        unsafe { initialize(&IID_V0, &mut base) }
    } else {
        let create: unsafe extern "system" fn(*mut usize) -> i32 = unsafe { core::mem::transmute(entry) };
        // SAFETY: the documented entry point, called with its own out parameter.
        unsafe { create(&mut base) }
    };
    if hr < 0 || base == 0 {
        refused(module_index * LAYOUTS.len(), "the GameInput entry point answered an error", quiet);
        if !quiet {
            log::fmt(format_args!("gameinput: the entry point answered 0x{hr:x}"));
        }
        return false;
    }
    let base_vtable = read_slot(base).unwrap_or(0);
    let query = vtable_slot(base_vtable, SLOT_QUERY_INTERFACE);
    if base_vtable == 0 || !executable(query) {
        refused(module_index * LAYOUTS.len(), "the created IGameInput has no QueryInterface", quiet);
        release(base);
        return false;
    }
    let query: QueryInterface = unsafe { core::mem::transmute(query) };
    // Newest first: a runtime that answers several IIDs with one vtable is patched once, with the newest
    // layout that claimed it.
    let mut settled = true;
    for version in (0..LAYOUTS.len()).rev() {
        let set = module_index * LAYOUTS.len() + version;
        let hooks = &HOOKS[set];
        if hooks.status.load(Ordering::Acquire) != UNTRIED {
            continue;
        }
        let layout = &LAYOUTS[version];
        let mut interface = 0usize;
        // SAFETY: `IUnknown::QueryInterface` of the object the runtime just handed out.
        let hr = unsafe { query(base, &layout.iid, &mut interface) };
        if hr < 0 || interface == 0 {
            hooks.status.store(ABSENT, Ordering::Release);
            log::fmt(format_args!("gameinput: {} does not answer IGameInput {} ({})", MODULE_NAMES[module_index], layout.name, layout.text));
            continue;
        }
        let vtable = read_slot(interface).unwrap_or(0);
        if vtable != 0 && HOOKS.iter().enumerate().any(|(other, hooks)| other != set && hooks.instance.load(Ordering::Acquire) == vtable) {
            hooks.status.store(ABSENT, Ordering::Release);
            log::fmt(format_args!(
                "gameinput: IGameInput {} of {} shares the vtable 0x{vtable:x} of another version; not patched twice",
                layout.name, MODULE_NAMES[module_index]
            ));
            release(interface);
            continue;
        }
        let Some(api) = probe(set, interface, quiet) else {
            release(interface);
            settled = false;
            continue;
        };
        hooks.instance.store(api.instance, Ordering::Release);
        hooks.reading.store(api.reading, Ordering::Release);
        if !patch_set(set, &api) {
            log::fmt(format_args!("gameinput: patching IGameInput {} failed; the game's own input is untouched", layout.name));
            restore_set(set);
            release(interface);
            settled = false;
            continue;
        }
        hooks.status.store(PATCHED, Ordering::Release);
        *hooks.note.lock() = "";
        *PROBE_NOTE.lock() = "";
        log::fmt(format_args!(
            "gameinput: hooked IGameInput {} of {} (instance vtable 0x{:x}, reading vtable 0x{:x}, entry 0x{entry:x})",
            layout.name, MODULE_NAMES[module_index], api.instance, api.reading
        ));
        release(interface);
    }
    release(base);
    settled
}

/// The vtables of one validated interface version.
struct Api {
    instance: usize,
    reading: usize,
}

/// Checks that the slots this module patches on `interface` behave as its version's header says, and
/// reads a mouse reading to find its class.
///
/// The check is of the *ABI*, not of live input: every answer below is one the header defines for any
/// reading, so a probe does not need the user to move the mouse first. In particular
/// `IGameInputReading::GetMouseState` answering `false` is a normal, valid answer (it is what this
/// build's runtime gives when no mouse reading has happened yet, and what any runtime gives for a
/// reading that carries no mouse state) — the state must then be zero, which is what the check
/// asserts. What *is* refused is an answer that cannot come from these methods at all: `GetInputKind`
/// outside `GameInputKind`, a `GetKeyCount` that is a pointer rather than a count, a
/// `GetMouseState` that writes a structure which is not a mouse state or past its version's size. A
/// runtime of another ABI fails one of those and this module leaves it alone; the probe is retried for
/// as long as the module is up.
fn probe(set: usize, interface: usize, quiet: bool) -> Option<Api> {
    let layout = &LAYOUTS[set % LAYOUTS.len()];
    let instance_vtable = read_slot(interface).unwrap_or(0);
    if !valid_vtable(instance_vtable, layout.register) {
        refused(set, "the IGameInput vtable is not readable or not code", quiet);
        return None;
    }
    let current = vtable_slot(instance_vtable, SLOT_CURRENT_READING);
    let register = vtable_slot(instance_vtable, layout.register);
    if !executable(current)
        || !executable(vtable_slot(instance_vtable, SLOT_NEXT_READING))
        || !executable(vtable_slot(instance_vtable, SLOT_PREVIOUS_READING))
        || !executable(register)
    {
        refused(set, "the IGameInput reading slots are not executable code", quiet);
        return None;
    }
    let get_current: GetReading = unsafe { core::mem::transmute(current) };
    // A mouse reading is what the merge happens on. `E_NOTFOUND` until the runtime has one is not a
    // failure of the interface: the probe is retried.
    let mut reading = 0usize;
    let hr = unsafe { get_current(interface, KIND_MOUSE, 0, &mut reading) };
    if hr < 0 || reading == 0 {
        refused(set, "GetCurrentReading(Mouse) has no reading yet", quiet);
        return None;
    }
    let reading_vtable = read_slot(reading).unwrap_or(0);
    let last = layout.mouse_state.max(layout.key_state).max(layout.key_count);
    if !valid_vtable(reading_vtable, last) {
        refused(set, "the IGameInputReading vtable is not readable or not code", quiet);
        release(reading);
        return None;
    }
    let kind_slot = vtable_slot(reading_vtable, SLOT_INPUT_KIND);
    let mouse_slot = vtable_slot(reading_vtable, layout.mouse_state);
    let count_slot = vtable_slot(reading_vtable, layout.key_count);
    let state_slot = vtable_slot(reading_vtable, layout.key_state);
    if !executable(kind_slot) || !executable(mouse_slot) || !executable(count_slot) || !executable(state_slot) {
        refused(set, "the reading slots are not executable code", quiet);
        release(reading);
        return None;
    }
    // Every probe call gets a heap scratch buffer for every pointer-sized argument, so a method of a
    // shifted layout writes there instead of through a zero or into this frame.
    let mut scratch = alloc::vec![0u8; 1024];
    // `GetMouseState` first, the one call with a real out pointer: both answers are valid. `true` must
    // have written this version's mouse state (two small bit sets lead the v1/v2 one, a small button set
    // the v0 one) and nothing past it; `false` must have written zeros at most.
    let get_mouse: GetMouseState = unsafe { core::mem::transmute(mouse_slot) };
    let mouse = unsafe { get_mouse(reading, scratch.as_mut_ptr()) };
    let size = layout.mouse_size();
    let past = scratch[size..].iter().any(|byte| *byte != 0);
    let shape_ok = if layout.v0_mouse {
        let state = unsafe { core::ptr::read_unaligned(scratch.as_ptr() as *const MouseStateV0) };
        state.buttons <= 0x7f
    } else {
        let state = unsafe { core::ptr::read_unaligned(scratch.as_ptr() as *const MouseState) };
        state.buttons <= 0x7f && state.positions <= (POSITION_ABSOLUTE | POSITION_RELATIVE)
    };
    if past || (mouse != 0 && !shape_ok) {
        refused(set, "GetMouseState wrote something that is not this version's mouse state", quiet);
        release(reading);
        return None;
    }
    if mouse == 0 && scratch[..size].iter().any(|byte| *byte != 0) {
        refused(set, "GetMouseState answered false but wrote a state", quiet);
        release(reading);
        return None;
    }
    // `GetInputKind()` answers one of a closed set of bits, always. A shifted layout answers a pointer,
    // or an `HRESULT`, and neither is inside that set.
    scratch.iter_mut().for_each(|byte| *byte = 0);
    let kind = unsafe { call_u32(kind_slot, reading, scratch.as_mut_ptr() as usize) };
    if kind & !KNOWN_KINDS != 0 {
        refused(set, "GetInputKind answered something that is not a GameInputKind", quiet);
        log::fmt(format_args!("gameinput: GetInputKind answered 0x{kind:x}"));
        release(reading);
        return None;
    }
    // `GetKeyCount()` is a small count on every reading (0 for a mouse reading).
    let count = unsafe { call_u32(count_slot, reading, scratch.as_mut_ptr() as usize) };
    if count > 64 {
        refused(set, "GetKeyCount answered something that is not a key count", quiet);
        log::fmt(format_args!("gameinput: GetKeyCount answered {count}"));
        release(reading);
        return None;
    }
    log::fmt(format_args!(
        "gameinput: validated IGameInput {} (kind 0x{kind:x}, keys {count}, mouse state {})",
        layout.name,
        if mouse != 0 { "present" } else { "not yet" }
    ));
    release(reading);
    Some(Api { instance: instance_vtable, reading: reading_vtable })
}

/// `GameInputKind` as the headers of every version define it: every bit a kind may have. A value outside
/// this set did not come from `GetInputKind`.
const KNOWN_KINDS: u32 = 0x0000_0001
    | 0x0000_0002
    | 0x0000_0004
    | 0x0000_0008
    | 0x0000_0010
    | 0x0000_0020
    | 0x0000_0040
    | 0x0000_0100
    | 0x0000_1000
    | 0x0001_0000
    | 0x0002_0000
    | 0x0004_0000
    | 0x0008_0000
    | 0x0100_0000;

/// Calls a reading method that takes no argument but `this` and answers a `u32`.
///
/// The extra argument registers are handed a scratch buffer so a method of a shifted layout writes
/// there instead of through a garbage pointer; the documented ones ignore them.
unsafe fn call_u32(slot: usize, this: usize, scratch: usize) -> u32 {
    type U32Method = unsafe extern "system" fn(usize, usize, usize, usize) -> u32;
    let method: U32Method = unsafe { core::mem::transmute(slot) };
    unsafe { method(this, scratch, scratch, 0) }
}

/// The replacement functions of one hook set.
struct Replacements {
    current: usize,
    next: usize,
    previous: usize,
    register: usize,
    mouse: usize,
    key_count: usize,
    key_state: usize,
}

fn replacements_for<const S: usize>() -> Replacements {
    let register = if LAYOUTS[S % LAYOUTS.len()].threshold {
        register_reading_threshold::<S> as *const () as usize
    } else {
        register_reading::<S> as *const () as usize
    };
    Replacements {
        current: current_reading::<S> as *const () as usize,
        next: next_reading::<S> as *const () as usize,
        previous: previous_reading::<S> as *const () as usize,
        register,
        mouse: mouse_state::<S> as *const () as usize,
        key_count: key_count::<S> as *const () as usize,
        key_state: key_state::<S> as *const () as usize,
    }
}

const _: () = assert!(SETS == 6, "replacements() lists one arm per hook set");

fn replacements(set: usize) -> Replacements {
    match set {
        0 => replacements_for::<0>(),
        1 => replacements_for::<1>(),
        2 => replacements_for::<2>(),
        3 => replacements_for::<3>(),
        4 => replacements_for::<4>(),
        _ => replacements_for::<5>(),
    }
}

/// Patches every slot the merge needs on one set. All or nothing: a slot that cannot be patched puts
/// back the ones already written (through [`restore_set`] in [`install_module`]).
fn patch_set(set: usize, api: &Api) -> bool {
    let layout = &LAYOUTS[set % LAYOUTS.len()];
    let hooks = &HOOKS[set];
    let with = replacements(set);
    let mut ok = true;
    ok &= hook_slot(set, api.instance, SLOT_CURRENT_READING, with.current, &hooks.current);
    ok &= hook_slot(set, api.instance, SLOT_NEXT_READING, with.next, &hooks.next);
    ok &= hook_slot(set, api.instance, SLOT_PREVIOUS_READING, with.previous, &hooks.previous);
    ok &= hook_slot(set, api.instance, layout.register, with.register, &hooks.register);
    ok &= hook_slot(set, api.reading, layout.mouse_state, with.mouse, &hooks.mouse);
    ok &= hook_slot(set, api.reading, layout.key_count, with.key_count, &hooks.key_count);
    ok &= hook_slot(set, api.reading, layout.key_state, with.key_state, &hooks.key_state);
    ok
}

/// Patches one slot, remembering its original in `original` and the patch for the unload.
fn hook_slot(set: usize, table: usize, index: usize, replacement: usize, original: &AtomicUsize) -> bool {
    let slot = table + index * 8;
    let Some(current) = read_slot(slot) else {
        log::fmt(format_args!("gameinput: slot 0x{slot:x} is not readable"));
        return false;
    };
    if current == replacement {
        return true;
    }
    // Claim the record first: a slot patched without one could not be restored on unload, and a
    // slot left pointing at this DLL after it is freed is a crash.
    let mut patches = PATCHES.lock();
    let Some(record) = patches.iter_mut().find(|patch| patch.slot == 0) else {
        log::line("gameinput: the patch table is full; not patching");
        return false;
    };
    if !write_slot(slot, replacement) {
        log::fmt(format_args!("gameinput: slot 0x{slot:x} is not writable"));
        return false;
    }
    *record = Patch { slot, original: current, set };
    original.store(current, Ordering::Release);
    true
}

/// Patches a reading class the game obtained that is not the one probed — only when its methods are
/// that same implementation, because the replacements call the probed class's original functions.
fn adopt(set: usize, table: usize) -> bool {
    let layout = &LAYOUTS[set % LAYOUTS.len()];
    let hooks = &HOOKS[set];
    if table == hooks.reading.load(Ordering::Acquire) || !valid_vtable(table, layout.mouse_state.max(layout.key_state)) {
        return false;
    }
    if vtable_slot(table, layout.mouse_state) != hooks.mouse.load(Ordering::Acquire)
        || vtable_slot(table, layout.key_count) != hooks.key_count.load(Ordering::Acquire)
        || vtable_slot(table, layout.key_state) != hooks.key_state.load(Ordering::Acquire)
    {
        log::fmt(format_args!(
            "gameinput: reading class 0x{table:x} of IGameInput {} has its own implementations; not merged",
            layout.name
        ));
        return false;
    }
    let with = replacements(set);
    let mouse = hook_slot(set, table, layout.mouse_state, with.mouse, &hooks.mouse);
    let count = hook_slot(set, table, layout.key_count, with.key_count, &hooks.key_count);
    let state = hook_slot(set, table, layout.key_state, with.key_state, &hooks.key_state);
    if mouse && count && state {
        hooks.adopted.fetch_add(1, Ordering::Relaxed);
        log::fmt(format_args!("gameinput: patched a second reading class of IGameInput {} at 0x{table:x}", layout.name));
        true
    } else {
        false
    }
}

/// Puts the patched slots of the sets `which` selects back, clears their originals, and answers how many
/// were restored.
fn restore_where(which: impl Fn(usize) -> bool) -> usize {
    let mut restored = 0;
    {
        let mut patches = PATCHES.lock();
        for patch in patches.iter_mut() {
            if patch.slot != 0 && which(patch.set) {
                if write_slot(patch.slot, patch.original) {
                    restored += 1;
                }
                *patch = Patch::EMPTY;
            }
        }
    }
    for (set, hooks) in HOOKS.iter().enumerate() {
        if which(set) {
            hooks.clear();
        }
    }
    restored
}

/// Puts one set's patched slots back after a failed patch.
fn restore_set(set: usize) -> usize {
    restore_where(|other| other == set)
}

/// Puts every patched slot back, and returns how many were restored. Called by the unload before this
/// image is freed: a slot left pointing at this DLL is a crash once the DLL is gone.
pub fn restore() -> usize {
    SETTLED.store(true, Ordering::Release);
    restore_where(|_| true)
}

/* ------------------------------------------------------------------------------------------------
 * The replacements, one instantiation per hook set
 * ---------------------------------------------------------------------------------------------- */

/// An original function, or `None` once the unload took it away.
fn original(slot: &AtomicUsize) -> Option<usize> {
    let function = slot.load(Ordering::Acquire);
    (function != 0).then_some(function)
}

/// `IGameInput::GetCurrentReading`: forwards, then remembers the class of the reading it produced.
unsafe extern "system" fn current_reading<const S: usize>(this: usize, kind: u32, device: usize, reading: *mut usize) -> i32 {
    let hooks = &HOOKS[S];
    let Some(function) = original(&hooks.current) else {
        return E_FAIL;
    };
    let function: GetReading = unsafe { core::mem::transmute(function) };
    hooks.note_kind(kind);
    let hr = unsafe { function(this, kind, device, reading) };
    if hr >= 0 && !reading.is_null() {
        hooks.note_reading(unsafe { core::ptr::read_unaligned(reading) });
    }
    hr
}

/// `IGameInput::GetNextReading`: the same pass-through as [`current_reading`].
unsafe extern "system" fn next_reading<const S: usize>(this: usize, reference: usize, kind: u32, device: usize, reading: *mut usize) -> i32 {
    let hooks = &HOOKS[S];
    let Some(function) = original(&hooks.next) else {
        return E_FAIL;
    };
    let function: GetRelativeReading = unsafe { core::mem::transmute(function) };
    hooks.note_kind(kind);
    let hr = unsafe { function(this, reference, kind, device, reading) };
    if hr >= 0 && !reading.is_null() {
        hooks.note_reading(unsafe { core::ptr::read_unaligned(reading) });
    }
    hr
}

/// `IGameInput::GetPreviousReading`: the same pass-through as [`current_reading`].
unsafe extern "system" fn previous_reading<const S: usize>(this: usize, reference: usize, kind: u32, device: usize, reading: *mut usize) -> i32 {
    let hooks = &HOOKS[S];
    let Some(function) = original(&hooks.previous) else {
        return E_FAIL;
    };
    let function: GetRelativeReading = unsafe { core::mem::transmute(function) };
    hooks.note_kind(kind);
    let hr = unsafe { function(this, reference, kind, device, reading) };
    if hr >= 0 && !reading.is_null() {
        hooks.note_reading(unsafe { core::ptr::read_unaligned(reading) });
    }
    hr
}

/// `E_FAIL` (0x80004005), for a replacement whose original was taken away by the unload.
const E_FAIL: i32 = -2147467259;

/// One registration's game callback and context, and the hook set it came through, so the wrapper can
/// hand the reading over unchanged and count it for the right version.
struct Registration {
    callback: AtomicUsize,
    context: AtomicUsize,
    set: AtomicUsize,
    used: AtomicUsize,
}

impl Registration {
    const EMPTY: Registration = Registration {
        callback: AtomicUsize::new(0),
        context: AtomicUsize::new(0),
        set: AtomicUsize::new(0),
        used: AtomicUsize::new(0),
    };
}

const MAX_REGISTRATIONS: usize = 8;
static REGISTRATIONS: [Registration; MAX_REGISTRATIONS] = [Registration::EMPTY; MAX_REGISTRATIONS];

/// The callback the runtime calls for every reading the game registered for: it records the reading's
/// class, then runs the game's own callback with the game's own context. The fourth register is passed
/// through untouched: v0's callback has a `hasOverrunOccurred` flag there, the later ones nothing.
unsafe extern "system" fn reading_wrapper(token: u64, registration: usize, reading: usize, overrun: usize) {
    if registration == 0 {
        return;
    }
    // SAFETY: `registration` is one of `REGISTRATIONS`, handed out by `wrap_registration` below.
    let record = unsafe { &*(registration as *const Registration) };
    if let Some(hooks) = HOOKS.get(record.set.load(Ordering::Acquire)) {
        hooks.callbacks.fetch_add(1, Ordering::Relaxed);
        hooks.note_reading(reading);
    }
    let callback = record.callback.load(Ordering::Acquire);
    if callback == 0 {
        return;
    }
    let game: ReadingCallback = unsafe { core::mem::transmute(callback) };
    let context = record.context.load(Ordering::Acquire);
    unsafe { game(token, context, reading, overrun) };
}

/// `IGameInput::RegisterReadingCallback` (v1 and later): registers the game's callback behind a
/// wrapper that sees each reading first. The wrapper's `context` is this module's record, so the game's
/// own context reaches it exactly as it registered it.
unsafe extern "system" fn register_reading<const S: usize>(
    this: usize,
    device: usize,
    kind: u32,
    context: usize,
    callback: usize,
    token: *mut u64,
) -> i32 {
    let Some(function) = original(&HOOKS[S].register) else {
        return E_FAIL;
    };
    let function: RegisterReading = unsafe { core::mem::transmute(function) };
    let Some(record) = wrap_registration(S, callback, context) else {
        return unsafe { function(this, device, kind, context, callback, token) };
    };
    let hr = unsafe { function(this, device, kind, record as *const Registration as usize, reading_wrapper as *const () as usize, token) };
    if hr < 0 {
        record.used.store(0, Ordering::Release);
    }
    hr
}

/// `IGameInput::RegisterReadingCallback` of v0, which takes an `analogThreshold` float between the kind
/// and the context: the same wrapper as [`register_reading`], the float passed through in its register.
unsafe extern "system" fn register_reading_threshold<const S: usize>(
    this: usize,
    device: usize,
    kind: u32,
    threshold: f32,
    context: usize,
    callback: usize,
    token: *mut u64,
) -> i32 {
    let Some(function) = original(&HOOKS[S].register) else {
        return E_FAIL;
    };
    let function: RegisterReadingThreshold = unsafe { core::mem::transmute(function) };
    let Some(record) = wrap_registration(S, callback, context) else {
        return unsafe { function(this, device, kind, threshold, context, callback, token) };
    };
    let hr = unsafe {
        function(this, device, kind, threshold, record as *const Registration as usize, reading_wrapper as *const () as usize, token)
    };
    if hr < 0 {
        record.used.store(0, Ordering::Release);
    }
    hr
}

/// A free registration record holding the game's callback, or `None` (the callback is then registered
/// unwrapped) when there is no callback or no free record.
fn wrap_registration(set: usize, callback: usize, context: usize) -> Option<&'static Registration> {
    if callback == 0 {
        return None;
    }
    for record in REGISTRATIONS.iter() {
        if record.used.swap(1, Ordering::AcqRel) == 0 {
            record.callback.store(callback, Ordering::Release);
            record.context.store(context, Ordering::Release);
            record.set.store(set, Ordering::Release);
            return Some(record);
        }
    }
    log::line("gameinput: no free registration record; the reading callback is not wrapped");
    None
}

/// `IGameInputReading::GetMouseState`: the merge. Answers the runtime's own verdict, unless the agent
/// has a mouse state to report. A v0 reading has the short state (no absolute position), which is
/// widened for the merge and narrowed back.
unsafe extern "system" fn mouse_state<const S: usize>(this: usize, state: *mut u8) -> u8 {
    let hooks = &HOOKS[S];
    let Some(function) = original(&hooks.mouse) else {
        return 0;
    };
    let function: GetMouseState = unsafe { core::mem::transmute(function) };
    let ok = unsafe { function(this, state) };
    if state.is_null() {
        return ok;
    }
    let now = win::tick_ms();
    hooks.samples.fetch_add(1, Ordering::Relaxed);
    LAST_SAMPLE_MS.store(now, Ordering::Release);
    let (answer, synthetic) = if LAYOUTS[S % LAYOUTS.len()].v0_mouse {
        // SAFETY: the caller passes an out pointer to a v0 `GameInputMouseState`, which `MouseStateV0` is.
        let short = unsafe { core::ptr::read_unaligned(state as *const MouseStateV0) };
        let mut wide = MouseState {
            buttons: short.buttons,
            positions: POSITION_RELATIVE,
            position_x: short.position_x,
            position_y: short.position_y,
            absolute_x: 0,
            absolute_y: 0,
            wheel_x: short.wheel_x,
            wheel_y: short.wheel_y,
        };
        let merged = unsafe { merge_mouse(&mut wide, ok, now) };
        if merged.0 {
            let short = MouseStateV0 {
                buttons: wide.buttons,
                _pad: 0,
                position_x: wide.position_x,
                position_y: wide.position_y,
                wheel_x: wide.wheel_x,
                wheel_y: wide.wheel_y,
            };
            unsafe { core::ptr::write_unaligned(state as *mut MouseStateV0, short) };
        }
        merged
    } else {
        // SAFETY: the caller passes an out pointer to a `GameInputMouseState`, which `MouseState` is.
        unsafe { merge_mouse(&mut *(state as *mut MouseState), ok, now) }
    };
    if synthetic {
        hooks.synthetic.fetch_add(1, Ordering::Relaxed);
    }
    answer as u8
}

/// `IGameInputReading::GetKeyCount`: the real count plus the synthetic keys the real reading does not
/// already list — or only the synthetic ones while the user's input is hidden.
unsafe extern "system" fn key_count<const S: usize>(this: usize) -> u32 {
    let hooks = &HOOKS[S];
    let Some(function) = original(&hooks.key_count) else {
        return 0;
    };
    let function: GetKeyCount = unsafe { core::mem::transmute(function) };
    let real = unsafe { function(this) };
    if !merging_keys() {
        return real;
    }
    let hide = hiding();
    let (wanted, wanted_len) = {
        let mut state = STATE.lock();
        state.expire(win::tick_ms());
        state.keys()
    };
    if wanted_len == 0 && !hide {
        return real;
    }
    let listed = real_keys(hooks, this, hide);
    let mut extra = 0u32;
    for index in 0..wanted_len {
        if !listed[..].iter().any(|entry| entry.virtual_key == wanted[index]) {
            extra += 1;
        }
    }
    if hide { extra } else { real + extra }
}

/// `IGameInputReading::GetKeyState`: the real keys (none while hidden) with the synthetic keys the real
/// reading does not already list appended.
unsafe extern "system" fn key_state<const S: usize>(this: usize, count: u32, array: *mut KeyState) -> u32 {
    let hooks = &HOOKS[S];
    let Some(function) = original(&hooks.key_state) else {
        return 0;
    };
    let function: GetKeyState = unsafe { core::mem::transmute(function) };
    if array.is_null() || count == 0 || !merging_keys() {
        return unsafe { function(this, count, array) };
    }
    let hide = hiding();
    let (wanted, wanted_len) = {
        let mut state = STATE.lock();
        state.expire(win::tick_ms());
        state.keys()
    };
    if wanted_len == 0 && !hide {
        return unsafe { function(this, count, array) };
    }
    let real = unsafe { function(this, count, array) };
    // The array now holds up to `count` real entries; rewrite it as the merged list.
    let real = (real as usize).min(count as usize).min(REAL_KEYS);
    let have = if hide { 0 } else { real };
    let mut entries = [KeyState::EMPTY; REAL_KEYS];
    unsafe {
        for index in 0..have {
            entries[index] = core::ptr::read_unaligned(array.add(index));
        }
    }
    let capacity = (count as usize).min(REAL_KEYS);
    let mut length = have;
    for index in 0..wanted_len {
        if length >= capacity {
            break;
        }
        if !entries[..length].iter().any(|entry| entry.virtual_key == wanted[index]) {
            entries[length] = KeyState {
                scan_code: 0,
                code_point: 0,
                virtual_key: wanted[index],
                is_dead_key: 0,
                _pad: [0; 2],
            };
            length += 1;
        }
    }
    unsafe {
        for index in 0..length {
            core::ptr::write_unaligned(array.add(index), entries[index]);
        }
    }
    KEY_SAMPLES.fetch_add(1, Ordering::Relaxed);
    length as u32
}

/// True when the agent has keys to merge or the user's own must be hidden.
fn merging_keys() -> bool {
    hiding() || STATE.lock().key_len != 0
}

/// The keys the real reading lists (none while the user's input is hidden), through the set's originals.
fn real_keys(hooks: &Hooks, this: usize, hide: bool) -> [KeyState; REAL_KEYS] {
    let mut list = [KeyState::EMPTY; REAL_KEYS];
    if hide {
        return list;
    }
    let state_slot = hooks.key_state.load(Ordering::Acquire);
    let count_slot = hooks.key_count.load(Ordering::Acquire);
    if !executable(state_slot) || !executable(count_slot) {
        return list;
    }
    let get_count: GetKeyCount = unsafe { core::mem::transmute(count_slot) };
    let get_state: GetKeyState = unsafe { core::mem::transmute(state_slot) };
    let count = unsafe { get_count(this) }.min(REAL_KEYS as u32);
    if count == 0 {
        return list;
    }
    let read = unsafe { get_state(this, count, list.as_mut_ptr()) }.min(count);
    if (read as usize) < REAL_KEYS {
        for entry in list.iter_mut().skip(read as usize) {
            *entry = KeyState::EMPTY;
        }
    }
    list
}

/* ------------------------------------------------------------------------------------------------
 * The merge
 * ---------------------------------------------------------------------------------------------- */

/// True while the user's own input must not reach the game: the lock is on and the user has not taken
/// over with F9.
fn hiding() -> bool {
    lock::on() && !lock::user_has_control()
}

/// Merges the agent's state into one mouse state and answers what the caller should return, and
/// whether the state now carries the agent's input (or hides the user's).
///
/// `ok` is the runtime's own verdict for this reading. A reading that is not a mouse reading is left
/// alone unless the agent has nothing to inject at all.
unsafe fn merge_mouse(state: &mut MouseState, ok: u8, now: u64) -> (bool, bool) {
    let hide = hiding();
    let synthetic = {
        let mut probe = STATE.lock();
        probe.expire(now);
        // A wheel step marks the state only while it is fresh: the offsets themselves are cumulative and
        // stay for the rest of the session, so they cannot be the test.
        probe.cursor || probe.buttons() != 0 || now < probe.wheel_until
    };
    // With nothing of the agent's to report, the runtime's verdict stands. With something to report it
    // must be `true`: a runtime answers `false` for a reading whose mouse state has not been filled yet
    // (this build does, whenever no mouse event has happened), and dropping our state there is exactly
    // why a click would go nowhere.
    let mut agent = STATE.lock();
    // The user's counters are tracked on every readable reading, hidden or not, before anything returns
    // early: a stale copy is exactly what made the camera jump when the lock engaged.
    if ok != 0 {
        let real = [state.position_x, state.position_y, state.wheel_x, state.wheel_y];
        if hide {
            if !agent.was_hidden {
                // Hiding begins: freeze at what the game was last shown.
                let last = if agent.seen { [agent.user_x, agent.user_y, agent.user_wheel_x, agent.user_wheel_y] } else { real };
                agent.frozen = [0, 1, 2, 3].map(|axis| last[axis].saturating_add(agent.shift[axis]));
                agent.was_hidden = true;
            }
            agent.shift = [0, 1, 2, 3].map(|axis| agent.frozen[axis].saturating_sub(real[axis]));
        } else {
            agent.was_hidden = false;
        }
        agent.user_x = real[0];
        agent.user_y = real[1];
        agent.user_wheel_x = real[2];
        agent.user_wheel_y = real[3];
        agent.seen = true;
    }
    // The offsets (the agent's own, and the shift that hides the user's movement) are cumulative and stay
    // on every reading once set: a reading without them would make the counters jump by the whole
    // movement, which the game reads as one huge delta — after a click on Resume, a look at the sky.
    let offset = agent.move_x != 0 || agent.move_y != 0 || agent.wheel_x != 0 || agent.wheel_y != 0 || agent.shift != [0; 4];
    // A reading the runtime answered `false` for holds no counters to offset.
    if !synthetic && !hide && (!offset || ok == 0) {
        return (ok != 0, false);
    }
    // Hidden: the frozen counters (also for a reading with no counters of its own). Otherwise the user's
    // counters plus the shift the last hiding left.
    let (base_x, base_y, base_wheel_x, base_wheel_y, base_buttons) = if hide {
        let user = [agent.user_x, agent.user_y, agent.user_wheel_x, agent.user_wheel_y];
        let frozen = if agent.was_hidden { agent.frozen } else { [0, 1, 2, 3].map(|axis| user[axis].saturating_add(agent.shift[axis])) };
        (frozen[0], frozen[1], frozen[2], frozen[3], 0u32)
    } else {
        (
            state.position_x.saturating_add(agent.shift[0]),
            state.position_y.saturating_add(agent.shift[1]),
            state.wheel_x.saturating_add(agent.shift[2]),
            state.wheel_y.saturating_add(agent.shift[3]),
            state.buttons,
        )
    };
    // A press queued with a move waits until the move has been reported: those readings carry the new
    // position with the button still up.
    if agent.pressed != 0 && agent.arm > 0 {
        agent.arm -= 1;
    } else if agent.pressed != 0 {
        // The reading decides when a queued press may be released: it is the sample that saw it down.
        if agent.press_at == 0 {
            agent.press_at = now;
            agent.press_samples = 0;
            note_click(CLICK_PRESSED);
        }
        agent.press_samples = agent.press_samples.saturating_add(1);
        let held = now >= agent.press_at.saturating_add(BUTTON_HOLD_MS) && agent.press_samples >= BUTTON_SAMPLES;
        let too_long = now >= agent.press_at.saturating_add(BUTTON_MAX_MS);
        if held || too_long {
            // Seen down by the game either way: a press that outlived its hold was still delivered.
            note_click(CLICK_RELEASED);
            agent.pressed = 0;
            agent.press_at = 0;
            agent.press_samples = 0;
        }
    }
    let live = agent.cursor && now < agent.until;
    state.position_x = base_x.saturating_add(agent.move_x);
    state.position_y = base_y.saturating_add(agent.move_y);
    state.wheel_x = base_wheel_x.saturating_add(agent.wheel_x);
    state.wheel_y = base_wheel_y.saturating_add(agent.wheel_y);
    state.buttons = base_buttons | agent.buttons();
    if live {
        // The absolute pair is a screen pixel, which is what the runtime fills in from the OS pointer;
        // the flag is what tells a consumer the pair may be read.
        state.positions |= POSITION_ABSOLUTE;
        state.absolute_x = ORIGIN_X.load(Ordering::Acquire) as i64 + agent.x as i64;
        state.absolute_y = ORIGIN_Y.load(Ordering::Acquire) as i64 + agent.y as i64;
        if state.positions & POSITION_RELATIVE == 0 {
            state.positions |= POSITION_RELATIVE;
        }
    }
    if hide {
        HIDDEN_SAMPLES.fetch_add(1, Ordering::Relaxed);
    }
    // A reading that only carries the offsets keeps the runtime's verdict.
    (ok != 0 || synthetic || hide, live || agent.buttons() != 0 || hide)
}

/// Moves the OS pointer to a client pixel, while the input lock is on.
///
/// The runtime only publishes a mouse reading when the device reports something, and a client that
/// walks readings with `GetNextReading` (instead of polling `GetCurrentReading`) sees nothing until one
/// arrives. Moving the real pointer gives it an event to report, and leaves the runtime's own absolute
/// position equal to the one this module merges — so a consumer that reads either agrees on where the
/// cursor is. It is gated on [`crate::lock::on`]: with the lock off the user still owns the pointer and
/// the agent does not move it.
fn warp(x: i32, y: i32) {
    if !lock::on() {
        return;
    }
    // SAFETY: no state is involved; a refused warp (gamescope, a locked session) is ignored.
    unsafe {
        SetCursorPos(ORIGIN_X.load(Ordering::Acquire) + x, ORIGIN_Y.load(Ordering::Acquire) + y);
    }
}

/// The OS pointer in client pixels: where the game's own cursor is before the agent moves it, when it
/// can be read.
fn pointer_client() -> Option<(i32, i32)> {
    let mut point = [0i32; 2];
    // SAFETY: `point` is a `POINT` (two `LONG`s).
    let ok = unsafe { GetCursorPos(point.as_mut_ptr()) };
    if ok == 0 {
        return None;
    }
    Some((point[0] - ORIGIN_X.load(Ordering::Acquire), point[1] - ORIGIN_Y.load(Ordering::Acquire)))
}

/* ------------------------------------------------------------------------------------------------
 * Memory: vtable slots, module memory
 * ---------------------------------------------------------------------------------------------- */

fn read_slot(slot: usize) -> Option<usize> {
    if !win::readable(slot, 8) {
        return None;
    }
    Some(unsafe { core::ptr::read_volatile(slot as *const usize) })
}

/// Writes one vtable pointer, making its page writable for the store and restoring the protection
/// afterwards. Answers whether the store happened.
fn write_slot(slot: usize, value: usize) -> bool {
    if slot == 0 || !win::readable(slot, 8) {
        return false;
    }
    let page = slot & !0xfff;
    let mut old = 0u32;
    // SAFETY: the slot is inside a mapped image (checked above), and the page is committed.
    unsafe {
        if win::VirtualProtect(page as *mut c_void, 0x1000, win::PAGE_READWRITE, &mut old) == 0 {
            return false;
        }
        core::ptr::write_volatile(slot as *mut usize, value);
        let mut ignored = 0u32;
        win::VirtualProtect(page as *mut c_void, 0x1000, old, &mut ignored);
    }
    true
}

fn vtable_slot(table: usize, index: usize) -> usize {
    read_slot(table + index * 8).unwrap_or(0)
}

/// A vtable with at least `last` slots, of which the first, `Release` and `last` are executable code.
fn valid_vtable(table: usize, last: usize) -> bool {
    if table == 0 || !win::readable(table, (last + 1) * 8) {
        return false;
    }
    executable(vtable_slot(table, 0)) && executable(vtable_slot(table, SLOT_RELEASE)) && executable(vtable_slot(table, last))
}

/// `IUnknown::Release` on an interface pointer, through its own vtable.
fn release(interface: usize) {
    let Some(vtable) = read_slot(interface) else {
        return;
    };
    let slot = vtable_slot(vtable, SLOT_RELEASE);
    if !executable(slot) {
        return;
    }
    let release: ReleaseFn = unsafe { core::mem::transmute(slot) };
    unsafe { release(interface) };
}

/// True when `address` is committed executable memory: safe to call through a vtable slot.
fn executable(address: usize) -> bool {
    if address < 0x1_0000 {
        return false;
    }
    let Some(info) = win::memory_info(address) else {
        return false;
    };
    let protect = info.protect & !win::PAGE_GUARD;
    protect == win::PAGE_EXECUTE
        || protect == win::PAGE_EXECUTE_READ
        || protect == win::PAGE_EXECUTE_READWRITE
        || protect == win::PAGE_EXECUTE_WRITECOPY
}
