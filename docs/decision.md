# Decision Model

A decision model answers typed questions about a state with probabilities instead of generating text. sculkwire uses one for two features, and only as an advisor. The `play` action of `player_act` picks its tactics with built-in scores and works without a model. The sign-in join recovery of `game_launch` walks the menus with a screen-state machine and asks a model with image support only when that machine is stuck (see [Sign-In Race at Launch](client.md#sign-in-race-at-launch)). Every other tool works without one too, and the default is none.

sculkwire speaks the TypeSafe System One API (`POST <base>/v1/systemone`) and supports three providers.

| Provider | Model | Endpoint | Key | Images |
|---|---|---|---|---|
| `openrouter` | Jev, `typesafe/jev-1.14` | `https://openrouter.ai/api/v1/systemone` | [OpenRouter key](https://openrouter.ai/settings/keys) | Yes |
| `zenmux` | Jev, `typesafe/jev-1.14` | `https://zenmux.ai/api/v1/systemone` | [ZenMux key](https://zenmux.ai/settings/keys) | Yes |
| `local` | Kev, `kev-latest` | `http://127.0.0.1:8009/v1/systemone` | None | No |

Jev answers in about 0.1 s and is billed per input token. Kev runs on your own GPU and accepts text only, so `play` with `vision` and the sign-in join recovery advisor need Jev.

## Setup

Run the interactive setup. It checks the machine, asks for the provider and its key or URL, saves the choice and prints how to register sculkwire with omp or Claude Code.

```sh
node src/cli.ts setup
```

An MCP client that supports elicitation is asked for the provider the first time `decision_status` runs without a model, and for the server URL when the choice is local Kev. `play` never asks, it runs on its built-in scores instead. No client is ever asked for an API key, because MCP forbids collecting secrets that way. For Jev, set `OPENROUTER_API_KEY` or `ZENMUX_API_KEY` in the environment sculkwire runs in, or enter the key in `sculk setup` in a terminal. Clients without elicitation get a message to run `sculk setup`.

To check the result, call the `decision_status` tool or run `node src/cli.ts doctor`. Both send one tiny question and report the provider, the model, whether it answered, the latency and whether it accepts images.

## The Tactic Layer

`play` decides every 250 ms which tactic to follow: fight a mob, flee, eat, walk to the goal, use the held item on a mob, or idle. A built-in scorer rates each one from a threat map (hostile mobs with their distance, closing speed, danger and creeper fuses, plus the player's health, food, armor, best weapon and food), so `play` works with the provider `none`. The tactics run as skills that keep going until the next decision replaces them. See [play](tools.md#play) for the scores and skills.

With a model configured, each decision also sends the model the threat map as a short text state and asks up to three questions in one request.

| Question | Type | Answers |
|---|---|---|
| `tactic` | Choice | The tactics possible now |
| `target` | Choice | An entity key such as `zombie_1`, or `none` |
| `goal_done` | Noul | Probability that the goal is achieved, asked only for goals without a built-in check |

The model's tactic runs when its probability is at least 0.3 and the tactic is possible. The built-in choice runs instead in an emergency (a creeper about to explode, near death next to a mob), when the answer is weak or impossible, and when the model fails or takes longer than 1.5 s. Kill, reach and hit-every-X goals are checked against the game, so the model's `goal_done` only ends goals the checks do not cover. Turn the advisor off for one run with `advisor: false`.

## Measured Effect

Measured on 2026-11-11 on the retail game 1.26.63.1 with local Kev (`kev-0.8b`), `play` with and without the advisor, five runs per cell (fighter loadout, closed arena, midnight, 90 s limit).

| Scenario | Advisor | Won | Time, mean (range) | Damage taken, mean | Advisor latency, median | Answers used | Differed from built-in |
|---|---|---|---|---|---|---|---|
| Three zombies | Off | 5/5 | 9.8 s (8.5 to 12.4) | 6.7 | | | |
| Three zombies | On | 5/5 | 10.1 s (9.3 to 11.2) | 7.3 | 35 ms | 100% | 18% |
| Creeper | Off | 5/5 | 8.7 s (8.3 to 9.1) | 0 | | | |
| Creeper | On | 5/5 | 8.4 s (8.0 to 9.0) | 0 | 32 ms | 100% | 0% |

No measurable effect: every difference is inside the run-to-run spread. The runs drove `player_act play` directly, because `sculk bench` never consults the advisor (its `play` goals run on the built-in scores). The sign-in join recovery needs a model with image support, so with Kev it is never asked.

## Running Kev Locally

Kev needs [uv](https://docs.astral.sh/uv/) and a GPU. The Kev-0.8B server uses about 4.3 GB of VRAM. `sculk doctor` names the uv install command for your OS.

Linux (on macOS the folder is `~/Library/Caches/sculkwire/kev`):

```sh
git clone https://github.com/jaredpalmer/kev ~/.cache/sculkwire/kev
uv sync --directory ~/.cache/sculkwire/kev --extra serve
uv run --directory ~/.cache/sculkwire/kev --extra serve python -m kev.serve --run jaredpalmer/kev-0.8b --port 8009
```

Windows (cmd):

```bat
git clone https://github.com/jaredpalmer/kev %LOCALAPPDATA%\sculkwire\cache\kev
uv sync --directory %LOCALAPPDATA%\sculkwire\cache\kev --extra serve
uv run --directory %LOCALAPPDATA%\sculkwire\cache\kev --extra serve python -m kev.serve --run jaredpalmer/kev-0.8b --port 8009
```

In PowerShell write `$env:LOCALAPPDATA` instead of `%LOCALAPPDATA%`. `sculk setup` and the error messages print these commands with the real folder filled in, as single commands that paste into sh, PowerShell and cmd alike.

The first start downloads the weights (about 1.8 GB) into the Hugging Face cache. Keep the server running while you play. When it is not running, sculkwire reports the start command instead of a connection error. On an RTX 4080 the status probe answers in 10 to 40 ms.

## Configuration

The choice is saved in `~/.config/sculkwire/config.json` (`$XDG_CONFIG_HOME/sculkwire` when set, `%APPDATA%\sculkwire` on Windows, or the folder in `SCULKWIRE_CONFIG`). On Linux and macOS the file is written with mode 0600 when it holds a key, so only your user can read it. Windows has no file modes: the file sits in your `%APPDATA%` profile folder, which only your account (and administrators) can read.

```json
{
  "decision": {
    "provider": "openrouter",
    "model": "typesafe/jev-1.14",
    "apiKey": "sk-or-..."
  }
}
```

`model` and `baseUrl` are optional and default to the values in the table above. `baseUrl` is the API base without `/v1/systemone`.

Environment variables override the file.

| Variable | Overrides |
|---|---|
| `SCULKWIRE_DECISION` | The provider: `none`, `openrouter`, `zenmux` or `local` |
| `SCULKWIRE_DECISION_URL` | The API base URL |
| `SCULKWIRE_DECISION_MODEL` | The model id |
| `OPENROUTER_API_KEY` | The key for `openrouter` |
| `ZENMUX_API_KEY` | The key for `zenmux` |

A key in the environment is used instead of the saved one, so you can keep keys out of the file.

## Errors

| Message | Fix |
|---|---|
| Rejected the API key (401 or 403) | Run `sculk setup` with a valid key, or fix the key variable |
| Answered 404 | Check `baseUrl` and the model id |
| Local decision server is not running | Start Kev with the command in the message |
| Did not answer within 10000 ms | The server is overloaded or the network is down |
