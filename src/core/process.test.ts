import { describe, expect, it } from "vitest";
import { run } from "./process.ts";

const node = process.execPath;

describe("run", () => {
  it("returns the exit code and both outputs, and hands stdin to the child", async () => {
    const script = "process.stdin.pipe(process.stdout); process.stderr.write('warn'); process.stdin.on('end', () => process.exit(3))";
    const r = await run(node, ["-e", script], { input: "hello" });
    expect(r).toMatchObject({ code: 3, stdout: "hello", stderr: "warn", timedOut: false });
    expect(r.output).toContain("hello");
    expect(r.output).toContain("warn");
    expect(r.startError).toBeUndefined();
  });

  it("kills a child that runs past its timeout", async () => {
    const r = await run(node, ["-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 200 });
    expect(r).toMatchObject({ code: null, timedOut: true });
  });

  it("keeps only the tail of a long output", async () => {
    const r = await run(node, ["-e", "process.stdout.write('a'.repeat(1000) + 'end')"], { maxOutput: 10 });
    expect(r.stdout).toBe("aaaaaaaend");
    expect(r.output).toBe("aaaaaaaend");
  });

  it("resolves with the reason when the command does not exist", async () => {
    const r = await run("sculkwire-no-such-command", []);
    expect(r.code).toBeNull();
    expect(r.startError).toBeInstanceOf(Error);
    expect(r.stderr).toMatch(/^sculkwire-no-such-command failed to start: /);
  });
});
