//! The seam between the agent machinery and one game build.
//!
//! An [`Engine`] resolves its own anchors, installs its own hooks, implements the methods that touch
//! the game and answers [`Engine::in_world`]. `agent-core` never learns a symbol, offset or string of
//! any particular build: everything build-specific lives in the crate that implements this trait, so
//! the public agent can serve any supported install without carrying game knowledge.

use alloc::string::String;
use alloc::vec::Vec;

use serde_json::Value;

use crate::Core;

/// One resolved address. `addr == 0` means the anchor is missing in this build.
#[derive(Clone, Copy, Debug)]
pub struct Anchor {
    pub name: &'static str,
    pub addr: usize,
}

/// Where a method runs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Thread {
    /// On the connection's thread. It may only read the agent's own state or store held input; it
    /// must never call game code.
    Socket,
    /// On the game's main thread, from [`Core::drain`], which the engine calls from its per-frame
    /// hook. The only place engine calls are safe.
    Main,
}

/// A JSON-RPC error, with the agent's own codes (see [`crate::error_message`]) plus an optional anchor
/// name and an optional `data` object for the wire.
#[derive(Clone, Debug)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    /// Anchor this failure blames, when it is a resolution failure; sent as `data.anchor`.
    pub anchor: Option<&'static str>,
    /// Extra `error.data` (the wire carries it verbatim).
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), anchor: None, data: None }
    }

    /// A standard error: the message comes from the agent's own table.
    pub fn standard(code: i32) -> Self {
        Self::new(code, crate::error_message(code))
    }

    /// `-32001 anchor not resolved`, with the anchor in `anchor` and `data`.
    pub fn anchor(anchor: &'static str) -> Self {
        Self { anchor: Some(anchor), ..Self::standard(ANCHOR_MISSING) }
    }

    /// `-32002 not_in_world`.
    pub fn not_in_world() -> Self {
        Self::standard(NOT_IN_WORLD)
    }

    /// `-32003 wrong_thread`.
    pub fn wrong_thread() -> Self {
        Self::standard(WRONG_THREAD)
    }

    /// `-32004 timeout`.
    pub fn timeout() -> Self {
        Self::standard(TIMEOUT)
    }

    /// `-32006 command failed`, with the engine's own message in `data`.
    pub fn command_failed(detail: impl Into<String>) -> Self {
        Self::standard(COMMAND_FAILED).with_data(serde_json::json!({ "message": detail.into() }))
    }

    /// `-32602 invalid params`, with the reason in `data`.
    pub fn invalid_params(reason: impl Into<String>) -> Self {
        Self::standard(INVALID_PARAMS).with_data(serde_json::json!({ "message": reason.into() }))
    }

    /// The internal deferral signal: [`Core::defer`] keeps the request open and this code never
    /// reaches the wire. A handler that needs more time returns `Err(RpcError::deferred())`.
    pub fn deferred() -> Self {
        Self::new(DEFERRED, "deferred")
    }

    /// Adds or replaces `data`.
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    /// The `error` object of a JSON-RPC response.
    pub fn to_json(&self) -> Value {
        let mut object = serde_json::Map::new();
        object.insert(String::from("code"), Value::from(self.code));
        object.insert(String::from("message"), Value::String(self.message.clone()));
        let data = match (&self.data, self.anchor) {
            (Some(data), Some(anchor)) => {
                let mut data = data.clone();
                if let Value::Object(map) = &mut data {
                    map.insert(String::from("anchor"), Value::String(String::from(anchor)));
                }
                Some(data)
            }
            (Some(data), None) => Some(data.clone()),
            (None, Some(anchor)) => Some(serde_json::json!({ "anchor": anchor })),
            (None, None) => None,
        };
        if let Some(data) = data {
            object.insert(String::from("data"), data);
        }
        Value::Object(object)
    }
}

/// A method handler. `Thread::Main` handlers get the deferred seam through [`Core::defer`].
pub type Handler = fn(core: &'static Core, params: &Value) -> Result<Value, RpcError>;

/// One method of the engine's table, dispatched by name.
#[derive(Clone, Copy)]
pub struct Method {
    pub name: &'static str,
    pub thread: Thread,
    pub handler: Handler,
}

impl Method {
    pub const fn socket(name: &'static str, handler: Handler) -> Self {
        Self { name, thread: Thread::Socket, handler }
    }

    pub const fn main(name: &'static str, handler: Handler) -> Self {
        Self { name, thread: Thread::Main, handler }
    }
}

/// One simulation tick, as the engine's per-tick hook sees it.
#[derive(Clone, Copy, Debug, Default)]
pub struct TickSample {
    pub tick: u64,
    pub position: [f32; 3],
    pub rotation: [f32; 2],
    pub velocity: [f32; 3],
    pub on_ground: Option<bool>,
    pub health: Option<f32>,
    pub selected_slot: Option<u8>,
}

impl TickSample {
    /// The `params` object of a `tick` notification, in the wire's field order.
    pub fn to_params(&self) -> Value {
        fn float(value: f32) -> Value {
            serde_json::Number::from_f64(value as f64).map(Value::Number).unwrap_or(Value::Null)
        }
        let mut object = serde_json::Map::new();
        object.insert(String::from("tick"), Value::from(self.tick));
        object.insert(String::from("position"), Value::Array(self.position.iter().map(|v| float(*v)).collect()));
        object.insert(String::from("rotation"), Value::Array(self.rotation.iter().map(|v| float(*v)).collect()));
        object.insert(String::from("velocity"), Value::Array(self.velocity.iter().map(|v| float(*v)).collect()));
        object.insert(
            String::from("onGround"),
            match self.on_ground {
                Some(value) => Value::Bool(value),
                None => Value::Null,
            },
        );
        object.insert(
            String::from("health"),
            match self.health {
                Some(value) => float(value),
                None => Value::Null,
            },
        );
        object.insert(
            String::from("selectedSlot"),
            match self.selected_slot {
                Some(value) => Value::from(value),
                None => Value::Null,
            },
        );
        Value::Object(object)
    }
}

/// The game side of the agent.
pub trait Engine: Sync + 'static {
    /// Build identity for `engine.status.build`, e.g. `"Minecraft.Windows.exe 1.26.63.0"`.
    fn build(&self) -> String;

    /// Resolve every anchor and install the engine's hooks. Runs once, on the attach thread, after
    /// `DllMain` has returned.
    ///
    /// The engine's per-frame main-thread hook must call [`Core::drain`], and its per-tick hook must
    /// call [`Core::tick`] — without them no request runs and the stream stays empty.
    fn attach(&'static self, core: &'static Core) -> Vec<Anchor>;

    /// The engine's RPC methods: `command`, `tick.pause`, `tick.step`, `tick.scale`, `screenshot`,
    /// `player.state`, `input.look`, `input.move`, `input.release`, `input.attack`, `input.use`.
    fn methods(&self) -> &'static [Method];

    /// The anchors as they are *now*: `agent-core` reports these instead of the list `attach` returned,
    /// so a pointer the engine recovered at runtime (a level's data, a command manager) stops being
    /// listed as missing the moment it resolves. The default keeps `attach`'s list.
    fn anchors(&self) -> Vec<Anchor> {
        Vec::new()
    }

    /// Extra `engine.status` fields only the engine can know (the game objects it sees, and their
    /// roles), merged into the status object. The default adds nothing.
    fn status(&self) -> Option<Value> {
        None
    }

    /// True while a world hosted by this process is loaded and its local player exists. Every method
    /// that acts on the game answers `-32002 not_in_world` when this is false, so the agent never
    /// drives a client connected to a remote server.
    fn in_world(&self) -> bool;

    /// Runs a command as the local player with its chat feedback suppressed, on the main thread.
    /// The input lock uses it for the camera gate and the action-bar badge.
    fn quiet_command(&'static self, core: &'static Core, line: &str) -> Result<(), RpcError>;

    /// Called on the main thread every frame while the lock is on: put back a view the agent did not
    /// set, and clear movement keys the agent did not press. Default no-op.
    fn lock_frame(&'static self, _core: &'static Core) {}

    /// Called once at the start of `agent.unload`, before any of this DLL's hooks are put back: an
    /// engine takes back what it installed itself — a `SetTimer` whose callback is this crate's code,
    /// parked work, its own subclass — because user32 would otherwise call into this image after it is
    /// freed, and a timer nobody kills is exactly what makes a hot reload crash instead of reload.
    /// Default: nothing to take back.
    fn detach(&'static self, _core: &'static Core) {}
}

/* Error codes. The agent's own range starts at -32001; the JSON-RPC ones are standard. */
pub const PARSE_ERROR: i32 = -32700;
pub const INVALID_REQUEST: i32 = -32600;
pub const UNKNOWN_METHOD: i32 = -32601;
pub const INVALID_PARAMS: i32 = -32602;
pub const INTERNAL_ERROR: i32 = -32603;
pub const ANCHOR_MISSING: i32 = -32001;
pub const NOT_IN_WORLD: i32 = -32002;
pub const WRONG_THREAD: i32 = -32003;
pub const TIMEOUT: i32 = -32004;
pub const COMMAND_FAILED: i32 = -32006;
pub const PATH_NOT_WRITABLE: i32 = -32007;
pub const SCRIPTING_UNAVAILABLE: i32 = -32014;

/// Internal: a handler kept its request open with [`Core::defer`]. Never sent on the wire.
pub const DEFERRED: i32 = -32010;

/// The error codes, re-exported under `agent_core::err` for engine crates.
pub mod err {
    pub use super::{
        ANCHOR_MISSING, COMMAND_FAILED, INVALID_PARAMS, INVALID_REQUEST, NOT_IN_WORLD, PARSE_ERROR,
        PATH_NOT_WRITABLE, SCRIPTING_UNAVAILABLE, TIMEOUT, UNKNOWN_METHOD, WRONG_THREAD, DEFERRED,
    };
}
