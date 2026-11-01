import { createConnection, createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "./framing.ts";
import { connectTo, listen } from "./session.ts";

/** A fake game listening like BDS auto-attach=listen: announces its protocol, records what the debugger sends. */
async function fakeGame(version: number, requirePasscode = false) {
  const received: Record<string, unknown>[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  /** Resolves once the debugger has sent `n` messages in total. */
  const receivedCount = (n: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (received.length >= n) resolve();
    else waiters.push({ n, resolve });
    return promise;
  };
  let socket: Socket | undefined;
  const server = createServer((s) => {
    socket = s;
    const decoder = new FrameDecoder();
    s.on("data", (chunk: Buffer) => {
      received.push(...(decoder.push(chunk) as Record<string, unknown>[]));
      for (const w of waiters.filter((x) => received.length >= x.n)) w.resolve();
    });
    const announce = encodeFrame({
      type: "event",
      event: { type: "ProtocolEvent", version, require_passcode: requirePasscode, plugins: [{ name: "BP", module_uuid: "AAAA-1" }] },
    });
    // Split the frame to exercise reassembly on the debugger side.
    s.write(announce.subarray(0, 5));
    setImmediate(() => s.write(announce.subarray(5)));
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return { port, received, receivedCount, server, send: (m: unknown) => socket?.write(encodeFrame(m)) };
}

describe("DebuggerSession handshake", () => {
  it("answers with the game's version, target module and passcode, then resumes", async () => {
    const game = await fakeGame(11, true);
    const session = await connectTo("127.0.0.1", game.port, { passcode: "pw", timeoutMs: 2000 });
    expect(session.info).toMatchObject({ gameVersion: 11, version: 11, targetModuleUuid: "AAAA-1", requirePasscode: true });
    session.command("/say hi");
    const { promise, resolve } = Promise.withResolvers<void>();
    session.once("print", () => resolve());
    game.send({ type: "event", event: { type: "PrintEvent", message: "Error: x    at <anonymous> (main.js:4)\n\r", logLevel: 3 } });
    await promise;
    await game.receivedCount(4);
    expect(game.received[0]).toEqual({ type: "protocol", version: 11, target_module_uuid: "AAAA-1", passcode: "pw" });
    expect(game.received.map((m) => m.type)).toEqual(["protocol", "stopOnException", "resume", "minecraftCommand"]);
    expect(game.received[3]).toEqual({ type: "minecraftCommand", command: "say hi", dimension_type: "overworld" });
    expect(session.prints()).toMatchObject([{ seq: 1, level: "error", message: "Error: x    at <anonymous> (main.js:4)", location: { file: "main.js", line: 4 } }]);
    session.close();
    game.server.close();
  });

  it("caps the version at 11 and uses the nested command shape for protocol 5-7", async () => {
    const newer = await fakeGame(14);
    const s1 = await connectTo("127.0.0.1", newer.port, { timeoutMs: 2000 });
    expect(s1.info?.version).toBe(11);
    s1.close();
    newer.server.close();

    const old = await fakeGame(6);
    const s2 = await connectTo("127.0.0.1", old.port, { timeoutMs: 2000 });
    s2.command("list");
    await old.receivedCount(4);
    expect(old.received.at(-1)).toEqual({ type: "minecraftCommand", command: { command: "list", dimension_type: "overworld" } });
    expect(() => s2.setDiagnosticsActive(["x"], true)).toThrow(/protocol >= 11/);
    s2.close();
    old.server.close();
  });

  it("accepts a game that dials in", async () => {
    const listener = await listen(0);
    const game = createConnection({ host: "127.0.0.1", port: listener.port });
    game.on("connect", () => game.write(encodeFrame({ type: "event", event: { type: "ProtocolEvent", version: 11, plugins: [] } })));
    const session = await listener.accept(2000);
    expect(session.info).toMatchObject({ version: 11, plugins: [] });
    expect(session.info?.targetModuleUuid).toBeUndefined();
    session.close();
    game.destroy();
    listener.close();
  });

  it("rejects a pending accept on close, so its timer does not keep the process alive", async () => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timers();
    const listener = await listen(0);
    const pending = listener.accept(10 * 60_000);
    expect(timers()).toBe(before + 1);
    listener.close();
    await expect(pending).rejects.toThrow(/closed/);
    await expect(listener.accept(1000)).rejects.toThrow(/closed/);
    expect(timers()).toBe(before);
  });
});
