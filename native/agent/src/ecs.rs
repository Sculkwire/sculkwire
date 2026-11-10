//! The game's ECS: the component accessor, the EnTT element walk and the local player's readable
//! fields.
//!
//! Components are looked up by the game's own rule — FNV-1a 32 of the plain type name, which the
//! runtime type-descriptor factories prove for every engine type
//! (`StateVectorComponent` → one fixed 32-bit value). No hash is written down here: it is computed from the
//! name at attach, so a name is the only thing this file carries.
//!
//! Field offsets and element strides are the ones the game's own code uses at its component
//! lookups (each constant below names what reads it). Every value read is range-checked before it is
//! believed, and every address goes through [`crate::pe::read`], so a wrong offset yields `None`
//! instead of a bogus number.

use core::ptr;

use crate::{anchors, pe};

/// Offset of the component accessor inside an `EntityContext`.
/// The player system reaches its accessor as `lea rbx,[rdx+0x30]`, where `rdx` is its second
/// argument.
pub const ACCESSOR: usize = 0x30;

/// `entt::sparse_set` fields the element walk reads: the sparse page-pointer vector (`begin`/`end`)
/// and the payload page-pointer vector. Observed in the storage getter's own body (`+0x08`/`+0x10`
/// page vector, `+0x50` payload pages) and in the inlined entity→element walk.
const SPARSE_BEGIN: usize = 0x08;
const SPARSE_END: usize = 0x10;
const PACKED_PAGES: usize = 0x50;

/// The flat `u32` entity-id vector every storage keeps beside the page arrays (`begin`/`end`). The
/// entity count is `(end - begin) / 4`, which is how view construction counts matches.
const ENTITY_BEGIN: usize = 0x20;
const ENTITY_END: usize = 0x28;

/// `StateVectorComponent` element stride: three `Vec3` (position, previous, delta). Observed as
/// `lea rax,[rcx+rcx*8]; shl eax,2` (×36) at the component's lookup site.
pub const STATE_VECTOR_STRIDE: usize = 0x24;
/// Position inside a `StateVectorComponent` element (feet, first of the three `Vec3`).
pub const STATE_POSITION: usize = 0x00;
/// Per-tick movement inside a `StateVectorComponent` element (third `Vec3`).
pub const STATE_DELTA: usize = 0x18;

/// `ActorRotationComponent` element stride: two `Vec2` (rotation, previous rotation), observed as
/// `shl ecx,4` at the component's lookup sites.
pub const ROTATION_STRIDE: usize = 0x10;
/// Pitch inside an `ActorRotationComponent` element: the rotation-term pass accumulates into `+0x00`
/// and clamps it to ±90 with the same instruction pair that wraps `+0x04` modulo 360.
pub const ROTATION_PITCH: usize = 0x00;
/// Yaw inside an `ActorRotationComponent` element: `+0x04`, wrapped with `fmodf(…, 360)` and ±180.
pub const ROTATION_YAW: usize = 0x04;
/// The movement system runs once per entity group, so one client tick can reach it twice. The
/// per-tick checks run at most once per this many milliseconds (a tick is 50 ms at 20 tps).
pub const CLIENT_TICK_WINDOW_MS: u64 = 30;

/// `ActorUniqueIDComponent` element stride (one `u64`); `u64::MAX` is the "no live actor" value the
/// game's own presence helper compares against.
pub const UNIQUE_STRIDE: usize = 0x08;

/// The local player's state for one simulation tick.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sample {
    pub entity: u32,
    pub position: [f32; 3],
    /// `[pitch, yaw]` in degrees.
    pub rotation: Option<[f32; 2]>,
    /// Per-tick movement (`StateVectorComponent`'s delta), blocks per tick.
    pub velocity: [f32; 3],
    pub on_ground: Option<bool>,
}

/// One tick's reading of the local player, plus the rotation element it was read from (the address a
/// view change has to write).
pub struct Reading {
    pub sample: Sample,
    rotation_element: Option<usize>,
}

impl Reading {
    /// Writes a view into the player's rotation component and reports whether the write landed.
    ///
    /// The game's camera copies into this component every frame, so a write is only useful from the
    /// tick the game is about to consume; the caller re-reads on the next tick to see whether it
    /// stuck (see [`crate::live`]).
    pub fn write_look(&self, pitch: f32, yaw: f32) -> bool {
        let Some(element) = self.rotation_element else {
            return false;
        };
        if !pe::writable(element, ROTATION_YAW + 4) {
            return false;
        }
        // SAFETY: the element was located by the component walk and its page is writable.
        unsafe {
            ptr::write_unaligned((element + ROTATION_YAW) as *mut f32, yaw);
            ptr::write_unaligned((element + ROTATION_PITCH) as *mut f32, pitch);
        }
        true
    }

    /// Reads the rotation back, for the confirmation on the following tick.
    pub fn read_look(&self) -> Option<[f32; 2]> {
        read_look(self.rotation_element?)
    }
}

/// The component storage of `hash`, from the accessor the game itself uses.
///
/// # Safety
/// The game's storage getter creates a storage when the registry has none. Call this only from the
/// tick that owns the entity context ([`crate::hooks::player_system`]).
pub fn storage(accessor: usize, hash: u32) -> Option<usize> {
    let getter = anchors::getter()?;
    // SAFETY: the getter is the game's own generic `getStorage(registry, hash)`, called with the
    // same accessor and hash argument shape its own systems use (`rcx = accessor`, `edx = hash`).
    let storage = unsafe { core::mem::transmute::<usize, unsafe extern "C" fn(usize, u32) -> usize>(getter)(accessor, hash) };
    sane(storage).then_some(storage)
}

/// A storage pointer is believed only when its page arrays could hold elements.
///
/// A *flag* component's storage has no payload pages at all (`+0x50` is null there) and still holds
/// entities, so only the sparse and entity vectors are required to be consistent.
fn sane(storage: usize) -> bool {
    if !pe::readable(storage, ENTITY_END + 8) {
        return false;
    }
    let Some(sparse_begin) = pe::read::<usize>(storage + SPARSE_BEGIN) else {
        return false;
    };
    let Some(sparse_end) = pe::read::<usize>(storage + SPARSE_END) else {
        return false;
    };
    let Some(entity_begin) = pe::read::<usize>(storage + ENTITY_BEGIN) else {
        return false;
    };
    let Some(entity_end) = pe::read::<usize>(storage + ENTITY_END) else {
        return false;
    };
    if sparse_end < sparse_begin || entity_end < entity_begin {
        return false;
    }
    // One sparse page pointer per 2^11 entities and one u32 per entity: a few pages at most in a
    // client registry.
    sparse_end - sparse_begin <= 0x1_0000 && entity_end - entity_begin <= 0x1_0000
}

/// True when `entity` carries the component `storage` holds, for components with no payload.
pub fn contains(storage: usize, entity: u32) -> bool {
    index_of(storage, entity).is_some()
}

/// The storage's index for `entity`, the part of the walk that does not touch payload pages.
fn index_of(storage: usize, entity: u32) -> Option<u32> {
    let page = entity & 0x3ffff;
    let slot = (page >> 0xb) as usize;
    let begin = pe::read::<usize>(storage + SPARSE_BEGIN)?;
    let end = pe::read::<usize>(storage + SPARSE_END)?;
    if end <= begin {
        return None;
    }
    if slot >= (end - begin) / 8 {
        return None;
    }
    let sparse = pe::read::<usize>(begin + slot * 8)?;
    if sparse == 0 {
        return None;
    }
    let index = pe::read::<u32>(sparse + (page & 0x7ff) as usize * 4)?;
    // The page tag in the index must match the entity's version bits.
    if (index ^ (entity & 0xfffc_0000)) > 0x3fffe {
        return None;
    }
    Some(index)
}

/// The element of `entity` in `storage`, following the game's own entity→element walk.
pub fn element(storage: usize, entity: u32, stride: usize) -> Option<usize> {
    let index = index_of(storage, entity)?;
    let packed_pages = pe::read::<usize>(storage + PACKED_PAGES)?;
    if packed_pages == 0 {
        return None;
    }
    let packed = pe::read::<usize>(packed_pages + ((index & 0x3ff80) >> 4) as usize * 8)?;
    if packed == 0 {
        return None;
    }
    Some(packed + (index & 0x7f) as usize * stride)
}

/// The local player storage as the tick sees it: the storage address, how many entities carry the
/// flag, and the first id — the read `area-player` describes (`+0x20`/`+0x28` is the packed id
/// vector, and a single-player client holds exactly one id there).
///
/// # Safety
/// As [`storage`]: only from the game's own tick.
pub fn local_players(accessor: usize) -> Option<(usize, usize, u32)> {
    let local = storage(accessor, anchors::component_hash("LocalPlayerComponent"))?;
    let begin = pe::read::<usize>(local + ENTITY_BEGIN)?;
    let end = pe::read::<usize>(local + ENTITY_END)?;
    if end < begin || (end - begin) % 4 != 0 || (end - begin) / 4 > 64 {
        return None;
    }
    let count = (end - begin) / 4;
    let first = if count == 0 { 0 } else { pe::read::<u32>(begin)? };
    Some((local, count, first))
}

/// One tick's reading of the local player, or `None` while no local player exists.
///
/// # Safety
/// As [`storage`]: only from the game's own tick.
pub fn read(accessor: usize) -> Option<Reading> {
    let local = storage(accessor, anchors::component_hash("LocalPlayerComponent"))?;
    let state_vector = storage(accessor, anchors::component_hash("StateVectorComponent"))?;
    let (entity, at) = local_entity(local, state_vector)?;
    let position = read_vec3(at + STATE_POSITION)?;
    if !plausible_position(&position) {
        return None;
    }
    // A standing player's per-tick movement is exactly zero, which is a reading, not a failure.
    let velocity = read_vec3(at + STATE_DELTA).unwrap_or([0.0, 0.0, 0.0]);

    // A dead or replaced actor keeps `-1` in its unique-id element; the game's own presence helper
    // compares exactly that, so a sample for one is refused rather than published.
    let unique = storage(accessor, anchors::component_hash("ActorUniqueIDComponent"))
        .and_then(|storage| element(storage, entity, UNIQUE_STRIDE))
        .and_then(pe::read::<u64>);
    if unique == Some(u64::MAX) {
        return None;
    }

    let rotation_element = storage(accessor, anchors::component_hash("ActorRotationComponent"))
        .and_then(|rotation| element(rotation, entity, ROTATION_STRIDE));
    let rotation = rotation_element.and_then(rotation_of);
    let on_ground = storage(accessor, anchors::component_hash("OnGroundFlagComponent"))
        .is_some_and(|flag| contains(flag, entity));

    Some(Reading {
        sample: Sample { entity, position, rotation, velocity, on_ground: Some(on_ground) },
        rotation_element,
    })
}

/// The entity a flag storage holds: its flat entity-id vector, validated against the position
/// storage.
///
/// A flag component (`LocalPlayerComponent`) has no payload pages, so the entities carrying it are
/// exactly the ids in `+0x20 .. +0x28`. The id is only believed when it resolves in the
/// `StateVectorComponent` storage *and* that element holds a plausible position, so a shifted field
/// yields `None` rather than a wrong entity.
fn local_entity(local: usize, state_vector: usize) -> Option<(u32, usize)> {
    let begin = pe::read::<usize>(local + ENTITY_BEGIN)?;
    let end = pe::read::<usize>(local + ENTITY_END)?;
    if end <= begin || (end - begin) % 4 != 0 {
        return None;
    }
    // A client registry holds a handful of local players, never thousands.
    if (end - begin) / 4 > 64 {
        return None;
    }
    let mut at = begin;
    while at < end {
        if let Some(entity) = pe::read::<u32>(at) {
            if entity != 0 {
                if let Some(element) = element(state_vector, entity, STATE_VECTOR_STRIDE) {
                    if read_vec3(element + STATE_POSITION).is_some_and(|position| plausible_position(&position)) {
                        return Some((entity, element));
                    }
                }
            }
        }
        at += 4;
    }
    None
}

/// `[pitch, yaw]` of a rotation element, refused when it is not an angle pair.
fn rotation_of(element: usize) -> Option<[f32; 2]> {
    let [pitch, yaw] = read_look(element)?;
    // Pitch is clamped to ±90 in play (and to ±180 by every camera); yaw wraps at ±360.
    (pitch.abs() <= 180.0 && yaw.abs() <= 1_000_000.0).then_some([pitch, yaw])
}

/// `[pitch, yaw]` of a rotation element, unvalidated.
pub fn read_look(element: usize) -> Option<[f32; 2]> {
    let pitch = pe::read::<f32>(element + ROTATION_PITCH)?;
    let yaw = pe::read::<f32>(element + ROTATION_YAW)?;
    (pitch.is_finite() && yaw.is_finite()).then_some([pitch, yaw])
}

fn read_vec3(address: usize) -> Option<[f32; 3]> {
    let vector = [
        pe::read::<f32>(address)?,
        pe::read::<f32>(address + 4)?,
        pe::read::<f32>(address + 8)?,
    ];
    vector.iter().all(|value| value.is_finite()).then_some(vector)
}

/// A position is believed only inside the build's world bounds (±30 M blocks, 4096 tall). A player
/// standing still has a zero delta, so zero is plausible for the *delta* and not a reason to refuse a
/// position: only the all-zero triple, which no entity ever stands at, is rejected here.
fn plausible_position(position: &[f32; 3]) -> bool {
    position.iter().all(|value| value.abs() < 31_000_000.0)
        && position[1].abs() < 4096.0
        && !position.iter().all(|value| *value == 0.0)
}
