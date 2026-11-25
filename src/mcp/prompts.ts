/**
 * MCP prompts: sculkwire's flows written out as the exact tool calls to make, in order. They are registered whatever
 * `SCULKWIRE_TOOLSETS` keeps; each description names the toolsets its calls need.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

function userText(lines: string[]): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text: lines.join("\n") } }] };
}

const project = z.string().describe("project, add-on or pack folder");

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "debug_pack_errors",
    {
      title: "Debug pack errors",
      description:
        "Find and fix every error in a project's packs, then prove the fix in the running game or on a server. " +
        "Needs the toolsets validate, game and bds.",
      argsSchema: { project },
    },
    ({ project }) =>
      userText([
        `Find and fix every error in the add-on at ${project}.`,
        "",
        `1. Call validate_pack {"path": ${JSON.stringify(project)}}.`,
        "2. Fix each error by its file and line (warnings after the errors), then call validate_pack again. Repeat until it reports no errors.",
        "3. Call game_status. If `running` is true:",
        '   a. game_reload {"all": true} so the game loads the fixed packs.',
        "   b. game_log: every content-log entry and script error since the last call. Fix each one by file and line and repeat from step 1.",
        '   c. Confirm the fixed behaviour in the world: game_query (entities, blocks, components, scores …) for what should now be there, or wait_until {"condition": {"kind": "log", "pattern": <regex>, "errorsOnly": true}} (or an entity, block or score condition) for what should become true.',
        `4. Else call bds_check {"path": ${JSON.stringify(project)}} and fix every content-log or console error it reports by file and line, repeating from step 1.`,
        "Done when validate_pack, the game log (or bds_check) report no errors and the behaviour checked in step 3c holds.",
      ]),
  );

  server.registerPrompt(
    "playtest_feature",
    {
      title: "Playtest a feature",
      description:
        "Exercise one feature of a project in the real game from a saved starting scene and check the result. " +
        "Needs the toolsets game (and validate to fix what it finds).",
      argsSchema: {
        project,
        feature: z.string().describe("the feature to exercise, in words"),
        scene: z.string().optional().describe("name of the saved scene to start from, [a-z0-9_-]{1,32} (default: playtest)"),
      },
    },
    ({ project, feature, scene }) => {
      const name = JSON.stringify(scene || "playtest");
      return userText([
        `Playtest this feature of the add-on at ${project}: ${feature}`,
        "",
        `1. game_launch {"project": ${JSON.stringify(project)}}: enters the user's world for this project (the saved dev world, or the one already using its packs). When it fails because no world is found, ask the user which of the listed worlds to use, game_worlds {"action": "use", "world": <their answer>}, and launch again.`,
        `2. Starting scene: scene_list shows the saved scenes. If ${name} is not among them, set the world up for the test (game_command for /setblock, /summon, /give …), then scene_save {"name": ${name}} once (it saves the blocks within "radius", default 8, of the player). On every later run call scene_reset {"name": ${name}} instead, so each run starts from the same state.`,
        '3. game_events {"since": "now"} and keep its `next` cursor, then exercise the feature: player_act (walk, look, attack, use items, mine) or game_command for what the player would do.',
        '4. Check the outcome: wait_until {"condition": {...}, "timeoutMs": …} for the condition the feature should cause (kind entity, block, score, event with "since": <cursor>, log, player or ticks); game_events {"since": <cursor>} for the in-world events it fired; game_query for entities, blocks, components, dynamic properties or scores.',
        "5. game_log: fix every content-log entry and script error by file and line, game_reload, then repeat from step 2.",
        "6. game_screenshot to show the final state.",
        "Report what the feature did, the checks that passed or failed, and the screenshot path.",
      ]);
    },
  );

  server.registerPrompt(
    "test_on_server",
    {
      title: "Test on a dedicated server",
      description:
        "Load a project on a disposable Bedrock Dedicated Server, run its GameTests and profile slow scripts. Needs the toolset bds.",
      argsSchema: { project },
    },
    ({ project }) => {
      const path = JSON.stringify(project);
      return userText([
        `Test the add-on at ${project} on a Bedrock Dedicated Server.`,
        "",
        `1. bds_check {"path": ${path}}: fix every content-log or console error by file and line, then call it again until it reports none.`,
        `2. gametest_run {"path": ${path}}: for each failed test, fix the cause at the reported file and line and run it again.`,
        `3. If a script is slow: bds_session_start {"path": ${path}} and note its \`id\`, then script_profile {"id": <id>, "command": <a command that triggers the slow code>} and fix the functions with the most self time. After an edit, bds_session_command {"id": <id>, "command": "reload"} and profile again.`,
        '4. bds_session_stop {"id": <id>} when done, even after a failure.',
        "Report the test results and the profile before and after any fix.",
      ]);
    },
  );

  server.registerPrompt(
    "new_content",
    {
      title: "Write new add-on content",
      description:
        "Write new content (an entity, item, block, script …) from the versioned docs and vanilla examples, then validate it and load it on a server. " +
        "Needs the toolsets knowledge, validate and bds.",
      argsSchema: { project, what: z.string().describe("the content to write, in words") },
    },
    ({ project, what }) => {
      const path = JSON.stringify(project);
      return userText([
        `Add this to the add-on at ${project}: ${what}`,
        "",
        "1. Look everything up before writing, never from memory: docs_search {\"query\": …} for the guide, component_lookup {\"id\": …} for each component, api_lookup {\"symbol\": …} for each Script API member, vanilla_example {\"identifier\": …} for real uses in Mojang's packs.",
        "2. Write the files in the project's packs, using the format_version and module versions the lookups name.",
        '3. validate_file {"path": <file>} for each file written; fix every error by line.',
        `4. pack_fix_versions {"path": ${path}}: a dry run (no "apply"). If it proposes version changes the new content needs, call it again with "apply": true.`,
        `5. validate_pack {"path": ${path}} until it reports no errors.`,
        `6. bds_check {"path": ${path}}: fix every content-log error by file and line, repeating from step 5.`,
        "Report the files written and the final validate_pack and bds_check results.",
      ]);
    },
  );
}
