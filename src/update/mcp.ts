import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeVersion, type VersionInfo, versionInfo } from "./auto.ts";
import { UPDATE_CHANNELS } from "./config.ts";

const versionShape = {
  version: z.string(),
  channel: z.enum(UPDATE_CHANNELS),
  managed: z.boolean(),
  root: z.string(),
  running: z.string().optional(),
  current: z.string().optional(),
  latest: z.string().optional(),
  updateReady: z.boolean().optional(),
  lastCheck: z.string().optional(),
  lastError: z.string().optional(),
};
// The tool returns a `VersionInfo`: the compiler keeps the schema and the type in step.
z.object(versionShape) satisfies z.ZodType<VersionInfo>;

export function register(server: McpServer): void {
  server.registerTool(
    "sculkwire_version",
    {
      title: "sculkwire version",
      description:
        "Report the running sculkwire version, the update channel, whether it runs from a managed install (updated " +
        "automatically, at most once a day) or a development checkout, the newest version seen and whether an " +
        "installed update waits for the next session. Does not contact the network.",
      inputSchema: {},
      outputSchema: versionShape,
    },
    async () => {
      const info = await versionInfo();
      return { content: [{ type: "text", text: describeVersion(info) }], structuredContent: { ...info } };
    },
  );
}
