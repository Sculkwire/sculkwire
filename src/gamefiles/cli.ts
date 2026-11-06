import { parseArgs } from "node:util";
import type { CliCommand } from "../core/cli.ts";
import { ExitCode } from "../core/diagnostic.ts";
import { detectBuilds, gameDirCandidates, noBuildMessage, selectBuild, type GameBuild } from "./detect.ts";
import { extractPack, findPack, listPacks, listVanillaPacks, PACK_KINDS, type PackKind } from "./extract.ts";

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

type Parsed = { values: Record<string, string | boolean | undefined>; positionals: string[] };

function parse(args: string[], options: Record<string, { type: "string" | "boolean"; short?: string }>): Parsed | undefined {
  try {
    return parseArgs({ args, options: { ...options, json: { type: "boolean" } }, allowPositionals: true });
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

function resolveBuild(selector: string | undefined): GameBuild | undefined {
  const build = selectBuild(detectBuilds(), selector);
  if (!build) err(noBuildMessage(selector));
  return build;
}

function isKind(value: unknown): value is PackKind {
  return typeof value === "string" && (PACK_KINDS as readonly string[]).includes(value);
}

const builds: CliCommand = {
  name: "gamefiles builds",
  summary: "Installed PC (GDK) game builds: version, game directory, pack folders [--game-dir dir] [--json]",
  async run(args) {
    const p = parse(args, { "game-dir": { type: "string" } });
    if (!p) return ExitCode.usage;
    const dir = p.values["game-dir"];
    const found = detectBuilds(typeof dir === "string" ? [dir] : gameDirCandidates());
    if (p.values.json) {
      out(JSON.stringify({ builds: found }, null, 2));
      return found.length ? ExitCode.ok : ExitCode.usage;
    }
    if (found.length === 0) {
      err(noBuildMessage());
      return ExitCode.usage;
    }
    for (const b of found) {
      out(`${b.root}`);
      out(`  version        ${b.version ?? "unknown"}${b.appxVersion ? ` (appx ${b.appxVersion})` : ""}`);
      if (b.packageName) out(`  package        ${b.packageName}`);
      out(`  key            ${b.key}`);
      out(`  behavior packs ${b.packRoots.behavior ?? "none"}`);
      out(`  resource packs ${b.packRoots.resource ?? "none"}`);
    }
    return ExitCode.ok;
  },
};

const packs: CliCommand = {
  name: "gamefiles packs",
  summary: "List the versioned vanilla packs of an installed build (--all for every pack, --kind behavior|resource)",
  async run(args) {
    const p = parse(args, { build: { type: "string" }, kind: { type: "string" }, all: { type: "boolean" } });
    if (!p) return ExitCode.usage;
    const kind = p.values.kind;
    if (kind !== undefined && !isKind(kind)) {
      err(`--kind must be one of ${PACK_KINDS.join(", ")}`);
      return ExitCode.usage;
    }
    const build = resolveBuild(p.values.build as string | undefined);
    if (!build) return ExitCode.usage;
    const list = (p.values.all ? listPacks(build) : listVanillaPacks(build)).filter((x) => !kind || x.kind === kind);
    if (p.values.json) out(JSON.stringify({ build: build.key, version: build.version, packs: list }, null, 2));
    else for (const x of list) out(`${x.kind.padEnd(8)} ${x.name.padEnd(32)} ${String(x.archives).padStart(4)} archives`);
    return ExitCode.ok;
  },
};

const extract: CliCommand = {
  name: "gamefiles extract",
  summary: "Unpack a game pack (.brarchive + loose files): gamefiles extract <pack> [--kind resource] [--out dir] [--force]",
  async run(args) {
    const p = parse(args, {
      build: { type: "string" },
      kind: { type: "string" },
      out: { type: "string" },
      force: { type: "boolean" },
    });
    if (!p) return ExitCode.usage;
    const pack = p.positionals[0];
    const kind = p.values.kind ?? "behavior";
    if (!pack || p.positionals.length > 1 || !isKind(kind)) {
      err("usage: sculk gamefiles extract <pack> [--kind behavior|resource] [--out dir] [--force] [--build key]");
      return ExitCode.usage;
    }
    const build = resolveBuild(p.values.build as string | undefined);
    if (!build) return ExitCode.usage;
    const target = findPack(build, pack, kind);
    if (!target) {
      err(`no ${kind} pack ${JSON.stringify(pack)} in build ${build.key} (see: sculk gamefiles packs --all)`);
      return ExitCode.usage;
    }
    err(`extracting ${kind} ${pack} from ${build.root}`);
    const options: { out?: string; force?: boolean } = {};
    if (typeof p.values.out === "string") options.out = p.values.out;
    if (p.values.force) options.force = true;
    const r = await extractPack(build, target, options);
    for (const f of r.failures) err(`  ${f.archive}: ${f.reason}: ${f.detail}`);
    if (p.values.json) out(JSON.stringify(r, null, 2));
    else {
      err(
        `${r.looseFiles} loose files, ${r.archives} archives, ${r.archiveEntries} entries` +
          ` (${r.placeholders} placeholders, ${r.failures.length} failures)${r.cached ? ", cached" : ""}`,
      );
      out(r.out);
    }
    return ExitCode.ok;
  },
};

export const commands: CliCommand[] = [builds, packs, extract];
