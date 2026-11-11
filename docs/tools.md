# MCP Tools

Every tool returns structured JSON plus a short text summary. Problems found in packs are always reported with a file, a line and a column, so an agent can jump straight to the fix.

- [Knowledge](#knowledge)
- [Validation](#validation)
- [Bedrock Dedicated Server](#bedrock-dedicated-server)
- [Game Client](#game-client)
- [Player](#player)
- [Containers and Crafting](#containers-and-crafting)
- [Engine](#engine)
- [Game Files](#game-files)
- [Decision Model](#decision-model)
- [sculkwire](#sculkwire)

Most knowledge tools take `channel` (`stable` by default, or `preview`) and `offline` (default false, answer from the local cache only and never fetch). Every answer names the game version and bedrock-samples tag it describes.

## Knowledge

### knowledge_versions

Shows the current stable and preview versions sculkwire tracks. That includes the bedrock-samples tag, the matching Bedrock Dedicated Server build, the `@minecraft/*` npm versions per channel (plain and beta) and the newest changelog. The pins are fetched on first use.

| Input | Description |
|---|---|
| `refresh` | Resolve the pins from upstream again now (default false) |

The result has `updatedAt` plus one record each for `stable` and `preview`, and `sources`: one entry per external data source (and channel) with `inUse` (the cached version in use), `latest` (the newest version seen upstream), `checkedAt` (the last upstream check) and a `note`. `sculk knowledge status` prints the same list.

Every source follows its upstream on its own, without `sculk knowledge update` or a new sculkwire release. Each upstream is asked at most once a day with a cheap metadata request. A tool call never waits longer than it did before: either the check runs in the background and the next call uses the result, or a small download happens on the call that finds a new release. Large downloads (a new bedrock-samples tag, a BDS build, a docs fetch and re-index, changelog articles) run in the background of the MCP server only. A CLI command refreshes only the version pins in the background and exits at most 3 seconds after its output; the next MCP session or `sculk knowledge update` downloads the new builds. `sculk knowledge update` refreshes every source in the foreground, including installed BDS builds. Offline, or when a check or download fails, the last copy keeps working, and the previous copy stays in place until the new one is unpacked and checked.

| Source | Daily check | When a new release appears |
|---|---|---|
| Version pins (`versions.json`) | bedrock-samples tags (`git ls-remote`), npm packuments, BDS download links, changelog list, in the background | The next call gets the new pins; the sources below follow them |
| bedrock-samples | Version pins | The MCP server checks out the new tag in the background; the previous checkout answers until then |
| `@minecraft/*` typings | Version pins | The new builds are downloaded on next use; if that fails, the previous install is used |
| Bedrock Dedicated Server | Version pins | `bds_check`, `gametest_run` and sessions keep the installed build; the MCP server downloads the new one in the background. The two newest builds per channel are kept |
| Changelogs | Version pins (newest article) | The MCP server fetches the articles again in the background |
| minecraft-creator docs | `git ls-remote` of `main` (and the stable pin), in the MCP server's background | The checkout is fetched and re-indexed in the background |
| rockide/schemas | `git ls-remote --tags`, newest `x.y.z` tag | The tag's source tarball is downloaded and switched to |

### docs_search

Searches the official Minecraft Creator docs from Microsoft Learn with BM25. Identifiers such as `minecraft:behavior.tempt` and `getComponent` are matched whole. Each hit has the page title, the heading, the Learn URL and the matching lines. The docs are CC-BY-4.0, so cite the URL.

| Input | Description |
|---|---|
| `query` | What to search for (required) |
| `limit` | Hits to return, 1 to 30 (default 8) |
| `pathPrefix` | Limit the search to part of the docs, e.g. `creator/ScriptAPI` |
| `channel`, `offline` | As above |

### api_lookup

Looks up a Script API symbol in the channel's `@minecraft/*` typings, e.g. `Entity.applyDamage`, `Entity`, `applyDamage`, `world.getDimension` or `@minecraft/server-ui:ActionFormData.button`. Returns the signature, the docs, parameters, what it throws, the privileges, whether it is beta, and the module version that added it. A class lookup lists every member, and inherited members are found through the base classes.

| Input | Description |
|---|---|
| `symbol` | The symbol to look up (required) |
| `module` | Limit to one module, e.g. `@minecraft/server` |
| `limit` | Matches to return, 1 to 50 (default 10) |
| `channel`, `offline` | As above |

### command_lookup

Shows the syntax of a slash command from the engine's command metadata. You get every overload, the parameter types, allowed enum values, the permission level and whether cheats are needed. When nothing matches, `suggestions` lists close names.

| Input | Description |
|---|---|
| `name` | Command name or alias, with or without `/` (required) |
| `channel`, `offline` | As above |

### molang_lookup

Explains a Molang query or math function, e.g. `query.is_baby`, `q.is_baby`, `is_baby` or `math.lerp`. Shows what it does, how many arguments it takes, what it returns, its query sets and the versions it exists in. `exact` says whether the name matched exactly.

| Input | Description |
|---|---|
| `name` | The query or function (required) |
| `limit` | Entries to return, 1 to 100 (default 20) |
| `channel`, `offline` | As above |

### component_lookup

Explains a component such as `minecraft:behavior.tempt` or `minecraft:geometry`. Returns the engine documentation with every property's type, default and description (`docs`), the engine JSON schemas for each `format_version` (`engineSchemas`), and the [rockide/schemas](https://github.com/rockide/schemas) definition with its description (`rockide`).

`rockide.matches` has one entry per scope that defines the id (`server/entity/behaviors`, `server/block/components`, `server/item/components`, client scopes, ...). Each entry summarizes the schema at the newest `format_version` folder not newer than the channel's game version (`selectedVersion`, `newerThanGame` when every folder is newer): description, type and every property with its type, description, default, allowed values (first 50, `enumCount` for the total), minimum, maximum, required and deprecated flags, and nested properties two levels deep. `formatVersions` lists every folder that has the component and `changes` the versions where its schema file changed. `rockide.release` names the release in use, `rockide.commit` its commit and `rockide.latest` the newest release seen upstream. rockide/schemas is fetched at runtime (see Validation); when it is not cached and cannot be fetched, or `offline` is set without a copy, `matches` is empty and `rockide.note` says why.

| Input | Description |
|---|---|
| `id` | The component id (required) |
| `channel`, `offline` | As above |

### vanilla_example

Finds where Mojang's own behavior and resource packs use an identifier, e.g. `minecraft:tameable`. Each example has the file, the line, whether the identifier is used as a key there, and a short excerpt. Uses as a component key come first. `ids` lists the matching vanilla data ids, such as block states and raw ids.

| Input | Description |
|---|---|
| `identifier` | A component, entity, item, block, event or texture key (required) |
| `pack` | `behavior`, `resource` or `both` (default) |
| `limit` | Examples to return, 1 to 50 (default 8) |
| `channel`, `offline` | As above |

### changelog_search

Searches the official Bedrock changelogs, the release changelogs for `stable` and the Beta and Preview changelogs for `preview`. Each hit has the article title, the game version, the date, the URL, the section and the matching lines.

| Input | Description |
|---|---|
| `query` | Keyword or symbol (default empty). May be empty when `from` or `to` is given, and then every article in the range is listed |
| `from` | Lower game version, not included, e.g. `1.26.50` |
| `to` | Upper game version, included, e.g. `1.26.60`. A version covers its previews and hotfixes |
| `limit` | Hits to return, 1 to 50 (default 10) |
| `channel`, `offline` | As above |

## Validation

Both validation tools return `ok` (no diagnostic reaches `fail_on`), `root`, `target` (channel and version), `packs`, `filesChecked`, `checks`, `summary` (errors, warnings, infos), `diagnostics`, `truncated` when `max_diagnostics` cut the list, `schemaSources` (files checked per schema source), `vanilla`, `rockide` (the rockide/schemas copy used: `root`, `release`, `commit`, `latest`, or a `note` when none was) and, for a Regolith project, `regolith` (profile, whether it was built, rgl's message). Every diagnostic has a file, a 1-based range and a stable code.

Schemas come from two sources. The first that covers a file is used:

1. [rockide/schemas](https://github.com/rockide/schemas): community schemas with one folder per `format_version`, routed by rockide's own file patterns (parsed from its `scripts/compile.ts`). sculkwire follows rockide's newest GitHub release: the source tarball of the newest `x.y.z` tag is downloaded into the cache (`<cache>/knowledge/rockide/<tag>/`) on first use, the tags are checked again at most once a day (`git ls-remote --tags`), and `sculk knowledge update` checks at once. A new release is unpacked and checked next to the old copy before it is used; the release asset `schemas.tar.gz` is not used because it holds only compiled bundles without `scripts/compile.ts`. Offline or after a failed check or download the last copy is used; without any copy validation goes on with the engine schemas and `rockide.note` says so.
2. Engine schemas: bedrock-samples `metadata/json_schemas` or any folder with that layout (`engine_schemas_dir`), nearest version not newer than the file's `format_version`.

On vanilla 1.26.60.5 (7862 JSON files) rockide covers 7476 files. The other 386 are texture lists, `texts/languages.json` and manifests; manifests have their own check. Vanilla calibration is cached per samples checkout and schema sources, so a new rockide release is calibrated again.

The order was measured on bedrock-samples 1.26.60.5 (rockide commit `a532d3b`). Errors injected into vanilla entity, block and item files (an unknown component, an unknown field in a component, a wrong value type; 886 cases) were caught 86% of the time with rockide first and 18% with the engine first: the engine dump admits unknown components and fields. False positives on vanilla files held out of calibration (3816 files, calibrated on the other half) went from 15 to 24, all unknown or removed fields in older entity files that full calibration against vanilla then demotes to `schema.gap`. On `test/fixtures` and a real add-on both rockide orders gave the same results; the add-on's flat `match_tool` loot condition with `levels: {range_min}` (the form Mojang documents) was a rockide false positive, now accepted.

These inputs are shared.

| Input | Description |
|---|---|
| `channel` | Target release channel, `stable` (default) or `preview` |
| `fail_on` | `error` (default) or `warning`, the severity that makes `ok` false |
| `max_diagnostics` | How many problems to return at most, errors first (default 200) |
| `samples_root` | A bedrock-samples checkout for vanilla names, script modules, commands and engine schemas (default `SCULKWIRE_SAMPLES`, else the cached checkout for the channel) |
| `typings_dir` | A `node_modules` folder with `@minecraft/*` typings for the script checks |
| `engine_schemas_dir` | An engine schema dump, a bedrock-samples root or the `<area>/<kind>/<version>/` layout |
| `rockide_dir` | A rockide/schemas checkout to use instead of the cached copy |

### validate_pack

Checks every pack in a folder. That can be an add-on folder, a single pack or a Regolith project. It checks JSON syntax as the game reads it, schemas for the file's `format_version`, the manifest, references between files, lang files, `.mcfunction` files and scripts with TypeScript.

| Input | Description |
|---|---|
| `path` | The project, add-on or pack folder (required) |
| `checks` | Run only some of `json`, `manifest`, `schema`, `reference`, `lang`, `mcfunction` and `typescript` (default all) |
| `regolith` | For a Regolith project, `auto` (default, build with rgl when the profile runs filters), `build` or `source` |

### validate_file

Checks one file in the context of its pack and the sibling packs, and returns only that file's diagnostics. Paths are relative to the returned `root`.

| Input | Description |
|---|---|
| `path` | A file inside a pack (required) |
| `content` | Unsaved text to check instead of the file on disk |

## Bedrock Dedicated Server

These tools download Bedrock Dedicated Server on first use. It runs on Linux and Windows x64. Pass `acceptEula: true` once to record that the user accepted the [Minecraft EULA](https://www.minecraft.net/eula), which is needed before the first download. `channel` picks the server build, `stable` (default) or `preview`.

### bds_check

Loads your packs into a throwaway server, waits for `Server started`, lets it run, then stops it. Returns every content log, console and script error (with the script's file and line) as diagnostics mapped back to your files, plus `summary`, `exitCode`, `serverVersion`, `durationMs` and `rawLogPath`.

A Regolith project whose profile runs filters is built with rgl first, and the server loads the built packs, the same way `validate_pack` and `game_launch` build. Diagnostics still point at the files you edit: a built file that also exists in the source pack is reported there (on the matching source line when a filter changed it), and generated JavaScript with a source map is reported at the original, such as `data/scripts/main.ts`. A generated file without a source map is reported in the build output, and the message says so. When rgl fails, the result has `status: "build-failed"`, one `regolith.build-failed` error with rgl's output, and no server starts. `keep` keeps the build folder too.

| Input | Description |
|---|---|
| `path` | Project or pack folder (required) |
| `settleMs` | How long to run after `Server started`, 0 to 120000 (default 8000) |
| `keep` | Keep the server instance folder |
| `channel`, `acceptEula` | As above |

### gametest_run

Runs your GameTests on a throwaway server with no game window. Returns `passed`, `failed`, `total`, a result per test, `runTimedOut` and `missingTags`, and points each failure at the `register()` call of the test. The exit code is 1 when any test failed or none ran. A Regolith project is built with rgl first, as in `bds_check`; when the build fails no test runs and `diagnostics` holds the `regolith.build-failed` error.

| Input | Description |
|---|---|
| `path` | Project or pack folder (required) |
| `tags` | Which tests to run (default `["suite:all"]`) |
| `mode` | `automation` (default, through `test_config.json`) or `command` (`gametest runset`) |
| `timeoutMs` | Give up after this long, 5000 to 3600000 (default 300000) |
| `channel`, `acceptEula` | As above |

### bds_session_start

Starts a server that keeps running, with your packs attached and the script debugger connected. Returns the session `id` for the tools below, plus the state, server version, port, instance folder, packs and debugger state. A Regolith project whose profile runs filters is built with rgl first and the world links the build output; `reload` through `bds_session_command` builds again, so source edits apply (in `symlink` mode). A failed build stops the start, or the reload with the previous build still loaded, with the `regolith.build-failed` diagnostic.

| Input | Description |
|---|---|
| `path` | Project or pack folder (required) |
| `packMode` | `symlink` (default, so edits show up after a reload) or `copy` |
| `debugger` | Attach the script debugger (default true) |
| `channel`, `acceptEula` | As above |

### bds_session_command

Runs a server command in a session, with or without the leading slash, and returns the console `lines` it printed. `reload` reloads scripts and functions, and `reload all` reloads packs too.

| Input | Description |
|---|---|
| `id` | Session id (required) |
| `command` | The command (required) |
| `via` | `console` (default) or `debugger` |
| `maxMs` | Longest wait for output, 100 to 60000 (default 5000) |

### bds_session_logs

Returns the console lines after the cursor `since`, plus the problems found in them. Pass the returned `next` as `since` to continue.

| Input | Description |
|---|---|
| `id` | Session id (required) |
| `since` | Cursor (default 0, from the start) |
| `limit` | Lines to return, 1 to 5000 (default 500) |

### bds_session_stop

Stops the server and returns its exit code, every problem from the whole run and the raw log path.

| Input | Description |
|---|---|
| `id` | Session id (required) |

### script_profile

Profiles your scripts through the session's debugger and returns the top functions by self time, with their file, line, self and total time.

| Input | Description |
|---|---|
| `id` | Session id (required) |
| `action` | `capture` (default) starts, optionally runs `command`, waits `durationMs` and stops. `start` and `stop` drive it by hand |
| `durationMs` | Capture length, 100 to 300000 (default 5000) |
| `command` | A command to run right after the profiler starts (capture only) |
| `limit` | Functions to return, 1 to 200 (default 20) |

## Game Client

These tools drive the real Minecraft client. See [Game Client Setup](client.md) for supported installs and platforms.

### game_launch

Starts the game of one detected install (Windows, mcbe-gdk-installer, a Wine or Proton prefix such as Flarial, or `SCULKWIRE_MINECRAFT_DIR`) in a fresh test world named `sculkwire-<name>`, with your packs and the sculkwire helper pack turned on. The world is flat and creative, has cheats on, keeps time, weather and mob spawning frozen, and is single-player only (no LAN, Xbox Live or platform broadcast), so nobody can join it. The script debugger attaches by itself. Only the chosen install's game is managed, so a game the user plays from another launcher is left alone. On Linux the agent's input stays inside gamescope; on Windows it uses the system keyboard and mouse while the game window is in the foreground and stops when you switch away (see [Platform Support](client.md#platform-support)).

A Regolith project whose profile runs filters is built with rgl first, and the built packs are deployed, so scripts produced by filters such as a TypeScript compiler are what the game loads. A build failure stops the launch and returns the rgl message instead of deploying the source packs. The call returns once the world is loaded, usually in 1 to 2 minutes. The result is the same as `game_status`, and its `packs` list names each deployed folder, its absolute path, and whether the folder holds build output.

If the world join races Microsoft sign-in (the game stops on "You need to authenticate to Microsoft services"), it walks the menus back into the test world without relaunching the game (Back to menu, out of any other screen, Play, the test world), and `game_status` reports it as `joinRecovery`. See [Sign-In Race at Launch](client.md#sign-in-race-at-launch). If sculkwire cannot start the game itself, it returns right away with `manualSteps` for the user, and `game_status` shows when the game is ready.

| Input | Description |
|---|---|
| `project` | Your add-on or pack folder |
| `deploy` | Copy packs that are not in `development_*_packs` yet (default true). Copies go to folders named `sculkwire_<project folder>_<pack folder>`, so projects with the same `packs/BP` layout do not overwrite each other, and `game_stop` removes only the folders this launch copied. Each deployed uuid ends up in one folder of the project, see [One Folder per Pack UUID](client.md#one-folder-per-pack-uuid) |
| `display` | `window` (Linux: a visible gamescope window; Windows: the game's own window), `headless` (Linux: no window, muted) or `desktop` (the launcher's own window; on Windows the same as `window`). The default is `window` on Windows. On Linux it is `window` when gamescope can run the install and there is a desktop, `headless` with no desktop, and `desktop` otherwise. A mode that cannot run falls back with a note: to `desktop` on Linux, to `window` for `headless` on Windows |
| `mute` | Silence the game's audio (default on in `headless` mode only). Linux: a silent PipeWire or PulseAudio sink. Windows: the game's audio sessions, unmuted again by `game_stop`; without an audio device or session the result has a note instead |
| `world` | World name, prefixed with `sculkwire-` (default `bridge`, replaced on each launch) |
| `difficulty` | `peaceful`, `easy`, `normal` (default) or `hard`. Peaceful removes hostile mobs such as zombies |
| `betaApis` | Turn on the Beta APIs experiment |
| `width`, `height` | Game resolution in `window` and `headless` mode on Linux, 320 to 3840 by 240 to 2160 (default 1280 by 720). Windows sizes the game window itself |
| `fps` | Frame rate in `window` and `headless` mode on Linux, 10 to 240 (default 60) |

### game_status

Shows whether the game is running (`running`, `ready`), the display `mode`, the game `version`, the `install`, the `world`, the `project` and its `packs`, the script `debugger` and `/connect` state, `manualSteps` still to do by hand, `deployDiagnostics` (a `client.duplicate-pack-uuid` warning for each pack folder that is not a copy of the project but shares a deployed pack's uuid), and `joinRecovery` after a sign-in race (`attempts`, `recovered`, `via` with the presses, `log`, `screenshot`). Each pack entry gives the pack name, uuid, kind, the deployed folder, its absolute path, and whether it is rgl build output. A manifest name that is a lang key such as `pack.name` is shown as its value in the pack's `texts/en_US.lang`.

No inputs.

### game_command

Runs a slash command in the game and returns `ok`, the `output` lines and the route it took. Through `/connect` the result also has `statusCode` and the structured `body`. Through the script debugger it runs server commands, and the output comes from the game's prints.

| Input | Description |
|---|---|
| `command` | Command line, with or without the leading slash (required) |
| `via` | `auto` (default, `/connect` when a client is attached, else the debugger), `connect` or `debugger` |

### game_reload

Copies the project's current packs into the game again, building a Regolith project with rgl first, then runs `/reload`, or `/reload all` with `all: true`. Use `all: true` after adding or changing blocks, items, entities or other JSON, since `/reload` only restarts scripts and functions and `/reload all` rejoins the world. A failed rgl build stops the reload with rgl's message. The redeploy follows the same one-folder-per-uuid rule as `game_launch`. Returns the `redeployed` folders, the `command` result and the `diagnostics` the reload logged, after any `client.duplicate-pack-uuid` warnings.

| Input | Description |
|---|---|
| `all` | Reload every pack (default false) |

### game_log

Returns content log and script errors since the last call as `diagnostics` mapped to your files, plus a `summary`. Errors the game repeats every frame are shown once. The log is read from the game's engine log, which the game writes as it goes, so errors at load time (a missing script main file, a broken JSON file) show up in the first call after `game_launch`. A line the script debugger also sends, such as a script's `console.warn`, is reported once.

| Input | Description |
|---|---|
| `includeText` | Also return the log text in content-log format as `text` (default false) |

### game_screenshot

Takes a screenshot of what the game shows now and returns the image, its `path` and its size in `bytes`. Works in `window` and `headless` mode on Linux, and on Windows. On Windows it captures the game window's client area while it is covered; when the game hands back an empty (one-colour) frame it copies the client area from the screen, which needs the game window in the foreground, and fails saying so otherwise.

| Input | Description |
|---|---|
| `path` | Where to save the PNG (default under sculkwire's data folder) |

### game_query

Reads the world through the helper pack and returns it as `result`.

| `kind` | Returns |
|---|---|
| `player` | Players with position, rotation and game mode |
| `entities` | Entities around the player or `x`, `y`, `z`, with id, type, position, tags, health and active effects (0-based amplifier, duration in ticks) |
| `blocks` | Non-air blocks in a cube around the player or `x`, `y`, `z`, with their states |
| `block` | The block at `x`, `y`, `z` |
| `ping` | `pong` when the helper pack answers |

| Input | Description |
|---|---|
| `kind` | One of the kinds above (required) |
| `type` | Only this entity or block type id |
| `radius` | 0 to 256. Entities default to 16 blocks. Blocks default to 4 and are capped at 16 |
| `limit` | Entities to return, 1 to 200 (default 50) |
| `x`, `y`, `z` | The point to search around instead of the player |
| `dimension` | Dimension of `x`, `y`, `z` (default the player's) |

### game_registry

Lists every block, item or mob id the running game knows, including ones from your add-on, through `/connect` data requests.

| Input | Description |
|---|---|
| `kind` | `block`, `item` or `mob` (required) |

### game_input

Presses keys, types text, clicks or moves the mouse in the game, like a player would. Coordinates are pixels in the screenshot. On Linux input goes to the game's own gamescope display and never touches your desktop. On Windows it brings the game window to the foreground, then uses the system keyboard and mouse; it fails with `the game window is not in the foreground` when the window loses it before the input is sent. With the in-game agent attached, keys, text and left/right clicks go through the game's own UI instead ([`game_ui`](#game_ui)), which works in the background and on Windows without the foreground; `move` and a middle click always take the route above.

| Input | Description |
|---|---|
| `action` | `key`, `type`, `click` or `move` (required) |
| `keys` | For `key`. xdotool key names, e.g. `w`, `space`, `Escape`, `Return`, `Shift_L`, `F3`, chords such as `ctrl+a`, several separated by spaces. Windows takes the same names; an unknown name fails with the list of valid ones |
| `text` | For `type` |
| `x`, `y` | For `click` and `move` |
| `button` | For `click`. 1 (left, default), 2 (middle) or 3 (right) |

### game_input_lock

Keeps your own keyboard and mouse out of the game while sculkwire plays through the in-game agent, so a click or key in the game window cannot disturb an action. While locked, the game also does not pause when its window loses focus, and the action bar shows a badge. F9 in the game always works: it hands control to you, which stops the running `player_act` action with `the user took control (F9)` and pauses a `play` job, and pressing it again gives control back. Needs `engine_attach`.

| Input | Description |
|---|---|
| `mode` | `on` locks now, `off` never locks, `auto` (the default) locks while a `player_act` action or `play` job runs. Omit it to read the state |

The result carries these fields.

| Field | Meaning |
|---|---|
| `locked` | Your input is kept out of the game now |
| `mode` | `on`, `off` or `auto` |
| `by` | Who made the last change: `agent` (a lock call) or `user` (F9) |
| `user` | You hold control after F9 and have not given it back |
| `active` | Some connection declared an action or play job running, which is what `auto` locks for |
| `window` | The game window is hooked. False until the first frame after injection |
| `dropped` | Input events dropped since injection |
| `focusLost`, `focusKept` | Focus-loss events seen, and how many the lock kept from the game |
| `hostFocused` | The game window has focus on your desktop, as sculkwire last reported it. True until a report says otherwise, and true when nothing watches the desktop |
| `focusWatch` | The desktop focus watcher: `backend` (`kwin`, `x11`, `windows` or `none`), the `gamePid` it matches, whether it is `running`, the number of `reports`, the `activePid` of the active window in the last report, `focused`, and the start `error` if it failed. On Linux it is absent when no `display: window` game runs. On Windows every launched game reports `backend: windows` with `running: false`, because the game sees its own focus |
| `pad` | The controller gate: `hooked` polled functions, `reads`, `active` reads with a pressed button or moved stick, and `hidden` reads the agent turned neutral |
| `keysHidden` | Polled key-state answers the agent turned into "not pressed" |
| `shift` | Shift presses by path, each `[background, foreground]`: `message` counts window messages, `raw` counts raw input |
| `wineFocused`, `wineForeground` | Diagnostic only: focus and foreground as the game process sees them. Under gamescope Wine never learns about desktop focus changes, so these stay true there; on Windows they are the real window focus. `hostFocused` is the desktop focus sculkwire reported |
| `camera` | The game's own camera permission the lock uses: `disabled` while locked in a world, `enabled` otherwise, `null` when it could not be set |

The keyboard route cannot be locked, because its keys and mouse reach the game the same way as yours. Without an attached agent the call fails and says to attach or to launch with `display: headless`.

### game_ui

Drives the game's own UI from inside the process: the screen, its controls, and keys, text, clicks and scrolling. This is how a menu is driven without the keyboard and mouse route, which only reaches the game while its window is in the foreground. It works in the background, on Linux and Windows alike, and needs no loaded world, so the title screen, the Play screen and Settings are reachable while the game sits in a menu. Every input is refused on a store, Marketplace, Minecoins, Dressing Room or persona editor screen except `Escape`, which leaves it. On an OreUI page (every one is named `ui://./hbui/index.html`) the agent reads the page's route from the game's own router, and refuses clicks, `Return` and `space` while the route cannot be read or is not one of the Play screen's (`/play`, `/create-new-world`, `/edit-world`) or the option pages of Settings (`/settings`, `/oreui-settings/` `game`, `video`, `audio`, `general`, `accessibility`, `keyboard-and-mouse`, `controller`, `touch`, `creator`); Multiplayer, Party, Account and Global Resources are refused. Without `engine_attach` it connects to an agent that is already listening on the agent port.

| Input | Description |
|---|---|
| `action` | `screen`, `controls`, `press`, `key`, `text`, `click` or `scroll` (required) |
| `name` | `press`: the control's name, as `controls` lists it |
| `filter` | `controls`: only names or labels containing this |
| `key` | `key`: one key or chord, with the key names `game_input` takes, e.g. `Escape`, `Return`, `space`, `F3`, `ctrl+a` |
| `keyAction` | `key`: `press` (default), `down` or `up` |
| `text` | `text`: what to type into the focused text box |
| `x`, `y` | `click` and `scroll`: client pixels, the same frame a screenshot shows |
| `button` | `click`: `left` (default) or `right` |
| `delta` | `scroll`: whole notches, positive up |

The result has `screen` (`name`, `stack` bottom to top, `modal`, and on an OreUI page its `route`, `null` when unread) for `screen`, `controls` for `controls`, each with `name`, `type` (`button`, `toggle`, `slider`, `text`, `label`, `list` or `other`), `rect` (`[x, y, width, height]`), `text` and `enabled`; and `pressed`, `key` (with `keyAction`), `typed` (characters), `click` (`x`, `y`, `button`) or `scroll` (`x`, `y`, `delta`) for the inputs. When the UI tree cannot be read, `controls` and `press` answer `anchor_missing` and `click` remains. A click while the game has not read the mouse for over 500 ms answers `anchor_missing` `ui.click_input`.

### game_settings

Reads or changes the game's own options, named by their `options.txt` save tag (`gfx_viewdistance`, `game_thirdperson`, `showcoordinates`). Through the running game when the agent is attached, so a change applies at once and the game saves it itself; in `options.txt` when it is not, which applies at the next launch and can only change options the game already saved. Every value sculkwire changes is put back by `game_stop`. The script debugger, WebSocket and content-log keys belong to the bridge: `game_launch` writes them and `game_stop` restores them, and this tool refuses them.

| Input | Description |
|---|---|
| `action` | `list` every option, `get` one, or `set` one (required) |
| `id` | `get` and `set`: the option's `options.txt` tag (required). `list`: an id substring, like `filter` |
| `value` | `set`: the new value, a boolean, number or string (required) |
| `filter` | `list`: case-insensitive id substring |

The result has `source` (`engine` or `options.txt`), and for `list` the `settings` array, each with `id`, `type` (`bool`, `int`, `float`, `string` or `enum`), `value`, and `min`/`max` or `values` where the game gives them. `get` returns `setting`. `set` returns `setting`, the `previous` value, `appliesAt` (`now` or `next launch`) and `saved`: `true` when the value reached `options.txt`, which it always does on the file route, `false` when the change is live only and is lost on restart unless the game saves later, and absent when the agent does not report it. With an attached agent a value outside the option's range or allowed values is an `invalid_params` failure.

### world_settings

Reads or changes a test world: game rules, difficulty, game type, time and weather. Through the running game when the agent is attached, the answer being what the loaded level itself says and a change applied the way the game applies its own command; otherwise sculkwire reads and rewrites `level.dat`, and only for a `sculkwire-*` world no game has loaded. Only `sculkwire-*` worlds are ever changed. World changes need no restore: a test world is disposable and the next launch replaces it.

| Input | Description |
|---|---|
| `action` | `get` or `set` (required) |
| `world` | `get` and `set` without an agent: world name, `sculkwire-` added when missing (default: the loaded world, else the newest `sculkwire-*` world) |
| `gamerules` | `set`: game rule values, e.g. `{ "keepinventory": true }` |
| `difficulty` | `set`: `peaceful`, `easy`, `normal` or `hard` |
| `gameType` | `set`: `survival`, `creative`, `adventure` or `spectator` |
| `time` | `set`: game ticks, 0 to 24000 in a day |
| `weather` | `set`: `{ "rain": true, "lightning": false }`. In `level.dat` it is written as rain and lightning levels with a five-day timer |

The result has `source` (`engine` or `level.dat`), the `world` (`name`, and for a file read `levelId` and `dir`), and `settings`: `name`, `seed` (as text, because it is a 64-bit integer), `gameType`, `difficulty`, `cheats`, `education`, `experiments`, `gamerules`, `time`, `dayCycle`, `weather`, `spawn` and `dimension`. A field the engine cannot read is `null`, never a guess. In `level.dat` mode only the game rules the file stores by name are reported and settable.

### game_stop

Closes the game, closes the bridge and puts back the `options.txt` keys sculkwire changed. It stops a running play job first. The result has `stopped`, `message` and `restoredOptions`. The message says what happened, for example `closed the game (1 process(es))`, `the game was not running`, or that the game had to be forced to quit.

No inputs.

## Player

These tools control the player in the game and read its state.

### player_act

Controls the player like a person playing, run in a fast loop by sculkwire, so the agent does not wait on the model between steps. Pass up to 50 actions to run them in order in one call. The call stops at the first failed action unless `continueOnError` is set. Needs `game_launch` with `display: window` or `headless` on Linux, or any display on Windows. It refuses to run while an [input provider](extensions.md#input-provider) reports the simulation paused, because the player cannot move then. When the MCP client cancels the call or the call times out, the running action stops and every key and mouse button is let go. A client that sends a progress token gets a progress notification after each action.

On Windows the keyboard route uses the system keyboard and mouse. The call brings the game window to the foreground once when it starts and never takes the focus back in the middle. When you switch to another window, every key and button is let go, the running action stops with `the game window is not in the foreground`, and a `play` job pauses until the game window is in the foreground again or `player_job stop` ends it.

On the engine route the input provider's input lock keeps your own keyboard and mouse out of the game while actions or a `play` job run. When you press F9 to take control, the running action stops with `the user took control (F9)` and a `play` job pauses until F9 gives control back or `player_job stop` ends it.

| Input | Description |
|---|---|
| `actions` | 1 to 50 actions from the tables below, run in order (required) |
| `continueOnError` | Keep going after a failed action (default false) |
| `input` | `auto` (default, the engine route when the input provider answers, else keyboard and mouse), `engine` (fails when the provider cannot be used) or `keyboard`. See the input routes below |

There are two input routes. The keyboard route sends held keys, mouse buttons and relative mouse motion: through `xdotool` into the game's own gamescope display on Linux, through `SendInput` on Windows. The engine route goes through the in-process [input provider](extensions.md#input-provider): the built-in one drives the [in-game agent](#engine) once `engine_attach` has loaded it, and an extension may install its own instead. Through it sculkwire sets the view every frame, holds a movement vector, asks for an attack or a use of the held item, and reads the player's position, rotation, velocity, ground contact and health from the provider's motion stream (the agent's tick stream, one tick old) instead of the helper pack (50 to 100 ms old there). Entities, the block and entity under the crosshair, the held item and the hotbar slot still come from the helper pack. `auto` takes the engine route when the provider answers and the keyboard otherwise. `engine` fails when no provider can be used. When the engine route fails during an action, every input is let go, the action runs again from the start on the keyboard, and its message says so. The call stays on the keyboard after that. Each action's result names the route that carried it out in `input`, and the text summary starts with the route the call picked. `mine`, `select_slot` and `hold` always use the keyboard and mouse buttons.

| Action | What it does |
|---|---|
| `move_to` | Walks to `x`, `z`, picking the WASD keys from the direction to the goal relative to the view, so it walks while it turns. It jumps over steps. `sprint` and `radius` are optional. `look` is an entity id to keep the crosshair on while walking, and then the player strafes (and sprints when the goal is ahead). When the helper pack answers and the straight line is blocked (a wall, a hole, a step over one block, lava), or the straight walk gets stuck, it plans a path like `goto` and the message says so |
| `goto` | Finds a way to `x`, `z` (and `y` when given) or to an `entity` (followed while it moves) over the blocks around the player, then walks it like a player. See [Pathfinding](#pathfinding) below. `radius` (default 0.7, 2 for an entity), `sprint` (default on, on straight stretches), `look` and `timeoutMs` (default 60000) are optional. The message gives the time, blocks planned, jumps, gap jumps, doors opened, replans and the damage taken |
| `look_at` | Turns to a point (`x`, `y`, `z`), an entity id (followed while it moves), or a `yaw` and `pitch`. The message says how long the turn took |
| `attack` | Hits an entity (by id, or the nearest of a `type`) `hits` times. The crosshair stays on it every frame while the player walks or sprints into reach, and it clicks whenever the entity is under the crosshair and its last hit's invulnerability is over |
| `shoot` | Throws or shoots at an entity (by id, or the nearest of a `type`) with the held snowball, egg, ender pearl, bow or trident. The crosshair follows the ballistic intercept every frame, solved again from the entity's latest position and velocity, and the shot goes off when the aim is inside the target. It reports a hit or a miss with the landing point from the game's impact log. `shots` retries until one hits, `holdMs` is the bow or trident draw time (default 1100) |
| `use_item` | Right-clicks with the held item, held for `holdMs` (a bow draw, eating) |
| `mine` | Holds left click for `holdMs` |
| `select_slot` | Picks hotbar slot 1 to 9 |
| `jump`, `sneak`, `hold`, `wait` | Jumps once, turns sneaking on or off, holds keys for a time, or waits |
| `fight` | Melee against a `target` (entity id or type, default the nearest hostile mob within `radius`, 16 by default), then the next one when `all` (default unless the target is an id). See [Skills](#skills) below. `crits` (default on) and `timeoutMs` (default 60000) are optional. The message lists the kills, hits and critical hits |
| `flee` | Sprints away `from` an entity id or type (default every hostile mob within 24 blocks) until every threat is `distance` blocks away (default 12) |
| `eat` | Eats the best food in the hotbar for the current food level, or the food in `slot`, and confirms it from the food level or the stack. Fails when the food bar is full |
| `use_on` | Hits each entity of a `target` type (or one entity id) once with the held item: thrown or shot like `shoot` when it is a projectile, a melee hit otherwise |
| `play` | Pursues a `goal` on its own, choosing among the skills every 250 ms (see below) |

Each action returns whether it succeeded, a short message, how long it took and the input route that carried it out (`input`), followed by the player's final state (`state`). A call that starts `play` also returns `job` and `status: "running"`.

These are the inputs of each action. `action` names the action and is always required.

| Action | Inputs |
|---|---|
| `move_to` | `x`, `z` (required), `y`. `radius` 0.3 to 10 (default 0.7). `sprint` (default false). `look`, an entity id. `timeoutMs` 500 to 300000 (default 30000) |
| `goto` | `x`, `z` and optional `y` (the height to arrive at, any height counts without it), or `entity`. `radius` 0.3 to 10 (default 0.7, 2 for an entity). `sprint` (default true). `look`. `timeoutMs` 500 to 300000 (default 60000) |
| `look_at` | One of `entity` (an id from `game_query`), `x`, `y`, `z`, or `yaw` (0 is south, +Z, and 90 is west, -X) and `pitch` (-90 up to 90 down) |
| `attack` | `entity` (default the nearest entity, of `type` when given), `type` such as `minecraft:zombie`, `hits` 1 to 100 (default 1), `timeoutMs` 500 to 300000 (default 30000) |
| `shoot` | `entity` (default the nearest of `type` within 64 blocks), `type`, `projectile` (`snowball`, `egg`, `ender_pearl`, `arrow` or `trident`, default from the held item, which must match), `holdMs` 0 to 30000 (default 1100 for a bow or trident, a short click for thrown items), `shots` 1 to 20 (default 1), `timeoutMs` aiming time per shot, 500 to 300000 (default 15000) |
| `use_item` | `holdMs` 0 to 30000 (default 100) |
| `mine` | `holdMs` 0 to 30000 (default 1000) |
| `select_slot` | `slot` 1 to 9 (required) |
| `jump` | None |
| `sneak` | `on` (required) |
| `hold` | `keys`, one or more xdotool key names such as `w`, `a`, `space` (required; the same names on Windows), and `ms` 0 to 30000 (required) |
| `wait` | `ms` 0 to 60000 (required) |
| `fight` | `target`, an entity id or type such as `zombie` or `minecraft:skeleton` (default the nearest hostile mob). `all` (default true unless `target` is an id). `radius` 1 to 64 (default 16). `crits` (default true). `timeoutMs` 500 to 300000 (default 60000) |
| `flee` | `from`, an entity id or type (default every hostile mob within 24 blocks). `distance` 2 to 64 (default 12). `timeoutMs` 500 to 300000 (default 8000) |
| `eat` | `slot` 1 to 9 (default the best food for the current food level). `timeoutMs` 500 to 30000 (default 3100) |
| `use_on` | `target`, an entity id or type (required). `all` (default true for a type). `radius` 1 to 64 (default 24). `timeoutMs` 500 to 300000 (default 60000) |
| `play` | See [play](#play) |

#### Pathfinding

`goto` reads the blocks around the player from the helper pack's `grid` query, 16-block sections at a time, and keeps them, so walking on only fetches the sections it has not seen or that are older than 30 seconds. Each block falls in one class, which is passable (air, plants, torches, carpets), solid, bottom slab, stairs, water, lava, dangerous (fire, cactus, magma, powder snow, berry bush, wither rose, campfire, cobweb, dripstone), climbable (ladder, vines, scaffolding), closed door, closed fence gate, open door or gate, fence or wall, or not loaded. Iron and copper doors count as solid, since a hand cannot open them.

The scan never stalls the game. The helper reads one block of a region and asks the game whether the region holds any other type (`containsBlock`, answered natively). A uniform region is one entry in the reply, and a mixed one is split in two, layers first, down to small pieces it reads block by block. It works through the pending queries for at most 4 ms of script time per game tick and answers when a query is done. The reply lists regions (class and two corners), not blocks. Sections are asked for nearest first, two per query, all in flight at once. Planning starts as soon as the blocks within 6 of the player are in (waiting up to 150 ms more for the rest of the window), and a partial path made that way is planned again as more sections arrive. On a flat world the 32 sections of a planning window cost 17 ms of script time over a few ticks (551 ms before, 218 ms of it in one tick), and a section of rough terrain costs about 22 ms spread over 5 or 6 ticks.

The planner is A* over a 48 by 48 block window around the player, 6 blocks up and down, stretched toward the goal. It knows the moves of a Bedrock player. It walks in eight directions without cutting corners, steps up one block with a jump, walks up stairs and slabs without one, drops up to 3 blocks (which costs no health) and any height into water, swims (at the surface where it can, since under water costs more), climbs ladders and vines, opens wooden doors and fence gates, and sprint-jumps gaps of 1 to 3 blocks from the edge, landing level or one lower. A 3-block gap needs a block of run-up. A 2-block gap needs none, so a line of 1-block pillars is a chain of jumps. It never steps into lava, fire or cactus and pays extra to pass next to them, so a way around a lava strip wins over a jump across it. Falls and gap jumps cost more than walking. A goal outside the window gives a partial path toward it, and the player plans again from its end. A goal inside the window that no move reaches gives a message with the closest reachable spot.

The player follows the path continuously. The crosshair looks about 3.5 blocks ahead along it, moving like the hand described below, while the movement steers toward a point just ahead on the path. It sprints on straight stretches of four blocks or more, jumps just before a one-block step and at the edge of a gap, and holds jump in water and on ladders, also to get off the top of one. In the air after a gap jump it steers the landing like a player. It predicts where the jump comes down from the speed and the fall still to go, holds forward while that is short of the middle of the landing block, lets go when it is on it, and pulls back when the jump would carry past, so a sprint jump stops on a 1-block pillar. Climbing up a ladder it pushes into the ladder's wall, and climbing down it lets go of every key, since walking off a ladder is a fall. A ladder only catches a player whose feet come down inside its block, and a player standing on the ledge above tips off about at the ladder's middle, so stepping onto the top of a ladder it stops just short of that point and edges over in taps of the walk key about one game tick long. The stop allows for the speed the game reports being what is left after ground friction, so the player slides about 0.7 blocks after letting go of a walk. Falling into the ladder and climbing down it, it steers back over the ladder's middle when it drifts more than 0.2 blocks off. It stops to look at a closed door or gate and right-clicks it open, and once past it and clear of it turns back and closes it (when walking to a place, not when following an entity). An open door is a thin panel at one edge of its block, so it aims at the middle first and then near each edge until the click lands. A door stays on the list to close when the player plans again right after it. It plans again when it leaves the path by more than 1.6 blocks, falls below it, or makes no headway for 2 seconds (after one jump at 1 second, as a player bumping an edge would, but never on the ledge above a ladder), and when an entity target moves 1.5 blocks from where the path ends.

The mouse moves like a hand. A loop at 120 Hz sends small relative steps along minimum-jerk submovements, and a turn's duration follows Fitts' law, from about 150 ms for a small nudge to 450 ms for a turn around. Large turns land a few percent long or short and get a short correction, with a slight arc and jitter. The loop corrects from the streamed state while it moves. It adds the steps sent since that state left the game, so it neither waits for the view to settle nor counts a step twice. The mouse sensitivity and the input delay are learned from every turn. Keys, sprint, jumps and the mouse run at the same time, and the state streams every game tick while an action runs (every second tick when idle). Input goes through one long-lived helper process per game (`xdotool` on Linux, a PowerShell `SendInput` helper on Windows), so a step costs no process start.

On the engine route the camera runs the same curve, overshoot, correction and jitter, but each frame sends the view itself instead of a mouse step. The commanded view is exact, so there is no sensitivity to learn and no delay to predict. When something else turns the player (a respawn or a teleport), the camera starts again from the rotation the motion stream reports. Movement is a forward and strafe vector toward the goal, sent again every 300 ms so a provider can let go by itself when updates stop. `attack` on this route swings as soon as the exact view and the distance put the target in reach, counts only swings that the provider reports as hitting the target, and the message lists the swings that missed.

`shoot` models each projectile per game tick with the vanilla update order (move, multiply the velocity by the drag, subtract gravity). The values, in blocks per tick, come from the vanilla behavior pack. Snowball and egg launch at 1.5 with gravity 0.03 and drag 0.99. An ender pearl launches at 1.5 with gravity 0.025 and no drag. A trident launches at 4 with gravity 0.1 and drag 0.99. A fully drawn bow launches its arrow at 3, as in Java Edition, with the arrow's gravity 0.05 and drag 0.99.

#### Skills

Skills are whole behaviors that run until they are done or something else takes over. `play` stops one the moment it picks another, and every key is let go in between.

`fight` takes the hardest-hitting weapon in the hotbar (swords and axes by damage) and keeps the crosshair on the middle of the target's body. It sprints in when the target is more than 3.5 blocks away and steps around anything else under the crosshair. Toward an archer more than 6 blocks away it runs from cover to cover when the blocks around have some (a standing spot within 6 blocks, at least 1.5 blocks nearer the archer, with a solid block between the archer's eyes and the player's chest, read from the navigation grid every 1.5 seconds), and otherwise weaves up to 50 degrees either side so the arrows miss. When the straight approach is blocked (a wall, a ledge, a hole) it finds a way to the target like `goto`. Bedrock has no attack-strength cooldown for any weapon, but a struck mob ignores hits for 10 ticks, so the next swing is timed to land 0.5 seconds after the last hit and never sooner. Between swings it hits and steps back: while the swing cools down it backs out of the mob's reach (plus 0.9) whenever the mob would get in, with its attack ready, before the swing is ready, holds and circles when it would not, and steps in to the edge of its own 3-block reach as the swing comes ready, then stands there (with other mobs around too) and lets the target walk in, so it swings first and the knockback pushes the mob out again. It jumps about 400 ms before the next hit is due, only while facing a lone target and only when no melee mob can hit the player (in its reach with its attack ready) within 700 ms, the time the jump leaves it unable to swing, and swings on the way down, for a critical hit (150 % damage), and swings plainly when the jump does not work out within 0.7 seconds. After a sprint hit it lets go of forward for 120 ms (a W-tap), so the next hit sprints again and knocks back. Zombies, spiders and most other melee mobs attack with the game's box reach (`minecraft:behavior.melee_box_attack`): their collision box grown 0.8 blocks on x and z has to overlap the player's, so a zombie reaches 1.4 blocks centre to centre straight along x or z and 1.98 on a diagonal (a spider 1.8 to 2.55), and it attacks at most once a second. `fight` uses the reach in the direction the mob stands, and when the health drops with exactly one melee mob in reach (and no archer in range) it counts that mob's 1-second cooldown from then and stands its ground inside the mob's reach until the cooldown is nearly over. With a shield in the off hand it raises it (sneaks) when a hit cannot be avoided: a melee mob in front (the shield covers the front half), in or a step from its reach with its attack ready, while the swing is not ready and the player cannot back off, or a spider in the air within 3.5 blocks, and lowers it for every swing. A player who can back off does that instead, since a shield raised 100 to 200 ms before a zombie's hit did not block it in the bench and sneaking is slower than a zombie (2.3 blocks a second). It never blocks an axe (a vindicator or a piglin brute), since an axe hit disables the shield for 5 seconds. Against a spider it does not jump and holds its swing while the spider leaps or climbs, hitting it as it lands. A swing counts as a hit when the camera is on the target within reach.

`fight` swings when the target is within reach and the view is on it. On the engine route the view in the motion stream decides. The keyboard route reads it from the helper 150 to 250 ms late (tens of degrees off at close range while the player and the mob move), and the click lands after the mouse steps already sent, so the view those steps will give decides. The player's streamed position is as late, so on the keyboard route the camera and the footwork carry it forward by the velocity over that latency. The keyboard cannot tell what a click struck, so a click counts as a hit once the target's health reading drops. Until then a melee mob is taken as struck (the footwork backs off while the swing cools down), but a creeper is not, so a strike that missed is followed by the next swing instead of a retreat. Without a drop after 0.4 seconds the hand may swing again, and after 0.9 seconds the click counts as a miss.

Against a creeper `fight` closes in and strikes. The creeper's data says the fuse lights within 2.5 blocks and goes out past 6, but measured in the game (horizontal centre distance, as `fight` reads it) it lights at about 3 blocks (at 2.9, not at 3.1) and goes out once the player is 7 blocks away (at 6.2 it still blows). The helper pack reports every creeper's fuse from the creeper's own entity events (`minecraft:start_exploding` and `minecraft:stop_exploding`), lit or not and how many ticks it has burned, and `fight` takes that as the answer. It meets a creeper that comes on by itself standing still and strikes it as it walks into reach, taking it where it will be 0.06 s later (the streamed readings are about 25 ms old and already carried forward), walks up to one that waits or backs off (sprinting while it is more than 4 blocks away, unless another melee mob stands nearer or is about to reach the player: then it backs off away from them, and the creeper, faster than a zombie, comes out ahead of the group), does not jump, and backs off after a hit only while the swing cools down with the creeper in reach. Without the fuse report (an older helper) it guesses: a creeper with a target always walks at it unless its fuse burns, so the fuse counts as burning when the creeper came within 2.8 blocks, when it stands still within 4.5 blocks (or for 0.3 s within 7.3), when it stood still after coming within 3.3 blocks in the last 0.9 s, or after a strike until it walks back in, and it then walks up only to a creeper more than 4.5 blocks out and not to one it struck in the last 1.5 s. It remembers each creeper's fuse for the whole `play` run. Once the fuse burns, a creeper still in reach with the swing ready and at least 0.7 s of fuse left is struck first (the knockback throws it 2 to 3 blocks), then the player turns away and sprints out past 7.3 blocks and comes back once the fuse is out. The way it runs is the open one: of the headings up to 120 degrees off straight away, the one that gets farthest from the creeper within 6 blocks on the blocks the nav grid knows (a wall, a hole or water ends a run), steering 4 blocks clear of creepers and about 2 blocks clear of other mobs, so it goes around a zombie instead of into it. When it makes no progress all the same it turns 75 degrees aside. Only when the blast would come before the player is out of its 6-block reach and the creeper is within 5 blocks does it raise the shield toward the creeper, which blocks the explosion (farther out the blast does little, and sneaking would give up getting past 7 blocks). With a bow and arrows in the hotbar it shoots a creeper that is more than 5 blocks away, walking backward while it draws, and takes the sword once the creeper gets closer.

Against a group, `fight` reads the hostile mobs within 8 blocks every 50 ms, from the helper's state stream, which carries the 8 closest living entities within 16 blocks every tick. A creeper within 5 blocks comes first, one whose fuse burns within 7.5 blocks, and a creeper target is kept as long, since only the creeper footwork keeps its fuse from finishing. An unlit creeper target farther out is dropped for a nearer mob, so the player does not back off from the zombies in front of it forever. It remembers every creeper's fuse across targets, so turning to a creeper that lit while the player fought another mob still runs from it. Otherwise it switches to a mob that is 0.8 blocks closer than its target, or to one within 2.5 blocks while the player is losing health (the one hitting). With another mob within 5 blocks it backs off diagonally, away from the side the others are on, so they line up in front and come one at a time. When one gets more than 70 degrees off the line to the target (beside or behind), it walks away from all of them until they are in front again. Every step back picks the open heading near the one it wants, as the creeper run does, so a wall or another mob on the way turns it aside. It only jumps for critical hits when no other mob is within 4 blocks.

`flee` faces the escape direction, away from the threats weighted by their damage and closeness, and sprints, sprint-jumping on the straight and jumping when it bumps into a step. When it stays stuck it turns aside, alternating sides and turning wider each time. When a threat stays within 2.5 blocks for 1.5 seconds (a wall or a corner), it gives up as cornered, and `play` fights back for 4 seconds before it tries to run again.

`sculk bench combat` measures these skills in built arenas in the real client (see [Bench](bench.md)).

#### play

`play` pursues a goal without the agent and without a decision model. A configured model (Jev through OpenRouter or ZenMux, or Kev served locally, see [Decision Model](decision.md)) is asked as an advisor when there is one.

Every `stepMs` (250 ms by default) the loop reads a threat map. It holds the living entities within 24 blocks with their distance, how fast they close in, how dangerous they are, and for creepers how long the fuse has been burning, plus the player's health, food level, armor points, best weapon and best food in the hotbar. It checks the goal, scores what the player could do now and keeps the best tactic running as a skill.

| Tactic | Runs | Scored high when |
|---|---|---|
| `fight` | `fight` against one target | The target is a goal target, or a hostile mob that is coming or close. Nearer and more dangerous targets score higher |
| `flee` | `flee` | A creeper's fuse has burned for half a second within 5 blocks (an emergency), unless a fight is running (it turns to any creeper within 5 blocks and its footwork backs away from the fuse). Also when health is at or below 6 with full iron armor (up to 8 without armor) and a hostile mob is within 8 blocks, after which the player keeps away (fleeing from mobs within 12 blocks and fighting only one at hand) until health is back to 12. Archers do not count for this: running keeps the player under their arrows, so an archer that has the player in range is fought at its full score instead. And when the mobs around are far more than the player's health and armor can take |
| `eat` | `eat` | The food level is 14 or less, or health is 14 or less and the food bar is not full. Between fights, or mid-fight when no hostile mob is within 4 blocks, no archer has the player in range and no mob can reach the player before the food is eaten (1.7 s, counting a mob that is knocked back as coming at its chase speed, 2.3 blocks a second for a zombie). Hurt and safe, eating outscores walking to the next fight. Health only comes back on a nearly full food bar |
| `goto` | `move_to` with pathfinding | The goal is a place the player has not reached |
| `use_on` | `use_on` for one entity | The goal is to hit every X once and this X has not been hit |
| `idle` | A short wait | Nothing else applies |

A new tactic must beat the running one by 0.08, so the player does not flip between two close options. These goals are read from the goal text and checked against the game on every decision. The goal counts as done once the check holds twice in a row.

| Goal text | Done when |
|---|---|
| "kill 3 zombies", "kill a skeleton", "kill the creeper" | That many of the type are killed (one for a lone singular) |
| "kill the zombies", "kill all skeletons" | No mob of the type is left within 24 blocks |
| "kill the hostile mobs near you" | No hostile mob is left within 24 blocks |
| "go to 10 64 -20", "walk to 10, -5" | The player is within 2 blocks of x/z |
| "hit every cow near you once with the held item" | Every cow within 24 blocks has been hit by `use_on` |

Kills come from the helper pack's death log (deaths the player caused), so a creeper that blew itself up is not a kill. Other goals end when the advisor's `goal_done` reaches 0.8, or at the time limit when there is no advisor.

With an advisor, every decision sends it a short text state (the goal, its progress, the time left, the vitals, every hostile and other entity with a key such as `zombie_1`, the running tactic and the last result) and asks it up to three questions in one request.

| Question | Type | Answers |
|---|---|---|
| `tactic` | Choice | The tactics possible now |
| `target` | Choice | An entity key, or `none` |
| `goal_done` | Noul | Probability that the goal is achieved. Only asked for goals without a built-in check |

The model's tactic runs when its probability is at least 0.3 and the tactic is possible. A targeted tactic whose target answer does not fit takes its best-scored target. An emergency (a score of 0.9 or more, such as a burning creeper) overrides the model, and so does the built-in choice when the model answers late (after 1.5 s) or fails. The loop stops when the goal is done, when the player dies, when `durationMs` runs out, or on an error such as the simulation being paused.

| Field | Default | What it does |
|---|---|---|
| `goal` | | What to achieve, in plain words (required) |
| `durationMs` | 30000 | Time limit, 1000 to 300000 |
| `stepMs` | 250 | Time between tactic decisions, 100 to 1000 |
| `allow` | all | Tactics `play` may use, from `fight`, `flee`, `eat`, `goto`, `use_on`, `idle`. `idle` is always allowed |
| `advisor` | true | Asks the configured decision model as an advisor. `false` runs on the built-in scores alone |
| `vision` | false | Sends a screenshot with every decision when the model accepts images (Jev). Off by default because it is slower |

`play` runs as a background job, because a run lasts longer than most MCP clients let one call run. It must be the last action in the list. The call returns at once with the job id in `job` and `status: "running"`, and [player_job](#player_job) follows it. Only one play job runs at a time. Starting another stops the first, and every other `player_act` call is refused until the job ends or `player_job` stops it. Play jobs also stop on `game_stop`, on `game_launch` and when the MCP server shuts down.

The finished job carries the stop reason, the goal check and its progress, combat numbers (decisions, kills by type, swings, hits, critical hits, damage taken, deaths, final health), the advisor's median and 90th percentile latency, and a trace with one entry per tactic run. Each entry has the tactic and target, whether the built-in scores or the model chose it and why, its score, the state text and answers when a model was asked, and how it ended (finished, or preempted by the next tactic). The text summary lists the stop reason, the combat numbers and the last five tactics.

### player_job

Follows the `play` job that `player_act` started. Without `id` it uses the running job, else the latest one. The last five finished jobs stay readable. A job paused by your F9 takeover stays `running` and continues when you press F9 again. On Windows, a job paused because the game window left the foreground stays `running` and continues once the game window is in the foreground again.

| Input | Description |
|---|---|
| `action` | `status`, `wait` or `stop` (required), see below |
| `id` | Job id from `player_act`, e.g. `play-1` |
| `timeoutMs` | For `wait` only. Longest to block, 0 to 25000 (default 25000) |

| `action` | What it does |
|---|---|
| `status` | Returns the job's progress at once. That is the steps so far, the elapsed time, the last five actions and the decision latency so far (median, 90th percentile, most) |
| `wait` | Blocks until the job ends or `timeoutMs` passes, then returns the same as `status`. 25 s stays under the 30 s many clients allow one call, so call it again until the job ends. With a progress token, each step sends a progress notification |
| `stop` | Ends the job, lets go of every key and returns its result |

The result has `id`, `goal`, `status`, `startedAt`, `progress`, and once the job has ended `stopReason`, `result` (the full play result described above) or `error`. `status` is `running`, `done`, `stopped` (by `stop`, a new play job, `game_stop`, `game_launch` or shutdown, named in `stopReason`) or `failed`.

### player_state

Returns the player's position, rotation, ground contact, velocity, health, held item, selected slot (1 to 9), and the block and entity under the crosshair, as `state`. The helper pack streams it, so the call is fast.

No inputs.

### player_inventory

The local player's attributes and whole inventory, read from the game on the thread that owns the data. Attributes are `{name: {current, min, max, default, base}}` for every attribute the player has (health, absorption, movement, attack damage, knockback resistance, luck, hunger, saturation, exhaustion, level, experience, ...; `base` is the value before modifiers) plus `armor` (total armour points) and `armorToughness` as `{current}`, computed by the game's own functions. The inventory is `selectedSlot`, `hotbar` (9), `inventory` (27), `armor` (`head`, `chest`, `legs`, `feet`), `offhand` and `cursor`; a slot is `null` or `{item, count, data?, name?, durability?: {damage, max}, enchantments: [{id, level}], lore?, contents?}`, where `contents` holds what is inside a bundle or a shulker box.

Takes no input. The result has `source`, `attributes` and `inventory`. Through the agent `source` is `engine`, the game's own data. Without an agent it is `script`, read through the helper pack's Script API components (inventory and equippable), which has no item aux value, no bundle contents and no cursor stack, and only the attributes the running game exposes as components. Crafting and setting up inventories stay on commands through `engine_command` (`/give`, `/clear`, `/replaceitem`, `/setblock`).

## Containers and Crafting

These tools use blocks, entities and the screens they open from inside the game: containers, crafting and every station. They go through the [engine](#engine); only `container` `get` has a fallback without it.

### container

Reads a block's container, or the container screen the player has open.

| Input | Description |
|---|---|
| `action` | `get` or `open` (required) |
| `x`, `y`, `z` | `get`: the block position |
| `dimension` | `get`: dimension id, e.g. `minecraft:nether` (default: the player's) |

`get` answers `block`, `size` and `slots` for a block that has a container (chest, trapped chest, barrel, shulker box, hopper, dispenser, dropper, furnace family, brewing stand, crafter, ...) in the same slot shape as `player_inventory`; a block without one is `invalid_params` (`-32602`). `open` answers `screen`, `block` when the screen is a block's, `slots` for the container and `playerSlots` for the player's own inventory beside it, and needs an agent.

Without an agent, `get` falls back to the helper pack's block inventory component (`source` is absent from the result; the slots are the Script API's). `open` has no fallback: the Script API does not expose the open screen.

### craft

Match and run crafting recipes through the game's own recipe lookup, the way the crafting table would.

| Input | Description |
|---|---|
| `action` | `match` or `run` (required) |
| `grid` | `match`: up to 3 rows of up to 3 item ids, `null` for an empty cell; short rows are padded to 3x3 |
| `ingredients` | `match`: up to 9 item ids for a shapeless recipe |
| `table` | `match`: a crafting table is open (3x3) rather than the 2x2 inventory grid |
| `recipe` | `run`: the recipe id `match` returned |
| `times` | `run`: how many times to craft, 1 to 1000 (default 1) |

Give exactly one of `grid` and `ingredients`. `match` answers `result` (a slot, or `null` when nothing matches) and `recipe` (`id`, `type` — `shaped`, `shapeless`, ... — and `tag` when it has one). `run` is the same request as `screen act craft`: the game's own crafting request through the screen the player has open, taking the ingredients out of the player's inventory and putting the result there for `times` crafts, and it answers `crafted`, `result` and `consumed`. A 3x3 recipe needs a crafting table open, like the player. Item ids may be written without `minecraft:`.

Crafting has no Script API equivalent, so both actions need the agent: without `engine_attach` the call fails and says so.

### interact

Uses a block or an entity the way a right click does, through the game's own interact path: open a chest, a barrel, a crafting table, a furnace, a brewing stand, an anvil, a stonecutter, a loom, a smithing or cartography table, a beacon or a villager's trades; open a horse's screen; sit in a boat or a minecart; press a button or pull a lever. Set the scene up first with commands (`/setblock`, `/summon`) through `engine_command`.

| Input | Description |
|---|---|
| `target` | `block` or `entity` (required) |
| `x`, `y`, `z` | `block`: the block position |
| `dimension` | `block`: dimension id, e.g. `minecraft:nether` (default: the player's) |
| `face` | `block`: which face to use, `down`, `up`, `north`, `south`, `west` or `east` (default: the side the player looks at) |
| `id` | `entity`: the entity's unique id, a whole number in text, as `game_query` reports it (text because it is a 64-bit integer) |

The result has `target`, `screen` (the screen it opened, or `null` when it opened none) and `changed` (an interaction that opened a screen always changed something). Read and drive that screen with `screen`.

### screen

Reads and drives the screen the game has open, opened with `interact`.

| Input | Description |
|---|---|
| `action` | `state`, `move`, `act` or `close` (required) |
| `from`, `to` | `move`: `{ container, slot }` each. `container` is a collection name `state` lists (`hotbar_items`, `furnace_ingredient_items`, `stonecutter_input_items`, ...), or a container enum name such as `HotbarContainer` mapped to the open screen's collection; `slot` is 0-based within that collection |
| `count` | `move`: how many items, 1 or more (default: the whole stack) |
| `act` | `act`: `craft`, `stonecut`, `anvil`, `grindstone`, `smithing`, `loom`, `cartography`, `enchant`, `trade`, `beacon` or `take_result` |
| `recipe` | `act` `craft`: the recipe id `craft match` returned. `act` `stonecut`: the 0-based `index` of a recipe in `data.recipes` |
| `times` | `act` `craft`, `stonecut` and `trade`: how many times, 1 to 1000 |
| `name` | `act` `anvil`: the rename text; an empty string clears the name |
| `pattern` | `act` `loom`: the pattern id the screen lists |
| `option` | `act` `enchant`: which of the three options, 0 to 2 |
| `offer` | `act` `trade`: the 0-based index of the offer |
| `primary`, `secondary` | `act` `beacon`: the effect id, e.g. `minecraft:speed`, and a second one |

`state` answers `screen`, `kind` and every container's slots, plus the screen's own `data`. `kind` is the screen family: `crafting_table`, `inventory`, `furnace`, `blast_furnace`, `smoker`, `brewing_stand`, `stonecutter`, `anvil`, `grindstone`, `smithing_table`, `loom`, `cartography_table`, `enchanting_table`, `beacon`, `trade`, `chest`, `barrel`, `shulker_box`, `hopper`, `dispenser`, `dropper`, `crafter`, `horse` or `other`; a kind the agent names that is not in this list is passed through as it is. `containers` maps each container's collection name (`hotbar_items`, `inventory_items`, `cursor_items`, `crafting_input_items`, `trade2_ingredient1_item`, ...) to its slots in the same shape `player_inventory` uses. `data` is `null` for a screen with no state of its own (a chest, a barrel, a hopper, the inventory), and otherwise holds what that screen reports (`netId` is the game's network id, a number):

| Screen | `data` |
|---|---|
| Stonecutter | `recipes` (`[{ index, result, netId }]`, the game's list for the input), `selected` (`-1` for none), `result` |
| Enchanting table | `options` (up to three: `{ option, cost, hint, level, enchants: [{ id, level }], netId }`, `option` being the index `act enchant` takes) |
| Villager trade | `offers` (`[{ index, buyA, buyB, sell, uses, maxUses, locked, netId }]`), `selected`, `trader` (the trader's unique id as text, as `interact` takes it) |
| Furnace, blast furnace, smoker | `burn`, `cook`: fractions 0 to 1 |
| Brewing stand | `brew` (done), `fuel` (left): fractions 0 to 1 |
| Anvil | `result`, `xpCost`, `tooExpensive`, `name` (the rename text) |
| Grindstone, smithing table, cartography table | `result` (the preview the take reads), `inputs` (slots per input container) |
| Beacon | `primary`, `secondary` (short effect names such as `speed`, a raw number for an effect without a name, `null` when none) |
| Loom | `pattern` |

A state the agent decodes but cannot read at that moment is `{ unavailable, anchor }` (the reason in words) rather than a failed call. A field the engine does not report is `null`, never a guess.

`move` moves items between those containers through the game's own item stack requests, the way dragging with the mouse does, and answers `moved` with the `from` and `to` it was given. `act` runs the screen's own action through the game's own request and answers `done`, `result`, `consumed` (`[{ item, count }]`), `xpCost` where one applies and `reason` (why a screen refused it). `close` closes the screen like `Escape` and answers `closed`; with nothing open it is `invalid_params`, because `Escape` while playing would open the pause menu.

All four actions need the agent, and so does `interact`: there is no Script API or `level.dat` equivalent for using a block or reading a screen. Without `engine_attach` they fail and say so; an agent too old to have these methods says to rebuild it. Setup stays on commands (`/setblock`, `/summon`, `/give`, `/enchant`, `/xp`) through `engine_command`.

## Engine

These tools talk to the in-game agent, a small DLL loaded into the running game, which answers on `127.0.0.1:19160` and runs the requests that touch the game on its main thread. Any PC (GDK) install sculkwire detects works: a Wine or Proton install on Linux (Flarial, mcbe-gdk-installer, Bottles, Lutris, Steam), a native install on Windows, and the game must already be running. See [In-Game Agent](engine.md) for the requirements per OS, the attach flow, the input lock and the wire protocol.

Other tools go through the same agent once `engine_attach` has loaded it, and are listed with what they act on: `game_input_lock`, `game_ui`, `game_settings` and `world_settings` under [Game Client](#game-client), `player_inventory` under [Player](#player), and `container`, `craft`, `interact` and `screen` under [Containers and Crafting](#containers-and-crafting).

Every call that goes through the agent returns `ok`. A failed call carries a stable `reason`, the JSON-RPC `code` and a `message`: `anchor_missing` (`-32001`, the anchor's name in `anchor`), `not_in_world` (`-32002`), `wrong_thread` (`-32003`), `timeout` (`-32004`), `command_failed` (`-32006`), `path_not_writable` (`-32007`), `scripting_unavailable` (`-32014`), `invalid_params` (`-32602`), `unknown_method` (`-32601`, an agent older than the method), `not_attached` and `disconnected` (no agent answers on the port), `protocol` (the agent answered a shape sculkwire does not know) or `rpc_error` (any other agent error). A host-side problem fails with `prerequisite` and no code: no install, the game not running, no `cargo` and no release build, or a file that cannot be read or written.

### engine_attach

Builds the agent DLL, injects it into the running `Minecraft.Windows.exe`, connects and returns the engine status (the fields of `engine_status`). The DLL comes from an extension's [agent source](extensions.md#agent-source) when one matches the game folder, else from `SCULKWIRE_AGENT_DLL`, a cargo build of `native/`, or the matching GitHub release (downloaded and checked against its sha256). The build is cached by a hash of its sources, and repeat calls reuse the loaded agent: they only read its status again. The call waits until the agent has resolved its anchors after the injection. Start the game first; an error says which install or game folder was not found, that the game has to run, or where `sculkwire-agent.log` is when the DLL loaded but nothing answered.

No inputs.

### engine_status

Returns the `build` identity as the DLL reports it (the executable's file name and version), whether the main-thread hook runs requests (`hooked`), the current `tick`, every `resolved` anchor with its address, and every `missing` one. Without a prior attach it connects to an agent that is already listening on the agent port.

No inputs.

### engine_command

Runs a command on the game's main thread as the local player, through the engine's command dispatcher, exactly as if it were typed: chat commands, client-side commands and `/reload` all work. The result carries the `command`, `success`, taken from the command's own output (`false` when it reported an error, `null` when it prints nothing, as `say` does), and the game's output text in `message`.

The agent replays the origin of a real player command, so the first command after an attach or a world change types `/testfor @s` in chat itself, with its output kept out of chat. It does so only while the HUD alone is showing; with another screen open the call fails with `anchor_missing` `command.origin` and says to run one line in chat yourself and retry. An empty command or one with a newline is `invalid_params`.

| Input | Description |
|---|---|
| `command` | Command line, with or without the leading slash (required). Newlines are rejected, because the game would split them into several commands |

### engine_player

Returns the local player's `position` (the feet), `rotation` (pitch, yaw; each `null` when not readable) and movement since the previous tick (`delta`), read from the engine on the game's main thread, plus the simulation tick it was read on (`simTick`) and the numeric `dimension` (`null` when unknown). Needs `engine_attach` and a loaded world; right after an attach it answers `not_in_world` until the agent's first client tick.

No inputs.

### engine_tick

Controls game time. Give exactly one input. The result has `paused`, `ticks`, `scale`, `success` and the engine's own `message` when it said anything.

| Input | Description |
|---|---|
| `pause` | `true` freezes the simulation, `false` resumes it |
| `step` | Pauses if needed, then runs exactly this many simulation ticks (1 to 600) inside one main-thread request and stays paused |
| `scale` | Sets the tick rate multiplier, a positive number |

### engine_screenshot

Asks the game's own screenshot code for a picture of the current frame, as F2 takes it (an open screen is not in it). The game saves the file in its own gallery; sculkwire waits for it to finish writing, copies it to `path`, and returns `path`, `bytes`, `format` (`png` or `jpeg`) and the image. The retail client saves JPEGs, so a `.png` path becomes `.jpg`. The game's gallery copy stays. A picture that does not appear in time is a `timeout`.

| Input | Description |
|---|---|
| `path` | Where to save the picture, a host path (default under sculkwire's cache) |

## Game Files

These tools read an installed PC (GDK) copy of Minecraft Bedrock: on Windows the folder Windows registered for the stable and Preview packages, else `<drive>\XboxGames\Minecraft for Windows\Content` (and the Preview) on every fixed drive; mcbe-gdk-linux on Linux (`~/.local/share/mcbe-gdk-linux/game` and its `game-dir` pointer); and any folder in `SCULKWIRE_GAME_DIRS` (`;`-separated on Windows, `:` elsewhere). An add-on developer uses them for the per-version `vanilla_1.x` packs that a world's `base_game_version` pins, which the public bedrock-samples repository does not keep, unpacked into plain folders to grep or diff against. `build` picks a build by its key (the game version, or a hash of its folder when the version is unknown), its game version (e.g. `1.21.120.1`) or its game folder, and defaults to the first detected build.

### game_builds

Lists installed builds (`builds`) with their game folder (`root`), `key`, game `version` (from `appxmanifest.xml`, `1.21.12001.0` becomes `1.21.120.1`), the raw `appxVersion`, the `packageName` and the behavior and resource pack folders (`packRoots`). `searched` lists the folders it looked in. Local only.

| Input | Description |
|---|---|
| `gameDir` | Inspect only this game folder |

### game_vanilla_packs

Lists the per-version base-game packs a build ships for behavior and resource packs, from `vanilla_1.14` up to the newest, in version order. Extract one with `game_extract_pack`.

| Input | Description |
|---|---|
| `build` | As above |
| `kind` | Only `behavior` or `resource` packs |
| `all` | Include every pack, not just the versioned vanilla packs |

### game_extract_pack

Unpacks one pack of a build into a normal folder: its `__brarchive/*.brarchive` containers are unpacked and merged with the loose files (a loose file wins over an empty archive entry of the same path). Returns the folder in `out`, counts of loose files, archives and entries, any `failures` (an archive that is not a readable `.brarchive`), and whether a previous extraction of the same build was reused (`cached`). The default folder is `<cache>/gamefiles/<build key>/packs/<kind>/<pack>`. A non-empty folder that is not a previous extraction is never overwritten.

| Input | Description |
|---|---|
| `pack` | Pack folder name, e.g. `vanilla_1.21.0` or `vanilla` (required) |
| `kind` | `behavior` (default) or `resource` |
| `build` | As above |
| `out` | Target folder, empty or a previous extraction (default under the sculkwire cache) |
| `force` | Extract again even when a previous extraction of the same build exists |

## Decision Model

Two features use a decision model, both only as an optional advisor. They are the `play` action of `player_act` and the sign-in join recovery of `game_launch`. See [Decision Model](decision.md) for providers and setup.

### decision_status

Reports the configured `provider` (`none`, `openrouter`, `zenmux` or `local`), the `model` and `baseUrl`, where the setting came from (`source`, `env`, `file` or `default`), the `configPath`, whether one is `configured`, whether it answers one tiny probe (`reachable`, `latencyMs`), whether the model accepts `images`, and any `error`. When no model is configured and the MCP client supports elicitation, it asks the user for a provider, and for the server URL when the choice is local Kev, and saves the answer. It never asks for an API key. A Jev key comes from `OPENROUTER_API_KEY` or `ZENMUX_API_KEY`, or from `sculk setup` in a terminal. Clients without elicitation get a message to run `sculk setup`.

| Input | Description |
|---|---|
| `probe` | Send the probe question (default true) |
| `setup` | Ask the user for a model when none is configured (default true) |

## sculkwire

### sculkwire_version

Reports the running version, the update channel (`release`, `main` or `off`) and whether sculkwire runs from a managed install or a development checkout. A managed install checks for a new release at most once a day in the background and installs it for the next session. When that happened, `updateReady` is true and `current` names the installed version. The tool never contacts the network. See [Install and Update](install.md).

No inputs.

| Output | Description |
|---|---|
| `version` | Version of the running server |
| `channel` | Update channel from the config |
| `managed` | True for a managed install, false for a development checkout |
| `root` | Where the running sculkwire lives |
| `running`, `current` | The running version and the one the next session starts (managed installs) |
| `latest` | Newest version seen by the last check |
| `updateReady` | An update is installed and waits for the next session |
| `lastCheck`, `lastError` | Time and error of the last update check |
