# Extensions

An extension is a local package that adds MCP tools and `sculk` commands to sculkwire, and can install an in-process input provider for `player_act`. sculkwire loads every installed extension once per process, after its own features.

## Installing One

sculkwire looks in two places:

1. Every directory in `SCULKWIRE_EXTENSIONS`, separated by `:` on Linux and macOS and `;` on Windows.
2. Every subdirectory of `<config>/extensions`, where `<config>` is `~/.config/sculkwire` on Linux and macOS (or `$XDG_CONFIG_HOME/sculkwire`) and `%APPDATA%\sculkwire` on Windows (or `SCULKWIRE_CONFIG`). A symbolic link (Linux, macOS) or a directory junction (Windows) to the extension's folder counts.

```sh
ln -s /path/to/my-extension ~/.config/sculkwire/extensions/my-extension
```

```powershell
New-Item -ItemType Junction -Path "$env:APPDATA\sculkwire\extensions\my-extension" -Target C:\path\to\my-extension
```

The same directory found twice is loaded once. Restart the MCP server to pick up a new extension. `sculk --help` lists the commands of every loaded extension.

## Manifest

A directory is an extension when its `package.json` names an entry file:

```json
{
  "name": "my-extension",
  "type": "module",
  "sculkwire": { "extension": "./src/index.ts" }
}
```

The entry path is relative to the directory. A `.ts` entry runs through Node's built-in type stripping (Node 22.18 or newer), so it may use only erasable TypeScript syntax, its relative imports carry the `.ts` extension, and the extension must not live inside a `node_modules` folder, where Node refuses to strip types. A `.js` or `.mjs` entry has no such limits.

## activate(host)

The entry default-exports `activate(host)`. It returns, or resolves to, the extension:

```ts
import type { ExtensionActivate } from "sculkwire/src/extensions/index.ts";

const activate: ExtensionActivate = (host) => ({
  name: "my-extension",
  register(server) {
    server.registerTool(
      "my_tool",
      { description: "…", inputSchema: { n: host.z.number() }, outputSchema: { doubled: host.z.number() } },
      async ({ n }) => ({ content: [{ type: "text", text: String(n * 2) }], structuredContent: { doubled: n * 2 } }),
    );
  },
  commands: [{ name: "my run", summary: "…", run: async () => host.ExitCode.ok }],
});

export default activate;
```

| Field | Meaning |
|---|---|
| `name` | Shown in messages about the extension (required) |
| `register(server)` | Registers MCP tools on sculkwire's `McpServer`. Follow the repository's tool rules: `structuredContent` with an `outputSchema`, plus a short text |
| `commands` | `CliCommand` objects (`name`, `summary`, `run(args)` returning an exit code). They appear in `sculk --help` and resolve like the built-in ones; a built-in command wins a name clash |

An extension uses the values on `host` at runtime and never imports sculkwire's modules by path, so the process keeps one copy of each module (one zod, one input-provider registry). Types may be imported with `import type`, which Node erases before running the file.

| Host member | What it is |
|---|---|
| `z` | sculkwire's zod, for tool input and output schemas |
| `ExitCode` | `ok` (0), `findings` (1), `usage` (2) |
| `cacheDir(...parts)` | A path under sculkwire's cache directory |
| `findOnPath(name)` | The first executable called `name` on PATH, PATHEXT-aware on Windows |
| `findInstall()`, `installerRoot()`, `winePrefix(appData)` | The game client install sculkwire uses, the mcbe-gdk-installer root, and the Wine prefix of a data folder |
| `registerInputProvider(provider)` | Installs the in-process input provider (below) and returns the function that removes it |
| `registerAgentSource(source)` | Supplies the in-game agent's DLL for game folders the extension recognises (below) |
| `gamePath(hostPath, platform?)` | The path a Windows game process (the agent, an injector) uses for a host path: the native path on Windows, `Z:\…` under Wine |
| `gamefiles` | `gameDirCandidates()`, `detectBuilds()`, `selectBuild()`, `noBuildMessage()`: the installed PC (GDK) builds behind the [Game Files](tools.md#game-files) tools |

## Input Provider

`player_act` and `sculk bench` have two input routes. The keyboard route is built in, and sculkwire's in-game agent is the built-in engine route (`src/runtime/engine/provider.ts`): `input: "auto"` takes the engine whenever the provider answers and the keyboard otherwise, and `input: "engine"` requires it. An extension replaces the provider with `registerInputProvider(provider)`; one is active at a time, and removing the extension's returns the built-in one.

| Member | Used for |
|---|---|
| `name` | Messages, such as a failed attach in `sculk bench` |
| `input` | The controller's engine route (`EngineInput` in `src/runtime/client/player.ts`): `prepare`, `reachable`, `look`, `move`, `release`, `attack`, `use`, and an optional `takeover` that lets the user take control with F9 |
| `motion()` | The newest position, rotation, velocity, ground contact and health with its arrival time. While under 250 ms old it replaces those fields of the helper pack's player state |
| `pausedReason()` | A message when the simulation is paused; `player_act` then refuses to run and a `play` job stops |
| `keyboardNote` | Optional text added to `player_act` output when the keyboard route was used |
| `hold()` | Holds the provider's input lock while actions or a `play` job run on the engine route. Resolves to the release function |
| `attach()` | Makes the engine route usable before a bench run |
| `launched({ mode, pid })`, `stopped()` | The bridge launched a game, or no game runs any more (also called before every launch) |
| `close()` | The MCP server is shutting down |

An input lock must fail open: a missing or bad signal must never block the user's own input.

## Agent Source

The in-game agent serves the [Engine](tools.md#engine) tools (`engine_*`) and every tool that goes through it (`game_input_lock`, `game_settings`, `world_settings`, `game_ui`, `player_inventory`, `container`, `craft`, `interact`, `screen`), the engine route of `player_act`, and the agent routes of `game_input` and the `game_launch` sign-in recovery. sculkwire supplies it from the prebuilt release archive or a cargo build of the checkout's `native/`. An extension may instead supply its own agent DLL for the game folders it knows:

```ts
host.registerAgentSource({
  name: "my-agent",
  matches: (gameDir) => existsSync(join(gameDir, "MyBuildMarker.dll")),
  async build({ force, platform, env, builtIn }) {
    // `builtIn()` is the agent sculkwire would have supplied: take its injector, or return both of its paths.
    return { dll: await buildMyDll({ force }), injector: (await builtIn()).injector, tag: hash };
  },
});
```

| Member | Meaning |
|---|---|
| `name` | Shown in the build's cache key (`<name>:<tag>`) and in its errors |
| `matches(gameDir)` | Whether this source handles the game folder being attached |
| `build(options)` | Returns `{ dll, injector, tag }`, plus an optional `cached`; `tag` names the build. `options` carries `force`, `platform`, `env` and `builtIn()` |

The sources are consulted when `engine_attach` builds the agent: the first registered source whose `matches(gameDir)` is true supplies the DLL and the injector, and the built-in routes (`SCULKWIRE_AGENT_DLL`, then a cargo build of `native/`, then the prebuilt release archive) are not used. With no match, or with nothing registered, nothing changes. A source that returns a path that does not exist fails the attach with the source's name. The source owns its cache: the returned paths are used as they are.

The built-in provider and every agent-backed tool drive whichever DLL the seam supplied, over the same [protocol](engine.md#protocol), so a source that only swaps the DLL needs nothing else. An agent that speaks a different protocol also installs its own input provider (`registerInputProvider`) so `player_act` and `sculk bench` use it; the other tools need the protocol.

## Failures

Loading fails open. A missing directory, a `package.json` without the `sculkwire.extension` field, a missing entry file, an entry that does not load, an entry without a default-exported function, or an `activate` that throws or returns no `name` each write one line to stderr, `sculkwire: extension <dir> skipped: <reason>`, and the other extensions and every built-in feature keep working. A `register` that throws (for example a tool name that is already taken) is reported the same way. Nothing is written to stdout, which carries the MCP stream. Loading reads local files only and never uses the network; with no extension installed it costs one directory read.
