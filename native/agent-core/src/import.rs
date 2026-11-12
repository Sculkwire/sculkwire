//! Import-address-table hooks: replace the function pointer a module imported, keeping the original.
//!
//! The IAT is the only place an engine can intercept a system call it does not own the code of
//! (`user32!PeekMessageW`), or one that several input modules import (`GetAsyncKeyState`). The
//! patched slot keeps its own copy per module, which is why the original is returned rather than
//! looked up: the caller's replacement forwards to exactly the function that slot used to call.
//!
//! Every lookup is a walk of the module's own import directory, validated at each step (the
//! descriptor table and both thunk arrays are readable, the DLL and function names are NUL-terminated
//! inside the image), so a module that does not import the function answers `None` and the caller
//! leaves it alone.

use core::ffi::c_void;
use core::ptr;

use crate::image::Image;
use crate::win;

/// One import-table slot, with the function it pointed at before any patch.
#[derive(Clone, Copy)]
pub struct Slot {
    /// Address of the slot itself (an 8-byte entry in the module's `.rdata`).
    pub slot: usize,
    /// The function the slot held: what a replacement forwards to.
    pub target: usize,
}

/// `IMAGE_IMPORT_DESCRIPTOR` size.
const DESCRIPTOR: usize = 20;
/// A loaded image has a few hundred descriptors at most; this bounds a corrupt table.
const MAX_DESCRIPTORS: usize = 4096;

/// The slot `module` imports `dll!function` through, or `None` when it does not import it.
///
/// `dll` is the import name as the image spells it (`"user32.dll"`); the comparison ignores case, as
/// the loader's does.
pub fn find(module: win::Hmodule, dll: &str, function: &str) -> Option<Slot> {
    let image = Image::at(module)?;
    let (rva, _size) = image.data_directory(1)?; // IMAGE_DIRECTORY_ENTRY_IMPORT
    let mut descriptor = image.base() + rva as usize;
    for _ in 0..MAX_DESCRIPTORS {
        if !image.is_readable(descriptor, DESCRIPTOR) {
            return None;
        }
        // SAFETY: the descriptor was just verified readable.
        let (original_thunk, name_rva, first_thunk) = unsafe {
            (
                ptr::read_unaligned(descriptor as *const u32),
                ptr::read_unaligned((descriptor + 12) as *const u32),
                ptr::read_unaligned((descriptor + 16) as *const u32),
            )
        };
        if name_rva == 0 || first_thunk == 0 {
            return None; // the terminator: the module does not import it
        }
        // ASCII case-insensitive, which is how the loader compares import names.
        if c_string(&image, name_rva).is_some_and(|name| name.eq_ignore_ascii_case(dll.as_bytes())) {
            return thunks(&image, original_thunk, first_thunk, function);
        }
        descriptor += DESCRIPTOR;
    }
    None
}

/// The named entry of one descriptor's thunk arrays.
fn thunks(image: &Image, original_thunk: u32, first_thunk: u32, function: &str) -> Option<Slot> {
    let base = image.base();
    // The names live in the original thunk array; the slots in the first thunk array.
    let names = if original_thunk != 0 { base + original_thunk as usize } else { base + first_thunk as usize };
    let slots = base + first_thunk as usize;
    let mut index = 0usize;
    loop {
        if !image.is_readable(names + index * 8, 8) || !image.is_readable(slots + index * 8, 8) {
            return None;
        }
        // SAFETY: eight readable bytes at each address (checked above).
        let entry = unsafe { ptr::read_unaligned((names + index * 8) as *const usize) };
        if entry == 0 {
            return None;
        }
        // The top bit marks an ordinal import, which has no name to compare.
        if entry >> 63 == 0 {
            if let Some(name) = c_string(image, entry as u32 + 2) {
                if name.eq_ignore_ascii_case(function.as_bytes()) {
                    let slot = slots + index * 8;
                    // SAFETY: the slot was verified readable above.
                    let target = unsafe { ptr::read_unaligned(slot as *const usize) };
                    return Some(Slot { slot, target });
                }
            }
        }
        index += 1;
    }
}

/// Points `slot` at `replacement`, and reports whether the write landed.
///
/// The page is made writable for the single store and put back: the import table is part of the
/// module's read-only data, and leaving a code page writable would be a needless hole.
pub fn replace(slot: usize, replacement: usize) -> bool {
    let size = core::mem::size_of::<usize>();
    let mut old = 0u32;
    // SAFETY: the slot is an 8-byte import-table entry inside a loaded module; the protection is
    // restored below.
    unsafe {
        if win::VirtualProtect(slot as *mut c_void, size, win::PAGE_READWRITE, &mut old) == 0 {
            return false;
        }
        ptr::write_unaligned(slot as *mut usize, replacement);
        let mut ignored = 0u32;
        win::VirtualProtect(slot as *mut c_void, size, old, &mut ignored);
    }
    true
}

/// The NUL-terminated bytes of a name at `rva`, for as long as the image is mapped.
fn c_string(image: &Image, rva: u32) -> Option<&'static [u8]> {
    let address = image.base() + rva as usize;
    let mut len = 0usize;
    while len < 256 {
        if !image.is_readable(address + len, 1) {
            return None;
        }
        // SAFETY: one readable byte (checked above).
        if unsafe { ptr::read_volatile((address + len) as *const u8) } == 0 {
            // SAFETY: the bytes belong to a loaded module and stay mapped.
            return Some(unsafe { core::slice::from_raw_parts(address as *const u8, len) });
        }
        len += 1;
    }
    None
}
