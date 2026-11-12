/**
 * Whether a command run through the script debugger failed. The debugger's `minecraftCommand` has no reply: the game
 * prints `Executing command [...]` and then the command's output lines, all at log level, without the success flag
 * the game keeps per output message. So failure is read from the text, against the game's own failure messages
 * (`commands.generic.*` errors and every `commands.*` message whose key names a failure) in its installed
 * `texts/<language>.lang`, read at runtime. Without a language file only the two built-in parser failures count.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseOptions } from "../../gamefiles/options.ts";

/** Used when no language file can be read: the parser's own errors. */
const BUILTIN_FAILURE = /^Syntax error|^Unknown command/i;

/** The one `commands.generic.*` message that does not report a failure. */
const GENERIC_NOT_FAILURE = "commands.generic.async.initiated";
/** Last key segments that name a failure: `failed`, `failure`, `fail`, `notFound`, `functionNameNotFound`, `outOfWorld`. */
const FAILURE_SEGMENT = /(?:fail|failed|failure|notfound|outofworld)$/i;
/** `%s`, `%1$s`, `%d`, `%2$d`, `%.2f`. */
const PLACEHOLDER = /%(?:\d+\$)?[-+ #0]*\d*(?:\.\d+)?[sdif]/g;
/** A template with less fixed text than this would match unrelated output. */
const MIN_FIXED_TEXT = 4;

export type FailureMatcher = (line: string) => boolean;

export function isFailureKey(key: string): boolean {
  if (!key.startsWith("commands.")) return false;
  if (key.startsWith("commands.generic.")) return key !== GENERIC_NOT_FAILURE;
  return FAILURE_SEGMENT.test(key.slice(key.lastIndexOf(".") + 1));
}

/** `key=value` lines of a `.lang` file; a tab starts a trailing comment. */
export function parseLang(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).split("\t")[0]!.trim());
  }
  return out;
}

/** One message template as a regex source: placeholders match any text, the rest literally. */
function templateSource(template: string): string | undefined {
  const fixed = template.split(PLACEHOLDER);
  if (fixed.join("").trim().length < MIN_FIXED_TEXT) return undefined;
  return fixed.map((part) => part.replaceAll("%%", "%").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*?");
}

/** A matcher for the failure messages of one or more parsed language files; the built-in one when they hold none. */
export function failureMatcher(langs: readonly Map<string, string>[]): FailureMatcher {
  const sources = new Set<string>();
  for (const lang of langs) {
    for (const [key, value] of lang) {
      if (!isFailureKey(key)) continue;
      const source = templateSource(value);
      if (source) sources.add(source);
    }
  }
  if (sources.size === 0) return (line) => BUILTIN_FAILURE.test(line);
  const re = new RegExp(`^(?:${[...sources].join("|")})$`, "s");
  return (line) => BUILTIN_FAILURE.test(line) || re.test(line);
}

/** The debugger route's `ok`: no output line is a failure message. */
export function debuggerCommandOk(output: readonly string[], failed: FailureMatcher): boolean {
  return !output.some((line) => failed(line.trim()));
}

/**
 * A debugger print that belongs to the helper pack's own traffic, not to a command's output: its `[sculkwire:…]`
 * lines (state stream, query replies) and the game's echo and confirmation of the `scriptevent sculkwire:query`
 * command every helper query is sent with.
 */
export function helperTraffic(message: string): boolean {
  return message.startsWith("[sculkwire:") || message.includes("sculkwire:query");
}

/**
 * The failure matcher for an installed game: `en_US` plus the language in `game_language` of its options.txt, from
 * `<gameDir>/data/resource_packs/vanilla/texts/`. Missing files are skipped.
 */
export async function loadFailureMatcher(gameDir: string | undefined, optionsFile: string | undefined): Promise<FailureMatcher> {
  if (!gameDir) return failureMatcher([]);
  const languages = new Set(["en_US"]);
  if (optionsFile) {
    const language = parseOptions(await readFile(optionsFile, "utf8").catch(() => "")).get("game_language");
    if (language && /^[A-Za-z]{2}_[A-Za-z]{2}$/.test(language)) languages.add(language);
  }
  const texts = join(gameDir, "data", "resource_packs", "vanilla", "texts");
  const langs: Map<string, string>[] = [];
  for (const language of languages) {
    const text = await readFile(join(texts, `${language}.lang`), "utf8").catch(() => undefined);
    if (text !== undefined) langs.push(parseLang(text));
  }
  return failureMatcher(langs);
}
