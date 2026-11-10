//! The socket server: newline-delimited JSON-RPC 2.0 on `127.0.0.1:<port>`, one request per line and
//! one response per line.
//!
//! Up to eight connections, each with its own thread; a ninth is refused by closing the socket. Three
//! kinds of method:
//!
//! * core methods (`ping`, `info`, `modules`, `engine.status`, `engine.resolve`, `input.lock`,
//!   `input.focus`, `stream.*`) handled here;
//! * socket-thread engine methods, which may only read agent state or store held input;
//! * main-thread engine methods, queued through [`crate::queue`] and run by the game's own thread.
//!
//! The stream thread sends tick notifications from the ring and a `lock` notification whenever the
//! lock state changes, so no game thread ever waits on a socket.

use core::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};

use alloc::string::String;
use alloc::vec::Vec;
use serde_json::{json, Value};

use crate::engine::{RpcError, Thread, UNKNOWN_METHOD};
use crate::queue;
use crate::sync::SpinLock;
use crate::{error_message, lock, log, stream, win};

/// Connections served at once, matching `agent.c`'s `MAX_CONN`.
const MAX_CONN: usize = 8;
/// Longest request line; a longer line is dropped.
const MAX_LINE: usize = 8192;
/// Read chunk.
const CHUNK: usize = 1024;

const NO_SOCKET: usize = usize::MAX;
/// The listening socket, 0 until `serve` bound it: `stop` closes it to release the port.
static LISTENER: AtomicUsize = AtomicUsize::new(0);
/// The port `serve` actually bound, 0 while it has none. Reported by `engine.status` and `info`, so a
/// hot reload that could not take the expected port says which one it took.
static BOUND: AtomicU32 = AtomicU32::new(0);
/// How long a fresh agent retries the port it was asked for before it settles for the next free one.
/// A predecessor's unload releases it within a second or two, and the host only ever dials the first.
const PORT_RETRY_MS: u32 = 3_000;
/// `WSAEWOULDBLOCK`: the non-blocking `accept` found nothing.
const WSAEWOULDBLOCK: i32 = 10035;

/// The port this agent listens on, 0 while it is not listening.
pub fn bound_port() -> u16 {
    BOUND.load(Ordering::Acquire) as u16
}

/// Stops the server for an unload: no new connections, and every open connection's socket is closed
/// so its thread's `recv` returns and the thread leaves. Idempotent.
pub fn stop() {
    let listener = LISTENER.swap(NO_SOCKET, Ordering::AcqRel);
    BOUND.store(0, Ordering::Release);
    if listener != NO_SOCKET && listener != 0 {
        // The listener is non-blocking, so no thread is inside `accept` on it; shut it down anyway so a
        // pending connection is refused rather than left half-accepted, then close it.
        // SAFETY: the listener is a socket this module bound and no longer uses.
        unsafe {
            win::shutdown(listener, 2);
            win::closesocket(listener);
        }
    }
    for conn in &CONNS {
        let socket = conn.socket.swap(NO_SOCKET, Ordering::AcqRel);
        if socket != NO_SOCKET {
            // SAFETY: each socket is closed once, by the swap above.
            unsafe {
                win::shutdown(socket, 2);
                win::closesocket(socket);
            }
        }
    }
}

struct Conn {
    used: AtomicBool,
    socket: AtomicUsize,
    /// Held while a line is written, so responses and notifications never interleave.
    send: SpinLock<()>,
    subscribed: AtomicBool,
    every: AtomicU32,
    cursor: AtomicU32,
}

impl Conn {
    const fn new() -> Self {
        Self {
            used: AtomicBool::new(false),
            socket: AtomicUsize::new(NO_SOCKET),
            send: SpinLock::new(()),
            subscribed: AtomicBool::new(false),
            every: AtomicU32::new(1),
            cursor: AtomicU32::new(0),
        }
    }
}

static CONNS: [Conn; MAX_CONN] = [const { Conn::new() }; MAX_CONN];

/* ------------------------------------------------------------------------------------------------
 * Sending
 * ---------------------------------------------------------------------------------------------- */

/// How long a send waits for a full socket buffer to drain before the line is given up.
const SEND_STALL_MS: u32 = 2_000;

fn send_all(socket: usize, bytes: &[u8]) {
    let mut sent = 0usize;
    let mut stalled = 0u32;
    while sent < bytes.len() {
        // SAFETY: `socket` is a connected socket owned by this process.
        let written = unsafe {
            win::send(
                socket,
                bytes[sent..].as_ptr(),
                (bytes.len() - sent).min(i32::MAX as usize) as i32,
                0,
            )
        };
        if written > 0 {
            sent += written as usize;
            stalled = 0;
            continue;
        }
        // The socket is non-blocking (inherited from the listener): a full send buffer answers
        // `WSAEWOULDBLOCK`, and dropping the rest would cut the line in half for the client.
        // SAFETY: reading the socket error, no invariants.
        if written < 0 && unsafe { win::WSAGetLastError() } == WSAEWOULDBLOCK && stalled < SEND_STALL_MS {
            win::sleep_ms(1);
            stalled += 1;
            continue;
        }
        break;
    }
}

/// Writes one whole line to a connection.
fn conn_send(conn: &Conn, line: &[u8]) {
    let _guard = conn.send.lock();
    let socket = conn.socket.load(Ordering::Acquire);
    if socket == NO_SOCKET {
        return;
    }
    send_all(socket, line);
    send_all(socket, b"\n");
}

fn broadcast(line: &[u8]) {
    for conn in &CONNS {
        if conn.used.load(Ordering::Acquire) {
            conn_send(conn, line);
        }
    }
}

/* ------------------------------------------------------------------------------------------------
 * Server
 * ---------------------------------------------------------------------------------------------- */

/// The listen port: `SCULKWIRE_AGENT_PORT`, then 19160.
fn port() -> u16 {
    let text = win::env("SCULKWIRE_AGENT_PORT");
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return 19160;
    }
    match text.parse::<u32>() {
        Ok(value) if (1..=65535).contains(&value) => value as u16,
        _ => 19160,
    }
}

fn sockaddr(port: u16) -> win::SockAddrIn {
    win::SockAddrIn {
        family: win::AF_INET as i16,
        port: port.to_be(),
        addr: win::INADDR_LOOPBACK,
        zero: [0; 8],
    }
}

/// The socket server thread: binds, then accepts connections forever.
pub extern "system" fn serve(_arg: usize) -> u32 {
    let mut data = win::WsaData::default();
    // SAFETY: `data` is a valid WSADATA; version 2.2 is the only one requested.
    if unsafe { win::WSAStartup(0x0202, &mut data) } != 0 {
        log::line("error: WSAStartup failed");
        return 1;
    }
    // SAFETY: a TCP socket; the handle is owned here.
    let listener = unsafe { win::socket(win::AF_INET, win::SOCK_STREAM, 0) };
    if listener == NO_SOCKET {
        // SAFETY: reading the socket error, no invariants.
        log::fmt(format_args!("error: socket() failed, wsa={}", unsafe { win::WSAGetLastError() }));
        return 2;
    }

    // The port is process-wide and a hot reload shares it with the agent it replaces: retry the port the
    // host dials for a few seconds, because the predecessor releases it as its own unload finishes.
    // Only then settle for the next free one, loudly — the host does not know about that port.
    let first = port();
    let mut bound = 0u16;
    let mut waited = 0u32;
    loop {
        let address = sockaddr(first);
        // SAFETY: the address structure and its length agree; SOCKADDR_IN is 16 bytes.
        let result = unsafe {
            win::bind(listener, &address as *const win::SockAddrIn as *const u8, core::mem::size_of::<win::SockAddrIn>() as i32)
        };
        if result == 0 {
            bound = first;
            break;
        }
        if waited == 0 {
            // SAFETY: reading the socket error, no invariants.
            let error = unsafe { win::WSAGetLastError() };
            log::fmt(format_args!("port {first} is taken (wsa={error}); retrying for up to {PORT_RETRY_MS} ms"));
        }
        if waited >= PORT_RETRY_MS {
            break;
        }
        win::sleep_ms(100);
        waited += 100;
    }
    if bound == 0 {
        let mut candidate = first.saturating_add(1);
        while candidate < first.saturating_add(10) {
            let address = sockaddr(candidate);
            // SAFETY: as above.
            let result = unsafe {
                win::bind(listener, &address as *const win::SockAddrIn as *const u8, core::mem::size_of::<win::SockAddrIn>() as i32)
            };
            if result == 0 {
                bound = candidate;
                break;
            }
            candidate += 1;
        }
    }
    if bound == 0 {
        // SAFETY: reading the socket error, no invariants.
        log::fmt(format_args!("error: bind failed, wsa={}", unsafe { win::WSAGetLastError() }));
        return 3;
    }
    if bound != first {
        log::fmt(format_args!(
            "WARNING: listening on port {bound}, not {first}: another agent in this process still holds {first} \
             after {PORT_RETRY_MS} ms, so the host's connection to {first} cannot reach this agent"
        ));
    }
    // SAFETY: a bound listening socket.
    if unsafe { win::listen(listener, MAX_CONN as i32) } != 0 {
        // SAFETY: reading the socket error, no invariants.
        log::fmt(format_args!("error: listen failed, wsa={}", unsafe { win::WSAGetLastError() }));
        return 4;
    }
    log::fmt(format_args!("listening on 127.0.0.1 port {bound}"));
    LISTENER.store(listener, Ordering::Release);
    BOUND.store(bound as u32, Ordering::Release);

    // Non-blocking: `closesocket` from another thread does not reliably interrupt a pending `accept`, and
    // an unload that cannot get its thread back never releases the port for the next agent.
    let mut nonblocking: u32 = 1;
    // SAFETY: the socket is ours and the flag word is a `u_long`-sized value.
    let changed = unsafe { win::ioctlsocket(listener, win::FIONBIO, &mut nonblocking) };
    if changed != 0 {
        log::fmt(format_args!("warning: the listener stays blocking (ioctlsocket wsa={})", unsafe {
            win::WSAGetLastError()
        }));
    }

    crate::thread::spawn("stream", stream_thread, 0);

    loop {
        if crate::hub::started().is_some_and(|core| core.stopping()) || LISTENER.load(Ordering::Acquire) != listener {
            break;
        }
        // SAFETY: accepting on the listening socket; no address buffer.
        let socket = unsafe { win::accept(listener, core::ptr::null_mut(), core::ptr::null_mut()) };
        if socket == NO_SOCKET {
            // SAFETY: reading the socket error, no invariants.
            let error = unsafe { win::WSAGetLastError() };
            if error == WSAEWOULDBLOCK {
                // Nothing pending: give the CPU back and look at the stop flag again.
                win::sleep_ms(20);
                continue;
            }
            if crate::hub::started().is_some_and(|core| core.stopping()) {
                break;
            }
            win::sleep_ms(20);
            continue;
        }
        let mut slot = MAX_CONN;
        for index in 0..MAX_CONN {
            if CONNS[index].used.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                slot = index;
                break;
            }
        }
        if slot == MAX_CONN {
            // SAFETY: a socket this call owns; closing it refuses the connection.
            unsafe {
                win::closesocket(socket);
            }
            continue;
        }
        let conn = &CONNS[slot];
        conn.socket.store(socket, Ordering::Release);
        conn.subscribed.store(false, Ordering::Release);
        conn.every.store(1, Ordering::Release);
        conn.cursor.store(0, Ordering::Release);
        if !crate::thread::spawn("connection", connection_thread, slot) {
            // SAFETY: the socket was never handed to a thread.
            unsafe {
                win::closesocket(socket);
            }
            conn.socket.store(NO_SOCKET, Ordering::Release);
            conn.used.store(false, Ordering::Release);
        }
    }
    log::line("serve: stopped");
    0
}

/// One connection: reads lines, answers them, and releases its lock bit when it goes away.
pub extern "system" fn connection_thread(slot: usize) -> u32 {
    let conn = &CONNS[slot];
    let mut line: Vec<u8> = Vec::with_capacity(MAX_LINE);
    let mut chunk = [0u8; CHUNK];
    loop {
        // SAFETY: reading from a connected socket this thread owns; the buffer and length agree.
        if crate::hub::started().is_some_and(|core| core.stopping()) {
            break;
        }
        let got = unsafe { win::recv(conn.socket.load(Ordering::Acquire), chunk.as_mut_ptr(), CHUNK as i32, 0) };
        if got < 0 {
            // An accepted socket inherits the listener's non-blocking mode, so an idle connection answers
            // `WSAEWOULDBLOCK` between requests: wait for the next line (and keep seeing the stop flag)
            // instead of treating it as a closed connection.
            // SAFETY: reading the socket error, no invariants.
            if unsafe { win::WSAGetLastError() } == WSAEWOULDBLOCK {
                win::sleep_ms(2);
                continue;
            }
            break;
        }
        if got == 0 {
            break;
        }
        for byte in &chunk[..got as usize] {
            match *byte {
                b'\n' => {
                    if !line.is_empty() {
                        serve_line(slot, conn, &line);
                        line.clear();
                    }
                }
                b'\r' => {}
                byte if line.len() < MAX_LINE - 1 => line.push(byte),
                _ => line.clear(),
            }
        }
    }
    lock::connection_closed(slot);
    {
        let _guard = conn.send.lock();
        if conn.subscribed.swap(false, Ordering::AcqRel) {
            stream::unsubscribe();
        }
        let socket = conn.socket.swap(NO_SOCKET, Ordering::AcqRel);
        if socket != NO_SOCKET {
            // SAFETY: the socket is owned by this connection and no other thread sends now.
            unsafe {
                win::closesocket(socket);
            }
        }
    }
    conn.used.store(false, Ordering::Release);
    0
}

/// The stream thread: `lock` notifications on every state change and `tick` lines from the ring.
pub extern "system" fn stream_thread(_arg: usize) -> u32 {
    let mut last_lock = lock::sequence();
    let mut buffer = [0u8; stream::LINE];
    loop {
        win::sleep_ms(1);
        if crate::hub::started().is_some_and(|core| core.stopping()) {
            break;
        }

        let sequence = lock::sequence();
        if sequence != last_lock {
            last_lock = sequence;
            let notification = json!({
                "jsonrpc": "2.0",
                "method": "lock",
                "params": crate::hub::instance().lock_state(),
            });
            if let Ok(text) = serde_json::to_string(&notification) {
                broadcast(text.as_bytes());
            }
        }

        if stream::subscribers() == 0 {
            continue;
        }
        let head = stream::head();
        for conn in &CONNS {
            if !conn.used.load(Ordering::Acquire) || !conn.subscribed.load(Ordering::Acquire) {
                continue;
            }
            let mut cursor = conn.cursor.load(Ordering::Relaxed);
            if head.wrapping_sub(cursor) > stream::RING - 8 {
                // The client is too slow: drop the oldest lines instead of stalling the game.
                cursor = head.wrapping_sub(stream::RING - 8);
            }
            let every = conn.every.load(Ordering::Relaxed).max(1);
            while cursor != head {
                let Some((tick, len)) = stream::read(cursor, &mut buffer) else {
                    cursor = cursor.wrapping_add(1);
                    continue;
                };
                cursor = cursor.wrapping_add(1);
                if every > 1 && tick % every != 0 {
                    continue;
                }
                conn_send(conn, &buffer[..len]);
            }
            conn.cursor.store(cursor, Ordering::Relaxed);
        }
    }
    log::line("stream: stopped");
    0
}

/* ------------------------------------------------------------------------------------------------
 * Dispatch
 * ---------------------------------------------------------------------------------------------- */

/// Answers one request line.
fn serve_line(slot: usize, conn: &Conn, line: &[u8]) {
    let request: Value = match serde_json::from_slice(line) {
        Ok(value) => value,
        Err(_) => {
            let response = error_response(&Value::Null, RpcError::new(crate::engine::PARSE_ERROR, error_message(crate::engine::PARSE_ERROR)));
            conn_send(conn, &response);
            return;
        }
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        let response = error_response(&id, RpcError::new(crate::engine::INVALID_REQUEST, error_message(crate::engine::INVALID_REQUEST)));
        conn_send(conn, &response);
        return;
    };
    let empty = Value::Object(serde_json::Map::new());
    let params = request.get("params").unwrap_or(&empty);

    let result = dispatch(slot, conn, method, params);
    let response = match result {
        Ok(value) => success_response(&id, value),
        Err(error) => error_response(&id, error),
    };
    conn_send(conn, &response);
}

fn dispatch(slot: usize, conn: &Conn, method: &str, params: &Value) -> Result<Value, RpcError> {
    if method != "agent.unload" && crate::hub::started().is_some_and(|core| core.stopping()) {
        return Err(RpcError::new(UNKNOWN_METHOD, "the agent is unloading"));
    }
    match method {
        "ping" => return Ok(Value::String(String::from("pong"))),
        "info" => return Ok(info()),
        "modules" => return Ok(modules()),
        "engine.status" | "engine.resolve" => return Ok(crate::hub::instance().status()),
        "input.lock" => return lock::request(slot, params),
        "input.focus" => return lock::focus(params).and_then(|_| Ok(crate::hub::instance().lock_state())),
        "debug.focus" => return debug_focus(),
        "agent.unload" => return crate::unload::request(),
        "stream.subscribe" => return subscribe(conn, params),
        "stream.unsubscribe" => return unsubscribe(conn),
        _ => {}
    }

    let core = crate::hub::instance();
    let Some(entry) = core.engine().methods().iter().find(|entry| entry.name == method) else {
        return Err(RpcError::new(UNKNOWN_METHOD, error_message(UNKNOWN_METHOD)));
    };
    match entry.thread {
        Thread::Socket => (entry.handler)(core, params),
        Thread::Main => {
            let Some(pending) = queue::submit(entry.name, params.clone()) else {
                return Err(RpcError::timeout());
            };
            pending.wait(queue::timeout_for(entry.name))
        }
    }
}

/// `debug.focus`: posts the three messages Windows sends a window that loses focus, through the lock,
/// so the focus-suppression path can be exercised without a desktop focus change. Test hook only.
fn debug_focus() -> Result<Value, RpcError> {
    if lock::post_focus_loss() {
        Ok(json!({ "posted": 3 }))
    } else {
        Err(RpcError::not_in_world())
    }
}

fn subscribe(conn: &Conn, params: &Value) -> Result<Value, RpcError> {
    let every = params.get("every").and_then(Value::as_u64).unwrap_or(1);
    if !(1..=1200).contains(&every) {
        return Err(RpcError::invalid_params("every must be 1..1200"));
    }
    conn.every.store(every as u32, Ordering::Release);
    conn.cursor.store(stream::head(), Ordering::Release);
    if !conn.subscribed.swap(true, Ordering::AcqRel) {
        stream::subscribe();
    }
    Ok(json!({ "ok": true, "every": every }))
}

fn unsubscribe(conn: &Conn) -> Result<Value, RpcError> {
    if conn.subscribed.swap(false, Ordering::AcqRel) {
        stream::unsubscribe();
    }
    Ok(json!({ "ok": true }))
}

/// `info`: process, executable, image and agent version.
fn info() -> Value {
    let path = win::module_path(win::main_module());
    let image = crate::hub::instance().image();
    json!({
        "pid": win::current_process_id(),
        "exe": win::narrow(&path),
        "imageBase": alloc::format!("0x{:x}", image.base()),
        "imageSize": image.size(),
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/// `modules`: every module of this process.
fn modules() -> Value {
    let mut out = Vec::new();
    // SAFETY: the snapshot handle is owned here and closed below.
    let snapshot = unsafe {
        win::CreateToolhelp32Snapshot(
            win::TH32CS_SNAPMODULE | win::TH32CS_SNAPMODULE32,
            win::current_process_id(),
        )
    };
    if snapshot != win::INVALID_HANDLE_VALUE && snapshot != 0 {
        let mut entry = win::ModuleEntry32W::default();
        entry.size = core::mem::size_of::<win::ModuleEntry32W>() as u32;
        // SAFETY: the entry is valid for the call.
        if unsafe { win::Module32FirstW(snapshot, &mut entry) } != 0 {
            loop {
                out.push(json!({
                    "name": win::narrow(&entry.name),
                    "base": alloc::format!("0x{:x}", entry.base as usize),
                    "size": entry.base_size,
                }));
                // SAFETY: the entry is valid for the call.
                if unsafe { win::Module32NextW(snapshot, &mut entry) } == 0 {
                    break;
                }
            }
        }
        // SAFETY: the handle was created above.
        unsafe {
            win::CloseHandle(snapshot);
        }
    }
    Value::Array(out)
}

/* ------------------------------------------------------------------------------------------------
 * Response shapes
 * ---------------------------------------------------------------------------------------------- */

pub fn success_response(id: &Value, result: Value) -> Vec<u8> {
    let response = json!({ "jsonrpc": "2.0", "id": id, "result": result });
    to_line(&response)
}

pub fn error_response(id: &Value, error: RpcError) -> Vec<u8> {
    let message = match error.code {
        // The agent's own codes have fixed messages, like agent.c's table; details travel in `data`.
        crate::engine::ANCHOR_MISSING
        | crate::engine::NOT_IN_WORLD
        | crate::engine::WRONG_THREAD
        | crate::engine::TIMEOUT
        | crate::engine::COMMAND_FAILED
        | crate::engine::PATH_NOT_WRITABLE
        | crate::engine::SCRIPTING_UNAVAILABLE
        | crate::engine::UNKNOWN_METHOD
        | crate::engine::INVALID_PARAMS
        | crate::engine::INVALID_REQUEST
        | crate::engine::PARSE_ERROR
        | crate::engine::INTERNAL_ERROR => String::from(error_message(error.code)),
        _ => error.message.clone(),
    };
    let mut payload = json!({ "code": error.code, "message": message });
    // Details travel in `data`: the handler's own data, else the detailed message; the missing anchor's name is
    // always added, so a client can say which piece of the engine was not found.
    let mut data = error.data.or_else(|| {
        if error.message != message {
            Some(json!({ "message": error.message }))
        } else {
            None
        }
    });
    if let Some(anchor) = error.anchor {
        match data.as_mut() {
            Some(Value::Object(object)) => {
                object.entry("anchor").or_insert_with(|| json!(anchor));
            }
            Some(_) => {}
            None => data = Some(json!({ "anchor": anchor })),
        }
    }
    if let Some(data) = data {
        payload["data"] = data;
    }
    let response = json!({ "jsonrpc": "2.0", "id": id, "error": payload });
    to_line(&response)
}

fn to_line(value: &Value) -> Vec<u8> {
    match serde_json::to_string(value) {
        Ok(text) => text.into_bytes(),
        Err(_) => Vec::from(&b"{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"internal error\"}}"[..]),
    }
}
