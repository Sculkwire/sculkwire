//! `sculkwire-agent.log`, written next to the DLL.
//!
//! The log is the only channel that survives a crash or an attach that resolved nothing, so it is
//! opened per line and never held open: a game that dies mid-write still leaves the earlier lines.
//! Lines carry the process tick count, which is what makes a frozen attach readable afterwards.

use alloc::vec::Vec;
use core::fmt::{self, Write};

use crate::sync::SpinLock;
use crate::win;

const LOG_NAME: &str = "sculkwire-agent.log";

/// The log file's full path, UTF-16 and NUL-terminated. Empty until [`init`].
static PATH: SpinLock<Vec<u16>> = SpinLock::new(Vec::new());

/// Points the log at `sculkwire-agent.log` beside `module` (this DLL).
pub fn init(module: win::Hmodule) {
    let mut path = win::module_path(module);
    if path.is_empty() {
        return;
    }
    // Replace the file name after the last separator with the log's.
    let cut = path
        .iter()
        .rposition(|c| *c == u16::from(b'\\') || *c == u16::from(b'/'))
        .map(|index| index + 1)
        .unwrap_or(0);
    path.truncate(cut);
    path.extend(LOG_NAME.encode_utf16());
    path.push(0);
    *PATH.lock() = path;
}

/// Appends one line, with a trailing newline.
pub fn line(text: &str) {
    let path = PATH.lock().clone();
    if path.is_empty() {
        return;
    }
    let mut bytes = Vec::with_capacity(text.len() + 32);
    push_u64(&mut bytes, win::tick_ms());
    bytes.extend_from_slice(b" ");
    bytes.extend_from_slice(text.as_bytes());
    bytes.push(b'\n');

    // SAFETY: `path` is NUL-terminated and owned for the call; the handle is closed below.
    unsafe {
        let handle = win::CreateFileW(
            path.as_ptr(),
            win::FILE_APPEND_DATA,
            win::FILE_SHARE_READ_WRITE,
            core::ptr::null_mut(),
            win::OPEN_ALWAYS,
            win::FILE_ATTRIBUTE_NORMAL,
            0,
        );
        if handle == win::INVALID_HANDLE_VALUE || handle == 0 {
            return;
        }
        let mut wrote = 0u32;
        win::SetFilePointer(handle, 0, core::ptr::null_mut(), win::FILE_END);
        win::WriteFile(handle, bytes.as_ptr().cast(), bytes.len() as u32, &mut wrote, core::ptr::null_mut());
        win::CloseHandle(handle);
    }
}

/// Appends one formatted line. Arguments are truncated at 480 bytes: a log line is diagnostic, not a
/// data channel.
pub fn fmt(args: fmt::Arguments<'_>) {
    let mut buffer = Line::default();
    let _ = buffer.write_fmt(args);
    line(buffer.as_str());
}

fn push_u64(out: &mut Vec<u8>, mut value: u64) {
    let mut digits = [0u8; 20];
    let mut n = 0;
    if value == 0 {
        out.push(b'0');
        return;
    }
    while value > 0 {
        digits[n] = b'0' + (value % 10) as u8;
        value /= 10;
        n += 1;
    }
    while n > 0 {
        n -= 1;
        out.push(digits[n]);
    }
}

/// A fixed-size UTF-8 line buffer.
struct Line {
    bytes: [u8; 480],
    len: usize,
}

impl Default for Line {
    fn default() -> Self {
        Self { bytes: [0; 480], len: 0 }
    }
}

impl Line {
    fn as_str(&self) -> &str {
        core::str::from_utf8(&self.bytes[..self.len]).unwrap_or("<invalid utf-8>")
    }
}

impl Write for Line {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        let room = self.bytes.len() - self.len;
        let take = text.len().min(room);
        self.bytes[self.len..self.len + take].copy_from_slice(&text.as_bytes()[..take]);
        self.len += take;
        Ok(())
    }
}
