//! The tick stream ring.
//!
//! The game thread formats a `tick` notification and drops it in the ring; the stream thread (see
//! [`crate::rpc`]) copies it out and sends it, so the game thread never waits on a socket. Each
//! connection carries its own cursor, and a connection that falls behind loses the oldest lines
//! instead of stalling the game.

use core::sync::atomic::{AtomicU32, Ordering};

use crate::sync::SpinLock;

/// Lines the ring holds, matching `agent.c`'s `STREAM_RING`.
pub const RING: u32 = 128;

/// Bytes per formatted line.
pub const LINE: usize = 480;

/// One formatted notification line.
struct Line {
    tick: u32,
    len: usize,
    text: [u8; LINE],
}

impl Line {
    const fn empty() -> Self {
        Self { tick: 0, len: 0, text: [0; LINE] }
    }
}

struct Ring {
    /// Number of lines ever produced; a reader follows this.
    head: u32,
    lines: [Line; RING as usize],
}

static RING_DATA: SpinLock<Ring> = SpinLock::new(Ring { head: 0, lines: [const { Line::empty() }; RING as usize] });

/// Connections that subscribed.
static SUBSCRIBERS: AtomicU32 = AtomicU32::new(0);

pub fn subscribers() -> u32 {
    SUBSCRIBERS.load(Ordering::Acquire)
}

pub fn subscribe() {
    SUBSCRIBERS.fetch_add(1, Ordering::AcqRel);
}

pub fn unsubscribe() {
    SUBSCRIBERS.fetch_sub(1, Ordering::AcqRel);
}

/// Appends one formatted line, tagged with its simulation tick. Longer lines are dropped: the stream
/// carries a state snapshot, not data.
pub fn push(tick: u32, json: &[u8]) {
    if json.len() > LINE {
        return;
    }
    let mut ring = RING_DATA.lock();
    let head = ring.head;
    let slot = &mut ring.lines[(head % RING) as usize];
    slot.tick = tick;
    slot.len = json.len();
    slot.text[..json.len()].copy_from_slice(json);
    ring.head = head.wrapping_add(1);
}

/// The number of lines ever produced.
pub fn head() -> u32 {
    RING_DATA.lock().head
}

/// Copies line `index` into `out` followed by its `\n`, returning its tick and length with the newline,
/// so the stream thread sends the whole line in one write. `None` when the line has already been
/// overwritten or never existed.
pub fn read(index: u32, out: &mut [u8; LINE + 1]) -> Option<(u32, usize)> {
    let ring = RING_DATA.lock();
    if index >= ring.head || ring.head - index > RING {
        return None;
    }
    let slot = &ring.lines[(index % RING) as usize];
    if slot.len > LINE {
        return None;
    }
    out[..slot.len].copy_from_slice(&slot.text[..slot.len]);
    out[slot.len] = b'\n';
    Some((slot.tick, slot.len + 1))
}
