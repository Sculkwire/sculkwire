//! The view math behind `input.look`: which camera the local player follows, and what to write into
//! it so the player looks at a commanded `[pitch, yaw]`.
//!
//! The client's player rotation is set from its active camera every frame (`VanillaCamera`'s
//! update-player-from-camera step), so the view is written into the camera. The game's camera presets
//! hold the view in one of two components:
//!
//! - **First person** (`minecraft:first_person`) has `minecraft:camera_direct_look`: a yaw/pitch pair
//!   in radians that becomes the camera's orientation. [`look_mapping`] tells which pair the player
//!   follows (it equals the player's rotation under the game's convention) and [`direct_look_pair`]
//!   gives the pair for a commanded view.
//! - **Third person** (`minecraft:third_person`, the view from behind, and
//!   `minecraft:third_person_front`) has no direct look. Its `minecraft:camera_orbit` places the
//!   camera on a sphere around the player by an azimuth and a polar angle, the camera looks at the
//!   player, and the player's rotation is the camera's forward direction (look mode "along the
//!   camera", the back view) or points at the camera (look mode `at_camera`, the front view).
//!   [`orbit_angles`] gives the orbit angles for a commanded view.
//!
//! The orbit convention is the game's own: when it points a camera along a view vector `v` it sets
//! the orbit to the offset `o = -v` (along the camera) or `o = v` (at the camera), with
//! `azimuth = atan2(o.z, o.x)` and `polar = acos(o.y / |o|)`, and its look input relates the
//! azimuth to the player's yaw by a quarter turn whose sign is the look mode. With the player's view
//! vector `(-sin yaw · cos pitch, -sin pitch, cos yaw · cos pitch)` (`+pitch` looks down, yaw 0 is
//! `+Z`) that is `azimuth = yaw - 90°`, `polar = 90° - pitch` along the camera and
//! `azimuth = yaw + 90°`, `polar = 90° + pitch` at the camera: no trigonometry needed.
//!
//! It also holds the aim math the workstation's `interact.*` uses ([`look_at`]), with the `sqrt` and
//! `atan2` it needs written out, because the agent links no floating-point library.
//!
//! Only `core` is used, so this file also builds on its own as a test crate on the host:
//! `rustc --edition 2021 --test agent/src/look.rs -o target/look-test.exe && ./target/look-test.exe`
//! (from `native/`).

pub const DEGREES_PER_RADIAN: f32 = 57.295_78;

/// How far, in degrees, a camera's direct-look pair may be from the player's rotation and still be
/// the one the player follows.
pub const LOOK_MATCH_DEGREES: f32 = 1.0;

/// How a direct-look camera's radians map to the player's degrees:
/// `yaw = yaw_sign · deg(yaw) + offset`, `pitch = pitch_sign · deg(pitch)`. Ordered by preference:
/// the first two are the game's quaternion `Ry · Rx` with the player's convention (yaw 0 = +Z,
/// growing clockwise from above; + pitch looks down) for a camera looking along +Z or −Z; the rest
/// only win when the live pair proves them.
pub const LOOK_MAPPINGS: [(f32, f32, f32); 8] = [
    (-1.0, 0.0, 1.0),
    (-1.0, 180.0, -1.0),
    (1.0, 0.0, 1.0),
    (1.0, 180.0, -1.0),
    (-1.0, 0.0, -1.0),
    (-1.0, 180.0, 1.0),
    (1.0, 0.0, -1.0),
    (1.0, 180.0, 1.0),
];

/// `value` inside `(-180, 180]`: the range the game keeps yaw in.
///
/// A truncating cast instead of `%` or `rem_euclid`, which compile to the CRT's `fmodf` and are not
/// linked into the agent.
pub fn wrap_degrees(value: f32) -> f32 {
    let turns = (value / 360.0) as i32;
    let wrapped = value - turns as f32 * 360.0;
    if wrapped > 180.0 {
        wrapped - 360.0
    } else if wrapped <= -180.0 {
        wrapped + 360.0
    } else {
        wrapped
    }
}

/// The first mapping under which a direct-look camera's `[yaw, pitch]` radians are the player's
/// current `[pitch, yaw]` degrees, or `None` when the camera is not the one the player follows.
pub fn look_mapping(camera: [f32; 2], player: [f32; 2]) -> Option<(f32, f32, f32)> {
    let [camera_yaw, camera_pitch] = [camera[0] * DEGREES_PER_RADIAN, camera[1] * DEGREES_PER_RADIAN];
    let [player_pitch, player_yaw] = player;
    LOOK_MAPPINGS.into_iter().find(|(yaw_sign, offset, pitch_sign)| {
        wrap_degrees(player_yaw - (yaw_sign * camera_yaw + offset)).abs() <= LOOK_MATCH_DEGREES
            && (player_pitch - pitch_sign * camera_pitch).abs() <= LOOK_MATCH_DEGREES
    })
}

/// The direct-look `[yaw, pitch]` radians that show the commanded `pitch`/`yaw` degrees under a
/// mapping [`look_mapping`] proved.
pub fn direct_look_pair(mapping: (f32, f32, f32), pitch: f32, yaw: f32) -> [f32; 2] {
    let (yaw_sign, offset, pitch_sign) = mapping;
    [wrap_degrees(yaw_sign * (yaw - offset)) / DEGREES_PER_RADIAN, pitch_sign * pitch / DEGREES_PER_RADIAN]
}

/// `VanillaCamera::UpdatePlayerFromCameraComponent`'s look mode: how the player's rotation follows
/// an orbit camera.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LookMode {
    /// `0`: the player looks where the camera looks (`minecraft:third_person`, the back view).
    AlongCamera,
    /// `1`, `"look_mode": "at_camera"`: the player looks at the camera
    /// (`minecraft:third_person_front`).
    AtCamera,
}

impl LookMode {
    /// The mode stored in the component, or `None` for a value this build's code does not handle
    /// (the game's own conversions test exactly `0` and `1`).
    pub fn from_raw(raw: u32) -> Option<LookMode> {
        match raw {
            0 => Some(LookMode::AlongCamera),
            1 => Some(LookMode::AtCamera),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            LookMode::AlongCamera => "along_camera",
            LookMode::AtCamera => "at_camera",
        }
    }
}

/// The orbit `[azimuth, polar]` radians that make the player look at `pitch`/`yaw` degrees.
pub fn orbit_angles(mode: LookMode, pitch: f32, yaw: f32) -> [f32; 2] {
    let (azimuth, polar) = match mode {
        LookMode::AlongCamera => (yaw - 90.0, 90.0 - pitch),
        LookMode::AtCamera => (yaw + 90.0, 90.0 + pitch),
    };
    [wrap_degrees(azimuth) / DEGREES_PER_RADIAN, polar / DEGREES_PER_RADIAN]
}

/// An orbit camera's angles are believable: finite, the polar angle inside `[0, π]`.
pub fn orbit_plausible(azimuth: f32, polar: f32) -> bool {
    azimuth.is_finite() && polar.is_finite() && azimuth.abs() <= 7.0 && (0.0..=3.2).contains(&polar)
}

/// The aim that points from `eye` at `target`: `[pitch, yaw]` in degrees, the convention the game
/// stores (`+pitch` looks down, `0` yaw is `+Z`, `-90` is `+X`).
pub fn look_at(eye: [f32; 3], target: [f32; 3]) -> Option<[f32; 2]> {
    let dx = target[0] - eye[0];
    let dy = target[1] - eye[1];
    let dz = target[2] - eye[2];
    let horizontal = sqrt(dx * dx + dz * dz);
    if !dx.is_finite() || !dy.is_finite() || !dz.is_finite() || (horizontal == 0.0 && dy == 0.0) {
        return None;
    }
    Some([degrees(-atan2(dy, horizontal)), wrap(degrees(atan2(-dx, dz)))])
}

/// The straight-line distance between two points.
pub fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    sqrt(dx * dx + dy * dy + dz * dz)
}

/// `sqrt`, implemented here because this crate links no floating-point library.
///
/// Newton from a halved-exponent seed: the seed is good to about 3 %, and six steps reach single
/// precision (each one halves the relative error).
pub fn sqrt(value: f32) -> f32 {
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
pub fn atan(value: f32) -> f32 {
    let square = value * value;
    value
        * (0.999_866
            + square * (-0.330_299_5 + square * (0.180_141 + square * (-0.085_133 + square * 0.020_835_1))))
}

/// `atan2(y, x)` in radians, computed from [`atan`] with the quadrant folded in.
pub fn atan2(y: f32, x: f32) -> f32 {
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

pub fn degrees(radians: f32) -> f32 {
    radians * (180.0 / core::f32::consts::PI)
}

/// `value` inside `(-180, 180]`, the range the game keeps yaw in.
pub fn wrap(value: f32) -> f32 {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
    }

    /// The player's view vector for `[pitch, yaw]` degrees (`+pitch` down, yaw 0 = `+Z`).
    fn view_vector(pitch: f32, yaw: f32) -> [f32; 3] {
        let [p, y] = [pitch / DEGREES_PER_RADIAN, yaw / DEGREES_PER_RADIAN];
        [-y.sin() * p.cos(), -p.sin(), y.cos() * p.cos()]
    }

    /// The game's own "point the orbit camera along a view vector": the offset is `-v` along the
    /// camera and `v` at the camera, then `atan2(o.z, o.x)` and `acos(o.y / |o|)`.
    fn game_orbit(mode: LookMode, v: [f32; 3]) -> [f32; 2] {
        let o = match mode {
            LookMode::AlongCamera => [-v[0], -v[1], -v[2]],
            LookMode::AtCamera => v,
        };
        let r = (o[0] * o[0] + o[1] * o[1] + o[2] * o[2]).sqrt();
        [o[2].atan2(o[0]), (o[1] / r).acos()]
    }

    /// The game's own player rotation from the camera's forward vector: `yaw = deg(atan2(f.z, f.x)) -
    /// 90`, `pitch = -deg(atan2(f.y, |f.xz|))`, with the forward negated at the camera.
    fn game_player(mode: LookMode, azimuth: f32, polar: f32) -> [f32; 2] {
        // The camera sits at the orbit offset and looks at the player: forward is minus the offset.
        let o = [polar.sin() * azimuth.cos(), polar.cos(), polar.sin() * azimuth.sin()];
        let mut f = [-o[0], -o[1], -o[2]];
        if mode == LookMode::AtCamera {
            f = [-f[0], -f[1], -f[2]];
        }
        let horizontal = (f[0] * f[0] + f[2] * f[2]).sqrt();
        [-(f[1].atan2(horizontal)) * DEGREES_PER_RADIAN, wrap_degrees(f[2].atan2(f[0]) * DEGREES_PER_RADIAN - 90.0)]
    }

    const VIEWS: [[f32; 2]; 9] =
        [[0.0, 0.0], [30.0, 90.0], [-45.0, -90.0], [10.0, 179.0], [-80.0, -179.5], [60.0, 45.0], [-20.0, -135.0], [89.0, 12.0], [0.0, 180.0]];

    #[test]
    fn orbit_angles_match_the_games_own_conversion_from_the_view_vector() {
        for mode in [LookMode::AlongCamera, LookMode::AtCamera] {
            for [pitch, yaw] in VIEWS {
                let ours = orbit_angles(mode, pitch, yaw);
                let game = game_orbit(mode, view_vector(pitch, yaw));
                let azimuth_gap = wrap_degrees((ours[0] - game[0]) * DEGREES_PER_RADIAN);
                assert!(azimuth_gap.abs() < 0.01, "{mode:?} {pitch}/{yaw}: azimuth {ours:?} vs {game:?}");
                assert!(close(ours[1], game[1]), "{mode:?} {pitch}/{yaw}: polar {ours:?} vs {game:?}");
            }
        }
    }

    #[test]
    fn the_player_followed_back_through_the_orbit_looks_where_commanded() {
        for mode in [LookMode::AlongCamera, LookMode::AtCamera] {
            for [pitch, yaw] in VIEWS {
                let [azimuth, polar] = orbit_angles(mode, pitch, yaw);
                let [shown_pitch, shown_yaw] = game_player(mode, azimuth, polar);
                assert!((shown_pitch - pitch).abs() < 0.01, "{mode:?} {pitch}/{yaw}: pitch {shown_pitch}");
                assert!(wrap_degrees(shown_yaw - yaw).abs() < 0.01, "{mode:?} {pitch}/{yaw}: yaw {shown_yaw}");
            }
        }
    }

    #[test]
    fn the_back_view_puts_the_camera_behind_and_the_front_view_in_front() {
        // Looking along +Z (yaw 0, level): behind is -Z (azimuth -90°), in front is +Z (azimuth 90°).
        let back = orbit_angles(LookMode::AlongCamera, 0.0, 0.0);
        let front = orbit_angles(LookMode::AtCamera, 0.0, 0.0);
        assert!(close(back[0] * DEGREES_PER_RADIAN, -90.0) && close(back[1] * DEGREES_PER_RADIAN, 90.0));
        assert!(close(front[0] * DEGREES_PER_RADIAN, 90.0) && close(front[1] * DEGREES_PER_RADIAN, 90.0));
        // Looking down 30°: the back camera rises above the player (polar under 90°), the front one sinks.
        assert!(orbit_angles(LookMode::AlongCamera, 30.0, 0.0)[1] < back[1]);
        assert!(orbit_angles(LookMode::AtCamera, 30.0, 0.0)[1] > front[1]);
    }

    #[test]
    fn look_mode_is_read_only_for_the_values_the_game_tests() {
        assert_eq!(LookMode::from_raw(0), Some(LookMode::AlongCamera));
        assert_eq!(LookMode::from_raw(1), Some(LookMode::AtCamera));
        assert_eq!(LookMode::from_raw(2), None);
        assert_eq!(LookMode::from_raw(u32::MAX), None);
    }

    #[test]
    fn a_direct_look_pair_matches_the_player_it_drives() {
        for mapping in [LOOK_MAPPINGS[0], LOOK_MAPPINGS[1]] {
            for [pitch, yaw] in VIEWS {
                let pair = direct_look_pair(mapping, pitch, yaw);
                assert_eq!(look_mapping(pair, [pitch, yaw]), Some(mapping), "{mapping:?} {pitch}/{yaw}");
            }
        }
    }

    #[test]
    fn a_stale_direct_look_pair_is_not_the_camera_the_player_follows() {
        // Third person: the first-person camera keeps the pair it had when the view switched, and
        // the player has turned since.
        let stale = direct_look_pair(LOOK_MAPPINGS[0], 0.0, 0.0);
        assert_eq!(look_mapping(stale, [25.0, 70.0]), None);
        assert_eq!(look_mapping(stale, [0.0, 0.5]), Some(LOOK_MAPPINGS[0]));
    }

    #[test]
    fn orbit_angles_outside_the_sphere_are_refused() {
        assert!(orbit_plausible(-1.5, 1.6));
        assert!(!orbit_plausible(f32::NAN, 1.0));
        assert!(!orbit_plausible(0.0, -0.5));
        assert!(!orbit_plausible(0.0, 4.0));
        assert!(!orbit_plausible(100.0, 1.0));
    }

    #[test]
    fn yaw_wraps_into_the_games_range() {
        assert!(close(wrap_degrees(190.0), -170.0));
        assert!(close(wrap_degrees(-180.0), 180.0));
        assert!(close(wrap_degrees(540.0), 180.0));
        assert!(close(wrap_degrees(-725.0), -5.0));
    }

    #[test]
    fn an_aim_points_the_way_the_game_stores_a_view() {
        // `+pitch` looks down, yaw 0 is `+Z`, -90 is `+X`.
        let [pitch, yaw] = look_at([0.0, 0.0, 0.0], [0.0, 0.0, 5.0]).unwrap();
        assert!(close(pitch, 0.0) && close(yaw, 0.0));
        let [pitch, yaw] = look_at([0.0, 0.0, 0.0], [5.0, 0.0, 0.0]).unwrap();
        assert!(close(pitch, 0.0) && (yaw + 90.0).abs() < 0.01);
        let [pitch, yaw] = look_at([0.0, 0.0, 0.0], [-5.0, 0.0, 0.0]).unwrap();
        assert!(close(pitch, 0.0) && (yaw - 90.0).abs() < 0.01);
        let [pitch, _] = look_at([0.0, 2.0, 0.0], [0.0, 0.0, 2.0]).unwrap();
        assert!((pitch - 45.0).abs() < 0.01);
        assert_eq!(look_at([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]), None);
        assert_eq!(look_at([0.0, 0.0, 0.0], [f32::NAN, 0.0, 0.0]), None);
    }

    #[test]
    fn the_hand_rolled_math_matches_the_library() {
        for value in [1e-6f32, 0.25, 2.0, 9.0, 1234.5, 1e12] {
            assert!((sqrt(value) - value.sqrt()).abs() <= value.sqrt() * 1e-6, "sqrt({value})");
        }
        assert_eq!(sqrt(-1.0), 0.0);
        assert_eq!(sqrt(f32::INFINITY), 0.0);
        for (y, x) in [(1.0f32, 2.0f32), (2.0, 1.0), (1.0, -2.0), (-2.0, -1.0), (-1.0, 3.0), (0.0, -1.0), (3.0, 0.0)] {
            assert!((atan2(y, x) - y.atan2(x)).abs() < 2e-4, "atan2({y}, {x})");
        }
        assert_eq!(atan2(0.0, 0.0), 0.0);
        assert!((degrees(core::f32::consts::PI) - 180.0).abs() < 1e-4);
        assert!((distance([0.0, 0.0, 0.0], [2.0, 3.0, 6.0]) - 7.0).abs() < 1e-5);
    }

    #[test]
    fn an_aim_yaw_wraps_and_a_non_finite_one_is_zero() {
        assert!(close(wrap(190.0), -170.0));
        assert!(close(wrap(-180.0), 180.0));
        assert!(close(wrap(725.0), 5.0));
        assert!(close(wrap(-1e6), 80.0));
        assert_eq!(wrap(f32::NAN), 0.0);
        assert_eq!(wrap(f32::INFINITY), 0.0);
    }
}
