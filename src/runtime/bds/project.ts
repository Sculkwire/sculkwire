/**
 * A project on BDS: its packs as BDS loads them (a Regolith project whose profile runs filters is built with rgl
 * first: the source packs hold filter inputs, not what the game loads), and a disposable instance with them attached.
 */
import { rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Diagnostic } from "../../core/diagnostic.ts";
import { PrerequisiteError } from "../../core/errors.ts";
import { discoverProject, type PackInfo } from "../../core/project.ts";
import { buildRegolith, regolithPlan } from "../../core/regolith.ts";
import type { Channel } from "../../core/version.ts";
import { indexPack, projectPath, type IndexedPack } from "../gamelog/logparse.ts";
import { indexBuiltPack } from "./built.ts";
import { resolveBds, type BdsInstall } from "./install.ts";
import { createInstance, disposeInstance, newInstanceId, type BdsInstance } from "./instance.ts";
import { ensureTemplate } from "./template.ts";

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

/** A project's instance, ready to run: the packs it loads and what to subtract from its logs. */
export interface PreparedRun {
  project: ProjectPacks;
  instance: BdsInstance;
  /** Entry keys a pack-less server of this version prints anyway. */
  baseline: Set<string>;
  indexed: IndexedPack[];
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

export async function prepareInstance(
  project: ProjectPacks,
  opts: BdsRunOptions & { packMode?: "copy" | "symlink"; properties?: Record<string, string> },
): Promise<PreparedRun> {
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
  return { project, instance, baseline: template.baseline, indexed };
}

export async function disposeBuild(project: ProjectPacks, keep: boolean | undefined): Promise<void> {
  if (project.build && !keep) await rm(project.build.workDir, { recursive: true, force: true });
}

/** Remove the instance (when there is one) and the Regolith build, unless `keep`. */
export async function disposeRun(project: ProjectPacks, instance: BdsInstance | undefined, keep: boolean | undefined): Promise<void> {
  try {
    if (instance && !keep) await disposeInstance(instance);
  } finally {
    await disposeBuild(project, keep);
  }
}

/** Prepare an instance for `project`, run `body` on it, then dispose of the instance and the build unless `keep`. */
export async function withInstance<T>(
  project: ProjectPacks,
  opts: BdsRunOptions & { packMode?: "copy" | "symlink"; properties?: Record<string, string> },
  body: (run: PreparedRun) => Promise<T>,
): Promise<T> {
  let instance: BdsInstance | undefined;
  try {
    const run = await prepareInstance(project, opts);
    instance = run.instance;
    return await body(run);
  } finally {
    await disposeRun(project, instance, opts.keep);
  }
}
