//! Blocks of the local world, read from the integrated server's own regions.
//!
//! `world.block` and `world.blocks` reach the region the way `container.get` does (the server player by
//! the local player's unique id, its `BlockSourceComponent`, another dimension's main region), check
//! the chunk with the region's own `getChunkAt` and read the block with its own `getBlock`. A block's
//! type is its legacy's namespaced name (`inventory::block_identifier`); its states come from the
//! `Block`'s serialization compound, the `{name, states, version}` tag the game writes for that block
//! state, found inside the `Block` by content (a compound whose `name` is the block's type) and read
//! with the same compound walk as an item's user data.

use alloc::string::String;
use alloc::vec::Vec;
use core::sync::atomic::{AtomicUsize, Ordering};

use agent_core::{Core, RpcError};
use serde_json::{json, Map, Value};

use crate::inventory::{self, COMPOUND_HEAD, NODE_KEY, NODE_LEFT, NODE_NIL, NODE_PARENT, NODE_RIGHT, NODE_SIZE, NODE_VALUE};
use crate::{entities, live, pe};

/// How far into a `Block` its serialization compound is looked for.
const BLOCK_SCAN: usize = 0x200;
/// Where the compound was found: `offset + 1` for an embedded compound, `offset + 1` with the high bit
/// for a pointer to one; 0 until found.
static STATES_AT: AtomicUsize = AtomicUsize::new(0);
const POINTED: usize = 1 << 63;
/// A block has a handful of states; a compound with more entries is not a state list.
const STATES_MAX: usize = 64;
/// The cube's radius and the answer's size, as the helper pack caps them.
const RADIUS_DEFAULT: i64 = 4;
const RADIUS_MAX: i64 = 16;
const BLOCKS_MAX: usize = 2000;
const AIR: &str = "minecraft:air";

/// `world.block {x, y, z, dimension?}` → `{typeId, location, states?}`, or `null` for a position in an
/// unloaded chunk or below the dimension's floor.
pub(crate) fn h_block(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let [x, y, z] = inventory::block_position(params)?;
    live::require_world()?;
    let unique = inventory::local_unique()?;
    let request = json!({
        "x": x, "y": y, "z": z,
        "dimension": inventory::dimension_param(params),
        "unique": alloc::format!("{unique}"),
    });
    crate::server::submit(core, crate::server::Request::Call(block_on_server, request))
}

/// `world.blocks {x?, y?, z?, radius?, type?, types?, dimension?, limit?}` → the non-air blocks in the
/// cube of `radius` around the point (the local player's feet when no point is given), at most `limit`.
pub(crate) fn h_blocks(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let point = entities::optional_point(params)?;
    if params.get("dimension").is_some() {
        inventory::block_position(&json!({ "x": 0, "y": 0, "z": 0, "dimension": params["dimension"] }))?;
    }
    let radius = match params.get("radius") {
        None | Some(Value::Null) => RADIUS_DEFAULT,
        Some(value) => value.as_i64().filter(|radius| *radius >= 0).ok_or_else(|| RpcError::invalid_params("radius must be a whole number"))?.min(RADIUS_MAX),
    };
    let limit = match params.get("limit") {
        None | Some(Value::Null) => BLOCKS_MAX as u64,
        Some(value) => value.as_u64().ok_or_else(|| RpcError::invalid_params("limit must be a whole number"))?.clamp(1, BLOCKS_MAX as u64),
    };
    let mut types: Vec<String> = Vec::new();
    if let Some(kind) = params.get("type").filter(|value| !value.is_null()) {
        types.push(inventory::namespaced(kind.as_str().ok_or_else(|| RpcError::invalid_params("type must be a string"))?));
    }
    if let Some(list) = params.get("types").filter(|value| !value.is_null()) {
        let list = list.as_array().ok_or_else(|| RpcError::invalid_params("types must be a list of block ids"))?;
        for kind in list {
            types.push(inventory::namespaced(kind.as_str().ok_or_else(|| RpcError::invalid_params("types must be a list of block ids"))?));
        }
    }
    live::require_world()?;
    let unique = inventory::local_unique()?;
    let request = json!({
        "point": point.map(|[x, y, z]| json!([x, y, z])),
        "radius": radius,
        "limit": limit,
        "types": types,
        "dimension": inventory::dimension_param(params),
        "unique": alloc::format!("{unique}"),
    });
    crate::server::submit(core, crate::server::Request::Call(blocks_on_server, request))
}

fn block_on_server(params: &Value) -> Result<Value, RpcError> {
    let coordinate = |key: &str| params.get(key).and_then(Value::as_i64).map(|value| value as i32);
    let (Some(x), Some(y), Some(z)) = (coordinate("x"), coordinate("y"), coordinate("z")) else {
        return Err(RpcError::invalid_params("x, y and z are required"));
    };
    let (level, player) = inventory::server_player(inventory::unique_param(params)?)?;
    let (region, _) = inventory::server_region(level, player, params.get("dimension").and_then(Value::as_i64))?;
    let floor = inventory::min_height(region).ok_or_else(|| RpcError::anchor("container.min_height"))?;
    let position = [x, y, z];
    if y < floor as i32 || inventory::chunk_at(region, &position)? == 0 {
        return Ok(Value::Null);
    }
    Ok(info(region, &position).unwrap_or(Value::Null))
}

fn blocks_on_server(params: &Value) -> Result<Value, RpcError> {
    let (level, player) = inventory::server_player(inventory::unique_param(params)?)?;
    let (region, _) = inventory::server_region(level, player, params.get("dimension").and_then(Value::as_i64))?;
    let floor = inventory::min_height(region).ok_or_else(|| RpcError::anchor("container.min_height"))? as i64;
    let point = match params.get("point").and_then(Value::as_array) {
        Some(point) => [0, 1, 2].map(|index| point.get(index).and_then(Value::as_f64).unwrap_or(0.0)),
        None => {
            let registry = pe::read::<usize>(player + inventory::ACTOR_REGISTRY).unwrap_or(0);
            let entity = pe::read::<u32>(player + inventory::ACTOR_ENTITY).unwrap_or(0);
            let [x, y, z] = entities::feet(registry, entity).ok_or_else(|| RpcError::anchor("world.position"))?;
            [x as f64, y as f64, z as f64]
        }
    };
    let [cx, cy, cz] = point.map(floor_of);
    let radius = params.get("radius").and_then(Value::as_i64).unwrap_or(RADIUS_DEFAULT);
    let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(BLOCKS_MAX as u64) as usize;
    let types: Vec<&str> = params.get("types").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let mut out: Vec<Value> = Vec::new();
    // Chunk columns already checked: (chunk x, chunk z, loaded).
    let mut columns: Vec<(i64, i64, bool)> = Vec::new();
    'cube: for y in (cy - radius).max(floor)..=cy + radius {
        for x in cx - radius..=cx + radius {
            for z in cz - radius..=cz + radius {
                if out.len() >= limit {
                    break 'cube;
                }
                let position = [x as i32, y as i32, z as i32];
                let column = (x >> 4, z >> 4);
                let loaded = match columns.iter().find(|(cx, cz, _)| (*cx, *cz) == column) {
                    Some((_, _, loaded)) => *loaded,
                    None => {
                        let loaded = inventory::chunk_at(region, &position)? != 0;
                        columns.push((column.0, column.1, loaded));
                        loaded
                    }
                };
                if !loaded {
                    continue;
                }
                let Some(block) = inventory::block_at(region, &position) else {
                    continue;
                };
                let id = inventory::block_identifier(block);
                let Some(name) = id.as_str() else {
                    continue;
                };
                if name == AIR || (!types.is_empty() && !types.contains(&name)) {
                    continue;
                }
                out.push(describe(block, name, &position));
            }
        }
    }
    Ok(Value::Array(out))
}

/// `floor` without `std`.
fn floor_of(value: f64) -> i64 {
    let whole = value as i64;
    if (whole as f64) > value {
        whole - 1
    } else {
        whole
    }
}

/// `{typeId, location, states?}` of the block at `position`, `None` when the region answers no block.
fn info(region: usize, position: &[i32; 3]) -> Option<Value> {
    let block = inventory::block_at(region, position)?;
    let id = inventory::block_identifier(block);
    Some(match id.as_str() {
        Some(name) => describe(block, name, position),
        None => json!({ "typeId": Value::Null, "location": location(position) }),
    })
}

fn location(position: &[i32; 3]) -> Value {
    json!({ "x": position[0], "y": position[1], "z": position[2] })
}

fn describe(block: usize, name: &str, position: &[i32; 3]) -> Value {
    let mut entry = Map::new();
    entry.insert(String::from("typeId"), Value::from(name));
    entry.insert(String::from("location"), location(position));
    if let Some(states) = states(block, name).filter(|states| !states.is_empty()) {
        entry.insert(String::from("states"), Value::Object(states));
    }
    Value::Object(entry)
}

/// The block state's own states, from its serialization compound; `None` when it cannot be read.
fn states(block: usize, name: &str) -> Option<Map<String, Value>> {
    let compound = serialization(block, name)?;
    let states = inventory::typed(compound, "states", inventory::TAG_COMPOUND)?;
    entries(states)
}

/// The `Block`'s serialization compound: the one whose `name` string is the block's type.
fn serialization(block: usize, name: &str) -> Option<usize> {
    let names = |compound: usize| {
        inventory::has_game_table(compound)
            && inventory::typed(compound, "name", inventory::TAG_STRING).and_then(inventory::text_value).as_deref() == Some(name)
    };
    let at = |found: usize| -> Option<usize> {
        let offset = (found & !POINTED) - 1;
        if found & POINTED != 0 {
            pe::read::<usize>(block + offset).filter(|compound| *compound != 0)
        } else {
            Some(block + offset)
        }
    };
    let known = STATES_AT.load(Ordering::Acquire);
    if known != 0 {
        if let Some(compound) = at(known).filter(|compound| names(*compound)) {
            return Some(compound);
        }
    }
    for offset in (0..BLOCK_SCAN).step_by(8) {
        if names(block + offset) {
            STATES_AT.store(offset + 1, Ordering::Release);
            return Some(block + offset);
        }
        if let Some(pointer) = pe::read::<usize>(block + offset).filter(|pointer| *pointer != 0 && pe::readable(*pointer, 0x30)) {
            if names(pointer) {
                STATES_AT.store((offset + 1) | POINTED, Ordering::Release);
                return Some(pointer);
            }
        }
    }
    None
}

/// Every entry of a compound, in key order: bytes as booleans (the Script API's boolean states), ints
/// as numbers, strings as text. An entry of another type is skipped; a tree that does not walk as one is
/// `None`.
fn entries(compound: usize) -> Option<Map<String, Value>> {
    let head = pe::read::<usize>(compound + COMPOUND_HEAD)?;
    let size = pe::read::<usize>(compound + COMPOUND_HEAD + 8)?;
    if head == 0 || size > STATES_MAX || !pe::readable(head, NODE_SIZE) {
        return None;
    }
    let nil = |node: usize| pe::read::<u8>(node + NODE_NIL).is_none_or(|flag| flag != 0);
    let mut out = Map::new();
    let mut node = pe::read::<usize>(head + NODE_LEFT)?;
    let mut steps = 0usize;
    while node != head {
        steps += 1;
        if steps > size || nil(node) || !pe::readable(node, NODE_SIZE) {
            return None;
        }
        let key = pe::std_string(node + NODE_KEY).filter(|key| !key.is_empty() && key.len() <= 128)?;
        let value = node + NODE_VALUE;
        let entry = match pe::read::<u8>(value + inventory::TAG_TYPE)? {
            inventory::TAG_BYTE => pe::read::<u8>(value + inventory::TAG_VALUE).map(|byte| Value::Bool(byte != 0)),
            inventory::TAG_INT => pe::read::<i32>(value + inventory::TAG_VALUE).map(Value::from),
            inventory::TAG_STRING => pe::std_string(value + inventory::TAG_VALUE).map(Value::String),
            _ => None,
        };
        if let Some(entry) = entry {
            out.insert(key, entry);
        }
        // In-order successor in the game's red-black tree.
        let right = pe::read::<usize>(node + NODE_RIGHT)?;
        if !nil(right) {
            node = right;
            let mut guard = 0;
            loop {
                let left = pe::read::<usize>(node + NODE_LEFT)?;
                if nil(left) {
                    break;
                }
                node = left;
                guard += 1;
                if guard > STATES_MAX {
                    return None;
                }
            }
        } else {
            let mut parent = pe::read::<usize>(node + NODE_PARENT)?;
            let mut guard = 0;
            while !nil(parent) && pe::read::<usize>(parent + NODE_RIGHT)? == node {
                node = parent;
                parent = pe::read::<usize>(node + NODE_PARENT)?;
                guard += 1;
                if guard > STATES_MAX {
                    return None;
                }
            }
            node = parent;
        }
    }
    (steps == size).then_some(out)
}
