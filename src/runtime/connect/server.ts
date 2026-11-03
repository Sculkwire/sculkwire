/**
 * `/connect` WebSocket server. The game dials in (`/connect localhost:<port>`); several games may be connected at
 * once. Commands go through a per-client queue capped at `MAX_IN_FLIGHT` unanswered requests; events from
 * subscriptions are kept in a ring buffer and fanned out to listeners. Subscriptions are replayed to clients that
 * connect later.
 */
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { commandRequest, dataRequest, MAX_IN_FLIGHT, newRequestId, parseMessage, subscribeRequest } from "./protocol.ts";
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

export interface GameEvent {
  seq: number;
  time: number;
  clientId: number;
  eventName: string;
  body: unknown;
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
  eventBuffer?: number;
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

/** Events: `client` (ConnectClientInfo), `disconnect` (id), `event` (GameEvent). */
export class ConnectServer extends EventEmitter {
  #wss: WebSocketServer | undefined;
  #clients = new Map<number, ConnectClient>();
  #nextId = 1;
  #seq = 0;
  #events: GameEvent[] = [];
  #subscriptions = new Set<string>();
  #opts: Required<ConnectServerOptions>;
  port = 0;

  constructor(opts: ConnectServerOptions = {}) {
    super();
    this.#opts = {
      port: opts.port ?? DEFAULT_CONNECT_PORT,
      host: opts.host ?? "127.0.0.1",
      maxInFlight: opts.maxInFlight ?? MAX_IN_FLIGHT,
      eventBuffer: opts.eventBuffer ?? 1000,
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
    wss.on("error", (err) => this.emit("serverError", err));
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
    for (const name of this.#subscriptions) ws.send(JSON.stringify(subscribeRequest(name)));
    this.emit("client", this.#info(client));
  }

  #receive(client: ConnectClient, data: string): void {
    const msg = parseMessage(data);
    if (!msg) return;
    if (msg.header.messagePurpose === "event") {
      const ev: GameEvent = { seq: ++this.#seq, time: Date.now(), clientId: client.id, eventName: msg.header.eventName ?? "", body: msg.body };
      this.#events.push(ev);
      if (this.#events.length > this.#opts.eventBuffer) this.#events.splice(0, this.#events.length - this.#opts.eventBuffer);
      this.emit("event", ev);
      return;
    }
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
    const timer = setTimeout(() => {
      this.off("client", resolve);
      reject(new Error(`no game connected to /connect port ${this.port} within ${timeoutMs} ms`));
    }, timeoutMs);
    this.once("client", (info: ConnectClientInfo) => {
      clearTimeout(timer);
      resolve(info);
    });
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

  /** Subscribe every current and future client to an event. */
  subscribe(eventName: string): void {
    this.#subscriptions.add(eventName);
    for (const c of this.#clients.values()) c.ws.send(JSON.stringify(subscribeRequest(eventName, false, newRequestId())));
  }

  unsubscribe(eventName: string): void {
    this.#subscriptions.delete(eventName);
    for (const c of this.#clients.values()) c.ws.send(JSON.stringify(subscribeRequest(eventName, true)));
  }

  subscriptions(): string[] {
    return [...this.#subscriptions];
  }

  /** Buffered events with `seq > since`. */
  events(since = 0, eventName?: string): GameEvent[] {
    return this.#events.filter((e) => e.seq > since && (!eventName || e.eventName === eventName));
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
