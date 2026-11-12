//! Walks of the loaded game image, and the only place this crate touches game memory by address.
//!
//! Every read first asks `VirtualQuery` whether the range is committed and readable
//! ([`agent_core::Image::range_readable`]), so a wrong pointer answers "unreadable" instead of
//! faulting inside the game. Every anchor is a *recipe* over the image the process already has — a
//! metadata triple, a string reference, an ECS component hash, a call site — never an address.

use alloc::vec::Vec;
use core::ptr;
use core::slice;

use agent_core::{x64, Image};

/// True when `[addr, addr + len)` is committed, readable and not a guard page.
pub(crate) fn readable(addr: usize, len: usize) -> bool {
    addr >= 0x1_0000 && Image::range_readable(addr, len)
}

/// The process's committed, readable regions, from one `VirtualQuery` walk.
///
/// A scan that tests every qword of a 9 MB section against a candidate pointer cannot ask
/// `VirtualQuery` about each one: that is a syscall per qword, about a second of stall inside the
/// game. One walk (a few hundred regions) plus a binary search per candidate costs milliseconds and
/// answers the same question — and it is fresh for every scan, so a heap region committed since the
/// last one is still accepted.
pub(crate) fn regions() -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut address = 0x1_0000usize;
    // The user-mode half of a 47-bit address space; the walk stops earlier when it runs out.
    const TOP: usize = 0x0000_7FFF_FFFF_FFFF;
    // A `VirtualQuery` that fails is skipped over, not treated as the end: one unqueryable gap used
    // to truncate the walk at ~117 MB and hide the high Wine mappings (0x7f… ) entirely.
    const SKIP: usize = 0x0100_0000;
    const MAX_FAILURES: usize = 4096;
    let mut failures = 0usize;
    while address < TOP && out.len() < 65536 && failures < MAX_FAILURES {
        let mut info = agent_core::win::MemoryBasicInformation {
            base_address: ptr::null_mut(),
            allocation_base: ptr::null_mut(),
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
            agent_core::win::VirtualQuery(
                address as *const core::ffi::c_void,
                &mut info,
                core::mem::size_of::<agent_core::win::MemoryBasicInformation>(),
            )
        };
        if got == 0 {
            failures += 1;
            address = address.saturating_add(SKIP);
            continue;
        }
        let base = info.base_address as usize;
        let end = base.saturating_add(info.region_size);
        if info.state == agent_core::win::MEM_COMMIT
            && info.protect != agent_core::win::PAGE_NOACCESS
            && info.protect & agent_core::win::PAGE_GUARD == 0
        {
            out.push((base, end));
        }
        if end <= address {
            address = address.saturating_add(SKIP);
            continue;
        }
        address = end;
    }
    let bytes: usize = out.iter().map(|(start, end)| end - start).sum();
    agent_core::log::fmt(format_args!("regions: {} readable regions, {} MB", out.len(), bytes / (1024 * 1024)));
    out
}

/// True when `[addr, addr + len)` lies inside one of `regions` (a [`regions`] walk).
pub(crate) fn in_regions(regions: &[(usize, usize)], addr: usize, len: usize) -> bool {
    let end = addr.saturating_add(len);
    // The regions are ascending and disjoint: the only candidate is the one containing `addr`.
    let index = regions.partition_point(|(start, _)| *start <= addr);
    match index.checked_sub(1).map(|index| regions[index]) {
        Some((start, stop)) => addr >= start && end <= stop,
        None => false,
    }
}

/// The first qword equal to `needle` in the process's readable regions, cheapest first, plus how many
/// bytes and regions were covered.
///
/// A scan over the whole address space is not affordable, so the regions that hold `preferred`
/// addresses (the game objects already known) are searched first and the rest follow by size, and the
/// total is capped by `budget`. Read-only, and every region in the list was verified committted and
/// readable when it was built.
pub(crate) fn find_qword(needle: usize, budget: usize, preferred: &[usize]) -> (Option<usize>, usize, usize) {
    let mut regions = regions();
    // The regions holding a known object first, then the smaller ones (they are cheaper to rule out).
    let rank = |region: &(usize, usize)| -> (u8, usize) {
        let holds = preferred.iter().any(|address| *address >= region.0 && *address < region.1);
        (if holds { 0 } else { 1 }, region.1 - region.0)
    };
    regions.sort_by_key(rank);
    /// How much of one region is read at a time: a region can be a whole gigabyte, and a single
    /// unreadable page inside it must cost that page, not the region (which is what made an earlier
    /// scan cover 119 MB of a 3.7 GB address space and report "not found").
    const CHUNK: usize = 1 << 20;
    let mut scanned = 0usize;
    let mut covered = 0usize;
    for (start, end) in regions {
        let mut at = start;
        while at < end && scanned < budget {
            let want = (end - at).min(CHUNK).min(budget - scanned);
            // Whole qwords only: a hit is a qword, so a partial tail can only hide a false negative.
            let want = want & !7;
            if want == 0 {
                break;
            }
            match bytes(at, want) {
                Some(bytes) => {
                    scanned += want;
                    covered += 1;
                    if let Some(found) = scan_qwords(bytes, at, needle) {
                        return (Some(found), scanned, covered);
                    }
                }
                None => {
                    // A chunk the OS will not hand over in one range: its pages are tried one by one,
                    // which is what keeps a coarse Wine region from costing a whole megabyte.
                    let mut page = at;
                    while page < at + want {
                        let len = (at + want - page).min(0x1000) & !7;
                        if len != 0 {
                            if let Some(bytes) = bytes(page, len) {
                                scanned += len;
                                covered += 1;
                                if let Some(found) = scan_qwords(bytes, page, needle) {
                                    return (Some(found), scanned, covered);
                                }
                            }
                        }
                        page += 0x1000;
                    }
                }
            }
            at += want;
        }
        if scanned >= budget {
            break;
        }
    }
    (None, scanned, covered)
}

/// The first address in `chunk` whose qword equals `needle`, written as an absolute address.
fn scan_qwords(chunk: &[u8], base: usize, needle: usize) -> Option<usize> {
    let mut offset = 0usize;
    while offset + 8 <= chunk.len() {
        // SAFETY: eight bytes inside a chunk the caller verified readable.
        let word = unsafe { core::ptr::read_unaligned(chunk.as_ptr().add(offset) as *const u64) } as usize;
        if word == needle {
            return Some(base + offset);
        }
        offset += 8;
    }
    None
}

/// Reads `T` at `addr`, or `None` when the range is not readable. Every game-structure read goes
/// through this.
pub(crate) fn read<T: Copy>(addr: usize) -> Option<T> {
    if !readable(addr, core::mem::size_of::<T>()) {
        return None;
    }
    // SAFETY: the range was just verified readable and `T` is `Copy`.
    Some(unsafe { ptr::read_unaligned(addr as *const T) })
}

/// A readable byte range of the image.
pub(crate) fn bytes(addr: usize, len: usize) -> Option<&'static [u8]> {
    if !readable(addr, len) {
        return None;
    }
    // SAFETY: the range was just verified readable; image bytes live as long as the process.
    Some(unsafe { slice::from_raw_parts(addr as *const u8, len) })
}

/// A NUL-terminated string of at most `max` bytes.
pub(crate) fn cstr(addr: usize, max: usize) -> Option<&'static [u8]> {
    let text = bytes(addr, max)?;
    let len = text.iter().position(|c| *c == 0)?;
    Some(&text[..len])
}

/// The executable section: its address and bytes.
pub(crate) struct Code {
    pub va: usize,
    pub bytes: &'static [u8],
}

/// The image's `.text`, for a scan that walks every byte.
pub(crate) fn code(image: &Image) -> Option<Code> {
    let text = image.text()?;
    Some(Code { va: text.va, bytes: bytes(text.va, text.len)? })
}

/// True when `needle` occurs in `haystack`.
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|window| window == needle)
}

/// The function (`(start, end)`) holding `va`, from `.pdata`.
pub(crate) fn function_of(image: &Image, va: usize) -> Option<(usize, usize)> {
    Some((image.function_start(va)?, image.function_end(va)?))
}

/// Every 4-byte little-endian occurrence of each target in `.text`, one list per target.
///
/// Component hashes and other immediates are found this way; callers keep only the hits they can
/// tie to an instruction, a function or an accessor call.
pub(crate) fn scan_u32(image: &Image, targets: &[u32]) -> Vec<Vec<usize>> {
    let mut out: Vec<Vec<usize>> = targets.iter().map(|_| Vec::new()).collect();
    let Some(code) = code(image) else {
        return out;
    };
    let haystack = code.bytes;
    let mut offset = 0usize;
    while offset + 4 <= haystack.len() {
        // SAFETY: four readable bytes remain in the section.
        let value = unsafe { ptr::read_unaligned(haystack.as_ptr().add(offset) as *const u32) };
        for (index, target) in targets.iter().enumerate() {
            if value == *target {
                out[index].push(code.va + offset);
            }
        }
        offset += 1;
    }
    out
}

/// Every validated RIP-relative reference to each target, one list per target.
///
/// A displacement is only accepted when an instruction ending exactly at it decodes to a
/// RIP-relative `lea`/`mov` form, which is the same rule [`Image::rip_refs`] applies one target at a
/// time; doing every target in one pass is what keeps attach time reasonable on a 200 MB `.text`.
pub(crate) fn scan_refs(image: &Image, targets: &[usize]) -> Vec<Vec<usize>> {
    let mut out: Vec<Vec<usize>> = targets.iter().map(|_| Vec::new()).collect();
    if targets.is_empty() {
        return out;
    }
    let Some(code) = code(image) else {
        return out;
    };
    let mut sorted: Vec<(usize, usize)> = targets.iter().copied().enumerate().map(|(index, target)| (target, index)).collect();
    sorted.sort_unstable();
    let haystack = code.bytes;
    let mut offset = 0usize;
    while offset + 4 <= haystack.len() {
        // SAFETY: four readable bytes remain in the section.
        let wide = unsafe { ptr::read_unaligned(haystack.as_ptr().add(offset) as *const i32) } as i64;
        let after = (code.va + offset + 4) as i64;
        let target = after + wide;
        if target <= 0 {
            offset += 1;
            continue;
        }
        let target = target as usize;
        let Ok(found) = sorted.binary_search_by_key(&target, |(value, _)| *value) else {
            offset += 1;
            continue;
        };
        let index = sorted[found].1;
        // The displacement belongs to an instruction that starts at most 15 bytes earlier.
        for back in 1..=15usize {
            if back > offset {
                break;
            }
            // SAFETY: `back + 4` bytes from `offset - back` are inside the section.
            let Some(insn) = (unsafe { x64::decode(haystack.as_ptr().add(offset - back), back + 4) }) else {
                continue;
            };
            if insn.len != back + 4 || !insn.rip || insn.disp_off != back || insn.rel != 0 {
                continue;
            }
            if out[index].len() < 256 {
                out[index].push(code.va + offset - back);
            }
            break;
        }
        offset += 1;
    }
    out
}

/// The targets of every direct `call rel32` inside `[start, end)`.
///
/// A displacement that is not an instruction start cannot be a call site, so only the four bytes
/// after an `E8` are read; the scan skips them so a byte inside a displacement is never mistaken for
/// an opcode.
pub(crate) fn callees(start: usize, end: usize) -> Vec<usize> {
    let mut out = Vec::new();
    let Some(body) = bytes(start, end.saturating_sub(start)) else {
        return out;
    };
    let mut at = 0usize;
    while at + 5 <= body.len() {
        if body[at] == 0xE8 {
            // SAFETY: four displacement bytes follow the opcode inside the range.
            let rel = unsafe { ptr::read_unaligned(body.as_ptr().add(at + 1) as *const i32) } as i64;
            let target = (start + at + 5) as i64 + rel;
            if target > 0 {
                out.push(target as usize);
            }
            at += 5;
        } else {
            at += 1;
        }
    }
    out
}

/// `pattern` in `.text` exactly once, at an instruction the image's unwind table names as a function
/// entry; `None` when it occurs zero or several times (a recipe that is not unique is refused).
pub(crate) fn signature_function(image: &Image, pattern: &[u8]) -> Option<usize> {
    if pattern.is_empty() {
        return None;
    }
    let code = code(image)?;
    let mut found: Option<usize> = None;
    let mut at = 0usize;
    while at + pattern.len() <= code.bytes.len() {
        if &code.bytes[at..at + pattern.len()] == pattern {
            if found.is_some() {
                return None;
            }
            found = Some(code.va + at);
        }
        at += 1;
    }
    let found = found?;
    image.function_start(found).filter(|start| *start == found)
}

/// The targets of every `lea r8,[rip+disp32]` (`4C 8D 05`) and `lea rdx,[rip+disp32]` (`48 8D 15`)
/// in `[start, end)` that name a function entry: the code pointers a body hands to a register.
pub(crate) fn lea_function_targets(image: &Image, start: usize, end: usize) -> Vec<usize> {
    let mut out = Vec::new();
    let Some(body) = bytes(start, end.saturating_sub(start)) else {
        return out;
    };
    for prefix in [[0x4C, 0x8D, 0x05], [0x48, 0x8D, 0x15]] {
        let mut at = 0usize;
        while at + 7 <= body.len() {
            if body[at..at + 3] == prefix {
                // SAFETY: four displacement bytes follow the three opcode bytes.
                let disp = unsafe { ptr::read_unaligned(body.as_ptr().add(at + 3) as *const i32) } as i64;
                let target = (start + at + 7) as i64 + disp;
                if target > 0 && image.function_start(target as usize) == Some(target as usize) {
                    out.push(target as usize);
                }
                at += 7;
            } else {
                at += 1;
            }
        }
    }
    out
}

/// True when `address` is inside the game image and in a non-executable section: a vtable or other
/// data the game dispatches through, never code.
pub(crate) fn in_image_data(address: usize) -> bool {
    in_data(agent_core::image::game(), address)
}

/// True when `address` is inside `image` and in a non-executable section.
pub(crate) fn in_data(image: &Image, address: usize) -> bool {
    if address < image.base() || address >= image.base() + image.size() {
        return false;
    }
    for section in image.sections() {
        if !section.is_data() {
            continue;
        }
        if address >= section.va && address < section.va + section.len {
            return true;
        }
    }
    false
}

/// `"41 C6 ?? 08"` → wildcard bytes.
pub(crate) fn parse_pattern(text: &str) -> Vec<Option<u8>> {
    text.split_ascii_whitespace().map(|token| if token == "??" { None } else { u8::from_str_radix(token, 16).ok() }).collect()
}

/// The address of the one qword in the image's data equal to `value`, when exactly one is.
pub(crate) fn unique_data_slot(image: &Image, value: usize) -> Option<usize> {
    let mut found: Option<usize> = None;
    for section in image.sections() {
        if !section.is_data() {
            continue;
        }
        let Some(bytes) = bytes(section.va, section.len) else {
            continue;
        };
        let mut offset = 0usize;
        while offset + 8 <= bytes.len() {
            // SAFETY: eight bytes inside a readable section; table slots are 8-byte aligned.
            let word = unsafe { ptr::read_unaligned(bytes.as_ptr().add(offset) as *const u64) } as usize;
            if word == value {
                if found.is_some() {
                    return None;
                }
                found = Some(section.va + offset);
            }
            offset += 8;
        }
    }
    found
}


/// True when `address` is inside the image's executable section: a code pointer.
pub(crate) fn in_image_code(address: usize) -> bool {
    match agent_core::image::game().text() {
        Some(text) => address >= text.va && address < text.va + text.len,
        None => false,
    }
}

/// The sites of every direct `call rel32` to `target`.
pub(crate) fn callers(image: &Image, target: usize) -> Vec<usize> {
    let mut out = Vec::new();
    let Some(code) = code(image) else {
        return out;
    };
    let haystack = code.bytes;
    let mut offset = 0usize;
    while offset + 5 <= haystack.len() {
        if haystack[offset] == 0xE8 {
            // SAFETY: the four displacement bytes are inside the section.
            let rel = unsafe { ptr::read_unaligned(haystack.as_ptr().add(offset + 1) as *const i32) } as i64;
            if (code.va + offset + 5) as i64 + rel == target as i64 {
                out.push(code.va + offset);
            }
        }
        offset += 1;
    }
    out
}

/// A MSVC `std::string` at `address`: buffer at `+0x00` (inline when the capacity is under 16, a heap
/// pointer otherwise), size at `+0x10`, capacity at `+0x18`.
pub(crate) fn std_string(address: usize) -> Option<alloc::string::String> {
    let size = read::<usize>(address + 0x10)?;
    let capacity = read::<usize>(address + 0x18)?;
    if size > 4096 {
        return None;
    }
    let bytes = if capacity < 16 {
        let buffer = bytes(address, 16)?;
        &buffer[..size.min(16)]
    } else {
        let pointer = read::<usize>(address)?;
        bytes(pointer, size)?
    };
    core::str::from_utf8(bytes).ok().map(alloc::string::String::from)
}

/// True when `function` appears as an 8-byte pointer in a non-executable section: a vtable slot, or
/// some other table entry the game dispatches through.
pub(crate) fn is_vtable_slot(image: &Image, function: usize) -> bool {
    if function == 0 {
        return false;
    }
    for section in image.sections() {
        if !section.is_data() {
            continue;
        }
        let Some(section_bytes) = bytes(section.va, section.len) else {
            continue;
        };
        let mut offset = 0usize;
        while offset + 8 <= section_bytes.len() {
            // SAFETY: eight bytes are inside the readable section.
            let word = unsafe { ptr::read_unaligned(section_bytes.as_ptr().add(offset) as *const u64) } as usize;
            if word == function {
                return true;
            }
            offset += 8;
        }
    }
    false
}

/// True when `[addr, addr + len)` is committed and writable, so a write to game state cannot fault.
pub(crate) fn writable(addr: usize, len: usize) -> bool {
    if !readable(addr, len) {
        return false;
    }
    let mut cursor = addr;
    let end = addr.saturating_add(len);
    while cursor < end {
        let mut info = agent_core::win::MemoryBasicInformation {
            base_address: ptr::null_mut(),
            allocation_base: ptr::null_mut(),
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
            agent_core::win::VirtualQuery(
                cursor as *const core::ffi::c_void,
                &mut info,
                core::mem::size_of::<agent_core::win::MemoryBasicInformation>(),
            )
        };
        if got == 0 {
            return false;
        }
        const WRITE: u32 = 0x04 | 0x08 | 0x40 | 0x80; // READWRITE | WRITECOPY | EXECUTE_READWRITE | EXECUTE_WRITECOPY
        if info.protect & WRITE == 0 {
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

/// True when `[addr, addr + len)` is readable and holds `pattern`.
pub(crate) fn has_pattern(addr: usize, len: usize, pattern: &[u8]) -> bool {
    match bytes(addr, len) {
        Some(window) => contains(window, pattern),
        None => false,
    }
}

/// The function an assert-metadata triple names: `.rdata` holds `{ fnptr, source path, signature }`
/// followed by packed line/column words, the path ends in `.cpp` and the signature is the C++
/// prototype. `needle` selects the prototype, and the answer is refused unless exactly one triple
/// matches.
pub(crate) fn named_function(image: &Image, needle: &[u8]) -> Option<usize> {
    let rdata = image.section(".rdata")?;
    let text = image.text()?;
    if !readable(rdata.va, rdata.len) {
        return None;
    }
    let rdata_end = rdata.va + rdata.len;
    let text_end = text.va + text.len;
    let count = rdata.len / 8;
    let mut found = 0usize;
    let mut result = 0usize;
    let mut index = 0usize;
    while index + 2 < count {
        let slot = rdata.va + index * 8;
        // SAFETY: three readable words (checked above) and `index + 2 < count`.
        let (pointer, path, signature) = unsafe {
            (
                ptr::read_unaligned(slot as *const u64) as usize,
                ptr::read_unaligned((slot + 8) as *const u64) as usize,
                ptr::read_unaligned((slot + 16) as *const u64) as usize,
            )
        };
        if pointer >= text.va && pointer < text_end && path >= rdata.va && path < rdata_end && signature >= rdata.va && signature < rdata_end {
            if let (Some(path), Some(signature)) = (cstr(path, 240), cstr(signature, 400)) {
                if path.ends_with(b".cpp")
                    && (contains(signature, b"__cdecl") || contains(signature, b"__fastcall") || contains(signature, b"__stdcall"))
                    && contains(signature, needle)
                {
                    found += 1;
                    result = pointer;
                }
            }
        }
        index += 1;
    }
    (found == 1).then_some(result)
}


/// The image's own `VS_FIXEDFILEINFO` version, as `[major, minor, build, revision]`.
///
/// Read out of the mapped `.rsrc` tree (RT_VERSION / 1 / any language) instead of the file, so no
/// extra import and no file access is needed.
pub(crate) fn version(image: &Image) -> Option<[u16; 4]> {
    let (rva, _size) = image.data_directory(2)?;
    let root = image.base() + rva as usize;
    let (type_dir, is_dir) = resource_entry(root, root, 16)?; // RT_VERSION
    if !is_dir {
        return None;
    }
    let (name_dir, _) = resource_entry(root, type_dir, 1)?;
    let (data_entry, _) = resource_entry(root, name_dir, u32::MAX)?;
    let offset = read::<u32>(data_entry)? as usize;
    let size = read::<u32>(data_entry + 4)? as usize;
    let block = bytes(image.base() + offset, size.min(0x1000))?;
    // VS_FIXEDFILEINFO begins with its signature; the key string before it makes its offset vary.
    let mut at = 0usize;
    while at + 16 <= block.len() {
        // SAFETY: the range is inside `block`.
        let word = unsafe { ptr::read_unaligned(block.as_ptr().add(at) as *const u32) };
        if word == 0xFEEF_04BD {
            // SAFETY: 16 bytes from `at` are inside `block`.
            let (high, low) = unsafe {
                (
                    ptr::read_unaligned(block.as_ptr().add(at + 8) as *const u32),
                    ptr::read_unaligned(block.as_ptr().add(at + 12) as *const u32),
                )
            };
            return Some([(high >> 16) as u16, high as u16, (low >> 16) as u16, low as u16]);
        }
        at += 1;
    }
    None
}

/// One entry of an `IMAGE_RESOURCE_DIRECTORY`: its target and whether that target is another
/// directory. An `id` of `u32::MAX` takes the first unnamed entry.
fn resource_entry(root: usize, directory: usize, id: u32) -> Option<(usize, bool)> {
    let named = read::<u16>(directory + 12)? as usize;
    let count = read::<u16>(directory + 14)? as usize;
    let mut index = 0usize;
    while index < count.min(256) {
        let entry = directory + 16 + (named + index) * 8;
        let name = read::<u32>(entry)?;
        let offset = read::<u32>(entry + 4)?;
        if name & 0x8000_0000 == 0 && (id == u32::MAX || name == id) {
            return Some((root + (offset & 0x7FFF_FFFF) as usize, offset & 0x8000_0000 != 0));
        }
        index += 1;
    }
    None
}

/// The distinct functions that hold any of `sites`, in the order they first appear.
pub(crate) fn functions_of(image: &Image, sites: &[usize]) -> Vec<usize> {
    let mut out: Vec<usize> = Vec::new();
    for site in sites {
        let Some(start) = image.function_start(*site) else {
            continue;
        };
        if !out.contains(&start) {
            out.push(start);
        }
    }
    out
}
