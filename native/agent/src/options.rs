//! The game's own options, read from the option records themselves.
//!
//! The registry object that indexes the options is a heap allocation whose only references live in
//! the client's own services, and a late attach has never found a pointer to it. The records are
//! reachable without it: every option is a small heap object whose first word is one of nine class
//! tables, and whose `+0x08` points at the definition that carries the `options.txt` tag, the option
//! id and the value kind. So the engine enumerates the records:
//!
//! 1. the nine class tables are derived from the registration function's own constructors — each
//!    constructor stores its class table into the record it builds (`lea reg,[rip+table]`), and a
//!    class table is five code slots, then a zero (the nine tables sit `0x30` bytes apart, and a
//!    recipe that does not yield at least four of them stores nothing);
//! 2. the writable heap is scanned once for objects that start with one of those tables;
//! 3. a candidate is kept only when its definition proves itself: the definition's own id is below
//!    the registry's 825 entries, its value kind is one the setters handle, and its save tag is a
//!    printable name — the same self-check the registry's own `add` relies on.
//!
//! When the registry object *is* reachable — the registration hook caught it on an early attach, a
//! field of an object the engine already steps points at it, or it sits in the same heap regions as
//! its records — it is preferred, because it also owns the asynchronous writer
//! ([`SAVE_SLOT`]) that `settings.set` arms so the game writes `options.txt` itself. Without it the
//! change is live and reported with `saved: false`, never claimed as written.
//!
//! Nothing here writes a value by hand: `settings.set` calls the record's own string setter, which
//! parses, clamps to the option's range, stores the value and fires every change listener the game
//! installed. A value the setter refuses leaves the option untouched and is reported as an error
//! instead of a fake success.

use alloc::string::String;
use alloc::vec::Vec;
use core::ptr;
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};

use agent_core::sync::SpinLock;
use agent_core::{Image, RpcError};
use serde_json::{json, Value};

use crate::{live, pe};

/* ------------------------------------------------------------------------------------------------
 * The registry object
 * ---------------------------------------------------------------------------------------------- */

/// The record array inside the registry: `Option* mOptions[825]`.
const OPTIONS_ARRAY: usize = 0x10;
/// The array's length (`mOptions[825]`).
const OPTIONS_COUNT: usize = 825;

/// `mov [rsi + rdi*8 + 0x10], rbx` inside the registry's `add(std::unique_ptr<Option>&&)`: the store
/// that puts a record into `mOptions[id]`. Unique in the image (verified against 1.26.63).
const REGISTRY_STORE: &[u8] = &[0x48, 0x89, 0x5C, 0xFE, 0x10];
/// `cmp rdi, 825` in the same body: the capacity check that proves the store's function is the
/// registry append and not some other indexed store.
const REGISTRY_CAPACITY: &[u8] = &[0x48, 0x81, 0xFF, 0x39, 0x03, 0x00, 0x00];
/// `add`'s slot in the registry's vtable.
const ADD_SLOT: usize = 0x88;
/// The registry vtables holding `add` at that slot.
const VTABLES: usize = 4;

/// The registry's own asynchronous writer: `OptionRegistry::_saveAsync` at vtable slot `0xa8`.
const SAVE_SLOT: usize = 0xa8;
/// The writer's request flags: "armed" (u8) and the mode (u32, 1 = the file only).
const SAVE_ARMED: usize = 0x1a2a;
const SAVE_MODE: usize = 0x1a2c;
const SAVE_FILE_ONLY: u32 = 1;
/// The `std::string` the writer was last given as its path (evidence, and nothing is built on it).
const SAVE_PATH: usize = 0x1a08;

/* ------------------------------------------------------------------------------------------------
 * The option records
 * ---------------------------------------------------------------------------------------------- */

/// The nine record classes: a table with five code slots and a trailing zero.
const CLASS_TABLES: usize = 9;
/// How many slots a class table has before the trailing zero.
const CLASS_CODE_SLOTS: usize = 5;
/// The slot holding `setValue(std::string const&)`.
const SETTER_SLOT: usize = 4 * 8;
/// A record constructor is small; anything larger is not one of the nine.
const CONSTRUCTOR_MAX: usize = 0x2000;

/// Record fields: the definition it belongs to, its range, its live value, and the two value shapes
/// the flag/string classes use instead of `+0x18`.
const RECORD_DEFINITION: usize = 0x08;
const RECORD_MAX: usize = 0x10;
const RECORD_MIN: usize = 0x14;
const RECORD_VALUE: usize = 0x18;
/// A flag record keeps its value in the byte `+0x10`; an enum record keeps an int there.
const RECORD_BOOL: usize = 0x10;
/// A string record keeps a `std::string` here.
const RECORD_STRING: usize = 0x10;
const RECORD_VALUES_BEGIN: usize = 0x28;
const RECORD_VALUES_END: usize = 0x30;

/// Definition fields: the save tag (`std::string`, so its size at `+0x10`), the id the record's
/// definition must name, and the value kind the record's setter parses.
const DEFINITION_TAG: usize = 0x188;
const DEFINITION_ID: usize = 0x1cc;
const DEFINITION_KIND: usize = 0x1d4;

/// `OptionDefinition+0x1d4`: what the value is.
const KIND_BOOL: u32 = 0;
const KIND_ENUM: u32 = 1;
const KIND_FLOAT: u32 = 2;
const KIND_ENUM_VARIANT: u32 = 3;
const KIND_STRING: u32 = 4;
const KIND_INT: u32 = 5;
/// An int picked from the record's own value list (`game_thirdperson`: 0, 1, 2). Its record class
/// shares the int class's parser and setter slots, and it keeps the value, range and list where an
/// int record does.
const KIND_INT_CHOICE: u32 = 6;
const KIND_STRING_LIST: u32 = 8;

/* ------------------------------------------------------------------------------------------------
 * The scan
 * ---------------------------------------------------------------------------------------------- */

/// How much of one region is read at a time; a single unreadable page costs that page, not the region.
const SCAN_CHUNK: usize = 1 << 20;
/// The scan's deadline when it runs on the game's own thread: short enough to answer inside the
/// client's request timeout, long enough to walk a real heap.
const FAST_MS: u64 = 3_000;
/// The deadline when it runs off the game's thread (the recovery thread), where nothing waits.
const SLOW_MS: u64 = 12_000;
/// The soonest a main-thread retry is allowed after a failed scan, so a client that asks repeatedly
/// cannot turn into a repeated stall.
const RETRY_MS: u64 = 20_000;
/// How much of the record regions the registry search may read, after the records are found.
const NEAR_BUDGET: usize = 256 * 1024 * 1024;
/// Its own deadline: the registry sits in the same arena as its records, so this is a short walk.
const NEAR_MS: u64 = 2_000;
/// How much of the address space the wider registry search may read, off the game's thread only.
const CONTAINER_BUDGET: usize = 768 * 1024 * 1024;
/// How far into an object `settings.*` looks for a registry pointer.
const OBJECT_WINDOW: usize = 0x4000;
/// A candidate hit list longer than this is not a set of records.
const HITS: usize = 16384;

/// One option record found in the heap, with the id its definition reports.
#[derive(Clone, Copy)]
struct Found {
    id: u32,
    record: usize,
}

/// What a record's definition says about it; the same data every read validates against.
struct Report {
    id: u32,
    kind: u32,
    tag: String,
}

/// The registry vtables, 0 for an empty entry.
static VTABLE_TABLE: [AtomicUsize; VTABLES] =
    [AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0)];
/// The nine record class tables, 0 for an empty entry.
static CLASS_TABLE: [AtomicUsize; CLASS_TABLES] = [
    AtomicUsize::new(0),
    AtomicUsize::new(0),
    AtomicUsize::new(0),
    AtomicUsize::new(0),
    AtomicUsize::new(0),
    AtomicUsize::new(0),
    AtomicUsize::new(0),
    AtomicUsize::new(0),
    AtomicUsize::new(0),
];

/// The discovered registry object, 0 while unknown.
static CONTAINER: AtomicUsize = AtomicUsize::new(0);
/// The registry's `add` function, resolved from its store instruction.
static ADD: AtomicUsize = AtomicUsize::new(0);
/// The records found in the heap, in id order, one entry per (id, record) pair.
static RECORDS: SpinLock<Vec<Found>> = SpinLock::new(Vec::new());
/// `settings.*` has a source.
static READY: AtomicBool = AtomicBool::new(false);
/// The module's writable data has been searched for a registry pointer.
static SCANNED_DATA: AtomicBool = AtomicBool::new(false);
/// The heap scan, so two callers never walk the address space at once.
const SCAN_IDLE: u32 = 0;
const SCAN_RUNNING: u32 = 1;
const SCAN_DONE: u32 = 2;
const SCAN_FAILED: u32 = 3;
static SCAN: AtomicU32 = AtomicU32::new(SCAN_IDLE);
/// The last scan failure's tick, for [`RETRY_MS`].
static SCAN_REFUSED_AT: AtomicUsize = AtomicUsize::new(0);

/* ------------------------------------------------------------------------------------------------
 * Attach-time resolution
 * ---------------------------------------------------------------------------------------------- */

/// Resolves the registry vtables and the nine record class tables from the loaded image, and returns
/// the first registry vtable (`None` when it did not resolve).
///
/// The registry recipe is its own append: `mov [rsi + rdi*8 + 0x10], rbx` (unique in the image) in a
/// body that also checks the 825-entry capacity, then every `.rdata` word holding that function gives
/// the table it is slot `0x88` of. The record classes are derived from the registration function's
/// constructors (see [`resolve_classes`]).
pub(crate) fn resolve(image: &Image) -> Option<usize> {
    let registry = match registry_vtable() {
        Some(vtable) => Some(vtable),
        None => resolve_registry(image),
    };
    if class_count() == 0 {
        let found = resolve_classes(image);
        let tables: Vec<alloc::string::String> = CLASS_TABLE
            .iter()
            .filter_map(|slot| match slot.load(Ordering::Acquire) {
                0 => None,
                address => Some(alloc::format!("0x{:x}", address - image.base())),
            })
            .collect();
        agent_core::log::fmt(format_args!("options: {found} record class tables ({})", tables.join(", ")));
    }
    registry
}

/// The first registry vtable, or `None`.
fn registry_vtable() -> Option<usize> {
    VTABLE_TABLE.iter().find_map(|slot| match slot.load(Ordering::Acquire) {
        0 => None,
        address => Some(address),
    })
}

/// How many record class tables resolved.
fn class_count() -> usize {
    CLASS_TABLE.iter().filter(|slot| slot.load(Ordering::Acquire) != 0).count()
}

/// The registry's `add(std::unique_ptr<Option>&&)`: the one function in the image containing the
/// `mOptions[id]` store, in a body that also checks the 825-entry capacity. Resolved once.
fn add_function(image: &Image) -> Option<usize> {
    match ADD.load(Ordering::Acquire) {
        0 => {}
        address => return Some(address),
    }
    let code = pe::code(image)?;
    let mut store = None;
    let mut at = 0usize;
    while at + REGISTRY_STORE.len() <= code.bytes.len() {
        if &code.bytes[at..at + REGISTRY_STORE.len()] == REGISTRY_STORE {
            if store.is_some() {
                return None; // not unique: refuse rather than pick one
            }
            store = Some(code.va + at);
        }
        at += 1;
    }
    let (start, end) = pe::function_of(image, store?)?;
    if !pe::has_pattern(start, end.saturating_sub(start), REGISTRY_CAPACITY) {
        return None;
    }
    ADD.store(start, Ordering::Release);
    Some(start)
}

/// Resolves the registry's `add` from its own store instruction, then the `.rdata` table it is a slot
/// of. A recipe that does not resolve uniquely stores nothing.
fn resolve_registry(image: &Image) -> Option<usize> {
    let start = add_function(image)?;
    let text = image.text()?;
    let text_end = text.va + text.len;
    let mut found = 0usize;
    for section in image.sections() {
        if !section.is_data() {
            continue;
        }
        let Some(bytes) = pe::bytes(section.va, section.len) else {
            continue;
        };
        let mut offset = 0usize;
        while offset + 8 <= bytes.len() && found < VTABLES {
            // SAFETY: eight bytes are inside the readable section.
            let word = unsafe { ptr::read_unaligned(bytes.as_ptr().add(offset) as *const u64) } as usize;
            offset += 8;
            if word != start {
                continue;
            }
            let Some(vtable) = (section.va + offset - 8).checked_sub(ADD_SLOT) else {
                continue;
            };
            // The slot must be the append again, and the table's first slot must be code.
            if pe::read::<usize>(vtable + ADD_SLOT) != Some(start) {
                continue;
            }
            if pe::read::<usize>(vtable).is_none_or(|first| !(first >= text.va && first < text_end)) {
                continue;
            }
            VTABLE_TABLE[found].store(vtable, Ordering::Release);
            found += 1;
        }
    }
    if found == 0 {
        return None;
    }
    agent_core::log::fmt(format_args!(
        "options: registry vtable 0x{:x} ({} tables)",
        VTABLE_TABLE[0].load(Ordering::Acquire) - image.base(),
        found
    ));
    registry_vtable()
}

/// Resolves the nine record class tables from the registry's own registration code.
///
/// Every option is built by a class constructor that stores its own table into the record
/// (`lea reg,[rip+table]` … `mov [this], reg`), and those constructors are direct callees of the
/// function that registers the options. That function is reached two ways, and both are used: the
/// registry append's own callers (the append is [`add_function`], resolved from its store instruction
/// without any anchor), and the save-tag function [`crate::anchors::options_registry`] resolved from
/// the `options.txt` tags it references. Each callee's body is then read for a RIP-relative address in
/// image data that proves itself as a class table ([`is_class_table`]). Fewer than four tables means
/// the recipe did not agree with the build, and nothing is stored.
fn resolve_classes(image: &Image) -> usize {
    if class_count() != 0 {
        return class_count();
    }
    let mut registrations: Vec<usize> = Vec::new();
    if let Some(anchor) = crate::anchors::options_registry() {
        if image.function_start(anchor).is_some() {
            registrations.push(anchor);
        }
    }
    // The append's callers only when the save-tag route failed: in this build every call to it goes
    // through the guard-dispatch slot, so this path normally finds nothing and is not paid for.
    if registrations.is_empty() {
        if let Some(add) = add_function(image) {
            for site in pe::callers(image, add) {
                if let Some(start) = image.function_start(site) {
                    if !registrations.contains(&start) {
                        registrations.push(start);
                    }
                }
            }
        }
    }
    if registrations.is_empty() {
        agent_core::log::line("options: neither the registry append's callers nor the registration function resolved");
        return 0;
    }
    let mut seen: Vec<usize> = Vec::new();
    let mut tables: Vec<usize> = Vec::new();
    for registry in registrations {
        let Some((start, end)) = pe::function_of(image, registry) else {
            continue;
        };
        for callee in pe::callees(start, end) {
            if seen.contains(&callee) {
                continue;
            }
            seen.push(callee);
            let Some((fstart, fend)) = pe::function_of(image, callee) else {
                continue;
            };
            if fend <= fstart || fend - fstart > CONSTRUCTOR_MAX {
                continue;
            }
            let Some(body) = pe::bytes(fstart, fend - fstart) else {
                continue;
            };
            let mut at = 0usize;
            while at + 7 <= body.len() {
                // `lea reg,[rip + disp32]`: REX.W or REX.WR/REX.WB/REX.WRB, `8D`, mod = 00 / rm = 101.
                if body[at + 1] != 0x8D || body[at + 2] & 0xC7 != 0x05 || !matches!(body[at], 0x48 | 0x4C | 0x49 | 0x4D) {
                    at += 1;
                    continue;
                }
                let displacement = i32::from_le_bytes([body[at + 3], body[at + 4], body[at + 5], body[at + 6]]) as i64;
                let target = usize::try_from((fstart + at + 7) as i64 + displacement).ok();
                if let Some(table) = target {
                    if tables.len() < CLASS_TABLES && !tables.contains(&table) && is_class_table(image, table) {
                        tables.push(table);
                    }
                }
                at += 7;
            }
        }
    }
    if tables.len() < 4 {
        agent_core::log::fmt(format_args!(
            "options: {} record class tables in {} constructors: refusing them",
            tables.len(),
            seen.len()
        ));
        return 0;
    }
    for (slot, table) in tables.iter().enumerate() {
        CLASS_TABLE[slot].store(*table, Ordering::Release);
    }
    tables.len()
}

/// True when `address` is one of the nine record class tables: in image data, five code slots, then a
/// zero.
fn is_class_table(image: &Image, address: usize) -> bool {
    if address % 8 != 0 || !pe::in_data(image, address) {
        return false;
    }
    let Some(text) = image.text() else {
        return false;
    };
    let text_end = text.va + text.len;
    for slot in 0..CLASS_CODE_SLOTS {
        match pe::read::<usize>(address + slot * 8) {
            Some(entry) if entry >= text.va && entry < text_end => {}
            _ => return false,
        }
    }
    pe::read::<usize>(address + CLASS_CODE_SLOTS * 8) == Some(0)
}

/* ------------------------------------------------------------------------------------------------
 * Discovery
 * ---------------------------------------------------------------------------------------------- */

/// Makes sure `settings.*` has a source: the registry object when it is reachable, otherwise the
/// records. `-32001 options.object` when neither is available.
pub(crate) fn ready(image: &Image) -> Result<(), RpcError> {
    if READY.load(Ordering::Acquire) {
        return Ok(());
    }
    if CONTAINER.load(Ordering::Acquire) == 0 {
        if let Some(found) = container(image) {
            adopt(found);
        }
    }
    let known = CONTAINER.load(Ordering::Acquire) != 0 || !RECORDS.lock().is_empty();
    if known || ensure_records(image) {
        READY.store(true, Ordering::Release);
        return Ok(());
    }
    Err(RpcError::anchor("options.object"))
}

/// Takes `object` as the registry: it is validated once more, its records replace anything the heap
/// scan found (its array is authoritative), and it can save.
fn adopt(object: usize) {
    if !validate(object) {
        return;
    }
    RECORDS.lock().clear();
    CONTAINER.store(object, Ordering::Release);
    agent_core::log::fmt(format_args!(
        "options: registry 0x{object:x} (vtable 0x{:x}), {} of the first 8 records proved",
        pe::read::<usize>(object).unwrap_or(0),
        (0..8).filter(|id| record(object, *id).is_some()).count()
    ));
}

/// The registry object, from every cheap place a pointer to it can be: the registration hook (an
/// early attach), a field of an object the engine already steps, or the module's writable data.
///
/// The objects this crate steps are the ones the simulation hands over (`live::known_objects`), so
/// this is the server-side pair of an integrated server; a client-side `Options` has no accessor here.
/// A pointer found this way is still preferable to none, because it owns the writer — and the records
/// it holds are its own array, which is what every read then uses.
fn container(image: &Image) -> Option<usize> {
    if let Some(object) = crate::anchors::options_object() {
        if validate(object) {
            agent_core::log::fmt(format_args!("options: registry 0x{object:x} from the registration hook"));
            return Some(object);
        }
    }
    for object in crate::live::known_objects() {
        if let Some(found) = field_pointing(object) {
            agent_core::log::fmt(format_args!(
                "options: registry 0x{found:x} from a field of the object at 0x{object:x}"
            ));
            return Some(found);
        }
    }
    let base = image.base();
    let end = base + image.size();
    // The module's writable data is a boot-time fact: a pointer found there never appears later, and
    // the walk (plus its region list) is not worth repeating on every request.
    if SCANNED_DATA.swap(true, Ordering::AcqRel) {
        return None;
    }
    let regions = pe::regions();
    for name in [".data", ".tls"] {
        let Some(section) = image.section(name) else {
            continue;
        };
        let Some(bytes) = pe::bytes(section.va, section.len) else {
            continue;
        };
        let mut offset = 0usize;
        while offset + 8 <= bytes.len() {
            // SAFETY: eight bytes are inside the readable section.
            let word = unsafe { ptr::read_unaligned(bytes.as_ptr().add(offset) as *const u64) } as usize;
            offset += 8;
            if word < 0x1_0000 || (word >= base && word < end) || !pe::in_regions(&regions, word, 8) {
                continue;
            }
            // The global may hold the object itself or the owner whose `+0x10` is it.
            for candidate in [word, word + OPTIONS_ARRAY] {
                if owns_vtable(candidate) && validate(candidate) {
                    agent_core::log::fmt(format_args!(
                        "options: registry 0x{candidate:x} from the global at 0x{:x}",
                        section.va + offset - 8
                    ));
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// The registry pointer held by a field of `object` in its first [`OBJECT_WINDOW`] bytes.
fn field_pointing(object: usize) -> Option<usize> {
    let bytes = pe::bytes(object, OBJECT_WINDOW)?;
    let mut offset = 0usize;
    while offset + 8 <= bytes.len() {
        // SAFETY: eight bytes inside the range just verified readable.
        let word = unsafe { ptr::read_unaligned(bytes.as_ptr().add(offset) as *const u64) } as usize;
        offset += 8;
        if word < 0x1_0000 {
            continue;
        }
        for candidate in [word, word + OPTIONS_ARRAY] {
            if owns_vtable(candidate) && validate(candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// True when `object`'s first word is one of the resolved registry vtables.
fn owns_vtable(object: usize) -> bool {
    let Some(vptr) = pe::read::<usize>(object) else {
        return false;
    };
    VTABLE_TABLE.iter().any(|slot| slot.load(Ordering::Acquire) == vptr)
}

/// Six of the first eight records must prove themselves.
fn validate(object: usize) -> bool {
    if object == 0 || !pe::readable(object, OPTIONS_ARRAY + 8) {
        return false;
    }
    (0..8usize).filter(|id| record(object, *id).is_some()).count() >= 6
}

/// The record of one option id in a registry array, validated against its own definition.
fn record(object: usize, id: usize) -> Option<usize> {
    if id >= OPTIONS_COUNT {
        return None;
    }
    let record = pe::read::<usize>(object + OPTIONS_ARRAY + id * 8)?;
    if record == 0 {
        return None;
    }
    // The definition's own id is the array index: a record that disagrees is not this option.
    if report(record)?.id as usize != id {
        return None;
    }
    Some(record)
}

/// What `record`'s definition says, or `None` when the pairing does not prove itself.
///
/// The same four facts every route relies on: a readable definition, an id inside the registry's
/// 825 entries, a value kind one of the setters handles, and a printable save tag. This is the check
/// that makes a heap candidate a record instead of a coincidence.
fn report(record: usize) -> Option<Report> {
    let definition = pe::read::<usize>(record + RECORD_DEFINITION)?;
    if definition == 0 || !pe::readable(definition, DEFINITION_KIND + 4) {
        return None;
    }
    let id = pe::read::<u32>(definition + DEFINITION_ID)?;
    if id as usize >= OPTIONS_COUNT {
        return None;
    }
    let kind = pe::read::<u32>(definition + DEFINITION_KIND)?;
    if !matches!(
        kind,
        KIND_BOOL
            | KIND_ENUM
            | KIND_FLOAT
            | KIND_ENUM_VARIANT
            | KIND_STRING
            | KIND_INT
            | KIND_INT_CHOICE
            | KIND_STRING_LIST
    ) {
        return None;
    }
    let tag = pe::std_string(definition + DEFINITION_TAG)?;
    if tag.is_empty()
        || tag.len() > 64
        || !tag.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-' | b'/'))
    {
        return None;
    }
    Some(Report { id, kind, tag })
}

/// Finds the option records in the heap, once, and keeps them in id order.
///
/// The scan is bounded by [`FAST_MS`] on the game's own thread and [`SLOW_MS`] anywhere else, and the
/// regions holding the objects the engine already steps are read first — the records were allocated
/// at boot next to them. A failed scan is not retried from the game's thread for [`RETRY_MS`], so a
/// client that asks in a loop cannot stall the game in a loop.
fn ensure_records(image: &Image) -> bool {
    if !RECORDS.lock().is_empty() {
        return true;
    }
    let needles: Vec<usize> = CLASS_TABLE
        .iter()
        .filter_map(|slot| match slot.load(Ordering::Acquire) {
            0 => None,
            address => Some(address),
        })
        .collect();
    if needles.len() < 4 {
        agent_core::log::fmt(format_args!("options: {} record class tables, not scanning the heap", needles.len()));
        return false;
    }
    let main = on_main_thread();
    let now = agent_core::win::tick_ms();
    let refused = SCAN_REFUSED_AT.load(Ordering::Acquire) as u64;
    if main && refused != 0 && now.saturating_sub(refused) < RETRY_MS {
        return false;
    }
    if SCAN.load(Ordering::Acquire) == SCAN_DONE || SCAN.load(Ordering::Acquire) == SCAN_FAILED {
        return false;
    }
    if SCAN.compare_exchange(SCAN_IDLE, SCAN_RUNNING, Ordering::AcqRel, Ordering::Acquire).is_err() {
        // Another thread is walking the heap right now.
        agent_core::log::line("options: the heap scan is already running on another thread");
        return false;
    }
    let found = scan_records(image, &needles, now + if main { FAST_MS } else { SLOW_MS });
    if found.is_empty() && CONTAINER.load(Ordering::Acquire) == 0 {
        SCAN.store(SCAN_IDLE, Ordering::Release);
        SCAN_REFUSED_AT.store(agent_core::win::tick_ms() as usize, Ordering::Release);
        if !main {
            SCAN.store(SCAN_FAILED, Ordering::Release);
        }
        return false;
    }
    if CONTAINER.load(Ordering::Acquire) == 0 {
        let mut records = RECORDS.lock();
        records.clear();
        records.extend(found);
    }
    SCAN.store(SCAN_DONE, Ordering::Release);
    true
}

/// The heap walk itself: every object whose first word is a record class table and whose definition
/// proves itself, in id order.
fn scan_records(image: &Image, needles: &[usize], deadline: u64) -> Vec<Found> {
    let mut regions = pe::regions();
    let preferred = crate::live::known_objects();
    let base = image.base();
    let end = base + image.size();
    // Records are heap allocations: the module's own sections cannot hold one, and a class table
    // referenced from image data is a different thing entirely.
    regions.retain(|(start, stop)| *start >= end || *stop <= base);
    // The regions holding an object we already step first, then the large private ones (the heap that
    // holds boot allocations).
    regions.sort_by_key(|(start, end)| {
        let holds = preferred.iter().any(|address| *address >= *start && *address < *end);
        (u8::from(!holds), usize::MAX - (*end - *start))
    });
    let (scanned, hits) = scan_regions(&regions, needles, base, end, deadline);
    let mut found: Vec<Found> = Vec::new();
    for hit in &hits {
        let Some(info) = report(*hit) else {
            continue;
        };
        if found.iter().any(|entry| entry.record == *hit) {
            continue;
        }
        found.push(Found { id: info.id, record: *hit });
    }
    found.sort_by_key(|entry| entry.id);
    let mut seen: Vec<u32> = Vec::new();
    for entry in &found {
        if !seen.contains(&entry.id) {
            seen.push(entry.id);
        }
    }
    agent_core::log::fmt(format_args!(
        "options: {scanned} heap bytes gave {} record objects, {} distinct ids",
        found.len(),
        seen.len()
    ));
    if found.is_empty() {
        return found;
    }
    // The registry object, if it sits in the regions its own records live in: it also owns the
    // asynchronous writer, so a change can be persisted by the game itself.
    if CONTAINER.load(Ordering::Acquire) == 0 {
        let record_regions = regions_of(&regions, &found);
        if let Some(object) = container_near(&record_regions, base, end).or_else(|| container_of_records(&regions, &found)) {
            adopt(object);
        }
    }
    found
}

/// The registry object, found through its own array: the scan also finds records of the game's other
/// option-like registries (feature toggles, developer flags: `OreUISearchScreen`, `enable_packet_profile`)
/// whose ids overlap the options' own, so a record is only an option when the registry holds it. Every
/// address that holds a found record is a candidate slot `registry + OPTIONS_ARRAY + id * 8`; the candidate must
/// carry a registry vtable and prove itself, so another registry's array or a listener's pointer to a
/// record is refused.
fn container_of_records(regions: &[(usize, usize)], found: &[Found]) -> Option<usize> {
    let needles: Vec<usize> = found.iter().take(64).map(|entry| entry.record).collect();
    let (lo, hi) = (*needles.iter().min()?, needles.iter().max()? + 1);
    let (scanned, hits) = scan_regions(regions, &needles, lo, hi, agent_core::win::tick_ms() + NEAR_MS);
    for hit in &hits {
        let Some(record) = pe::read::<usize>(*hit) else {
            continue;
        };
        for entry in found.iter().filter(|entry| entry.record == record) {
            let Some(candidate) = hit.checked_sub(OPTIONS_ARRAY + entry.id as usize * 8) else {
                continue;
            };
            if owns_vtable(candidate) && validate(candidate) {
                agent_core::log::fmt(format_args!("options: registry 0x{candidate:x} from its array ({scanned} bytes read)"));
                return Some(candidate);
            }
        }
    }
    agent_core::log::fmt(format_args!("options: no registry array holds the found records ({scanned} bytes, {} slots)", hits.len()));
    None
}

/// The regions that hold at least one found record.
fn regions_of(regions: &[(usize, usize)], found: &[Found]) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    for entry in found {
        // The list was re-ordered for the scan, so the region is found by containment, not by index.
        let Some(region) = regions
            .iter()
            .find(|(start, end)| entry.record >= *start && entry.record < *end)
            .copied()
        else {
            continue;
        };
        if !out.contains(&region) {
            out.push(region);
        }
    }
    out
}

/// The registry object, searched for in the heap regions its records were found in.
fn container_near(regions: &[(usize, usize)], lo: usize, hi: usize) -> Option<usize> {
    let needles: Vec<usize> = VTABLE_TABLE
        .iter()
        .filter_map(|slot| match slot.load(Ordering::Acquire) {
            0 => None,
            address => Some(address),
        })
        .collect();
    if needles.is_empty() || regions.is_empty() {
        return None;
    }
    let deadline = agent_core::win::tick_ms() + NEAR_MS;
    let mut scanned = 0usize;
    let mut hits: Vec<usize> = Vec::new();
    for region in regions {
        if scanned >= NEAR_BUDGET || hits.len() >= HITS {
            break;
        }
        let end = region.1.min(region.0 + (NEAR_BUDGET - scanned));
        let (bytes, found) = scan_regions(&[(region.0, end)], &needles, lo, hi, deadline);
        scanned += bytes;
        hits.extend(found);
    }
    for hit in hits {
        if owns_vtable(hit) && validate(hit) {
            agent_core::log::fmt(format_args!("options: registry 0x{hit:x} in the region of its own records"));
            return Some(hit);
        }
    }
    // Off the game's thread, where nothing waits for the answer, the rest of the address space is
    // tried too: the registry is worth finding for its writer alone, and the walk is bounded.
    if on_main_thread() {
        return None;
    }
    let preferred = crate::live::known_objects();
    for needle in &needles {
        let (found, scanned, covered) = pe::find_qword(*needle, CONTAINER_BUDGET, &preferred);
        agent_core::log::fmt(format_args!(
            "options: registry vtable 0x{needle:x} searched in {scanned} bytes ({covered} regions)"
        ));
        if let Some(candidate) = found {
            if owns_vtable(candidate) && validate(candidate) {
                agent_core::log::fmt(format_args!("options: registry 0x{candidate:x} from the wider heap scan"));
                return Some(candidate);
            }
        }
    }
    None
}

/// Reads `regions` in chunks and returns every address of a qword equal to one of `needles`, plus how
/// many bytes were read. A word outside `[lo, hi)` cannot be a table and is skipped by the same
/// compare, which is what keeps the walk memory-bandwidth bound.
fn scan_regions(regions: &[(usize, usize)], needles: &[usize], lo: usize, hi: usize, deadline: u64) -> (usize, Vec<usize>) {
    let mut scanned = 0usize;
    let mut hits: Vec<usize> = Vec::new();
    for (start, end) in regions {
        let mut at = *start;
        while at < *end {
            if agent_core::win::tick_ms() >= deadline || hits.len() >= HITS {
                return (scanned, hits);
            }
            let want = (*end - at).min(SCAN_CHUNK) & !7;
            if want == 0 {
                break;
            }
            match pe::bytes(at, want) {
                Some(chunk) => {
                    scanned += want;
                    scan_chunk(chunk, at, needles, lo, hi, &mut hits);
                }
                None => {
                    // A chunk the OS will not hand over in one range: its pages are tried one by one,
                    // which is what keeps a coarse Wine region from costing a whole megabyte.
                    let mut page = at;
                    while page < at + want {
                        let len = (at + want - page).min(0x1000) & !7;
                        if len != 0 {
                            if let Some(chunk) = pe::bytes(page, len) {
                                scanned += len;
                                scan_chunk(chunk, page, needles, lo, hi, &mut hits);
                            }
                        }
                        page += 0x1000;
                    }
                }
            }
            at += want;
        }
    }
    (scanned, hits)
}

/// Appends every address in `chunk` whose qword is one of `needles`.
fn scan_chunk(chunk: &[u8], base: usize, needles: &[usize], lo: usize, hi: usize, hits: &mut Vec<usize>) {
    let mut offset = 0usize;
    while offset + 8 <= chunk.len() && hits.len() < HITS {
        // SAFETY: eight bytes inside a chunk the caller verified readable.
        let word = unsafe { ptr::read_unaligned(chunk.as_ptr().add(offset) as *const u64) } as usize;
        if word >= lo && word < hi && needles.iter().any(|needle| *needle == word) {
            hits.push(base + offset);
        }
        offset += 8;
    }
}

/// True when the calling thread is the game's own (the window thread).
fn on_main_thread() -> bool {
    agent_core::hub::started().is_some_and(|core| core.is_main_thread())
}

/* ------------------------------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------------------------------- */

/// One option as the wire's `settings.list` / `settings.get` entry.
fn entry(record: usize) -> Option<Value> {
    let info = report(record)?;
    let mut entry = serde_json::Map::new();
    entry.insert(String::from("id"), Value::String(info.tag));
    match info.kind {
        KIND_BOOL => {
            let value = pe::read::<u8>(record + RECORD_BOOL)? != 0;
            entry.insert(String::from("type"), Value::String(String::from("bool")));
            entry.insert(String::from("value"), Value::Bool(value));
        }
        KIND_INT | KIND_INT_CHOICE => {
            let value = pe::read::<i32>(record + RECORD_VALUE)?;
            entry.insert(String::from("type"), Value::String(String::from("int")));
            entry.insert(String::from("value"), Value::from(value));
            if let (Some(min), Some(max)) = (pe::read::<i32>(record + RECORD_MIN), pe::read::<i32>(record + RECORD_MAX)) {
                if min <= max {
                    entry.insert(String::from("min"), Value::from(min));
                    entry.insert(String::from("max"), Value::from(max));
                }
            }
            // A bounded int option is an enum: its allowed values are an int vector of the record.
            let values = int_values(record);
            if values.len() > 1 {
                entry.insert(
                    String::from("values"),
                    Value::Array(values.iter().map(|value| Value::String(alloc::format!("{value}"))).collect()),
                );
            }
        }
        KIND_FLOAT => {
            let value = pe::read::<f32>(record + RECORD_VALUE)?;
            entry.insert(String::from("type"), Value::String(String::from("float")));
            entry.insert(String::from("value"), live::number(value));
            if let (Some(min), Some(max)) = (pe::read::<f32>(record + RECORD_MIN), pe::read::<f32>(record + RECORD_MAX)) {
                if min <= max {
                    entry.insert(String::from("min"), live::number(min));
                    entry.insert(String::from("max"), live::number(max));
                }
            }
        }
        KIND_STRING | KIND_STRING_LIST => {
            let value = pe::std_string(record + RECORD_STRING)?;
            entry.insert(String::from("type"), Value::String(String::from("string")));
            entry.insert(String::from("value"), Value::String(value));
        }
        KIND_ENUM | KIND_ENUM_VARIANT => {
            // The three-value enum classes store an int at the value slot and have no string setter.
            let value = pe::read::<i32>(record + RECORD_BOOL)?;
            entry.insert(String::from("type"), Value::String(String::from("enum")));
            entry.insert(String::from("value"), Value::from(value));
        }
        _ => return None,
    }
    Some(Value::Object(entry))
}

/// The int vector an option's allowed values come from (empty when it has none).
fn int_values(record: usize) -> Vec<i32> {
    let (Some(begin), Some(end)) = (pe::read::<usize>(record + RECORD_VALUES_BEGIN), pe::read::<usize>(record + RECORD_VALUES_END)) else {
        return Vec::new();
    };
    if end <= begin || (end - begin) % 4 != 0 || (end - begin) / 4 > 64 {
        return Vec::new();
    }
    let mut values = Vec::new();
    let mut at = begin;
    while at < end {
        match pe::read::<i32>(at) {
            Some(value) => values.push(value),
            None => return Vec::new(),
        }
        at += 4;
    }
    values
}

/// Every option the engine can report, in id order, one entry per save tag.
///
/// Every record found is looked at, not one per numeric id: the heap scan finds several records under
/// one id (546 records for 445 ids live), and keeping only the first per id dropped options such as
/// `gfx_viewdistance` that `settings.get` still found by tag.
pub(crate) fn list(filter: Option<&str>) -> Result<Value, RpcError> {
    let needle = filter.map(|filter| filter.to_ascii_lowercase());
    let mut seen = alloc::collections::BTreeSet::new();
    let mut settings = Vec::new();
    for record in all_records() {
        let Some(entry) = entry(record) else {
            continue;
        };
        let tag = entry.get("id").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
        if needle.as_ref().is_some_and(|needle| !tag.contains(needle.as_str())) || !seen.insert(tag) {
            continue;
        }
        settings.push(entry);
    }
    Ok(json!({ "settings": settings }))
}

/// Every option record: the container's own table when it is known, else every record the heap scan
/// found, in id order.
fn all_records() -> Vec<usize> {
    let object = CONTAINER.load(Ordering::Acquire);
    if object != 0 {
        return (0..OPTIONS_COUNT).filter_map(|id| record(object, id)).collect();
    }
    RECORDS.lock().iter().map(|found| found.record).collect()
}

/// One option, found by its save tag.
pub(crate) fn get(id: &str) -> Result<Value, RpcError> {
    let records = find(id)?;
    entry(records[0]).ok_or_else(|| RpcError::invalid_params("this option's value kind is not readable"))
}

/// Changes one option through the record's own string setter and reports the value the game kept.
///
/// Every record carrying the tag is set — a build that keeps two registries (the client's and the
/// user-initialised one) then answers the same whichever one the settings screen reads — and the
/// first is the one reported. The registry's own writer is armed afterwards when the object is known;
/// `saved` says whether the game itself was asked to write `options.txt`.
pub(crate) fn set(id: &str, value: &Value) -> Result<Value, RpcError> {
    let records = find(id)?;
    let primary = records[0];
    let info = report(primary).ok_or_else(|| RpcError::invalid_params("the option has no definition"))?;
    if matches!(info.kind, KIND_ENUM | KIND_ENUM_VARIANT) {
        // The enum classes' setter is a bare `ret`: their value is only changed by the game's own UI.
        return Err(RpcError::invalid_params("this option cannot be set by text in this build"));
    }
    let read = |record: usize| entry(record).and_then(|entry| entry.get("value").cloned());
    let previous = read(primary).unwrap_or(Value::Null);
    let text = match (info.kind, value) {
        (KIND_BOOL, Value::Bool(flag)) => String::from(if *flag { "true" } else { "false" }),
        (KIND_BOOL, _) => return Err(RpcError::invalid_params("this option takes true or false")),
        (KIND_INT | KIND_INT_CHOICE, Value::Number(number)) => match number.as_i64() {
            Some(number) => alloc::format!("{number}"),
            None => return Err(RpcError::invalid_params("this option takes a whole number")),
        },
        (KIND_FLOAT, Value::Number(number)) => match number.as_f64() {
            Some(number) if number.is_finite() => alloc::format!("{number}"),
            _ => return Err(RpcError::invalid_params("this option takes a finite number")),
        },
        (KIND_STRING | KIND_STRING_LIST, Value::String(text)) => text.clone(),
        (KIND_INT | KIND_INT_CHOICE | KIND_FLOAT, _) => return Err(RpcError::invalid_params("this option takes a number")),
        (KIND_STRING | KIND_STRING_LIST, _) => return Err(RpcError::invalid_params("this option takes a string")),
        _ => return Err(RpcError::invalid_params("this option cannot be set by text in this build")),
    };
    if same(value, &previous) {
        // Already the value asked for: nothing to set, and the game's writer is not needed.
        return Ok(json!({ "id": id, "previous": previous, "value": previous, "saved": false }));
    }
    let Some(argument) = crate::text::Text::new(&text) else {
        return Err(RpcError::standard(agent_core::engine::INTERNAL_ERROR));
    };
    let mut applied = 0usize;
    for record in &records {
        let Some(found) = report(*record) else {
            continue;
        };
        if found.kind != info.kind {
            // A registry where the same tag is a different kind: not the same option, leave it.
            continue;
        }
        let Some(vtable) = pe::read::<usize>(*record) else {
            continue;
        };
        let Some(setter) = pe::read::<usize>(vtable + SETTER_SLOT) else {
            continue;
        };
        if !pe::in_image_code(setter) {
            continue;
        }
        // SAFETY: the game's own virtual setter for this record, called with the record and a live
        // `std::string` it only reads (it parses, clamps and copies the text). The record's vtable is
        // one of the nine the game registers, and this is the call its settings screen makes.
        unsafe {
            core::mem::transmute::<usize, unsafe extern "C" fn(usize, *const crate::text::Text)>(setter)(*record, &argument);
        }
        applied += 1;
    }
    if applied == 0 {
        return Err(RpcError::anchor("options.setter"));
    }
    let value = read(primary).unwrap_or(Value::Null);
    if value == previous {
        // The setter refused the value (out of range, or not parseable): report it as bad input.
        return Err(RpcError::invalid_params("the game did not accept that value"));
    }
    let saved = save();
    Ok(json!({ "id": id, "previous": previous, "value": value, "saved": saved }))
}

/// True when `requested` and `previous` are the same value as the wire spells them.
fn same(requested: &Value, previous: &Value) -> bool {
    match (requested, previous) {
        (Value::Bool(left), Value::Bool(right)) => left == right,
        (Value::String(left), Value::String(right)) => left == right,
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        _ => false,
    }
}

/// Asks the registry to write `options.txt` with its own asynchronous writer.
///
/// The writer's two request flags are the only thing touched here: "armed", and mode 1 (the file
/// only). It walks the registry, collects every option's text and hands `{path, text, mode}` to its
/// own sink, so nothing about the file format is known to the engine.
fn save() -> bool {
    let object = CONTAINER.load(Ordering::Acquire);
    if object == 0 {
        return false;
    }
    let Some(vtable) = pe::read::<usize>(object) else {
        return false;
    };
    let Some(writer) = pe::read::<usize>(vtable + SAVE_SLOT) else {
        return false;
    };
    if !pe::in_image_code(writer) || !pe::writable(object + SAVE_ARMED, 6) {
        return false;
    }
    let path = pe::std_string(object + SAVE_PATH).unwrap_or_default();
    // SAFETY: both flags are inside the registry object, which was validated when it was adopted, and
    // the ranges were just verified writable. The writer clears the mode itself.
    unsafe {
        ptr::write((object + SAVE_ARMED) as *mut u8, 1);
        ptr::write((object + SAVE_MODE) as *mut u32, SAVE_FILE_ONLY);
        core::mem::transmute::<usize, unsafe extern "C" fn(usize)>(writer)(object);
    }
    agent_core::log::fmt(format_args!(
        "options: the registry was asked to write its file (path {:?})",
        path
    ));
    true
}

/// Every record carrying the save tag `id`: the one the settings screen reads first, then any other
/// registry that registered the same option.
fn find(id: &str) -> Result<Vec<usize>, RpcError> {
    let object = CONTAINER.load(Ordering::Acquire);
    let mut out = Vec::new();
    if object != 0 {
        for index in 0..OPTIONS_COUNT {
            let Some(record) = record(object, index) else {
                continue;
            };
            if report(record).is_some_and(|info| info.tag == id) {
                out.push(record);
            }
        }
    } else {
        for found in RECORDS.lock().iter() {
            if report(found.record).is_some_and(|info| info.tag == id) {
                out.push(found.record);
            }
        }
    }
    if out.is_empty() {
        return Err(RpcError::invalid_params(alloc::format!("no option is named {id}")));
    }
    Ok(out)
}
