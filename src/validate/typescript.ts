/**
 * Type-check behavior-pack scripts with the native `tsc --noEmit --pretty false` (checkJs for .js), resolving
 * `@minecraft/*` only for modules the manifest declares, and parse `file(line,col): error TSxxxx:` into
 * diagnostics. A project-level tsconfig.json (Regolith projects keep TypeScript sources outside the packs) is
 * checked with the project's own settings instead.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Severity } from "../core/diagnostic.ts";
import { errorMessage } from "../core/errors.ts";
import { run } from "../core/process.ts";
import { findOnPath } from "../core/which.ts";
import type { Channel } from "../core/version.ts";
import { SCRIPT_EXT } from "./classify.ts";
import { type Context, type Finding, type Pack, toPosix } from "./context.ts";
import { NPM_ONLY } from "./manifest.ts";

const DIAG = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;
const RUNTIME_GLOBALS = `declare const console: {
  log(...data: any[]): void;
  info(...data: any[]): void;
  warn(...data: any[]): void;
  error(...data: any[]): void;
  debug(...data: any[]): void;
};
`;

/** Returns a `node_modules` directory holding `@minecraft/<pkg>` typings for the given manifest pins. */
export type ResolveTypings = (modules: Record<string, string>, channel: Channel) => Promise<string | undefined>;

export interface TypeScriptOptions {
  channel: Channel;
  /** A `node_modules` dir (or its parent) with `@minecraft/<pkg>` typings. */
  typingsDir?: string;
  resolveTypings?: ResolveTypings;
  /** Explicit tsc launcher (JS file run with node, or a native executable). */
  tscPath?: string;
}

export interface TscDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: Severity;
  code: string;
  message: string;
}

/** Parse `tsc --pretty false` output; continuation lines (indented) are folded into the message. */
export function parseTscOutput(output: string): TscDiagnostic[] {
  const out: TscDiagnostic[] = [];
  let current: TscDiagnostic | undefined;
  for (const line of output.split(/\r?\n/)) {
    const m = DIAG.exec(line);
    if (m) {
      current = {
        file: m[1] as string,
        line: Number(m[2]),
        column: Number(m[3]),
        severity: m[4] === "error" ? "error" : m[4] === "warning" ? "warning" : "info",
        code: m[5] as string,
        message: m[6] as string,
      };
      out.push(current);
    } else if (current && /^\s+\S/.test(line)) {
      current.message += ` ${line.trim()}`;
    } else {
      current = undefined;
    }
  }
  return out;
}

/**
 * JS launchers an npm `tsc.cmd` shim points at: a global shim (`<prefix>\tsc.cmd`) sits beside
 * `node_modules\typescript`, a project one (`node_modules\.bin\tsc.cmd`) beside `typescript`.
 */
export function cmdShimTargets(cmd: string): string[] {
  const dir = dirname(cmd);
  return [join(dir, "node_modules", "typescript", "bin", "tsc"), join(dir, "..", "typescript", "bin", "tsc")];
}

/**
 * tsc on PATH. A native executable runs as it is. npm's `tsc.cmd` shim on Windows cannot run without a shell, so the
 * JS launcher it points at runs with the current node instead.
 */
export function tscOnPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } | undefined {
  const hit = findOnPath("tsc", env, platform);
  if (!hit || !/\.(cmd|bat)$/i.test(hit)) return hit ? { command: hit, args: [] } : undefined;
  const target = cmdShimTargets(hit).find((f) => existsSync(f));
  return target ? { command: process.execPath, args: [target] } : undefined;
}

/** tsc launcher: project-local first, then the one shipped with sculkwire, then PATH. */
export function findTsc(projectRoot: string, explicit?: string): { command: string; args: string[] } | undefined {
  const viaNode = (js: string) => ({ command: process.execPath, args: [js] });
  if (explicit) {
    if (/\.cmd$/i.test(explicit)) {
      const target = cmdShimTargets(explicit).find((f) => existsSync(f));
      if (target) return viaNode(target);
    }
    return explicit.endsWith(".js") || existsSync(join(dirname(explicit), "..", "package.json")) ? viaNode(explicit) : { command: explicit, args: [] };
  }
  for (let d = resolve(projectRoot); ; d = dirname(d)) {
    const local = join(d, "node_modules", "typescript", "bin", "tsc");
    if (existsSync(local)) return viaNode(local);
    if (dirname(d) === d) break;
  }
  try {
    const pkg = createRequire(import.meta.url).resolve("typescript/package.json");
    const own = join(dirname(pkg), "bin", "tsc");
    if (existsSync(own)) return viaNode(own);
  } catch {
    // typescript is a dev dependency; absent in some installs
  }
  return tscOnPath();
}

function nodeModulesOf(dir: string): string {
  return existsSync(join(dir, "node_modules", "@minecraft")) ? join(dir, "node_modules") : dir;
}

/** Project-local node_modules holding `@minecraft/<pkg>`, walking up from `start` to `stop`. */
function localTypings(start: string, stop: string, pkg: string): string | undefined {
  for (let d = resolve(start); ; d = dirname(d)) {
    const candidate = join(d, "node_modules", "@minecraft", pkg);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (d === resolve(stop) || dirname(d) === d) return undefined;
  }
}

async function report(ctx: Context, packs: readonly Pack[], cwd: string, diags: TscDiagnostic[]): Promise<void> {
  const files = new Map<string, string[] | undefined>();
  for (const t of diags) {
    const abs = isAbsolute(t.file) ? t.file : resolve(cwd, t.file);
    const pack = packs.find((p) => abs.startsWith(p.dir + sep));
    if (!files.has(abs)) files.set(abs, await readFile(abs, "utf8").then((text) => text.split(/\r?\n/), () => undefined));
    const lineText = files.get(abs)?.[t.line - 1];
    const word = lineText ? /^[\w$]+|^./.exec(lineText.slice(t.column - 1))?.[0] : undefined;
    const d: Omit<Finding, "file"> = {
      severity: t.severity,
      code: `ts.${t.code.slice(2)}`,
      message: t.message,
      range: { start: { line: t.line, column: t.column }, end: { line: t.line, column: t.column + (word?.length ?? 1) } },
    };
    if (pack) await ctx.add(pack, toPosix(relative(pack.dir, abs)), d);
    else ctx.push({ ...d, file: toPosix(relative(ctx.root, abs)) });
  }
}

/** Check one behavior pack's scripts with a generated tsconfig. */
async function checkPack(ctx: Context, pack: Pack, opts: TypeScriptOptions, tsc: { command: string; args: string[] }): Promise<void> {
  const scripts = pack.files.filter((f) => f.startsWith("scripts/") && SCRIPT_EXT.test(f) && !f.endsWith(".d.ts"));
  if (!scripts.length) return;
  const declared: Record<string, string> = {};
  for (const dep of Array.isArray(pack.manifest?.dependencies) ? (pack.manifest?.dependencies as unknown[]) : []) {
    if (!dep || typeof dep !== "object" || !("module_name" in dep)) continue;
    const name = dep.module_name;
    const version = "version" in dep ? dep.version : undefined;
    if (typeof name === "string" && name.startsWith("@minecraft/") && !NPM_ONLY[name]) declared[name] = typeof version === "string" ? version : "";
  }
  let typings = opts.typingsDir ? nodeModulesOf(opts.typingsDir) : undefined;
  if (!typings && opts.resolveTypings && Object.keys(declared).length) {
    try {
      typings = await opts.resolveTypings(declared, opts.channel);
    } catch (err) {
      await ctx.at(pack, "manifest.json", "/dependencies", {
        severity: "warning",
        code: "typescript.typings-unavailable",
        message: `no typings for ${Object.entries(declared).map(([n, v]) => `${n}@${v}`).join(", ")}: ${errorMessage(err)}`,
      });
    }
  }
  const paths: Record<string, string[]> = {};
  const shims: string[] = [];
  for (const name of Object.keys(declared)) {
    const pkg = name.slice("@minecraft/".length);
    const dir = typings && existsSync(join(typings, "@minecraft", pkg, "package.json")) ? join(typings, "@minecraft", pkg) : localTypings(pack.dir, ctx.root, pkg);
    if (dir) paths[name] = [dir];
    else shims.push(name);
  }
  if (shims.length) {
    await ctx.at(pack, "manifest.json", "/dependencies", {
      severity: "info",
      code: "typescript.typings-missing",
      message: `no typings for ${shims.join(", ")}; their APIs are typed as 'any'`,
      hint: "pass typingsDir (sculk validate --typings <dir>) for full API checks",
    });
  }
  const tmp = await mkdtemp(join(tmpdir(), "sculk-tsc-"));
  try {
    const globals = join(tmp, "bedrock-runtime.d.ts");
    await writeFile(globals, `${RUNTIME_GLOBALS}${shims.map((s) => `declare module ${JSON.stringify(s)};\n`).join("")}`);
    const config = {
      compilerOptions: {
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
        lib: ["es2023"],
        allowJs: true,
        checkJs: true,
        noEmit: true,
        strict: false,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        types: [],
        paths,
      },
      files: [globals, ...scripts.map((s) => join(pack.dir, ...s.split("/")))],
    };
    const cfgPath = join(tmp, "tsconfig.json");
    await writeFile(cfgPath, JSON.stringify(config, null, 2));
    const { code, stdout, stderr } = await run(tsc.command, [...tsc.args, "-p", cfgPath, "--pretty", "false"], { cwd: tmp, timeoutMs: 600_000 });
    const output = stdout + stderr;
    const diags = parseTscOutput(output);
    await report(ctx, [pack], tmp, diags);
    if (code !== 0 && diags.length === 0) {
      await ctx.add(pack, "manifest.json", {
        severity: "error",
        code: "typescript.failed",
        message: `tsc failed: ${output.trim().slice(-1500)}`,
      });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Check the project's own tsconfig.json (sources outside the packs, e.g. Regolith `data/`). */
async function checkProject(ctx: Context, tsconfig: string, tsc: { command: string; args: string[] }): Promise<void> {
  const root = dirname(tsconfig);
  if (!existsSync(join(root, "node_modules"))) {
    ctx.push({
      severity: "info",
      code: "typescript.skipped",
      message: "tsconfig.json found but node_modules is missing; run your package manager's install to type-check project sources",
      file: toPosix(relative(ctx.root, tsconfig)),
    });
    return;
  }
  const { code, stdout, stderr } = await run(tsc.command, [...tsc.args, "-p", tsconfig, "--noEmit", "--pretty", "false"], { cwd: root, timeoutMs: 600_000 });
  const output = stdout + stderr;
  const diags = parseTscOutput(output);
  await report(ctx, ctx.packs, root, diags);
  if (code !== 0 && diags.length === 0) {
    ctx.push({
      severity: "error",
      code: "typescript.failed",
      message: `tsc -p ${toPosix(relative(ctx.root, tsconfig))} failed: ${output.trim().slice(-1500)}`,
      file: toPosix(relative(ctx.root, tsconfig)),
    });
  }
}

export async function checkTypeScript(ctx: Context, packs: readonly Pack[], opts: TypeScriptOptions): Promise<void> {
  const scriptPacks = packs.filter((p) => p.kind === "behavior" && p.files.some((f) => f.startsWith("scripts/") && SCRIPT_EXT.test(f)));
  const projectConfig = join(ctx.root, "tsconfig.json");
  const hasProjectConfig = existsSync(projectConfig);
  if (!scriptPacks.length && !hasProjectConfig) return;
  const tsc = findTsc(ctx.root, opts.tscPath);
  if (!tsc) {
    ctx.push({
      severity: "warning",
      code: "typescript.unavailable",
      message: "no TypeScript compiler found (project node_modules, sculkwire's own, or PATH); scripts were not type-checked",
      hint: "npm install --save-dev typescript",
    });
    return;
  }
  if (hasProjectConfig) await checkProject(ctx, projectConfig, tsc);
  else for (const pack of scriptPacks) await checkPack(ctx, pack, opts, tsc);
}
