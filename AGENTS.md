# sculkwire: agent rules

Agent-first MCP server + CLI (`sculk`) for Minecraft: Bedrock Edition add-on development.
TypeScript, Node >= 22.18, ESM. Source runs directly (`node src/cli.ts`); `npm run build` emits `dist/`.

Engine work (anything in `native/agent/` or a new agent method) starts with `docs/reverse-engineering.md`. Contributors read `CONTRIBUTING.md`.

## Layout
- `src/core/`: shared contracts. `diagnostic.ts` (the one `Diagnostic` shape + exit codes), `version.ts` (channel + game version), `paths.ts` (cache, data and config dirs), `project.ts` (pack and Regolith discovery), `background.ts` (heavy background downloads only in the MCP server; a CLI command exits at most 3 s after its output), `shutdown.ts`, `cli.ts` (`CliCommand`).
- `src/<feature>/`: one directory per feature. A feature exports `register(server)` from `mcp.ts` and `commands: CliCommand[]` from `cli.ts`; `src/mcp/server.ts` and `src/cli.ts` list them.
  - `knowledge/`: versioned docs, Script API, components, commands, Molang, vanilla samples, changelogs per channel + version, and rockide/schemas (`rockide.ts`). Every source follows its upstream on its own: version pins refresh once a day, `tracked.ts` keeps one folder per upstream release, and the last copy answers offline. `suggest.ts`: near names (substring, then edit distance) for a lookup that matched nothing.
  - `validate/`: pack validator (Regolith projects built with rgl); every diagnostic has file + 1-based line/column. Schemas come from rockide/schemas first, then the engine schemas of bedrock-samples.
  - `runtime/bds/`, `runtime/debugger/`, `runtime/connect/`: Bedrock Dedicated Server, script debugger and `/connect` bridges.
  - `runtime/client/`: the game client bridge.
    - `bridge.ts` (launch, deploy, reload, logs, queries), `launcher.ts` (gamescope, input, stop), `install.ts` (where each client install lives and how it starts), `options.ts` (`options.txt` and its restore record), `world.ts` (test worlds), `deploy.ts`, `contentlog.ts`, `screens.ts` (screen tracking and join recovery), `jobs.ts` (background `play` jobs), `entitystream.ts` (streamed nearby entities and their age), `windows.ts` (Windows-native helpers through PowerShell).
    - `commandfail.ts`: whether a command sent through the script debugger failed, read from its output against the failure messages in the installed game's `texts/<language>.lang` (only the parser's own errors without one).
    - `player.ts`: `PlayerController`, human-like camera and the keyboard and engine input routes. `inputprovider.ts`: the seam through which an extension supplies the engine route, the pause guard, the input lock and game lifecycle hooks; without one the keyboard is the only route.
    - `nav/`: block grid, A* planner and path follower. `skills/`: fight, flee, eat, use_on, defense, tactics and the `play` loop. `bench/`: `sculk bench` harness and scenarios.
    - `helper-pack/`: the behavior pack sculkwire deploys into test worlds (queries, state and entity streams).
  - `runtime/engine/`: the in-game agent (`engine_attach`, `engine_status`, `engine_command`, `engine_player`, `engine_tick`, `engine_screenshot`, `game_input_lock`, `game_settings`, `world_settings`, `game_ui`, `player_inventory`, `container`, `craft`, `interact`, `screen`; `sculk engine attach|status|command|tick|screenshot|player`, `sculk game lock`, `sculk game settings`, `sculk world settings`, `sculk game ui`, `sculk player inventory`, `sculk container get`, `sculk craft`, `sculk interact block|entity`, `sculk screen state|move|act|close`).
    - `build.ts` (where the DLL and injector come from: extension agent source, `SCULKWIRE_AGENT_DLL`, a cargo build of `native/` keyed by a hash of the crates, or the prebuilt release archive with its sha256), `inject.ts` (Wine or Proton prefix off Windows, native on Windows), `engine.ts` (the attached session and the JSON-RPC methods), `client.ts` (the socket), `lock.ts`, `settings.ts` (game options, plus the record `game_stop` restores from), `world.ts` (test-world settings through the agent or `level.dat`), `ui.ts` (menus and screens: the screen, its controls and the input parameters), `inventory.ts` (player attributes and inventory, containers and crafting: the typed calls, their parsing and normalisation, the MCP tools, the CLI commands and the helper pack fallback), `workstation.ts` (interactable blocks and entities and their screens: `interact.*` and `screen.*`, the typed calls, their parsing, the MCP tools and the CLI commands), `png.ts` (recompresses the agent's stored-deflate screenshot PNG), `focus.ts`, `gamepath.ts`, `mcp.ts`, `cli.ts`.
    - `provider.ts`: the built-in input provider for `player_act` and `sculk bench`, installed when the feature module loads; an extension's `registerInputProvider` replaces it.
  - `gamefiles/`: an installed PC (GDK) copy of the game: build detection from the game folder and `appxmanifest.xml`, the versioned vanilla packs and their `.brarchive` extraction (`game_builds`, `game_vanilla_packs`, `game_extract_pack`, `sculk gamefiles`). `wine.ts` is the one walk for Wine/Proton prefixes and their launchers' game folders; `runtime/client/install.ts` uses it too.
  - `extensions/`: the extension loader (`SCULKWIRE_EXTENSIONS` and `<config>/extensions`), `loadExtensions()` and the `ExtensionHost` handed to `activate(host)`. Extensions fail open: a broken one is skipped with one stderr line.
  - `decision/`: optional decision model (System One API: Jev through OpenRouter/ZenMux, Kev locally), its config, `decision_status`, `sculk setup` and `sculk doctor`.
  - `update/`: managed install, `sculk update`, the background release check, client registration and `sculkwire_version`. Installers are `install.sh` and `install.ps1` at the root. A background update never writes to stdout (the MCP stream) and fails open.
- `native/`: the in-game agent's Rust workspace, `#![no_std]`, no Windows SDK. `native/.cargo/config.toml` pins the linker and `agent-core` defines the CRT symbols the compiler emits, so the same command builds on Linux and Windows.
  - `agent-core/`: the build-agnostic core: the JSON-RPC socket server (`rpc.rs`), the hub (`hub.rs`: drain, tick stream, held input), the main-thread request queue and its drain recovery (`queue.rs`), the `Engine` seam one game build implements (`engine.rs`), the input lock and GameInput gate (`lock.rs`, `gameinput.rs`), hook, PE/x64 and image primitives, fault logging and the provable unload (`unload.rs`).
  - `agent/`: the `sculkwire_agent.dll` cdylib: anchors resolved against the loaded image (`anchors.rs`), hooks, ECS reads, and the engine methods by area (`command.rs`, `input.rs`, `options.rs`, `world.rs`, `ui.rs`, `inventory.rs`, `workstation.rs`; `methods.rs` routes them). The `debug-rpc` feature adds `debug.*` diagnosis methods and is never enabled for a published artifact.
  - `injector/`: `sculkwire-injector.exe <process.exe> <dll-path>`.
- `test/fixtures/`: small packs (good + one broken variant per rule family) and recorded client logs. `src/testing/faketime.ts`: fake clock and seeded random for deterministic sims.
- `docs/`: `tools.md` (every MCP tool), `install.md` (installers, managed install, updates, releasing), `client.md` (game client), `engine.md` (the in-game agent), `reverse-engineering.md` (researching the retail game for an agent feature, and the data routes that need none), `extensions.md` (extension loader and host), `decision.md`, `bench.md`.
- `CONTRIBUTING.md` (setup, checks, where things go, live-game rules), `CHANGELOG.md` (each `## vX.Y.Z` section is that release's notes).

## Rules
- Run `npx tsc --noEmit` and `npx vitest run` before finishing a change. The `native.test.ts` test "lists no game processes" fails while any game runs; that one failure is expected then.
- Native changes must build for the game's target: `cd native && cargo build --release --locked --target x86_64-pc-windows-msvc` must pass. cargo reads `native/.cargo/config.toml` from its working directory, so run it inside `native/`; `rust-lld` links it, so no Windows SDK, MSVC or mingw is needed. Add the target once per toolchain with `rustup target add x86_64-pc-windows-msvc` (`~/.cargo/bin` is not always on `PATH`).
- A native change builds twice in `native/`: the default build and `cargo build --release --locked --target x86_64-pc-windows-msvc --features sculkwire-agent/debug-rpc`.
- Imports use `.ts` extensions (`rewriteRelativeImportExtensions`); only erasable TS syntax (no enums, namespaces, parameter properties).
- Every diagnostic producer emits `Diagnostic` from `src/core/diagnostic.ts`. No ad-hoc error shapes, no JSON pointer without a range when a range is computable.
- MCP tools return `structuredContent` (with `outputSchema`) plus a short text summary. Long-running work (BDS, client, `play`) must not block other tools: run it as a job and keep every call under the client's timeout.
- Machine output on stdout, progress on stderr. Exit codes: 0 ok, 1 findings/failed tests, 2 usage or prerequisite error.
- Never commit Mojang game content (bedrock-samples, BDS, game files, dumps from any game build): fetch it at runtime into `cacheDir()`.
- Decision models are optional. Exactly two features may use one, each as an optional advisor through `loadDecisionModel()` from `src/decision/`: `player_act play`, and the `game_launch` join recovery (`src/runtime/client/screens.ts`, asked only when its screen-state machine is stuck). Both work without one. Every other tool must work with the provider `none` (the default). API keys are never asked for through MCP elicitation. Tests use a fake `DecisionModel` or a fake System One HTTP server, never a cloud key.
- Nothing in this repository depends on or is derived from a non-public game build. Features for such builds belong in an extension, which reaches sculkwire only through `src/extensions/` and `src/runtime/client/inputprovider.ts`.
- No personal data in the repo: test fixtures and logs use made-up names and ids (`Steve`, fake xuid).

## Live game rules
- Only one agent or process drives the game at a time.
- Only create or change worlds named `sculkwire-*`, only through `createWorld` (single player: multiplayer and every broadcast off). Never touch the user's other worlds or settings; restore any option changed.
- Stop the game with `game_stop` / `bridge.stop()` or `mcbe-gdk-linux stop`, never by killing the launcher's process group, and confirm `~/.local/share/mcbe-gdk-linux/profile/.gpu-launch-in-progress.json` is gone.
- Never click or confirm anything on a store, Minecoins or Dressing Room screen.
- An input provider's input lock fails open: a missing or bad signal must never block the user's own input.

## Remotes
`origin` is GitHub, [github.com/ve3dy/sculkwire](https://github.com/ve3dy/sculkwire) (meant to be public; private for now). `gitlab` is its mirror, [gitlab.com/ve3dy/sculkwire](https://gitlab.com/ve3dy/sculkwire). `git push origin` pushes to both. Push `main` and release tags.
