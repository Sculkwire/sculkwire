//! `sculkwire_agent.dll`: the in-game agent for the retail Minecraft: Bedrock Edition PC (GDK)
//! client.
//!
//! `DllMain` hands everything to [`agent_core::start`], which starts the socket server and the engine
//! attach on their own threads. [`Retail`] is the engine: it resolves its anchors from the loaded
//! image (`anchors`), hooks the game's frame and player-system functions (`hooks`), reads the local
//! player from the game's own ECS (`ecs`, `live`), and answers the wire's methods (`methods`).
//!
//! Everything the engine does is a *recipe*: the assert-metadata triple for the frame function, the
//! ECS component hash rule for the component lookups, a string reference for the command entry
//! points, a throwaway swap chain's vtable for the screenshot, and the option save tags for the
//! settings registry. Nothing in this crate knows an address of a particular build, and a recipe
//! that does not resolve uniquely leaves its anchor missing, which turns into `-32001 anchor not
//! resolved` on the wire — never a guess.

#![no_std]

extern crate alloc;

mod anchors;
mod capture;
mod command;
mod ecs;
mod hooks;
mod input;
mod inventory;
mod live;
mod look;
mod methods;
mod options;
mod pe;
mod recover;
mod route;
mod server;
mod text;
mod ui;
mod world;
mod workstation;

use alloc::string::String;
use alloc::vec::Vec;

use agent_core::engine::Method;
use agent_core::{win, Anchor, Core, Engine, RpcError};

use methods as m;

/// How long the frame thread waits for a quiet command to run on the server thread. The server steps
/// every 50 ms and the request is only queued while it is stepping, so this bounds a stall, not a wait.
/// (Quiet commands replay a real player command's origin, as `command` does: on 1.26.63.1 an origin
/// this crate built itself faulted inside the game's own lookup.)
const QUIET_TIMEOUT_MS: u32 = 1_000;

/// The RPC methods, in the order the TypeScript client expects them.
static METHODS: &[Method] = &[
    Method::main("command", m::command),
    Method::socket("command.prime", m::command_prime),
    Method::main("tick.pause", m::tick_pause),
    Method::main("tick.step", m::tick_step),
    Method::main("tick.scale", m::tick_scale),
    // The frame copy waits for the game's next `Present` (render thread), not for the main thread.
    Method::socket("screenshot", m::screenshot),
    // Input and the player's state go through the game's own window procedure and the client's
    // component registry, both of which belong to the game's thread.
    Method::main("player.state", input::h_player_state),
    Method::main("input.look", input::h_input_look),
    Method::main("input.move", input::h_input_move),
    Method::main("input.release", input::h_input_release),
    Method::main("input.attack", input::h_input_attack),
    Method::main("input.use", input::h_input_use),
    Method::main("settings.list", m::settings_list),
    Method::main("settings.get", m::settings_get),
    Method::main("settings.set", m::settings_set),
    // The game's UI, driven from inside the process (menus work without the keyboard route).
    Method::main("ui.screen", ui::h_screen),
    Method::main("ui.controls", ui::h_controls),
    Method::main("ui.press", ui::h_press),
    Method::main("ui.key", ui::h_key),
    Method::main("ui.text", ui::h_text),
    Method::main("ui.click", ui::h_click),
    Method::main("ui.scroll", ui::h_scroll),
    // The player's own components: attributes, the inventory and the container interface.
    Method::main("player.attributes", inventory::h_attributes),
    Method::main("player.inventory", inventory::h_inventory),
    Method::main("container.get", inventory::h_container_get),
    Method::main("container.open", workstation::h_container_open),
    Method::main("craft.match", inventory::h_craft_match),
    // Legacy on the wire (`screen.act {action:"craft"}` is the current route); kept for older clients.
    Method::main("craft.run", inventory::h_craft_run),
    // Interactable blocks and entities, and the screen they open.
    Method::main("interact.block", workstation::h_interact_block),
    Method::main("interact.entity", workstation::h_interact_entity),
    Method::main("screen.state", workstation::h_screen_state),
    Method::main("screen.move", workstation::h_screen_move),
    Method::main("screen.act", workstation::h_screen_act),
    Method::main("screen.close", workstation::h_screen_close),
    Method::main("world.settings", m::world_settings_read),
    Method::main("world.set", m::world_set),
    // Diagnosis only, and never in a release artifact: `debug.mem` reads this process's memory.
    #[cfg(feature = "debug-rpc")]
    Method::socket("debug.mem", m::debug_mem),
    #[cfg(feature = "debug-rpc")]
    Method::socket("debug.find", m::debug_find),
    #[cfg(feature = "debug-rpc")]
    Method::socket("debug.str", m::debug_str),
    #[cfg(feature = "debug-rpc")]
    Method::main("debug.sleep", m::debug_sleep),
    #[cfg(feature = "debug-rpc")]
    Method::main("debug.fault", m::debug_fault),
    #[cfg(feature = "debug-rpc")]
    Method::socket("debug.threads", m::debug_threads),
    #[cfg(feature = "debug-rpc")]
    Method::main("debug.hit", input::h_debug_hit),
];

struct Retail;

static ENGINE: Retail = Retail;

impl Engine for Retail {
    /// `"Minecraft.Windows.exe 1.26.63.0"`: the executable's own file name and `VS_FIXEDFILEINFO`.
    fn build(&self) -> String {
        let path = win::module_path(win::main_module());
        let name = file_name(&win::narrow(&path));
        match agent_core::hub::started().and_then(|core| pe::version(core.image())) {
            Some([major, minor, build, revision]) => alloc::format!("{name} {major}.{minor}.{build}.{revision}"),
            None => name,
        }
    }

    /// Resolves every anchor from the loaded image, then installs the hooks that make the agent live
    /// on the game's own threads.
    fn attach(&'static self, core: &'static Core) -> Vec<Anchor> {
        let image = core.image();
        agent_core::log::fmt(format_args!(
            "attach: image {} at 0x{:x}",
            image.size(),
            image.base()
        ));
        let mut anchors = anchors::resolve(image);
        // The screen/keyboard routes and the input module resolve their own anchors (today: the scene
        // name getter and the window, and nothing for `input`).
        anchors.extend(ui::resolve(core));
        anchors.extend(input::resolve(core));
        // After `anchors::resolve`: it hooks the entity-system runner to capture the client's context.
        anchors.extend(inventory::resolve(core));
        anchors.extend(workstation::resolve(core));
        anchors.extend(route::resolve(core));
        anchors.extend(capture::resolve(core));
        hooks::install();
        let missing = anchors.iter().filter(|anchor| anchor.addr == 0).count();
        agent_core::log::fmt(format_args!(
            "attach: {} anchors resolved, {} missing",
            anchors.len() - missing,
            missing
        ));
        anchors
    }

    fn methods(&self) -> &'static [Method] {
        METHODS
    }

    /// The anchors as they are now: a pointer recovered after attach (`level.data`, the command
    /// manager) is resolved from that moment, so `engine.status.missing` never lies about it.
    fn anchors(&self) -> Vec<Anchor> {
        let mut list = anchors::report();
        list.extend(ui::report());
        list.extend(input::report());
        list.extend(inventory::report());
        list.extend(workstation::report());
        list.extend(route::report());
        list.extend(capture::report());
        list
    }

    /// The game objects this process steps, with the role the engine proved for each.
    fn status(&self) -> Option<serde_json::Value> {
        Some(serde_json::json!({
            "minecraft": live::objects_json(),
            // The windows a UI request can be aimed at: the game window, its children and the hosted view
            // `ui.click` prefers. On a build whose OreUI buttons ignore the class procedure, this names
            // the window a click has to reach.
            "ui": ui::windows(),
        }))
    }

    fn in_world(&self) -> bool {
        live::in_world()
    }

    /// A command as the local player with its chat feedback suppressed: it runs on the server thread
    /// through the same queue, with the message hook dropping what the command body writes.
    fn quiet_command(&'static self, _core: &'static Core, line: &str) -> Result<(), RpcError> {
        let line = line.trim().trim_start_matches('/');
        if line.is_empty() {
            return Err(RpcError::invalid_params("command must not be empty"));
        }
        if line.contains('\n') || line.contains('\r') {
            return Err(RpcError::invalid_params("a command cannot contain a newline"));
        }
        if !live::in_world() {
            return Err(RpcError::not_in_world());
        }
        // The lock asks for this on the frame thread. During the load the command manager and the
        // origin it builds are not usable yet, and the game's own command path then faults inside the
        // origin's entity lookup: a quiet command is dropped instead of being attempted.
        if !live::settled() {
            return Err(RpcError::anchor("command.commands").with_data(serde_json::json!({
                "message": "the world is still loading; a quiet command is not attempted yet",
                "frames": live::steady_frames(),
                "wait_for": live::STEADY_FRAMES,
            })));
        }
        // Nothing to wait for when the command path is not resolved: answering now keeps the drain
        // (the window thread) from blocking for the queue's whole timeout.
        if live::commands_ready().is_none() {
            return Err(RpcError::anchor("command.commands"));
        }
        // No player command seen in this world yet: nothing to replay, so nothing is attempted. The
        // client primes one (`command.prime` and one chat line) when it turns the lock on.
        if !command::origin_ready() {
            return Err(RpcError::anchor("command.origin").with_data(serde_json::json!({
                "message": "no player command has been seen in this world yet; a quiet command is not attempted",
                "wait_for": "command.origin",
            })));
        }
        // The frame thread must never wait on a server that is not stepping (a paused single-player
        // world): the request would only time out with the frame held.
        if !live::server_stepping() {
            return Err(RpcError::anchor("sim.update").with_data(serde_json::json!({
                "message": "the server is not stepping; a quiet command is not attempted",
            })));
        }
        // The lock calls this from the frame thread; the server thread runs it, bounded.
        server::run(server::Request::Command { line: String::from(line), quiet: true }, QUIET_TIMEOUT_MS).map(|_| ())
    }

    /// The lock's camera gate and key clearing run from the tick (`live::observe`). Per frame, after
    /// the queue, no handler is running on this thread, so an item-registry scope still open here was
    /// left by a handler the game unwound past, and is closed.
    fn lock_frame(&'static self, core: &'static Core) {
        input::close_abandoned_scopes(usize::MAX);
        live::lock_frame(core)
    }

    /// The timers this engine installs carry this crate's code as their callback, so they are killed
    /// here: a `WM_TIMER` delivered after the image is freed would call into nothing. The hold the input
    /// keys were under, and a click's button still held down, are released at the same time.
    fn detach(&'static self, _core: &'static Core) {
        input::detach();
        workstation::detach();
        ui::detach();
    }
}

/// The file name of a path, with either separator.
fn file_name(path: &str) -> String {
    let tail = path.rsplit(|c| c == '\\' || c == '/').next().unwrap_or(path);
    if tail.is_empty() {
        String::from("Minecraft.Windows.exe")
    } else {
        String::from(tail)
    }
}

/// The DLL entry point. Nothing but the hand-off happens here: the loader lock is released as soon as
/// this returns.
#[no_mangle]
pub extern "system" fn DllMain(_module: usize, reason: u32, _reserved: usize) -> i32 {
    if reason == win::DLL_PROCESS_ATTACH {
        agent_core::start(&ENGINE);
    }
    1
}

/// The entry point the MSVC CRT would normally provide. Defined here because the build is
/// freestanding (`/nodefaultlib`); it forwards to `DllMain`, which is what the loader expects.
#[no_mangle]
pub extern "system" fn DllMainCRTStartup(module: usize, reason: u32, reserved: usize) -> i32 {
    DllMain(module, reason, reserved)
}

/// The same entry point under its decorated name, for linkers that look for the underscore form.
#[no_mangle]
pub extern "system" fn _DllMainCRTStartup(module: usize, reason: u32, reserved: usize) -> i32 {
    DllMain(module, reason, reserved)
}
