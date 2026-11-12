/** A tiny hand-written tree in the rockide/schemas layout (no real rockide file is used), for knowledge and validator tests. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Entity schemas of the tree, relative to its root. */
export const E = "schema/bedrock/server/entity";

/**
 * Writes the tree into `dir`: `scripts/compile.ts` routing entities and loot tables, entity format_versions 1.21.0 and
 * 1.26.0 (health, behavior.tempt), loot conditions shaped like rockide's, and an inline block component.
 */
export function writeRockideTree(dir: string): void {
  const put = (rel: string, content: object | string): void => {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  };
  put(
    "scripts/compile.ts",
    `const BP_ENTRIES: JsonValidationEntry[] = [
\t{
\t\tfileMatch: ["entities/**/*.json"],
\t\turl: "./schema/bedrock/server/entity/_index.json",
\t},
\t{
\t\tfileMatch: ["loot_tables/**/*.json"],
\t\turl: "./schema/bedrock/server/loot_table/_index.json",
\t},
];
`,
  );
  // Loot conditions shaped like rockide's: match_tool fields nested under `match_tool`, ranges as {min, max}.
  put("schema/bedrock/server/loot_table/_index.json", {
    type: "object",
    properties: { pools: { type: "array", items: { type: "object", properties: { conditions: { type: "array", items: { $ref: "./condition.json" } } } } } },
  });
  put("schema/bedrock/server/loot_table/condition.json", {
    type: "object",
    required: ["condition"],
    unevaluatedProperties: false,
    properties: { condition: { type: "string" } },
    allOf: [
      {
        if: { properties: { condition: { const: "match_tool" } }, required: ["condition"] },
        then: { properties: { condition: true, match_tool: { $ref: "#/$defs/match_tool" } }, additionalProperties: false, required: ["condition", "match_tool"] },
      },
    ],
    $defs: {
      match_tool: {
        type: "object",
        additionalProperties: false,
        properties: { count: { $ref: "#/$defs/range" }, enchantments: { type: "array", items: { $ref: "#/$defs/enchantment_spec" } } },
      },
      enchantment_spec: { type: "object", additionalProperties: false, properties: { enchantment: { type: "string" }, levels: { $ref: "#/$defs/range" } } },
      range: { type: "object", required: ["min", "max"], additionalProperties: false, properties: { min: { type: "integer" }, max: { type: "integer" } } },
    },
  });
  put(`${E}/_index.json`, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["format_version"],
    properties: { format_version: { enum: ["1.21.0", "1.26.0"] } },
    allOf: [
      { if: { properties: { format_version: { const: "1.21.0" } } }, then: { $ref: "./1.21.0/_index.json" } },
      { if: { properties: { format_version: { const: "1.26.0" } } }, then: { $ref: "./1.26.0/_index.json" } },
    ],
  });
  for (const v of ["1.21.0", "1.26.0"]) {
    put(`${E}/${v}/_index.json`, {
      type: "object",
      properties: {
        format_version: { type: "string" },
        "minecraft:entity": {
          type: "object",
          properties: {
            components: { type: "object", unevaluatedProperties: false, allOf: [{ $ref: "./components/_index.json" }, { $ref: "./behaviors/_index.json" }] },
          },
        },
      },
    });
  }
  put(`${E}/1.21.0/components/_index.json`, { type: "object", properties: { "minecraft:health": { $ref: "./health.json" } } });
  put(`${E}/1.21.0/behaviors/_index.json`, { type: "object", properties: {} });
  put(`${E}/1.21.0/components/health.json`, {
    type: "object",
    description: "Health v1",
    additionalProperties: false,
    properties: { value: { type: "integer", default: 10, description: "Hit points" } },
  });
  put(`${E}/1.26.0/components/_index.json`, { type: "object", properties: { "minecraft:health": { $ref: "./health.json" } } });
  put(`${E}/1.26.0/components/health.json`, {
    type: "object",
    description: "Health v2",
    additionalProperties: false,
    properties: { value: { anyOf: [{ type: "integer" }, { type: "object", properties: { range_min: { type: "integer" } } }] }, max: { type: "integer", minimum: 1 } },
  });
  put(`${E}/1.26.0/behaviors/_index.json`, { type: "object", properties: { "minecraft:behavior.tempt": { $ref: "./behavior.tempt.json" } } });
  put(`${E}/1.26.0/behaviors/behavior.tempt.json`, {
    type: "object",
    description: "Tempted by items",
    required: ["priority"],
    properties: {
      priority: { type: "integer", minimum: 0 },
      speed_multiplier: { type: "number", default: 1, description: "Speed while tempted" },
      control_flags: { type: "array", items: { type: "string", anyOf: [{ enum: ["move", "look"] }, { pattern: "^(?:MOVE|LOOK)$" }] } },
      look_mode: { anyOf: [{ enum: ["near", "far"] }, { pattern: "^(?:NEAR|FAR)$" }] },
      sound_interval: { type: "object", properties: { min: { type: "number" }, max: { type: "number" } } },
    },
  });
  // Block components: an inline definition in the index.
  put("schema/bedrock/server/block/1.26.0/components/_index.json", {
    type: "object",
    properties: {
      "minecraft:collision_box": { description: "Collision box", oneOf: [{ type: "boolean" }, { type: "object", properties: { origin: { type: "array" }, size: { type: "array" } } }] },
    },
  });
}
