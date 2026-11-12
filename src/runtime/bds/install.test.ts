import { describe, expect, it } from "vitest";
import { PrerequisiteError } from "../../core/errors.ts";
import { assertHostSupported, bdsPlatformFor, pickLink, serverExecutable, type BdsLink } from "./install.ts";

const links: BdsLink[] = [
  { channel: "stable", platform: "linux", version: "1.26.63.1", url: "https://x/bin-linux/bedrock-server-1.26.63.1.zip" },
  { channel: "stable", platform: "windows", version: "1.26.63.1", url: "https://x/bin-win/bedrock-server-1.26.63.1.zip" },
  { channel: "preview", platform: "linux", version: "1.26.70.23", url: "https://x/bin-linux-preview/bedrock-server-1.26.70.23.zip" },
  { channel: "preview", platform: "windows", version: "1.26.70.23", url: "https://x/bin-win-preview/bedrock-server-1.26.70.23.zip" },
];

describe("BDS host platform", () => {
  it("maps x64 Linux and Windows hosts to their server build", () => {
    expect(bdsPlatformFor("linux", "x64")).toBe("linux");
    expect(bdsPlatformFor("win32", "x64")).toBe("windows");
  });

  it("has no server for macOS or non-x64 hosts", () => {
    expect(bdsPlatformFor("darwin", "arm64")).toBeUndefined();
    expect(bdsPlatformFor("darwin", "x64")).toBeUndefined();
    expect(bdsPlatformFor("linux", "arm64")).toBeUndefined();
    expect(bdsPlatformFor("win32", "arm64")).toBeUndefined();
  });

  it("raises a prerequisite error (exit 2) on unsupported hosts", () => {
    expect(assertHostSupported("win32", "x64")).toBe("windows");
    let err: unknown;
    try {
      assertHostSupported("darwin", "arm64");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PrerequisiteError);
    expect((err as PrerequisiteError).exitCode).toBe(2);
    expect((err as Error).message).toMatch(/darwin-arm64.*linux\/amd64 container/s);
  });

  it("picks the download link for the channel and host", () => {
    expect(pickLink(links, "stable", "linux")?.url).toContain("bin-linux/");
    expect(pickLink(links, "stable", "windows")?.url).toContain("bin-win/");
    expect(pickLink(links, "preview", "windows")?.url).toContain("bin-win-preview/");
    expect(pickLink(links.slice(0, 1), "preview", "linux")).toBeUndefined();
  });

  it("names the server executable per platform", () => {
    expect(serverExecutable("linux")).toBe("bedrock_server");
    expect(serverExecutable("windows")).toBe("bedrock_server.exe");
  });
});
