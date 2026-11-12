//! Running one command line as the local player, on the integrated server's own thread.
//!
//! The game's synchronous entry (`executeCommand`) takes a request it builds and destroys itself and
//! a `CommandOrigin*` it **owns**: the wrapper moves the pointer out and zeroes our slot, then the
//! request's destructor deletes the origin through its vtable. So the origin is allocated by the
//! game's own `CommandOrigin::fromData` (which uses the game's allocator and resolves the local
//! player from the server's origin source), handed over once, and never freed here.
//!
//! The result is read from the messages the command body writes, not from the dispatcher's `int*`
//! (which carries the last script command's status). [`crate::hooks::add_message`] copies every
//! message while our line runs — a thread id marks "ours", so a command the player types meanwhile is
//! untouched — and drops the original call when the line must stay out of chat (`quiet_command`).
//!
//! Success is the game's own rule: a message of type 1 is an error, a message of type 0 is success,
//! and a command that printed nothing (e.g. `/difficulty` on an unchanged value) reports `null`.

use alloc::string::String;
use alloc::vec::Vec;
use core::mem::transmute;
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use agent_core::sync::SpinLock;
use agent_core::RpcError;
use serde_json::{json, Value};

use crate::{anchors, live, pe, text};

/// One `CommandOrigin::fromData` call, exactly as the game made it.
///
/// `fromData` is the only builder of a player origin, and this build's player lookup (`Level` vtable
/// slot `0x710`) matches the registry against the `reference` and `filter` the caller hands it — a
/// made-up pair faults inside the ECS walk. So the agent never invents them: the
/// `command.origin` hook records the arguments of a real call (the game's own chat command makes one),
/// and this module replays exactly those.
///
/// `reference` is the sending connection's network identifier, a value the lookup only *compares*
/// (its transport tag at `+0xa8`, then the address fields that tag selects). The game hands over a
/// pointer into the packet it is handling, which does not outlive that packet, so the bytes are copied
/// at capture and the replay points at the copy.
#[derive(Clone, Copy)]
pub(crate) struct OriginCall {
    /// The wire form of `CommandOriginData`, 0x40 bytes, copied.
    pub data: [u8; ORIGIN_DATA_SIZE],
    /// The 0x18-byte level reference the game passed, copied.
    pub src: [u8; SOURCE_SIZE],
    /// The lookup's reference value (the sender's network identifier), copied.
    pub reference: [u8; REFERENCE_SIZE],
    /// The lookup's filter byte (the sub-client id).
    pub filter: u8,
}

static ORIGIN_CALL: SpinLock<Option<OriginCall>> = SpinLock::new(None);

/// Records one real `fromData` call: its origin data, its level reference, its lookup reference and
/// filter byte, and logs the first one of each capture.
///
/// Called from the `command.origin` hook on the thread that runs the command, so every read here is a
/// guarded read of a live object, and every buffer is copied out before the call returns.
pub(crate) fn capture_call(data: usize, src: usize, reference: usize, filter: u8) {
    if data == 0 || src == 0 || reference == 0 {
        return;
    }
    let (Some(data_bytes), Some(src_bytes), Some(reference_bytes)) =
        (pe::bytes(data, ORIGIN_DATA_SIZE), pe::bytes(src, SOURCE_SIZE), pe::bytes(reference, REFERENCE_SIZE))
    else {
        return;
    };
    // `CommandOriginType::Player`: the only kind a player command and this agent both use.
    const PLAYER: u8 = 0;
    if data_bytes[0] != PLAYER {
        return;
    }
    // Only the player command path builds its origin against the level the server steps: `fromData` has
    // a second caller in this build whose level reference names another object than the server level,
    // and replaying that one faulted inside `fromData`. So a call is kept only when its `src+0x10` is
    // the server's own level.
    let named = usize::from_le_bytes(src_bytes[0x10..0x18].try_into().unwrap_or([0; 8]));
    if live::server_level() != Some(named) {
        return;
    }
    let mut call = OriginCall {
        data: [0u8; ORIGIN_DATA_SIZE],
        src: [0u8; SOURCE_SIZE],
        reference: [0u8; REFERENCE_SIZE],
        filter,
    };
    call.data.copy_from_slice(data_bytes);
    call.src.copy_from_slice(src_bytes);
    call.reference.copy_from_slice(reference_bytes);
    let first = ORIGIN_CALL.lock().is_none();
    *ORIGIN_CALL.lock() = Some(call);
    take_prime();
    if first {
        LEVEL_LOGGED.store(false, Ordering::Release);
        let word = |at: usize| usize::from_le_bytes(src_bytes[at..at + 8].try_into().unwrap_or([0; 8]));
        agent_core::log::fmt(format_args!(
            "command: captured a player command origin (src {{0x{:x}, 0x{:x}, level 0x{:x}}}, reference 0x{reference:x}, filter {filter})",
            word(0),
            word(8),
            word(0x10)
        ));
    }
}

/// How long an armed prime waits for the client's chat line to reach the server.
const PRIME_ARM_MS: u64 = 10_000;
/// How long after the primed capture its command's messages are dropped. The command body runs right after
/// `fromData` in the same `executeCommand` call, so this only bounds a capture whose command never wrote.
const PRIME_DROP_MS: u64 = 1_000;
/// Until when (`tick_ms`) the next captured player command is the client's priming line, 0 when not armed.
static PRIME_UNTIL: AtomicU64 = AtomicU64::new(0);
/// The thread running the primed line, and until when its messages stay out of chat.
static PRIME_THREAD: AtomicU32 = AtomicU32::new(0);
static PRIME_DROP_UNTIL: AtomicU64 = AtomicU64::new(0);

/// `command.prime`: the client is about to type one line in chat only so the origin is captured
/// (`engine command` right after an attach). That line's own output is kept out of chat, so the bootstrap
/// leaves no trace for the player.
pub(crate) fn arm_prime() {
    PRIME_UNTIL.store(agent_core::win::tick_ms() + PRIME_ARM_MS, Ordering::Release);
}

/// Called on the capturing thread: an armed prime turns into "drop this thread's messages for a moment".
/// Our own replay (marked by [`begin`] before it calls `fromData`) never takes it.
fn take_prime() {
    if OURS.load(Ordering::Acquire) != 0 {
        return;
    }
    let until = PRIME_UNTIL.swap(0, Ordering::AcqRel);
    let now = agent_core::win::tick_ms();
    if until == 0 || now > until {
        return;
    }
    PRIME_DROP_UNTIL.store(now + PRIME_DROP_MS, Ordering::Release);
    PRIME_THREAD.store(agent_core::win::current_thread_id(), Ordering::Release);
}

/// True while `thread` runs the primed line, whose messages are dropped.
fn primed(thread: u32) -> bool {
    PRIME_THREAD.load(Ordering::Acquire) == thread && agent_core::win::tick_ms() <= PRIME_DROP_UNTIL.load(Ordering::Acquire)
}

/// The `Level*` an [`OriginCall`] was made against (`src + 0x10`).
fn call_level(call: &OriginCall) -> usize {
    let b = &call.src;
    usize::from_le_bytes([b[0x10], b[0x11], b[0x12], b[0x13], b[0x14], b[0x15], b[0x16], b[0x17]])
}

/// The last captured call. A world change forgets it ([`forget_origin`], from the level tracker), so a
/// call is only ever replayed in the world it was made in.
fn captured_call() -> Option<OriginCall> {
    *ORIGIN_CALL.lock()
}

/// True when a player command of this world was captured, so a replay has an origin to use.
pub(crate) fn origin_ready() -> bool {
    captured_call().is_some()
}

/// Forgets the captured call: the world it was made in is gone, and with it the level the call names.
pub(crate) fn forget_origin() {
    *ORIGIN_CALL.lock() = None;
}

/// The captured call's level against the one the server steps, logged once per capture.
static LEVEL_LOGGED: AtomicBool = AtomicBool::new(false);

/// The wire form of `CommandOriginData` (0x40 bytes): `{u8 type; u8[16] uuid; std::string requestId;
/// i64 playerId}`. A player origin reads only the type byte.
const ORIGIN_DATA_SIZE: usize = 0x40;
/// The 0x18-byte level reference `fromData` reads its `Level*` from (`src + 0x10`).
const SOURCE_SIZE: usize = 0x18;
/// The network identifier the lookup compares: its transport tag is the dword at `+0xa8`.
const REFERENCE_SIZE: usize = 0xB0;
/// The flag word every in-process caller of `executeCommand` passes (observed at all eight sites).
const COMMAND_FLAGS: u32 = 0x37;
/// `CommandOutputParameter`: a `std::string` then the parameter kind (`-1` = hidden, not rendered).
const PARAM_SIZE: usize = 0x28;
const PARAM_KIND: usize = 0x20;

/// What the message hook does for a captured message.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Capture {
    /// The message belongs to a command the game is running on its own: forward untouched.
    Off,
    /// Ours, and the line may show feedback: copy it, then let the game add it.
    Keep,
    /// Ours, and the line must stay out of chat: copy it and drop the game's call.
    Drop,
}

/// One message a command body wrote.
#[derive(Clone)]
struct Message {
    /// 0 = success text, 1 = error text.
    kind: u32,
    key: String,
    params: Vec<String>,
}

/// The thread running our command, 0 when none is.
static OURS: AtomicU32 = AtomicU32::new(0);
/// Whether the captured messages must be dropped instead of added.
static QUIET: AtomicBool = AtomicBool::new(false);
static MESSAGES: SpinLock<Vec<Message>> = SpinLock::new(Vec::new());

/// Runs `line` as the local player on the server thread and reports what the command said.
pub(crate) fn run(minecraft: usize, line: &str, quiet: bool) -> Result<Value, RpcError> {
    let execute = anchors::command_execute().ok_or_else(|| RpcError::anchor("command.execute"))?;
    let from_data = anchors::command_origin().ok_or_else(|| RpcError::anchor("command.origin"))?;
    let commands = live::commands().ok_or_else(|| {
        RpcError::anchor("command.commands").with_data(json!({
            "message": "the server has not run a command yet: run one line in chat (t, /help, Return) and retry",
            "wait_for": "command.commands",
        }))
    })?;
    let source = live::command_source(minecraft).ok_or_else(|| RpcError::anchor("server.instance"))?;

    // The origin: `fromData(&out, &data, src, reference, filter)` allocates the player origin with the
    // game's own operator new, so the request destructor can delete it with the same allocator. `src` is
    // the level reference the game's own command path passed, and the level asks its registry for the
    // player whose connection matches `reference` and `filter` — replayed from the arguments a real
    // player command came in with, never invented.
    let Some(call) = captured_call() else {
        return Err(RpcError::anchor("command.origin").with_data(json!({
            "message": "no player command has been seen in this world yet: run one line in chat (t, /help, Return) and retry",
            "wait_for": "command.origin",
        })));
    };
    // Captures are filtered to the server level already; a mismatch here means the server now steps
    // another level, and the call is not replayed against it.
    if call_level(&call) != source[2] {
        if !LEVEL_LOGGED.swap(true, Ordering::AcqRel) {
            agent_core::log::fmt(format_args!(
                "command: the captured origin names level 0x{:x}, the server steps 0x{:x}; not replayed",
                call_level(&call),
                source[2]
            ));
        }
        forget_origin();
        return Err(RpcError::anchor("command.origin").with_data(json!({
            "message": "the captured player command belongs to another level: run one line in chat and retry",
            "wait_for": "command.origin",
        })));
    }
    let Some(line_text) = text::Text::new(line) else {
        return Err(RpcError::standard(agent_core::engine::INTERNAL_ERROR));
    };
    // Marked as ours before `fromData`, so the origin hook knows this capture is our own replay and leaves an
    // armed prime for the player's chat line.
    begin(quiet);
    let mut origin: usize = 0;
    // SAFETY: the game's own builder, called with the out slot and copies of the 0x40-byte origin data,
    // the 0x18-byte level reference and the network identifier, and the filter byte: the exact values
    // the game itself passed when the player ran a command in this world. The identifier is only read
    // during the call, through the lookup predicate.
    unsafe {
        transmute::<usize, unsafe extern "C" fn(*mut usize, *const u8, *const u8, *const u8, u8)>(from_data)(
            &mut origin,
            call.data.as_ptr(),
            call.src.as_ptr(),
            call.reference.as_ptr(),
            call.filter,
        );
    }
    if origin == 0 {
        end();
        // The player could not be resolved from that source: the origin builder refused it.
        return Err(RpcError::anchor("command.origin"));
    }

    let mut result: i32 = 0;
    let mut owner = origin;
    // SAFETY: the game's own synchronous entry, called on the thread that owns the server, with a
    // request line it copies, an origin it takes ownership of, and the flags its own callers use.
    unsafe {
        transmute::<usize, unsafe extern "C" fn(usize, *mut i32, *mut usize, *const u8, u32, u8) -> *mut i32>(execute)(
            commands,
            &mut result,
            &mut owner,
            line_text.as_ptr(),
            COMMAND_FLAGS,
            0,
        );
    }
    end();
    let messages = take();
    Ok(summary(&messages))
}

/// Marks this thread as running one of our commands and clears the captured messages.
fn begin(quiet: bool) {
    MESSAGES.lock().clear();
    QUIET.store(quiet, Ordering::Release);
    OURS.store(agent_core::win::current_thread_id(), Ordering::Release);
}

/// Clears the marker, so messages added by any other command are forwarded untouched again.
fn end() {
    OURS.store(0, Ordering::Release);
}

/// The captured messages, cleared for the next run.
fn take() -> Vec<Message> {
    let mut messages = MESSAGES.lock();
    let taken = messages.clone();
    messages.clear();
    taken
}

/// The wire's `{success, message}` from the messages the command body wrote.
fn summary(messages: &[Message]) -> Value {
    let mut success: Option<bool> = None;
    let mut text = String::new();
    for message in messages {
        if message.kind == 0 {
            success.get_or_insert(true);
        } else {
            success = Some(false);
        }
        if !text.is_empty() {
            text.push_str("; ");
        }
        text.push_str(&message.key);
        if !message.params.is_empty() {
            text.push_str(": ");
            for (index, param) in message.params.iter().enumerate() {
                if index > 0 {
                    text.push_str(", ");
                }
                text.push_str(param);
            }
        }
    }
    json!({
        "success": success.map(Value::Bool).unwrap_or(Value::Null),
        "message": text,
    })
}

/// The `addMessage` hook's body: copies the message while our command runs and reports what to do.
pub(crate) fn capture(_output: usize, key: usize, params: usize, kind: u32) -> Capture {
    let ours = OURS.load(Ordering::Acquire);
    let thread = agent_core::win::current_thread_id();
    if ours == 0 || ours != thread {
        // The client's priming chat line (`command.prime`) stays out of chat; every other command is untouched.
        return if primed(thread) { Capture::Drop } else { Capture::Off };
    }
    let key = message_key(key);
    let mut values = Vec::new();
    if params != 0 {
        let begin = pe::read::<usize>(params).unwrap_or(0);
        let end = pe::read::<usize>(params + 8).unwrap_or(0);
        if end > begin && (end - begin) % PARAM_SIZE == 0 && (end - begin) / PARAM_SIZE <= 64 {
            let mut at = begin;
            while at < end {
                // A parameter whose kind is -1 is hidden and never rendered: skip it, like the game.
                if pe::read::<i32>(at + PARAM_KIND) != Some(-1) {
                    if let Some(value) = pe::std_string(at) {
                        values.push(value);
                    }
                }
                at += PARAM_SIZE;
            }
        }
    }
    MESSAGES.lock().push(Message { kind, key, params: values });
    if QUIET.load(Ordering::Acquire) {
        Capture::Drop
    } else {
        Capture::Keep
    }
}

/// The message key `addMessage` was handed: a `std::string` per the decode, else a `{ptr, len}` view.
/// The first key that reads as neither logs its four words once, so the layout can be settled from the
/// log instead of answering a wrong key.
///
/// There is no C-string fallback: read at a `std::string` holding a heap pointer, it turned the
/// pointer's own low bytes into a "key" (live, once after a reload: `@/Ay: 6000`).
fn message_key(key: usize) -> String {
    if let Some(text) = pe::std_string(key).filter(|text| plain(text)) {
        return text;
    }
    // A `{ptr, len}` view: a key, or a raw (already localized) text the command wrote as is, which is
    // accepted only when every one of its `len` bytes is printable UTF-8 — never a guess at a length.
    if let (Some(pointer), Some(length)) = (pe::read::<usize>(key), pe::read::<usize>(key + 8)) {
        if (1..=256).contains(&length) {
            if let Some(text) = pe::bytes(pointer, length)
                .and_then(|bytes| core::str::from_utf8(bytes).ok())
                .filter(|text| plain(text) || printable(text))
            {
                return String::from(text);
            }
        }
    }
    if !KEY_LOGGED.swap(true, Ordering::AcqRel) {
        let word = |at: usize| pe::read::<usize>(key + at).unwrap_or(0);
        agent_core::log::fmt(format_args!(
            "command: unreadable message key at 0x{key:x}: {:x} {:x} {:x} {:x}",
            word(0),
            word(8),
            word(0x10),
            word(0x18)
        ));
    }
    String::new()
}

/// A message key is a dotted name of letters, digits, `_`, `-` and `%` (`commands.time.query.daytime`,
/// `%potion.moveSlowdown`): anything else is not a key, whatever bytes it happens to read as.
fn plain(text: &str) -> bool {
    text.len() >= 3
        && text.contains('.')
        && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'%'))
}

/// Text a player could read: no control characters (the `§` colour codes are ordinary characters).
fn printable(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| !c.is_control())
}

static KEY_LOGGED: AtomicBool = AtomicBool::new(false);
