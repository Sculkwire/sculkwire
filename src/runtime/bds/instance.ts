/**
 * Disposable BDS instances under `dataDir('bds-instances', id)`: the install's read-only content is linked,
 * mutable files are copied, and a world (from a per-version template, experiments set in level.dat) gets the
 * packs attached through `world_behavior_packs.json` / `world_resource_packs.json`.
 */
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { copyFile, cp, link, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import type { PackInfo } from "../../core/project.ts";
import { dataDir } from "../../core/paths.ts";
import type { BdsInstall } from "./install.ts";
import { enableExperiments, readLevelDat, writeLevelDat } from "./nbt.ts";

/** Files the server writes or we rewrite: copied, never linked (a hardlink would modify the install). */
const COPY_FILES: Record<string, true> = { "server.properties": true, "allowlist.json": true, "permissions.json": true };
/** Install entries an instance must not share. */
const SKIP: Record<string, true> = {
  worlds: true,
  logs: true,
  "console.log": true,
  ".sculkwire-bds.json": true,
  "test_config.json": true,
};
export const DEFAULT_LEVEL = "sculkwire";

export interface LoadedPack {
  pack: PackInfo;
  /** Folder name inside the world's `behavior_packs/` or `resource_packs/`. */
  folder: string;
  /** Absolute path of the pack inside the instance world. */
  worldPath: string;
}

export interface InstanceOptions {
  install: BdsInstall;
  packs?: PackInfo[];
  /** `symlink` keeps the world pointing at live pack sources (for reload); `copy` freezes them. */
  packMode?: "copy" | "symlink";
  /** level.dat experiment keys to enable; `gametest` is Beta APIs. Default `["gametest"]`. */
  experiments?: string[];
  /** Extra / overriding server.properties entries. */
  properties?: Record<string, string>;
  /** Start from an existing world folder instead of the template (template used when absent). */
  templateWorld?: string;
  /** Without a template world (first run), let BDS generate a fresh world. */
  noWorld?: boolean;
  id?: string;
}

export interface BdsInstance {
  id: string;
  dir: string;
  levelName: string;
  worldDir: string;
  port: number;
  portV6: number;
  packs: LoadedPack[];
  install: BdsInstall;
}

/** A free UDP port on loopback (BDS listens on UDP). */
export async function freeUdpPort(): Promise<number> {
  const sock = createSocket("udp4");
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  sock.once("error", reject);
  sock.bind(0, "0.0.0.0", () => {
    const { port } = sock.address();
    sock.close(() => resolve(port));
  });
  return promise;
}

/** A free TCP port on loopback (the script debugger listens on TCP). */
export async function freeTcpPort(): Promise<number> {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    server.close(() => resolve(port));
  });
  return promise;
}

export function newInstanceId(): string {
  return `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
}

/** Rewrite `key=value` lines of server.properties, appending keys that are absent. */
export function setProperties(text: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values));
  const lines = text.split(/\r?\n/).map((line) => {
    const m = /^([A-Za-z0-9_.-]+)=/.exec(line);
    if (m?.[1] && pending.has(m[1])) {
      const v = pending.get(m[1])!;
      pending.delete(m[1]);
      return `${m[1]}=${v}`;
    }
    return line;
  });
  for (const [k, v] of pending) lines.push(`${k}=${v}`);
  return lines.join("\n");
}

/**
 * `fs.symlink` type for a directory link: Windows symlinks need admin or Developer Mode, junctions do not
 * (junction targets must be absolute local paths, which ours are).
 */
export function dirLinkType(platform: NodeJS.Platform): "dir" | "junction" {
  return platform === "win32" ? "junction" : "dir";
}

/** Link directory `src` at `dst`; copy it when the filesystem refuses links. */
export async function linkDir(src: string, dst: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  try {
    await symlink(src, dst, dirLinkType(platform));
  } catch {
    await cp(src, dst, { recursive: true });
  }
}

async function linkInstall(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (SKIP[entry.name]) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) await linkDir(src, dst);
    else if (COPY_FILES[entry.name]) await copyFile(src, dst);
    else {
      try {
        await link(src, dst);
      } catch {
        await copyFile(src, dst);
      }
    }
  }
}

function packVersion(pack: PackInfo): number[] {
  return (pack.version ?? "1.0.0").split(".").map((n) => Number(n) || 0);
}

export async function createInstance(opts: InstanceOptions): Promise<BdsInstance> {
  const id = opts.id ?? newInstanceId();
  const dir = dataDir("bds-instances", id);
  await rm(dir, { recursive: true, force: true });
  await linkInstall(opts.install.dir, dir);

  const port = await freeUdpPort();
  let portV6 = await freeUdpPort();
  while (portV6 === port) portV6 = await freeUdpPort();
  const levelName = DEFAULT_LEVEL;
  const props = setProperties(await readFile(join(dir, "server.properties"), "utf8"), {
    "server-name": `sculkwire ${id}`,
    "level-name": levelName,
    "level-type": "FLAT",
    gamemode: "creative",
    "allow-cheats": "true",
    "allow-list": "false",
    "online-mode": "false",
    "server-port": String(port),
    "server-portv6": String(portV6),
    "server-udp-ports": String(port),
    "enable-lan-visibility": "false",
    "content-log-file-enabled": "true",
    "content-log-console-output-enabled": "true",
    "content-log-level": "info",
    "allow-inbound-script-debugging": "true",
    "allow-outbound-script-debugging": "true",
    "emit-server-telemetry": "false",
    ...opts.properties,
  });
  await writeFile(join(dir, "server.properties"), props);

  const worldDir = join(dir, "worlds", levelName);
  await mkdir(join(dir, "worlds"), { recursive: true });
  if (!opts.noWorld) {
    const template = opts.templateWorld;
    if (!template) throw new Error("createInstance: templateWorld is required unless noWorld is set");
    await cp(template, worldDir, { recursive: true });
    const levelDat = join(worldDir, "level.dat");
    const level = readLevelDat(await readFile(levelDat));
    enableExperiments(level.root, opts.experiments ?? ["gametest"]);
    await writeFile(levelDat, writeLevelDat(level));
  }

  const packs: LoadedPack[] = [];
  const bp: { pack_id: string; version: number[] }[] = [];
  const rp: { pack_id: string; version: number[] }[] = [];
  for (const [i, pack] of (opts.packs ?? []).entries()) {
    if ((pack.kind !== "behavior" && pack.kind !== "resource") || !pack.uuid) continue;
    const sub = pack.kind === "behavior" ? "behavior_packs" : "resource_packs";
    const folder = `${i}_${basename(pack.dir).replace(/[^\w.-]+/g, "_")}`;
    const worldPath = join(worldDir, sub, folder);
    await mkdir(join(worldDir, sub), { recursive: true });
    if (opts.packMode === "symlink") await symlink(resolve(pack.dir), worldPath, dirLinkType(process.platform));
    else await cp(pack.dir, worldPath, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules)$/.test(src) });
    packs.push({ pack, folder, worldPath });
    (pack.kind === "behavior" ? bp : rp).push({ pack_id: pack.uuid, version: packVersion(pack) });
  }
  if (!opts.noWorld || packs.length > 0) {
    await mkdir(worldDir, { recursive: true });
    await writeFile(join(worldDir, "world_behavior_packs.json"), JSON.stringify(bp, null, 2));
    await writeFile(join(worldDir, "world_resource_packs.json"), JSON.stringify(rp, null, 2));
  }
  return { id, dir, levelName, worldDir, port, portV6, packs, install: opts.install };
}

/** Content log files the server wrote (`logs/ContentLog*.txt` and legacy root location). */
export async function contentLogFiles(instance: Pick<BdsInstance, "dir">): Promise<string[]> {
  const out: string[] = [];
  for (const sub of ["logs", ""]) {
    try {
      for (const name of await readdir(join(instance.dir, sub))) {
        if (/^ContentLog.*\.txt$/i.test(name)) out.push(join(instance.dir, sub, name));
      }
    } catch {
      // no such dir
    }
  }
  return out;
}

export async function disposeInstance(instance: Pick<BdsInstance, "dir">): Promise<void> {
  await rm(instance.dir, { recursive: true, force: true });
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
