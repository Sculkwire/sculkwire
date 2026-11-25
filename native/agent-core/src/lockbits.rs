//! Who wants the input lock, as pure functions over plain values, so the rules build and are tested
//! on the host (`host-tests.sh`); `lock.rs` keeps the atomics and applies them.
//!
//! Two per-connection bit sets want the lock besides the mode: `active` (an action or play job runs,
//! which `auto` locks for) and `session` (the host keeps the lock for the session it holds the game).
//! Each connection owns one bit of each, and both clear when it disconnects, so a lock the host asked
//! for never outlives its connection: a crashed or killed host leaves the user's input free.

pub const MODE_OFF: i32 = 0;
pub const MODE_ON: i32 = 1;
pub const MODE_AUTO: i32 = 2;

/// The bit connection `conn` owns in `active` and `session`.
pub fn bit(conn: usize) -> u32 {
    1u32 << conn.min(31)
}

/// The lock is wanted: mode `on`, or mode `auto` while a connection holds an action or a session.
/// Mode `off` never locks.
pub fn wanted(mode: i32, active: u32, session: u32) -> bool {
    mode == MODE_ON || (mode == MODE_AUTO && (active | session) != 0)
}

/// Nothing wants the lock in `auto` any more: there is no control left to give back to the user.
pub fn nothing_held(mode: i32, active: u32, session: u32) -> bool {
    mode == MODE_AUTO && (active | session) == 0
}

/// `bits` with connection `conn`'s bit set or cleared.
pub fn with(bits: u32, conn: usize, set: bool) -> u32 {
    if set {
        bits | bit(conn)
    } else {
        bits & !bit(conn)
    }
}

/// The game is kept unaware of losing focus while the lock holds, or while a connection holds focus
/// (`input.lock {focus: true}`, the host's whole connection): its focus queries are answered with its
/// own window, a deactivation is withheld (and replayed when nothing holds focus any more), and a
/// background window is told once that it is active. Independent of the lock, so background clicks
/// work between actions and switching away never pauses the user's game; ends with the connection.
pub fn focus_held(locked: bool, focus_bits: u32) -> bool {
    locked || focus_bits != 0
}

/// Whether the agent tells the game its window is active now: focus is held and the window known, it
/// is not really the foreground one, and the game was not told since focus was last let go. A game
/// started behind another window was told at launch that it lost focus (before anything held it) and
/// then ignores the agent's clicks on its menus.
pub fn give_focus(held: bool, window_known: bool, foreground: bool, already_given: bool) -> bool {
    held && window_known && !foreground && !already_given
}

/// The game's focus queries are answered with its own window only while focus is held.
pub fn spoof_focus(held: bool, window_known: bool) -> bool {
    held && window_known
}

/// A cursor clip or a mouse capture the game asks for is skipped while focus is held and its window
/// is in the background: it would confine or take the user's real pointer in the window in front.
/// Releasing a clip (no rectangle) always passes.
pub fn keep_cursor_free(held: bool, background: bool, releasing: bool) -> bool {
    held && background && !releasing
}

/// The action-bar badge waits this long after the lock took hold, so a short action leaves no trace.
pub const BADGE_DELAY_MS: u64 = 1_000;

/// Whether the badge shows: the lock (or the user's F9 hand-over) has stood since `since` (0: it does
/// not stand) for at least [`BADGE_DELAY_MS`].
pub fn badge_due(since: u64, now: u64) -> bool {
    since != 0 && now.saturating_sub(since) >= BADGE_DELAY_MS
}

/// How often the action-bar badge is sent again while nothing changes: the game starts fading an
/// action-bar text out about 3 s after it was sent (measured on 1.26.60: a 4 s refresh left a gap of
/// about 1 s), so 2 s keeps it up without a gap.
pub const BADGE_REFRESH_MS: u64 = 2_000;

/// The wait before sending again a lock command (camera gate, badge) that failed `failures` times in a
/// row: 1 s doubling up to 8 s, then `None` after the fifth failure, so a command that keeps failing
/// (or keeps reporting a failure although it ran) is not sent again until the lock state changes.
pub fn retry_after_ms(failures: u32) -> Option<u64> {
    match failures {
        0 => Some(0),
        1..=4 => Some(1_000u64 << (failures - 1)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_locks_in_auto_and_its_connection_closing_releases_it() {
        let session = with(0, 3, true);
        assert!(wanted(MODE_AUTO, 0, session));
        // The connection closes: its bits go, and with them the lock.
        let session = with(session, 3, false);
        assert!(!wanted(MODE_AUTO, 0, session));
        assert!(nothing_held(MODE_AUTO, 0, session));
    }

    #[test]
    fn another_connections_session_or_action_keeps_the_lock() {
        let session = with(with(0, 1, true), 2, true);
        assert!(wanted(MODE_AUTO, 0, with(session, 1, false)));
        assert!(wanted(MODE_AUTO, bit(4), with(session, 2, false) & !bit(1)));
        assert!(!nothing_held(MODE_AUTO, bit(4), 0));
    }

    #[test]
    fn off_never_locks_and_on_always_does() {
        assert!(!wanted(MODE_OFF, u32::MAX, u32::MAX));
        assert!(wanted(MODE_ON, 0, 0));
        assert!(!nothing_held(MODE_ON, 0, 0));
    }

    #[test]
    fn focus_is_given_once_per_lock_and_only_to_a_background_window() {
        assert!(give_focus(true, true, false, false));
        assert!(!give_focus(true, true, false, true));
        assert!(!give_focus(true, true, true, false));
        assert!(!give_focus(false, true, false, false));
        assert!(!give_focus(true, false, false, false));
    }

    #[test]
    fn nothing_is_spoofed_or_kept_without_the_lock() {
        assert!(!spoof_focus(false, true));
        assert!(spoof_focus(true, true));
        assert!(!keep_cursor_free(false, true, false));
        assert!(keep_cursor_free(true, true, false));
        assert!(!keep_cursor_free(true, false, false));
        // Releasing a clip always reaches the system.
        assert!(!keep_cursor_free(true, true, true));
    }

    #[test]
    fn focus_is_held_by_the_lock_or_a_connection_and_ends_with_it() {
        assert!(!focus_held(false, 0));
        assert!(focus_held(true, 0));
        let bits = with(0, 2, true);
        assert!(focus_held(false, bits));
        // The connection closes: nothing holds focus, so the withheld loss is replayed.
        assert!(!focus_held(false, with(bits, 2, false)));
    }

    #[test]
    fn the_badge_waits_a_second_and_never_shows_without_the_lock() {
        assert!(!badge_due(0, 10_000));
        assert!(!badge_due(5_000, 5_999));
        assert!(badge_due(5_000, 6_000));
    }

    #[test]
    fn a_failing_lock_command_backs_off_and_stops() {
        assert_eq!(retry_after_ms(0), Some(0));
        assert_eq!(retry_after_ms(1), Some(1_000));
        assert_eq!(retry_after_ms(4), Some(8_000));
        assert_eq!(retry_after_ms(5), None);
        assert!(BADGE_REFRESH_MS < 3_000);
    }

    #[test]
    fn connections_past_31_share_the_last_bit() {
        assert_eq!(bit(40), bit(31));
        assert_eq!(with(0, 0, true), 1);
    }
}
