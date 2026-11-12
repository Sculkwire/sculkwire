import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_EXIT_GRACE_MS } from "./background.ts";

const CLI = join(import.meta.dirname, "..", "cli.ts");

describe("background work policy", () => {
  // A real process: the bound is about the event loop of a separate node process, which fake timers cannot drive.
  it("a CLI command exits within the grace period although a handle keeps the event loop alive", () => {
    const hang = "data:text/javascript,setInterval(() => {}, 1000)";
    const started = Date.now();
    const r = spawnSync(process.execPath, ["--import", hang, CLI, "--version"], { encoding: "utf8", timeout: 20_000 });
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).not.toBe("");
    expect(Date.now() - started).toBeLessThan(CLI_EXIT_GRACE_MS + 10_000);
  });
});
