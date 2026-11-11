//! The screenshot request: a copy of the frame the game presents, written as a PNG to the requested path.
//!
//! The client renders through Direct3D 12 and shows each frame with the DXGI swap chain's `Present`
//! (vkd3d-proton behind DXVK's `dxgi.dll` under Proton, the system DXGI on Windows). The agent hooks
//! that `Present` and, when a screenshot is wanted, copies the back buffer the game is about to show
//! into a readback buffer on the game's own command queue before the original `Present` runs. The
//! picture is what the window shows that frame: the world, the HUD and any open screen. The game's
//! own screenshot path (F2, its gallery, its toast and sound) is not involved.
//!
//! Recipe ([`resolve`]), nothing from the game's executable: the swap chain class's `Present` and
//! `Present1` are read from the vtable of a throwaway 16x16 swap chain made the way the game makes its
//! own — `D3D12CreateDevice` (a device is a per-adapter singleton, so this is the game's device),
//! a direct command queue and `IDXGIFactory2::CreateSwapChainForHwnd` on a hidden window, through the
//! `dxgi.dll` and `d3d12.dll` the game already loaded — and the queue class's `ExecuteCommandLists`
//! from the same queue's vtable. All three are hooked; a call that reaches `Present1` from `Present`
//! finds the request already taken.
//!
//! In the hook ([`grab`]): the back buffer is `GetBuffer(GetCurrentBackBufferIndex())`, the queue is the
//! swap chain's device object when `GetDevice` answers a command queue, else the direct queue the
//! presenting thread last submitted to (DXVK's DXGI over vkd3d-proton answers no queue;
//! [`hook_execute`] remembers it). The copy is a transition `PRESENT -> COPY_SOURCE`, a
//! `CopyTextureRegion` into a row-major readback buffer, the transition back, and a fence the frame
//! thread waits on. The rows are converted to RGB on
//! that thread; the PNG (stored deflate) is built and written on the caller's thread.

use alloc::vec::Vec;
use core::ffi::c_void;
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};

use agent_core::sync::SpinLock;
use agent_core::{log, win, Anchor, Core, RpcError};

/// `engine.status` anchor and hook site of the hooked `Present`.
pub const SITE_PRESENT: &str = "screenshot.present";
/// Hook site of the hooked `Present1`.
const SITE_PRESENT1: &str = "screenshot.present1";
/// Hook site of the hooked `ID3D12CommandQueue::ExecuteCommandLists`.
const SITE_EXECUTE: &str = "screenshot.queue";

static PRESENT: AtomicUsize = AtomicUsize::new(0);
static PRESENT_TRAMPOLINE: AtomicUsize = AtomicUsize::new(0);
static PRESENT1: AtomicUsize = AtomicUsize::new(0);
static PRESENT1_TRAMPOLINE: AtomicUsize = AtomicUsize::new(0);
static EXECUTE: AtomicUsize = AtomicUsize::new(0);
static EXECUTE_TRAMPOLINE: AtomicUsize = AtomicUsize::new(0);
/// The direct queue the game last submitted to from the thread that presents, and from any thread.
static QUEUE_PRESENTING: AtomicUsize = AtomicUsize::new(0);
static QUEUE_ANY: AtomicUsize = AtomicUsize::new(0);
/// The thread the game presents on (0 until the first `Present`).
static PRESENT_THREAD: AtomicU32 = AtomicU32::new(0);

/// How long a request waits for the next presented frame.
const FRAME_WAIT_MS: u64 = 3_000;
/// How long the frame thread waits for the GPU to finish the copy.
const COPY_WAIT_MS: u64 = 2_000;

/// The request between the caller and the frame thread.
const IDLE: u32 = 0;
const WANTED: u32 = 1;
const TAKEN: u32 = 2;
const DONE: u32 = 3;
static REQUEST: AtomicU32 = AtomicU32::new(IDLE);
/// What the frame thread copied for the request, or why it could not.
static RESULT: SpinLock<Option<Result<Frame, &'static str>>> = SpinLock::new(None);
/// One screenshot at a time, across connections.
static BUSY: AtomicBool = AtomicBool::new(false);

/// One copied frame: `height` rows of a filter byte (0) and `width` RGB pixels — the PNG scanlines.
struct Frame {
    width: u32,
    height: u32,
    rows: Vec<u8>,
}

/* ------------------------------------------------------------------------------------------------
 * COM plumbing
 * ---------------------------------------------------------------------------------------------- */

#[repr(C)]
struct Guid(u32, u16, u16, [u8; 8]);

const IID_DXGI_FACTORY2: Guid = Guid(0x50c83a1c, 0xe072, 0x4c48, [0x87, 0xb0, 0x36, 0x30, 0xfa, 0x36, 0xa6, 0xd0]);
const IID_DXGI_SWAP_CHAIN3: Guid = Guid(0x94d99bdb, 0xf1f8, 0x4ab0, [0xb2, 0x36, 0x7d, 0xa0, 0x17, 0x0e, 0xda, 0xb1]);
const IID_D3D12_DEVICE: Guid = Guid(0x189819f1, 0x1db6, 0x4b57, [0xbe, 0x54, 0x18, 0x21, 0x33, 0x9b, 0x85, 0xf7]);
const IID_D3D12_COMMAND_QUEUE: Guid = Guid(0x0ec870a6, 0x5d7e, 0x4c22, [0x8c, 0xfc, 0x5b, 0xaa, 0xe0, 0x76, 0x16, 0xed]);
const IID_D3D12_COMMAND_ALLOCATOR: Guid = Guid(0x6102dee4, 0xaf59, 0x4b09, [0xb9, 0x99, 0xb4, 0x4d, 0x73, 0xf0, 0x9b, 0x24]);
const IID_D3D12_GRAPHICS_COMMAND_LIST: Guid = Guid(0x5b160d0f, 0xac1b, 0x4185, [0x8b, 0xa8, 0xb3, 0xae, 0x42, 0xa5, 0xa4, 0x55]);
const IID_D3D12_RESOURCE: Guid = Guid(0x696442be, 0xa72e, 0x4059, [0xbc, 0x79, 0x5b, 0x5c, 0x98, 0x04, 0x0f, 0xad]);
const IID_D3D12_FENCE: Guid = Guid(0x0a753dcf, 0xc4d8, 0x4b91, [0xad, 0xf6, 0xbe, 0x5a, 0x60, 0xd9, 0x5a, 0x76]);

/// Vtable slots (IUnknown 0-2; the rest from the SDK's interface order).
mod slot {
    pub const QUERY_INTERFACE: usize = 0;
    pub const RELEASE: usize = 2;
    // IDXGIDeviceSubObject / ID3D12DeviceChild
    pub const GET_DEVICE: usize = 7;
    // IDXGISwapChain / IDXGISwapChain1 / IDXGISwapChain3
    pub const PRESENT: usize = 8;
    pub const GET_BUFFER: usize = 9;
    pub const GET_DESC1: usize = 18;
    pub const PRESENT1: usize = 22;
    pub const GET_CURRENT_BACK_BUFFER_INDEX: usize = 36;
    // IDXGIFactory2
    pub const CREATE_SWAP_CHAIN_FOR_HWND: usize = 15;
    // ID3D12Device
    pub const CREATE_COMMAND_QUEUE: usize = 8;
    pub const CREATE_COMMAND_ALLOCATOR: usize = 9;
    pub const CREATE_COMMAND_LIST: usize = 12;
    pub const CREATE_COMMITTED_RESOURCE: usize = 27;
    pub const CREATE_FENCE: usize = 36;
    // ID3D12CommandQueue
    pub const EXECUTE_COMMAND_LISTS: usize = 10;
    pub const SIGNAL: usize = 14;
    // ID3D12GraphicsCommandList
    pub const CLOSE: usize = 9;
    pub const COPY_TEXTURE_REGION: usize = 16;
    pub const RESOURCE_BARRIER: usize = 26;
    // ID3D12CommandList
    pub const GET_TYPE: usize = 8;
    // ID3D12Resource
    pub const MAP: usize = 8;
    pub const UNMAP: usize = 9;
    // ID3D12Fence
    pub const GET_COMPLETED_VALUE: usize = 8;
}

/// Entry `index` of the vtable of the COM object `this`.
///
/// # Safety
/// `this` must be a live COM object whose vtable has more than `index` entries.
unsafe fn method(this: usize, index: usize) -> usize {
    *((*(this as *const usize)) as *const usize).add(index)
}

/// `IUnknown::Release`, for a non-null object.
fn release(this: usize) {
    if this != 0 {
        // SAFETY: every object passed here is a COM object this module received and owns a reference to.
        unsafe {
            let f: extern "system" fn(usize) -> u32 = core::mem::transmute(method(this, slot::RELEASE));
            f(this);
        }
    }
}

/// `QueryInterface(this, iid)`: the interface, or 0.
fn query(this: usize, iid: &Guid) -> usize {
    let mut out = 0usize;
    // SAFETY: `this` is a live COM object; the out pointer is a valid usize.
    let hr = unsafe {
        let f: extern "system" fn(usize, *const Guid, *mut usize) -> i32 = core::mem::transmute(method(this, slot::QUERY_INTERFACE));
        f(this, iid, &mut out)
    };
    if hr < 0 { 0 } else { out }
}

/// `GetDevice(iid)` of a DXGI device sub-object or a Direct3D 12 device child: the object, or 0.
fn device_of(this: usize, iid: &Guid) -> usize {
    let mut out = 0usize;
    // SAFETY: `this` is a live object with `GetDevice(REFIID, void**)` at slot 7.
    let hr = unsafe {
        let f: extern "system" fn(usize, *const Guid, *mut usize) -> i32 = core::mem::transmute(method(this, slot::GET_DEVICE));
        f(this, iid, &mut out)
    };
    if hr < 0 { 0 } else { out }
}

/// Releases every held object when dropped.
struct Held([usize; 12], usize);

impl Held {
    fn new() -> Self {
        Self([0; 12], 0)
    }
    fn keep(&mut self, object: usize) -> usize {
        if object != 0 && self.1 < self.0.len() {
            self.0[self.1] = object;
            self.1 += 1;
        }
        object
    }
    /// Gives up the references without releasing them (the GPU may still use them).
    fn leak(&mut self) {
        self.1 = 0;
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        for object in self.0[..self.1].iter().rev() {
            release(*object);
        }
    }
}

#[repr(C)]
struct SampleDesc {
    count: u32,
    quality: u32,
}

#[repr(C)]
struct SwapChainDesc1 {
    width: u32,
    height: u32,
    format: u32,
    stereo: i32,
    sample: SampleDesc,
    usage: u32,
    buffers: u32,
    scaling: u32,
    effect: u32,
    alpha: u32,
    flags: u32,
}

#[repr(C)]
struct CommandQueueDesc {
    kind: u32,
    priority: i32,
    flags: u32,
    node_mask: u32,
}

#[repr(C)]
struct HeapProperties {
    kind: u32,
    cpu_page: u32,
    pool: u32,
    creation_mask: u32,
    visible_mask: u32,
}

#[repr(C)]
struct ResourceDesc {
    dimension: u32,
    alignment: u64,
    width: u64,
    height: u32,
    depth: u16,
    mips: u16,
    format: u32,
    sample: SampleDesc,
    layout: u32,
    flags: u32,
}

#[repr(C)]
struct TransitionBarrier {
    kind: u32,
    flags: u32,
    resource: usize,
    subresource: u32,
    before: u32,
    after: u32,
}

#[repr(C)]
struct Footprint {
    offset: u64,
    format: u32,
    width: u32,
    height: u32,
    depth: u32,
    row_pitch: u32,
}

/// `D3D12_TEXTURE_COPY_LOCATION`: the union is the placed footprint, or its first `u32` the subresource.
#[repr(C)]
struct CopyLocation {
    resource: usize,
    kind: u32,
    footprint: Footprint,
}

#[repr(C)]
struct Range {
    begin: usize,
    end: usize,
}

const D3D_FEATURE_LEVEL_11_0: u32 = 0xb000;
const DXGI_FORMAT_R8G8B8A8_UNORM: u32 = 28;
const DXGI_USAGE_RENDER_TARGET_OUTPUT: u32 = 0x20;
const DXGI_SWAP_EFFECT_FLIP_DISCARD: u32 = 4;
const DXGI_PRESENT_TEST: u32 = 0x1;
const D3D12_COMMAND_LIST_TYPE_DIRECT: u32 = 0;
const D3D12_RESOURCE_STATE_PRESENT: u32 = 0;
const D3D12_RESOURCE_STATE_COPY_DEST: u32 = 0x400;
const D3D12_RESOURCE_STATE_COPY_SOURCE: u32 = 0x800;
const D3D12_HEAP_TYPE_READBACK: u32 = 3;
const D3D12_RESOURCE_DIMENSION_BUFFER: u32 = 1;
const D3D12_TEXTURE_LAYOUT_ROW_MAJOR: u32 = 1;
const D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX: u32 = 0;
const D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT: u32 = 1;
const D3D12_TEXTURE_DATA_PITCH_ALIGNMENT: u32 = 256;
const WS_POPUP: u32 = 0x8000_0000;

/* ------------------------------------------------------------------------------------------------
 * Resolution
 * ---------------------------------------------------------------------------------------------- */

/// A function of a module the game already loaded, or 0.
fn export(module: &str, name: &[u8]) -> usize {
    let handle = win::module(module);
    if handle == 0 {
        return 0;
    }
    // SAFETY: `handle` is a loaded module; `name` is NUL-terminated.
    unsafe { win::GetProcAddress(handle, name.as_ptr()) as usize }
}

/// Finds the swap chain's `Present` and `Present1` and hooks both (see the module docs). Runs once, at attach.
pub fn resolve(core: &'static Core) -> Vec<Anchor> {
    match swap_chain_entries() {
        Ok((present, present1, execute)) => {
            log::fmt(format_args!(
                "capture: swap chain Present 0x{present:x}, Present1 0x{present1:x}, queue ExecuteCommandLists 0x{execute:x}"
            ));
            // First, so the queue is known by the time a request reaches `Present`.
            if install(core, SITE_EXECUTE, execute, hook_execute as *const () as usize, &EXECUTE_TRAMPOLINE) {
                EXECUTE.store(execute, Ordering::Release);
            }
            if install(core, SITE_PRESENT, present, hook_present as *const () as usize, &PRESENT_TRAMPOLINE) {
                PRESENT.store(present, Ordering::Release);
            }
            if present1 != present && install(core, SITE_PRESENT1, present1, hook_present1 as *const () as usize, &PRESENT1_TRAMPOLINE) {
                PRESENT1.store(present1, Ordering::Release);
            }
        }
        Err(reason) => log::fmt(format_args!("capture: no swap chain Present ({reason}); screenshot answers -32001")),
    }
    report()
}

/// The anchor as it is now.
pub fn report() -> Vec<Anchor> {
    alloc::vec![Anchor { name: SITE_PRESENT, addr: PRESENT.load(Ordering::Acquire) }]
}

fn install(core: &'static Core, name: &'static str, target: usize, replacement: usize, slot: &AtomicUsize) -> bool {
    match agent_core::hook::install_published(target, replacement, slot) {
        Some(_) => {
            core.site(name, true);
            log::fmt(format_args!("hook {name}: installed at 0x{target:x}"));
            true
        }
        None => {
            core.site(name, false);
            log::fmt(format_args!("hook {name}: refused, dxgi code untouched"));
            false
        }
    }
}

/// `Present` and `Present1` of the swap chain class and the command queue class's `ExecuteCommandLists`,
/// read from a throwaway swap chain's and queue's vtables.
fn swap_chain_entries() -> Result<(usize, usize, usize), &'static str> {
    let create_factory = export("dxgi.dll", b"CreateDXGIFactory1\0");
    let create_device = export("d3d12.dll", b"D3D12CreateDevice\0");
    if create_factory == 0 || create_device == 0 {
        return Err("dxgi.dll or d3d12.dll is not loaded: the game does not render with Direct3D 12");
    }
    let create_window = export("user32.dll", b"CreateWindowExW\0");
    let destroy_window = export("user32.dll", b"DestroyWindow\0");
    if create_window == 0 || destroy_window == 0 {
        return Err("user32.dll is not loaded");
    }
    let mut held = Held::new();
    // SAFETY: each call is the documented export or vtable entry with its documented arguments; every
    // out pointer is a local, and each object is released once by `held`.
    unsafe {
        let mut factory = 0usize;
        let f: extern "system" fn(*const Guid, *mut usize) -> i32 = core::mem::transmute(create_factory);
        if f(&IID_DXGI_FACTORY2, &mut factory) < 0 || held.keep(factory) == 0 {
            return Err("CreateDXGIFactory1 refused IDXGIFactory2");
        }
        let mut device = 0usize;
        let f: extern "system" fn(usize, u32, *const Guid, *mut usize) -> i32 = core::mem::transmute(create_device);
        if f(0, D3D_FEATURE_LEVEL_11_0, &IID_D3D12_DEVICE, &mut device) < 0 || held.keep(device) == 0 {
            return Err("D3D12CreateDevice failed");
        }
        let desc = CommandQueueDesc { kind: 0, priority: 0, flags: 0, node_mask: 0 };
        let mut queue = 0usize;
        let f: extern "system" fn(usize, *const CommandQueueDesc, *const Guid, *mut usize) -> i32 =
            core::mem::transmute(method(device, slot::CREATE_COMMAND_QUEUE));
        if f(device, &desc, &IID_D3D12_COMMAND_QUEUE, &mut queue) < 0 || held.keep(queue) == 0 {
            return Err("CreateCommandQueue failed");
        }
        let class = win::wide("STATIC");
        let title = win::wide("");
        let f: extern "system" fn(u32, *const u16, *const u16, u32, i32, i32, i32, i32, usize, usize, usize, usize) -> usize =
            core::mem::transmute(create_window);
        let window = f(0, class.as_ptr(), title.as_ptr(), WS_POPUP, 0, 0, 16, 16, 0, 0, 0, 0);
        if window == 0 {
            return Err("CreateWindowExW failed");
        }
        let desc = SwapChainDesc1 {
            width: 16,
            height: 16,
            format: DXGI_FORMAT_R8G8B8A8_UNORM,
            stereo: 0,
            sample: SampleDesc { count: 1, quality: 0 },
            usage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            buffers: 2,
            scaling: 0,
            effect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
            alpha: 0,
            flags: 0,
        };
        let mut chain = 0usize;
        let f: extern "system" fn(usize, usize, usize, *const SwapChainDesc1, usize, usize, *mut usize) -> i32 =
            core::mem::transmute(method(factory, slot::CREATE_SWAP_CHAIN_FOR_HWND));
        let hr = f(factory, queue, window, &desc, 0, 0, &mut chain);
        let entries = if hr < 0 || chain == 0 {
            Err("CreateSwapChainForHwnd failed")
        } else {
            let entries = (
                follow(method(chain, slot::PRESENT)),
                follow(method(chain, slot::PRESENT1)),
                follow(method(queue, slot::EXECUTE_COMMAND_LISTS)),
            );
            release(chain);
            Ok(entries)
        };
        let f: extern "system" fn(usize) -> i32 = core::mem::transmute(destroy_window);
        f(window);
        entries
    }
}

/// The function a vtable entry runs: an import or incremental-link stub (`jmp rel32`, `jmp [rip+x]`)
/// is followed to its target, since a hook cannot relocate a relative jump.
fn follow(mut entry: usize) -> usize {
    for _ in 0..4 {
        // SAFETY: `entry` is the start of mapped code (a vtable entry or a jump target); at most 6 bytes read.
        unsafe {
            let code = entry as *const u8;
            match (*code, *code.add(1)) {
                (0xE9, _) => entry = (entry as isize + 5 + (code.add(1) as *const i32).read_unaligned() as isize) as usize,
                (0xFF, 0x25) => entry = *((entry as isize + 6 + (code.add(2) as *const i32).read_unaligned() as isize) as *const usize),
                _ => return entry,
            }
        }
    }
    entry
}

/* ------------------------------------------------------------------------------------------------
 * The hooks
 * ---------------------------------------------------------------------------------------------- */

unsafe extern "system" fn hook_present(chain: usize, interval: u32, flags: u32) -> i32 {
    take(chain, flags);
    let original = PRESENT_TRAMPOLINE.load(Ordering::Acquire);
    // SAFETY: the trampoline runs the original `Present` with the game's own arguments.
    let f: extern "system" fn(usize, u32, u32) -> i32 = core::mem::transmute(original);
    f(chain, interval, flags)
}

unsafe extern "system" fn hook_present1(chain: usize, interval: u32, flags: u32, parameters: usize) -> i32 {
    take(chain, flags);
    let original = PRESENT1_TRAMPOLINE.load(Ordering::Acquire);
    // SAFETY: the trampoline runs the original `Present1` with the game's own arguments.
    let f: extern "system" fn(usize, u32, u32, usize) -> i32 = core::mem::transmute(original);
    f(chain, interval, flags, parameters)
}

/// The game's queue submissions: remembers the direct queue the presenting thread renders with.
unsafe extern "system" fn hook_execute(queue: usize, count: u32, lists: *const usize) {
    if count > 0 && !lists.is_null() {
        let list = *lists;
        // ID3D12CommandList::GetType
        let kind: extern "system" fn(usize) -> u32 = core::mem::transmute(method(list, slot::GET_TYPE));
        if list != 0 && kind(list) == D3D12_COMMAND_LIST_TYPE_DIRECT {
            QUEUE_ANY.store(queue, Ordering::Release);
            if win::current_thread_id() == PRESENT_THREAD.load(Ordering::Acquire) {
                QUEUE_PRESENTING.store(queue, Ordering::Release);
            }
        }
    }
    let original = EXECUTE_TRAMPOLINE.load(Ordering::Acquire);
    // SAFETY: the trampoline runs the original `ExecuteCommandLists` with the game's own arguments.
    let f: extern "system" fn(usize, u32, *const usize) = core::mem::transmute(original);
    f(queue, count, lists)
}

/// The queue the copy runs on, with a reference: the swap chain's own (`GetDevice` answers it on
/// Windows), else the direct queue the presenting thread last submitted to, else any direct queue.
fn presenting_queue(chain: usize) -> usize {
    let own = device_of(chain, &IID_D3D12_COMMAND_QUEUE);
    if own != 0 {
        return own;
    }
    let queue = match QUEUE_PRESENTING.load(Ordering::Acquire) {
        0 => QUEUE_ANY.load(Ordering::Acquire),
        queue => queue,
    };
    if queue != 0 {
        // SAFETY: the game's queue outlives its swap chain; AddRef (slot 1) pairs with `held`'s Release.
        unsafe {
            let add_ref: extern "system" fn(usize) -> u32 = core::mem::transmute(method(queue, 1));
            add_ref(queue);
        }
    }
    queue
}

/// Copies this frame when a request waits for one.
fn take(chain: usize, flags: u32) {
    PRESENT_THREAD.store(win::current_thread_id(), Ordering::Release);
    if flags & DXGI_PRESENT_TEST != 0 {
        return;
    }
    if REQUEST.compare_exchange(WANTED, TAKEN, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return;
    }
    let result = grab(chain);
    *RESULT.lock() = Some(result);
    REQUEST.store(DONE, Ordering::Release);
}

/// The back buffer about to be presented, as RGB scanlines.
fn grab(chain: usize) -> Result<Frame, &'static str> {
    let mut held = Held::new();
    // SAFETY: `chain` is the swap chain the game presents; every call is a documented vtable entry
    // with its documented arguments, every out pointer a local, every object released once by `held`
    // (or deliberately leaked when the GPU did not finish with it).
    unsafe {
        let chain3 = held.keep(query(chain, &IID_DXGI_SWAP_CHAIN3));
        if chain3 == 0 {
            return Err("the swap chain has no IDXGISwapChain3");
        }
        let mut desc: SwapChainDesc1 = core::mem::zeroed();
        let f: extern "system" fn(usize, *mut SwapChainDesc1) -> i32 = core::mem::transmute(method(chain3, slot::GET_DESC1));
        if f(chain3, &mut desc) < 0 || desc.width == 0 || desc.height == 0 {
            return Err("GetDesc1 failed");
        }
        let Some(pixel) = PixelFormat::of(desc.format) else {
            return Err("the back buffer format is not one the agent converts");
        };
        let f: extern "system" fn(usize) -> u32 = core::mem::transmute(method(chain3, slot::GET_CURRENT_BACK_BUFFER_INDEX));
        let index = f(chain3);
        let mut buffer = 0usize;
        let f: extern "system" fn(usize, u32, *const Guid, *mut usize) -> i32 = core::mem::transmute(method(chain3, slot::GET_BUFFER));
        if f(chain3, index, &IID_D3D12_RESOURCE, &mut buffer) < 0 || held.keep(buffer) == 0 {
            return Err("the back buffer is not a Direct3D 12 resource");
        }
        let queue = held.keep(presenting_queue(chain3));
        if queue == 0 {
            return Err("no Direct3D 12 direct command queue of the game is known yet");
        }
        let device = held.keep(device_of(queue, &IID_D3D12_DEVICE));
        if device == 0 {
            return Err("the command queue has no device");
        }

        let pitch = (desc.width * 4).div_ceil(D3D12_TEXTURE_DATA_PITCH_ALIGNMENT) * D3D12_TEXTURE_DATA_PITCH_ALIGNMENT;
        let size = pitch as u64 * desc.height as u64;
        let heap = HeapProperties { kind: D3D12_HEAP_TYPE_READBACK, cpu_page: 0, pool: 0, creation_mask: 0, visible_mask: 0 };
        let rdesc = ResourceDesc {
            dimension: D3D12_RESOURCE_DIMENSION_BUFFER,
            alignment: 0,
            width: size,
            height: 1,
            depth: 1,
            mips: 1,
            format: 0,
            sample: SampleDesc { count: 1, quality: 0 },
            layout: D3D12_TEXTURE_LAYOUT_ROW_MAJOR,
            flags: 0,
        };
        let mut readback = 0usize;
        let f: extern "system" fn(usize, *const HeapProperties, u32, *const ResourceDesc, u32, usize, *const Guid, *mut usize) -> i32 =
            core::mem::transmute(method(device, slot::CREATE_COMMITTED_RESOURCE));
        if f(device, &heap, 0, &rdesc, D3D12_RESOURCE_STATE_COPY_DEST, 0, &IID_D3D12_RESOURCE, &mut readback) < 0
            || held.keep(readback) == 0
        {
            return Err("CreateCommittedResource (readback) failed");
        }
        let mut allocator = 0usize;
        let f: extern "system" fn(usize, u32, *const Guid, *mut usize) -> i32 =
            core::mem::transmute(method(device, slot::CREATE_COMMAND_ALLOCATOR));
        if f(device, 0, &IID_D3D12_COMMAND_ALLOCATOR, &mut allocator) < 0 || held.keep(allocator) == 0 {
            return Err("CreateCommandAllocator failed");
        }
        let mut list = 0usize;
        let f: extern "system" fn(usize, u32, u32, usize, usize, *const Guid, *mut usize) -> i32 =
            core::mem::transmute(method(device, slot::CREATE_COMMAND_LIST));
        if f(device, 0, 0, allocator, 0, &IID_D3D12_GRAPHICS_COMMAND_LIST, &mut list) < 0 || held.keep(list) == 0 {
            return Err("CreateCommandList failed");
        }
        let mut fence = 0usize;
        let f: extern "system" fn(usize, u64, u32, *const Guid, *mut usize) -> i32 = core::mem::transmute(method(device, slot::CREATE_FENCE));
        if f(device, 0, 0, &IID_D3D12_FENCE, &mut fence) < 0 || held.keep(fence) == 0 {
            return Err("CreateFence failed");
        }

        let barrier: extern "system" fn(usize, u32, *const TransitionBarrier) = core::mem::transmute(method(list, slot::RESOURCE_BARRIER));
        let to_copy = TransitionBarrier {
            kind: 0,
            flags: 0,
            resource: buffer,
            subresource: 0,
            before: D3D12_RESOURCE_STATE_PRESENT,
            after: D3D12_RESOURCE_STATE_COPY_SOURCE,
        };
        barrier(list, 1, &to_copy);
        let destination = CopyLocation {
            resource: readback,
            kind: D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT,
            footprint: Footprint { offset: 0, format: desc.format, width: desc.width, height: desc.height, depth: 1, row_pitch: pitch },
        };
        let source = CopyLocation {
            resource: buffer,
            kind: D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX,
            footprint: Footprint { offset: 0, format: 0, width: 0, height: 0, depth: 0, row_pitch: 0 },
        };
        let copy: extern "system" fn(usize, *const CopyLocation, u32, u32, u32, *const CopyLocation, usize) =
            core::mem::transmute(method(list, slot::COPY_TEXTURE_REGION));
        copy(list, &destination, 0, 0, 0, &source, 0);
        let back = TransitionBarrier { before: D3D12_RESOURCE_STATE_COPY_SOURCE, after: D3D12_RESOURCE_STATE_PRESENT, ..to_copy };
        barrier(list, 1, &back);
        let close: extern "system" fn(usize) -> i32 = core::mem::transmute(method(list, slot::CLOSE));
        if close(list) < 0 {
            return Err("the copy command list did not close");
        }
        let execute: extern "system" fn(usize, u32, *const usize) = core::mem::transmute(method(queue, slot::EXECUTE_COMMAND_LISTS));
        execute(queue, 1, &list);
        let signal: extern "system" fn(usize, usize, u64) -> i32 = core::mem::transmute(method(queue, slot::SIGNAL));
        if signal(queue, fence, 1) < 0 {
            held.leak();
            return Err("the queue refused the fence signal");
        }
        let completed: extern "system" fn(usize) -> u64 = core::mem::transmute(method(fence, slot::GET_COMPLETED_VALUE));
        let deadline = win::tick_ms() + COPY_WAIT_MS;
        while completed(fence) < 1 {
            if win::tick_ms() > deadline {
                // The GPU may still write the readback buffer: keep every object alive.
                held.leak();
                return Err("the GPU did not finish the copy in time");
            }
            win::sleep_ms(0);
        }

        let mut data: *mut u8 = core::ptr::null_mut();
        let range = Range { begin: 0, end: size as usize };
        let map: extern "system" fn(usize, u32, *const Range, *mut *mut u8) -> i32 = core::mem::transmute(method(readback, slot::MAP));
        if map(readback, 0, &range, &mut data) < 0 || data.is_null() {
            return Err("the readback buffer did not map");
        }
        let width = desc.width as usize;
        let mut rows = Vec::new();
        let total = (width * 3 + 1) * desc.height as usize;
        if rows.try_reserve_exact(total).is_err() {
            let unmap: extern "system" fn(usize, u32, *const Range) = core::mem::transmute(method(readback, slot::UNMAP));
            unmap(readback, 0, &Range { begin: 0, end: 0 });
            return Err("out of memory for the frame");
        }
        for y in 0..desc.height as usize {
            let line = core::slice::from_raw_parts(data.add(y * pitch as usize), width * 4);
            rows.push(0u8);
            for pixel_bytes in line.chunks_exact(4) {
                rows.extend_from_slice(&pixel.rgb(pixel_bytes));
            }
        }
        let unmap: extern "system" fn(usize, u32, *const Range) = core::mem::transmute(method(readback, slot::UNMAP));
        unmap(readback, 0, &Range { begin: 0, end: 0 });
        Ok(Frame { width: desc.width, height: desc.height, rows })
    }
}

/// The back buffer formats the copy converts (all four bytes a pixel).
#[derive(Clone, Copy)]
enum PixelFormat {
    Rgba8,
    Bgra8,
    Rgb10A2,
}

impl PixelFormat {
    fn of(format: u32) -> Option<Self> {
        match format {
            27..=32 => Some(Self::Rgba8),           // R8G8B8A8_{TYPELESS,UNORM,UNORM_SRGB,UINT,SNORM,SINT}
            87 | 88 | 90..=93 => Some(Self::Bgra8), // B8G8R8A8/X8 UNORM, TYPELESS, SRGB
            23 | 24 => Some(Self::Rgb10A2),         // R10G10B10A2_{TYPELESS,UNORM}
            _ => None,
        }
    }

    fn rgb(self, p: &[u8]) -> [u8; 3] {
        match self {
            Self::Rgba8 => [p[0], p[1], p[2]],
            Self::Bgra8 => [p[2], p[1], p[0]],
            Self::Rgb10A2 => {
                let v = u32::from_le_bytes([p[0], p[1], p[2], p[3]]);
                [((v & 0x3ff) >> 2) as u8, ((v >> 12) & 0xff) as u8, ((v >> 22) & 0xff) as u8]
            }
        }
    }
}

/* ------------------------------------------------------------------------------------------------
 * The request
 * ---------------------------------------------------------------------------------------------- */

/// Takes the next presented frame and writes it to `path` (a Windows path) as a PNG. Answers the size.
pub fn request(path: &str) -> Result<(u32, u32), RpcError> {
    if PRESENT.load(Ordering::Acquire) == 0 && PRESENT1.load(Ordering::Acquire) == 0 {
        return Err(RpcError::anchor(SITE_PRESENT));
    }
    while BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        win::sleep_ms(5);
    }
    let frame = next_frame();
    BUSY.store(false, Ordering::Release);
    let frame = frame?;
    let png = encode(&frame);
    write(path, &png)?;
    Ok((frame.width, frame.height))
}

/// Asks the frame thread for the next frame and waits for it.
fn next_frame() -> Result<Frame, RpcError> {
    *RESULT.lock() = None;
    REQUEST.store(WANTED, Ordering::Release);
    let deadline = win::tick_ms() + FRAME_WAIT_MS;
    loop {
        if REQUEST.load(Ordering::Acquire) == DONE {
            break;
        }
        if win::tick_ms() > deadline
            && REQUEST.compare_exchange(WANTED, IDLE, Ordering::AcqRel, Ordering::Acquire).is_ok()
        {
            return Err(RpcError::timeout().with_data(serde_json::json!({
                "message": "the game presented no frame within 3 s (minimized or not rendering)"
            })));
        }
        // A taken request always finishes: the copy has its own bound.
        win::sleep_ms(1);
    }
    let result = RESULT.lock().take();
    REQUEST.store(IDLE, Ordering::Release);
    match result {
        Some(Ok(frame)) => Ok(frame),
        Some(Err(reason)) => {
            log::fmt(format_args!("capture: {reason}"));
            Err(RpcError::command_failed(reason))
        }
        None => Err(RpcError::command_failed("the frame thread answered nothing")),
    }
}

/* ------------------------------------------------------------------------------------------------
 * PNG (stored deflate) and the file
 * ---------------------------------------------------------------------------------------------- */

const CRC_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
};

fn crc32(parts: &[&[u8]]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for part in parts {
        for byte in part.iter() {
            c = CRC_TABLE[((c ^ *byte as u32) & 0xff) as usize] ^ (c >> 8);
        }
    }
    c ^ 0xffff_ffff
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in data.chunks(5552) {
        for byte in chunk {
            a += *byte as u32;
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    (b << 16) | a
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32(&[kind, data]).to_be_bytes());
}

/// An 8-bit RGB PNG of `frame`, its scanlines in stored (uncompressed) deflate blocks.
fn encode(frame: &Frame) -> Vec<u8> {
    let raw = &frame.rows;
    let blocks = raw.len().div_ceil(65_535).max(1);
    let mut zlib = Vec::with_capacity(raw.len() + blocks * 5 + 6);
    zlib.extend_from_slice(&[0x78, 0x01]);
    let mut pieces = raw.chunks(65_535).peekable();
    if pieces.peek().is_none() {
        zlib.extend_from_slice(&[1, 0, 0, 0xff, 0xff]);
    }
    while let Some(piece) = pieces.next() {
        let last = pieces.peek().is_none();
        let len = piece.len() as u16;
        zlib.push(last as u8);
        zlib.extend_from_slice(&len.to_le_bytes());
        zlib.extend_from_slice(&(!len).to_le_bytes());
        zlib.extend_from_slice(piece);
    }
    zlib.extend_from_slice(&adler32(raw).to_be_bytes());

    let mut out = Vec::with_capacity(zlib.len() + 64);
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    let mut header = [0u8; 13];
    header[..4].copy_from_slice(&frame.width.to_be_bytes());
    header[4..8].copy_from_slice(&frame.height.to_be_bytes());
    header[8] = 8; // bit depth
    header[9] = 2; // RGB
    chunk(&mut out, b"IHDR", &header);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    out
}

const GENERIC_WRITE: u32 = 0x4000_0000;
const CREATE_ALWAYS: u32 = 2;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;

/// Writes `data` to `path`, replacing the file.
fn write(path: &str, data: &[u8]) -> Result<(), RpcError> {
    let wide = win::wide(path);
    let not_writable = || RpcError::standard(agent_core::engine::PATH_NOT_WRITABLE).with_data(serde_json::json!({ "path": path }));
    // SAFETY: `wide` is NUL-terminated; the handle is closed on every path below.
    let handle = unsafe {
        win::CreateFileW(wide.as_ptr(), GENERIC_WRITE, 0, core::ptr::null_mut::<c_void>(), CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0)
    };
    if handle == win::INVALID_HANDLE_VALUE || handle == 0 {
        return Err(not_writable());
    }
    let mut ok = true;
    for piece in data.chunks(1 << 24) {
        let mut wrote = 0u32;
        // SAFETY: `piece` is alive for the call; the handle is open for writing.
        if unsafe { win::WriteFile(handle, piece.as_ptr() as *const c_void, piece.len() as u32, &mut wrote, core::ptr::null_mut()) } == 0
            || wrote as usize != piece.len()
        {
            ok = false;
            break;
        }
    }
    // SAFETY: the handle came from `CreateFileW` above.
    unsafe {
        win::CloseHandle(handle);
    }
    if ok { Ok(()) } else { Err(not_writable()) }
}
