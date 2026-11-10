//! The global allocator: the process heap through `HeapAlloc`, since no CRT is linked.

use core::alloc::{GlobalAlloc, Layout};

use crate::win;

struct ProcessHeap;

// SAFETY: HeapAlloc/HeapFree/HeapReAlloc on the process heap are thread-safe and handle any
// alignment up to 16 bytes, which is what `Layout` asks for in practice; for a larger alignment the
// block is over-allocated and the original pointer is stored in front of it.
unsafe impl GlobalAlloc for ProcessHeap {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let heap = win::GetProcessHeap();
        if layout.align() <= 16 {
            return win::HeapAlloc(heap, 0, layout.size().max(1));
        }
        let total = layout.size() + layout.align() + core::mem::size_of::<usize>();
        let raw = win::HeapAlloc(heap, 0, total);
        if raw.is_null() {
            return raw;
        }
        let start = raw as usize + core::mem::size_of::<usize>();
        let aligned = (start + layout.align() - 1) & !(layout.align() - 1);
        (aligned as *mut usize).sub(1).write(raw as usize);
        aligned as *mut u8
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let heap = win::GetProcessHeap();
        if layout.align() <= 16 {
            win::HeapFree(heap, 0, ptr);
            return;
        }
        let raw = (ptr as *mut usize).sub(1).read() as *mut u8;
        win::HeapFree(heap, 0, raw);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if layout.align() > 16 {
            // Over-aligned blocks are re-allocated and copied; they are rare (none in this crate).
            let fresh = self.alloc(Layout::from_size_align_unchecked(new_size, layout.align()));
            if !fresh.is_null() {
                core::ptr::copy_nonoverlapping(ptr, fresh, layout.size().min(new_size));
                self.dealloc(ptr, layout);
            }
            return fresh;
        }
        win::HeapReAlloc(win::GetProcessHeap(), 0, ptr, new_size.max(1))
    }
}

#[global_allocator]
static ALLOCATOR: ProcessHeap = ProcessHeap;
