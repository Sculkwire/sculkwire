/**
 * A project on BDS: its packs as BDS loads them (for a Regolith project whose profile runs filters, what rgl last
 * built: the source packs hold filter inputs, not what the game loads), and a disposable instance with them attached.
 */
import { relative, resolve } from "node:path";
import { compareDiagnostics, type Diagnostic } from "../../core/diagnostic.ts";
import { PrerequisiteError } from "../../core/errors.ts";
import { discoverProject, type PackInfo } from "../../core/project.ts";
import { RGL_NOT_BUILT, regolithOutput, regolithPlan } from "../../core/regolith.ts";
import type { Channel } from "../../core/version.ts";
import { indexPack, projectPath, type IndexedPack } from "../gamelog/logparse.ts";
import { indexBuiltPack } from "./built.ts";
import { resolveBds, type BdsInstall } from "./install.ts";
import { createInstance, disposeInstance, keepInstance, newInstanceId, type BdsInstance } from "./instance.ts";
import { ensureTemplate } from "./template.ts";

/** rgl's output the loadable packs come from. It belongs to the user: nothing here writes or deletes it. */
export interface PackBuild {
  profile: string;
  /** Source pack of each built pack dir (real path of rgl's output dir → source pack). */
  sources: Map<string, PackInfo>;
  /** The project's data folder (`regolith.dataPath`, absolute): the filters saw it as `.regolith/tmp/data`. */
  dataDir: string;
}

export interface ProjectPacks {
  root: string;
  /** Packs to load: rgl's output dirs for a filtered Regolith profile (`relDir` stays the source pack's), else the source dirs. */
  loadable: PackInfo[];
  /** Diagnostics for packs BDS cannot load (skin packs, world templates, packs without uuid/version). */
  skipped: Diagnostic[];
  build?: PackBuild;
  /** Set when rgl has not built a filtered profile (`regolith.not-built`); `loadable` is empty then and no server should start. */
  failure?: Diagnostic;
}

export interface BdsRunOptions {
  channel?: Channel;
  /** Use this install instead of resolving one for the channel. */
  install?: BdsInstall;
  acceptEula?: boolean;
  /** level.dat experiments; default `["gametest"]` (Beta APIs). */
  experiments?: string[];
  /** Keep the instance directory for inspection. */
  keep?: boolean;
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
 * The project's packs as BDS should load them. For a Regolith project whose profile runs filters the server loads
 * what rgl last built (`regolithOutput`); sculkwire does not run rgl. No output, or a source pack rgl's output has no
 * loadable pack for, gives `failure` instead of a silent fallback to the unbuilt source packs.
 */
export async function projectPacks(path: string, opts: { log?: (line: string) => void } = {}): Promise<ProjectPacks> {
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
      code: "regolith.not-built",
      message,
      source: "bds",
      file: config,
    },
  });
  const output = await regolithOutput(root);
  if (!output) return failure(RGL_NOT_BUILT);
  const builtDirs = new Map(output.outputs.map((o) => [resolve(o.source), o.built]));
  const packs: PackInfo[] = [];
  const sources = new Map<string, PackInfo>();
  const unbuilt: string[] = [];
  const configured = [layout.regolith.behaviorPack, layout.regolith.resourcePack].filter((d) => d !== undefined).map((d) => resolve(d));
  for (const pack of loadable) {
    const dir = builtDirs.get(resolve(pack.dir));
    if (!dir && !configured.includes(resolve(pack.dir))) {
      // Not one of the packs config.json names: rgl does not build it, so it is no part of what the game loads.
      skipped.push({
        severity: "warning",
        code: "bds.pack-not-loaded",
        message: `${pack.kind} pack is not one of the packs config.json names, so rgl does not build it and it is not loaded into BDS`,
        source: "bds",
        file: projectPath(pack, "manifest.json"),
      });
      continue;
    }
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
    return failure(
      `rgl's last output (.regolith/tmp) has no loadable pack (manifest with header uuid/version) for ${unbuilt.join(", ")}: ` +
        "run `rgl run`, or keep `rgl watch` running, first. sculkwire does not run rgl",
    );
  }
  if (!packs.length) return failure(RGL_NOT_BUILT);
  const when = output.builtAt ? `, built ${output.builtAt.toISOString()}` : "";
  opts.log?.(`Regolith profile ${plan.profile} runs filters: loading what rgl last built (${packs.map((p) => p.dir).join(", ")}${when})`);
  return { root, loadable: packs, skipped, build: { profile: plan.profile, sources, dataDir: output.dataDir } };
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
        ? indexBuiltPack(l.pack, source, project.root, project.build.dataDir, l.folder)
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

/** A kept instance after its run: the folder it ended in, and a warning when it could not leave its slot. */
export interface KeptRun {
  instanceDir: string;
  diagnostics: Diagnostic[];
}

/**
 * After the server has stopped: remove the instance, unless `keep`. A kept instance moves out of its slot
 * (`keepInstance`); the result says where it is. The packs it linked (the project's, or rgl's output) stay as they are.
 */
export async function disposeRun(instance: BdsInstance, keep: boolean | undefined): Promise<KeptRun | undefined> {
  if (!keep) {
    await disposeInstance(instance);
    return undefined;
  }
  const kept = await keepInstance(instance);
  const diagnostics: Diagnostic[] = kept.note ? [{ severity: "warning", code: "bds.instance-kept-in-slot", message: kept.note, source: "bds" }] : [];
  return { instanceDir: kept.dir, diagnostics };
}

/** `result` with the kept instance's folder and warnings added. */
export function withKept<T extends { diagnostics: Diagnostic[]; instanceDir?: string }>(result: T, kept: KeptRun | undefined): T {
  if (!kept) return result;
  return { ...result, instanceDir: kept.instanceDir, diagnostics: [...result.diagnostics, ...kept.diagnostics].sort(compareDiagnostics) };
}

/**
 * Prepare an instance for `project`, run `body` on it, then dispose of the instance unless `keep`. With
 * `keep`, the result's `instanceDir` is where the kept instance ended up.
 */
export async function withInstance<T extends { diagnostics: Diagnostic[]; instanceDir?: string }>(
  project: ProjectPacks,
  opts: BdsRunOptions & { packMode?: "copy" | "symlink"; properties?: Record<string, string> },
  body: (run: PreparedRun) => Promise<T>,
): Promise<T> {
  const run = await prepareInstance(project, opts);
  let result: T;
  let kept: KeptRun | undefined;
  try {
    result = await body(run);
  } finally {
    kept = await disposeRun(run.instance, opts.keep);
  }
  return withKept(result, kept);
}
