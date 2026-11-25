//! The content log as the game emits it: every message the game hands its content log, kept in a ring
//! the wire reads with `log.content`, whether or not a content-log file or the in-game GUI is on.
//!
//! The game logs a content message through one variadic entry (`ContentLog::log(this, bool, level,
//! area, fmt, ...)`), which tests the log's enabled flag and hands its arguments to one writer
//! (`_writeToLog(this, bool, area, level, va_list*)`): the writer formats the message and passes it to
//! every registered end point (the file, the GUI). The writer is hooked; the detour formats the same
//! `va_list` once more with the C runtime's own `vsnprintf` core (`__stdio_common_vsprintf`, which the
//! writer itself calls) without advancing it, keeps the message, and forwards the call unchanged.
//!
//! The recipes, none of them an address:
//!
//! * `contentlog.writer`: the one function whose body builds the default scope name `Unknown_Scope`
//!   from two `movabs` immediates (`"Unknown_"`, `"wn_Scope"`), each of which occurs once in `.text`.
//! * `contentlog.log`: the writer's only direct caller. Its body tests the enabled flag
//!   (`cmp byte [rcx+FLAG], 1; jne`) before the call, which gives the flag's offset.
//! * `contentlog.instance`: the global the game keeps its `ContentLog*` in: the RIP-relative qword the
//!   callers of `contentlog.log` load into `rcx` right before the call (three in four must agree).
//! * `contentlog.levels` / `contentlog.areas`: the name tables the file end point prints `[area][level]`
//!   with: the `.rdata` table of four pointers to `verbose`, `inform`, `warning`, `error`, and the table
//!   the same formatting functions index by area after a `cmp reg, N-1; ja` bound check.
//!
//! The log's enabled flag is the game's own "is any end point enabled": with the file and the GUI both
//! off the game skips the writer entirely. While a `log.content` reader exists, the main-thread drain
//! keeps that flag on (the end points still decide for themselves, so nothing appears in a file or on
//! screen that the user did not enable), and the unload puts it back off when the agent turned it on.

use alloc::collections::VecDeque;
use alloc::string::String;
use alloc::vec::Vec;
use core::mem::transmute;
use core::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use agent_core::sync::SpinLock;
use agent_core::{Anchor, Core, Image, RpcError};
use serde_json::{json, Value};

use crate::{inventory, logring, pe};

/// `engine.status.hooks` name of the writer hook.
const SITE: &str = "contentlog.writer";
/// `movabs rax, "Unknown_"` and `movabs rax, "wn_Scope"`: the writer's default scope name.
const SCOPE_HEAD: &str = "48 B8 55 6E 6B 6E 6F 77 6E 5F";
const SCOPE_TAIL: &str = "48 B8 77 6E 5F 53 63 6F 70 65";
/// `cmp byte [rcx+FLAG], 1; jne`: the enabled test in `contentlog.log`.
const FLAG_TEST: [Option<u8>; 5] = [Some(0x80), Some(0x79), None, Some(0x01), Some(0x75)];
/// How far before a call to `contentlog.log` the `mov rcx, [rip+X]` of the instance is looked for.
const INSTANCE_WINDOW: usize = 0x60;
/// The level names, in the game's own order (`verbose` 0 … `error` 3).
const LEVEL_NAMES: [&[u8]; 4] = [b"verbose", b"inform", b"warning", b"error"];
/// An area table is a handful of dozen names; a bound past this is not one.
const AREAS_MAX: usize = 256;
/// The longest message kept, in bytes; a longer one is cut.
const MESSAGE_MAX: usize = 16 * 1024;
/// `_CRT_INTERNAL_PRINTF_STANDARD_SNPRINTF_BEHAVIOR`: a cut message is NUL-terminated and the full
/// length is returned, so a long message can be formatted again into a buffer that fits.
const PRINTF_SNPRINTF: u64 = 2;

static WRITER: AtomicUsize = AtomicUsize::new(0);
static LOG: AtomicUsize = AtomicUsize::new(0);
/// The global that holds the `ContentLog*`.
static INSTANCE_SLOT: AtomicUsize = AtomicUsize::new(0);
/// Offset of the enabled flag in the `ContentLog`, 0 while unresolved.
static FLAG_AT: AtomicUsize = AtomicUsize::new(0);
static LEVELS: AtomicUsize = AtomicUsize::new(0);
static AREAS: AtomicUsize = AtomicUsize::new(0);
static AREA_COUNT: AtomicUsize = AtomicUsize::new(0);
static PRINTF: AtomicUsize = AtomicUsize::new(0);
/// The writer hook's trampoline, 0 while not installed.
static TRAMPOLINE: AtomicUsize = AtomicUsize::new(0);
/// The `ContentLog*` the writer was last entered with.
static SEEN: AtomicUsize = AtomicUsize::new(0);
/// A reader asked for the log, so the drain keeps the game emitting it.
static WANTED: AtomicBool = AtomicBool::new(false);
/// The agent turned the game's enabled flag on (and turns it off again at unload).
static FORCED: AtomicBool = AtomicBool::new(false);

/// One message as the game emitted it.
struct Entry {
    seq: u64,
    /// Milliseconds since the Unix epoch, when the writer was entered.
    time: u64,
    area: u32,
    level: u32,
    message: String,
}

struct Ring {
    entries: VecDeque<Entry>,
    /// The number the next entry gets (the first is 1).
    next: u64,
}

static RING: SpinLock<Ring> = SpinLock::new(Ring { entries: VecDeque::new(), next: 1 });

#[link(name = "kernel32", kind = "raw-dylib")]
extern "system" {
    fn GetSystemTimeAsFileTime(time: *mut u64);
}

/// Milliseconds since the Unix epoch.
fn now_ms() -> u64 {
    let mut filetime = 0u64;
    // SAFETY: the out pointer is a valid `u64` (`FILETIME` is two `u32` in little-endian order).
    unsafe { GetSystemTimeAsFileTime(&mut filetime) };
    filetime.saturating_sub(116_444_736_000_000_000) / 10_000
}

fn get(slot: &AtomicUsize) -> Option<usize> {
    match slot.load(Ordering::Acquire) {
        0 => None,
        value => Some(value),
    }
}

/// Resolves every recipe and installs the writer hook. Called once, from `Engine::attach`.
pub(crate) fn resolve(core: &'static Core) -> Vec<Anchor> {
    let image = core.image();
    let patterns = [pe::parse_pattern(SCOPE_HEAD), pe::parse_pattern(SCOPE_TAIL)];
    let sites = inventory::all_sites(image, &patterns);
    let writer = match (&sites[0][..], &sites[1][..]) {
        ([head], [tail]) => {
            let start = image.function_start(*head);
            (start.is_some() && start == image.function_start(*tail)).then(|| start).flatten()
        }
        _ => None,
    };
    if let Some(writer) = writer {
        WRITER.store(writer, Ordering::Release);
        resolve_log(image, writer);
    }
    resolve_tables(image);
    let printf = export("ucrtbase.dll", b"__stdio_common_vsprintf\0");
    PRINTF.store(printf, Ordering::Release);
    if let (Some(writer), Some(_)) = (writer, get(&PRINTF)) {
        match agent_core::hook::install_published(writer, detour as *const () as usize, &TRAMPOLINE) {
            Some(_) => {
                core.site(SITE, true);
                agent_core::log::fmt(format_args!("hook {SITE}: installed at 0x{writer:x}"));
            }
            None => {
                core.site(SITE, false);
                agent_core::log::fmt(format_args!("hook {SITE}: refused, game code untouched"));
            }
        }
    } else {
        core.site(SITE, false);
    }
    agent_core::log::fmt(format_args!(
        "resolve contentlog: writer 0x{:x}, log 0x{:x}, instance slot 0x{:x}, flag +0x{:x}, levels 0x{:x}, areas 0x{:x} ({}), printf 0x{:x}",
        WRITER.load(Ordering::Acquire),
        LOG.load(Ordering::Acquire),
        INSTANCE_SLOT.load(Ordering::Acquire),
        FLAG_AT.load(Ordering::Acquire),
        LEVELS.load(Ordering::Acquire),
        AREAS.load(Ordering::Acquire),
        AREA_COUNT.load(Ordering::Acquire),
        PRINTF.load(Ordering::Acquire),
    ));
    report()
}

/// The anchors for `engine.status`.
pub(crate) fn report() -> Vec<Anchor> {
    alloc::vec![
        Anchor { name: "contentlog.writer", addr: WRITER.load(Ordering::Acquire) },
        Anchor { name: "contentlog.log", addr: LOG.load(Ordering::Acquire) },
        Anchor { name: "contentlog.instance", addr: INSTANCE_SLOT.load(Ordering::Acquire) },
        Anchor { name: "contentlog.levels", addr: LEVELS.load(Ordering::Acquire) },
        Anchor { name: "contentlog.areas", addr: AREAS.load(Ordering::Acquire) },
        Anchor { name: "contentlog.printf", addr: PRINTF.load(Ordering::Acquire) },
    ]
}

/// A function of a module the game already loaded, or 0.
fn export(module: &str, name: &[u8]) -> usize {
    let handle = agent_core::win::module(module);
    if handle == 0 {
        return 0;
    }
    // SAFETY: `handle` is a loaded module; `name` is NUL-terminated.
    unsafe { agent_core::win::GetProcAddress(handle, name.as_ptr()) as usize }
}

/// `contentlog.log` (the writer's only direct caller), the flag offset from its enabled test, and the
/// instance global its callers load.
fn resolve_log(image: &Image, writer: usize) {
    let mut callers: Vec<usize> = Vec::new();
    for site in pe::callers(image, writer) {
        if let Some(start) = image.function_start(site) {
            if !callers.contains(&start) {
                callers.push(start);
            }
        }
    }
    let [log] = callers[..] else {
        return;
    };
    let Some((start, end)) = pe::function_of(image, log) else {
        return;
    };
    let Some(body) = pe::bytes(start, end - start) else {
        return;
    };
    let mut flag: Option<usize> = None;
    for window in body.windows(FLAG_TEST.len()) {
        if window.iter().zip(FLAG_TEST.iter()).all(|(byte, want)| want.is_none_or(|want| want == *byte)) {
            if flag.is_some() {
                return; // two tests: not the entry this recipe describes
            }
            flag = Some(window[2] as usize);
        }
    }
    let Some(flag) = flag.filter(|flag| *flag != 0) else {
        return;
    };
    LOG.store(log, Ordering::Release);
    FLAG_AT.store(flag, Ordering::Release);

    // The instance: the global loaded into `rcx` closest before each call.
    let mut votes: Vec<(usize, usize)> = Vec::new();
    let mut voters = 0usize;
    for site in pe::callers(image, log) {
        let Some(before) = pe::bytes(site.saturating_sub(INSTANCE_WINDOW), INSTANCE_WINDOW) else {
            continue;
        };
        let mut found = None;
        let mut at = before.len().saturating_sub(7);
        loop {
            if before[at..at + 3] == [0x48, 0x8B, 0x0D] {
                let disp = i32::from_le_bytes([before[at + 3], before[at + 4], before[at + 5], before[at + 6]]) as isize;
                found = Some((site - INSTANCE_WINDOW + at + 7).wrapping_add_signed(disp));
                break;
            }
            if at == 0 {
                break;
            }
            at -= 1;
        }
        let Some(global) = found else {
            continue;
        };
        voters += 1;
        match votes.iter_mut().find(|(address, _)| *address == global) {
            Some((_, count)) => *count += 1,
            None => votes.push((global, 1)),
        }
    }
    votes.sort_by(|a, b| b.1.cmp(&a.1));
    if let Some((global, count)) = votes.first().copied() {
        if count >= 8 && count * 4 >= voters * 3 && pe::in_data(image, global) {
            INSTANCE_SLOT.store(global, Ordering::Release);
        }
    }
}

/// The level and area name tables.
fn resolve_tables(image: &Image) {
    // The linker shares string tails (`verbose` is the end of a longer option key), so the table is
    // matched by what each of its four pointers reads, not by where a lone copy of the word sits.
    // The image's data sections are mapped for the life of the process, so each one is checked readable once
    // and a candidate pointer is then read in place when it lies wholly inside one (no `VirtualQuery` per
    // qword of `.rdata`). The bound is computed without overflow: a qword such as -1 must not wrap into range.
    let sections: Vec<(usize, usize)> = image
        .sections()
        .iter()
        .filter(|section| section.is_data() && pe::readable(section.va, section.len))
        .map(|section| (section.va, section.va + section.len))
        .collect();
    let word_at = |pointer: usize, word: &[u8]| -> bool {
        let Some(end) = pointer.checked_add(word.len() + 1) else {
            return false;
        };
        sections.iter().any(|(start, limit)| pointer >= *start && end <= *limit) && {
            // SAFETY: `[pointer, end)` lies inside one of the image's data sections, verified readable above.
            let text = unsafe { core::slice::from_raw_parts(pointer as *const u8, word.len() + 1) };
            &text[..word.len()] == word && text[word.len()] == 0
        }
    };
    let mut levels: Option<usize> = None;
    for section in image.sections() {
        if !section.name().starts_with(".rdata") {
            continue;
        }
        let Some(bytes) = pe::bytes(section.va, section.len) else {
            continue;
        };
        let mut at = 0usize;
        while at + 32 <= bytes.len() {
            let entry = |index: usize| usize::from_le_bytes(bytes[at + index * 8..at + index * 8 + 8].try_into().unwrap_or([0; 8]));
            if (0..4).all(|index| word_at(entry(index), LEVEL_NAMES[index])) {
                if levels.is_some() {
                    return; // two tables: refuse rather than pick one
                }
                levels = Some(section.va + at);
            }
            at += 8;
        }
    }
    let Some(levels) = levels else {
        return;
    };
    LEVELS.store(levels, Ordering::Release);

    // The area table: indexed after a bound check in the functions that format with the level table.
    let refs = pe::scan_refs(image, &[levels]);
    let functions = refs.first().map(|sites| pe::functions_of(image, sites)).unwrap_or_default();
    let mut found: Option<(usize, usize)> = None;
    for function in functions {
        let Some((start, end)) = pe::function_of(image, function) else {
            continue;
        };
        let Some(body) = pe::bytes(start, end - start) else {
            continue;
        };
        let mut at = 0usize;
        while at + 7 <= body.len() {
            let lea = matches!(body[at], 0x48 | 0x4C) && body[at + 1] == 0x8D && body[at + 2] & 0xC7 == 0x05;
            if !lea {
                at += 1;
                continue;
            }
            let disp = i32::from_le_bytes([body[at + 3], body[at + 4], body[at + 5], body[at + 6]]) as isize;
            let target = (start + at + 7).wrapping_add_signed(disp);
            if target != levels && pe::in_data(image, target) {
                if let Some(count) = bound_before(&body[at.saturating_sub(16)..at]) {
                    if (1..=AREAS_MAX).contains(&count) && (0..count).all(|index| name_at(target, index).is_some()) {
                        if found.is_some_and(|known| known != (target, count)) {
                            return; // the functions disagree
                        }
                        found = Some((target, count));
                    }
                }
            }
            at += 7;
        }
    }
    if let Some((areas, count)) = found {
        AREAS.store(areas, Ordering::Release);
        AREA_COUNT.store(count, Ordering::Release);
    }
}

/// `N + 1` from the last `cmp r, N; ja` (`[REX] 83 F8+r N 77 rel8`) in `before`.
fn bound_before(before: &[u8]) -> Option<usize> {
    let mut at = before.len().checked_sub(5)?;
    loop {
        if before[at] == 0x83 && (0xF8..=0xFF).contains(&before[at + 1]) && before[at + 3] == 0x77 {
            return Some(before[at + 2] as usize + 1);
        }
        if at == 0 {
            return None;
        }
        at -= 1;
    }
}

/// The name a table entry points at: a short printable NUL-terminated string in the image.
fn name_at(table: usize, index: usize) -> Option<String> {
    let pointer = pe::read::<usize>(table + index * 8)?;
    if !pe::in_image_data(pointer) {
        return None;
    }
    let text = pe::cstr(pointer, 64)?;
    (!text.is_empty() && text.iter().all(|byte| byte.is_ascii_graphic())).then(|| String::from_utf8_lossy(text).into_owned())
}

fn level_name(level: u32) -> Value {
    get(&LEVELS).filter(|_| level < 4).and_then(|table| name_at(table, level as usize)).map(Value::String).unwrap_or(Value::Null)
}

fn area_name(area: u32) -> Value {
    let count = AREA_COUNT.load(Ordering::Acquire);
    get(&AREAS).filter(|_| (area as usize) < count).and_then(|table| name_at(table, area as usize)).map(Value::String).unwrap_or(Value::Null)
}

/// The writer: `(ContentLog*, bool, LogArea, LogLevel, va_list*)`, the fifth on the stack. Every
/// argument is forwarded as it arrived.
extern "C" fn detour(this: usize, flag: usize, area: usize, level: usize, args: usize) -> usize {
    if let Some(core) = agent_core::hub::started() {
        core.site_fired(SITE);
    }
    if this != 0 {
        SEEN.store(this, Ordering::Release);
    }
    capture(area as u32, level as u32, args);
    let original = TRAMPOLINE.load(Ordering::Acquire);
    if original == 0 {
        return 0;
    }
    // SAFETY: the trampoline is the relocated prologue of the writer; the four argument registers and
    // the stack-passed fifth are forwarded exactly as they arrived.
    unsafe { transmute::<usize, extern "C" fn(usize, usize, usize, usize, usize) -> usize>(original)(this, flag, area, level, args) }
}

/// Formats the message the writer is about to format and keeps it.
///
/// `args` points at the caller's `va_list`, whose first element is the format; the writer advances it
/// past the format itself, so this reads it without writing it back.
fn capture(area: u32, level: u32, args: usize) {
    let Some(printf) = get(&PRINTF) else {
        return;
    };
    let Some(list) = pe::read::<usize>(args).filter(|list| *list != 0) else {
        return;
    };
    let Some(format) = pe::read::<usize>(list).filter(|format| *format != 0) else {
        return;
    };
    let rest = list + 8;
    // SAFETY: the C runtime's own formatting core, with the format and the argument list the game is
    // about to format with it; the list is a copy of the caller's cursor (a plain pointer on x64).
    let print = |buffer: &mut [u8]| unsafe {
        transmute::<usize, unsafe extern "C" fn(u64, *mut u8, usize, usize, usize, usize) -> i32>(printf)(
            PRINTF_SNPRINTF,
            buffer.as_mut_ptr(),
            buffer.len(),
            format,
            0,
            rest,
        )
    };
    let mut buffer = alloc::vec![0u8; 512];
    let mut length = print(&mut buffer);
    if length < 0 {
        return;
    }
    if length as usize >= buffer.len() {
        buffer = alloc::vec![0u8; (length as usize + 1).min(MESSAGE_MAX + 1)];
        length = print(&mut buffer);
        if length < 0 {
            return;
        }
    }
    let length = (length as usize).min(buffer.len() - 1);
    buffer.truncate(length);
    let mut message = String::from_utf8_lossy(&buffer).into_owned();
    while message.ends_with(['\n', '\r']) {
        message.pop();
    }
    let time = now_ms();
    let mut ring = RING.lock();
    let seq = ring.next;
    ring.next += 1;
    if ring.entries.len() >= logring::CAPACITY {
        ring.entries.pop_front();
    }
    ring.entries.push_back(Entry { seq, time, area, level, message });
}

/// The game's enabled flag now: `Some(true)` while the game hands messages to the writer.
fn emitting() -> Option<bool> {
    let flag = get(&FLAG_AT)?;
    let log = instance()?;
    pe::read::<u8>(log + flag).map(|value| value != 0)
}

/// The `ContentLog*`: the one the writer last ran with, else the global's.
fn instance() -> Option<usize> {
    let seen = SEEN.load(Ordering::Acquire);
    if seen != 0 {
        return Some(seen);
    }
    let slot = get(&INSTANCE_SLOT)?;
    pe::read::<usize>(slot).filter(|log| *log != 0 && pe::readable(*log, FLAG_AT.load(Ordering::Acquire) + 1))
}

/// Per main-thread drain: while a reader wants the log, keep the game emitting it.
pub(crate) fn frame() {
    if !WANTED.load(Ordering::Acquire) || TRAMPOLINE.load(Ordering::Acquire) == 0 {
        return;
    }
    let (Some(flag), Some(log)) = (get(&FLAG_AT), instance()) else {
        return;
    };
    if pe::read::<u8>(log + flag) != Some(0) || !pe::writable(log + flag, 1) {
        return;
    }
    // SAFETY: the flag byte of the game's own `ContentLog`, verified writable; the game reads it
    // without a lock before every message and writes it only when an end point changes.
    unsafe { core::ptr::write_volatile((log + flag) as *mut u8, 1) };
    if !FORCED.swap(true, Ordering::AcqRel) {
        agent_core::log::line("contentlog: no end point is enabled; the agent keeps the content log emitting while it reads it");
    }
}

/// Unload: the enabled flag goes back off when the agent turned it on.
pub(crate) fn detach() {
    if !FORCED.swap(false, Ordering::AcqRel) {
        return;
    }
    let (Some(flag), Some(log)) = (get(&FLAG_AT), instance()) else {
        return;
    };
    if pe::read::<u8>(log + flag) == Some(1) && pe::writable(log + flag, 1) {
        // SAFETY: the same flag byte, back to the value the game had before the agent turned it on.
        unsafe { core::ptr::write_volatile((log + flag) as *mut u8, 0) };
    }
}

/// `log.content {since?, limit?}` → `{entries: [{seq, time, area, level, message}], next, dropped,
/// emitting, forced}`.
pub(crate) fn h_content(_core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    if TRAMPOLINE.load(Ordering::Acquire) == 0 {
        let missing = if get(&WRITER).is_none() { "contentlog.writer" } else { "contentlog.printf" };
        return Err(RpcError::anchor(missing));
    }
    let number = |key: &str| -> Result<Option<u64>, RpcError> {
        match params.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_u64()
                .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
                .map(Some)
                .ok_or_else(|| RpcError::invalid_params(alloc::format!("{key} must be a non-negative whole number"))),
        }
    };
    let since = number("since")?.unwrap_or(0);
    let limit = number("limit")?.unwrap_or(logring::LIMIT_DEFAULT);
    WANTED.store(true, Ordering::Release);
    let (window, picked) = {
        let ring = RING.lock();
        let oldest = ring.entries.front().map(|entry| entry.seq).unwrap_or(ring.next);
        let window = logring::window(oldest, ring.entries.len() as u64, since, limit);
        let picked: Vec<(u64, u64, u32, u32, String)> = ring
            .entries
            .iter()
            .filter(|entry| entry.seq >= window.start && entry.seq < window.end)
            .map(|entry| (entry.seq, entry.time, entry.area, entry.level, entry.message.clone()))
            .collect();
        (window, picked)
    };
    let entries: Vec<Value> = picked
        .into_iter()
        .map(|(seq, time, area, level, message)| {
            json!({ "seq": seq, "time": time, "area": area_name(area), "level": level_name(level), "message": message })
        })
        .collect();
    Ok(json!({
        "entries": entries,
        "next": window.next,
        "dropped": window.dropped,
        "emitting": emitting(),
        "forced": FORCED.load(Ordering::Acquire),
    }))
}
