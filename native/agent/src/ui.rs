//! Menus and screens: `ui.screen`, `ui.controls`, `ui.press`, `ui.key`, `ui.text`, `ui.click`,
//! `ui.scroll`.
//!
//! The agent drives the game's own UI from inside the process, so a menu works in the background and on
//! Windows without the foreground. Two mechanisms, both read from live game objects and code shapes:
//!
//! * **The screen stack.** The client keeps its screens as a stack of scene objects; a scene names
//!   itself through its vtable slot `0x1b8` (`std::string*` out in `rdx`, this in `rcx`, exactly how the
//!   game's own `SceneStack::getCurrentSceneName` calls it), and a concrete screen whose own name slot is
//!   a stub is named through `[scene+0x58]` → `controller->vtable[0x588]` → `->vtable[0x28]`. [`stack`]
//!   finds the live stack at runtime — the entry vector at `+0x18`, count at `+0x88`, first active entry
//!   at `+0x90`, entries stride `0x20` with the scene at `+0x08` — from the objects the agent already
//!   holds (`live::known_objects`, the `Minecraft` scene host at `+0x18`, the client instances' stack
//!   slots), then from the image's writable data, and finally from the `SceneStack` vtable itself. An
//!   object is believed to be the stack only when its own name getter answers a screen name; nothing
//!   about the owner is fixed. Two things can hide the screen input reaches. The client has a second
//!   stack of *always active* screens (`toast_screen`, `debug_screen`), whose top is a toast in a world
//!   even while the chat is open: it is recognised by the owner field the game's own
//!   `initPushAlwaysActiveScreen` pushes onto ([`always_screens`]) and only stands in while the client's
//!   own stack is not found. And a stack counts overlays at its top in `+0x90` (the game's searches skip
//!   that many, its current-scene getter answers entry `count - 1 - [+0x90]`), so [`screen_now`]
//!   reports that current scene. Discovery logs every candidate of a stack class with its verdict.
//! * **The message path.** The game's window procedure is the object that owns the input mappings, so a
//!   `WM_KEYDOWN`/`WM_CHAR`/`WM_MOUSEMOVE`/`WM_MOUSEWHEEL` sent to the window *class* procedure
//!   (`GetClassLongPtrW(hwnd, GCLP_WNDPROC)` through `CallWindowProcW`) reaches the UI, the focus
//!   manager, sliders and text boxes exactly as a real message does, on this thread, in the frame the
//!   request ran. The input lock's window subclass and its raw-input drop are not on that path.
//!
//!   That path is the whole story for a **key** and for **text**, and it is where this module started.
//!   For the **mouse** it is not: the client polls its mouse from GameInput (`GetCurrentReading(Mouse)`
//!   then `GetMouseState` every frame) and its `WM_LBUTTONDOWN` handler returns at once while that
//!   provider is set, so a click goes through [`agent_core::gameinput`] — the API's own vtables, hooked
//!   in the process for every interface version the runtime serves. `ui.click` and `ui.scroll` use
//!   GameInput once the game has read a mouse state through a hooked version (`samples` above zero), and
//!   answer `route: "gameinput"` or `route: "window"` so a caller can see which one carried the
//!   request; `ui.key` and `ui.text` always answer `"window"`. A message-route click holds its button
//!   for [`CLICK_HOLD_MS`]: the game samples the button state once per frame, so a down and an up in
//!   the same frame are no press at all.
//!
//! * **The control tree.** A JSON-UI screen owns one `UIControl` tree; [`screen_view`] reaches it from
//!   the scene's controller (`[scene+0x58]`, vtable slot `0x588`), the root sits at `[view+0x08]` and
//!   a control's children at `+0x98`..`+0xa0` (0x10-byte `shared_ptr`s) — the vector the game's own
//!   tree walks recurse over. Every node is shape-checked, so the walk is proven without a hook.
//!
//! `ui.controls` and `ui.press` still need the `UIControl` field map (name, rect, text, enabled) and the
//! layout writer (`VisualTree::measureControls`), which this build does not have: a reachable tree
//! answers `-32001 ui.control_rect` with its control count, an OreUI/cohtml screen (no JSON-UI
//! controller) answers `-32001 ui.oreui_dom`, and `ui.click` at the pixels of a screenshot remains the
//! way to press any control.
//!
//! # Wiring
//!
//! Every method here runs on the **client main thread** (the window's own thread), so they are all
//! `Thread::Main`:
//!
//! ```text
//! mod ui;
//!
//! Method::main("ui.screen", ui::h_screen),
//! Method::main("ui.controls", ui::h_controls),
//! Method::main("ui.press", ui::h_press),
//! Method::main("ui.key", ui::h_key),
//! Method::main("ui.text", ui::h_text),
//! Method::main("ui.click", ui::h_click),
//! Method::main("ui.scroll", ui::h_scroll),
//! ```
//!
//! and in `Retail::attach`, next to the other recipe passes:
//!
//! ```text
//! anchors.extend(ui::resolve(core));
//! ```
//!
//! which reports `ui.scene_name`, `ui.scene_vtable` and `ui.window`. No hook is installed: a hooked
//! client function is exactly what another mod in the process may detour, so everything here reads
//! objects and sends messages instead.

use alloc::string::String;
use alloc::vec::Vec;
use core::ffi::c_void;
use core::ptr;
use core::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use agent_core::engine::err as codes;
use agent_core::sync::SpinLock;
use agent_core::{gameinput, win, Anchor, Core, RpcError};
use serde_json::{json, Value};

use crate::pe;

/* ------------------------------------------------------------------------------------------------
 * Win32 the message path needs beyond agent-core's surface
 * ---------------------------------------------------------------------------------------------- */

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[link(name = "user32", kind = "raw-dylib")]
extern "system" {
    /// The window class procedure, which a subclass does not replace.
    fn GetClassLongPtrW(window: win::Hwnd, index: i32) -> isize;
    /// The children of the game's window: the OreUI host is one of them, and it is the window a click on
    /// an OreUI button has to reach.
    fn EnumChildWindows(window: win::Hwnd, callback: win::EnumWindowsProc, arg: win::Lparam) -> win::Bool;
    /// Screen pixels to a window's client pixels.
    fn ScreenToClient(window: win::Hwnd, point: *mut Point) -> win::Bool;
    /// A message into a window's queue: the normal path input takes.
    fn PostMessageW(window: win::Hwnd, message: u32, wparam: win::Wparam, lparam: win::Lparam) -> win::Bool;
    /// `MAPVK_VK_TO_VSC`: the scan code the key messages carry in `lParam`.
    fn MapVirtualKeyW(code: u32, map: u32) -> u32;
    /// Client pixels to screen pixels, for `WM_MOUSEWHEEL`'s `lParam`.
    fn ClientToScreen(window: win::Hwnd, point: *mut Point) -> win::Bool;
}

/// `GetClassLongPtrW(hwnd, GCLP_WNDPROC)`.
const GCLP_WNDPROC: i32 = -24;
/// `GetWindowLongPtrW(hwnd, GWLP_USERDATA)`: whatever the game stores on its own window.
const GWLP_USERDATA: i32 = -21;

/* Window messages the UI reads. */
const WM_MOUSEMOVE: u32 = 0x0200;
const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_RBUTTONDOWN: u32 = 0x0204;
const WM_RBUTTONUP: u32 = 0x0205;
const WM_MOUSEWHEEL: u32 = 0x020A;
const WM_CHAR: u32 = 0x0102;
/// `WM_KEYDOWN`/`WM_KEYUP`/`WM_SYSKEYDOWN`/`WM_SYSKEYUP` are `win::WM_*`.

/// Mouse key state bits the message procedures carry in `wParam`.
const MK_LBUTTON: usize = 0x0001;
const MK_RBUTTON: usize = 0x0002;
/// One wheel notch.
const WHEEL_DELTA: i32 = 120;

/// `lParam` bits.
const KEY_EXTENDED: u32 = 1 << 24;
const KEY_CONTEXT: u32 = 1 << 29;
const KEY_PREVIOUS: u32 = 1 << 30;
const KEY_TRANSITION: u32 = 1 << 31;

/* Virtual keys (Win32 values, not game offsets). */
const VK_BACK: u32 = 0x08;
const VK_TAB: u32 = 0x09;
const VK_RETURN: u32 = 0x0D;
const VK_PAUSE: u32 = 0x13;
const VK_CAPITAL: u32 = 0x14;
const VK_ESCAPE: u32 = 0x1B;
const VK_SPACE: u32 = 0x20;
const VK_PRIOR: u32 = 0x21;
const VK_NEXT: u32 = 0x22;
const VK_END: u32 = 0x23;
const VK_HOME: u32 = 0x24;
const VK_LEFT: u32 = 0x25;
const VK_UP: u32 = 0x26;
const VK_RIGHT: u32 = 0x27;
const VK_DOWN: u32 = 0x28;
const VK_SNAPSHOT: u32 = 0x2C;
const VK_INSERT: u32 = 0x2D;
const VK_DELETE: u32 = 0x2E;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;
const VK_APPS: u32 = 0x5D;
const VK_MULTIPLY: u32 = 0x6A;
const VK_ADD: u32 = 0x6B;
const VK_SUBTRACT: u32 = 0x6D;
const VK_DECIMAL: u32 = 0x6E;
const VK_DIVIDE: u32 = 0x6F;
const VK_F1: u32 = 0x70;
const VK_NUMLOCK: u32 = 0x90;
const VK_SCROLL: u32 = 0x91;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
const VK_LMENU: u32 = 0xA4;
const VK_RMENU: u32 = 0xA5;
const VK_OEM_1: u32 = 0xBA;
const VK_OEM_PLUS: u32 = 0xBB;
const VK_OEM_COMMA: u32 = 0xBC;
const VK_OEM_MINUS: u32 = 0xBD;
const VK_OEM_PERIOD: u32 = 0xBE;
const VK_OEM_2: u32 = 0xBF;
const VK_OEM_3: u32 = 0xC0;
const VK_OEM_4: u32 = 0xDB;
const VK_OEM_5: u32 = 0xDC;
const VK_OEM_6: u32 = 0xDD;
const VK_OEM_7: u32 = 0xDE;

/// Longest chord `ui.key` takes: modifiers plus the key itself (the host sends at most four parts).
const CHORD_LIMIT: usize = 4;
/// Longest `ui.text` a single request may type.
const TEXT_LIMIT: usize = 4096;
/// Largest client coordinate a click or a wheel point may name.
const COORD_LIMIT: i32 = 0x7FFF;

/* ------------------------------------------------------------------------------------------------
 * The scene stack: layout, slots and the identity of a scene
 * ---------------------------------------------------------------------------------------------- */

/// `SceneStack` fields (all observed in the game's own stack bodies): the entry vector, the entry count
/// and how many entries at the top are inactive overlays. Entries are `0x20` bytes with the scene's
/// `shared_ptr` at `+0x08`.
const STACK_BEGIN: usize = 0x18;
const STACK_END: usize = 0x20;
const STACK_CAPACITY: usize = 0x28;
const STACK_COUNT: usize = 0x88;
const STACK_FIRST_ACTIVE: usize = 0x90;
const ENTRY_STRIDE: usize = 0x20;
const ENTRY_SCENE: usize = 0x08;
/// `UIControl`'s children: the `std::vector<std::shared_ptr<UIControl>>` the game's own tree walks
/// recurse over — begin at `+0x98`, end at `+0xa0`, one 0x10-byte shared_ptr per element.
const CONTROL_CHILDREN: usize = 0x98;
const CONTROL_CHILDREN_END: usize = 0xa0;
const CONTROL_ELEMENT: usize = 0x10;
/// The root control of a screen: the screen view keeps it as a `shared_ptr` at `+0x08`, the pair the
/// JSON-UI tree builder stores what the per-control create handed back.
const VIEW_ROOT: usize = 0x08;
/// Caps so a wrong object cannot turn the tree walk into a stall (a busy screen has a few hundred).
const MAX_CONTROLS: usize = 1024;
const MAX_CONTROL_DEPTH: usize = 32;
/// Refuse a stack with more entries than this: a wrong candidate should not walk a huge vector.
const MAX_ENTRIES: usize = 64;
/// The offsets this build's client instances hold their stack at. Tried first, never required: the
/// stack is found by its own shape either way.
const CLIENT_STACK_SLOTS: [usize; 2] = [0x5E8, 0x1DF8];
/// `Minecraft + 0x18`: the scene host the game's own push path builds its handle from (`[host + 0x08]`
/// is the object a scene is added to, `[host + 0x10]` its control block), so it is tried directly.
const GAME_SCENE_HOST: usize = 0x18;
const HOST_TARGET: usize = 0x08;
/// How much of an object the chain walk reads looking for the stack: the seeds the agent already holds
/// (a `Minecraft` is a big object) and the objects reached from them.
const SEED_WINDOW: usize = 0x4000;
const OWNER_WINDOW: usize = 0x2000;
/// Bounds so a wrong build cannot turn discovery into a stall.
const MAX_OWNERS: usize = 128;
const MAX_CANDIDATES: usize = 32;
/// How many object-to-object hops the chain walk follows (`.data` → wrapper → client instance → stack).
const MAX_DEPTH: u8 = 3;
/// How many objects one owner may add to the walk: breadth first, so deeper hops are still reached when
/// the shallow objects are many.
const MAX_CHILDREN: usize = 8;
/// Writable memory the vtable scan may read before it gives up.
const VTABLE_SCAN_BUDGET: usize = 512 << 20;

/// The concrete screen's name, as the game's own scene name slot implements it: `[scene + 0x48]` is a
/// guard the game asserts points at a zero byte, `[scene + 0x58]` the screen controller,
/// `controller->vtable[0x588]` the object that names the screen and `->vtable[0x28]` fills the
/// `std::string` with this in `rcx` and the out string in `rdx`.
const SCENE_CONTROLLER_GUARD: usize = 0x48;
const SCENE_CONTROLLER: usize = 0x58;
const CONTROLLER_OWNER_SLOT: usize = 0x588;

/// Scene vtable slots the game itself calls: the flags mask (`0x1b0`, which the stack searches test on
/// every entry) and the name getter (`0x1b8`). Both must be image code for an object to be a scene; a
/// slot a scene leaves to a base class is still a body, so this asks nothing of the rest of the table.
const SCENE_SLOT_FLAGS: usize = 0x1b0;
const SCENE_SLOT_NAME: usize = 0x1b8;
/// `SceneStack`'s own slot for `getCurrentSceneName`. Unlike a scene's name slot this is a call on the
/// validated stack object, the same call the game makes on every screen query.
const STACK_NAME_SLOT: usize = 0x160;

/// The head of `SceneStack::getCurrentSceneName`: `mov rax,[rcx+0x20]; cmp [rcx+0x18],rax`.
const NAME_HEAD: &[u8] = &[0x48, 0x8B, 0x41, 0x20, 0x48, 0x39, 0x41, 0x18];
/// The top entry's scene: `mov rcx,[rax-0x18]` (`end - 0x20 + 0x08`).
const NAME_TOP: &[u8] = &[0x48, 0x8B, 0x48, 0xE8];
/// `mov rax,[rax+0x1b8]`: the slot the name getter sits in.
const NAME_SLOT: &[u8] = &[0x48, 0x8B, 0x80, 0xB8, 0x01, 0x00, 0x00];

/// Screens whose controls the agent never touches. The game names a screen `<package>.<scene>`, so the
/// package decides it: `store_layout.…`, `store_inventory.…`, `csb.…`, `marketplace.…` and the store's
/// auxiliaries all match here, including scenes this build does not know about yet.
const STORE_PACKAGES: &[&str] = &[
    "store",
    "csb",
    "marketplace",
    "minecoins",
    "dressing",
    "portfolio",
    "token_faq",
    "ugc_viewer",
    "persona_emote",
    "day_one_experience",
    "win10_trial_conversion",
    "tabbed_upsell",
    "bundle_purchase_warning",
    "skin_selector",
    "character_creator",
];

/// The live stack, once found (0 while it is not).
static STACK: AtomicUsize = AtomicUsize::new(0);
/// The last discovery attempt, for the rate limit.
static STACK_TRIED: AtomicU64 = AtomicU64::new(0);
/// The name getter resolved from the image: the slot `SceneStack` exposes the current name through.
static SCENE_NAME: AtomicUsize = AtomicUsize::new(0);
/// The `SceneStack` tables this image validated (one, or two `SceneStack`-shaped classes), most likely
/// first. A preference for discovery, never a requirement: an object is believed only when its entries
/// name themselves. The first slot is filled from the found stack when the image resolved none.
static SCENE_TABLES: [AtomicUsize; 2] = [AtomicUsize::new(0), AtomicUsize::new(0)];
/// The owner field that holds the stack of the client's *always active* screens (`toast_screen`,
/// `debug_screen` and one more, pushed once at startup by the function that names itself
/// `initPushAlwaysActiveScreen`), resolved from that function's own loads; 0 while unresolved. That
/// stack is drawn over every screen but takes no input, and in a world its top is a toast even while
/// the chat or the pause menu is open, so discovery takes it only when no other stack names a screen.
static ALWAYS_SLOT: AtomicUsize = AtomicUsize::new(0);
/// The function the slot was read from, for `engine.status`.
static ALWAYS_FUNCTION: AtomicUsize = AtomicUsize::new(0);
/// The always-active stacks discovery has met at [`ALWAYS_SLOT`] of an owner, and those owners (the
/// game object that also holds the client instances).
static ALWAYS_STACKS: [AtomicUsize; 4] = [AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0)];
static ALWAYS_OWNERS: [AtomicUsize; 4] = [AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0)];
/// The client instance's class table and the field its init stores the client's own `SceneStack` in
/// (the in-world screens: HUD, chat, pause), resolved from the image; 0 while unresolved.
static CLIENT_CLASS: AtomicUsize = AtomicUsize::new(0);
static CLIENT_SLOT: AtomicUsize = AtomicUsize::new(0);
/// The client instance whose [`CLIENT_SLOT`] held the stack last taken, and that stack: the router of
/// the in-world screens (Settings from the pause menu) is kept beside it (`+0x5f0` in 1.26.63).
static CLIENT_OWNER: AtomicUsize = AtomicUsize::new(0);
static CLIENT_STACK: AtomicUsize = AtomicUsize::new(0);
/// Bounds of the walk from the main owner to a client instance.
const CLIENT_WALK_DEPTH: u8 = 3;
const CLIENT_WALK_NODES: usize = 4096;
/// Bytes of a node the walk reads: an object (vtable first) is read wide, a container node narrow.
const CLIENT_WALK_OBJECT: usize = 0x2000;
const CLIENT_WALK_NODE: usize = 0x40;
/// While the cached stack is the always-active one, the client's own stack is looked for again this
/// often (passes 1 and 2 only: the table scan is too heavy to repeat on the main thread). Only a request
/// pays for it, never a frame. At 5 s, the first container screen opened after an attach was read
/// through the stand-in's top scene for seconds (live: `screen.craft` / `screen.trade` "keeps no
/// controller" until a close and reopen).
const ALWAYS_RETRY_MS: u64 = 500;
/// Candidate descriptions one discovery run may log.
const MAX_CANDIDATE_LOGS: usize = 40;
/// Candidate lines logged by the current discovery run.
static CANDIDATE_LOGS: AtomicUsize = AtomicUsize::new(0);
/// The game window, once found.
static WINDOW: AtomicUsize = AtomicUsize::new(0);
/// `tick_ms` of the last input this module sent. A screen transition it started frees the scenes the
/// entry vector still names, so no name slot is called for a moment after one.
static INPUT_STAMP: AtomicU64 = AtomicU64::new(0);
/// How long after an input a screen's scenes are left alone.
const QUIET_AFTER_INPUT_MS: u64 = 1_200;


/// A discovery run is at most this often, so a build where the stack cannot be found costs one scan a
/// second and not one per request.
const FIND_INTERVAL_MS: u64 = 1_000;

/// A stack as its own fields describe it.
#[derive(Clone, Copy)]
struct Stack {
    addr: usize,
    begin: usize,
    end: usize,
    count: usize,
    /// How many entries at the top are inactive overlays (`[stack+0x90]`): the game's stack searches skip
    /// that many from the top, and its current scene is entry `count - 1 - first_active`.
    first_active: usize,
}

/// The current screen as `ui.screen` reports it.
struct Screen {
    /// Bottom to top: the current screen, then the overlay on top of it when one covers it.
    names: Vec<String>,
    /// The current screen: the stack's own current scene (below the overlays), named by its own slot.
    top: String,
    /// Overlays sit above the current screen (the stack's `[+0x90]` is not zero).
    modal: bool,
    /// The `SceneStack` the names were read from: an OreUI route belongs to the screen only when its
    /// router routes this stack.
    stack: usize,
}

/* ------------------------------------------------------------------------------------------------
 * Params
 * ---------------------------------------------------------------------------------------------- */

fn text_param<'a>(params: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    match params.get(key) {
        Some(Value::String(text)) => Ok(text),
        Some(_) => Err(RpcError::invalid_params(alloc::format!("{key} must be a string"))),
        None => Err(RpcError::invalid_params(alloc::format!("{key} is required"))),
    }
}

fn number_param(params: &Value, key: &str) -> Result<f64, RpcError> {
    match params.get(key) {
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| RpcError::invalid_params(alloc::format!("{key} must be a finite number"))),
        Some(_) => Err(RpcError::invalid_params(alloc::format!("{key} must be a number"))),
        None => Err(RpcError::invalid_params(alloc::format!("{key} is required"))),
    }
}

/// The nearest whole number, without `libm` (this crate has no floating-point library).
fn whole(value: f64) -> f64 {
    if !value.is_finite() || value.abs() >= 1.0e9 {
        return value;
    }
    let truncated = value as i64 as f64;
    if value - truncated >= 0.5 {
        truncated + 1.0
    } else if truncated - value >= 0.5 {
        truncated - 1.0
    } else {
        truncated
    }
}

/// A client pixel coordinate: a whole number from `0` to [`COORD_LIMIT`].
fn coordinate(params: &Value, key: &str) -> Result<i32, RpcError> {
    let value = whole(number_param(params, key)?);
    if value < 0.0 || value > COORD_LIMIT as f64 {
        return Err(RpcError::invalid_params(alloc::format!(
            "{key} must be a client pixel from 0 to {COORD_LIMIT}"
        )));
    }
    Ok(value as i32)
}

/* ------------------------------------------------------------------------------------------------
 * Handlers
 * ---------------------------------------------------------------------------------------------- */

/// `ui.screen` → `{name, stack, modal}`: the screen the game shows and the stack under it, in the game's
/// own names (`start_screen`, `play.play_screen`, `pause.pause_screen`, `hud.hud_screen`).
pub(crate) fn h_screen(_core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    let screen = screen_now()?;
    let mut answer = json!({
        "name": screen.top,
        "stack": screen.names,
        "modal": screen.modal,
    });
    // An OreUI page names itself by its document URL; the route says which page it is (`null` when unread).
    if is_document_url(&screen.top) {
        answer["route"] = json!(crate::route::current_route(screen.stack));
    }
    Ok(answer)
}

/// `ui.controls {filter?}` → the current screen's visible controls.
///
/// The tree is reachable ([`screen_view`] → root → `+0x98` children), but the layout rect — where a
/// `UIControl` keeps its client-pixel rectangle after `VisualTree::measureControls` — is not decoded on
/// this build, so there is nothing truthful to list yet: a name without a rect cannot be pressed and a
/// guessed rect would click in the wrong place. [`control_err`] names the piece this scene is missing.
pub(crate) fn h_controls(_core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    Err(control_err())
}

/// `ui.press {name}` → press a named control through the game's own handler.
///
/// Pressing is a click at the control's rectangle centre (the input path, so the button's own handler
/// runs). The tree is reachable ([`control_count`]) but the layout rect is not decoded on this build,
/// and `ui.click` at the pixels of a screenshot is the supported way until it is.
pub(crate) fn h_press(_core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    Err(control_err())
}

/// `ui.key {key, action?}` → one key or chord (`Escape`, `Return`, `space`, `F3`, `w`, `ctrl+a`) through
/// the game's own window procedure. `action` is `press` (default), `down` or `up`.
pub(crate) fn h_key(_core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let key = text_param(params, "key")?;
    let action = match params.get("action") {
        None | Some(Value::Null) => "press",
        Some(Value::String(action)) if action == "press" => "press",
        Some(Value::String(action)) if action == "down" => "down",
        Some(Value::String(action)) if action == "up" => "up",
        Some(_) => return Err(RpcError::invalid_params("action must be press, down or up")),
    };
    let chord = Chord::parse(key)?;
    // Escape is the game's own "leave this screen" message, so it stays allowed where everything else
    // is refused.
    let input = if chord.is_escape() {
        Input::Escape
    } else if chord.activates() {
        Input::Activate
    } else {
        Input::Other
    };
    let screen = guard(input)?;
    let count = chord.send(action)?;
    // Keys stay on the message route: the game takes its keyboard from the window procedure (that is
    // why `Escape` opens the pause menu) and its GameInput device callback does not ask for keyboard
    // readings, so a synthetic key reading would reach nothing.
    Ok(json!({ "key": key, "action": action, "sent": count, "screen": screen, "route": "window" }))
}

/// `ui.text {text}` → text into the focused text box, one `WM_CHAR` per UTF-16 code unit, which is what
/// a real keystroke produces.
pub(crate) fn h_text(_core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let text = text_param(params, "text")?;
    if text.is_empty() {
        return Err(RpcError::invalid_params("text is empty"));
    }
    let units = text.encode_utf16().count();
    if units > TEXT_LIMIT {
        return Err(RpcError::invalid_params(alloc::format!("text is longer than {TEXT_LIMIT} units")));
    }
    // A space or a line break typed into a page presses its focused control like the key would.
    let input = if text.contains([' ', '\r', '\n']) { Input::Activate } else { Input::Other };
    let screen = guard(input)?;
    let (window, procedure) = window()?;
    for unit in text.encode_utf16() {
        send(window, procedure, WM_CHAR, unit as usize, 1);
    }
    // Text is a character, and a character reaches a text box as `WM_CHAR`: not a GameInput state.
    Ok(json!({ "text": text, "sent": units, "screen": screen, "route": "window" }))
}

/// `ui.click {x, y, button?}` → a click at client pixels, the same frame a screenshot shows.
///
/// The client's mouse is GameInput, not the message queue: a `WM_LBUTTONDOWN` posted to the window
/// procedure moves nothing (a key message does). So the click goes into the API when it is hooked
/// (`route: "gameinput"`, applied by the game's next reading) and the message path is the fallback
/// (`route: "window"`, delivered synchronously).
pub(crate) fn h_click(_core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let x = coordinate(params, "x")?;
    let y = coordinate(params, "y")?;
    let right = match params.get("button") {
        None | Some(Value::Null) => false,
        Some(Value::String(button)) if button == "left" => false,
        Some(Value::String(button)) if button == "right" => true,
        Some(_) => return Err(RpcError::invalid_params("button must be left or right")),
    };
    let screen = guard(Input::Activate)?;
    let (window, procedure) = window()?;
    check_client(window, x, y)?;
    let button = if right { gameinput::Button::Right } else { gameinput::Button::Left };
    if gameinput::mouse_read() {
        // A game that is not reading the mouse now applies nothing: the press would wait out
        // `BUTTON_MAX_MS` and be dropped while the answer said `pending`. Said instead, with the reason.
        let idle = gameinput::idle_ms().unwrap_or(u64::MAX);
        if idle > CLICK_IDLE_MS {
            return Err(RpcError::anchor("ui.click_input").with_data(json!({
                "message": "the game is not reading the mouse right now (its window is not focused, or it has not polled since launch), so a click would be dropped; focus the game window or move the real mouse over it once, then retry",
                "idleMs": if idle == u64::MAX { Value::Null } else { Value::from(idle) },
                "screen": screen,
                "previousClick": gameinput::last_click(),
            })));
        }
        if let Some(origin) = client_origin(window) {
            gameinput::client_origin(origin.0, origin.1);
            // What became of the click before this one (`released` = delivered, `dropped` = never read).
            let previous = gameinput::last_click();
            if gameinput::click(x, y, button) {
                return Ok(json!({
                    "x": x,
                    "y": y,
                    "button": if right { "right" } else { "left" },
                    "screen": screen,
                    "route": "gameinput",
                    // The game applies it when it next reads; the request itself is queued.
                    // `engine.status.gameinput.lastClick` follows it to `released` or `dropped`.
                    "pending": true,
                    "previousClick": previous,
                }));
            }
        }
    }
    // A JSON-UI screen is drawn and hit-tested by the game's own window procedure, which is the route
    // that has always worked for it. An OreUI screen is a hosted view in a child window (a WinAppSDK
    // content island, a WebView2/CEF host) whose own procedure hit-tests the button and owns the
    // coordinates, and the class procedure reaches nothing there — so the child is tried first, and only
    // for a screen with no JSON-UI control tree.
    let hosted = screen_view().is_none();
    let via = match host_window(window) {
        Some(host) if hosted && click_child(window, host, x, y, right) => "child",
        _ => {
            if !click_class(window, procedure, x, y, right) {
                return Err(RpcError::standard(agent_core::engine::INTERNAL_ERROR)
                    .with_data(json!({ "message": "the game window refused the button-release timer" })));
            }
            "class"
        }
    };
    Ok(json!({
        "x": x,
        "y": y,
        "button": if right { "right" } else { "left" },
        "screen": screen,
        "route": "window",
        "via": via,
    }))
}

/// How long the game may go without reading the mouse before `ui.click` refuses: it reads it every
/// frame while it polls (about 120 readings a second in run 12).
const CLICK_IDLE_MS: u64 = 500;

/// `ui.scroll {x, y, delta}` → wheel notches at a point of the current screen, positive up.
///
/// Like a click the wheel is GameInput when the game reads its mouse there: the reading's `wheelY`
/// accumulates the same deltas a `WM_MOUSEWHEEL` would carry, and the game computes its own delta from
/// two readings. Otherwise it is the wheel message, which is one event and needs no hold.
pub(crate) fn h_scroll(_core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let x = coordinate(params, "x")?;
    let y = coordinate(params, "y")?;
    let notches = whole(number_param(params, "delta")?);
    if notches == 0.0 {
        return Err(RpcError::invalid_params("delta must be a non-zero number of wheel notches"));
    }
    if !(-100.0..=100.0).contains(&notches) {
        return Err(RpcError::invalid_params("delta must be at most 100 wheel notches"));
    }
    let screen = guard(Input::Other)?;
    let (window, procedure) = window()?;
    check_client(window, x, y)?;
    if gameinput::mouse_read() {
        if let Some(origin) = client_origin(window) {
            gameinput::client_origin(origin.0, origin.1);
            if gameinput::scroll(x, y, notches as i32) {
                return Ok(json!({
                    "x": x,
                    "y": y,
                    "delta": notches,
                    "screen": screen,
                    "route": "gameinput",
                    "pending": true,
                }));
            }
        }
    }
    // The wheel's message carries *screen* pixels in `lParam`, so the point is converted first, the same
    // way for the child host and for the class procedure.
    let mut point = Point { x, y };
    // SAFETY: the out pointer is a POINT and the window belongs to this process.
    if unsafe { ClientToScreen(window as win::Hwnd, &mut point) } == 0 {
        // Without the conversion the message would name the wrong control; refuse instead of guessing.
        return Err(RpcError::invalid_params("the window refused client-to-screen conversion"));
    }
    let delta = (notches as i32) * WHEEL_DELTA;
    let wparam = ((delta as u32) & 0xFFFF) << 16;
    let hosted = screen_view().is_none();
    let via = match host_window(window) {
        Some(host) if hosted => {
            // The cursor first, so the control the wheel targets is the one under the point.
            let mut local = Point { x, y };
            let moved = unsafe { ScreenToClient(host as win::Hwnd, &mut local) } != 0;
            let at = if moved { Point { x: local.x, y: local.y } } else { Point { x: point.x, y: point.y } };
            unsafe {
                PostMessageW(host as win::Hwnd, WM_MOUSEMOVE, 0, point_lparam(at.x, at.y));
                PostMessageW(host as win::Hwnd, WM_MOUSEWHEEL, wparam as usize, point_lparam(point.x, point.y));
            }
            "child"
        }
        _ => {
            // The cursor first, so the control the wheel targets is the one under the point.
            send(window, procedure, WM_MOUSEMOVE, 0, point_lparam(x, y));
            send(window, procedure, WM_MOUSEWHEEL, wparam as usize, point_lparam(point.x, point.y));
            "class"
        }
    };
    Ok(json!({ "x": x, "y": y, "delta": notches, "screen": screen, "route": "window", "via": via }))
}

/// The hosted view an OreUI screen draws in, inside the game's window.
///
/// A JSON-UI screen is drawn and hit-tested by the game's own window procedure. An OreUI screen (the
/// Start screen, the Marketplace, the settings screens) is a *hosted* view: a WinAppSDK content island, a
/// WebView2/CEF host or the embedded browser's own window, each with its own `HWND`, its own window
/// procedure and its own client coordinates. A click posted to the game's class procedure never reaches
/// it — the button is hit-tested by that child — so those windows are what a click has to target.
///
/// The child is chosen by class name first (`DesktopChildSiteBridge` for a WinAppSDK island,
/// `Chrome_WidgetWin_*` for CEF/WebView2, the browser's own hosts), then by the largest client area: a
/// screen-sized child *is* the render host whatever its class is called.
fn host_window(window: usize) -> Option<usize> {
    HOST.store(0, Ordering::Release);
    HOST_SCORE.store(-1, Ordering::Release);
    HOST_AREA.store(0, Ordering::Release);
    // SAFETY: the callback has `EnumWindowsProc`'s signature and only reads window state.
    unsafe {
        EnumChildWindows(window as win::Hwnd, collect_host, 0);
    }
    let found = HOST.load(Ordering::Acquire);
    (found != 0).then_some(found)
}

static HOST: AtomicUsize = AtomicUsize::new(0);
static HOST_SCORE: core::sync::atomic::AtomicI64 = core::sync::atomic::AtomicI64::new(-1);
static HOST_AREA: core::sync::atomic::AtomicI64 = core::sync::atomic::AtomicI64::new(0);

/// Classes a hosted view has been seen under, in the GDK client and in WinAppSDK applications.
const HOST_CLASSES: [&str; 6] =
    ["desktopchildsitebridge", "chrome_widgetwin", "webview", "cohtml", "gameface", "contentisland"];

unsafe extern "system" fn collect_host(child: win::Hwnd, _arg: win::Lparam) -> win::Bool {
    let mut name = [0u16; 96];
    // SAFETY: the class-name out buffer and its length agree.
    let len = unsafe { win::GetClassNameW(child, name.as_mut_ptr(), name.len() as i32) };
    if len <= 0 {
        return 1;
    }
    let class = win::narrow(&name[..len as usize]).to_ascii_lowercase();
    let mut rect = win::Rect { left: 0, top: 0, right: 0, bottom: 0 };
    // SAFETY: the out pointer is a RECT and the child belongs to this process.
    if unsafe { win::GetClientRect(child, &mut rect) } == 0 {
        return 1;
    }
    let area = ((rect.right - rect.left) as i64) * ((rect.bottom - rect.top) as i64);
    if area <= 0 {
        return 1;
    }
    let named = HOST_CLASSES.iter().any(|known| class.contains(known));
    let score = if named { 2 } else { 1 };
    let better = score > HOST_SCORE.load(Ordering::Relaxed)
        || (score == HOST_SCORE.load(Ordering::Relaxed) && area > HOST_AREA.load(Ordering::Relaxed));
    if better {
        HOST_SCORE.store(score, Ordering::Relaxed);
        HOST_AREA.store(area, Ordering::Relaxed);
        HOST.store(child as usize, Ordering::Release);
    }
    1
}

/// Posts a click into the hosted view, in its own client pixels.
///
/// `PostMessageW` rather than `CallWindowProcW`: input messages are *posted* — the window's procedure
/// reads them from its thread's queue with the state `GetKeyState` reports, which a direct call does not
/// set up.
fn click_child(window: usize, child: usize, x: i32, y: i32, right: bool) -> bool {
    let mut point = Point { x, y };
    // SAFETY: two `POINT` out pointers on windows of this process.
    unsafe {
        if ClientToScreen(window as win::Hwnd, &mut point) == 0 {
            return false;
        }
        if ScreenToClient(child as win::Hwnd, &mut point) == 0 {
            return false;
        }
        let at = point_lparam(point.x, point.y);
        let (down, up, keys) = if right {
            (WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON)
        } else {
            (WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON)
        };
        PostMessageW(child as win::Hwnd, WM_MOUSEMOVE, 0, at);
        PostMessageW(child as win::Hwnd, down, keys, at);
        PostMessageW(child as win::Hwnd, up, 0, at);
    }
    true
}

/// How long a message-route click keeps its button down. The game's input handler turns the button
/// messages into a state it samples once per frame, so a down and an up delivered in the same frame are
/// no press at all: live on 1.26.63.1 an instantaneous click opened nothing and a held one opened the
/// Play screen.
const CLICK_HOLD_MS: u32 = 150;
/// The release timer's id on the game window. The timer carries a `TimerProc`, so the window procedure
/// never sees its `WM_TIMER`.
const RELEASE_TIMER_ID: usize = 0x0053_4B55;

/// The button-up a held click still owes.
#[derive(Clone, Copy)]
struct Release {
    window: usize,
    procedure: usize,
    message: u32,
    lparam: isize,
}

static RELEASE: SpinLock<Option<Release>> = SpinLock::new(None);
/// The window the release timer runs on, 0 while none does.
static RELEASE_WINDOW: AtomicUsize = AtomicUsize::new(0);

/// A click through the window procedure: the move and the button-down now, the button-up from a timer
/// [`CLICK_HOLD_MS`] later on the window's own thread. Answers false when the timer could not be set,
/// after releasing the button at once so nothing is left held.
fn click_class(window: usize, procedure: usize, x: i32, y: i32, right: bool) -> bool {
    // A click still held is finished first, so two clicks never merge into one long press.
    finish_release();
    let point = point_lparam(x, y);
    let (down, up, keys) = if right {
        (WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON)
    } else {
        (WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON)
    };
    // The move first: it is what gives the control under the cursor its hover state.
    send(window, procedure, WM_MOUSEMOVE, 0, point);
    send(window, procedure, down, keys, point);
    *RELEASE.lock() = Some(Release { window, procedure, message: up, lparam: point });
    // SAFETY: a timer on the game window, created from the window's own thread (every `ui.*` handler
    // runs there), with an id nothing else uses and a `TimerProc`.
    let id = unsafe {
        win::SetTimer(window as win::Hwnd, RELEASE_TIMER_ID, CLICK_HOLD_MS, release_tick as *const () as *mut c_void)
    };
    if id == 0 {
        finish_release();
        return false;
    }
    RELEASE_WINDOW.store(window, Ordering::Release);
    true
}

/// Stops the release timer and sends the button-up a held click owes, on the window's own thread.
fn finish_release() {
    let window = RELEASE_WINDOW.swap(0, Ordering::AcqRel);
    if window != 0 {
        // SAFETY: the timer this module set on that window.
        unsafe {
            win::KillTimer(window as win::Hwnd, RELEASE_TIMER_ID);
        }
    }
    let pending = RELEASE.lock().take();
    if let Some(release) = pending {
        send(release.window, release.procedure, release.message, 0, release.lparam);
    }
}

/// The release timer: one shot.
unsafe extern "system" fn release_tick(_window: win::Hwnd, _message: u32, _id: usize, _time: u32) {
    finish_release();
}

/// `agent.unload`: the release timer's callback is this crate's code, so it must not outlive the image.
/// This runs on the unload thread, where the game's window procedure is not ours to call, so a button
/// still held is released by a *posted* message the window's own thread delivers later.
pub(crate) fn detach() {
    let window = RELEASE_WINDOW.swap(0, Ordering::AcqRel);
    if window != 0 {
        // SAFETY: the timer this module set on that window; a window timer can be killed from any thread
        // of the process that owns the window.
        unsafe {
            win::KillTimer(window as win::Hwnd, RELEASE_TIMER_ID);
        }
    }
    if let Some(release) = RELEASE.lock().take() {
        // SAFETY: a plain message into the queue of a window of this process.
        unsafe {
            PostMessageW(release.window as win::Hwnd, release.message, 0, release.lparam);
        }
    }
}

/// The windows a UI request can be aimed at, for `engine.status`: the game window's class and client size,
/// and the first children with their classes and client sizes. This is what names the OreUI host on a
/// build where the class procedure reaches nothing.
pub(crate) fn windows() -> Value {
    let Ok((window, _)) = window() else {
        return Value::Null;
    };
    COLLECT.lock().clear();
    // SAFETY: the callback has `EnumWindowsProc`'s signature and only reads window state.
    unsafe {
        EnumChildWindows(window as win::Hwnd, collect_all, 0);
    }
    let mut children = Vec::new();
    for (class, width, height) in COLLECT.lock().iter() {
        children.push(json!({ "class": class, "width": width, "height": height }));
    }
    let mut name = [0u16; 96];
    // SAFETY: the out buffer and its length agree.
    let len = unsafe { win::GetClassNameW(window as win::Hwnd, name.as_mut_ptr(), name.len() as i32) };
    let own = if len > 0 { win::narrow(&name[..len as usize]) } else { String::new() };
    let mut rect = win::Rect { left: 0, top: 0, right: 0, bottom: 0 };
    // SAFETY: the out pointer is a RECT.
    unsafe {
        win::GetClientRect(window as win::Hwnd, &mut rect);
    }
    json!({
        "window": { "class": own, "width": rect.right - rect.left, "height": rect.bottom - rect.top },
        "children": children,
        "host": match host_window(window) {
            Some(host) => Value::String(alloc::format!("0x{host:x}")),
            None => Value::Null,
        },
    })
}

/// The children [`windows`] lists, with their client sizes.
static COLLECT: SpinLock<Vec<(String, i32, i32)>> = SpinLock::new(Vec::new());

unsafe extern "system" fn collect_all(child: win::Hwnd, _arg: win::Lparam) -> win::Bool {
    let mut name = [0u16; 96];
    // SAFETY: the out buffer and its length agree.
    let len = unsafe { win::GetClassNameW(child, name.as_mut_ptr(), name.len() as i32) };
    if len <= 0 {
        return 1;
    }
    let mut rect = win::Rect { left: 0, top: 0, right: 0, bottom: 0 };
    // SAFETY: the out pointer is a RECT.
    if unsafe { win::GetClientRect(child, &mut rect) } == 0 {
        return 1;
    }
    let class = win::narrow(&name[..len as usize]);
    let mut list = COLLECT.lock();
    if list.len() < 8 {
        list.push((class, rect.right - rect.left, rect.bottom - rect.top));
    }
    1
}

/// The client area's top-left corner in screen pixels: the space GameInput reports the absolute mouse
/// position in, which is what turns a client-pixel request into the position the game expects.
fn client_origin(window: usize) -> Option<(i32, i32)> {
    let mut point = Point { x: 0, y: 0 };
    // SAFETY: the out pointer is a POINT and the window belongs to this process.
    if unsafe { ClientToScreen(window as win::Hwnd, &mut point) } != 0 {
        Some((point.x, point.y))
    } else {
        None
    }
}

/// `-32001` for the part of `ui.controls`/`ui.press` this build does not have, naming the piece that is
/// actually missing:
///
/// * `ui.oreui_dom` — the scene keeps no JSON-UI screen controller, so its DOM lives in the embedded
///   browser (an OreUI/cohtml screen) and there is no in-process control tree to read;
/// * `ui.control_tree` — a JSON-UI scene whose screen view did not resolve to a readable root control;
/// * `ui.control_rect` — the tree *is* reachable (the count is reported), but the field map that turns a
///   control into `{name, type, rect, text, enabled}` is not decoded on this build.
fn control_err() -> RpcError {
    // A screen this agent cannot read is not "OreUI": report the stack anchor instead of guessing.
    let screen = match screen_now() {
        Ok(screen) => screen,
        Err(error) => return error,
    };
    let scene = Some(screen.top);
    let data = |message: &str, extra: Value| {
        let mut payload = json!({
            "message": message,
            "scene": scene,
            "use": "ui.click at the pixels of a screenshot",
        });
        if let (Some(object), Value::Object(more)) = (payload.as_object_mut(), extra) {
            for (key, value) in more {
                object.insert(key, value);
            }
        }
        payload
    };
    match screen_view() {
        None => RpcError::anchor("ui.oreui_dom").with_data(data(
            "this scene has no in-process JSON-UI control tree (an OreUI/cohtml screen renders its DOM in the embedded browser)",
            json!({}),
        )),
        Some(view) => match control_count(view) {
            None => RpcError::anchor("ui.control_tree").with_data(data(
                "the screen's view did not resolve to a readable root control on this build",
                json!({}),
            )),
            Some(count) => RpcError::anchor("ui.control_rect").with_data(data(
                "the control tree is reachable, but the field map (name, type, client-pixel rect, text, enabled) is not decoded on this build",
                json!({ "controls": count }),
            )),
        },
    }
}

/// What a `ui.*` input does, for [`guard`].
#[derive(Clone, Copy, PartialEq, Eq)]
enum Input {
    /// `Escape`: the game's own "leave this screen" message.
    Escape,
    /// A click, or `Return`/`Space`: it activates whatever is under it or focused.
    Activate,
    /// Text, a scroll, or any other key: it cannot buy, open or confirm anything by itself.
    Other,
}

/// The store guard every input but `Escape` passes through, returning the screen the input went to.
///
/// An input is refused (`-32602`, "store screen") while the stack shows a store, the Marketplace,
/// Minecoins or the Dressing Room anywhere in it, and refused (`-32001 ui.scene_stack`) when the screen
/// cannot be read at all — a screen this agent cannot see is not proven to be a safe one. `Escape` is the
/// exception in both directions: it is the game's own "leave this screen" message, so it is sent even
/// while the store guard is up, and even while the stack cannot be read.
///
/// Every OreUI page names itself by the same document URL (`ui://./hbui/index.html`), so the scene name
/// cannot tell the Play screen from the Marketplace or the Dressing Room. On an OreUI page the guard
/// therefore reads the page's current route ([`crate::route::current_route`]) and applies the store rule
/// to it; a click, `Return` or `Space` is only sent on a route of [`OREUI_ROUTES`], and refused
/// (`-32001 ui.oreui_route`) while the route cannot be read. Fail closed: an unknown page may be a store.
fn guard(input: Input) -> Result<Option<String>, RpcError> {
    // Every `ui.*` input passes here before it is sent: from this moment the screens the game owns may
    // be transitioned, so the entry-name walk stays out of the way for `QUIET_AFTER_INPUT_MS`.
    INPUT_STAMP.store(win::tick_ms(), Ordering::Release);
    if input == Input::Escape {
        return Ok(screen_now().ok().map(|screen| screen.top));
    }
    let screen = screen_now()?;
    if let Some(store) = screen.names.iter().find(|name| is_store_screen(name)) {
        let mut error = RpcError::standard(codes::INVALID_PARAMS);
        error = error.with_data(json!({ "message": "store screen", "screen": store }));
        return Err(error);
    }
    if is_document_url(&screen.top) {
        match crate::route::current_route(screen.stack) {
            Some(route) if is_store_screen(&route) => {
                return Err(RpcError::standard(codes::INVALID_PARAMS)
                    .with_data(json!({ "message": "store screen", "screen": screen.top, "route": route })));
            }
            Some(route) if input == Input::Activate && !oreui_route_allowed(&route) => {
                return Err(RpcError::standard(codes::INVALID_PARAMS).with_data(json!({
                    "message": "this OreUI page is not one the agent clicks on (Play, world, settings pages only); Escape leaves it",
                    "screen": screen.top,
                    "route": route,
                })));
            }
            None if input == Input::Activate => {
                return Err(RpcError::anchor("ui.oreui_route").with_data(json!({
                    "message": "an OreUI page is open and its route cannot be read, so a click, Return or Space is refused (it could be the Marketplace or the Dressing Room); Escape leaves it",
                    "screen": screen.top,
                })));
            }
            _ => {}
        }
    }
    Ok(Some(screen.top))
}

/* ------------------------------------------------------------------------------------------------
 * Reading the screen
 * ---------------------------------------------------------------------------------------------- */

/// The current screen, read from the live stack.
fn screen_now() -> Result<Screen, RpcError> {
    let stack = stack().ok_or_else(|| RpcError::anchor("ui.scene_stack"))?;
    // The **stack's own** name getter names the last entry, and it is the call the game itself makes
    // every time it asks which screen it is on: `this` is a validated `SceneStack`, so the walk to the
    // top entry and that entry's name slot are the game's own accesses.
    let top = stack_name(&stack);
    // With overlays on top (a toast over the chat or the pause menu), the screen input reaches is the
    // stack's own *current scene*, which its own getter hands out with a strong reference: that scene
    // cannot be freed while it is named, unlike a scene this module would reach by walking the vector
    // (a transition frees those for a frame, and calling one is a wild write, not a bad answer).
    if stack.first_active > 0 {
        if let Some(current) = current_name(&stack) {
            let names: Vec<String> = match top {
                Some(top) if top != current => alloc::vec![current.clone(), top],
                _ => alloc::vec![current.clone()],
            };
            return Ok(Screen { names, top: current, modal: true, stack: stack.addr });
        }
    }
    let top = top.ok_or_else(|| RpcError::anchor("ui.scene_name"))?;
    let names: Vec<String> = alloc::vec![top.clone()];
    Ok(Screen { names, top, modal: stack.first_active > 0, stack: stack.addr })
}

/// The stack's current scene — entry `count - 1 - [+0x90]`, below the overlays — named by its own name
/// slot, while the stack's own getter (`SceneStack` slot `0x1b0`) holds a reference to it.
fn current_name(stack: &Stack) -> Option<String> {
    /// `SceneStack::getCurrentScene(std::shared_ptr<Scene>* out)`: the same body as slot `0x1b8`.
    const STACK_CURRENT: usize = 0x1b0;
    let vtable = pe::read::<usize>(stack.addr)?;
    if !pe::in_image_data(vtable) {
        return None;
    }
    let getter = pe::read::<usize>(vtable + STACK_CURRENT)?;
    if !pe::in_image_code(getter) || pe::read::<usize>(vtable + STACK_CURRENT + 8) != Some(getter) {
        return None;
    }
    let mut held = [0usize; 2];
    // SAFETY: a validated `SceneStack` method with the game's own call shape (this, out shared_ptr).
    let call: unsafe extern "system" fn(usize, *mut usize) = unsafe { core::mem::transmute(getter) };
    unsafe { call(stack.addr, held.as_mut_ptr()) };
    let [scene, control] = held;
    let name = (scene != 0 && scene_shape(scene))
        .then(|| pe::read::<usize>(scene).and_then(|table| pe::read::<usize>(table + SCENE_SLOT_NAME)))
        .flatten()
        .filter(|function| pe::in_image_code(*function))
        .and_then(|function| call_string(function, scene))
        .filter(|name| is_screen_name(name));
    release_shared(control);
    name
}

/// Drops the strong reference a getter handed out, the way the game's own `shared_ptr` destructor does:
/// the use count at `+0x08`, then `_Destroy` (control vtable slot 0) and the weak count at `+0x0c`, then
/// `_Delete_this` (slot 1).
fn release_shared(control: usize) {
    use core::sync::atomic::AtomicI32;
    if control < 0x1_0000 || !pe::readable(control, 0x10) {
        return;
    }
    let Some(table) = pe::read::<usize>(control) else {
        return;
    };
    let (Some(destroy), Some(delete)) = (pe::read::<usize>(table), pe::read::<usize>(table + 8)) else {
        return;
    };
    if !pe::in_image_code(destroy) || !pe::in_image_code(delete) {
        return;
    }
    // SAFETY: `+0x08`/`+0x0c` are the control block's use and weak counts, which the game itself updates
    // with locked increments; the getter just incremented the use count for this module.
    let uses = unsafe { &*((control + 8) as *const AtomicI32) };
    if uses.fetch_sub(1, Ordering::AcqRel) != 1 {
        return;
    }
    let method: unsafe extern "system" fn(usize) = unsafe { core::mem::transmute(destroy) };
    unsafe { method(control) };
    let weaks = unsafe { &*((control + 0xc) as *const AtomicI32) };
    if weaks.fetch_sub(1, Ordering::AcqRel) == 1 {
        let method: unsafe extern "system" fn(usize) = unsafe { core::mem::transmute(delete) };
        unsafe { method(control) };
    }
}

/// The stack's current screen name, through `SceneStack`'s own slot `0x160`.
///
/// This is the only virtual call this module makes into the game for a name: `this` is a stack whose
/// every field was just read as a stack, and the game itself makes exactly this call. A scene pointer
/// this module reached by walking the entry vector is **never** called — a screen transition frees
/// scenes, and calling a slot on one of those is how an agent takes the game down.
fn stack_name(stack: &Stack) -> Option<String> {
    let vtable = pe::read::<usize>(stack.addr)?;
    if !pe::in_image_data(vtable) {
        return None;
    }
    let function = pe::read::<usize>(vtable + STACK_NAME_SLOT)?;
    if !pe::in_image_code(function) || pe::read::<usize>(stack.addr + STACK_BEGIN).is_none() {
        return None;
    }
    call_string(function, stack.addr).filter(|name| is_screen_name(name))
}

/// True for a store, Marketplace, Minecoins, Dressing Room or profile/persona editor screen or OreUI route.
fn is_store_screen(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let package = lower.split('.').next().unwrap_or(lower.as_str());
    for prefix in STORE_PACKAGES {
        // `store` itself and every package in its family (`store_layout`, `store_inventory`, …), so a
        // store scene this build does not know about yet is refused without a code change.
        if let Some(rest) = package.strip_prefix(prefix) {
            if rest.is_empty() || rest.starts_with('_') {
                return true;
            }
        }
    }
    // Anywhere in a scene name or a route (`/marketplace/store`, `dressingRoomCoinScreen`,
    // `/oreui-marketplace/…`, a purchase dialog): a false match only refuses input on a harmless screen.
    STORE_WORDS.iter().any(|word| lower.contains(word))
}

/// Words that make any scene name or OreUI route a store screen, matched case-insensitively anywhere.
const STORE_WORDS: &[&str] = &[
    "marketplace",
    "minecoins",
    "coin",
    "store",
    "purchase",
    "dressing",
    "persona",
    "profile_editor",
    "profileeditor",
    "skin_selector",
    "character_creator",
    "upsell",
];

/// OreUI routes where a click, `Return` or `Space` is allowed: the Play screen (world list, create and edit
/// a world) and the settings pages. A route matches as a whole path segment, so `/play` allows
/// `/play/worlds` but not `/player-permissions`.
///
/// In a world, Settings (from the pause menu) is `/oreui-settings/<page>` (read live on 1.26.63.1). Only
/// the option pages are listed; Multiplayer (world broadcast), Party, Account and Global Resources are
/// not, so a click there is refused like any page off the list.
const OREUI_ROUTES: &[&str] = &[
    "/play",
    "/settings",
    "/create-new-world",
    "/edit-world",
    "/oreui-settings/accessibility",
    "/oreui-settings/game",
    "/oreui-settings/keyboard-and-mouse",
    "/oreui-settings/controller",
    "/oreui-settings/touch",
    "/oreui-settings/general",
    "/oreui-settings/video",
    "/oreui-settings/audio",
    "/oreui-settings/creator",
];

fn oreui_route_allowed(route: &str) -> bool {
    let lower = route.to_ascii_lowercase();
    OREUI_ROUTES.iter().any(|allowed| {
        lower
            .strip_prefix(allowed)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/') || rest.starts_with('?') || rest.starts_with('#'))
    })
}

/// The live stack: the cached one while it still checks out, else a fresh discovery.
fn stack() -> Option<Stack> {
    let cached = STACK.load(Ordering::Acquire);
    if cached != 0 {
        // The cached object is still the live stack only while it reads as one *and* still carries a
        // `SceneStack` table: a freed or reused object can keep the shape but is not this class.
        let tables = tables();
        if let Some(stack) = stack_shape(cached) {
            let vtable = pe::read::<usize>(cached).unwrap_or(0);
            if tables == [0, 0] || tables.contains(&vtable) {
                if !is_always(cached) {
                    return Some(stack);
                }
                // The always-active stack is only a stand-in: look for the client's own stack again
                // every few seconds, through the owners (never the table scan), and keep the stand-in
                // until it turns up.
                let now = win::tick_ms();
                if now.saturating_sub(STACK_TRIED.load(Ordering::Relaxed)) < ALWAYS_RETRY_MS {
                    return Some(stack);
                }
                STACK_TRIED.store(now, Ordering::Release);
                CANDIDATE_LOGS.store(0, Ordering::Release);
                let regions = pe::regions();
                let (found, _) = find_from_owners(&regions);
                let Some(found) = found else {
                    return Some(stack);
                };
                STACK.store(found.addr, Ordering::Release);
                log_found(&found);
                return Some(found);
            }
        }
        // A world change or a teardown rebuilt it: find it again.
        STACK.store(0, Ordering::Release);
    }
    let now = win::tick_ms();
    if now.saturating_sub(STACK_TRIED.load(Ordering::Relaxed)) < FIND_INTERVAL_MS {
        return None;
    }
    STACK_TRIED.store(now, Ordering::Release);
    CANDIDATE_LOGS.store(0, Ordering::Release);
    let found = stack_find()?;
    STACK.store(found.addr, Ordering::Release);
    // A stack names its own class: when the image resolved no table (two `SceneStack`-shaped classes, or
    // one this build moved), the table the found object carries is what a later pass scans for.
    let vtable = pe::read::<usize>(found.addr).unwrap_or(0);
    if tables() == [0, 0] && pe::in_image_data(vtable) {
        SCENE_TABLES[0].store(vtable, Ordering::Release);
    }
    log_found(&found);
    Some(found)
}

fn log_found(found: &Stack) {
    agent_core::log::fmt(format_args!(
        "ui: SceneStack at 0x{:x} ({} entries, first active {}, tables {:?}{})",
        found.addr,
        found.count,
        found.first_active,
        tables().map(|table| (table != 0).then(|| alloc::format!("0x{table:x}"))),
        if is_always(found.addr) { "; the always-active stack, standing in until the client's own stack is found" } else { "" }
    ));
}

/// A stack's fields at `addr`, or `None` when they do not describe a stack.
fn stack_shape(addr: usize) -> Option<Stack> {
    if addr < 0x1_0000 {
        return None;
    }
    let begin = pe::read::<usize>(addr + STACK_BEGIN)?;
    let end = pe::read::<usize>(addr + STACK_END)?;
    let capacity = pe::read::<usize>(addr + STACK_CAPACITY)?;
    let count = pe::read::<i32>(addr + STACK_COUNT)?;
    let first_active = pe::read::<i32>(addr + STACK_FIRST_ACTIVE)?;
    shape(addr, begin, end, capacity, count, first_active)
}

/// The same test over fields already read: a non-empty entry vector of `0x20`-byte entries, a count
/// inside the bounds the game's own loops use, and a first-active index inside the count.
///
/// The count and the vector length are checked separately and not required to be equal: the game's own
/// code walks `count` entries of a vector it bounds-checkes against the entries it has, and a build that
/// keeps them a little apart must still be found — the entry names are what prove a candidate.
fn shape(addr: usize, begin: usize, end: usize, capacity: usize, count: i32, first_active: i32) -> Option<Stack> {
    if count < 1 || count as usize > MAX_ENTRIES {
        return None;
    }
    if first_active < 0 || first_active > count {
        return None;
    }
    if begin == 0 || end <= begin || capacity < end {
        return None;
    }
    let span = end - begin;
    if span % ENTRY_STRIDE != 0 {
        return None;
    }
    let entries = span / ENTRY_STRIDE;
    if entries < 1 || entries > MAX_ENTRIES {
        return None;
    }
    Some(Stack { addr, begin, end, count: count as usize, first_active: first_active as usize })
}

/// A scene: a readable object whose vtable is image data and whose flags and name slots are image code.
fn scene_shape(scene: usize) -> bool {
    if scene < 0x1_0000 || !pe::readable(scene, 0x60) {
        return false;
    }
    let Some(vtable) = pe::read::<usize>(scene) else {
        return false;
    };
    if !pe::in_image_data(vtable) {
        return false;
    }
    [SCENE_SLOT_FLAGS, SCENE_SLOT_NAME]
        .iter()
        .all(|slot| pe::read::<usize>(vtable + slot).is_some_and(pe::in_image_code))
}

/// The pointer a virtual method of `object` returns, with a scratch buffer for the out parameter the
/// game's own caller leaves in `rdx` (`controller->vtable[0x588]` returns a `shared_ptr` in `rax`).
fn call_pointer(object: usize, slot: usize) -> Option<usize> {
    let vtable = pe::read::<usize>(object)?;
    if !pe::in_image_data(vtable) {
        return None;
    }
    let function = pe::read::<usize>(vtable + slot)?;
    if !pe::in_image_code(function) {
        return None;
    }
    let mut scratch = [0u8; 32];
    // SAFETY: the function is a validated virtual method of a scene's screen controller, and the call is
    // the one the game's own scene name body makes (`rcx` = the object, `rdx` = the out buffer).
    let call: unsafe extern "system" fn(usize, *mut u8) -> usize = unsafe { core::mem::transmute(function) };
    let pointer = unsafe { call(object, scratch.as_mut_ptr()) };
    (pointer >= 0x1_0000).then_some(pointer)
}

/// A `std::string`-filling function called the way the game calls it: `rcx` = the object, `rdx` = a
/// zeroed 32-byte `std::string` the callee constructs into (nothing else is written).
fn call_string(function: usize, object: usize) -> Option<String> {
    let mut out = [0u8; 32];
    // SAFETY: `function` is a validated scene or screen method; the game calls all of them with these two
    // arguments, and the out object is a `std::string` the callee initialises.
    let call: unsafe extern "system" fn(usize, *mut u8) = unsafe { core::mem::transmute(function) };
    unsafe { call(object, out.as_mut_ptr()) };
    std_string(&out)
}

/// A MSVC `std::string` (buffer at `+0x00`, size at `+0x10`, capacity at `+0x18`) as text.
fn std_string(bytes: &[u8; 32]) -> Option<String> {
    let size = u64::from_ne_bytes(bytes[16..24].try_into().ok()?);
    let capacity = u64::from_ne_bytes(bytes[24..32].try_into().ok()?);
    if size > 96 || capacity < size {
        return None;
    }
    let size = size as usize;
    let text: &[u8] = if capacity < 16 {
        &bytes[..size.min(16)]
    } else {
        let pointer = usize::from_ne_bytes(bytes[..8].try_into().ok()?);
        pe::bytes(pointer, size)?
    };
    if !text.is_ascii() {
        return None;
    }
    core::str::from_utf8(text).ok().map(String::from)
}

/// A scene name as the game writes it: `start_screen`, `hud_screen`, `toast_screen`,
/// `store_layout.store_data_driven_screen`. This build names most scenes **without** the package
/// prefix (the name getter answers `start_screen`), so a bare `<word>_<word>` name is as valid as a
/// dotted one; the underscore is what makes it a scene name rather than any short string a stub
/// hands back.
fn is_screen_name(text: &str) -> bool {
    if text.len() < 3 || text.len() > 96 {
        return false;
    }
    // An OreUI screen is a hosted web page, and this build names it by its **document URL**
    // (`ui://./hbui/index.html` — the Play screen, observed live). It is a real answer from the game's
    // own getter, so it is reported as it is; refusing it is what made `ui.screen` answer `-32001` on
    // every OreUI screen.
    if is_document_url(text) {
        return true;
    }
    let bytes = text.as_bytes();
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    if !(bytes[bytes.len() - 1].is_ascii_lowercase() || bytes[bytes.len() - 1].is_ascii_digit()) {
        return false;
    }
    let mut separator = false;
    for byte in bytes {
        match byte {
            b'.' | b'_' => separator = true,
            b'a'..=b'z' | b'0'..=b'9' | b'-' => {}
            _ => return false,
        }
    }
    separator
}

/// True for an OreUI scene's name: a document URL with a scheme this build uses.
fn is_document_url(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let rest = match lower.strip_prefix("ui://").or_else(|| lower.strip_prefix("coui://")) {
        Some(rest) => rest,
        None => match lower.strip_prefix("https://").or_else(|| lower.strip_prefix("file://")) {
            Some(rest) => rest,
            None => return false,
        },
    };
    !rest.is_empty()
        && rest.len() < 96
        && rest.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'/' | b'_' | b'-' | b':' | b'?' | b'=' | b'&'))
}

/* ------------------------------------------------------------------------------------------------
 * The control tree
 *
 * A JSON-UI screen keeps one `UIControl` tree: the screen view holds the root as a `shared_ptr` at
 * `+0x08`, and every control holds its children at `+0x98`..`+0xa0` (0x10-byte `shared_ptr`s) — the
 * vector the game's own tree walks recurse over. Reading it needs only the scene: `[scene + 0x58]` is
 * the screen controller (guarded by `[scene + 0x48]`, exactly as the game asserts), and its vtable slot
 * `0x588` hands back the view that names the screen and owns the tree.
 *
 * Every object is shape-checked before it is followed, so a wrong offset answers "no tree" instead of
 * walking garbage. The field map inside a control (name, type, client-pixel rect, text, enabled) is
 * still open, which is why the handlers report reachability and refuse the rest.
 * ---------------------------------------------------------------------------------------------- */

/// The scene on top: the last entry of the live stack, the one the game's own name getter reads.
fn top_scene() -> Option<usize> {
    let stack = stack()?;
    if stack.end <= stack.begin {
        return None;
    }
    let scene = pe::read::<usize>(stack.end - ENTRY_STRIDE + ENTRY_SCENE)?;
    // The controller walk below follows the scene's own fields: only a validated scene may be followed.
    scene_shape(scene).then_some(scene)
}

/// The top scene's screen controller, or `None` while the scene is settling, has no controller (an
/// OreUI screen) or does not validate.
///
/// Two scene layouts carry one, each read the way the scene's own name slot (`0x1b8`) reads it:
///
/// * The main stack's scenes keep it at `[scene + 0x58]`, behind a guard at `[scene + 0x48]` that must
///   be a live pointer to a zero byte, as the game's own controller walk asserts.
/// * The client instance's scenes (the in-world screens) forward their name slot to an inner object —
///   `mov rcx,[rcx+inner]; jmp body` — whose body asks the controller it holds for the name:
///   `mov rcx,[rcx+controller]; mov rax,[rcx]; mov rax,[rax+slot]`. The two displacements are read from
///   that code at run time, so the class needs no offsets of its own here.
///
/// A screen the agent just changed the input of may be replacing its scene, and callers follow the
/// controller's own fields and virtual methods, so it waits for the transition to settle.
/// `workstation` reaches an open container screen's model through this controller.
pub(crate) fn screen_controller() -> Option<usize> {
    if win::tick_ms().saturating_sub(INPUT_STAMP.load(Ordering::Acquire)) < QUIET_AFTER_INPUT_MS {
        return None;
    }
    let scene = top_scene()?;
    let guard = pe::read::<usize>(scene + SCENE_CONTROLLER_GUARD).unwrap_or(0);
    if guard >= 0x1_0000 && pe::read::<u8>(guard) == Some(0) {
        if let Some(controller) = pe::read::<usize>(scene + SCENE_CONTROLLER).filter(|controller| *controller >= 0x1_0000) {
            return Some(controller);
        }
    }
    forwarded_controller(scene)
}

/// The controller of a scene whose name slot forwards to an inner object (see [`screen_controller`]):
/// `[[scene + inner] + controller]`, both displacements decoded from the scene's own code, the result an
/// object whose table is image data.
fn forwarded_controller(scene: usize) -> Option<usize> {
    let table = pe::read::<usize>(scene).filter(|table| pe::in_image_data(*table))?;
    let name = pe::read::<usize>(table + SCENE_SLOT_NAME).filter(|function| pe::in_image_code(*function))?;
    let head = pe::bytes(name, 9)?;
    // `mov rcx,[rcx+disp8]` (48 8B 49 d8), then `jmp rel32` (E9).
    if head[..3] != [0x48, 0x8B, 0x49] || head[4] != 0xE9 {
        return None;
    }
    let inner_at = head[3] as usize;
    let rel = i32::from_le_bytes([head[5], head[6], head[7], head[8]]) as isize;
    let body = (name as isize + 9 + rel) as usize;
    if !pe::in_image_code(body) {
        return None;
    }
    let code = pe::bytes(body, 0x100)?;
    // `mov rcx,[rcx+disp8]; mov rax,[rcx]; mov rax,[rax+disp32]`: the virtual call on the controller.
    let controller_at = code.windows(14).find_map(|window| {
        (window[..3] == [0x48, 0x8B, 0x49] && window[4..7] == [0x48, 0x8B, 0x01] && window[7..10] == [0x48, 0x8B, 0x80])
            .then_some(window[3] as usize)
    })?;
    let inner = pe::read::<usize>(scene + inner_at).filter(|inner| *inner >= 0x1_0000)?;
    let controller = pe::read::<usize>(inner + controller_at).filter(|controller| *controller >= 0x1_0000)?;
    pe::read::<usize>(controller).filter(|table| pe::in_image_data(*table))?;
    Some(controller)
}

/// The current screen's view object, or `None` when this scene has no JSON-UI controller.
fn screen_view() -> Option<usize> {
    let controller = screen_controller()?;
    let holder = call_pointer(controller, CONTROLLER_OWNER_SLOT)?;
    pe::read::<usize>(holder)
}

/// Every control in `view`'s tree, counted once, or `None` when the root or a children vector does not
/// read as a control tree.
fn control_count(view: usize) -> Option<usize> {
    let root = pe::read::<usize>(view + VIEW_ROOT)?;
    let mut queue: Vec<(usize, usize)> = alloc::vec![(root, 0usize)];
    let mut seen: Vec<usize> = Vec::new();
    while let Some((control, depth)) = queue.pop() {
        if seen.contains(&control) {
            continue;
        }
        if seen.len() >= MAX_CONTROLS || !control_node(control) {
            return None;
        }
        seen.push(control);
        if depth >= MAX_CONTROL_DEPTH {
            continue;
        }
        for child in control_children(control)? {
            queue.push((child, depth + 1));
        }
    }
    Some(seen.len())
}

/// A control: a readable object whose first qword is a class table in the image.
fn control_node(control: usize) -> bool {
    control >= 0x1_0000
        && pe::readable(control, 0xa8)
        && pe::read::<usize>(control).is_some_and(pe::in_image_data)
}

/// A control's children, from the vector the game's own tree walks recurse over.
fn control_children(control: usize) -> Option<Vec<usize>> {
    let begin = pe::read::<usize>(control + CONTROL_CHILDREN)?;
    let end = pe::read::<usize>(control + CONTROL_CHILDREN_END)?;
    if begin == 0 && end == 0 {
        return Some(Vec::new());
    }
    if begin < 0x1_0000 || end < begin {
        return None;
    }
    let bytes = end - begin;
    if bytes % CONTROL_ELEMENT != 0 || bytes / CONTROL_ELEMENT > MAX_CONTROLS {
        return None;
    }
    let mut out = Vec::with_capacity(bytes / CONTROL_ELEMENT);
    for index in 0..bytes / CONTROL_ELEMENT {
        let child = pe::read::<usize>(begin + index * CONTROL_ELEMENT)?;
        if !control_node(child) {
            return None;
        }
        out.push(child);
    }
    Some(out)
}

/* ------------------------------------------------------------------------------------------------
 * Finding the stack
 *
 * Nothing here may be hooked at startup, and this build does not keep the stack at the offset an owner
 * "should" use, so the object is reached from things the agent already has. Three passes, cheapest
 * first, each answer validated by [`stack_entries`] — every entry a scene, and at least one naming
 * itself `<package>.<scene>`:
 *
 * 1. the chain out of the objects the agent holds: the `Minecraft` objects the simulation was stepped
 *    with (their scene host at `+0x18`, the client instances' `+0x5e8`/`+0x1df8`), their levels and the
 *    server's `LevelData`, following object-to-object pointers [`MAX_DEPTH`] hops;
 * 2. the image's writable data: a global that holds the stack, or a singleton object whose fields hold
 *    the client instance (the same walk, from each);
 * 3. the `SceneStack` table over committed writable memory: a stack object's first qword *is* that
 *    table, so scanning for it finds the stack wherever this build moved it. Only possible once a table
 *    is known — from the image, or learned from the stack pass 1 or 2 found.
 * ---------------------------------------------------------------------------------------------- */

/// The client's screen stack; the always-active stack only when nothing else names a screen.
fn stack_find() -> Option<Stack> {
    let regions = pe::regions();
    let (found, fallback) = find_from_owners(&regions);
    if found.is_some() {
        return found;
    }
    let (found, scanned) = find_by_vtable(&regions);
    if found.is_some() {
        return found;
    }
    if let Some(stack) = fallback.or(scanned) {
        return Some(stack);
    }
    agent_core::log::line("ui: no SceneStack through the client objects, the image's data or the scene table (ui.screen answers -32001)");
    None
}

/// The `SceneStack` tables this image validated, most likely first.
fn tables() -> [usize; 2] {
    [SCENE_TABLES[0].load(Ordering::Acquire), SCENE_TABLES[1].load(Ordering::Acquire)]
}

/// Passes 1 and 2: a breadth-first walk over objects, trying every qword of each as a stack pointer.
/// Answers the client's stack, and the always-active stack met on the way as a stand-in.
fn find_from_owners(regions: &[(usize, usize)]) -> (Option<Stack>, Option<Stack>) {
    let preferred = tables();
    let mut seeds = crate::live::known_objects();
    seeds.extend(data_objects(regions));
    // The window's own user data: the pointer the game stores on the window that owns the client.
    if let Some(window) = Some(WINDOW.load(Ordering::Acquire)).filter(|window| *window != 0).or_else(find_window) {
        // SAFETY: a window query takes no ownership and cannot fault on a stale handle.
        let user = unsafe { win::GetWindowLongPtrW(window as win::Hwnd, GWLP_USERDATA) } as usize;
        if user >= 0x1_0000 {
            seeds.push(user);
        }
    }
    seeds.sort_unstable();
    seeds.dedup();
    // Before any candidate is ranked: every seed that holds the always-active stack names it.
    for owner in &seeds {
        note_always(regions, *owner);
    }
    let mut fallback: Option<Stack> = None;
    // Pass 0: the client instance's own stack. Its owner class is resolved from the image (the class
    // whose virtual init stores a new `SceneStack`); an instance is a seed itself or is reached from the
    // main stack's owner, which holds the client instances.
    if let Some(stack) = client_instance_stack(regions, &seeds) {
        return (Some(stack), fallback);
    }
    // Pass 1: the client's screen stack sits at a fixed offset in the object that owns it
    // (`+0x5e8` or `+0x1df8`), and that object is registered in the image's data. Two reads per seed finds it without walking
    // every field of every object, and the data scan is not bounded by `MAX_OWNERS` — a 9 MB `.data`
    // holds far more singletons than the walk can visit.
    let mut candidates: Vec<usize> = Vec::new();
    for owner in &seeds {
        for slot in CLIENT_STACK_SLOTS {
            if let Some(held) = word_in(regions, owner.saturating_add(slot)) {
                consider(regions, held, &mut candidates);
            }
        }
        if candidates.len() >= MAX_CANDIDATES {
            break;
        }
    }
    let (found, stand_in) = confirm(&candidates, preferred);
    fallback = fallback.or(stand_in);
    if found.is_some() {
        return (found, fallback);
    }
    candidates.clear();
    let mut owners: Vec<(usize, u8)> = seeds.into_iter().map(|address| (address, 0u8)).collect();
    let mut seen: Vec<usize> = Vec::with_capacity(MAX_OWNERS);
    let mut index = 0usize;
    while index < owners.len() && index < MAX_OWNERS {
        let (owner, depth) = owners[index];
        index += 1;
        if seen.contains(&owner) {
            continue;
        }
        seen.push(owner);
        note_always(regions, owner);
        candidates.clear();
        consider(regions, owner, &mut candidates);
        if depth == 0 {
            // The game's push path takes its scene host from the `Minecraft` object's `+0x18`, and the
            // host's `+0x08` is the object the scene is added to.
            if let Some(host) = word_in(regions, owner.saturating_add(GAME_SCENE_HOST)) {
                if let Some(target) = word_in(regions, host.saturating_add(HOST_TARGET)) {
                    consider(regions, target, &mut candidates);
                    follow(regions, target, depth, &mut owners, &seen);
                }
            }
            for slot in CLIENT_STACK_SLOTS {
                if let Some(held) = word_in(regions, owner.saturating_add(slot)) {
                    consider(regions, held, &mut candidates);
                }
            }
        }
        let window = if depth == 0 { SEED_WINDOW } else { OWNER_WINDOW };
        let mut children = 0usize;
        let mut offset = 0usize;
        while offset + 8 <= window && candidates.len() < MAX_CANDIDATES {
            let Some(value) = word_in(regions, owner.saturating_add(offset)) else {
                break;
            };
            offset += 8;
            if value < 0x1_0000 {
                continue;
            }
            consider(regions, value, &mut candidates);
            if children < MAX_CHILDREN && follow(regions, value, depth, &mut owners, &seen) {
                children += 1;
            }
        }
        if candidates.is_empty() {
            continue;
        }
        let (found, stand_in) = confirm(&candidates, preferred);
        fallback = fallback.or(stand_in);
        if found.is_some() {
            return (found, fallback);
        }
    }
    (None, fallback)
}

/// Queues `value` as an owner one hop further when it is an object with a vtable and the depth budget
/// allows it; true when it was queued.
fn follow(regions: &[(usize, usize)], value: usize, depth: u8, owners: &mut Vec<(usize, u8)>, seen: &[usize]) -> bool {
    if depth >= MAX_DEPTH
        || owners.len() >= MAX_OWNERS
        || seen.contains(&value)
        || owners.iter().any(|(queued, _)| *queued == value)
    {
        return false;
    }
    let Some(vtable) = word_in(regions, value) else {
        return false;
    };
    if !pe::in_image_data(vtable) {
        return false;
    }
    owners.push((value, depth + 1));
    true
}

/// The image's writable data as seeds: a global holding the stack, or a singleton object whose fields
/// hold the client instance.
fn data_objects(regions: &[(usize, usize)]) -> Vec<usize> {
    let image = agent_core::image::game();
    let mut out: Vec<usize> = Vec::new();
    for name in [".data", ".tls"] {
        let Some(section) = image.section(name) else {
            continue;
        };
        let Some(bytes) = pe::bytes(section.va, section.len) else {
            continue;
        };
        let mut offset = 0usize;
        while offset + 8 <= bytes.len() {
            // SAFETY: eight bytes inside a readable section.
            let word = unsafe { ptr::read_unaligned(bytes.as_ptr().add(offset) as *const u64) } as usize;
            offset += 8;
            if word < 0x1_0000 {
                continue;
            }
            let Some(vtable) = word_in(regions, word) else {
                continue;
            };
            if pe::in_image_data(vtable) {
                out.push(word);
            }
        }
    }
    // Two globals can name one singleton, and a 9 MB `.data` holds tens of thousands of candidates.
    out.sort_unstable();
    out.dedup();
    out
}

/// Pass 3: every object whose first qword is one of the `SceneStack` tables. Answers the client's stack
/// and the always-active stand-in, like [`find_from_owners`].
fn find_by_vtable(regions: &[(usize, usize)]) -> (Option<Stack>, Option<Stack>) {
    let tables = tables();
    if tables == [0, 0] {
        return (None, None);
    }
    let mut candidates: Vec<usize> = Vec::new();
    let mut scanned = 0usize;
    // The heap that holds the client's objects first, then the small regions (cheap to rule out).
    let known = crate::live::known_objects();
    let mut order: Vec<(usize, usize)> = regions.to_vec();
    order.sort_by_key(|(start, end)| {
        let holds = known.iter().any(|address| *address >= *start && *address < *end);
        (if holds { 0u8 } else { 1 }, *end - *start)
    });
    for (start, end) in order {
        if candidates.len() >= MAX_CANDIDATES || scanned >= VTABLE_SCAN_BUDGET {
            break;
        }
        // The image's own sections cannot hold a stack object, and a read-only region cannot either.
        if end <= start + 0x1000
            || pe::in_image_data(start)
            || pe::in_image_code(start)
            || !pe::writable(start, 8)
        {
            continue;
        }
        let mut at = (start + 7) & !7;
        while at + 8 <= end && scanned < VTABLE_SCAN_BUDGET && candidates.len() < MAX_CANDIDATES {
            let want = (end - at).min(1 << 20) & !7;
            if want == 0 {
                break;
            }
            let Some(chunk) = pe::bytes(at, want) else {
                at += 0x1000;
                continue;
            };
            scanned += want;
            let mut offset = 0usize;
            while offset + 8 <= chunk.len() {
                // SAFETY: eight bytes inside a chunk verified readable.
                let word = unsafe { ptr::read_unaligned(chunk.as_ptr().add(offset) as *const u64) } as usize;
                if tables.contains(&word) {
                    candidates.push(at + offset);
                    if candidates.len() >= MAX_CANDIDATES {
                        break;
                    }
                }
                offset += 8;
            }
            at += want;
        }
    }
    agent_core::log::fmt(format_args!(
        "ui: scene table scan read {} MB, {} object(s)",
        scanned >> 20,
        candidates.len()
    ));
    confirm(&candidates, tables)
}

/// Keeps `candidate` when it is a stack-shaped object: one readable, one deduplicated.
///
/// Every candidate must open with a vtable in image data — that is what makes it an object at all — which
/// also keeps the walk over a several-megabyte data section cheap: a plain pointer to a string or a
/// number is dropped after one read.
fn consider(regions: &[(usize, usize)], candidate: usize, out: &mut Vec<usize>) {
    if candidate < 0x1_0000 || out.len() >= MAX_CANDIDATES || out.contains(&candidate) {
        return;
    }
    let Some(vtable) = word_in(regions, candidate) else {
        return;
    };
    if !pe::in_image_data(vtable) || shape_in(regions, candidate).is_none() {
        return;
    }
    out.push(candidate);
}

/// A stack's fields at `addr`, read against a region walk instead of a `VirtualQuery` per field.
fn shape_in(regions: &[(usize, usize)], addr: usize) -> Option<Stack> {
    let begin = word_in(regions, addr + STACK_BEGIN)?;
    let end = word_in(regions, addr + STACK_END)?;
    let capacity = word_in(regions, addr + STACK_CAPACITY)?;
    let count = i32_in(regions, addr + STACK_COUNT)?;
    let first_active = i32_in(regions, addr + STACK_FIRST_ACTIVE)?;
    shape(addr, begin, end, capacity, count, first_active)
}

/// The first candidate that reads as a stack *and* names a screen, preferring one whose first qword is
/// a `SceneStack` table this image resolved (or learned from a stack it found). The always-active stack
/// is answered second, as a stand-in, never as the first answer.
fn confirm(candidates: &[usize], preferred: [usize; 2]) -> (Option<Stack>, Option<Stack>) {
    let mut ordered: Vec<usize> = candidates.to_vec();
    if preferred != [0, 0] {
        ordered.sort_by_key(|addr| match pe::read::<usize>(*addr) {
            Some(vtable) if preferred.contains(&vtable) => 0u8,
            _ => 1,
        });
    }
    let mut stand_in: Option<Stack> = None;
    for addr in ordered {
        let vtable = pe::read::<usize>(addr).unwrap_or(0);
        // Only objects of a resolved stack class are described: the walk meets thousands of others.
        let described = preferred.contains(&vtable) && vtable != 0;
        let Some(stack) = stack_shape(addr) else {
            if described {
                describe(addr, "not stack-shaped", None, None);
            }
            continue;
        };
        // The class proves itself through its own getters: slot `0x160` names the last entry, slot `0x1b0`
        // hands out the current scene under the overlays.
        let top = stack_name(&stack);
        let current = if top.is_none() || stack.first_active > 0 { current_name(&stack) } else { None };
        let always = is_always(addr);
        if described {
            let verdict = match (top.is_some() || current.is_some(), always) {
                (false, _) => "names no screen",
                (true, true) => "always-active stand-in",
                (true, false) => "taken",
            };
            describe(addr, verdict, top.as_deref(), current.as_deref());
        }
        if top.is_none() && current.is_none() {
            continue;
        }
        if always {
            stand_in = stand_in.or(Some(stack));
            continue;
        }
        return (Some(stack), stand_in);
    }
    (None, stand_in)
}

/// One discovery log line for a candidate of a stack class: its fields as read and the verdict, so a
/// live run shows why the client's own stack was or was not taken.
fn describe(addr: usize, verdict: &str, top: Option<&str>, current: Option<&str>) {
    if CANDIDATE_LOGS.fetch_add(1, Ordering::AcqRel) >= MAX_CANDIDATE_LOGS {
        return;
    }
    let word = |offset: usize| pe::read::<usize>(addr + offset).unwrap_or(0);
    let dword = |offset: usize| pe::read::<i32>(addr + offset).unwrap_or(-1);
    agent_core::log::fmt(format_args!(
        "ui: candidate 0x{addr:x} vtable 0x{:x} begin 0x{:x} end 0x{:x} capacity 0x{:x} count {} first active {} always {}: {verdict} (top {:?}, current {:?})",
        word(0),
        word(STACK_BEGIN),
        word(STACK_END),
        word(STACK_CAPACITY),
        dword(STACK_COUNT),
        dword(STACK_FIRST_ACTIVE),
        is_always(addr),
        top,
        current
    ));
}

/// Records the always-active stack `owner` holds at [`ALWAYS_SLOT`], when it holds a stack there.
fn note_always(regions: &[(usize, usize)], owner: usize) {
    let slot = ALWAYS_SLOT.load(Ordering::Acquire);
    if slot == 0 {
        return;
    }
    let Some(held) = word_in(regions, owner.saturating_add(slot)) else {
        return;
    };
    if held < 0x1_0000 || is_always(held) || shape_in(regions, held).is_none() {
        return;
    }
    let tables = tables();
    let vtable = word_in(regions, held).unwrap_or(0);
    if !(if tables == [0, 0] { pe::in_image_data(vtable) } else { tables.contains(&vtable) }) {
        return;
    }
    if let Some(index) = ALWAYS_STACKS.iter().position(|entry| entry.load(Ordering::Acquire) == 0) {
        ALWAYS_STACKS[index].store(held, Ordering::Release);
        ALWAYS_OWNERS[index].store(owner, Ordering::Release);
        agent_core::log::fmt(format_args!("ui: the always-active SceneStack is 0x{held:x} ([0x{owner:x} + 0x{slot:x}])"));
        // The client's own stack has not been seen in a world: describe what this owner holds at the
        // other stack slots, whatever shape it has, so a live log shows where it went.
        for other in CLIENT_STACK_SLOTS {
            if other == slot {
                continue;
            }
            match word_in(regions, owner.saturating_add(other)) {
                Some(value) if value >= 0x1_0000 && pe::readable(value, 0x98) => {
                    describe(value, "held at the owner's other stack slot", None, None)
                }
                value => agent_core::log::fmt(format_args!(
                    "ui: owner 0x{owner:x} + 0x{other:x} holds {:?}, not an object",
                    value.map(|value| alloc::format!("0x{value:x}"))
                )),
            }
        }
    }
}

/// The client instance's own stack: an instance of [`CLIENT_CLASS`] among the seeds, else reached from
/// the main owner, and the `SceneStack` it holds at [`CLIENT_SLOT`] — when that reads as a stack and
/// names a screen.
fn client_instance_stack(regions: &[(usize, usize)], seeds: &[usize]) -> Option<Stack> {
    let class = CLIENT_CLASS.load(Ordering::Acquire);
    let slot = CLIENT_SLOT.load(Ordering::Acquire);
    if class == 0 || slot == 0 {
        return None;
    }
    let mut instances: Vec<usize> = seeds.iter().copied().filter(|seed| word_in(regions, *seed) == Some(class)).collect();
    if instances.is_empty() {
        let starts: Vec<usize> = ALWAYS_OWNERS.iter().map(|owner| owner.load(Ordering::Acquire)).filter(|owner| *owner != 0).collect();
        instances.extend(find_instances(regions, &starts, class));
    }
    let tables = tables();
    for instance in instances {
        let Some(held) = word_in(regions, instance.saturating_add(slot)) else {
            continue;
        };
        if held < 0x1_0000 {
            agent_core::log::fmt(format_args!("ui: client instance 0x{instance:x} holds no SceneStack at +0x{slot:x}"));
            continue;
        }
        let vtable = word_in(regions, held).unwrap_or(0);
        if tables != [0, 0] && !tables.contains(&vtable) {
            continue;
        }
        let Some(stack) = stack_shape(held) else {
            describe(held, "client instance stack, not stack-shaped (empty outside a world)", None, None);
            continue;
        };
        let top = stack_name(&stack);
        let current = if top.is_none() || stack.first_active > 0 { current_name(&stack) } else { None };
        describe(held, if top.is_some() || current.is_some() { "client instance stack, taken" } else { "client instance stack, names no screen" }, top.as_deref(), current.as_deref());
        if top.is_some() || current.is_some() {
            CLIENT_OWNER.store(instance, Ordering::Release);
            CLIENT_STACK.store(held, Ordering::Release);
            return Some(stack);
        }
    }
    None
}

/// Objects whose first qword is `class`, reached from `starts` breadth first: an object's fields are
/// read [`CLIENT_WALK_OBJECT`] wide, any other heap block (a map or list node) [`CLIENT_WALK_NODE`]
/// wide, at most [`CLIENT_WALK_DEPTH`] hops and [`CLIENT_WALK_NODES`] blocks. Reads only.
fn find_instances(regions: &[(usize, usize)], starts: &[usize], class: usize) -> Vec<usize> {
    let mut found: Vec<usize> = Vec::new();
    let mut queue: Vec<(usize, u8)> = starts.iter().map(|start| (*start, 0u8)).collect();
    let mut seen: Vec<usize> = starts.to_vec();
    let mut index = 0usize;
    while index < queue.len() && found.len() < 4 {
        let (node, depth) = queue[index];
        index += 1;
        let object = word_in(regions, node).is_some_and(pe::in_image_data);
        let width = if object { CLIENT_WALK_OBJECT } else { CLIENT_WALK_NODE };
        let mut offset = 0usize;
        while offset + 8 <= width {
            let Some(value) = word_in(regions, node.saturating_add(offset)) else {
                break;
            };
            offset += 8;
            if value < 0x1_0000 || value & 7 != 0 || pe::in_image_data(value) || pe::in_image_code(value) {
                continue;
            }
            let Some(head) = word_in(regions, value) else {
                continue;
            };
            if head == class {
                if !found.contains(&value) {
                    found.push(value);
                }
                continue;
            }
            if depth + 1 < CLIENT_WALK_DEPTH && seen.len() < CLIENT_WALK_NODES && !seen.contains(&value) {
                seen.push(value);
                queue.push((value, depth + 1));
            }
        }
    }
    agent_core::log::fmt(format_args!(
        "ui: client instance walk visited {} block(s) from {} owner(s), found {:?}",
        index,
        starts.len(),
        found.iter().map(|address| alloc::format!("0x{address:x}")).collect::<Vec<_>>()
    ));
    found
}

/// True for a stack discovery met as the always-active one.
fn is_always(stack: usize) -> bool {
    stack != 0 && ALWAYS_STACKS.iter().any(|entry| entry.load(Ordering::Acquire) == stack)
}

/// The `SceneStack`s this module validated, as `(stack, owner, owner field)`: the always-active stacks
/// with the owner and the field discovery met them at, then the cached live stack (owner and field 0
/// unless it is one of those). Also the two owner fields stacks are kept in (`[always, client]`, 0 while
/// unresolved). Read by [`crate::route`], which finds the OreUI router kept beside a stack.
pub(crate) fn stack_holders() -> (Vec<(usize, usize, usize)>, [usize; 2]) {
    let always = ALWAYS_SLOT.load(Ordering::Acquire);
    let mut out: Vec<(usize, usize, usize)> = Vec::new();
    for (stack, owner) in ALWAYS_STACKS.iter().zip(&ALWAYS_OWNERS) {
        let (stack, owner) = (stack.load(Ordering::Acquire), owner.load(Ordering::Acquire));
        if stack != 0 && owner != 0 && always != 0 {
            out.push((stack, owner, always));
        }
    }
    let live = STACK.load(Ordering::Acquire);
    // The client instance's own stack, with the instance and slot it was read from (a stack taken from
    // there and still held there).
    let (client, client_stack, slot) = (CLIENT_OWNER.load(Ordering::Acquire), CLIENT_STACK.load(Ordering::Acquire), CLIENT_SLOT.load(Ordering::Acquire));
    if client != 0 && slot != 0 && client_stack != 0 && pe::read::<usize>(client + slot) == Some(client_stack) && !out.iter().any(|(stack, _, _)| *stack == client_stack) {
        out.push((client_stack, client, slot));
    }
    if live != 0 && !out.iter().any(|(stack, _, _)| *stack == live) {
        out.push((live, 0, 0));
    }
    (out, [always, CLIENT_SLOT.load(Ordering::Acquire)])
}

/// A word at `addr`, when the region walk says it is readable.
fn word_in(regions: &[(usize, usize)], addr: usize) -> Option<usize> {
    if !pe::in_regions(regions, addr, 8) {
        return None;
    }
    // SAFETY: the range was just checked against the live region walk.
    Some(unsafe { ptr::read_unaligned(addr as *const u64) } as usize)
}

/// An `i32` at `addr`, when the region walk says it is readable.
fn i32_in(regions: &[(usize, usize)], addr: usize) -> Option<i32> {
    if !pe::in_regions(regions, addr, 4) {
        return None;
    }
    // SAFETY: the range was just checked against the live region walk.
    Some(unsafe { ptr::read_unaligned(addr as *const u32) } as i32)
}

/* ------------------------------------------------------------------------------------------------
 * The message path
 * ---------------------------------------------------------------------------------------------- */

/// The game window and the window *class* procedure: the two things a message needs.
///
/// The class procedure is what the game registered, so an input lock's subclass on the window is not in
/// the path; when the class procedure cannot be read the window's own procedure is used instead, which
/// chains to it.
fn window() -> Result<(usize, usize), RpcError> {
    let mut handle = WINDOW.load(Ordering::Acquire);
    if handle != 0 {
        // SAFETY: a window query takes no ownership and cannot fault on a stale handle.
        if unsafe { win::IsWindow(handle as win::Hwnd) } == 0 || !belongs(handle) {
            WINDOW.store(0, Ordering::Release);
            handle = 0;
        }
    }
    if handle == 0 {
        handle = find_window().ok_or_else(|| RpcError::anchor("ui.window"))?;
        WINDOW.store(handle, Ordering::Release);
    }
    // SAFETY: `handle` is a window of this process.
    let class_procedure = unsafe { GetClassLongPtrW(handle as win::Hwnd, GCLP_WNDPROC) } as usize;
    if class_procedure != 0 {
        return Ok((handle, class_procedure));
    }
    // SAFETY: as above; the window procedure is the fallback and chains to the class procedure.
    let procedure = unsafe { win::GetWindowLongPtrW(handle as win::Hwnd, win::GWLP_WNDPROC) } as usize;
    if procedure == 0 {
        return Err(RpcError::anchor("ui.window"));
    }
    Ok((handle, procedure))
}

/// The largest visible top-level window of this process.
fn find_window() -> Option<usize> {
    FIND_PID.store(win::current_process_id(), Ordering::Release);
    FIND_BEST.store(0, Ordering::Release);
    FIND_AREA.store(-1, Ordering::Release);
    // SAFETY: the callback has the expected signature and only reads window state.
    unsafe {
        win::EnumWindows(collect_window, 0);
    }
    let found = FIND_BEST.load(Ordering::Acquire);
    (found != 0).then_some(found)
}

static FIND_PID: core::sync::atomic::AtomicU32 = core::sync::atomic::AtomicU32::new(0);
static FIND_BEST: AtomicUsize = AtomicUsize::new(0);
static FIND_AREA: core::sync::atomic::AtomicI64 = core::sync::atomic::AtomicI64::new(-1);

/// `EnumWindows` callback: keeps the largest visible window of this process.
unsafe extern "system" fn collect_window(window: win::Hwnd, _arg: win::Lparam) -> win::Bool {
    let mut owner = 0u32;
    // SAFETY: the out pointer is a `DWORD`; a wrong handle just fails.
    unsafe {
        win::GetWindowThreadProcessId(window, &mut owner);
    }
    if owner != FIND_PID.load(Ordering::Relaxed) {
        return 1;
    }
    if unsafe { win::IsWindowVisible(window) } == 0 {
        return 1;
    }
    let mut rect = win::Rect { left: 0, top: 0, right: 0, bottom: 0 };
    if unsafe { win::GetClientRect(window, &mut rect) } == 0 {
        return 1;
    }
    let area = (rect.right - rect.left) as i64 * (rect.bottom - rect.top) as i64;
    if area > FIND_AREA.load(Ordering::Relaxed) {
        FIND_AREA.store(area, Ordering::Relaxed);
        FIND_BEST.store(window as usize, Ordering::Release);
    }
    1
}

/// True when `window` belongs to this process.
fn belongs(window: usize) -> bool {
    let mut owner = 0u32;
    // SAFETY: the out pointer is a `DWORD`.
    unsafe {
        win::GetWindowThreadProcessId(window as win::Hwnd, &mut owner);
    }
    owner == win::current_process_id()
}

/// One message through the window procedure, synchronously, on this thread.
fn send(window: usize, procedure: usize, message: u32, wparam: usize, lparam: isize) -> isize {
    // SAFETY: `procedure` is the window class's own procedure (or the window's, which chains to it) for a
    // window of this process, and the arguments are the ones such a message carries.
    let procedure: win::WndProc = unsafe { core::mem::transmute(procedure) };
    unsafe { win::CallWindowProcW(procedure, window as win::Hwnd, message, wparam, lparam) }
}

/// `lParam` for a point in client pixels.
fn point_lparam(x: i32, y: i32) -> isize {
    let x = (x as u32) & 0xFFFF;
    let y = (y as u32) & 0xFFFF;
    (((y << 16) | x) as i32) as isize
}

/// Refuses a pointer position outside the game's client area, so a screenshot taken at another
/// resolution is an error with the size in it instead of a click that silently lands somewhere else.
fn check_client(window: usize, x: i32, y: i32) -> Result<(), RpcError> {
    let mut rect = win::Rect { left: 0, top: 0, right: 0, bottom: 0 };
    // SAFETY: the out pointer is a RECT and the window belongs to this process.
    if unsafe { win::GetClientRect(window as win::Hwnd, &mut rect) } == 0 {
        return Ok(());
    }
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width > 0 && height > 0 && (x >= width || y >= height) {
        return Err(RpcError::invalid_params(alloc::format!(
            "({x}, {y}) is outside the game's {width}x{height} client area"
        )));
    }
    Ok(())
}

/* ------------------------------------------------------------------------------------------------
 * Keys: xdotool-style names to virtual keys, chords to messages
 * ---------------------------------------------------------------------------------------------- */

/// One key: its virtual key and whether the message must carry the extended flag.
#[derive(Clone, Copy)]
struct Key {
    vk: u32,
    extended: bool,
}

/// A key or a chord (`ctrl+a`): the modifiers, the key, and the character a press produces.
struct Chord {
    modifiers: Vec<Key>,
    key: Key,
    alt: bool,
    character: Option<u16>,
}

impl Chord {
    /// `Escape`, `Return`, `space`, `F3`, `w`, `ctrl+a`, `shift+F3`, `alt+F4`.
    fn parse(text: &str) -> Result<Chord, RpcError> {
        let parts: Vec<&str> = text.split('+').collect();
        if parts.is_empty() || parts.len() > CHORD_LIMIT {
            return Err(invalid_key(text));
        }
        if parts.iter().any(|part| part.is_empty()) {
            return Err(invalid_key(text));
        }
        let (key_name, modifier_names) = parts.split_last().expect("a split yields at least one part");
        let mut modifiers: Vec<Key> = Vec::new();
        let mut shift = false;
        let mut alt = false;
        for name in modifier_names {
            let (key, modifier) = modifier_key(name).ok_or_else(|| invalid_key(text))?;
            match modifier {
                Modifier::Shift => shift = true,
                Modifier::Alt => alt = true,
                Modifier::Other => {}
            }
            modifiers.push(key);
        }
        let key = key_of(key_name).ok_or_else(|| invalid_key(text))?;
        let character = character_of(key.vk, shift);
        Ok(Chord { modifiers, key, alt, character })
    }

    /// True for the one key the store guard lets through.
    fn is_escape(&self) -> bool {
        self.modifiers.is_empty() && self.key.vk == VK_ESCAPE
    }

    /// `Return` or `Space`, with or without modifiers: the keys that press the focused control.
    fn activates(&self) -> bool {
        self.key.vk == VK_RETURN || self.key.vk == VK_SPACE
    }

    /// Sends the chord: modifiers down, the key, modifiers up; a press also produces its character, the
    /// way the message loop's `TranslateMessage` would.
    fn send(&self, action: &str) -> Result<usize, RpcError> {
        let (window, procedure) = window()?;
        let scan = scan_code(self.key.vk);
        let mut sent = 0usize;
        if action == "press" || action == "down" {
            for modifier in &self.modifiers {
                send_key(window, procedure, *modifier, false, self.alt);
                sent += 1;
            }
            send_key(window, procedure, self.key, false, self.alt);
            sent += 1;
            if action == "press" {
                if let Some(character) = self.character {
                    let lparam = (1u32 | (scan << 16)) as i32 as isize;
                    send(window, procedure, WM_CHAR, character as usize, lparam);
                    sent += 1;
                }
            }
        }
        if action == "press" || action == "up" {
            send_key(window, procedure, self.key, true, self.alt);
            sent += 1;
            for modifier in self.modifiers.iter().rev() {
                send_key(window, procedure, *modifier, true, self.alt);
                sent += 1;
            }
        }
        Ok(sent)
    }
}

fn invalid_key(text: &str) -> RpcError {
    RpcError::invalid_params(alloc::format!(
        "'{text}' is not a key: use the names game_input takes (Escape, Return, space, F3, w, ctrl+a)"
    ))
}

/// One key message.
fn send_key(window: usize, procedure: usize, key: Key, up: bool, alt_down: bool) {
    let scan = scan_code(key.vk);
    let mut lparam: u32 = 1 | ((scan & 0xFF) << 16);
    if key.extended {
        lparam |= KEY_EXTENDED;
    }
    if alt_down {
        lparam |= KEY_CONTEXT;
    }
    if up {
        lparam |= KEY_PREVIOUS | KEY_TRANSITION;
    }
    let message = match (up, alt_down) {
        (false, false) => win::WM_KEYDOWN,
        (false, true) => win::WM_SYSKEYDOWN,
        (true, false) => win::WM_KEYUP,
        (true, true) => win::WM_SYSKEYUP,
    };
    send(window, procedure, message, key.vk as usize, lparam as i32 as isize);
}

/// The scan code the key messages carry; 0 when the platform has none for this key.
fn scan_code(vk: u32) -> u32 {
    // SAFETY: a pure query; `MAPVK_VK_TO_VSC` is 0.
    unsafe { MapVirtualKeyW(vk, 0) & 0xFF }
}

enum Modifier {
    Shift,
    Alt,
    Other,
}

/// A chord's modifier prefix: `ctrl`, `control`, `shift`, `alt`, `super`/`meta`/`win`/`cmd`.
fn modifier_key(name: &str) -> Option<(Key, Modifier)> {
    let (key, modifier) = match lower(name).as_str() {
        "ctrl" | "control" | "ctrl_l" | "control_l" => (Key { vk: VK_LCONTROL, extended: false }, Modifier::Other),
        "ctrl_r" | "control_r" => (Key { vk: VK_RCONTROL, extended: true }, Modifier::Other),
        "shift" | "shift_l" => (Key { vk: VK_LSHIFT, extended: false }, Modifier::Shift),
        "shift_r" => (Key { vk: VK_RSHIFT, extended: false }, Modifier::Shift),
        "alt" | "alt_l" => (Key { vk: VK_LMENU, extended: false }, Modifier::Alt),
        "alt_r" | "altgr" | "iso_level3_shift" => (Key { vk: VK_RMENU, extended: true }, Modifier::Alt),
        "super" | "super_l" | "meta" | "meta_l" | "win" | "windows" | "cmd" | "command" => {
            (Key { vk: VK_LWIN, extended: true }, Modifier::Other)
        }
        "super_r" | "meta_r" | "win_r" => (Key { vk: VK_RWIN, extended: true }, Modifier::Other),
        _ => return None,
    };
    Some((key, modifier))
}

/// A key name (not a modifier) as its virtual key, in the names `game_input` documents.
fn key_of(name: &str) -> Option<Key> {
    let plain = |vk: u32| Some(Key { vk, extended: false });
    let extended = |vk: u32| Some(Key { vk, extended: true });
    // A single printable character (`w`, `A`, `7`, `-`) is its own key.
    if name.len() == 1 {
        let character = name.as_bytes()[0];
        return match character {
            b'a'..=b'z' => plain(character as u32 - 0x20),
            b'A'..=b'Z' => plain(character as u32),
            b'0'..=b'9' => plain(character as u32),
            _ => match character {
                b' ' => plain(VK_SPACE),
                b'-' => plain(VK_OEM_MINUS),
                b'=' => plain(VK_OEM_PLUS),
                b'[' => plain(VK_OEM_4),
                b']' => plain(VK_OEM_6),
                b'\\' => plain(VK_OEM_5),
                b';' => plain(VK_OEM_1),
                b'\'' => plain(VK_OEM_7),
                b'`' => plain(VK_OEM_3),
                b',' => plain(VK_OEM_COMMA),
                b'.' => plain(VK_OEM_PERIOD),
                b'/' => plain(VK_OEM_2),
                _ => None,
            },
        };
    }
    let lower = lower(name);
    let simple = match lower.as_str() {
        "escape" | "esc" => Some(VK_ESCAPE),
        "return" | "enter" => Some(VK_RETURN),
        "tab" => Some(VK_TAB),
        "space" => Some(VK_SPACE),
        "backspace" | "back_space" => Some(VK_BACK),
        "caps_lock" | "capslock" => Some(VK_CAPITAL),
        "pause" | "break" => Some(VK_PAUSE),
        "print" | "print_screen" | "snapshot" | "sys_req" => return extended(VK_SNAPSHOT),
        "scroll_lock" | "scrolllock" => Some(VK_SCROLL),
        "num_lock" | "numlock" => return extended(VK_NUMLOCK),
        "insert" => return extended(VK_INSERT),
        "delete" | "del" => return extended(VK_DELETE),
        "home" => return extended(VK_HOME),
        "end" => return extended(VK_END),
        "prior" | "page_up" | "pageup" | "pgup" => return extended(VK_PRIOR),
        "next" | "page_down" | "pagedown" | "pgdn" => return extended(VK_NEXT),
        "left" => return extended(VK_LEFT),
        "right" => return extended(VK_RIGHT),
        "up" => return extended(VK_UP),
        "down" => return extended(VK_DOWN),
        "menu" | "apps" => return extended(VK_APPS),
        "kp_enter" => return extended(VK_RETURN),
        "kp_multiply" => Some(VK_MULTIPLY),
        "kp_add" => Some(VK_ADD),
        "kp_subtract" | "kp_minus" => Some(VK_SUBTRACT),
        "kp_decimal" => Some(VK_DECIMAL),
        "kp_divide" | "kp_slash" => return extended(VK_DIVIDE),
        "minus" => Some(VK_OEM_MINUS),
        "equal" => Some(VK_OEM_PLUS),
        "bracketleft" => Some(VK_OEM_4),
        "bracketright" => Some(VK_OEM_6),
        "backslash" => Some(VK_OEM_5),
        "semicolon" => Some(VK_OEM_1),
        "apostrophe" => Some(VK_OEM_7),
        "grave" | "backtick" => Some(VK_OEM_3),
        "comma" => Some(VK_OEM_COMMA),
        "period" => Some(VK_OEM_PERIOD),
        "slash" => Some(VK_OEM_2),
        _ => None,
    };
    if let Some(vk) = simple {
        return plain(vk);
    }
    // Modifiers may also stand alone (`Shift_L`, `ctrl` as the key itself).
    if let Some((key, _)) = modifier_key(&lower) {
        return Some(key);
    }
    // F1 .. F24.
    if let Some(digits) = lower.strip_prefix('f') {
        if let Ok(number) = digits.parse::<u32>() {
            if (1..=24).contains(&number) {
                return plain(VK_F1 + number - 1);
            }
        }
    }
    // Keypad digits.
    if let Some(digits) = lower.strip_prefix("kp_") {
        if let Ok(number) = digits.parse::<u32>() {
            if number <= 9 {
                return plain(0x60 + number);
            }
        }
    }
    None
}

/// The character a press of `vk` produces, which `ui.key` sends as `WM_CHAR` after the key down.
fn character_of(vk: u32, shift: bool) -> Option<u16> {
    let character = match vk {
        0x41..=0x5A => {
            let letter = (b'a' + (vk as u8 - 0x41)) as char;
            if shift {
                letter.to_ascii_uppercase()
            } else {
                letter
            }
        }
        0x30..=0x39 => (b'0' + (vk as u8 - 0x30)) as char,
        0x60..=0x69 => (b'0' + (vk as u8 - 0x60)) as char,
        VK_SPACE => ' ',
        VK_RETURN => '\r',
        VK_TAB => '\t',
        VK_BACK => '\u{8}',
        VK_MULTIPLY => '*',
        VK_ADD => '+',
        VK_SUBTRACT => '-',
        VK_DECIMAL => '.',
        VK_DIVIDE => '/',
        VK_OEM_MINUS => if shift { '_' } else { '-' },
        VK_OEM_PLUS => if shift { '+' } else { '=' },
        VK_OEM_4 => if shift { '{' } else { '[' },
        VK_OEM_6 => if shift { '}' } else { ']' },
        VK_OEM_5 => if shift { '|' } else { '\\' },
        VK_OEM_1 => if shift { ':' } else { ';' },
        VK_OEM_7 => if shift { '"' } else { '\'' },
        VK_OEM_3 => if shift { '~' } else { '`' },
        VK_OEM_COMMA => if shift { '<' } else { ',' },
        VK_OEM_PERIOD => if shift { '>' } else { '.' },
        VK_OEM_2 => if shift { '?' } else { '/' },
        _ => return None,
    };
    Some(character as u16)
}

/// ASCII-lowercase of a key name.
fn lower(text: &str) -> String {
    text.chars().map(|c| c.to_ascii_lowercase()).collect()
}

/* ------------------------------------------------------------------------------------------------
 * Anchors
 * ---------------------------------------------------------------------------------------------- */

/// Resolves the two image recipes this feature needs and the game window, and reports them.
///
/// * `ui.scene_name` — `SceneStack::getCurrentSceneName`: the function whose body reads the entry vector,
///   takes the last entry's scene and calls its vtable slot `0x1b8`. Several classes can carry a body of
///   this shape, so the one reported is the one whose class table validates (below); with two such
///   classes nothing is reported rather than a guess.
/// * `ui.scene_vtable` — the table that holds that function at slot `0x160` and whose class is a
///   `SceneStack` (the same current-scene getter in `0x1b0` and `0x1b8`, the entry list at `0x150`). It
///   is a preference when the live stack is found — an ambiguous pair is reported as `0` and both tables
///   are still tried by discovery.
/// * `ui.window` — the largest visible top-level window of this process, found here so
///   `engine.status` shows it; the message path revalidates it on every call.
pub(crate) fn resolve(core: &'static Core) -> Vec<Anchor> {
    let image = core.image();
    let functions = scene_name_functions(image);
    let mut found: Vec<(usize, usize, bool)> = Vec::new();
    for function in &functions {
        if let Some((table, _slot)) = scene_stack_vtable(image, *function) {
            if found.iter().all(|(_, known, _)| *known != table) {
                found.push((*function, table, direct_stack_getter(*function)));
            }
        }
    }
    // Two classes carry the GetCurrentSceneName shape in this build; the direct one's `this` is the
    // stack itself, the other reaches the stack through `this + 0x08`, so the direct one comes first.
    found.sort_by_key(|(_, _, direct)| !*direct);
    let (name, tables) = match found.len() {
        0 => (None, [0usize, 0usize]),
        1 => (Some(found[0].0), [found[0].1, 0]),
        _ => (Some(found[0].0), [found[0].1, found[1].1]),
    };
    // The anchor names a table only when it is the stack's own class, not the wrapper's.
    let anchor = if found.len() <= 1 || found[0].2 { tables[0] } else { 0 };
    SCENE_NAME.store(name.unwrap_or(0), Ordering::Release);
    SCENE_TABLES[0].store(tables[0], Ordering::Release);
    SCENE_TABLES[1].store(tables[1], Ordering::Release);
    let window = find_window();
    if let Some(window) = window {
        WINDOW.store(window, Ordering::Release);
    }
    let always = always_screens(image);
    if let Some((function, slot)) = always {
        ALWAYS_FUNCTION.store(function, Ordering::Release);
        ALWAYS_SLOT.store(slot, Ordering::Release);
    }
    let client = if anchor != 0 { client_stack_owner(image, anchor) } else { None };
    if let Some((class, slot)) = client {
        CLIENT_CLASS.store(class, Ordering::Release);
        CLIENT_SLOT.store(slot, Ordering::Release);
    }
    agent_core::log::fmt(format_args!(
        "ui: client instance class {:?}, its SceneStack at {:?}",
        client.map(|(class, _)| alloc::format!("0x{:x}", class - image.base())),
        client.map(|(_, slot)| alloc::format!("+0x{slot:x}"))
    ));
    agent_core::log::fmt(format_args!(
        "ui: {} name-shaped function(s), scene name {:?}, tables {:?}, window {:?}, always-active stack slot {:?}",
        functions.len(),
        name.map(|address| alloc::format!("0x{:x}", address - image.base())),
        tables.map(|table| (table != 0).then(|| alloc::format!("0x{:x}", table - image.base()))),
        window,
        always.map(|(_, slot)| alloc::format!("0x{slot:x}"))
    ));
    alloc::vec![
        Anchor { name: "ui.scene_name", addr: name.unwrap_or(0) },
        Anchor { name: "ui.scene_vtable", addr: anchor },
        Anchor { name: "ui.window", addr: window.unwrap_or(0) },
        Anchor { name: "ui.always_screens", addr: always.map_or(0, |(function, _)| function) },
        Anchor { name: "ui.client_class", addr: client.map_or(0, |(class, _)| class) },
    ]
}

/// The class whose virtual init stores a new `SceneStack` in one of its own fields — the client
/// instance — and that field.
///
/// The `SceneStack` constructor is the function that stamps `table` into the new object; each direct
/// call of it is followed, within a few instructions, by the store of the new stack into its owner
/// (`mov [rsi+slot], r15`). An owner function that is itself a virtual method names its class: its
/// table is the nearest address at or below the slot holding it that code loads with `lea` (retail
/// strips RTTI, so tables are packed and only the constructor's own load marks a start). A non-virtual
/// owner (the main game object, which keeps the menus' stack) is skipped: that stack is found from the
/// image's data already.
fn client_stack_owner(image: &agent_core::Image, table: usize) -> Option<(usize, usize)> {
    let mut references = [0usize; 4];
    let count = image.rip_refs(table, &mut references);
    for reference in &references[..count] {
        let Some(constructor) = image.function_start(*reference) else {
            continue;
        };
        for site in pe::callers(image, constructor) {
            let Some(slot) = owner_store(site) else {
                continue;
            };
            let Some(owner) = image.function_start(site) else {
                continue;
            };
            let Some(holder) = data_slot_of(image, owner) else {
                continue;
            };
            let candidates: Vec<usize> = (0..0x400usize).map(|index| holder - index * 8).collect();
            let found = pe::scan_refs(image, &candidates);
            if let Some(index) = found.iter().position(|refs| !refs.is_empty()) {
                return Some((candidates[index], slot));
            }
        }
    }
    None
}

/// The field a just-constructed stack is stored into after the constructor call at `site`: the first
/// `mov [base+disp32], r64` (no SIB, base not `rsp`/`rbp`) in the next 0x80 bytes.
fn owner_store(site: usize) -> Option<usize> {
    let code = pe::bytes(site + 5, 0x80)?;
    let mut at = 0usize;
    while at + 7 <= code.len() {
        let rex = code[at];
        if rex & 0xF8 == 0x48 && code[at + 1] == 0x89 {
            let modrm = code[at + 2];
            let rm = modrm & 7;
            if modrm >> 6 == 2 && rm != 4 && !(rm == 5 && rex & 1 == 0) {
                let disp = i32::from_le_bytes([code[at + 3], code[at + 4], code[at + 5], code[at + 6]]);
                if (0x100..=0x10000).contains(&disp) {
                    return Some(disp as usize);
                }
            }
        }
        at += 1;
    }
    None
}

/// The address of the one qword in the image's data that holds `function` (a vtable slot), when exactly
/// one does.
fn data_slot_of(image: &agent_core::Image, function: usize) -> Option<usize> {
    let mut found: Option<usize> = None;
    for section in image.sections() {
        let name = section.name();
        if name.starts_with(".text") || matches!(name, ".pdata" | ".rsrc" | ".reloc") {
            continue;
        }
        let Some(bytes) = pe::bytes(section.va, section.len) else {
            continue;
        };
        let mut offset = 0usize;
        while offset + 8 <= bytes.len() {
            // SAFETY: eight bytes inside a readable section; table slots are 8-byte aligned.
            let word = unsafe { ptr::read_unaligned(bytes.as_ptr().add(offset) as *const u64) } as usize;
            if word == function {
                if found.is_some() {
                    return None;
                }
                found = Some(section.va + offset);
            }
            offset += 8;
        }
    }
    found
}

/// The function that pushes the always-active screens and the owner field it pushes them onto.
///
/// The function names itself: it compares its argument against the literal
/// `initPushAlwaysActiveScreen`. Its body loads the same owner field before every push
/// (`mov rdi,[rsi+slot]`, then `mov rax,[rdi]; mov rax,[rax+push]; mov rcx,rdi` — a virtual call on the
/// loaded stack), so the slot is the displacement of the loads whose result is used as `this` of a
/// virtual call, repeated at least twice and more often than any other. The literal is referenced by
/// more than one function; the smallest one that yields a unique slot is the pusher. A wrong answer only
/// changes which stack discovery prefers: the always-active stack is still taken when nothing else
/// names a screen.
fn always_screens(image: &agent_core::Image) -> Option<(usize, usize)> {
    let string = image.find_string(b"initPushAlwaysActiveScreen")?;
    let mut references = [0usize; 8];
    let count = image.rip_refs(string, &mut references);
    let mut best: Option<(usize, usize, usize)> = None;
    for reference in &references[..count] {
        let (Some(start), Some(end)) = (image.function_start(*reference), image.function_end(*reference)) else {
            continue;
        };
        let size = end - start;
        if best.is_some_and(|(_, _, known)| known <= size) {
            continue;
        }
        if let Some(slot) = pushed_slot(start, size) {
            best = Some((start, slot, size));
        }
    }
    best.map(|(function, slot, _)| (function, slot))
}

/// The owner-field displacement `[function, function + size)` loads a `this` from most often (see
/// [`always_screens`]), when it is loaded at least twice and no other displacement is as frequent.
fn pushed_slot(function: usize, size: usize) -> Option<usize> {
    let code = pe::bytes(function, size)?;
    let mut counts: Vec<(usize, usize)> = Vec::new();
    let mut at = 0usize;
    while at + 7 <= code.len() {
        let rex = code[at];
        // `mov r64, [r64 + disp32]`: REX.W, `8B`, mod `10`, no SIB, destination not the base.
        if rex & 0xF8 != 0x48 || code[at + 1] != 0x8B {
            at += 1;
            continue;
        }
        let modrm = code[at + 2];
        let reg = ((modrm >> 3) & 7) | ((rex & 4) << 1);
        let base = (modrm & 7) | ((rex & 1) << 3);
        if modrm >> 6 != 2 || modrm & 7 == 4 || reg == base || matches!(reg & 7, 4 | 5) {
            at += 1;
            continue;
        }
        let disp = i32::from_le_bytes([code[at + 3], code[at + 4], code[at + 5], code[at + 6]]);
        if !(0x100..=0x10000).contains(&disp) {
            at += 1;
            continue;
        }
        // Within the next 0x40 bytes: `mov rax,[reg]` (its vtable), then `mov rcx,reg` (as `this`).
        let high = (reg >= 8) as u8;
        let vtable_load = [0x48 | high, 0x8B, reg & 7];
        let this_load = [0x48 | high, 0x8B, 0xC8 | (reg & 7)];
        let this_store = [0x48 | (high << 2), 0x89, 0xC1 | ((reg & 7) << 3)];
        let window = &code[at + 7..code.len().min(at + 7 + 0x40)];
        let used = window.windows(3).position(|bytes| bytes == vtable_load).is_some_and(|vtable| {
            window[vtable..].windows(3).any(|bytes| bytes == this_load || bytes == this_store)
        });
        if used {
            let disp = disp as usize;
            match counts.iter_mut().find(|(value, _)| *value == disp) {
                Some((_, count)) => *count += 1,
                None => counts.push((disp, 1)),
            }
        }
        at += 1;
    }
    let top = counts.iter().map(|(_, count)| *count).max()?;
    let mut leaders = counts.iter().filter(|(_, count)| *count == top);
    let (slot, _) = leaders.next()?;
    (top >= 2 && leaders.next().is_none()).then_some(*slot)
}

/// True when the getter's `this` is the stack object itself (`mov rax,[rcx+0x20]` straight away) and
/// not a holder that reaches the stack through `this + 0x08`, which is how this build's two
/// `SceneStack`-shaped classes differ. The client's screen stack is the direct one.
fn direct_stack_getter(function: usize) -> bool {
    /// `mov rcx,[rcx+8]`: a `shared_ptr` holder's first step.
    const HOLDER: &[u8] = &[0x48, 0x8B, 0x49, 0x08];
    let Some(head) = pe::bytes(function, 0x20) else {
        return false;
    };
    let Some(at) = head.windows(NAME_HEAD.len()).position(|window| window == NAME_HEAD) else {
        return false;
    };
    !at.checked_sub(HOLDER.len()).is_some_and(|start| head[start..start + HOLDER.len()] == *HOLDER)
}

/// Every function with the `getCurrentSceneName` shape, deduplicated and bounded.
fn scene_name_functions(image: &agent_core::Image) -> Vec<usize> {
    let mut found: Vec<usize> = Vec::new();
    let Some(code) = pe::code(image) else {
        return found;
    };
    let bytes = code.bytes;
    let mut offset = 0usize;
    while offset + NAME_HEAD.len() <= bytes.len() {
        if &bytes[offset..offset + NAME_HEAD.len()] != NAME_HEAD {
            offset += 1;
            continue;
        }
        let at = code.va + offset;
        offset += NAME_HEAD.len();
        if found.len() >= 8 {
            break;
        }
        let Some((start, end)) = pe::function_of(image, at) else {
            continue;
        };
        if end - start > 0x400 || !pe::has_pattern(start, end - start, NAME_TOP) || !pe::has_pattern(start, end - start, NAME_SLOT) {
            continue;
        }
        if !found.contains(&start) {
            found.push(start);
        }
    }
    found
}

/// The `SceneStack` table that holds `function`, and the class slot it sits in.
///
/// This build's class exposes `getCurrentSceneName` at slot `0x160`, which is how the table is located;
/// the table is then confirmed as `SceneStack` by the rest of the class, not by that slot alone: the
/// current-scene getter is the *same body* in `0x1b0` and `0x1b8` (what the game's own stack searches
/// call on every entry), the entry list sits at `0x150`, and slot `0` is a body. The word before a table
/// is *not* a boundary marker — retail strips RTTI, so tables are packed back to back and that word is
/// the previous table's last method — which is why it is not used to find a table start.
fn scene_stack_vtable(image: &agent_core::Image, function: usize) -> Option<(usize, usize)> {
    let mut candidate: Option<(usize, usize)> = None;
    for section in image.sections() {
        let name = section.name();
        if name.starts_with(".text") || matches!(name, ".pdata" | ".rsrc" | ".reloc") {
            continue;
        }
        let Some(bytes) = pe::bytes(section.va, section.len) else {
            continue;
        };
        let mut offset = 0usize;
        while offset + 8 <= bytes.len() {
            // SAFETY: eight bytes inside a readable section; a table slot is 8-byte aligned, so only
            // aligned positions can hold one.
            let word = unsafe { ptr::read_unaligned(bytes.as_ptr().add(offset) as *const u64) } as usize;
            offset += 8;
            if word != function {
                continue;
            }
            let slot = section.va + offset - 8;
            let Some(table) = slot.checked_sub(STACK_NAME_SLOT) else {
                continue;
            };
            if !stack_class(table, function) {
                continue;
            }
            if candidate.is_some_and(|(known, _)| known != table) {
                // Two `SceneStack`-shaped classes: which one the client uses is decided by the screen
                // that names itself through it, so this reports neither and discovery tries both.
                agent_core::log::line("ui: two SceneStack-shaped tables; discovery will try both");
                return None;
            }
            candidate = Some((table, STACK_NAME_SLOT));
        }
    }
    if candidate.is_none() {
        agent_core::log::line("ui: the scene name getter is not in a SceneStack-shaped table");
    }
    candidate
}

/// True when `table` is a `SceneStack` class table: slot `0` a body, the current-scene getter in both
/// `0x1b0` and `0x1b8` (one body, which every stack search in the game calls on its entries), the entry
/// list at `0x150`, and this build's name getter at `0x160`.
fn stack_class(table: usize, function: usize) -> bool {
    /// `SceneStack`'s current-scene getter, one body in `0x1b0` and `0x1b8` — the slots the game's own
    /// stack searches call on every entry.
    const STACK_CURRENT: usize = 0x1b0;
    const STACK_CURRENT_ALIAS: usize = 0x1b8;
    /// `SceneStack`'s entry-list slot, from the class's own bodies.
    const STACK_LIST_SLOT: usize = 0x150;
    if !pe::read::<usize>(table).is_some_and(pe::in_image_code) {
        return false;
    }
    let Some(current) = pe::read::<usize>(table + STACK_CURRENT) else {
        return false;
    };
    if current == 0
        || !pe::in_image_code(current)
        || pe::read::<usize>(table + STACK_CURRENT_ALIAS) != Some(current)
    {
        return false;
    }
    if !pe::read::<usize>(table + STACK_LIST_SLOT).is_some_and(pe::in_image_code) {
        return false;
    }
    pe::read::<usize>(table + STACK_NAME_SLOT) == Some(function)
}

/// The anchors `engine.status` reports for this module: the scene name getter, the `SceneStack` table
/// (0 while two classes carry the shape), the live stack, the game window and the always-active pusher.
pub(crate) fn report() -> Vec<Anchor> {
    let tables = tables();
    alloc::vec![
        Anchor { name: "ui.scene_name", addr: SCENE_NAME.load(Ordering::Acquire) },
        Anchor { name: "ui.scene_vtable", addr: tables[0] },
        Anchor { name: "ui.scene_stack", addr: STACK.load(Ordering::Acquire) },
        Anchor { name: "ui.window", addr: WINDOW.load(Ordering::Acquire) },
        Anchor { name: "ui.always_screens", addr: ALWAYS_FUNCTION.load(Ordering::Acquire) },
        Anchor { name: "ui.client_class", addr: CLIENT_CLASS.load(Ordering::Acquire) },
    ]
}
