//! The one chat line a quiet `script debugger connect` may still leave behind, and the bounded window in
//! which an engine drops it.
//!
//! The command reports its result as `script.success.debuggerConnect` ("Debugger connected to host … on
//! port …"). A quiet command drops the messages it captures while it runs, but a reply that arrives after
//! the capture closed (the server answered late, or the line ran on another thread) would reach chat.
//! So a quiet connect arms a window of [`WINDOW_MS`]; the first message with that key inside it is
//! dropped and closes the window. Nothing else is touched, and a `/script debugger connect` the user
//! types outside the window keeps its line.
//!
//! Pure over a caller-supplied clock, so the rules build and are tested on the host (`host-tests.sh`).

use core::sync::atomic::{AtomicU64, Ordering};

/// The message key of a successful `script debugger connect`.
pub const KEY: &[u8] = b"script.success.debuggerConnect";

/// How long after a quiet connect its success line is still dropped.
pub const WINDOW_MS: u64 = 5_000;

/// The end of the open window (a tick in ms), 0 when none is open.
static UNTIL: AtomicU64 = AtomicU64::new(0);

/// `line` is a `script debugger connect …` command, with or without its slash, in any case.
pub fn is_connect(line: &str) -> bool {
    let mut words = line.trim_start().trim_start_matches('/').split_ascii_whitespace();
    ["script", "debugger", "connect"]
        .iter()
        .all(|want| words.next().is_some_and(|word| word.eq_ignore_ascii_case(want)))
}

/// `key` is the connect success key, as the game hands it (a leading `%` marks a key to translate).
pub fn is_key(key: &[u8]) -> bool {
    key.strip_prefix(b"%").unwrap_or(key) == KEY
}

/// Opens the window at `now` for a quiet connect sculkwire is about to run.
pub fn arm(now: u64) {
    UNTIL.store(now.saturating_add(WINDOW_MS).max(1), Ordering::Release);
}

/// Closes the window (the reply was already dropped with the command's own capture).
pub fn disarm() {
    UNTIL.store(0, Ordering::Release);
}

/// A window is open at `now`: the caller reads the message key only then.
pub fn armed(now: u64) -> bool {
    let until = UNTIL.load(Ordering::Acquire);
    until != 0 && now <= until
}

/// Whether the message with `key` at `now` is the reply to drop; the first one closes the window.
pub fn take(now: u64, key: &[u8]) -> bool {
    let until = UNTIL.load(Ordering::Acquire);
    if until == 0 || now > until || !is_key(key) {
        return false;
    }
    UNTIL.compare_exchange(until, 0, Ordering::AcqRel, Ordering::Acquire).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_lines_are_recognised_in_any_form() {
        assert!(is_connect("script debugger connect localhost 19151"));
        assert!(is_connect("/script debugger connect localhost 19151"));
        assert!(is_connect("  /Script  DEBUGGER connect"));
        assert!(!is_connect("script debugger listen 19144"));
        assert!(!is_connect("script debugger close"));
        assert!(!is_connect("say script debugger connect"));
        assert!(!is_connect("scriptevent debugger connect"));
    }

    #[test]
    fn only_the_success_key_matches() {
        assert!(is_key(b"script.success.debuggerConnect"));
        assert!(is_key(b"%script.success.debuggerConnect"));
        assert!(!is_key(b"clientscript.success.debuggerConnect"));
        assert!(!is_key(b"script.error.debuggerFailed"));
        assert!(!is_key(b"script.success.debuggerConnectX"));
    }

    // One test owns the shared window, so the steps cannot race another test.
    #[test]
    fn the_window_drops_one_reply_and_expires() {
        disarm();
        assert!(!take(100, KEY), "nothing is dropped without a quiet connect");

        arm(1_000);
        assert!(armed(1_000 + WINDOW_MS));
        assert!(!take(1_001, b"commands.time.set"), "another message never closes the window");
        assert!(take(1_002, KEY), "the first reply inside the window is dropped");
        assert!(!take(1_003, KEY), "a second one (the user's own connect) is kept");

        arm(2_000);
        assert!(!armed(2_001 + WINDOW_MS));
        assert!(!take(2_001 + WINDOW_MS, KEY), "a reply after the window is kept");

        arm(3_000);
        disarm();
        assert!(!take(3_001, KEY), "a disarmed window drops nothing");
    }
}
