# sculkwire: agent rules

Agent-first MCP server + CLI (`sculk`) for Minecraft: Bedrock Edition add-on development.
TypeScript, Node >= 22.18, ESM. Source runs directly (`node src/cli.ts`); `npm run build` emits `dist/`.

Engine work (anything in `native/agent/` or a new agent method) starts with `docs/reverse-engineering.md`. Contributors read `CONTRIBUTING.md`.

## Layout
Each folder below says what it is for and which module is its entry or seam; read the folder for the rest.

Layering (directory imports, checked with an import graph): `core/` imports nothing in `src/`. `gamefiles/` and `knowledge/` sit on `core/`, and `validate/` on `knowledge/`. Above them `runtime/gamelog/` (on `core/`), `runtime/debugger/` (on `gamelog/`), `runtime/connect/` (no imports in `src/`) and `runtime/bds/` (on `debugger/`, `gamelog/`, `knowledge/` and `gamefiles/`). `runtime/engine/` uses only `core/` and `gamefiles/`; `runtime/client/` sits on the engine, `debugger/`, `connect/`, `gamelog/`, `knowledge/` and `gamefiles/`. `extensions/`, `setup/` and `update/` come next, and `src/features.ts`, `src/cli.ts` and `src/mcp/` are on top. No import points upward: the engine reaches the client only through `EngineDeps` (`runtime/engine/deps.ts`), which `src/features.ts` fills in.

- `src/core/`: shared plumbing every area uses. `diagnostic.ts` is the one `Diagnostic` shape and the exit codes; `errors.ts` (`UsageError`, `PrerequisiteError`), `cli.ts` (`CliCommand`, `runMain`), `mcp.ts` (`ToolResult`, `ok`, `fail`, shared result schemas), `process.ts` (the one child-process `run`), `fs.ts` (atomic writes), `meta.ts` (`VERSION`, repository URL, user agent), `version.ts` (channel and game version), `paths.ts` (cache, data and config dirs). `background.ts`: heavy background downloads run only in the MCP server; a CLI command exits at most 3 s after its output.
- `src/features.ts`: the one list of built-in features (`FEATURES`). A feature is `src/<feature>/` with `register(server)` in `mcp.ts` and `commands: CliCommand[]` in `cli.ts`; a new feature registers here. `wireFeatures()` connects features once per process (the validator's knowledge providers, the BDS store source, the in-game agent as input provider). `src/cli.ts` and `src/mcp/server.ts` read it.
- `src/knowledge/`: versioned docs, Script API, components, commands, Molang, vanilla samples, changelogs and rockide/schemas. Every source follows its upstream on its own: version pins refresh once a day, `tracked.ts` keeps one folder per upstream release, the last copy answers offline. `store.ts` lists the sources for `sculk knowledge update|status`; `suggest.ts` offers near names for a lookup that matched nothing.
- `src/validate/`: the pack validator. sculkwire never runs rgl: for a Regolith project whose profile runs filters, the validator, BDS and the client all read what rgl last built (`regolithOutput` in `src/core/regolith.ts`) and never write it. Every diagnostic has a file and a 1-based line and column. Schemas come from rockide/schemas first, then the engine schemas of bedrock-samples.
- `src/runtime/gamelog/`: console and content-log parsing, mapped to pack files (`logparse.ts`) and script frames (`frames.ts`); shared by BDS and the client.
- `src/runtime/bds/`, `src/runtime/debugger/`, `src/runtime/connect/`: the Bedrock Dedicated Server, the script debugger and the `/connect` bridges.
- `src/runtime/engine/`: the TypeScript side of the in-game agent ([In-Game Agent](docs/engine.md) lists its tools and commands). `engine.ts` is the attached session; `methods.ts` is every JSON-RPC method the client sends, and `methods.test.ts` checks those names against `METHODS` in `native/agent/src/lib.rs` and the Protocol table of `docs/engine.md`. `build.ts` is where the DLL comes from (an extension's agent source, `SCULKWIRE_AGENT_DLL`, a cargo build of `native/` keyed by a hash of the crates, or the release zip checked against its sha256); `inject.ts` loads it.
- `src/runtime/client/`: the game client. `bridge.ts` is the entry (launch, deploy, reload, logs, queries). A world tile is opened only by its marker icon (`world.ts` and `jpeg.ts` write it, `icon.ts` finds it in a screenshot), never by position. `inputprovider.ts` is the seam through which an extension supplies the engine input route, the pause guard, the input lock and lifecycle hooks; `agentprovider.ts` is the built-in one, installed by `wireFeatures()`. `player.ts` is `player_act`'s controller; `nav/` (grid, A*, follower), `skills/` (fight, flee, eat, use on, the goal grammar in `plan.ts` and the `play` loop), `tasks/` (the steps `play` runs as code), `bench/` (`sculk bench`) and `helper-pack/` (the behavior pack deployed into test worlds) are its parts.
- `src/gamefiles/`: an installed PC (GDK) copy of the game on disk: build detection, the vanilla packs and their `.brarchive` extraction, `options.txt` and its restore record, `level.dat`, `sculkwire-` world names, and where each client install lives (`install.ts`). `wine.ts` is the one walk over Wine and Proton prefixes.
- `src/extensions/`: the extension loader (`SCULKWIRE_EXTENSIONS` and `<config>/extensions`) and the `ExtensionHost` handed to `activate(host)`. Extensions fail open: a broken one is skipped with one stderr line.
- `src/setup/`: `sculk setup` and `sculk doctor`. `src/update/`: the managed install, `sculk update` and the background release check (installers: `install.sh`, `install.ps1` at the root). A background update never writes to stdout (the MCP stream) and fails open.
- `src/testing/`: fakes for unit tests: `faketime.ts` (clock and seeded random), `fakeworld.ts` (a fake `TaskEnv`), `fightsim.ts` (the fight simulator, with speeds, reach and shield rules as measured on retail). `test/fixtures/`: small packs (a good one and one broken variant per rule family) and recorded client logs.
- `native/`: the agent's Rust workspace, `#![no_std]`, no Windows SDK; `native/.cargo/config.toml` pins the linker, so the same command builds on Linux and Windows.
  - `agent-core/`: the build-agnostic core: the JSON-RPC server (`rpc.rs`), the hub (drain, tick stream, held input), the main-thread queue, the input lock, hooks and the provable unload. `engine.rs` is the `Engine` seam one game build implements.
  - `agent/`: `sculkwire_agent.dll`, the retail build. `METHODS` in `lib.rs` is the method list; handlers live in one module per area (`command.rs`, `input.rs`, `ui.rs`, `inventory.rs`, `workstation.rs`, …), anchors in `anchors.rs`. Its pure modules have host tests, listed in `host-tests.sh`. The `debug-rpc` feature adds `debug.*` methods and is never in a published artifact.
  - `injector/`: `sculkwire-injector.exe <process.exe> <dll-path>`.
- `docs/`: `tools.md` (every MCP tool), `engine.md`, `client.md`, `bench.md`, `install.md`, `extensions.md`, `reverse-engineering.md`. `CONTRIBUTING.md`: setup, the checks, where new things go, live-game rules. `CHANGELOG.md`: each `## vX.Y.Z` section is that release's notes.

## Rules
- Before finishing, run the checks in [CONTRIBUTING.md](CONTRIBUTING.md#checks-before-a-pull-request): types and tests always; for a `native/` change both agent builds and `sh host-tests.sh`, all inside `native/` (cargo reads `native/.cargo/config.toml` from its working directory). `~/.cargo/bin` is not always on `PATH`.
- Imports use `.ts` extensions (`rewriteRelativeImportExtensions`); only erasable TS syntax (no enums, namespaces, parameter properties).
- Every diagnostic producer emits `Diagnostic` from `src/core/diagnostic.ts`. No ad-hoc error shapes, no JSON pointer without a range when a range is computable.
- MCP tools return `structuredContent` (with `outputSchema`) plus a short text summary. Long-running work (BDS, client, `play`) must not block other tools: run it as a job and keep every call under the client's timeout.
- Machine output on stdout, progress on stderr. Exit codes: 0 ok, 1 findings/failed tests, 2 usage or prerequisite error.
- Never commit Mojang game content (bedrock-samples, BDS, game files, dumps from any game build): fetch it at runtime into `cacheDir()`.
- Nothing in this repository depends on or is derived from a non-public game build. Features for such builds belong in an extension, which reaches sculkwire only through `src/extensions/` and `src/runtime/client/inputprovider.ts`.
- No personal data in the repo: test fixtures and logs use made-up names and ids (`Steve`, fake xuid).

## Live game rules
The full list is in [CONTRIBUTING.md](CONTRIBUTING.md#live-game-rules). In short:
- Only one agent or process drives the game at a time.
- Only create or change worlds named `sculkwire-*`, only through `createWorld` (single player: multiplayer and every broadcast off). Never touch the user's other worlds or settings; restore any option changed. A user's world may be read to copy it (`copyFrom`), and only when the user chose it.
- Stop the game with `game_stop` / `bridge.stop()` or `mcbe-gdk-linux stop`, never by killing the launcher's process group, and confirm `~/.local/share/mcbe-gdk-linux/profile/.gpu-launch-in-progress.json` is gone.
- Never click or confirm anything on a store, Minecoins, Marketplace, Realms, Dressing Room or profile/persona editor screen.
- An input provider's input lock fails open: a missing or bad signal must never block the user's own input.

## Remotes
`origin` is GitHub, [github.com/Sculkwire/sculkwire](https://github.com/Sculkwire/sculkwire) (public), the source of truth: pull requests and pushes go there. Push `main` and release tags to `origin` only. `gitlab` is the read-only mirror, [gitlab.com/sculkwire/sculkwire](https://gitlab.com/sculkwire/sculkwire): the `mirror` workflow (`.github/workflows/mirror.yml`) pushes every branch and tag to it on each push. Never push to GitLab by hand.
