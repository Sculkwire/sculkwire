//! Which part of the content-log ring a `log.content {since, limit}` request reads.
//!
//! The ring numbers every entry it takes from 1 up and keeps the newest [`CAPACITY`]. A reader names
//! the last number it saw (`since`, 0 for "everything held"); the answer is the entries after it,
//! oldest first, at most `limit` of them, plus how many entries after `since` the ring had already
//! dropped. A cursor that is ahead of everything the ring numbered (the agent was reloaded and counts
//! from 1 again) reads from the oldest entry held, so a stale cursor never hides new messages.
//!
//! Plain `core` code over numbers (no game memory), so it also builds on its own as a host test crate:
//! `rustc --edition 2021 --test agent/src/logring.rs -o target/logring-test.exe &&
//! ./target/logring-test.exe` (from `native/`).

/// Entries the ring keeps.
pub const CAPACITY: usize = 2000;
/// The most entries one answer carries.
pub const LIMIT_MAX: u64 = CAPACITY as u64;
/// Entries one answer carries when the request names no limit.
pub const LIMIT_DEFAULT: u64 = 500;

/// The entries one answer carries: sequence numbers `start..end`, and `dropped` entries after the
/// caller's cursor that the ring no longer holds. `next` is the cursor for the following request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    pub start: u64,
    pub end: u64,
    pub dropped: u64,
    pub next: u64,
}

/// The window for a ring holding `held` entries from sequence `oldest` on.
pub fn window(oldest: u64, held: u64, since: u64, limit: u64) -> Window {
    let limit = limit.clamp(1, LIMIT_MAX);
    if held == 0 {
        // Nothing held: the cursor stays where it was unless the ring was reset under it.
        let newest = oldest.saturating_sub(1);
        let next = if since > newest { newest } else { since };
        return Window { start: oldest, end: oldest, dropped: 0, next };
    }
    let newest = oldest + held - 1;
    let first = if since > newest { oldest } else { since + 1 };
    let dropped = oldest.saturating_sub(first);
    let start = first.max(oldest);
    let end = (start + limit).min(newest + 1);
    let next = if end > start { end - 1 } else { since.min(newest) };
    Window { start, end, dropped, next }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn everything_held_after_a_zero_cursor() {
        assert_eq!(window(1, 3, 0, 500), Window { start: 1, end: 4, dropped: 0, next: 3 });
    }

    #[test]
    fn only_what_follows_the_cursor() {
        assert_eq!(window(1, 10, 7, 500), Window { start: 8, end: 11, dropped: 0, next: 10 });
    }

    #[test]
    fn a_caught_up_cursor_gets_nothing_and_keeps_its_place() {
        assert_eq!(window(1, 10, 10, 500), Window { start: 11, end: 11, dropped: 0, next: 10 });
    }

    #[test]
    fn the_limit_cuts_the_answer_and_the_next_cursor_follows_it() {
        assert_eq!(window(1, 10, 0, 4), Window { start: 1, end: 5, dropped: 0, next: 4 });
    }

    #[test]
    fn entries_the_ring_dropped_are_counted() {
        // Entries 1..=100 were numbered, the ring holds 61..=100, the reader last saw 20.
        assert_eq!(window(61, 40, 20, 500), Window { start: 61, end: 101, dropped: 40, next: 100 });
    }

    #[test]
    fn a_cursor_ahead_of_the_ring_reads_from_the_oldest_entry() {
        // The agent was reloaded: it numbers from 1 again while the reader still holds 900.
        assert_eq!(window(1, 5, 900, 500), Window { start: 1, end: 6, dropped: 0, next: 5 });
    }

    #[test]
    fn an_empty_ring() {
        assert_eq!(window(1, 0, 0, 500), Window { start: 1, end: 1, dropped: 0, next: 0 });
        assert_eq!(window(1, 0, 42, 500), Window { start: 1, end: 1, dropped: 0, next: 0 });
    }

    #[test]
    fn a_zero_limit_still_reads_one() {
        assert_eq!(window(1, 3, 0, 0), Window { start: 1, end: 2, dropped: 0, next: 1 });
    }
}
