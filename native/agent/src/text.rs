//! A `std::string` the game can read, built without the game's allocator.
//!
//! MSVC's `std::string` is 32 bytes: a 16-byte buffer that is either the text itself (short strings)
//! or a pointer to it, the size at `+0x10` and the capacity at `+0x18`. The game copies or parses a
//! `std::string const*` it is handed, so the only requirement is that the bytes be exactly that
//! shape and that the text outlive the call — which is why the block a long string needs is owned by
//! this type and freed when it drops.

use agent_core::win;

/// The bytes of a `std::string`, plus the block a long text needs.
pub(crate) struct Text {
    bytes: [u8; 32],
    block: usize,
}

impl Text {
    /// A `std::string` holding `text`, or `None` when its buffer cannot be allocated.
    pub(crate) fn new(text: &str) -> Option<Text> {
        let text = text.as_bytes();
        let mut bytes = [0u8; 32];
        let mut block = 0usize;
        if text.len() < 16 {
            bytes[..text.len()].copy_from_slice(text);
            bytes[16..24].copy_from_slice(&text.len().to_ne_bytes());
            bytes[24..32].copy_from_slice(&15usize.to_ne_bytes());
        } else {
            // SAFETY: a plain process-heap allocation, freed in `Drop`; the game only reads it.
            let allocated = unsafe { win::HeapAlloc(win::GetProcessHeap(), 0, text.len() + 1) };
            if allocated.is_null() {
                return None;
            }
            // SAFETY: the block holds `text.len() + 1` bytes.
            unsafe {
                core::ptr::copy_nonoverlapping(text.as_ptr(), allocated, text.len());
                *allocated.add(text.len()) = 0;
            }
            bytes[..8].copy_from_slice(&(allocated as usize).to_ne_bytes());
            bytes[16..24].copy_from_slice(&text.len().to_ne_bytes());
            bytes[24..32].copy_from_slice(&text.len().to_ne_bytes());
            block = allocated as usize;
        }
        Some(Text { bytes, block })
    }

    /// The address of the 32-byte `std::string`.
    pub(crate) fn as_ptr(&self) -> *const u8 {
        self.bytes.as_ptr()
    }
}

impl Drop for Text {
    fn drop(&mut self) {
        if self.block != 0 {
            // SAFETY: the block came from `HeapAlloc` above and is freed exactly once.
            unsafe {
                win::HeapFree(win::GetProcessHeap(), 0, self.block as *mut u8);
            }
        }
    }
}
