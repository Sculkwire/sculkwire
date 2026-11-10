import { describe, expect, it } from "vitest";
import { gamePath } from "./gamepath.ts";

describe("gamePath", () => {
  it("maps a host path to Wine's Z: drive on Linux", () => {
    expect(gamePath("/var/cache/sculkwire/agent/abc/sculkwire-agent-abc.dll", "linux")).toBe(
      "Z:\\var\\cache\\sculkwire\\agent\\abc\\sculkwire-agent-abc.dll",
    );
    expect(gamePath("/tmp/a/../b/shot.png", "linux")).toBe("Z:\\tmp\\b\\shot.png");
  });

  it("keeps the native path on Windows", () => {
    expect(gamePath("C:\\Users\\Steve\\AppData\\Local\\sculkwire\\cache\\agent\\abc\\x.dll", "win32")).toBe(
      "C:\\Users\\Steve\\AppData\\Local\\sculkwire\\cache\\agent\\abc\\x.dll",
    );
    expect(gamePath("D:/games/out/../shot.png", "win32")).toBe("D:\\games\\shot.png");
  });
});
