//! The engine's RPC methods.
//!
//! Names, parameters and results follow the wire the TypeScript client speaks. A method
//! whose mechanism is not resolved in this build answers `-32001 anchor not resolved` with the
//! anchor it needs, and every method that touches the game answers `-32002 not_in_world` outside a
//! world this process hosts, in that order: a caller learns "you are not in a world" before it
//! learns "this build cannot do it".
//!
//! The split follows the thread that owns each object: commands, the tick controls and world changes
//! run on the integrated server's thread through [`crate::server`]; input, look, screenshots, the
//! options registry and world reads run on the client's frame thread, where the game's own objects
//! live.

use alloc::string::String;
use alloc::vec::Vec;

use serde_json::{json, Value};

use agent_core::{Core, RpcError};

use crate::{anchors, capture, live, options, server, world as world_settings};

/* ------------------------------------------------------------------------------------------------
 * Params
 * ---------------------------------------------------------------------------------------------- */

fn required<'a>(params: &'a Value, key: &str) -> Result<&'a Value, RpcError> {
    params.get(key).ok_or_else(|| RpcError::invalid_params(alloc::format!("{key} is required")))
}

fn text<'a>(params: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    required(params, key)?
        .as_str()
        .ok_or_else(|| RpcError::invalid_params(alloc::format!("{key} must be a string")))
}

fn float(params: &Value, key: &str) -> Result<f64, RpcError> {
    let value = required(params, key)?
        .as_f64()
        .ok_or_else(|| RpcError::invalid_params(alloc::format!("{key} must be a number")))?;
    if !value.is_finite() {
        return Err(RpcError::invalid_params(alloc::format!("{key} must be finite")));
    }
    Ok(value)
}

fn flag(params: &Value, key: &str) -> Result<bool, RpcError> {
    required(params, key)?
        .as_bool()
        .ok_or_else(|| RpcError::invalid_params(alloc::format!("{key} must be a boolean")))
}

/// `-32002` unless a world this process hosts is loaded with a local player.
fn world() -> Result<(), RpcError> {
    if live::in_world() {
        Ok(())
    } else {
        Err(RpcError::not_in_world())
    }
}

/// `command.prime` → `{armed: true}`: the client types one chat line next only so the game captures the player's
/// command origin (`command` answers -32001 `command.origin` until a player command was seen in this world). That
/// line's own output is kept out of chat. Socket thread: it only arms a flag.
pub fn command_prime(_core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    crate::command::arm_prime();
    Ok(json!({ "armed": true }))
}

/* ------------------------------------------------------------------------------------------------
 * Commands
 * ---------------------------------------------------------------------------------------------- */

/// `command {command}` → `{success, message}`.
///
/// The line runs on the server thread through the game's own synchronous entry, as the local player,
/// with the messages the command body writes captured instead of the dispatcher's script status.
pub fn command(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let line = text(params, "command")?;
    let line = line.trim().trim_start_matches('/');
    if line.is_empty() {
        return Err(RpcError::invalid_params("command must not be empty"));
    }
    if line.contains('\n') || line.contains('\r') {
        return Err(RpcError::invalid_params("a command cannot contain a newline"));
    }
    // `quiet: true` keeps the command's own output out of chat (the client's origin check uses it).
    let quiet = params.get("quiet").and_then(Value::as_bool).unwrap_or(false);
    server::submit(core, server::Request::Command { line: String::from(line), quiet })
}

/* ------------------------------------------------------------------------------------------------
 * Simulation control
 * ---------------------------------------------------------------------------------------------- */

/// `tick.pause {paused}` → `{paused, success}`, through the engine's own pause switch, which freezes
/// the simulation timer (so block, redstone, fluid, scheduled, entity and time-of-day updates all
/// stop) while the server loop keeps running.
pub fn tick_pause(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let paused = flag(params, "paused")?;
    server::submit(core, server::Request::Pause(paused))
}

/// `tick.step {count}` → `{paused: true, ticks}`: the engine's step budget (`Timer+0x3c`) is set to
/// `count`, so the server's own loop runs exactly that many ticks and then stays frozen.
pub fn tick_step(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let count = required(params, "count")?
        .as_u64()
        .ok_or_else(|| RpcError::invalid_params("count must be an integer"))?;
    if !(1..=600).contains(&count) {
        return Err(RpcError::invalid_params("count must be 1..600"));
    }
    server::submit(core, server::Request::Step(count as u32))
}

/// `tick.scale {value}` → `{scale, success}`: the simulation timer's time scale, in the engine's own
/// range `0 ..= 10`.
pub fn tick_scale(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let scale = float(params, "value")?;
    if scale <= 0.0 {
        return Err(RpcError::invalid_params("value must be positive"));
    }
    server::submit(core, server::Request::Scale(scale as f32))
}

/* ------------------------------------------------------------------------------------------------
 * Screenshot
 * ---------------------------------------------------------------------------------------------- */

/// `screenshot {path}` → `{path, named: true, route: "present", width, height}`: the next frame the game
/// presents, copied from its swap chain and written to `path` as a PNG (see [`capture`]). Works in menus
/// and outside a world; the game's own screenshot (gallery, toast, sound) is not involved.
pub fn screenshot(_core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let path = text(params, "path")?;
    if path.trim().is_empty() {
        return Err(RpcError::invalid_params("path must not be empty"));
    }
    let (width, height) = capture::request(path)?;
    Ok(json!({ "path": path, "named": true, "route": "present", "width": width, "height": height }))
}

/* ------------------------------------------------------------------------------------------------
 * Player
 * ---------------------------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------------------------------
 * Game settings
 *
 * These work in menus too (no world needed) and go through the game's own option records, so a
 * change applies at once and fires the listeners the game installed. The registry is enumerated at
 * runtime from the `Options` object the engine finds; nothing is resolved by save tag.
 * ---------------------------------------------------------------------------------------------- */

/// The `Options` object, discovered on first use (`-32001 options.object` when it cannot be found).
fn options_ready(core: &'static Core) -> Result<(), RpcError> {
    options::ready(core.image())
}

/// `settings.list {filter?}` → `{settings: [...]}`.
pub fn settings_list(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let filter = match params.get("filter") {
        Some(filter) => Some(filter.as_str().ok_or_else(|| RpcError::invalid_params("filter must be a string"))?),
        None => None,
    };
    options_ready(core)?;
    options::list(filter)
}

/// `settings.get {id}` → one entry.
pub fn settings_get(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    options_ready(core)?;
    options::get(text(params, "id")?.trim())
}

/// `settings.set {id, value}` → `{id, previous, value}`.
pub fn settings_set(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    if text(params, "id")?.trim().is_empty() {
        return Err(RpcError::invalid_params("id must not be empty"));
    }
    let value = required(params, "value")?;
    match value {
        Value::Bool(_) | Value::String(_) => {}
        Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => {}
        _ => return Err(RpcError::invalid_params("value must be a boolean, a finite number or a string")),
    }
    options_ready(core)?;
    options::set(text(params, "id")?.trim(), value)
}

/* ------------------------------------------------------------------------------------------------
 * World settings
 *
 * Read from the loaded level's own data and applied the way the game applies it: the four changes
 * with a command (`/gamerule`, `/difficulty`, `/time set`, `/weather`) run as the local player on
 * the server thread. The level name is also what the host and this engine use to refuse a world that
 * is not `sculkwire-*`.
 * ---------------------------------------------------------------------------------------------- */

/// `world.settings` → `{name, seed, gameType, difficulty, cheats, education, experiments, gamerules,
/// time, dayCycle, weather, spawn, dimension}`.
pub fn world_settings_read(core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    world()?;
    // On the server thread: the game type is read through the level data's own lookup, which writes
    // the key's cache and so must run on the thread that owns that level data.
    server::submit(core, server::Request::Settings)
}

/// A game rule value as the command takes it.
fn rule_value(name: &str, value: &Value) -> Result<String, RpcError> {
    match value {
        Value::Bool(flag) => Ok(String::from(if *flag { "true" } else { "false" })),
        Value::Number(number) => match number.as_i64() {
            Some(number) => Ok(alloc::format!("{number}")),
            None => Err(RpcError::invalid_params(alloc::format!("game rule {name} must be a whole number"))),
        },
        _ => Err(RpcError::invalid_params(alloc::format!("game rule {name} must be true, false or a number"))),
    }
}

/// `world.set {gamerules?, difficulty?, gameType?, time?, weather?}` → the new `world.settings`.
///
/// Every change is one of the game's own commands, run as the local player on the server thread:
/// `/gamerule`, `/difficulty`, `/defaultgamemode` plus `/gamemode … @s`, `/time set`, `/weather`.
/// `gameType` sets the level's own game type (what `world.settings.gameType` reads back) and the local
/// player's game mode (what a player sees change).
pub fn world_set(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let mut lines: Vec<String> = Vec::new();
    if let Some(rules) = params.get("gamerules") {
        let Value::Object(rules) = rules else {
            return Err(RpcError::invalid_params("gamerules must be an object"));
        };
        for (name, value) in rules {
            if name.trim().is_empty() {
                return Err(RpcError::invalid_params("a game rule needs a name"));
            }
            lines.push(alloc::format!("/gamerule {name} {}", rule_value(name, value)?));
        }
    }
    if let Some(difficulty) = params.get("difficulty") {
        let name = difficulty.as_str().ok_or_else(|| RpcError::invalid_params("difficulty must be a name"))?;
        if !matches!(name, "peaceful" | "easy" | "normal" | "hard") {
            return Err(RpcError::invalid_params("difficulty must be peaceful, easy, normal or hard"));
        }
        lines.push(alloc::format!("/difficulty {name}"));
    }
    if let Some(game_type) = params.get("gameType") {
        let name = game_type.as_str().ok_or_else(|| RpcError::invalid_params("gameType must be a name"))?;
        if !matches!(name, "survival" | "creative" | "adventure" | "spectator") {
            return Err(RpcError::invalid_params("gameType must be survival, creative, adventure or spectator"));
        }
        lines.push(alloc::format!("/defaultgamemode {name}"));
        lines.push(alloc::format!("/gamemode {name} @s"));
    }
    if let Some(time) = params.get("time") {
        let ticks = time.as_u64().ok_or_else(|| RpcError::invalid_params("time must be whole ticks"))?;
        if ticks > 24000 {
            return Err(RpcError::invalid_params("time must be 0..24000"));
        }
        lines.push(alloc::format!("/time set {ticks}"));
    }
    if let Some(weather) = params.get("weather") {
        let Value::Object(weather) = weather else {
            return Err(RpcError::invalid_params("weather must be an object"));
        };
        let rain = weather
            .get("rain")
            .and_then(Value::as_bool)
            .ok_or_else(|| RpcError::invalid_params("weather needs rain"))?;
        let lightning = weather
            .get("lightning")
            .and_then(Value::as_bool)
            .ok_or_else(|| RpcError::invalid_params("weather needs lightning"))?;
        lines.push(String::from(if lightning {
            "/weather thunder"
        } else if rain {
            "/weather rain"
        } else {
            "/weather clear"
        }));
    }
    let changed = !lines.is_empty();
    if !changed {
        return Err(RpcError::invalid_params("give at least one of gamerules, difficulty, gameType, time or weather"));
    }
    world()?;
    world_settings::changeable()?;
    if anchors::command_execute().is_none() {
        return Err(RpcError::anchor("command.execute"));
    }
    if anchors::command_origin().is_none() {
        return Err(RpcError::anchor("command.origin"));
    }
    server::submit(core, server::Request::Commands { lines, quiet: true })
}

/* ------------------------------------------------------------------------------------------------
 * Diagnosis (feature `debug-rpc`, never in a release artifact)
 * ---------------------------------------------------------------------------------------------- */

/// `debug.mem {addr, len}` → `{addr, len, hex}`: the bytes at `addr`, for checking an offset by hand.
///
/// Runs on the connection's thread, so it never touches a game object: it only reads memory that
/// `VirtualQuery` reports committed and readable, at most 4 KiB per call. The address is accepted as a
/// number or as a `"0x…"` string, because that is how the log and `engine.status` spell one.
#[cfg(feature = "debug-rpc")]
pub fn debug_mem(_core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let address = match required(params, "addr")? {
        Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| RpcError::invalid_params("addr must be a whole number or a 0x string"))? as usize,
        Value::String(text) => parse_address(text)
            .ok_or_else(|| RpcError::invalid_params("addr must be a number or a 0x-prefixed hexadecimal string"))?,
        _ => return Err(RpcError::invalid_params("addr must be a number or a 0x string")),
    };
    let len = required(params, "len")?
        .as_u64()
        .ok_or_else(|| RpcError::invalid_params("len must be a whole number"))? as usize;
    if len == 0 || len > 4096 {
        return Err(RpcError::invalid_params("len must be 1..4096"));
    }
    if !agent_core::Image::range_readable(address, len) {
        return Err(RpcError::invalid_params("that range is not readable in this process"));
    }
    // SAFETY: the range was just verified committed and readable for exactly `len` bytes.
    let bytes = unsafe { core::slice::from_raw_parts(address as *const u8, len) };
    let mut hex = String::with_capacity(len * 2);
    for byte in bytes {
        hex.push(nibble(byte >> 4));
        hex.push(nibble(byte & 0x0f));
    }
    Ok(json!({ "addr": alloc::format!("0x{address:x}"), "len": len, "hex": hex }))
}

/// `debug.find {value, limit?, addr?, bytes?, budget?}` → `{hits: ["0x…"], scanned}`: every
/// 8-byte-aligned position whose qword is `value`, inside `[addr, addr+bytes)` when both are given.
///
/// Runs on the connection's thread and only reads memory, like [`debug_mem`]: a value that names a
/// vtable, an object or a string is how a live offset is proved without installing a hook.
#[cfg(feature = "debug-rpc")]
pub fn debug_find(_core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let needle = match required(params, "value")? {
        Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| RpcError::invalid_params("value must be a whole number or a 0x string"))? as usize,
        Value::String(text) => parse_address(text)
            .ok_or_else(|| RpcError::invalid_params("value must be a number or a 0x-prefixed hexadecimal string"))?,
        _ => return Err(RpcError::invalid_params("value must be a number or a 0x string")),
    };
    let limit = match params.get("limit") {
        Some(limit) => limit
            .as_u64()
            .ok_or_else(|| RpcError::invalid_params("limit must be a whole number"))? as usize,
        None => 32,
    };
    if limit == 0 || limit > 256 {
        return Err(RpcError::invalid_params("limit must be 1..256"));
    }
    let range = match (params.get("addr"), params.get("bytes")) {
        (Some(addr), Some(bytes)) => {
            let addr = match addr {
                Value::Number(number) => number
                    .as_u64()
                    .ok_or_else(|| RpcError::invalid_params("addr must be a whole number"))? as usize,
                Value::String(text) => {
                    parse_address(text).ok_or_else(|| RpcError::invalid_params("addr must be a 0x string"))?
                }
                _ => return Err(RpcError::invalid_params("addr must be a number or a 0x string")),
            };
            let bytes = bytes
                .as_u64()
                .ok_or_else(|| RpcError::invalid_params("bytes must be a whole number"))? as usize;
            if bytes == 0 || bytes > (256 << 20) {
                return Err(RpcError::invalid_params("bytes must be 1..268435456"));
            }
            Some((addr, addr.saturating_add(bytes)))
        }
        _ => None,
    };
    let budget = match params.get("budget") {
        Some(budget) => budget
            .as_u64()
            .ok_or_else(|| RpcError::invalid_params("budget must be a whole number"))? as usize,
        None => 512 << 20,
    };
    let regions = match range {
        Some(range) => alloc::vec![range],
        None => crate::pe::regions(),
    };
    let mut hits: Vec<Value> = Vec::new();
    let mut scanned = 0usize;
    for (start, end) in regions {
        if hits.len() >= limit || scanned >= budget {
            break;
        }
        let mut at = (start + 7) & !7;
        while at + 8 <= end && hits.len() < limit && scanned < budget {
            let want = (end - at).min(1 << 20) & !7;
            if want == 0 {
                break;
            }
            let Some(chunk) = crate::pe::bytes(at, want) else {
                at += 0x1000;
                continue;
            };
            scanned += want;
            let mut offset = 0usize;
            while offset + 8 <= chunk.len() {
                // SAFETY: eight bytes inside a chunk verified readable.
                let word = unsafe { core::ptr::read_unaligned(chunk.as_ptr().add(offset) as *const u64) } as usize;
                if word == needle {
                    hits.push(json!(alloc::format!("0x{:x}", at + offset)));
                    if hits.len() >= limit {
                        break;
                    }
                }
                offset += 8;
            }
            at += want;
        }
    }
    Ok(json!({ "hits": hits, "scanned": scanned }))
}

/// `debug.str {addr, fn}` → `{text}`: calls `fn(addr, &out)` as an MSVC `std::string` getter and
/// decodes the 32-byte result. `fn` may also be `{slot}` against a vtable of `addr`.
///
/// This is what proves a virtual getter's argument order and out layout on a live object, without
/// waiting for the game to call it. Both addresses are checked to be code and a readable object.
#[cfg(feature = "debug-rpc")]
pub fn debug_str(_core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let object = match required(params, "addr")? {
        Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| RpcError::invalid_params("addr must be a whole number or a 0x string"))? as usize,
        Value::String(text) => {
            parse_address(text).ok_or_else(|| RpcError::invalid_params("addr must be a number or a 0x string"))?
        }
        _ => return Err(RpcError::invalid_params("addr must be a number or a 0x string")),
    };
    let function = match params.get("fn") {
        Some(Value::Number(number)) => number
            .as_u64()
            .ok_or_else(|| RpcError::invalid_params("fn must be a whole number"))? as usize,
        Some(Value::String(text)) => {
            parse_address(text).ok_or_else(|| RpcError::invalid_params("fn must be a 0x string"))?
        }
        Some(Value::Object(slot)) => {
            let slot = slot
                .get("slot")
                .and_then(Value::as_u64)
                .ok_or_else(|| RpcError::invalid_params("fn.slot must be a whole number"))? as usize;
            let vtable = crate::pe::read::<usize>(object)
                .ok_or_else(|| RpcError::invalid_params("addr is not readable"))?;
            crate::pe::read::<usize>(vtable + slot)
                .ok_or_else(|| RpcError::invalid_params("that vtable slot is not readable"))?
        }
        _ => return Err(RpcError::invalid_params("fn is required: a 0x address or {slot}")),
    };
    if !crate::pe::in_image_code(function) {
        return Err(RpcError::invalid_params("fn is not in the image's code"));
    }
    if !crate::pe::readable(object, 0x40) {
        return Err(RpcError::invalid_params("addr is not a readable object"));
    }
    // Sixteen-byte aligned so an SSO copy with an aligned move is safe.
    #[repr(align(16))]
    struct Buffer([u8; 64]);
    let mut out = Buffer([0u8; 64]);
    // SAFETY: the caller named a code address inside the image and a readable object; this is the
    // calling convention the game's own scene-name callers use (`rcx` = object, `rdx` = std::string*).
    let call: unsafe extern "system" fn(usize, *mut u8) -> usize = unsafe { core::mem::transmute(function) };
    let returned = unsafe { call(object, out.0.as_mut_ptr()) };
    let text = core::str::from_utf8(&out.0[..32])
        .ok()
        .map(alloc::string::String::from);
    Ok(json!({
        "fn": alloc::format!("0x{function:x}"),
        "returned": alloc::format!("0x{returned:x}"),
        "raw": out.0[..32].iter().map(|byte| alloc::format!("{byte:02x}")).collect::<alloc::string::String>(),
        "text": text,
    }))
}

/// `debug.sleep {ms}` → `{slept}`: holds the main-thread drain for `ms` (at most 20 s), so the queue's
/// timeout, slot reuse and drain recovery can be checked on a live game. The game's frame stalls for
/// exactly that long.
#[cfg(feature = "debug-rpc")]
pub fn debug_sleep(_core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let ms = required(params, "ms")?
        .as_u64()
        .filter(|ms| *ms <= 20_000)
        .ok_or_else(|| RpcError::invalid_params("ms must be 0..20000"))?;
    agent_core::win::sleep_ms(ms as u32);
    Ok(json!({ "slept": ms }))
}

/// `debug.fault` → never answers: an access violation inside a main-thread handler, so the fault path
/// (`drain: released by a fault inside the drain`, `engine.status.drainReleases`) can be checked live.
/// Whether the game survives is the game's and Wine's own exception handling, exactly as for a real
/// fault; nothing here catches it.
#[cfg(feature = "debug-rpc")]
pub fn debug_fault(_core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    // An address no process maps: the first page is reserved on every Windows and Wine process.
    let address = core::hint::black_box(8usize);
    // SAFETY: deliberately unsound — the read faults, which is the whole point of this test hook.
    let value = unsafe { core::ptr::read_volatile(address as *const usize) };
    Ok(json!({ "read": value }))
}

/// `debug.threads` → `{threads: [{thread, rip, frames, end, why?, busy?}], ...}`: the unload's own
/// quiescence pass against this image, run now, for every thread. It shows which stacks unwind to their
/// first frame and which fall back to the word search, so the check can be judged on a live game
/// before an unload depends on it. Every thread is suspended for the length of its own look.
#[cfg(feature = "debug-rpc")]
pub fn debug_threads(_core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    use agent_core::hook::End;
    let own = agent_core::win::module_from_address(debug_threads as *const () as usize);
    let size = agent_core::Image::size_of_module(own);
    let walks = agent_core::hook::thread_walks(own, size, 1 << 20);
    let modules: Vec<(usize, usize, String)> = agent_core::win::loaded_modules()
        .into_iter()
        .map(|(base, name)| (base, agent_core::Image::size_of_module(base), name))
        .collect();
    let place = |address: usize| match modules.iter().find(|(base, size, _)| address >= *base && address < base + size) {
        Some((base, _, name)) => alloc::format!("{name}+0x{:x}", address - base),
        None => alloc::format!("0x{address:x}"),
    };
    let mut counts = [0u32; 5];
    let threads: Vec<Value> = walks
        .iter()
        .map(|walk| {
            let (index, end) = match walk.end {
                End::Running => (0, "running"),
                End::Frame => (1, "frame"),
                End::Outermost => (2, "outermost"),
                End::Searched => (3, "searched"),
                End::Unread => (4, "unread"),
            };
            counts[index] += 1;
            json!({
                "thread": alloc::format!("0x{:x}", walk.thread),
                "rip": place(walk.rip),
                "frames": walk.frames,
                "end": end,
                "why": if walk.why.is_empty() { Value::Null } else { Value::from(walk.why) },
                "busy": walk.busy.map(|busy| json!({
                    "code": place(busy.code),
                    "returnTo": place(busy.return_to),
                    "stackAt": alloc::format!("0x{:x}", busy.stack_at),
                })),
            })
        })
        .collect();
    Ok(json!({
        "image": alloc::format!("0x{own:x}"),
        "running": counts[0],
        "frame": counts[1],
        "outermost": counts[2],
        "searched": counts[3],
        "unread": counts[4],
        "threads": threads,
    }))
}

/// A `"0x…"` or plain hexadecimal address.
#[cfg(feature = "debug-rpc")]
fn parse_address(text: &str) -> Option<usize> {
    let digits = text.trim();
    let digits = digits.strip_prefix("0x").or_else(|| digits.strip_prefix("0X")).unwrap_or(digits);
    if digits.is_empty() || digits.len() > 16 || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    usize::from_str_radix(digits, 16).ok()
}

/// One hexadecimal digit.
#[cfg(feature = "debug-rpc")]
fn nibble(value: u8) -> char {
    match value & 0x0f {
        digit @ 0..=9 => (b'0' + digit) as char,
        digit => (b'a' + digit - 10) as char,
    }
}
