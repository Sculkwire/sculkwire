import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatDiagnostic } from "../core/diagnostic.ts";
import { CHECKS, type ValidateOptions, type ValidationResult, validateProject, validateText } from "./index.ts";

const position = z.object({ line: z.number().int(), column: z.number().int() });
const diagnostic = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: z.string(),
  source: z.string(),
  file: z.string().optional(),
  range: z.object({ start: position, end: position }).optional(),
  pointer: z.string().optional(),
  hint: z.string().optional(),
  related: z.array(z.object({ file: z.string(), range: z.object({ start: position, end: position }).optional(), message: z.string() })).optional(),
});

const output = {
  root: z.string(),
  target: z.object({ channel: z.enum(["stable", "preview"]), version: z.string().optional() }),
  ok: z.boolean().describe("true when no diagnostic reaches fail_on"),
  packs: z.array(z.object({ kind: z.string(), relDir: z.string(), name: z.string().optional(), uuid: z.string().optional(), version: z.string().optional(), files: z.number() })),
  filesChecked: z.number(),
  checks: z.array(z.string()),
  summary: z.object({ errors: z.number(), warnings: z.number(), infos: z.number() }),
  diagnostics: z.array(diagnostic),
  truncated: z.object({ total: z.number(), returned: z.number() }).optional().describe("present when max_diagnostics cut the list (errors first)"),
  schemaSources: z.record(z.string(), z.number()).describe("files validated per schema source"),
  vanilla: z.object({ root: z.string(), version: z.string().optional() }).optional(),
  rockide: z
    .object({
      root: z.string().optional(),
      release: z.string().optional().describe("release tag in use"),
      commit: z.string().optional(),
      latest: z.string().optional().describe("newest release seen upstream"),
      note: z.string().optional(),
    })
    .optional()
    .describe("rockide/schemas release used (newest GitHub release, checked daily), or a note why none was"),
  regolith: z.object({ profile: z.string(), built: z.boolean(), message: z.string().optional() }).optional(),
};

const common = {
  channel: z.enum(["stable", "preview"]).optional().describe("target release channel (default stable)"),
  fail_on: z.enum(["error", "warning"]).optional().describe("severity that makes ok=false (default error)"),
  max_diagnostics: z.number().int().positive().optional().describe("cap on returned diagnostics, errors first (default 200)"),
  samples_root: z.string().optional().describe("bedrock-samples checkout: vanilla names, script modules, commands, engine schemas"),
  typings_dir: z.string().optional().describe("node_modules dir with @minecraft/* typings for script checks"),
  engine_schemas_dir: z.string().optional().describe("engine schema dump (bedrock-samples root or <area>/<kind>/<version>/ layout)"),
  rockide_dir: z.string().optional().describe("rockide/schemas checkout to use instead of the cached copy"),
};

interface CommonArgs {
  channel?: "stable" | "preview" | undefined;
  fail_on?: "error" | "warning" | undefined;
  samples_root?: string | undefined;
  typings_dir?: string | undefined;
  engine_schemas_dir?: string | undefined;
  rockide_dir?: string | undefined;
}

function options(a: CommonArgs): ValidateOptions {
  const o: ValidateOptions = {};
  if (a.channel) o.channel = a.channel;
  if (a.fail_on) o.failOn = a.fail_on;
  if (a.samples_root) o.samplesRoot = a.samples_root;
  if (a.typings_dir) o.typingsDir = a.typings_dir;
  if (a.engine_schemas_dir) o.engineSchemasDir = a.engine_schemas_dir;
  if (a.rockide_dir) o.rockideSchemasDir = a.rockide_dir;
  return o;
}

const RANK = { error: 0, warning: 1, info: 2 } as const;

function structured(r: ValidationResult, max: number) {
  const ordered = [...r.diagnostics].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const diagnostics = ordered.slice(0, max);
  const schemaSources: Record<string, number> = {};
  for (const label of Object.values(r.schemaSources)) {
    const source = label.split(" ", 1)[0] as string;
    schemaSources[source] = (schemaSources[source] ?? 0) + 1;
  }
  const out: Record<string, unknown> = {
    root: r.root,
    target: r.target,
    ok: r.ok,
    packs: r.packs.map((p) => {
      const pack: Record<string, unknown> = { kind: p.kind, relDir: p.relDir, files: p.files };
      if (p.name) pack.name = p.name;
      if (p.uuid) pack.uuid = p.uuid;
      if (p.version) pack.version = p.version;
      return pack;
    }),
    filesChecked: r.filesChecked,
    checks: r.checks,
    summary: r.summary,
    diagnostics,
    schemaSources,
  };
  if (diagnostics.length < r.diagnostics.length) out.truncated = { total: r.diagnostics.length, returned: diagnostics.length };
  if (r.vanilla) out.vanilla = r.vanilla;
  if (r.rockide) out.rockide = r.rockide;
  if (r.regolith) out.regolith = r.regolith;
  return out;
}

function summaryText(r: ValidationResult, shown: number): string {
  const s = r.summary;
  const head = `${r.ok ? "OK" : "FAILED"}: ${s.errors} error(s), ${s.warnings} warning(s), ${s.infos} info in ${r.filesChecked} file(s); target ${r.target.channel}${r.target.version ? ` ${r.target.version}` : ""}`;
  const top = [...r.diagnostics]
    .sort((a, b) => RANK[a.severity] - RANK[b.severity])
    .slice(0, Math.min(10, shown))
    .map(formatDiagnostic);
  const notes = r.rockide?.note ? [`note: rockide/schemas ${r.rockide.note}`] : [];
  return [head, ...notes, ...top, ...(r.diagnostics.length > top.length ? [`... ${r.diagnostics.length - top.length} more in structuredContent`] : [])].join("\n");
}

export function register(server: McpServer): void {
  server.registerTool(
    "validate_pack",
    {
      title: "Validate add-on packs",
      description:
        "Validate every behavior/resource pack under a directory (add-on folder, single pack, or Regolith project, which is built with rgl when its profile runs filters). " +
        "Checks: JSON syntax as the game reads it, schemas chosen by format_version, manifest, cross-file references, lang, mcfunction, TypeScript. " +
        "Every diagnostic has file + 1-based range + stable code; fix errors by file and line, then re-run.",
      inputSchema: {
        path: z.string().describe("project, add-on or pack directory"),
        checks: z.array(z.enum(CHECKS)).optional().describe(`subset of ${CHECKS.join(", ")} (default all)`),
        regolith: z.enum(["auto", "build", "source"]).optional().describe("Regolith projects: auto builds when filters exist"),
        ...common,
      },
      outputSchema: output,
    },
    async (args) => {
      const o = options(args);
      if (args.checks) o.checks = args.checks;
      if (args.regolith) o.regolith = args.regolith;
      const r = await validateProject(args.path, o);
      const max = args.max_diagnostics ?? 200;
      return { content: [{ type: "text" as const, text: summaryText(r, max) }], structuredContent: structured(r, max) };
    },
  );

  server.registerTool(
    "validate_file",
    {
      title: "Validate one pack file",
      description:
        "Validate a single file in the context of its pack (and sibling packs), optionally with unsaved content. " +
        "Returns only that file's diagnostics (paths relative to the returned root).",
      inputSchema: {
        path: z.string().describe("file path inside a pack"),
        content: z.string().optional().describe("unsaved file content to validate instead of the file on disk"),
        ...common,
      },
      outputSchema: output,
    },
    async (args) => {
      const r = await validateText(args.path, args.content, options(args));
      const max = args.max_diagnostics ?? 200;
      return { content: [{ type: "text" as const, text: summaryText(r, max) }], structuredContent: structured(r, max) };
    },
  );
}
