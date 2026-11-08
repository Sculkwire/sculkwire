import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDecisionModel, DecisionError, kevStartCommand, systemOneUrl } from "./client.ts";
import { configPath, decisionStatus, loadDecisionModel, readConfig, resolveDecision, saveDecisionConfig } from "./config.ts";
import { elicitDecisionSetup, register } from "./mcp.ts";

/** Fake System One server: `/ok` answers every question, `/denied` 401s, `/slow` never answers. */
let fake: Server;
let base: string;
const seen: { auth?: string; images?: string; body: unknown }[] = [];
/** Resolved when a `/slow` request arrives, so tests abort a request that is really in flight. */
let slowArrived = Promise.withResolvers<void>();

beforeAll(async () => {
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { questions?: Record<string, { type: string; criteria?: unknown }> };
      seen.push({ auth: req.headers.authorization, images: req.headers["typesafe-danger-zone-images"] as string | undefined, body });
      const reply = () => {
        const answers: Record<string, unknown> = {};
        for (const [key, q] of Object.entries(body.questions ?? {})) {
          if (q.type === "noul") answers[key] = { type: "noul", noul: 0.9 };
          else if (q.type === "choice") {
            const options = Object.keys(q.criteria as Record<string, unknown>);
            answers[key] = { type: "choice", choice: options[0], confidence: 0.8, probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.9 : 0.1 / (options.length - 1)])) };
          } else if (q.type === "box") answers[key] = { type: "box", box: { top: 0.4, bottom: 0.5, left: 0.2, right: 0.3 }, confidence: 0.9 };
          else answers[key] = { type: "score", score: 1.2, confidence: 0.5, probabilities: { "0": 0.2, "1": 0.4, "2": 0.4 } };
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "fake", answers, usage: {} }));
      };
      if (req.url?.startsWith("/denied/")) res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "No auth credentials found" } }));
      else if (req.url?.startsWith("/slow/")) slowArrived.resolve();
      else if (req.url?.startsWith("/ok/")) reply();
      else res.writeHead(404).end("not found");
    });
  });
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

afterAll(async () => {
  fake.closeAllConnections();
  fake.close();
  await once(fake, "close");
});

const ENV_KEYS = ["SCULKWIRE_CONFIG", "SCULKWIRE_DECISION", "SCULKWIRE_DECISION_URL", "SCULKWIRE_DECISION_MODEL", "OPENROUTER_API_KEY", "ZENMUX_API_KEY"];
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = await mkdtemp(join(tmpdir(), "sculkwire-decision-"));
  process.env.SCULKWIRE_CONFIG = dir;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(dir, { recursive: true, force: true });
});

describe("client", () => {
  it("builds the endpoint from any base form", () => {
    expect(systemOneUrl("https://openrouter.ai/api")).toBe("https://openrouter.ai/api/v1/systemone");
    expect(systemOneUrl("http://127.0.0.1:8009/")).toBe("http://127.0.0.1:8009/v1/systemone");
    expect(systemOneUrl("http://127.0.0.1:8009/v1/systemone")).toBe("http://127.0.0.1:8009/v1/systemone");
  });

  it("returns typed answers, latency and sends the key", async () => {
    const model = createDecisionModel({ label: "fake", baseUrl: `${base}/ok`, model: "m", apiKey: "sk-test", images: true });
    const d = await model.decide("state", {
      go: { type: "noul", instructions: "Go?" },
      dir: { type: "choice", instructions: "Where?", criteria: { left: null, right: "the other way" } },
      risk: { type: "score", instructions: "Risk?", criteria: ["low", "mid", "high"] },
    });
    expect(d.answers.go).toEqual({ type: "noul", noul: 0.9 });
    expect(d.answers.dir).toMatchObject({ type: "choice", choice: "left" });
    expect(d.answers.risk).toMatchObject({ type: "score", score: 1.2 });
    expect(d.latencyMs).toBeGreaterThan(0);
    expect(seen.at(-1)?.auth).toBe("Bearer sk-test");
    expect(seen.at(-1)?.body).toMatchObject({ model: "m", state: "state" });
  });

  it("returns Box answers and opts into images for a screenshot or a Box question", async () => {
    const model = createDecisionModel({ label: "fake", baseUrl: `${base}/ok`, model: "m", images: true });
    const image = { type: "image_url" as const, image_url: { url: "data:image/png;base64,AA==" } };
    const d = await model.decide(["`screen`:", image], { button: { type: "box", instructions: "the Play button in `screen`" } });
    expect(d.answers.button).toEqual({ type: "box", box: { top: 0.4, bottom: 0.5, left: 0.2, right: 0.3 }, confidence: 0.9 });
    expect(seen.at(-1)?.images).toBe("true");
    await model.decide("text only", { go: { type: "noul", instructions: "Go?" } });
    expect(seen.at(-1)?.images).toBeUndefined();
  });

  it("reports a rejected key", async () => {
    const model = createDecisionModel({ label: "fake", baseUrl: `${base}/denied`, model: "m", apiKey: "bad", images: false });
    const err = await model.decide("s", { q: { type: "noul", instructions: "?" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect(err).toMatchObject({ kind: "auth", status: 401 });
    expect((err as Error).message).toMatch(/rejected the API key.*No auth credentials found.*sculk setup/);
  });

  it("reports a wrong URL", async () => {
    const model = createDecisionModel({ label: "fake", baseUrl: `${base}/nope`, model: "m", images: false });
    await expect(model.decide("s", { q: { type: "noul", instructions: "?" } })).rejects.toMatchObject({ kind: "not_found", status: 404 });
  });

  it("times out a slow server", async () => {
    const model = createDecisionModel({ label: "fake", baseUrl: `${base}/slow`, model: "m", images: false, timeoutMs: 150 });
    await expect(model.decide("s", { q: { type: "noul", instructions: "?" } })).rejects.toMatchObject({ kind: "timeout" });
  });

  it("stops when the caller aborts", async () => {
    const model = createDecisionModel({ label: "fake", baseUrl: `${base}/slow`, model: "m", images: false });
    const ctl = new AbortController();
    slowArrived = Promise.withResolvers<void>();
    const pending = model.decide("s", { q: { type: "noul", instructions: "?" } }, { signal: ctl.signal });
    await slowArrived.promise;
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  it("names the Kev start command when the local server is down", async () => {
    const closed = createServer().listen(0, "127.0.0.1");
    await once(closed, "listening");
    const port = (closed.address() as AddressInfo).port;
    closed.close();
    await once(closed, "close");
    const model = createDecisionModel({ label: "local", baseUrl: `http://127.0.0.1:${port}`, model: "kev-latest", images: false, local: true });
    const err = await model.decide("s", { q: { type: "noul", instructions: "?" } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "unreachable" });
    expect((err as Error).message).toContain(kevStartCommand(port));
  });
});

describe("config", () => {
  it("defaults to none", async () => {
    expect(resolveDecision({}, {})).toMatchObject({ provider: "none", source: "default" });
    expect(await loadDecisionModel()).toBeUndefined();
    expect(await decisionStatus()).toMatchObject({ provider: "none", configured: false, reachable: false });
  });

  it("lets the environment override the file", () => {
    const file = { decision: { provider: "openrouter" as const, apiKey: "file-key", model: "file-model" } };
    expect(resolveDecision(file, {})).toMatchObject({ provider: "openrouter", apiKey: "file-key", model: "file-model", baseUrl: "https://openrouter.ai/api", source: "file" });
    expect(resolveDecision(file, { OPENROUTER_API_KEY: "env-key", SCULKWIRE_DECISION_MODEL: "env-model" })).toMatchObject({ apiKey: "env-key", model: "env-model" });
    const local = resolveDecision(file, { SCULKWIRE_DECISION: "local", SCULKWIRE_DECISION_URL: "http://127.0.0.1:9000" });
    expect(local).toMatchObject({ provider: "local", model: "kev-latest", baseUrl: "http://127.0.0.1:9000", source: "env", images: false });
    expect(local.apiKey).toBeUndefined();
    expect(resolveDecision(file, { SCULKWIRE_DECISION: "none" }).provider).toBe("none");
    expect(() => resolveDecision(file, { SCULKWIRE_DECISION: "gpt" })).toThrow(/not one of/);
  });

  it("needs a key for a cloud provider", () => {
    expect(resolveDecision({}, { SCULKWIRE_DECISION: "zenmux" }).missing).toMatch(/ZENMUX_API_KEY/);
    const zenmux = resolveDecision({}, { SCULKWIRE_DECISION: "zenmux", ZENMUX_API_KEY: "k" });
    expect(zenmux).toMatchObject({ baseUrl: "https://zenmux.ai/api", apiKey: "k" });
    expect(zenmux.missing).toBeUndefined();
  });

  it("saves keys with mode 0600 and keeps other settings", async () => {
    // Windows has no POSIX modes: Node reports every writable file as 0o666 whatever mode it was written with.
    const windows = process.platform === "win32";
    await saveDecisionConfig({ provider: "local" });
    expect((await stat(configPath())).mode & 0o777).toBe(windows ? 0o666 : 0o644);
    await saveDecisionConfig({ provider: "openrouter", apiKey: "sk-secret" });
    expect((await stat(configPath())).mode & 0o777).toBe(windows ? 0o666 : 0o600);
    expect(await readConfig()).toEqual({ decision: { provider: "openrouter", apiKey: "sk-secret" } });
    expect(JSON.parse(await readFile(configPath(), "utf8"))).toEqual({ decision: { provider: "openrouter", apiKey: "sk-secret" } });
  });

  it("probes a configured model", async () => {
    await saveDecisionConfig({ provider: "local", baseUrl: `${base}/ok` });
    const status = await decisionStatus();
    expect(status).toMatchObject({ provider: "local", configured: true, reachable: true, images: false, model: "kev-latest" });
    expect(status.latencyMs).toBeGreaterThan(0);
    process.env.SCULKWIRE_DECISION_URL = `${base}/denied`;
    expect(await decisionStatus()).toMatchObject({ configured: true, reachable: false, error: expect.stringMatching(/401/) });
  });
});

async function connect(elicit?: (message: string, n: number) => ElicitResult): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer({ name: "test", version: "0" });
  register(server);
  const client = new Client({ name: "test-client", version: "0" }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
  if (elicit) {
    let n = 0;
    client.setRequestHandler(ElicitRequestSchema, async (req) => elicit(req.params.message, n++));
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server };
}

describe("elicitation", () => {
  it("asks for a provider and URL, saves it and probes", async () => {
    const asked: string[] = [];
    const { client } = await connect((message, n): ElicitResult => {
      asked.push(message);
      return n === 0 ? { action: "accept", content: { provider: "local" } } : { action: "accept", content: { baseUrl: `${base}/ok` } };
    });
    const res = await client.callTool({ name: "decision_status", arguments: {} });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain(kevStartCommand());
    expect(res.structuredContent).toMatchObject({ provider: "local", configured: true, reachable: true, setup: expect.stringContaining("Saved local") });
    expect(await readConfig()).toEqual({ decision: { provider: "local", baseUrl: `${base}/ok` } });
    await client.close();
  });

  it("never asks for a cloud key in chat: it points to the env variable or sculk setup", async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const asked: string[] = [];
    const { client, server } = await connect((message): ElicitResult => {
      asked.push(message);
      return { action: "accept", content: { provider: "openrouter" } };
    });
    try {
      expect(await elicitDecisionSetup(server)).toMatchObject({ saved: false, reason: "needs_key", message: expect.stringMatching(/OPENROUTER_API_KEY.*sculk setup/) });
      expect(asked).toHaveLength(1);
      expect(await readConfig()).toEqual({});
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
      await client.close();
    }
  });

  it("uses a cloud key from the environment and saves only the provider", async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { client, server } = await connect((): ElicitResult => ({ action: "accept", content: { provider: "openrouter" } }));
    try {
      expect(await elicitDecisionSetup(server)).toMatchObject({ saved: true, config: { provider: "openrouter" } });
      expect((await loadDecisionModel())?.label).toBe("openrouter typesafe/jev-1.14");
      expect(await readConfig()).toEqual({ decision: { provider: "openrouter" } });
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
      await client.close();
    }
  });

  it("reports a decline", async () => {
    const { client, server } = await connect(() => ({ action: "decline" }));
    expect(await elicitDecisionSetup(server)).toMatchObject({ saved: false, reason: "declined", message: expect.stringMatching(/declined.*sculk setup/) });
    await client.close();
  });

  it("points to sculk setup when the client cannot elicit", async () => {
    const { client, server } = await connect();
    const res = await client.callTool({ name: "decision_status", arguments: {} });
    expect(res.structuredContent).toMatchObject({ provider: "none", configured: false });
    expect(JSON.stringify(res.content)).toContain("sculk setup");
    expect(await elicitDecisionSetup(server)).toMatchObject({ saved: false, reason: "unsupported", message: expect.stringMatching(/cannot ask.*sculk setup/) });
    await client.close();
  });

  it("does not ask when a model is configured", async () => {
    process.env.SCULKWIRE_DECISION = "local";
    process.env.SCULKWIRE_DECISION_URL = `${base}/ok`;
    let asked = 0;
    const { client } = await connect(() => {
      asked++;
      return { action: "cancel" };
    });
    expect((await loadDecisionModel())?.label).toBe("local kev-latest");
    const res = await client.callTool({ name: "decision_status", arguments: { probe: false } });
    expect(res.structuredContent).toMatchObject({ provider: "local", configured: true, reachable: false });
    expect(asked).toBe(0);
    await client.close();
  });
});
