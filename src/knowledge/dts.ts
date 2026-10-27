/**
 * Line-based parser for the generated `@minecraft/*` declaration files. The files follow one fixed layout
 * (TSDoc block, then one declaration; members indented by 4 spaces), so no compiler API is needed.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type DtsKind =
  | "class"
  | "interface"
  | "enum"
  | "type"
  | "function"
  | "variable"
  | "method"
  | "property"
  | "constructor"
  | "enumMember";

export interface DtsDoc {
  summary: string;
  params: { name: string; text: string }[];
  returns?: string;
  throws: string[];
  examples: { title: string; code: string }[];
  privileges: string[];
  deprecated?: string;
  beta: boolean;
}

export interface DtsSymbol {
  module: string;
  /** `Entity`, `Entity.applyDamage`, `world`. */
  name: string;
  container?: string;
  kind: DtsKind;
  signature: string;
  doc: DtsDoc;
  /** Base types from `extends` (containers only). */
  bases?: string[];
}

export function parseDoc(lines: string[]): DtsDoc {
  const doc: DtsDoc = { summary: "", params: [], throws: [], examples: [], privileges: [], beta: false };
  const summary: string[] = [];
  let tag = "";
  let body: string[] = [];
  const close = () => {
    const text = body.join("\n").trim();
    if (tag === "" || tag === "remarks") {
      if (text) summary.push(text);
    } else if (tag === "param") {
      const m = /^(\S+)\s*([\s\S]*)$/.exec(text);
      if (m?.[1]) doc.params.push({ name: m[1], text: (m[2] ?? "").trim() });
    } else if (tag === "returns") {
      doc.returns = text;
    } else if (tag === "throws") {
      doc.throws.push(text.replace(/\{@link ([^}]+)\}/g, "$1").replace(/\n\s*\n/g, "\n"));
    } else if (tag === "example") {
      const [title = "", ...rest] = text.split("\n");
      const code = rest.join("\n").replace(/^```\w*\n?/, "").replace(/\n?```\s*$/, "");
      doc.examples.push({ title: title.trim(), code });
    } else if (tag === "privilege") {
      doc.privileges.push(text);
    } else if (tag === "deprecated") {
      doc.deprecated = text || "deprecated";
    }
    body = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/^\s*\/\*\*\s?/, "").replace(/\s*\*\/\s*$/, "").replace(/^\s*\*\s?/, "");
    const t = /^@(\w+)\s?(.*)$/.exec(line);
    if (t?.[1]) {
      close();
      tag = t[1];
      if (tag === "beta") doc.beta = true;
      body.push(t[2] ?? "");
    } else {
      body.push(line);
    }
  }
  close();
  doc.summary = summary.join("\n\n");
  return doc;
}

/** Bracket depth change ignoring `<>` (arrow functions contain `>`) and string contents. */
function depthDelta(line: string): number {
  let d = 0;
  let quote = "";
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(" || ch === "{" || ch === "[") d++;
    else if (ch === ")" || ch === "}" || ch === "]") d--;
  }
  return d;
}

const TOP_RE = /^export (?:declare )?(?:abstract )?(class|interface|enum|type|function|const|let|var) ([A-Za-z_$][\w$]*)/;
const MODIFIERS_RE = /^(?:(?:readonly|static|private|protected|public|abstract|get|set|declare)\s+)*/;

function memberName(decl: string): { name: string; callable: boolean } | undefined {
  const rest = decl.trim().replace(MODIFIERS_RE, "");
  if (rest.startsWith("[")) return undefined;
  const m = /^(['"]?)([A-Za-z_$][\w$]*)\1(\??)\s*([(<:=,;]?)/.exec(rest);
  if (!m?.[2]) return undefined;
  return { name: m[2], callable: m[4] === "(" || m[4] === "<" };
}

export function parseDts(text: string, module: string): DtsSymbol[] {
  const out: DtsSymbol[] = [];
  const lines = text.split(/\r?\n/);
  let doc: string[] = [];
  let container: DtsSymbol | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("/**")) {
      doc = [line];
      while (!(lines[i] ?? "").includes("*/") && i < lines.length - 1) doc.push(lines[++i] ?? "");
      continue;
    }
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("import ")) continue;

    if (container) {
      if (/^}/.test(line)) {
        container = undefined;
        doc = [];
        continue;
      }
      let decl = trimmed;
      let depth = depthDelta(trimmed);
      while ((depth > 0 || !/[;,]$/.test(decl)) && i < lines.length - 1 && !/^}/.test(lines[i + 1] ?? "")) {
        const next = (lines[++i] ?? "").trim();
        decl += ` ${next}`;
        depth += depthDelta(next);
      }
      const nm = memberName(decl);
      if (nm) {
        const kind: DtsKind =
          container.kind === "enum"
            ? "enumMember"
            : nm.name === "constructor"
              ? "constructor"
              : nm.callable
                ? "method"
                : "property";
        out.push({
          module,
          name: `${container.name}.${nm.name}`,
          container: container.name,
          kind,
          signature: decl.replace(/[,;]$/, ""),
          doc: parseDoc(doc),
        });
      }
      doc = [];
      continue;
    }

    const top = TOP_RE.exec(line);
    if (!top?.[1] || !top[2]) {
      doc = [];
      continue;
    }
    const keyword = top[1];
    const kind: DtsKind =
      keyword === "const" || keyword === "let" || keyword === "var" ? "variable" : (keyword as DtsKind);
    let decl = trimmed;
    const sym: DtsSymbol = { module, name: top[2], kind, signature: "", doc: parseDoc(doc) };
    doc = [];
    if ((kind === "class" || kind === "interface" || kind === "enum") && decl.endsWith("{")) {
      sym.signature = decl.replace(/\s*\{$/, "").replace(/^export (?:declare )?/, "");
      const ext = /\bextends\s+(.+?)(?:\s+implements\b|$)/.exec(sym.signature);
      if (ext?.[1]) sym.bases = ext[1].split(",").map((b) => b.trim().replace(/<.*$/, ""));
      if (decl.endsWith("{}")) {
        out.push(sym);
        continue;
      }
      out.push(sym);
      container = sym;
      continue;
    }
    let depth = depthDelta(trimmed);
    while ((depth > 0 || !decl.endsWith(";")) && i < lines.length - 1) {
      const next = (lines[++i] ?? "").trim();
      decl += `\n${next}`;
      depth += depthDelta(next);
    }
    sym.signature = decl.replace(/^export (?:declare )?/, "").replace(/;$/, "");
    out.push(sym);
  }
  return out;
}

/** Parse a package's declarations: its `types` entry (or `index.d.ts`) plus `export * from` targets. */
export async function parsePackage(packageDir: string, module: string): Promise<DtsSymbol[]> {
  const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
    types?: string;
    typings?: string;
  };
  const entry = join(packageDir, pkg.types ?? pkg.typings ?? "index.d.ts");
  const seen = new Set<string>();
  const out: DtsSymbol[] = [];
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return;
    }
    out.push(...parseDts(text, module));
    for (const m of text.matchAll(/^export \* from ['"](\.[^'"]+)['"]/gm)) {
      const target = join(dirname(file), m[1] ?? "").replace(/\.js$/, "");
      await visit(target.endsWith(".d.ts") ? target : `${target}.d.ts`);
    }
  };
  await visit(entry);
  return out;
}
