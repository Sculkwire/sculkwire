import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configDir, xdgDataHome } from "./paths.ts";

afterEach(() => vi.unstubAllEnvs());

describe("XDG base directories", () => {
  it("uses the variable when set and the home default when unset or empty, as the XDG spec says", () => {
    expect(xdgDataHome({ XDG_DATA_HOME: "/data" }, "/home/u")).toBe("/data");
    expect(xdgDataHome({}, "/home/u")).toBe(join("/home/u", ".local", "share"));
    expect(xdgDataHome({ XDG_DATA_HOME: "" }, "/home/u")).toBe(join("/home/u", ".local", "share"));
  });

  it.skipIf(process.platform === "win32")("treats an empty XDG_CONFIG_HOME as unset", () => {
    vi.stubEnv("SCULKWIRE_CONFIG", undefined);
    vi.stubEnv("XDG_CONFIG_HOME", "");
    expect(configDir()).not.toBe("sculkwire");
    expect(configDir().endsWith(join(".config", "sculkwire"))).toBe(true);
  });
});
