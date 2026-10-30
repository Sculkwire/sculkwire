/**
 * `.mcfunction` line checks: command names against the target game's command list (when known), including
 * the command after `execute ... run`, and `functions/tick.json` shape. Function references
 * (`function x`, tick.json values) are resolved by references.ts.
 */
import type { Context, Pack } from "./context.ts";

export interface McfunctionOptions {
  /** Lowercase command names and aliases the game knows. Empty/undefined: command names are not checked. */
  commands?: ReadonlySet<string>;
}

const RUN = /\brun\s+\/?([A-Za-z_][\w:.-]*)/g;

export async function checkMcfunctions(ctx: Context, packs: readonly Pack[], opts: McfunctionOptions): Promise<void> {
  const commands = opts.commands?.size ? opts.commands : undefined;
  for (const pack of packs) {
    if (pack.kind !== "behavior") continue;
    for (const rel of pack.files) {
      if (rel.startsWith("functions/") && rel.toLowerCase().endsWith(".mcfunction")) await checkFile(ctx, pack, rel, commands);
    }
    if (pack.fileSet.has("functions/tick.json")) await checkTickJson(ctx, pack);
  }
}

async function checkFile(ctx: Context, pack: Pack, rel: string, commands: ReadonlySet<string> | undefined): Promise<void> {
  const text = await ctx.text(pack, rel);
  if (text === undefined) return;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).replace(/\r$/, "").replace(/^\uFEFF/, "");
    const lead = line.length - line.trimStart().length;
    const body = line.slice(lead);
    if (!body || body.startsWith("#")) continue;
    if (!commands) continue;
    const names: { name: string; col: number }[] = [];
    const first = /^\/?([^\s]+)/.exec(body);
    if (first) names.push({ name: first[1] as string, col: lead + (body.startsWith("/") ? 2 : 1) });
    for (const m of body.matchAll(RUN)) names.push({ name: m[1] as string, col: lead + (m.index ?? 0) + m[0].length - (m[1] as string).length + 1 });
    for (const { name, col } of names) {
      // `namespace:command` are script-registered custom commands; the game resolves them at runtime.
      if (name.includes(":") || commands.has(name.toLowerCase())) continue;
      await ctx.add(pack, rel, {
        severity: "error",
        code: "mcfunction.unknown-command",
        source: "mcfunction",
        message: `unknown command '${name}'; the whole function fails to load`,
        range: { start: { line: i + 1, column: col }, end: { line: i + 1, column: col + name.length } },
      });
    }
  }
}

async function checkTickJson(ctx: Context, pack: Pack): Promise<void> {
  const rel = "functions/tick.json";
  const value = await ctx.value(pack, rel);
  if (value === undefined) return;
  const values = value && typeof value === "object" && !Array.isArray(value) && "values" in value ? value.values : undefined;
  if (!Array.isArray(values)) {
    await ctx.at(pack, rel, values === undefined ? "" : "/values", {
      severity: "error",
      code: "mcfunction.tick-json",
      source: "mcfunction",
      message: 'tick.json needs "values": an array of function names (paths under functions/ without .mcfunction)',
    });
    return;
  }
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "string") {
      await ctx.at(pack, rel, `/values/${i}`, { severity: "error", code: "mcfunction.tick-json", source: "mcfunction", message: "function names must be strings" });
    } else if (v.endsWith(".mcfunction") || v.startsWith("functions/")) {
      await ctx.at(pack, rel, `/values/${i}`, {
        severity: "error",
        code: "mcfunction.tick-json",
        source: "mcfunction",
        message: `'${v}' must be the function name relative to functions/, without the extension`,
        hint: `use "${v.replace(/^functions\//, "").replace(/\.mcfunction$/, "")}"`,
      });
    }
  }
}
