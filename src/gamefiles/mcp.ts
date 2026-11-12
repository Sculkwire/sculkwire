/**
 * MCP tools over an installed PC (GDK) copy of the game: which builds are installed, the per-version vanilla packs
 * they ship, and those packs unpacked from `.brarchive` into plain folders.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail } from "../core/mcp.ts";
import { detectBuilds, gameDirCandidates, type GameBuild, noBuildMessage, requireBuild } from "./detect.ts";
import { DEFAULT_PACK_KIND, extractPack, findPack, listPacks, listVanillaPacks, PACK_KINDS, type PackInfo, type PackKind } from "./extract.ts";

const kindSchema = z.enum(PACK_KINDS as [PackKind, ...PackKind[]]);
const buildSelector = z
  .string()
  .optional()
  .describe("Build key, game version (1.21.120.1) or game directory; default: first detected build");

const buildShape = z.object({
  root: z.string(),
  key: z.string(),
  version: z.string().optional(),
  appxVersion: z.string().optional(),
  packageName: z.string().optional(),
  packRoots: z.object({ behavior: z.string().optional(), resource: z.string().optional() }),
}) satisfies z.ZodType<GameBuild>;

const packShape = z.object({
  kind: kindSchema,
  name: z.string(),
  family: z.string(),
  baseGameVersion: z.string().optional(),
  archives: z.number(),
  dir: z.string(),
}) satisfies z.ZodType<PackInfo>;

export function register(server: McpServer): void {
  server.registerTool(
    "game_builds",
    {
      title: "Installed game builds",
      description:
        "Detect installed PC (GDK) copies of Minecraft Bedrock (the Xbox app install on Windows, mcbe-gdk-linux on " +
        "Linux, plus SCULKWIRE_GAME_DIRS) and read each one's game version from its appxmanifest.xml, and where its " +
        "behavior and resource packs live. Use it to know which game version your add-on is tested against. Local only.",
      inputSchema: { gameDir: z.string().optional().describe("Inspect only this game directory") },
      outputSchema: { builds: z.array(buildShape), searched: z.array(z.string()) },
    },
    async ({ gameDir }) => {
      const searched = gameDir ? [gameDir] : gameDirCandidates();
      const builds = detectBuilds(searched);
      const text = builds.length === 0 ? noBuildMessage(undefined, searched) : builds.map((b) => `${b.version ?? "version unknown"} (${b.root})`).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { builds, searched } };
    },
  );

  server.registerTool(
    "game_vanilla_packs",
    {
      title: "Versioned vanilla packs",
      description:
        "List the per-version base-game packs (vanilla_1.14 ... vanilla_<latest>) an installed PC (GDK) copy of the " +
        "game ships, for behavior and resource packs. These are the packs a world's base_game_version pins, and the " +
        "public samples repo keeps only the latest one. `all` lists every pack. Unpack one with game_extract_pack.",
      inputSchema: {
        build: buildSelector,
        kind: kindSchema.optional().describe("Only behavior or resource packs"),
        all: z.boolean().optional().describe("Include every pack, not just versioned vanilla packs"),
      },
      outputSchema: { build: z.string(), version: z.string().optional(), packs: z.array(packShape) },
    },
    async ({ build: selector, kind, all }) => {
      let build: GameBuild;
      try {
        build = requireBuild(selector);
      } catch (err) {
        return fail(err);
      }
      const packs = (all ? listPacks(build) : listVanillaPacks(build)).filter((p) => !kind || p.kind === kind);
      const versions = packs.filter((p) => p.kind === "behavior" && p.baseGameVersion).map((p) => p.baseGameVersion);
      const text =
        `${packs.length} packs in build ${build.key}` +
        (versions.length ? ` (behavior vanilla ${versions[0]} .. ${versions[versions.length - 1]})` : "");
      const structured: { build: string; version?: string; packs: typeof packs } = { build: build.key, packs };
      if (build.version) structured.version = build.version;
      return { content: [{ type: "text", text }], structuredContent: structured };
    },
  );

  server.registerTool(
    "game_extract_pack",
    {
      title: "Extract a game pack",
      description:
        "Unpack one pack of an installed PC (GDK) copy of the game (e.g. behavior vanilla_1.21.0) into a plain " +
        "folder: its .brarchive containers are unpacked and merged with the loose files, so you can grep how vanilla " +
        "uses a component or diff your content against it. Returns the directory, by default under the sculkwire " +
        "cache. Reuses a previous extraction of the same build unless force. Archives that cannot be read are listed " +
        "in failures.",
      inputSchema: {
        pack: z.string().describe("Pack directory name, e.g. vanilla_1.21.0 or vanilla"),
        kind: kindSchema.optional().describe("behavior (default) or resource"),
        build: buildSelector,
        out: z.string().optional().describe("Target directory (must be empty or a previous extraction)"),
        force: z.boolean().optional(),
      },
      outputSchema: {
        kind: kindSchema,
        pack: z.string(),
        out: z.string(),
        looseFiles: z.number(),
        archives: z.number(),
        archiveEntries: z.number(),
        placeholders: z.number().describe("Zero-size archive entries backed by a loose file"),
        emptyEntries: z.number(),
        failures: z.array(z.object({ archive: z.string(), reason: z.string(), detail: z.string() })),
        cached: z.boolean(),
      },
    },
    async ({ pack, kind = DEFAULT_PACK_KIND, build: selector, out, force }) => {
      let result;
      try {
        const build = requireBuild(selector);
        const info = findPack(build, pack, kind);
        if (!info) return fail(`no ${kind} pack ${JSON.stringify(pack)} in build ${build.key}`);
        const options: { out?: string; force?: boolean } = {};
        if (out) options.out = out;
        if (force) options.force = force;
        result = await extractPack(build, info, options);
      } catch (err) {
        return fail(err);
      }
      const text =
        `${result.kind} ${result.pack} → ${result.out} (${result.looseFiles} loose, ${result.archiveEntries} archived` +
        `${result.failures.length ? `, ${result.failures.length} archive failures` : ""}${result.cached ? ", cached" : ""})`;
      return { content: [{ type: "text", text }], structuredContent: { ...result } };
    },
  );
}
