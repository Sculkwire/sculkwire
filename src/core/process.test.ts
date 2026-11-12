import { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { run, runUnattended } from "./process.ts";

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

  // Real processes on the real clock: the timeout races a child process, which fake timers cannot drive.
  it("settles at the timeout while a grandchild still holds the pipes open", async () => {
    // The child hands its stdio to a detached sleeper, so the pipes stay open after the child itself is killed.
    const script = "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { detached: true, stdio: 'inherit' }).unref(); setTimeout(() => {}, 60_000)";
    const started = Date.now();
    const r = await run(node, ["-e", script], { timeoutMs: 500 });
    expect(r).toMatchObject({ code: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(runUnattended(node, ["-e", script], { timeoutMs: 500 })).rejects.toThrow(/timed out after/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("sends SIGKILL on a timeout unless told otherwise", async () => {
    const kill = vi.spyOn(ChildProcess.prototype, "kill");
    try {
      await run(node, ["-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 200 });
      await run(node, ["-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 200, killSignal: "SIGTERM" });
      expect(kill.mock.calls).toEqual([["SIGKILL"], ["SIGTERM"]]);
    } finally {
      kill.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("reports a signal-ended child as exit 1 when unattended", async () => {
    const r = await runUnattended(node, ["-e", "process.kill(process.pid, 'SIGKILL')"], { timeoutMs: 10_000 });
    expect(r.code).toBe(1);
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
