<p align="center">
  <img src="assets/sculkwire.svg" width="112" alt="Sculkwire icon">
</p>

<h1 align="center">Sculkwire</h1>

<p align="center">An MCP server that lets coding agents build, validate, test and play Minecraft Bedrock add-ons.</p>

<p align="center">
  <a href="docs/tools.md">Tools</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="docs/client.md">Game Client Setup</a> ·
  <a href="docs/extensions.md">Extensions</a> ·
  <a href="#cli">CLI</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

Sculkwire gives your AI agent the Bedrock docs, a validator, a test server and the real game. The agent can write an add-on, check it, run it and watch it work.

## Features

- **Knowledge.** Looks up docs, Script API, components, commands, Molang, vanilla examples and changelogs for stable and preview.
- **Validation.** Reports each problem with its file, line and rule.
- **Test server.** Runs your packs and GameTests on a Bedrock Dedicated Server.
- **Live game.** Starts the real game in a test world with your packs, reloads after edits, reads the log and takes screenshots. Works on Windows and Linux.
- **Player control.** The agent walks, finds paths, fights mobs, crafts, smelts, trades and works toward goals like a player.
- **Game files.** Unpacks the vanilla packs from your installed game so you can search or compare them.
- **In-game agent.** An optional helper inside the game. It lets the agent run commands as the player, take screenshots, read inventories, use menus and crafting stations, and pause or step game time. See [In-Game Agent](docs/engine.md).
- **Extensions.** Add your own tools and commands. See [Extensions](docs/extensions.md).
- **Benchmarks.** `sculk bench` measures the agent's combat, movement, goal and task skills in the real game. See [Bench](docs/bench.md).

## MCP Tools

| Category | Tools |
|---|---|
| Knowledge | `docs_search`, `api_lookup`, `component_lookup`, `command_lookup`, `molang_lookup`, `vanilla_example`, `changelog_search`, `knowledge_versions` |
| Validation | `validate_pack`, `validate_file` |
| Server | `bds_check`, `gametest_run`, `bds_session_start`, `bds_session_command`, `bds_session_logs`, `bds_session_stop`, `script_profile` |
| Game | `game_launch`, `game_status`, `game_command`, `game_reload`, `game_log`, `game_screenshot`, `game_query`, `game_registry`, `game_input`, `game_input_lock`, `game_ui`, `game_settings`, `world_settings`, `game_stop` |
| Player | `player_act`, `player_job`, `player_state`, `player_inventory` |
| Containers and Crafting | `container`, `craft`, `interact`, `screen` |
| Engine | `engine_attach`, `engine_status`, `engine_command`, `engine_player`, `engine_tick`, `engine_screenshot` |
| Game Files | `game_builds`, `game_vanilla_packs`, `game_extract_pack` |
| Setup | `sculkwire_version` |

The [tool reference](docs/tools.md) explains each tool and its inputs.

## Quick Start

You need Node.js 22.18 or newer and git. Both install paths give you a `sculk` command and register sculkwire with your MCP client.

### Install With Your Agent

Paste this into your AI agent harness:

```text
Install the sculkwire MCP server: clone https://github.com/Sculkwire/sculkwire.git and follow the "Agent Install" steps in its docs/install.md.
```

The agent installs sculkwire, registers it and runs `sculk doctor`.

### Install With a Script

Linux and macOS:

```sh
git clone https://github.com/Sculkwire/sculkwire.git
cd sculkwire
./install.sh
```

Windows (Windows PowerShell 5.1 or PowerShell 7):

```powershell
git clone https://github.com/Sculkwire/sculkwire.git
cd sculkwire
.\install.ps1
```

The installer asks which MCP clients to register with.

`--yes` (`-Yes` in PowerShell) skips the question. Other options are in [Install and Update](docs/install.md#installers).

Or install in one line:

```sh
curl -fsSL https://raw.githubusercontent.com/Sculkwire/sculkwire/main/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/Sculkwire/sculkwire/main/install.ps1 | iex
```

Run `sculk doctor` any time. It lists each problem on your machine with a fix.

### Manual Setup

To run from a git checkout, run `npm install` in the clone and add this to your MCP client config:

```json
{
  "mcpServers": {
    "sculkwire": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/sculkwire/src/cli.ts", "mcp"]
    }
  }
}
```

A git checkout never updates itself.

The first knowledge request downloads docs and samples. This takes about a minute. Run `sculk knowledge update` to do it ahead of time.

## Updating

- An installed sculkwire updates itself, at most once a day, in the background.
- The new version starts with your next session.
- Docs, typings, samples and the test server also update on their own. Offline, the last copy keeps working.

```sh
sculk update --check            # Show whether a newer release exists
sculk update                    # Install the newest release now
sculk update --rollback         # Switch back to the version before the last update
sculk update --channel off      # No automatic updates (release and main are the other channels)
```

Details are in [Install and Update](docs/install.md#updates).

## Requirements

| Feature | Requirement |
|---|---|
| Knowledge and validation | Node.js 22.18 or newer. rgl for Regolith projects |
| Test server | Windows or Linux x64. You accept the [Minecraft EULA](https://www.minecraft.net/eula) |
| Game client | Minecraft Bedrock for PC (GDK). Linux also needs gamescope and xdotool. See [Game Client Setup](docs/client.md) |
| In-game agent (optional) | The game running. sculkwire downloads the helper, or builds it if you have Rust. See [In-Game Agent](docs/engine.md) |
| Game files | An installed PC (GDK) copy of the game. See [Game Client Setup](docs/client.md) |

## CLI

Most tools also have a command; `sculk --help` lists them. Installed, the command is `sculk`. In a git checkout, use `node src/cli.ts` instead.

Tools that work on state the MCP server keeps between calls have no command: `bds_session_*`, `script_profile`, `game_launch` and the tools on the client it launched (`game_command`, `game_reload`, `game_query`, `game_registry`, `game_screenshot`, `game_input`, `player_act`, `player_job`, `player_state`). `sculk game check` runs a whole launch in one command instead. `command_lookup`, `molang_lookup`, `vanilla_example` and `validate_file` have no command either.

```sh
sculk validate path/to/addon            # Exit code 1 when errors are found
sculk bds gametest path/to/addon        # Run GameTests
sculk game check path/to/addon --screenshot shot.png
sculk api Entity.applyDamage
sculk bench combat --runs 3             # Measure the player skills
sculk doctor                            # Check the machine
sculk --help                            # List all commands
```

With the game running, these commands use the in-game agent. Each prints JSON.

```sh
sculk engine attach                     # Load the in-game agent and print its status
sculk engine status|command|tick|screenshot|player
sculk game lock [on|off|auto]           # Keep your input out of the game; F9 takes over
sculk game settings [list|get <id>|set <id> <value>]
sculk world settings [get|set ...]
sculk game ui [screen|controls|press|key|text|click|scroll]
sculk player inventory
sculk container get <x> <y> <z>
sculk craft match|run
sculk interact block <x> <y> <z> | interact entity <id>
sculk screen state|move|act|close
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and where new code goes. Work on the in-game agent starts with [Reverse Engineering the Game](docs/reverse-engineering.md).

## Data Sources

- Vanilla samples, `@minecraft/*` typings, Microsoft Learn docs, changelogs and Bedrock Dedicated Server are downloaded into your local cache.
- [rockide/schemas](https://github.com/rockide/schemas) by the Rockide project provides the JSON schemas used by the validator and `component_lookup`.
- Packs unpacked from your installed game stay in your local cache.
- The icon is a pixel-art sculk block with a glowing pixel [Model Context Protocol](https://github.com/modelcontextprotocol/modelcontextprotocol) mark above it.

## License

MIT, see [LICENSE](LICENSE).

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
