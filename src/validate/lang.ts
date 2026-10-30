/**
 * `.lang` files and `texts/languages.json`: malformed lines, duplicate keys, a BOM that corrupts the first
 * key, languages listed without a file. Missing keys for defined entities/items/blocks are reference checks
 * (`lang.key-missing`, see references.ts).
 */
import type { Context, Pack } from "./context.ts";
import { LineIndex } from "./jsonc.ts";

export async function checkLang(ctx: Context, packs: readonly Pack[]): Promise<void> {
  for (const pack of packs) {
    for (const rel of pack.files) {
      if (/^texts\/[^/]+\.lang$/i.test(rel) || /^subpacks\/[^/]+\/texts\/[^/]+\.lang$/i.test(rel)) await checkLangFile(ctx, pack, rel);
    }
    if (pack.fileSet.has("texts/languages.json")) await checkLanguagesJson(ctx, pack);
  }
}

async function checkLangFile(ctx: Context, pack: Pack, rel: string): Promise<void> {
  const text = await ctx.text(pack, rel);
  if (text === undefined) return;
  const lines = new LineIndex(text);
  if (text.charCodeAt(0) === 0xfeff) {
    await ctx.add(pack, rel, {
      severity: "warning",
      code: "lang.bom",
      source: "lang",
      message: "UTF-8 byte order mark at the start of the file; the game reads it as part of the first key",
      range: lines.range(0, 1),
      hint: "save the file as UTF-8 without BOM",
    });
  }
  const seen = new Map<string, number>();
  const raw = text.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const line = (raw[i] as string).replace(/\r$/, "").replace(/^\uFEFF/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("##") || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const n = i + 1;
    if (eq <= 0) {
      await ctx.add(pack, rel, {
        severity: "warning",
        code: "lang.syntax",
        source: "lang",
        message: "line is not 'key=value'; the game ignores it",
        range: lines.lineRange(n),
      });
      continue;
    }
    const key = line.slice(0, eq);
    if (key !== key.trim()) {
      await ctx.add(pack, rel, {
        severity: "warning",
        code: "lang.key-whitespace",
        source: "lang",
        message: `key '${key}' has surrounding whitespace, which becomes part of the key`,
        range: { start: { line: n, column: 1 }, end: { line: n, column: eq + 1 } },
      });
    }
    const prev = seen.get(key);
    if (prev !== undefined) {
      await ctx.add(pack, rel, {
        severity: "warning",
        code: "lang.duplicate-key",
        source: "lang",
        message: `duplicate key '${key}' (first defined on line ${prev}); the game keeps the last value`,
        range: { start: { line: n, column: 1 }, end: { line: n, column: eq + 1 } },
      });
    } else seen.set(key, n);
  }
}

async function checkLanguagesJson(ctx: Context, pack: Pack): Promise<void> {
  const rel = "texts/languages.json";
  const value = await ctx.value(pack, rel);
  if (!Array.isArray(value)) {
    if (value !== undefined)
      await ctx.at(pack, rel, "", { severity: "error", code: "lang.languages-invalid", source: "lang", message: "languages.json must be an array of language codes" });
    return;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value[i];
    if (typeof code !== "string") {
      await ctx.at(pack, rel, `/${i}`, { severity: "error", code: "lang.languages-invalid", source: "lang", message: "language codes must be strings" });
    } else if (!pack.fileSet.has(`texts/${code}.lang`)) {
      await ctx.at(pack, rel, `/${i}`, {
        severity: "warning",
        code: "lang.file-missing",
        source: "lang",
        message: `languages.json lists '${code}' but texts/${code}.lang does not exist`,
      });
    }
  }
}
