import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kevStartCommand } from "./client.ts";
import { configPath, decisionStatus, PROVIDERS, saveDecisionConfig, type DecisionConfig, type DecisionStatus, type ModelProvider } from "./config.ts";

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const SETUP_HINT = "Run `sculk setup` in a terminal to choose one (Jev through OpenRouter or ZenMux, or Kev served locally)";

export type SetupOutcome =
  | { saved: true; config: DecisionConfig; path: string }
  | { saved: false; reason: "unsupported" | "declined" | "none" | "needs_key"; message: string };

/**
 * Ask the user through MCP elicitation for a provider (and the URL for local Kev), then save the config. Cloud keys
 * are never asked for here. Returns why nothing was saved when the client cannot elicit, the user declined, chose no
 * decision model, or chose a cloud provider whose key variable is not set.
 */
export async function elicitDecisionSetup(server: McpServer): Promise<SetupOutcome> {
  if (!server.server.getClientCapabilities()?.elicitation) {
    return { saved: false, reason: "unsupported", message: `No decision model is configured and this MCP client cannot ask for one. ${SETUP_HINT}.` };
  }
  const first = await server.server.elicitInput({
    message:
      "sculkwire needs a decision model for this. Jev answers in about 0.1 s through OpenRouter or ZenMux and accepts " +
      "screenshots (paid per input token). Kev runs on your own GPU, text only. The choice is saved in " +
      `${configPath()}.`,
    requestedSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          title: "Decision model",
          oneOf: [
            { const: "openrouter", title: PROVIDERS.openrouter.title },
            { const: "zenmux", title: PROVIDERS.zenmux.title },
            { const: "local", title: `${PROVIDERS.local.title} (${PROVIDERS.local.baseUrl})` },
            { const: "none", title: "None" },
          ],
        },
      },
      required: ["provider"],
    },
  });
  if (first.action !== "accept") return { saved: false, reason: "declined", message: `Decision model setup was ${first.action === "decline" ? "declined" : "cancelled"}. ${SETUP_HINT}.` };
  const choice = first.content?.provider;
  if (choice !== "openrouter" && choice !== "zenmux" && choice !== "local") {
    return { saved: false, reason: "none", message: `No decision model chosen. ${SETUP_HINT}.` };
  }
  const provider: ModelProvider = choice;
  const info = PROVIDERS[provider];
  if (provider !== "local") {
    // The MCP spec forbids asking for secrets through form elicitation, so a cloud key comes from the environment or
    // from `sculk setup` in a terminal. The provider choice alone is saved; the loader reads the key from the env.
    if (!info.keyEnv || !process.env[info.keyEnv]?.trim()) {
      return {
        saved: false,
        reason: "needs_key",
        message:
          `${info.title} needs an API key (${info.keyUrl}). Set ${info.keyEnv} in the environment sculkwire runs in, ` +
          `or run \`sculk setup\` in a terminal, which saves the key in ${configPath()}, readable only by your user account.`,
      };
    }
    const config: DecisionConfig = { provider };
    return { saved: true, config, path: await saveDecisionConfig(config) };
  }
  const second = await server.server.elicitInput({
    message: `URL of the local Kev server. Start one with: ${kevStartCommand()}`,
    requestedSchema: {
      type: "object",
      properties: { baseUrl: { type: "string", title: "Server URL", format: "uri", default: info.baseUrl } },
      required: ["baseUrl"],
    },
  });
  if (second.action !== "accept") return { saved: false, reason: "declined", message: `Decision model setup was ${second.action === "decline" ? "declined" : "cancelled"}. ${SETUP_HINT}.` };
  const value = second.content?.baseUrl;
  if (typeof value !== "string" || !value.trim()) return { saved: false, reason: "declined", message: `No URL given. ${SETUP_HINT}.` };
  const config: DecisionConfig = { provider, baseUrl: value.trim() };
  const path = await saveDecisionConfig(config);
  return { saved: true, config, path };
}

function statusText(s: DecisionStatus): string {
  if (s.provider === "none" || !s.configured) return s.error ?? "No decision model configured.";
  const head = `${s.provider} ${s.model} at ${s.baseUrl}, images ${s.images ? "supported" : "not supported"}`;
  return s.reachable ? `${head}. Reachable, probe answered in ${s.latencyMs} ms.` : `${head}. Not reachable: ${s.error}`;
}

export function register(server: McpServer): void {
  server.registerTool(
    "decision_status",
    {
      title: "Decision model status",
      description:
        "Report the optional decision model that `player_act play` uses (Jev through OpenRouter or ZenMux, or Kev served " +
        "locally): provider, model, whether it answers, the latency of one tiny probe and whether it accepts images. " +
        "When none is configured and the client supports elicitation, asks for the provider (never an API key) and saves " +
        "it. Only player_act play and the game_launch sign-in recovery use one, as an optional advisor.",
      inputSchema: {
        probe: z.boolean().optional().describe("Send one tiny question to measure reachability and latency (default true)"),
        setup: z.boolean().optional().describe("Ask the user for a model when none is configured (default true)"),
      },
      outputSchema: {
        provider: z.enum(["none", "openrouter", "zenmux", "local"]),
        model: z.string().optional(),
        baseUrl: z.string().optional(),
        source: z.enum(["env", "file", "default"]),
        configPath: z.string(),
        configured: z.boolean(),
        reachable: z.boolean(),
        latencyMs: z.number().optional(),
        images: z.boolean(),
        error: z.string().optional(),
        setup: z.string().optional().describe("What happened when sculkwire asked for a model"),
      },
    },
    async ({ probe, setup }): Promise<ToolResult> => {
      let status = await decisionStatus({ probe });
      let setupNote: string | undefined;
      if (!status.configured && setup !== false) {
        try {
          const outcome = await elicitDecisionSetup(server);
          setupNote = outcome.saved ? `Saved ${outcome.config.provider} in ${outcome.path}.` : outcome.reason === "unsupported" ? undefined : outcome.message;
          if (outcome.saved) status = await decisionStatus({ probe });
        } catch (err) {
          setupNote = `Asking for a decision model failed: ${err instanceof Error ? err.message : String(err)}. ${SETUP_HINT}.`;
        }
      }
      const text = [setupNote, statusText(status)].filter(Boolean).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { ...status, ...(setupNote ? { setup: setupNote } : {}) } };
    },
  );
}
