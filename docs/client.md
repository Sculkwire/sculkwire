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
| Commands, reload, content log, world queries | Yes | Yes |
| Screenshots | Yes, also while the window is covered | Yes, in window or off-screen mode |
| Keyboard and mouse input (`game_input`, `/connect` typing, sign-in recovery) | Yes, while the game window is in the foreground | Yes, in window or off-screen mode |
| `player_act`, `player_job`, `sculk bench` | Yes, while the game window is in the foreground | Yes, in window or off-screen mode |
| `mute` | Yes (the game's audio sessions) | Yes (a silent PipeWire or PulseAudio sink) |
| Off-screen (`headless`) mode | No | Yes |
| Watch the game while the agent works | Yes | Yes, in window mode (default) |
| In-game agent (`engine_*`, `game_input_lock`, `game_settings`, `world_settings`, `game_ui`, `player_inventory`, `container`, `craft`, `interact`, `screen`) | Yes, in the game's own process | Yes, through the install's Wine or Proton prefix. See [In-Game Agent](engine.md) |

The one real difference is where the agent's input goes:

- **Linux** runs the game inside gamescope, which has its own keyboard and mouse. The agent's input goes there, so your own mouse and keyboard stay yours and you can keep working while the agent plays. `headless` mode exists because of it.
- **Windows** has no gamescope. The agent uses the system keyboard and mouse (`SendInput`, the path a real keyboard takes), and only while the game window is in the foreground. Before every key, click or mouse move it checks that the game window is in front, and sends nothing when it is not. When you switch to another window it lets go of every key and button it holds and stops: a `player_act` action ends with "the game window is not in the foreground", a `play` job pauses until the game window is in front again, and `game_input` fails with the same message. One-shot input (`game_input`, typing `/connect`, the sign-in recovery) brings the game window to the front first. `player_act` and `sculk bench` bring it to the front once when they start and never take the focus back in the middle of an action.

macOS is supported through Wine-based launchers, without screenshots or input.

## Display Modes

Pass `display` to `game_launch`, or `--display` to `sculk game check`.

| Mode | Linux | Windows |
|---|---|---|
| `window` (default) | A gamescope window on your desktop, so you can watch the agent. Sound on | The game's own window. Sound on |
| `headless` | Nothing on screen: the game runs off-screen in gamescope. Muted | Not available: the game runs in its own window and the launch result says why. Muted |
| `desktop` | The launcher's own game window, no screenshots or input | The same as `window` |

On Linux, `window` and `headless` run the game inside [gamescope](https://github.com/ValveSoftware/gamescope) at 1280 by 720 and 60 fps unless `game_launch` gets `width`, `height` or `fps`. They need a Wine or Proton install with a launch command and `gamescope` on the `PATH`. Without them, or without a desktop for `window`, the game runs in `desktop` mode and the launch result says why. With a desktop the default is `window`, without one `headless`.

On Windows the game sizes its own window, so `width`, `height` and `fps` do nothing. Screenshots capture the window's client area with `PrintWindow`, which works while the window is covered. When the game hands back an empty frame (one colour), the client area is copied from the screen instead, which needs the game window in the foreground; otherwise the screenshot fails and says so. Clicks use the same client area in physical pixels, so a pixel in the screenshot is the pixel clicked.

`mute` silences the game in any mode: on Linux through a silent PipeWire or PulseAudio sink, on Windows by muting the game's audio sessions once it plays sound. When Windows has no audio output device or the game opened no session, the launch result says so instead of failing. Windows can keep an app's mute in its volume mixer, so `game_stop` unmutes the game before closing it; if the game is closed another way and stays silent later, unmute Minecraft in the volume mixer.

## Linux Requirements

| Tool | Needed for |
|---|---|
| `gamescope` | `window` and `headless` mode |
| `xdotool` | Keyboard and mouse input, the keyboard route of `player_act` and the sign-in recovery |
| `pactl` | `mute` (a silent PipeWire or PulseAudio sink) |

## Windows Requirements

Nothing to install. Input, screenshots and mute run through Windows PowerShell 5.1, which ships with Windows 10 and 11, with a few lines of C# it compiles on first use (a few seconds). A game started as administrator cannot receive input from a normal process; start it normally.

## Playing While the Agent Works

On Windows and Linux, sculkwire only manages the game of the install it uses, so you can keep playing from another install at the same time. On Windows that can be Preview while sculkwire uses Stable (or the other way round), and on Linux, for example, Flarial while sculkwire uses mcbe-gdk-installer. Set `SCULKWIRE_CLIENT` to choose which install sculkwire uses. On macOS sculkwire cannot tell installs apart yet, so close your own game first. On Windows the agent's input pauses while your game window is in the foreground, because the agent shares your keyboard and mouse; on Linux it does not.

Two games from the same install cannot run at once. If your own game is already open from that install, `game_launch` tells you so instead of closing it.

When the agent session ends, sculkwire closes the game it started.

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

`game_launch` creates a world named `sculkwire-<name>` and installs a small helper behavior pack. The world is flat and creative, has cheats on, and keeps daylight, weather and mob spawning frozen. It is a single-player world with LAN, Xbox Live and platform broadcast off, so nobody can join a test session. sculkwire also changes a few `options.txt` settings (script debugger and WebSockets) so it can connect. `game_stop` restores them.

### Worlds

sculkwire writes and deletes only worlds whose folder and level name both start with `sculkwire-`. Every launch reuses `sculkwire-bridge` (or the world `game_launch` names) and replaces it. A test world nobody played for 3 days is removed by the next launch, unless it carries the kept marker (`sculkwire-world.json` in its folder), which `keep: true` and `copyFrom` set. `keep: true` enters an existing test world as it is and adds the project's packs to its pack lists. `copyFrom` copies one of your worlds, by its name or level id and only when you chose it, into a `sculkwire-` world; it reads the original and never writes it, and turns multiplayer and every broadcast off and cheats on in the copy only. Your own worlds are never renamed, moved, changed or deleted. `game_worlds` and `sculk game worlds` list every world and delete a test world.

### One Folder per Pack UUID

When two folders in `development_behavior_packs` or `development_resource_packs` share a header uuid, the game loads either of them, so a stale copy can win over your latest build. `game_launch` and `game_reload` therefore leave exactly one folder of your project per deployed uuid:

1. If `rgl run` already exported the project there (for example `Echo Wand_bp`, named after `config.json`'s `name`, a literal `bpName`/`rpName`, or an `exact` export path), the fresh build is copied into that folder. It is the same project built the same way, so your export keeps working after `game_stop`, and sculkwire never deletes it.
2. Otherwise the pack goes to `sculkwire_<project folder>_<pack folder>`, which `game_stop` removes. Every launch and reload copies the current packs into it, also when an earlier launch left it behind.
3. Any other copy of the project with that uuid (an older `sculkwire_*` folder or a second rgl export) is deleted.

A folder that shares the uuid but is not an rgl export or `sculkwire_*` copy of this project is never touched and never used as the project's deployment. That includes a `sculkwire_*` folder of another project folder, for example a copy of the project in another directory whose earlier session left `sculkwire_<other folder>_BP` behind. `game_launch` and `game_status` report it in `deployDiagnostics`, and `game_reload` in its `diagnostics`, as a `client.duplicate-pack-uuid` warning naming the folder: the game may load that folder instead of the project's, so delete it or give one of the two packs another uuid, then relaunch. `game_reload` copies the project into its own folder (the rgl export or the `sculkwire_*` folder) every time, so the copy in `redeployed` always holds the current files. Only with `deploy: false`, when nothing of the project serves a uuid, is a folder that is not the project's used as it is; it is not copied and not in `redeployed`.

## Sign-In Race at Launch

The world link can beat Microsoft sign-in, and the join then fails in one of two ways.

- The game rejects the client's login, logs `LoginPacket failed validation` and `DisconnectPacket` in `logs/Debug_Log*.txt`, and stops on "An error has occurred. You need to authenticate to Microsoft services." After "Back to menu" it either joins the world by itself or shows the Play screen with the world list.
- Sign-in finishes while the world is still loading. The game closes the world again (`[Server]Level-LevelStartLeaveGame` before any client join) and shows the start screen.

`game_launch` watches for both signatures while it waits for the world and then walks the menus back into the test world the way a person would. It never relaunches the game for this. Without the agent it follows which screen is up through the engine log, where the game names every screen it creates and closes, and acts on that screen with the host's keys and clicks.

- On the error screen it presses Return, which activates the focused "Back to menu" button, and clicks the button if Return did nothing.
- On the Marketplace, the Minecoins store, the Dressing Room or any other unexpected screen it presses Escape until the start screen is back. It never clicks on a store screen.
- On the start screen it waits a few seconds in case the game re-opens the world by itself, then clicks Play (Return and Escape are the fallbacks).
- On the Play screen it double-clicks only the tile whose thumbnail shows the test world's icon (see [How sculkwire Finds Its World](#how-sculkwire-finds-its-world)). The engine log names the world that opens. If it is another world anyway, sculkwire leaves it through Save & Quit and looks for the icon again. After 2 such worlds it stops.
- Loading screens are waited out.

Each press waits for the screen to change before the next way of pressing is tried. The recovery stops when the client is in the test world or after 3 minutes. Its presses, the screenshot of the screen it started from, and the outcome are in `game_status` as `joinRecovery`.

The recovery presses keys and clicks on Linux in window and off-screen mode and on Windows (where it brings the game window to the front first). In `desktop` mode on Linux there is no background input. There `game_launch` fails with a message that asks you to press "Back to menu" yourself, then Play and the test world, unless the in-game agent is attached. When you started the game yourself (no launch command) and no agent can be attached, the same step is listed in `manualSteps` and sculkwire waits until you are in the world.

With the in-game agent attached, the screen comes from the agent's `ui.screen` instead, and every press goes through the game's own UI. A named control is pressed where the screen lists one (`Back to menu`, `Play`, `Save & Quit`), the key otherwise, and the world tile is clicked through `ui.click`. Where the host cannot take screenshots of the game (a game you started yourself on a Linux desktop), they come from the agent too. That works in the background and on Windows without the foreground. The engine log still says which world opened and whether each press moved the game on. When `ui.screen` fails twice in a row, the recovery falls back to the log and the host's keys for the rest of that run.

## How sculkwire Finds Its World

Every `sculkwire-` world gets a `world_icon.jpeg` from sculkwire: 256x144, a ring of black and teal squares that marks it as a sculkwire world, and inside it 4 by 2 coloured cells chosen by a hash of the world's level id. The Play screen shows it as the world's thumbnail, so no other world's tile looks like it, not even another sculkwire world's. When a world is saved and quit, the game replaces its thumbnail with its own picture of the world. So sculkwire writes the icon again whenever the world is not open: at every launch (`createWorld`) and before every walk into the world. The file stays a normal, writable file.

On the Play screen sculkwire takes a screenshot and finds pieces of the ring: a row or a column of alternating black and teal squares. The game draws a "Creative" badge (and an "Experimental" one for some worlds) over the thumbnail's bottom-left corner, and the list's edges cut tiles off, so the whole ring never has to be visible. It then reads the middle of each cell. It opens a tile when every cell matches the test world's icon. A tile whose visible cells all match but whose other cells are cut off by the tab strip or the screen's edge is scrolled into view through the agent, at most twice and never away. If it is still cut off, it is opened when at least 4 of its cells matched, with the click in the middle of those cells. An icon with a visible cell that differs is another world's. When no tile matches, it looks again (thumbnails load after the list). Then it leaves and reopens the Play screen once, in case the list still shows a picture it read before the icon was written again. Then it scrolls the list down through the agent up to 3 times. If the tile is still not found, it stops and says that the world's tile was not found. The game's own picture of a world cannot be predicted, so it is never used to pick a tile. It never opens a tile by its place in the list: featured servers and friends' worlds come first when some are online, and the local worlds are ordered by when they were last played, so the places move.

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
