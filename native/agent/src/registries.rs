//! Which captured registry the client tick reads the local player through, and when the published
//! reading is too old for the tick stream.
//!
//! The `component.getter` hook captures every registry accessor the game hands to `getStorage`, into a
//! few round-robin slots ([`crate::live::note_accessor`]). A world change leaves the old world's
//! accessor in its slot: after a failed join, a left world or a menu preview registry, the lowest slot
//! on the client thread could be a registry the game no longer uses, still holding a player frozen
//! where it stood. So the choice is made from two facts per slot, both kept by the hook:
//!
//! * `captured`: when the accessor entered its slot (a sequence number, newer is larger);
//! * `seen`: the client frame in which the game last passed it to `getStorage`.
//!
//! A registry the game did not use in the last [`RECENT_FRAMES`] client frames is never read, and among
//! the ones it did use the newest capture comes first. The caller reads each candidate in order and
//! takes the first that holds a local player, so a registry without one (the server's, a menu's) is
//! skipped rather than ending the tick.
//!
//! Plain `core` code over numbers (no game memory), so it also builds on its own as a host test crate:
//! `rustc --edition 2021 --test agent/src/registries.rs -o target/registries-test.exe &&
//! ./target/registries-test.exe` (from `native/`).

/// Accessor slots the hook keeps.
pub const SLOTS: usize = 4;

/// A registry is current while the game passed it to `getStorage` in this client frame or the one
/// before: the client tick runs before its frame's systems, so the frame that just ended counts.
pub const RECENT_FRAMES: u64 = 1;

/// A published player reading older than this is not sent on the tick stream: the client tick stopped
/// reading the local player (world change, no current registry), and an old position sent as current
/// is what froze the stream at the world spawn. The client steps every frame, so half a second is
/// several missed frames even at a low frame rate.
pub const STREAM_FRESH_MS: u64 = 500;

/// A `Minecraft` object `sim.update` has not been called with for this long is gone: its world was
/// left. Its slot may hold a new object, and the same address called again later is a new object
/// whose role is proved again. A world change takes seconds; a paused world still calls the step.
pub const OBJECT_SILENT_MS: u64 = 2_000;

/// True when an object last called at `last` (`GetTickCount64`, 0 = never) has been silent at `now`.
pub fn object_silent(last: u64, now: u64) -> bool {
    last != 0 && now.saturating_sub(last) >= OBJECT_SILENT_MS
}

/// The slot a newly seen object takes, from each slot's `(object, last call)`: an empty slot first,
/// else the slot silent the longest, `None` while every object is still being called. Without reuse a
/// session that changes worlds a few times runs out of slots and its new server object is never
/// classified, which stops the tick stream.
pub fn object_slot<const N: usize>(slots: &[(usize, u64); N], now: u64) -> Option<usize> {
    if let Some(index) = slots.iter().position(|(object, _)| *object == 0) {
        return Some(index);
    }
    let mut best: Option<usize> = None;
    for (index, (_, last)) in slots.iter().enumerate() {
        if object_silent(*last, now) && best.map_or(true, |b| *last < slots[b].1) {
            best = Some(index);
        }
    }
    best
}

/// One slot as the hook left it. `accessor == 0` is an empty slot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Capture {
    pub accessor: usize,
    pub thread: u32,
    pub captured: u64,
    pub seen: u64,
}

/// True when the game used this capture's registry within [`RECENT_FRAMES`] of `frame`.
pub fn recent(capture: &Capture, frame: u64) -> bool {
    capture.accessor != 0 && capture.seen.saturating_add(RECENT_FRAMES) >= frame
}

/// The accessors the client tick on `thread` may read the local player through at client frame
/// `frame`, best first, and how many there are.
///
/// Captures on `thread` that are [`recent`], newest capture first; then `fallback` (the accessor the
/// last successful tick read through, which may have been captured on another thread) when its slot is
/// still recent. An accessor appears once. A registry the game stopped using is never returned, so a
/// world change cannot leave the tick reading the old world's player.
pub fn candidates(captures: &[Capture; SLOTS], thread: u32, frame: u64, fallback: usize) -> ([usize; SLOTS + 1], usize) {
    let mut order = [0usize; SLOTS];
    let mut count = 0;
    for (index, capture) in captures.iter().enumerate() {
        if capture.thread == thread && recent(capture, frame) {
            order[count] = index;
            count += 1;
        }
    }
    // Newest capture first: a short insertion sort over at most `SLOTS` entries.
    for i in 1..count {
        let mut j = i;
        while j > 0 && captures[order[j - 1]].captured < captures[order[j]].captured {
            order.swap(j - 1, j);
            j -= 1;
        }
    }
    let mut out = [0usize; SLOTS + 1];
    let mut len = 0;
    for &index in &order[..count] {
        let accessor = captures[index].accessor;
        if !out[..len].contains(&accessor) {
            out[len] = accessor;
            len += 1;
        }
    }
    if fallback != 0
        && !out[..len].contains(&fallback)
        && captures.iter().any(|capture| capture.accessor == fallback && recent(capture, frame))
    {
        out[len] = fallback;
        len += 1;
    }
    (out, len)
}

/// True when a reading stamped at `stamp` (`GetTickCount64`, 0 = never) may still be sent at `now`.
pub fn stream_fresh(stamp: u64, now: u64) -> bool {
    stamp != 0 && now.saturating_sub(stamp) < STREAM_FRESH_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLIENT: u32 = 7;
    const OTHER: u32 = 9;

    fn slot(accessor: usize, thread: u32, captured: u64, seen: u64) -> Capture {
        Capture { accessor, thread, captured, seen }
    }

    fn list(captures: &[Capture; SLOTS], thread: u32, frame: u64, fallback: usize) -> Vec<usize> {
        let (out, len) = candidates(captures, thread, frame, fallback);
        out[..len].to_vec()
    }

    #[test]
    fn the_newest_capture_wins_over_a_lower_slot() {
        // The live fault: the old world's registry in slot 0, the new world's in slot 2, both on the
        // client thread. The old one is still being passed (a lingering level): the newer capture leads.
        let captures = [slot(0xA000, CLIENT, 1, 50), slot(0xB000, OTHER, 2, 50), slot(0xC000, CLIENT, 3, 50), Capture::default()];
        assert_eq!(list(&captures, CLIENT, 50, 0), vec![0xC000, 0xA000]);
    }

    #[test]
    fn a_registry_the_game_stopped_using_is_never_read() {
        // The old world's registry was last passed at frame 10; the new one every frame since 40.
        let captures = [slot(0xA000, CLIENT, 1, 10), slot(0xC000, CLIENT, 3, 49), Capture::default(), Capture::default()];
        assert_eq!(list(&captures, CLIENT, 50, 0), vec![0xC000]);
        // Within a frame of its last use it still counts; two frames later it is gone.
        assert_eq!(list(&captures, CLIENT, 11, 0), vec![0xC000, 0xA000]);
        assert_eq!(list(&captures, CLIENT, 12, 0), vec![0xC000]);
    }

    #[test]
    fn nothing_current_means_no_candidate_not_the_last_one() {
        // Left the world: every capture aged out, the old tick's accessor included.
        let captures = [slot(0xA000, CLIENT, 1, 10), slot(0xB000, OTHER, 2, 10), Capture::default(), Capture::default()];
        assert!(list(&captures, CLIENT, 30, 0xA000).is_empty());
    }

    #[test]
    fn the_fallback_comes_last_and_only_while_its_registry_is_in_use() {
        let captures = [slot(0xB000, OTHER, 2, 49), slot(0xC000, CLIENT, 3, 49), Capture::default(), Capture::default()];
        assert_eq!(list(&captures, CLIENT, 50, 0xB000), vec![0xC000, 0xB000]);
        assert_eq!(list(&captures, CLIENT, 50, 0xC000), vec![0xC000]);
        // A fallback no slot holds any more, or one the game stopped using, is dropped.
        assert_eq!(list(&captures, CLIENT, 50, 0xD000), vec![0xC000]);
        let aged = [slot(0xB000, OTHER, 2, 10), slot(0xC000, CLIENT, 3, 49), Capture::default(), Capture::default()];
        assert_eq!(list(&aged, CLIENT, 50, 0xB000), vec![0xC000]);
    }

    #[test]
    fn a_new_object_takes_an_empty_slot_then_the_longest_silent_one() {
        let now = 100_000;
        assert_eq!(object_slot(&[(0xA, now), (0, 0), (0xC, now), (0, 0)], now), Some(1));
        // Four worlds in: the first two worlds' objects are silent, the oldest call goes first.
        let full = [(0xA, now - 9_000), (0xB, now - 30_000), (0xC, now - 10), (0xD, now)];
        assert_eq!(object_slot(&full, now), Some(1));
        // Every object still stepping: nothing is taken.
        let busy = [(0xA, now - 10), (0xB, now - 1_999), (0xC, now), (0xD, now)];
        assert_eq!(object_slot(&busy, now), None);
    }

    #[test]
    fn an_object_is_silent_only_after_the_whole_gap() {
        assert!(!object_silent(0, 50_000));
        assert!(!object_silent(10_000, 10_000 + OBJECT_SILENT_MS - 1));
        assert!(object_silent(10_000, 10_000 + OBJECT_SILENT_MS));
        assert!(!object_silent(10_000, 9_000));
    }

    #[test]
    fn empty_slots_and_other_threads_are_skipped() {
        let captures = [Capture::default(), slot(0xB000, OTHER, 5, 50), Capture::default(), Capture::default()];
        assert!(list(&captures, CLIENT, 50, 0).is_empty());
        assert_eq!(list(&captures, OTHER, 50, 0), vec![0xB000]);
    }

    #[test]
    fn the_stream_drops_an_old_reading() {
        assert!(!stream_fresh(0, 1_000));
        assert!(stream_fresh(1_000, 1_000));
        assert!(stream_fresh(1_000, 1_000 + STREAM_FRESH_MS - 1));
        assert!(!stream_fresh(1_000, 1_000 + STREAM_FRESH_MS));
        // A clock read before the stamp (another thread published in between) is fresh, not a wrap.
        assert!(stream_fresh(1_000, 900));
    }
}
