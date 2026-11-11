# Reverse Engineering the Game

How to research the retail PC (GDK) client of Minecraft Bedrock to add or fix a feature of the in-game agent, and how to get data out of the game without any reverse engineering. Read [In-Game Agent](engine.md) first: it describes what the agent does and its wire protocol. This page is about how a new piece of it is found, written and proven.

Everything here is about the retail game as you can install it. Three things never go into this repository:

- **Addresses.** No game address, RVA, offset or `exe+0x…` value from a real build, in code, comments, tests or docs. `exe+0x…` below is a placeholder.
- **Game content.** No copy of `Minecraft.Windows.exe`, no decompiled output, no dumps, no unpacked packs. Keep your notes and your Ghidra project outside the checkout.
- **Your machine.** No real paths with your user name, no logs with your account or xuid.

## First: Do You Need It?

Most questions about the game have an answer that needs no reverse engineering. Try these first; they are faster, they survive game updates, and they work without the agent.

| You want | Use | How it gets it |
|---|---|---|
| Vanilla definitions of the installed version: recipes, loot tables, entities, blocks, items | `game_vanilla_packs`, `game_extract_pack` | Unpacks the game's own `.brarchive` packs into plain folders you can grep |
| How vanilla uses a component, an event or a texture key | `vanilla_example` | Mojang's bedrock-samples for the channel |
| Every block, item or mob id the running game knows, add-ons included | `game_registry` | `/connect`'s data request, or the Script API (`BlockTypes`, `ItemTypes`, `EntityTypes`) through the helper pack |
| Players, entities, blocks, inventories, containers in a running world | `game_query`, `player_state`, `player_inventory`, `container get` | The helper pack's Script API queries; add a handler to `HANDLERS` in `src/runtime/client/helper-pack/scripts/main.js` for a new read |
| A command's result | `game_command`, `engine_command` | `/connect` or the script debugger; the agent runs it as the local player |
| Script API, components, commands, Molang, what changed in which version | `api_lookup`, `component_lookup`, `command_lookup`, `molang_lookup`, `docs_search`, `changelog_search` | The versioned knowledge sources |
| What the game complained about | `game_log` | The content log, mapped to your files |
| Game options and world settings with the game closed | `game_settings`, `world_settings` | `options.txt` and `level.dat` |
| What is on screen | `game_screenshot` | The window, without the agent |

Reverse engineering is for what the game only does inside its own process: input that works in the background, the UI's screens and controls, item stack requests, the recipe lookup, the station actions, the presented frame, the tick. If a feature can be built on the Script API or a command, build it there.

## How the Agent Finds Things

The agent holds no addresses. At attach, each area module of `native/agent/src/` resolves its **anchors** against the image that is loaded in the process, from **recipes**: rules that describe a function or a field by something that survives a game update. `anchors.rs` lists the recipe kinds in order of preference:

| Recipe | What it reads | Example of the idea |
|---|---|---|
| Assert metadata | The `{function pointer, source .cpp, signature}` triples the game keeps in `.rdata` | The frame function, found by its own signature text |
| A string the function references | A unique string, then the RIP-relative reference to it, then the function around that reference (`.pdata`) | A command's error message names the function that prints it |
| An ECS component type hash | The FNV-1a 32 hash of a component's type name, as an immediate in code, cross-checked against the runtime's descriptor table | The player system is the smallest function that uses all of a few component hashes |
| MSVC RTTI | Type descriptor, complete object locator, vtable, then a slot | A class's virtual getter |
| Code shape at a proven site | A call after a hash immediate, a masked byte signature, a code pointer a body hands to a register | The accessor called right after a known hash |
| A live object | Something the running game creates: the local server, the command manager, the level's data | Recovered at runtime once it exists (`live.rs`, `world.rs`) |

Field offsets and vtable slots are read from the game's own code, not written down: a getter whose body is `lea rax,[rcx+N]; ret` gives `N` (`member_getter` in `inventory.rs`), a `mov al,N; ret` body gives a constant, an instruction ending at a displacement gives that displacement. The primitives for all of this are in `agent-core` (`Image`: sections, `find_string`, `rip_refs`, `function_start`, `type_descriptor`, `vtable`, `scan_signature`; `x64` for decoding) and in `native/agent/src/pe.rs` (component hash scans, callers, callees, `named_function`, readability checks).

Resolution is fail-closed. A recipe that does not find exactly one answer leaves the anchor at 0, and every method that needs it answers `-32001` (`anchor_missing`) with the anchor's name in `data.anchor`. `engine_status` lists every resolved anchor with its address and every missing one, so after a game update you see at once what moved:

```sh
sculk engine status | jq '.missing'
```

## Tools

| Tool | Use |
|---|---|
| A copy of `Minecraft.Windows.exe` | Copy it out of the game folder into a scratch folder outside the checkout and work on the copy. Note the game version (`game_builds` reports it) next to your notes |
| [Ghidra](https://ghidra-sre.org) | Decompile the functions you found. The image is several hundred MB, so a full auto-analysis takes hours; import with `analyzeHeadless … -import <copy> -noanalysis`, then disassemble and decompile only the functions you need from a script. The GUI works the same on a small project |
| Python with `pefile` and `capstone` | Fast static scans over the copy: strings, RIP-relative references to a string, `.pdata` function bounds, RTTI vtables, wildcard signatures and their match count, callers of a function. These are the same questions the agent's recipes ask, so a scan here is a dry run of a recipe |
| The agent's `debug-rpc` build | Read memory and call getters in the live game, below |
| `engine_status` and `sculkwire-agent.log` | What resolved, what is missing, what the recipes logged, and every fault |

Ghidra shows virtual addresses at the image's preferred base. The agent logs offsets from the loaded image (`exe+0x…`) and `engine_status` reports absolute addresses; `info` returns the loaded `imageBase`. Subtract the base before comparing any two of them.

### The debug-rpc Build

`--features sculkwire-agent/debug-rpc` adds diagnosis methods to the agent. An agent that can be told to read memory is a debugging build: it is never published, and the release workflow builds without it.

| Method | Thread | What it does |
|---|---|---|
| `debug.mem {addr, len}` | socket | The bytes at `addr` as hex, at most 4096, only where the memory is committed and readable. `addr` is a number or a `"0x…"` string |
| `debug.find {value, limit?, addr?, bytes?, budget?}` | socket | Every 8-byte-aligned position whose qword is `value`, inside `[addr, addr+bytes)` when given. How a pointer to a vtable, an object or a string is found without a hook |
| `debug.str {addr, fn}` | socket | Calls `fn(addr, &out)` as an MSVC `std::string` getter and decodes the result. `fn` is a code address or `{slot}` of `addr`'s vtable. Proves a getter's argument order and output layout on a live object |
| `debug.sleep {ms}` | main | Holds the main-thread drain up to 20 s, to check timeouts and drain recovery. The game's frame stalls that long |
| `debug.fault` | main | A deliberate access violation inside a handler, to check the fault path. Never answers |
| `debug.threads` | socket | Runs the unload's quiescence check now, for every thread: which stacks unwind cleanly and which do not |
| `debug.hit` | main | The entities in reach and the raw hit-result data around the crosshair |

These are always present, in every build: `ping`, `info` (pid, executable, `imageBase`, `imageSize`), `modules`, `engine.status`, `engine.resolve`, `agent.unload`, and the test hook `debug.focus` (posts a focus loss through the input lock). The list in your checkout is `METHODS` in `native/agent/src/lib.rs` plus the `match` in `native/agent-core/src/rpc.rs`.

The wire is newline-delimited JSON-RPC 2.0 on `127.0.0.1:19160` (`SCULKWIRE_AGENT_PORT` moves it). A tiny client:

```python
#!/usr/bin/env python3
"""rpc.py <method> [json params]: call the agent and print the answer."""
import json, socket, sys

def call(method, params=None, port=19160):
    with socket.create_connection(("127.0.0.1", port), timeout=30) as s:
        s.sendall((json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}) + "\n").encode())
        for line in s.makefile():
            message = json.loads(line)
            if message.get("id") == 1:  # tick and lock notifications carry no id
                return message

if __name__ == "__main__":
    print(json.dumps(call(sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv) > 2 else None), indent=1))
```

```sh
python3 rpc.py info
python3 rpc.py debug.mem '{"addr": "0x…", "len": 64}'
```

## Workflow

1. **Find it statically.** Start from something stable: a string the feature prints, an assert-metadata signature, a component name, a class name in RTTI. Follow it to the function with your scanner, and read that function in Ghidra. Write down the chain, not the address: "the function that references string S, then its second call".
2. **Write the recipe** in the area's `resolve(core)` in `native/agent/src/`, report it from `report()`, and log what it found (`resolve <name>: …`). Check every step: a unique match, an instruction boundary, a `.pdata` entry that contains the address, a vtable slot that points into `.text`, a readable object.
3. **Build with `debug-rpc` and hot-reload it** into the running game. The injector refuses a DLL path that is already loaded, so every build gets a new file name:

   ```sh
   cd native
   cargo build --release --locked --target x86_64-pc-windows-msvc --features sculkwire-agent/debug-rpc
   dev=~/.cache/sculkwire/agent-dev; mkdir -p "$dev"
   n=$(date +%s)
   cp target/x86_64-pc-windows-msvc/release/sculkwire_agent.dll "$dev/sculkwire-agent-$n.dll"
   cp target/x86_64-pc-windows-msvc/release/sculkwire-injector.exe "$dev/"
   python3 rpc.py agent.unload          # only when an agent is loaded; answers {"unloading": true}
   SCULKWIRE_AGENT_DLL="$dev/sculkwire-agent-$n.dll" sculk engine attach
   ```

   Wait for `unload: freeing … with 1 reference(s)` in the old agent's log before the attach. `SCULKWIRE_AGENT_INJECTOR` defaults to `sculkwire-injector.exe` next to the DLL. The new agent writes `sculkwire-agent.log` next to its DLL, here `$dev/sculkwire-agent.log`.
4. **Read the log and the status.** `attach: N anchors resolved, M missing`, your own `resolve` lines, and `engine_status.missing`. A missing anchor is a recipe to fix, not a value to hard-code.
5. **Prove the layout live before relying on it.** Read the object with `debug.mem`, find who points at it with `debug.find`, call a string getter with `debug.str`. A field is proven when its value changes the way the game changes (move the player, open a screen, put an item in a slot) and the read-back agrees.
6. **When it faults**, the log has the place and the caller chain:

   ```text
   fault: code=0xc0000005 thread=0x… exe+0x…
   fault: …registers and the address that was touched…
   fault: stack returns exe+0x… exe+0x… …
   ```

   `exe+0x…` is an offset into the game image: add the preferred base Ghidra uses and go to that address; the `stack returns` are the callers. `agent+0x…` is inside the agent: look it up in a disassembly of the DLL you built. A fault inside a main-thread handler releases the drain and fails that request, so the game usually keeps running, but whatever the game function did before it faulted stays done. Fix the call; never continue from it.
7. **Derive offsets and slots from the game's code**, as above, and validate each one against a live object before the method uses it. A layout seen once in a debugger is a guess.

## Writing the Recipe

- **No constants from one build.** No addresses, RVAs or field offsets in the source. A masked byte signature is the last resort, only when it matches exactly once and the code around it is checked too.
- **Fail with `anchor_missing`, never guess.** A method whose anchor is missing answers `RpcError::anchor("<area>.<name>")`. Do not fall back to "the address it had last time" or to the nearest match.
- **Game calls on the main thread.** A method that touches the game is a `Method::main`; a `Method::socket` only reads the agent's own state or memory it has proven readable.
- **Use the game's own paths.** Change state through the setter, the command or the request the game itself uses (an item stack request, an interact call, a recipe lookup), not with a raw memory write.
- **Input fails open.** Anything that hides or replaces the user's input must give it back when its signal is missing, when the agent unloads, and when it faults.
- **Keep the guards.** Only local worlds (`-32002` otherwise), only `sculkwire-*` worlds for world changes, and no UI input on store screens except `Escape`.
- **Keep it unloadable.** Every hook, patched slot, subclass or timer you add is taken back in the unload, or a hot reload breaks.

## Verifying Live

1. Use a `sculkwire-*` world created through sculkwire, with nothing else driving the game.
2. Call the method through the real tool or `sculk` command, not only `rpc.py`.
3. Look with `engine_screenshot` (it copies the presented frame, without the game's own screenshot), and read the result back another way: `player_inventory`, `container get`, `game_query`, `engine_player`, a command's output.
4. Check `engine_status` again: nothing new is missing, `drainReleases` did not move, the hooks are still in place.
5. Restore everything: options through `game_settings` or `game_stop`, the world through commands or a fresh test world.
6. Record the result in the Status table of [In-Game Agent](engine.md#status) with the game version you checked.

## Pitfalls

- **A locked desktop throttles the game** to about one frame per second, so main-thread requests time out and input looks broken. Keep the session unlocked while testing (a screen-saver inhibitor helps; on KDE Plasma, `kde-inhibit --screenSaver --power sleep infinity`).
- **Wine and Proton.** The injector must run with the install's own Wine (`SCULKWIRE_WINE` overrides it), or a second wineserver starts and the game is not found. Paths crossing into the game are `Z:` paths, and the agent's log is next to its DLL on the host side. See [Linux and macOS](engine.md#linux-and-macos).
- **The same DLL path twice.** `LoadLibraryW` on a path that is still mapped returns the old module and never runs the new `DllMain`. The injector refuses such a path by name; use a fresh file name per build.
- **The port after a reload.** A new agent retries `19160` for three seconds while the old one leaves, then takes the next free port. `engine_status.port` says which; sculkwire only dials the first.
- **OreUI and JSON-UI.** JSON-UI screens are drawn and hit-tested by the game's window procedure and have a readable control tree. OreUI pages are a hosted web view in a child window: they all name themselves `ui://./hbui/index.html`, the route comes from the game's OreUI router, and a click goes to the child window. Some screens hand out no control view at all. Check which kind a screen is before planning a feature for it.
- **Client mods.** A launcher that injects its own client mod hooks the same functions the agent uses. Research and test against an unmodified game.
- **Ghidra VAs.** Ghidra prints virtual addresses at the preferred base; the agent prints offsets. Convert before comparing, and never paste either into the repository.
- **A game update.** Recipes re-resolve on every attach. After an update, `engine_status.missing` is the work list.
