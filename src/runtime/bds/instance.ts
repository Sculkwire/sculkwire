/**
 * Disposable BDS instances. An instance runs in the lowest free numbered slot, `dataDir('bds-instances', 'slot-<n>')`,
 * held through the lock file `slot-<n>.lock` beside it; a kept instance moves out of its slot to
 * `dataDir('bds-instances', <id>)` after its server has stopped. The install's read-only content is linked, mutable
 * files are copied, and a world (from a per-version template, experiments set in level.dat) gets the packs attached
 * through `world_behavior_packs.json` / `world_resource_packs.json`.
 */
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { existsSync } from "node:fs";
import { copyFile, cp, link, mkdir, open, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "../../core/errors.ts";
import { writeFileAtomic } from "../../core/fs.ts";
import type { PackInfo } from "../../core/project.ts";
import { dataDir } from "../../core/paths.ts";
import type { BdsInstall } from "./install.ts";
import { enableExperiments, readLevelDat, writeLevelDat } from "../../gamefiles/nbt.ts";
import { CONSOLE_LOG, INSTALL_MARKER, LOGS_DIR, TEST_CONFIG } from "./files.ts";

/** Files the server writes or we rewrite: copied, never linked (a hardlink would modify the install). */
const COPY_FILES: Record<string, true> = { "server.properties": true, "allowlist.json": true, "permissions.json": true };
/** Install entries an instance must not share. */
const SKIP = new Set(["worlds", LOGS_DIR, CONSOLE_LOG, INSTALL_MARKER, TEST_CONFIG]);
const LEVEL_NAME = "sculkwire";

/**
 * Folder of instance slot `n`. Instances run in numbered slots, so `bedrock_server.exe` keeps the same path from
 * run to run: Windows Firewall keys its rules and its prompt on the program path, and a new path asks again.
 */
export function slotDir(n: number): string {
  return dataDir("bds-instances", `slot-${n}`);
}

/** Lock file of slot `n`, beside its folder. */
function slotLock(n: number): string {
  return dataDir("bds-instances", `slot-${n}.lock`);
}

/** A held slot: its number and the token written into its lock file, so only the owner releases it. */
export interface SlotClaim {
  n: number;
  token: string;
}

/**
 * Content of a slot lock. `kept` marks a kept instance whose folder could not be moved out of the slot: the slot
 * stays taken while that folder exists, whatever happens to the process that kept it.
 */
interface SlotLock {
  pid: number;
  token: string;
  kept?: boolean;
}

/** An unreadable lock younger than this may be one another process has created and not written yet. */
const LOCK_WRITE_GRACE_MS = 10_000;

function parseLock(text: string): SlotLock | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== "object" || !("pid" in v) || !("token" in v)) return undefined;
    if (typeof v.pid !== "number" || typeof v.token !== "string") return undefined;
    return { pid: v.pid, token: v.token, ...("kept" in v && v.kept === true ? { kept: true } : {}) };
  } catch {
    return undefined;
  }
}

/** Whether process `pid` runs. EPERM means it runs under another user. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * State of an existing slot lock: `held` while its owner runs (or its kept folder exists), `gone` when it was
 * released in the meantime, else stale with the token it holds (undefined for an unreadable lock).
 */
async function lockState(n: number, path: string): Promise<"held" | "gone" | { token: string | undefined }> {
  let text: string;
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    return "held";
  }
  const lock = parseLock(text);
  if (!lock) return Date.now() - mtimeMs >= LOCK_WRITE_GRACE_MS ? { token: undefined } : "held";
  if (lock.kept) return existsSync(slotDir(n)) ? "held" : { token: lock.token };
  return alive(lock.pid) ? "held" : { token: lock.token };
}

/**
 * Remove a stale lock. The lock is first renamed to a unique name, which only one of several stealers can do. When the
 * renamed lock is not the stale one that was read (another process stole that one and claimed the slot in between),
 * it is linked back, which fails when a newer lock exists already.
 */
async function stealLock(path: string, staleToken: string | undefined): Promise<void> {
  const aside = `${path}.stale-${randomBytes(6).toString("hex")}`;
  try {
    await rename(path, aside);
  } catch {
    return;
  }
  const moved = parseLock(await readFile(aside, "utf8").catch(() => ""));
  if (moved?.token !== staleToken) await link(aside, path).catch(() => undefined);
  await rm(aside, { force: true });
}

/** Try to take slot `n`: undefined when it is busy. A taken slot's leftover folder is removed. */
async function tryClaimSlot(n: number): Promise<SlotClaim | undefined> {
  const path = slotLock(n);
  const claim: SlotClaim = { n, token: randomBytes(8).toString("hex") };
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    try {
      handle = await open(path, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const state = await lockState(n, path);
      if (state === "held") return undefined;
      if (state !== "gone") await stealLock(path, state.token);
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token: claim.token } satisfies SlotLock));
    } catch (err) {
      await handle.close();
      await rm(path, { force: true });
      throw err;
    }
    await handle.close();
    try {
      await rm(slotDir(n), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // On Windows a server orphaned by a dead owner keeps its executable locked: the slot stays busy until it exits.
      await releaseSlot(claim);
      return undefined;
    }
    return claim;
  }
  return undefined;
}

/**
 * Take the lowest free slot. A slot is free when it has no lock, or when its lock is stale: the owner process has
 * died, or the kept folder it marks is gone. The lock is created exclusively, so two owners never share a slot, in
 * one process or across processes sharing the data dir.
 */
export async function claimSlot(): Promise<SlotClaim> {
  await mkdir(dataDir("bds-instances"), { recursive: true });
  for (let n = 0; ; n++) {
    const claim = await tryClaimSlot(n);
    if (claim) return claim;
  }
}

/** Give up a slot. Only the lock this claim wrote is removed. */
export async function releaseSlot(claim: SlotClaim): Promise<void> {
  const path = slotLock(claim.n);
  const lock = parseLock(await readFile(path, "utf8").catch(() => ""));
  if (lock?.token === claim.token) await rm(path, { force: true });
}

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
  /** Unique, starts with a UTC timestamp. Names the run's raw log and, when kept, the instance folder. */
  id: string;
  /** The slot folder the server runs in. */
  dir: string;
  slot: SlotClaim;
  worldDir: string;
  port: number;
  packs: LoadedPack[];
  install: BdsInstall;
}

/** A free UDP port on loopback (BDS listens on UDP). */
export async function freeUdpPort(): Promise<number> {
  const sock = createSocket("udp4");
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  sock.once("error", reject);
  sock.bind(0, "127.0.0.1", () => {
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
    if (SKIP.has(entry.name)) continue;
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
  const slot = await claimSlot();
  const dir = slotDir(slot.n);
  try {
    return await fillInstance(opts, id, slot, dir);
  } catch (err) {
    await disposeInstance({ dir, slot }).catch(() => undefined);
    throw err;
  }
}

async function fillInstance(opts: InstanceOptions, id: string, slot: SlotClaim, dir: string): Promise<BdsInstance> {
  await linkInstall(opts.install.dir, dir);

  const port = await freeUdpPort();
  let portV6 = await freeUdpPort();
  while (portV6 === port) portV6 = await freeUdpPort();
  const props = setProperties(await readFile(join(dir, "server.properties"), "utf8"), {
    "server-name": `sculkwire ${id}`,
    "level-name": LEVEL_NAME,
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

  const worldDir = join(dir, "worlds", LEVEL_NAME);
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
  return { id, dir, slot, worldDir, port, packs, install: opts.install };
}

/** Content log files the server wrote (`logs/ContentLog*.txt` and legacy root location). */
export async function contentLogFiles(instance: Pick<BdsInstance, "dir">): Promise<string[]> {
  const out: string[] = [];
  for (const sub of [LOGS_DIR, ""]) {
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

/**
 * Removes the instance folder and releases its slot. Windows keeps a process's executable locked for a moment after
 * the process has exited, so removing the folder of a server that just stopped can fail with EBUSY: the removal is
 * retried. The slot is released even when the removal fails; the next claim of the slot tries again.
 */
export async function disposeInstance(instance: Pick<BdsInstance, "dir" | "slot">): Promise<void> {
  try {
    await rm(instance.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } finally {
    await releaseSlot(instance.slot);
  }
}

/** Errors a rename of a just-stopped server's folder can give on Windows while the executable is still locked. */
const LOCKED_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

async function renameRetrying(from: string, to: string, tries = 10): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (attempt >= tries || !LOCKED_CODES.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
      await sleep(100 * attempt);
    }
  }
}

export interface KeptInstance {
  /** Where the kept instance is now. */
  dir: string;
  /** Set when the folder could not be moved out of its slot: why, and that the slot stays taken. */
  note?: string;
}

/**
 * Keep a stopped instance: move its folder out of the slot to `dataDir('bds-instances', <id>)` and release the slot.
 * The move is a rename, which keeps every link: the install's folders are linked by absolute path, files are hard
 * links, and packs are copies or links to absolute paths outside the instance; nothing links into the instance itself.
 * When the move fails, the folder stays in the slot and the lock is marked kept, so the slot stays taken until the
 * folder is deleted.
 */
export async function keepInstance(instance: Pick<BdsInstance, "id" | "dir" | "slot">): Promise<KeptInstance> {
  const target = dataDir("bds-instances", instance.id);
  try {
    await rm(target, { recursive: true, force: true });
    await renameRetrying(instance.dir, target);
  } catch (err) {
    const lock: SlotLock = { pid: process.pid, token: instance.slot.token, kept: true };
    await writeFileAtomic(slotLock(instance.slot.n), JSON.stringify(lock));
    return {
      dir: instance.dir,
      note: `could not move the kept instance to ${target} (${errorMessage(err)}); it stays in ${instance.dir}, and that slot stays taken until the folder is deleted`,
    };
  }
  await releaseSlot(instance.slot);
  return { dir: target };
}
