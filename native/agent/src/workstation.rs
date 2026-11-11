//! Workstations: using a block or an entity like a right click, the screens that open, and the
//! game's own item stack requests on them.
//!
//! | method | what it does | how |
//! |---|---|---|
//! | `interact.block {x, y, z, face?}` | uses a block: opens its screen, presses a button, sits | aim at the block, then the client's own use-button handler |
//! | `interact.entity {id}` | uses an entity: a villager's trades, a horse, a chest boat | aim at the entity, then the same handler |
//! | `screen.state` | the open screen, its family and every container it shows | the scene stack (`ui.screen`) and the client's own container map |
//! | `screen.move` | moves a stack like dragging with the mouse | the screen controller's own transfer (`Take`/`Place`/`Swap`), in one request |
//! | `screen.act` | one screen action (`take_result`, …) | the screen's own request — see below |
//! | `screen.close` | closes the screen like Escape | `Escape` through the window procedure (`ui.key`) |
//! | `container.open` | the open screen's containers and the player's | the client's container map |
//!
//! # Interactions
//!
//! A right click is the client's `button.build_or_interact` handler, which acts on the level's hit
//! result — the block or entity the crosshair is on. The engine writes the view into the player's
//! rotation component (`ActorRotationComponent`, read back), waits [`AIM_MS`] so the game picks with
//! the new view, then runs that handler ([`input::use_click`]). That is the only route that reaches an
//! add-on's `minecraft:interact` component and every `BlockPlayerInteractEvent` handler, exactly as a
//! real click does. The answer settles on a window timer ([`settle_tick`]): the screen that opened, or
//! `changed: false` after [`SETTLE_MS`] (a lever or a boat changes the world, not the screen, and the
//! engine reports only what it can see).
//!
//! # Item stack requests
//!
//! A move or a screen action is what the client's own screen controllers build: this module opens the
//! request (`_beginRequest`), runs the controller's own code, which sees a request open, applies the
//! change to the client's containers (the prediction a mouse drag makes) and adds its actions, then ends
//! it with the submit step that queues it for the next `PlayerAuthInputPacket`. Each piece is found
//! from the client net manager's own log literals, and the manager itself is the local player's
//! (`Player + offset`, the offset read out of the game's own request-scope constructor). A move is the
//! controllers' slot-to-slot transfer (`kind, to, from, amount`), its slots addressed as the UI does:
//! `{collection name, index within the collection}`. A request found still open on entry (a game
//! handler that threw mid-request) is ended first, the game's way.
//!
//! The containers and their items are the client's own: the container map the net manager applies the
//! server's responses to (an ECS component on the local player, found from the response handler's own
//! lookup), keyed by `FullContainerName`. Names that share one container (the player UI container holds
//! every station's inputs, the cursor and the crafting grids) own the slots its per-name predicate
//! accepts. The request's outcome is the server's own answer: `handleItemStackResponse` is hooked to
//! record each response's `(clientRequestId, result)`, and a move answers once its own id comes back.
//!
//! # What is still missing, and why each gap is named
//!
//! * `screen.craft` — the recipe net id a craft, a stonecutter recipe, a smithing transform or a trade
//!   sends (`CraftRecipe`): the client's recipe registry and the trade model are not located;
//! * `screen.enchanting` — the three options' `Enchant Net Id`s (`PlayerEnchantOptionsPacket`) are not
//!   located on the client;
//! * `screen.anvil`, `screen.grindstone`, `screen.loom`, `screen.cartography` — the preview's net id
//!   and the per-screen scalars (cost, rename text, pattern) the screen's model holds;
//! * `screen.beacon` — which removal action pays the beacon (`Consume` is refused without a craft).
//!
//! # Wiring (for `lib.rs`, which this module does not edit)
//!
//! ```text
//! Method::main("interact.block",  workstation::h_interact_block),
//! Method::main("interact.entity", workstation::h_interact_entity),
//! Method::main("screen.state",    workstation::h_screen_state),
//! Method::main("screen.move",     workstation::h_screen_move),
//! Method::main("screen.act",      workstation::h_screen_act),
//! Method::main("screen.close",    workstation::h_screen_close),
//! Method::main("container.open",  workstation::h_container_open),
//! ```

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use core::ffi::c_void;
use core::mem::transmute;
use core::sync::atomic::{AtomicUsize, Ordering};

use agent_core::queue::Deferred;
use agent_core::sync::SpinLock;
use agent_core::{hook, win, Anchor, Core, Image, RpcError};
use serde_json::{json, Map, Value};

use crate::{anchors, ecs, input, inventory, live, pe, ui};

/* ------------------------------------------------------------------------------------------------
 * The screens the game registers, and what each family is called on the wire
 * ---------------------------------------------------------------------------------------------- */

/// Every container scene of this build, by the name the scene reports (the part after the package
/// of its registered `<package>.<scene>` name: `chest.small_chest_screen` reports `small_chest_screen`),
/// with the family the contract names it by.
const SCENES: &[(&str, &str)] = &[
    ("crafting_screen", "crafting_table"),
    ("inventory_screen", "inventory"),
    ("small_chest_screen", "chest"),
    ("large_chest_screen", "chest"),
    ("ender_chest_screen", "chest"),
    ("barrel_screen", "barrel"),
    ("shulker_box_screen", "shulker_box"),
    ("hopper_screen", "hopper"),
    ("dispenser_screen", "dispenser"),
    ("dropper_screen", "dropper"),
    ("crafter_screen", "crafter"),
    ("furnace_screen", "furnace"),
    ("blast_furnace_screen", "blast_furnace"),
    ("smoker_screen", "smoker"),
    ("stonecutter_screen", "stonecutter"),
    ("anvil_screen", "anvil"),
    ("enchanting_screen", "enchanting_table"),
    ("brewing_stand_screen", "brewing_stand"),
    ("beacon_screen", "beacon"),
    ("smithing_table_screen", "smithing_table"),
    ("loom_screen", "loom"),
    ("grindstone_screen", "grindstone"),
    ("cartography_screen", "cartography_table"),
    ("horse_screen", "horse"),
    ("trade_screen", "trade"),
];

/// The scene a player is in while the game is being played: no screen is open on top of it.
const HUD: &str = "hud_screen";

/// A scene name without its package, the form the live scene stack reports.
fn bare(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or(name)
}

/// The contract's family for the screen `name`, `other` for every screen that is not a container
/// screen (menus, dialogs, the book, …).
fn kind_of(name: &str) -> &'static str {
    let name = bare(name);
    SCENES.iter().find(|(scene, _)| *scene == name).map(|(_, kind)| *kind).unwrap_or("other")
}

/// The client's *always active* scenes: drawn over everything, taking no input. When `ui.screen` can only
/// see their stack (it stands in until the client's own stack is found), its top is one of these while
/// the player is playing.
const ALWAYS_ACTIVE: [&str; 2] = ["toast_screen", "debug_screen"];

/// True for the in-game scene (or an always-active overlay standing in for it): the player is playing,
/// so a use reaches the world and `Escape` would open the pause menu.
fn on_hud(name: &str) -> bool {
    let name = bare(name);
    name == HUD || ALWAYS_ACTIVE.contains(&name)
}

/* ------------------------------------------------------------------------------------------------
 * Reading the open screen
 * ---------------------------------------------------------------------------------------------- */

/// The screen the game shows, as the game names it.
struct Screen {
    top: String,
    /// Every screen on the stack is the HUD or an always-active overlay. A closed screen stays on the
    /// stack under the HUD while it leaves (about 350 ms, `modal` set), and until it is gone the
    /// client's use handler ignores a click (live: a hopper used 150-300 ms after `screen.close` of a
    /// crafter opened nothing; 500 ms after it opened).
    settled: bool,
}

/// The current screen from the live scene stack, through `ui.screen` (the one reader of the stack).
fn screen_now(core: &'static Core) -> Result<Screen, RpcError> {
    let value = ui::h_screen(core, &Value::Object(Map::new()))?;
    let top = value
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| RpcError::anchor("ui.scene_name"))?;
    let settled = value
        .get("stack")
        .and_then(Value::as_array)
        .is_some_and(|stack| stack.iter().all(|name| name.as_str().is_some_and(on_hud)));
    Ok(Screen { top: String::from(top), settled })
}

/// The current screen's name, or `None` when the stack cannot be read right now (a settling
/// interaction treats that as "nothing changed yet").
fn screen_name(core: &'static Core) -> Option<String> {
    screen_now(core).ok().map(|screen| screen.top)
}

/* ------------------------------------------------------------------------------------------------
 * The player, the aim
 * ---------------------------------------------------------------------------------------------- */

/// How far a block can be used from (vanilla survival reach).
const BLOCK_REACH: f32 = 4.5;
/// How far an entity can be used from (vanilla entity interaction range).
const ENTITY_REACH: f32 = 3.0;
/// Where on an entity the aim goes: this far above its feet, which is inside every interactable
/// hitbox (a villager's legs, a boat's hull) without needing the entity's height.
const ENTITY_AIM: f32 = 0.4;

/// The faces of a block in the game's own order (`0 = down, 1 = up, then north, south, west, east`).
const FACES: [&str; 6] = ["down", "up", "north", "south", "west", "east"];
/// The outward normal of each face, in the same order. North is `-Z` and south `+Z`, as the game has it.
const NORMALS: [[f32; 3]; 6] = [
    [0.0, -1.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, 0.0, -1.0],
    [0.0, 0.0, 1.0],
    [-1.0, 0.0, 0.0],
    [1.0, 0.0, 0.0],
];

/// The player's eye: a player's state-vector position is already at eye height (`/tp … -60 …` on a
/// flat world reads `y = -58.38`, the feet plus 1.62), so it is read from there, not from the
/// published `position`, which is the feet.
fn eye() -> Result<[f32; 3], RpcError> {
    live::player_state().ok_or_else(RpcError::not_in_world)?;
    let accessor = input::registry().ok_or_else(|| RpcError::anchor("component.getter"))?;
    ecs::read(accessor).map(|reading| reading.sample.position).ok_or_else(|| RpcError::anchor("player.state"))
}

/// Writes the view the way `input.look` does — the camera the player follows first (first person's
/// direct-look pair or third person's orbit), then the local player's rotation component — and reads
/// the rotation back.
///
/// The read-back is what makes the use that follows honest: a view the component refused is an error,
/// never a click at whatever the player was already looking at. The camera write is what keeps the
/// view: the camera is the source of the player's orientation, so a rotation written alone was put
/// back on the next frame and the click went where the player had been looking (live: `interact.entity`
/// answered `screen: null` with the rotation unchanged).
fn write_look(pitch: f32, yaw: f32) -> Result<(), RpcError> {
    let accessor = input::registry().ok_or_else(|| RpcError::anchor("component.getter"))?;
    let reading = ecs::read(accessor).ok_or_else(|| RpcError::anchor("component.getter"))?;
    let current = reading.read_look().ok_or_else(|| RpcError::anchor("component.getter"))?;
    input::write_camera_look(accessor, current, pitch, yaw)?;
    if !reading.write_look(pitch, yaw) {
        return Err(RpcError::anchor("component.getter").with_data(json!({
            "message": "the local player's rotation component refused the write",
        })));
    }
    let shown = reading.read_look().ok_or_else(|| RpcError::anchor("component.getter"))?;
    if (shown[0] - pitch).abs() > 0.01 || wrap(shown[1] - yaw).abs() > 0.01 {
        return Err(RpcError::anchor("component.getter").with_data(json!({
            "message": format!("the rotation component kept {:.2}/{:.2}, not the aim {pitch:.2}/{yaw:.2}", shown[0], shown[1]),
        })));
    }
    Ok(())
}

/// The aim that points from `eye` at `target`: `[pitch, yaw]` in degrees, the convention the game
/// stores (`+pitch` looks down, `0` yaw is `+Z`, `-90` is `+X`).
fn look_at(eye: [f32; 3], target: [f32; 3]) -> Option<[f32; 2]> {
    let dx = target[0] - eye[0];
    let dy = target[1] - eye[1];
    let dz = target[2] - eye[2];
    let horizontal = sqrt(dx * dx + dz * dz);
    if !dx.is_finite() || !dy.is_finite() || !dz.is_finite() || (horizontal == 0.0 && dy == 0.0) {
        return None;
    }
    Some([degrees(-atan2(dy, horizontal)), wrap(degrees(atan2(-dx, dz)))])
}

/// The point a use on `block` aims at: the requested face's centre, or the block's closest point to
/// the eye (the face the player is looking at).
fn block_target(block: [i32; 3], face: Option<usize>, eye: [f32; 3]) -> Result<[f32; 3], RpcError> {
    let min = [block[0] as f32, block[1] as f32, block[2] as f32];
    let max = [min[0] + 1.0, min[1] + 1.0, min[2] + 1.0];
    match face {
        Some(index) => {
            let normal = NORMALS[index];
            let centre = [
                (min[0] + max[0]) * 0.5 + normal[0] * 0.5,
                (min[1] + max[1]) * 0.5 + normal[1] * 0.5,
                (min[2] + max[2]) * 0.5 + normal[2] * 0.5,
            ];
            // The eye has to be on that face's own side of the block, or the ray would cross the
            // block and use another face (or nothing at all).
            let side = (eye[0] - centre[0]) * normal[0] + (eye[1] - centre[1]) * normal[1] + (eye[2] - centre[2]) * normal[2];
            if !(side > 0.0) {
                return Err(RpcError::invalid_params(format!(
                    "the player is not on the {} side of that block, so its {} face cannot be used from here",
                    FACES[index], FACES[index]
                )));
            }
            Ok(centre)
        }
        None => {
            let mut target = [0.0f32; 3];
            for axis in 0..3 {
                target[axis] = eye[axis].max(min[axis] + 0.05).min(max[axis] - 0.05);
            }
            if distance(eye, target) < 0.1 {
                return Err(RpcError::invalid_params(
                    "the player stands inside that block: there is no face to use from here",
                ));
            }
            Ok(target)
        }
    }
}

/// How far inside the cell the later aim points sit from a face: inside a floor button (2/16 tall),
/// a carpet (1/16) or a wall button, but still inside the cell's own bounds.
const AIM_INSET: f32 = 0.06;

/// Every point a use on `block` may aim at, first [`block_target`]'s, then points deeper in the cell
/// for a block whose shape does not fill it: along the requested face's normal into the cell, or the
/// cell's centre and the centres of its six faces just inside it, nearest the eye first. Only points
/// within reach are kept; the game's own pick decides which one is on the block.
fn block_aims(block: [i32; 3], face: Option<usize>, eye: [f32; 3]) -> Result<Vec<[f32; 3]>, RpcError> {
    let first = block_target(block, face, eye)?;
    let centre = [block[0] as f32 + 0.5, block[1] as f32 + 0.5, block[2] as f32 + 0.5];
    let along = |normal: [f32; 3], out: f32| [centre[0] + normal[0] * out, centre[1] + normal[1] * out, centre[2] + normal[2] * out];
    let mut more: Vec<[f32; 3]> = match face {
        Some(index) => [0.25, 0.0, -0.25, -(0.5 - AIM_INSET)].iter().map(|out| along(NORMALS[index], *out)).collect(),
        None => {
            let mut sides: Vec<[f32; 3]> = NORMALS.iter().map(|normal| along(*normal, 0.5 - AIM_INSET)).collect();
            sides.sort_by(|a, b| distance(eye, *a).partial_cmp(&distance(eye, *b)).unwrap_or(core::cmp::Ordering::Equal));
            let mut points = alloc::vec![centre];
            points.extend(sides);
            points
        }
    };
    more.retain(|point| distance(eye, *point) <= BLOCK_REACH && distance(eye, *point) >= 0.1);
    let mut aims = alloc::vec![first];
    aims.extend(more);
    Ok(aims)
}

/// The straight-line distance between two points.
fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    sqrt(dx * dx + dy * dy + dz * dz)
}

/// `sqrt`, implemented here because this crate links no floating-point library.
///
/// Newton from a halved-exponent seed: the seed is good to about 3 %, and six steps reach single
/// precision (each one halves the relative error).
fn sqrt(value: f32) -> f32 {
    if !(value > 0.0) || !value.is_finite() {
        return 0.0;
    }
    // `(bits >> 1) + 0x1fbd1df5` is the classic square-root seed of the fast-inverse-sqrt family.
    let mut guess = f32::from_bits((value.to_bits() >> 1) + 0x1fbd_1df5);
    for _ in 0..6 {
        guess = 0.5 * (guess + value / guess);
    }
    guess
}

/// `atan(x)` for `|x| <= 1`, from Eberly's minimax polynomial (`|error| < 1.5e-4 rad`).
fn atan(value: f32) -> f32 {
    let square = value * value;
    value
        * (0.999_866
            + square * (-0.330_299_5 + square * (0.180_141 + square * (-0.085_133 + square * 0.020_835_1))))
}

/// `atan2(y, x)` in radians, computed from [`atan`] with the quadrant folded in.
fn atan2(y: f32, x: f32) -> f32 {
    if !x.is_finite() || !y.is_finite() {
        return 0.0;
    }
    let ax = if x < 0.0 { -x } else { x };
    let ay = if y < 0.0 { -y } else { y };
    if ax == 0.0 && ay == 0.0 {
        return 0.0;
    }
    let mut angle = if ax >= ay {
        let base = atan(ay / ax);
        if x < 0.0 {
            core::f32::consts::PI - base
        } else {
            base
        }
    } else {
        let base = core::f32::consts::FRAC_PI_2 - atan(ax / ay);
        if x < 0.0 {
            core::f32::consts::PI - base
        } else {
            base
        }
    };
    if y < 0.0 {
        angle = -angle;
    }
    angle
}

fn degrees(radians: f32) -> f32 {
    radians * (180.0 / core::f32::consts::PI)
}

/// `value` inside `(-180, 180]`, the range the game keeps yaw in.
fn wrap(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    let turns = (value / 360.0) as i64 as f32;
    let mut wrapped = value - turns * 360.0;
    if wrapped > 180.0 {
        wrapped -= 360.0;
    }
    if wrapped <= -180.0 {
        wrapped += 360.0;
    }
    wrapped
}

/* ------------------------------------------------------------------------------------------------
 * interact.block / interact.entity
 * ---------------------------------------------------------------------------------------------- */

/// The whole block a `interact.block` call names: whole coordinates, and a face when one is asked for.
fn block_use(params: &Value) -> Result<([i32; 3], Option<usize>), RpcError> {
    let mut block = [0i32; 3];
    for (axis, key) in ["x", "y", "z"].iter().enumerate() {
        let value = params
            .get(key)
            .and_then(Value::as_f64)
            .ok_or_else(|| RpcError::invalid_params(format!("{key} is required")))?;
        if !value.is_finite() || value.abs() >= 30_000_000.0 || value != (value as i64) as f64 {
            return Err(RpcError::invalid_params(format!("{key} must be a whole block coordinate")));
        }
        block[axis] = value as i32;
    }
    // A use happens in the dimension the player is in, and the engine cannot read which one that is.
    // Acting on the same coordinates in a dimension the caller *states* would use whatever block stands
    // there instead, so a stated dimension is refused rather than ignored.
    if let Some(dimension) = params.get("dimension").and_then(Value::as_str) {
        let dimension = dimension.trim();
        if !dimension.is_empty() {
            return Err(RpcError::invalid_params(format!(
                "the engine cannot read the player's dimension, so a use in {dimension} cannot be confirmed: drop dimension to use the block in the player's current dimension"
            )));
        }
    }
    let face = match params.get("face").and_then(Value::as_str) {
        None => None,
        Some(name) => {
            let index = FACES.iter().position(|face| *face == name.trim()).ok_or_else(|| {
                RpcError::invalid_params(format!("face must be one of {}", FACES.join(", ")))
            })?;
            Some(index)
        }
    };
    Ok((block, face))
}

/// `interact.block {x, y, z, face?}` → `{screen, changed}`.
///
/// The view is written into the rotation component; [`AIM_MS`] later the game's own pick is read, and
/// when it is not on the block the next aim of [`block_aims`] is tried. Once the crosshair is on the
/// block the client's own use handler runs, and the answer settles on the timer (see the module
/// documentation): `screen` is the screen that opened, `null` when none did, and `changed` whether a
/// screen opened or the block's state changed (a lever, a button, a door).
pub(crate) fn h_interact_block(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    expire(core);
    world()?;
    let (block, face) = block_use(params)?;
    let before = playing(core)?;
    let eye = eye()?;
    let aims = block_aims(block, face, eye)?;
    let distance = distance(eye, aims[0]);
    if distance > BLOCK_REACH {
        return Err(RpcError::invalid_params(format!(
            "the block is {distance:.1} blocks from the player's eye, beyond the {BLOCK_REACH}-block reach: move the player closer"
        )));
    }
    let looks: Vec<[f32; 2]> = aims.iter().filter_map(|point| look_at(eye, *point)).collect();
    let [pitch, yaw] = *looks
        .first()
        .ok_or_else(|| RpcError::invalid_params("the block is at the player's eye: there is no view to aim"))?;
    write_look(pitch, yaw)?;
    let plan = AimPlan { block, looks, next: 0, missed: None, state: None };
    park_settle(core, before, Phase::Aim, None, None, Some(plan))
}

/// `interact.entity {id}` → `{screen, changed}`.
///
/// `id` is an entity's unique id as a decimal string (an int64 does not survive a JSON number). The
/// entity is found in the client's own ECS (`ActorUniqueIDComponent` → `StateVectorComponent`), aimed
/// at and used exactly like a block.
pub(crate) fn h_interact_entity(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    expire(core);
    world()?;
    let id = unique_id(params)?;
    let before = playing(core)?;
    let eye = eye()?;
    let position = entity_position(id)?;
    let target = [position[0], position[1] + ENTITY_AIM, position[2]];
    let distance = distance(eye, target);
    if distance > ENTITY_REACH {
        return Err(RpcError::invalid_params(format!(
            "the entity is {distance:.1} blocks from the player's eye, beyond the {ENTITY_REACH}-block reach: walk the player closer"
        )));
    }
    let [pitch, yaw] = look_at(eye, target)
        .ok_or_else(|| RpcError::invalid_params("the entity is at the player's eye: there is no view to aim"))?;
    write_look(pitch, yaw)?;
    park(core, before, Phase::Aim, None)
}

/// The screen the player is in, refusing the call while anything else is open: a use belongs to the
/// world, and a screen that is open (a store, a menu, another container) would take it.
fn playing(core: &'static Core) -> Result<String, RpcError> {
    let screen = screen_now(core)?;
    if !on_hud(&screen.top) {
        return Err(RpcError::invalid_params(format!(
            "a screen is open ({}): close it before using a block or an entity",
            screen.top
        )));
    }
    Ok(screen.top)
}

/// An entity's unique id from the wire: a decimal string, which is how an int64 travels intact.
fn unique_id(params: &Value) -> Result<u64, RpcError> {
    let text = params
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::invalid_params("id is required: an entity's unique id as a decimal string"))?;
    let text = text.trim();
    // The Script API writes an actor id signed; its unsigned spelling names the same 64 bits.
    text.parse::<i64>()
        .map(|value| value as u64)
        .or_else(|_| text.parse::<u64>())
        .map_err(|_| RpcError::invalid_params("id must be an entity's unique id: a whole number in text"))
}

/// The `ActorUniqueIDComponent` entity vector's begin/end, the same fields `ecs` walks.
const ENTITY_BEGIN: usize = 0x20;
const ENTITY_END: usize = 0x28;
/// An ECS holds a few hundred entities on a client; anything larger is not an entity vector.
const ENTITY_LIMIT: u64 = 4_096;

/// The position of the entity carrying unique id `id`, from the client's own ECS.
///
/// `ActorUniqueIDComponent`'s element is the `u64` actor id (`u64::MAX` = no live actor) and
/// `StateVectorComponent`'s is the three `Vec3` position/movement block; both are addressed through
/// the same element walk `ecs` uses, so a storage this build does not have answers an anchor instead
/// of a position.
fn entity_position(id: u64) -> Result<[f32; 3], RpcError> {
    let accessor = input::registry().ok_or_else(|| RpcError::anchor("component.getter"))?;
    let unique = ecs::storage(accessor, anchors::component_hash("ActorUniqueIDComponent"))
        .ok_or_else(|| RpcError::anchor("entity.unique_id"))?;
    let state = ecs::storage(accessor, anchors::component_hash("StateVectorComponent"))
        .ok_or_else(|| RpcError::anchor("entity.position"))?;
    let local = ecs::read(accessor).map(|reading| reading.sample.entity);
    let (Some(begin), Some(end)) = (pe::read::<usize>(unique + ENTITY_BEGIN), pe::read::<usize>(unique + ENTITY_END)) else {
        return Err(RpcError::anchor("entity.unique_id"));
    };
    if end <= begin || (end - begin) % 4 != 0 || (end - begin) as u64 / 4 > ENTITY_LIMIT {
        return Err(RpcError::anchor("entity.unique_id"));
    }
    let mut at = begin;
    while at < end {
        let Some(entity) = pe::read::<u32>(at) else {
            return Err(RpcError::anchor("entity.unique_id"));
        };
        let found = ecs::element(unique, entity, ecs::UNIQUE_STRIDE).and_then(pe::read::<u64>);
        if found == Some(id) && id != u64::MAX {
            if local == Some(entity) {
                return Err(RpcError::invalid_params("that id is the local player: an entity interaction needs another actor"));
            }
            let element = ecs::element(state, entity, ecs::STATE_VECTOR_STRIDE)
                .ok_or_else(|| RpcError::anchor("entity.position"))?;
            let mut position = [0.0f32; 3];
            for (axis, slot) in position.iter_mut().enumerate() {
                *slot = pe::read::<f32>(element + ecs::STATE_POSITION + axis * 4)
                    .ok_or_else(|| RpcError::anchor("entity.position"))?;
                if !slot.is_finite() {
                    return Err(RpcError::anchor("entity.position"));
                }
            }
            return Ok(position);
        }
        at += 4;
    }
    Err(RpcError::invalid_params("no entity of this world carries that unique id"))
}

/* ------------------------------------------------------------------------------------------------
 * The settle: answers that need the game to run a few frames first
 * ---------------------------------------------------------------------------------------------- */

/// How long an interaction waits for the screen to open before it answers "nothing opened".
const SETTLE_MS: u64 = 1_200;
/// How long an opened container screen is given to be usable before the interaction answers anyway.
const READY_MS: u64 = 2_000;
/// How long the aim is left for the game to pick with (two client ticks and a frame) before the use.
const AIM_MS: u64 = 120;
/// How long an interaction waits for a closed screen to leave the stack before it aims (see [`Screen::settled`]).
const CLEAR_MS: u64 = 1_500;
/// How long a request waits for the server's answer.
const RESPONSE_MS: u64 = 2_000;
/// How often the settle timer looks (one client tick at 20 tps).
const SETTLE_TICK_MS: u32 = 50;
/// The settle timer's id on the game window (any value the game and the other modules do not use).
const SETTLE_TIMER_ID: usize = 0x0053_5754;
/// How long `screen.close` waits after an Escape before it sends another: a screen with a focused text box
/// (the chat screen opens with its text box focused) spends its first Escape on leaving the box.
const CLOSE_RETRY_MS: u64 = 400;
/// How many Escapes `screen.close` sends at most.
const CLOSE_ESCAPES: u8 = 3;

/// What a parked request is waiting for.
#[derive(Clone, Copy)]
enum Phase {
    /// The aim is written; the use waits for a closed screen to leave the stack, then for the game to
    /// pick with the new view.
    Aim,
    /// The use went out; waiting for a screen to open.
    Open,
    /// A container screen opened (`Settle::opened`); waiting until its container manager controller and
    /// containers are there and it ran a frame with them (`seen`: they were there on the previous tick).
    Ready { seen: bool },
    /// An item stack request went out; waiting for the server's answer to its id. `cursor`: the result
    /// lands on the cursor (a screen's result handler), which the answer names.
    Request { id: i32, moved: u32, take: bool, cursor: bool },
    /// `screen.close` sent `escapes` Escapes; waiting for the screen to leave the top.
    Close { escapes: u8 },
    /// A `craft.run`: its placements, the craft and the store, step by step ([`CraftRun`]).
    Craft,
}

/// The request waiting on the timer.
struct Settle {
    deferred: Deferred,
    /// The screen that was on top *before* the interaction.
    before: String,
    /// `GetTickCount64` when the current phase began.
    started: u64,
    /// `GetTickCount64` when the request was parked.
    requested: u64,
    phase: Phase,
    /// The slot a `take_result` takes, for its answer.
    item: Option<Value>,
    /// A `craft.run`'s state while its phase is [`Phase::Craft`].
    craft: Option<CraftRun>,
    /// An `interact.block`'s aims and the block's state before the use.
    aim: Option<AimPlan>,
    /// The screen an interaction opened, while its phase is [`Phase::Ready`].
    opened: Option<String>,
}

/// The views an `interact.block` tries, in order, until the game's own pick lands on the block.
///
/// The pick runs against the block's real shape, so a thin block (a floor button, a carpet, a
/// pressure plate) that the first view passes over is reached by a later one aimed lower in the cell;
/// the use goes out only once the crosshair is on the block.
struct AimPlan {
    block: [i32; 3],
    /// `[pitch, yaw]` per aim point; `next` is the one being tried.
    looks: Vec<[f32; 2]>,
    next: usize,
    /// What the crosshair was on at the last aim that missed, for the refusal.
    missed: Option<[i32; 3]>,
    /// The client's `Block` at the target right before the use (one object per block state).
    state: Option<usize>,
}

static SETTLE: SpinLock<Option<Settle>> = SpinLock::new(None);
/// 1 while the settle timer is installed on the game window.
static TIMER: AtomicUsize = AtomicUsize::new(0);

/// Parks the request until its phase settles. A second request while one is still settling answers the
/// older one first, so one action can never be reported under another's outcome.
fn park(core: &'static Core, before: String, phase: Phase, item: Option<Value>) -> Result<Value, RpcError> {
    park_with(core, before, phase, item, None)
}

fn park_with(core: &'static Core, before: String, phase: Phase, item: Option<Value>, craft: Option<CraftRun>) -> Result<Value, RpcError> {
    park_settle(core, before, phase, item, craft, None)
}

fn park_settle(
    core: &'static Core,
    before: String,
    phase: Phase,
    item: Option<Value>,
    craft: Option<CraftRun>,
    aim: Option<AimPlan>,
) -> Result<Value, RpcError> {
    if !core.is_main_thread() || !ensure_timer() {
        return Err(RpcError::anchor("window.game").with_data(json!({
            "message": "the settle timer needs the game window and its own thread",
        })));
    }
    let Some(deferred) = core.defer() else {
        return Err(RpcError::wrong_thread());
    };
    let now = win::tick_ms();
    let previous = SETTLE.lock().replace(Settle { deferred, before, started: now, requested: now, phase, item, craft, aim, opened: None });
    if let Some(previous) = previous {
        previous.deferred.fail(RpcError::timeout());
    }
    Err(RpcError::deferred())
}

/// True when the screen `name` can take a move: a container screen's manager controller (the one
/// `screen.move` runs through) and the containers it shows are there. A screen of no container family is
/// ready as it opens.
fn screen_ready(name: &str) -> bool {
    if kind_of(name) == "other" {
        return true;
    }
    screen_manager(MOVE_SLOT.load(Ordering::Acquire), "screen.move").is_ok() && open_containers().is_ok_and(|open| !open.is_empty())
}

/// The wire's interaction answer: the screen that opened (`null` when none did) and whether the use
/// changed anything: a screen opened, or the used block's state is not the one it had before.
fn outcome(now: Option<&str>, before: &str, aim: Option<&AimPlan>) -> Value {
    let opened = now.filter(|name| *name != before && !on_hud(name));
    json!({ "screen": opened, "changed": opened.is_some() || aim.is_some_and(block_changed) })
}

/// True when the used block is now in another state than right before the use.
fn block_changed(aim: &AimPlan) -> bool {
    let now = inventory::client_block(aim.block).map(|(block, _)| block);
    aim.state.is_some() && now.is_some() && now != aim.state
}

/// The answer a request gets once the server's verdict (or its absence) is known. For a take, `item` is the
/// made slot, or (from [`take_screen`]) the whole answer's `{result, consumed, to}`, read when the client
/// predicted the move.
fn request_outcome(result: Option<u8>, moved: u32, take: bool, cursor: bool, item: Option<Value>) -> Value {
    let accepted = result == Some(0);
    let reason = match result {
        Some(0) => Value::Null,
        Some(code) => Value::String(format!("the server refused the request (ItemStackNetResult {code})")),
        None => Value::String(String::from("the server did not answer the request in time")),
    };
    if take {
        let (mut made, mut consumed, to, at, before) = match item {
            Some(Value::Object(mut answer)) if answer.contains_key("consumed") => (
                answer.remove("result").unwrap_or(Value::Null),
                answer.remove("consumed").unwrap_or(Value::Array(Vec::new())),
                answer.remove("to"),
                answer.remove("slot").and_then(|slot| slot.as_u64()),
                answer.remove("before"),
            ),
            other => (other.unwrap_or(Value::Null), Value::Array(Vec::new()), None, None, None),
        };
        // The made stack as the client holds it now that the server answered (the prediction may not have
        // shown it yet when the request went out).
        if accepted {
            if let (Some(Value::String(name)), Some(slot)) = (to.as_ref(), at) {
                if let Some(now) = open_containers().ok().and_then(|open| open_named(&open, name).and_then(|open| open.item(slot as usize)).and_then(inventory::slot)) {
                    made = now;
                }
            }
            // What left the screen's own slots, read again when the request went out before the client showed
            // it (a beacon's payment leaves only once the server answers).
            if consumed.as_array().is_some_and(Vec::is_empty) {
                if let (Some(before), Ok(open)) = (before.as_ref().map(stations_from), open_containers()) {
                    consumed = Value::Array(consumed_between(&before, &station_items(&open)));
                }
            }
        }
        let mut answer = json!({
            "done": accepted,
            "result": if accepted { made } else { Value::Null },
            "consumed": if accepted { consumed } else { Value::Array(Vec::new()) },
            "reason": reason,
        });
        if accepted {
            if let Some(to) = to {
                answer["to"] = to;
            } else if cursor {
                answer["to"] = Value::String(String::from("CursorContainer"));
            }
        }
        return answer;
    }
    // A bundle insert's count, read again now that the server answered: the source as the request
    // named it can be a view the client refreshes later (`hotbar_items` while the combined hotbar and
    // inventory view already changed), so the bundle's own contents are counted too.
    let moved = match item.as_ref() {
        Some(watch) if accepted => moved.max(watched_move(watch)),
        _ => moved,
    };
    json!({ "moved": if accepted { moved } else { 0 }, "reason": reason, "result": result })
}

/// What a bundle insert moved, as the client shows it now: the larger of what left the source stack
/// and what the bundle's contents gained (each view can lag the other).
fn watched_move(watch: &Value) -> u32 {
    let Ok(open) = open_containers() else {
        return 0;
    };
    let read = |side: &str| {
        let entry = &watch[side];
        let slot = entry["slot"].as_u64().unwrap_or(u64::MAX) as usize;
        let before = entry["before"].as_u64().unwrap_or(0) as u32;
        let item = entry["container"].as_str().and_then(|name| open_named(&open, name)).and_then(|open| open.item(slot));
        (item, before)
    };
    let (source, held) = read("source");
    let left = source.map_or(0, |item| held.saturating_sub(count_of(item) as u32));
    let (bundle, contained) = read("bundle");
    let gained = bundle.map_or(0, |item| bundle_total(&open, item).saturating_sub(contained));
    left.max(gained)
}

/// The items a bundle stack holds, counted in its open dynamic container (0 when none is open).
fn bundle_total(open: &[Open], bundle: usize) -> u32 {
    inventory::bundle_id(bundle)
        .and_then(|id| open.iter().find(|other| other.dynamic == Some(id)))
        .map_or(0, |inside| (0..inside.size).filter_map(|slot| inside.item(slot)).map(|item| count_of(item) as u32).sum())
}

/// Answers a parked request whose phase ran out. Every handler starts with this, so a parked request
/// cannot outlive a message pump that stopped dispatching timers.
fn expire(core: &'static Core) {
    let stale = {
        let slot = SETTLE.lock();
        slot.as_ref().is_some_and(|state| {
            let limit = match state.phase {
                Phase::Aim | Phase::Open => SETTLE_MS,
                Phase::Close { .. } => CLOSE_RETRY_MS * u64::from(CLOSE_ESCAPES),
                Phase::Ready { .. } => READY_MS + u64::from(SETTLE_TICK_MS),
                Phase::Request { .. } | Phase::Craft => RESPONSE_MS,
            };
            state.deferred.cancelled() || win::tick_ms().saturating_sub(state.started) >= limit
        })
    };
    if !stale {
        return;
    }
    let Some(state) = SETTLE.lock().take() else {
        return;
    };
    if state.deferred.cancelled() {
        return;
    }
    match state.phase {
        Phase::Aim => {
            state.deferred.fail(RpcError::timeout());
        }
        Phase::Open => {
            state.deferred.resolve(outcome(screen_name(core).as_deref(), &state.before, state.aim.as_ref()));
        }
        Phase::Ready { .. } => {
            state.deferred.resolve(json!({ "screen": state.opened, "changed": true }));
        }
        Phase::Request { id, moved, take, cursor } => {
            state.deferred.resolve(request_outcome(response(id), moved, take, cursor, state.item));
        }
        Phase::Close { .. } => {
            let gone = screen_name(core).as_deref() != Some(state.before.as_str());
            state.deferred.resolve(json!({ "closed": gone }));
        }
        Phase::Craft => {
            let reason = String::from("the craft's step did not finish in time");
            state.deferred.resolve(state.craft.map(|run| run.failed(reason.clone())).unwrap_or_else(|| craft_failure(reason, Vec::new())));
        }
    }
}

/// Installs the settle timer on the game window, once. A window timer — unlike a thread timer — can be
/// killed from any thread of the process, which is what `agent.unload` needs; it must be *set* from
/// the window's own thread, which every `Thread::Main` handler runs on.
fn ensure_timer() -> bool {
    if TIMER.load(Ordering::Acquire) != 0 {
        return true;
    }
    let Some(window) = input::window() else {
        return false;
    };
    // SAFETY: `SetTimer` on the game window with an id nothing else uses and a `TimerProc`.
    let id = unsafe { win::SetTimer(window, SETTLE_TIMER_ID, SETTLE_TICK_MS, settle_tick as *const () as *mut c_void) };
    if id == 0 {
        return false;
    }
    TIMER.store(1, Ordering::Release);
    true
}

/// Stops the settle timer.
fn stop_timer() {
    if TIMER.swap(0, Ordering::AcqRel) == 0 {
        return;
    }
    if let Some(window) = input::window() {
        // SAFETY: `KillTimer` on the window and the id this module set.
        unsafe { win::KillTimer(window, SETTLE_TIMER_ID) };
    }
}

/// `agent.unload`: stops the settle timer, whose callback is this crate's code, and the response hook's
/// bookkeeping (the hook itself is removed with every other inline hook).
pub fn detach() {
    stop_timer();
    SETTLE.lock().take();
}

/// The settle timer, on the window's thread: runs the use once the aim had time to reach the game,
/// then answers once a screen opens or a request's answer arrives, or when its phase runs out.
unsafe extern "system" fn settle_tick(_window: win::Hwnd, _message: u32, _id: usize, _time: u32) {
    let Some(core) = agent_core::hub::started() else {
        stop_timer();
        return;
    };
    let Some(mut state) = SETTLE.lock().take() else {
        stop_timer();
        return;
    };
    if state.deferred.cancelled() {
        stop_timer();
        return;
    }
    let now = win::tick_ms();
    let elapsed = now.saturating_sub(state.started);
    match state.phase {
        Phase::Aim => {
            // A screen closed just before the request is still leaving the stack: the use would be
            // ignored, so the aim's own wait starts once the stack holds only the HUD.
            if !screen_now(core).is_ok_and(|screen| screen.settled) {
                if now.saturating_sub(state.requested) >= CLEAR_MS {
                    state.deferred.fail(RpcError::timeout().with_data(json!({
                        "message": format!("the closed screen did not leave the stack within {CLEAR_MS} ms; nothing was used"),
                    })));
                    stop_timer();
                    return;
                }
                state.started = now;
                *SETTLE.lock() = Some(state);
                return;
            }
            if elapsed < AIM_MS {
                *SETTLE.lock() = Some(state);
                return;
            }
            if let Some(aim) = state.aim.as_mut() {
                let picked = input::crosshair_block();
                if picked != Some(aim.block) {
                    // This view misses the block's shape: try the next one, or say what is in the way.
                    aim.missed = picked.or(aim.missed);
                    aim.next += 1;
                    let Some(&[pitch, yaw]) = aim.looks.get(aim.next) else {
                        let [x, y, z] = aim.block;
                        let seen = match aim.missed {
                            Some([a, b, c]) => format!("the crosshair lands on the block at {a} {b} {c} instead"),
                            None => String::from("the crosshair lands on no block"),
                        };
                        state.deferred.fail(RpcError::invalid_params(format!(
                            "no view from the player's eye reaches the block at {x} {y} {z}: {seen}; move the player so nothing is in the way"
                        )));
                        stop_timer();
                        return;
                    };
                    if let Err(error) = write_look(pitch, yaw) {
                        state.deferred.fail(error);
                        stop_timer();
                        return;
                    }
                    state.started = now;
                    *SETTLE.lock() = Some(state);
                    return;
                }
                aim.state = inventory::client_block(aim.block).map(|(block, _)| block);
            }
            if let Err(error) = input::with_item_scope(input::use_click).and_then(|result| result) {
                state.deferred.fail(error);
                stop_timer();
                return;
            }
            state.phase = Phase::Open;
            state.started = now;
            *SETTLE.lock() = Some(state);
        }
        Phase::Open => {
            let now_screen = screen_name(core);
            let opened = now_screen.as_deref().filter(|name| *name != state.before && !on_hud(name)).map(String::from);
            if let Some(name) = opened {
                // Answered once the screen can be used: a move right after the answer finds the screen's
                // controller and the containers it shows, and whatever the screen does as it opens (a
                // trade screen fills the selected offer's cost from the inventory) has happened.
                state.phase = Phase::Ready { seen: false };
                state.started = now;
                state.opened = Some(name);
                *SETTLE.lock() = Some(state);
            } else if state.aim.as_ref().is_some_and(block_changed) {
                // A lever, a button, a door: the use changed the block and opens nothing. Answered at
                // once, before a button springs back.
                state.deferred.resolve(json!({ "screen": null, "changed": true }));
                stop_timer();
            } else if elapsed >= SETTLE_MS {
                state.deferred.resolve(json!({ "screen": null, "changed": false }));
                stop_timer();
            } else {
                *SETTLE.lock() = Some(state);
            }
        }
        Phase::Ready { seen } => {
            let name = state.opened.clone().unwrap_or_default();
            let still_open = screen_name(core).as_deref() == Some(name.as_str());
            let ready = still_open && screen_ready(&name);
            if !still_open || (ready && seen) || elapsed >= READY_MS {
                #[cfg(feature = "debug-rpc")]
                agent_core::log::fmt(format_args!("interact: {name} open {still_open} ready {ready} after {elapsed} ms, controller {:x?}", ui::screen_controller()));
                state.deferred.resolve(json!({ "screen": name, "changed": true }));
                stop_timer();
            } else {
                state.phase = Phase::Ready { seen: ready };
                *SETTLE.lock() = Some(state);
            }
        }
        Phase::Request { id, moved, take, cursor } => {
            let result = response(id);
            if result.is_some() || elapsed >= RESPONSE_MS {
                let item = state.item.take();
                state.deferred.resolve(request_outcome(result, moved, take, cursor, item));
                stop_timer();
            } else {
                *SETTLE.lock() = Some(state);
            }
        }
        Phase::Close { escapes } => {
            let gone = screen_name(core).as_deref() != Some(state.before.as_str());
            if gone || elapsed >= CLOSE_RETRY_MS * u64::from(CLOSE_ESCAPES) {
                state.deferred.resolve(json!({ "closed": gone, "escapes": escapes }));
                stop_timer();
            } else if elapsed >= CLOSE_RETRY_MS * u64::from(escapes) && escapes < CLOSE_ESCAPES {
                // Still on top: the last Escape went to something inside the screen (its focused text box).
                let sent = ui::h_key(core, &json!({ "key": "Escape", "action": "press" })).is_ok();
                state.phase = Phase::Close { escapes: escapes + u8::from(sent) };
                *SETTLE.lock() = Some(state);
            } else {
                *SETTLE.lock() = Some(state);
            }
        }
        Phase::Craft => {
            let Some(mut run) = state.craft.take() else {
                state.deferred.fail(RpcError::standard(agent_core::engine::INTERNAL_ERROR));
                stop_timer();
                return;
            };
            match run.step(elapsed) {
                Some(answer) => {
                    state.deferred.resolve(answer);
                    stop_timer();
                }
                None => {
                    if run.restarted {
                        run.restarted = false;
                        state.started = now;
                    }
                    state.craft = Some(run);
                    *SETTLE.lock() = Some(state);
                }
            }
        }
    }
}

/* ------------------------------------------------------------------------------------------------
 * The client's item stack requests: anchors
 * ---------------------------------------------------------------------------------------------- */

/// The client net manager's own log literals: each names the one member that logs it.
const BEGIN_LOG: &[u8] = b"ItemStackNetManagerClient::_beginRequest() with clientRequestId: ";
const ADD_LOG: &[u8] =
    b"ItemStackNetManagerClient::addRequestAction() SUCCEEDED with clientRequestId: {} and requestAction {}";
const END_LOG: &[u8] = b"ItemStackNetManagerClient::_endRequest() with clientRequestId: ";
const RESPONSE_LOG: &[u8] =
    b"ItemStackNetManagerClient::handleItemStackResponse with clientRequestId: {} with result: {} **** START ****";

/// `_beginRequest(manager, mode)`, `addRequestAction(manager, unique_ptr<Action>&&)` and the submit step
/// (`_endRequest` + enqueue for the next input packet).
static BEGIN: AtomicUsize = AtomicUsize::new(0);
static ADD: AtomicUsize = AtomicUsize::new(0);
static SUBMIT: AtomicUsize = AtomicUsize::new(0);
/// The global that holds the game's allocator object (`allocate(size)` is its table's slot 1).
static ALLOCATOR: AtomicUsize = AtomicUsize::new(0);
/// The request's own table (a `TypedClientNetId<ItemStackRequestIdTag>`), which `_beginRequest` stamps.
static REQUEST_TABLE: AtomicUsize = AtomicUsize::new(0);
/// `Player + this` = the player's `ItemStackNetManagerBase*`.
static MANAGER_OFFSET: AtomicUsize = AtomicUsize::new(0);
/// `handleItemStackResponse` and its hook's trampoline.
static RESPONSE: AtomicUsize = AtomicUsize::new(0);
static RESPONSE_TRAMPOLINE: AtomicUsize = AtomicUsize::new(0);
/// The ECS component (hash) holding the client's container map, and its element stride.
static CONTAINERS_HASH: AtomicUsize = AtomicUsize::new(0);
static CONTAINERS_STRIDE: AtomicUsize = AtomicUsize::new(0);

/// `engine.status.hooks` name of the response hook.
const SITE_RESPONSE: &str = "screen.response";

/// The manager's fields this module reads: the client-side flag (`== 1` on the client's manager) and
/// the request being built (null when none).
const MANAGER_CLIENT: usize = 0x09;
const MANAGER_PENDING: usize = 0x68;
/// `ItemStackRequestData`: `+0x08` client request id, `+0x30`/`+0x38` the action vector.
const REQUEST_ID: usize = 0x08;
const REQUEST_ACTIONS: usize = 0x30;
/// The client `ItemStack`'s size (the base stack plus its net id variant).
const ITEM_SIZE: usize = 0x98;
/// `ItemStack + 0x08` (the item's refcounted impl, `impl[0]` the `Item*`), `+0x20` aux, `+0x22` count.
const ITEM_IMPL: usize = 0x08;
const ITEM_AUX: usize = 0x20;
const ITEM_COUNT: usize = 0x22;
/// The stack's "valid" flag (`ItemStackBase::mValid`), 0 or 1.
const ITEM_VALID: usize = 0x23;
/// Transfer action types (`ItemStackRequestActionType`).
const TAKE: u8 = 0;
const PLACE: u8 = 1;
const SWAP: u8 = 2;

/// `mov rcx,[rip+G]; mov rax,[rcx]; mov rax,[rax+8]; mov edx,0x48` — the request's allocation in
/// `_beginRequest`: `G` holds the game's allocator, `0x48` is the request's size.
const ALLOCATION: [Option<u8>; 17] = {
    const W: Option<u8> = None;
    [
        Some(0x48), Some(0x8B), Some(0x0D), W, W, W, W, Some(0x48), Some(0x8B), Some(0x01), Some(0x48), Some(0x8B),
        Some(0x40), Some(0x08), Some(0xBA), Some(0x48), Some(0x00),
    ]
};
/// `lea rdi,[rip+TABLE]; mov [rbp+d8],rdi; mov eax,[rip+counter]` — the request's table, stamped
/// right before the request id is drawn.
const REQUEST_STAMP: [Option<u8>; 13] = {
    const W: Option<u8> = None;
    [Some(0x48), Some(0x8D), Some(0x3D), W, W, W, W, Some(0x48), Some(0x89), Some(0x7D), W, Some(0x8B), Some(0x05)]
};
/// `mov rax,[r8+0x30]; mov rcx,[rax+OFFSET]; test rcx,rcx` — the request scope reading the player's
/// net manager.
const MANAGER_READ: [Option<u8>; 14] = {
    const W: Option<u8> = None;
    [
        Some(0x49), Some(0x8B), Some(0x40), Some(0x30), Some(0x48), Some(0x8B), Some(0x88), W, W, W, W, Some(0x48),
        Some(0x85), Some(0xC9),
    ]
};

/// The first offset of `pattern` in `body` (`None` bytes match anything).
fn find(body: &[u8], pattern: &[Option<u8>]) -> Option<usize> {
    if body.len() < pattern.len() {
        return None;
    }
    (0..=body.len() - pattern.len())
        .find(|&at| body[at..at + pattern.len()].iter().zip(pattern).all(|(byte, want)| want.is_none_or(|want| want == *byte)))
}

/// The absolute target of a `disp32` at `body[at..at + 4]`, for an instruction ending at `end`.
fn rip_target(base: usize, body: &[u8], at: usize, end: usize) -> Option<usize> {
    let disp = i32::from_le_bytes(body.get(at..at + 4)?.try_into().ok()?) as isize;
    Some((base + end).wrapping_add_signed(disp))
}

/// A function's body, from `.pdata`, when it is a plausible size.
fn body_of(image: &Image, function: usize, limit: usize) -> Option<(usize, &'static [u8])> {
    let (start, end) = pe::function_of(image, function)?;
    if end <= start || end - start > limit {
        return None;
    }
    Some((start, pe::bytes(start, end - start)?))
}

/// Resolves the request path. Every piece is derived from the net manager's own code; a piece that
/// does not resolve uniquely leaves `screen.request` missing.
fn resolve_requests(core: &'static Core) {
    let image = core.image();
    let begin = image.function_from_string(BEGIN_LOG);
    let add = image.function_from_string(ADD_LOG);
    let end = image.function_from_string(END_LOG);
    let response = image.function_from_string(RESPONSE_LOG);
    // `_beginRequest`: the allocator global and the request's table.
    if let Some((start, body)) = begin.and_then(|begin| body_of(image, begin, 0x1000)) {
        if let Some(at) = find(body, &ALLOCATION) {
            if let Some(global) = rip_target(start, body, at + 3, at + 7) {
                ALLOCATOR.store(global, Ordering::Release);
            }
        }
        if let Some(at) = find(body, &REQUEST_STAMP) {
            if let Some(table) = rip_target(start, body, at + 3, at + 7).filter(|table| pe::in_image_data(*table)) {
                REQUEST_TABLE.store(table, Ordering::Release);
            }
        }
    }
    // The submit step: the small `_endRequest` caller that pushes into the manager's queue (`[x+0x70]`).
    let submit = end.and_then(|end| {
        let mut found: Option<usize> = None;
        for site in pe::callers(image, end) {
            let Some((start, body)) = body_of(image, site, 0x200) else {
                continue;
            };
            let queues = body.windows(4).any(|window| {
                matches!(window[0], 0x48 | 0x4C) && window[1] == 0x8B && window[2] >> 6 == 1 && window[2] & 7 != 4 && window[3] == 0x70
            });
            if queues {
                if found.is_some_and(|known| known != start) {
                    return None;
                }
                found = Some(start);
            }
        }
        found
    });
    // The manager's offset in the player: every request scope reads it the same way.
    let offset = begin.and_then(|begin| {
        let mut found: Option<u32> = None;
        for site in pe::callers(image, begin) {
            let Some((_, body)) = body_of(image, site, 0x4000) else {
                continue;
            };
            if let Some(at) = find(body, &MANAGER_READ) {
                let value = u32::from_le_bytes(body[at + 7..at + 11].try_into().ok()?);
                if found.is_some_and(|known| known != value) {
                    return None;
                }
                found = Some(value);
            }
        }
        found.filter(|value| (0x100..0x4000).contains(value))
    });
    // The client's container map: the component the response handler looks up inline
    // (`cmp dword [rdx+r8+8],HASH`), and its element stride (`imul rdx,rdx,STRIDE`) right after.
    if let Some((_, body)) = response.and_then(|response| body_of(image, response, 0x4000)) {
        if let Some(at) = find(body, &[Some(0x42), Some(0x81), Some(0x7C), Some(0x02), Some(0x08)]) {
            let hash = u32::from_le_bytes(body[at + 5..at + 9].try_into().unwrap_or([0; 4]));
            let after = &body[at..(at + 0x100).min(body.len())];
            if let Some(imul) = find(after, &[Some(0x48), Some(0x69), Some(0xD2)]) {
                let stride = u32::from_le_bytes(after[imul + 3..imul + 7].try_into().unwrap_or([0; 4])) as usize;
                if hash != 0 && (0x40..0x1000).contains(&stride) {
                    CONTAINERS_HASH.store(hash as usize, Ordering::Release);
                    CONTAINERS_STRIDE.store(stride, Ordering::Release);
                }
            }
        }
        resolve_slot_filters(body);
    }
    if let (Some(begin), Some(add), Some(submit), Some(offset)) = (begin, add, submit, offset) {
        BEGIN.store(begin, Ordering::Release);
        ADD.store(add, Ordering::Release);
        SUBMIT.store(submit, Ordering::Release);
        MANAGER_OFFSET.store(offset as usize, Ordering::Release);
    }
    match response {
        Some(target) => {
            RESPONSE.store(target, Ordering::Release);
            match hook::install_published(target, response_hook as *const () as usize, &RESPONSE_TRAMPOLINE) {
                Some(_) => {
                    core.site(SITE_RESPONSE, true);
                    agent_core::log::fmt(format_args!("hook {SITE_RESPONSE}: installed at 0x{target:x}"));
                }
                None => {
                    core.site(SITE_RESPONSE, false);
                    agent_core::log::fmt(format_args!("hook {SITE_RESPONSE}: refused, game code untouched"));
                }
            }
        }
        None => core.site(SITE_RESPONSE, false),
    }
    let rva = |address: usize| if address == 0 { String::from("missing") } else { format!("0x{:x}", address - image.base()) };
    agent_core::log::fmt(format_args!(
        "resolve workstation: begin {}, add {}, submit {}, allocator {}, request table {}, manager +0x{:x}, response {}, containers 0x{:x}/0x{:x}",
        rva(BEGIN.load(Ordering::Acquire)),
        rva(ADD.load(Ordering::Acquire)),
        rva(SUBMIT.load(Ordering::Acquire)),
        rva(ALLOCATOR.load(Ordering::Acquire)),
        rva(REQUEST_TABLE.load(Ordering::Acquire)),
        MANAGER_OFFSET.load(Ordering::Acquire),
        rva(RESPONSE.load(Ordering::Acquire)),
        CONTAINERS_HASH.load(Ordering::Acquire),
        CONTAINERS_STRIDE.load(Ordering::Acquire),
    ));
}

/// True when every piece a transfer request needs resolved.
fn requests_ready() -> bool {
    [&BEGIN, &ADD, &SUBMIT, &ALLOCATOR, &REQUEST_TABLE, &MANAGER_OFFSET, &RESPONSE_TRAMPOLINE]
        .iter()
        .all(|slot| slot.load(Ordering::Acquire) != 0)
}

/* ------------------------------------------------------------------------------------------------
 * The server's answers
 * ---------------------------------------------------------------------------------------------- */

/// The last answers the client received: `(clientRequestId, ItemStackNetResult)`.
const RESPONSE_RING: usize = 32;
static RESPONSES: SpinLock<([(i32, u8); RESPONSE_RING], usize)> = SpinLock::new(([(0, 0); RESPONSE_RING], 0));
/// `ItemStackResponseInfo`: 0x30 bytes, `+0x00` result, `+0x10` client request id.
const RESPONSE_STRIDE: usize = 0x30;
const RESPONSE_ID: usize = 0x10;

/// `handleItemStackResponse(manager, vector<ItemStackResponseInfo> const&)`: records each answer, then
/// runs the game's own handler unchanged.
extern "C" fn response_hook(manager: usize, list: usize, third: usize, fourth: usize) -> usize {
    if let Some(core) = agent_core::hub::started() {
        core.site_fired(SITE_RESPONSE);
    }
    record_responses(list);
    let original = RESPONSE_TRAMPOLINE.load(Ordering::Acquire);
    if original == 0 {
        return 0;
    }
    // SAFETY: the trampoline runs the game's own handler with every argument register it was given.
    unsafe { transmute::<usize, extern "C" fn(usize, usize, usize, usize) -> usize>(original)(manager, list, third, fourth) }
}

fn record_responses(list: usize) {
    let (Some(begin), Some(end)) = (pe::read::<usize>(list), pe::read::<usize>(list + 8)) else {
        return;
    };
    if end < begin || (end - begin) % RESPONSE_STRIDE != 0 || (end - begin) / RESPONSE_STRIDE > 64 {
        return;
    }
    let mut at = begin;
    while at < end {
        if let (Some(result), Some(id)) = (pe::read::<u8>(at), pe::read::<i32>(at + RESPONSE_ID)) {
            let mut ring = RESPONSES.lock();
            let index = ring.1 % RESPONSE_RING;
            ring.0[index] = (id, result);
            ring.1 = ring.1.wrapping_add(1);
        }
        at += RESPONSE_STRIDE;
    }
}

/// The server's verdict on request `id`, once it arrived.
fn response(id: i32) -> Option<u8> {
    let ring = RESPONSES.lock();
    ring.0.iter().find(|(known, _)| *known == id && id != 0).map(|(_, result)| *result)
}

/* ------------------------------------------------------------------------------------------------
 * The local player, its net manager, and the client's container map
 * ---------------------------------------------------------------------------------------------- */

/// `ContainerEnumName` ↔ name, as the game itself maps them: the static `unordered_map<u8, std::string>`
/// its own name function (`FullContainerName` → string) walks. `ENUM_END` is the address of that map's
/// list head pointer (`mov rdx,[rip+END]` in the function); a node is `+0x00` next, `+0x10` the enum
/// byte, `+0x18` the name. The numbering changed between builds, so it is always read, never assumed.
static ENUM_END: AtomicUsize = AtomicUsize::new(0);
/// In the name function: `movzx eax,[rcx]; mov r8d,[rip+MASK]; and r8d,eax; mov r9,[rip+BUCKETS];
/// shl r8d,4; mov rdi,[r9+r8+8]; mov rdx,[rip+END]`.
const ENUM_NAMES_PATTERN: &str = "0F B6 01 44 8B 05 ?? ?? ?? ?? 41 21 C0 4C 8B 0D ?? ?? ?? ?? 41 C1 E0 04 4B 8B 7C 01 08 48 8B 15 ?? ?? ?? ??";
/// More entries than this means the walk is not on the enum map.
const ENUM_LIMIT: usize = 256;

/// Every `(enum, name)` the game registers.
fn container_names() -> Vec<(u8, String)> {
    let mut out = Vec::new();
    let end = ENUM_END.load(Ordering::Acquire);
    let Some(head) = pe::read::<usize>(end).filter(|head| *head != 0) else {
        #[cfg(feature = "debug-rpc")]
        agent_core::log::fmt(format_args!("container names: list head global 0x{end:x} holds no head"));
        return out;
    };
    let mut node = pe::read::<usize>(head).unwrap_or(head);
    let mut walked = 0usize;
    while node != head && node != 0 && walked < ENUM_LIMIT {
        walked += 1;
        let (Some(id), Some(name)) = (pe::read::<u8>(node + 0x10), pe::std_string(node + 0x18)) else {
            break;
        };
        if !name.is_empty() && name.len() <= 64 && name.bytes().all(|byte| byte.is_ascii_graphic()) {
            out.push((id, name));
        }
        node = pe::read::<usize>(node).unwrap_or(0);
    }
    #[cfg(feature = "debug-rpc")]
    agent_core::log::fmt(format_args!(
        "container names: global 0x{end:x} head 0x{head:x} first 0x{:x} walked {walked} kept {} sample {:?}",
        pe::read::<usize>(head).unwrap_or(0),
        out.len(),
        out.iter().take(4).collect::<Vec<_>>()
    ));
    out
}

/// The name of enum value `id`.
fn name_of(id: u8) -> Option<String> {
    container_names().into_iter().find(|(known, _)| *known == id).map(|(_, name)| name)
}

/// A container name folded for comparison: lower case, letters and digits only, without the trailing
/// `items`/`item`/`container` and `preview`. The game's collection names (`stonecutter_input_items`,
/// `stonecutter_result_items`) and the enum names earlier builds and callers use
/// (`StonecutterInputContainer`, `StonecutterResultPreviewContainer`) fold to the same text.
fn folded(name: &str) -> String {
    let mut out: String = name.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect();
    for suffix in ["container", "items", "item"] {
        if out.len() > suffix.len() && out.ends_with(suffix) {
            out.truncate(out.len() - suffix.len());
            break;
        }
    }
    if out.len() > "preview".len() && out.ends_with("preview") {
        out.truncate(out.len() - "preview".len());
    }
    if let Some(rest) = out.strip_prefix("brewingstand") {
        out = format!("brewing{rest}");
    }
    // The names that differ in more than the spelling (enum name → the game's collection name).
    let renamed = match out.as_str() {
        "createdoutput" => "creativeoutput",
        "furnaceresult" => "furnaceoutput",
        "enchantingmaterial" => "enchantinglapis",
        "blastfurnaceingredient" | "smokeringredient" => "furnaceingredient",
        _ => return out,
    };
    String::from(renamed)
}

/// The open container `name` names: the one reported under exactly that key, else the first whose key
/// folds to the same text (see [`folded`]; several enum values can share one collection name, so the
/// lookup is among what is open, never through a global name → enum table).
fn open_named<'a>(open: &'a [Open], name: &str) -> Option<&'a Open> {
    if let Some(found) = open.iter().find(|container| container.key() == name) {
        return Some(found);
    }
    let wanted = folded(name);
    open.iter().find(|container| folded(&container.key()) == wanted)
}

/// True when enum value `id` is one of `names` (compared folded).
fn named_any(id: u8, names: &[&str]) -> bool {
    name_of(id).is_some_and(|name| {
        let name = folded(&name);
        names.iter().any(|known| folded(known) == name)
    })
}

/// The player's own containers, by name: armour, the combined view, hotbar, inventory, offhand, cursor.
const PLAYER_CONTAINERS: [&str; 6] = [
    "ArmorContainer",
    "CombinedHotbarAndInventoryContainer",
    "HotbarContainer",
    "InventoryContainer",
    "OffhandContainer",
    "CursorContainer",
];
/// The ones that hold the player's carried items (hotbar + main inventory, alone or combined).
const CARRIED: [&str; 3] = ["HotbarContainer", "InventoryContainer", "CombinedHotbarAndInventoryContainer"];

fn is_player(id: u8) -> bool {
    named_any(id, &PLAYER_CONTAINERS)
}

fn is_carried(id: u8) -> bool {
    named_any(id, &CARRIED)
}

/// The two maps in the container-map element (`FullContainerName` → screen container): each an MSVC
/// `unordered_map` whose list head sits at these offsets (size right after), read the way the
/// response handler reads them.
const MAP_HEADS: [usize; 2] = [0xD0, 0x110];
/// A list node: `+0x00` next, `+0x10` the key's enum, `+0x14` dynamic id, `+0x18` has-dynamic-id, and
/// `+0x50` the entry whose `+0x08` is the container.
const NODE_NAME: usize = 0x10;
const NODE_DYNAMIC: usize = 0x14;
const NODE_HAS_DYNAMIC: usize = 0x18;
const NODE_ENTRY: usize = 0x50;
const ENTRY_CONTAINER: usize = 0x08;
/// `Container::getItem(int) -> ItemStack const&` and `getContainerSize()`.
const CONTAINER_GET_ITEM: usize = 0x38;
const CONTAINER_SIZE: usize = 0xA0;
const CONTAINER_LIMIT: usize = 0x100;

/// Which slots of a screen container belong to which name. Several names share one container (a
/// station's inputs, the cursor and the crafting grids are ranges of the player's UI container; the
/// hotbar and the inventory are ranges of the carried one), and the container keeps, per name, the
/// predicate the response handler asks before it applies a slot: an MSVC `unordered_map<u8,
/// std::function<bool(int)>>` whose list head is at [`SLOT_FILTERS`] in the container (buckets `+0x10`,
/// mask `+0x28`), the function's implementation pointer at [`SLOT_FILTER_NODE`] in a node and its
/// `_Do_call` at [`SLOT_FILTER_CALL`] in that object's table. All three are read out of the response
/// handler (`movzx edx,name; and edx,[c+MASK]; mov rax,[c+HEAD]; mov r8,[c+BUCKETS]; shl edx,4`, then
/// `mov rcx,[node+FN]; test rcx,rcx; jz; mov rax,[rcx]; mov rax,[rax+CALL]`).
static SLOT_FILTERS: AtomicUsize = AtomicUsize::new(0);
static SLOT_FILTER_NODE: AtomicUsize = AtomicUsize::new(0);
static SLOT_FILTER_CALL: AtomicUsize = AtomicUsize::new(0);

const SLOT_FILTER_LOOKUP: [Option<u8>; 26] = [
    Some(0x0F), Some(0xB6), None, Some(0x23), None, None, None, None, None,
    None, Some(0x8B), None, None, None, None, None,
    Some(0x4C), Some(0x8B), None, None, None, None, None,
    Some(0xC1), Some(0xE2), Some(0x04),
];
const SLOT_FILTER_INVOKE: [Option<u8>; 20] = [
    Some(0x48), Some(0x8B), None, None, Some(0x48), Some(0x85), Some(0xC9), Some(0x0F), Some(0x84), None, None, None, None,
    Some(0x48), Some(0x8B), Some(0x01), Some(0x48), Some(0x8B), Some(0x40), None,
];

/// Reads the slot-predicate map's offsets out of the response handler's body.
fn resolve_slot_filters(body: &[u8]) {
    let Some(at) = find(body, &SLOT_FILTER_LOOKUP) else {
        return;
    };
    let disp = |offset: usize| body.get(at + offset..at + offset + 4).map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize);
    let (Some(mask), Some(head), Some(buckets)) = (disp(5), disp(12), disp(19)) else {
        return;
    };
    // The three fields of one MSVC `unordered_map`: list, bucket vector, mask.
    if head == 0 || head > 0x4000 || buckets != head + 0x10 || mask != head + 0x28 {
        return;
    }
    let after = &body[at..(at + 0x100).min(body.len())];
    let Some(call) = find(after, &SLOT_FILTER_INVOKE) else {
        return;
    };
    let (node, slot) = (after[call + 3] as usize, after[call + 19] as usize);
    if !(0x18..0x80).contains(&node) || node % 8 != 0 || slot % 8 != 0 || slot > 0x40 {
        return;
    }
    SLOT_FILTER_NODE.store(node, Ordering::Release);
    SLOT_FILTER_CALL.store(slot, Ordering::Release);
    SLOT_FILTERS.store(head, Ordering::Release);
}

/// The slots of `container` (of `size` slots) that belong to name `name`, in order. Every slot when the
/// container keeps no predicates (or they did not resolve); none when it keeps some but not one for
/// this name, which is how the game itself treats a response slot for that name.
fn slots_named(container: usize, size: usize, name: u8) -> Vec<u8> {
    let all = || (0..size.min(CONTAINER_LIMIT)).map(|slot| slot as u8).collect::<Vec<u8>>();
    let head_at = SLOT_FILTERS.load(Ordering::Acquire);
    if head_at == 0 {
        return all();
    }
    let (Some(head), Some(count)) = (pe::read::<usize>(container + head_at), pe::read::<usize>(container + head_at + 8)) else {
        return all();
    };
    if head == 0 || count == 0 || count > CONTAINER_LIMIT {
        return all();
    }
    let mut node = pe::read::<usize>(head).unwrap_or(head);
    let mut walked = 0usize;
    let mut found = None;
    while node != head && node != 0 {
        walked += 1;
        if walked > count {
            return all();
        }
        if pe::read::<u8>(node + NODE_NAME) == Some(name) {
            found = Some(node);
            break;
        }
        node = pe::read::<usize>(node).unwrap_or(0);
    }
    let Some(node) = found else {
        return Vec::new();
    };
    let Some(function) = pe::read::<usize>(node + SLOT_FILTER_NODE.load(Ordering::Acquire)).filter(|function| *function != 0) else {
        return Vec::new();
    };
    let entry = pe::read::<usize>(function)
        .filter(|table| pe::in_image_data(*table))
        .and_then(|table| pe::read::<usize>(table + SLOT_FILTER_CALL.load(Ordering::Acquire)))
        .filter(|entry| pe::in_image_code(*entry));
    let Some(entry) = entry else {
        return all();
    };
    (0..size.min(CONTAINER_LIMIT))
        .filter(|slot| {
            let mut argument = *slot as i32;
            // SAFETY: the `_Do_call(int&&) -> bool` of the predicate the container keeps for this name,
            // its table in the image; the response handler calls it the same way, with a slot below the
            // container's size.
            unsafe { transmute::<usize, extern "C" fn(usize, *mut i32) -> u8>(entry)(function, &mut argument) != 0 }
        })
        .map(|slot| slot as u8)
        .collect()
}

/// One container the client's open screen shows: one name, and the slots of the (possibly shared)
/// container that are that name's, in order. Slot indices on the wire are positions in `slots`; the
/// request carries the container's own slot (`at`).
struct Open {
    name: u8,
    dynamic: Option<u32>,
    container: usize,
    slots: Vec<u8>,
    size: usize,
}

impl Open {
    /// The key `screen.state` reports it under: the game's name, plus `_<id>` for a dynamic container.
    fn key(&self) -> String {
        let name = name_of(self.name).unwrap_or_else(|| format!("Container{}", self.name));
        match self.dynamic {
            Some(id) => format!("{name}_{id}"),
            None => String::from(name),
        }
    }

    /// The container's own slot behind position `slot` of this name.
    fn at(&self, slot: usize) -> u8 {
        self.slots.get(slot).copied().unwrap_or(u8::MAX)
    }

    fn item(&self, slot: usize) -> Option<usize> {
        let slot = *self.slots.get(slot)?;
        let table = pe::read::<usize>(self.container)?;
        let entry = pe::read::<usize>(table + CONTAINER_GET_ITEM).filter(|entry| pe::in_image_code(*entry))?;
        // SAFETY: the game's own `ItemStack const& getItem(int)` on the container it belongs to (its
        // table was validated when the container was listed); the result is only read.
        let item = unsafe { transmute::<usize, extern "C" fn(usize, u32) -> usize>(entry)(self.container, slot as u32) };
        pe::readable(item, ITEM_SIZE).then_some(item)
    }
}

/// The net manager's screen contexts: `[manager + 0x38]` is a `std::deque` of context objects (map `+0x08`,
/// map size `+0x10`, offset `+0x18`, size `+0x20`, two pointers per block), each with its registry at
/// `+0x10` and entity at `+0x18` — what the response handler walks to find the entity holding the container
/// map it applies a response to.
const MANAGER_CONTEXTS: usize = 0x38;
const CONTEXT_REGISTRY: usize = 0x10;
const CONTEXT_ENTITY: usize = 0x18;
/// A client keeps a handful of screen contexts; more means the deque is not one.
const CONTEXT_LIMIT: usize = 64;

/// The storage of component `hash` in `registry`, looked up read-only the way the response handler does
/// (an open-hash table: buckets `[+0x48, +0x50)` of node indices, nodes of `0x20` bytes at `+0x68` with the
/// next index at `+0x00`, the hash at `+0x08` and the storage at `+0x10`, `+0x70` the end). Unlike the
/// game's getter it never creates a storage.
pub(crate) fn storage_in(registry: usize, hash: u32) -> Option<usize> {
    let buckets = pe::read::<usize>(registry + 0x48)?;
    let buckets_end = pe::read::<usize>(registry + 0x50)?;
    let nodes = pe::read::<usize>(registry + 0x68)?;
    let nodes_end = pe::read::<usize>(registry + 0x70)?;
    let count = buckets_end.checked_sub(buckets)? / 8;
    if count == 0 || count > 0x1_0000 || nodes == 0 || nodes_end < nodes {
        return None;
    }
    let mut index = pe::read::<u64>(buckets + ((count - 1) & hash as usize) * 8)?;
    for _ in 0..CONTEXT_LIMIT * 16 {
        if index == u64::MAX {
            return None;
        }
        let node = nodes + (index as usize) * 0x20;
        if node >= nodes_end {
            return None;
        }
        if pe::read::<u32>(node + 8)? == hash {
            return pe::read::<usize>(node + 0x10).filter(|storage| *storage != 0);
        }
        index = pe::read::<u64>(node)?;
    }
    None
}

/// Every container-map element: on each screen context the net manager keeps (newest first), then on the
/// local player.
fn container_maps(hash: u32, stride: usize) -> Result<Vec<usize>, RpcError> {
    let mut out: Vec<usize> = Vec::new();
    let managed = manager();
    #[cfg(feature = "debug-rpc")]
    agent_core::log::fmt(format_args!(
        "screen.state: player {:x?} manager {:x?}",
        local_player().ok().and_then(|(accessor, entity)| player_object(accessor, entity)),
        managed.as_ref().ok()
    ));
    if let Ok(manager) = managed {
        if let Some(deque) = pe::read::<usize>(manager + MANAGER_CONTEXTS).filter(|deque| *deque != 0) {
            let (map, map_size, offset, size) = (
                pe::read::<usize>(deque + 0x08).unwrap_or(0),
                pe::read::<usize>(deque + 0x10).unwrap_or(0),
                pe::read::<usize>(deque + 0x18).unwrap_or(0),
                pe::read::<usize>(deque + 0x20).unwrap_or(0),
            );
            #[cfg(feature = "debug-rpc")]
            agent_core::log::fmt(format_args!(
                "screen.state: manager 0x{manager:x} deque 0x{deque:x} map 0x{map:x} mapsize {map_size} offset {offset} size {size}"
            ));
            if map != 0 && map_size.is_power_of_two() && size <= CONTEXT_LIMIT {
                for position in (offset..offset + size).rev() {
                    let Some(block) = pe::read::<usize>(map + ((position >> 1) & (map_size - 1)) * 8).filter(|block| *block != 0) else {
                        continue;
                    };
                    let Some(context) = pe::read::<usize>(block + (position & 1) * 8).filter(|context| *context != 0) else {
                        continue;
                    };
                    let (Some(registry), Some(entity)) = (pe::read::<usize>(context + CONTEXT_REGISTRY), pe::read::<u32>(context + CONTEXT_ENTITY)) else {
                        continue;
                    };
                    #[cfg(feature = "debug-rpc")]
                    agent_core::log::fmt(format_args!(
                        "screen.state: context #{position} 0x{context:x} registry 0x{registry:x} entity 0x{entity:x} storage {:x?}",
                        storage_in(registry, hash)
                    ));
                    if let Some(element) = storage_in(registry, hash).and_then(|storage| ecs::element(storage, entity, stride)) {
                        if !out.contains(&element) {
                            out.push(element);
                        }
                    }
                }
            }
        }
    }
    if let Ok((accessor, entity)) = local_player() {
        if let Some(element) = ecs::storage(accessor, hash).and_then(|storage| ecs::element(storage, entity, stride)) {
            if !out.contains(&element) {
                out.push(element);
            }
        }
    }
    if out.is_empty() {
        return Err(RpcError::anchor("screen.containers").with_data(json!({ "message": "no screen context holds a container map" })));
    }
    Ok(out)
}

/// The local player's registry accessor and entity: the client registry `player.inventory` reads (live
/// verified).
fn local_player() -> Result<(usize, u32), RpcError> {
    inventory::context().ok_or_else(|| RpcError::anchor("inventory.context"))
}

/// `getContainerSize()` of a container whose table holds the two interface entries this module calls.
fn container_size(container: usize) -> Option<usize> {
    let table = pe::read::<usize>(container).filter(|table| pe::in_image_data(*table))?;
    pe::read::<usize>(table + CONTAINER_GET_ITEM).filter(|entry| pe::in_image_code(*entry))?;
    let entry = pe::read::<usize>(table + CONTAINER_SIZE).filter(|entry| pe::in_image_code(*entry))?;
    // SAFETY: the game's own `int getContainerSize()` of this container; it takes `this` only.
    let size = unsafe { transmute::<usize, extern "C" fn(usize) -> i32>(entry)(container) };
    (size > 0 && (size as usize) <= CONTAINER_LIMIT).then_some(size as usize)
}

/// Every container in the client's container map, in map order.
fn open_containers() -> Result<Vec<Open>, RpcError> {
    let hash = CONTAINERS_HASH.load(Ordering::Acquire) as u32;
    let stride = CONTAINERS_STRIDE.load(Ordering::Acquire);
    if hash == 0 || stride == 0 {
        return Err(RpcError::anchor("screen.containers"));
    }
    if ENUM_END.load(Ordering::Acquire) == 0 {
        return Err(RpcError::anchor("screen.container_names"));
    }
    let mut out: Vec<Open> = Vec::new();
    for element in container_maps(hash, stride)? {
    #[cfg(feature = "debug-rpc")]
    agent_core::log::fmt(format_args!(
        "screen.state: element 0x{element:x} map A head {:x?} size {:?}, map B head {:x?} size {:?}",
        pe::read::<usize>(element + MAP_HEADS[0]),
        pe::read::<usize>(element + MAP_HEADS[0] + 8),
        pe::read::<usize>(element + MAP_HEADS[1]),
        pe::read::<usize>(element + MAP_HEADS[1] + 8)
    ));
    for head_at in MAP_HEADS {
        let head = pe::read::<usize>(element + head_at).ok_or_else(|| RpcError::anchor("screen.containers"))?;
        let size = pe::read::<usize>(element + head_at + 8).ok_or_else(|| RpcError::anchor("screen.containers"))?;
        if head == 0 || size > 64 {
            return Err(RpcError::anchor("screen.containers").with_data(json!({ "message": "the container map does not have a map's shape" })));
        }
        let mut node = pe::read::<usize>(head).ok_or_else(|| RpcError::anchor("screen.containers"))?;
        let mut walked = 0usize;
        while node != head {
            walked += 1;
            if walked > size {
                return Err(RpcError::anchor("screen.containers").with_data(json!({ "message": "the container map's list is longer than its size" })));
            }
            let (Some(name), Some(dynamic), Some(has)) =
                (pe::read::<u8>(node + NODE_NAME), pe::read::<u32>(node + NODE_DYNAMIC), pe::read::<u8>(node + NODE_HAS_DYNAMIC))
            else {
                return Err(RpcError::anchor("screen.containers"));
            };
            #[cfg(feature = "debug-rpc")]
            agent_core::log::fmt(format_args!(
                "screen.state: element 0x{element:x} map +0x{head_at:x} node 0x{node:x} enum {name} ({:?}) dynamic {has}/{dynamic} entry {:x?}",
                name_of(name),
                pe::read::<usize>(node + NODE_ENTRY)
            ));
            let container = pe::read::<usize>(node + NODE_ENTRY)
                .filter(|entry| *entry != 0)
                .and_then(|entry| pe::read::<usize>(entry + ENTRY_CONTAINER))
                .filter(|container| *container != 0);
            if let Some(container) = container {
                if name_of(name).is_some() {
                    if let Some(size) = container_size(container) {
                        let dynamic = (has == 1).then_some(dynamic);
                        if !out.iter().any(|open| open.name == name && open.dynamic == dynamic) {
                            let slots = slots_named(container, size, name);
                            #[cfg(feature = "debug-rpc")]
                            agent_core::log::fmt(format_args!(
                                "screen.state: {:?} container 0x{container:x} of {size}: slots {slots:?}",
                                name_of(name)
                            ));
                            let size = slots.len();
                            out.push(Open { name, dynamic, container, slots, size });
                        }
                    }
                }
            }
            node = pe::read::<usize>(node).ok_or_else(|| RpcError::anchor("screen.containers"))?;
        }
        if walked != size {
            return Err(RpcError::anchor("screen.containers").with_data(json!({ "message": "the container map's list and size disagree" })));
        }
    }
    }
    Ok(out)
}

/// The slots of one container as the inventory tools report them. A bundle's `contents` come from its
/// dynamic container (`dynamic_container_<bundle_id>`) when the screen has it open: the client's copy of a
/// bundle stack carries only that id in its user data, not the items.
fn slots_of(open: &Open, all: &[Open]) -> Vec<Value> {
    (0..open.size)
        .map(|slot| {
            let Some(item) = open.item(slot) else {
                return Value::Null;
            };
            let mut entry = inventory::slot(item).unwrap_or(Value::Null);
            let inside = inventory::bundle_id(item).and_then(|id| all.iter().find(|other| other.dynamic == Some(id)));
            if let (Some(inside), Value::Object(fields)) = (inside, &mut entry) {
                if !fields.contains_key("contents") {
                    fields.insert(String::from("contents"), contents_of(inside));
                }
            }
            entry
        })
        .collect()
}

/// A bundle's dynamic container as a slot's `contents`: its stacks in order, trailing empty slots dropped.
fn contents_of(inside: &Open) -> Value {
    let mut items = slots_of(inside, &[]);
    while items.last().is_some_and(Value::is_null) {
        items.pop();
    }
    Value::Array(items)
}

/// A carried bundle's `contents` for `player.inventory`, read the way the screen tools read them: from the
/// bundle's dynamic container while an open screen has it. `None` when no screen shows it (on the HUD
/// the client holds no copy of a bundle's items).
pub(crate) fn bundle_contents(stack: usize) -> Option<Value> {
    let id = inventory::bundle_id(stack)?;
    let open = open_containers().ok()?;
    open.iter().find(|other| other.dynamic == Some(id)).map(contents_of)
}

/// An item's count (0 for an empty stack).
fn count_of(item: usize) -> u8 {
    let has_item = pe::read::<usize>(item + ITEM_IMPL).is_some_and(|value| value != 0);
    if !has_item {
        return 0;
    }
    pe::read::<u8>(item + ITEM_COUNT).filter(|count| *count <= 127).unwrap_or(0)
}

/// True when two stacks hold the same item (same `Item` and aux value).
fn same_item(a: usize, b: usize) -> bool {
    let kind = |item: usize| {
        let item_impl = pe::read::<usize>(item + ITEM_IMPL)?;
        Some((pe::read::<usize>(item_impl)?, pe::read::<u16>(item + ITEM_AUX)?))
    };
    matches!((kind(a), kind(b)), (Some(x), Some(y)) if x == y)
}

/// The local player's `Player*`, through `ActorOwnerComponent` (one pointer per entity).
fn player_object(accessor: usize, entity: u32) -> Option<usize> {
    let actors = ecs::storage(accessor, anchors::component_hash("ActorOwnerComponent"))?;
    let element = ecs::element(actors, entity, 8)?;
    pe::read::<usize>(element).filter(|actor| *actor != 0)
}

/// The player's client net manager, validated: a table in the image and the client flag set.
fn manager() -> Result<usize, RpcError> {
    let (accessor, entity) = local_player()?;
    let player = player_object(accessor, entity).ok_or_else(|| RpcError::anchor("inventory.actor"))?;
    let manager = pe::read::<usize>(player + MANAGER_OFFSET.load(Ordering::Acquire))
        .filter(|manager| *manager != 0)
        .ok_or_else(|| RpcError::anchor("screen.request").with_data(json!({ "message": "the player has no item stack net manager" })))?;
    let table_ok = pe::read::<usize>(manager).is_some_and(pe::in_image_data);
    if !table_ok || pe::read::<u8>(manager + MANAGER_CLIENT) != Some(1) {
        return Err(RpcError::anchor("screen.request").with_data(json!({ "message": "the player's net manager is not the client's" })));
    }
    Ok(manager)
}

/* ------------------------------------------------------------------------------------------------
 * Building one request
 * ---------------------------------------------------------------------------------------------- */

/// `size` bytes from the game's own allocator (the request owns and frees what it is given).
fn allocate(size: usize) -> Option<usize> {
    let allocator = pe::read::<usize>(ALLOCATOR.load(Ordering::Acquire)).filter(|allocator| *allocator != 0)?;
    let table = pe::read::<usize>(allocator).filter(|table| pe::in_image_data(*table))?;
    let entry = pe::read::<usize>(table + 8).filter(|entry| pe::in_image_code(*entry))?;
    // SAFETY: slot 1 of the allocator the game itself allocates every request and action through.
    let memory = unsafe { transmute::<usize, extern "C" fn(usize, usize) -> usize>(entry)(allocator, size) };
    if memory == 0 || !pe::writable(memory, size) {
        return None;
    }
    // SAFETY: `size` bytes the allocator just handed out.
    unsafe { core::ptr::write_bytes(memory as *mut u8, 0, size) };
    Some(memory)
}

/* ------------------------------------------------------------------------------------------------
 * screen.state / container.open
 * ---------------------------------------------------------------------------------------------- */

/// `screen.state` → `{screen, kind, containers, data}`: the open screen, its family, every container the
/// client's container map holds for it (the screen's own and the player's), keyed by the game's collection
/// name, and the screen's own state ([`screen_data`]).
pub(crate) fn h_screen_state(core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    expire(core);
    let screen = screen_now(core)?;
    let kind = kind_of(&screen.top);
    let mut out = Map::new();
    out.insert(String::from("kind"), Value::String(String::from(kind)));
    if live::in_world() {
        let containers = open_containers()?;
        let mut map = Map::new();
        for open in &containers {
            map.insert(open.key(), Value::Array(slots_of(open, &containers)));
        }
        out.insert(String::from("containers"), Value::Object(map));
        out.insert(String::from("data"), screen_data(kind));
    } else {
        out.insert(String::from("data"), Value::Null);
    }
    out.insert(String::from("screen"), Value::String(screen.top));
    Ok(Value::Object(out))
}

/// `container.open` → `{screen, block, position, slots, playerSlots}`: the open screen's own containers
/// (in map order), the player's 36 carried slots once, and the block the screen belongs to.
///
/// The screen's own slots leave out the player's containers and the dynamic ones: a shulker box or a
/// bundle carried in the inventory shows its contents as a container of its own. The player's slots are
/// the combined hotbar-and-inventory view when the screen has one (hotbar first), else the hotbar and
/// the inventory. The block is the one the crosshair picked to open the screen, read from the client's
/// own region; a screen of an entity (a horse, a villager, a chest boat) or the inventory has none.
pub(crate) fn h_container_open(core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    expire(core);
    world()?;
    let screen = screen_now(core)?;
    let kind = kind_of(&screen.top);
    if kind == "other" {
        return Err(RpcError::invalid_params(format!("no container screen is open ({} is)", screen.top)));
    }
    let containers = open_containers()?;
    let slots: Vec<Value> = containers
        .iter()
        .filter(|open| !is_player(open.name) && open.dynamic.is_none())
        .flat_map(|open| slots_of(open, &containers))
        .collect();
    let named = |name: &str| containers.iter().find(|open| open.dynamic.is_none() && named_any(open.name, &[name]));
    let player: Vec<Value> = match named("CombinedHotbarAndInventoryContainer") {
        Some(combined) => slots_of(combined, &containers),
        None => ["HotbarContainer", "InventoryContainer"].iter().filter_map(|name| named(name)).flat_map(|open| slots_of(open, &containers)).collect(),
    };
    let (block, position) = match kind {
        "inventory" | "horse" | "trade" => (Value::Null, Value::Null),
        _ => input::crosshair_block()
            .and_then(|at| inventory::client_block(at).map(|(_, name)| (name, json!([at[0], at[1], at[2]]))))
            .filter(|(name, _)| !name.is_null())
            .unwrap_or((Value::Null, Value::Null)),
    };
    Ok(json!({ "screen": screen.top, "block": block, "position": position, "slots": slots, "playerSlots": player }))
}

/* ------------------------------------------------------------------------------------------------
 * screen.move
 * ---------------------------------------------------------------------------------------------- */

/// One container reference from the wire: a name as `screen.state` reports it (the game's collection
/// name, `_<id>` appended for a dynamic container) or an enum-style alias of it (`HotbarContainer`), and a
/// slot, counted within that name's own slots.
fn slot_ref(params: &Value, key: &str) -> Result<(String, usize), RpcError> {
    let value = params
        .get(key)
        .ok_or_else(|| RpcError::invalid_params(format!("{key} is required: {{container, slot}}")))?;
    let name = value
        .get("container")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| RpcError::invalid_params(format!("{key}.container must name a container screen.state reports")))?;
    let slot = value
        .get("slot")
        .and_then(Value::as_u64)
        .ok_or_else(|| RpcError::invalid_params(format!("{key}.slot must be a whole slot index from 0")))?;
    if slot > u8::MAX as u64 {
        return Err(RpcError::invalid_params(format!("{key}.slot must be a slot index below 256")));
    }
    Ok((String::from(name), slot as usize))
}

/// The open container `name` names, or the list of what is open.
fn container<'a>(open: &'a [Open], name: &str, key: &str) -> Result<&'a Open, RpcError> {
    open_named(open, name).ok_or_else(|| {
        let names: Vec<Value> = open.iter().map(|open| Value::String(open.key())).collect();
        RpcError::invalid_params(format!("{key}.container '{name}' is not open on this screen")).with_data(json!({ "open": names }))
    })
}

/// `screen.move {from, to, count?}` → `{moved}` once the server answered.
///
/// One request: `Place` into an empty slot or onto the same item (`Take` when the source is the
/// screen's own container), `Swap` when the destination holds another item and no count is given. The
/// items' net ids are the client's own; `moved` is the count the server accepted (0 with a `reason`
/// when it refused, or did not answer in time).
pub(crate) fn h_screen_move(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    expire(core);
    world()?;
    let from = slot_ref(params, "from")?;
    let to = slot_ref(params, "to")?;
    let count = match params.get("count") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let count = value
                .as_u64()
                .filter(|count| (1..=u8::MAX as u64).contains(count))
                .ok_or_else(|| RpcError::invalid_params("count must be a whole number of items from 1"))?;
            Some(count as u8)
        }
    };
    if !requests_ready() {
        return Err(RpcError::anchor("screen.request"));
    }
    let open = open_containers()?;
    let source = container(&open, &from.0, "from")?;
    let target = container(&open, &to.0, "to")?;
    let source_item = source
        .item(from.1)
        .ok_or_else(|| RpcError::invalid_params(format!("from.slot must be below {}", source.size)))?;
    let target_item = target
        .item(to.1)
        .ok_or_else(|| RpcError::invalid_params(format!("to.slot must be below {}", target.size)))?;
    if source.container == target.container && source.at(from.1) == target.at(to.1) {
        return Err(RpcError::invalid_params("from and to are the same slot"));
    }
    let available = count_of(source_item);
    if available == 0 {
        // A screen can fill its own slots from the inventory as it opens (a trade screen places the
        // selected offer's cost): name what the screen's own slots hold, where such a stack went.
        let held: Vec<Value> = open
            .iter()
            .filter(|open| !is_player(open.name) && open.dynamic.is_none())
            .flat_map(|open| {
                (0..open.size).filter_map(move |slot| {
                    open.item(slot).and_then(inventory::slot).filter(|item| !item.is_null()).map(|item| json!({ "container": open.key(), "slot": slot, "item": item }))
                })
            })
            .collect();
        if held.is_empty() {
            return Err(RpcError::invalid_params("the from slot is empty"));
        }
        let names: Vec<String> = held
            .iter()
            .map(|entry| format!("{} {} {} x{}", entry["container"].as_str().unwrap_or("?"), entry["slot"], entry["item"]["item"].as_str().unwrap_or("?"), entry["item"]["count"]))
            .collect();
        let message = format!("the from slot is empty; the screen's own slots hold {}", names.join(", "));
        return Err(RpcError::invalid_params(message.clone()).with_data(json!({ "message": message, "screenSlots": held })));
    }
    let occupied = count_of(target_item) != 0;
    // A stack dropped on a bundle, or a bundle on a stack, goes into the bundle (what fits), the way the
    // inventory screen's own bundle code does it; a bundle dropped on an empty slot moves as any stack.
    let bundle = if occupied && is_bundle(target_item) {
        Some(((source, from.1), target_item))
    } else if occupied && is_bundle(source_item) {
        Some(((target, to.1), source_item))
    } else {
        None
    };
    if let Some((items, bundle)) = bundle {
        let held = items.0.item(items.1).map(count_of).unwrap_or(0);
        if count.is_some_and(|count| count > held) {
            return Err(RpcError::invalid_params(format!("the stack going into the bundle holds {held}, not {}", count.unwrap_or(0))));
        }
        let place = if core::ptr::eq(items.0, source) { (target, to.1) } else { (source, from.1) };
        let watch = json!({
            "source": { "container": items.0.key(), "slot": items.1, "before": held },
            "bundle": { "container": place.0.key(), "slot": place.1, "before": bundle_total(&open, bundle) },
        });
        let (id, moved) = bundle_insert(items, bundle, count)?;
        let before = screen_now(core).map(|screen| screen.top).unwrap_or_default();
        return park(core, before, Phase::Request { id, moved: moved as u32, take: false, cursor: false }, Some(watch));
    }
    let (kind, amount) = if occupied && !same_item(source_item, target_item) {
        if count.is_some() {
            return Err(RpcError::invalid_params("the to slot holds another item: drop count to swap the two stacks"));
        }
        (SWAP, available)
    } else {
        let amount = count.unwrap_or(available);
        if amount > available {
            return Err(RpcError::invalid_params(format!("the from slot holds {available}, not {amount}")));
        }
        let kind = if is_player(source.name) { PLACE } else { TAKE };
        (kind, amount)
    };
    let id = move_through(kind, (source, from.1), (target, to.1), amount)?;
    let before = screen_now(core).map(|screen| screen.top).unwrap_or_default();
    park(core, before, Phase::Request { id, moved: amount as u32, take: false, cursor: false }, None)
}

/* ------------------------------------------------------------------------------------------------
 * The open screen's own controller and the handlers it runs
 * ---------------------------------------------------------------------------------------------- */

/// The screen handlers this module runs, by index into [`HANDLERS`].
const H_ENCHANT: usize = 0;
const H_BEACON: usize = 1;
const H_STONECUTTER: usize = 2;
const H_SMITHING: usize = 3;
const H_ANVIL: usize = 4;
const H_GRINDSTONE: usize = 5;
const H_CARTOGRAPHY: usize = 6;
const H_LOOM: usize = 7;
const H_TRADE: usize = 8;
const H_TRADE2: usize = 9;
const H_SCOPE_END: usize = 10;
const H_ANVIL_UPDATE: usize = 11;
const H_STONECUTTER_REFRESH: usize = 12;
const H_CRAFT: usize = 13;
const H_CRAFT_SLOT: usize = 14;
const HANDLER_COUNT: usize = 15;

/// Each handler's entry, 0 while it is not resolved.
static HANDLERS: [AtomicUsize; HANDLER_COUNT] = [const { AtomicUsize::new(0) }; HANDLER_COUNT];
/// The anchors `engine.status` reports them under.
const HANDLER_ANCHORS: [&str; HANDLER_COUNT] = [
    "screen.enchanting",
    "screen.beacon",
    "screen.stonecutter",
    "screen.smithing",
    "screen.anvil",
    "screen.grindstone",
    "screen.cartography",
    "screen.loom",
    "screen.trade",
    "screen.trade2",
    "screen.scope",
    "screen.anvil_update",
    "screen.stonecutter_refresh",
    "screen.craft",
    "screen.craft_slot",
];

/// Offsets read out of the handlers' own instructions (0 while not resolved).
/// `controller + MODEL_AT` = the controller's `weak_ptr<ContainerManagerModel>` object pointer.
static MODEL_AT: AtomicUsize = AtomicUsize::new(0);
/// `model + BEACON_SELECTION` = the two effect ids the beacon pays for (`u32` primary, `u32` secondary).
static BEACON_SELECTION: AtomicUsize = AtomicUsize::new(0);
/// `model + STONECUTTER_SELECTION` = the selected recipe's index in the stonecutter's list (`i32`).
static STONECUTTER_SELECTION: AtomicUsize = AtomicUsize::new(0);
/// `model + TRADE_SELECTION` = the selected offer's index (`i32`, the tier-1 trade screen).
static TRADE_SELECTION: AtomicUsize = AtomicUsize::new(0);
/// `controller + LOOM_PATTERN` = the selected banner pattern's name id (`std::string`).
static LOOM_PATTERN: AtomicUsize = AtomicUsize::new(0);
/// The anvil controller's table slot (byte offset) whose body is `lea rax,[rcx+TEXT]; ret`: the rename text.
static ANVIL_TEXT_SLOT: AtomicUsize = AtomicUsize::new(0);
/// `screen + ENCHANT_FIELD` / `screen + BEACON_FIELD`: the enchanting / beacon screen controller's own
/// pointer to its manager controller, as the screen's single call into `enchant` / the payment loads it.
static ENCHANT_FIELD: AtomicUsize = AtomicUsize::new(0);
static BEACON_FIELD: AtomicUsize = AtomicUsize::new(0);
/// `model + ENCHANT_OPTIONS` = the enchanting table's `std::vector<ItemEnchantOption>` (`0x80`-byte records).
static ENCHANT_OPTIONS: AtomicUsize = AtomicUsize::new(0);
/// One `ItemEnchantOption` record (`shr rax,7` in the handler's bounds check).
const ENCHANT_OPTION_SIZE: usize = 0x80;
/// In the enchant handler: `mov r12,[r15+BEGIN]; mov rax,[r15+END]; sub rax,r12; shr rax,7`.
const OPTIONS_PATTERN: &[Option<u8>] = &[
    Some(0x4D), Some(0x8B), Some(0xA7), None, None, None, None, Some(0x49), Some(0x8B), Some(0x87), None, None, None, None,
    Some(0x4C), Some(0x29), Some(0xE0), Some(0x48), Some(0xC1), Some(0xE8), Some(0x07),
];

/// How each handler is found: wildcard bytes unique in `.text` (from the action the handler builds or a
/// field it reads), and where in them the piece to validate or read sits.
struct HandlerRecipe {
    index: usize,
    pattern: &'static str,
    /// Offset of a `lea r,[rip+disp32]` displacement whose target must be an action's table, if any.
    table_at: Option<usize>,
    /// True when the pattern is the function's own first bytes (otherwise it sits inside the body).
    entry: bool,
}

/// The recipes. Each `table_at` points at the `disp32` of the `lea` that loads the action's table, right
/// after the `mov byte [R+8],TYPE` that stamps the action's type (part of the pattern).
const HANDLER_RECIPES: [HandlerRecipe; 12] = [
    // The crafting screen's own result take: CraftRecipe{n, matchedRecipe.netId (+0x44)}.
    HandlerRecipe {
        index: H_CRAFT,
        pattern: "C6 43 08 0C 44 88 73 10 48 8D 05 ?? ?? ?? ?? 48 89 03 8B 46 44 89 43 18 48 8B B5 98 03 00 00 48 89 5D B0",
        table_at: Some(11),
        entry: false,
    },
    // EnchantingContainerManagerController::enchant(option): CraftRecipe{1, option.netId}.
    HandlerRecipe {
        index: H_ENCHANT,
        pattern: "C6 43 08 0C C6 43 10 01 48 8D 05 ?? ?? ?? ?? 48 89 03 41 8B 44 24 78 89 43 18 48 89 9D 00 01 00 00",
        table_at: Some(11),
        entry: false,
    },
    // The beacon's payment: BeaconPayment{model selection} (`movsd xmm6,[rdi+SELECTION]` right before).
    HandlerRecipe {
        index: H_BEACON,
        pattern: "F2 0F 10 B7 ?? ?? ?? ?? 48 8B 0D ?? ?? ?? ?? 48 8B 01 48 8B 40 08 BA 18 00 00 00 FF 15 ?? ?? ?? ?? 90 48 89 C6 48 85 C0 0F 84 ?? ?? ?? ?? C6 46 08 0A 48 8D 05 ?? ?? ?? ??",
        table_at: Some(53),
        entry: false,
    },
    // The result-taking handler of each screen (the controller's own `take from the result collection`).
    HandlerRecipe {
        index: H_STONECUTTER,
        pattern: "41 C6 44 24 08 0C 45 88 74 24 10 48 8D 05 ?? ?? ?? ?? 49 89 04 24 8B 87 80 01 00 00 41 89 44 24 18",
        table_at: Some(14),
        entry: false,
    },
    HandlerRecipe {
        index: H_SMITHING,
        pattern: "41 C6 47 08 0C 41 C6 47 10 01 48 8D 05 ?? ?? ?? ?? 49 89 07 8B 83 70 01 00 00 41 89 47 18 4C 8B B5 70 04 00 00",
        table_at: Some(13),
        entry: false,
    },
    HandlerRecipe {
        index: H_ANVIL,
        pattern: "41 C6 46 08 0F 41 C6 46 10 01 48 8D 05 ?? ?? ?? ?? 49 89 06 8B 87 E8 01 00 00 41 89 46 18 41 C7 46 1C 00 00 00 00",
        table_at: Some(13),
        entry: false,
    },
    HandlerRecipe {
        index: H_GRINDSTONE,
        pattern: "41 C6 47 08 10 41 C6 47 10 01 48 8D 05 ?? ?? ?? ?? 49 89 07 41 C6 47 28 FF 0F B6 87 80 01 00 00",
        table_at: Some(13),
        entry: false,
    },
    HandlerRecipe {
        index: H_CARTOGRAPHY,
        pattern: "41 C6 47 08 0F 41 C6 47 10 01 48 8D 05 ?? ?? ?? ?? 49 89 07 8B 87 28 02 00 00 41 89 47 18 45 89 67 1C",
        table_at: Some(13),
        entry: false,
    },
    // The loom's: `lea rdx,[rdi+PATTERN]` handed to the CraftLoom action's constructor.
    HandlerRecipe {
        index: H_LOOM,
        pattern: "49 89 C5 48 85 C0 0F 84 ?? ?? ?? ?? 48 8D 97 ?? ?? ?? ?? 4C 89 E9 41 89 D8 4C 89 AD ?? ?? ?? ?? E8 ?? ?? ?? ??",
        table_at: None,
        entry: false,
    },
    HandlerRecipe {
        index: H_TRADE,
        pattern: "41 C6 47 08 0C 45 88 77 10 48 8D 05 ?? ?? ?? ?? 49 89 07 41 8B 85 A8 01 00 00 41 89 47 18 4C 89 BD E0 02 00 00",
        table_at: Some(12),
        entry: false,
    },
    HandlerRecipe {
        index: H_TRADE2,
        pattern: "41 C6 47 08 0C 45 88 77 10 48 8D 05 ?? ?? ?? ?? 49 89 07 8B 83 A8 01 00 00 41 89 47 18 48 8B 9D E0 05 00 00",
        table_at: Some(12),
        entry: false,
    },
    // The anvil's preview update (its table's "contents changed" slot): recomputes result, cost and name.
    HandlerRecipe {
        index: H_ANVIL_UPDATE,
        pattern: "55 41 57 41 56 41 55 41 54 56 57 53 48 81 EC F8 04 00 00 48 8D AC 24 80 00 00 00 48 C7 85 70 04 00 00 FE FF FF FF 48 89 CE C6 81 F0 01 00 00 00",
        table_at: None,
        entry: true,
    },
];

/// The result-transfer scope's destructor: applies the taken item to its destination slot and submits the
/// request when the scope owns it (`call SUBMIT` in its body is checked).
const SCOPE_END_PATTERN: &str = "55 41 56 56 57 53 48 83 EC 40 48 8D 6C 24 40 48 C7 45 F8 FE FF FF FF 48 89 CE 48 8B 41 08 48 85 C0";
/// In the stonecutter's preview refresh: `cmp dword [rdi+SELECTION],0; js` on the model.
const STONECUTTER_SELECTION_PATTERN: &str = "48 85 FF 0F 94 C0 48 85 C9 0F 94 C2 08 C2 75 57 83 BF ?? ?? ?? ?? 00 78";
/// In the stonecutter's preview refresh: `mov rcx,rdi (model); mov r8,rbx (input stack); call LIST;
/// nop; movsxd rbx,[rdi+SELECTION]; …; imul eax,eax,0xF0F0F0F1` (entries of 0x88 bytes).
const STONECUTTER_LIST_PATTERN: &str =
    "48 89 F9 49 89 D8 E8 ?? ?? ?? ?? 90 48 63 9F ?? ?? ?? ?? 48 8B 7D ?? 48 8B 45 ?? 48 29 F8 48 C1 E8 03 69 C0 F1 F0 F0 F0";
/// `void list(model, std::vector<{ItemInstance 0x80, u32 netId}>* out, ItemStackBase const& input)`: the
/// recipes the stonecutter offers for an input, in the order the selection indexes.
static STONECUTTER_LIST: AtomicUsize = AtomicUsize::new(0);
const STONECUTTER_ENTRY: usize = 0x88;
/// In the tier-1 trade handler, the trader lookup: `mov rcx,[rbx+0x30] (player); call LEVEL; nop;
/// mov rcx,[rax]; mov rdx,[rcx+LEVEL_SLOT]; …; call; nop; mov rdx,[rbx+TRADER]; mov rcx,[rax];
/// mov r9,[rcx+FETCH]; mov rcx,rax; xor r8d,r8d; mov rax,r9; call` — the trader by its unique id.
const TRADER_PATTERN: &str = "48 8B 4B 30 E8 ?? ?? ?? ?? 90 48 8B 08 48 8B 91 ?? ?? ?? ?? 48 89 C1 48 89 D0 FF 15 ?? ?? ?? ?? 90 48 8B 93 ?? ?? ?? ?? 48 8B 08 4C 8B 89 ?? ?? ?? ?? 48 89 C1 45 31 C0 4C 89 C8 FF 15";
/// Then `mov rcx,rax; call OFFERS; nop; test rax,rax; jz; movsxd rcx,[rbx+SELECTION]; test rcx,rcx`.
const OFFERS_PATTERN: &str = "48 89 C1 E8 ?? ?? ?? ?? 90 48 85 C0 0F 84 ?? ?? ?? ?? 48 63 8B ?? ?? ?? ?? 48 85 C9";
/// The lookup's pieces: `LEVEL(player)`, its table slot (`this` only), the model's trader unique id field,
/// the fetch slot `(this, u64 id, bool removed)`, and `OFFERS(actor)` → the merchant's recipe list
/// (`+0x08` a vector of 0x1b0-byte offers).
static TRADE_LEVEL: AtomicUsize = AtomicUsize::new(0);
static TRADE_LEVEL_SLOT: AtomicUsize = AtomicUsize::new(0);
static TRADE_TRADER: AtomicUsize = AtomicUsize::new(0);
static TRADE_FETCH_SLOT: AtomicUsize = AtomicUsize::new(0);
static TRADE_OFFERS: AtomicUsize = AtomicUsize::new(0);
/// An offer: `+0x00` buy A, `+0x80` buy B, `+0x100` sell (`ItemInstance`s), `+0x184` uses, `+0x188` max
/// uses (locked when `0 <= max <= uses`, as the handler tests), `+0x1a8` its net id (the handler sends it).
const OFFER_SIZE: usize = 0x1b0;
const OFFER_BUY_B: usize = 0x80;
const OFFER_SELL: usize = 0x100;
const OFFER_USES: usize = 0x184;
const OFFER_MAX_USES: usize = 0x188;
const OFFER_NET_ID: usize = 0x1a8;

/// The tier-2 trade screen's offer select `(controller, u32 index)`, what clicking an offer in its list runs:
/// bounds-checked against the trader's offers (`imul eax,eax,0x684BDA13` = / 0x1b0), it stores the index on
/// the controller and on the model (`mov [rsi+CTRL],edi; mov [r15+MODEL],edi`, the model field the tier-1
/// handler reads as its selection) and refreshes the preview. 0 while unresolved.
static TRADE2_SELECT: AtomicUsize = AtomicUsize::new(0);
const TRADE2_SELECT_PATTERN: &str = "69 C0 13 DA 4B 68 39 C7 0F 8D ?? ?? ?? ?? 89 BE ?? ?? ?? ?? 41 89 BF ?? ?? ?? ?? C6 85";

fn resolve_trade2(image: &Image) {
    let sites = inventory::all_sites(image, &[parse_pattern(TRADE2_SELECT_PATTERN)]).remove(0);
    let [site] = sites[..] else {
        return;
    };
    let selection = TRADE_SELECTION.load(Ordering::Acquire);
    if selection == 0 || disp_at(site + 23) != Some(selection) {
        return;
    }
    if let Some(start) = image.function_start(site) {
        TRADE2_SELECT.store(start, Ordering::Release);
    }
}

/// The trade screen's offers: the trader the model names (its unique id), looked up and read the way the
/// trade handler does, and the selected offer (the model's selection, which both tiers keep). `offer` in
/// `screen.act trade` is an `index` of `offers`.
fn trade_data() -> Result<Value, RpcError> {
    let (level, level_slot, trader_at, fetch_slot, offers_of) = (
        TRADE_LEVEL.load(Ordering::Acquire),
        TRADE_LEVEL_SLOT.load(Ordering::Acquire),
        TRADE_TRADER.load(Ordering::Acquire),
        TRADE_FETCH_SLOT.load(Ordering::Acquire),
        TRADE_OFFERS.load(Ordering::Acquire),
    );
    if [level, level_slot, trader_at, fetch_slot, offers_of].contains(&0) {
        return Err(RpcError::anchor("screen.trade_offers"));
    }
    let tier2 = handler(H_TRADE2).ok().and_then(|entry| screen_manager(entry, "screen.trade2").ok());
    let controller = match tier2 {
        Some(controller) => controller,
        None => screen_manager(handler(H_TRADE)?, "screen.trade")?,
    };
    let model = model_of(controller).ok_or_else(|| RpcError::anchor("screen.trade"))?;
    let anchor = || RpcError::anchor("screen.trade_offers");
    let player = pe::read::<usize>(model + MODEL_PLAYER).filter(|player| pe::read::<usize>(*player).is_some_and(pe::in_image_data)).ok_or_else(anchor)?;
    let trader = pe::read::<u64>(model + trader_at).ok_or_else(anchor)?;
    // SAFETY: the calls the trade handler makes, in its order, each on an object whose table is checked
    // first: the player's level, its table slot, then the fetch by unique id (not removed ones).
    let level = unsafe { transmute::<usize, extern "C" fn(usize) -> usize>(level)(player) };
    let slot = |object: usize, at: usize| {
        pe::read::<usize>(object).filter(|table| pe::in_image_data(*table)).and_then(|table| pe::read::<usize>(table + at)).filter(|entry| pe::in_image_code(*entry))
    };
    let world = slot(level, level_slot).map(|entry| unsafe { transmute::<usize, extern "C" fn(usize) -> usize>(entry)(level) }).ok_or_else(anchor)?;
    let fetch = slot(world, fetch_slot).ok_or_else(anchor)?;
    // SAFETY: see above.
    let actor = unsafe { transmute::<usize, extern "C" fn(usize, u64, u8) -> usize>(fetch)(world, trader, 0) };
    let selected = pe::read::<i32>(model + TRADE_SELECTION.load(Ordering::Acquire));
    if actor == 0 {
        return Ok(json!({ "offers": [], "selected": selected, "trader": null }));
    }
    // SAFETY: the game's own offers getter on the actor it just fetched, as the handler calls it.
    let list = unsafe { transmute::<usize, extern "C" fn(usize) -> usize>(offers_of)(actor) };
    let mut offers = Vec::new();
    if list != 0 {
        let (begin, end) = (pe::read::<usize>(list + 8).unwrap_or(0), pe::read::<usize>(list + 0x10).unwrap_or(0));
        if begin != 0 && end >= begin && (end - begin) % OFFER_SIZE == 0 && (end - begin) / OFFER_SIZE <= 64 {
            for (index, offer) in (begin..end).step_by(OFFER_SIZE).enumerate() {
                let (uses, max) = (pe::read::<i32>(offer + OFFER_USES), pe::read::<i32>(offer + OFFER_MAX_USES));
                offers.push(json!({
                    "index": index,
                    "buyA": inventory::slot(offer),
                    "buyB": inventory::slot(offer + OFFER_BUY_B),
                    "sell": inventory::slot(offer + OFFER_SELL),
                    "uses": uses,
                    "maxUses": max,
                    "locked": matches!((uses, max), (Some(uses), Some(max)) if max >= 0 && max <= uses),
                    "netId": pe::read::<u32>(offer + OFFER_NET_ID),
                }));
            }
        }
    }
    // The trader's unique id in the form `interact.entity` takes: signed decimal text (an int64 does not
    // survive a JSON number).
    Ok(json!({ "offers": offers, "selected": selected, "trader": format!("{}", trader as i64) }))
}
/// `model + 0x30`: the player the screen's model belongs to (the trade handler's own lookup reads it).
const MODEL_PLAYER: usize = 0x30;
/// In a base slot every container manager controller shares: `mov rax,0x100000000; mov [rbp+..],rax;
/// mov byte [rbp+..],0; lea rax,[rbp+..]; mov [rsp+0x20],rax; mov byte [rsp+0x30],1; mov byte [rsp+0x28],0;
/// mov rcx,rsi; mov edx,1; mov r8,rdi; mov r9,[rbp+..]; call TRANSFER` (the call at [`MOVE_CALL_AT`]).
const MOVE_PATTERN: &str =
    "48 B8 00 00 00 00 01 00 00 00 48 89 45 ?? C6 45 ?? 00 48 8D 45 ?? 48 89 44 24 20 C6 44 24 30 01 C6 44 24 28 00 48 89 F1 BA 01 00 00 00 49 89 F8 4C 8B 4D ?? E8";
const MOVE_CALL_AT: usize = 0x34;
/// The controller's transfer `bool (controller, u32 kind (Take 0 / Place 1 / Swap 2), SlotData const& to,
/// SlotData const& from, Amount const*, bool, bool)`: it applies the move to the client's own containers (the
/// prediction a mouse drag makes) and adds the matching transfer to the request. `MOVE_SLOT` is the base
/// slot that calls it, which identifies a container manager controller.
static MOVE_TRANSFER: AtomicUsize = AtomicUsize::new(0);
static MOVE_SLOT: AtomicUsize = AtomicUsize::new(0);
/// In the tier-1 trade handler: `movsxd rcx,[rbx+SELECTION]` on the model.
const TRADE_SELECTION_PATTERN: &str = "48 85 C0 0F 84 ?? ?? ?? ?? 48 63 8B ?? ?? ?? ?? 48 85 C9 0F 88";
/// In the anvil handler: `mov rax,[rdi]; mov rax,[rax+SLOT]; mov rcx,rdi; call` — the rename text getter.
const ANVIL_TEXT_PATTERN: &str =
    "48 8B 07 48 8B 40 ?? 48 89 F9 FF 15 ?? ?? ?? ?? 90 49 89 C6 48 8B 45 38 48 8B 08 48 8B 01 48 8B 80 ?? ?? ?? ?? 48 8D 95";
/// In the enchant handler: `movups xmm0,[rsi+MODEL]; mov r15,[rsi+MODEL]` — the controller's model.
const MODEL_PATTERN: &[Option<u8>] = &[
    Some(0x0F), Some(0x10), Some(0x86), None, None, None, None, Some(0x4C), Some(0x8B), Some(0xBE), None, None, None, None,
];

/// In the loom's result builder (which its take handler calls): `mov eax,[rdi+SELECTED]; test eax,eax; js;
/// mov rcx,[rip+END]; sub rcx,[rip+BEGIN]; shr rcx,6; imul ecx,ecx,0xaaaaaaab; cmp eax,ecx` — the selected
/// pattern's index into the game's banner pattern list, bounds-checked against it (records of 3 << 6 bytes).
const LOOM_INDEX_PATTERN: &str =
    "8B 87 ?? ?? ?? ?? 85 C0 0F 88 ?? ?? ?? ?? 48 8B 0D ?? ?? ?? ?? 48 2B 0D ?? ?? ?? ?? 48 C1 E9 06 69 C9 AB AA AA AA 39 C8";
/// A banner pattern record's size: the `shr 6` and the multiply by the inverse of 3 in [`LOOM_INDEX_PATTERN`].
const LOOM_RECORD: usize = 3 << 6;
/// Further in the builder: `add rdi,NAME; lea rcx,[rbp+..]; mov rdx,rdi; call` — the selected record's
/// pattern id (`std::string`, `bo`, `bri`, ...), copied into the controller's pattern name.
const LOOM_NAME_PATTERN: &str = "48 81 C7 ?? ?? ?? ?? 48 8D 8D ?? ?? ?? ?? 48 89 FA E8";
/// `controller + LOOM_SELECTED` = the selected pattern's index (`i32`); the builder clears the pattern name
/// and rebuilds it (and the result) from this index, so the index is what a pattern button sets.
static LOOM_SELECTED: AtomicUsize = AtomicUsize::new(0);
/// The address of the banner pattern list's `begin` pointer (its `end` follows).
static LOOM_LIST: AtomicUsize = AtomicUsize::new(0);
/// `record + LOOM_NAME` = the record's pattern id.
static LOOM_NAME: AtomicUsize = AtomicUsize::new(0);
/// The loom's own pattern button `void (controller, u32 button)`: `test edx,edx; js; mov rax,[rcx+OFFERED];
/// mov r8,[rcx+OFFERED+8]; sub r8,rax; shr r8,2; cmp edx,r8d; jge; mov edx,edx; mov eax,[rax+rdx*4];
/// cmp [rcx+SELECTED],eax; je; mov [rcx+SELECTED],eax` — it selects the button's pattern (an index into
/// the list the screen offers now) and rebuilds the result preview through the builder.
const LOOM_SELECT_PATTERN: &str =
    "85 D2 0F 88 ?? ?? ?? ?? 48 8B 81 ?? ?? ?? ?? 4C 8B 81 ?? ?? ?? ?? 49 29 C0 49 C1 E8 02 44 39 C2 7D ?? 89 D2 8B 04 90 39 81 ?? ?? ?? ?? 74 ?? 89 81";
static LOOM_SELECT: AtomicUsize = AtomicUsize::new(0);
/// `controller + LOOM_OFFERED` = the patterns the screen offers now (`std::vector<i32>` of list indices).
static LOOM_OFFERED: AtomicUsize = AtomicUsize::new(0);

/// `"41 C6 ?? 08"` → wildcard bytes.
fn parse_pattern(text: &str) -> Vec<Option<u8>> {
    text.split_ascii_whitespace().map(|token| if token == "??" { None } else { u8::from_str_radix(token, 16).ok() }).collect()
}

/// The one place each pattern occurs in `.text` (`None` when absent or not unique), in one pass: every
/// pattern starts with two fixed bytes, and a 64 Ki-entry table of those pairs keeps the pass to one
/// lookup per byte.
fn unique_sites(image: &Image, patterns: &[Vec<Option<u8>>]) -> Vec<Option<usize>> {
    let mut found: Vec<(Option<usize>, bool)> = patterns.iter().map(|_| (None, false)).collect();
    let Some(code) = pe::code(image) else {
        return found.into_iter().map(|(site, _)| site).collect();
    };
    let mut prefixes = alloc::vec![false; 0x1_0000];
    for pattern in patterns {
        if let (Some(Some(a)), Some(Some(b))) = (pattern.first(), pattern.get(1)) {
            prefixes[*a as usize | (*b as usize) << 8] = true;
        }
    }
    let bytes = code.bytes;
    for at in 0..bytes.len().saturating_sub(1) {
        if !prefixes[bytes[at] as usize | (bytes[at + 1] as usize) << 8] {
            continue;
        }
        for (index, pattern) in patterns.iter().enumerate() {
            if at + pattern.len() > bytes.len() {
                continue;
            }
            if bytes[at..at + pattern.len()].iter().zip(pattern).all(|(byte, want)| want.is_none_or(|want| want == *byte)) {
                let slot = &mut found[index];
                if slot.0.is_some() {
                    slot.1 = true;
                }
                slot.0 = Some(code.va + at);
            }
        }
    }
    found.into_iter().map(|(site, ambiguous)| if ambiguous { None } else { site }).collect()
}

/// Every direct `call`/`jmp rel32` (`E8`/`E9`) to each target, in one pass.
fn direct_sites(image: &Image, targets: &[usize]) -> Vec<Vec<usize>> {
    let mut out: Vec<Vec<usize>> = targets.iter().map(|_| Vec::new()).collect();
    let Some(code) = pe::code(image) else {
        return out;
    };
    let bytes = code.bytes;
    for at in 0..bytes.len().saturating_sub(4) {
        if !matches!(bytes[at], 0xE8 | 0xE9) {
            continue;
        }
        let Some(target) = rip_target(code.va, bytes, at + 1, at + 5) else {
            continue;
        };
        if let Some(index) = targets.iter().position(|known| *known != 0 && *known == target) {
            out[index].push(code.va + at);
        }
    }
    out
}

/// The screen-controller field a single call site loads its argument from: the closest
/// `mov r64,[r64+disp32]` within `0x20` bytes before the site (`mov rcx,[rsi+0x12d0]; …; jmp enchant`).
fn loaded_field(site: usize) -> Option<usize> {
    let window = pe::bytes(site - 0x20, 0x20)?;
    (0..window.len().saturating_sub(6)).rev().find_map(|at| {
        let rex = window[at];
        let modrm = window[at + 2];
        let plain = matches!(rex, 0x48 | 0x49 | 0x4C | 0x4D) && window[at + 1] == 0x8B && modrm >> 6 == 2 && modrm & 7 != 4;
        if !plain || at + 7 > window.len() {
            return None;
        }
        let disp = u32::from_le_bytes(window[at + 3..at + 7].try_into().ok()?) as usize;
        (0x100..0x4000).contains(&disp).then_some(disp)
    })
}

/// True when the function holding `function` calls or jumps to `target` directly (`E8`/`E9 rel32`).
fn calls(image: &Image, function: usize, target: usize) -> bool {
    let Some((start, body)) = body_of(image, function, 0x10000) else {
        return false;
    };
    (0..body.len().saturating_sub(4)).any(|at| {
        matches!(body[at], 0xE8 | 0xE9) && rip_target(start, body, at + 1, at + 5) == Some(target)
    })
}

/// A `disp32` read out of the code at `address`.
fn disp_at(address: usize) -> Option<usize> {
    pe::read::<u32>(address).map(|value| value as usize)
}

/// The furnace screen's two progress getters `int (controller, int scale)`: each reads the furnace's
/// block actor in the client's own region at the model's block position (checking its type against the
/// model's), and answers `scale ×` the burn left (`BurnTime / BurnDuration`) or the cook done (`CookTime /
/// the smelt time`). Found as the two sites of [`FURNACE_PATTERN`] (region slot, model position, chunk slot);
/// the burn getter divides by a register (`idiv ecx`), the cook getter by a field (`idiv dword [rcx+..]`).
const FURNACE_PATTERN: &str = "48 8B 07 48 8B 40 ?? 48 89 F9 FF 15 ?? ?? ?? ?? 90 48 89 C7 49 8D 96 ?? ?? ?? ?? 48 8B 00 48 8B 80 ?? ?? ?? ??";
static FURNACE_BURN: AtomicUsize = AtomicUsize::new(0);
static FURNACE_COOK: AtomicUsize = AtomicUsize::new(0);
/// The getters' scale: the answer is in thousandths.
const PROGRESS_SCALE: i32 = 1000;

/// The brewing stand model's own getters `int (model, int scale)`, read from the block actor in the client's
/// region at the model's block position after checking it is a brewing stand (`isType(8)`): the brew done
/// (`(1 - BrewTime / 400) × scale`, BrewTime counting down from 400) and the fuel left (`FuelAmount × scale /
/// FuelTotal`). Each is the one function holding its body; the model's own sync (which copies the block
/// actor's three counters into the model) is the virtual a brewing model's table must hold before either
/// getter is called on it.
const BREW_PROGRESS_PATTERN: &str = "8B 83 90 02 00 00 85 C0 74 ?? F3 0F 2A C6 F3 0F 2A C8 F3 0F 5E 0D ?? ?? ?? ?? F3 0F 58 0D";
const BREW_FUEL_PATTERN: &str = "8B 83 94 02 00 00 85 C0 74 ?? F3 0F 2A C6 F3 0F 2A C8 F3 0F 59 C8 0F 57 C0 F3 0F 2A 83 98 02 00 00 F3 0F 5E C8";
const BREW_SYNC_PATTERN: &str = "44 8B 8F 90 02 00 00 44 3B 8E 94 01 00 00";
static BREW_PROGRESS: AtomicUsize = AtomicUsize::new(0);
static BREW_FUEL: AtomicUsize = AtomicUsize::new(0);
static BREW_SYNC: AtomicUsize = AtomicUsize::new(0);

/// One pass over the code for the furnace and brewing stand getters.
fn resolve_progress(image: &Image) {
    let mut sites = inventory::all_sites(
        image,
        &[parse_pattern(FURNACE_PATTERN), parse_pattern(BREW_PROGRESS_PATTERN), parse_pattern(BREW_FUEL_PATTERN), parse_pattern(BREW_SYNC_PATTERN)],
    );
    let brewing: Vec<Option<usize>> = sites
        .drain(1..)
        .map(|found| match found[..] {
            [site] => image.function_start(site),
            _ => None,
        })
        .collect();
    if let [Some(progress), Some(fuel), Some(sync)] = brewing[..] {
        if progress != fuel && fuel != sync && progress != sync {
            BREW_PROGRESS.store(progress, Ordering::Release);
            BREW_FUEL.store(fuel, Ordering::Release);
            BREW_SYNC.store(sync, Ordering::Release);
        }
    }
    resolve_furnace(image, &sites.remove(0));
}

fn resolve_furnace(image: &Image, sites: &[usize]) {
    let [first, second] = sites[..] else {
        return;
    };
    let mut burn = None;
    let mut cook = None;
    for site in [first, second] {
        let Some((start, body)) = image.function_start(site).and_then(|start| body_of(image, start, 0x400)) else {
            return;
        };
        let by_register = body.windows(2).any(|pair| pair == [0xF7, 0xF9]);
        let by_field = body.windows(2).any(|pair| pair[0] == 0xF7 && pair[1] == 0xB9);
        match (by_register, by_field) {
            (true, false) => burn = Some(start),
            (false, true) => cook = Some(start),
            _ => return,
        }
    }
    if let (Some(burn), Some(cook)) = (burn, cook) {
        FURNACE_BURN.store(burn, Ordering::Release);
        FURNACE_COOK.store(cook, Ordering::Release);
    }
}

/// A furnace, blast furnace or smoker's progress: `burn` the fuel left and `cook` the smelt done, each a
/// fraction 0..1, through the furnace screen's own getters.
fn furnace_data() -> Result<Value, RpcError> {
    let (burn, cook) = (FURNACE_BURN.load(Ordering::Acquire), FURNACE_COOK.load(Ordering::Acquire));
    if burn == 0 || cook == 0 {
        return Err(RpcError::anchor("screen.furnace_progress"));
    }
    let controller = screen_manager(MOVE_SLOT.load(Ordering::Acquire), "screen.furnace")?;
    // SAFETY: the furnace screen's own getters on the open screen's validated controller; each checks the
    // block actor it finds against the model's block actor type before reading it.
    let read = |getter: usize| unsafe { transmute::<usize, extern "C" fn(usize, i32) -> i32>(getter)(controller, PROGRESS_SCALE) };
    let fraction = |value: i32| (0..=PROGRESS_SCALE).contains(&value).then(|| value as f64 / PROGRESS_SCALE as f64);
    Ok(json!({ "burn": fraction(read(burn)), "cook": fraction(read(cook)) }))
}

/// A brewing stand's `{brew, fuel}`: the brew done and the fuel left, each a fraction 0..1, through the
/// brewing model's own getters — called only on a model whose table holds the brewing model's sync.
fn brewing_data() -> Result<Value, RpcError> {
    let (progress, fuel, sync) = (BREW_PROGRESS.load(Ordering::Acquire), BREW_FUEL.load(Ordering::Acquire), BREW_SYNC.load(Ordering::Acquire));
    if progress == 0 || fuel == 0 || sync == 0 {
        return Err(RpcError::anchor("screen.brewing_progress"));
    }
    let controller = screen_manager(MOVE_SLOT.load(Ordering::Acquire), "screen.brewing")?;
    let model = model_of(controller)
        .filter(|model| has_slot(*model, sync))
        .ok_or_else(|| RpcError::anchor("screen.brewing").with_data(json!({ "message": "the open screen's model is not a brewing stand's" })))?;
    // SAFETY: the brewing model's own getters on a validated brewing model; each finds the block actor at
    // the model's position and checks it is a brewing stand before reading it.
    let read = |getter: usize| unsafe { transmute::<usize, extern "C" fn(usize, i32) -> i32>(getter)(model, PROGRESS_SCALE) };
    let fraction = |value: i32| (0..=PROGRESS_SCALE).contains(&value).then(|| value as f64 / PROGRESS_SCALE as f64);
    Ok(json!({ "brew": fraction(read(progress)), "fuel": fraction(read(fuel)) }))
}

/// A result screen's `{result, inputs}`: the result preview its controller keeps (the stack its own take
/// handler copies and checks before it builds a request; `null` when empty) and its input slots per
/// container (`null` for an empty slot) — the grindstone, smithing table and cartography table.
///
/// The preview's offset in each controller is the one its take handler reads (`lea rbx,[rdi+0xf0]` before
/// the stack copy in the grindstone's, the same `+0xf0` in the smithing table's, `lea rdx,[rdi+0x1a8]` in the
/// cartography table's, 1.26.63.1): an `ItemInstance` (0x80 bytes, its own table, not the slots'
/// `ItemStack` one). It is read only when it has an item stack's shape there — a table in the image, a
/// valid flag of 0 or 1, a count of at most 127, and no item reference or a readable one — so a moved
/// layout answers `unavailable`, never a wrong item.
fn result_screen_data(take: &TakeScreen, preview_at: usize) -> Result<Value, RpcError> {
    let controller = screen_manager(handler(take.handler)?, "screen.result_preview")?;
    let open = open_containers()?;
    let preview = controller + preview_at;
    let shaped = pe::readable(preview, ITEM_INSTANCE_SIZE)
        && pe::read::<usize>(preview).is_some_and(pe::in_image_data)
        && pe::read::<u8>(preview + ITEM_VALID).is_some_and(|valid| valid <= 1)
        && pe::read::<u8>(preview + ITEM_COUNT).is_some_and(|count| count <= 127)
        && pe::read::<usize>(preview + ITEM_IMPL).is_some_and(|item| item == 0 || pe::readable(item, 8));
    if !shaped {
        return Err(RpcError::anchor("screen.result_preview")
            .with_data(json!({ "message": "the controller holds no item stack where its take handler reads the preview" })));
    }
    let result = (count_of(preview) != 0).then(|| inventory::slot(preview)).flatten();
    let mut inputs = serde_json::Map::new();
    for container in open.iter().filter(|open| !is_player(open.name)) {
        let key = container.key();
        if folded(&key).contains("result") || folded(&key).contains("creativeoutput") {
            continue;
        }
        let slots: Vec<Value> = (0..container.size)
            .map(|slot| container.item(slot).filter(|item| count_of(*item) != 0).and_then(inventory::slot).unwrap_or(Value::Null))
            .collect();
        inputs.insert(key, Value::Array(slots));
    }
    Ok(json!({ "result": result, "inputs": inputs }))
}

/// Where the grindstone, smithing table and cartography table controllers keep their result preview.
const GRINDSTONE_PREVIEW: usize = 0xF0;
const SMITHING_PREVIEW: usize = 0xF0;
const CARTOGRAPHY_PREVIEW: usize = 0x1A8;

/// The anvil controller's state, read out of its own update (the slot that recomputes the preview): the
/// XP cost (`mov dword [rsi+COST],0x27` caps it, `cmp dword [rsi+COST],0x28` tests "too expensive"), and
/// the result preview it keeps (`mov rcx,rsi; lea rdx,[rsi+PREVIEW]; call SET_PREVIEW`, the same setter
/// at every site). The rename text is [`anvil_text`].
static ANVIL_COST: AtomicUsize = AtomicUsize::new(0);
static ANVIL_PREVIEW: AtomicUsize = AtomicUsize::new(0);
/// The game's "too expensive" bound (the update tests `cost >= 40`).
const ANVIL_TOO_EXPENSIVE: i32 = 40;

fn resolve_anvil(image: &Image) {
    let update = HANDLERS[H_ANVIL_UPDATE].load(Ordering::Acquire);
    let Some((start, body)) = (update != 0).then(|| body_of(image, update, 0x4000)).flatten() else {
        return;
    };
    let cap = find(body, &parse_pattern("C7 86 ?? ?? ?? ?? 27 00 00 00")).and_then(|at| disp_at(start + at + 2));
    let test = find(body, &parse_pattern("83 BE ?? ?? ?? ?? 28")).and_then(|at| disp_at(start + at + 2));
    if let (Some(cap), Some(test)) = (cap, test) {
        if cap == test && (0x10..0x1000).contains(&cap) {
            ANVIL_COST.store(cap, Ordering::Release);
        }
    }
    let pattern = parse_pattern("48 89 F1 48 8D 96 ?? ?? ?? ?? E8");
    let mut found: Option<(usize, usize)> = None;
    let mut at = 0;
    while let Some(hit) = body.get(at..).and_then(|rest| find(rest, &pattern)) {
        let site = start + at + hit;
        let (Some(offset), Some(rel)) = (disp_at(site + 6), pe::read::<i32>(site + 11)) else {
            return;
        };
        let target = (site + 15).wrapping_add_signed(rel as isize);
        if found.is_some_and(|known| known != (offset, target)) {
            return;
        }
        found = Some((offset, target));
        at += hit + 1;
    }
    if let Some((offset, target)) = found {
        if (0x10..0x1000).contains(&offset) && image.function_start(target) == Some(target) {
            ANVIL_PREVIEW.store(offset, Ordering::Release);
        }
    }
}

/// The anvil's `{result, xpCost, tooExpensive, name}` as its controller holds them after its own update.
fn anvil_data() -> Result<Value, RpcError> {
    let (cost_at, preview_at) = (ANVIL_COST.load(Ordering::Acquire), ANVIL_PREVIEW.load(Ordering::Acquire));
    if cost_at == 0 || preview_at == 0 {
        return Err(RpcError::anchor("screen.anvil_state"));
    }
    let controller = screen_manager(handler(H_ANVIL)?, "screen.anvil")?;
    let cost = pe::read::<i32>(controller + cost_at).filter(|cost| (0..=1000).contains(cost));
    let name = anvil_text(controller).ok().and_then(pe::std_string);
    Ok(json!({
        "result": inventory::slot(controller + preview_at),
        "xpCost": cost,
        "tooExpensive": cost.map(|cost| cost >= ANVIL_TOO_EXPENSIVE),
        "name": name,
    }))
}

/// Resolves the screen handlers. A handler is believed only when its pattern is unique, it lies in a
/// function `.pdata` knows, the action table it loads is a table (data whose first entry is code) and the
/// function opens a request itself (calls `_beginRequest`) or, for the helpers, calls what it must.
fn resolve_screen_actions(core: &'static Core) {
    let image = core.image();
    resolve_progress(image);
    let begin = BEGIN.load(Ordering::Acquire);
    let submit = SUBMIT.load(Ordering::Acquire);
    if begin == 0 || submit == 0 {
        return;
    }
    let mut patterns: Vec<Vec<Option<u8>>> = HANDLER_RECIPES.iter().map(|recipe| parse_pattern(recipe.pattern)).collect();
    let extra = patterns.len();
    for text in [
        SCOPE_END_PATTERN,
        STONECUTTER_SELECTION_PATTERN,
        TRADE_SELECTION_PATTERN,
        ANVIL_TEXT_PATTERN,
        ENUM_NAMES_PATTERN,
        MOVE_PATTERN,
        LOOM_INDEX_PATTERN,
        LOOM_SELECT_PATTERN,
    ] {
        patterns.push(parse_pattern(text));
    }
    let sites = unique_sites(image, &patterns);
    for (recipe, (site, pattern)) in HANDLER_RECIPES.iter().zip(sites.iter().zip(&patterns)) {
        let Some(site) = *site else {
            continue;
        };
        let Some(function) = image.function_start(site) else {
            continue;
        };
        if recipe.entry && function != site {
            continue;
        }
        if let Some(at) = recipe.table_at {
            let table = rip_target(site, pe::bytes(site, pattern.len()).unwrap_or(&[]), at, at + 4);
            let is_table = table.is_some_and(|table| pe::in_image_data(table) && pe::read::<usize>(table).is_some_and(pe::in_image_code));
            if !is_table {
                continue;
            }
        }
        let opens = match recipe.index {
            H_ANVIL_UPDATE => true,
            _ => calls(image, function, begin),
        };
        if !opens {
            continue;
        }
        match recipe.index {
            H_BEACON => match disp_at(site + 4) {
                Some(offset) if (0x10..0x1000).contains(&offset) => BEACON_SELECTION.store(offset, Ordering::Release),
                _ => continue,
            },
            H_LOOM => match disp_at(site + 15) {
                Some(offset) if (0x10..0x1000).contains(&offset) => LOOM_PATTERN.store(offset, Ordering::Release),
                _ => continue,
            },
            H_ENCHANT => {
                let head = body_of(image, function, 0x4000).map(|(start, body)| (start, &body[..body.len().min(0x200)]));
                let model = head
                    .and_then(|(start, body)| find(body, MODEL_PATTERN).map(|at| start + at))
                    .and_then(|at| Some((disp_at(at + 3)?, disp_at(at + 10)?)))
                    .filter(|(a, b)| a == b && (0x10..0x400).contains(a));
                let options = head
                    .and_then(|(start, body)| find(body, OPTIONS_PATTERN).map(|at| start + at))
                    .and_then(|at| Some((disp_at(at + 3)?, disp_at(at + 10)?)))
                    .filter(|(begin, end)| *end == *begin + 8 && (0x10..0x1000).contains(begin));
                match (model, options) {
                    (Some((model, _)), Some((options, _))) => {
                        MODEL_AT.store(model, Ordering::Release);
                        ENCHANT_OPTIONS.store(options, Ordering::Release);
                    }
                    _ => continue,
                }
            }
            _ => {}
        }
        HANDLERS[recipe.index].store(function, Ordering::Release);
    }
    // The scope destructor: its entry, and it submits a request it owns.
    if let Some(site) = sites[extra] {
        if image.function_start(site) == Some(site) && calls(image, site, submit) {
            HANDLERS[H_SCOPE_END].store(site, Ordering::Release);
        }
    }
    // The stonecutter's selection: read in its preview refresh, which its result handler calls.
    let stonecutter = HANDLERS[H_STONECUTTER].load(Ordering::Acquire);
    if let Some(site) = sites[extra + 1] {
        if let (Some(refresh), Some(offset)) = (image.function_start(site), disp_at(site + 18)) {
            if stonecutter != 0 && calls(image, stonecutter, refresh) && (0x10..0x1000).contains(&offset) {
                HANDLERS[H_STONECUTTER_REFRESH].store(refresh, Ordering::Release);
                STONECUTTER_SELECTION.store(offset, Ordering::Release);
                // The recipe list builder the refresh calls right before it reads the selection.
                if let Some((start, body)) = body_of(image, refresh, 0x4000) {
                    if let Some(at) = find(body, &parse_pattern(STONECUTTER_LIST_PATTERN)) {
                        let call = start + at + 6;
                        let list = pe::read::<i32>(call + 1).map(|rel| (call + 5).wrapping_add_signed(rel as isize));
                        if let Some(list) = list.filter(|list| image.function_start(*list) == Some(*list)) {
                            if pe::read::<u32>(start + at + 15).map(|disp| disp as usize) == Some(offset) {
                                STONECUTTER_LIST.store(list, Ordering::Release);
                            }
                        }
                    }
                }
            }
        }
    }
    // The tier-1 trade selection: read by the trade handler itself.
    let trade = HANDLERS[H_TRADE].load(Ordering::Acquire);
    if let Some(site) = sites[extra + 2] {
        if let Some(offset) = disp_at(site + 12) {
            if trade != 0 && image.function_start(site) == Some(trade) && (0x10..0x1000).contains(&offset) {
                TRADE_SELECTION.store(offset, Ordering::Release);
            }
        }
    }
    // The trader and its offers, as the tier-1 trade handler looks them up.
    if trade != 0 {
        if let Some((start, body)) = body_of(image, trade, 0x4000) {
            let call_target = |at: usize| pe::read::<i32>(at + 1).map(|rel| (at + 5).wrapping_add_signed(rel as isize)).filter(|target| image.function_start(*target) == Some(*target));
            let lookup = find(body, &parse_pattern(TRADER_PATTERN)).map(|at| start + at);
            let offers = find(body, &parse_pattern(OFFERS_PATTERN)).map(|at| start + at);
            if let (Some(lookup), Some(offers)) = (lookup, offers) {
                let pieces = (
                    call_target(lookup + 4),
                    disp_at(lookup + 16),
                    disp_at(lookup + 36),
                    disp_at(lookup + 46),
                    call_target(offers + 3),
                    disp_at(offers + 21),
                );
                if let (Some(level), Some(level_slot), Some(trader), Some(fetch), Some(list), Some(selection)) = pieces {
                    if level_slot % 8 == 0 && fetch % 8 == 0 && (0x10..0x1000).contains(&trader) && Some(selection) == Some(TRADE_SELECTION.load(Ordering::Acquire)).filter(|known| *known != 0) {
                        TRADE_LEVEL.store(level, Ordering::Release);
                        TRADE_LEVEL_SLOT.store(level_slot, Ordering::Release);
                        TRADE_TRADER.store(trader, Ordering::Release);
                        TRADE_FETCH_SLOT.store(fetch, Ordering::Release);
                        TRADE_OFFERS.store(list, Ordering::Release);
                    }
                }
            }
        }
    }
    // The controllers' own slot-to-slot transfer: called from a base slot every container controller shares;
    // it submits the request it opens itself (the submit step).
    if let Some(site) = sites[extra + 5] {
        let call = site + MOVE_CALL_AT;
        let target = pe::read::<i32>(call + 1).map(|rel| (call + 5).wrapping_add_signed(rel as isize));
        let caller = image.function_start(site);
        if let (Some(target), Some(caller)) = (target, caller) {
            if pe::read::<u8>(call) == Some(0xE8)
                && image.function_start(target) == Some(target)
                && pe::is_vtable_slot(image, caller)
                && calls(image, target, submit)
            {
                MOVE_TRANSFER.store(target, Ordering::Release);
                // Its first resolve of a slot: `lea rdx,[rbp+..]; mov rcx,rdi; mov r8,rsi; call RESOLVE`.
                if let Some((start, body)) = body_of(image, target, 0x4000) {
                    if let Some(at) = find(&body[..body.len().min(0x200)], &parse_pattern("48 8D 55 ?? 48 89 F9 49 89 F0 E8")) {
                        let call = start + at + 10;
                        let resolve = pe::read::<i32>(call + 1).map(|rel| (call + 5).wrapping_add_signed(rel as isize));
                        if let Some(resolve) = resolve.filter(|resolve| image.function_start(*resolve) == Some(*resolve)) {
                            SLOT_RESOLVE.store(resolve, Ordering::Release);
                        }
                    }
                }
                MOVE_SLOT.store(caller, Ordering::Release);
            }
        }
    }
    // The container enum's name map: the list-head global the game's own name function loads.
    if let Some(site) = sites[extra + 4] {
        if let Some(end) = rip_target(site, pe::bytes(site, 36).unwrap_or(&[]), 32, 36).filter(|end| pe::in_image_data(*end)) {
            ENUM_END.store(end, Ordering::Release);
        }
    }
    // The anvil's rename text getter slot: read by the anvil handler itself.
    let anvil = HANDLERS[H_ANVIL].load(Ordering::Acquire);
    if let Some(site) = sites[extra + 3] {
        if let Some(slot) = pe::read::<u8>(site + 6) {
            if anvil != 0 && image.function_start(site) == Some(anvil) && slot % 8 == 0 {
                ANVIL_TEXT_SLOT.store(slot as usize, Ordering::Release);
            }
        }
    }
    // The loom's selected pattern: the index its result builder (called by the loom's take handler)
    // reads, the banner pattern list it indexes and the record's pattern id.
    let loom = HANDLERS[H_LOOM].load(Ordering::Acquire);
    if let Some(site) = sites[extra + 6] {
        let code = pe::bytes(site, 28).unwrap_or(&[]);
        let builder = image.function_start(site).filter(|builder| loom != 0 && calls(image, loom, *builder));
        let pieces = (disp_at(site + 2), rip_target(site, code, 17, 21), rip_target(site, code, 24, 28));
        if let (Some(builder), (Some(selected), Some(end), Some(begin))) = (builder, pieces) {
            let name = body_of(image, builder, 0x4000)
                .and_then(|(start, body)| find(&body[site - start..], &parse_pattern(LOOM_NAME_PATTERN)).map(|at| site + at))
                .and_then(|at| disp_at(at + 3))
                .filter(|name| *name + 0x20 <= LOOM_RECORD);
            if let Some(name) = name.filter(|_| end == begin + 8 && (0x10..0x1000).contains(&selected)) {
                LOOM_SELECTED.store(selected, Ordering::Release);
                LOOM_LIST.store(begin, Ordering::Release);
                LOOM_NAME.store(name, Ordering::Release);
                // The pattern button: it writes the same index and rebuilds the preview through the builder.
                if let Some(select_site) = sites[extra + 7] {
                    let button = image.function_start(select_site).filter(|button| calls(image, *button, builder));
                    let (offered, offered_end, written) = (disp_at(select_site + 11), disp_at(select_site + 18), disp_at(select_site + 41));
                    if let (Some(button), Some(offered), Some(offered_end)) = (button, offered, offered_end) {
                        if offered_end == offered + 8 && written == Some(selected) && (0x10..0x1000).contains(&offered) {
                            LOOM_SELECT.store(button, Ordering::Release);
                            LOOM_OFFERED.store(offered, Ordering::Release);
                        }
                    }
                }
            }
        }
    }
    // The crafting controller's class: the one caller of the crafting take that is a virtual (a slot of
    // the crafting controller's table), which identifies the controller the take may be called on.
    let craft = HANDLERS[H_CRAFT].load(Ordering::Acquire);
    if craft != 0 {
        let mut slots: Vec<usize> = Vec::new();
        for site in &direct_sites(image, &[craft])[0] {
            if let Some(function) = image.function_start(*site) {
                if !slots.contains(&function) && pe::is_vtable_slot(image, function) {
                    slots.push(function);
                }
            }
        }
        if let [slot] = slots[..] {
            HANDLERS[H_CRAFT_SLOT].store(slot, Ordering::Release);
        }
        // The crafting click path: `call TAKE(craft); …; call TRANSFER; nop; lea rdx,[rbp+..]; mov rcx,rsi;
        // call EXTRAS; nop; lea rcx,[rbp+..]; call SCOPE_END` — the result's move out of the created-output
        // slot, then the extra results (a bucket left by a cake) placed into the inventory.
        let pattern = parse_pattern("E8 ?? ?? ?? ?? 90 48 8D 55 ?? 48 89 F1 E8 ?? ?? ?? ?? 90 48 8D 4D ?? E8");
        let target = |at: usize| pe::read::<i32>(at + 1).map(|rel| (at + 5).wrapping_add_signed(rel as isize));
        let (transfer, scope_end) = (MOVE_TRANSFER.load(Ordering::Acquire), HANDLERS[H_SCOPE_END].load(Ordering::Acquire));
        let mut extras: Option<usize> = None;
        for site in &direct_sites(image, &[craft])[0] {
            let Some((start, body)) = image.function_start(*site).and_then(|start| body_of(image, start, 0x2000)) else {
                continue;
            };
            let mut at = 0;
            while let Some(hit) = body.get(at..).and_then(|rest| find(rest, &pattern)) {
                let site = start + at + hit;
                if target(site) == Some(transfer) && target(site + 23) == Some(scope_end) {
                    let found = target(site + 13).filter(|found| image.function_start(*found) == Some(*found));
                    match (extras, found) {
                        (None, Some(found)) => extras = Some(found),
                        (Some(known), Some(found)) if known == found => {}
                        _ => {
                            extras = None;
                            break;
                        }
                    }
                }
                at += hit + 1;
            }
        }
        if let Some(extras) = extras {
            CRAFT_EXTRAS.store(extras, Ordering::Release);
        }
    }
    // The screen fields the enchanting and beacon screens pass their controller from: `enchant` and the
    // beacon payment are not virtual, so the screen's own single call site names the field.
    let enchant = HANDLERS[H_ENCHANT].load(Ordering::Acquire);
    let beacon = HANDLERS[H_BEACON].load(Ordering::Acquire);
    let first = direct_sites(image, &[enchant, beacon]);
    if let [site] = first[0][..] {
        if let Some(field) = loaded_field(site) {
            ENCHANT_FIELD.store(field, Ordering::Release);
        }
    }
    if let [site] = first[1][..] {
        // The payment is reached through the beacon's button dispatcher, which the screen calls once.
        if let Some(dispatcher) = image.function_start(site) {
            if let [outer] = direct_sites(image, &[dispatcher])[0][..] {
                if let Some(field) = loaded_field(outer) {
                    BEACON_FIELD.store(field, Ordering::Release);
                }
            }
        }
    }
    let rva = |address: usize| if address == 0 { String::from("missing") } else { format!("0x{:x}", address - image.base()) };
    let mut line = String::from("resolve screen actions:");
    for (index, name) in HANDLER_ANCHORS.iter().enumerate() {
        line.push_str(&format!(" {name} {}", rva(HANDLERS[index].load(Ordering::Acquire))));
    }
    agent_core::log::fmt(format_args!(
        "{line}; model +0x{:x}, beacon +0x{:x}, stonecutter +0x{:x}, trade +0x{:x}, loom +0x{:x}, anvil text slot 0x{:x}, enchant field +0x{:x}, beacon field +0x{:x}, loom select {} (selected +0x{:x}, offered +0x{:x})",
        MODEL_AT.load(Ordering::Acquire),
        BEACON_SELECTION.load(Ordering::Acquire),
        STONECUTTER_SELECTION.load(Ordering::Acquire),
        TRADE_SELECTION.load(Ordering::Acquire),
        LOOM_PATTERN.load(Ordering::Acquire),
        ANVIL_TEXT_SLOT.load(Ordering::Acquire),
        ENCHANT_FIELD.load(Ordering::Acquire),
        BEACON_FIELD.load(Ordering::Acquire),
        rva(LOOM_SELECT.load(Ordering::Acquire)),
        LOOM_SELECTED.load(Ordering::Acquire),
        LOOM_OFFERED.load(Ordering::Acquire),
    ));
}

/// A resolved handler, or the anchor that names it.
fn handler(index: usize) -> Result<usize, RpcError> {
    match HANDLERS[index].load(Ordering::Acquire) {
        0 => Err(RpcError::anchor(HANDLER_ANCHORS[index])),
        entry => Ok(entry),
    }
}

/// How far into the screen controller its manager controller pointer may sit.
const CONTROLLER_WINDOW: usize = 0x2000;
/// How many table slots of a candidate are compared with a handler.
const TABLE_SLOTS: usize = 64;

/// True when `object`'s table holds `entry` among its first [`TABLE_SLOTS`] slots: the object is an
/// instance of the class whose virtual `entry` is.
fn has_slot(object: usize, entry: usize) -> bool {
    let Some(table) = pe::read::<usize>(object).filter(|table| pe::in_image_data(*table)) else {
        return false;
    };
    (0..TABLE_SLOTS).any(|slot| pe::read::<usize>(table + slot * 8) == Some(entry))
}

/// The open screen's container manager controller whose class runs `entry` (one of [`HANDLERS`]).
///
/// The screen controller is the top scene's (`ui::screen_controller`); the manager controller is the
/// `shared_ptr` the screen keeps of it, found among the screen's fields as the object whose own table
/// holds `entry`, and its model must be alive. That identity — the table of the class the handler belongs
/// to — is what makes calling the handler on it the call the game itself makes.
fn screen_manager(entry: usize, anchor: &'static str) -> Result<usize, RpcError> {
    let screen = ui::screen_controller()
        .ok_or_else(|| RpcError::anchor("ui.screen").with_data(json!({ "message": "the open screen's controller is not readable now" })))?;
    let model_at = base_model_at(screen, entry).unwrap_or_else(|| MODEL_AT.load(Ordering::Acquire));
    if model_at == 0 {
        return Err(RpcError::anchor("screen.enchanting").with_data(json!({ "message": "the controller's model offset did not resolve" })));
    }
    for offset in (0..CONTROLLER_WINDOW).step_by(8) {
        let Some(candidate) = pe::read::<usize>(screen + offset).filter(|candidate| *candidate >= 0x1_0000) else {
            continue;
        };
        if !has_slot(candidate, entry) {
            continue;
        }
        if !model_alive(candidate, model_at) {
            return Err(RpcError::invalid_params("the screen's model is gone: the screen is closing"));
        }
        return Ok(candidate);
    }
    #[cfg(feature = "debug-rpc")]
    agent_core::log::fmt(format_args!(
        "screen_manager: no controller with slot 0x{entry:x} in screen 0x{screen:x} (table {:x?}) for {anchor}",
        pe::read::<usize>(screen)
    ));
    Err(RpcError::anchor(anchor).with_data(json!({
        "message": "the open screen keeps no controller of this screen's class",
    })))
}

/// True when `controller + at` holds a live `weak_ptr` / `shared_ptr` to an object with a table.
fn model_alive(controller: usize, at: usize) -> bool {
    let model = pe::read::<usize>(controller + at).unwrap_or(0);
    let uses = pe::read::<usize>(controller + at + 8)
        .filter(|block| *block != 0)
        .and_then(|block| pe::read::<u32>(block + 8))
        .is_some_and(|uses| uses != 0);
    model != 0 && uses && pe::read::<usize>(model).is_some_and(pe::in_image_data)
}

/// `controller + BASE_MODEL_AT` = the model every container manager controller keeps (a `weak_ptr`
/// held by the base class), 0 until read from the base class's own destructor.
static BASE_MODEL_AT: AtomicUsize = AtomicUsize::new(0);

/// `lea rax,[rip+TABLE]; mov [rcx],rax; mov rcx,[rcx+BLOCK]; test rcx,rcx`: a destructor storing its
/// class's table, then loading the control block of the `weak_ptr` it locks.
const BASE_DTOR_HEAD: &[Option<u8>] = &[
    Some(0x48), Some(0x8D), Some(0x05), None, None, None, None, Some(0x48), Some(0x89), Some(0x01), Some(0x48), Some(0x8B),
    Some(0x49), None, Some(0x48), Some(0x85), Some(0xC9),
];
/// `lock cmpxchg [rcx+8],edx; jne; mov r,[rbx+PTR]; mov r,[rbx+BLOCK]`: the lock succeeded, the pointer
/// and its control block are read.
const BASE_DTOR_LOCK: &[Option<u8>] =
    &[Some(0xF0), Some(0x0F), Some(0xB1), Some(0x51), Some(0x08), Some(0x75), None, Some(0x48), Some(0x8B), None, None, Some(0x48), Some(0x8B), None, None];

/// The base manager controller's model field, read once from the controller of the open screen whose
/// class runs `entry`: its deleting destructor (table slot 0) calls the base destructor, the one that
/// stores a table holding `entry` itself and then locks the model's `weak_ptr` at `[this+PTR]`,
/// `[this+PTR+8]`. A crafter, hopper, dispenser or dropper screen uses the base class as is, so its object
/// ends where a derived class's typed model copy ([`MODEL_AT`]) would start.
fn base_model_at(screen: usize, entry: usize) -> Option<usize> {
    match BASE_MODEL_AT.load(Ordering::Acquire) {
        0 => {}
        at => return Some(at),
    }
    let controller = (0..CONTROLLER_WINDOW)
        .step_by(8)
        .filter_map(|offset| pe::read::<usize>(screen + offset).filter(|candidate| *candidate >= 0x1_0000))
        .find(|candidate| has_slot(*candidate, entry))?;
    let deleting = pe::read::<usize>(controller).and_then(pe::read::<usize>).filter(|entry| pe::in_image_code(*entry))?;
    let head = pe::bytes(deleting, 0x80)?;
    let at = (0..head.len().saturating_sub(5)).filter(|at| head[*at] == 0xE8).find_map(|at| {
        let dtor = rip_target(deleting, head, at + 1, at + 5).filter(|dtor| pe::in_image_code(*dtor))?;
        let body = pe::bytes(dtor, 0x80)?;
        let store = find(body, BASE_DTOR_HEAD)?;
        let table = rip_target(dtor, body, store + 3, store + 7)?;
        if !(0..TABLE_SLOTS).any(|slot| pe::read::<usize>(table + slot * 8) == Some(entry)) {
            return None;
        }
        let block = body[store + 13] as usize;
        let lock = store + find(&body[store..], BASE_DTOR_LOCK)?;
        let (ptr_rm, ptr) = (body[lock + 9], body[lock + 10] as usize);
        let (block_rm, block_at) = (body[lock + 13], body[lock + 14] as usize);
        let rbx_disp8 = |modrm: u8| modrm & 0xC7 == 0x43;
        (rbx_disp8(ptr_rm) && rbx_disp8(block_rm) && block_at == block && ptr + 8 == block).then_some(ptr)
    })?;
    BASE_MODEL_AT.store(at, Ordering::Release);
    Some(at)
}

/// The model the manager controller works on (validated alive by [`screen_manager`]).
fn model_of(controller: usize) -> Option<usize> {
    pe::read::<usize>(controller + MODEL_AT.load(Ordering::Acquire)).filter(|model| *model != 0)
}

/// The open screen's manager controller as the screen itself passes it to a non-virtual handler: the
/// pointer at `screen + field` (the field the screen's own call site loads), validated as an object with a
/// table in the image and a live model.
fn screen_field_manager(field: usize, anchor: &'static str) -> Result<usize, RpcError> {
    let screen = ui::screen_controller()
        .ok_or_else(|| RpcError::anchor("ui.screen").with_data(json!({ "message": "the open screen's controller is not readable now" })))?;
    let model_at = MODEL_AT.load(Ordering::Acquire);
    if field == 0 || model_at == 0 {
        return Err(RpcError::anchor(anchor).with_data(json!({ "message": "the screen's controller field did not resolve" })));
    }
    let controller = pe::read::<usize>(screen + field)
        .filter(|controller| *controller >= 0x1_0000 && pe::read::<usize>(*controller).is_some_and(pe::in_image_data))
        .ok_or_else(|| RpcError::anchor(anchor).with_data(json!({ "message": "the open screen keeps no manager controller there" })))?;
    if !model_alive(controller, model_at) {
        return Err(RpcError::invalid_params("the screen's model is gone: the screen is closing"));
    }
    Ok(controller)
}

/// How many options the enchanting model lists now, validated as a vector of option records.
fn enchant_options(controller: usize) -> Result<usize, RpcError> {
    let at = ENCHANT_OPTIONS.load(Ordering::Acquire);
    let model = model_of(controller).ok_or_else(|| RpcError::anchor("screen.enchanting"))?;
    let (Some(begin), Some(end)) = (pe::read::<usize>(model + at), pe::read::<usize>(model + at + 8)) else {
        return Err(RpcError::anchor("screen.enchanting"));
    };
    if at == 0 || end < begin || (end - begin) % ENCHANT_OPTION_SIZE != 0 || (end - begin) / ENCHANT_OPTION_SIZE > 3 {
        return Err(RpcError::anchor("screen.enchanting").with_data(json!({ "message": "the model's options do not have the vector's shape" })));
    }
    Ok((end - begin) / ENCHANT_OPTION_SIZE)
}

/// Empties the request being built: each action is freed with its own deleting destructor (slot 0, the way
/// `addRequestAction` frees one its validator refuses) and the action vector is cut back to empty, so the
/// submit step that follows discards the request instead of sending a half-built one to the server.
fn discard_actions(request: usize) {
    let (Some(begin), Some(end)) = (pe::read::<usize>(request + REQUEST_ACTIONS), pe::read::<usize>(request + REQUEST_ACTIONS + 8)) else {
        return;
    };
    if begin == 0 || end < begin || (end - begin) % 8 != 0 || (end - begin) / 8 > 64 || !pe::writable(request + REQUEST_ACTIONS + 8, 8) {
        return;
    }
    for at in (begin..end).step_by(8) {
        let Some(action) = pe::read::<usize>(at).filter(|action| *action != 0) else {
            continue;
        };
        if let Some(destroy) = pe::read::<usize>(action).filter(|table| pe::in_image_data(*table)).and_then(|table| pe::read::<usize>(table)).filter(|entry| pe::in_image_code(*entry)) {
            // SAFETY: slot 0 of the action's own table, its scalar deleting destructor (`this, flags`).
            unsafe { transmute::<usize, extern "C" fn(usize, u32) -> usize>(destroy)(action, 1) };
        }
    }
    // SAFETY: the vector's end pointer, writable (checked); the elements past `begin` were just freed.
    unsafe { core::ptr::write_unaligned((request + REQUEST_ACTIONS + 8) as *mut usize, begin) };
}

/// Ends a request left open on the manager. The game opens and submits its own requests inside one call
/// on this thread, and every handler here runs between those calls, so a request still open on entry was
/// abandoned (a screen handler that faulted after `_beginRequest`). Its actions are discarded first —
/// sending a half-built request let the server run a trade whose result move never came (live: 20 emeralds
/// gone) — then the submit step ends the now empty request, so later requests can open again.
fn clear_stale(manager: usize) -> Result<(), RpcError> {
    let pending = pe::read::<usize>(manager + MANAGER_PENDING).unwrap_or(0);
    if pending == 0 {
        return Ok(());
    }
    if pe::read::<usize>(pending) != Some(REQUEST_TABLE.load(Ordering::Acquire)) {
        return Err(RpcError::anchor("screen.request").with_data(json!({ "message": "the manager's open request is not a request" })));
    }
    agent_core::log::fmt(format_args!(
        "screen.request: discarding the abandoned request {} left open on the manager",
        pe::read::<i32>(pending + REQUEST_ID).unwrap_or(0)
    ));
    discard_actions(pending);
    // SAFETY: the game's own submit step on the player's validated manager, with its request open.
    unsafe { transmute::<usize, extern "C" fn(usize)>(SUBMIT.load(Ordering::Acquire))(manager) };
    if pe::read::<usize>(manager + MANAGER_PENDING) != Some(0) {
        return Err(RpcError::invalid_params("an item request is still open on the player's manager: try again"));
    }
    Ok(())
}

/// Discards whatever the request this module opened holds so far (see [`discard_actions`]): a result take
/// whose move cannot be made must not reach the server, where it would consume the inputs and destroy the
/// result.
fn discard_pending() {
    if let Some(request) = manager().ok().and_then(|manager| pe::read::<usize>(manager + MANAGER_PENDING)).filter(|request| *request != 0) {
        if pe::read::<usize>(request) == Some(REQUEST_TABLE.load(Ordering::Acquire)) {
            discard_actions(request);
        }
    }
}

/// `resolve(controller, shared_ptr<ContainerModel>* out, SlotData const&)`: the model a slot's collection
/// belongs to (null when the controller has none), the first call of the transfer
/// (`lea rdx,[rbp+..]; mov rcx,rdi; mov r8,rsi; call RESOLVE`).
static SLOT_RESOLVE: AtomicUsize = AtomicUsize::new(0);

/// True when the controller knows the slot's collection, so its transfer can be given that slot: the
/// transfer itself dereferences the model it resolves without a check.
fn slot_known(controller: usize, slot: usize) -> bool {
    let resolve = SLOT_RESOLVE.load(Ordering::Acquire);
    if resolve == 0 || slot == 0 || !pe::readable(slot, 0x28) {
        return false;
    }
    let mut out = [0usize; 2];
    // SAFETY: the transfer's own resolver on the same controller and slot, with a shared_ptr to fill.
    unsafe { transmute::<usize, extern "C" fn(usize, *mut usize, usize) -> usize>(resolve)(controller, out.as_mut_ptr(), slot) };
    let [model, control] = out;
    if control != 0 {
        // Release the shared_ptr's strong reference the resolver took, as its destructor does.
        // SAFETY: the control block the resolver handed out; its table's slot 0 destroys the object and slot 1
        // the block, each when its count reaches zero.
        unsafe {
            let strong = &*((control + 8) as *const core::sync::atomic::AtomicI32);
            if strong.fetch_sub(1, Ordering::AcqRel) == 1 {
                if let Some(entry) = pe::read::<usize>(control).and_then(|table| pe::read::<usize>(table)).filter(|entry| pe::in_image_code(*entry)) {
                    transmute::<usize, extern "C" fn(usize)>(entry)(control);
                }
                let weak = &*((control + 0xc) as *const core::sync::atomic::AtomicI32);
                if weak.fetch_sub(1, Ordering::AcqRel) == 1 {
                    if let Some(entry) = pe::read::<usize>(control).and_then(|table| pe::read::<usize>(table + 8)).filter(|entry| pe::in_image_code(*entry)) {
                        transmute::<usize, extern "C" fn(usize)>(entry)(control);
                    }
                }
            }
        }
    }
    model != 0
}

/// Runs `build` inside one request this module opens: the screen's own handler sees a request already being
/// built, adds its actions to it and leaves ending it to the opener (every handler does: it begins and submits
/// only when the manager has no request open). Answers the request's id and how many actions it holds.
fn in_request(build: impl FnOnce()) -> Result<(i32, usize), RpcError> {
    if !requests_ready() {
        return Err(RpcError::anchor("screen.request"));
    }
    let manager = manager()?;
    clear_stale(manager)?;
    let begin = BEGIN.load(Ordering::Acquire);
    let submit = SUBMIT.load(Ordering::Acquire);
    // SAFETY: the game's own `_beginRequest(manager, mode 0)` on the player's validated manager.
    unsafe { transmute::<usize, extern "C" fn(usize, u8)>(begin)(manager, 0) };
    // SAFETY: the game's own submit step on the same manager (an empty request is discarded).
    let finish = || unsafe { transmute::<usize, extern "C" fn(usize)>(submit)(manager) };
    let request = pe::read::<usize>(manager + MANAGER_PENDING).unwrap_or(0);
    if request == 0 || pe::read::<usize>(request) != Some(REQUEST_TABLE.load(Ordering::Acquire)) {
        finish();
        return Err(RpcError::anchor("screen.request").with_data(json!({ "message": "_beginRequest did not open a request" })));
    }
    let id = pe::read::<i32>(request + REQUEST_ID).unwrap_or(0);
    // The handlers touch items: they run inside the game's item-registry scope (absent on this thread).
    if let Err(error) = input::with_item_scope(build) {
        finish();
        return Err(error);
    }
    if pe::read::<usize>(manager + MANAGER_PENDING) != Some(request) {
        // The handler ended the request itself; it went out under its own id.
        return Ok((id, 1));
    }
    let actions = match (pe::read::<usize>(request + REQUEST_ACTIONS), pe::read::<usize>(request + REQUEST_ACTIONS + 8)) {
        (Some(begin), Some(end)) if end >= begin => (end - begin) / 8,
        _ => 0,
    };
    finish();
    Ok((id, actions))
}

/// An MSVC `std::string` the game reads through a `const&`: inline up to 15 bytes, else a pointer to
/// `text` (which carries its own terminating zero).
#[repr(C)]
struct ConstString {
    data: [usize; 2],
    size: usize,
    capacity: usize,
}

impl ConstString {
    /// `text` ends with its zero and must outlive every use of the result (it is borrowed, not copied, when
    /// longer than the inline buffer).
    fn new(text: &[u8]) -> Self {
        let size = text.len().saturating_sub(1);
        let mut data = [0usize; 2];
        if size < 16 {
            // SAFETY: at most 16 bytes into the 16-byte inline buffer (the zero included when it fits).
            unsafe { core::ptr::copy_nonoverlapping(text.as_ptr(), data.as_mut_ptr() as *mut u8, text.len().min(16)) };
            Self { data, size, capacity: 15 }
        } else {
            data[0] = text.as_ptr() as usize;
            Self { data, size, capacity: size | 0xF }
        }
    }
}

/// How much a result handler takes: `{kind, value, all}` as the screen hands it over (kind 2 / value 0 = one
/// craft; kind 0 = `value` items, clamped by what the inputs make when `all` is set).
#[repr(C)]
struct Amount {
    kind: i32,
    value: i32,
    all: u8,
    pad: [u8; 3],
}

/// Writes `text` into the game's `std::string` at `at`: in place when it fits the current buffer, into a
/// new buffer from the game's allocator when the string is still inline; a heap string too small for the
/// text is refused rather than leaked.
fn write_string(at: usize, text: &str) -> Result<(), RpcError> {
    let bytes = text.as_bytes();
    if bytes.len() >= 0x400 {
        return Err(RpcError::invalid_params("text is too long"));
    }
    let (Some(size), Some(capacity)) = (pe::read::<usize>(at + 0x10), pe::read::<usize>(at + 0x18)) else {
        return Err(RpcError::anchor("screen.string"));
    };
    if capacity < 15 || size > capacity || capacity >= 0x1_0000 || !pe::writable(at, 0x20) {
        return Err(RpcError::anchor("screen.string").with_data(json!({ "message": "the field is not a std::string" })));
    }
    let buffer = if capacity == 15 {
        if bytes.len() <= 15 {
            at
        } else {
            let wanted = bytes.len() | 0xF;
            let memory = allocate(wanted + 1).ok_or_else(|| RpcError::anchor("screen.request").with_data(json!({ "message": "the game's allocator is not readable" })))?;
            // SAFETY: `at` is a writable std::string whose inline buffer becomes a pointer to `memory`.
            unsafe {
                core::ptr::write_unaligned(at as *mut usize, memory);
                core::ptr::write_unaligned((at + 0x18) as *mut usize, wanted);
            }
            memory
        }
    } else {
        if bytes.len() > capacity {
            return Err(RpcError::invalid_params("the text is longer than the field's buffer: shorten it"));
        }
        pe::read::<usize>(at).filter(|pointer| pe::writable(*pointer, capacity + 1)).ok_or_else(|| RpcError::anchor("screen.string"))?
    };
    // SAFETY: `buffer` holds at least `bytes.len() + 1` writable bytes (checked or allocated above).
    unsafe {
        core::ptr::copy_nonoverlapping(bytes.as_ptr(), buffer as *mut u8, bytes.len());
        core::ptr::write((buffer + bytes.len()) as *mut u8, 0);
        core::ptr::write_unaligned((at + 0x10) as *mut usize, bytes.len());
    }
    Ok(())
}

/// Takes the screen's result through its own result handler, as a click on the result slot does. The
/// handler adds the craft action and puts the made item into the created-output slot it names in the scope it
/// hands back (`scope[0]`, a [`SlotData`]); the click then moves it out with the controller's own transfer
/// (`Take`, all of it, as the stonecutter's own click path 0x14cc67ca0 does) while the scope is alive, and
/// only then ends the scope. Without that move the server destroys the made item at the end of the request
/// (live: a stone consumed, no slab anywhere). Here the move goes to `to` (an empty hotbar or inventory
/// slot). Answers the request id and how many actions it built.
fn take_through(controller: usize, entry: usize, collection: &[u8], amount: Amount, to: &SlotData) -> Result<(i32, usize), RpcError> {
    let scope_end = handler(H_SCOPE_END)?;
    let transfer = MOVE_TRANSFER.load(Ordering::Acquire);
    if transfer == 0 {
        return Err(RpcError::anchor("screen.move"));
    }
    // The handlers take the clicked result slot as the screen passes it: `{collection name, index}`.
    let name = SlotData { name: ConstString::new(collection), index: 0, pad: 0 };
    let everything = Amount { kind: 1, value: 0, all: 0, pad: [0; 3] };
    in_request(|| {
        let mut scope = [0usize; 5];
        // SAFETY: the class's own result handler (`entry`, a slot of `controller`'s table), with the
        // out-scope it fills, the collection name it compares and the amount it reads.
        unsafe {
            transmute::<usize, extern "C" fn(usize, *mut usize, *const SlotData, *const Amount) -> usize>(entry)(
                controller,
                scope.as_mut_ptr(),
                &name,
                &amount,
            )
        };
        if scope[0] != 0 && !(slot_known(controller, scope[0]) && slot_known(controller, to as *const SlotData as usize)) {
            // The move cannot be made on this controller: send nothing rather than a craft whose result the
            // server would destroy.
            discard_pending();
        } else if scope[0] != 0 {
            // SAFETY: the controller's own transfer, from the created-output slot the handler's scope names
            // (alive until the scope ends below) to `to`, as the screen's own click makes it.
            unsafe {
                transmute::<usize, extern "C" fn(usize, u32, *const SlotData, *const SlotData, *const Amount, u8, u8) -> u8>(transfer)(
                    controller,
                    TAKE as u32,
                    to,
                    scope[0] as *const SlotData,
                    &everything,
                    1,
                    0,
                )
            };
        }
        // SAFETY: the scope's own destructor on the scope the handler filled (or zeroed).
        unsafe { transmute::<usize, extern "C" fn(*mut usize)>(scope_end)(scope.as_mut_ptr()) };
    })
}

/// The result collection a result handler compares the clicked slot with: its first `mov byte [rbp+d],KEY;
/// lea rcx,[rip+MAP]` (MAP the game's container name map, whose list head is the name list this module
/// reads), named through that map. Zero-terminated, for a [`SlotData`].
fn handler_collection(entry: usize) -> Option<Vec<u8>> {
    let body = pe::bytes(entry, 0x80)?;
    let at = find(body, &parse_pattern("C6 85 ?? ?? ?? ?? ?? 48 8D 0D"))?;
    let key = body[at + 6];
    let disp = i32::from_le_bytes(body.get(at + 10..at + 14)?.try_into().ok()?);
    let map = (entry + at + 14).wrapping_add_signed(disp as isize);
    if map + 8 != ENUM_END.load(Ordering::Acquire) {
        return None;
    }
    let mut name = name_of(key)?.into_bytes();
    name.push(0);
    Some(name)
}

/// A slot as the container manager controllers address it: the UI collection's name and the index within
/// that collection (the name's own slots, in order — what `screen.state` lists).
#[repr(C)]
struct SlotData {
    name: ConstString,
    index: i32,
    pad: i32,
}

/// Moves `count` items (the whole stack for a swap) from `from` to `to` through the open screen's own
/// container manager controller, as a mouse drag does: the controller applies the move to the client's own
/// containers and adds the transfer to the request this module opens ([`in_request`]), so the client shows
/// what the server is asked to do. Answers the request's id; a move the controller refused (it added no
/// action) is `-32602`.
fn move_through(kind: u8, from: (&Open, usize), to: (&Open, usize), count: u8) -> Result<i32, RpcError> {
    let transfer = MOVE_TRANSFER.load(Ordering::Acquire);
    if transfer == 0 {
        return Err(RpcError::anchor("screen.move"));
    }
    let controller = screen_manager(MOVE_SLOT.load(Ordering::Acquire), "screen.move")?;
    // The collection name the controller resolves: a dynamic container's (a bundle's contents) carries its
    // id, `<name>_<id>`, the way the game's own bundle code names it; the bare name resolves to nothing.
    let collection = |open: &Open| -> Result<Vec<u8>, RpcError> {
        name_of(open.name).ok_or_else(|| RpcError::anchor("screen.container_names"))?;
        let mut name = open.key().into_bytes();
        name.push(0);
        Ok(name)
    };
    let (from_name, to_name) = (collection(from.0)?, collection(to.0)?);
    let source = SlotData { name: ConstString::new(&from_name), index: from.1 as i32, pad: 0 };
    let target = SlotData { name: ConstString::new(&to_name), index: to.1 as i32, pad: 0 };
    let amount = Amount { kind: 0, value: count as i32, all: 0, pad: [0; 3] };
    // The transfer dereferences the model it resolves for each slot without a check: a collection the
    // controller has no model of (a carried bundle's contents, before the game's own bundle code made one)
    // faulted inside it (live, 1.26.63.1), so such a slot is refused here.
    for (slot, open) in [(&source, from.0), (&target, to.0)] {
        if !slot_known(controller, slot as *const SlotData as usize) {
            return Err(RpcError::invalid_params(format!(
                "the screen's controller has no model of {}: moving into or out of a bundle is not supported yet",
                open.key()
            )));
        }
    }
    let (id, actions) = in_request(|| {
        // SAFETY: the controller's own transfer on the open screen's validated controller, with two slots
        // and an amount laid out as its callers build them (the names outlive the call).
        unsafe {
            transmute::<usize, extern "C" fn(usize, u32, *const SlotData, *const SlotData, *const Amount, u8, u8) -> u8>(transfer)(
                controller,
                kind as u32,
                &target,
                &source,
                &amount,
                1,
                0,
            )
        };
    })?;
    if actions == 0 {
        return Err(RpcError::invalid_params("the screen's own controller refused the move (nothing to move, or the slots do not take it)"));
    }
    Ok(id)
}

/// The type of the `std::function` target the inventory screen registers for putting a stack into a
/// bundle (`BundleHelper::registerStateMachine`'s second lambda).
const BUNDLE_LAMBDA: &[u8] = b".?AV<lambda_1>@?0??registerStateMachine@BundleHelper@@SAXAEAVContainerScreenController@@@Z@";
/// `insert(managerController, SlotData const& source, ItemStack const& bundle, u32 limit)`: the game's own
/// bundle insert the lambda reaches. It reads the bundle's `bundle_id`, has the controller make (or find)
/// the model of the bundle's contents and moves what fits from `source` into it through the controller's
/// transfer; `limit` is `count | 0x100`, or 0 for the whole stack.
static BUNDLE_INSERT: AtomicUsize = AtomicUsize::new(0);
/// The user data key the insert reads the bundle's contents id from.
const BUNDLE_ID_KEY: &[u8] = b"bundle_id";

/// Resolves the bundle insert: the lambda's type descriptor → its `_Target_type` leaf (`lea rax,[type];
/// ret`) → the one `_Func_impl` table holding it → the table's call slot → the function it calls that in
/// turn calls the one function which loads the `bundle_id` key and calls the controller's transfer.
fn resolve_bundle(image: &Image) {
    let transfer = MOVE_TRANSFER.load(Ordering::Acquire);
    if transfer == 0 {
        return;
    }
    let Some(descriptor) = image.type_descriptor(BUNDLE_LAMBDA) else {
        return;
    };
    let mut references = [0usize; 8];
    let count = image.rip_refs(descriptor, &mut references);
    let mut leaf: Option<usize> = None;
    for reference in &references[..count] {
        let Some((start, register)) = crate::route::lea_at(*reference) else {
            continue;
        };
        if register != 0 || pe::read::<u8>(start + 7) != Some(0xC3) {
            continue;
        }
        if leaf.is_some_and(|known| known != start) {
            return;
        }
        leaf = Some(start);
    }
    let Some(slot) = leaf.and_then(|leaf| crate::route::unique_data_slot(image, leaf)) else {
        return;
    };
    // `_Func_impl` slots: copy, move, call, target type, delete, get.
    let table = slot - 3 * 8;
    let Some(call) = pe::read::<usize>(table + 2 * 8).filter(|entry| pe::in_image_code(*entry)) else {
        return;
    };
    let mut found_strings = [0usize; 4];
    let found = image.find_strings(BUNDLE_ID_KEY, &mut found_strings);
    let strings = &found_strings[..found];
    let loads_key = |function: usize| {
        body_of(image, function, 0x10000).is_some_and(|(start, body)| {
            (0..body.len().saturating_sub(4)).any(|at| rip_target(start, body, at, at + 4).is_some_and(|target| strings.contains(&target)))
        })
    };
    let Some((start, body)) = body_of(image, call, 0x4000) else {
        return;
    };
    let mut found: Option<usize> = None;
    for callee in pe::callees(image, start, start + body.len()) {
        let Some((inner_start, inner)) = body_of(image, callee, 0x4000) else {
            continue;
        };
        for insert in pe::callees(image, inner_start, inner_start + inner.len()) {
            if image.function_start(insert) != Some(insert) || !loads_key(insert) || !calls(image, insert, transfer) {
                continue;
            }
            if found.is_some_and(|known| known != insert) {
                return;
            }
            found = Some(insert);
        }
    }
    if let Some(insert) = found {
        BUNDLE_INSERT.store(insert, Ordering::Release);
    }
}

/// True when the stack is a bundle (`minecraft:bundle` or a dyed one).
fn is_bundle(item: usize) -> bool {
    inventory::slot(item).and_then(|slot| slot.get("item").and_then(Value::as_str).map(|name| name.ends_with("bundle"))).unwrap_or(false)
}

/// Puts what fits of the stack in `source` (at most `limit` items) into `bundle` through the game's own
/// bundle insert, as the inventory screen does when a stack is dropped on a bundle or a bundle on a stack.
/// Answers the request's id and the count that left `source`.
fn bundle_insert(source: (&Open, usize), bundle: usize, limit: Option<u8>) -> Result<(i32, u8), RpcError> {
    let insert = BUNDLE_INSERT.load(Ordering::Acquire);
    if insert == 0 || MOVE_TRANSFER.load(Ordering::Acquire) == 0 {
        return Err(RpcError::anchor("screen.bundle"));
    }
    let controller = screen_manager(MOVE_SLOT.load(Ordering::Acquire), "screen.move")?;
    name_of(source.0.name).ok_or_else(|| RpcError::anchor("screen.container_names"))?;
    let mut name = source.0.key().into_bytes();
    name.push(0);
    let slot = SlotData { name: ConstString::new(&name), index: source.1 as i32, pad: 0 };
    if !slot_known(controller, &slot as *const SlotData as usize) {
        return Err(RpcError::invalid_params(format!("the screen's controller has no model of {}", source.0.key())));
    }
    let before = source.0.item(source.1).map(count_of).unwrap_or(0);
    let limit = limit.map_or(0, |count| count as u32 | 0x100);
    let (id, actions) = in_request(|| {
        // SAFETY: the game's own bundle insert, called as the inventory screen's bundle lambda calls it: the
        // open screen's validated manager controller, a slot laid out as the controller's callers build it
        // (its name outlives the call), the bundle stack the container holds, and a limit.
        unsafe { transmute::<usize, extern "C" fn(usize, *const SlotData, usize, u32) -> usize>(insert)(controller, &slot, bundle, limit) };
    })?;
    let after = source.0.item(source.1).map(count_of).unwrap_or(0);
    let moved = before.saturating_sub(after);
    if actions == 0 {
        return Err(RpcError::invalid_params("the bundle took nothing (it is full, or the item does not go into a bundle)"));
    }
    Ok((id, moved))
}

/// The crafting screen's result preview (`CraftingOutputPreviewContainer`).
const CRAFTING_PREVIEW: &str = "CraftingOutputPreviewContainer";
/// One extra result the crafting take hands back (an `ItemInstance`, a leftover such as a bucket).
const ITEM_INSTANCE_SIZE: usize = 0x80;

/// Hands `memory` (from the game's allocator) back to it: the allocator's own free slot (slot 2), which
/// the game's sized delete calls; a block of `size >= 0x1000` carries its real start just below it, as
/// the game's own vector deallocation reads it.
fn deallocate(memory: usize, size: usize) {
    let real = if size >= 0x1000 { pe::read::<usize>(memory - 8).unwrap_or(0) } else { memory };
    let Some(allocator) = pe::read::<usize>(ALLOCATOR.load(Ordering::Acquire)).filter(|allocator| *allocator != 0) else {
        return;
    };
    let entry = pe::read::<usize>(allocator).and_then(|table| pe::read::<usize>(table + 0x10)).filter(|entry| pe::in_image_code(*entry));
    if let (Some(entry), true) = (entry, real != 0) {
        // SAFETY: the game allocator's own free slot on a block it handed out.
        unsafe { transmute::<usize, extern "C" fn(usize, usize)>(entry)(allocator, real) };
    }
}

/// The crafting click path's extra-results placer `(controller, vector<ItemInstance>* extras)`, 0 while
/// unresolved: it puts what a recipe leaves behind (a bucket) into the inventory.
static CRAFT_EXTRAS: AtomicUsize = AtomicUsize::new(0);

/// The first empty hotbar or inventory slot of the open screen: its collection name (zero-terminated, for a
/// [`SlotData`]), the key `screen.state` reports it under, and its index.
fn empty_carried_slot() -> Result<(Vec<u8>, String, usize), RpcError> {
    let open = open_containers()?;
    let (target, slot) = carried(&open)
        .into_iter()
        .find_map(|open| (0..open.size).find(|slot| open.item(*slot).is_some_and(|item| count_of(item) == 0)).map(|slot| (open, slot)))
        .ok_or_else(|| RpcError::invalid_params("the player's hotbar and inventory have no empty slot for the result"))?;
    let mut name = name_of(target.name).ok_or_else(|| RpcError::anchor("screen.container_names"))?.into_bytes();
    name.push(0);
    Ok((name, target.key(), slot))
}

/// The crafting screen's own result take, as its click path runs it (0x143a46c70): the take (`ctrl, out
/// scope, collection, amount, vector<ItemInstance>& extra results`) adds the craft and puts the result in
/// the created-output slot the scope names; then, with the scope alive, the controller's transfer moves it
/// (all of it) to `to` and the extras placer puts the extra results away; then the scope ends. Without the
/// move the server destroys the result at the end of the request (live: four planks gone, no table). The
/// extra results vector is released the way the screen releases it (each element's own destructor, then
/// the buffer).
fn craft_through(controller: usize, entry: usize, amount: Amount, to: &SlotData) -> Result<(i32, usize), RpcError> {
    let scope_end = handler(H_SCOPE_END)?;
    let (transfer, extras) = (MOVE_TRANSFER.load(Ordering::Acquire), CRAFT_EXTRAS.load(Ordering::Acquire));
    if transfer == 0 || extras == 0 {
        return Err(RpcError::anchor("screen.craft").with_data(json!({ "message": "the crafting click path's move did not resolve" })));
    }
    let name = SlotData { name: ConstString::new(b"crafting_output_items\0"), index: 0, pad: 0 };
    let everything = Amount { kind: 1, value: 0, all: 0, pad: [0; 3] };
    let mut extra = [0usize; 3];
    let built = in_request(|| {
        let mut scope = [0usize; 5];
        // SAFETY: the crafting controller's own take (its class checked through the virtual that calls it),
        // with the out-scope, the collection name, the amount and the extra-results vector it fills.
        unsafe {
            transmute::<usize, extern "C" fn(usize, *mut usize, *const SlotData, *const Amount, *mut usize) -> usize>(entry)(
                controller,
                scope.as_mut_ptr(),
                &name,
                &amount,
                extra.as_mut_ptr(),
            )
        };
        if scope[0] != 0 && !(slot_known(controller, scope[0]) && slot_known(controller, to as *const SlotData as usize)) {
            discard_pending();
        } else if scope[0] != 0 {
            // SAFETY: the click path's own two calls on the same controller while the scope is alive: the
            // transfer from the slot the scope names to `to`, then the extras placer with the take's vector.
            unsafe {
                transmute::<usize, extern "C" fn(usize, u32, *const SlotData, *const SlotData, *const Amount, u8, u8) -> u8>(transfer)(
                    controller,
                    TAKE as u32,
                    to,
                    scope[0] as *const SlotData,
                    &everything,
                    1,
                    0,
                );
                transmute::<usize, extern "C" fn(usize, *mut usize)>(extras)(controller, extra.as_mut_ptr());
            }
        }
        // SAFETY: the scope's own destructor on the scope the take filled (or zeroed).
        unsafe { transmute::<usize, extern "C" fn(*mut usize)>(scope_end)(scope.as_mut_ptr()) };
    });
    let [begin, end, capacity] = extra;
    if begin != 0 && end >= begin && capacity >= end && (end - begin) % ITEM_INSTANCE_SIZE == 0 {
        for element in (begin..end).step_by(ITEM_INSTANCE_SIZE) {
            if let Some(destroy) = pe::read::<usize>(element).and_then(|table| pe::read::<usize>(table)).filter(|entry| pe::in_image_code(*entry)) {
                // SAFETY: the element's own scalar destructor without the free (flag 0), as the screen calls it.
                unsafe { transmute::<usize, extern "C" fn(usize, u32) -> usize>(destroy)(element, 0) };
            }
        }
        deallocate(begin, capacity - begin);
    }
    built
}

/// The item a screen's result preview shows now, for the answer (its container in the client's map).
fn preview(name: &str) -> Option<(Value, u8)> {
    let open = open_containers().ok()?;
    let container = open_named(&open, name)?;
    let item = container.item(0).filter(|item| count_of(*item) != 0)?;
    Some((inventory::slot(item)?, count_of(item)))
}

/// The effect ids a beacon can pay for (vanilla `MobEffect` ids, which the protocol carries).
const BEACON_EFFECTS: [(&str, u32); 6] = [
    ("speed", 1),
    ("haste", 3),
    ("strength", 5),
    ("jump_boost", 8),
    ("regeneration", 10),
    ("resistance", 11),
];

/// An effect from the wire: a name (`speed`, `minecraft:speed`) or its id.
fn beacon_effect(params: &Value, key: &str) -> Result<Option<u32>, RpcError> {
    let Some(value) = params.get(key).filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let known = |id: u32| BEACON_EFFECTS.iter().any(|(_, known)| *known == id);
    let id = match value {
        Value::Number(number) => number.as_u64().map(|id| id as u32),
        Value::String(text) => {
            let name = text.trim().trim_start_matches("minecraft:");
            BEACON_EFFECTS.iter().find(|(known, _)| *known == name).map(|(_, id)| *id).or_else(|| name.parse::<u32>().ok())
        }
        _ => None,
    };
    match id.filter(|id| known(*id)) {
        Some(id) => Ok(Some(id)),
        None => Err(RpcError::invalid_params(format!(
            "{key} must be one of {}",
            BEACON_EFFECTS.iter().map(|(name, _)| *name).collect::<Vec<_>>().join(", ")
        ))),
    }
}

/// A 0-based index from the wire: a number or a numeric string.
fn index_param(params: &Value, key: &str, limit: u64) -> Result<u32, RpcError> {
    let value = params.get(key).ok_or_else(|| RpcError::invalid_params(format!("{key} is required: a 0-based index")))?;
    let index = match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    };
    index
        .filter(|index| *index < limit)
        .map(|index| index as u32)
        .ok_or_else(|| RpcError::invalid_params(format!("{key} must be a 0-based index below {limit}")))
}

/// One result-taking screen: its handler, the result collection its handler compares and the preview container.
struct TakeScreen {
    handler: usize,
    collection: &'static [u8],
    preview: &'static str,
}

const STONECUTTER_TAKE: TakeScreen = TakeScreen { handler: H_STONECUTTER, collection: b"stonecutter_result_items\0", preview: "StonecutterResultPreviewContainer" };
const SMITHING_TAKE: TakeScreen = TakeScreen { handler: H_SMITHING, collection: b"smithing_table_result_items\0", preview: "SmithingTableResultPreviewContainer" };
const ANVIL_TAKE: TakeScreen = TakeScreen { handler: H_ANVIL, collection: b"anvil_result_items\0", preview: "AnvilResultPreviewContainer" };
const GRINDSTONE_TAKE: TakeScreen = TakeScreen { handler: H_GRINDSTONE, collection: b"grindstone_result_items\0", preview: "GrindstoneResultPreviewContainer" };
const CARTOGRAPHY_TAKE: TakeScreen = TakeScreen { handler: H_CARTOGRAPHY, collection: b"cartography_result_items\0", preview: "CartographyResultPreviewContainer" };
const LOOM_TAKE: TakeScreen = TakeScreen { handler: H_LOOM, collection: b"loom_result_items\0", preview: "LoomResultPreviewContainer" };
// The game's own pairing (read from each handler): the tier-1 handler compares `trade2_result_item`, the tier-2
// one `trade_result_item`.
const TRADE_TAKE: TakeScreen = TakeScreen { handler: H_TRADE, collection: b"trade2_result_item\0", preview: "TradeResultPreviewContainer" };
const TRADE2_TAKE: TakeScreen = TakeScreen { handler: H_TRADE2, collection: b"trade_result_item\0", preview: "Trade2ResultPreviewContainer" };

/// The amount for `times` crafts: one craft's worth, or `times` × the preview's count (clamped by the game to
/// what the inputs make).
fn amount_for(times: u32, per_craft: Option<u8>) -> Result<Amount, RpcError> {
    if times <= 1 {
        return Ok(Amount { kind: 2, value: 0, all: 0, pad: [0; 3] });
    }
    let per = per_craft.filter(|per| *per != 0).ok_or_else(|| {
        RpcError::invalid_params("times above 1 needs the result preview readable: run the action once per craft")
    })?;
    Ok(Amount { kind: 0, value: (times * per as u32) as i32, all: 1, pad: [0; 3] })
}

/// Takes a screen's result once its own state is set (the caller set it), and parks for the server's answer.
fn take_screen(core: &'static Core, screen: String, controller: usize, take: &TakeScreen, times: u32) -> Result<Value, RpcError> {
    let entry = handler(take.handler)?;
    let shown = preview(take.preview);
    // The screen's own handler is never run on an empty result: with nothing to take it can throw inside
    // the game (seen on the stonecutter), which no answer survives.
    let listed = open_containers().ok().is_some_and(|open| open_named(&open, take.preview).is_some());
    if listed && shown.is_none() {
        return Err(RpcError::invalid_params(
            "the screen's result is empty: place the inputs (and choose what to make) first",
        ));
    }
    // The stonecutter lists no result preview container: one craft's count is its selected recipe's result.
    let per_craft = shown.as_ref().map(|(_, count)| *count).or_else(|| {
        (take.handler == H_STONECUTTER)
            .then(stonecutter_data)
            .and_then(Result::ok)
            .and_then(|data| data["result"]["count"].as_u64())
            .and_then(|count| u8::try_from(count).ok())
    });
    let amount = amount_for(times, per_craft)?;
    let open = open_containers()?;
    let (target, slot) = carried(&open)
        .into_iter()
        .find_map(|open| (0..open.size).find(|slot| open.item(*slot).is_some_and(|item| count_of(item) == 0)).map(|slot| (open, slot)))
        .ok_or_else(|| RpcError::invalid_params("the player's hotbar and inventory have no empty slot for the result"))?;
    let mut target_name = name_of(target.name).ok_or_else(|| RpcError::anchor("screen.container_names"))?.into_bytes();
    target_name.push(0);
    let to = SlotData { name: ConstString::new(&target_name), index: slot as i32, pad: 0 };
    let to_key = target.key();
    let before = station_items(&open);
    // The collection the handler compares is the one it names itself (its first lookup in the game's name
    // map); the static name is only the fallback. Live: the tier-2 trade handler compares
    // `trade_result_item` and the tier-1 one `trade2_result_item`, the reverse of the names' look.
    let collection = handler_collection(entry).unwrap_or_else(|| take.collection.to_vec());
    let (id, actions) = take_through(controller, entry, &collection, amount, &to)?;
    if actions == 0 {
        return Err(RpcError::invalid_params(
            "the screen's own handler built no request: its result is empty (place the inputs and choose what to make first)",
        ));
    }
    // The client shows the move at once (the controller predicts it): the made stack is in the target slot
    // and the inputs are reduced; the server's answer confirms or refuses it.
    let after = open_containers()?;
    let result = open_named(&after, &to_key).and_then(|open| open.item(slot)).and_then(inventory::slot).or_else(|| shown.map(|(slot, _)| slot));
    let consumed = consumed_between(&before, &station_items(&after));
    let answer = json!({ "result": result, "consumed": consumed, "to": to_key, "slot": slot, "before": stations_json(&before) });
    park(core, screen, Phase::Request { id, moved: 0, take: true, cursor: false }, Some(answer))
}

/// Every stack in the screen's own containers (not the player's): `(item id, count)` per slot.
fn station_items(open: &[Open]) -> Vec<(String, u32)> {
    let mut out = Vec::new();
    for container in open.iter().filter(|open| !is_player(open.name)) {
        for slot in 0..container.size {
            let Some(item) = container.item(slot).filter(|item| count_of(*item) != 0) else {
                continue;
            };
            if let Some(name) = inventory::slot(item).and_then(|value| value.get("item").and_then(Value::as_str).map(String::from)) {
                out.push((name, count_of(item) as u32));
            }
        }
    }
    out
}

/// The beacon's chosen effects (vanilla effect ids, 0 = none) as its model holds them for the payment.
fn beacon_data() -> Result<Value, RpcError> {
    let selection = BEACON_SELECTION.load(Ordering::Acquire);
    if selection == 0 {
        return Err(RpcError::anchor("screen.beacon"));
    }
    let controller = screen_field_manager(BEACON_FIELD.load(Ordering::Acquire), "screen.beacon")?;
    let model = model_of(controller).ok_or_else(|| RpcError::anchor("screen.beacon"))?;
    let effect = |id: Option<u32>| -> Value {
        match id {
            Some(0) | None => Value::Null,
            Some(id) => BEACON_EFFECTS.iter().find(|(_, known)| *known == id).map_or(json!(id), |(name, _)| json!(name)),
        }
    };
    Ok(json!({
        "primary": effect(pe::read::<u32>(model + selection)),
        "secondary": effect(pe::read::<u32>(model + selection + 4)),
    }))
}

/// The loom's selected pattern (its name id, `""` = none) as its controller holds it, and the patterns its
/// screen offers now (in button order).
fn loom_data() -> Result<Value, RpcError> {
    let field = LOOM_PATTERN.load(Ordering::Acquire);
    if field == 0 {
        return Err(RpcError::anchor("screen.loom"));
    }
    let controller = screen_manager(handler(H_LOOM)?, "screen.loom")?;
    let patterns = match (loom_patterns(), loom_offered(controller)) {
        (Some(names), Some(offered)) => json!(offered.iter().filter_map(|index| names.get(*index as usize)).collect::<Vec<_>>()),
        _ => Value::Null,
    };
    Ok(json!({ "pattern": pe::std_string(controller + field), "patterns": patterns }))
}

/// The game's banner pattern list: each record's pattern id, by list index.
fn loom_patterns() -> Option<Vec<String>> {
    let (list, name) = (LOOM_LIST.load(Ordering::Acquire), LOOM_NAME.load(Ordering::Acquire));
    if list == 0 || name == 0 {
        return None;
    }
    let (begin, end) = (pe::read::<usize>(list)?, pe::read::<usize>(list + 8)?);
    if end < begin || (end - begin) % LOOM_RECORD != 0 || (end - begin) / LOOM_RECORD > 256 {
        return None;
    }
    (0..(end - begin) / LOOM_RECORD).map(|index| pe::std_string(begin + index * LOOM_RECORD + name)).collect()
}

/// The pattern list indices the open loom offers now, in button order.
fn loom_offered(controller: usize) -> Option<Vec<i32>> {
    let at = LOOM_OFFERED.load(Ordering::Acquire);
    if at == 0 {
        return None;
    }
    let (begin, end) = (pe::read::<usize>(controller + at)?, pe::read::<usize>(controller + at + 8)?);
    if end < begin || (end - begin) % 4 != 0 || (end - begin) / 4 > 256 {
        return None;
    }
    (0..(end - begin) / 4).map(|index| pe::read::<i32>(begin + index * 4)).collect()
}

/// `screen.state.data`: the open screen's own state, for the kinds whose state is decoded; `null` for a
/// screen with no state of its own or one not decoded yet. A state that is decoded but not readable now
/// answers `{unavailable: reason}` rather than failing the whole `screen.state`.
fn screen_data(kind: &str) -> Value {
    let data = match kind {
        "stonecutter" => stonecutter_data(),
        "enchanting_table" => enchanting_data(),
        "trade" => trade_data(),
        "furnace" | "blast_furnace" | "smoker" => furnace_data(),
        "anvil" => anvil_data(),
        "brewing_stand" => brewing_data(),
        "grindstone" => result_screen_data(&GRINDSTONE_TAKE, GRINDSTONE_PREVIEW),
        "smithing_table" => result_screen_data(&SMITHING_TAKE, SMITHING_PREVIEW),
        "cartography_table" => result_screen_data(&CARTOGRAPHY_TAKE, CARTOGRAPHY_PREVIEW),
        "beacon" => beacon_data(),
        "loom" => loom_data(),
        _ => return Value::Null,
    };
    data.unwrap_or_else(|error| {
        // The reason in words when the error carries one (`data.message`), else the error's own message.
        let detail = error.data.as_ref().and_then(|data| data.get("message")).and_then(Value::as_str).map(String::from);
        json!({ "unavailable": detail.unwrap_or(error.message), "anchor": error.anchor })
    })
}

/// The stonecutter's recipe list for the item in its input, as its own refresh builds it (the game's list
/// builder, called on the model with the input stack; the vector it fills is destroyed and freed here the
/// way the refresh does), and the selected index (`-1` = none). `recipe` in `screen.act stonecut` is an
/// `index` of this list.
fn stonecutter_data() -> Result<Value, RpcError> {
    let (list, selection) = (STONECUTTER_LIST.load(Ordering::Acquire), STONECUTTER_SELECTION.load(Ordering::Acquire));
    if list == 0 || selection == 0 {
        return Err(RpcError::anchor("screen.stonecutter_list"));
    }
    let controller = screen_manager(handler(H_STONECUTTER)?, "screen.stonecutter")?;
    let model = model_of(controller).ok_or_else(|| RpcError::anchor("screen.stonecutter"))?;
    let selected = pe::read::<i32>(model + selection);
    let open = open_containers()?;
    let input = open_named(&open, "StonecutterInputContainer").and_then(|input| input.item(0)).filter(|item| count_of(*item) != 0);
    let mut recipes = Vec::new();
    if let Some(input) = input {
        let mut vector = [0usize; 3];
        // SAFETY: the game's own recipe list builder, called as the refresh calls it: the model of the open
        // stonecutter's validated controller, an empty vector to fill and the input stack it shows.
        input::with_item_scope(|| unsafe { transmute::<usize, extern "C" fn(usize, *mut usize, usize)>(list)(model, vector.as_mut_ptr(), input) })?;
        let [begin, end, capacity] = vector;
        if begin != 0 && end >= begin && capacity >= end && (end - begin) % STONECUTTER_ENTRY == 0 && (end - begin) / STONECUTTER_ENTRY <= 512 {
            for (index, entry) in (begin..end).step_by(STONECUTTER_ENTRY).enumerate() {
                recipes.push(json!({
                    "index": index,
                    "result": inventory::slot(entry),
                    "netId": pe::read::<u32>(entry + ITEM_INSTANCE_SIZE),
                }));
            }
            for entry in (begin..end).step_by(STONECUTTER_ENTRY) {
                if let Some(destroy) = pe::read::<usize>(entry).and_then(|table| pe::read::<usize>(table)).filter(|entry| pe::in_image_code(*entry)) {
                    // SAFETY: the entry's own scalar destructor without the free (flag 0), as the refresh runs it.
                    unsafe { transmute::<usize, extern "C" fn(usize, u32) -> usize>(destroy)(entry, 0) };
                }
            }
            deallocate(begin, capacity - begin);
        }
    }
    let result = selected.and_then(|index| usize::try_from(index).ok()).and_then(|index| recipes.get(index)).map_or(Value::Null, |recipe| recipe["result"].clone());
    Ok(json!({ "recipes": recipes, "selected": selected, "result": result }))
}

/// One enchanting option (`ItemEnchantOption`, 0x80 bytes, in the model's option vector): `+0x00` the cost
/// in levels, `+0x08` the enchantments it would apply (`ItemEnchants`: an `i32` slot, then three vectors
/// of `{u8 id, i32 level}` at `+0x10`/`+0x28`/`+0x40`), `+0x58` the hint name (`std::string`), `+0x78` its
/// net id (the enchant handler reads it there).
const OPTION_COST: usize = 0x00;
const OPTION_ENCHANTS: [usize; 3] = [0x10, 0x28, 0x40];
const OPTION_NAME: usize = 0x58;
const OPTION_NET_ID: usize = 0x78;

/// The enchanting table's three options as the model holds them (`[]` with no item or lapis).
///
/// The option record holds the level the option needs (`cost`), not what it takes: option `n` takes
/// `n + 1` lapis and `n + 1` levels. The game's own screen draws that lapis cost by button position (the
/// enchanting screen's dust grid shows `dust_selectable_1` to `_3` on rows 0 to 2), and 1.26.63.1 took 2
/// lapis and 2 levels for option 1 with 17 needed (live, survival).
fn enchanting_data() -> Result<Value, RpcError> {
    let controller = screen_field_manager(ENCHANT_FIELD.load(Ordering::Acquire), "screen.enchanting")?;
    let count = enchant_options(controller)?;
    let model = model_of(controller).ok_or_else(|| RpcError::anchor("screen.enchanting"))?;
    let begin = pe::read::<usize>(model + ENCHANT_OPTIONS.load(Ordering::Acquire)).unwrap_or(0);
    let mut options = Vec::new();
    for index in 0..count {
        let option = begin + index * ENCHANT_OPTION_SIZE;
        let mut enchants = Vec::new();
        for at in OPTION_ENCHANTS {
            let (Some(first), Some(last)) = (pe::read::<usize>(option + at), pe::read::<usize>(option + at + 8)) else {
                continue;
            };
            if first == 0 || last < first || (last - first) % 8 != 0 || (last - first) / 8 > 16 {
                continue;
            }
            for entry in (first..last).step_by(8) {
                if let (Some(id), Some(level)) = (pe::read::<u8>(entry), pe::read::<i32>(entry + 4)) {
                    enchants.push(json!({ "id": id, "level": level }));
                }
            }
        }
        let level = enchants.first().map(|first| first["level"].clone()).unwrap_or(Value::Null);
        let hint = pe::std_string(option + OPTION_NAME).filter(|name| name.len() <= 64 && name.bytes().all(|byte| byte.is_ascii_graphic() || byte == b' '));
        options.push(json!({
            "option": index,
            "cost": pe::read::<i32>(option + OPTION_COST).filter(|cost| (0..=1000).contains(cost)),
            "hint": hint,
            "level": level,
            "lapis": index + 1,
            "levelsTaken": index + 1,
            "enchants": enchants,
            "netId": pe::read::<u32>(option + OPTION_NET_ID),
        }));
    }
    Ok(json!({ "options": options }))
}

/// A [`station_items`] reading kept in a parked answer, and read back by [`stations_from`].
fn stations_json(items: &[(String, u32)]) -> Value {
    Value::Array(items.iter().map(|(name, count)| json!([name, count])).collect())
}

fn stations_from(value: &Value) -> Vec<(String, u32)> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|pair| Some((String::from(pair.get(0)?.as_str()?), pair.get(1)?.as_u64()? as u32)))
                .collect()
        })
        .unwrap_or_default()
}

/// What left the screen's containers between two readings, as `[{item, count}]`.
fn consumed_between(before: &[(String, u32)], after: &[(String, u32)]) -> Vec<Value> {
    let total = |list: &[(String, u32)], name: &str| list.iter().filter(|(known, _)| known == name).map(|(_, count)| *count).sum::<u32>();
    let mut names: Vec<&str> = before.iter().map(|(name, _)| name.as_str()).collect();
    names.dedup();
    let mut out = Vec::new();
    for name in names {
        if out.iter().any(|entry: &Value| entry["item"] == name) {
            continue;
        }
        let gone = total(before, name).saturating_sub(total(after, name));
        if gone != 0 {
            out.push(json!({ "item": name, "count": gone }));
        }
    }
    out
}

/* ------------------------------------------------------------------------------------------------
 * craft.run
 * ---------------------------------------------------------------------------------------------- */

/// The crafting grid.
const CRAFTING_INPUT: &str = "CraftingInputContainer";
/// The carried containers a craft takes its ingredients from (the combined view only when neither is open).
const SOURCES: [&str; 2] = ["HotbarContainer", "InventoryContainer"];
const COMBINED: &str = "CombinedHotbarAndInventoryContainer";
/// The protocol's first crafting-grid slot of the 3x3 and the 2x2 grid (the player UI container's
/// numbering), used when the grid container reports that numbering.
const GRID_BASE_LARGE: usize = 32;
const GRID_BASE_SMALL: usize = 28;
/// How long the grid's preview gets to show the recipe after the ingredients landed.
const PREVIEW_MS: u64 = 1_500;
/// A stack this module puts on another never grows past this.
const STACK_MAX: u32 = 64;

#[derive(Clone, Copy, PartialEq, Eq)]
enum CraftStage {
    /// The placements went out; waiting for every answer.
    Place,
    /// Waiting for the grid's preview to show the recipe's result.
    Preview,
    /// The crafting screen's own take (with the move into the inventory) went out; waiting for its answer.
    Take,
}

/// A `craft.run` between its steps.
pub(crate) struct CraftRun {
    stage: CraftStage,
    /// The requests of the current stage.
    ids: Vec<i32>,
    times: u32,
    controller: usize,
    entry: usize,
    /// What the recipe makes (`minecraft:…`), and the answer's slot for it once crafted.
    makes: String,
    result: Value,
    /// The container the result was moved into (as `screen.state` names it).
    to: String,
    consumed: Vec<Value>,
    /// Set by a step that began a new stage: the settle timer restarts its clock.
    restarted: bool,
}

/// The answer of a craft that made nothing.
fn craft_failure(reason: String, consumed: Vec<Value>) -> Value {
    json!({ "crafted": 0, "done": false, "result": null, "consumed": consumed, "reason": reason })
}

impl CraftRun {
    fn failed(self, reason: String) -> Value {
        // Placed ingredients stay in the grid when a later step fails: say so instead of reporting them
        // as consumed.
        let reason = if self.stage == CraftStage::Place {
            reason
        } else {
            format!("{reason}; the ingredients are in the crafting grid")
        };
        let mut answer = craft_failure(reason, Vec::new());
        answer["stage"] = Value::String(String::from(match self.stage {
            CraftStage::Place => "place",
            CraftStage::Preview => "preview",
            CraftStage::Take => "take",
        }));
        answer
    }

    fn crafted(self, to: Option<&str>, reason: Option<String>) -> Value {
        let mut answer = json!({
            "crafted": self.times,
            "done": true,
            "result": self.result,
            "consumed": self.consumed,
        });
        if let Some(to) = to {
            answer["to"] = Value::String(String::from(to));
        }
        if let Some(reason) = reason {
            answer["reason"] = Value::String(reason);
        }
        answer
    }

    fn begin(&mut self, stage: CraftStage, ids: Vec<i32>) {
        self.stage = stage;
        self.ids = ids;
        self.restarted = true;
    }

    /// One look from the settle timer (on the window's thread): `Some(answer)` once the craft is over.
    fn step(&mut self, elapsed: u64) -> Option<Value> {
        let finish = |run: &mut Self, reason: String| {
            let taken = core::mem::replace(run, run.placeholder());
            Some(taken.failed(reason))
        };
        match self.stage {
            CraftStage::Place => {
                let answers: Vec<Option<u8>> = self.ids.iter().map(|id| response(*id)).collect();
                if let Some(code) = answers.iter().flatten().find(|code| **code != 0) {
                    return finish(self, format!("the server refused placing an ingredient (ItemStackNetResult {code})"));
                }
                if answers.iter().all(Option::is_some) {
                    self.begin(CraftStage::Preview, Vec::new());
                    return None;
                }
                (elapsed >= RESPONSE_MS).then(|| finish(self, String::from("the server did not answer placing the ingredients in time"))).flatten()
            }
            CraftStage::Preview => {
                // The grid's preview, when the screen lists it, must show the recipe before the take; this
                // build's inventory and crafting table screens do not list it, and then the server's answers
                // to the placements (all accepted) are what the take relies on, as a click right after the
                // drags does.
                let listed = open_containers().ok().is_some_and(|open| open_named(&open, CRAFTING_PREVIEW).is_some());
                let shown = preview(CRAFTING_PREVIEW);
                if listed {
                    let makes = shown.as_ref().and_then(|(slot, _)| slot.get("item").and_then(Value::as_str).map(String::from));
                    if makes.as_deref() != Some(self.makes.as_str()) {
                        if elapsed < PREVIEW_MS {
                            return None;
                        }
                        let showing = makes.unwrap_or_else(|| String::from("nothing"));
                        return finish(self, format!("the crafting grid shows {showing}, not {}", self.makes));
                    }
                }
                let per_craft = shown
                    .as_ref()
                    .map(|(_, count)| *count)
                    .or_else(|| self.result.get("count").and_then(Value::as_u64).and_then(|count| u8::try_from(count).ok()));
                let amount = match amount_for(self.times, per_craft) {
                    Ok(amount) => amount,
                    Err(error) => return finish(self, reason_of(&error)),
                };
                let (name, key, slot) = match empty_carried_slot() {
                    Ok(target) => target,
                    Err(error) => return finish(self, reason_of(&error)),
                };
                let to = SlotData { name: ConstString::new(&name), index: slot as i32, pad: 0 };
                match craft_through(self.controller, self.entry, amount, &to) {
                    Ok((id, actions)) if actions > 0 => {
                        if let Some(per_craft) = per_craft {
                            self.result["count"] = Value::from(per_craft as u32 * self.times);
                        }
                        self.to = key;
                        self.begin(CraftStage::Take, alloc::vec![id]);
                        None
                    }
                    Ok(_) => finish(self, String::from("the crafting screen's own handler built no request")),
                    Err(error) => finish(self, reason_of(&error)),
                }
            }
            CraftStage::Take => match self.ids.first().and_then(|id| response(*id)) {
                Some(0) => {
                    let run = core::mem::replace(self, self.placeholder());
                    let to = run.to.clone();
                    Some(run.crafted(Some(&to), None))
                }
                Some(code) => finish(self, format!("the server refused the craft (ItemStackNetResult {code})")),
                None => (elapsed >= RESPONSE_MS).then(|| finish(self, String::from("the server did not answer the craft in time"))).flatten(),
            },
        }
    }

    /// An empty run with this one's stage, left behind when the run itself is moved into its answer.
    fn placeholder(&self) -> Self {
        CraftRun {
            stage: self.stage,
            ids: Vec::new(),
            times: 0,
            controller: 0,
            entry: 0,
            makes: String::new(),
            result: Value::Null,
            to: String::new(),
            consumed: Vec::new(),
            restarted: false,
        }
    }
}

/// An error's human reason: its `data.message` (where `invalid_params` and anchors keep it), else its message.
fn reason_of(error: &RpcError) -> String {
    error
        .data
        .as_ref()
        .and_then(|data| data.get("message"))
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| error.message.clone())
}

/// The carried containers open on this screen: the hotbar and the inventory, or the combined view.
fn carried(open: &[Open]) -> Vec<&Open> {
    let separate: Vec<&Open> = SOURCES.iter().filter_map(|name| open_named(open, name)).collect();
    if separate.is_empty() {
        open_named(open, COMBINED).into_iter().collect()
    } else {
        separate
    }
}

/// One stack the player carries, for the plan.
struct Source<'a> {
    container: &'a Open,
    slot: usize,
    stack: usize,
    name: String,
    item: Option<usize>,
    left: u32,
}

/// One placement: `amount` from source `source` into grid cell `cell`.
struct Piece {
    source: usize,
    cell: usize,
    amount: u32,
}

/// Where each of `recipe`'s ingredients goes on a `side`×`side` grid and which carried stacks fill it for
/// `times` crafts, or the first ingredient nothing carried can fill.
fn plan(recipe: &inventory::Recipe, side: usize, times: u32, sources: &mut [Source]) -> Result<Vec<Piece>, String> {
    let mut cells: Vec<(usize, &inventory::Ingredient, u32)> = Vec::new();
    if recipe.shapeless {
        for (index, (ingredient, count)) in recipe.needed().enumerate() {
            cells.push((index, ingredient, *count as u32 * times));
        }
    } else {
        for y in 0..recipe.height {
            for x in 0..recipe.width {
                let (ingredient, count) = &recipe.ingredients[y * recipe.width + x];
                if !matches!(ingredient, inventory::Ingredient::Empty) {
                    cells.push((y * side + x, ingredient, *count as u32 * times));
                }
            }
        }
    }
    let mut pieces = Vec::new();
    for (cell, ingredient, need) in cells {
        if need > STACK_MAX {
            return Err(format!("{need} items in one grid cell is more than a stack: lower times"));
        }
        // One stack that covers the whole cell first, so a cell takes one placement when it can.
        let whole = sources.iter().position(|source| source.left >= need && inventory::accepts(ingredient, &source.name, source.item));
        let mut left = need;
        if let Some(index) = whole {
            sources[index].left -= need;
            pieces.push(Piece { source: index, cell, amount: need });
            left = 0;
        }
        for (index, source) in sources.iter_mut().enumerate() {
            if left == 0 {
                break;
            }
            if source.left == 0 || !inventory::accepts(ingredient, &source.name, source.item) {
                continue;
            }
            let amount = left.min(source.left);
            source.left -= amount;
            left -= amount;
            pieces.push(Piece { source: index, cell, amount });
        }
        if left > 0 {
            return Err(match ingredient {
                inventory::Ingredient::Item(item) => inventory::item_identifier(*item).unwrap_or_default(),
                inventory::Ingredient::Name(name) => name.clone(),
                inventory::Ingredient::Tag(tag) => format!("an item tagged {tag}"),
                _ => String::from("an ingredient this reader cannot decode"),
            });
        }
    }
    Ok(pieces)
}

/// `craft.run {recipe, times?}` → `{crafted, result, consumed, to?, reason?}`, as a player crafts by hand on
/// the open crafting screen (the crafting table, or the inventory's 2x2 grid):
///
/// 1. the recipe is the client registry's own (by recipe id, else by what it makes), and its ingredients
///    are planned from the carried stacks with the same matcher as `craft.match`;
/// 2. each ingredient is placed into its grid cell (`Place` requests, as dragging does);
/// 3. once the server accepted every placement (and the grid's preview, where the screen lists it, shows the
///    recipe's result), the crafting screen's own take crafts `times` and, in the same request, its click
///    path moves the result into the first empty hotbar or inventory slot (`to` names that container).
///
/// The grid must be empty. A step that fails answers `crafted: 0` and names the stage; ingredients placed
/// by then stay in the grid.
pub(crate) fn craft_run(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    expire(core);
    world()?;
    let wanted = required_text(params, "recipe", "craft.run")?;
    let times = match params.get("times") {
        None | Some(Value::Null) => 1,
        Some(value) => value
            .as_u64()
            .filter(|times| (1..=64).contains(times))
            .ok_or_else(|| RpcError::invalid_params("times must be a whole number from 1 to 64"))? as u32,
    };
    let screen = require_screen(core, &["crafting_table", "inventory"], "craft.run")?;
    let table = kind_of(&screen) == "crafting_table";
    if !requests_ready() {
        return Err(RpcError::anchor("screen.request"));
    }
    if !core.is_main_thread() || !ensure_timer() {
        return Err(RpcError::anchor("window.game"));
    }
    let entry = handler(H_CRAFT)?;
    let controller = screen_manager(handler(H_CRAFT_SLOT)?, "screen.craft")?;

    let recipes = inventory::recipes(Some(inventory::CRAFTING_TAG))?;
    let named = inventory::namespaced(&wanted);
    let mut candidates: Vec<&inventory::Recipe> = recipes.iter().filter(|recipe| recipe.id == wanted || recipe.id == named).collect();
    if candidates.is_empty() {
        candidates = recipes.iter().filter(|recipe| recipe.result_id().as_deref() == Some(named.as_str())).collect();
    }
    if candidates.is_empty() {
        return Err(RpcError::invalid_params(format!("no crafting recipe is named {wanted} or makes {named}")));
    }
    let fitting: Vec<&inventory::Recipe> = candidates.iter().copied().filter(|recipe| table || recipe.fits_small()).collect();
    if fitting.is_empty() {
        return Err(RpcError::invalid_params(format!("{wanted} needs the 3x3 grid: open a crafting table")));
    }

    let open = open_containers()?;
    let grid = open_named(&open, CRAFTING_INPUT).ok_or_else(|| {
        let names: Vec<Value> = open.iter().map(|open| Value::String(open.key())).collect();
        RpcError::anchor("screen.crafting_input").with_data(json!({ "message": "the crafting grid is not in the screen's containers", "open": names }))
    })?;
    let side = if table { 3 } else { 2 };
    // The grid's cells among the name's slots: exactly the grid, or (when the name covers both grids, or
    // the whole UI container) the run starting at the protocol's first cell of this grid.
    let start = if table { GRID_BASE_LARGE } else { GRID_BASE_SMALL };
    let base = if grid.size == side * side {
        0
    } else {
        grid.slots.iter().position(|slot| *slot as usize == start).unwrap_or(0)
    };
    if grid.size < base + side * side {
        return Err(RpcError::anchor("screen.crafting_input").with_data(json!({ "message": format!("the crafting grid holds {} slots", grid.size) })));
    }
    if (0..side * side).any(|cell| grid.item(base + cell).is_some_and(|item| count_of(item) != 0)) {
        return Err(RpcError::invalid_params("the crafting grid is not empty: move its items out first (screen.move)"));
    }

    let containers = carried(&open);
    let mut sources: Vec<Source> = Vec::new();
    for container in &containers {
        for slot in 0..container.size {
            let Some(stack) = container.item(slot).filter(|stack| count_of(*stack) != 0) else {
                continue;
            };
            let Some(name) = inventory::slot(stack).and_then(|value| value.get("item").and_then(Value::as_str).map(String::from)) else {
                continue;
            };
            sources.push(Source { container, slot, stack, name, item: inventory::stack_item(stack), left: count_of(stack) as u32 });
        }
    }
    let mut chosen = None;
    // What each recipe lacks: several recipes can make one item (a crafting table from any planks), and
    // naming only the first one's (`crimson_planks`) misleads a player holding none of them.
    let mut missing: Vec<String> = Vec::new();
    for recipe in &fitting {
        for source in sources.iter_mut() {
            source.left = count_of(source.stack) as u32;
        }
        match plan(recipe, side, times, &mut sources) {
            Ok(pieces) => {
                chosen = Some((*recipe, pieces));
                break;
            }
            Err(what) => {
                if !missing.contains(&what) {
                    missing.push(what);
                }
            }
        }
    }
    let Some((recipe, pieces)) = chosen else {
        let lacks = match missing.len() {
            1 => missing.remove(0),
            _ => format!("one of {}", missing.join(", ")),
        };
        return Err(RpcError::invalid_params(format!("the inventory lacks {lacks} for {times} × {wanted}")));
    };
    let makes = recipe.result_id().ok_or_else(|| RpcError::anchor("craft.recipe").with_data(json!({ "message": "the recipe's result is not readable" })))?;

    let mut consumed: Vec<(String, u32)> = Vec::new();
    let mut ids = Vec::with_capacity(pieces.len());
    for piece in &pieces {
        let source = &sources[piece.source];
        let cell = base + piece.cell;
        if grid.item(cell).is_none() {
            return Err(RpcError::anchor("screen.crafting_input"));
        }
        let sent = move_through(PLACE, (source.container, source.slot), (grid, cell), piece.amount as u8);
        match sent {
            Ok(id) => ids.push(id),
            Err(error) if ids.is_empty() => return Err(error),
            Err(error) => {
                return Err(error.with_data(json!({ "placed": ids.len(), "message": "some ingredients are already in the crafting grid" })));
            }
        }
        match consumed.iter_mut().find(|(name, _)| *name == source.name) {
            Some((_, count)) => *count += piece.amount,
            None => consumed.push((source.name.clone(), piece.amount)),
        }
    }
    let consumed = consumed.into_iter().map(|(item, count)| json!({ "item": item, "count": count })).collect();
    let run = CraftRun {
        stage: CraftStage::Place,
        ids,
        times,
        controller,
        entry,
        makes,
        result: recipe.result(),
        to: String::new(),
        consumed,
        restarted: false,
    };
    park_with(core, screen, Phase::Craft, None, Some(run))
}

/* ------------------------------------------------------------------------------------------------
 * screen.act
 * ---------------------------------------------------------------------------------------------- */

/// The actions `screen.act` takes.
const ACTIONS: [&str; 11] = [
    "craft",
    "stonecut",
    "anvil",
    "grindstone",
    "smithing",
    "loom",
    "cartography",
    "enchant",
    "trade",
    "beacon",
    "take_result",
];

/// `screen.act {action, …}` → `{done, result, consumed, reason?, to?}` once the server answered.
///
/// Every action is the request the screen's own controller builds, run inside one request this module opens
/// (see [`in_request`]): the enchanting table's `enchant(option)`, the beacon's payment, and every other
/// screen's own result handler — the one a click on the result slot runs — after the screen's selection (a
/// stonecutter recipe, a loom pattern, a trade offer, an anvil name) is set where the screen keeps it. A
/// result handler puts the result in the created-output slot; the take then moves it, as the click does,
/// into the first empty hotbar or inventory slot (`to` names that container).
pub(crate) fn h_screen_act(core: &'static Core, params: &Value) -> Result<Value, RpcError> {
    expire(core);
    world()?;
    let action = params
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| RpcError::invalid_params("action is required"))?;
    if !ACTIONS.contains(&action) {
        return Err(RpcError::invalid_params(format!("action must be one of {}", ACTIONS.join(", "))));
    }
    let mut times = 1u32;
    if let Some(value) = params.get("times") {
        let value = value
            .as_u64()
            .ok_or_else(|| RpcError::invalid_params("times must be a whole number from 1 to 64"))?;
        if !(1..=64).contains(&value) {
            return Err(RpcError::invalid_params("times must be a whole number from 1 to 64"));
        }
        times = value as u32;
    }
    match action {
        "craft" => {
            let recipe = optional_text(params, "recipe")?;
            let screen = require_screen(core, &["crafting_table", "inventory", "crafter"], action)?;
            if kind_of(&screen) == "crafter" {
                // The crafter's screen runs the plain container manager controller: it has no result to
                // take and no crafting handler (calling the crafting table's on it faults in the game).
                return Err(RpcError::invalid_params(
                    "a crafter crafts when a redstone pulse reaches it, not from its screen: place the recipe with screen.move, close the screen and power the crafter (a button, or setblock a redstone_block next to it); the result drops out of its face",
                ));
            }
            // An empty grid and a recipe: the whole craft as `craft.run` does it (place, then take). The
            // take alone on an empty grid throws inside the game (live: `sculk craft run crafting_table`
            // on the inventory screen, "the handler faulted inside the game's frame").
            let open = open_containers()?;
            let grid_empty = open_named(&open, CRAFTING_INPUT)
                .is_some_and(|grid| (0..grid.size).all(|cell| grid.item(cell).is_none_or(|item| count_of(item) == 0)));
            if recipe.is_some() && grid_empty {
                return craft_run(core, params);
            }
            let entry = handler(H_CRAFT)?;
            let controller = screen_manager(handler(H_CRAFT_SLOT)?, "screen.craft")?;
            // What the grid makes now: the crafting screen's own preview (the client's own recipe match).
            let shown = preview(CRAFTING_PREVIEW);
            if shown.is_none() && (grid_empty || open_named(&open, CRAFTING_PREVIEW).is_some()) {
                return Err(RpcError::invalid_params(
                    "the crafting grid makes nothing: name a recipe on an empty grid, or place a recipe's ingredients with screen.move first",
                ));
            }
            if let (Some(wanted), Some((slot, _))) = (recipe.as_deref().filter(|text| text.contains(':')), shown.as_ref()) {
                let makes = slot.get("item").and_then(Value::as_str).unwrap_or("");
                if makes != wanted {
                    return Err(RpcError::invalid_params(format!("the crafting grid makes {makes}, not {wanted}: place that recipe's ingredients with screen.move")));
                }
            }
            let amount = amount_for(times, shown.as_ref().map(|(_, count)| *count))?;
            let (name, key, slot) = empty_carried_slot()?;
            let to = SlotData { name: ConstString::new(&name), index: slot as i32, pad: 0 };
            let before = open_containers().map(|open| station_items(&open)).unwrap_or_default();
            let (id, actions) = craft_through(controller, entry, amount, &to)?;
            if actions == 0 {
                return Err(RpcError::invalid_params(
                    "the crafting screen's own handler built no request: the grid makes nothing (place a recipe's ingredients with screen.move first)",
                ));
            }
            let consumed = open_containers().map(|open| consumed_between(&before, &station_items(&open))).unwrap_or_default();
            let answer = json!({ "result": shown.map(|(slot, _)| slot), "consumed": consumed, "to": key, "slot": slot });
            park(core, screen, Phase::Request { id, moved: 0, take: true, cursor: false }, Some(answer))
        }
        "stonecut" => {
            let recipe = index_param(params, "recipe", 256)?;
            let screen = require_screen(core, &["stonecutter"], action)?;
            let input = open_containers()
                .ok()
                .and_then(|open| open_named(&open, "StonecutterInputContainer").map(|input| input.item(0).map_or(0, count_of)));
            if input == Some(0) {
                return Err(RpcError::invalid_params("the stonecutter's input is empty: place the block to cut first (screen.move)"));
            }
            // One craft uses one input block, and the server refuses a take of more than the input makes:
            // `times` is capped at what is there.
            let times = input.map_or(times, |input| times.min(u32::from(input)));
            let controller = screen_manager(handler(H_STONECUTTER)?, "screen.stonecutter")?;
            let selection = STONECUTTER_SELECTION.load(Ordering::Acquire);
            let refresh = handler(H_STONECUTTER_REFRESH)?;
            let model = model_of(controller).ok_or_else(|| RpcError::anchor("screen.stonecutter"))?;
            if selection == 0 || !pe::writable(model + selection, 4) {
                return Err(RpcError::anchor("screen.stonecutter_refresh"));
            }
            // SAFETY: the model's own selected-index field, written as the recipe button does, then the
            // controller's own preview refresh, which reads it (and clamps an index past the list to empty).
            unsafe { core::ptr::write_unaligned((model + selection) as *mut i32, recipe as i32) };
            // SAFETY: the controller's own preview refresh, which reads the index (and clamps one past the
            // list to empty), inside the item-registry scope it needs.
            input::with_item_scope(|| unsafe { transmute::<usize, extern "C" fn(usize)>(refresh)(controller) })?;
            take_screen(core, screen, controller, &STONECUTTER_TAKE, times)
        }
        "anvil" => {
            let name = optional_text(params, "name")?;
            let screen = require_screen(core, &["anvil"], action)?;
            let controller = screen_manager(handler(H_ANVIL)?, "screen.anvil")?;
            if let Some(name) = name {
                let update = handler(H_ANVIL_UPDATE)?;
                if !has_slot(controller, update) {
                    return Err(RpcError::anchor("screen.anvil_update"));
                }
                let text = anvil_text(controller)?;
                write_string(text, &name)?;
                // SAFETY: the anvil controller's own update slot (checked in its table): it recomputes the
                // preview, its cost and its name from the inputs and the text.
                input::with_item_scope(|| unsafe { transmute::<usize, extern "C" fn(usize)>(update)(controller) })?;
            }
            take_screen(core, screen, controller, &ANVIL_TAKE, 1)
        }
        "grindstone" => {
            let screen = require_screen(core, &["grindstone"], action)?;
            let controller = screen_manager(handler(H_GRINDSTONE)?, "screen.grindstone")?;
            take_screen(core, screen, controller, &GRINDSTONE_TAKE, 1)
        }
        "smithing" => {
            let screen = require_screen(core, &["smithing_table"], action)?;
            let controller = screen_manager(handler(H_SMITHING)?, "screen.smithing")?;
            take_screen(core, screen, controller, &SMITHING_TAKE, 1)
        }
        "loom" => {
            let pattern = required_text(params, "pattern", action)?;
            let screen = require_screen(core, &["loom"], action)?;
            let controller = screen_manager(handler(H_LOOM)?, "screen.loom")?;
            let select = LOOM_SELECT.load(Ordering::Acquire);
            let (Some(names), Some(offered)) = (loom_patterns(), loom_offered(controller)) else {
                return Err(RpcError::anchor("screen.loom_select"));
            };
            if select == 0 {
                return Err(RpcError::anchor("screen.loom_select"));
            }
            let offered_names = || offered.iter().filter_map(|index| names.get(*index as usize).cloned()).collect::<Vec<_>>().join(", ");
            let Some(index) = names.iter().position(|name| *name == pattern) else {
                return Err(RpcError::invalid_params(format!("no banner pattern is named {pattern}: the game's patterns are {}", names.join(", "))));
            };
            let Some(button) = offered.iter().position(|offer| *offer as usize == index) else {
                return Err(RpcError::invalid_params(format!(
                    "the loom does not offer {pattern} now (place a banner and a dye; a banner pattern item adds its own patterns); it offers: {}",
                    offered_names()
                )));
            };
            // SAFETY: the loom's own pattern button on the validated loom controller with a button the screen
            // offers now: it records the pattern and rebuilds the result preview (item stacks are copied, so
            // it runs in the item-registry scope).
            input::with_item_scope(|| unsafe { transmute::<usize, extern "C" fn(usize, u32)>(select)(controller, button as u32) })?;
            take_screen(core, screen, controller, &LOOM_TAKE, 1)
        }
        "cartography" => {
            let screen = require_screen(core, &["cartography_table"], action)?;
            let controller = screen_manager(handler(H_CARTOGRAPHY)?, "screen.cartography")?;
            take_screen(core, screen, controller, &CARTOGRAPHY_TAKE, 1)
        }
        "enchant" => {
            let option = index_param(params, "option", 3)?;
            let screen = require_screen(core, &["enchanting_table"], action)?;
            let entry = handler(H_ENCHANT)?;
            let controller = screen_field_manager(ENCHANT_FIELD.load(Ordering::Acquire), "screen.enchanting")?;
            let offered = enchant_options(controller)?;
            if option as usize >= offered {
                return Err(RpcError::invalid_params(format!(
                    "the enchanting table offers {offered} option(s) now (place an enchantable item and lapis first)"
                )));
            }
            let before = open_containers().map(|open| station_items(&open)).unwrap_or_default();
            // SAFETY: the enchanting screen's own `enchant(option)` on the controller the screen itself passes
            // it (its field, validated), with an option the model lists.
            let (id, actions) = in_request(|| unsafe { transmute::<usize, extern "C" fn(usize, u32)>(entry)(controller, option) })?;
            if actions == 0 {
                return Err(RpcError::invalid_params(
                    "the enchanting table offers no such option now (place an enchantable item and lapis first)",
                ));
            }
            let made = preview("EnchantingInputContainer").map_or(Value::Null, |(slot, _)| slot);
            let answer = json!({ "result": made, "consumed": [], "before": stations_json(&before) });
            park(core, screen, Phase::Request { id, moved: 0, take: true, cursor: false }, Some(answer))
        }
        "trade" => {
            let offer = index_param(params, "offer", 64)?;
            let screen = require_screen(core, &["trade"], action)?;
            if let Some(controller) = handler(H_TRADE2).ok().and_then(|entry| screen_manager(entry, "screen.trade2").ok()) {
                // The tier-2 screen's offer is the one clicked in its list: the screen's own select (it
                // bounds-checks the index against the trader's offers, records it on the controller and the
                // model and refreshes the result preview from the ingredient slots).
                let select = TRADE2_SELECT.load(Ordering::Acquire);
                if select == 0 {
                    return Err(RpcError::anchor("screen.trade2_select"));
                }
                // SAFETY: the tier-2 controller's own offer select on the validated controller; it copies item
                // stacks, so it runs inside the item-registry scope.
                input::with_item_scope(|| unsafe { transmute::<usize, extern "C" fn(usize, u32)>(select)(controller, offer) })?;
                return take_screen(core, screen, controller, &TRADE2_TAKE, times);
            }
            let controller = screen_manager(handler(H_TRADE)?, "screen.trade")?;
            let selection = TRADE_SELECTION.load(Ordering::Acquire);
            let model = model_of(controller).ok_or_else(|| RpcError::anchor("screen.trade"))?;
            if selection == 0 || !pe::writable(model + selection, 4) {
                return Err(RpcError::anchor("screen.trade"));
            }
            // SAFETY: the trade model's own selected-offer index, which the trade handler bounds-checks.
            unsafe { core::ptr::write_unaligned((model + selection) as *mut i32, offer as i32) };
            take_screen(core, screen, controller, &TRADE_TAKE, times)
        }
        "beacon" => {
            let primary = beacon_effect(params, "primary")?.ok_or_else(|| RpcError::invalid_params("beacon needs primary: the effect to pay for"))?;
            let secondary = beacon_effect(params, "secondary")?.unwrap_or(0);
            let screen = require_screen(core, &["beacon"], action)?;
            let entry = handler(H_BEACON)?;
            let controller = screen_field_manager(BEACON_FIELD.load(Ordering::Acquire), "screen.beacon")?;
            let selection = BEACON_SELECTION.load(Ordering::Acquire);
            let model = model_of(controller).ok_or_else(|| RpcError::anchor("screen.beacon"))?;
            if selection == 0 || !pe::writable(model + selection, 8) {
                return Err(RpcError::anchor("screen.beacon"));
            }
            // SAFETY: the beacon model's own two effect fields (what its effect buttons set), then its own
            // payment, which sends them with the payment item's removal.
            unsafe {
                core::ptr::write_unaligned((model + selection) as *mut u32, primary);
                core::ptr::write_unaligned((model + selection + 4) as *mut u32, secondary);
            }
            let before = open_containers().map(|open| station_items(&open)).unwrap_or_default();
            let (id, actions) = in_request(|| unsafe { transmute::<usize, extern "C" fn(usize)>(entry)(controller) })?;
            if actions == 0 {
                return Err(RpcError::invalid_params("the beacon built no payment"));
            }
            // The payment leaves the beacon's slot as the server takes it: the answer counts it then.
            let answer = json!({ "result": Value::Null, "consumed": [], "before": stations_json(&before) });
            park(core, screen, Phase::Request { id, moved: 0, take: true, cursor: false }, Some(answer))
        }
        _ => take_result(core),
    }
}

/// The anvil controller's rename text field: the address its own getter slot returns (`lea rax,[rcx+X]; ret`).
fn anvil_text(controller: usize) -> Result<usize, RpcError> {
    let slot = ANVIL_TEXT_SLOT.load(Ordering::Acquire);
    let table = pe::read::<usize>(controller).filter(|table| pe::in_image_data(*table));
    let getter = table.and_then(|table| pe::read::<usize>(table + slot)).filter(|entry| slot != 0 && pe::in_image_code(*entry));
    let offset = getter
        .filter(|getter| pe::has_pattern(*getter, 3, &[0x48, 0x8D, 0x81]) && pe::read::<u8>(getter + 7) == Some(0xC3))
        .and_then(|getter| disp_at(getter + 3))
        .filter(|offset| (0x10..0x1000).contains(offset))
        .ok_or_else(|| RpcError::anchor("screen.anvil").with_data(json!({ "message": "the anvil's rename text field did not resolve" })))?;
    Ok(controller + offset)
}

/// `take_result`: the first non-empty slot of the screen's result container (a furnace's output or a
/// brewing stand's bottles) into the first empty hotbar or inventory slot, as one `Take`.
fn take_result(core: &'static Core) -> Result<Value, RpcError> {
    let screen = screen_now(core)?;
    let kind = kind_of(&screen.top);
    let result = match kind {
        "furnace" | "blast_furnace" | "smoker" => "FurnaceResultContainer",
        "brewing_stand" => "BrewingStandResultContainer",
        "other" => {
            return Err(RpcError::invalid_params(format!("take_result needs a screen with a result slot open, and {} is open", screen.top)));
        }
        "anvil" | "grindstone" | "smithing_table" | "cartography_table" => {
            let take = match kind {
                "anvil" => &ANVIL_TAKE,
                "grindstone" => &GRINDSTONE_TAKE,
                "smithing_table" => &SMITHING_TAKE,
                _ => &CARTOGRAPHY_TAKE,
            };
            let controller = screen_manager(handler(take.handler)?, HANDLER_ANCHORS[take.handler])?;
            return take_screen(core, screen.top, controller, take, 1);
        }
        "stonecutter" | "loom" | "trade" | "enchanting_table" | "beacon" => {
            return Err(RpcError::invalid_params(format!(
                "the {kind} screen's result needs its own choice: use screen.act {}",
                match kind {
                    "stonecutter" => "stonecut {recipe}",
                    "loom" => "loom {pattern}",
                    "trade" => "trade {offer}",
                    "enchanting_table" => "enchant {option}",
                    _ => "beacon {primary, secondary?}",
                }
            )));
        }
        "crafting_table" | "inventory" | "crafter" => {
            return Err(RpcError::invalid_params(
                "the crafting screen's result is taken with screen.act {action: \"craft\"} once the grid holds a recipe",
            ));
        }
        _ => {
            return Err(RpcError::invalid_params(format!("the {kind} screen has no result slot")));
        }
    };
    if !requests_ready() {
        return Err(RpcError::anchor("screen.request"));
    }
    let open = open_containers()?;
    let source = container(&open, result, "result")?;
    let (slot, item) = (0..source.size)
        .filter_map(|slot| source.item(slot).map(|item| (slot, item)))
        .find(|(_, item)| count_of(*item) != 0)
        .ok_or_else(|| RpcError::invalid_params("the result slot is empty"))?;
    let (target, target_slot) = open
        .iter()
        .filter(|open| is_carried(open.name))
        .find_map(|open| (0..open.size).find(|slot| open.item(*slot).is_some_and(|item| count_of(item) == 0)).map(|slot| (open, slot)))
        .ok_or_else(|| RpcError::invalid_params("the player's hotbar and inventory have no empty slot"))?;
    let amount = count_of(item);
    let taken = inventory::slot(item);
    let id = move_through(TAKE, (source, slot), (target, target_slot), amount)?;
    park(core, screen.top, Phase::Request { id, moved: amount as u32, take: true, cursor: false }, taken)
}

/// A text parameter, when it was given: an empty string is kept (an anvil's empty name clears it).
fn optional_text(params: &Value, key: &str) -> Result<Option<String>, RpcError> {
    match params.get(key) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(String::from(value.trim()))),
        Some(_) => Err(RpcError::invalid_params(format!("{key} must be text"))),
    }
}

/// A text parameter the action cannot run without.
fn required_text(params: &Value, key: &str, action: &str) -> Result<String, RpcError> {
    optional_text(params, key)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params(format!("{action} needs {key}: what the action works on")))
}

/// Refuses an action while the screen it belongs to is not the open one; answers the open screen's name.
fn require_screen(core: &'static Core, kinds: &[&str], action: &str) -> Result<String, RpcError> {
    let screen = screen_now(core)?;
    let kind = kind_of(&screen.top);
    if !kinds.contains(&kind) {
        return Err(RpcError::invalid_params(format!(
            "{action} needs a {} screen open, and {} is open",
            kinds.join(" or "),
            screen.top
        )));
    }
    Ok(screen.top)
}

/* ------------------------------------------------------------------------------------------------
 * screen.close
 * ---------------------------------------------------------------------------------------------- */

/// `screen.close` → `{closed}`: Escape through the game's own window procedure (the path `ui.key`
/// uses, so the screen's own handler runs and the store guard does not apply to Escape).
///
/// Refused while the player is playing: Escape there opens the pause menu instead of closing a screen.
pub(crate) fn h_screen_close(core: &'static Core, _params: &Value) -> Result<Value, RpcError> {
    expire(core);
    let before = screen_now(core)?;
    if on_hud(&before.top) {
        return Err(RpcError::invalid_params(
            "no screen is open: Escape while playing would open the pause menu",
        ));
    }
    ui::h_key(core, &json!({ "key": "Escape", "action": "press" }))?;
    // The window procedure handles the Escape on a later frame: answer once the screen left the top.
    park(core, before.top, Phase::Close { escapes: 1 }, None)
}

/* ------------------------------------------------------------------------------------------------
 * Anchors
 * ---------------------------------------------------------------------------------------------- */

/// The per-screen pieces this build still does not have, reported by `engine.status.missing` so a gap of
/// the analysis is visible there (every screen action has its handler anchor in [`HANDLER_ANCHORS`]).
const MISSING: [&str; 0] = [];

/// Resolves the request path, installs the response hook and finds the screens' own handlers. Runs once
/// at attach.
pub(crate) fn resolve(core: &'static Core) -> Vec<Anchor> {
    resolve_requests(core);
    resolve_screen_actions(core);
    resolve_bundle(core.image());
    resolve_anvil(core.image());
    resolve_trade2(core.image());
    report()
}

/// The anchors as they are now, for `engine.status`: the request path (its submit step, once every piece
/// resolved), the response handler, the container map (named by the response handler that reads it),
/// and the per-screen gaps.
pub(crate) fn report() -> Vec<Anchor> {
    let ready = requests_ready();
    let containers = CONTAINERS_HASH.load(Ordering::Acquire) != 0;
    let mut list = alloc::vec![
        Anchor { name: "screen.request", addr: if ready { SUBMIT.load(Ordering::Acquire) } else { 0 } },
        Anchor { name: SITE_RESPONSE, addr: if RESPONSE_TRAMPOLINE.load(Ordering::Acquire) != 0 { RESPONSE.load(Ordering::Acquire) } else { 0 } },
        Anchor { name: "screen.containers", addr: if containers { RESPONSE.load(Ordering::Acquire) } else { 0 } },
        Anchor { name: "screen.move", addr: MOVE_TRANSFER.load(Ordering::Acquire) },
        Anchor { name: "screen.bundle", addr: BUNDLE_INSERT.load(Ordering::Acquire) },
    ];
    list.extend(HANDLER_ANCHORS.iter().zip(HANDLERS.iter()).map(|(name, entry)| Anchor { name: *name, addr: entry.load(Ordering::Acquire) }));
    list.extend(MISSING.iter().map(|name: &&str| Anchor { name: *name, addr: 0 }));
    list
}

/// True while a world is loaded: the screens and containers of this module all belong to one.
fn world() -> Result<(), RpcError> {
    if live::in_world() {
        Ok(())
    } else {
        Err(RpcError::not_in_world())
    }
}
