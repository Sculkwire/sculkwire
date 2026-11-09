# Install and Update

sculkwire runs from its TypeScript sources with Node.js 22.18 or newer (the first 22.x release that runs `.ts` files without flags). An installed copy lives in a managed folder and updates itself from the release tags of the repository. A git checkout you run directly is a development checkout and never updates itself.

## Agent Install

Steps for an AI agent that was asked to install sculkwire. Work in the clone of the repository.

1. Check that `node --version` is 22.18 or newer and that git is installed. Stop and tell the user if either is missing.
2. Work out which MCP client you run in. `./install.sh --help` (Linux, macOS) or `.\install.ps1 -Help` (Windows) lists the clients `--register` accepts.
3. Run the installer without questions. Use `./install.sh --yes` on Linux or macOS and `.\install.ps1 -Yes` on Windows. Add `--register <client>` (`-Register <client>`) when your client is one of the accepted ones.
4. If you could not register yourself, add the JSON the installer printed under "MCP registration for any other client" to your own MCP configuration. If you cannot edit that configuration, show the user the JSON and where it belongs.
5. Run `sculk doctor` and show the user its output. Lines tagged `warning` or `info` are optional features.
6. Ask the user one optional question. "Decision model (optional): None (default), Jev through OpenRouter, Jev through ZenMux, Kev on your own GPU". No answer means None, and nothing more is needed.
   - Jev through OpenRouter or ZenMux. Run `sculk setup --yes --decision openrouter` (or `zenmux`). Never ask for an API key and never handle one. Tell the user to set `OPENROUTER_API_KEY` (or `ZENMUX_API_KEY`) in their environment, or to run `sculk setup` in a terminal themselves.
   - Kev. Run `sculk setup --yes --decision local`, then offer to set up the local server as described in [Decision Model](decision.md). Ask before installing anything.
7. Tell the user to restart the session so the sculkwire tools load.

## Installers

`install.sh` (Linux and macOS) and `install.ps1` (Windows PowerShell 5.1 or PowerShell 7) take the same options, ask the same questions and print the same lines.

1. Check for git, npm and a Node.js that runs TypeScript sources.
2. Use the clone the script runs from, or clone the repository into a temporary folder when the script arrives through a pipe.
3. Run `node src/update/bootstrap.ts --install` from that clone. This creates the managed folder, writes the launchers and installs the newest release (clone, `npm ci`, smoke check). It needs no `node_modules` in the source clone.
4. Put `sculk` on PATH, after saying what it is about to change. `--no-path` (`-NoPath`) skips this step.
   - Linux and macOS: a symlink `sculk` in `SCULKWIRE_BIN_DIR`, default `~/.local/bin`. Your shell profile is never edited: when that folder is not on PATH, the installer prints the line to add.
   - Windows: the managed `bin` folder is added to the user PATH (new terminals pick it up) and to the PATH of the running session. With `SCULKWIRE_BIN_DIR` set, a `sculk.cmd` that calls the launcher is written there instead, and that folder is added. Windows cannot create a symlink without admin rights.
5. Ask the two setup questions (decision model, MCP clients) unless `--yes` is given or there is no terminal to ask in (`install.sh` reads `/dev/tty`, `install.ps1` needs an interactive console with stdin not redirected), then run `sculk setup --yes` with the answers.

| `install.sh` | `install.ps1` | Environment | Meaning |
|---|---|---|---|
| `--yes` | `-Yes` | `SCULKWIRE_YES=1` | Ask nothing. A saved decision model is kept, otherwise none is saved. No client is registered unless `--register` is given |
| `--decision <provider>` | `-Decision <provider>` | `SCULKWIRE_DECISION` | `none` (default), `openrouter`, `zenmux` or `local`. Only the provider is saved, never a key |
| `--register <clients>` | `-Register <clients>` | `SCULKWIRE_REGISTER` | Comma separated: `omp`, `claude` |
| `--channel <channel>` | `-Channel <channel>` | `SCULKWIRE_CHANNEL` | `release` (default), `main` or `off` |
| `--repo <url>` | `-Repo <url>` | `SCULKWIRE_REPO` | Repository to install from, a git URL or a local path. Default `https://github.com/ve3dy/sculkwire.git` |
| `--no-path` | `-NoPath` | `SCULKWIRE_NO_PATH=1` | Leave PATH alone |
| `--help` | `-Help` | | Print the options |

A flag wins over its environment variable. The variables exist for piped runs, which cannot take flags. Both scripts exit 0 on success and 2 on a failure, with the reason on stderr.

Without a clone, install in one line:

```sh
curl -fsSL https://raw.githubusercontent.com/ve3dy/sculkwire/main/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/ve3dy/sculkwire/main/install.ps1 | iex
```

Piped, `install.sh` takes flags after `sh -s --` (`curl ... | sh -s -- --yes`) and `install.ps1` takes them as a script block: `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ve3dy/sculkwire/main/install.ps1))) -Yes`. Piped through `iex`, `install.ps1` never closes your PowerShell window: it sets `$LASTEXITCODE` instead of exiting.

CI runs both installers on every push, from the checkout under test (`--channel main --repo <checkout>`), then runs the installed `sculk --version` and `sculk doctor`, and on Windows `cmd /c <data>\bin\sculk.cmd --version` the way an MCP client starts it.

## Managed Folder

The managed folder is the sculkwire data folder: `~/.local/share/sculkwire` on Linux (`$XDG_DATA_HOME/sculkwire`), `~/Library/Application Support/sculkwire` on macOS and `%LOCALAPPDATA%\sculkwire\data` on Windows. `SCULKWIRE_DATA` overrides it.

| Path | Content |
|---|---|
| `versions/<version>/` | One checkout per installed version with its dependencies. A release is named by its tag (`v0.2.0`), a main branch build by its commit (`main-<sha12>`) |
| `current` | Symlink to `versions/<version>` (Linux and macOS) |
| `current.txt` | Name of the current version (Windows) |
| `bin/sculk`, `bin/sculk.cmd` | Launchers that run `node <current>/src/cli.ts`. `SCULKWIRE_NODE` picks another `node` for both |
| `install.json` | Repository URL. Its presence marks the folder as a managed install |
| `update.json` | Last check, newest version seen, previous version, last error |

A version folder is never changed after it is installed. A new version is cloned into a staging folder, gets `npm ci`, and must pass a smoke check (`sculk --help` and an MCP `tools/list`) before it is renamed into `versions/` and `current` switches with a single rename.

## Registration

`sculk setup --register omp,claude` registers the launcher, so an update never touches a client configuration.

- omp: adds or replaces only the `sculkwire` entry in `~/.omp/agent/mcp.json`. An existing file is first copied to `mcp.json.bak`. An invalid file is left unchanged.
- Claude Code: runs `claude mcp add --scope user sculkwire -- <launcher> mcp` when the `claude` command exists, replacing an earlier registration.
- Any other client: `sculk setup` prints the JSON entry on stdout.

On Windows the entry runs `cmd /c <data>\bin\sculk.cmd mcp`, because MCP clients start servers without a shell.

## Updates

Releases are git tags `vX.Y.Z`. The channel is set in `config.json` in the sculkwire config folder (`~/.config/sculkwire/config.json` on Linux and macOS, `%APPDATA%\sculkwire\config.json` on Windows).

```json
{ "update": { "channel": "release" } }
```

| Channel | Installs |
|---|---|
| `release` (default) | The newest release tag. Prereleases such as `v1.0.0-rc.1` are skipped |
| `main` | The head of the main branch |
| `off` | No automatic updates. `sculk update` still installs the newest release when run by hand |

Automatic updates run in a managed MCP server after it starts. The check happens at most once every 24 hours, in the background, and never delays startup or a tool call. Every network step has a timeout (20 s for the tag lookup, 3 minutes for the download). A failure writes one line to stderr and keeps the current version. After an update the server sends an MCP logging notice (`sculkwire X.Y.Z installed, restart the session to use it`). The running server keeps its version and the next session starts the new one. `SCULKWIRE_AUTO_UPDATE=0` turns the automatic check off for one process.

| Command | Effect |
|---|---|
| `sculk update` | Install the newest version of the channel and switch to it |
| `sculk update --check` | Report whether a newer version exists, install nothing |
| `sculk update --channel <channel>` | Save the channel, then update (except for `off`) |
| `sculk update --rollback` | Switch back to the version before the last update. A second rollback switches forward again |

`update` keeps two versions, the current one and the one before it. An older version that a running MCP server still uses is kept until a later update finds it unused.

`sculkwire_version` (MCP) and `sculk doctor` report the running version, the channel, the newest version seen, the last check and whether an installed update waits for the next session.

## Releasing

1. Bump `version` in `package.json` and add a `## vX.Y.Z` section to `CHANGELOG.md`.
2. Commit, then tag `vX.Y.Z` and push the tag.
3. The `release` workflow runs tsc and vitest, checks that the tag matches `package.json`, and creates the GitHub release with the changelog section as its notes.

Managed installs pick up the tag on their next daily check.
