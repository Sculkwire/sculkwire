/**
 * BDS load-check: boot a disposable server with the project's packs, wait for `Server started.`, let it settle,
 * stop it, and turn console + content log output into Diagnostics mapped to pack files.
 *
 * A Regolith project whose profile runs filters is built with rgl first (the same `regolithPlan` + `buildRegolith`
 * the validator and the client bridge use), and the server loads the built packs: the source packs hold filter
 * inputs, not what the game loads. A failed build is an error Diagnostic and no server starts.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Diagnostic } from "../../core/diagnostic.ts";
import { compareDiagnostics } from "../../core/diagnostic.ts";
import { dataDir } from "../../core/paths.ts";
import { discoverProject, type PackInfo } from "../../core/project.ts";
import type { Channel } from "../../core/version.ts";
import { buildRegolith, regolithPlan } from "../../validate/regolith.ts";
import { indexBuiltPack } from "./built.ts";
import { PrerequisiteError, resolveBds, type BdsInstall } from "./install.ts";
import { createInstance, disposeInstance, newInstanceId, type BdsInstance } from "./instance.ts";
import { entriesToDiagnostics, indexPack, projectPath, type IndexedPack } from "./logparse.ts";
import type { BdsServer } from "./server.ts";
import { ensureTemplate, runOnce } from "./template.ts";

/** The Regolith build the loadable packs come from. */
export interface PackBuild {
  profile: string;
  /** rgl's temp dir (build output and project copy); delete when done. */
  workDir: string;
  /** Source pack of each built pack dir (absolute built dir → source pack). */
  sources: Map<string, PackInfo>;
}

export interface ProjectPacks {
  root: string;
  /** Packs to load: the built dirs after a Regolith build (`relDir` stays the source pack's), else the source dirs. */
  loadable: PackInfo[];
  /** Diagnostics for packs BDS cannot load (skin packs, world templates, packs without uuid/version). */
  skipped: Diagnostic[];
  build?: PackBuild;
  /** Set when the Regolith build failed; `loadable` is empty then and no server should start. */
  failure?: Diagnostic;
}

function isLoadable(pack: PackInfo): boolean {
  return (pack.kind === "behavior" || pack.kind === "resource") && !!pack.uuid && !!pack.version;
}

/**
 * The project's packs as BDS should load them. A Regolith project whose profile runs filters is built with rgl
 * (`rglPath` overrides the lookup); the server then loads the built packs. A build failure, or a source pack the
 * build left out, gives `failure` instead of a silent fallback to the unbuilt source packs.
 */
export async function projectPacks(path: string, opts: { rglPath?: string; log?: (line: string) => void } = {}): Promise<ProjectPacks> {
  const root = resolve(path);
  const layout = await discoverProject(root);
  const loadable: PackInfo[] = [];
  const skipped: Diagnostic[] = [];
  for (const pack of layout.packs) {
    if (isLoadable(pack)) loadable.push(pack);
    else {
      skipped.push({
        severity: "warning",
        code: "bds.pack-not-loaded",
        message: `${pack.kind} pack${pack.uuid ? "" : " without header.uuid"} is not loaded into BDS`,
        source: "bds",
        file: projectPath(pack, "manifest.json"),
      });
    }
  }
  if (loadable.length === 0) throw new PrerequisiteError(`no behavior or resource pack (manifest.json with header.uuid) under ${root}`);
  const plan = layout.regolith ? await regolithPlan(root) : undefined;
  if (!layout.regolith || !plan) return { root, loadable, skipped };
  if (!plan.hasFilters) {
    opts.log?.(`Regolith profile ${plan.profile} runs no filters: loading the source packs`);
    return { root, loadable, skipped };
  }

  const config = relative(root, layout.regolith.configPath).split("\\").join("/");
  const failure = (message: string): ProjectPacks => ({
    root,
    loadable: [],
    skipped,
    failure: {
      severity: "error",
      code: "regolith.build-failed",
      message: `${message}; BDS was not started, because the source packs of a filtered profile are not what the game loads`,
      source: "bds",
      file: config,
    },
  });
  opts.log?.(`Regolith profile ${plan.profile} runs filters: building with rgl first`);
  const build = await buildRegolith(root, plan.profile, opts.rglPath);
  if (!("outputs" in build)) return failure(build.message);
  const builtDirs = new Map(build.outputs.map((o) => [resolve(o.source), o.built]));
  const packs: PackInfo[] = [];
  const sources = new Map<string, PackInfo>();
  const unbuilt: string[] = [];
  for (const pack of loadable) {
    const dir = builtDirs.get(resolve(pack.dir));
    const [info] = dir ? (await discoverProject(dir)).packs : [];
    if (!dir || !info || !isLoadable(info)) {
      unbuilt.push(pack.relDir || ".");
      continue;
    }
    const builtPack: PackInfo = { ...info, relDir: pack.relDir };
    packs.push(builtPack);
    sources.set(builtPack.dir, pack);
  }
  if (unbuilt.length) {
    await rm(build.workDir, { recursive: true, force: true });
    return failure(`rgl run ${plan.profile} did not build a loadable pack (manifest with header uuid/version) for ${unbuilt.join(", ")}`);
  }
  opts.log?.(`Regolith: built ${packs.length} pack(s) with ${build.rgl} into ${join(build.workDir, "out")}`);
  return { root, loadable: packs, skipped, build: { profile: plan.profile, workDir: build.workDir, sources } };
}

/**
 * Index loaded packs for log mapping. Built packs map back to the project sources (`indexBuiltPack`); `folder` is
 * each pack's folder in the world, when it is loaded there.
 */
export function indexProject(project: Pick<ProjectPacks, "root" | "build">, packs: readonly { pack: PackInfo; folder?: string }[]): Promise<IndexedPack[]> {
  return Promise.all(
    packs.map((l) => {
      const source = project.build?.sources.get(l.pack.dir);
      return source && project.build
        ? indexBuiltPack(l.pack, source, project.root, join(project.build.workDir, "project"), l.folder)
        : indexPack(l.pack, l.folder);
    }),
  );
}

export interface BdsRunOptions {
  channel?: Channel;
  /** Use this install instead of resolving one for the channel. */
  install?: BdsInstall;
  acceptEula?: boolean;
  /** level.dat experiments; default `["gametest"]` (Beta APIs). */
  experiments?: string[];
  /** Keep the instance directory (and a Regolith build dir) for inspection. */
  keep?: boolean;
  /** rgl binary for Regolith builds; default: found on `~/.local/bin`, `~/.rgl/bin` or PATH. */
  rglPath?: string;
  log?: (line: string) => void;
}

export interface CheckOptions extends BdsRunOptions {
  /** Time to keep running after `Server started.` so late script errors surface. Default 8000. */
  settleMs?: number;
  startTimeoutMs?: number;
}

export interface CheckResult {
  diagnostics: Diagnostic[];
  /** Absent when no server ran (`build-failed`). */
  serverVersion?: string;
  durationMs: number;
  /** Console + content log of the run, kept after the instance is removed; absent when no server ran. */
  rawLogPath?: string;
  /** `build-failed`: the Regolith build failed, so BDS did not start. */
  status: "started" | "exited" | "timeout" | "build-failed";
  /** Instance dir when `keep` was set. */
  instanceDir?: string;
}

/** `[00] Name (id: uuid, version: 1.0.0) @ path` entries of the `Pack Stack -` console line. */
export function packStackIds(lines: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    if (!line.includes("Pack Stack")) continue;
    for (const m of line.matchAll(/\(id: ([0-9a-fA-F-]{36})/g)) ids.add(m[1]!.toLowerCase());
  }
  return ids;
}

const KEEP_RUN_LOGS = 100;

/** Write the run's console + content log to `dataDir('bds-runs', <id>.log)`; keeps the newest 100 logs. */
export async function writeRawLog(id: string, server: BdsServer, contentLog: string): Promise<string> {
  const dir = dataDir("bds-runs");
  const path = join(dir, `${id}.log`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${server.lines.map((l) => l.text).join("\n")}\n\n===== content log =====\n${contentLog}`);
  // Instance ids start with a UTC timestamp, so name order is age order.
  const logs = (await readdir(dir)).filter((n) => n.endsWith(".log")).sort();
  for (const old of logs.slice(0, Math.max(0, logs.length - KEEP_RUN_LOGS))) await rm(join(dir, old), { force: true });
  return path;
}

/** Instance for a project: resolve the install, template world, packs attached. */
export async function prepareInstance(
  project: ProjectPacks,
  opts: BdsRunOptions & { packMode?: "copy" | "symlink"; properties?: Record<string, string> },
): Promise<{ instance: BdsInstance; baseline: Set<string>; indexed: IndexedPack[] }> {
  const install = opts.install ?? (await resolveBds(opts.channel ?? "stable", { acceptEula: opts.acceptEula, log: opts.log }));
  const template = await ensureTemplate(install, opts.log);
  const instance = await createInstance({
    install,
    packs: project.loadable,
    templateWorld: template.worldDir,
    packMode: opts.packMode ?? "copy",
    experiments: opts.experiments,
    properties: opts.properties,
    id: newInstanceId(),
  });
  const indexed = await indexProject(project, instance.packs);
  return { instance, baseline: template.baseline, indexed };
}

/** Remove the Regolith build dir unless the run is kept. */
export async function disposeBuild(project: ProjectPacks, keep: boolean | undefined): Promise<void> {
  if (project.build && !keep) await rm(project.build.workDir, { recursive: true, force: true });
}

export async function bdsCheck(path: string, opts: CheckOptions = {}): Promise<CheckResult> {
  const t0 = Date.now();
  const project = await projectPacks(path, opts);
  if (project.failure) return { diagnostics: [...project.skipped, project.failure].sort(compareDiagnostics), durationMs: Date.now() - t0, status: "build-failed" };
  try {
    const { instance, baseline, indexed } = await prepareInstance(project, opts);
    try {
      opts.log?.(`BDS ${instance.install.version}: checking ${project.loadable.length} pack(s) in ${instance.dir}`);
      const run = await runOnce(instance, { settleMs: opts.settleMs ?? 8000, startTimeoutMs: opts.startTimeoutMs });
      const serverVersion = run.server.serverVersion ?? instance.install.version;
      const label = `BDS ${serverVersion}`;
      const diagnostics = [...project.skipped, ...entriesToDiagnostics(run.entries, indexed, { baseline, label })];
      if (run.status !== "started") {
        diagnostics.push({
          severity: "error",
          code: "bds.start-failed",
          message: `${label} did not start (${run.status}); console tail:\n${run.server.lines.slice(-30).map((l) => l.text).join("\n")}`,
          source: "bds",
        });
      } else {
        const stack = packStackIds(run.server.lines.map((l) => l.text));
        for (const p of indexed) {
          if (p.pack.kind !== "behavior" || stack.has(p.pack.uuid!.toLowerCase())) continue;
          diagnostics.push({
            severity: "error",
            code: "bds.pack-not-in-stack",
            message: `${label}: behavior pack "${p.pack.name ?? p.pack.uuid}" is attached to the world but missing from the pack stack (rejected at load)`,
            source: "bds",
            file: projectPath(p.pack, "manifest.json"),
          });
        }
      }
      diagnostics.sort(compareDiagnostics);
      const rawLogPath = await writeRawLog(instance.id, run.server, run.contentLog);
      const result: CheckResult = { diagnostics, serverVersion, durationMs: Date.now() - t0, rawLogPath, status: run.status };
      if (opts.keep) result.instanceDir = instance.dir;
      return result;
    } finally {
      if (!opts.keep) await disposeInstance(instance);
    }
  } finally {
    await disposeBuild(project, opts.keep);
  }
}
