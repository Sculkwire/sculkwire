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

Looks up a Script API symbol in the channel's `@minecraft/*` typings, e.g. `Entity.applyDamage`, `Entity`, `applyDamage`, `world.getDimension` or `@minecraft/server-ui:ActionFormData.button`. Returns the signature, the docs, parameters, what it throws, the privileges, whether it is beta, and the module version that added it. A class lookup lists every member, and inherited members are found through the base classes. A stable symbol is described from the channel's plain typings (`npmVersion` is the plain build, e.g. `2.11.0`); only a beta symbol comes from the beta typings. When nothing matches, `suggestions` lists close names.

| Input | Description |
|---|---|
| `symbol` | The symbol to look up (required) |
| `module` | Limit to one module, e.g. `@minecraft/server` |
| `limit` | Matches to return, 1 to 50 (default 10) |
| `channel`, `offline` | As above |

### command_lookup

Shows the syntax of a slash command from the engine's command metadata. You get every overload, the parameter types, allowed enum values, the permission level and whether cheats are needed. When nothing matches, `suggestions` lists close names: names containing the query first, then misspellings (`gvie` → `give`, `tpp` → `tp`).

| Input | Description |
|---|---|
| `name` | Command name or alias, with or without `/` (required) |
| `channel`, `offline` | As above |

### molang_lookup

Explains a Molang query or math function, e.g. `query.is_baby`, `q.is_baby`, `is_baby` or `math.lerp`. Shows what it does, how many arguments it takes, what it returns, its query sets and the versions it exists in. `exact` says whether the name matched exactly; when it did not, `entries` holds the close names (`is_bbay` → `query.is_baby`).

| Input | Description |
|---|---|
| `name` | The query or function (required) |
| `limit` | Entries to return, 1 to 100 (default 20) |
| `channel`, `offline` | As above |

### component_lookup

Explains a component such as `minecraft:behavior.tempt` or `minecraft:geometry`. Returns the engine documentation with every property's type, default and description (`docs`), the engine JSON schemas for each `format_version` (`engineSchemas`), and the [rockide/schemas](https://github.com/rockide/schemas) definition with its description (`rockide`). When nothing matches, `suggestions` lists close ids.

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

Starts a server that keeps running, with your packs attached and the script debugger connected. Returns the session `id` for the tools below, plus the state, server version, port, instance folder, packs (each with its name, kind and `path` relative to the project, `.` when the project folder is itself the pack) and debugger state. A Regolith project whose profile runs filters is built with rgl first and the world links the build output; `reload` through `bds_session_command` builds again, so source edits apply (in `symlink` mode). A failed build stops the start, or the reload with the previous build still loaded, with the `regolith.build-failed` diagnostic.

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

Lines are 1-based: a script function's line is its hottest sampled line. A native Script API binding such as `Test::succeed` or `System::currentTick` (`native: true`) has no source of its own, and the line the game's capture gives it is the end of the calling function, so it is reported at the line of the script frame that called it.

The result also has `durationMs` (the capture), `sampleCount`, `intervalMs` and `idleMs`. The game samples only while script code runs (every interval, plus one sample per native binding call) and records nothing between game ticks. Each sample is charged the time until the next sample, but at most one sampling interval (`intervalMs`: the median gap between samples, at least 1 ms), so the time between one tick's script work and the next is `idleMs` and is charged to no function. A function that runs briefly once per tick is still charged up to one interval per tick. `selfPercent` is a function's self time as a percent of `durationMs`, so the self times plus `idleMs` add up to the capture.

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

A Regolith project whose profile runs filters is built with rgl first, and the built packs are deployed, so scripts produced by filters such as a TypeScript compiler are what the game loads. A build failure stops the launch and returns the rgl message instead of deploying the source packs. The call returns once the world is loaded, usually in 1 to 2 minutes; it blocks for that whole wait, so an MCP client with a shorter call timeout gives up on the call while the launch goes on (`game_status` then shows it). The result is the same as `game_status`, and its `packs` list names each deployed folder, its absolute path, and whether the folder holds build output.

`worldWaitSeconds` sets how long the launch waits for the game process and then for the world (each). When the world has not loaded by then, the launch stops the game and fails. With `keepOnTimeout: true` it keeps the game running instead and returns `ready: false` with a manual step that the world has not loaded yet and how to enter it (Play, then the test world on the Worlds tab); sculkwire keeps waiting in the background for 30 minutes, as when the user starts the game, and `game_status` turns ready once the world is in. Use it when the launch command cannot open the world itself and the user or the agent enters it from the start screen. A launch that fails for another reason (the game exited, a sign-in race that cannot be walked back) still stops the game.

If the world join races Microsoft sign-in (the game stops on "You need to authenticate to Microsoft services"), it walks the menus back into the test world without relaunching the game (Back to menu, out of any other screen, Play, the tile showing the test world's icon), and `game_status` reports it as `joinRecovery`. See [Sign-In Race at Launch](client.md#sign-in-race-at-launch) and [How sculkwire Finds Its World](client.md#how-sculkwire-finds-its-world). If sculkwire cannot start the game itself, it returns right away with `manualSteps` for the user, and `game_status` shows when the game is ready. With an input provider installed (the in-game agent is the built-in one) the only step is to start the game: once the start screen is up, sculkwire attaches the agent and opens the test world itself, and `manualSteps` asks the user to open the world only when that fails.

| Input | Description |
|---|---|
| `project` | Your add-on or pack folder |
| `deploy` | Copy the project's packs into `development_*_packs` (default true). Copies go to folders named `sculkwire_<project folder>_<pack folder>`, so projects with the same `packs/BP` layout do not overwrite each other; such a folder left by an earlier launch is copied over with the current packs, and `game_stop` removes the folders this launch copied. With `false`, a pack is only used when a folder already serves its uuid. Each deployed uuid ends up in one folder of the project, see [One Folder per Pack UUID](client.md#one-folder-per-pack-uuid) |
| `display` | `window` (Linux: a visible gamescope window; Windows: the game's own window), `headless` (Linux: no window, muted) or `desktop` (the launcher's own window; on Windows the same as `window`). The default is `window` on Windows. On Linux it is `window` when gamescope can run the install and there is a desktop, `headless` with no desktop, and `desktop` otherwise. A mode that cannot run falls back with a note: to `desktop` on Linux, to `window` for `headless` on Windows |
| `mute` | Silence the game's audio (default on in `headless` mode only). Linux: a silent PipeWire or PulseAudio sink. Windows: the game's audio sessions, unmuted again by `game_stop`; without an audio device or session the result has a note instead |
| `world` | World name, prefixed with `sculkwire-` (default `bridge`, replaced on each launch) |
| `difficulty` | `peaceful`, `easy`, `normal` (default) or `hard`. Peaceful removes hostile mobs such as zombies |
| `betaApis` | Turn on the Beta APIs experiment |
| `width`, `height` | Game resolution in `window` and `headless` mode on Linux, 320 to 3840 by 240 to 2160 (default 1280 by 720). Windows sizes the game window itself |
| `fps` | Frame rate in `window` and `headless` mode on Linux, 10 to 240 (default 60) |
| `worldWaitSeconds` | Seconds to wait for the game to start, and then for the world to load, 10 to 1800 (default 180). `sculk game check` takes it as `--world-wait` |
| `keepOnTimeout` | When the wait runs out, keep the game running and keep waiting in the background instead of stopping it (default false) |

### game_status

Shows whether the game is running (`running`, `ready`), the display `mode`, the game `version`, the `install`, the `world`, the `project` and its `packs`, the script `debugger` and `/connect` state, `manualSteps` still to do by hand, `deployDiagnostics` (a `client.duplicate-pack-uuid` warning for each pack folder that is not a copy of the project but shares a deployed pack's uuid), and `joinRecovery` after sculkwire walked the menus into the world itself, after a sign-in race or from a start or Play screen nobody left (`attempts`, `recovered`, `via` with the presses, `log`, `screenshot`). Each pack entry gives the pack name, uuid, kind, the deployed folder, its absolute path, and whether it is rgl build output. A manifest name that is a lang key such as `pack.name` is shown as its value in the pack's `texts/en_US.lang`.

`running` and `ready` follow the game process found for the launch, checked on every call: once it exits (a crash, or closed by hand) they turn false, `gameExited` is `true` and `manualSteps` says to call `game_stop` (which still cleans up the bridge, its options and deployed packs); `game_launch` does that cleanup itself. Until the process is found (a user still starting the game) `running` stays true and `ready` false.

`ready` also needs the helper pack to answer on an attached script debugger session: it turns false when the debugger session closes or while a reload restarts the helper, and true again once the helper prints ready on a session. After a `game_reload` the bridge could not recover (see `game_reload`), `manualSteps` names what to do.

When sculkwire cannot type `/connect` itself (desktop mode), `manualSteps` asks the user to type it. That step shows only while no `/connect` client is attached: it goes once one attaches (`connect.method` is then `chat`) and comes back if the game drops the socket, e.g. on a rejoin.

No inputs.

### game_command

Runs a slash command in the game and returns `ok`, the `output` lines and the route it took. Through `/connect` the result also has `statusCode` and the structured `body`, and `ok` is the game's own status. Through the script debugger it runs server commands and the output comes from the game's prints. The debugger sends no status, so `ok` is false when an output line is one of the game's failure messages (`No targets matched selector`, `Function <name> not found.`, a syntax error), read from the installed game's `texts/en_US.lang` and the language in its options.txt; without that file only syntax errors and unknown commands count as failures.

| Input | Description |
|---|---|
| `command` | Command line, with or without the leading slash (required) |
| `via` | `auto` (default, `/connect` when a client is attached, else the debugger), `connect` or `debugger` |

### game_reload

Copies the project's current packs into the game again, building a Regolith project with rgl first, then runs `/reload`, or `/reload all` with `all: true`. Use `all: true` after adding or changing blocks, items, entities or other JSON, since `/reload` only restarts scripts and functions. Plain `/reload` re-reads the `.mcfunction` files the game already knows but does not register a new one (calling it answers `Function <name> not found.`). `all: true` registers it where the game really rejoins the world; the retail client 1.26.63 does not (measured over `/connect` and over the script debugger), so there a new function file, like new JSON content, needs a relaunch with `game_launch`. The game documents `/reload all` as reloading every behavior and resource pack by leaving and rejoining the world, but the retail client 1.26.63 run through `/connect` (and BDS) answers it like `/reload` (`Function and script files have been reloaded.`) and stays in the world; when new JSON content does not show up, relaunch with `game_launch`. A failed rgl build stops the reload with rgl's message. The redeploy follows the same one-folder-per-uuid rule as `game_launch` and copies into every folder of the project (its `sculkwire_*` folder or rgl export), also one an earlier launch or sculkwire process left behind, and also with `deploy: false`. A folder that is not the project's is never written, so a pack only such a folder serves is not redeployed. Returns the `redeployed` folders, the `command` result and the `diagnostics` the reload logged, after any `client.duplicate-pack-uuid` warnings.

After the command the reload waits for the helper pack to print ready again (60 s for `all: true`, 30 s for `/reload`). Without `/connect` the command goes through the script debugger, and on the retail client 1.26.63 `/reload all` sent that way left the debugger socket open while the game sent no more command output or helper replies. When the helper does not come back, `game_reload` re-establishes the channel: it pings the helper, asks the game to dial the debugger again with `/script debugger connect localhost <port>` (sent over the old session and over `/connect` when attached), closes the old session, and types that command into the game chat where input reaches the game. If the helper still does not answer, the result carries a `client.helper-lost` error, and `game_status` shows `ready: false`, `debugger.attached: false` and the step to take in `manualSteps` (type the command into the chat, or `game_stop` and `game_launch`). The step goes away once the helper prints ready on a new debugger session. `/connect` avoids this: attach it before a `reload all` when you can.

| Input | Description |
|---|---|
| `all` | Run `/reload all` instead of `/reload` (default false) |

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
| `blocks` | Non-air blocks in a cube around the player or `x`, `y`, `z`, with their states. Rows outside the dimension's height range (below the world floor, above the build limit) are left out: a cube that crosses them returns the blocks inside, one wholly outside returns `[]` |
| `block` | The block at `x`, `y`, `z`; `null` outside the height range or in an unloaded chunk |
| `ping` | `pong` when the helper pack answers |

| Input | Description |
|---|---|
| `kind` | One of the kinds above (required) |
| `type` | Only this entity or block type id |
| `types` | Blocks only: an array of block type ids, keeping the blocks of any of them in one scan of the cube (`type` is then ignored) |
| `radius` | 0 to 256. Entities default to 16 blocks. Blocks default to 4 and are capped at 16 |
| `limit` | Entities to return, 1 to 200 (default 50) |
| `x`, `y`, `z` | The point to search around instead of the player |
| `dimension` | Dimension of `x`, `y`, `z` (default the player's) |

### game_registry

Lists every block, item or mob id the running game knows, including ones from your add-on. It asks `/connect`'s data request first. When no `/connect` client is attached, the request fails, or the game answers an empty list (the retail client answers `[]` to every data request), the helper pack lists the ids through the Script API instead (`BlockTypes`, `ItemTypes` and `EntityTypes`, so `mob` then lists every entity type, projectiles and other non-mobs included), which needs the script debugger. The result has `kind`, `source` (`connect` or `script`), the `entries` (the game's own entry objects from `/connect`, sorted id strings from the helper pack) and, for the helper pack, a `note` saying why `/connect` did not answer.

| Input | Description |
|---|---|
| `kind` | `block`, `item` or `mob` (required) |

### game_input

Presses keys, types text, clicks or moves the mouse in the game, like a player would. Coordinates are pixels in the screenshot. On Linux input goes to the game's own gamescope display and never touches your desktop. On Windows it brings the game window to the foreground, then uses the system keyboard and mouse; it fails with `the game window is not in the foreground` when the window loses it before the input is sent. With the in-game agent attached, keys, text and left/right clicks go through the game's own UI instead ([`game_ui`](#game_ui)), which works in the background and on Windows without the foreground; `move` and a middle click always take the route above. The result has `done` and `route`: `engine` when the in-game agent's UI took the input, `gamescope` for xdotool into gamescope's display (Linux), `windows` for the system keyboard and mouse through SendInput.

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

Drives the game's own UI from inside the process: the screen, its controls, and keys, text, clicks and scrolling. This is how a menu is driven without the keyboard and mouse route, which only reaches the game while its window is in the foreground. It works in the background, on Linux and Windows alike, and needs no loaded world, so the title screen, the Play screen and Settings are reachable while the game sits in a menu. Every input is refused on a store, Marketplace, Minecoins, Dressing Room or profile/persona editor screen except `Escape`, which leaves it. On an OreUI page (every one is named `ui://./hbui/index.html`) the agent reads the page's route from the game's own router, and refuses clicks, `Return` and `space` while the route cannot be read or is not one of the Play screen's (`/play`, `/create-new-world`, `/edit-world`), the option pages of Settings (`/settings`, `/oreui-settings/` `game`, `video`, `audio`, `general`, `accessibility`, `keyboard-and-mouse`, `controller`, `touch`, `creator`) or the idle overlay (`/idle-route`, "You've been away for a bit", whose page says any button closes it; `Escape` only opens the pause menu over it; not verified live yet that an allowed input closes it); Multiplayer, Party, Account and Global Resources are refused. Without `engine_attach` it connects to an agent that is already listening on the agent port.

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

The result has `source` (`engine` or `options.txt`), and for `list` the `settings` array, each with `id`, `type` (`bool`, `int`, `float`, `string` or `enum`), `value`, and `min`/`max` or `values` where the game gives them. `get` returns `setting`. `set` returns `setting`, the `previous` value, `appliesAt` (`now` or `next launch`) and `saved`: `true` when the value reached `options.txt`, which it always does on the file route, `false` when the change is live only and is lost on restart unless the game saves later, and absent when the agent does not report it. With an attached agent a value outside the option's range or allowed values is an `invalid_params` failure. Both routes answer in the game's own unit: `gfx_viewdistance` is in chunks (the game's 5 to 96), although `options.txt` saves it in blocks (16 per chunk), so the file route reads `800` as `50` and writes `12` as `192`.

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

Controls the player like a person playing, run in a fast loop by sculkwire, so the agent does not wait on the model between steps. Pass up to 50 actions to run them in order in one call. The call stops at the first failed action unless `continueOnError` is set. The keyboard route needs `game_launch` with `display: window` or `headless` on Linux, or any display on Windows. With the in-game agent attached (an input provider), the engine route also drives a Linux `desktop`-mode game, such as one you start yourself: `input: auto` or `engine` take it, `input: keyboard` fails with the reason, and when the engine route fails during an action, the action fails with the engine error and that the keyboard route is unavailable rather than redoing it on the keyboard. It refuses to run while an [input provider](extensions.md#input-provider) reports the simulation paused, because the player cannot move then. When the MCP client cancels the call or the call times out, the running action stops and every key and mouse button is let go. A client that sends a progress token gets a progress notification after each action.

On Windows the keyboard route uses the system keyboard and mouse. The call brings the game window to the foreground once when it starts and never takes the focus back in the middle. When you switch to another window, every key and button is let go, the running action stops with `the game window is not in the foreground`, and a `play` job pauses until the game window is in the foreground again or `player_job stop` ends it.

On the engine route the input provider's input lock keeps your own keyboard and mouse out of the game while actions or a `play` job run. When you press F9 to take control, the running action stops with `the user took control (F9)` and a `play` job pauses until F9 gives control back or `player_job stop` ends it.

| Input | Description |
|---|---|
| `actions` | 1 to 50 actions from the tables below, run in order (required) |
| `continueOnError` | Keep going after a failed action (default false) |
| `input` | `auto` (default, the engine route when the input provider answers, else keyboard and mouse), `engine` (fails when the provider cannot be used) or `keyboard`. See the input routes below |

There are two input routes. The keyboard route sends held keys, mouse buttons and relative mouse motion: through `xdotool` into the game's own gamescope display on Linux, through `SendInput` on Windows. The engine route goes through the in-process [input provider](extensions.md#input-provider): the built-in one drives the [in-game agent](#engine) once `engine_attach` has loaded it, and an extension may install its own instead. Through it sculkwire sets the view every frame, holds a movement vector, asks for an attack or a use of the held item, and reads the player's position, rotation, velocity, ground contact and health from the provider's motion stream (the agent's tick stream, one tick old) instead of the helper pack (50 to 100 ms old there). Entities, the block and entity under the crosshair, the held item and the hotbar slot still come from the helper pack. `auto` takes the engine route when the provider answers and the keyboard otherwise. `engine` fails when no provider can be used. When the engine route fails during an action, every input is let go, the action runs again from the start on the keyboard, and its message says so. The call stays on the keyboard after that. Each action's result names the route that carried it out in `input`, and the text summary starts with the route the call picked. On the engine route `select_slot` presses the hotbar key, and `hold` the keys it names, on the game's own keyboard through the provider (the built-in one sends them with the agent's `ui.key`, so they reach a Linux `desktop`-mode game too), and `hold` turns the movement keys (`w`, `a`, `s`, `d`, `space`, shift, ctrl) into the held movement vector; a provider that takes no keys leaves them to the keyboard route. `mine` always holds the keyboard route's left mouse button, because the engine route cannot hold an attack (the agent's `input.attack` is one click), so it fails on a game without a keyboard route.

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
| `fight` | Melee against a `target` (entity id or type, default the nearest hostile mob within `radius`, 16 by default), then the next one when `all` (default unless the target is an id). See [Skills](#skills) below. `crits` (default on), `stance` (the shield: `auto`, `kite`, `guard`) and `timeoutMs` (default 60000) are optional. The message lists the kills, hits, critical hits and hits blocked |
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
| `fight` | `target`, an entity id or type such as `zombie` or `minecraft:skeleton` (default the nearest hostile mob). `all` (default true unless `target` is an id). `radius` 1 to 64 (default 16). `crits` (default true). `stance` `auto`, `kite` or `guard` (default `auto`, see [Skills](#skills)). `timeoutMs` 500 to 300000 (default 60000) |
| `flee` | `from`, an entity id or type (default every hostile mob within 24 blocks). `distance` 2 to 64 (default 12). `timeoutMs` 500 to 300000 (default 8000) |
| `eat` | `slot` 1 to 9 (default the best food for the current food level). `timeoutMs` 500 to 30000 (default 3100) |
| `use_on` | `target`, an entity id or type (required). `all` (default true for a type). `radius` 1 to 64 (default 24). `timeoutMs` 500 to 300000 (default 60000) |
| `play` | See [play](#play) |

#### Pathfinding

`goto` reads the blocks around the player from the helper pack's `grid` query, 16-block sections at a time, and keeps them, so walking on only fetches the sections it has not seen or that are older than 30 seconds. Each block falls in one class, which is passable (air, plants, torches, carpets), solid, bottom slab, stairs, water, lava, dangerous (fire, cactus, magma, powder snow, berry bush, wither rose, campfire, cobweb, dripstone), climbable (ladder, vines, scaffolding), closed door, closed fence gate, open door or gate, fence or wall, or not loaded. Iron and copper doors count as solid, since a hand cannot open them.

The scan never stalls the game. The helper reads one block of a region and asks the game whether the region holds any other type (`containsBlock`, answered natively). A uniform region is one entry in the reply, and a mixed one is split in two, layers first, down to small pieces it reads block by block. It works through the pending queries for at most 4 ms of script time per game tick and answers when a query is done. The reply lists regions (class and two corners), not blocks. Sections are asked for nearest first, two per query, all in flight at once. Planning starts as soon as the blocks within 6 of the player are in (waiting up to 150 ms more for the rest of the window), and a partial path made that way is planned again as more sections arrive. On a flat world the 32 sections of a planning window cost 17 ms of script time over a few ticks (551 ms before, 218 ms of it in one tick), and a section of rough terrain costs about 22 ms spread over 5 or 6 ticks.

The planner is A* over a 48 by 48 block window around the player, 6 blocks up and down, stretched toward the goal. It knows the moves of a Bedrock player. It walks in eight directions without cutting corners, steps up one block with a jump, walks up stairs and slabs without one, drops up to 3 blocks (which costs no health) and any height into water, swims (at the surface where it can, since under water costs more), climbs ladders and vines, opens wooden doors and fence gates, and sprint-jumps gaps of 1 to 3 blocks from the edge, landing level or one lower. A 3-block gap needs a block of run-up. A 2-block gap needs none, so a line of 1-block pillars is a chain of jumps. It never steps into lava, fire or cactus and pays extra to pass next to them, so a way around a lava strip wins over a jump across it. Falls and gap jumps cost more than walking. A goal outside the window gives a partial path toward it, and the player plans again from its end.

When no move reaches a goal inside the window, `goto` recovers in this order, each step only when the one before found no way:

1. **Closed in.** When the open blocks around the goal (within its radius, at its height and the one above) and every open block they connect to are known, fewer than 4096, and walled in by solid blocks, fences and walls, with the player not among them, it fails at once without walking.
2. **A wider window.** When the search reached within 4 blocks of the window's edge (a wall wider than the window), it plans again over 80 by 80 blocks, then 128 by 128 (up to 120 000 blocks searched), still limited to the blocks the helper serves. A partial path that ends where the player stands gets the same wider plans.
3. **Legs to the closest spot.** When the search ran into the edge or into blocks the helper does not know (an unloaded chunk), the player walks to the closest spot it reached and plans again from there, after fetching the sections that held unknown blocks again. Legs go on while each brings the player at least 1 block nearer the goal than before; three legs in a row without that, or a closest spot within 1.5 blocks of the player, end it.

The failure keeps the planner's message (`no way to reach X, Y, Z from a, b, c within 3 block drops, jumps of one block and gaps of up to 3 (searched N blocks). The closest reachable spot is a, b, c, D blocks away`) and adds what was tried: `Tried a window of W x D blocks around the player and walked N leg(s) to the closest spot, getting within D blocks of the target:` and why it stopped (`the target is closed in by blocks on every side`, `every block the player can reach is known and closed in`, `the closest spot is where the player stands` or `3 legs in a row brought the player no nearer`).

The player follows the path continuously. The crosshair looks about 3.5 blocks ahead along it, moving like the hand described below, while the movement steers toward a point just ahead on the path. It sprints on straight stretches of four blocks or more, jumps just before a one-block step and at the edge of a gap, and holds jump in water and on ladders, also to get off the top of one. In the air after a gap jump it steers the landing like a player. It predicts where the jump comes down from the speed and the fall still to go, holds forward while that is short of the middle of the landing block, lets go when it is on it, and pulls back when the jump would carry past, so a sprint jump stops on a 1-block pillar. Climbing up a ladder it pushes into the ladder's wall, and climbing down it lets go of every key, since walking off a ladder is a fall. A ladder only catches a player whose feet come down inside its block, and a player standing on the ledge above tips off about at the ladder's middle, so stepping onto the top of a ladder it stops just short of that point and edges over in taps of the walk key about one game tick long. The stop allows for the speed the game reports being what is left after ground friction, so the player slides about 0.7 blocks after letting go of a walk. Falling into the ladder and climbing down it, it steers back over the ladder's middle when it drifts more than 0.2 blocks off. It stops to look at a closed door or gate and right-clicks it open, and once past it and clear of it turns back and closes it (when walking to a place, not when following an entity). An open door is a thin panel at one edge of its block, so it aims at the middle first and then near each edge until the click lands. A door stays on the list to close when the player plans again right after it. It plans again when it leaves the path by more than 1.6 blocks, falls below it, or makes no headway for 2 seconds (after one jump at 1 second, as a player bumping an edge would, but never on the ledge above a ladder), and when an entity target moves 1.5 blocks from where the path ends.

The mouse moves like a hand. A loop at 120 Hz sends small relative steps along minimum-jerk submovements, and a turn's duration follows Fitts' law, from about 150 ms for a small nudge to 450 ms for a turn around. Large turns land a few percent long or short and get a short correction, with a slight arc and jitter. The loop corrects from the streamed state while it moves. It adds the steps sent since that state left the game, so it neither waits for the view to settle nor counts a step twice. The mouse sensitivity and the input delay are learned from every turn. Keys, sprint, jumps and the mouse run at the same time, and the state streams every game tick while an action runs (every second tick when idle). Input goes through one long-lived helper process per game (`xdotool` on Linux, a PowerShell `SendInput` helper on Windows), so a step costs no process start.

On the engine route the camera runs the same curve, overshoot, correction and jitter, but each frame sends the view itself instead of a mouse step. The commanded view is exact, so there is no sensitivity to learn and no delay to predict. When something else turns the player (a respawn or a teleport), the camera starts again from the rotation the motion stream reports. Movement is a forward and strafe vector toward the goal, sent again every 300 ms so a provider can let go by itself when updates stop. A movement change does not wait for the provider's answer (about a frame): one update is in flight at a time and only the newest movement goes next, so a skill that changes its feet every tick keeps its pace. `attack` on this route swings as soon as the exact view and the distance put the target in reach, counts only swings that the provider reports as hitting the target, and the message lists the swings that missed.

`shoot` models each projectile per game tick with the vanilla update order (move, multiply the velocity by the drag, subtract gravity). The values, in blocks per tick, come from the vanilla behavior pack. Snowball and egg launch at 1.5 with gravity 0.03 and drag 0.99. An ender pearl launches at 1.5 with gravity 0.025 and no drag. A trident launches at 4 with gravity 0.1 and drag 0.99. A fully drawn bow launches its arrow at 3, as in Java Edition, with the arrow's gravity 0.05 and drag 0.99.

#### Skills

Skills are whole behaviors that run until they are done or something else takes over. `play` stops one the moment it picks another, and every key is let go in between.

`fight` takes the hardest-hitting weapon in the hotbar (swords and axes by damage) and keeps the crosshair on the middle of the target's body. Toward an archer more than 6 blocks away it runs from cover to cover when the blocks around have some (a standing spot within 6 blocks, at least 1.5 blocks nearer the archer, with a solid block between the archer's eyes and the player's chest, read from the navigation grid every 1.5 seconds), and otherwise weaves up to 50 degrees either side so the arrows miss. In reach it stands at 2.8 blocks and walks in again only past 2.95, so the feet do not flip between the two at the edge. When the straight approach is blocked (a wall, a ledge, a hole) it finds a way to the target like `goto`. Bedrock has no attack-strength cooldown for any weapon, but a struck mob ignores hits for 10 ticks, so each mob is swung at at most every 0.5 seconds; another mob in reach can be struck meanwhile (up to one swing every 150 ms). Zombies, spiders and most other melee mobs attack with the game's box reach (`minecraft:behavior.melee_box_attack`): their collision box grown 0.8 blocks on x and z has to overlap the player's, so a zombie reaches 1.4 blocks centre to centre straight along x or z and 1.98 on a diagonal (a spider 1.8 to 2.55). Measured on retail, a zombie or husk attacks as soon as the player is in that reach and then exactly every 20 ticks while the player stays in it, and the player's swing lands up to 3.0 blocks centre to centre (3.06 eye to the aim point on the body) and not at 3.1, so `fight` swings only when the mob will be within 3.05 of the eye (to the aim point) as the swing lands, and its feet hold a target at about 2.8 blocks. Against a spider it does not jump and holds its swing while the spider leaps or climbs (shield up within 3.5 blocks), hitting it as it lands.

`fight` swings when the target is within reach and the view is on it. On the engine route the view in the motion stream decides. The keyboard route reads it from the helper 150 to 250 ms late (tens of degrees off at close range while the player and the mob move), and the click lands after the mouse steps already sent, so the view those steps will give decides. The player's streamed position is as late, so on the keyboard route the camera and the footwork carry it forward by the velocity over that latency. The keyboard cannot tell what a click struck, so a click counts as a hit once the target's health reading drops. Until then a melee mob is taken as struck (its 10-tick invulnerability counts from the click), but a creeper is not, so a strike that missed is followed by the next swing instead of a retreat. Without a drop after 0.4 seconds the hand may swing again, and after 0.9 seconds the click counts as a miss.

Against a creeper `fight` closes in and strikes. The creeper's data says the fuse lights within 2.5 blocks and goes out past 6, but measured in the game (horizontal centre distance, as `fight` reads it) it lights when the gap between its box and the player's (both 0.6 wide) is under 2.5 blocks, which is a centre distance of 3.1 along an axis and about 3.35 on a diagonal, coasts about 0.15 to 0.25 further as it stops to swell (so it stands inside reach when it comes along an axis and up to 0.35 outside it from the side), and goes out once the player is 7 blocks away (at 6.2 it still blows). The helper pack reports every creeper's fuse from the creeper's own entity events (`minecraft:start_exploding` and `minecraft:stop_exploding`), lit or not and how many ticks it has burned, and `fight` takes that as the answer. It meets a creeper that comes on by itself standing still and strikes it standing still once it is inside reach (3.0 blocks, where a swing lands; none is sent beyond it), so the run starts from where the strike stood: live, sprinting in at a creeper that walks in carried the player to about 2 blocks after the strike and lost every creeper. With the swing ready and an unlit creeper that stands just beyond reach (up to 0.3 blocks), it steps in by taps (forward for one tick, then let go, the next tap only after 250 ms; never held: held, the step overshot live from 3.1 to 2.24). A lit creeper is judged by where it will stand: from the reading once it shows the creeper slowing (the rest of its coast), before that from the box gap for its bearing. Inside reach, `fight` waits for it standing; up to 0.45 blocks outside, it closes the difference while the creeper still slows, forward for as many ticks as the gap needs (1 to 3: about 0.11, 0.27 and 0.43 blocks with the coast), then lets go, and swings the first tick the reading is inside reach, about 200 ms after the creeper lit. Once a strike attempt started it stays with it until the swing went out; a mob passing through the line is waited out rather than struck through. It walks up to one that waits or backs off (sprinting while it is more than 5 blocks away: a sprint let go carries the player on for nearly a block, unless another melee mob stands nearer or is about to reach the player: then it backs off away from them, and the creeper, faster than a zombie, comes out ahead of the group), does not jump, and backs off after a hit only while the swing cools down with the creeper in reach. Without the fuse report (an older helper) it guesses: a creeper with a target always walks at it unless its fuse burns, so the fuse counts as burning when the creeper came within 2.8 blocks, when it stands still within 4.5 blocks (or for 0.3 s within 7.3), when it stood still after coming within 3.3 blocks in the last 0.9 s, or after a strike until it walks back in, and it then walks up only to a creeper more than 4.5 blocks out and not to one it struck in the last 1.5 s. It remembers each creeper's fuse for the whole `play` run. Once the fuse burns, a creeper in reach with the swing ready is struck first (the knockback throws it 2 to 3 blocks) while a hit still leaves the run time (a struck creeper is past 7 blocks about 0.8 s after the hit); a swing that misses falls back on the shield, which blocks the blast and loses the creeper. Then the player backs straight off out past 7.3 blocks, the view kept on the creeper, at full backward input from the next tick, no turn and no sprint, and comes back once the fuse is out. Walking backward is as fast as forward (4.32 blocks a second) and needs no turn; with the hit's knockback it puts the creeper past 7 blocks about 0.8 s after the hit. Live, turning round to sprint moved the player only 1.5 to 2 blocks in the first second (the turn, and no push from the feet while the view swings) and lost most creepers. Once chosen, the escape stays the decision for that fuse: no strike or step back into it. The way back is the open heading nearest straight back (up to 90 degrees aside: strafing is as fast), leaning only as far as walls, holes and the other mobs require (4 blocks clear of creepers, about 2 of other mobs). Only when the nav grid shows too little free run behind to get past 7 blocks (counting the 2 blocks a hit in the last 0.6 s throws the creeper) does it turn toward the open heading (up to 120 degrees off straight away) and sprint; when that makes no progress it turns 75 degrees aside. Only when the run cannot get out of the blast's 6-block reach before it (with room behind the backward walk, counting a creeper struck in the last 0.6 s as thrown 2 blocks farther; without room the turn and the sprint) and the creeper is within 5 blocks does it raise the shield toward the creeper, never during a backward escape with room after a hit on that fuse (the shield would slow the walk to a sneak, and the knockback has the creeper about 5 blocks off by then), which blocks the explosion (farther out the blast does little, and sneaking would give up getting past 7 blocks). With a zombie beside the creeper the strike can cost the kill: the zombie walks into the line or hits the player during the close-in or the escape (a hit taken throws the player up for about half a second), and the shield then blocks the blast, no damage taken but the creeper lost. With a bow and arrows in the hotbar it shoots a creeper that is more than 5 blocks away, walking backward while it draws, and takes the sword once the creeper gets closer.

Against a group, `fight` reads the hostile mobs within 8 blocks every 50 ms, from the helper's state stream, which carries the 8 closest living entities within 16 blocks every tick. One loop runs the whole fight: among melee mobs it changes target inside the loop without stopping the feet, after a kill it turns to the next mob of the crowd at once, and the hand strikes whichever hostile mob under the crosshair is in reach and can take a hit (on the engine route; the keyboard route strikes only its target). A creeper within 5 blocks comes first, unless another mob is a block or more nearer (that one is struck first: the creeper footwork cannot strike the mobs in front of it), one whose fuse burns within 7.5 blocks always, and a creeper target is kept while it stays within 5.5 (7.5 when lit), since only the creeper footwork keeps its fuse from finishing. A turn to or from a creeper or an archer sets that fight up again, with the feet still moving, and the next such turn waits 0.6 s unless it is to a burning creeper or one within 4 blocks, so two choices cannot flip tick by tick. While a creeper is the target the pack's keep-out rule still holds: a melee mob about to have the player in its reach is backed off from, except during the strike and the escape from the fuse; a creeper that comes with zombies is waited for standing (it outruns them and leads by about a block), struck, and the backward escape outruns them all. A creeper with another mob in the line (under the crosshair, nearer) is not struck through it: a lit one is escaped from instead. An unlit creeper target farther out is dropped for a nearer mob, so the player does not back off from the zombies in front of it forever. It remembers every creeper's fuse across targets, so turning to a creeper that lit while the player fought another mob still runs from it.

Against melee mobs `fight` keeps an attack clock for each one: when it can attack next, from the last attack the fight saw (a hit taken or a hit the shield blocked). Measured on retail, a zombie or husk attacks again 20 ticks after an attack that landed and 30 ticks after one the shield blocked. An attack is credited to the mob in reach whose attack was due first, and with it to any other mob in reach whose clock has been ready for 250 ms or more (two attacks on one tick show as one). From all of them, not only the target, it decides every tick:

- **Where to stand.** It walks up to a mob that does not come (sprinting beyond 6 blocks), but waits for one that comes at the edge of its reach (standing within 4 blocks), and never steps where a melee mob would have the player in reach on arrival. It strikes a mob first at the edge of reach (a hit there is free: the mob's reach is shorter and the knockback sends it back), and it stands only while the hand can strike, this tick, every mob coming in inside the strike range (3.0 blocks, and 0.1 beyond it: under a tick at a zombie's pace): one it cannot (its 10-tick invulnerability left, or the view off it by more than the swing's tolerance as the game shows it) is stepped away from at once, walking backward at 4.32 blocks a second against its 2.3 while the view keeps turning, and the hand strikes on the way the tick it can. No estimate of how soon the turn lands decides this: live, every hit taken in the slow runs came with the feet holding for a turn estimated to land in time. A mob just beyond that range that would have the player in its reach before the hand can strike it (the camera's turn onto it, 150 to 450 ms plus the view's latency) is stepped away from too. The swing goes out where the mob reads now, with no lead for its walk: at 2.9 blocks (centre to centre) for a mob walking in and 2.99 for one standing or backing off, and only with the eye within 3.05 of the aim point (not from the top of a jump); measured live, a mob walking in read at 3.05 or more was hit 28 times in 604 swings, at 2.85 three times in four. A mob the hand cannot strike is not stepped back from while another one coming in, as near or nearer, is under the crosshair. Among the mobs in reach it strikes the one the hand can strike soonest (under the crosshair, or the shortest turn), keeping the current one while it is within 100 ms of that. It jumps for a critical hit only in place (one jump sent per crit), only with no other mob within 4.5 blocks, and only when no attack can come within 700 ms (the jump leaves the player unable to swing on its way up).
- **The shield (`stance`).** A raised shield (sneaking with a shield in either hand) blocks a melee hit only when the server saw the sneak at least 6 ticks (300 ms) before the hit (measured: a lead of 6 to 9 ticks blocked 12 hits of 12, 1 to 5 ticks blocked none of 22), and only from an attacker within 90 degrees of the view (blocked at 85 degrees, not at 95). Input reaches the server 1.5 to 2 ticks after it is sent, so `fight` sends the sneak 400 ms before the attack (300 ms plus the input latency, more on the keyboard route) and counts a mob as covered within 75 degrees of the view. A swing lowers the raised shield for 12 ticks: an attack 12 ticks or less after a swing lands, 13 or more is blocked again (measured; swinging every 300 to 1000 ms behind the shield let 38 of 41 attacks land). So behind a shield raised for an attack it swings only when no mob can attack within 650 ms plus the input latency (750 ms on the engine route): right after a block, when the blocked mob waits 1500 ms, there is room for a swing at once and another 500 ms later. `stance` `kite` never raises the shield: it backs off whenever a mob would have the player in reach within the input latency and 150 ms more (on retail the fewest hits taken: 0.1 to 0.3 damage a fight). `auto` (the default) is `kite`'s footwork exactly, plus the shield only boxed in (under 1 block of free run behind), raised when it can be up 400 ms ahead of the earliest attack due from a mob in front and no swing will hold it open then (a swing lowers it for 12 ticks); never late. Holding the shield anywhere else costs hits: live, a shield held while standing cost about one hit a fight, since lowering it holds the feet still some 4 ticks before a retreat and a hit struck sneaking knocks the mob back less. The shield-forward rhythm (block, strike in the cooldown after the block, block again) is `guard`: it raises the shield whenever a melee mob is within 3.6 blocks (stepping back instead when the shield could not be up before the next attack and the feet can clear it). After 1.5 seconds behind the shield without a swing (its clocks leave no window), it steps out when there is room: shield down, the footwork of `auto`, raising the shield again only for an attack it can block in time (as `auto` does boxed in), and back to holding it after the next block. When the clocks of three or more mobs leave no window for 3 seconds and there is no room to step out (a corner), it strikes once right after a block, shield down, taking at most the next attack: a landed attack puts that mob on its 20-tick clock, which shifts the clocks apart. In all of them a creeper's blast is shielded as described above, and an axe (a vindicator or a piglin brute) is never blocked, since its hit disables the shield for 5 seconds.
- **Beside or behind.** The shield covers the front half only. A mob about to have the player in reach more than 75 degrees off the view is stepped away from when the feet can do it in time; behind a raised shield, or when the feet cannot, the view turns so the whole pack is in front (when it fits in 150 degrees) and the shield stays or goes up, and when the pack is around the player the fight walks out along the open way. Every step back picks the open heading near the one away from the pressing mobs (up to 90 degrees aside, so it runs along a wall rather than into a corner).

Against a zombie or husk holding a spear (the helper reports a mob's main-hand item as `held`: from the equippable component when the mob has one, else by asking the game with the `hasitem` selector for each spear, one mob a tick, cached and read again every 5 s; and a mob the helper's hurt log names as the damager of a melee attack (`entityAttack`, never an arrow or a blast) from 2.3 blocks or more, of a type that can carry a spear, is taken to hold one for the rest of the fight), `fight` fights as the spear works in the game: the mob charges from 6 to 7 blocks, hurts on contact while the two close faster than about 0.9 blocks a second, and also from up to 3.35 blocks when the player moves fast (live, every such hit came with the player at 4.1 to 5.7 blocks a second), then backs off to 9 to 11 blocks and comes again. So with a spear mob near the feet never go faster than 3 blocks a second (the engine route's movement is analog): a charge farther out is waited for standing; once one charges within 3.8 blocks they give ground at its speed less 0.3 blocks a second, so its contact cannot land, and the hand strikes it on the way when it reads in the strike distance; one standing is stepped in to only with the swing ready and the view on it; one backing off is chased at a sprint only beyond 5 blocks, nearer at its own speed plus 0.8 (struck from 2.8 as it backs off: its reading lags behind it). No critical jumps with a spear mob within 8 blocks, and no shield near one (live, 19 spear hits of 34 came through a raised shield). One backing off past 4 blocks is gone after at a sprint instead of waited for, and a `fight` over all hostile mobs keeps going while one it struck is alive within 24 blocks. Live before this (`combat/spears3`, three husks with iron spears): 1 run of 5 won, 10.6 damage a run.

`fight` returns, on both input routes and also when it fails, times out or `play` preempts it, what it did as `fight` on its result: `kills` (short mob type to kills by the player), `swings`, `hits` (swings that struck the target or another hostile mob), `misses` (swings that struck nothing; `swings` is `hits` plus `misses`), `crits`, `hitsTaken` and `damageTaken` (every health drop the fight saw), `blocked` (hits the raised shield took: each rise of the off-hand item's durability damage the helper streams while the shield is up counts one, so two hits on one tick count once; nothing is counted without that reading) and `timeMs`. The message says the same: `killed 3 husk with iron_sword: 11 swings, 6 hits, 5 misses, 1 critical, took 2 hits for 3.5 damage, blocked 4 hits, in 10.4 s`. Kills come from the helper's death log (the deaths the player caused since the fight started), so a mob killed by the last blow before the fight turned to another, or by a swing aimed at another, counts; without the log, every mob the fight struck that is gone at its end counts, except a creeper last seen at full health (it blew up). The engine route reports what each swing struck. On the keyboard route a swing is a hit once the target's health reading drops, and a miss when it has not dropped after 0.9 seconds, when the next click goes out first, or when the fight leaves the target first.

`flee` faces the escape direction, away from the threats weighted by their damage and closeness, and sprints, sprint-jumping on the straight and jumping when it bumps into a step. When it stays stuck it turns aside, alternating sides and turning wider each time. When a threat stays within 2.5 blocks for 1.5 seconds (a wall or a corner), it gives up as cornered, and `play` fights back for 4 seconds before it tries to run again.

`sculk bench combat` measures these skills in built arenas in the real client (see [Bench](bench.md)).

#### play

`play` pursues a goal without the agent. The goal is compiled into a plan first: steps that run one after another, each with a check against the game, and standing orders. The built-in tactic scores choose every move inside a combat or movement step.

##### The plan

The goal grammar splits the goal into clauses at `then`, `and then`, `;`, `after that`, `afterwards` and the end of a sentence, and at commas or `and` when every side is a step it understands. "X after Y" and "after Y, X" run Y first. Each clause becomes one step:

| Step | Written like | Done when |
|---|---|---|
| `kill` | "kill 3 zombies", "take out the zombies", "get rid of those three undead", "clear the arena", "kill the hostile mobs near you" | That many of the type dead during the step (one for a lone singular): killed by the player, or by another mob's attack within 24 blocks; or none of the type (or no hostile) left within 24 blocks. A step with a count stops with `targets_gone` once none of its targets is left within 24 blocks before the count is reached (after some were there) |
| `reach` | "go to 10 64 -20", "walk to 10, -5" | The player is within 2 blocks of x/z |
| `use_on` | "hit every cow near you once with the held item" | Every cow within 24 blocks has been hit by `use_on` |
| `reach_block`, `reach_entity` | "go to the gold block", "stand next to the villager", "find the furnace" | The player stands within 3 blocks of the nearest one |
| `craft` | "craft an iron sword", "make 4 sticks", "forge a sword" | That many more of the item in the inventory (the ingredients are smelted, crafted or fetched first when needed) |
| `smelt` | "smelt the raw iron", "cook 3 beef", "smelt the ore into ingots" | That many more of the result in the inventory |
| `trade` | "trade for an emerald", "buy an emerald from the villager", "get an emerald from the farmer" | That many more of the item in the inventory |
| `fetch` | "get the diamonds out of the chest", "take 3 diamonds from the chest", "grab the diamonds" | That many more of the item in the inventory, also out of a shulker box lying in a container; a plural without a number (`all`) takes every one the containers hold |
| `equip` | "equip the shield", "wear the iron helmet", "hold the bow" | The item is held, worn, or in the off hand (a shield) |
| `survive` | "survive for 2 minutes", "defend yourself", "wait here for 30 seconds" | The time has passed (without a duration: the whole time limit). A duration alone is not enough: "dance for 30 seconds" is not understood |
| `free` | anything else | Never: see below |

Item, block and mob names stay as written for the task steps' name resolution (the game's registry, the inventory and the recipes; a tie goes to what is at hand). Standing orders come from keywords: "with the shield up", "behind your shield" or "tank" fight with `stance: guard`; "keep your distance", "kite" or "do not use the shield" with `stance: kite`. An explicit `stance` wins.

The grammar alone compiles the goal. A clause two patterns claim goes to the first in the order of the table; a clause it cannot place is `free` and ends the run as not understood (below). A decision model placing those clauses was measured on the live game and made no clear difference ([Bench](bench.md#latest-results)), so none is asked about the goal.

##### Running the steps

Every `stepMs` (250 ms by default) the loop reads a threat map. It holds the living entities within 24 blocks with their distance, how fast they close in, how dangerous they are, and for creepers how long the fuse has been burning, plus the player's health, food level, armor points, best weapon and best food in the hotbar. It checks the goal, scores what the player could do now and keeps the best tactic running as a skill.

| Tactic | Runs | Scored high when |
|---|---|---|
| `fight` | one `fight` (`all`, the play's `stance`) started on the best-scored target | The target is a goal target, or a hostile mob that is coming or close. Nearer and more dangerous targets score higher. The fight is one step whatever the target: it moves on to the next hostile and chooses whom to strike by itself, and `play` keeps it running until something else (a flee, eating) scores clearly higher. A kill step's target alive within 24 blocks is never idled at: when nothing else is offered (it keeps away or walks off, or the player is low on health and it is not at hand), the fight goes after the nearest one at a low score, which any flee or meal still beats |
| `flee` | `flee` | A creeper's fuse has burned for half a second within 5 blocks (an emergency), unless a fight is running (it turns to any creeper within 5 blocks and its footwork backs away from the fuse). Also when health is at or below 6 with full iron armor (up to 8 without armor) and a hostile mob is within 8 blocks, after which the player keeps away (fleeing from mobs within 12 blocks and fighting only one at hand) until health is back to 12. Archers do not count for this: running keeps the player under their arrows, so an archer that has the player in range is fought at its full score instead. And when the mobs around are far more than the player's health and armor can take |
| `eat` | `eat` | The food level is 14 or less, or health is 14 or less and the food bar is not full. Between fights, or mid-fight when no hostile mob is within 4 blocks, no archer has the player in range and no mob can reach the player before the food is eaten (1.7 s, counting a mob that is knocked back as coming at its chase speed, 2.3 blocks a second for a zombie). Hurt and safe, eating outscores walking to the next fight. Health only comes back on a nearly full food bar |
| `goto` | `move_to` with pathfinding | The goal is a place the player has not reached |
| `use_on` | `use_on` for one entity | The goal is to hit every X once and this X has not been hit |
| `idle` | A short wait | Nothing else applies |

A new tactic must beat the running one by 0.08, so the player does not flip between two close options. A combat or movement step is checked against the game on every decision and counts as done once the check holds twice in a row.

Kills come from the helper pack's death log (deaths the player caused), so a creeper that blew itself up is not a kill. A mob seen within 24 blocks that died by something else (spear husks run each other through with their charges) is not a kill either, but it counts toward the kill step as a target gone: the step ends with both numbers, e.g. `goal done: 3 of 3 husk dead (2 killed by the player, 1 by another husk)`, and the stats carry `kills` and `killed` (the player's only) and `otherDeaths` (by type) apart.

An emergency (a score of 0.9 or more, such as a burning creeper) preempts the running tactic at once. The tactics `fight`, `flee` and `eat` stay active during every step.

A task step (`craft`, `smelt`, `trade`, `fetch`, `equip`, `reach_block`, `reach_entity`) runs as one procedure inside sculkwire (walk, open the station, move the items, wait for the furnace) while the loop keeps reading the threat map. A hit, or a hostile mob within 6 blocks, aborts it (its screen is closed and every key let go), the tactics fight or flee until no hostile is within 8 blocks, and the step starts again: at most 2 retries, then the plan fails with the reason. A task step that fails by itself (a missing ingredient, no station, no offer) ends the plan with its message.

A task step finds its station, the containers, the block of `reach_block`, the mob of `reach_entity` or the traders first within 16 blocks of the player (the helper's `blocks` query reads a cube of at most 16 blocks around a point, every type of the lookup in one scan). Only when that finds nothing does it look further, out to 48 blocks: for blocks, the 16-block cubes on a ring around the player, 33 blocks apart, nearest first, each sent with its centre as `x`, `y`, `z` and skipped when the block at its centre does not read (an unloaded chunk), at most 12 cubes in all, stopping once no cube left can hold a block nearer than the nearest found; for entities, one more `entities` query with the 48-block radius. What it found is sorted by distance to the player. A lookup that finds nothing says how far it looked: `no crafting table within 48 blocks (searched 9 cubes)`, `no villager or wandering trader within 48 blocks`, and the containers' messages say `within 48 blocks (searched 9 cubes)` too.

A task step uses a station, a container or a trader from where the player can. It walks next to the block. It then tries the use from there: first aimed at the block's nearest point, then at each face the eye is on the side of. If that fails, it tries up to 4 other spots it can stand on within 2 blocks of the block, nearest first, with the same aims. It stops at the first screen of the right kind. That screen must also belong to the wanted block: `container open` names the block position the screen opened for. A chest of the same type in the next cell on the same level counts as the other half of a double chest; any other block that opens instead is refused with `it opened the chest at x y z instead`. One block gets at most 12 uses and 30 seconds. After that the step moves on to the next block of the type (at most 3), and the failure names every spot and aim it tried. A trader gets the same spots and caps. Before each use the view turns onto the trader's body, and `player_state`'s crosshair pick must rest on that trader: another entity or a nearer block in the way moves the player to the next spot. The trade screen that opens must report this trader's id in `trader`. When the screen reports no id, a screen without the wanted offer while the crosshair rests on another trader counts as the wrong one. A wrong screen is closed and the next spot tried.

A task step decides every choice by fixed rules; no model is asked. An item name resolves to the exact id, then the id without namespace, then the ids containing every word of the name. A material word ("wood pickaxe", "a pickaxe out of the planks") selects that variant, and words after the name that are not part of it ("made at the table over there", "please") are dropped. When the name still fits several items:

- A craft with several variants and no material ("a pickaxe") takes the best material it can make from the inventory, else from the inventory and the containers near.
- Otherwise it takes the item at hand, then the one in the containers near, the one there is most of, then the plainest id.
- A tie that remains fails the step naming the candidates: `"the ore" as the item to smelt ... could mean raw_copper or raw_iron equally: name one`.

Of several recipes the inventory can make, the first in the game's own order (priority, then id) is used, and the actions say which. A refused screen move is repaired by the first that applies of another slot, fetching the missing item from a container near, another station of the same type, or giving up.

The run stops when the last step is done (`goal_done`), when the player dies, when `durationMs` runs out, or on an error: a failed step, or the simulation being paused.

A part of the goal the grammar did not understand (a `free` step) does not idle to the time limit. The steps before it run as usual. On it, the player still defends itself (fights, flees, eats), and once there has been nothing to do for 5 s (only `idle`, no hostile within 16 blocks) the run stops with `stoppedBy: "goal_unknown"`. The message quotes the part ("did not understand \"dance a little\"", after "did 1 step(s) (go to 1 1), then" when steps ran before it) and lists the forms `play` understands with one example each: kill ("kill 3 zombies"), reach ("go to 10 64 -20"), hit every ("hit every cow once with the held item"), craft ("craft an iron sword"), smelt ("smelt the raw iron"), trade ("trade for an emerald"), fetch ("get the diamonds out of the chest"), equip ("equip the shield"), go to ("go to the gold block"), survive ("survive for 30 seconds"). The step's plan entry is `failed`. A goal that says to survive, defend or wait is a `survive` step and runs to its time; a duration alone ("dance for 30 seconds") is not understood.

| Field | Default | What it does |
|---|---|---|
| `goal` | | What to achieve, in plain words (required) |
| `durationMs` | 30000 | Time limit, 1000 to 300000 |
| `stepMs` | 250 | Time between tactic decisions, 100 to 1000 |
| `allow` | all | Tactics `play` may use, from `fight`, `flee`, `eat`, `goto`, `use_on`, `idle`. `idle` is always allowed |
| `stance` | the goal's order, else `auto` | The fights' shield stance, as `fight`'s `stance` (`auto`, `kite`, `guard`) |

`play` runs as a background job, because a run lasts longer than most MCP clients let one call run. It must be the last action in the list. The call returns at once with the job id in `job` and `status: "running"`, and [player_job](#player_job) follows it. Only one play job runs at a time. Starting another stops the first, and every other `player_act` call is refused until the job ends or `player_job` stops it. Play jobs also stop on `game_stop`, on `game_launch` and when the MCP server shuts down.

The finished job carries the stop reason, the goal check (`kind` of the current or last step, `known` when every step has a check, its progress), the plan, the standing orders (`orders.stance`, from the goal or the `stance` field), combat numbers (decisions, kills by type, swings, hits, misses, critical hits, hits taken and damage taken as the loop saw the health drop, hits blocked, deaths, final health), and a trace with one entry per tactic run. Each plan entry has the clause (`text`), `kind`, `status` (`done`, `failed`, `running`, `stopped` or `pending`), `ok`, `message` and `ms`, and for a task step its `actions`, `gained` (inventory change over every attempt), `reason` when it failed and `retries`. A trace entry has the tactic and target, its score and the reason it was chosen, and how it ended (finished, or preempted by the next tactic; a preempted fight still lists its numbers). The text summary lists the stop reason, one line per plan step, the stance, the combat numbers and the last five tactics.

### player_job

Follows the `play` job that `player_act` started. Without `id` it uses the running job, else the latest one. The last five finished jobs stay readable. A job paused by your F9 takeover stays `running` and continues when you press F9 again. On Windows, a job paused because the game window left the foreground stays `running` and continues once the game window is in the foreground again.

| Input | Description |
|---|---|
| `action` | `status`, `wait` or `stop` (required), see below |
| `id` | Job id from `player_act`, e.g. `play-1` |
| `timeoutMs` | For `wait` only. Longest to block, 0 to 25000 (default 25000) |

| `action` | What it does |
|---|---|
| `status` | Returns the job's progress at once. That is the steps so far, the elapsed time, the plan step being worked on (`planStep`, e.g. `step 2 of 3: craft iron sword, attempt 2`) and the last five actions |
| `wait` | Blocks until the job ends or `timeoutMs` passes, then returns the same as `status`. 25 s stays under the 30 s many clients allow one call, so call it again until the job ends. With a progress token, each step sends a progress notification |
| `stop` | Ends the job, lets go of every key and returns its result |

The result has `id`, `goal`, `status`, `startedAt`, `progress`, and once the job has ended `stopReason` plus `result` (the full play result described above) or `error`. `status` is `running`, `done`, `stopped` or `failed`. `stopReason` is the outside reason for a stopped job (`stop`, a new play job, `game_stop`, `game_launch` or shutdown, by name), the play loop's own `result.stoppedBy` for a job that ended by itself (`goal_done`, `timeout`, `died`, `error` or `goal_unknown`), and `error` for a job whose run failed.

### player_state

Returns the player's position, rotation, ground contact, velocity, health, held item, selected slot (1 to 9, the same number `player_inventory` reports as `selectedSlot`), and the block and entity under the crosshair, as `state`. The helper pack streams it, so the call is fast. While the in-game agent's tick stream runs (during `player_act`), position, rotation, velocity and ground come from it and `source` is `engine`.

The agent's tick stream follows world changes: after leaving one world and entering another it reads the player of the world now loaded, and a tick without a current reading carries no position, which sculkwire drops rather than merge. When the world lists more than one player handle (after a rejoin), the helper reports the one the newest spawn event named.

No inputs.

### player_inventory

The local player's attributes and whole inventory, read from the game on the thread that owns the data. Attributes are `{name: {current, min, max, default, base}}` for every attribute the player has (health, absorption, movement, attack damage, knockback resistance, luck, hunger, saturation, exhaustion, level, experience, ...; `base` is the value before modifiers) plus `armor` (total armour points) and `armorToughness` as `{current}`, computed by the game's own functions. The inventory is `selectedSlot` (the hotbar slot 1 to 9, as `player_state` and `select_slot` count it, so the held stack is `hotbar[selectedSlot - 1]`), `hotbar` (9), `inventory` (27), `armor` (`head`, `chest`, `legs`, `feet`), `offhand` and `cursor`; a slot is `null` or `{item, count, data?, name?, durability?: {damage, max}, enchantments: [{id, level}], lore?, contents?}`, where `contents` holds what is inside a bundle or a shulker box. A bundle's `contents` are the ones `screen` shows: the client holds a bundle's items only once a screen has shown that bundle (it stays known on the HUD afterwards), so a bundle no screen has shown since the world loaded has no `contents`. An enchantment `id` is the Script API's name (`minecraft:unbreaking`); the agent reads the game's numeric id and sculkwire names it (0 `protection` to 40 `breach`), and a number past that table is `minecraft:unknown_<n>` so its level still shows.

Takes no input. The result has `source`, `attributes` and `inventory`. Through the agent `source` is `engine`, the game's own data. When no agent answers (never attached, or the attached agent is gone because it was unloaded or the game restarted) it is `script`, read through the helper pack's Script API components (inventory and equippable), which has no item aux value, no bundle contents and no cursor stack, and only the attributes the running game exposes as components; `note` then says why the agent did not answer. Crafting and setting up inventories stay on commands through `engine_command` (`/give`, `/clear`, `/replaceitem`, `/setblock`).

## Containers and Crafting

These tools use blocks, entities and the screens they open from inside the game: containers, crafting and every station. They go through the [engine](#engine); only `container` `get` has a fallback without it.

### container

Reads a block's container, or the container screen the player has open.

| Input | Description |
|---|---|
| `action` | `get` or `open` (required) |
| `x`, `y`, `z` | `get`: the block position |
| `dimension` | `get`: `overworld`, `nether` or `the_end`; the `minecraft:` id (`minecraft:nether`) and the numeric id `engine_player` reports (0, 1, 2) work too (default: the player's) |

`get` answers `block`, `size` and `slots` for a block that has a container (chest, trapped chest, barrel, shulker box, hopper, dispenser, dropper, furnace family, brewing stand, crafter, ...) in the same slot shape as `player_inventory`; a block without one is `invalid_params` (`-32602`). `open` answers `screen`, `block` and its `position` (`{x, y, z}`) when the screen is a block's (both `null` for an entity's screen or the inventory), `slots` for the screen's own container (not the contents of a shulker box or bundle the player carries; a carried bundle's slot holds them as `contents`) and `playerSlots` for the player's 36 carried slots (hotbar first, then the inventory), and needs an agent.

When no agent answers (never attached, or the attached agent is gone), `get` falls back to the helper pack's block inventory component (`source` is absent from the result; the slots are the Script API's; `note` says why the agent did not answer). `open` has no fallback: the Script API does not expose the open screen.

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
| `dimension` | `block`: `overworld`, `nether` or `the_end`; the `minecraft:` id (`minecraft:nether`) and the numeric id `engine_player` reports (0, 1, 2) work too (default: the player's). The retail agent cannot read which dimension the player is in, so it refuses a stated one: leave it out to use the block where the player is |
| `face` | `block`: which face to use, `down`, `up`, `north`, `south`, `west` or `east` (default: the side the player looks at) |
| `id` | `entity`: the entity's unique id, a whole number in text, as `game_query` reports it (text because it is a 64-bit integer) |

The result has `target`, `screen` (the screen it opened, or `null` when it opened none) and `changed`: a screen opened, or, for a block, the block's state changed (a lever flipped, a button pressed, a door opened). A block is used only once the crosshair is on it: the view is aimed at the block's nearest point, then deeper into its cell, so a thin block such as a floor button or a carpet is reached too; when no view reaches it (something is in the way) the answer is `invalid_params` naming what the crosshair lands on. Read and drive that screen with `screen`.

### screen

Reads and drives the screen the game has open, opened with `interact`.

| Input | Description |
|---|---|
| `action` | `state`, `move`, `act` or `close` (required) |
| `from`, `to` | `move`: `{ container, slot }` each. `container` is a collection name `state` lists (`hotbar_items`, `furnace_ingredient_items`, `stonecutter_input_items`, ...), or a container enum name such as `HotbarContainer` mapped to the open screen's collection; `slot` is 0-based within that collection |
| `count` | `move`: how many items, 1 or more (default: the whole stack) |
| `act` | `act`: `craft`, `stonecut`, `anvil`, `grindstone`, `smithing`, `loom`, `cartography`, `enchant`, `trade`, `beacon` or `take_result` |
| `recipe` | `act` `craft`: the recipe id `craft match` returned (text). `act` `stonecut`: the 0-based `index` of a recipe in `data.recipes` (a number 0 to 255; the CLI's `--recipe 2` is read as one) |
| `times` | `act` `craft`, `stonecut` and `trade`: how many times, 1 to 1000 (`stonecut`: capped at the input blocks in the stonecutter) |
| `name` | `act` `anvil`: the rename text; an empty string clears the name |
| `pattern` | `act` `loom`: the pattern id the screen lists |
| `option` | `act` `enchant`: which of the three options, 0 to 2 |
| `offer` | `act` `trade`: the 0-based index of the offer |
| `primary`, `secondary` | `act` `beacon`: the effect id, e.g. `minecraft:speed`, and a second one |

`state` answers `screen`, `kind` and every container's slots, plus the screen's own `data`. `kind` is the screen family: `crafting_table`, `inventory`, `furnace`, `blast_furnace`, `smoker`, `brewing_stand`, `stonecutter`, `anvil`, `grindstone`, `smithing_table`, `loom`, `cartography_table`, `enchanting_table`, `beacon`, `trade`, `chest`, `barrel`, `shulker_box`, `hopper`, `dispenser`, `dropper`, `crafter`, `horse` or `other`; a kind the agent names that is not in this list is passed through as it is. `containers` maps each container's collection name (`hotbar_items`, `inventory_items`, `cursor_items`, `crafting_input_items`, `trade2_ingredient1_item`, ...) to its slots in the same shape `player_inventory` uses. `data` is `null` for a screen with no state of its own (a chest, a barrel, a hopper, the inventory), and otherwise holds what that screen reports (`netId` is the game's network id, a number):

| Screen | `data` |
|---|---|
| Stonecutter | `recipes` (`[{ index, result, netId }]`, the game's list for the input), `selected` (`-1` for none), `result` |
| Enchanting table | `options` (up to three: `{ option, cost, hint, level, lapis, levelsTaken, enchants: [{ id, level }], netId }`, `option` being the index `act enchant` takes; `cost` is the level the option needs, `lapis` and `levelsTaken` what it takes, option + 1 each) |
| Villager trade | `offers` (`[{ index, buyA, buyB, sell, uses, maxUses, locked, netId }]`), `selected`, `trader` (the trader's unique id as text, as `interact` takes it) |
| Furnace, blast furnace, smoker | `burn`, `cook`: fractions 0 to 1 |
| Brewing stand | `brew` (done), `fuel` (left): fractions 0 to 1 |
| Anvil | `result`, `xpCost`, `tooExpensive`, `name` (the rename text) |
| Grindstone, smithing table, cartography table | `result` (the preview the take reads), `inputs` (slots per input container) |
| Beacon | `primary`, `secondary` (short effect names such as `speed`, a raw number for an effect without a name, `null` when none) |
| Loom | `pattern` (the selected pattern id, `""` for none), `patterns` (the pattern ids the screen offers now, in button order: what `act loom` takes) |

A state the agent decodes but cannot read at that moment is `{ unavailable, anchor }` (the reason in words) rather than a failed call. A field the engine does not report is `null`, never a guess.

`move` moves items between those containers through the game's own item stack requests, the way dragging with the mouse does, and answers `moved` with the `from` and `to` it was given. A stack moved onto a bundle, or a bundle onto a stack, goes into the bundle the way the inventory screen does it (the game's own bundle insert): what fits moves (a bundle holds 64 weight), `moved` is that count, `count` caps it, and a full bundle is `invalid_params`. While the screen is open, a bundle's slot shows its items as `contents` and `state` lists them as `dynamic_container_<id>`; taking items out of a bundle is not supported (`invalid_params`). An empty `from` slot is `invalid_params`; when the screen's own slots hold items it names them (`screenSlots`), because a screen can fill itself as it opens: a trade screen places the selected offer's cost from the inventory. `act` runs the screen's own action through the game's own request and answers `done`, `result`, `consumed` (`[{ item, count }]`), `xpCost` where one applies and `reason` (why a screen refused it). `act loom` presses the screen's own button for `pattern` (one of `data.patterns`; a pattern the screen does not offer now is `invalid_params` and lists what it offers), then takes the result. A crafter's screen has no result to take: `act craft` there is `invalid_params`, and the crafter crafts what `move` placed when a redstone pulse reaches it (the item drops out of its face). `close` closes the screen like `Escape` and answers `closed` and `escapes`: a screen still open 400 ms after an `Escape` gets another, up to three, because a focused text box (the chat screen's) takes the first one; with nothing open it is `invalid_params`, because `Escape` while playing would open the pause menu.

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

The agent's diagnostic fields come with it when the agent reports them (an older agent leaves them out):

| Field | Description |
|---|---|
| `attached` | `false` while the agent is still resolving its anchors right after the injection |
| `mainThread` | Which thread main-thread methods run on and the hook that proved it (`null` before any drain ran) |
| `port` | The port the agent's socket bound; a hot reload that could not take the expected one says so here |
| `drainReleases` | Drains released from outside: a fault inside a handler, or one that never returned |
| `hooks` | Every hook the engine installed: `installed`, `calls`, first `thread` |
| `gameinput` | The GameInput interface the mouse goes through: `hooked`, `patched` (slots), `samples`, `readings`, `kinds` (`mouse`, `keyboard`, `other`), `cursor`, `idleMs`, `lastClick` (`number`, `state`: `queued`, `pressed`, `released` or `dropped`), `versions`, `probe` (why the last probe refused) |
| `ui` | The game window (`window`: `class`, `width`, `height`), its `children` and the OreUI `host` a click is posted to |
| `minecraft` | The game objects the engine steps, each with its `role` (`server`, `client`, `unknown`) |

No inputs.

### engine_command

Runs a command on the game's main thread as the local player, through the engine's command dispatcher, exactly as if it were typed: chat commands, client-side commands and `/reload` all work. The result carries the `command`, `success`, taken from the command's own output (`false` when it reported an error, `null` when it prints nothing, as `say` does), and the game's output text in `message`.

The agent replays the origin of a real player command, so the first command after an attach or a world change types `/testfor @s` in chat itself, with its output kept out of chat. It does so only while the HUD alone is showing; with another screen open the call fails with `anchor_missing` `command.origin` and says to run one line in chat yourself and retry. An empty command or one with a newline is `invalid_params`.

| Input | Description |
|---|---|
| `command` | Command line, with or without the leading slash (required). Newlines are rejected, because the game would split them into several commands |

### engine_player

Returns the local player's `position` (the feet: the bottom of the player's collision box, `null` when not readable), `rotation` (pitch, yaw; each `null` when not readable) and movement since the previous tick (`delta`), read from the engine on the game's main thread, plus the simulation tick it was read on (`simTick`) and the numeric `dimension` (`null` when unknown). When the agent reads them it adds `onGround`, `health`, `selectedSlot` and the raw `dimensionState` value (each `null` when unreadable). Keys an agent answers beyond these are dropped. Needs `engine_attach` and a loaded world; right after an attach it answers `not_in_world` until the agent's first client tick.

No inputs.

### engine_tick

Controls game time. Give exactly one input. The result has `paused`, `ticks`, `scale`, `success` and the engine's own `message` when it said anything.

| Input | Description |
|---|---|
| `pause` | `true` freezes the simulation, `false` resumes it |
| `step` | Pauses if needed, then runs exactly this many simulation ticks (1 to 600) inside one main-thread request and stays paused |
| `scale` | Sets the tick rate multiplier, a positive number |

### engine_screenshot

Writes the next frame the game presents to `path` as a PNG and returns `path`, `bytes`, `format` (`png`) and the image. The picture is what the game window shows: the world, the HUD and any open screen. The in-game agent copies the frame itself, so the game shows no screenshot animation or toast, plays no sound and adds nothing to its gallery, and calls can follow each other at once. The agent writes the PNG uncompressed (about 6 MB at 1920x1080), and sculkwire deflates it again before returning it, so the file and the image are a fraction of that. A game that presents no frame within 3 s (minimized) is a `timeout`.

| Input | Description |
|---|---|
| `path` | Where to save the picture, a host path (default under sculkwire's cache) |

## Game Files

These tools read an installed PC (GDK) copy of Minecraft Bedrock: on Windows the folder Windows registered for the stable and Preview packages, else `<drive>\XboxGames\Minecraft for Windows\Content` (and the Preview) on every fixed drive; on Linux and macOS mcbe-gdk-linux (`~/.local/share/mcbe-gdk-linux/game` and its `game-dir` pointer), then every game folder of each Wine or Proton client install sculkwire finds (BedrockOnLinux and Flarial keep them in `<launcher>/games/<edition>/<version>`, the one the launcher's `settings.json` names first; Bottles, Lutris, Steam); and any folder in `SCULKWIRE_GAME_DIRS` (`;`-separated on Windows, `:` elsewhere). An add-on developer uses them for the per-version `vanilla_1.x` packs that a world's `base_game_version` pins, which the public bedrock-samples repository does not keep, unpacked into plain folders to grep or diff against. `build` picks a build by its key (the game version, or a hash of its folder when the version is unknown), its game version (e.g. `1.21.120.1`) or its game folder, and defaults to the first detected build.

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
