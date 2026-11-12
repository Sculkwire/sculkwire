//! The loaded level's own settings, from the level data the level being stepped points at.
//!
//! The level data is not reached by a static address: it is a pointer member of the `Level` object the
//! tick loop steps (`[[Minecraft+0xd0]+0x40]`). `Level+0x90` is that pointer — read live on
//! 1.26.63.1 from both the client and the server level, where `[[Level+0x90]+0x2b0]` is the loaded
//! world's name ("sculkwire-bridge", 16 bytes on the heap), with storage version 10, difficulty 0,
//! force-game-type 0, education 0, cheats 1: five of the fields `LevelData::load` writes from
//! `level.dat`.
//!
//! The rest of what the wire reports comes from the same structure where its offset is proven: the
//! `GameRules` object embedded at `+0xa0` (its rule vector names and values), the time of day
//! (`+0x348`), the rain and lightning levels, and the spawn point gated on the flag its own setter
//! writes. Anything not proven is `null`, never a guess — and because the level name is the gate that
//! keeps the agent out of the user's own worlds, an unreadable name refuses `world.set` instead of
//! turning the check off.

use alloc::string::String;
use alloc::vec::Vec;
use core::sync::atomic::{AtomicUsize, Ordering};

use agent_core::RpcError;
use serde_json::{json, Value};

use crate::{anchors, live, pe};

/// The `LevelData*` every `Level` holds at `+0x90` (confirmed live on both the client and the server
/// level of 1.26.63.1).
const LEVEL_DATA_POINTER: usize = 0x90;
/// How far into the `Level` object an embedded level data structure may sit, for the fallback scan.
const LEVEL_DATA_WINDOW: usize = 0x8000;
/// `LevelName` (`std::string`), `StorageVersion` (u32), `Difficulty` (u32), `ForceGameType` (u8),
/// `educationFeaturesEnabled` (u8) and `cheatsEnabled` (u8): the fields the loader writes from
/// `level.dat`, and the five constraints the scan validates together.
const LEVEL_NAME: usize = 0x2B0;
const LEVEL_STORAGE_VERSION: usize = 0x2D0;
const LEVEL_DIFFICULTY: usize = 0x3C0;
/// `ForceGameType`: a flag (`setne` on the tag), not the level's game type.
const LEVEL_FORCE_GAME_TYPE: usize = 0x3C4;
const LEVEL_EDUCATION: usize = 0x4B0;
const LEVEL_CHEATS: usize = 0x4C8;
/// `Time` (i32, ticks of day), `rainLevel` and `lightningLevel` (f32).
const LEVEL_TIME: usize = 0x348;
const LEVEL_RAIN: usize = 0x374;
const LEVEL_LIGHTNING: usize = 0x37C;
/// The `GameRules` object embedded in the level data, and the rule vector inside it: begin and end.
const LEVEL_RULES: usize = 0xA0;
const RULES_BEGIN: usize = 0x18;
const RULES_END: usize = 0x20;
/// One `GameRule`: its type byte, the value the type describes, the value tag that mirrors the type,
/// and its name (`std::string`).
const RULE_SIZE: usize = 0x118;
const RULE_TYPE: usize = 0x01;
const RULE_VALUE: usize = 0x04;
const RULE_TAG: usize = 0x08;
const RULE_NAME: usize = 0x10;
/// A fresh world has 39 rules; a vector longer than this is not one.
const RULES_MAX: usize = 256;
/// The spawn point (`Vec3` of three i32) and the flag that says it was set.
const LEVEL_SPAWN: usize = 0x33C;
const LEVEL_HAS_SPAWN: usize = 0x338;
/// A coordinate beyond this is not a position the game would keep.
const COORDINATE_MAX: i32 = 30_000_000;
/// The extent of the structure the loader fills for a 1.26 world.
const LEVEL_DATA_SIZE: usize = 0x4D0;
/// A level name is a plain name, never a long path.
const LEVEL_NAME_MAX: usize = 64;

/// The level being stepped, 0 until the simulation step runs.
static LEVEL: AtomicUsize = AtomicUsize::new(0);
/// The level data found inside it, and the level it belongs to.
static DATA: AtomicUsize = AtomicUsize::new(0);
static DATA_LEVEL: AtomicUsize = AtomicUsize::new(0);

/// Records the level the simulation step is running.
pub(crate) fn note_level(level: usize) {
    if level == 0 {
        return;
    }
    if LEVEL.load(Ordering::Acquire) != level {
        // A new world: the level data found in the old level is stale.
        DATA.store(0, Ordering::Release);
        DATA_LEVEL.store(0, Ordering::Release);
        anchors::clear_level_data();
        // The command manager is a member of the level too: a new world has a different one, and the
        // player command origin captured in the old world names a level and a connection that are gone.
        anchors::clear_command_commands();
        crate::command::forget_origin();
    }
    LEVEL.store(level, Ordering::Release);
}

/// The level data of the loaded world: the pointer the level holds, validated, then its parent.
fn level_data() -> Result<usize, RpcError> {
    let level = LEVEL.load(Ordering::Acquire);
    if level == 0 {
        return Err(RpcError::anchor("level.data"));
    }
    // The steady state: the pointer already found for this level. `in_world` asks on every drain, and
    // re-validating eight fields each time would cost more than the answer is worth.
    if DATA_LEVEL.load(Ordering::Acquire) == level {
        let data = DATA.load(Ordering::Acquire);
        if data != 0 {
            return Ok(data);
        }
    }
    if let Some(data) = pointed(level) {
        if plausible(data) {
            DATA.store(data, Ordering::Release);
            DATA_LEVEL.store(level, Ordering::Release);
            return Ok(data);
        }
    }
    locate(level).ok_or_else(|| RpcError::anchor("level.data"))
}

/// The `LevelData*` at `[Level + 0x90]`, or `None` when the pointer is absent.
fn pointed(level: usize) -> Option<usize> {
    match pe::read::<usize>(level + LEVEL_DATA_POINTER)? {
        0 => None,
        data => Some(data),
    }
}

/// Locates the loaded world's `LevelData` inside `level` for the late-attach recovery, logging the
/// chain and the name it found there.
///
/// This is the derivation the startup hook would have replaced: the level the simulation step is
/// running is known from `Minecraft+0xd0`, and the level data sits somewhere inside it. A scan that
/// finds nothing (or more than one offset) answers `None` and says why, so `level.data` stays an
/// honest "missing" instead of a guessed address.
pub(crate) fn recover(level: usize) -> Option<usize> {
    if level == 0 {
        return None;
    }
    // The pointer member first: one read, and the five field checks decide whether to believe it.
    if let Some(data) = pointed(level) {
        if plausible(data) {
            DATA.store(data, Ordering::Release);
            DATA_LEVEL.store(level, Ordering::Release);
            anchors::set_level_data(data);
            let name = pe::std_string(data + LEVEL_NAME).unwrap_or_default();
            agent_core::log::fmt(format_args!(
                "recover: LevelData 0x{:x} = [Level 0x{:x} + 0x90], name {:?}",
                data, level, name
            ));
            return Some(data);
        }
        agent_core::log::fmt(format_args!(
            "recover: [Level 0x{:x} + 0x90] = 0x{:x} does not carry the level's five fields",
            level, data
        ));
    }
    // Fallback: an embedded structure, for a build where the member is not a pointer.
    match locate(level) {
        Some(at) => {
            let name = pe::std_string(at + LEVEL_NAME).unwrap_or_default();
            agent_core::log::fmt(format_args!(
                "recover: LevelData 0x{:x} embedded at Level 0x{:x} + 0x{:x}, name {:?}",
                at,
                level,
                at.saturating_sub(level),
                name
            ));
            Some(at)
        }
        None => {
            agent_core::log::fmt(format_args!(
                "recover: no LevelData in Level 0x{:x} (neither [+0x90] nor the 0x{:x}-byte scan)",
                level, LEVEL_DATA_WINDOW
            ));
            None
        }
    }
}

/// Finds the level data inside `level`: exactly one offset whose five fields agree.
fn locate(level: usize) -> Option<usize> {
    if DATA_LEVEL.load(Ordering::Acquire) == level {
        let data = DATA.load(Ordering::Acquire);
        if data != 0 && plausible(data) {
            return Some(data);
        }
    }
    let mut found: Option<usize> = None;
    let mut offset = 0usize;
    while offset + LEVEL_DATA_SIZE <= LEVEL_DATA_WINDOW {
        let candidate = level + offset;
        if plausible(candidate) {
            if found.is_some() {
                // Ambiguous: refuse rather than pick one and report another world's fields.
                return None;
            }
            found = Some(candidate);
        }
        offset += 8;
    }
    if let Some(data) = found {
        DATA.store(data, Ordering::Release);
        DATA_LEVEL.store(level, Ordering::Release);
        anchors::set_level_data(data);
    }
    found
}

/// Five independent constraints, all written by `LevelData::load`: a readable level name, a storage
/// version in range, a difficulty in range, the force-game-type flag and two more flags that are
/// booleans.
fn plausible(candidate: usize) -> bool {
    if !pe::readable(candidate, LEVEL_DATA_SIZE) {
        return false;
    }
    let Some(name) = pe::std_string(candidate + LEVEL_NAME) else {
        return false;
    };
    if name.is_empty() || name.len() > LEVEL_NAME_MAX || !name.bytes().all(|byte| byte >= 0x20 && byte != 0x7F) {
        return false;
    }
    let storage = pe::read::<u32>(candidate + LEVEL_STORAGE_VERSION).unwrap_or(0);
    if !(1..=40).contains(&storage) {
        return false;
    }
    if pe::read::<u32>(candidate + LEVEL_DIFFICULTY).unwrap_or(u32::MAX) > 3 {
        return false;
    }
    if pe::read::<u8>(candidate + LEVEL_FORCE_GAME_TYPE).unwrap_or(u8::MAX) > 5 {
        return false;
    }
    pe::read::<u8>(candidate + LEVEL_EDUCATION).unwrap_or(u8::MAX) <= 1
        && pe::read::<u8>(candidate + LEVEL_CHEATS).unwrap_or(u8::MAX) <= 1
}

/// The loaded world's name, when it is readable.
pub(crate) fn name() -> Option<alloc::string::String> {
    pe::std_string(level_data().ok()? + LEVEL_NAME)
}

/// The level's game rules, read out of the `GameRules` object embedded in the level data.
///
/// Each record names itself and carries its value with a tag that mirrors its type (1 flag, 2 int,
/// 3 float), which is the pairing the game's own `/gamerule` handler formats. A vector that does not
/// validate — a wrong stride, an unreadable name, a count no world has — answers `None`, and the
/// caller reports `null` rather than an empty map that would claim "no rules".
fn gamerules(level_data: usize) -> Option<serde_json::Map<String, Value>> {
    let begin = pe::read::<usize>(level_data + LEVEL_RULES + RULES_BEGIN)?;
    let end = pe::read::<usize>(level_data + LEVEL_RULES + RULES_END)?;
    if begin == 0 || end <= begin || (end - begin) % RULE_SIZE != 0 {
        return None;
    }
    let count = (end - begin) / RULE_SIZE;
    if count == 0 || count > RULES_MAX || !pe::readable(begin, end - begin) {
        return None;
    }
    let mut rules = serde_json::Map::new();
    for index in 0..count {
        let rule = begin + index * RULE_SIZE;
        let Some(name) = pe::std_string(rule + RULE_NAME) else {
            return None;
        };
        if name.is_empty() || name.len() > 64 || !name.bytes().all(|byte| byte.is_ascii_graphic()) {
            return None;
        }
        let (Some(kind), Some(tag)) = (pe::read::<u8>(rule + RULE_TYPE), pe::read::<u8>(rule + RULE_TAG)) else {
            return None;
        };
        if kind != tag {
            // The value tag mirrors the type in every rule the game writes: skip one that does not.
            continue;
        }
        let value = match kind {
            1 => pe::read::<u8>(rule + RULE_VALUE).map(|value| Value::Bool(value != 0)),
            2 => pe::read::<i32>(rule + RULE_VALUE).map(Value::from),
            3 => pe::read::<f32>(rule + RULE_VALUE).filter(|value| value.is_finite()).map(live::number),
            _ => None,
        };
        let Some(value) = value else {
            continue;
        };
        rules.insert(name, value);
    }
    if rules.is_empty() {
        return None;
    }
    Some(rules)
}

/// The daylight-cycle rule's value, or `null` when the world does not have that rule.
fn day_cycle(rules: &serde_json::Map<String, Value>) -> Value {
    for (name, value) in rules {
        if name.eq_ignore_ascii_case("doDaylightCycle") {
            if let Value::Bool(flag) = value {
                return Value::Bool(*flag);
            }
        }
    }
    Value::Null
}

/// The spawn point, gated on the flag `LevelData::setSpawn` writes with it.
fn spawn(level_data: usize) -> Value {
    if pe::read::<u8>(level_data + LEVEL_HAS_SPAWN) != Some(1) {
        return Value::Null;
    }
    let coordinates = (0..3).map(|index| pe::read::<i32>(level_data + LEVEL_SPAWN + index * 4));
    let mut out = Vec::with_capacity(3);
    for coordinate in coordinates {
        match coordinate {
            Some(value) if value <= COORDINATE_MAX && value >= -COORDINATE_MAX => out.push(Value::from(value)),
            _ => return Value::Null,
        }
    }
    Value::Array(out)
}

/// `world.settings`: what the loaded level itself says.
pub(crate) fn settings() -> Result<Value, RpcError> {
    let level_data = level_data()?;
    let name = pe::std_string(level_data + LEVEL_NAME).map(Value::String).unwrap_or(Value::Null);
    let difficulty = pe::read::<u32>(level_data + LEVEL_DIFFICULTY).map(Value::from).unwrap_or(Value::Null);
    let cheats = pe::read::<u8>(level_data + LEVEL_CHEATS).map(|value| Value::Bool(value != 0)).unwrap_or(Value::Null);
    let education = pe::read::<u8>(level_data + LEVEL_EDUCATION).map(|value| Value::Bool(value != 0)).unwrap_or(Value::Null);
    let time = pe::read::<i32>(level_data + LEVEL_TIME).map(Value::from).unwrap_or(Value::Null);
    let weather = match (pe::read::<f32>(level_data + LEVEL_RAIN), pe::read::<f32>(level_data + LEVEL_LIGHTNING)) {
        (Some(rain), Some(lightning)) if rain.is_finite() && lightning.is_finite() => {
            json!({ "rain": rain > 0.0, "lightning": lightning > 0.0 })
        }
        _ => Value::Null,
    };
    let rules = gamerules(level_data);
    let day_cycle = rules.as_ref().map(day_cycle).unwrap_or(Value::Null);
    let gamerules = rules.map(Value::Object).unwrap_or(Value::Null);
    Ok(json!({
        "name": name,
        // The seed is an int64 set through `setSeed`, whose member offset is not decoded.
        "seed": Value::Null,
        // The level's own game type, through the lookup `LevelData::getTagData` uses (anchor
        // `world.gameType`); null off the server thread or when the level data does not hold one.
        "gameType": game_type(),
        "difficulty": difficulty,
        "cheats": cheats,
        "education": education,
        // Experiments are a pack-level compound, not a level-data field.
        "experiments": Value::Null,
        "gamerules": gamerules,
        "time": time,
        // The day cycle is the `doDaylightCycle` rule of the same container.
        "dayCycle": day_cycle,
        "weather": weather,
        // The spawn point shares its slot with the limited-world origin in this build, gated on the
        // flag `setSpawn` writes beside it.
        "spawn": spawn(level_data),
        // The dimension id's component field is not decoded.
        "dimension": Value::Null,
    }))
}

/// `GameType` as the level holds it: 0 survival, 1 creative, 2 adventure, 6 spectator (5 is the
/// "default" the tag writer falls back to when the level holds none).
fn game_type_name(value: i32) -> Option<&'static str> {
    match value {
        0 => Some("survival"),
        1 => Some("creative"),
        2 => Some("adventure"),
        6 => Some("spectator"),
        _ => None,
    }
}

/// The value type `getTagData` requires of the `GameType` entry (`cmp byte [rax+0x20], 5`).
const GAME_TYPE_VALUE_TYPE: usize = 0x20;
const GAME_TYPE_INT: u8 = 5;

/// The server level's game type, read the way `LevelData::getTagData` reads it: `lookup(levelData,
/// &KEY)`, then the i32 at the entry when its type byte says it is one. The lookup writes the key's
/// last-match cache, so it only runs on the server thread, against the server level's own level data
/// (validated like the stepped level's).
fn game_type() -> Value {
    if !crate::live::on_server_thread() {
        return Value::Null;
    }
    let Some((lookup, key)) = anchors::game_type() else {
        return Value::Null;
    };
    let Some(data) = crate::live::server_level().and_then(pointed).filter(|data| plausible(*data)) else {
        return Value::Null;
    };
    // SAFETY: the game's own lookup, called with a validated `LevelData` and the static key its only
    // caller passes, on the thread that owns that level data.
    let entry = unsafe { core::mem::transmute::<usize, unsafe extern "C" fn(usize, usize) -> usize>(lookup)(data, key) };
    if entry == 0 || pe::read::<u8>(entry + GAME_TYPE_VALUE_TYPE) != Some(GAME_TYPE_INT) {
        return Value::Null;
    }
    match pe::read::<i32>(entry) {
        Some(value) => match game_type_name(value) {
            Some(name) => Value::from(name),
            None => {
                agent_core::log::fmt(format_args!("world: the level's game type is {value}, not a named one"));
                Value::Null
            }
        },
        None => Value::Null,
    }
}

/// True when the loaded world is one the agent may change: its name starts with `sculkwire-`.
///
/// An unreadable name is a refusal (`level.data`), never an allow.
pub(crate) fn changeable() -> Result<(), RpcError> {
    match name() {
        Some(name) if name.starts_with("sculkwire-") => Ok(()),
        Some(_) => Err(RpcError::invalid_params("only a world named sculkwire-* may be changed")),
        None => Err(RpcError::anchor("level.data")),
    }
}
