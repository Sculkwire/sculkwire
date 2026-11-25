# Game Client Setup

sculkwire works with the PC (GDK) edition of Minecraft Bedrock on Windows and Linux, and detects installed copies automatically. Run `node src/cli.ts game status` to see which installs were found.

Next to the bridge, an optional in-game agent can be loaded into the running game: it runs commands, controls game time, reads the player, takes a screenshot through the game's own code, holds the input lock, drives menus and screens, reads inventories and containers, crafts and uses blocks, and reads and changes game and world settings, all from inside the game rather than through the screen. It is attached with `engine_attach` and is documented in [In-Game Agent](engine.md), including its requirements and its current status.

While the agent is attached, the bridge's own input takes its route where it can:

- `game_input` sends keys, text and left and right clicks through the game's own UI (`ui.key`, `ui.text`, `ui.click`), so they work in the background and on Windows without the foreground. A mouse move and a middle click keep the keyboard and mouse route.
- `player_act` and `sculk bench` use the engine route through the built-in [input provider](extensions.md#input-provider), with the input lock held while actions run.
- The sign-in recovery below reads the screen from the agent and presses through it.

## Platform Support

| Feature | Windows | Linux |
|---|---|---|
| Supported installs | Microsoft Store / Xbox app, stable and Preview, on any drive (the folder Windows registered for the package, else `XboxGames` on every fixed drive, plus `SCULKWIRE_GAME_DIRS`) | [mcbe-gdk-installer](https://gitlab.com/ve3dy/mcbe-gdk-installer), BedrockOnLinux, Flarial, Bottles, Lutris, Steam (any Wine or Proton prefix; the launcher's game folder is found next to its prefix) |
| Starts the game automatically | Yes | With mcbe-gdk-installer, or any launcher given a launch command |
| Use a game you already opened (attach) | Yes (not run against a real Windows game yet) | Yes |
| Commands, reload, content log, world queries | Yes | Yes |
| Screenshots | Yes, also while the window is covered | Yes, in window or off-screen mode |
| Keyboard and mouse input (`game_input`, `/connect` typing, sign-in recovery) | Yes, while the game window is in the foreground | Yes, in window or off-screen mode |
| `player_act`, `player_job`, `sculk bench` | Yes, while the game window is in the foreground | Yes, in window or off-screen mode |
| `mute` | Yes (the game's audio sessions) | Yes (a silent PipeWire or PulseAudio sink) |
| Off-screen (`headless`) mode | No | Yes |
| Watch the game while the agent works | Yes | Yes, in window mode (ask for `display: "window"`) |
| In-game agent (`engine_*`, `game_input_lock`, `game_settings`, `world_settings`, `game_ui`, `player_inventory`, `container`, `craft`, `interact`, `screen`) | Yes, in the game's own process | Yes, through the install's Wine or Proton prefix. See [In-Game Agent](engine.md) |

The one real difference is where the agent's input goes:

- **Linux** runs the game inside gamescope, which has its own keyboard and mouse. The agent's input goes there, so your own mouse and keyboard stay yours and you can keep working while the agent plays. `headless` mode exists because of it.
- **Windows** has no gamescope. The agent uses the system keyboard and mouse (`SendInput`, the path a real keyboard takes), and only while the game window is in the foreground. Before every key, click or mouse move it checks that the game window is in front, and sends nothing when it is not. When you switch to another window it lets go of every key and button it holds and stops: a `player_act` action ends with "the game window is not in the foreground", a `play` job pauses until the game window is in front again, and `game_input` fails with the same message. One-shot input (`game_input`, typing `/connect`, the sign-in recovery) brings the game window to the front first. `player_act` and `sculk bench` bring it to the front once when they start and never take the focus back in the middle of an action.

macOS is supported through Wine-based launchers, without screenshots or input.

## Display Modes

Pass `display` to `game_launch`, or `--display` to `sculk game check`.

| Mode | Linux | Windows |
|---|---|---|
| `window` | A gamescope window on your desktop, so you can watch the agent. Sound on | The game's own window (default). Sound on |
| `headless` (Linux default) | Nothing on screen: the game runs off-screen in gamescope, so it never takes your screen, keyboard or focus. Muted | Not available: the game runs in its own window and the launch result says why. Muted |
| `desktop` | The launcher's own game window, no screenshots or input | The same as `window` |

On Linux, `window` and `headless` run the game inside [gamescope](https://github.com/ValveSoftware/gamescope) at 1280 by 720 and 60 fps unless `game_launch` gets `width`, `height` or `fps`. They need a Wine or Proton install with a launch command and `gamescope` on the `PATH`. Without them, or without a desktop for `window`, the game runs in `desktop` mode and the launch result says why. The default is `headless`: the game runs in the background, and `window` shows it only when you ask for it. `game_screenshot` shows what the game shows in either mode.

On Windows the game sizes its own window, so `width`, `height` and `fps` do nothing. Screenshots capture the window's client area with `PrintWindow`, which works while the window is covered. When the game hands back an empty frame (one colour), the client area is copied from the screen instead, which needs the game window in the foreground; otherwise the screenshot fails and says so. Clicks use the same client area in physical pixels, so a pixel in the screenshot is the pixel clicked.

`mute` silences the game until `game_stop`. It is on by default only in `headless` mode, where the game runs in the background; `window`, `desktop`, a game you start yourself and a game sculkwire attached to keep their sound unless `game_launch` gets `mute: true`.

On Linux the game's audio goes to a silent PipeWire or PulseAudio sink (`sculkwire_muted_game`). PipeWire remembers an output per application and can send the game to that output instead, so while the game is muted sculkwire checks its audio streams every 2 s and moves each stream of the game's own processes onto the silent sink (`pactl move-sink-input`). The same memory can send your own Minecraft, started from another install while a muted game runs, to the silent sink, since both are named Minecraft: a stream of any other process found on the silent sink is moved to the default output within 2 s. No other stream of other apps is touched, the default output is never changed, and no stream is muted. When `game_stop` closes a game sculkwire started, its streams stay on the silent sink until the game has exited, so nothing plays during the stop; then the silent sink is removed. PipeWire remembers the move as Minecraft's output, a sink that no longer exists, so the next time Minecraft starts it plays on the default output. If you had sent Minecraft to another output than the default one, pick that output for it again once (in your sound settings or `pavucontrol`). A game you opened yourself that sculkwire attached to with `mute: true` keeps running after `game_stop`: its streams are moved back to the output they came from, so PipeWire remembers your own output for Minecraft again, and then the silent sink is removed. When a stream cannot be moved, or `pactl` is missing, `game_status` reports `muted: false` with a `muteNote`.

On Windows sculkwire mutes the game's audio sessions once it plays sound. When Windows has no audio output device or the game opened no session, the launch result says so instead of failing. Windows can keep an app's mute in its volume mixer, so `game_stop` unmutes the game before closing or leaving it; if the game is closed another way and stays silent later, unmute Minecraft in the volume mixer.

## Linux Requirements

| Tool | Needed for |
|---|---|
| `gamescope` | `window` and `headless` mode |
| `xdotool` | Keyboard and mouse input, the keyboard route of `player_act` and the sign-in recovery |
| `pactl` | `mute` (a silent PipeWire or PulseAudio sink) |

## Windows Requirements

Nothing to install. Input, screenshots and mute run through Windows PowerShell 5.1, which ships with Windows 10 and 11, with a few lines of C# it compiles on first use (a few seconds). A game started as administrator cannot receive input from a normal process; start it normally.

## Playing While the Agent Works

On Windows and Linux, sculkwire only manages the game of the install it uses, so you can keep playing from another install at the same time. On Windows that can be Preview while sculkwire uses Stable (or the other way round), and on Linux, for example, Flarial while sculkwire uses mcbe-gdk-installer. Set `SCULKWIRE_CLIENT` to choose which install sculkwire uses. On macOS sculkwire cannot tell installs apart, so any running game counts as the one it uses. On Windows the agent's input pauses while your game window is in the foreground, because the agent shares your keyboard and mouse; on Linux it does not.

## Working in a Game You Opened

Two games from the same install cannot run at once. If your own game is already open from that install, `game_launch` attaches to it instead of starting another one: it never restarts, closes or Save & Quits it, and writes nothing into its world.

1. With the in-game agent, sculkwire turns `/connect` and the content log on in the running game and, once a world is open, runs `/script debugger connect localhost 19151` and types `/connect localhost:19150` in chat for you. Both need cheats on in the world: with cheats off, turn them on (pause menu, Settings, Game) and sculkwire dials again. It never answers a confirmation dialog for you. If your game requires encrypted websockets (Settings > General > Require Encrypted Websockets), turn that off yourself to let sculkwire use `/connect`; commands work through the script debugger meanwhile.
2. Without the agent (macOS, or the attach failed), type those two commands in the game chat yourself; `manualSteps` names the exact ports.
3. The tools that read the world through the helper pack (`game_query`, `wait_until`, `game_events`, `scene_*`) work only in a world that lists the helper pack. sculkwire puts it into `development_behavior_packs`; add "sculkwire helper" to the world's Behavior Packs and rejoin, or launch the world through sculkwire once with the game closed.

`game_stop` then only detaches and leaves your game running. See [Attaching to a Running Game](tools.md#attaching-to-a-running-game) for the details.

When the agent session ends, sculkwire closes the game it started, and only detaches from a game you opened.

## Custom Launchers

For a launcher sculkwire does not detect, set the following environment variables.

| Variable | Description |
|---|---|
| `SCULKWIRE_MINECRAFT_DIR` | Path to the game's `Minecraft Bedrock` data folder |
| `SCULKWIRE_CLIENT_LAUNCH` | Command that starts the game. `{uri}` is replaced with the world link; an `{args}` part is dropped |
| `SCULKWIRE_CLIENT_STOP` | Command that stops the game (optional) |
| `SCULKWIRE_CLIENT` | Which install to use when several are found |

If sculkwire cannot start the game itself, `game_launch` returns at once with `manualSteps` that name the world to open, and the bridge connects once you are in it. `game_status` shows when the game is ready.

If the launch command starts the game but cannot open the world (it ignores `{uri}`, or you enter the world from the start screen yourself), `game_launch` waits `worldWaitSeconds` (default 180) and then stops the game. Pass `keepOnTimeout: true` to keep the game instead: the result says the world has not loaded yet and how to enter it (Play, then the `sculkwire-` world on the Worlds tab), and `game_status` turns ready once you are in, up to 30 minutes later. `sculk game check` takes the wait as `--world-wait <seconds>`.

## What sculkwire Changes

`game_launch` enters one of your own worlds (below) and installs a small helper behavior pack into it; it never creates or copies a world for you. sculkwire also changes a few `options.txt` settings (script debugger and WebSockets) so it can connect. `game_stop` restores them.

### Worlds

`game_launch` enters, in this order: `userWorld`; your saved dev world, chosen once with `game_worlds` `action: "use"` or `sculk game worlds --use <name or level id>` (`--clear-default` forgets it); else the one of your worlds whose pack lists already name the project's packs (several: the one played last, and `worldNote` says so). When none is found the launch fails at once, lists your worlds and asks which one to use. `sculk game check` follows the same order and takes `--user-world <name>`. Before each launch writes to the world, sculkwire backs up its `level.dat`, `level.dat_old` and pack lists (never `db/`) to `world-backups/<levelId>/<time>` in its data folder, keeping the newest 10. It then adds the helper pack and the project's packs to the world's pack lists (other packs stay, and these stay after `game_stop`, with their `sculkwire_*` pack folders), turns cheats and commands on when they are off (the world then awards no achievements), turns Beta APIs on only with `betaApis` and sets the difficulty only with `difficulty`. Nothing else is written into it: no icon, no marker. These writes happen only while the game is closed. `game_stop` tries Save & Quit first, through the in-game agent's UI or a background mouse; when that cannot be done it says that changes from about the last minute may be lost. The world is never deleted, replaced or removed as stale, and your other worlds are never renamed, moved, changed or deleted. See [Worlds](tools.md#worlds).

sculkwire deletes only worlds whose folder and level name both start with `sculkwire-`: test worlds earlier versions made, and the scratch world `sculkwire-bench` that `sculk bench` creates for its own run (flat, creative, single player, no icon) and deletes when the run ends. `game_worlds` and `sculk game worlds` list every world and delete a `sculkwire-` world. A `sculkwire-` world nobody played for 3 days is removed by the next launch, unless it carries the kept marker (`sculkwire-world.json`, which earlier versions wrote for kept and copied worlds) or is your saved dev world.

### One Folder per Pack UUID

When two folders in `development_behavior_packs` or `development_resource_packs` share a header uuid, the game loads either of them, so a stale copy can win over your latest build. `game_launch` and `game_reload` therefore keep sculkwire's own copy of a pack to one folder, use a folder rgl exported to in its place, and report every other folder that shares the uuid:

1. A folder rgl exported the project to serves the pack as it is (for example `Echo Wand_bp`). It is your folder and rgl is what updates it, so sculkwire never writes or deletes it, on a launch or on a reload. For a profile without filters, where the folder should be a copy of the source pack, a `client.rgl-export-differs` warning says when it is not: run `rgl run`.
2. A Regolith project whose profile runs filters deploys what rgl last built (`.regolith/tmp`, see [Regolith Projects](tools.md#regolith-projects)); sculkwire never runs rgl. With `--compat` the folder rgl exported to is the one that holds the same files as rgl's build. When rgl built the pack somewhere else than these dev packs, the build is copied into `sculkwire_<project folder>_<pack folder>` on every launch and reload.
3. Any other pack goes to `sculkwire_<project folder>_<pack folder>`, which `game_stop` removes. Every launch and reload copies the current packs into it, also when an earlier launch left it behind.
4. The project's `sculkwire_*` folder is deleted when a folder rgl exported to serves the pack. No other folder is ever deleted.

Any other folder that shares the uuid is never touched and never used as the project's deployment. That includes a second folder rgl exported the project to, and a `sculkwire_*` folder of another project folder, for example a copy of the project in another directory whose earlier session left `sculkwire_<other folder>_BP` behind. `game_launch` and `game_status` report it in `deployDiagnostics`, and `game_reload` in its `diagnostics`, as a `client.duplicate-pack-uuid` warning naming the folder: the game may load that folder instead of the project's, so delete it or give one of the two packs another uuid, then relaunch. `game_reload` copies the project into its `sculkwire_*` folder every time, so the copy in `redeployed` always holds the current files. A folder rgl exported to is not copied and not in `redeployed`: rgl is what updates it. Only with `deploy: false`, when nothing of the project serves a uuid, is a folder that is not the project's used as it is; it is not copied and not in `redeployed`.

## Sign-In Race at Launch

The world link can beat Microsoft sign-in, and the join then fails in one of two ways.

- The game rejects the client's login, logs `LoginPacket failed validation` and `DisconnectPacket` in `logs/Debug_Log*.txt`, and stops on "An error has occurred. You need to authenticate to Microsoft services." After "Back to menu" it either joins the world by itself or shows the Play screen with the world list.
- Sign-in finishes while the world is still loading. The game closes the world again (`[Server]Level-LevelStartLeaveGame` before any client join) and shows the start screen.

`game_launch` watches for both signatures while it waits for the world and then walks the menus back into the world the way a person would. It never relaunches the game for this. Without the agent it follows which screen is up through the engine log, where the game names every screen it creates and closes, and acts on that screen with the host's keys and clicks.

- On the error screen it presses Return, which activates the focused "Back to menu" button, and clicks the button if Return did nothing.
- On the Marketplace, the Minecoins store, the Dressing Room or any other unexpected screen it presses Escape until the start screen is back. It never clicks on a store screen.
- On the start screen it waits a few seconds in case the game re-opens the world by itself, then clicks Play (Return and Escape are the fallbacks).
- On the Play screen it double-clicks only the tile whose thumbnail shows the world's own picture (see [How sculkwire Finds Its World](#how-sculkwire-finds-its-world)). The engine log names the world that opens. If it is another world anyway, sculkwire leaves it through Save & Quit and looks for the picture again. After 2 such worlds it stops.
- Loading screens are waited out.

Each press waits for the screen to change before the next way of pressing is tried. The recovery stops when the client is in the world or after 3 minutes. Its presses, the screenshot of the screen it started from, and the outcome are in `game_status` as `joinRecovery`.

The recovery presses keys and clicks on Linux in window and off-screen mode and on Windows (where it brings the game window to the front first). In `desktop` mode on Linux there is no background input. There `game_launch` fails with a message that asks you to press "Back to menu" yourself, then Play and the test world, unless the in-game agent is attached. When you started the game yourself (no launch command) and no agent can be attached, the same step is listed in `manualSteps` and sculkwire waits until you are in the world.

With the in-game agent attached, the screen comes from the agent's `ui.screen` instead, and every press goes through the game's own UI. A named control is pressed where the screen lists one (`Back to menu`, `Play`, `Save & Quit`), the key otherwise, and the world tile is clicked through `ui.click`. Where the host cannot take screenshots of the game (a game you started yourself on a Linux desktop), they come from the agent too. That works in the background and on Windows without the foreground. The engine log still says which world opened and whether each press moved the game on. When `ui.screen` fails twice in a row, the recovery falls back to the log and the host's keys for the rest of that run.

## How sculkwire Finds Its World

sculkwire writes nothing into a world to find it. The Play screen shows each world's own `world_icon.jpeg` as its tile's thumbnail, the picture the game took when the world was last saved, so sculkwire reads that file (`jpeg.ts` decodes baseline JPEG) and looks for the same picture in a screenshot (`thumbnail.ts`). The picture is shrunk to a 16 by 9 grid of cell colours and searched for at every tile size from a tenth to two fifths of the frame's width; each place is scored by the correlation of its cell colours with the grid, so a darkened or hovered thumbnail still matches. The bottom row is left out because the game draws its "Creative" and "Experimental" badges over it. A tile cut off by the tab strip or the list's edge matches by its visible half; it is scrolled into view through the agent, at most twice and never away, and then opened by its visible half.

A tile is opened only when exactly one local world's tile shows the picture. When the world has no `world_icon.jpeg` (a world never saved), a picture sculkwire cannot read (progressive JPEG) or one too plain to tell apart, or when two tiles show the same picture (a world and its copy), the recovery clicks nothing, stops, and `manualSteps` asks you to open the world yourself. A tile that sits where the 4-column layout puts a featured server is never opened. When no tile matches, it looks again (thumbnails load after the list), then leaves and reopens the Play screen once, then scrolls the list down through the agent up to 3 times, and then stops and says that the world's tile was not found. It never opens a tile by its place in the list: featured servers and friends' worlds come first when some are online, and the local worlds are ordered by when they were last played, so the places move.

After it clicks the tile, the world's loading screen must come within 8 s. When the Play screen stays up instead and the tile is covered afterwards, the game shows a dialog over the screen, such as the World update that makes an old world higher and deeper; when the tile stays in view, the game ignored the click. Either way the recovery stops at once (at most two double-clicks on the tile): it presses nothing more, never confirms a dialog (sculkwire never updates a world for you), and `manualSteps` asks you to confirm the dialog yourself (the game can make a backup copy first) or to open the world. sculkwire keeps waiting for the world in the background and clicks nothing while the step is yours; a launch that waited in the foreground returns at that point.

On the Play screen sculkwire never clicks anything but that thumbnail:

- It never clicks in the tab strip, and never opens or presses the Realms or Servers tab. When the agent reports the Play screen's route on another tab than Worlds (`/play/all` after Save & Quit), sculkwire presses the control named exactly "Worlds" through the game's handler, when the screen lists one. On a tab that lists no local worlds it presses Escape.
- On a store, Marketplace, Minecoins, Dressing Room or profile screen it only presses Escape.
- Through the agent, Save & Quit on the pause screen is pressed only by its name, never by its place: "Browse Add-ons!", a store entry, sits right above it. When the pause screen lists no Save & Quit control, nothing is clicked.

When you start the game yourself (no launch command), `game_launch` needs nothing more from you than starting it. Once the start screen is up, sculkwire attaches the in-game agent and walks into the world when the game has sat on the start or Play screen for 6 seconds with no world opening. If you use the menus meanwhile, it is not fought: at most one walk per 20 seconds, and none after 3. When the agent cannot attach, or the walks did not get in, `manualSteps` says to open the world yourself. On an install sculkwire starts with a world link, the walk runs only when an agent is already attached.

## Status

This is the bridge. The in-game agent has its own status, in [In-Game Agent](engine.md#status).

- **Linux:** verified end to end against the game with mcbe-gdk-installer, Flarial and BedrockOnLinux (1.26.63.1, 2026-11-11; there `game_launch` returns the manual steps and you start the game from the launcher).
- **Windows:** the input helper (held keys, chords, Unicode text, clicks on the requested pixel, relative mouse motion, nothing delivered and the loss reported while another window is in front, keys let go when the helper closes), `PrintWindow` screenshots and the screen-capture fallback are checked on CI against a test window, not against the game. The installers are checked on CI too.
- **Still to do:** a full run against the game on Windows. On a Windows machine with the game installed, run:

```
sculk game check <addon> --screenshot shot.png
sculk bench nav --scenario course
```

The first launches the game, loads the add-on, collects its errors and saves a screenshot (check that `shot.png` shows the game, not a blank frame). The second walks the player through an obstacle course with keyboard and mouse input; keep the game window in front until it ends.
