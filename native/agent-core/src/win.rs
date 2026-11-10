//! Win32 surface: the types, constants and imports the agent uses.
//!
//! Imports come from `raw-dylib`, so no import libraries and no Windows SDK are needed; the linker
//! synthesises them. Only kernel32, user32 and ws2_32 are imported: the agent talks to the OS, never
//! to the CRT (`agent-core` defines the few CRT symbols the compiler emits).

use alloc::string::String;
use alloc::vec::Vec;
use core::ffi::c_void;

#[allow(non_camel_case_types)]
pub type Hmodule = usize;
#[allow(non_camel_case_types)]
pub type Hwnd = isize;
#[allow(non_camel_case_types)]
pub type Handle = usize;
#[allow(non_camel_case_types)]
pub type Bool = i32;
#[allow(non_camel_case_types)]
pub type Dword = u32;
#[allow(non_camel_case_types)]
pub type Lresult = isize;
#[allow(non_camel_case_types)]
pub type Wparam = usize;
#[allow(non_camel_case_types)]
pub type Lparam = isize;

pub const DLL_PROCESS_ATTACH: u32 = 1;

pub const INVALID_HANDLE_VALUE: Handle = usize::MAX;

/* Threads. */
pub const CREATE_SUSPENDED: u32 = 0x0000_0004;
pub const INFINITE: u32 = 0xFFFF_FFFF;
pub const THREAD_SUSPEND_RESUME: u32 = 0x0002;
/// Read a suspended thread's registers.
pub const THREAD_GET_CONTEXT: u32 = 0x0008;
/// Read a thread's exit state and the thread's own identity.
pub const THREAD_QUERY_INFORMATION: u32 = 0x0040;
/// `CONTEXT_CONTROL`: the control registers (Rsp, Rip, flags, segments).
pub const CONTEXT_CONTROL: u32 = 0x0010_0001;
/// `CONTEXT_CONTROL | CONTEXT_INTEGER`: what an unwind needs, because a frame may be addressed through a
/// frame register (usually Rbp) rather than Rsp.
pub const CONTEXT_UNWIND: u32 = 0x0010_0003;

/// An x64 `CONTEXT`, as `GetThreadContext` writes it: 0x4d0 bytes, 16-byte aligned, read at the offsets
/// `winnt.h` gives its fields.
#[repr(C, align(16))]
pub struct Context {
    pub bytes: [u8; 0x4d0],
}

impl Context {
    /// A context asking for the control registers.
    pub fn control() -> Self {
        Self::with_flags(CONTEXT_CONTROL)
    }

    /// A context asking for the control and integer registers: one `RtlVirtualUnwind` can step.
    pub fn unwindable() -> Self {
        Self::with_flags(CONTEXT_UNWIND)
    }

    fn with_flags(flags: u32) -> Self {
        let mut context = Context { bytes: [0; 0x4d0] };
        context.bytes[0x30..0x34].copy_from_slice(&flags.to_le_bytes());
        context
    }

    /// `CONTEXT::Rsp` (0x98).
    pub fn stack_pointer(&self) -> usize {
        usize::from_le_bytes(self.bytes[0x98..0xa0].try_into().unwrap_or([0; 8]))
    }

    /// `CONTEXT::Rip` (0xf8).
    pub fn instruction_pointer(&self) -> usize {
        usize::from_le_bytes(self.bytes[0xf8..0x100].try_into().unwrap_or([0; 8]))
    }

    /// Sets `Rsp` and `Rip`: a leaf frame's unwind, which is one pop of the return address.
    pub fn set_frame(&mut self, stack_pointer: usize, instruction_pointer: usize) {
        self.bytes[0x98..0xa0].copy_from_slice(&stack_pointer.to_le_bytes());
        self.bytes[0xf8..0x100].copy_from_slice(&instruction_pointer.to_le_bytes());
    }
}

/* Process memory. */
pub const MEM_COMMIT: u32 = 0x1000;
pub const MEM_RESERVE: u32 = 0x2000;
pub const MEM_RELEASE: u32 = 0x8000;
pub const MEM_FREE: u32 = 0x1_0000;
pub const PAGE_NOACCESS: u32 = 0x01;
pub const PAGE_READONLY: u32 = 0x02;
pub const PAGE_READWRITE: u32 = 0x04;
pub const PAGE_WRITECOPY: u32 = 0x08;
pub const PAGE_EXECUTE: u32 = 0x10;
pub const PAGE_EXECUTE_READ: u32 = 0x20;
pub const PAGE_EXECUTE_READWRITE: u32 = 0x40;
pub const PAGE_EXECUTE_WRITECOPY: u32 = 0x80;
pub const PAGE_GUARD: u32 = 0x100;

/* Module handles. */
/// Ask for a module handle without raising the loader's reference count and without pinning the image:
/// this crate asks for its own module several times and must stay freeable (`agent.unload`).
pub const GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT: u32 = 0x2;
pub const GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS: u32 = 0x4;

/* Toolhelp snapshots. */
pub const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
pub const TH32CS_SNAPTHREAD: u32 = 0x0000_0004;
pub const TH32CS_SNAPMODULE: u32 = 0x0000_0008;
pub const TH32CS_SNAPMODULE32: u32 = 0x0000_0010;

/* Window hooks and timers. */
pub const WH_GETMESSAGE: i32 = 3;
/// The drain timer's id on the game window (`'S'`, `'C'`): a WM_TIMER the window's own thread
/// dispatches, so the message pump cannot be bypassed.
pub const DRAIN_TIMER_ID: usize = 0x0053_0043;

/* Window messages the lock handles. */
pub const WM_ACTIVATE: u32 = 0x0006;
pub const WM_SETFOCUS: u32 = 0x0007;
pub const WM_KILLFOCUS: u32 = 0x0008;
pub const WM_ACTIVATEAPP: u32 = 0x001C;
pub const WM_INPUT: u32 = 0x00FF;
pub const WM_KEYDOWN: u32 = 0x0100;
pub const WM_KEYUP: u32 = 0x0101;
pub const WM_SYSKEYDOWN: u32 = 0x0104;
pub const WM_SYSKEYUP: u32 = 0x0105;
pub const GWLP_WNDPROC: i32 = -4;
pub const GW_OWNER: u32 = 4;

/* Raw input. */
pub const RID_INPUT: u32 = 0x1000_0003;
pub const RIM_TYPEMOUSE: u32 = 0;
pub const RIM_TYPEKEYBOARD: u32 = 1;

/* Virtual keys. */
pub const VK_SHIFT: usize = 0x10;
pub const VK_LSHIFT: usize = 0xA0;
pub const VK_RSHIFT: usize = 0xA1;
pub const VK_F9: usize = 0x78;

/* Sockets. */
pub const AF_INET: i32 = 2;
pub const SOCK_STREAM: i32 = 1;
pub const INADDR_LOOPBACK: u32 = 0x0100_007F; // 127.0.0.1 in network byte order on little-endian

/* Log file. */
pub const FILE_APPEND_DATA: u32 = 0x0004;
pub const FILE_SHARE_READ_WRITE: u32 = 3;
pub const OPEN_ALWAYS: u32 = 4;
pub const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
pub const FILE_END: u32 = 2;

/// `CRITICAL_SECTION`'s storage. Opaque: only the initialise/enter/leave/delete calls touch it.
#[repr(C, align(8))]
pub struct CriticalSection {
    data: [u8; 40],
}

impl CriticalSection {
    pub const fn new() -> Self {
        Self { data: [0; 40] }
    }
}

#[repr(C)]
pub struct MemoryBasicInformation {
    pub base_address: *mut c_void,
    pub allocation_base: *mut c_void,
    pub allocation_protect: u32,
    pub partition_id: u16,
    pub _pad: u16,
    pub region_size: usize,
    pub state: u32,
    pub protect: u32,
    pub kind: u32,
}

#[repr(C)]
pub struct ModuleEntry32W {
    pub size: u32,
    pub module_id: u32,
    pub process_id: u32,
    pub global_usage: u32,
    pub process_usage: u32,
    pub base: *mut u8,
    pub base_size: u32,
    pub module: Hmodule,
    pub name: [u16; 256],
    pub path: [u16; 260],
}

impl Default for ModuleEntry32W {
    fn default() -> Self {
        // SAFETY: all-zero is a valid MODULEENTRY32W; `size` is set by the caller.
        unsafe { core::mem::zeroed() }
    }
}

#[repr(C)]
pub struct ThreadEntry32 {
    pub size: u32,
    pub usage: u32,
    pub thread_id: u32,
    pub owner_process_id: u32,
    pub base_pri: i32,
    pub delta_pri: i32,
    pub flags: u32,
}

impl Default for ThreadEntry32 {
    fn default() -> Self {
        unsafe { core::mem::zeroed() }
    }
}

#[repr(C)]
pub struct ModuleEntry32 {
    pub size: u32,
    pub module_id: u32,
    pub process_id: u32,
    pub global_usage: u32,
    pub process_usage: u32,
    pub base: *mut u8,
    pub base_size: u32,
    pub module: Hmodule,
    pub name: [u8; 256],
    pub path: [u8; 260],
}

impl Default for ModuleEntry32 {
    fn default() -> Self {
        unsafe { core::mem::zeroed() }
    }
}

#[repr(C)]
pub struct ProcessEntry32W {
    pub size: u32,
    pub usage: u32,
    pub process_id: u32,
    pub default_heap_id: usize,
    pub module_id: u32,
    pub threads: u32,
    pub parent_process_id: u32,
    pub pri_class_base: i32,
    pub flags: u32,
    pub exe_file: [u16; 260],
}

impl Default for ProcessEntry32W {
    fn default() -> Self {
        unsafe { core::mem::zeroed() }
    }
}

#[repr(C)]
pub struct WsaData {
    pub version: u16,
    pub high_version: u16,
    pub description: [u8; 257],
    pub system_status: [u8; 129],
    pub max_sockets: u16,
    pub max_udp_dg: u16,
    pub vendor_info: *mut u8,
}

impl Default for WsaData {
    fn default() -> Self {
        unsafe { core::mem::zeroed() }
    }
}

#[repr(C)]
pub struct SockAddrIn {
    pub family: i16,
    pub port: u16,
    pub addr: u32,
    pub zero: [u8; 8],
}

#[repr(C)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

pub type WndProc = unsafe extern "system" fn(Hwnd, u32, Wparam, Lparam) -> Lresult;
pub type EnumWindowsProc = unsafe extern "system" fn(Hwnd, Lparam) -> Bool;
/// A `WH_GETMESSAGE` (or other hook) procedure.
pub type HookProc = unsafe extern "system" fn(i32, Wparam, Lparam) -> Lresult;

#[link(name = "kernel32", kind = "raw-dylib")]
extern "system" {
    pub fn GetModuleHandleW(name: *const u16) -> Hmodule;
    pub fn GetModuleHandleExW(flags: u32, name: *const u16, module: *mut Hmodule) -> Bool;
    pub fn GetModuleFileNameW(module: Hmodule, name: *mut u16, size: u32) -> Dword;
    pub fn GetProcAddress(module: Hmodule, name: *const u8) -> *mut c_void;
    pub fn GetCurrentProcessId() -> Dword;
    pub fn GetCurrentThreadId() -> Dword;
    pub fn CreateThread(
        attributes: *mut c_void,
        stack: usize,
        start: extern "system" fn(*mut c_void) -> Dword,
        arg: *mut c_void,
        flags: Dword,
        id: *mut Dword,
    ) -> Handle;
    pub fn CloseHandle(handle: Handle) -> Bool;
    pub fn Sleep(ms: Dword);
    pub fn GetTickCount64() -> u64;
    pub fn QueryPerformanceCounter(counter: *mut i64) -> Bool;
    pub fn QueryPerformanceFrequency(frequency: *mut i64) -> Bool;
    pub fn GetLastError() -> Dword;
    pub fn GetEnvironmentVariableW(name: *const u16, value: *mut u16, size: Dword) -> Dword;
    /// One frame of the x64 unwind: `context` becomes the caller's.
    pub fn RtlVirtualUnwind(
        handler_type: u32,
        image_base: u64,
        pc: u64,
        function: *mut c_void,
        context: *mut Context,
        handler_data: *mut *mut c_void,
        establisher_frame: *mut u64,
        context_pointers: *mut c_void,
    ) -> *mut c_void;

    pub fn VirtualAlloc(address: *mut c_void, size: usize, kind: Dword, protect: Dword) -> *mut c_void;
    pub fn VirtualFree(address: *mut c_void, size: usize, kind: Dword) -> Bool;
    pub fn VirtualProtect(address: *mut c_void, size: usize, protect: Dword, old: *mut Dword) -> Bool;
    pub fn VirtualQuery(address: *const c_void, info: *mut MemoryBasicInformation, size: usize) -> usize;
    pub fn FlushInstructionCache(process: Handle, address: *const c_void, size: usize) -> Bool;

    pub fn CreateToolhelp32Snapshot(flags: Dword, process: Dword) -> Handle;
    pub fn Module32FirstW(snapshot: Handle, entry: *mut ModuleEntry32W) -> Bool;
    pub fn Module32NextW(snapshot: Handle, entry: *mut ModuleEntry32W) -> Bool;
    pub fn Thread32First(snapshot: Handle, entry: *mut ThreadEntry32) -> Bool;
    pub fn Thread32Next(snapshot: Handle, entry: *mut ThreadEntry32) -> Bool;
    pub fn OpenThread(access: Dword, inherit: Bool, id: Dword) -> Handle;
    pub fn SuspendThread(thread: Handle) -> Dword;
    /// The register state of a suspended thread: what says whether it is executing this DLL's code.
    pub fn GetThreadContext(thread: Handle, context: *mut Context) -> Bool;
    pub fn ResumeThread(thread: Handle) -> Dword;

    pub fn CreateFileW(
        name: *const u16,
        access: Dword,
        share: Dword,
        security: *mut c_void,
        disposition: Dword,
        flags: Dword,
        template: Handle,
    ) -> Handle;
    pub fn WriteFile(handle: Handle, buf: *const c_void, len: Dword, wrote: *mut Dword, overlapped: *mut c_void) -> Bool;
    pub fn SetFilePointer(handle: Handle, distance: i32, high: *mut i32, method: Dword) -> Dword;

    pub fn AddVectoredExceptionHandler(first: u32, handler: unsafe extern "system" fn(*mut c_void) -> i32) -> *mut c_void;
    /// Drops a handler `AddVectoredExceptionHandler` installed: an unload must not leave the process
    /// calling into an image it is about to free.
    pub fn RemoveVectoredExceptionHandler(handle: *mut c_void) -> u32;

    pub fn GetProcessHeap() -> Handle;
    pub fn HeapAlloc(heap: Handle, flags: u32, size: usize) -> *mut u8;
    pub fn HeapFree(heap: Handle, flags: u32, block: *mut u8) -> Bool;
    pub fn HeapReAlloc(heap: Handle, flags: u32, block: *mut u8, size: usize) -> *mut u8;

    pub fn InitializeCriticalSection(section: *mut CriticalSection);
    pub fn EnterCriticalSection(section: *mut CriticalSection);
    pub fn LeaveCriticalSection(section: *mut CriticalSection);
    pub fn DeleteCriticalSection(section: *mut CriticalSection);

    pub fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> Bool;
    pub fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> Bool;
    pub fn OpenProcess(access: Dword, inherit: Bool, id: Dword) -> Handle;
    pub fn VirtualAllocEx(process: Handle, address: *mut c_void, size: usize, kind: Dword, protect: Dword) -> *mut c_void;
    pub fn VirtualFreeEx(process: Handle, address: *mut c_void, size: usize, kind: Dword) -> Bool;
    pub fn WriteProcessMemory(process: Handle, address: *mut c_void, buf: *const c_void, size: usize, wrote: *mut usize) -> Bool;
    pub fn CreateRemoteThread(
        process: Handle,
        attributes: *mut c_void,
        stack: usize,
        start: extern "system" fn(*mut c_void) -> Dword,
        arg: *mut c_void,
        flags: Dword,
        id: *mut Dword,
    ) -> Handle;
    pub fn WaitForSingleObject(handle: Handle, ms: Dword) -> Dword;
    pub fn GetExitCodeThread(thread: Handle, code: *mut Dword) -> Bool;
    pub fn ExitProcess(code: u32) -> !;
    pub fn FreeLibrary(module: Hmodule) -> Bool;
    pub fn FreeLibraryAndExitThread(module: Hmodule, code: u32) -> !;
    pub fn DebugBreak();
    pub fn TerminateProcess(process: Handle, code: u32) -> Bool;
    pub fn GetCommandLineW() -> *const u16;
    pub fn GetStdHandle(kind: u32) -> Handle;
}

#[link(name = "user32", kind = "raw-dylib")]
extern "system" {
    pub fn EnumWindows(callback: EnumWindowsProc, arg: Lparam) -> Bool;
    pub fn GetWindowThreadProcessId(window: Hwnd, process: *mut Dword) -> Dword;
    pub fn IsWindowVisible(window: Hwnd) -> Bool;
    pub fn IsWindow(window: Hwnd) -> Bool;
    pub fn GetWindow(window: Hwnd, command: u32) -> Hwnd;
    pub fn GetClientRect(window: Hwnd, rect: *mut Rect) -> Bool;
    pub fn GetClassNameW(window: Hwnd, name: *mut u16, size: i32) -> i32;
    pub fn GetWindowLongPtrW(window: Hwnd, index: i32) -> isize;
    pub fn SetWindowLongPtrW(window: Hwnd, index: i32, value: isize) -> isize;
    pub fn CallWindowProcW(previous: WndProc, window: Hwnd, message: u32, wparam: Wparam, lparam: Lparam) -> Lresult;
    pub fn DefWindowProcW(window: Hwnd, message: u32, wparam: Wparam, lparam: Lparam) -> Lresult;
    pub fn GetRawInputData(
        raw: *mut c_void,
        command: u32,
        data: *mut c_void,
        size: *mut u32,
        header_size: u32,
    ) -> u32;
    pub fn GetForegroundWindow() -> Hwnd;
    pub fn PostMessageW(window: Hwnd, message: u32, wparam: Wparam, lparam: Lparam) -> Bool;
    /// A message into a thread's own queue, with no window: it makes a thread blocked in `GetMessage`
    /// run one wake-up, which is when user32 drops the reference a `WH_GETMESSAGE` hook took on this DLL.
    pub fn PostThreadMessageW(thread: Dword, message: u32, wparam: Wparam, lparam: Lparam) -> Bool;
    pub fn SetWindowsHookExW(id: i32, procedure: HookProc, module: Hmodule, thread: Dword) -> Handle;
    pub fn CallNextHookEx(hook: Handle, code: i32, wparam: Wparam, lparam: Lparam) -> Lresult;
    pub fn UnhookWindowsHookEx(hook: Handle) -> Bool;
    pub fn SetTimer(window: Hwnd, id: usize, interval: u32, callback: *mut c_void) -> usize;
    pub fn KillTimer(window: Hwnd, id: usize) -> Bool;
    pub fn EnumThreadWindows(thread: Dword, callback: EnumWindowsProc, arg: Lparam) -> Bool;
}

#[link(name = "ws2_32", kind = "raw-dylib")]
extern "system" {
    pub fn WSAStartup(version: u16, data: *mut WsaData) -> i32;
    pub fn socket(family: i32, kind: i32, protocol: i32) -> usize;
    pub fn bind(socket: usize, address: *const u8, len: i32) -> i32;
    pub fn listen(socket: usize, backlog: i32) -> i32;
    pub fn accept(socket: usize, address: *mut u8, len: *mut i32) -> usize;
    pub fn recv(socket: usize, buf: *mut u8, len: i32, flags: i32) -> i32;
    pub fn send(socket: usize, buf: *const u8, len: i32, flags: i32) -> i32;
    pub fn closesocket(socket: usize) -> i32;
    pub fn shutdown(socket: usize, how: i32) -> i32;
    pub fn WSAGetLastError() -> i32;
    /// `FIONBIO`: makes `accept` return at once with `WSAEWOULDBLOCK`, so the server loop can notice a
    /// stop instead of sitting in a call another thread cannot reliably interrupt.
    pub fn ioctlsocket(socket: usize, command: i32, value: *mut u32) -> i32;
}

/// `FIONBIO`, the "non-blocking" `ioctlsocket` command.
pub const FIONBIO: i32 = 0x8004_667Eu32 as i32;

/// The module handle of the code at `address` (this DLL, usually).
///
/// The handle is asked for with [`GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT`]: it neither raises the
/// loader's count nor pins the image. Both matter for hot reload. A pinned module can never be freed,
/// and a count raised by an agent that never drops it leaves `FreeLibraryAndExitThread` with nothing to
/// do, so the image stays mapped; a later attach of the same file name then finds the module already
/// loaded, `DllMain` is never called again, and the new agent never opens its port.
pub fn module_from_address(address: usize) -> Hmodule {
    let mut module: Hmodule = 0;
    // SAFETY: `address` is inside a mapped image (our own code); the out pointer is valid.
    unsafe {
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            address as *const u16,
            &mut module,
        );
    }
    module
}

/// Puts `previous` back as `window`'s procedure, but only while `ours` is the procedure on top: a
/// subclass installed after ours has saved `ours` as *its* previous, and overwriting it would lose that
/// link or, worse, restore a procedure that is itself one of this DLL's. Returns whether it restored.
pub fn restore_procedure(window: usize, ours: usize, previous: usize) -> bool {
    // SAFETY: a window of this process; reading its procedure has no side effect.
    let current = unsafe { GetWindowLongPtrW(window as Hwnd, GWLP_WNDPROC) } as usize;
    if current != ours {
        return false;
    }
    // SAFETY: `previous` was the window's procedure before `ours` replaced it.
    unsafe {
        SetWindowLongPtrW(window as Hwnd, GWLP_WNDPROC, previous as isize);
    }
    true
}

/// The loader's reference count for the module at `base` (its `LDR_DATA_TABLE_ENTRY` load count), or 0
/// when the module is not in the loader's list.
///
/// A module unloads when its count reaches zero. `agent.unload` waits for everything else that holds
/// this DLL — user32 for a `WH_GETMESSAGE` hook, the loader itself — to let go, and logs the count at
/// every step, so a reload that does not happen says why.
pub fn module_references(base: Hmodule) -> u16 {
    if base == 0 {
        return 0;
    }
    // SAFETY: `gs:[0x60]` is the PEB on x64 for every user thread; the walk only reads the loader's own
    // doubly linked module list, bounded by `steps`.
    unsafe {
        let peb: usize;
        core::arch::asm!("mov {}, gs:[0x60]", out(reg) peb, options(nostack, preserves_flags));
        if peb == 0 {
            return 0;
        }
        let ldr = core::ptr::read_volatile((peb + 0x18) as *const usize);
        if ldr == 0 {
            return 0;
        }
        // `InLoadOrderModuleList` sits at `ldr + 0x10`; a `LIST_ENTRY` is the entry's first field, so a
        // link address is also the entry address.
        let head = ldr + 0x10;
        let mut link = core::ptr::read_volatile(head as *const usize);
        let mut steps = 0;
        while link != 0 && link != head && steps < 1_024 {
            let dll_base = core::ptr::read_volatile((link + 0x30) as *const usize);
            if dll_base == base {
                // `ObsoleteLoadCount` on x64: `Flags` (u32) at +0x68, the count (u16) at +0x6c.
                return core::ptr::read_volatile((link + 0x6c) as *const u16);
            }
            link = core::ptr::read_volatile(link as *const usize);
            steps += 1;
        }
    }
    0
}

/// Every module of this process, by base and file name, as the loader has them.
pub fn loaded_modules() -> Vec<(Hmodule, String)> {
    let mut out = Vec::new();
    // SAFETY: the snapshot handle is owned here and closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, GetCurrentProcessId()) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot == 0 {
        return out;
    }
    let mut entry = ModuleEntry32W::default();
    entry.size = core::mem::size_of::<ModuleEntry32W>() as u32;
    // SAFETY: `entry` is a `MODULEENTRY32W` whose size field is set.
    if unsafe { Module32FirstW(snapshot, &mut entry) } != 0 {
        loop {
            let end = entry.name.iter().position(|unit| *unit == 0).unwrap_or(entry.name.len());
            out.push((entry.base as usize, narrow(&entry.name[..end])));
            // SAFETY: the same out pointer against the same snapshot.
            if unsafe { Module32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }
    // SAFETY: a handle this call created.
    unsafe {
        CloseHandle(snapshot);
    }
    out
}

/// The committed region `address` lies in, or `None` when it is not committed.
pub fn memory_info(address: usize) -> Option<MemoryBasicInformation> {
    let mut info = MemoryBasicInformation {
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
    // SAFETY: `info` has the documented size and layout of `MEMORY_BASIC_INFORMATION`.
    let written =
        unsafe { VirtualQuery(address as *const c_void, &mut info, core::mem::size_of::<MemoryBasicInformation>()) };
    if written == 0 || info.state != MEM_COMMIT {
        return None;
    }
    Some(info)
}

/// True when `[address, address+len)` is committed and readable: the guard every read of an address that
/// came from somewhere else goes through.
pub fn readable(address: usize, len: usize) -> bool {
    if address < 0x1_0000 {
        return false;
    }
    let mut left = len.max(1);
    let mut cursor = address;
    while left > 0 {
        let Some(info) = memory_info(cursor) else {
            return false;
        };
        let protect = info.protect & !PAGE_GUARD;
        if protect != PAGE_READONLY
            && protect != PAGE_READWRITE
            && protect != PAGE_WRITECOPY
            && protect != PAGE_EXECUTE_READ
            && protect != PAGE_EXECUTE_READWRITE
            && protect != PAGE_EXECUTE_WRITECOPY
        {
            return false;
        }
        let end = info.base_address as usize + info.region_size;
        if end <= cursor {
            return false;
        }
        left = left.saturating_sub(end - cursor);
        cursor = end;
    }
    true
}

/// The main module of the process (the game executable).
pub fn main_module() -> Hmodule {
    // SAFETY: a null name asks for the process's own module.
    unsafe { GetModuleHandleW(core::ptr::null()) }
}

/// A named module, or 0 when it is not loaded.
pub fn module(name: &str) -> Hmodule {
    let wide = wide(name);
    // SAFETY: `wide` is NUL-terminated and alive for the call.
    unsafe { GetModuleHandleW(wide.as_ptr()) }
}

pub fn current_process_id() -> u32 {
    // SAFETY: no arguments, no invariants.
    unsafe { GetCurrentProcessId() }
}

pub fn current_thread_id() -> u32 {
    // SAFETY: no arguments, no invariants.
    unsafe { GetCurrentThreadId() }
}

/// Milliseconds since the process started, matching agent.c's `GetTickCount64` uses.
pub fn tick_ms() -> u64 {
    // SAFETY: no arguments, no invariants.
    unsafe { GetTickCount64() }
}

/// A monotonic microsecond clock from the performance counter: the rate limit's own time base.
///
/// `GetTickCount64` is too coarse for a two-millisecond limit (its tick can be 15.6 ms), so the
/// counter that the game itself times frames with is used, with a millisecond fallback when the
/// platform refuses it.
pub fn qpc_micros() -> u64 {
    use core::sync::atomic::{AtomicI64, Ordering};
    static FREQUENCY: AtomicI64 = AtomicI64::new(0);
    let mut frequency = FREQUENCY.load(Ordering::Relaxed);
    if frequency == 0 {
        let mut queried = 0i64;
        // SAFETY: the out pointer is a valid i64.
        if unsafe { QueryPerformanceFrequency(&mut queried) } == 0 || queried <= 0 {
            return tick_ms().saturating_mul(1000);
        }
        FREQUENCY.store(queried, Ordering::Relaxed);
        frequency = queried;
    }
    let mut counter = 0i64;
    // SAFETY: the out pointer is a valid i64.
    if unsafe { QueryPerformanceCounter(&mut counter) } == 0 {
        return tick_ms().saturating_mul(1000);
    }
    (counter.max(0) as u128 * 1_000_000 / frequency as u128) as u64
}

pub fn sleep_ms(ms: u32) {
    // SAFETY: no arguments, no invariants.
    unsafe { Sleep(ms) }
}

/// Drops one loader reference of `module`. The caller must hold more than one, so the image stays mapped.
pub fn free_library(module: Hmodule) -> bool {
    // SAFETY: `module` is a mapped module whose count the caller read as above one.
    unsafe { FreeLibrary(module) != 0 }
}

/// Frees this DLL and ends the calling thread. The caller must have removed every hook and stopped
/// every other thread this DLL started: after it returns nothing of this image may run again.
pub fn free_library_and_exit_thread(module: Hmodule, code: u32) -> ! {
    // SAFETY: the caller guarantees no hook or thread of this DLL survives.
    unsafe { FreeLibraryAndExitThread(module, code) }
}

pub fn debug_break() {
    // SAFETY: raises a breakpoint; a debugger or the OS handles it.
    unsafe { DebugBreak() }
}

/// Terminates the process, used by the panic handler: there is no CRT to unwind with.
pub fn terminate_process(code: u32) -> ! {
    // SAFETY: `GetCurrentProcess` is not imported, so use the pseudo handle (-1).
    unsafe {
        TerminateProcess(usize::MAX, code);
    }
    // TerminateProcess can only fail for a handle we do not own; spin instead of returning.
    loop {
        sleep_ms(1000);
    }
}

/// A UTF-16, NUL-terminated copy of `text`.
pub fn wide(text: &str) -> Vec<u16> {
    let mut out: Vec<u16> = text.encode_utf16().collect();
    out.push(0);
    out
}

/// UTF-8 of a UTF-16 string, stopping at the first NUL (or at `len` when given).
pub fn narrow(text: &[u16]) -> String {
    let end = text.iter().position(|c| *c == 0).unwrap_or(text.len());
    char::decode_utf16(text[..end].iter().copied())
        .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

/// The full path of `module` (its own file), or an empty string.
pub fn module_path(module: Hmodule) -> Vec<u16> {
    let mut buf = alloc::vec![0u16; 1024];
    // SAFETY: the buffer and its length agree.
    let n = unsafe { GetModuleFileNameW(module, buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if n == 0 || n >= buf.len() {
        return Vec::new();
    }
    buf.truncate(n + 1);
    buf[n] = 0;
    buf
}

/// Environment variable as UTF-8; empty when unset.
pub fn env(name: &str) -> String {
    let wide_name = wide(name);
    let mut buf = [0u16; 64];
    // SAFETY: the buffer and its length agree.
    let n = unsafe { GetEnvironmentVariableW(wide_name.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if n == 0 || n >= buf.len() {
        return String::new();
    }
    narrow(&buf[..n])
}

/// `GetLastError`, for log lines.
pub fn last_error() -> u32 {
    // SAFETY: no arguments, no invariants.
    unsafe { GetLastError() }
}
