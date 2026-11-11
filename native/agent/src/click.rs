//! When an `input.attack` or `input.use` click may run: only while the game's crosshair pick is there.
//!
//! The local player's pick lives in a queue the game fills and empties on its own schedule (the
//! `HitResultComponent` holder, see [`crate::input`]): one entry pair per pick, newest last, and a clear
//! that leaves it empty until the next pick is pushed. A click whose read finds the queue empty reports
//! no target even with the crosshair on a mob, and the click itself ran in that same frame, against the
//! same empty pick. Live, the empty stretch follows the 20 Hz tick: an attack sent a multiple of
//! 50 ms after an `input.look` answered never saw the mob (0 of 12 at 0, 50, 100 and 150 ms), one sent
//! 25 ms off that phase mostly did (8 of 12 at 75 ms), and unsynchronised calls hit 13 of 20. A click
//! that finds the queue empty therefore waits for the next main-thread drain in which it is filled, at
//! most [`WAIT_MS`] (a tick and a half, so every phase of a tick is visited), and then runs in that
//! drain, reading and acting on the same pick. The bound is time, not a drain count: the drains run
//! from the message loop several times a frame. A queue whose shape does not check out is not waited
//! for: the layout moved, and a wait would only delay the click.
//!
//! Plain `core` code over numbers (no game memory), so it also builds on its own as a host test crate:
//! `rustc --edition 2021 --test agent/src/click.rs -o target/click-test.exe && ./target/click-test.exe`
//! (from `native/`).

/// Milliseconds a click waits at most: a tick and a half, so every phase of a tick is visited.
pub const WAIT_MS: u64 = 75;

/// The pick queue as the reader found it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Queue {
    /// Nothing queued right now: the game emptied it and has not pushed the next pick yet.
    Empty,
    /// The newest entry's address.
    Newest(usize),
    /// Not the vector this reader knows.
    Bad,
}

/// The queue from its vector bounds: `begin`/`end` of `entry`-byte entries, at most `max` of them.
pub fn queue(begin: usize, end: usize, entry: usize, max: usize) -> Queue {
    if end == begin {
        return Queue::Empty;
    }
    if begin == 0 || end < begin || entry == 0 || (end - begin) % entry != 0 || (end - begin) / entry > max {
        return Queue::Bad;
    }
    Queue::Newest(end - entry)
}

/// True when a click that has waited `waited_ms` milliseconds runs now: the pick is there (`ready`), or
/// the wait reached its bound.
pub fn run_now(ready: bool, waited_ms: u64) -> bool {
    ready || waited_ms >= WAIT_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY: usize = 0x110;

    #[test]
    fn an_emptied_queue_is_empty_not_bad() {
        assert_eq!(queue(0x5000, 0x5000, ENTRY, 256), Queue::Empty);
        // A holder that never held a pick: no vector allocated yet.
        assert_eq!(queue(0, 0, ENTRY, 256), Queue::Empty);
    }

    #[test]
    fn the_newest_entry_is_the_last_one() {
        assert_eq!(queue(0x5000, 0x5000 + ENTRY, ENTRY, 256), Queue::Newest(0x5000));
        assert_eq!(queue(0x5000, 0x5000 + 3 * ENTRY, ENTRY, 256), Queue::Newest(0x5000 + 2 * ENTRY));
    }

    #[test]
    fn a_queue_of_another_shape_is_bad() {
        assert_eq!(queue(0x5000, 0x5000 + ENTRY + 8, ENTRY, 256), Queue::Bad);
        assert_eq!(queue(0x5000 + ENTRY, 0x5000, ENTRY, 256), Queue::Bad);
        assert_eq!(queue(0, ENTRY, ENTRY, 256), Queue::Bad);
        assert_eq!(queue(0x5000, 0x5000 + 300 * ENTRY, ENTRY, 256), Queue::Bad);
    }

    #[test]
    fn a_click_waits_for_the_pick_within_its_bound() {
        assert!(run_now(true, 0));
        assert!(!run_now(false, 0));
        assert!(!run_now(false, WAIT_MS - 1));
        assert!(run_now(false, WAIT_MS));
    }
}
