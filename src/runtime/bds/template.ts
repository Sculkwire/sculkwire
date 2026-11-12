/**
 * Per-BDS-version template world and baseline, under `dataDir('bds-templates', <version>)`:
 * `world/` is a world BDS generated once (packs are attached per instance, experiments set per instance), and
 * `baseline.json` lists the warnings/errors a pack-less server with Beta APIs prints, to subtract from checks.
 */
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../../core/paths.ts";
import type { BdsInstall } from "./install.ts";
import { exists } from "../../core/fs.ts";
import { entryKey } from "../gamelog/logparse.ts";
import { createInstance, disposeInstance } from "./instance.ts";
import { collectLogs, runOnce } from "./run.ts";

export interface Template {
  worldDir: string;
  baseline: Set<string>;
}

const pending = new Map<string, Promise<Template>>();

async function build(install: BdsInstall, dir: string, log: (line: string) => void): Promise<Template> {
  log(`generating BDS ${install.version} template world (one-time)`);
  const tmp = `${dir}.tmp-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const fresh = await createInstance({ install, noWorld: true });
  try {
    const run = await runOnce(fresh, { settleMs: 1000 });
    if (run.status !== "started") {
      throw new Error(`BDS ${install.version} did not start (${run.status}):\n${run.server.tail()}`);
    }
    await cp(fresh.worldDir, join(tmp, "world"), { recursive: true });
    for (const f of ["world_behavior_packs.json", "world_resource_packs.json"]) await rm(join(tmp, "world", f), { force: true });
  } finally {
    await disposeInstance(fresh);
  }
  const base = await createInstance({ install, templateWorld: join(tmp, "world") });
  try {
    const run = await runOnce(base, { settleMs: 3000 });
    const { entries } = await collectLogs(base, run.server);
    const keys = [...new Set(entries.filter((e) => e.severity !== "info").map(entryKey))].sort();
    await writeFile(join(tmp, "baseline.json"), JSON.stringify(keys, null, 2));
  } finally {
    await disposeInstance(base);
  }
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  return load(dir);
}

async function load(dir: string): Promise<Template> {
  const keys = JSON.parse(await readFile(join(dir, "baseline.json"), "utf8")) as string[];
  return { worldDir: join(dir, "world"), baseline: new Set(keys) };
}

/** Template for the install, generated on first use (one pack-less run to create, one to measure the baseline). */
export async function ensureTemplate(install: BdsInstall, log: (line: string) => void = () => {}): Promise<Template> {
  const dir = dataDir("bds-templates", install.version);
  if ((await exists(join(dir, "world", "level.dat"))) && (await exists(join(dir, "baseline.json")))) return load(dir);
  let p = pending.get(dir);
  if (!p) {
    p = build(install, dir, log).finally(() => pending.delete(dir));
    pending.set(dir, p);
  }
  return p;
}
