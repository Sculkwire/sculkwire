//! The entities of the local world, read from the integrated server's own registry.
//!
//! `world.entities` walks the server level's actors where the game keeps them: the entity ids of the
//! `ActorOwnerComponent` storage of the server player's registry (the registry the server's own actor
//! methods read through `Actor + 0x10`), each one's `Actor*` from that element. An actor is believed
//! only when it is a game object whose own registry, entity id and level are the ones it was found
//! through. Per actor:
//!
//! * `id`: `ActorUniqueIDComponent`, the signed 64-bit unique id the Script API's `Entity.id` spells as
//!   a decimal string; an actor whose id is the "no actor" value (-1) is skipped, as the game's own
//!   presence helper does.
//! * `typeId`: `ActorDefinitionIdentifierComponent`, an `ActorDefinitionIdentifier` (element `0xb0`,
//!   `imul … 0xb0` at `Actor::getActorIdentifier`, whose fallback is a static of the same shape): four
//!   `std::string` (namespace, identifier, init event, full name) and the canonical `HashedString`
//!   (`+0x80` hash, `+0x88` text). The canonical text is reported only when it is a namespaced name
//!   ending in the identifier string, so a moved field is `null`, not a wrong type.
//! * `location`: the feet, from the state vector and the collision box (`ecs::feet_of`), the same
//!   reading `player.state` checks.
//! * `dimension`: the actor's dimension reference compared with what the level's own `getDimension`
//!   answers for each dimension id.
//! * `health`: the `minecraft:health` attribute instance, as `player.attributes` reads it.
//!
//! Every field is `null` when it does not read as described; nothing is filled in.

use alloc::string::String;
use alloc::vec::Vec;

use agent_core::{Core, RpcError};
use serde_json::{json, Map, Value};

use crate::{anchors, ecs, inventory, live, pe, workstation};

/// `ActorOwnerComponent` element: the `Actor*` (see `inventory::player`).
const OWNER_STRIDE: usize = 0x08;
/// `ActorDefinitionIdentifierComponent` element and the fields read from it.
const IDENTIFIER_STRIDE: usize = 0xB0;
const IDENTIFIER_NAME: usize = 0x20;
const IDENTIFIER_CANONICAL: usize = 0x88;
/// A registry holds a few thousand actors at most; more is not an id vector.
const ENTITY_LIMIT: usize = 0x4000;
/// The radius and the answer's size, as the helper pack caps them.
const RADIUS_DEFAULT: f64 = 16.0;
const RADIUS_MAX: f64 = 256.0;
const LIMIT_DEFAULT: u64 = 50;
const LIMIT_MAX: u64 = 200;

/// `world.entities {x?, y?, z?, radius?, type?, limit?, dimension?}` → the entities within `radius`
/// blocks of the point (the local player's feet when no point is given), nearest first.
pub(crate) fn h_entities(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    let point = optional_point(params)?;
    if params.get("dimension").is_some() {
        inventory::block_position(&json!({ "x": 0, "y": 0, "z": 0, "dimension": params["dimension"] }))?;
    }
    let radius = match params.get("radius") {
        None | Some(Value::Null) => RADIUS_DEFAULT,
        Some(value) => value
            .as_f64()
            .filter(|radius| radius.is_finite() && *radius >= 0.0)
            .ok_or_else(|| RpcError::invalid_params("radius must be a non-negative number"))?
            .min(RADIUS_MAX),
    };
    let limit = match params.get("limit") {
        None | Some(Value::Null) => LIMIT_DEFAULT,
        Some(value) => value.as_u64().ok_or_else(|| RpcError::invalid_params("limit must be a whole number"))?.clamp(1, LIMIT_MAX),
    };
    let kind = match params.get("type") {
        None | Some(Value::Null) => None,
        Some(value) => Some(inventory::namespaced(value.as_str().ok_or_else(|| RpcError::invalid_params("type must be a string"))?)),
    };
    live::require_world()?;
    let unique = inventory::local_unique()?;
    let request = json!({
        "unique": alloc::format!("{unique}"),
        "point": point.map(|[x, y, z]| json!([x, y, z])),
        "radius": radius,
        "limit": limit,
        "type": kind,
        "dimension": inventory::dimension_param(params),
    });
    crate::server::submit(core, crate::server::Request::Call(entities_on_server, request))
}

/// `{x, y, z}` all three or none.
pub(crate) fn optional_point(params: &Value) -> Result<Option<[f64; 3]>, RpcError> {
    let present = ["x", "y", "z"].iter().filter(|key| !matches!(params.get(**key), None | Some(Value::Null))).count();
    match present {
        0 => Ok(None),
        3 => {
            let mut out = [0f64; 3];
            for (index, key) in ["x", "y", "z"].into_iter().enumerate() {
                out[index] = params[key]
                    .as_f64()
                    .filter(|value| value.is_finite() && value.abs() < 30_000_000.0)
                    .ok_or_else(|| RpcError::invalid_params(alloc::format!("{key} must be a finite coordinate")))?;
            }
            Ok(Some(out))
        }
        _ => Err(RpcError::invalid_params("give x, y and z together, or none of them")),
    }
}

/// One actor as the server registry holds it.
pub(crate) struct Actor {
    pub actor: usize,
    pub entity: u32,
    pub unique: u64,
}

/// The server's registry (the player's), and every live actor in it.
pub(crate) fn actors(level: usize, player: usize) -> Result<(usize, Vec<Actor>), RpcError> {
    let registry = pe::read::<usize>(player + inventory::ACTOR_REGISTRY)
        .filter(|registry| *registry != 0)
        .ok_or_else(|| RpcError::anchor("world.registry"))?;
    let owners = workstation::storage_in(registry, anchors::component_hash("ActorOwnerComponent"))
        .ok_or_else(|| RpcError::anchor("world.actors"))?;
    let begin = pe::read::<usize>(owners + ecs::ENTITY_BEGIN).unwrap_or(0);
    let end = pe::read::<usize>(owners + ecs::ENTITY_END).unwrap_or(0);
    if begin == 0 || end < begin || (end - begin) % 4 != 0 || (end - begin) / 4 > ENTITY_LIMIT || !pe::readable(begin, end - begin) {
        return Err(RpcError::anchor("world.actors"));
    }
    let uniques = workstation::storage_in(registry, anchors::component_hash("ActorUniqueIDComponent"));
    let gone: Vec<usize> = ["ActorRemovedFlagComponent", "ActorIsBeingDestroyedFlagComponent"]
        .iter()
        .filter_map(|name| workstation::storage_in(registry, anchors::component_hash(name)))
        .collect();
    let mut out = Vec::new();
    let mut at = begin;
    while at < end {
        let entity = pe::read::<u32>(at).unwrap_or(0);
        at += 4;
        if gone.iter().any(|flag| ecs::contains(*flag, entity)) {
            continue;
        }
        let Some(actor) = ecs::element(owners, entity, OWNER_STRIDE).and_then(pe::read::<usize>) else {
            continue;
        };
        if !inventory::has_game_table(actor)
            || pe::read::<usize>(actor + inventory::ACTOR_REGISTRY) != Some(registry)
            || pe::read::<u32>(actor + inventory::ACTOR_ENTITY) != Some(entity)
            || inventory::actor_level(actor) != Some(level)
        {
            continue;
        }
        let Some(unique) = uniques.and_then(|storage| ecs::element(storage, entity, ecs::UNIQUE_STRIDE)).and_then(pe::read::<u64>) else {
            continue;
        };
        if unique == u64::MAX {
            continue;
        }
        out.push(Actor { actor, entity, unique });
    }
    Ok((registry, out))
}

/// The feet of an entity in `registry`, as `player.state` reads them.
pub(crate) fn feet(registry: usize, entity: u32) -> Option<[f32; 3]> {
    let state = workstation::storage_in(registry, anchors::component_hash("StateVectorComponent"))
        .and_then(|storage| ecs::element(storage, entity, ecs::STATE_VECTOR_STRIDE))?;
    let position = ecs::read_vec3(state + ecs::STATE_POSITION).filter(ecs::plausible_position)?;
    workstation::storage_in(registry, anchors::component_hash("AABBShapeComponent"))
        .and_then(|storage| ecs::element(storage, entity, ecs::AABB_STRIDE))
        .and_then(|shape| ecs::feet_of(shape, &position))
}

/// Per-tick movement of an entity in `registry` (blocks per tick).
fn velocity(registry: usize, entity: u32) -> Option<[f32; 3]> {
    let state = workstation::storage_in(registry, anchors::component_hash("StateVectorComponent"))
        .and_then(|storage| ecs::element(storage, entity, ecs::STATE_VECTOR_STRIDE))?;
    ecs::read_vec3(state + ecs::STATE_DELTA)
}

/// The type id of an entity in `registry`: its definition identifier's canonical name.
fn type_id(registry: usize, entity: u32) -> Option<String> {
    let element = workstation::storage_in(registry, anchors::component_hash("ActorDefinitionIdentifierComponent"))
        .and_then(|storage| ecs::element(storage, entity, IDENTIFIER_STRIDE))?;
    let name = pe::std_string(element + IDENTIFIER_NAME)?;
    let canonical = pe::std_string(element + IDENTIFIER_CANONICAL)?;
    let (namespace, tail) = canonical.split_once(':')?;
    let token = |text: &str| !text.is_empty() && text.len() <= 96 && text.bytes().all(|byte| byte.is_ascii_graphic() && byte != b':');
    (token(namespace) && token(tail) && tail == name).then_some(canonical)
}

/// The dimension objects of ids 0, 1 and 2 the level answers (a dimension that is not loaded is 0).
pub(crate) fn dimensions(level: usize) -> [usize; 3] {
    [0, 1, 2].map(|id| inventory::dimension_object(level, id).unwrap_or(0))
}

/// The dimension id of an actor, through `dimensions`.
pub(crate) fn dimension_of(actor: usize, dimensions: &[usize; 3]) -> Option<i32> {
    let dimension = inventory::actor_dimension(actor)?;
    dimensions.iter().position(|known| *known != 0 && *known == dimension).map(|id| id as i32)
}

fn vector(value: [f32; 3]) -> Value {
    json!({ "x": live::number(value[0]), "y": live::number(value[1]), "z": live::number(value[2]) })
}

/// The server half of `world.entities`, on the server thread.
fn entities_on_server(params: &Value) -> Result<Value, RpcError> {
    let unique = inventory::unique_param(params)?;
    let (level, player) = inventory::server_player(unique)?;
    let (registry, actors) = actors(level, player)?;
    let dimensions = dimensions(level);
    let player_entity = pe::read::<u32>(player + inventory::ACTOR_ENTITY).unwrap_or(0);
    let wanted = match params.get("dimension").and_then(Value::as_i64) {
        Some(id) => id as i32,
        None => dimension_of(player, &dimensions).ok_or_else(|| RpcError::anchor("container.actor_dimension"))?,
    };
    let point = match params.get("point").and_then(Value::as_array) {
        Some(point) => [0, 1, 2].map(|index| point.get(index).and_then(Value::as_f64).unwrap_or(0.0)),
        None => {
            let [x, y, z] = feet(registry, player_entity).ok_or_else(|| RpcError::anchor("world.position"))?;
            [x as f64, y as f64, z as f64]
        }
    };
    let radius = params.get("radius").and_then(Value::as_f64).unwrap_or(RADIUS_DEFAULT);
    let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(LIMIT_DEFAULT) as usize;
    let kind = params.get("type").and_then(Value::as_str);
    let mut found: Vec<(f64, Value)> = Vec::new();
    for Actor { actor, entity, unique } in actors {
        if dimension_of(actor, &dimensions) != Some(wanted) {
            continue;
        }
        let Some(location) = feet(registry, entity) else {
            continue;
        };
        let distance = {
            let [dx, dy, dz] = [0, 1, 2].map(|index| location[index] as f64 - point[index]);
            libm_sqrt(dx * dx + dy * dy + dz * dz)
        };
        if distance > radius {
            continue;
        }
        let type_id = type_id(registry, entity);
        if let Some(kind) = kind {
            if type_id.as_deref() != Some(kind) {
                continue;
            }
        }
        let mut entry = Map::new();
        entry.insert(String::from("id"), Value::String(alloc::format!("{}", unique as i64)));
        entry.insert(String::from("typeId"), type_id.map(Value::String).unwrap_or(Value::Null));
        entry.insert(String::from("location"), vector(location));
        entry.insert(String::from("dimension"), inventory::dimension_name(wanted).map(Value::from).unwrap_or(Value::Null));
        if let Some(velocity) = velocity(registry, entity) {
            entry.insert(String::from("velocity"), vector(velocity));
        }
        if let Some((current, max)) = inventory::attribute_in(registry, entity, "minecraft:health") {
            entry.insert(String::from("health"), json!({ "current": live::number(current), "max": live::number(max) }));
        }
        found.push((distance, Value::Object(entry)));
    }
    found.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(core::cmp::Ordering::Equal));
    found.truncate(limit);
    Ok(Value::Array(found.into_iter().map(|(_, entry)| entry).collect()))
}

/// `sqrt` without `std`: Newton's iteration from the float's own estimate, exact to the last bit that
/// matters for a distance compared against a radius.
fn libm_sqrt(value: f64) -> f64 {
    if value <= 0.0 || !value.is_finite() {
        return 0.0;
    }
    let mut guess = f64::from_bits((value.to_bits() >> 1) + (1023u64 << 51));
    for _ in 0..6 {
        guess = 0.5 * (guess + value / guess);
    }
    guess
}
