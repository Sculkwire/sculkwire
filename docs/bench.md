# Bench

`sculk bench` measures how well the player skills do in the real client. It launches a sculkwire world named `sculkwire-bench` (a visible window by default, muted, difficulty normal), attaches the [input provider](extensions.md#input-provider) when one is installed, builds each scenario's arena with commands far from spawn, sets the player up, spawns the mobs, runs the scenario's action or `play` goal, measures, resets and goes again. At the end it stops the game unless `--keep` is given, prints a markdown table and writes the full JSON (every run, every hurt event count, the extra numbers) to the bench cache folder (`~/.cache/sculkwire/bench` on Linux) as `<suite>-<timestamp>.json`, or `<suite>-<scenario>+<scenario>-<timestamp>.json` with `--scenario`. A `play` run also gets a `trace`. It has one line per hit the player took from the helper's hurt log (damage and who did it), then the tactic changes with their reasons, and for every hit taken during a fight the fight's frames from the 1.2 seconds before it (distance and reach of the target, swing and mob cooldowns, footwork, shield, held movement and the other mobs around), so a failed run shows why the hits landed.

Each scenario in the JSON also has `entityAge`, how old the entity readings the skills got were, in milliseconds (count, mean, median, 90th percentile, most), split by where they came from. `stream` readings rode the helper's state stream, which carries the 8 closest living entities within 16 blocks every tick, and were carried forward along their velocity by their age. `query` readings came from a helper query (an entity farther out, or none in the stream). An age runs from the arrival of the streamed state of the reading's game tick to the moment the skill had it, so the print's own transport is left out of both.

Every run's action runs with the fight's per-tick trace switched on (`traceFights`). The frames of every run that fought go into a second file next to the JSON, `<same name>.trace.json` (`tracePath` in the JSON, `Trace:` under the table), an array of `{ scenario, view?, stance?, run, frames }`. A frame is about 25 ms of the fight: the time since the trace started, the player's x, z, health and ground contact, each mob around (distance, its reach, ms until its attack is ready, degrees off the view, closing speed, whether it is the target), the footwork (`advance`, `hold`, `retreat`, `guard` or the creeper move) and group mode, the swing plan, ms until the next swing can land, the shield, the view error and its tolerance, the movement input, what happened (`swing`, `hit`, `crit`, `miss`, `hurt`, `jump`, `block`) and the health lost. A fight keeps at most 8000 frames, dropping the oldest. A run with no fight frames (a `goto`) has no entry, and a bench with none writes no trace file.

On an install that sculkwire cannot start itself, the launch returns at once with the steps for the user. The bench then prints them and the world to open (`sculkwire-bench`) on stderr and waits until the world is ready (the helper pack answers and the player spawned), at most `--wait` seconds, and stops with a message when the game exits first. Only then does it attach the input provider. When the in-game agent is already loaded by another process (the injector refuses a second load of the same DLL), the bench uses that agent instead of failing.

World entry: the JSON's `entry` says how the bench world was reached, as `{ by, seconds, clicks? }`. The same line is printed under the table (`World entry: …`). `entry` is absent when the world never turned ready. See [How sculkwire Finds Its World](client.md#how-sculkwire-finds-its-world).

- `by` is `launch` when sculkwire started the game into the world, and `auto-enter` when sculkwire walked the menus into it itself: on an install you start by hand, or after a world link raced Microsoft sign-in.
- `by` is `manual` when you opened the world, and `already-open` when the world was ready the first time sculkwire looked.
- `seconds` runs from the bridge's start to the world being ready, the game's boot included.
- `clicks` counts the inputs sculkwire sent walking the menus.

```
sculk bench combat                       # every combat scenario, its default number of runs
sculk bench combat --scenario creeper --runs 3
sculk bench combat --scenario zombies3,mixed
sculk bench combat --input keyboard      # keyboard and mouse (xdotool, SendInput on Windows) instead of the engine route
sculk bench combat --scenario husks3 --view first,third   # every scenario once in first person, then once in third person
sculk bench combat --scenario cornered,zombies3 --stance kite,guard,auto   # every scenario once per shield stance
sculk bench nav
sculk bench all --list                   # every scenario, its default runs and what it tests
```

| Option | Meaning |
|---|---|
| `<suite>` | `combat`, `nav`, `goal`, `task` or `all` |
| `--scenario` | Only these scenarios, one name or a comma-separated list |
| `--runs` | Runs per scenario instead of each scenario's default (a positive integer) |
| `--input` | `auto` (default, the input provider's engine route when one is installed and attaches, else the keyboard), `engine` (fails when no input provider can be used) or `keyboard` |
| `--display` | `window` (default) or `headless` (Linux only; Windows runs the game's own window) |
| `--view` | `first`, `third` or `first,third`: the camera for the scenarios. For each view the bench sets the game's `game_thirdperson` option (0 first person, 1 third person behind) through the in-game agent and runs every picked scenario, so two views run each scenario twice. The original value is put back at the end, also with `--keep` and after an error. Default: the game's view is left alone |
| `--stance` | `auto`, `kite`, `guard` or a comma-separated list of them: how the fight uses the shield. The bench sets `stance` on every `play` action and `fight` action the scenarios return (other actions are left alone) and runs every picked scenario once per stance, each a row of its own; with a `--view` list too, once per view and stance. Default: the scenarios' actions as they are |
| `--wait` | Seconds to wait for the world on an install the user starts by hand (default 900) |
| `--keep` | Leave the game running at the end |
| `--json` | Print the whole report as JSON instead of the table |
| `--list` | Print every scenario and exit, whatever the suite |

The exit code is 0 when every run of every scenario succeeded and 1 otherwise. A bad option (a `--stance` other than `auto`, `kite` or `guard`, for one) prints the usage and exits with 2. `--view` needs the in-game agent: when none answers after the input setup (`--input keyboard` attaches none), the bench says so, stops the game and exits with 2. The bench launches its own game, so it fails when the game of the same install is already running or a sculkwire bridge already runs in the process.

On Windows the keyboard route uses the system keyboard and mouse: the bench brings the game window to the foreground once at the start, and it has to stay there. When you switch away, every key and button is let go, the running action fails with `the game window is not in the foreground`, and each run after it fails at once with the same message until the game window is in front again. On Linux the input stays inside gamescope and you can use your desktop meanwhile. Bench results so far come from Linux.

## Table

| Column | Meaning |
|---|---|
| view | The camera the row ran in; only present with `--view` (the JSON reports carry `view` then) |
| stance | The shield stance the row ran with; only present with `--stance` (the JSON reports carry `stance` then) |
| success | Runs that met the scenario's success condition, out of the runs |
| avg time s | Seconds from the start of the action to its end |
| avg damage | Health lost, from the helper pack's hurt log (armor and shield already counted) |
| avg health left, min health | Health at the end of the run (0 when the player died) |
| deaths | Player deaths over all runs |
| kills | Spawned mobs the player killed, from the helper's death log (see [World and reset](#world-and-reset)) |
| lost | Spawned mobs gone without a player kill (a creeper that blew up) |
| blast dmg | Damage from explosions |
| falls | Hurt events from falling |
| extra | The scenario's own numbers, averaged (booleans count the runs where they held) |

## World and reset

The bench sets these rules once. No natural mob spawning, no mob griefing (a creeper blast does not break the arena), immediate respawn, keep inventory, no phantoms, no fire spread, frozen daylight and weather, and natural regeneration on. Each scenario gets its own arena origin 160 blocks apart along x from x 1000, z 1000, with the feet at y -60 on the flat world.

Before every run the player is teleported to the arena in creative (so the chunks load), every non-player entity within the arena radius plus 24 is killed, the box is filled with air and its floor laid, and the scenario's build commands run. Then the player gets the game mode, an empty inventory, no effects, instant health and saturation (full health and food), the time of day, hotbar items in order from slot 1, a full armor set, the off-hand item, effects, and the start position and facing. The mobs are summoned (zombies and husks as adults, so no run fights a baby) and found again by type and spawn point to get their ids: right after the summons are sent, the bench looks every 100 ms, for at most 3 s, until every spawn has claimed the nearest entity of its type to its spawn point that no other spawn claimed. A scenario with `spawnAfterMs` summons them that many ms after its action started instead, and finds them the same way while the action runs; a failed summon ends the run as an error. A run ends when the action returns, the `play` goal is done, the time limit passes or the player dies.

A run's kills are counted from the helper's death log since the run started: every death of a found spawn's id with the player as the killer. For a spawn whose id was never found (it died before the bench saw it, as a quick kill of a slow summon can), a player kill of that spawn's type whose id is none of the found ones counts instead, at most one per such spawn. The death log carries no position; such a kill is in the arena because the arena was cleared of other mobs before the run and natural spawning is off. `lost` counts only found spawns that are gone without a player kill.

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
| `spawnAfterMs` | Summon the mobs this many ms after the action started instead of before it |
| `action(ctx)` | Any `player_act` action, or a `play` goal (run in the bench process) |
| `goals` | Phrasings of the `play` goal: run i plays phrasing i, wrapping around |
| `measure(ctx, outcome)` | Extra numbers for the table and the JSON |
| `success(outcome, extra)` | Whether a run counts (default, the action succeeded and the player did not die) |

### Combat

Every combat scenario is survival at night in a 29 by 29 glass-walled arena, with an iron sword, 16 cooked beef, full iron armor and a shield in the off hand unless it says otherwise. It runs `play` with the goal text in the table and a time limit of 90 s (120 s for `mixed`). A run succeeds when every spawned mob was killed by the player and the player did not die. The extra numbers are hits taken, whether the arena was cleared, swings, hits, misses and critical hits (the fight's own counts), `blocked` (hits the raised shield blocked, the `play` run's own count), meals eaten, flee decisions, the damage dealt by zombies, skeletons and spiders, `otherDeaths` (mobs near that died by something other than the player, such as another husk's spear), and these, read off the run's trace:

| Extra | Meaning |
|---|---|
| `stepBacks` | Hits after which the distance to the struck target grew by at least 0.5 block before the next swing was sent; read it against `hits` |
| `stepBackShare` | `stepBacks` over the hits the trace recorded (0 without a hit), two decimals |
| `blocks` | Frames with a `block` event (a hit the raised shield blocked) |
| `idleInReachMs` | Ms the player moved slower than 0.5 block/s with the shield down while a melee mob was within its reach plus 0.3 and the next swing was more than 120 ms away (standing behind a raised shield is not idle exposure) |
| `inReachStillMs` | The same, shield up or down |
| `inReachMs` | Ms a melee mob was within its reach plus 0.3 with its attack ready (its cooldown 0), whatever the player did |
| `shieldMs` | Ms with the shield raised |
| `retreatMs`, `advanceMs`, `holdMs` | Ms in each footwork |
| `maxMobsInReach` | Most melee mobs within their reach plus 0.3 in one frame |
| `aimErrAtSwing` | Mean view error in degrees on the frames that sent a swing (absent without a swing) |

Each gap between two frames counts for the earlier frame, at most 100 ms (a stalled frame does not add seconds), and the speed over a gap is the x/z distance over its real length. A mob counts as melee when its reach is at most 4 blocks (a ranged mob's reach in the trace is its shooting range). The extras average over the runs like the others.

| Scenario | Runs | Goal | Setup | Also needs |
|---|---|---|---|---|
| `zombies3` | 10 | "kill all the zombies" | 3 zombies 10 blocks out | |
| `creeper` | 10 | "kill the creeper" | 1 creeper 10 blocks out, sword only | No blast damage |
| `creeper-bow` | 5 | "kill the creeper" | 1 creeper 12 blocks out, a bow and 16 arrows besides the sword | No blast damage |
| `skeleton2` | 5 | "kill all the skeletons" | 2 skeletons 12 blocks out, two 2 by 2 stone pillars between | |
| `spider2` | 5 | "kill all the spiders" | 2 spiders 10 blocks out | |
| `mixed` | 5 | "kill the hostile mobs near you" | 2 zombies, a skeleton and a creeper | Its own rule instead of every mob killed by the player. The player is alive, the goal is done (no hostile left within 24 blocks), there was no blast damage and the creeper did not blow up. As in real play, a zombie the skeleton's arrows kill is fine, it only shows in `lost`. The `exploded` extra counts creepers gone without a player kill in every combat scenario |
| `husks3` | 10 | "kill 3 husks" | At day: 3 husks in a tight group (1 block apart) 10 blocks out, summoned 500 ms after `play` started, so the player is already in survival and fighting when they arrive. The goal counts kills, so it is not done before the husks exist | |
| `spears3` | 10 | "kill 3 husks" | At day: 3 husks with iron spears 10 blocks out (the scenario's `held` puts the item in the main hand after the summon). A spear husk charges with the spear lowered, hits on contact while the two close at speed, backs off to 9 to 11 blocks and comes again. The charges also run the other husks through | Its own rule: every husk dead (by the player or another husk: `kills` plus the `otherDeaths` extra) and the player alive. `kills` stays the player's kills |
| `cornered` | 10 | "kill all the zombies" | 3 zombies 8 blocks out in front (2 blocks apart), the player in a dead-end alcove of stone 3 high: a wall directly behind and one block to each side (3 wide, 2 deep), open only to the front. Stepping back is impossible, so the shield is the tool | |

### Navigation

Every movement course is survival at day with empty hands inside a glass ring 4 blocks high at the arena's edge, on a stone floor, so the course is the only way to the goal. Each runs 3 times by default with a 45 s limit (30 s for `parkour`, 60 s for `detour`). The action is a `goto` to the goal block. A run succeeds when `goto` arrives at the goal's height (within a block) with no damage and no death. The extra numbers are the distance from the goal, the height difference, and the jumps, gap jumps, doors opened, doors closed behind and replans from `goto`'s message. The shared pieces are in `scenarios/nav-kit.ts`.

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
| `detour` | `nav-detour.ts` | A stone wall 61 wide and 3 high 4 blocks ahead, the goal 12 behind it, in an arena of radius 36: the way around starts 31 blocks to the side, outside the first 48 by 48 planning window | |

`sealed` (`nav-sealed.ts`) is the course with no way: the goal is the block inside a closed 3 by 3 by 4 glass box 6 blocks ahead. It runs 3 times with a 15 s limit and succeeds when `goto` answers with a failure within 15 s whose message names the closest reachable spot, with no damage and no death. Its extra numbers are `seconds`, `closestSpot` and `closedIn` (whether the message says so) and `walked`, the blocks between the player's start and where it ended.

### Goal and Task

These suites measure what [`play`](tools.md#play) makes of a goal in plain words. Each scenario lists ten phrasings of one intent in `goals`, and run i plays phrasing i (the run's goal is in the log line and in the JSON run record as `goal`). Some phrasings match the goal grammar and some do not, on purpose: the success rate measures what the grammar understands (goals are compiled by the grammar alone) and how well the steps then run. A phrasing it does not understand ends in seconds with `goal_unknown`, which the time column shows. Every run builds its arena again and resets the player by commands, so runs are independent. The extras, from the run's plan:

| Extra | Meaning |
|---|---|
| `planSteps` | Steps the goal became |
| `freeSteps` | Parts the grammar did not understand (the run stops with `goal_unknown`) |
| `retries` | Task-step attempts a hit or a hostile close interrupted |

| Scenario | File | Setup | Phrasings like | Success |
|---|---|---|---|---|
| `goal/kill-phrased` | `goal-phrased.ts` | `combat/zombies3`: 3 zombies at night, the combat loadout | "kill all the zombies", "get rid of those three undead", "clear the arena" | 3 kills by the player and `goal_done` within the 60 s limit, no death |
| `goal/reach-phrased` | `goal-phrased.ts` | A gold block 12 blocks ahead by day, empty hands | "go to the gold block", "head over to that yellow block" | Within 2.5 blocks of the block's centre and `goal_done` |
| `goal/two-step` | `goal-phrased.ts` | One zombie 9 blocks ahead at night, a gold block 11 blocks off to the side, the combat loadout | "kill the zombie then go to the gold block", "go to the gold block after you kill the zombie" | Both: the zombie killed, within 2.5 blocks of the block, `goal_done`, no death |
| `task/smelt-craft` | `task-phrased.ts` | An empty furnace and a crafting table 4 blocks away; the player holds 3 raw iron, 4 coal and 2 sticks | "smelt the ore and craft an iron sword", "forge an iron sword" | An iron sword in the inventory (120 s limit) |
| `task/trade` | `task-phrased.ts` | A farmer villager penned in fences 4 blocks away, a composter next to the pen. It is summoned as `minecraft:villager` with the `minecraft:become_farmer` event, which fixes the profession; `minecraft:spawn_farmer` picks one of five professions at random. The player holds 64 wheat, potatoes, carrots and beetroot, so whichever of the farmer's first-tier buy offers the game picked is accepted, and 64 sticks for a fletcher's first offer. The run's `offer` extra says what the villager offered | "trade for an emerald", "buy an emerald from the villager" | An emerald in the inventory |
| `task/nested-shulker` | `task-phrased.ts` | A chest 4 blocks away holding an undyed shulker box with 3 diamonds. No command fills a shulker box item inside a chest on Bedrock, so the build places the box above a hopper that feeds the chest, fills it with `replaceitem block`, and breaks it with `setblock ... air destroy`: the dropped box keeps its contents and the hopper moves it into the chest before the run starts | "get the diamonds out of the chest", "grab the diamonds" | 3 diamonds in the inventory |
| `task/blocked-chest` | `task-blocked-chest.ts` | A chest 4 blocks away holding 1 diamond, with two stone blocks on the side facing the player's start so no view from that side reaches it, and an empty decoy chest 2 blocks beside it (not touching, so it cannot pair) | "get the diamond from the chest", "fetch the diamond" | The diamond in the inventory |
| `task/blocked-chest-villager` | `task-blocked-chest.ts` | The same chests, with a villager penned in fences on the chest's side facing the player's start instead of the stone | "get the diamond from the chest", "loot the diamond" | The diamond in the inventory |
| `task/far-table` | `task-far-table.ts` | The only crafting table 30 blocks away, beyond the helper's 16-block `blocks` cube around the player, so the craft finds it in the cubes around that one; the player holds 8 oak planks | "craft a wooden pickaxe", "turn the planks into a wooden pickaxe" | A wooden pickaxe in the inventory (120 s limit) |

## Latest Results

These are the newest runs in `~/.cache/sculkwire/bench/` on the development machine (retail 1.26.63.1, the engine route, `play` with each scenario's goal, 2026-11-11). Success is runs that met the scenario's rule; time and damage are averages per run, and the worst run is the most damage any single run took.

Goals in plain words with and without a decision model placing the parts the grammar could not (local Kev, 10 phrasings per scenario, `goal-2026-11-11T20-20-34-773Z.json` and `task-2026-11-11T21-15-44-698Z.json`). The model placed 1 phrasing of 90 and made no clear difference, so `play` now compiles goals with the grammar alone.

| Suite | Grammar only | Grammar and model |
|---|---|---|
| goal (`kill-phrased`, `reach-phrased`, `two-step`) | 21/30 | 20/30 by the scenarios' rules, 23/30 by the goal check |
| task (6 scenarios) | 40/60 | 37/60 |

A combat adviser (the decision model setting the fights' stance and a bow opener about once a second) made no clear difference and was taken out with the last use of the model: 39/40 wins and 2.1 damage a run without it, 38/40 and 2.15 with it (10 runs each, `combat-husks3-bow+skeleton2+mixed+zombies3-2026-11-11T22-19-07-979Z.json`).

| Scenario | Adviser off | Adviser on |
|---|---|---|
| `husks3-bow` | 10/10, 0 damage, 22.0 s | 10/10, 1.3 damage, 21.4 s (20 orders a run, 7.8 differing from the built-in, 945 ms of model time) |
| `mixed` | 9/10, 4.2 damage | 8/10, 2.6 damage |
| `skeleton2` | 10/10, 4.1 damage | 10/10, 4.7 damage |
| `zombies3` | 10/10, 0.1 damage | 10/10, 0 damage |

Fights against a group, default stance, 10 runs per camera (`combat-zombies3+husks3+cornered-2026-11-11T20-43-37-210Z.json`).

| Scenario | View | Success | Avg time s | Avg damage | Worst run | Swings | Hits | Misses |
|---|---|---|---|---|---|---|---|---|
| `zombies3` | first | 10/10 | 10.7 | 0 | 0 | 11.2 | 9.4 | 1.8 |
| `zombies3` | third | 10/10 | 11.1 | 0.1 | 1.4 | 13.2 | 9.8 | 3.4 |
| `husks3` | first | 10/10 | 10.8 | 0 | 0 | 14.4 | 9.6 | 4.8 |
| `husks3` | third | 10/10 | 10.8 | 0.1 | 1.4 | 13.5 | 9.8 | 3.7 |
| `cornered` | first | 10/10 | 10.4 | 0 | 0 | 11.1 | 9.2 | 1.9 |
| `cornered` | third | 10/10 | 10.6 | 0 | 0 | 14.9 | 9.9 | 5 |

The same with `--stance guard`, first person, 5 runs (`combat-zombies3+husks3+cornered-2026-11-11T21-08-28-479Z.json`).

| Scenario | Success | Avg time s | Avg damage | Worst run | Hits blocked |
|---|---|---|---|---|---|
| `zombies3` | 5/5 | 14.2 | 1.1 | 2.8 | 6.8 |
| `husks3` | 5/5 | 16.2 | 1.4 | 2.8 | 8.4 |
| `cornered` | 5/5 | 16.1 | 0.3 | 1.4 | 10.8 |

The other combat scenarios (`combat-creeper+creeper-bow+skeleton2+spider2+mixed-2026-11-11T20-59-16-763Z.json`).

| Scenario | Success | Avg time s | Avg damage | Worst run |
|---|---|---|---|---|
| `creeper` | 10/10 | 8.2 | 0 | 0 |
| `creeper-bow` | 5/5 | 5.6 | 0 | 0 |
| `skeleton2` | 5/5 | 10.9 | 4.4 | 7.6 |
| `spider2` | 5/5 | 10.1 | 0 | 0 |
| `mixed` | 5/5 | 20.3 | 4.5 | 7.7 |

Husks with spears and the mixed group on the final build, 10 runs each (`combat-mixed+spears3-2026-11-12T00-34-06-246Z.json`): `spears3` 10/10 with 1.5 average damage in 18 s (before spear mobs were told apart: 1 of 5, 10.6 average damage, one death; in about half the runs a husk dies to another husk's spear, which the goal counts apart from the player's kills), `mixed` 8/10 with 5.1 average damage in 21.9 s. `mixed` varies from run to run: 5/5, 4/5, 9/10, 8/10, 2/5 and 8/10 over the day; a miss is the creeper blowing up with a zombie beside it, behind the shield.

Before the fight rework the same scenarios, N=10 per camera, gave: `zombies3` 9/10 and 10/10 with 12.0 and 9.6 average damage (worst run 22.4), `husks3` 9/10 and 10/10 with 11.2 and 9.2, `cornered` 9.3 and 10.2, `creeper` 8/10, `skeleton2` 7.9, `spider2` 2.8 and `mixed` 3/5 with 12.7 (`combat-zombies3+husks3-2026-11-11T13-50-05-257Z.json`, `combat-husks3+cornered-2026-11-11T14-25-01-426Z.json`, `combat-creeper+creeper-bow+skeleton2+spider2+mixed-2026-11-11T14-36-13-271Z.json`).

On the keyboard route the last full run is older: combat 3 runs each, all 3/3, with 3.7 (`zombies3`), 5.5 (`skeleton2`) and 8.0 (`mixed`) average damage (`combat-2026-11-09T04-57-52-777Z.json`).

Navigation, 2 runs each, succeeded in every run with no damage (`nav-2026-11-09T00-09-37-139Z.json`).

Navigation recovery, 5 runs each (`nav-detour+sealed-*.json`, the two newest of 2026-11-11): `detour` reached the goal 0 of 5 times before (it answered `no way to reach ...` in 0.2 s) and 5 of 5 after, in 13.2 to 14.3 s with 64 blocks planned. `sealed` answers with the closest spot in 0.2 to 0.6 s before and after; after, the answer also names the window tried and the legs walked.

World entry by icon on retail 1.26.63.1, an install started by hand with six `sculkwire-` worlds on the list: 16 of 16 launches entered `sculkwire-bench` with no help and opened no other tile, 146 to 148 s from the bench's start to the world being open, the game's boot included.
