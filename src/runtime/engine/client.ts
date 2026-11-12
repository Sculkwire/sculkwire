/**
 * JSON-RPC 2.0 client for sculkwire's in-process agent DLL (the Rust crates in `native/`).
 *
 * Framing: newline-delimited JSON — one request object per line, one response object per line. Responses are matched
 * to requests by id, so replies may arrive in any order and split across TCP chunks. Calls time out individually;
 * closing the socket rejects everything still pending. A line with a `method` and no id is a server notification
 * (e.g. `tick` after `stream.subscribe`); `on(method, listener)` receives its params.
 */
import { createConnection, type Socket } from "node:net";
import type { MethodName } from "./methods.ts";

export class AgentClientError extends Error {
  readonly kind: "timeout" | "closed" | "protocol";
  constructor(kind: AgentClientError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export class AgentRpcError extends Error {
  readonly code: number;
  /** The response's `error.data`, e.g. `{ anchor }` for -32001 or `{ status, message }` for -32006. */
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export interface AgentClientOptions {
  host?: string;
  port: number;
  /** Per-call timeout; `call` may override. */
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export type NotificationListener = (params: unknown, method: string) => void;

const DEFAULT_TIMEOUT_MS = 5000;

export class AgentClient {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  #socket: Socket | undefined;
  #buffer = "";
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  /** Most recent line that was not valid JSON, quoted in timeout errors: a silent drop is otherwise invisible. */
  #lastBadLine: string | undefined;
  /** Notification listeners by method; `*` receives every notification. */
  #listeners = new Map<string, Set<NotificationListener>>();

  constructor(options: AgentClientOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get connected(): boolean {
    return this.#socket !== undefined && !this.#closed;
  }

  /** Opens the TCP connection; rejects on error or timeout. */
  async connect(timeoutMs = 3000): Promise<this> {
    if (this.connected) return this;
    const { promise, resolve: done, reject } = Promise.withResolvers<this>();
    const socket = createConnection({ host: this.host, port: this.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AgentClientError("timeout", `agent did not accept a connection on ${this.host}:${this.port} within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.setNoDelay(true);
    socket.once("connect", () => {
      clearTimeout(timer);
      this.#socket = socket;
      this.#closed = false;
      socket.on("data", (chunk: Buffer) => this.#onData(chunk));
      socket.on("error", (err) => this.#onClose(err.message));
      socket.on("close", () => this.#onClose("agent closed the connection"));
      done(this);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(new AgentClientError("closed", `cannot connect to agent on ${this.host}:${this.port}: ${err.message}`));
    });
    return promise;
  }

  /** Sends one request and resolves with its result. Ids are assigned in order and matched on the way back. */
  async call<T = unknown>(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    await this.connect();
    const socket = this.#socket;
    if (!socket || this.#closed) throw new AgentClientError("closed", "agent connection is closed");
    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const request: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) request.params = params;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      const bad = this.#lastBadLine === undefined ? "" : ` (last unparsable line from the agent: ${this.#lastBadLine})`;
      reject(new AgentClientError("timeout", `agent method "${method}" (id ${id}) timed out after ${timeoutMs} ms${bad}`));
    }, timeoutMs);
    this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    socket.write(`${JSON.stringify(request)}\n`);
    return promise;
  }

  ping(): Promise<string> {
    return this.call<string>("ping" satisfies MethodName);
  }

  /**
   * Receive server notifications for `method` (`*` for every method). Returns the function that removes the
   * listener. A listener that throws is ignored, so one bad consumer cannot break the connection.
   */
  on(method: string, listener: NotificationListener): () => void {
    let set = this.#listeners.get(method);
    if (!set) {
      set = new Set();
      this.#listeners.set(method, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.#listeners.get(method) === set) this.#listeners.delete(method);
    };
  }

  /** `stream.subscribe`: this connection then receives a `tick` notification every `every` ticks (default 1). */
  subscribe(every?: number): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>("stream.subscribe" satisfies MethodName, every === undefined ? {} : { every });
  }

  unsubscribe(): Promise<unknown> {
    return this.call("stream.unsubscribe" satisfies MethodName, {});
  }

  close(): void {
    this.#closed = true;
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#rejectPending(new AgentClientError("closed", "agent client closed"));
  }

  #onData(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    for (;;) {
      const nl = this.#buffer.indexOf("\n");
      if (nl < 0) return;
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (line) this.#onLine(line);
    }
  }

  #onLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      // Cannot be matched to a request; keep it so a subsequent timeout names the real cause.
      this.#lastBadLine = line.length > 200 ? `${line.slice(0, 200)}…` : line;
      return;
    }
    if (typeof message.method === "string" && (message.id === undefined || message.id === null)) {
      this.#notify(message.method, message.params);
      return;
    }
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id === undefined) return; // id-less response
    const pending = this.#pending.get(id);
    if (!pending) return; // late response after a timeout
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new AgentRpcError(message.error.code ?? -32603, message.error.message ?? "agent error", message.error.data));
    } else {
      pending.resolve(message.result);
    }
  }

  #notify(method: string, params: unknown): void {
    for (const key of [method, "*"]) {
      const set = this.#listeners.get(key);
      if (!set) continue;
      for (const listener of [...set]) {
        try {
          listener(params, method);
        } catch {
          // A consumer's bug is not a protocol error.
        }
      }
    }
  }

  #onClose(reason: string): void {
    if (this.#closed && this.#socket === undefined) return;
    this.#closed = true;
    this.#socket = undefined;
    this.#rejectPending(new AgentClientError("closed", reason));
  }

  #rejectPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }
}
