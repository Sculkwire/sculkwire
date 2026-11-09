# Changelog

Release notes for sculkwire. Each `## vX.Y.Z` section becomes the GitHub release text when its tag is pushed.

## v0.1.0

First release.

- Versioned knowledge for stable and preview: docs, Script API, components, commands, Molang, vanilla examples and changelogs.
- Pack validation with file, line, column and rule code for every problem, including Regolith projects.
- Schemas from [rockide/schemas](https://github.com/rockide/schemas) by default, kept on rockide's newest GitHub release: the source tarball of the newest release tag goes into the cache on first use, the tags are checked again at most once a day (`sculk knowledge update` checks at once), a new release is unpacked and checked before it replaces the old copy, and the last copy is used offline. Without a copy, validation goes on with the engine schemas and `component_lookup` without rockide, and both say so in a `rockide.note`.
- The validator tries rockide first, then the engine schemas from bedrock-samples. Measured on vanilla 1.26.60.5: rockide covers 7476 of 7862 JSON files (the rest are texture lists, `texts/languages.json` and manifests, which have their own check), and 86% of injected entity, block and item errors are caught instead of 18% with the engine first (unknown components and fields), for 9 more held-out vanilla false positives in 3816 files. `--rockide <dir>` (CLI) and `rockide_dir` (MCP) pick a checkout. Results carry `rockide` (release, commit and newest release seen).
- Loot `match_tool` conditions accept a number or `{range_min, range_max}` for `count`, `durability` and enchantment `levels`, as Mojang documents.
- `component_lookup` and `sculk component` include the rockide definition per scope (entity behaviors and components, block and item components, client files): description, properties with types, defaults, allowed values and bounds at the `format_version` matching the channel's game version, plus every version and the versions where it changed.
- Every data source updates on its own, at most one cheap check per source per day, without blocking a tool call and keeping the last copy offline or after a failure. The version pins (samples tags, npm builds, BDS builds, changelog titles) are re-resolved in the background once a day. The MCP server then checks out a newly pinned samples tag while the previous checkout answers, downloads a newer BDS build for the next `bds_check`/`gametest_run`/session, fetches changelogs again when a new article appears and re-indexes the creator docs when `main` moves, all in the background. New typings are installed on next use with the previous install as fallback. A CLI command only refreshes the pins in the background and exits at most 3 seconds after its output; `sculk knowledge update` refreshes everything in the foreground, including installed BDS builds.
- `sculk knowledge status` and `knowledge_versions` list every data source with the version in use, the newest seen upstream and the last check.
- Bedrock Dedicated Server: load checks, headless GameTest runs, sessions and script profiling. A Regolith project whose profile runs filters is built with rgl first and BDS loads the built packs; diagnostics point at the source files (through source maps for generated scripts), and a failed build is a `regolith.build-failed` error with no server started.
- Live game bridge on Windows and Linux: private single-player test worlds, deploy and reload, content log, queries, screenshots and input, with screen-aware sign-in recovery at launch. Deploys leave one folder of the project per pack uuid (a fresh build goes into the project's rgl export folder when there is one) and warn about other packs that share the uuid.
- Player control (`player_act`, `player_job`, `player_state`): human-like camera, pathfinding and combat skills, and the background `play` loop with an optional decision model as advisor.
- Game files of an installed PC (GDK) copy (`game_builds`, `game_vanilla_packs`, `game_extract_pack`, `sculk gamefiles`): game version, the per-version `vanilla_1.x` packs and their extraction from `.brarchive` into plain folders.
- Extensions: packages listed in `SCULKWIRE_EXTENSIONS` or placed in `<config>/extensions` add MCP tools, CLI commands and an in-process input provider for `player_act`; a broken extension is skipped with one stderr line.
- `sculk bench` measures the player skills in built arenas.
- Installers. `install.sh` (Linux and macOS) and `install.ps1` (Windows) install the newest release into a managed layout, put `sculk` on PATH and run `sculk setup`. Flags: `--yes`, `--decision`, `--register`, `--channel`.
- Automatic updates. A managed MCP server checks for a new release at most once a day in the background, installs and checks it, and switches to it for the next session. `sculk update` (with `--check`, `--channel release|main|off` and `--rollback`) does the same by hand.
- `sculk setup --register omp,claude` registers the stable launcher with omp and Claude Code and prints the JSON for any other client. `sculk setup --yes --decision <provider>` runs without questions.
- `sculkwire_version` tool and a `version` line in `sculk doctor`: running version, channel, newest version seen and whether an update waits for the next session.
- Dependabot opens PRs for the npm dependencies.
