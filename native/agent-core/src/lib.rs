//! The in-game agent for Minecraft: Bedrock Edition on PC (GDK): a no_std Rust DLL that serves a
//! newline-delimited JSON-RPC 2.0 socket on loopback, a main-thread request queue, a tick stream and
//! the input lock, plus the PE, x64 and hooking primitives an engine crate resolves the game with.
//!
//! Nothing in this crate knows about a game build. An [`Engine`] implementation supplies the game:
//! its anchors, its method handlers, its command runner and its in-world check. `agent-core` owns
//! everything build-agnostic: the socket server, the queue and drain, the stream, the lock state
//! machine, the hook engine and the log file.
//!
//! Everything is freestanding: no CRT (`/nodefaultlib`), imports through `raw-dylib`, memory
//! primitives and the panic handler defined here, and a global allocator over the process heap.

#![no_std]
#![allow(non_snake_case)]

extern crate alloc;

pub mod hub;
pub mod engine;
pub mod gameinput;
pub mod hook;
pub mod image;
pub mod import;
pub mod lock;
pub mod log;
pub mod message_loop;
pub mod queue;
pub mod rpc;
pub mod stream;
pub mod sync;
pub mod thread;
pub mod unload;
pub mod win;
pub mod x64;

mod allocator;
mod fault;

pub use hub::{Core, HeldInput, Movement};
pub use engine::{
    err, Anchor, Engine, Handler, Method, RpcError, Thread, TickSample, DEFERRED,
};
pub use image::{Image, Section};

use core::ffi::c_void;

/// Starts the agent for `engine`. Call once from `DllMain(DLL_PROCESS_ATTACH)`.
///
/// Returns immediately: the socket server and the engine attach run on their own threads, so the
/// loader lock is released at once. `engine.attach` runs on the attach thread, never here.
pub fn start(engine: &'static dyn Engine) {
    let marker: fn(&'static dyn Engine) = start;
    let module = win::module_from_address(marker as usize);
    log::init(module);
    log::line("attach");
    log::fmt(format_args!("attach pid={}", win::current_process_id()));
    // What this image is, and what the loader thinks of it: a hot reload is diagnosed from these two
    // lines and the `unload:` lines of the previous run.
    log::fmt(format_args!(
        "attach: module 0x{module:x} ({} reference(s) at load)",
        win::module_references(module)
    ));
    // A crash inside the game would otherwise leave nothing behind: log the first fatal exceptions.
    fault::install();

    hub::init(engine);
    thread::spawn("serve", rpc::serve, 0);
    thread::spawn("attach", attach_thread, 0);
}

/// Runs once on its own thread: resolve the engine's anchors, install its hooks, then publish the
/// result for `engine.status`.
extern "system" fn attach_thread(_arg: usize) -> u32 {
    let core = hub::instance();
    // A predecessor injected beside this one is waited out here, on this thread: `DllMain` must not
    // block (the predecessor's own unload needs the loader lock this thread would be holding).
    let marker: fn(&'static dyn Engine) = start;
    unload::wait_for_predecessor(win::module_from_address(marker as usize));
    log::line("attach: engine.attach begin");
    let anchors = core.engine().attach(core);
    for anchor in &anchors {
        match anchor.addr {
            0 => log::fmt(format_args!("anchor missing: {}", anchor.name)),
            addr => log::fmt(format_args!("anchor {} = 0x{:x}", anchor.name, addr)),
        }
    }
    core.set_anchors(anchors);
    log::fmt(format_args!("attach: done, image 0x{:x}", core.image().base()));
    0
}

/// One JSON-RPC error code as its agent.c message, for the wire.
pub fn error_message(code: i32) -> &'static str {
    match code {
        -32700 => "parse error",
        -32600 => "invalid request",
        -32601 => "method not found",
        -32602 => "invalid params",
        -32603 => "internal error",
        -32001 => "anchor not resolved",
        -32002 => "not in a world / no local player",
        -32003 => "wrong thread",
        -32004 => "main-thread drain did not run the request within its timeout",
        -32006 => "command failed",
        -32007 => "path not writable",
        -32014 => "scripting unavailable",
        _ => "error",
    }
}

/* ------------------------------------------------------------------------------------------------
 * Freestanding runtime: memory primitives, the floating-point marker and the stack probe.
 *
 * The compiler may synthesise calls to these with no CRT linked. They are plain byte loops (volatile
 * so the compiler cannot turn them back into a call to themselves); they run rarely.
 * ---------------------------------------------------------------------------------------------- */

/// `memcpy` replacement. Not overlap-safe; see [`memmove`].
#[no_mangle]
pub unsafe extern "C" fn memcpy(dst: *mut c_void, src: *const c_void, n: usize) -> *mut c_void {
    let d = dst as *mut u8;
    let s = src as *const u8;
    let mut i = 0;
    while i < n {
        core::ptr::write_volatile(d.add(i), core::ptr::read_volatile(s.add(i)));
        i += 1;
    }
    dst
}

/// `memmove` replacement: copies backwards when the regions overlap forwards.
#[no_mangle]
pub unsafe extern "C" fn memmove(dst: *mut c_void, src: *const c_void, n: usize) -> *mut c_void {
    let d = dst as *mut u8;
    let s = src as *const u8;
    if (d as usize) < (s as usize) {
        let mut i = 0;
        while i < n {
            core::ptr::write_volatile(d.add(i), core::ptr::read_volatile(s.add(i)));
            i += 1;
        }
    } else {
        let mut i = n;
        while i > 0 {
            i -= 1;
            core::ptr::write_volatile(d.add(i), core::ptr::read_volatile(s.add(i)));
        }
    }
    dst
}

/// `memset` replacement.
#[no_mangle]
pub unsafe extern "C" fn memset(dst: *mut c_void, c: i32, n: usize) -> *mut c_void {
    let d = dst as *mut u8;
    let mut i = 0;
    while i < n {
        core::ptr::write_volatile(d.add(i), c as u8);
        i += 1;
    }
    dst
}

/// `memcmp` replacement: byte order, like the CRT.
#[no_mangle]
pub unsafe extern "C" fn memcmp(a: *const c_void, b: *const c_void, n: usize) -> i32 {
    let x = a as *const u8;
    let y = b as *const u8;
    let mut i = 0;
    while i < n {
        let p = core::ptr::read_volatile(x.add(i));
        let q = core::ptr::read_volatile(y.add(i));
        if p != q {
            return p as i32 - q as i32;
        }
        i += 1;
    }
    0
}

/// `bcmp` replacement (synthesised for some slice comparisons).
#[no_mangle]
pub unsafe extern "C" fn bcmp(a: *const c_void, b: *const c_void, n: usize) -> i32 {
    memcmp(a, b, n)
}

/// `strlen` replacement: `alloc`'s `CString::from_raw` needs it and no CRT is linked. The C signature
/// takes `*const c_char`, which is `*const i8` here, so it is spelled that way.
#[no_mangle]
pub unsafe extern "C" fn strlen(text: *const i8) -> usize {
    let mut len = 0usize;
    while core::ptr::read_volatile(text.add(len)) != 0 {
        len += 1;
    }
    len
}

/// MSVC's floating-point marker: the compiler references it once floating point is used.
#[no_mangle]
pub static _fltused: i32 = 1;

// x64 stack probe. The compiler emits `call __chkstk` in prologues of functions with a frame larger
// than a page; it touches every page of the frame so a guard page faults inside the function instead
// of on the first store past it. Follows the standard MSVC contract: rax = frame size in, rax/rcx
// preserved, r10/r11 free.
core::arch::global_asm!(
    ".globl __chkstk",
    ".p2align 4",
    "__chkstk:",
    "push rcx",
    "push rax",
    "cmp rax, 0x1000",
    "lea rcx, [rsp + 0x18]",
    "jb 2f",
    "1:",
    "sub rcx, 0x1000",
    "sub rax, 0x1000",
    "or byte ptr [rcx], 0",
    "cmp rax, 0x1000",
    "ja 1b",
    "2:",
    "sub rcx, rax",
    "or byte ptr [rcx], 0",
    "pop rax",
    "pop rcx",
    "ret",
);

/// MSVC's C++ exception personality routine. `panic = "abort"` never unwinds, but `core`'s `.xdata`
/// still names it, and with no CRT linked nothing else defines it. `ExceptionContinueSearch` keeps a
/// foreign exception (raised by the game, not by this DLL) moving to the game's own handlers.
#[no_mangle]
pub extern "system" fn __CxxFrameHandler3(
    _record: *mut c_void,
    _frame: *mut c_void,
    _context: *mut c_void,
    _dispatch: *mut c_void,
) -> i32 {
    1
}

/// Panics abort. A panic inside the game must not unwind into engine frames, and there is no CRT to
/// unwind with, so the handler logs what it can and terminates the process through the OS.
#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    log::fmt(format_args!("panic: {}", info));
    log::line("panic: aborting");
    win::debug_break();
    win::terminate_process(101);
}
