//! The game module's PE image: sections, string anchors, validated RIP-relative references,
//! `.pdata` function boundaries and MSVC RTTI.
//!
//! Everything here is build-agnostic: it reads the loaded image the process already has, and every
//! answer is validated (an instruction boundary is decoded, a `.pdata` entry must contain the
//! address, a vtable slot must point into `.text`), so a wrong hit is refused rather than returned.

use alloc::vec::Vec;
use core::ffi::c_void;

use crate::sync::Once;
use crate::win;
use crate::x64;

/// `.pdata` data-directory index.
const DIR_EXCEPTION: u32 = 3;

/// One PE section of a loaded module.
#[derive(Clone, Copy)]
pub struct Section {
    pub name: [u8; 8],
    pub va: usize,
    pub len: usize,
}

impl Section {
    pub fn name(&self) -> &str {
        let end = self.name.iter().position(|c| *c == 0).unwrap_or(self.name.len());
        core::str::from_utf8(&self.name[..end]).unwrap_or("")
    }

    /// True for a section that holds data: not code (`.text*`) and not the exception, resource or
    /// relocation tables.
    pub fn is_data(&self) -> bool {
        let name = self.name();
        !(name.starts_with(".text") || matches!(name, ".pdata" | ".rsrc" | ".reloc"))
    }

    /// Bytes of the section, valid while the image is loaded.
    fn bytes(&self) -> &'static [u8] {
        // SAFETY: a loaded section is mapped and committed for its virtual size.
        unsafe { core::slice::from_raw_parts(self.va as *const u8, self.len) }
    }
}

/// A loaded module, as the process sees it.
pub struct Image {
    base: usize,
    size: usize,
    sections: Vec<Section>,
}

/// The process's main module, built once. Static storage, so `&'static Image` needs no leak.
static GAME: Once<Image> = Once::new();

/// The game module's image, for [`crate::Core::image`].
pub fn game() -> &'static Image {
    GAME.get_or_init(Image::current)
}

impl Image {
    /// Builds the image of the process's main module.
    pub fn current() -> Image {
        Image::at(win::main_module()).unwrap_or_else(Image::empty)
    }

    /// An image with no sections, for a process whose headers cannot be read.
    pub fn empty() -> Image {
        Image { base: 0, size: 0, sections: Vec::new() }
    }

    /// Builds the image of the module loaded at `base`, or `None` when it is not a PE32+ image.
    pub fn at(base: usize) -> Option<Image> {
        let size = Image::size_of_module(base);
        if size == 0 {
            return None;
        }
        let mut sections = Vec::new();
        // SAFETY: `base` is the start of a loaded module with a valid PE header (checked above).
        unsafe {
            let dos = base as *const u8;
            let lfanew = core::ptr::read_unaligned(dos.add(0x3c) as *const u32) as usize;
            let coff = base + lfanew + 4;
            let count = core::ptr::read_unaligned((coff + 2) as *const u16) as usize;
            let opt_size = core::ptr::read_unaligned((coff + 16) as *const u16) as usize;
            let table = coff + 20 + opt_size;
            for i in 0..count.min(96) {
                let header = table + i * 40;
                let mut name = [0u8; 8];
                core::ptr::copy_nonoverlapping(header as *const u8, name.as_mut_ptr(), 8);
                let vsize = core::ptr::read_unaligned((header + 8) as *const u32) as usize;
                let vaddr = core::ptr::read_unaligned((header + 12) as *const u32) as usize;
                let raw_size = core::ptr::read_unaligned((header + 16) as *const u32) as usize;
                sections.push(Section {
                    name,
                    va: base + vaddr,
                    len: if vsize != 0 { vsize } else { raw_size },
                });
            }
        }
        Some(Image { base, size, sections })
    }

    /// `OptionalHeader.SizeOfImage` of the module at `base`, or 0 when it is not a PE image.
    pub fn size_of_module(base: usize) -> usize {
        if base == 0 || !Image::range_readable(base, 0x40) {
            return 0;
        }
        // SAFETY: the DOS header is readable; the PE offset is then validated before use.
        unsafe {
            let lfanew = core::ptr::read_unaligned((base + 0x3c) as *const u32) as usize;
            if lfanew == 0 || lfanew > 0x1000 || !Image::range_readable(base + lfanew, 0x58) {
                return 0;
            }
            let signature = core::ptr::read_unaligned((base + lfanew) as *const u32);
            if signature != 0x0000_4550 {
                return 0;
            }
            core::ptr::read_unaligned((base + lfanew + 24 + 56) as *const u32) as usize
        }
    }

    pub fn base(&self) -> usize {
        self.base
    }

    pub fn size(&self) -> usize {
        self.size
    }

    pub fn sections(&self) -> &[Section] {
        &self.sections
    }

    pub fn section(&self, name: &str) -> Option<Section> {
        self.sections.iter().copied().find(|s| s.name() == name)
    }

    /// The `.text` section (the executable code).
    pub fn text(&self) -> Option<Section> {
        self.sections.iter().copied().find(|s| s.name().starts_with(".text"))
    }

    /// A data directory's RVA and size, for callers that walk the image themselves (the lock's
    /// import-table patching).
    pub fn data_directory(&self, index: u32) -> Option<(u32, u32)> {
        // SAFETY: the header is present (checked when the image was built).
        unsafe {
            let dos = self.base as *const u8;
            let lfanew = core::ptr::read_unaligned(dos.add(0x3c) as *const u32) as usize;
            let optional = self.base + lfanew + 24;
            let magic = core::ptr::read_unaligned(optional as *const u16);
            if magic != 0x20b {
                return None; // PE32+ only
            }
            let count = core::ptr::read_unaligned((optional + 108) as *const u32);
            if index >= count {
                return None;
            }
            let entry = optional + 112 + index as usize * 8;
            let rva = core::ptr::read_unaligned(entry as *const u32);
            let size = core::ptr::read_unaligned((entry + 4) as *const u32);
            if rva == 0 || size == 0 {
                None
            } else {
                Some((rva, size))
            }
        }
    }

    /// Every occurrence of `needle` (with a trailing NUL) in the image's non-executable sections,
    /// which is where MSVC keeps string literals.
    pub fn find_strings(&self, needle: &[u8], out: &mut [usize]) -> usize {
        if needle.is_empty() {
            return 0;
        }
        let mut found = 0;
        for section in &self.sections {
            if found >= out.len() {
                break;
            }
            if !section.is_data() {
                continue;
            }
            let bytes = section.bytes();
            if bytes.len() < needle.len() + 1 {
                continue;
            }
            let mut offset = 0;
            while offset + needle.len() < bytes.len() {
                if bytes[offset] == needle[0] && &bytes[offset..offset + needle.len()] == needle {
                    if bytes[offset + needle.len()] == 0 {
                        out[found] = section.va + offset;
                        found += 1;
                        if found >= out.len() {
                            break;
                        }
                    }
                }
                offset += 1;
            }
        }
        found
    }

    /// The first occurrence of `needle` as a NUL-terminated string in a non-executable section.
    pub fn find_string(&self, needle: &[u8]) -> Option<usize> {
        let mut found = [0usize; 1];
        (self.find_strings(needle, &mut found) > 0).then_some(found[0])
    }

    /// Every validated RIP-relative `lea`/`mov` reference to `target` in `.text`.
    ///
    /// The scan finds the 4-byte displacement first, then tries each possible instruction start
    /// within the maximum instruction length, so a displacement that merely looks right inside some
    /// other instruction is not mistaken for a reference.
    pub fn rip_refs(&self, target: usize, out: &mut [usize]) -> usize {
        let Some(text) = self.text() else {
            return 0;
        };
        let code = text.bytes();
        let mut found = 0;
        let mut offset = 0;
        while offset + 4 <= code.len() {
            // SAFETY: four bytes are readable at `offset`.
            let raw = unsafe { core::ptr::read_unaligned(code.as_ptr().add(offset) as *const u32) };
            let disp = raw as i32 as i64;
            if text.va.wrapping_add(offset).wrapping_add(4).wrapping_add(disp as usize) != target {
                offset += 1;
                continue;
            }
            let mut hit = 0;
            for back in 1..=15usize {
                if back > offset {
                    break;
                }
                // SAFETY: `back + 4` bytes from `offset - back` are inside the section.
                let Some(insn) = (unsafe { x64::decode(code.as_ptr().add(offset - back), back + 4) }) else {
                    continue;
                };
                if insn.len != back + 4 || !insn.rip || insn.disp_off != back {
                    continue;
                }
                if !matches!(insn.opcode, 0x8D | 0x8B | 0x89 | 0x8A | 0x88 | 0x8C | 0x8E) {
                    continue;
                }
                hit = text.va + offset - back;
                break;
            }
            if hit != 0 {
                out[found] = hit;
                found += 1;
                if found >= out.len() {
                    break;
                }
            }
            offset += 1;
        }
        found
    }

    /// The first validated RIP-relative reference to `target`.
    pub fn rip_ref(&self, target: usize) -> Option<usize> {
        let mut found = [0usize; 1];
        (self.rip_refs(target, &mut found) > 0).then_some(found[0])
    }

    /// `.pdata`'s `RUNTIME_FUNCTION` entry containing `va`: `(start, end)` absolute addresses.
    fn function_range(&self, va: usize) -> Option<(usize, usize)> {
        let (rva, size) = self.data_directory(DIR_EXCEPTION)?;
        let table = self.base + rva as usize;
        let count = size as usize / 12;
        if count == 0 || va < self.base {
            return None;
        }
        let target = (va - self.base) as u32;
        // Binary search for the last entry whose BeginAddress is <= target.
        let (mut low, mut high) = (0usize, count);
        while low < high {
            let mid = low + (high - low) / 2;
            // SAFETY: the entry is inside the `.pdata` table.
            let begin = unsafe { core::ptr::read_unaligned((table + mid * 12) as *const u32) };
            if begin <= target {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        if low == 0 {
            return None;
        }
        let index = low - 1;
        // SAFETY: the entry is inside the `.pdata` table.
        let (begin, end) = unsafe {
            (
                core::ptr::read_unaligned((table + index * 12) as *const u32),
                core::ptr::read_unaligned((table + index * 12 + 4) as *const u32),
            )
        };
        if target >= begin && target < end {
            Some((self.base + begin as usize, self.base + end as usize))
        } else {
            None
        }
    }

    /// Start of the function containing `va`, from `.pdata`.
    pub fn function_start(&self, va: usize) -> Option<usize> {
        self.function_range(va).map(|(start, _)| start)
    }

    /// End (exclusive) of the function containing `va`, from `.pdata`.
    pub fn function_end(&self, va: usize) -> Option<usize> {
        self.function_range(va).map(|(_, end)| end)
    }

    /// The function that refers to `needle`: string → validated RIP-relative reference → `.pdata`.
    pub fn function_from_string(&self, needle: &[u8]) -> Option<usize> {
        let string = self.find_string(needle)?;
        let reference = self.rip_ref(string)?;
        self.function_start(reference)
    }

    /// The MSVC `TypeDescriptor` whose `.?AV...` (class) or `.?AU...` (struct) name is exactly `mangled`.
    pub fn type_descriptor(&self, mangled: &[u8]) -> Option<usize> {
        if mangled.is_empty() {
            return None;
        }
        for section in &self.sections {
            let name = section.name();
            if !(name.starts_with(".rdata") || name == ".data") {
                continue;
            }
            let bytes = section.bytes();
            // TypeDescriptor: vftable pointer (8) | spare (8) | name[] — so scan from 16 on.
            let mut offset = 16;
            while offset + 4 <= bytes.len() {
                if bytes[offset] == b'.' && bytes[offset + 1] == b'?' && bytes[offset + 2] == b'A' && (bytes[offset + 3] == b'V' || bytes[offset + 3] == b'U') {
                    let mut n = 0;
                    while offset + n < bytes.len() && bytes[offset + n] != 0 && n < 1024 {
                        n += 1;
                    }
                    if n == mangled.len() && &bytes[offset..offset + n] == mangled {
                        return Some(section.va + offset - 16);
                    }
                    offset += n;
                } else {
                    offset += 1;
                }
            }
        }
        None
    }

    /// Every vtable whose `CompleteObjectLocator` names `type_descriptor`.
    pub fn vtables(&self, type_descriptor: usize, out: &mut [usize]) -> usize {
        let mut found = 0;
        let text = self.text();
        let (text_lo, text_hi) = text.map(|t| (t.va, t.va + t.len)).unwrap_or((0, 0));
        let Some(col) = self.complete_object_locator(type_descriptor) else {
            return 0;
        };
        for section in &self.sections {
            if !(section.name().starts_with(".rdata") || section.name() == ".data") {
                continue;
            }
            let bytes = section.bytes();
            let mut offset = 0;
            while offset + 16 <= bytes.len() {
                // SAFETY: 8 readable bytes inside the section.
                let pointer = unsafe { core::ptr::read_unaligned(bytes.as_ptr().add(offset) as *const usize) };
                if pointer == col {
                    let vtable = section.va + offset + 8;
                    // SAFETY: the slot is inside the section.
                    let slot0 = unsafe { core::ptr::read_unaligned((vtable) as *const usize) };
                    if slot0 >= text_lo && slot0 < text_hi {
                        out[found] = vtable;
                        found += 1;
                        if found >= out.len() {
                            return found;
                        }
                    }
                }
                offset += 8;
            }
        }
        found
    }

    /// The vtable of a class, by its mangled RTTI name (`".?AVLocalPlayer@@"`).
    pub fn vtable(&self, mangled: &[u8]) -> Option<usize> {
        let td = self.type_descriptor(mangled)?;
        let mut found = [0usize; 1];
        (self.vtables(td, &mut found) > 0).then_some(found[0])
    }

    /// The `CompleteObjectLocator` of a `TypeDescriptor`, if present.
    fn complete_object_locator(&self, type_descriptor: usize) -> Option<usize> {
        for section in &self.sections {
            if !section.name().starts_with(".rdata") {
                continue;
            }
            let bytes = section.bytes();
            let mut offset = 0;
            while offset + 24 <= bytes.len() {
                // signature == 1 (x64), pTypeDescriptor at +12, self RVA at +20.
                // SAFETY: 24 readable bytes inside the section.
                let (signature, ptd, self_rva) = unsafe {
                    let words = bytes.as_ptr().add(offset) as *const u32;
                    (
                        core::ptr::read_unaligned(words),
                        core::ptr::read_unaligned(words.add(3)),
                        core::ptr::read_unaligned(words.add(5)),
                    )
                };
                let location = section.va + offset;
                if signature == 1
                    && self.base + ptd as usize == type_descriptor
                    && self_rva as usize == location - self.base
                {
                    return Some(location);
                }
                offset += 4;
            }
        }
        None
    }

    /// True when `[address, address+len)` is committed and readable in this process.
    pub fn is_readable(&self, address: usize, len: usize) -> bool {
        Image::range_readable(address, len)
    }

    /// [`is_readable`](Self::is_readable) without an image: a `VirtualQuery` walk.
    pub fn range_readable(address: usize, len: usize) -> bool {
        // The user-mode half of a 47-bit address space. Wine's `VirtualQuery` answers *success* for
        // `0xffff_ffff_ffff_ffff` (live: `options` scanned an object word of -1, was told it was
        // readable, and faulted reading it), so a range outside it is refused before the query.
        const USER_TOP: usize = 0x0000_7FFF_FFFF_FFFF;
        if address == 0 || address > USER_TOP || len > USER_TOP - address {
            return false;
        }
        let end = address + len.max(1);
        let mut cursor = address;
        while cursor < end {
            let mut info = win::MemoryBasicInformation {
                base_address: core::ptr::null_mut(),
                allocation_base: core::ptr::null_mut(),
                allocation_protect: 0,
                partition_id: 0,
                _pad: 0,
                region_size: 0,
                state: 0,
                protect: 0,
                kind: 0,
            };
            // SAFETY: the out pointer is a valid MEMORY_BASIC_INFORMATION.
            let got = unsafe {
                win::VirtualQuery(cursor as *const c_void, &mut info, core::mem::size_of::<win::MemoryBasicInformation>())
            };
            if got == 0 {
                return false;
            }
            if info.state != win::MEM_COMMIT || info.protect == win::PAGE_NOACCESS || (info.protect & win::PAGE_GUARD) != 0 {
                return false;
            }
            let next = (info.base_address as usize).saturating_add(info.region_size);
            if next <= cursor {
                return false;
            }
            cursor = next;
        }
        true
    }
}
