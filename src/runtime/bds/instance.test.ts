import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataDir } from "../../core/paths.ts";
import type { BdsInstall } from "./install.ts";
import { claimSlot, createInstance, dirLinkType, disposeInstance, keepInstance, releaseSlot, setProperties, slotDir } from "./instance.ts";

describe("server.properties", () => {
  it("rewrites and appends server.properties keys", () => {
    expect(setProperties("a=1\n# c\nb=2", { b: "3", d: "4" })).toBe("a=1\n# c\nb=3\nd=4");
  });
});

describe("dirLinkType", () => {
  it("uses junctions on Windows (no admin or Developer Mode needed)", () => {
    expect(dirLinkType("win32")).toBe("junction");
    expect(dirLinkType("linux")).toBe("dir");
    expect(dirLinkType("darwin")).toBe("dir");
  });
});

describe("instance slots", () => {
  let dir: string;
  let savedData: string | undefined;
  let install: BdsInstall;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sculkwire-slots-"));
    savedData = process.env.SCULKWIRE_DATA;
    process.env.SCULKWIRE_DATA = join(dir, "data");
    const server = join(dir, "server");
    await mkdir(join(server, "behavior_packs"), { recursive: true });
    await writeFile(join(server, "server.properties"), "server-name=Dedicated Server\nserver-port=19132\n");
    await writeFile(join(server, "bedrock_server"), "");
    install = { channel: "stable", version: "1.0.0", dir: server };
  });

  afterEach(async () => {
    if (savedData === undefined) delete process.env.SCULKWIRE_DATA;
    else process.env.SCULKWIRE_DATA = savedData;
    await rm(dir, { recursive: true, force: true });
  });

  /** The pid of a process that has exited. */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", ""]);
    return child.pid;
  }

  it("takes the lowest free slot, the next one while it is held, and the same one again once released", async () => {
    const first = await claimSlot();
    const second = await claimSlot();
    expect([first.n, second.n]).toEqual([0, 1]);
    await releaseSlot(first);
    const third = await claimSlot();
    expect(third.n).toBe(0);
    await releaseSlot(second);
    await releaseSlot(third);
  });

  it("gives concurrent claims distinct slots", async () => {
    const claims = await Promise.all([claimSlot(), claimSlot(), claimSlot(), claimSlot()]);
    expect(claims.map((c) => c.n).sort()).toEqual([0, 1, 2, 3]);
    for (const c of claims) await releaseSlot(c);
  });

  it("takes over a slot whose owner died and removes its leftover folder", async () => {
    await mkdir(slotDir(0), { recursive: true });
    await writeFile(join(slotDir(0), "leftover.txt"), "from a crashed run");
    await writeFile(dataDir("bds-instances", "slot-0.lock"), JSON.stringify({ pid: deadPid(), token: "dead" }));
    const claim = await claimSlot();
    expect(claim.n).toBe(0);
    expect(existsSync(join(slotDir(0), "leftover.txt"))).toBe(false);
    expect(JSON.parse(await readFile(dataDir("bds-instances", "slot-0.lock"), "utf8"))).toEqual({ pid: process.pid, token: claim.token });
    await releaseSlot(claim);
  });

  it("keeps a slot marked kept taken while its folder exists", async () => {
    await mkdir(slotDir(0), { recursive: true });
    await writeFile(dataDir("bds-instances", "slot-0.lock"), JSON.stringify({ pid: deadPid(), token: "kept", kept: true }));
    const busy = await claimSlot();
    expect(busy.n).toBe(1);
    await rm(slotDir(0), { recursive: true });
    const freed = await claimSlot();
    expect(freed.n).toBe(0);
    await releaseSlot(busy);
    await releaseSlot(freed);
  });

  it("runs consecutive instances in the same slot folder with different ids", async () => {
    const a = await createInstance({ install, noWorld: true });
    await disposeInstance(a);
    const b = await createInstance({ install, noWorld: true });
    await disposeInstance(b);
    expect(a.dir).toBe(slotDir(0));
    expect(b.dir).toBe(slotDir(0));
    expect(a.id).not.toBe(b.id);
    expect(existsSync(slotDir(0))).toBe(false);
  });

  it("runs concurrent instances in distinct slots", async () => {
    const [a, b] = await Promise.all([createInstance({ install, noWorld: true }), createInstance({ install, noWorld: true })]);
    expect([a.dir, b.dir].sort()).toEqual([slotDir(0), slotDir(1)]);
    await disposeInstance(a);
    await disposeInstance(b);
  });

  it("moves a kept instance to its id folder and frees the slot", async () => {
    const instance = await createInstance({ install, noWorld: true });
    const kept = await keepInstance(instance);
    expect(kept).toEqual({ dir: dataDir("bds-instances", instance.id) });
    expect(await readFile(join(kept.dir, "server.properties"), "utf8")).toContain(`server-name=sculkwire ${instance.id}`);
    expect(existsSync(slotDir(0))).toBe(false);
    const next = await claimSlot();
    expect(next.n).toBe(0);
    await releaseSlot(next);
  });
});
