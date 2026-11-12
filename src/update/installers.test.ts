import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UPDATE_CHANNELS } from "./config.ts";
import { DEFAULT_REPO } from "./layout.ts";

// install.sh and install.ps1 cannot import TypeScript: they repeat the default repository and the update channels.
const scripts = ["install.sh", "install.ps1"].map((name) => ({ name, text: readFileSync(new URL(`../../${name}`, import.meta.url), "utf8") }));

describe.each(scripts)("$name", ({ text }) => {
  it("clones DEFAULT_REPO by default", () => {
    const urls = [...text.matchAll(/https:\/\/\S+?\.git\b/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toBe(DEFAULT_REPO);
  });

  it("offers exactly the update channels", () => {
    expect(text).toContain(UPDATE_CHANNELS.join("|"));
    const shCheck = `"" | ${UPDATE_CHANNELS.join(" | ")})`;
    const psCheck = `-notin "", ${UPDATE_CHANNELS.map((c) => `"${c}"`).join(", ")}`;
    expect(text.includes(shCheck) || text.includes(psCheck), "the channel value check").toBe(true);
  });
});
