# Bench

`sculk bench` measures how well the player skills do in the real client. It launches a sculkwire world named `sculkwire-bench` (a visible window by default, muted, difficulty normal), attaches the [input provider](extensions.md#input-provider) when one is installed, builds each scenario's arena with commands far from spawn, sets the player up, spawns the mobs, runs the scenario's action or `play` goal, measures, resets and goes again. At the end it stops the game unless `--keep` is given, prints a markdown table and writes the full JSON (every run, every hurt event count, the extra numbers) to the bench cache folder (`~/.cache/sculkwire/bench` on Linux) as `<suite>-<timestamp>.json`, or `<suite>-<scenario>+<scenario>-<timestamp>.json` with `--scenario`. A `play` run also gets a `trace`. It has one line per hit the player took from the helper's hurt log (damage and who did it), then the tactic changes with their reasons, and for every hit taken during a fight the fight's frames from the 1.2 seconds before it (distance and reach of the target, swing and mob cooldowns, footwork, shield, held movement and the other mobs around), so a failed run shows why the hits landed.

Each scenario in the JSON also has `entityAge`, how old the entity readings the skills got were, in milliseconds (count, mean, median, 90th percentile, most), split by where they came from. `stream` readings rode the helper's state stream, which carries the 8 closest living entities within 16 blocks every tick, and were carried forward along their velocity by their age. `query` readings came from a helper query (an entity farther out, or none in the stream). An age runs from the arrival of the streamed state of the reading's game tick to the moment the skill had it, so the print's own transport is left out of both.

```
sculk bench combat                       # every combat scenario, its default number of runs
sculk bench combat --scenario creeper --runs 3
sculk bench combat --scenario zombies3,mixed
sculk bench combat --input keyboard      # keyboard and mouse (xdotool, SendInput on Windows) instead of the engine route
sculk bench nav
sculk bench all --list                   # every scenario, its default runs and what it tests
```

| Option | Meaning |
|---|---|
| `<suite>` | `combat`, `nav` or `all` |
| `--scenario` | Only these scenarios, one name or a comma-separated list |
| `--runs` | Runs per scenario instead of each scenario's default (a positive integer) |
| `--input` | `auto` (default, the input provider's engine route when one is installed and attaches, else the keyboard), `engine` (fails when no input provider can be used) or `keyboard` |
| `--display` | `window` (default) or `headless` (Linux only; Windows runs the game's own window) |
| `--keep` | Leave the game running at the end |
| `--json` | Print the whole report as JSON instead of the table |
| `--list` | Print every scenario and exit, whatever the suite |

The exit code is 0 when every run of every scenario succeeded and 1 otherwise. A bad option prints the usage. The bench launches its own game, so it fails when the game of the same install is already running or a sculkwire bridge already runs in the process.

On Windows the keyboard route uses the system keyboard and mouse: the bench brings the game window to the foreground once at the start, and it has to stay there. When you switch away, every key and button is let go, the running action fails with `the game window is not in the foreground`, and each run after it fails at once with the same message until the game window is in front again. On Linux the input stays inside gamescope and you can use your desktop meanwhile. Bench results so far come from Linux.

## Table

| Column | Meaning |
|---|---|
| success | Runs that met the scenario's success condition, out of the runs |
| avg time s | Seconds from the start of the action to its end |
| avg damage | Health lost, from the helper pack's hurt log (armor and shield already counted) |
| avg health left, min health | Health at the end of the run (0 when the player died) |
| deaths | Player deaths over all runs |
| kills | Spawned mobs the player killed (the helper's death log, killer the player) |
| lost | Spawned mobs gone without a player kill (a creeper that blew up) |
| blast dmg | Damage from explosions |
| falls | Hurt events from falling |
| extra | The scenario's own numbers, averaged (booleans count the runs where they held) |

## World and reset

The bench sets these rules once. No natural mob spawning, no mob griefing (a creeper blast does not break the arena), immediate respawn, keep inventory, no phantoms, no fire spread, frozen daylight and weather, and natural regeneration on. Each scenario gets its own arena origin 160 blocks apart along x from x 1000, z 1000, with the feet at y -60 on the flat world.

Before every run the player is teleported to the arena in creative (so the chunks load), every non-player entity within the arena radius plus 24 is killed, the box is filled with air and its floor laid, and the scenario's build commands run. Then the player gets the game mode, an empty inventory, no effects, instant health and saturation (full health and food), the time of day, hotbar items in order from slot 1, a full armor set, the off-hand item, effects, and the start position and facing. The mobs are summoned (zombies as adults, so no run fights a baby zombie) and found again by type and spawn point to get their ids. A run ends when the action returns, the `play` goal is done, the time limit passes or the player dies.

## Scenarios

A scenario is a small declarative object in its own file in `src/runtime/client/bench/scenarios/`, exported as the file's default export (or as a `scenarios` array). The runner loads every file in the folder, so adding one needs no index edit. The fields are in `src/runtime/client/bench/types.ts`.

| Field | Meaning |
|---|---|
| `name`, `suite`, `summary` | Identity and the line `--list` prints |
| `runs` | Default number of runs |
| `timeoutMs` | Limit for one run's action |
| `area` | `radius` (blocks out on x and z) and `height` of the box cleared around the origin |
| `floor` | Floor block (default grass) |
| `build(ctx)` | Extra commands with absolute coordinates from `ctx.at({ dx, dy, dz })` |
| `player` | Game mode, time, hotbar, armor set, off hand, effects, start offset and yaw |
| `mobs` | Mob types and spawn offsets |
| `action(ctx)` | Any `player_act` action, or a `play` goal (run in the bench process) |
| `measure(ctx, outcome)` | Extra numbers for the table and the JSON |
| `success(outcome, extra)` | Whether a run counts (default, the action succeeded and the player did not die) |

### Combat

Every combat scenario is survival at night in a 29 by 29 glass-walled arena, with an iron sword, 16 cooked beef, full iron armor and a shield in the off hand unless it says otherwise. It runs `play` with the goal text in the table and a time limit of 90 s (120 s for `mixed`). A run succeeds when every spawned mob was killed by the player and the player did not die. The extra numbers are hits taken, whether the arena was cleared, swings, hits, meals eaten, flee decisions and the damage dealt by zombies, skeletons and spiders.

| Scenario | Runs | Goal | Setup | Also needs |
|---|---|---|---|---|
| `zombies3` | 10 | "kill all the zombies" | 3 zombies 10 blocks out | |
| `creeper` | 10 | "kill the creeper" | 1 creeper 10 blocks out, sword only | No blast damage |
| `creeper-bow` | 5 | "kill the creeper" | 1 creeper 12 blocks out, a bow and 16 arrows besides the sword | No blast damage |
| `skeleton2` | 5 | "kill all the skeletons" | 2 skeletons 12 blocks out, two 2 by 2 stone pillars between | |
| `spider2` | 5 | "kill all the spiders" | 2 spiders 10 blocks out | |
| `mixed` | 5 | "kill the hostile mobs near you" | 2 zombies, a skeleton and a creeper | Its own rule instead of every mob killed by the player. The player is alive, the goal is done (no hostile left within 24 blocks), there was no blast damage and the creeper did not blow up. As in real play, a zombie the skeleton's arrows kill is fine, it only shows in `lost`. The `exploded` extra counts creepers gone without a player kill in every combat scenario |

### Navigation

Every movement course is survival at day with empty hands inside a glass ring 4 blocks high at the arena's edge, on a stone floor, so the course is the only way to the goal. Each runs 3 times by default with a 45 s limit (30 s for `parkour`). The action is a `goto` to the goal block. A run succeeds when `goto` arrives at the goal's height (within a block) with no damage and no death. The extra numbers are the distance from the goal, the height difference, and the jumps, gap jumps, doors opened, doors closed behind and replans from `goto`'s message. The shared pieces are in `scenarios/nav-kit.ts`.

| Scenario | File | Course | Also needs |
|---|---|---|---|
| `ladder-up` | `nav-ladder.ts` | A 6-block ladder up the front of a stone tower 5 wide | |
| `ladder-down` | `nav-ladder.ts` | Down the same ladder from the tower top, where a jump would hurt | |
| `swim` | `nav-swim.ts` | A pool 3 deep and 10 long across the arena, out over a 1-block ledge | |
| `swim-dive` | `nav-swim.ts` | The same pool after a 3-block drop from a diving platform, so the player sinks and has to surface | |
| `stairs` | `nav-stairs.ts` | Up a ridge 3 high by bottom slabs and blocks (half a block per step), down oak stairs | |
| `stairs-back` | `nav-stairs.ts` | The same ridge the other way | |
| `gate` | `nav-gate.ts` | A fence across the arena with a closed fence gate | The gate closed again afterwards |
| `door` | `nav-gate.ts` | A stone wall across the arena with a closed oak door | The door closed again afterwards |
| `parkour` | `nav-parkour.ts` | Four 2-block gap jumps along 1-wide pillars 4 high (a fall hurts and has no way back) | |
| `course` | `nav-course.ts` | Two steps up onto a ledge 3 high, a 3-block drop, a water channel and a fence gate off to the side | |

## Latest Results

These are the newest full-suite runs on the keyboard route in `~/.cache/sculkwire/bench/` on the development machine. Success is runs that met the scenario's rule, time and damage are averages per run.

Combat, 3 runs each (`combat-2026-11-09T04-57-52-777Z.json`).

| Scenario | Success | Avg time s | Avg damage |
|---|---|---|---|
| `zombies3` | 3/3 | 12.3 | 3.7 |
| `creeper` | 3/3 | 7.8 | 0 |
| `creeper-bow` | 3/3 | 5.4 | 0 |
| `skeleton2` | 3/3 | 11.0 | 5.5 |
| `spider2` | 3/3 | 6.3 | 0 |
| `mixed` | 3/3 | 24.7 | 8.0 |

Navigation, 2 runs each, succeeded in every run with no damage (`nav-2026-11-09T00-09-37-139Z.json`).
