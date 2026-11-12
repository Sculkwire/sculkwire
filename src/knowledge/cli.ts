/** `sculk knowledge update|status`, `sculk docs|api|component|changelog <query>`. */
import { parseArgs } from "node:util";
import { type CliCommand, err, out } from "../core/cli.ts";
import { ExitCode } from "../core/diagnostic.ts";
import { errorMessage, UsageError } from "../core/errors.ts";
import { type Channel, CHANNELS, isChannel } from "../core/version.ts";
import { searchChangelogs } from "./changelog.ts";
import { DOCS_ATTRIBUTION, searchDocs } from "./docs.ts";
import { componentLookup } from "./lookups.ts";
import { formatRockide } from "./rockide.ts";
import { apiLookup } from "./scriptapi.ts";
import { formatSources, knowledgeStatus, updateKnowledge } from "./store.ts";

interface Parsed {
  positionals: string[];
  channel: Channel;
  json: boolean;
  offline: boolean;
  limit?: number;
  from?: string;
  to?: string;
  all: boolean;
}

function parse(args: string[], extra: { range?: boolean; channelAll?: boolean } = {}): Parsed {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      channel: { type: "string", short: "c", default: "stable" },
      json: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      limit: { type: "string", short: "n" },
      ...(extra.range ? { from: { type: "string" }, to: { type: "string" } } : {}),
    },
  });
  const channel = String(values.channel);
  const all = extra.channelAll === true && channel === "all";
  if (!all && !isChannel(channel)) throw new UsageError(`--channel must be stable or preview, got ${channel}`);
  const parsed: Parsed = {
    positionals,
    channel: all ? "stable" : (channel as Channel),
    json: values.json === true,
    offline: values.offline === true,
    all,
  };
  if (values.limit !== undefined) {
    const n = Number(values.limit);
    if (!Number.isInteger(n) || n < 1) throw new UsageError(`--limit must be a positive integer`);
    parsed.limit = n;
  }
  if (typeof values.from === "string") parsed.from = values.from;
  if (typeof values.to === "string") parsed.to = values.to;
  return parsed;
}

function emit(json: boolean, value: unknown, text: string): void {
  out(json ? JSON.stringify(value, null, 2) : text);
}

/** Wrap a command body: usage errors and failures map to exit code 2 with a message on stderr. */
function command(
  name: string,
  summary: string,
  usage: string,
  body: (args: string[]) => Promise<number>,
): CliCommand {
  return {
    name,
    summary,
    async run(args) {
      if (args.includes("-h") || args.includes("--help")) {
        out(`Usage: sculk ${name} ${usage}\n${summary}`);
        return ExitCode.ok;
      }
      try {
        return await body(args);
      } catch (e) {
        err(`sculk ${name}: ${errorMessage(e)}`);
        if (e instanceof UsageError) err(`Usage: sculk ${name} ${usage}`);
        return ExitCode.usage;
      }
    },
  };
}

const COMMON = "[--channel stable|preview] [--json] [--offline] [--limit N]";

function query(p: Parsed, what: string): string {
  const q = p.positionals.join(" ").trim();
  if (!q) throw new UsageError(`missing ${what}`);
  return q;
}

export const commands: CliCommand[] = [
  command(
    "knowledge update",
    "Re-resolve stable/preview versions and refresh samples, typings, docs, changelogs, rockide/schemas and installed BDS builds now (the MCP server also updates them on its own, at most daily)",
    "[--channel stable|preview|all] [--json]",
    async (args) => {
      const p = parse(args, { channelAll: true });
      const explicit = args.some((a) => a === "--channel" || a.startsWith("--channel=") || a === "-c");
      const channels = p.all || !explicit ? CHANNELS : [p.channel];
      const report = await updateKnowledge(channels);
      const failed = report.steps.filter((s) => !s.ok);
      const lines = [
        ...channels.map((c) => {
          const pin = report.pins.channels[c];
          return `${c}: ${pin.version} (samples ${pin.samples.tag}${pin.bds ? `, BDS ${pin.bds.version}` : ""}, @minecraft/server ${pin.npm["@minecraft/server"]?.default?.version ?? "?"} / beta ${pin.npm["@minecraft/server"]?.beta?.version ?? "?"})`;
        }),
        ...report.steps.map((s) => `  ${s.ok ? "ok  " : "FAIL"} ${s.channel} ${s.step}: ${s.detail}`),
      ];
      emit(p.json, report, lines.join("\n"));
      return failed.length ? ExitCode.findings : ExitCode.ok;
    },
  ),
  command("knowledge status", "Show pinned versions, what is cached, and per data source the version in use, the newest upstream and the last check", "[--json]", async (args) => {
    const p = parse(args);
    const status = await knowledgeStatus();
    const lines = [`cache: ${status.cacheDir}`, `pinned: ${status.updatedAt ?? "never (run sculk knowledge update)"}`];
    for (const c of status.channels) {
      lines.push(`${c.channel}: ${c.version ?? "unpinned"}`);
      if (c.pin) lines.push(`  samples pin ${c.pin.samples.tag}${c.pin.bds ? `, BDS ${c.pin.bds.version}` : ""}`);
      for (const s of c.samples) lines.push(`  samples ${s.tag}: ${s.cached ? (s.parts ?? []).join(", ") : "incomplete"}`);
      lines.push(`  docs: ${c.docs ? `${c.docs.docsVersion} @ ${c.docs.commit.slice(0, 10)}` : "not cached"}`);
      lines.push(`  changelogs: ${c.changelogs ?? "not cached"}`);
    }
    lines.push("sources (in use, newest upstream, last check):", ...formatSources(status.sources).map((l) => `  ${l}`));
    emit(p.json, status, lines.join("\n"));
    return ExitCode.ok;
  }),
  command("docs", "Search Microsoft Learn creator docs", `<query> ${COMMON}`, async (args) => {
    const p = parse(args);
    const r = await searchDocs({ query: query(p, "query"), channel: p.channel, limit: p.limit, offline: p.offline });
    const text = [
      `${r.channel} docs ${r.docsVersion}: ${r.hits.length} hits`,
      ...r.hits.map((h) => `\n## ${h.title}${h.heading ? ` › ${h.heading}` : ""}\n${h.url}\n${h.excerpt}`),
      `\n${DOCS_ATTRIBUTION}`,
    ].join("\n");
    emit(p.json, r, text);
    return r.hits.length ? ExitCode.ok : ExitCode.findings;
  }),
  command("api", "Look up a Script API symbol (Entity.applyDamage)", `<symbol> ${COMMON}`, async (args) => {
    const p = parse(args);
    const r = await apiLookup({ query: query(p, "symbol"), channel: p.channel, limit: p.limit, offline: p.offline });
    const text = r.entries.length
      ? [
          `${r.channel} ${r.version} (metadata ${r.samplesTag})`,
          ...r.entries.map((e) =>
            [
              `\n${e.module}@${e.npmVersion} ${e.kind} ${e.name}${e.beta ? " [beta]" : ""}${e.since ? ` (since ${e.since})` : ""}${e.inheritedFrom ? ` (inherited from ${e.inheritedFrom})` : ""}`,
              `  ${e.signature}`,
              e.summary ? `  ${e.summary.replace(/\n/g, "\n  ")}` : "",
              ...e.params.map((x) => `  @param ${x.name} ${x.text.replace(/\n/g, " ")}`),
              e.returns ? `  @returns ${e.returns.replace(/\n/g, " ")}` : "",
              ...(e.members ?? []).map((m) => `  - ${m.signature}${m.beta ? " [beta]" : ""}`),
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        ].join("\n")
      : `no symbol "${r.query}" in ${r.channel} ${r.version}; near: ${r.suggestions.join(", ") || "none"}`;
    emit(p.json, r, text);
    return r.entries.length ? ExitCode.ok : ExitCode.findings;
  }),
  command("component", "Look up a component (minecraft:behavior.tempt)", `<id> ${COMMON}`, async (args) => {
    const p = parse(args);
    const r = await componentLookup({ id: query(p, "component id"), channel: p.channel, offline: p.offline });
    const found = r.docs.length + r.engineSchemas.length + r.rockide.matches.length > 0;
    const lines = [`${r.id} — ${r.channel} ${r.version} (${r.samplesTag})`];
    for (const d of r.docs) {
      lines.push(`\n[${d.module}] ${d.section}\n${d.description}`);
      for (const prop of d.properties) {
        lines.push(
          `  - ${prop.name}${prop.type ? ` (${prop.type})` : ""}${prop.default !== undefined ? ` default ${prop.default}` : ""}${prop.description ? `: ${prop.description.replace(/\n/g, " ")}` : ""}`,
        );
      }
    }
    for (const s of r.engineSchemas) lines.push(`\nengine schema ${s.scope}: format_versions ${s.formatVersions.join(", ")} → ${s.latest}`);
    const rockide = formatRockide(r.rockide);
    if (rockide.length) lines.push("", ...rockide);
    if (!found) lines.push(`not found; near: ${r.suggestions.join(", ") || "none"}`);
    emit(p.json, r, lines.join("\n"));
    return found ? ExitCode.ok : ExitCode.findings;
  }),
  command(
    "changelog",
    "Search Bedrock changelogs; --from/--to for what changed between versions",
    `[query] ${COMMON} [--from X] [--to Y]`,
    async (args) => {
      const p = parse(args, { range: true });
      const q = p.positionals.join(" ").trim();
      if (!q && !p.from && !p.to) throw new UsageError("give a query, or --from/--to versions");
      const r = await searchChangelogs({
        channel: p.channel,
        query: q,
        from: p.from,
        to: p.to,
        limit: p.limit,
        offline: p.offline,
      });
      const lines = [`${r.channel} changelogs (newest ${r.version})`];
      if (r.articles) {
        lines.push(`${r.articles.length} articles in range:`);
        for (const a of r.articles) lines.push(`  ${a.date.slice(0, 10)} ${a.version} ${a.title} ${a.url}`);
      }
      for (const h of r.hits) {
        lines.push(`\n## ${h.date.slice(0, 10)} ${h.title} (${h.version})${h.heading ? ` › ${h.heading}` : ""}\n${h.url}\n${h.excerpt}`);
      }
      emit(p.json, r, lines.join("\n"));
      return r.hits.length || r.articles?.length ? ExitCode.ok : ExitCode.findings;
    },
  ),
];
