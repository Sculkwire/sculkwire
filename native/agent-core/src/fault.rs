//! Fault logging: the first few fatal-looking exceptions are written to the agent log with their
//! address relative to the game or to this DLL.
//!
//! A vectored handler runs before the game's own handlers and before Windows' crash reporting, so a
//! crash that leaves the game's log empty still leaves a line here. The handler only logs and returns
//! `EXCEPTION_CONTINUE_SEARCH`: it never swallows an exception the game should see.

use core::ffi::c_void;
use core::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

use crate::{log, win};

/// Bounded so a fault storm cannot fill the user's disk.
static LOGGED: AtomicU32 = AtomicU32::new(0);

const ACCESS_VIOLATION: u32 = 0xC000_0005;
const ILLEGAL_INSTRUCTION: u32 = 0xC000_001D;
const STACK_OVERFLOW: u32 = 0xC000_00FD;
const HEAP_CORRUPTION: u32 = 0xC000_0374;

/// The handle `AddVectoredExceptionHandler` returned, 0 while no handler is installed.
static HANDLER: AtomicUsize = AtomicUsize::new(0);

pub fn install() {
    // SAFETY: the handler has the VEH signature and never unwinds.
    let handle = unsafe { win::AddVectoredExceptionHandler(0, handler) };
    HANDLER.store(handle as usize, Ordering::Release);
}

/// Removes the handler. An unload must call this before the image is freed: the vector still points into
/// this DLL, and the next fault of the game would call into memory that is no longer mapped.
pub fn remove() -> bool {
    let handle = HANDLER.swap(0, Ordering::AcqRel);
    if handle == 0 {
        return false;
    }
    // SAFETY: the handle came from `AddVectoredExceptionHandler` and is removed once.
    unsafe {
        win::RemoveVectoredExceptionHandler(handle as *mut c_void);
    }
    true
}

unsafe extern "system" fn handler(info: *mut c_void) -> i32 {
    // EXCEPTION_POINTERS { ExceptionRecord*, ContextRecord* }; EXCEPTION_RECORD::ExceptionCode is
    // first, ExceptionAddress is at +0x10 on x64.
    let pointers = info as *const usize;
    if pointers.is_null() {
        return 0;
    }
    let record = core::ptr::read_volatile(pointers) as *const u8;
    if record.is_null() {
        return 0;
    }
    let code = core::ptr::read_volatile(record as *const u32);
    if code != ACCESS_VIOLATION && code != ILLEGAL_INSTRUCTION && code != STACK_OVERFLOW && code != HEAP_CORRUPTION {
        return 0;
    }
    if LOGGED.fetch_add(1, Ordering::Relaxed) >= 8 {
        return 0;
    }
    let at = core::ptr::read_volatile(record.add(0x10) as *const usize);
    let game = win::main_module();
    let game_size = crate::Image::size_of_module(game);
    let self_module = win::module_from_address(handler as *const () as usize);
    let self_size = crate::Image::size_of_module(self_module);

    let place = if at >= self_module && at < self_module + self_size {
        alloc::format!(" agent+0x{:x}", at - self_module)
    } else if at >= game && at < game + game_size {
        alloc::format!(" exe+0x{:x}", at - game)
    } else {
        alloc::format!(" at=0x{at:x}")
    };
    let thread = win::current_thread_id();
    log::fmt(format_args!("fault: code=0x{code:08x} thread=0x{thread:x}{place}"));
    let context = core::ptr::read_volatile(pointers.add(1)) as *const u8;
    if !context.is_null() && LOGGED.load(Ordering::Relaxed) <= 2 {
        describe(record, context, game, game_size, self_module, self_size);
    }
    // A handler that faults leaves this DLL's drain frame for good: a foreign exception unwinds through
    // SEH, not through Rust's drops, so the drain flag would stay set and every later main-thread
    // request would be refused for the life of the process. Release it here, while the faulting thread
    // is still the one holding it, and fail the request it was running.
    if let Some(core) = crate::hub::started() {
        if core.drain_owner() == thread {
            core.release_drain("a fault inside the drain");
        }
    }
    0 // EXCEPTION_CONTINUE_SEARCH
}

/// `CONTEXT` offsets (x64): the sixteen integer registers from `Rax` at 0x78, then `Rip` at 0xf8.
const CONTEXT_RAX: usize = 0x78;
const CONTEXT_RSP: usize = 0x98;
const REGISTER_NAMES: [&str; 16] =
    ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];
/// How many stack words are searched for return addresses, and how many are logged.
const STACK_WORDS: usize = 0x800;
const RETURNS_LOGGED: usize = 24;

/// The faulting registers, the address an access violation touched, and the code addresses on the
/// faulting thread's stack that sit right after a call instruction: enough to name the caller chain of
/// a fault inside the game from the log alone. Every stack read stays between `rsp` and the thread's
/// own stack base (`gs:[8]`), and only image bytes are read to test for a call.
unsafe fn describe(record: *const u8, context: *const u8, game: usize, game_size: usize, agent: usize, agent_size: usize) {
    let mut text = alloc::string::String::new();
    if core::ptr::read_volatile(record as *const u32) == ACCESS_VIOLATION {
        // EXCEPTION_RECORD::NumberParameters at +0x18, ExceptionInformation[] at +0x20.
        let kind = core::ptr::read_volatile(record.add(0x20) as *const usize);
        let address = core::ptr::read_volatile(record.add(0x28) as *const usize);
        text.push_str(&alloc::format!("{} 0x{address:x};", if kind == 0 { "read" } else { "write" }));
    }
    for (index, name) in REGISTER_NAMES.iter().enumerate() {
        let value = core::ptr::read_volatile(context.add(CONTEXT_RAX + index * 8) as *const usize);
        text.push_str(&alloc::format!(" {name}=0x{value:x}"));
    }
    log::fmt(format_args!("fault: {text}"));

    let rsp = core::ptr::read_volatile(context.add(CONTEXT_RSP) as *const usize);
    let base: usize;
    core::arch::asm!("mov {}, gs:[8]", out(reg) base, options(nostack, readonly, preserves_flags));
    if rsp == 0 || rsp & 7 != 0 || base <= rsp {
        return;
    }
    let words = ((base - rsp) / 8).min(STACK_WORDS);
    let mut returns = alloc::string::String::new();
    let mut found = 0usize;
    for index in 0..words {
        let value = core::ptr::read_volatile((rsp + index * 8) as *const usize);
        let (name, start, size) = if value >= game && value < game + game_size {
            ("exe", game, game_size)
        } else if value >= agent && value < agent + agent_size {
            ("agent", agent, agent_size)
        } else {
            continue;
        };
        if value < start + 0x1000 + 6 || value >= start + size {
            continue;
        }
        // `call rel32` (e8, 5 bytes), `call [rip+x]` (ff 15, 6 bytes), `call reg` (ff d0..d7 / 41 ff d0..),
        // `call [reg+disp8]` (ff 50..57 xx): the byte patterns a return address follows.
        let before = |back: usize| core::ptr::read_volatile((value - back) as *const u8);
        let after_call = before(5) == 0xE8
            || (before(6) == 0xFF && before(5) == 0x15)
            || (before(2) == 0xFF && (0xD0..=0xD7).contains(&before(1)))
            || (before(3) == 0xFF && (0x50..=0x57).contains(&before(2)))
            || (before(6) == 0xFF && (0x90..=0x97).contains(&before(5)));
        if !after_call {
            continue;
        }
        returns.push_str(&alloc::format!(" [+0x{:x}]{name}+0x{:x}", index * 8, value - start));
        found += 1;
        if found >= RETURNS_LOGGED {
            break;
        }
    }
    log::fmt(format_args!("fault: stack returns{returns}"));
}
