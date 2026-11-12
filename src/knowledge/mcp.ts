/** MCP tools over the versioned knowledge layer. Every result names the `{channel, version}` it came from. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok } from "../core/mcp.ts";
import { searchChangelogs } from "./changelog.ts";
import { DOCS_ATTRIBUTION, searchDocs } from "./docs.ts";
import { commandLookup, componentLookup, molangLookup, vanillaExample } from "./lookups.ts";
import { formatRockide } from "./rockide.ts";
import { apiLookup } from "./scriptapi.ts";
import { formatSources, sourceStatus } from "./store.ts";
import { getPins, updatePins } from "./versions.ts";

const channel = z
  .enum(["stable", "preview"])
  .default("stable")
  .describe("Release channel; results are tagged with the exact build they describe");
const offline = z.boolean().default(false).describe("Answer from cache only, never fetch");
const anyRecord = z.record(z.string(), z.unknown());

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function register(server: McpServer): void {
  server.registerTool(
    "knowledge_versions",
    {
      title: "Knowledge versions",
      description:
        "Current stable and preview Minecraft Bedrock builds as pinned by sculkwire: bedrock-samples tag, BDS build, " +
        "@minecraft/* npm versions per channel (plain and beta) and the newest changelog, plus every external data source " +
        "(version in use, newest seen upstream, last check). Sources update on their own (checked at most daily). " +
        "Fetches pins on first use.",
      inputSchema: { refresh: z.boolean().default(false).describe("Re-resolve the pins from upstream now") },
      outputSchema: {
        updatedAt: z.string(),
        stable: anyRecord,
        preview: anyRecord,
        sources: z
          .array(
            z.object({
              source: z.string(),
              channel: z.enum(["stable", "preview"]).optional(),
              inUse: z.string().optional().describe("version in use (cached copy)"),
              latest: z.string().optional().describe("newest version seen upstream"),
              checkedAt: z.string().optional().describe("last upstream check"),
              note: z.string().optional(),
            }),
          )
          .describe("every external data source"),
      },
    },
    async ({ refresh }) => {
      const pins = refresh ? await updatePins() : await getPins();
      const sources = await sourceStatus(pins);
      const s = pins.channels.stable;
      const p = pins.channels.preview;
      return ok(
        [
          `stable ${s.version} (samples ${s.samples.tag}${s.bds ? `, BDS ${s.bds.version}` : ""}); ` +
            `preview ${p.version} (samples ${p.samples.tag}${p.bds ? `, BDS ${p.bds.version}` : ""}); pinned ${pins.updatedAt}`,
          ...formatSources(sources),
        ].join("\n"),
        { updatedAt: pins.updatedAt, stable: { ...s }, preview: { ...p }, sources: sources.map((x) => ({ ...x })) },
      );
    },
  );

  server.registerTool(
    "docs_search",
    {
      title: "Search creator docs",
      description:
        "Full-text search (BM25, identifier-aware: `minecraft:behavior.tempt`, `getComponent`) over Microsoft Learn " +
        "Minecraft Creator docs for the channel. Returns page title, heading, Learn URL and matching lines. " +
        "Docs are CC-BY-4.0; cite the URL.",
      inputSchema: {
        query: z.string().min(1),
        channel,
        limit: z.number().int().min(1).max(30).default(8),
        pathPrefix: z.string().optional().describe("Restrict to a docs subtree, e.g. `creator/ScriptAPI`"),
        offline,
      },
      outputSchema: {
        channel: z.string(),
        version: z.string(),
        docsVersion: z.string(),
        attribution: z.string(),
        query: z.string(),
        hits: z.array(
          z.object({
            title: z.string(),
            heading: z.string(),
            path: z.string(),
            url: z.string(),
            score: z.number(),
            excerpt: z.string(),
          }),
        ),
      },
    },
    async (args) => {
      const r = await searchDocs(args);
      const lines = r.hits.map((h) => `- ${h.title}${h.heading ? ` › ${h.heading}` : ""} ${h.url}`);
      return ok(
        `${plural(r.hits.length, "hit")} in creator docs (${r.channel} ${r.docsVersion}). ${DOCS_ATTRIBUTION}\n${lines.join("\n")}`,
        { ...r },
      );
    },
  );

  server.registerTool(
    "api_lookup",
    {
      title: "Script API lookup",
      description:
        "Exact Script API symbol lookup from the channel's @minecraft/* typings: `Entity.applyDamage`, `Entity`, " +
        "`applyDamage`, `world.getDimension`, `@minecraft/server-ui:ActionFormData.button`. Returns signature, docs, " +
        "params, throws, privileges, beta flag, the module version that introduced it (engine metadata), and for " +
        "classes the member list. Inherited members resolve through base classes.",
      inputSchema: {
        symbol: z.string().min(1),
        channel,
        module: z.string().optional().describe("Restrict to a module, e.g. `@minecraft/server`"),
        limit: z.number().int().min(1).max(50).default(10),
        offline,
      },
      outputSchema: {
        channel: z.string(),
        version: z.string(),
        samplesTag: z.string(),
        query: z.string(),
        entries: z.array(
          z.object({
            module: z.string(),
            npmVersion: z.string(),
            name: z.string(),
            kind: z.string(),
            signature: z.string(),
            summary: z.string(),
            beta: z.boolean(),
            since: z.string().optional(),
            inheritedFrom: z.string().optional(),
            deprecated: z.string().optional(),
            params: z.array(z.object({ name: z.string(), text: z.string() })),
            returns: z.string().optional(),
            throws: z.array(z.string()),
            privileges: z.array(z.string()),
            examples: z.array(z.object({ title: z.string(), code: z.string() })),
            members: z
              .array(z.object({ name: z.string(), kind: z.string(), signature: z.string(), beta: z.boolean() }))
              .optional(),
          }),
        ),
        suggestions: z.array(z.string()),
      },
    },
    async ({ symbol, ...rest }) => {
      const r = await apiLookup({ query: symbol, ...rest });
      const head = `${r.channel} ${r.version} (metadata ${r.samplesTag})`;
      if (!r.entries.length) {
        return ok(`no Script API symbol "${symbol}" in ${head}. Near: ${r.suggestions.join(", ") || "none"}`, { ...r });
      }
      const lines = r.entries.map(
        (e) =>
          `- ${e.module}@${e.npmVersion} ${e.kind} ${e.name}${e.beta ? " [beta]" : ""}${e.since ? ` since ${e.since}` : ""}` +
          `${e.inheritedFrom ? ` (inherited from ${e.inheritedFrom})` : ""}\n  ${e.signature}${e.summary ? `\n  ${e.summary.split("\n")[0]}` : ""}`,
      );
      return ok(`${head}\n${lines.join("\n")}`, { ...r });
    },
  );

  server.registerTool(
    "command_lookup",
    {
      title: "Command lookup",
      description:
        "Slash command syntax from engine metadata (bedrock-samples command_modules): overloads, parameter types, " +
        "enum values, permission level, cheats requirement.",
      inputSchema: { name: z.string().min(1).describe("Command name or alias, with or without `/`"), channel, offline },
      outputSchema: {
        channel: z.string(),
        version: z.string(),
        samplesTag: z.string(),
        query: z.string(),
        commands: z.array(anyRecord),
        suggestions: z.array(z.string()),
      },
    },
    async (args) => {
      const r = await commandLookup(args);
      const lines = r.commands.flatMap((c) => [`/${c.name}: ${c.description}`, ...c.overloads.map((o) => `  ${o.syntax}`)]);
      return ok(
        lines.length
          ? `${r.channel} ${r.version}\n${lines.join("\n")}`
          : `no command "${args.name}" in ${r.channel} ${r.version}. Near: ${r.suggestions.join(", ") || "none"}`,
        { ...r, commands: r.commands.map((c) => ({ ...c })) },
      );
    },
  );

  server.registerTool(
    "molang_lookup",
    {
      title: "Molang lookup",
      description:
        "Molang query and math function reference from engine metadata: description, argument counts, return type, " +
        "query sets and version ranges. Accepts `query.is_baby`, `q.is_baby`, `is_baby`, `math.lerp`.",
      inputSchema: { name: z.string().min(1), channel, limit: z.number().int().min(1).max(100).default(20), offline },
      outputSchema: {
        channel: z.string(),
        version: z.string(),
        samplesTag: z.string(),
        query: z.string(),
        exact: z.boolean(),
        entries: z.array(anyRecord),
      },
    },
    async (args) => {
      const r = await molangLookup(args);
      const lines = r.entries.map((e) => `- ${e.name}: ${e.description}`);
      return ok(
        `${r.exact ? "" : "no exact match; "}${plural(r.entries.length, "entry")} (${r.channel} ${r.version})\n${lines.join("\n")}`,
        { ...r, entries: r.entries.map((e) => ({ ...e })) },
      );
    },
  );

  server.registerTool(
    "component_lookup",
    {
      title: "Component lookup",
      description:
        "Component reference for an id like `minecraft:behavior.tempt` or `minecraft:geometry`: engine documentation " +
        "(doc_modules) with every property's type/default/description, the engine JSON schemas per format_version, " +
        "the rockide/schemas definition (description, properties, types, defaults, enums) per scope at the " +
        "format_version matching the channel's game version, with the other versions listed. rockide/schemas follows " +
        "its newest GitHub release (checked at most daily) and is skipped when unavailable.",
      inputSchema: { id: z.string().min(1), channel, offline },
      outputSchema: {
        channel: z.string(),
        version: z.string(),
        samplesTag: z.string(),
        id: z.string(),
        docs: z.array(anyRecord),
        engineSchemas: z.array(anyRecord),
        rockide: z.object({
          repo: z.string(),
          release: z.string().optional().describe("rockide/schemas release tag in use"),
          commit: z.string().optional(),
          latest: z.string().optional().describe("newest release seen upstream"),
          root: z.string().optional(),
          gameVersion: z.string().describe("game version the selection targets"),
          matches: z
            .array(
              z.object({
                scope: z.string().describe("server/entity/behaviors, server/block/components, ..."),
                formatVersions: z.array(z.string()),
                selectedVersion: z.string(),
                newerThanGame: z.boolean().optional(),
                file: z.string(),
                title: z.string().optional(),
                description: z.string().optional(),
                type: z.string().optional(),
                properties: z.array(anyRecord).describe("name, type, description, default, enum, minimum, maximum, required, deprecated, properties"),
                changes: z.array(z.object({ formatVersion: z.string(), file: z.string() })),
              }),
            )
            .describe("one entry per scope that defines the component"),
          note: z.string().optional().describe("why there are no rockide results, or that the cached copy is stale"),
        }),
        suggestions: z.array(z.string()),
      },
    },
    async (args) => {
      const r = await componentLookup(args);
      const doc = r.docs[0];
      const schemaDesc = r.rockide.matches[0]?.description ?? r.engineSchemas[0]?.description;
      const head = doc
        ? `${r.id} (${doc.module}: ${doc.section}) ${r.channel} ${r.version}\n${doc.description}\n` +
          doc.properties.map((p) => `- ${p.name}${p.type ? ` (${p.type})` : ""}${p.default !== undefined ? ` = ${p.default}` : ""}`).join("\n")
        : schemaDesc
          ? `${r.id} ${r.channel} ${r.version}\n${schemaDesc}`
          : r.rockide.matches.length
            ? `${r.id} ${r.channel} ${r.version}`
            : `no component "${r.id}" in ${r.channel} ${r.version}. Near: ${r.suggestions.join(", ") || "none"}`;
      const text = [head, ...formatRockide(r.rockide)].join("\n");
      return ok(text, {
        ...r,
        docs: r.docs.map((d) => ({ ...d })),
        engineSchemas: r.engineSchemas.map((d) => ({ ...d })),
        rockide: { ...r.rockide, matches: r.rockide.matches.map((m) => ({ ...m, properties: m.properties.map((p) => ({ ...p })) })) },
      });
    },
  );

  server.registerTool(
    "vanilla_example",
    {
      title: "Vanilla usage examples",
      description:
        "Find real uses of an identifier (component, entity, item, block, event, texture key) in Mojang's vanilla " +
        "behavior/resource packs for the channel. Returns file paths, line numbers and excerpts (component keys " +
        "first), plus matching vanilla data ids (block states, raw ids).",
      inputSchema: {
        identifier: z.string().min(1),
        channel,
        pack: z.enum(["behavior", "resource", "both"]).default("both"),
        limit: z.number().int().min(1).max(50).default(8),
        offline,
      },
      outputSchema: {
        channel: z.string(),
        version: z.string(),
        samplesTag: z.string(),
        identifier: z.string(),
        ids: z.array(anyRecord),
        examples: z.array(z.object({ file: z.string(), line: z.number(), asKey: z.boolean(), excerpt: z.string() })),
        totalFiles: z.number(),
      },
    },
    async (args) => {
      const r = await vanillaExample(args);
      const lines = r.examples.map((e) => `- ${e.file}:${e.line}`);
      return ok(
        `${r.identifier} appears in ${plural(r.totalFiles, "vanilla file")} (${r.channel} ${r.version})\n${lines.join("\n")}`,
        { ...r, ids: r.ids.map((i) => ({ ...i })) },
      );
    },
  );

  server.registerTool(
    "changelog_search",
    {
      title: "Changelog search",
      description:
        "Search official Bedrock changelogs (release changelogs for stable, Beta & Preview for preview). Each hit has " +
        "the article title, game version, date, URL, section and matching lines. Give `from`/`to` to ask what changed " +
        "between two versions (from exclusive, to inclusive; `1.26.60` covers its previews and hotfixes); with an " +
        "empty query that lists the articles in the range.",
      inputSchema: {
        query: z.string().default("").describe("Keyword or symbol; may be empty when from/to are given"),
        channel,
        from: z.string().optional().describe("Exclusive lower game version, e.g. 1.26.50"),
        to: z.string().optional().describe("Inclusive upper game version, e.g. 1.26.60"),
        limit: z.number().int().min(1).max(50).default(10),
        offline,
      },
      outputSchema: {
        channel: z.string(),
        version: z.string(),
        query: z.string(),
        from: z.string().optional(),
        to: z.string().optional(),
        hits: z.array(
          z.object({
            title: z.string(),
            version: z.string(),
            date: z.string(),
            url: z.string(),
            heading: z.string(),
            excerpt: z.string(),
            score: z.number().optional(),
          }),
        ),
        articles: z
          .array(z.object({ title: z.string(), version: z.string(), date: z.string(), url: z.string() }))
          .optional(),
      },
    },
    async (args) => {
      if (!args.query.trim() && !args.from && !args.to) throw new Error("give a query, or from/to versions");
      const r = await searchChangelogs(args);
      const lines = r.hits.map((h) => `- ${h.date.slice(0, 10)} ${h.title} (${h.version})${h.heading ? ` › ${h.heading}` : ""}`);
      const range = r.articles ? ` across ${plural(r.articles.length, "article")} in range` : "";
      const listed =
        !r.hits.length && r.articles
          ? r.articles.map((a) => `- ${a.date.slice(0, 10)} ${a.title} (${a.version}) ${a.url}`)
          : lines;
      return ok(`${plural(r.hits.length, "hit")}${range} (${r.channel} changelogs up to ${r.version})\n${listed.join("\n")}`, {
        ...r,
      });
    },
  );

  server.registerResource(
    "knowledge-versions",
    "sculkwire://knowledge/versions",
    {
      title: "Pinned Bedrock versions",
      description: "Stable and preview builds, samples tags, BDS builds and npm versions sculkwire's knowledge uses",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await getPins(), null, 2) }],
    }),
  );
}
