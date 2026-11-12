/**
 * `/connect` WebSocket server. The game dials in (`/connect localhost:<port>`); several games may be connected at
 * once. Commands go through a per-client queue capped at `MAX_IN_FLIGHT` unanswered requests.
 */
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { commandRequest, dataRequest, MAX_IN_FLIGHT, parseMessage } from "./protocol.ts";
import type { DataKind, Message } from "./protocol.ts";
import { RequestQueue } from "./queue.ts";

export const DEFAULT_CONNECT_PORT = 19150;

export interface CommandResult {
  /** 0 on success; the game uses large negative codes for failures. Some dev commands return a negative code with valid output. */
  statusCode: number;
  statusMessage: string;
  ok: boolean;
  /** Full response body (extra fields such as `victim`, `levelName`). */
  body: Record<string, unknown>;
}

export interface ConnectClientInfo {
  id: number;
  address: string;
  connectedAt: number;
  inFlight: number;
  waiting: number;
}

class ConnectClient {
  readonly id: number;
  readonly address: string;
  readonly connectedAt = Date.now();
  readonly ws: WebSocket;
  readonly queue: RequestQueue<Message>;

  constructor(id: number, ws: WebSocket, address: string, limit: number) {
    this.id = id;
    this.ws = ws;
    this.address = address;
    this.queue = new RequestQueue<Message>(limit);
  }

  request(message: Message, timeoutMs: number, what: string): Promise<Message> {
    return this.queue.request(message.header.requestId, () => this.ws.send(JSON.stringify(message)), timeoutMs, what);
  }
}

export interface ConnectServerOptions {
  port?: number;
  host?: string;
  /** In-flight cap per client (default `MAX_IN_FLIGHT`). */
  maxInFlight?: number;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};
}

export function toCommandResult(response: Message): CommandResult {
  const body = asRecord(response.body);
  const statusCode = typeof body.statusCode === "number" ? body.statusCode : response.header.messagePurpose === "error" ? -1 : 0;
  const statusMessage = typeof body.statusMessage === "string" ? body.statusMessage : typeof body.message === "string" ? body.message : "";
  return { statusCode, statusMessage, ok: statusCode >= 0, body };
}

/** Events: `client` (ConnectClientInfo), `disconnect` (id). */
export class ConnectServer extends EventEmitter {
  #wss: WebSocketServer | undefined;
  #clients = new Map<number, ConnectClient>();
  #nextId = 1;
  #opts: Required<ConnectServerOptions>;
  port = 0;

  constructor(opts: ConnectServerOptions = {}) {
    super();
    this.#opts = {
      port: opts.port ?? DEFAULT_CONNECT_PORT,
      host: opts.host ?? "127.0.0.1",
      maxInFlight: opts.maxInFlight ?? MAX_IN_FLIGHT,
    };
  }

  get listening(): boolean {
    return this.#wss !== undefined;
  }

  async start(): Promise<number> {
    if (this.#wss) return this.port;
    const wss = new WebSocketServer({ port: this.#opts.port, host: this.#opts.host });
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    wss.once("listening", () => resolve());
    wss.once("error", reject);
    await promise;
    // Without a listener a later server error would crash the process.
    wss.on("error", () => {});
    wss.on("connection", (ws, req) => this.#accept(ws, req.socket.remoteAddress ?? "?"));
    this.#wss = wss;
    const address: AddressInfo | string | null = wss.address();
    this.port = typeof address === "object" && address ? address.port : this.#opts.port;
    return this.port;
  }

  #accept(ws: WebSocket, address: string): void {
    const client = new ConnectClient(this.#nextId++, ws, address, this.#opts.maxInFlight);
    this.#clients.set(client.id, client);
    ws.on("message", (data) => this.#receive(client, data.toString()));
    ws.on("close", () => {
      this.#clients.delete(client.id);
      client.queue.close(new Error(`game connection ${client.id} closed`));
      this.emit("disconnect", client.id);
    });
    ws.on("error", () => ws.terminate());
    this.emit("client", this.#info(client));
  }

  #receive(client: ConnectClient, data: string): void {
    const msg = parseMessage(data);
    if (!msg) return;
    // Event messages (from subscriptions) answer no request.
    if (msg.header.messagePurpose === "event") return;
    client.queue.settle(msg.header.requestId, msg);
  }

  #info(c: ConnectClient): ConnectClientInfo {
    return { id: c.id, address: c.address, connectedAt: c.connectedAt, inFlight: c.queue.inFlight, waiting: c.queue.waiting };
  }

  clients(): ConnectClientInfo[] {
    return [...this.#clients.values()].map((c) => this.#info(c));
  }

  #pick(clientId?: number): ConnectClient {
    if (clientId !== undefined) {
      const c = this.#clients.get(clientId);
      if (!c) throw new Error(`no game connection with id ${clientId}`);
      return c;
    }
    const latest = [...this.#clients.values()].at(-1);
    if (!latest) throw new Error(`no game is connected; type /connect localhost:${this.port || this.#opts.port} in the game chat`);
    return latest;
  }

  /** Wait until at least one game is connected. */
  async waitForClient(timeoutMs: number): Promise<ConnectClientInfo> {
    const existing = [...this.#clients.values()].at(-1);
    if (existing) return this.#info(existing);
    const { promise, resolve, reject } = Promise.withResolvers<ConnectClientInfo>();
    const onClient = (info: ConnectClientInfo): void => {
      clearTimeout(timer);
      resolve(info);
    };
    const timer = setTimeout(() => {
      this.off("client", onClient);
      reject(new Error(`no game connected to /connect port ${this.port} within ${timeoutMs} ms`));
    }, timeoutMs);
    this.once("client", onClient);
    return promise;
  }

  /** Run a command on one connected game (default: the most recent). */
  async command(commandLine: string, opts: { clientId?: number; timeoutMs?: number } = {}): Promise<CommandResult> {
    const client = this.#pick(opts.clientId);
    const response = await client.request(commandRequest(commandLine), opts.timeoutMs ?? 10_000, `command "${commandLine}"`);
    return toCommandResult(response);
  }

  /** Registry dumps the game offers over /connect (`data:block|item|mob`). */
  async data(kind: DataKind, opts: { clientId?: number; timeoutMs?: number } = {}): Promise<unknown> {
    const client = this.#pick(opts.clientId);
    const response = await client.request(dataRequest(kind), opts.timeoutMs ?? 15_000, `data:${kind}`);
    return response.body;
  }

  async stop(): Promise<void> {
    const wss = this.#wss;
    if (!wss) return;
    this.#wss = undefined;
    for (const c of this.#clients.values()) c.ws.terminate();
    this.#clients.clear();
    const { promise, resolve } = Promise.withResolvers<void>();
    wss.close(() => resolve());
    await promise;
  }
}
