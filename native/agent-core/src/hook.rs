//! An inline hook engine for x64: a five-byte relative jump at the target, a trampoline that runs the
//! stolen instructions and jumps back, and a relay within reach of the target.
//!
//! The relay exists because a game function can be further than ±2 GiB from the DLL, while the patch
//! itself needs a `rel32`. The relay is `FF 25` (jump through a pointer) to the hook function, placed
//! in a page allocated near the target.
//!
//! Every hook here either installs completely or does nothing: a prologue that cannot be relocated, a
//! relay that cannot be placed and a page that cannot be made writable all return `None`, and the
//! caller leaves the game's code untouched. The input lock depends on that: a hook it cannot install
//! must leave the user's input working.

use core::ffi::c_void;
use core::sync::atomic::{AtomicUsize, Ordering};

use crate::sync::SpinLock;
use crate::win;
use crate::x64;

const TRAMPOLINE_ARENA: usize = 0x1_0000;
const RELAY_ARENA: usize = 0x1_0000;

/// One installed hook.
#[derive(Clone, Copy)]
pub struct Hook {
    /// Where to call to run the original function. 0 when the hook is not installed.
    pub trampoline: usize,
    target: usize,
    stolen: usize,
    original: [u8; 15],
}

impl Hook {
    pub fn installed(&self) -> bool {
        self.trampoline != 0
    }

    pub fn trampoline(&self) -> usize {
        self.trampoline
    }

    pub fn target(&self) -> usize {
        self.target
    }

    /// Puts the original prologue back.
    pub fn remove(&mut self) {
        if self.trampoline == 0 {
            return;
        }
        patch_memory(self.target, &self.original[..self.stolen]);
        self.trampoline = 0;
    }
}

/// A page of executable scratch, allocated near the image so its jumps can be `rel32`.
struct Arena {
    page: usize,
    used: usize,
}

static TRAMPOLINES: SpinLock<Arena> = SpinLock::new(Arena { page: 0, used: 0 });
static RELAYS: SpinLock<Arena> = SpinLock::new(Arena { page: 0, used: 0 });

/// Every hook this DLL installed, so an unload can put all the original prologues back.
///
/// The engine and the lock both drop the [`Hook`] they get, and a hook left in place would run code
/// of a DLL that is about to be freed — so the registry is the crate's own record, not the caller's.
const MAX_HOOKS: usize = 32;
static INSTALLED: SpinLock<[Option<Hook>; MAX_HOOKS]> = SpinLock::new([None; MAX_HOOKS]);

/// Remembers `hook` for [`remove_all`]. A full table drops the record: the hook still works, it just
/// cannot be removed (32 hooks is far more than this agent installs).
fn remember(hook: Hook) {
    let mut table = INSTALLED.lock();
    for slot in table.iter_mut() {
        if slot.is_none() {
            *slot = Some(hook);
            return;
        }
    }
}

/// Installs `replacement` at `target`, or returns `None` without touching the target. The trampoline
/// is stored in `slot` **before** the jump is
/// written, so a thread entering the detour at once already finds the original to forward to. A hot
/// function (`ClientInstance::getLevel`, called many times a frame) entered in that window used to get
/// the detour's "no trampoline" answer, `0`, and the game dereferenced it (live: `exe+0x4e085a2`, read
/// of 0 on the main thread, the same millisecond the hook went in). `slot` is reset to 0 when the
/// install fails.
pub fn install_published(target: usize, replacement: usize, slot: &AtomicUsize) -> Option<Hook> {
    if target == 0 || replacement == 0 {
        return None;
    }

    let code = target as *const u8;
    let mut stolen = 0usize;
    let mut original = [0u8; 15];
    while stolen < 5 {
        // SAFETY: the target is the entry of a mapped function; the decoder reads at most 15 bytes.
        let insn = unsafe { x64::decode(code.add(stolen), 15) }?;
        if insn.rel != 0 {
            return None; // a relative branch cannot be copied into the trampoline
        }
        stolen += insn.len;
        if stolen > 15 {
            return None;
        }
    }

    let trampoline = allocate(&TRAMPOLINES, stolen + 32, target)?;
    // SAFETY: the trampoline is committed RWX and `stolen` bytes fit.
    unsafe {
        core::ptr::copy_nonoverlapping(code, trampoline as *mut u8, stolen);
        for i in 0..stolen {
            original[i] = core::ptr::read_volatile(code.add(i));
        }
        relocate_rip_relative(code, trampoline, stolen)?;
        // Absolute jump back to the rest of the function.
        let back = (trampoline + stolen) as *mut u8;
        *back = 0xFF;
        *back.add(1) = 0x25;
        *(back.add(2) as *mut u32) = 0;
        *(back.add(6) as *mut usize) = target + stolen;
    }

    let relay = relay_for(target, replacement)?;
    let delta = relay as isize - (target as isize + 5);
    if delta < i32::MIN as isize || delta > i32::MAX as isize {
        return None;
    }

    let mut patch = [0x90u8; 15];
    patch[0] = 0xE9;
    patch[1..5].copy_from_slice(&(delta as i32).to_le_bytes());
    slot.store(trampoline, Ordering::Release);
    if !patch_memory(target, &patch[..stolen]) {
        slot.store(0, Ordering::Release);
        return None;
    }

    let hook = Hook { trampoline, target, stolen, original };
    remember(hook);
    Some(hook)
}

/// Puts every prologue this DLL patched back, newest first, and returns how many were restored.
///
/// Each patch suspends the other threads of the process for the few bytes it writes, exactly as the
/// install did, so no thread can be seen executing a half-restored instruction.
pub fn remove_all() -> usize {
    let mut restored = 0usize;
    let mut table = INSTALLED.lock();
    for slot in table.iter_mut().rev() {
        if let Some(hook) = slot.as_mut() {
            hook.remove();
            *slot = None;
            restored += 1;
        }
    }
    restored
}

/// One thread still able to run code of this DLL.
#[derive(Clone, Copy)]
pub struct Busy {
    /// The thread's id.
    pub thread: u32,
    /// Its instruction pointer, inside the image.
    pub code: usize,
    /// Where on its stack a return address into the image was found (0 when the hit was the RIP).
    pub stack_at: usize,
    /// The word at `stack_at` (0 when the hit was the RIP).
    pub return_to: usize,
}

/// How the look at one thread ended.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum End {
    /// Its instruction pointer is inside the image.
    Running,
    /// A live frame of its stack returns into the image.
    Frame,
    /// The unwind reached the thread's first frame: the whole stack is proven free of this image.
    Outermost,
    /// The unwind stopped before the first frame, so the rest of the stack was searched word by word.
    Searched,
    /// The thread could not be suspended or its registers read.
    Unread,
}

/// What one thread's look found.
#[derive(Clone, Copy)]
pub struct Walk {
    pub thread: u32,
    /// The suspended instruction pointer.
    pub rip: usize,
    /// Frames unwound.
    pub frames: u32,
    pub end: End,
    /// Why an unwind ended early (`Searched`), empty otherwise.
    pub why: &'static str,
    pub busy: Option<Busy>,
}

/// Per pass: how many threads ended each way.
#[derive(Clone, Copy, Default)]
pub struct Tally {
    pub outermost: u32,
    pub searched: u32,
    pub unread: u32,
}

/// Answers the first thread of this process that is executing code of the image at `base`, or will
/// return into it, and how every thread looked at ended.
///
/// A hook's entry may be restored while a thread is already inside the replacement that entry led to
/// — the game's own callers run these detours thousands of times a minute on several threads — and
/// `FreeLibrary` on an image a thread can still return into is a crash a moment later. Restoring the
/// prologues stops *new* entries; this is what proves the ones already inside have left:
///
/// * a thread whose `RIP` is inside `[base, base + size)` is inside this DLL's code outright;
/// * otherwise its stack is unwound frame by frame with the x64 unwind data every image carries, and a
///   frame that returns into this DLL is a live call through it (the thread is suspended inside a game
///   function a detour called). A stack unwound to its first frame is proven clean, so a word that only
///   *looks* like a return address — a slot of a frame that returned long ago, which uninitialised
///   locals keep for minutes — cannot hold the image back. Live in a menu on 1.26.63.1 a plain word
///   search did exactly that for a thread blocked in the GameInput runtime;
/// * a walk that stops before the first frame — code outside every image (a hook trampoline page), an
///   unreadable or non-advancing frame — proves nothing, so the rest of that stack is searched word by
///   word instead, which can only err on the safe side: a false hit leaves an inert image mapped, a
///   missed frame frees code a thread will return into.
///
/// Every thread is suspended for the length of the look and resumed before anything else happens.
/// While one is suspended nothing here may wait for a lock that thread could hold: no spin lock of this
/// crate, no allocation (the process heap's lock), and no loader call — `RtlLookupFunctionEntry` and
/// `GetModuleHandleExW` take the loader's own lock under Wine. So the function tables of every loaded
/// image are read *before* any thread is suspended, and the walk itself only reads memory and calls
/// `RtlVirtualUnwind`, which computes from the unwind data and the stack alone. Nothing is logged until
/// the whole pass is done.
pub fn image_threads(base: usize, size: usize, depth: usize) -> (Option<Busy>, Tally) {
    let mut tally = Tally::default();
    let mut busy = None;
    walk_threads(base, size, depth, |walk| {
        match walk.end {
            End::Outermost => tally.outermost += 1,
            End::Searched => tally.searched += 1,
            End::Unread => tally.unread += 1,
            End::Running | End::Frame => {}
        }
        if walk.busy.is_some() {
            busy = walk.busy;
            return false;
        }
        true
    });
    (busy, tally)
}

/// Every thread's look, for a diagnosis: the same pass as [`image_threads`], without stopping at the
/// first busy thread.
pub fn thread_walks(base: usize, size: usize, depth: usize) -> alloc::vec::Vec<Walk> {
    let mut walks = alloc::vec::Vec::new();
    walk_threads(base, size, depth, |walk| {
        walks.push(walk);
        true
    });
    walks
}

/// Looks at every other thread of this process in turn and hands each result to `each`, after that
/// thread was resumed; `each` answers whether to go on.
fn walk_threads(base: usize, size: usize, depth: usize, mut each: impl FnMut(Walk) -> bool) {
    if base == 0 || size == 0 {
        return;
    }
    let own = win::current_thread_id();
    let process = win::current_process_id();
    let first = base;
    let last = base.saturating_add(size);
    let inside = |address: usize| address >= first && address < last;
    let tables = function_tables();
    // SAFETY: the snapshot handle is owned here and closed below.
    let snapshot = unsafe { win::CreateToolhelp32Snapshot(win::TH32CS_SNAPTHREAD, 0) };
    if snapshot == win::INVALID_HANDLE_VALUE || snapshot == 0 {
        return;
    }
    let mut entry = win::ThreadEntry32::default();
    entry.size = core::mem::size_of::<win::ThreadEntry32>() as u32;
    // SAFETY: the entry is valid for the call.
    if unsafe { win::Thread32First(snapshot, &mut entry) } != 0 {
        loop {
            if entry.owner_process_id == process && entry.thread_id != own {
                let walk = inspect_thread(entry.thread_id, &inside, depth, &tables);
                if !each(walk) {
                    break;
                }
            }
            // SAFETY: the entry is valid for the call.
            if unsafe { win::Thread32Next(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }
    // SAFETY: the handle was created above.
    unsafe {
        win::CloseHandle(snapshot);
    }
}

/// One loaded image's function table (`.pdata`): where its `RUNTIME_FUNCTION` entries are.
struct Table {
    base: usize,
    end: usize,
    /// The first entry and how many there are (12 bytes each: begin, end and unwind-info RVAs).
    entries: usize,
    count: usize,
}

/// The function table of every image loaded now, read while no thread is suspended.
fn function_tables() -> alloc::vec::Vec<Table> {
    const EXCEPTION_DIRECTORY: u32 = 3;
    let mut tables = alloc::vec::Vec::new();
    for (base, _) in win::loaded_modules() {
        let Some(image) = crate::Image::at(base) else {
            continue;
        };
        let (entries, count) = match image.data_directory(EXCEPTION_DIRECTORY) {
            Some((rva, size)) if crate::Image::range_readable(base + rva as usize, size as usize) => {
                (base + rva as usize, size as usize / RUNTIME_FUNCTION_SIZE)
            }
            // An image without unwind data: every function in it is a leaf to the walk.
            _ => (0, 0),
        };
        tables.push(Table { base, end: base + image.size(), entries, count });
    }
    tables
}

const RUNTIME_FUNCTION_SIZE: usize = 12;

/// Where `pc` is: `None` outside every image, else the image base and its `RUNTIME_FUNCTION` for `pc`
/// (0 for a leaf function). A binary search over the sorted table; it reads image memory only.
fn function_at(tables: &[Table], pc: usize) -> Option<(usize, usize)> {
    let table = tables.iter().find(|table| pc >= table.base && pc < table.end)?;
    let rva = (pc - table.base) as u32;
    let (mut low, mut high) = (0usize, table.count);
    while low < high {
        let middle = (low + high) / 2;
        let entry = table.entries + middle * RUNTIME_FUNCTION_SIZE;
        // SAFETY: the entry lies inside the exception directory, checked readable when it was listed.
        let (begin, end) = unsafe {
            (core::ptr::read_unaligned(entry as *const u32), core::ptr::read_unaligned((entry + 4) as *const u32))
        };
        if rva < begin {
            high = middle;
        } else if rva >= end {
            low = middle + 1;
        } else {
            return Some((table.base, entry));
        }
    }
    Some((table.base, 0))
}

/// Suspends one thread, looks at it, resumes it. Answers what was found, never holding it suspended.
fn inspect_thread(thread: u32, inside: &impl Fn(usize) -> bool, depth: usize, tables: &[Table]) -> Walk {
    let unread = Walk { thread, rip: 0, frames: 0, end: End::Unread, why: "", busy: None };
    // SAFETY: opening a thread of this process to suspend it and read its registers.
    let handle = unsafe {
        win::OpenThread(win::THREAD_SUSPEND_RESUME | win::THREAD_GET_CONTEXT | win::THREAD_QUERY_INFORMATION, 0, thread)
    };
    if handle == 0 {
        return unread;
    }
    // SAFETY: a handle this call owns; the thread is resumed before the handle is closed.
    if unsafe { win::SuspendThread(handle) } == u32::MAX {
        // SAFETY: a handle this call owns.
        unsafe {
            win::CloseHandle(handle);
        }
        return unread;
    }
    let mut context = win::Context::unwindable();
    // SAFETY: `context` is an aligned `CONTEXT`; the thread is suspended.
    let read = unsafe { win::GetThreadContext(handle, &mut context) } != 0;
    let walk = if read { inspect_context(thread, &context, inside, depth, tables) } else { unread };
    // SAFETY: the same handle, resumed exactly once and then closed.
    unsafe {
        win::ResumeThread(handle);
        win::CloseHandle(handle);
    }
    walk
}

/// Frames walked before the rest of a stack is searched word by word.
const MAX_FRAMES: u32 = 256;

/// The register and stack check itself: `RIP` inside the image, a live frame returning into it, or —
/// when the unwind cannot reach the first frame — any word of the rest of the stack pointing into it.
fn inspect_context(
    thread: u32,
    context: &win::Context,
    inside: &impl Fn(usize) -> bool,
    words: usize,
    tables: &[Table],
) -> Walk {
    let rip = context.instruction_pointer();
    let mut walk = Walk { thread, rip, frames: 0, end: End::Outermost, why: "", busy: None };
    if inside(rip) {
        walk.end = End::Running;
        walk.busy = Some(Busy { thread, code: rip, stack_at: 0, return_to: 0 });
        return walk;
    }
    let searched = |mut walk: Walk, from: usize, why: &'static str| {
        walk.end = End::Searched;
        walk.why = why;
        walk.busy = scan_words(thread, from, inside, words);
        walk
    };
    let mut frame = win::Context { bytes: context.bytes };
    let mut last_sp = context.stack_pointer();
    while walk.frames < MAX_FRAMES {
        let pc = frame.instruction_pointer();
        let sp = frame.stack_pointer();
        // A zero return address is the thread's first frame: the whole stack was walked.
        if pc == 0 {
            return walk;
        }
        if sp == 0 || !stack_readable(sp) {
            return searched(walk, last_sp, "unreadable frame");
        }
        last_sp = sp;
        let Some((image_base, function)) = function_at(tables, pc) else {
            return searched(walk, sp, "code outside every image");
        };
        if function == 0 {
            // A leaf function keeps no frame: its return address is the word at `Rsp`.
            // SAFETY: `sp` is inside a committed, readable region (checked above).
            let returns_to = unsafe { core::ptr::read_volatile(sp as *const usize) };
            frame.set_frame(sp + 8, returns_to);
        } else {
            let mut handler_data: *mut c_void = core::ptr::null_mut();
            let mut establisher: u64 = 0;
            // SAFETY: the function entry is the image's own `RUNTIME_FUNCTION` for this very `pc`, and
            // the context is the suspended thread's own; the unwind reads that thread's stack above `sp`.
            unsafe {
                win::RtlVirtualUnwind(
                    0,
                    image_base as u64,
                    pc as u64,
                    function as *mut c_void,
                    &mut frame,
                    &mut handler_data,
                    &mut establisher,
                    core::ptr::null_mut(),
                );
            }
        }
        walk.frames += 1;
        let next_pc = frame.instruction_pointer();
        let next_sp = frame.stack_pointer();
        if inside(next_pc) {
            walk.end = End::Frame;
            walk.busy = Some(Busy { thread, code: 0, stack_at: next_sp.saturating_sub(8), return_to: next_pc });
            return walk;
        }
        if next_pc != 0 && next_sp <= sp {
            return searched(walk, sp, "frame did not advance");
        }
    }
    let from = frame.stack_pointer();
    searched(walk, from, "deeper than the walk")
}

/// True when the word at `address` is in a committed, readable, unguarded region.
fn stack_readable(address: usize) -> bool {
    const READABLE: u32 = win::PAGE_READONLY
        | win::PAGE_READWRITE
        | win::PAGE_WRITECOPY
        | win::PAGE_EXECUTE_READ
        | win::PAGE_EXECUTE_READWRITE
        | win::PAGE_EXECUTE_WRITECOPY;
    match win::memory_info(address) {
        Some(info) => {
            info.protect & READABLE != 0
                && info.protect & win::PAGE_GUARD == 0
                && address + 8 <= info.base_address as usize + info.region_size
        }
        None => false,
    }
}

/// The conservative search: any word from `cursor` up to the top of that stack that points into the
/// image, at most `words` of them. Only the reservation `cursor` lies in is read — the stack itself —
/// never the unrelated memory mapped above it, and only its committed, readable, unguarded pages.
fn scan_words(thread: u32, mut cursor: usize, inside: &impl Fn(usize) -> bool, words: usize) -> Option<Busy> {
    let Some(first) = win::memory_info(cursor) else {
        return None;
    };
    let reservation = first.allocation_base as usize;
    let mut left = words;
    while left > 0 {
        let Some(info) = win::memory_info(cursor) else {
            break;
        };
        if info.allocation_base as usize != reservation || !stack_readable(cursor) {
            break;
        }
        let end = info.base_address as usize + info.region_size;
        if end <= cursor {
            break;
        }
        while left > 0 && cursor + 8 <= end {
            // SAFETY: the word is inside a committed, readable region that was just queried.
            let word = unsafe { core::ptr::read_volatile(cursor as *const usize) };
            if inside(word) {
                return Some(Busy { thread, code: 0, stack_at: cursor, return_to: word });
            }
            cursor += 8;
            left -= 1;
        }
    }
    None
}

/// Moves the RIP-relative operands of the stolen instructions from `target` to `trampoline`.
///
/// # Safety
/// `stolen` bytes at `from` and at `to` must be readable/writable respectively.
unsafe fn relocate_rip_relative(from: *const u8, to: usize, stolen: usize) -> Option<()> {
    let mut offset = 0usize;
    while offset < stolen {
        let to_mut = to as *mut u8;
        let insn = x64::decode(from.add(offset), stolen - offset)?;
        if insn.len == 0 {
            return None;
        }
        if insn.rip {
            let raw = core::ptr::read_unaligned(from.add(offset + insn.disp_off) as *const u32);
            let old = raw as i32 as i64;
            let destination = (from as usize)
                .wrapping_add(offset)
                .wrapping_add(insn.len)
                .wrapping_add(old as usize);
            let next = to.wrapping_add(offset).wrapping_add(insn.len);
            let new = destination as i64 - next as i64;
            if new < i32::MIN as i64 || new > i32::MAX as i64 {
                // The trampoline is too far from the operand for a `disp32`: refuse the hook rather
                // than patch a function whose original would read the wrong address.
                return None;
            }
            core::ptr::write_unaligned(to_mut.add(offset + insn.disp_off) as *mut u32, new as i32 as u32);
        }
        offset += insn.len;
    }
    Some(())
}

/// A relay near `target`: `FF 25 00 00 00 00 <address of replacement>`.
fn relay_for(target: usize, replacement: usize) -> Option<usize> {
    let relay = allocate(&RELAYS, 16, target)?;
    // SAFETY: the relay page is committed RWX and 16 bytes are reserved.
    unsafe {
        let p = relay as *mut u8;
        *p = 0xFF;
        *p.add(1) = 0x25;
        *(p.add(2) as *mut u32) = 0;
        *(p.add(6) as *mut usize) = replacement;
    }
    Some(relay)
}

/// Reserves `size` bytes from an arena page reachable from `near` by a `rel32`.
fn allocate(arena: &SpinLock<Arena>, size: usize, near: usize) -> Option<usize> {
    let size = (size + 15) & !15;
    let mut arena = arena.lock();
    let mut page = arena.page;
    if page != 0 {
        let delta = page as isize - (near as isize + 5);
        if delta < i32::MIN as isize || delta > i32::MAX as isize || arena.used + size > TRAMPOLINE_ARENA {
            page = 0;
            arena.used = 0;
        }
    }
    if page == 0 {
        page = alloc_near(near)?;
        arena.page = page;
        arena.used = 0;
    }
    let at = page + arena.used;
    arena.used += size;
    Some(at)
}

/// Commits one RWX page in the first free region within ±2 GiB of `near`.
fn alloc_near(near: usize) -> Option<usize> {
    let reach = 0x7FFF_0000usize;
    let low = near.saturating_sub(reach).max(0x1_0000);
    let high = near.saturating_add(reach);
    let mut address = low;
    while address < high {
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
            win::VirtualQuery(address as *const c_void, &mut info, core::mem::size_of::<win::MemoryBasicInformation>())
        };
        if got == 0 {
            return None;
        }
        let base = info.base_address as usize;
        let end = base.saturating_add(info.region_size);
        if info.state == win::MEM_FREE && info.region_size >= RELAY_ARENA {
            let want = base.max(low).saturating_add(0xFFFF) & !0xFFFF;
            if want + RELAY_ARENA <= end {
                // SAFETY: the range is free according to VirtualQuery.
                let page = unsafe {
                    win::VirtualAlloc(
                        want as *mut c_void,
                        RELAY_ARENA,
                        win::MEM_COMMIT | win::MEM_RESERVE,
                        win::PAGE_EXECUTE_READWRITE,
                    )
                };
                if !page.is_null() {
                    return Some(page as usize);
                }
            }
        }
        if end <= address {
            return None;
        }
        address = end;
    }
    None
}

/// Writes `bytes` at `target` with every other thread of the process suspended, so no thread can see a
/// half-written instruction.
fn patch_memory(target: usize, bytes: &[u8]) -> bool {
    let mut old = 0u32;
    // SAFETY: the target is code this agent has decided to patch; the protection is restored below.
    let writable = unsafe {
        win::VirtualProtect(target as *mut c_void, bytes.len(), win::PAGE_EXECUTE_READWRITE, &mut old)
    };
    if writable == 0 {
        return false;
    }
    let mut suspended = [0usize; 256];
    let count = suspend_other_threads(&mut suspended);
    // SAFETY: the range is written under the protection above, and no other thread runs.
    unsafe {
        core::ptr::copy_nonoverlapping(bytes.as_ptr(), target as *mut u8, bytes.len());
    }
    resume_threads(&suspended[..count]);
    // SAFETY: same range; restores the original protection and flushes the instruction cache.
    unsafe {
        win::FlushInstructionCache(usize::MAX, target as *const c_void, bytes.len());
        let mut ignored = 0u32;
        win::VirtualProtect(target as *mut c_void, bytes.len(), old, &mut ignored);
    }
    true
}

/// Suspends every other thread of this process and stores its handles in `handles`, returning how
/// many it suspended (at most `handles.len()`).
fn suspend_other_threads(handles: &mut [usize]) -> usize {
    let own = win::current_thread_id();
    let process = win::current_process_id();
    let mut count = 0usize;
    // SAFETY: the snapshot handle is owned here and closed below.
    let snapshot = unsafe { win::CreateToolhelp32Snapshot(win::TH32CS_SNAPTHREAD, 0) };
    if snapshot == win::INVALID_HANDLE_VALUE || snapshot == 0 {
        return 0;
    }
    let mut entry = win::ThreadEntry32::default();
    entry.size = core::mem::size_of::<win::ThreadEntry32>() as u32;
    // SAFETY: the entry is valid for the call.
    if unsafe { win::Thread32First(snapshot, &mut entry) } != 0 {
        loop {
            if entry.owner_process_id == process && entry.thread_id != own && count < handles.len() {
                // SAFETY: opening a thread of this process for suspension only.
                let handle = unsafe { win::OpenThread(win::THREAD_SUSPEND_RESUME, 0, entry.thread_id) };
                if handle != 0 {
                    // SAFETY: a handle this call owns; suspended threads are resumed below.
                    if unsafe { win::SuspendThread(handle) } != u32::MAX {
                        handles[count] = handle;
                        count += 1;
                    } else {
                        // SAFETY: a handle this call owns.
                        unsafe {
                            win::CloseHandle(handle);
                        }
                    }
                }
            }
            // SAFETY: the entry is valid for the call.
            if unsafe { win::Thread32Next(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }
    // SAFETY: the handle was created above.
    unsafe {
        win::CloseHandle(snapshot);
    }
    count
}

/// Resumes the threads [`suspend_other_threads`] suspended and closes their handles.
fn resume_threads(handles: &[usize]) {
    for handle in handles {
        // SAFETY: each handle came from the matching suspend call and is closed once.
        unsafe {
            win::ResumeThread(*handle);
            win::CloseHandle(*handle);
        }
    }
}
