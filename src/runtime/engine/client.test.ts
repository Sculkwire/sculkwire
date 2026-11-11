import { createServer, type Server, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient, AgentClientError, AgentRpcError } from "./client.ts";

interface FakeAgent {
  port: number;
  /** Every request line the client sent, parsed, in arrival order. */
  requests: Record<string, unknown>[];
  /** Resolves once at least `count` request lines have arrived (no polling). */
  waitForRequests(count: number): Promise<Record<string, unknown>[]>;
  /** Raw bytes to the connected client (no newline added). */
  write(text: string): void;
  /** Drops the client connection; `stop()` afterwards. */
  drop(): void;
  stop(): Promise<void>;
}

/** A TCP server that records request lines and lets the test answer with arbitrary bytes. */
async function fakeAgent(): Promise<FakeAgent> {
  const requests: Record<string, unknown>[] = [];
  const sockets = new Set<Socket>();
  const waiters: { count: number; resolve: (lines: Record<string, unknown>[]) => void }[] = [];

  const notify = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter && requests.length >= waiter.count) {
        waiters.splice(i, 1);
        waiter.resolve(requests);
      }
    }
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) requests.push(JSON.parse(line) as Record<string, unknown>);
      }
      notify();
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake agent has no TCP address");

  return {
    port: address.port,
    requests,
    waitForRequests: (count) => {
      if (requests.length >= count) return Promise.resolve(requests);
      const { promise, resolve } = Promise.withResolvers<Record<string, unknown>[]>();
      waiters.push({ count, resolve });
      return promise;
    },
    write: (text) => {
      for (const socket of sockets) socket.write(text);
    },
    drop: () => {
      for (const socket of sockets) socket.destroy();
    },
    stop: () => {
      for (const socket of sockets) socket.destroy();
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      return promise;
    },
  };
}

const clients: AgentClient[] = [];
const agents: FakeAgent[] = [];

function makeClient(agent: FakeAgent, timeoutMs?: number): AgentClient {
  const client = new AgentClient(timeoutMs === undefined ? { port: agent.port } : { port: agent.port, timeoutMs });
  clients.push(client);
  return client;
}

async function makeAgent(): Promise<FakeAgent> {
  const agent = await fakeAgent();
  agents.push(agent);
  return agent;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const agent of agents.splice(0)) await agent.stop();
});

describe("AgentClient framing", () => {
  it("writes one request per line as JSON-RPC 2.0 with increasing ids", async () => {
    const agent = await makeAgent();
    const client = makeClient(agent);
    const first = client.call("ping");
    const second = client.call("info", { detail: true });
    const requests = await agent.waitForRequests(2);
    expect(requests[0]).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(requests[1]).toEqual({ jsonrpc: "2.0", id: 2, method: "info", params: { detail: true } });
    agent.write('{"jsonrpc":"2.0","id":1,"result":"pong"}\n{"jsonrpc":"2.0","id":2,"result":{"pid":42}}\n');
    await expect(first).resolves.toBe("pong");
    await expect(second).resolves.toEqual({ pid: 42 });
  });

  it("reassembles one response split across TCP chunks and several responses in one chunk", async () => {
    const agent = await makeAgent();
    const client = makeClient(agent);
    const a = client.call<string>("ping");
    const b = client.call<string>("ping");
    await agent.waitForRequests(2);
    const line = '{"jsonrpc":"2.0","id":2,"result":"pong-two"}\n';
    agent.write(line.slice(0, 9));
    agent.write(line.slice(9, 24));
    agent.write(line.slice(24));
    await expect(b).resolves.toBe("pong-two");
    agent.write('{"jsonrpc":"2.0","id":1,"result":"pong-one"}\n');
    await expect(a).resolves.toBe("pong-one");
  });

  it("matches out-of-order responses to the right request and ignores unknown ids", async () => {
    const agent = await makeAgent();
    const client = makeClient(agent);
    const slow = client.call("info");
    const fast = client.call("modules");
    await agent.waitForRequests(2);
    agent.write('{"jsonrpc":"2.0","id":99,"result":"nobody asked"}\n');
    agent.write('{"jsonrpc":"2.0","id":2,"result":[{"name":"Minecraft.Windows.exe"}]}\n');
    agent.write('{"jsonrpc":"2.0","id":1,"result":{"pid":7}}\n');
    await expect(fast).resolves.toEqual([{ name: "Minecraft.Windows.exe" }]);
    await expect(slow).resolves.toEqual({ pid: 7 });
  });

  it("ignores malformed lines and notifications without an id", async () => {
    const agent = await makeAgent();
    const client = makeClient(agent);
    const call = client.call<string>("ping");
    await agent.waitForRequests(1);
    agent.write("not json at all\n");
    agent.write('{"jsonrpc":"2.0","method":"log","params":"hello"}\n');
    agent.write('{"jsonrpc":"2.0","id":1,"result":"pong"}\n');
    await expect(call).resolves.toBe("pong");
  });

  it("turns a JSON-RPC error object into AgentRpcError with its code", async () => {
    const agent = await makeAgent();
    const client = makeClient(agent);
    const call = client.call("resolve_rtti", { name: ".?AVNope@@" });
    await agent.waitForRequests(1);
    agent.write('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}\n');
    const error = await call.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentRpcError);
    expect((error as AgentRpcError).code).toBe(-32601);
    expect((error as AgentRpcError).message).toBe("method not found");
  });
});

describe("AgentClient latency", () => {
  // Pins `setNoDelay` and one write per request: a request written in two pieces with Nagle on waits for the
  // agent's delayed ACK of the first piece, about 40 ms on every call that follows another within the ACK delay.
  // The 25 ms gaps are real on purpose: the kernel's delayed-ACK timer runs on the wall clock, fake timers cannot
  // reach it, and a quiet gap is what lets the ACK be delayed at all.
  it("answers calls sent 25 ms apart in a few ms each from an agent that replies at once", async () => {
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
          const { id } = JSON.parse(buffer.slice(0, nl)) as { id: number };
          buffer = buffer.slice(nl + 1);
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: "pong" })}\n`);
        }
      });
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => listening.resolve());
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake agent has no TCP address");
    const client = new AgentClient({ port: address.port });
    try {
      await client.ping();
      const times: number[] = [];
      for (let i = 0; i < 20; i++) {
        await sleep(25);
        const start = performance.now();
        await client.ping();
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      expect(times[10]).toBeLessThan(10);
      expect(times[17]).toBeLessThan(20);
    } finally {
      client.close();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
  });
});

describe("AgentClient failures", () => {
  // The call timeout is a real timer inside the client; only its expiry lets this test observe the timeout path.
  it("rejects a call that outlives its timeout without leaking the id", async () => {
    const agent = await makeAgent();
    const client = makeClient(agent);
    const error = await client.call("ping", undefined, { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentClientError);
    expect((error as AgentClientError).kind).toBe("timeout");
    expect((error as AgentClientError).message).toContain("timed out");
    // A later answer for the timed-out id is dropped, and the next call still works.
    agent.write('{"jsonrpc":"2.0","id":1,"result":"late"}\n');
    const ping = client.ping();
    await agent.waitForRequests(2);
    agent.write('{"jsonrpc":"2.0","id":2,"result":"pong"}\n');
    await expect(ping).resolves.toBe("pong");
  });

  it("names the unparsable line when the agent replies with invalid JSON", async () => {
    const agent = await makeAgent();
    const client = makeClient(agent);
    const call = client.call("info", undefined, { timeoutMs: 200 });
    await agent.waitForRequests(1);
    // Bare 0x… hex is not JSON: this is exactly what the first agent build sent for addresses.
    agent.write('{"jsonrpc":"2.0","id":1,"result":{"imageBase":0x140000000}}\n');
    const error = await call.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentClientError);
    expect((error as AgentClientError).kind).toBe("timeout");
    expect((error as AgentClientError).message).toContain("last unparsable line");
    expect((error as AgentClientError).message).toContain("0x140000000");
  });

  it("rejects pending calls with kind `closed` when the agent drops the connection", async () => {
    const agent = await makeAgent();
    const client = makeClient(agent);
    const call = client.call("ping");
    await agent.waitForRequests(1);
    agent.drop();
    const error = await call.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentClientError);
    expect((error as AgentClientError).kind).toBe("closed");
  });

  it("reports a refused connection", async () => {
    const agent = await makeAgent();
    await agent.stop();
    agents.splice(agents.indexOf(agent), 1);
    const client = makeClient(agent);
    const error = await client.connect(1000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentClientError);
    expect((error as AgentClientError).message).toContain("cannot connect to agent");
    expect(client.connected).toBe(false);
  });
});
