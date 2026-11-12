# Contributing

How to set up a checkout, what to run before a pull request, where new code goes, and the rules for working against the real game. `AGENTS.md` holds the same rules in short form for coding agents; the layout of the source tree is listed there.

## Setup

| Need | Version | Used for |
|---|---|---|
| Node.js | 22.18 or newer (the first 22.x that runs `.ts` files without flags) | Everything in `src/` |
| git | Any recent one | Knowledge sources, installs |
| rustup and cargo | Stable toolchain with the `x86_64-pc-windows-msvc` target | The in-game agent in `native/` |

```sh
git clone https://github.com/Sculkwire/sculkwire.git
cd sculkwire
npm ci
node src/cli.ts --help
```

The sources run directly; there is no build step for development. `npm run build` emits `dist/` and is only needed for a package.

The agent builds on Linux and Windows the same way. `native/.cargo/config.toml` pins `rust-lld` as the linker, so no Windows SDK, MSVC or mingw is needed. cargo reads that file from its working directory, so build inside `native/`:

```sh
rustup target add x86_64-pc-windows-msvc        # once per toolchain
cd native
cargo build --release --locked --target x86_64-pc-windows-msvc
cargo build --release --locked --target x86_64-pc-windows-msvc --features sculkwire-agent/debug-rpc
```

The second build adds the `debug.*` diagnosis methods ([Reverse Engineering the Game](docs/reverse-engineering.md#the-debug-rpc-build)). It is for your own machine only: a published artifact never has it. `~/.cargo/bin` is not always on `PATH`; sculkwire finds `~/.cargo/bin/cargo` on its own.

To use your checkout from an MCP client, point the client at `node /path/to/sculkwire/src/cli.ts mcp` ([Manual Setup](README.md#manual-setup)). A checkout never updates itself.

## Checks Before a Pull Request

Run all of these from the repository root. CI runs the types, the tests, the default agent build and the agent's host tests on Linux and Windows; the `debug-rpc` build is only checked by you.

| Check | Command | Notes |
|---|---|---|
| Types | `npx tsc --noEmit` | Must be clean |
| Tests | `npx vitest run` | The `native.test.ts` test "lists no game processes" fails while any Minecraft runs on the machine. Close the game, or accept that one failure |
| Agent, default | `cd native && cargo build --release --locked --target x86_64-pc-windows-msvc` | Only when `native/` changed |
| Agent, `debug-rpc` | Same, plus `--features sculkwire-agent/debug-rpc` | Only when `native/` changed. Both builds must pass |
| Agent, host tests | `cd native && for m in look screens registries click; do rustc --edition 2021 --test agent/src/$m.rs -o target/$m-test.exe && ./target/$m-test.exe \|\| exit 1; done` | Only when `native/agent/src/look.rs`, `screens.rs`, `registries.rs` or `click.rs` changed. The agent's pure modules (the view math, the screen rules, the tick stream's registry choice, the click's wait for the crosshair pick), which build on their own as host test crates (the agent itself builds only for the game's target) |

Code style follows the existing code: imports with `.ts` extensions, only erasable TypeScript (no enums, namespaces or parameter properties), machine output on stdout and progress on stderr, exit codes 0 ok, 1 findings, 2 usage or prerequisite error, and every problem reported as the one `Diagnostic` shape from `src/core/diagnostic.ts`.

## Commits

One change per commit, message `area: what changed`, written as what is now true. The area is the part of the project the change is in:

```text
engine: inventory and container take the helper pack when an attached agent is gone
client: game_reload re-establishes the script debugger when the helper does not come back
agent: screen.move refuses a collection the controller does not know
docs: plain /reload does not register new function files; game_reload all does
```

Common areas: `knowledge`, `validate`, `bds`, `client`, `engine` (the TypeScript side of the agent), `agent` (the Rust side), `play`, `player_act`, `gamefiles`, `update`, `docs`, `release`. A user-visible change also gets a line in `CHANGELOG.md` under `## Unreleased`.

## Where Changes Go

The home of sculkwire is GitHub, [github.com/Sculkwire/sculkwire](https://github.com/Sculkwire/sculkwire): open issues and pull requests there. [gitlab.com/sculkwire/sculkwire](https://gitlab.com/sculkwire/sculkwire) is a read-only mirror. The `mirror` workflow pushes every branch and tag from GitHub to it on each push, so merged pull requests reach it on their own; never push to GitLab by hand.

## Tests

- Test behaviour, not wiring. A test states what a caller sees: the parsed answer, the diagnostic with its file and line, the route the build driver takes. A test that only checks that a function was called with some arguments is not wanted.
- No game, network or cloud key in a unit test. Fake the edges: `src/testing/faketime.ts` for a fake clock and seeded random, a fake HTTP server, recorded answers for the agent and the client logs.
- Fixtures are small and made up. A pack in `test/fixtures/` has a good variant and one broken variant per rule family. Names and ids are invented (`Steve`, a fake xuid); never a real account, path or log from your machine.
- Never commit Mojang game content: no bedrock-samples, BDS, game files, unpacked vanilla packs or dumps from any game build. sculkwire fetches what it needs at runtime into its cache.

## Docs in Step With the Code

A change that adds, removes or renames a tool, an input or a result field updates in the same commit:

- the tool table at the top of `README.md`;
- the tool's section in `docs/tools.md`;
- the feature's own doc when it has one (`docs/engine.md` for an agent method, with its row in the Protocol table; `docs/client.md`, `docs/bench.md`, `docs/extensions.md`);
- `CHANGELOG.md` under `## Unreleased`.

Docs state what the code does now. A status table names the game version it was checked on.

## Live Game Rules

These hold for anything that drives a real client, by hand or from a test:

- **Only `sculkwire-*` worlds.** Create them through sculkwire (`game_launch`, `createWorld`): single player, multiplayer and every broadcast off. Never open, change or delete another world.
- **Never the store.** Never click or confirm anything on a store, Marketplace, Minecoins, Realms, Dressing Room or profile screen. The agent refuses UI input on store, Marketplace, Minecoins, Dressing Room and persona screens except `Escape`; do not work around it.
- **Restore every option you change.** `game_settings` records the original value and `game_stop` puts it back. Something changed by hand gets put back by hand.
- **One driver at a time.** Only one agent or process sends input or commands to the game.
- **The input lock fails open.** A missing or bad focus signal, an unloaded agent or a crash must never leave the user's keyboard and mouse locked out.
- **Stop the game properly.** `game_stop`, `sculk game stop` or the launcher's own stop command; never kill the launcher's process group.

## Where New Things Go

### A Tool

1. Put it in the feature it belongs to: `src/<feature>/mcp.ts` calls `server.registerTool` with a zod input schema and an `outputSchema`, and returns `structuredContent` plus a one-line text summary. A new feature exports `register(server)` and is listed in `src/features.ts`.
2. Add the matching CLI command to the feature's `commands` in `src/<feature>/cli.ts` (listed in `src/features.ts` for a new feature).
3. Keep every call under the client's timeout. Long work (BDS, the client, `play`) runs as a job the tool starts and another tool reads.
4. Update the docs as above, and add tests for the parsing and the choices the tool makes.

### A Knowledge Source

A source is a module in `src/knowledge/` that downloads into `cacheDir("knowledge", …)` and never into the repository. It follows its upstream on its own: pin it from `versions.ts` when it belongs to a game version, or use `tracked.ts` when the upstream has its own releases (rockide/schemas does). Offline, the last copy answers. Add it to `store.ts` so `sculk knowledge update` and `sculk knowledge status` cover it, then expose it through `lookups.ts` or `search.ts` and a tool in `mcp.ts`. A lookup that matches nothing offers near names through `suggest.ts`.

### A Bench Scenario

One file in `src/runtime/client/bench/scenarios/`, exporting the scenario as its default export (or a `scenarios` array). The runner loads every file in the folder; no index to edit. The fields are in `src/runtime/client/bench/types.ts` and explained in [Benchmarks](docs/bench.md#scenarios).

### A Helper Pack Query

The behavior pack sculkwire deploys into test worlds answers queries from `HANDLERS` in `src/runtime/client/helper-pack/scripts/main.js`. A new read that the Script API can answer goes there, not into the agent.

### An Agent Method

Read [Reverse Engineering the Game](docs/reverse-engineering.md) first. Then:

1. Write the handler in the area module of `native/agent/src/` it belongs to (`command.rs`, `input.rs`, `options.rs`, `world.rs`, `ui.rs`, `inventory.rs`, `workstation.rs`, …) as `fn(&'static Core, &Value) -> Result<Value, RpcError>`.
2. List it in `METHODS` in `native/agent/src/lib.rs`: `Method::main` when it touches the game (it then runs on the game's main thread), `Method::socket` only when it reads the agent's own state.
3. Resolve what it needs in that area's `resolve(core)` and report it in `report()`, both called from `lib.rs`. A recipe that does not resolve leaves the anchor at 0, and the method answers `RpcError::anchor("<area>.<name>")`.
4. Add the typed call and the parsing of its answer in `src/runtime/engine/` (`engine.ts`, or the area's own file such as `inventory.ts` or `workstation.ts`), the tool or CLI command that uses it, unit tests for the parsing, and a row in the Protocol table of `docs/engine.md`.
5. Prove it live on the retail game and record the result in the Status table of `docs/engine.md`.

A change to `native/agent-core/` keeps the `Engine` seam and the wire stable: method names, parameters, result shapes and error codes are a contract with the TypeScript side.

## Releases

Releasing is described in [Install and Update](docs/install.md#releasing): bump `package.json`, move the `## Unreleased` notes into a `## vX.Y.Z` section of `CHANGELOG.md`, commit, tag `vX.Y.Z` and push the tag. The `release` workflow runs the checks, builds the agent without `debug-rpc`, and publishes `sculkwire-agent-<version>-x86_64-windows.zip` with its `.sha256` next to the release notes. Managed installs pick the tag up on their next daily check.
