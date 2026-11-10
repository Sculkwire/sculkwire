import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../../core/meta.ts";
import {
  AGENT_MEMBERS,
  AgentBuildError,
  buildAgent,
  buildWithCargo,
  cargoArtifacts,
  cargoBuildArgs,
  fetchPrebuiltAgent,
  findCargo,
  nativeRoot,
  nativeSourceHash,
  parseSha256,
  prebuiltName,
  prebuiltUrl,
  sha256Hex,
  verifySha256,
  type AgentSource,
} from "./build.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempRoot(prefix = "sculkwire-build-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function touch(path: string, content = "x"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** A stand-in release archive: the two members the driver unpacks and nothing else. */
function releaseZip(dll = "dll-bytes", injector = "injector-bytes"): Uint8Array {
  return zipSync({ [AGENT_MEMBERS[0]]: new TextEncoder().encode(dll), [AGENT_MEMBERS[1]]: new TextEncoder().encode(injector) });
}

describe("cargo build command", () => {
  it("builds the workspace for the Windows target from any OS", () => {
    expect(cargoBuildArgs()).toEqual(["build", "--release", "--locked", "--target", "x86_64-pc-windows-msvc"]);
    expect(cargoArtifacts("/repo/native", "linux")).toEqual({
      dll: "/repo/native/target/x86_64-pc-windows-msvc/release/sculkwire_agent.dll",
      injector: "/repo/native/target/x86_64-pc-windows-msvc/release/sculkwire-injector.exe",
    });
    expect(cargoArtifacts("C:\\repo\\native", "win32")).toEqual({
      dll: "C:\\repo\\native\\target\\x86_64-pc-windows-msvc\\release\\sculkwire_agent.dll",
      injector: "C:\\repo\\native\\target\\x86_64-pc-windows-msvc\\release\\sculkwire-injector.exe",
    });
  });

  it("finds cargo on PATH, else in the rustup user install", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const rustupCargo = touch(join(home, ".cargo", "bin", "cargo"));
    expect(findCargo({ HOME: home }, "linux", () => undefined)).toBe(rustupCargo);
    expect(findCargo({ HOME: home }, "win32", () => undefined)).toBeUndefined();
    expect(findCargo({ HOME: home, PATH: "/usr/bin" }, "linux", (name, env) => (env.PATH === "/usr/bin" && name === "cargo" ? "/usr/bin/cargo" : undefined))).toBe(
      "/usr/bin/cargo",
    );
  });

  it("keys the cache on the sources and ignores the build directory", async () => {
    const native = await tempRoot("sculkwire-native-");
    touch(join(native, "Cargo.toml"), "[workspace]\n");
    touch(join(native, "agent", "src", "lib.rs"), "fn main() {}\n");
    touch(join(native, "target", "release", "sculkwire_agent.dll"), "old");
    const first = nativeSourceHash(native);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    // Rebuilding does not change the key.
    touch(join(native, "target", "release", "sculkwire_agent.dll"), "newer");
    expect(nativeSourceHash(native)).toBe(first);
    touch(join(native, "agent", "src", "lib.rs"), "fn main() { todo!() }\n");
    expect(nativeSourceHash(native)).not.toBe(first);
    expect(nativeRoot()).toMatch(/native$/);
  });
});

describe("release archive", () => {
  it("names and locates the asset of the running version", () => {
    expect(prebuiltName("1.2.3")).toBe("sculkwire-agent-1.2.3-x86_64-windows.zip");
    expect(prebuiltUrl("1.2.3")).toBe("https://github.com/ve3dy/sculkwire/releases/download/v1.2.3/sculkwire-agent-1.2.3-x86_64-windows.zip");
    expect(prebuiltUrl()).toContain(`/v${VERSION}/`);
  });

  it("reads the published sha256 and refuses a mismatch", () => {
    const zip = releaseZip();
    const hex = sha256Hex(zip);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(parseSha256(hex)).toBe(hex);
    expect(parseSha256(`${hex}  sculkwire-agent-1.2.3-x86_64-windows.zip\n`)).toBe(hex);
    expect(parseSha256(`SHA256 (sculkwire-agent.zip) = ${hex.toUpperCase()}`)).toBe(hex);
    expect(parseSha256("no checksum here")).toBeUndefined();
    expect(() => verifySha256(zip, hex, "asset")).not.toThrow();
    expect(() => verifySha256(zip, "0".repeat(64), "asset")).toThrow(AgentBuildError);
    expect(() => verifySha256(zip, "0".repeat(64), "asset")).toThrow(/is corrupt: sha256/);
  });

  it("downloads, verifies and unpacks the archive into the version's cache directory", async () => {
    const root = await tempRoot();
    const zip = releaseZip();
    const calls: string[] = [];
    const fetchBytes = async (url: string): Promise<Uint8Array> => {
      calls.push(url);
      return url.endsWith(".sha256") ? new TextEncoder().encode(`${sha256Hex(zip)}  asset\n`) : zip;
    };
    const built = await fetchPrebuiltAgent({ cacheRoot: join(root, "cache"), platform: "linux", fetchBytes });
    expect(calls).toEqual([prebuiltUrl(), `${prebuiltUrl()}.sha256`]);
    expect(built).toMatchObject({ key: `prebuilt-${VERSION}`, source: "prebuilt", cached: false });
    expect(built.dir).toBe(join(root, "cache", `prebuilt-${VERSION}`));
    expect(built.dll).toBe(join(built.dir, AGENT_MEMBERS[0]));
    expect(await readFile(built.dll, "utf8")).toBe("dll-bytes");
    expect(await readFile(built.injector, "utf8")).toBe("injector-bytes");

    // The second call finds both files and never touches the network.
    const again = await fetchPrebuiltAgent({
      cacheRoot: join(root, "cache"),
      platform: "linux",
      fetchBytes: async () => {
        throw new Error("should not download again");
      },
    });
    expect(again).toMatchObject({ cached: true, source: "prebuilt" });
  });

  it("refuses a corrupt archive and leaves nothing behind", async () => {
    const root = await tempRoot();
    const cacheRoot = join(root, "cache");
    const fetchBytes = async (url: string): Promise<Uint8Array> =>
      url.endsWith(".sha256") ? new TextEncoder().encode("1".repeat(64)) : releaseZip();
    await expect(fetchPrebuiltAgent({ cacheRoot, platform: "linux", fetchBytes })).rejects.toThrow(/is corrupt/);
    await expect(fetchPrebuiltAgent({ cacheRoot, platform: "linux", fetchBytes })).rejects.toThrow(AgentBuildError);
    expect(existsSync(join(cacheRoot, `prebuilt-${VERSION}`))).toBe(false);
  });

  it("reports a missing download with what to do instead", async () => {
    const root = await tempRoot();
    await expect(
      fetchPrebuiltAgent({
        cacheRoot: join(root, "cache"),
        platform: "linux",
        fetchBytes: async () => {
          throw new Error("getaddrinfo ENOTFOUND github.com");
        },
      }),
    ).rejects.toThrow(/cannot download the prebuilt agent from .*ENOTFOUND.*SCULKWIRE_AGENT_DLL/);
  });
});

describe("agent resolution", () => {
  it("uses SCULKWIRE_AGENT_DLL and the injector beside it when both are set", async () => {
    const root = await tempRoot();
    const dll = touch(join(root, "override", "sculkwire_agent.dll"), "dll");
    touch(join(root, "override", "sculkwire-injector.exe"), "exe");
    const built = await buildAgent({ env: { SCULKWIRE_AGENT_DLL: dll }, platform: "linux" });
    expect(built).toEqual({
      key: "override",
      dir: join(root, "override"),
      dll,
      injector: join(root, "override", "sculkwire-injector.exe"),
      cached: true,
      source: "override",
    });
  });

  it("names the injected variable when an override is missing", async () => {
    const root = await tempRoot();
    const dll = touch(join(root, "dll", "sculkwire_agent.dll"), "dll");
    await expect(buildAgent({ env: { SCULKWIRE_AGENT_DLL: join(root, "absent.dll") }, platform: "linux" })).rejects.toThrow(
      /SCULKWIRE_AGENT_DLL does not exist/,
    );
    const injector = join(root, "elsewhere", "sculkwire-injector.exe");
    await expect(buildAgent({ env: { SCULKWIRE_AGENT_DLL: dll, SCULKWIRE_AGENT_INJECTOR: injector }, platform: "linux" })).rejects.toThrow(
      /SCULKWIRE_AGENT_INJECTOR does not exist/,
    );
    touch(injector, "exe");
    expect((await buildAgent({ env: { SCULKWIRE_AGENT_DLL: dll, SCULKWIRE_AGENT_INJECTOR: injector }, platform: "linux" })).injector).toBe(injector);
  });

  it("runs cargo in the crate root and copies both binaries to a hash-named DLL", async () => {
    const crate = await tempRoot("sculkwire-crate-");
    touch(join(crate, "Cargo.toml"), "[workspace]\n");
    touch(join(crate, "agent", "src", "lib.rs"), "fn main() {}\n");
    const cacheRoot = join(await tempRoot("sculkwire-cache-"), "cache");
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];
    const run = async (cmd: string, args: string[], cwd: string) => {
      calls.push({ cmd, args, cwd });
      const artifacts = cargoArtifacts(crate, "linux");
      touch(artifacts.dll, "fresh-dll");
      touch(artifacts.injector, "fresh-exe");
      return { code: 0, output: "Finished release", timedOut: false };
    };
    const built = await buildWithCargo(crate, "/opt/rust/bin/cargo", { cacheRoot, platform: "linux", run });
    expect(calls).toEqual([{ cmd: "/opt/rust/bin/cargo", args: cargoBuildArgs(), cwd: crate }]);
    expect(built).toMatchObject({ key: nativeSourceHash(crate), dir: join(cacheRoot, nativeSourceHash(crate)), cached: false, source: "cargo" });
    expect(built.dll).toBe(join(built.dir, `sculkwire-agent-${built.key}.dll`));
    expect(await readFile(built.dll, "utf8")).toBe("fresh-dll");
    expect(await readFile(built.injector, "utf8")).toBe("fresh-exe");
    // A second build of the same sources is a cache hit and never runs cargo again.
    const again = await buildWithCargo(crate, "/opt/rust/bin/cargo", {
      cacheRoot,
      platform: "linux",
      run: async () => {
        throw new Error("should not build again");
      },
    });
    expect(again).toMatchObject({ cached: true, source: "cargo" });
  });

  it("reports cargo's own words when the build fails", async () => {
    const crate = await tempRoot("sculkwire-crate-");
    touch(join(crate, "Cargo.toml"), "[workspace]\n");
    const run = async () => ({ code: 101, output: "error[E0308]: mismatched types", timedOut: false });
    await expect(buildWithCargo(crate, "cargo", { cacheRoot: join(await tempRoot("sculkwire-cache-"), "cache"), platform: "linux", run })).rejects.toThrow(
      /cargo build failed \(exit code 101\):\nerror\[E0308\]/,
    );
  });

  // The routing picks cargo only when this machine has it; `run` stops before anything is compiled.
  it.skipIf(findCargo() === undefined)("routes to the cargo build when the crate and cargo are both here", async () => {
    const cacheRoot = join(await tempRoot("sculkwire-cache-"), "cache");
    const options = {
      cacheRoot,
      platform: "linux" as const,
      // An empty env has no SCULKWIRE_AGENT_DLL, so the override route does not apply; the prebuilt route would
      // try to download instead.
      env: {},
      run: async () => {
        throw new Error("stop before compiling");
      },
    };
    await expect(buildAgent(options)).rejects.toThrow("stop before compiling");
  });
});

describe("extension agent sources", () => {
  /** One source that records whether it was asked to build, serving files under `root/<name>`. */
  function makeSource(name: string, matches: (gameDir: string) => boolean, root: string): AgentSource & { builds: number } {
    const source = {
      name,
      builds: 0,
      matches,
      build: async () => {
        source.builds += 1;
        return {
          dll: touch(join(root, name, `sculkwire-agent-${name}.dll`), name),
          injector: touch(join(root, name, "sculkwire-injector.exe"), "exe"),
          tag: "tag-1",
        };
      },
    };
    return source;
  }

  it("gives the DLL to the first registered source that matches the game folder", async () => {
    const root = await tempRoot();
    const gameDir = join(root, "game");
    const other = makeSource("other", (dir) => dir === join(root, "elsewhere"), root);
    const first = makeSource("first", (dir) => dir === gameDir, root);
    const second = makeSource("second", (dir) => dir === gameDir, root);
    const built = await buildAgent({ gameDir, sources: [other, first, second], platform: "linux" });
    expect(built).toMatchObject({
      key: "first:tag-1",
      dll: join(root, "first", "sculkwire-agent-first.dll"),
      injector: join(root, "first", "sculkwire-injector.exe"),
      source: "extension",
    });
    expect([other.builds, first.builds, second.builds]).toEqual([0, 1, 0]);
  });

  it("keeps the built-in route when no source matches, and when no game folder is given", async () => {
    const root = await tempRoot();
    const gameDir = join(root, "game");
    const dll = touch(join(root, "override", "sculkwire_agent.dll"), "dll");
    touch(join(root, "override", "sculkwire-injector.exe"), "exe");
    const source = makeSource("unused", (dir) => dir === gameDir, root);
    const env = { SCULKWIRE_AGENT_DLL: dll };
    expect(await buildAgent({ gameDir: join(root, "retail"), env, sources: [source], platform: "linux" })).toMatchObject({
      source: "override",
      dll,
    });
    expect(await buildAgent({ env, sources: [source], platform: "linux" })).toMatchObject({ source: "override", dll });
    expect(source.builds).toBe(0);
  });

  it("refuses a source whose paths do not exist", async () => {
    const root = await tempRoot();
    const source: AgentSource = {
      name: "broken",
      matches: () => true,
      build: async () => ({ dll: join(root, "absent.dll"), injector: join(root, "absent.exe"), tag: "t" }),
    };
    await expect(buildAgent({ gameDir: root, sources: [source], platform: "linux" })).rejects.toThrow(
      /broken returned a DLL that does not exist: .*absent\.dll/,
    );
  });

  it("hands the source the built-in agent for its injector", async () => {
    const root = await tempRoot();
    const dll = touch(join(root, "override", "sculkwire_agent.dll"), "dll");
    const injector = touch(join(root, "override", "sculkwire-injector.exe"), "exe");
    const seen: string[] = [];
    const source: AgentSource = {
      name: "injector-user",
      matches: () => true,
      build: async (options) => {
        const base = await options.builtIn();
        seen.push(`${base.source}:${options.platform}`);
        return { dll: touch(join(root, "mine", "mine.dll")), injector: base.injector, tag: "t" };
      },
    };
    const built = await buildAgent({
      gameDir: root,
      sources: [source],
      env: { SCULKWIRE_AGENT_DLL: dll },
      platform: "linux",
    });
    expect(seen).toEqual(["override:linux"]);
    expect(built.injector).toBe(injector);
  });
});
