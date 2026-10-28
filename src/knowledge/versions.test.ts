import { describe, expect, it } from "vitest";
import { inVersionRange } from "./changelog.ts";
import { resolveModuleVersion } from "./typings.ts";
import { changelogTitleVersion, parseNpmVersion, pickNpmVersion } from "./versions.ts";

describe("parseNpmVersion", () => {
  it("maps beta-on-stable to the stable game build", () => {
    expect(parseNpmVersion("2.12.0-beta.1.26.63-stable")).toMatchObject({
      kind: "beta",
      game: "1.26.63",
      channel: "stable",
      base: [2, 12, 0],
    });
  });
  it("maps rc and beta preview builds to the preview game build", () => {
    expect(parseNpmVersion("2.12.0-rc.1.26.70-preview.23")).toMatchObject({
      kind: "rc",
      game: "1.26.70.23",
      channel: "preview",
    });
    expect(parseNpmVersion("2.13.0-beta.1.26.70-preview.23")).toMatchObject({
      kind: "beta",
      game: "1.26.70.23",
      channel: "preview",
    });
  });
  it("reads legacy four-part preview builds", () => {
    expect(parseNpmVersion("1.0.0-preview.1.19.60.22")).toMatchObject({ kind: "preview", game: "1.19.60.22" });
  });
  it("treats plain releases as untargeted and internal hashes as other", () => {
    expect(parseNpmVersion("2.11.0")).toEqual({ version: "2.11.0", base: [2, 11, 0], kind: "release" });
    expect(parseNpmVersion("1.0.0-beta.00001b37")?.kind).toBe("other");
    expect(parseNpmVersion("1.0.0-internal.00001b39")?.kind).toBe("other");
    expect(parseNpmVersion("1.0.0-beta.11940b24")?.kind).toBe("other");
  });
  it("reads vanilla-data versions as game versions", () => {
    expect(parseNpmVersion("1.26.60", true)).toMatchObject({ kind: "release", game: "1.26.60", channel: "stable" });
    expect(parseNpmVersion("1.26.70-preview.23", true)).toMatchObject({
      kind: "preview",
      game: "1.26.70.23",
      channel: "preview",
    });
  });
});

describe("pickNpmVersion", () => {
  const server = [
    "1.0.0-beta.00001b37",
    "2.10.0",
    "2.11.0",
    "2.12.0-beta.1.26.60-stable",
    "2.12.0-rc.1.26.70-preview.22",
    "2.13.0-beta.1.26.70-preview.22",
    "2.12.0-beta.1.26.63-stable",
    "2.12.0-rc.1.26.70-preview.23",
    "2.13.0-beta.1.26.70-preview.23",
    "2.12.0-beta.1.26.62-stable",
  ];
  const pick = (opts: Parameters<typeof pickNpmVersion>[1], versions = server) =>
    pickNpmVersion(versions, opts)?.version;

  it("picks per channel and beta flag", () => {
    expect(pick({ channel: "stable", beta: false })).toBe("2.11.0");
    expect(pick({ channel: "stable", beta: true })).toBe("2.12.0-beta.1.26.63-stable");
    expect(pick({ channel: "preview", beta: false, previewTarget: "1.26.70.23" })).toBe("2.12.0-rc.1.26.70-preview.23");
    expect(pick({ channel: "preview", beta: true, previewTarget: "1.26.70.23" })).toBe(
      "2.13.0-beta.1.26.70-preview.23",
    );
  });
  it("falls back to the stable release when the rc belongs to an older cycle", () => {
    const common = ["1.2.0", "1.3.0-rc.1.26.30-preview.26", "1.3.0"];
    expect(pick({ channel: "preview", beta: false, previewTarget: "1.26.70.23" }, common)).toBe("1.3.0");
  });
  it("uses betas when the latest dist-tag is not a plain release", () => {
    const gametest = ["0.1.0", "1.0.0-beta.1.26.63-stable", "1.0.0-beta.1.26.70-preview.23", "1.0.0-beta.00001b37"];
    const latest = "1.0.0-beta.1.21.60-preview.24";
    expect(pick({ channel: "stable", beta: false, latest }, gametest)).toBe("1.0.0-beta.1.26.63-stable");
    expect(pick({ channel: "preview", beta: false, previewTarget: "1.26.70.23", latest }, gametest)).toBe(
      "1.0.0-beta.1.26.70-preview.23",
    );
    expect(pick({ channel: "stable", beta: false, latest: "2.11.0" })).toBe("2.11.0");
  });
});

describe("resolveModuleVersion", () => {
  const versions = ["2.1.0", "2.4.0-beta.1.26.62-stable", "2.4.0-beta.1.26.63-stable", "2.4.0-beta.1.26.70-preview.23"];
  it("maps manifest module versions to npm builds for the channel", () => {
    expect(resolveModuleVersion(versions, "2.1.0", "stable")).toBe("2.1.0");
    expect(resolveModuleVersion(versions, "2.4.0-beta", "stable")).toBe("2.4.0-beta.1.26.63-stable");
    expect(resolveModuleVersion(versions, "2.4.0-beta", "preview")).toBe("2.4.0-beta.1.26.70-preview.23");
    expect(resolveModuleVersion(versions, "9.9.9", "stable")).toBeUndefined();
  });
});

describe("changelogTitleVersion", () => {
  it.each([
    ["Minecraft: Bedrock Edition 26.62 Hotfix Changelog", "1.26.62"],
    ["Minecraft: Bedrock Edition 26.50 Changelog - Wilderness Bound", "1.26.50"],
    ["Minecraft Beta & Preview - 26.70.23", "1.26.70.23"],
    ["Minecraft Beta & Preview - 1.21.40.25", "1.21.40.25"],
    ["Minecraft - 1.20.40 (Bedrock)", "1.20.40"],
    ["Minecraft - 1.2.13.60 / 1.2.16 iOS", "1.2.13.60"],
    ["MCPE/WIN 10/Gear VR - 1.0.2", "1.0.2"],
    ["Minecraft Beta - 1.2.20.1 (Xbox One/Windows 10/Android)", "1.2.20.1"],
  ])("%s → %s", (title, version) => {
    expect(changelogTitleVersion(title)).toBe(version);
  });
  it("skips Java Edition articles", () => {
    expect(changelogTitleVersion("Minecraft Java Edition - 26.3")).toBeUndefined();
    expect(changelogTitleVersion("Minecraft: Java Edition - 1.20.2")).toBeUndefined();
  });
});

describe("inVersionRange", () => {
  it("treats from as exclusive and to as inclusive at the bound's precision", () => {
    expect(inVersionRange("1.26.50", "1.26.50", "1.26.60")).toBe(false);
    expect(inVersionRange("1.26.51", "1.26.50", "1.26.60")).toBe(true);
    expect(inVersionRange("1.26.60", "1.26.50", "1.26.60")).toBe(true);
    expect(inVersionRange("1.26.62", "1.26.50", "1.26.60")).toBe(false);
    // A 1.26.70 preview build belongs to the 1.26.70 cycle.
    expect(inVersionRange("1.26.70.23", "1.26.60", "1.26.70")).toBe(true);
    expect(inVersionRange("1.26.60.30", "1.26.60", "1.26.70")).toBe(false);
    expect(inVersionRange("1.26.70.21", undefined, "1.26.70.20")).toBe(false);
  });
});
