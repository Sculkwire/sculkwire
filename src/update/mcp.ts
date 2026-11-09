import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeVersion, versionInfo } from "./auto.ts";
import { CHANNELS } from "./install.ts";

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
      outputSchema: {
        version: z.string(),
        channel: z.enum(CHANNELS),
        managed: z.boolean(),
        root: z.string(),
        running: z.string().optional(),
        current: z.string().optional(),
        latest: z.string().optional(),
        updateReady: z.boolean().optional(),
        lastCheck: z.string().optional(),
        lastError: z.string().optional(),
      },
    },
    async () => {
      const info = await versionInfo();
      return { content: [{ type: "text", text: describeVersion(info) }], structuredContent: { ...info } };
    },
  );
}
