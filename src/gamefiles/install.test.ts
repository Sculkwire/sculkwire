import { describe, expect, it } from "vitest";
import { splitCommand } from "./install.ts";

describe("splitCommand", () => {
  it("splits a launch command line with quotes", () => {
    expect(splitCommand(`flatpak run "com.example.Mc Launcher" --play {uri} ''`)).toEqual(["flatpak", "run", "com.example.Mc Launcher", "--play", "{uri}", ""]);
  });
});
