//! `sculkwire-injector.exe <process.exe> <dll-path>`: loads a DLL into a running Windows process.
//!
//! Finds the process by executable name (`CreateToolhelp32Snapshot`), copies the DLL path into it,
//! starts `LoadLibraryW` there with `CreateRemoteThread`, waits for the result, and prints `OK <pid>`
//! with the Windows pid from the snapshot. An error goes to stderr and the exit code is 1.
//!
//! Freestanding like the DLL: no CRT, `raw-dylib` imports, its own memory primitives.

#![no_std]
#![no_main]

use core::ffi::c_void;

type Handle = usize;
type Module = usize;

const INVALID_HANDLE_VALUE: Handle = usize::MAX;
const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
const TH32CS_SNAPMODULE: u32 = 0x0000_0008;
const PROCESS_CREATE_THREAD: u32 = 0x0002;
const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
const PROCESS_VM_OPERATION: u32 = 0x0008;
const PROCESS_VM_WRITE: u32 = 0x0020;
const PROCESS_VM_READ: u32 = 0x0010;
const MEM_COMMIT: u32 = 0x1000;
const MEM_RESERVE: u32 = 0x2000;
const MEM_RELEASE: u32 = 0x8000;
const PAGE_READWRITE: u32 = 0x04;
const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
const STD_ERROR_HANDLE: u32 = -12i32 as u32;

#[repr(C)]
struct ProcessEntry32W {
    size: u32,
    usage: u32,
    process_id: u32,
    default_heap_id: usize,
    module_id: u32,
    threads: u32,
    parent_process_id: u32,
    pri_class_base: i32,
    flags: u32,
    exe_file: [u16; 260],
}

#[repr(C)]
struct ModuleEntry32W {
    size: u32,
    module_id: u32,
    process_id: u32,
    global_usage: u32,
    process_usage: u32,
    base_address: *mut u8,
    base_size: u32,
    module: Module,
    name: [u16; 256],
    path: [u16; 260],
}

#[link(name = "kernel32", kind = "raw-dylib")]
extern "system" {
    fn GetCommandLineW() -> *const u16;
    fn GetModuleHandleW(name: *const u16) -> Module;
    fn GetProcAddress(module: Module, name: *const u8) -> *mut c_void;
    fn CreateToolhelp32Snapshot(flags: u32, process: u32) -> Handle;
    fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
    fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
    fn Module32FirstW(snapshot: Handle, entry: *mut ModuleEntry32W) -> i32;
    fn Module32NextW(snapshot: Handle, entry: *mut ModuleEntry32W) -> i32;
    fn OpenProcess(access: u32, inherit: i32, id: u32) -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
    fn VirtualAllocEx(process: Handle, address: *mut c_void, size: usize, kind: u32, protect: u32) -> *mut c_void;
    fn VirtualFreeEx(process: Handle, address: *mut c_void, size: usize, kind: u32) -> i32;
    fn WriteProcessMemory(process: Handle, address: *mut c_void, data: *const c_void, size: usize, wrote: *mut usize) -> i32;
    fn CreateRemoteThread(
        process: Handle,
        attributes: *mut c_void,
        stack: usize,
        start: extern "system" fn(*mut c_void) -> u32,
        arg: *mut c_void,
        flags: u32,
        id: *mut u32,
    ) -> Handle;
    fn WaitForSingleObject(handle: Handle, ms: u32) -> u32;
    fn GetExitCodeThread(thread: Handle, code: *mut u32) -> i32;
    fn GetStdHandle(kind: u32) -> Handle;
    fn WriteFile(handle: Handle, data: *const c_void, len: u32, wrote: *mut u32, overlapped: *mut c_void) -> i32;
    fn ExitProcess(code: u32) -> !;

}

/* Freestanding runtime pieces the compiler may call. */
#[no_mangle]
unsafe extern "C" fn memcpy(dst: *mut c_void, src: *const c_void, len: usize) -> *mut c_void {
    let d = dst as *mut u8;
    let s = src as *const u8;
    let mut i = 0;
    while i < len {
        core::ptr::write_volatile(d.add(i), core::ptr::read_volatile(s.add(i)));
        i += 1;
    }
    dst
}

#[no_mangle]
unsafe extern "C" fn memmove(dst: *mut c_void, src: *const c_void, len: usize) -> *mut c_void {
    let d = dst as *mut u8;
    let s = src as *const u8;
    if (d as usize) < (s as usize) {
        let mut i = 0;
        while i < len {
            core::ptr::write_volatile(d.add(i), core::ptr::read_volatile(s.add(i)));
            i += 1;
        }
    } else {
        let mut i = len;
        while i > 0 {
            i -= 1;
            core::ptr::write_volatile(d.add(i), core::ptr::read_volatile(s.add(i)));
        }
    }
    dst
}

#[no_mangle]
unsafe extern "C" fn memset(dst: *mut c_void, value: i32, len: usize) -> *mut c_void {
    let d = dst as *mut u8;
    let mut i = 0;
    while i < len {
        core::ptr::write_volatile(d.add(i), value as u8);
        i += 1;
    }
    dst
}

#[no_mangle]
unsafe extern "C" fn memcmp(a: *const c_void, b: *const c_void, len: usize) -> i32 {
    let x = a as *const u8;
    let y = b as *const u8;
    let mut i = 0;
    while i < len {
        let p = core::ptr::read_volatile(x.add(i));
        let q = core::ptr::read_volatile(y.add(i));
        if p != q {
            return p as i32 - q as i32;
        }
        i += 1;
    }
    0
}

// x64 stack probe: the compiler emits `call __chkstk` in prologues with a frame larger than a page.
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

/// MSVC's C++ personality routine: `core`'s `.xdata` names it, and no CRT is linked.
#[no_mangle]
pub extern "system" fn __CxxFrameHandler3(
    _record: *mut c_void,
    _frame: *mut c_void,
    _context: *mut c_void,
    _dispatch: *mut c_void,
) -> i32 {
    1
}

/// MSVC's floating-point marker.
#[no_mangle]
static _fltused: i32 = 1;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    write_err(b"sculkwire-injector: internal error\n");
    // SAFETY: terminates this process, which owns no other state by now.
    unsafe {
        ExitProcess(1);
    }
}

/* ------------------------------------------------------------------------------------------------
 * Output
 * ---------------------------------------------------------------------------------------------- */

fn write_handle(kind: u32, bytes: &[u8]) {
    // SAFETY: a standard handle and a plain message; `WriteFile` writes to the console.
    unsafe {
        let handle = GetStdHandle(kind);
        if handle == 0 || handle == INVALID_HANDLE_VALUE {
            return;
        }
        let mut wrote = 0u32;
        WriteFile(handle, bytes.as_ptr().cast(), bytes.len() as u32, &mut wrote, core::ptr::null_mut());
    }
}

fn write_err(bytes: &[u8]) {
    write_handle(STD_ERROR_HANDLE, bytes);
}

/* ------------------------------------------------------------------------------------------------
 * Command line and process lookup
 * ---------------------------------------------------------------------------------------------- */

/// The command line's two arguments — `<process.exe>` and `<dll-path>` — as ASCII with their lengths,
/// plus how many tokens the line had (1 = program only, 3 = both arguments). Quotes group a token and
/// are not kept; a path may contain spaces, so the whole rest of the line after the program name is
/// never split on anything but unquoted whitespace.
fn arguments() -> ([u8; 1024], usize, [u8; 1024], usize, usize) {
    let mut text = [0u8; 1024];
    let mut len = 0usize;
    // SAFETY: the OS owns the command line for the life of the process.
    let raw = unsafe { GetCommandLineW() };
    if !raw.is_null() {
        let mut index = 0usize;
        while len + 4 < text.len() {
            // SAFETY: the string is NUL-terminated by the OS.
            let unit = unsafe { core::ptr::read(raw.add(index)) };
            if unit == 0 {
                break;
            }
            index += 1;
            // ASCII verbatim, anything else as '?': the paths this tool takes are ASCII.
            text[len] = if unit < 0x80 { unit as u8 } else { b'?' };
            len += 1;
        }
    }

    // Skip the program name (argv[0]); a quoted one is legal.
    let mut index = 0usize;
    if index < len && text[index] == b'"' {
        index += 1;
        while index < len && text[index] != b'"' {
            index += 1;
        }
        if index < len {
            index += 1;
        }
    } else {
        while index < len && text[index] != b' ' && text[index] != b'\t' {
            index += 1;
        }
    }

    let mut first = [0u8; 1024];
    let mut second = [0u8; 1024];
    let mut first_len = 0usize;
    let mut second_len = 0usize;
    let mut found = 1usize; // the program name
    while found < 3 {
        while index < len && (text[index] == b' ' || text[index] == b'\t') {
            index += 1;
        }
        if index >= len {
            break;
        }
        let quoted = text[index] == b'"';
        if quoted {
            index += 1;
        }
        let buffer = if found == 1 { &mut first } else { &mut second };
        let mut n = 0usize;
        while index < len {
            let byte = text[index];
            if quoted {
                if byte == b'"' {
                    index += 1;
                    break;
                }
            } else if byte == b' ' || byte == b'\t' {
                break;
            }
            if n + 1 < buffer.len() {
                buffer[n] = byte;
                n += 1;
            }
            index += 1;
        }
        if found == 1 {
            first_len = n;
        } else {
            second_len = n;
        }
        found += 1;
    }
    (first, first_len, second, second_len, found)
}

fn basename(path: &[u8]) -> &[u8] {
    let mut start = 0;
    for (index, byte) in path.iter().enumerate() {
        if *byte == b'\\' || *byte == b'/' {
            start = index + 1;
        }
    }
    &path[start..]
}

fn equals_ignore_case(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_ascii_lowercase() == y.to_ascii_lowercase())
}

/// UTF-16 to ASCII (non-ASCII units become `?`), stopping at the first NUL.
fn ascii(units: &[u16], out: &mut [u8]) -> usize {
    let mut used = 0usize;
    for unit in units {
        if *unit == 0 || used + 1 >= out.len() {
            break;
        }
        out[used] = if *unit < 0x80 { *unit as u8 } else { b'?' };
        used += 1;
    }
    used
}

/// Whether the main module of `pid` (the first entry of its module snapshot) is called `name`. Launchers that start
/// the game from a staged, already deleted copy of the executable leave the process image name empty, while the
/// loader still records the module under the name it was mapped as.
fn main_module_is(pid: u32, name: &[u8]) -> bool {
    // SAFETY: the snapshot handle is owned here and closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot == 0 {
        return false;
    }
    let mut entry = ModuleEntry32W {
        size: core::mem::size_of::<ModuleEntry32W>() as u32,
        module_id: 0,
        process_id: 0,
        global_usage: 0,
        process_usage: 0,
        base_address: core::ptr::null_mut(),
        base_size: 0,
        module: 0,
        name: [0; 256],
        path: [0; 260],
    };
    // SAFETY: the entry is valid for the call.
    let matched = unsafe { Module32FirstW(snapshot, &mut entry) } != 0 && {
        let mut module = [0u8; 256];
        let used = ascii(&entry.name, &mut module);
        let mut path = [0u8; 260];
        let path_used = ascii(&entry.path, &mut path);
        equals_ignore_case(&module[..used], name) || equals_ignore_case(basename(&path[..path_used]), name)
    };
    // SAFETY: the handle was created above.
    unsafe {
        CloseHandle(snapshot);
    }
    matched
}

/// The path of the loaded module of `pid` whose full path (or file name) is `wanted`, if one is mapped.
///
/// `LoadLibraryW` on a path that is *already* mapped does not run `DllMain` a second time: it returns the
/// existing handle. Injecting an agent that is still loaded therefore succeeds and changes nothing — no
/// server, no attach, no port — which looks exactly like a broken hot reload. The injector refuses that
/// case by name instead.
fn loaded_module_path(pid: u32, wanted: &[u8]) -> Option<([u8; 260], usize)> {
    // SAFETY: the snapshot handle is owned here and closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot == 0 {
        return None;
    }
    let mut entry = ModuleEntry32W {
        size: core::mem::size_of::<ModuleEntry32W>() as u32,
        module_id: 0,
        process_id: 0,
        global_usage: 0,
        process_usage: 0,
        base_address: core::ptr::null_mut(),
        base_size: 0,
        module: 0,
        name: [0; 256],
        path: [0; 260],
    };
    let mut found = None;
    // SAFETY: the entry is valid for the call.
    if unsafe { Module32FirstW(snapshot, &mut entry) } != 0 {
        loop {
            let mut path = [0u8; 260];
            let used = ascii(&entry.path, &mut path);
            if used != 0
                && (equals_ignore_case(&path[..used], wanted)
                    || equals_ignore_case(basename(&path[..used]), basename(wanted)))
            {
                found = Some((path, used));
                break;
            }
            // SAFETY: same entry pointer, same snapshot.
            if unsafe { Module32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }
    // SAFETY: the handle was created above.
    unsafe {
        CloseHandle(snapshot);
    }
    found
}

/// The pid of the first process whose executable name is `name`; failing that, the first process without an image
/// name whose main module is `name`.
fn find_process(name: &[u8]) -> Option<u32> {
    // SAFETY: the snapshot handle is owned here and closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot == 0 {
        return None;
    }
    let mut entry = ProcessEntry32W {
        size: core::mem::size_of::<ProcessEntry32W>() as u32,
        usage: 0,
        process_id: 0,
        default_heap_id: 0,
        module_id: 0,
        threads: 0,
        parent_process_id: 0,
        pri_class_base: 0,
        flags: 0,
        exe_file: [0; 260],
    };
    let mut found = None;
    let mut unnamed = [0u32; 64];
    let mut unnamed_len = 0usize;
    // SAFETY: the entry is valid for the call.
    if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
        loop {
            let mut bytes = [0u8; 260];
            let used = ascii(&entry.exe_file, &mut bytes);
            if equals_ignore_case(&bytes[..used], name) {
                found = Some(entry.process_id);
                break;
            }
            if used == 0 && unnamed_len < unnamed.len() {
                unnamed[unnamed_len] = entry.process_id;
                unnamed_len += 1;
            }
            // SAFETY: the entry is valid for the call.
            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }
    // SAFETY: the handle was created above.
    unsafe {
        CloseHandle(snapshot);
    }
    found.or_else(|| unnamed[..unnamed_len].iter().copied().find(|pid| main_module_is(*pid, name)))
}

/* ------------------------------------------------------------------------------------------------
 * Injection
 * ---------------------------------------------------------------------------------------------- */

fn run() -> u32 {
    let (process_name, process_len, dll_path, dll_len, found) = arguments();
    if found < 3 || process_len == 0 || dll_len == 0 {
        write_err(b"usage: sculkwire-injector.exe <process.exe> <dll-path>\n");
        return 1;
    }
    let name = basename(&process_name[..process_len]);
    let Some(pid) = find_process(name) else {
        write_err(b"sculkwire-injector: process not found: ");
        write_err(name);
        write_err(b"\n");
        return 1;
    };

    // SAFETY: opening the target process with the rights injection needs.
    let process = unsafe {
        OpenProcess(
            PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
            0,
            pid,
        )
    };
    if process == 0 || process == INVALID_HANDLE_VALUE {
        write_err(b"sculkwire-injector: OpenProcess failed\n");
        return 1;
    }

    // A path that is already mapped cannot run `DllMain` again: refuse and say what is still there,
    // instead of injecting a DLL that does nothing.
    if let Some((path, used)) = loaded_module_path(pid, &dll_path[..dll_len]) {
        // SAFETY: the handle was opened above.
        unsafe {
            CloseHandle(process);
        }
        write_err(b"sculkwire-injector: the DLL is already loaded in the process: ");
        write_err(&path[..used]);
        write_err(b"\nsculkwire-injector: it must be unloaded first (agent.unload), or the injector must be given a new copy\n");
        return 1;
    }

    // The DLL path as UTF-16, NUL-terminated.
    let mut wide = [0u16; 1024];
    let mut wide_len = 0usize;
    for byte in &dll_path[..dll_len] {
        if wide_len + 1 >= wide.len() {
            // SAFETY: the handle was opened above.
            unsafe {
                CloseHandle(process);
            }
            write_err(b"sculkwire-injector: dll path too long\n");
            return 1;
        }
        wide[wide_len] = *byte as u16;
        wide_len += 1;
    }
    wide[wide_len] = 0;
    let bytes = (wide_len + 1) * 2;

    // SAFETY: allocating in the target process, which was opened for it.
    let remote = unsafe {
        VirtualAllocEx(process, core::ptr::null_mut(), bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE)
    };
    if remote.is_null() {
        // SAFETY: the handle was opened above.
        unsafe {
            CloseHandle(process);
        }
        write_err(b"sculkwire-injector: VirtualAllocEx failed\n");
        return 1;
    }
    // SAFETY: `remote` is a writable block of `bytes` in the target; `wide` is that many bytes.
    let written = unsafe {
        WriteProcessMemory(process, remote, wide.as_ptr().cast(), bytes, core::ptr::null_mut())
    };
    if written == 0 {
        // SAFETY: the block and handle were created above.
        unsafe {
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            CloseHandle(process);
        }
        write_err(b"sculkwire-injector: WriteProcessMemory failed\n");
        return 1;
    }

    // SAFETY: resolving LoadLibraryW out of this process's own kernel32.
    let load_library = unsafe {
        let kernel32 = GetModuleHandleW([b'k' as u16, b'e' as u16, b'r' as u16, b'n' as u16, b'e' as u16, b'l' as u16, b'3' as u16, b'2' as u16, b'.' as u16, b'd' as u16, b'l' as u16, b'l' as u16, 0u16].as_ptr());
        GetProcAddress(kernel32, b"LoadLibraryW\0".as_ptr())
    };
    if load_library.is_null() {
        // SAFETY: the block and handle were created above.
        unsafe {
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            CloseHandle(process);
        }
        write_err(b"sculkwire-injector: GetProcAddress(LoadLibraryW) failed\n");
        return 1;
    }

    // SAFETY: the thread starts at LoadLibraryW with the remote path as its argument.
    let thread = unsafe {
        CreateRemoteThread(
            process,
            core::ptr::null_mut(),
            0,
            core::mem::transmute::<*mut c_void, extern "system" fn(*mut c_void) -> u32>(load_library),
            remote,
            0,
            core::ptr::null_mut(),
        )
    };
    if thread == 0 || thread == INVALID_HANDLE_VALUE {
        // SAFETY: the block and handle were created above.
        unsafe {
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            CloseHandle(process);
        }
        write_err(b"sculkwire-injector: CreateRemoteThread failed\n");
        return 1;
    }

    // SAFETY: waiting on a thread this call created.
    unsafe {
        WaitForSingleObject(thread, 60_000);
        let mut code = 0u32;
        GetExitCodeThread(thread, &mut code);
        CloseHandle(thread);
        VirtualFreeEx(process, remote, 0, MEM_RELEASE);
        CloseHandle(process);
        if code == 0 {
            write_err(b"sculkwire-injector: LoadLibrary returned 0 (bad DLL / 32-bit / missing deps)\n");
            return 1;
        }
    }

    let mut out = [0u8; 32];
    out[0] = b'O';
    out[1] = b'K';
    out[2] = b' ';
    let mut value = pid;
    let mut digits = [0u8; 10];
    let mut n = 0usize;
    if value == 0 {
        digits[0] = b'0';
        n = 1;
    }
    while value > 0 {
        digits[n] = b'0' + (value % 10) as u8;
        value /= 10;
        n += 1;
    }
    let mut position = 3usize;
    for i in 0..n {
        out[position] = digits[n - 1 - i];
        position += 1;
    }
    out[position] = b'\n';
    write_handle(STD_OUTPUT_HANDLE, &out[..position + 1]);
    0
}

/// The entry point the MSVC CRT would provide; the build is freestanding.
#[no_mangle]
pub extern "system" fn mainCRTStartup() -> ! {
    let code = run();
    // SAFETY: ends this process with its result code.
    unsafe {
        ExitProcess(code);
    }
}
