# In-Game Agent

The in-game agent is a small DLL that sculkwire loads into a running Minecraft Bedrock client. It serves JSON-RPC on `127.0.0.1`, runs the requests that touch the game on the game's main thread, and lets sculkwire read the game instead of the screen: commands go through the game's own command dispatcher, player state comes from the level, and one frame's picture is a copy of the frame the game presents. The same DLL holds the input lock (`game_input_lock`), which keeps your keyboard and mouse out of the game while sculkwire plays through the engine.

With the agent attached, `player_act` and `sculk bench` use the engine route through sculkwire's in-process input provider; without it they use the keyboard. See [Extensions](extensions.md#input-provider) for the provider seam and [Extensions](extensions.md#agent-source) for supplying another DLL.

| Command | What it does |
|---|---|
| `sculk engine attach` | Build, inject, connect and verify (`engine_attach`) |
| `sculk engine status` | Build identity, hook state, tick, resolved and missing anchors (`engine_status`) |
| `sculk engine command "<line>"` | Run a command as the local player (`engine_command`) |
| `sculk engine tick --pause\|--resume\|--step N\|--scale X` | Control game time (`engine_tick`) |
| `sculk engine screenshot [path]` | PNG of the current frame (`engine_screenshot`) |
| `sculk engine player` | Local player position and rotation (`engine_player`) |
| `sculk game lock [on\|off\|auto]` | Input lock; no argument prints the state (`game_input_lock`) |
| `sculk game settings [list\|get <id>\|set <id> <value>] [--filter x]` | The game's own options (`game_settings`) |
| `sculk world settings [get\|set ...] [--world name]` | Game rules, difficulty, game type, time, weather (`world_settings`) |
| `sculk game ui [screen\|controls [filter]\|press <name>\|key <key> [--action down\|up]\|text <text>\|click <x> <y> [--button right]\|scroll <x> <y> <delta>]` | Menus and screens, through the game's own UI (`game_ui`) |
| `sculk player inventory` | Attributes and the whole inventory, through the agent or the helper pack (`player_inventory`) |
| `sculk container get <x> <y> <z> [--dimension overworld\|nether\|the_end]` | What a block's container holds (`container`); the dimension also takes `minecraft:nether` or 0, 1, 2 |
| `sculk craft match --grid "oak_log,-,-;…"\|--ingredients a,b [--table]`, `sculk craft run <recipe> [--times N]` | The game's own recipe lookup, and crafting through it (`craft`; `run` is `screen act craft`) |
| `sculk interact block <x> <y> <z> [--dimension overworld\|nether\|the_end] [--face up]`, `sculk interact entity <id>` | Use a block or an entity like a right click and say what opened (`interact`) |
| `sculk screen state`, `sculk screen move <container:slot> <container:slot> [--count N]`, `sculk screen act <action> [--recipe id\|index] [--times N] [--name text] [--pattern id] [--option 0\|1\|2] [--offer N] [--primary effect] [--secondary effect]`, `sculk screen close` | The open screen: its containers, moving items, its own action, closing it (`screen`) |

Every command prints JSON on stdout and its hints on stderr. Exit codes are the shared ones: 0 success, 1 the agent reported a failure, 2 usage or a missing prerequisite. The MCP tools are listed in the [tool reference](tools.md#engine).

```sh
sculk engine attach
sculk engine command "time set noon"
sculk engine tick --step 20
sculk engine player
sculk game settings set gfx_viewdistance 12
sculk world settings set --weather rain --gamerule keepinventory=true
```

## Requirements

| Need | Linux | Windows | For |
|---|---|---|---|
| A PC (GDK) install of the game, already running | A Wine or Proton install sculkwire detects: Flarial, mcbe-gdk-installer, Bottles, Lutris, Steam | A native install: the Microsoft Store or Xbox app copy, or a folder named by `SCULKWIRE_GAME_DIR` | Injection |
| The install's own Wine | Found next to the install's prefix (`proton/<engine>` or `engine/<engine>`); `SCULKWIRE_WINE` overrides it | Not used | Running the injector |
| `cargo`, when you build the DLL yourself | `cargo` on `PATH`, else `~/.cargo/bin/cargo` | Same | Building `native/` |
| `rustup target add x86_64-pc-windows-msvc` | Once per rustup toolchain | Same | Building `native/` |

Nothing else is needed to build: the workspace links with rustup's `rust-lld` and declares its Win32 imports with `raw-dylib`, so a Windows SDK, MSVC or mingw is not required on either host. Without `cargo` at all, the prebuilt DLL is downloaded instead, and no build tool is needed.

```sh
rustup target add x86_64-pc-windows-msvc   # once per toolchain, on Linux and Windows alike
```

Without rustup, install it from [rustup.rs](https://rustup.rs) first; `~/.cargo/bin/cargo` is found even when that folder is not on `PATH`.

The agent is injected into the game's Windows process, so the route has to match the host: a Wine or Proton install is supported off Windows, and a native install only on Windows. An install of the other kind is rejected before anything is built or injected.

The game must be running before `engine_attach`, because the injector finds it by executable name (`Minecraft.Windows.exe`). Start it from the install sculkwire uses, or set `SCULKWIRE_CLIENT` when several installs are present.

## Attach Flow

1. sculkwire finds the install (`src/runtime/client/install.ts`) and checks that its kind matches this OS, then resolves the game folder that holds `Minecraft.Windows.exe`.
2. The DLL and the injector are built or downloaded, once per source version (`build.ts`).
3. The injector loads the DLL into the running `Minecraft.Windows.exe` and prints `OK <pid>`.
4. sculkwire connects to `127.0.0.1:19160`, retrying while the DLL's listener thread starts, and reads `engine.status`.

Repeat calls reuse the loaded agent: a connected session only refreshes its status, so the common path never recompiles or re-injects. A game that restarted needs a new attach, and a rebuilt DLL takes effect after the game restarts, because Windows does not run `DllMain` again for a DLL path that is already loaded. The build is therefore copied to a file name carrying a hash of its sources.

### Linux and macOS

The game is a Windows process inside the install's Wine or Proton prefix, so the injector runs with that prefix's Wine:

- The prefix is the directory the game runs in: `<prefix>/pfx` when umu-run or Proton created it, else the prefix folder. It is resolved to its real path, so it is the one the running wineserver was started with.
- The Wine binary is the install's own (`SCULKWIRE_WINE` overrides it), because a different Wine build starts a second wineserver and the injector would not see the running game. Proton needs its own `lib/wine/x86_64-unix` on `LD_LIBRARY_PATH`; sculkwire adds it.
- The DLL path is handed over as a `Z:` drive path, because the injector is a Windows program. Every path crossing that boundary goes through `gamepath.ts`, and files the game writes are read back through the host path.

macOS takes the same route. The desktop focus watcher has no macOS backend, so the game counts as focused there unless an X11 display is set.

### Windows

The injector runs natively and gets the native DLL path. Nothing is watched for focus: the game runs as a normal window, so Windows delivers its focus changes to the game itself.

### Where the DLL Comes From

`build.ts` takes the first route that applies:

| Order | Route | Notes |
|---|---|---|
| 1 | A registered extension agent source whose `matches(gameDir)` is true | [Agent Source](extensions.md#agent-source); the built-in routes are not used |
| 2 | `SCULKWIRE_AGENT_DLL` | `SCULKWIRE_AGENT_INJECTOR`, or `sculkwire-injector.exe` next to the DLL. Both are checked to exist |
| 3 | `cargo build --release --locked --target x86_64-pc-windows-msvc` in `native/` | Needs `native/` and `cargo`; cached by a hash of the crates |
| 4 | The release archive `sculkwire-agent-<version>-x86_64-windows.zip` | Downloaded with its `.sha256`, verified, unpacked into the cache |

The cargo route writes into `cacheDir("agent")/<hash>/` (Linux `~/.cache/sculkwire/agent`, Windows `%LOCALAPPDATA%\sculkwire\cache\agent`), with the DLL named `sculkwire-agent-<hash>.dll` and the injector `sculkwire-injector.exe`. The prebuilt route uses `cacheDir("agent")/prebuilt-<version>/`. The agent writes `sculkwire-agent.log` into the same folder; `engine_attach` names that path when the DLL was loaded but nothing accepted the connection.

The prebuilt archive holds `sculkwire_agent.dll` and `sculkwire-injector.exe`. Its checksum is published next to it, and a mismatch is a hard failure rather than a load.

The injector is `sculkwire-injector.exe <process.exe> <dll-path>`: it finds the process by executable name, writes the path into it and calls `LoadLibraryW` from a remote thread. It prints `OK <pid>` on success and exits 1 with a message on failure. It modifies no game file.

## How the Agent Works

The DLL starts a socket server and an engine thread from `DllMain`. The engine resolves its anchors (build-relative recipes for the functions and data it needs), installs its hooks, and from then on answers requests from its per-frame hook on the game's main thread. Nothing is addressed by a fixed offset, so the agent is not tied to one build; a recipe that does not resolve leaves its anchor missing, and a method that needs it fails with `anchor_missing` (`-32001`) naming the anchor instead of guessing. `engine_status` lists every resolved anchor with its address and every missing one.

Requests that only read the agent's own state run on the connection's thread. Everything that touches the game runs on the main thread, which is the only place engine calls are safe. A request that cannot run in time answers `timeout` (`-32004`) rather than blocking the frame.

The drain is one at a time, and that guard is itself survivable: a handler that faults leaves its frame for good — a foreign exception unwinds through SEH, not through Rust's drops — so the fault path releases the drain and answers the request it was running with `internal error` instead of leaving the queue wedged for the life of the process. A drain that has held the flag for longer than any handler can (two minutes; `tick.step` is capped well below it) is treated the same way by the next entry, and `engine_status.drainReleases` counts both. A slot whose caller gave up before its handler answered is taken by the next request instead of being lost, so a run of timeouts no longer starves the sixteen slots.

The agent serves up to eight connections, so `sculk game lock` and the `engine_*` commands work while an MCP session keeps its own connection open.

## Tools

Full inputs and results are in the [tool reference](tools.md#engine), which names the section of each tool. This is what each one does inside the game.

| Tool | Inside the game |
|---|---|
| `engine_attach` | Build, inject, connect, read `engine.status`. An error says what to fix: which install or game folder was not found, that the game has to be running, or where the agent log is when the DLL loaded but nothing answered |
| `engine_status` | `build` (the executable's own file name and version), `hooked`, `tick`, `resolved`, `missing`, and the diagnostics `attached`, `mainThread`, `port`, `drainReleases`, `hooks`, `gameinput`, `ui`, `minecraft`. Without an attach it connects to an agent already listening on the port |
| `engine_command` | Runs one line as the local player through the game's command dispatcher, chat feedback included. A leading slash is optional; a newline is rejected because the game would split it into several commands. `success` comes from the command's own output and is `null` when it prints nothing, as `say` does. The agent replays the origin of a real player command, so the first command after an attach or a world change types one line in chat itself first (`/testfor @s`, its output kept out of chat by `command.prime`). It does so only while the HUD alone is showing: the chat opens with `t`, the line is typed only into that chat screen, and Return goes only to it. With any other screen open it answers `anchor_missing` `command.origin` and says to run one line in chat |
| `engine_tick` | `pause` freezes or resumes the simulation, `step` pauses if needed and runs 1 to 600 ticks inside one main-thread request then stays paused, `scale` sets the tick rate multiplier. Exactly one of the three |
| `engine_screenshot` | Copies the next frame the game presents (the world, the HUD and any open screen, as the window shows them) and writes it to your path as a PNG. The game's own screenshot is not used: no animation, toast or sound, nothing added to its gallery, and calls can follow each other at once |
| `engine_player` | `position` (the feet: the bottom of the player's collision box, `null` when not readable), `rotation` (pitch, yaw; `null` when not readable), `delta` since the previous tick, `simTick` and `dimension`. Needs a loaded world |
| `game_input_lock` | The input lock, see below |
| `game_settings` | The game's own options, see below |
| `world_settings` | The loaded level's settings, see below |
| `game_ui` | The screen and its controls, and keys, text, clicks and scrolling through the game's own UI, see below |
| `player_inventory` | The player's attributes and whole inventory, see below |
| `container` | A block's container, or the container screen that is open, see below |
| `craft` | The game's recipe lookup, and crafting through it, see below |
| `interact` | Use a block or an entity like a right click, and the screen it opened, see below |
| `screen` | The open screen: its containers, moving items, its own action, closing it, see below |

`player_act` and `sculk bench` on the engine route send `input.look` (the view shown from the next frame), `input.move` (a movement vector the game applies every tick until no update arrives for a second; sculkwire repeats it every 300 ms), `input.release`, `input.attack` and `input.use`, plus `ui.key` with `down` and `up` for the hotbar keys of `select_slot` and the keys of `hold`. `mine` holds the attack button with `input.attack {hold: true}`, and `use_item` and a bow draw hold the use button with `input.use {hold: true}`; the agent lets a held button go a second after its last `hold: true`, so sculkwire repeats it every 300 ms and ends the hold with `hold: false`. `input.attack` answers with the id of the entity under the crosshair, the id the Script API reports. The tick stream carries position, rotation, velocity, ground contact, health and the selected slot every tick, so the view the controller reads is one tick old.

### Agent Port

The listener is on `127.0.0.1:19160`. Set `SCULKWIRE_AGENT_PORT` to move it; the DLL reads its own environment, so sculkwire and the game have to agree. A game sculkwire launched inherits sculkwire's environment; a game you started yourself does not, so set the variable for your user session.

If the port is taken — the common case is a hot reload, where the previous agent is still unloading — a fresh agent retries it for three seconds and only then settles for the next free one, with a line in the log naming both ports. `engine_status.port` says which one it bound, because sculkwire only ever dials the first.

### Unload and Hot Reload

`agent.unload` takes everything this DLL put into the game back out and then frees the image: the queued work, the socket server, the inline hooks, the GameInput vtable slots, the `WH_GETMESSAGE` hook, the window subclass, the timers, the import slots, the vectored exception handler, and finally its own threads. A hot reload injects a new agent afterwards — and only works if the old image really left: `LoadLibraryW` on a file that is still mapped returns the existing handle and never runs `DllMain` again, which looks exactly like a broken agent (no server, no attach, no port).

So the unload is written to be provably complete, and says so in `sculkwire-agent.log`: `attach: module 0x… (N reference(s) at load)` when it starts, `unload: module … (N reference(s) before teardown)`, every drop of the loader's reference count as the hook, the exception handler and the window thread let go (`unload: reference count 2 -> 1`), the thread count, and `unload: freeing 0x… with 1 reference(s)`. An image that cannot be freed says why and is *left mapped* rather than freed under a thread that is still running — a mapped stale agent is a failed reload, a freed one under live code is a dead game.

`WH_GETMESSAGE` is what holds a DLL longest: user32 keeps its own reference until the hooked thread next retrieves a message, so the unload posts a `WM_NULL` to that thread after unhooking and waits. A second agent that starts while an old one is still mapped reports it (`hot reload: a previous agent DLL is still mapped: …`), waits up to three seconds for it to leave, and then carries on with a warning; its socket server keeps retrying the port the whole time. The injector refuses outright when the DLL path it was given is already loaded in the target, naming it.

Restoring a hook's prologue stops new calls into the DLL, but the game's own threads may already be *inside* a detour — they fire tens of thousands of times a minute — or inside a game function the detour called, with the way back through this image still on the stack. The unload therefore ends with a quiescence check: every thread of the process is suspended for a moment, looked at, and resumed. A thread whose `RIP` is in this image is inside it; otherwise its stack is **unwound** frame by frame with the x64 unwind data (`.pdata`) of every loaded image, and a live frame that returns into this image keeps it mapped. A stack unwound to its first frame is proven clean, so a stale word that only looks like a return address (a slot of a frame that returned long ago) cannot hold the image back — a plain word search did exactly that in a menu, for a GameInput runtime thread. A walk that stops short of the first frame (code outside every image such as a trampoline page, a frame that does not advance, an unreadable frame) proves nothing, so the rest of that thread's stack is searched word by word instead. The function tables are read before any thread is suspended, because the loader's own lookups take a lock a suspended thread may hold. The check repeats for two seconds; a clean pass logs `unload: no other thread is in this image (… N stack(s) unwound to their first frame, M searched word by word …)`, and a busy one names the thread and the frame (`thread 0x… has a frame returning to agent+0x… … NOT freeing`) and **does not free** — an image left mapped with no hooks, no timer and no thread is a failed reload, a freed one under a live detour is a dead game. The hook engine's trampolines and relays are `VirtualAlloc` pages the unload never frees, so a thread that is inside one when its prologue is restored finishes and returns to the game normally. With the `debug-rpc` feature, `debug.threads` runs the same pass on demand and lists how every thread's walk ended.

## Input Lock

While sculkwire plays through the engine, your own keyboard and mouse still reach the same game window: a click or key moves the camera or the player under the agent, and the game opens its pause menu when the window loses focus. The lock stops both.

While it is on, the DLL drops the key presses, mouse movement, clicks and wheel turns that reach the game window, including raw input, before the game sees them. Key and button releases still pass, so a key held when the lock engaged does not stay pressed. The camera is gated with the game's own permission, and the movement keys the agent did not press are cleared every frame. A controller bypasses window messages, so the functions the game polls for it report a centred, released pad while the lock is on. The action bar shows a badge.

F9 always works. It hands control to you: a running `player_act` action stops, a `play` job pauses, and agent input that still arrives is ignored. Pressing F9 again gives control back.

| Mode | Behavior |
|---|---|
| `auto` | Default. Locked while a `player_act` action or a `play` job runs |
| `on` | Locked until changed |
| `off` | Never locked |

The mode lives in the DLL, so every sculkwire process sees the same one, and each change is sent to every connection. The result carries `locked`, `mode`, `by` (`agent` or `user`), `user`, `active`, `window`, `dropped`, `focusLost`, `focusKept`, `shift`, `keysHidden`, `hostFocused`, `pad`, `wineFocused` and `wineForeground`; the MCP tool adds `focusWatch`.

Focus is the part that differs by OS. Inside Wine under gamescope the game never learns about desktop focus changes, so on a KDE Plasma Wayland desktop sculkwire loads a KWin script at runtime over D-Bus (from a temporary file, never installed into your KWin config) and unloads it on `game_stop`; on X11 it reads `_NET_ACTIVE_WINDOW` with `xprop`. It reports the game window's focus to the agent with `input.focus`, and the agent keeps polled input out while the window is not focused. On Windows nothing is watched: the game sees its own focus, and `focusWatch.backend` is `windows`. The watcher fails open: a game counts as focused until a report says otherwise, and again if the watcher cannot start or dies.

The keyboard route cannot be locked, because its keys and mouse reach the game the same way as yours. Use the engine route (attach the agent) or launch with `display: headless`.

## Game Settings

`game_settings` reads and changes the options the game owns, named by their `options.txt` save tag (`gfx_viewdistance`, `game_thirdperson`, `showcoordinates`, and so on). Through an attached agent the change goes through the game's own options object, so it applies at once; the value is checked against the option's type, and against its range or allowed values. The agent also reports `saved`: `true` when the game wrote `options.txt` itself, `false` when the change is live only and is lost on restart unless the game saves later (sculkwire still restores it on `game_stop`). Without an agent, sculkwire reads and writes the install's `options.txt`, and the change arrives with the next launch, so that route is always `saved: true`. Values are in the game's unit on both routes: `options.txt` saves `gfx_viewdistance` in blocks, so the file route divides by 16 on read and multiplies on write (and on restore), and the render distance is in chunks whichever route answers. Only options the game has already saved can be changed that way.

The script debugger, WebSocket and content-log keys belong to the bridge's own channels: `game_launch` writes them and `game_stop` restores them, and `game_settings` refuses them by name.

An agent that is already listening counts as attached, for `game_settings` and `world_settings` alike: a `sculk` command in a new process, or an MCP server started after the attach, connects to it first and only falls back to `options.txt` or `level.dat` when nothing answers on the port. Before, such a process wrote the files of a running game (which overwrites them) while the agent could have applied the change at once.

Every value sculkwire changes is recorded in `<data>/client/engine-settings-restore.json`, keeping the value the option had before the first change. `game_stop` puts all of them back, live through the agent while the game still runs and in `options.txt` as well, so the file agrees whether or not the game got to save its own copy. The first `options.txt` write leaves `<file>.sculkwire-backup` behind.

## World Settings

`world_settings` reads and changes a test world: game rules, difficulty, game type, time and weather. Through an attached agent it reads the loaded level's own data, so the answer is what the running world uses, and applies changes the way the game applies its own command (game rule, difficulty, time and weather through the game's setters or the equivalent command run as the local player), never as a raw memory write. Without an agent it reads and rewrites `level.dat`, and only for a `sculkwire-*` world that no game has loaded, because a running game would overwrite the file and keep its own value.

A field the engine cannot read is `null`, never a guess. In `level.dat` mode only the game rules the file stores by name are reported (the boolean switches and the integer rules), a weather change is written with a five-day timer so it holds through a test session, and education edition and the dimension are left `null` because the file does not store them.

World changes need no restore: a test world is disposable and the next launch replaces it. Any other world is refused by name.

## Menus and Screens

`game_ui` drives the game's own UI from inside the process, so a menu works in the background and on Windows without the foreground: the keyboard and mouse route ([`game_input`](tools.md#game_input)) only reaches the game while its window is in front. No world is needed, so the title screen, the Play screen and Settings are reachable while the game sits in a menu.

`screen` answers the current screen and the stack under it in the game's own names (`start_screen`, `play_screen`, `pause_screen`, `hud_screen`), with `modal` while a dialog blocks what is below. `controls` lists the visible controls when the UI tree is readable, each with the name `press` takes, its type, its client-pixel rectangle, the label the player reads and whether it is enabled; where the tree cannot be read, `controls` and `press` answer `anchor_missing` and `click` remains: `ui.oreui_dom` on a screen with no JSON-UI controller, `ui.control_tree` on one whose controller hands out no view (the start and pause screens of 1.26.63.1) or right after an input while the screen may still be changing. The controller's view getter is only called where the game's own code proves it: the scene's own name method makes that same call on the object at the same field, and the controller's class table reaches the slot (every entry up to it is image code). Other controllers keep another method at that offset: calling it faulted the drain on the start screen and, on the pause screen, ran a whole screen operation with a garbage argument that wrote through it and took the game down seconds later. `press` presses a named control through the game's own handler, and `key`, `text`, `click` and `scroll` send input the way the game reads it: a key or chord, text into the focused box, a click at the pixels of a screenshot, or wheel notches.

Every one of those inputs is refused while the current screen is a store, the Marketplace, Minecoins, the Dressing Room or the persona/profile editor, except `Escape` to leave it. A screen counts as one when its name or route carries a store word anywhere, case-insensitively (`marketplace`, `minecoins`, `coin`, `store`, `purchase`, `dressing`, `persona`, `profile_editor`, `skin_selector`, `character_creator`, `upsell`; so `dressingRoomCoinScreen` and `/marketplace/store` both match) or a store package name (`csb.…`, `portfolio.…`, `token_faq.…`). Every OreUI page names itself `ui://./hbui/index.html`, so on an OreUI page the agent reads the page's route from the game's own OreUI router (the last entry of its history, `/play/all` on the Play screen) and `screen` reports it as `route`. Only a router of the stack the screen was read from answers, so another stack's page (the toast layer's `/__bedrock__/toast_screen` in a world) is never taken for the one on screen. The store rule applies to that route. A click, `Return`, `Space`, or text with a space or line break is sent only on an allowlisted route: `/play…`, `/settings…`, `/create-new-world…` and `/edit-world…`. While the route cannot be read, those inputs are refused with `anchor_missing` `ui.oreui_route`, failing closed; in a world that is the case on every OreUI page for now (the in-game Settings, see Blockers). The agent refuses all of this itself; the join recovery and `game_input` keep the same rule.

`key` and `text` reach the game as window messages — a key is a message the game's own procedure reads. The mouse is not: the client takes it from `GameInput`, the GDK's input API, which the game calls through COM vtables, so `click` and `scroll` write the agent's own state into the readings the API hands the game (the interface's own vtables are patched in the process and restored on `agent.unload`) and the input lock hides your own mouse and keyboard in those same readings while it is on. That route is taken only once the game has read a mouse state through the hooked interface (`engine_status.gameinput.samples` above zero); then both answer `route: "gameinput"`, after the game's own window procedure is given a `WM_MOUSEMOVE` at the point: the page hit-tests at the cursor that procedure keeps (it feeds the mouse device a move), not at the GameInput position, so a client the real pointer never entered pressed nothing. The user's desktop pointer is not moved, and `engine_status.gameinput.cursor` keeps the last point the agent placed — the request is queued and the game applies it on its next readings, so `pending` is `true`. Otherwise they answer `route: "window"`: the message route, where a click holds its button for 150 ms (the game samples button state once per frame, so a down and an up in one frame are no press) and is released by a timer on the window's own thread. The game's own button handler ignores those messages while its GameInput provider is active, which is the case on 1.26.63.1 (see Status).

The GameInput route is validated on the interface's own answers, not on the user moving the mouse: the probe accepts `GetMouseState` answering `false` (which is what a runtime says before any mouse reading exists) as long as it wrote nothing, and refuses only an answer that cannot come from these methods at all — `GetInputKind` outside `GameInputKind`, a `GetKeyCount` that is a pointer, a `GetMouseState` that writes something which is not a mouse state. Nothing is patched until that passes, and the probe is retried every 500 ms for as long as the module is up. `engine_status.gameinput` reports `hooked`, `patched`, `probe` (why the last attempt refused) and what the game itself asked for: `kinds` (`mouse`, `keyboard`, `other`), `readings`, `callbacks`, `samples` and `synthetic`. A `kinds.mouse` above zero with `samples` at zero means the game takes mouse readings but never interprets one as a mouse; `kinds.mouse` at zero means it does not read the mouse through the API at all.

A window click has two targets, and `via` says which one was used. A JSON-UI screen is drawn and hit-tested by the game's own window procedure (`via: "class"`). An OreUI screen is a hosted view in a child window — a WinAppSDK content island, a WebView2/CEF host — whose own procedure hit-tests the button and owns the coordinates, so the click is posted there with child-client pixels (`via: "child"`), and `engine_status.ui` lists the game window's class, its children and the host it picked. `SCULKWIRE_AGENT_DLL` and the shipped `Installers/GameInputRedist.msi` pin the interface version the slot layout comes from; an older redistributable (the pre-2.x ABI) would answer the same call shapes with different slots, which the probe cannot tell apart.

The join recovery (`game_launch`, `src/runtime/client/screens.ts`) reads `ui.screen` while the agent is attached instead of inferring the screen from the engine log, presses the named control where the screen lists one (`Back to menu`, `Play`) and the key otherwise, and clicks the world tile through `ui.click`. The log still says which world the game opened. When the agent's UI stops answering twice in a row, the recovery falls back to the log and the host's keys for the rest of that run.

## Player Inventory, Containers and Crafting

`player_inventory`, `container` and `craft` read and use what the player has, from the game's own data: `player.attributes`, `player.inventory`, `container.get`, `container.open` and `craft.match`, with a craft itself running as `screen act craft` (below). Every answer is parsed and normalised here before it is used: an item id is namespaced, a count is a whole number, damage is clamped into the item's own maximum, and a container's slot list is made exactly as long as the container, so a reader can index it.

A slot is `null` when empty, else `{item, count, data?, name?, durability?: {damage, max}, enchantments: [{id, level}], lore?, contents?}`. An enchantment `id` is the Script API's name (`minecraft:unbreaking`): the agent sends the game's numeric id, which sculkwire maps (0 `protection` to 40 `breach`, the game's enchantment order), and a number past that table becomes `minecraft:unknown_<n>`. Slot indices are 0-based, the index the Script API uses too. `selectedSlot` is the exception: it is the hotbar slot 1 to 9 (`hotbar[selectedSlot - 1]`), the number `player_state` and `player_act select_slot` use, although the agent's `player.inventory` answer and its `tick` notification count from 0. `contents` holds what is inside a bundle or a shulker box item. Attributes are `{name: {current, min, max, default, base}}` for every attribute the player has (`base` is the value before modifiers: movement stays 0.1 while sprinting raises `current`), plus `armor` and `armorToughness` as `{current}`, computed by the game's own per-item functions and summed over the four armour slots.

`craft.match` goes through the game's recipe lookup, so the answer is what the crafting table would show: `result` (a slot, or `null` when nothing matches) and `recipe` (`id`, `type`, and `tag` when it has one). A grid is padded to 3x3, and item ids may be written without `minecraft:`. A craft is a screen action, so the `craft` tool's `run` action is the thin alias of `screen act craft`: the game's own crafting request through the screen the player has open — ingredients leave the inventory, the result enters it — and a 3x3 recipe needs a crafting table open, like the player.

Without an attached agent, `player_inventory` and `container get` fall back to the helper pack's Script API queries (`inventory` and `container` in `helper-pack/scripts/main.js`), and `source` says `script`. The Script API exposes the inventory, equippable and block inventory components, so that route has no item aux value, no bundle contents and no cursor stack, and only the attributes the running game exposes as components; a block without a container is `invalid_params` there too, the helper's `no_container` reason mapped to it. `container open`, both `craft` actions and everything below need the agent and fail saying so. Setting up inventories and containers stays on commands (`/give`, `/clear`, `/replaceitem`, `/setblock`) through `engine_command`.

## Interactable Blocks, Entities and Screens

`interact` and `screen` are how an add-on's own behaviour is used the way a player uses it. `interact.block` and `interact.entity` run the game's own interact path — the same call a right click makes — so a chest, a crafting table, a furnace, a brewing stand, an anvil, a stonecutter, a loom, a smithing or cartography table, a beacon or a villager's trades open their real screen, a boat or a minecart takes the player, and a button, a lever or a bed does what it does. The answer is the screen that opened (`null` when none did) and whether anything changed, and the screen is then read and driven through `screen`.

`screen.state` answers the open screen in one shape: its name, its family (`kind`: `crafting_table`, `furnace`, `blast_furnace`, `smoker`, `brewing_stand`, `stonecutter`, `anvil`, `grindstone`, `smithing_table`, `loom`, `cartography_table`, `enchanting_table`, `beacon`, `trade`, `chest`, `barrel`, `shulker_box`, `hopper`, `dispenser`, `dropper`, `crafter`, `horse`, `inventory` or `other`), every container keyed by the game's own collection name with slots in the same shape `player_inventory` uses, and the screen's own `data`. The names are the ones the screen itself uses, so they differ per screen: `hotbar_items` (9), `inventory_items` (27), `combined_hotbar_and_inventory_items` (36), `cursor_items`, `armor_items`, `offhand_items`, `crafting_input_items` (4 in the inventory, 9 on a crafting table), `furnace_ingredient_items` / `furnace_fuel_items` / `furnace_output_items`, `stonecutter_input_items`, `anvil_input_items` / `anvil_material_items`, `grindstone_input_items` / `grindstone_additional_items`, `smithing_table_input_items` / `_material_items` / `_template_items`, `loom_input_items` / `loom_dye_items` / `loom_material_items`, `cartography_input_items` / `cartography_additional_items`, `enchanting_input_items` / `enchanting_lapis_items`, `brewing_input_item` / `brewing_fuel_item` / `brewing_result_items` (3), `trade2_ingredient1_item` / `trade2_ingredient2_item`, and `container_items` for a chest, barrel or hopper. Each name holds only its own slots (index 0 is the collection's first slot), not the whole container behind it. `screen.move` takes these names, and also the container enum names older callers used (`HotbarContainer`, `StonecutterInputContainer`, `FurnaceResultContainer`, ...), mapped to the open screen's collection. A screen with no model state of its own reports `data: null`, read as no state. `data` otherwise holds what that screen reports: an anvil's `result`, `xpCost` and `name`; an enchanting table's three `options` (`cost`, the level the option needs; `lapis` and `levelsTaken`, what it takes: option + 1 each, the rule the game's own screen draws its lapis icons by; `hint`, `level`, and the `netId` the request echoes); a villager's `offers` (`tier`, the two buys, the sell, `uses`, `maxUses`, `xp`, and `priceMultiplier`/`demand`/`locked`); a furnace's or a brewing stand's `progress` (`burn`, `cook`, and the totals when known); a beacon's `levels`, `primary` and `secondary`; and the `recipes` a stonecutter, loom, smithing table or cartography table lists, each with its `output`.

`screen.move` moves items between those containers through the game's own item stack requests, the way dragging with the mouse does, and answers how many moved. A stack moved onto a bundle, or a bundle onto a stack, goes into the bundle through the game's own bundle insert (the one the inventory screen's bundle code calls): what fits moves (a bundle holds 64 weight), `moved` is that count, `count` caps it, and a full bundle is `-32602`. `moved` is counted again once the server answered, as the larger of what left the source stack and what the bundle's contents gained: a source named as `hotbar_items` or `inventory_items` is a view the client refreshes after the combined hotbar-and-inventory view, so it can still show the old count right after the insert. While the screen is open the bundle's items are its dynamic container (`dynamic_container_<bundle_id>`) and the bundle's slot carries them as `contents`; the client's copy of a bundle stack holds only that id. `player.inventory` adds a bundle's `contents` from that same dynamic container whenever the client's container map holds it (live: with the inventory screen open, and still on the HUD after it closed); a bundle no screen has shown since the world loaded has no client copy of its items, and its slot has no `contents`. A crafter, hopper, dispenser or dropper screen runs the plain container manager controller, whose model the agent reads where every controller keeps it (the base class's own field, read from its destructor), so moves work there like on a chest. `screen.act` runs the screen's own action through the game's own request: `craft` and `stonecut` by recipe, `anvil` with the rename text, `grindstone`, `smithing`, `loom` by pattern (the loom's own pattern button for one of `data.patterns`, which rebuilds the preview before the take), `cartography`, `enchant` by option, `trade` by offer, `beacon` by effect, and `take_result`. `stonecut` with `times` takes all the crafts in one request: one craft's count is the selected recipe's result in the stonecutter's list (the screen lists no preview container), and `times` is capped at the input blocks there (the server refuses a take of more than they make). A crafter has nothing to take: `craft` there is `-32602`, and the crafter crafts on a redstone pulse. It answers `done`, the `result` slot, the `consumed` stacks, the `xpCost` where one applies, and a `reason` when the screen refused it; `consumed` is read again once the server answered when the client had not shown it yet (a beacon's payment and an enchantment's lapis leave their slot only then). `screen.close` closes the screen the way `Escape` does, and sends another `Escape` (up to three) while the screen is still open 400 ms later: the chat screen's focused text box takes the first one.

Nothing here has a fallback: the Script API cannot use a block or read a crafting table, and no `level.dat` field stands in for it. Setting a scene up stays on commands (`/setblock`, `/summon`, `/give`, `/enchant`, `/xp`) through `engine_command`.

## Rules

- **Only local worlds.** Every agent method that acts on the game answers `not_in_world` (`-32002`) unless the loaded world is hosted by this game process: single player, with the in-process server present. The agent never drives a client connected to a remote server.
- **Only `sculkwire-*` worlds are changed.** World settings through the engine refuse a loaded level whose name does not carry the prefix, and the `level.dat` route refuses a folder that does not.
- **One driver at a time, options restored.** `AGENTS.md` lists the live game rules for sculkwire as a whole; the two above are the part the agent enforces inside the game.

## Protocol

Newline-delimited JSON-RPC 2.0 over TCP on `127.0.0.1:<port>`: one object per line, responses matched by id, so replies may arrive in any order. A line with a `method` and no id is a notification.

| Method | Thread | Result |
|---|---|---|
| `ping`, `info`, `modules` | socket | Liveness; the process, image base and size; loaded modules |
| `engine.status` | socket | `{build, hooked, attached, tick, mainThread, hooks, gameinput, port, drainReleases, resolved: {name: "0x…"}, missing: [name]}` plus the engine's own `minecraft` and `ui`; `attached` is false while the agent is still resolving right after the injection, and `engine_attach` waits for it |
| `engine.resolve` | socket | The `engine.status` shape; the client calls it to re-check the anchors |
| `stream.subscribe {every?}` / `stream.unsubscribe` | socket | `tick` notifications, every 1 to 1200 ticks |
| `input.lock {mode?, active?}` / `input.focus {focused}` | socket | Lock state; host focus |
| `command {command}` | main | `{success: bool\|null, message}` |
| `tick.pause {paused}` | main | `{paused, success}` |
| `tick.step {count}` | main | `{paused: true, ticks}` |
| `tick.scale {value}` | main | `{scale, success}` |
| `screenshot {path}` | socket | `{path, named: true, route: "present", width, height}`: the agent hooks the DXGI swap chain's `Present` (found through a throwaway swap chain's vtable, made on the `dxgi.dll` and `d3d12.dll` the game loaded) and copies the back buffer about to be shown on the game's own Direct3D 12 queue into a readback buffer, then writes it to `path` as an 8-bit RGB PNG. Waits up to 3 s for a frame (`-32004` when the game presents none, e.g. minimized); `-32001 screenshot.present` when the game does not render through Direct3D 12 |
| `player.state` | socket | `{position, rotation, delta, simTick, dimension}` |
| `input.look {pitch, yaw}` | main | The view shown from the next frame; pitch -90 to 90, yaw wrapped |
| `input.move {forward, strafe, jump, sneak, sprint}` | socket | Held; dropped after a second without an update |
| `input.release` | socket | Drops everything held |
| `input.attack {hold?}`, `input.use {hold?}` | main | `{hit: entityId\|null, target}` (`use`, and `attack` with `hold`: `{held, target}`); no `hold` is one click, `hold: true` presses and keeps holding (held `attack` breaks the block under the crosshair), renewed by repeating it, and let go a second after the last one or by `hold: false` or `input.release`. `target` is the crosshair's target before the click: `{kind:"block", block, face, position}` or `{kind:"entity", id, type, position}`, `null` when nothing in reach |
| `settings.list {filter?}`, `settings.get {id}`, `settings.set {id, value}` | main | `{settings: [...]}`, one entry, `{id, previous, value, saved?}` (`saved` false: live only, not in options.txt) |
| `world.settings`, `world.set {gamerules?, difficulty?, gameType?, time?, weather?}` | main | The world state, before and after, read on the server thread (`gameType` sets `/defaultgamemode` and `/gamemode … @s`) |
| `ui.screen`, `ui.controls {filter?}`, `ui.press {name}`, `ui.key {key, action?}`, `ui.text {text}`, `ui.click {x, y, button?}`, `ui.scroll {x, y, delta}` | main | `{name, stack, modal}`, the controls, then the input; refused on a store screen except `Escape` |
| `player.attributes`, `player.inventory` | main | `{name: {current, min, max, default, base}}` for every attribute plus `armor` and `armorToughness` as numbers (sculkwire turns them into `{current}`); `{selectedSlot, hotbar, inventory, armor: {head, chest, legs, feet}, offhand, cursor}` |
| `container.get {x, y, z, dimension?}`, `container.open` | main | `{block, size, slots}`; `dimension` is the bare name (`overworld`, `nether`, `the_end`), which sculkwire sends whichever spelling the caller used. A block without a container is `-32602`. Open: `{screen, block, position, slots, playerSlots}` (`position` `[x, y, z]` of the block the crosshair opened, `null` with `block` for an entity's screen; `playerSlots` the 36 carried slots once) |
| `craft.match {grid\|ingredients, table?}` | main | `{result, recipe: {id, type, tag?}}` |
| `interact.block {x, y, z, dimension?, face?}`, `interact.entity {id}` | main | `{screen: string\|null, changed}`; the game's own interact path. A screen closed just before stays on the stack under the HUD while it leaves (about 350 ms), and the game ignores a use until it is gone, so the aim waits for that first (up to 1.5 s, else `-32004`). A block is used once the crosshair's pick is on it (aims deeper into the cell until it is, else `-32602`); `changed` is a screen that opened or the block's state changing. A container screen is answered once it can take a `screen.move` (its controller and containers are there and it ran a frame with them), so what the screen does as it opens has happened: a trade screen fills the selected offer's cost from the inventory |
| `screen.state` | main | `{screen, kind, containers: {name: [slot]}, data}`; `data` is `null` for a screen with no state of its own, else the screen's own fields ([tool reference](tools.md#screen)), or `{unavailable, anchor}` when they cannot be read now |
| `screen.move {from: {container, slot}, to: {container, slot}, count?}` | main | `{moved}`; item stack requests, as dragging |
| `screen.act {action, recipe?, times?, name?, pattern?, option?, offer?, primary?, secondary?}` | main | `{done, result, consumed, xpCost?, reason?}`; `craft` here is what `craft run` sends |
| `screen.close` | main | `{closed, escapes}` |

Notifications: `tick` (`tick`, `position`, `rotation`, `velocity`, `onGround`, `health`, `selectedSlot`) and `lock` (the lock state). Error codes: `-32601` unknown method, `-32602` invalid params, `-32001` anchor missing (with `data.anchor`), `-32002` not in a local world, `-32003` wrong thread, `-32004` timeout, `-32006` command failed, `-32007` path not writable, `-32014` scripting unavailable.

The agent's addresses come from anchors resolved against the loaded image at attach time. A method whose anchor is missing fails instead of guessing, and `engine_status` says which one.

## Status

Verified live on the retail PC (GDK) client **1.26.63.1** under Wine on Linux, in a `sculkwire-*` world entered through the Play screen. "Live" means the answer came back over the wire from the running game, not from a unit test.

| Area | Status on 1.26.63.1 | What was checked |
|---|---|---|
| Attach, status, hot reload | Works | `engine_attach` waits for the anchors and reports `hooked: true`; five hot reloads in a world and several in menus, each freeing the old image with one reference left and re-binding port 19160 |
| Queue and connections | Works | A held drain times out its requests at 6 s and the queue answers again afterwards; one connection carries many requests |
| `engine_command` | Works, no manual step | `time query daytime`, `give`, `say` (`success: null`); 15 commands after five fresh attaches, each priming its own origin |
| `engine_tick` | Works | Pause, `step 20` (the sim tick moves by exactly 20), `scale 2`, resume |
| `engine_player`, `input.move`, `input.look` | Works | Position, rotation and delta in a world; walking at about 4.3 blocks/s that stops a second after the last update; jump; the view set exactly |
| `input.attack`, `input.use` | Works | The crosshair `target` (an entity with id and type, or a block with its face); one placed block per use; a used chest opens and closes again |
| `engine_screenshot` | Works | The presented frame as a PNG at the window's size (1920x1080 here), in a world and in menus with the open screen in the picture; five calls in a row each gave their own frame, with no toast and the game's gallery unchanged |
| Input lock | Works, checked with real input | With the lock on, real mouse moves and a held `w` change nothing; off, they move the player; on plus unload, input comes back (fail open). Camera permission and badge follow the lock |
| `game_settings` | Works | `list`, `get`, `set` and restore through the agent (`saved: false` until the game writes the file) |
| `world_settings` | Works | Time, weather, difficulty and a game rule set and restored |
| `game_ui` | Works in menus and in a world | `screen` names the JSON-UI screens and the OreUI route; `key`, `text` and `click` drive Chat, Pause, Save & Quit, the Play screen and its world tile; store and off-list OreUI pages are refused |
| `player_inventory`, `container`, `craft match` | Works | Inventory with armour and attributes, a filled chest, recipe matches (shaped and shapeless, 2x2 and 3x3) |
| `interact`, `screen` | Works for every station and a villager | Each station screen opens with its kind and per-name slots; `screen.move` (crafter, hopper, dispenser and dropper too); `screen.act` for craft (2x2 and 3x3, `times`), trade, stonecut, furnace take, enchant, anvil, grindstone, smithing, loom (the requested pattern, checked on the placed banner), cartography, beacon and brewing, with every count checked on the server; `screen.close`, the chat screen too |
| MCP tools end to end | Works | Every tool above over `sculk mcp` |

Without a game, the unit tests check the build driver (route order, source hash, cargo arguments, the release archive's checksum and unpacking), the injector command line for both hosts, the path mapping, the focus backend choice, the lock state, the settings and world file routes, and the parsing of every agent answer; CI builds the crates for `x86_64-pc-windows-msvc` on Linux and Windows. No live run on a native Windows install is recorded here yet.

## Known Limitations

- **Bundles cannot be emptied through `screen.move`**: a slot of a carried bundle's contents (`dynamic_container_<id>`) can have no model in the screen's controller, and the transfer dereferences the model without a check (it faulted, live), so `screen.move` refuses a slot whose collection the controller does not know (`invalid_params`). Filling goes through the game's own bundle insert instead (see `screen.move` above).
- **`Escape` on the chat screen** first leaves its text box, which has focus when the screen opens (the header's `Back` turns into `Exit`); the second `Escape` closes the screen, and one does once a click elsewhere took the focus. Measured on 1.26.63.1 with a press, a 0, 120, 200 and 300 ms hold and a hardware-keyboard message source: the same every time, so it is the page's behaviour for a key message, not a timing. `Return` submits on the first press.
- **Drain recovery after a fault inside a handler** releases the drain and fails the request (live on 1.26.63.1), but it cannot undo what a game function the handler called had already done before it faulted: a fault inside the game is a bug to fix at its call, never a state the agent can continue from.
- **Options outside the options object**, such as the video Mode (`graphics_mode`), are not reachable through the agent; they are `options.txt` keys while the game is closed.
- **`settings.list` holds the options with a save tag of their own**: 376 on 1.26.63.1, the tagged entries of the options registry (96 of its 472 entries have no tag). The per-input `options.txt` keys (`ctrl_sensitivity2_mouse`, `ctrl_invertmouse_gamepad`, `ctrl_autojump_touch`, ...: 149 of the file's 518 keys) are not among them. Until the registry object is found the agent reads the option records from the heap, and that walk also meets the records of the game's other option-like registries (feature toggles and developer flags such as `OreUISearchScreen` or `enable_packet_profile`, ids overlapping the options' own), which made `settings.list` answer about 544 entries; the registry is now looked up through its own array (an address that holds a found record is a slot of the registry's array when the object the array belongs to carries a registry vtable and proves its records), so the list is the registry's own once the heap walk ran.
