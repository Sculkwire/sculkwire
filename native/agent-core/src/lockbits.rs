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
    fn connections_past_31_share_the_last_bit() {
        assert_eq!(bit(40), bit(31));
        assert_eq!(with(0, 0, true), 1);
    }
}
